/**
 * Toolbar and keyboard commands for the text editor (LLD Part 3 §9; §0 PO-20, PO-24, PO-25,
 * L-2, L-13).
 *
 * Every command is disabled while the editor is read-only. "Read-only" means that some plugin's
 * `editable` prop returns false for the state: the editor's own read-only flag or the sync
 * plugin's (V1-32), whichever is set.
 *
 * Attribute changes (alignment, paragraph formatting, image size and alt text, column widths)
 * use attribute steps (`setNodeAttribute`), not `setNodeMarkup`, so concurrent changes to
 * different attributes of one node all survive, as page settings do with `DocAttrStep`.
 *
 * @module
 */
import { getPageSettings, isAllowedHref, textSchema, type LineHeight, type PageSettings, type TextAlign } from '@open-docex/shared/text';
import type { Attrs, Mark, MarkType, Node as PMNode, NodeType, ResolvedPos } from 'prosemirror-model';
import { toggleMark } from 'prosemirror-commands';
import { liftListItem, sinkListItem, wrapInList } from 'prosemirror-schema-list';
import {
  NodeSelection,
  Selection,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from 'prosemirror-state';
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  findTable,
  isInTable,
  mergeCells,
  splitCell,
  toggleHeader,
} from 'prosemirror-tables';
import type { EditorView } from 'prosemirror-view';
import type { Labels } from '../labels.js';
import type { TextToolbarItemId } from '../options.js';
import { IMAGE_ACCEPT, insertImage, type ImageUploadDeps } from './imageUpload.js';

const S = textSchema;
const N = S.nodes;
const M = S.marks;

/** A toolbar command (LLD Part 3 §9). */
export interface EditorCommand {
  id: TextToolbarItemId;
  label: keyof Labels['toolbar'];
  isEnabled(s: EditorState): boolean;
  isActive?(s: EditorState): boolean;
  value?(s: EditorState): string | number | null;
  /**
   * Runs the command. `arg` is the chosen value or the dialog's result; see
   * {@link CommandArgs}. A dialog command called without `arg` asks for its dialog through
   * {@link CommandDeps.requestDialog}.
   */
  run(view: EditorView, arg?: unknown): boolean | Promise<boolean>;
}

/** The commands that need a dialog (LLD Part 3 §14: `LinkDialog`, `ImageAltDialog`, `TablePicker`, `PageSetupDialog`). */
export type DialogCommandId = 'link' | 'imageAlt' | 'insertTable' | 'pageSetup';

/**
 * The `arg` each command's `run` takes. Commands not listed take none.
 * - `paragraphStyle`: 0 for a paragraph, 1–6 for a heading level.
 * - `fontFamily`: a family name, or null to clear. `fontSize`: pt, or null. `textColor`:
 *   `#rrggbb`, or null.
 * - `link`: the href; `''` removes the link.
 * - `insertTable`: `{ rows, cols }`, each 1–20.
 * - `insertImage`: a `File`; without one, a file picker opens.
 * - `imageAlt`: the alt text, at most 1000 characters.
 * - `pageSetup`: the page settings to change.
 */
export interface CommandArgs {
  paragraphStyle: number;
  fontFamily: string | null;
  fontSize: number | null;
  textColor: string | null;
  link: string;
  insertTable: { rows: number; cols: number };
  insertImage: File;
  imageAlt: string;
  pageSetup: Partial<PageSettings>;
}

/** What the commands need from the editor. */
export interface CommandDeps {
  /** Image upload, for `insertImage`. */
  images: ImageUploadDeps;
  /** Opens a command's dialog (V1-35). The dialog then calls `run(view, result)`. */
  requestDialog?: (id: DialogCommandId) => void;
  /** Picks an image file. Defaults to a hidden `<input type="file">`. */
  pickFile?: (view: EditorView) => Promise<File | null>;
}

/** Largest table `insertTable` makes (LLD Part 3 §9). */
export const MAX_TABLE_SIZE = 20;
/** Longest alt text (LLD Part 1 §8.1). */
const MAX_ALT = 1000;

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

/**
 * True unless some plugin's `editable` prop returns false for `state`. This is how the view
 * decides `contenteditable`, so commands follow the same read-only rule as typing.
 */
export function isEditable(state: EditorState): boolean {
  return !state.plugins.some((p) => p.props.editable?.call(p, state) === false);
}

/** True when `type` is active at the selection (stored marks or caret marks when empty). */
export function markActive(state: EditorState, type: MarkType): boolean {
  const { from, to, empty, $from } = state.selection;
  if (empty) return type.isInSet(state.storedMarks ?? $from.marks()) !== undefined;
  return state.doc.rangeHasMark(from, to, type);
}

/** The marks at the selection: stored or caret marks when empty, else the first text's marks. */
function selectionMarks(state: EditorState): readonly Mark[] {
  const sel = state.selection;
  if (sel.empty) return state.storedMarks ?? sel.$from.marks();
  let marks: readonly Mark[] = [];
  let found = false;
  state.doc.nodesBetween(sel.from, sel.to, (node) => {
    if (found) return false;
    if (node.isText) {
      marks = node.marks;
      found = true;
    }
    return !found;
  });
  return marks;
}

/** Paragraphs and headings touched by the selection, with their positions. */
function selectedTextblocks(state: EditorState): { node: PMNode; pos: number }[] {
  const out: { node: PMNode; pos: number }[] = [];
  for (const r of state.selection.ranges) {
    state.doc.nodesBetween(r.$from.pos, r.$to.pos, (node, pos) => {
      if (node.type === N.paragraph || node.type === N.heading) {
        out.push({ node, pos });
        return false;
      }
      return true;
    });
  }
  return out;
}

/** The nearest list around the selection's start, or null. */
function listAround($pos: ResolvedPos): PMNode | null {
  for (let d = $pos.depth; d > 0; d--) {
    const n = $pos.node(d);
    if (n.type === N.bullet_list || n.type === N.ordered_list) return n;
  }
  return null;
}

/** The selected `image` node and its position, or null. */
function selectedImage(state: EditorState): { node: PMNode; pos: number } | null {
  const sel = state.selection;
  return sel instanceof NodeSelection && sel.node.type === N.image ? { node: sel.node, pos: sel.from } : null;
}

/** True when a block of `type` can be inserted around the selection's start. */
function canInsertBlock(state: EditorState, type: NodeType): boolean {
  const $from = state.selection.$from;
  for (let d = $from.depth; d >= 0; d--) {
    const index = $from.index(d);
    if ($from.node(d).canReplaceWith(index, index, type)) return true;
  }
  return false;
}

/** The extent of the `type` mark around `$pos` in its parent, or null if `$pos` isn't in one. */
function markExtent($pos: ResolvedPos, type: MarkType): { from: number; to: number } | null {
  const parent = $pos.parent;
  const start = $pos.start();
  let index = $pos.index();
  let mark = type.isInSet(parent.maybeChild(index)?.marks ?? []);
  if (!mark && index > 0) {
    index -= 1;
    mark = type.isInSet(parent.child(index).marks);
  }
  if (!mark) return null;
  let first = index;
  while (first > 0 && mark.isInSet(parent.child(first - 1).marks)) first--;
  let last = index;
  while (last < parent.childCount - 1 && mark.isInSet(parent.child(last + 1).marks)) last++;
  let from = start;
  for (let i = 0; i < first; i++) from += parent.child(i).nodeSize;
  let to = from;
  for (let i = first; i <= last; i++) to += parent.child(i).nodeSize;
  return { from, to };
}

/** The format attributes a paragraph and a heading share (PO-20, L-2). */
const FORMAT_ATTRS = ['align', 'spacingBefore', 'spacingAfter', 'lineHeight', 'indentLeft', 'indentRight', 'indentFirstLine'] as const;

function formatAttrsOf(node: PMNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of FORMAT_ATTRS) out[k] = node.attrs[k];
  return out;
}

// ---------------------------------------------------------------------------
// Exported commands
// ---------------------------------------------------------------------------

/** The `text_style` attributes (HLD §8.1). A null value removes that attribute. */
export interface TextStylePatch {
  fontFamily?: string | null;
  fontSize?: number | null;
  color?: string | null;
}

function dropNulls(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

/**
 * Merges `patch` into the `text_style` mark of each text segment in the selection, keeping each
 * segment's other attributes (LLD Part 3 §9). With an empty selection it sets stored marks.
 * Returns false, changing nothing, for an attribute value the schema rejects.
 */
export function setTextStyle(patch: TextStylePatch): Command {
  return (state, dispatch) => {
    const type = M.text_style;
    try {
      type.create(dropNulls({ ...patch }));
    } catch {
      return false;
    }
    if (!toggleMark(type)(state)) return false;
    if (!dispatch) return true;
    const sel = state.selection;
    const tr = state.tr;
    if (sel.empty) {
      const marks = state.storedMarks ?? sel.$from.marks();
      const old = type.isInSet(marks)?.attrs ?? {};
      const attrs = dropNulls({ ...old, ...patch });
      let next = type.removeFromSet(marks);
      if (Object.keys(attrs).length > 0) next = type.create(attrs).addToSet(next);
      dispatch(tr.setStoredMarks(next));
      return true;
    }
    for (const r of sel.ranges) {
      const from = r.$from.pos;
      const to = r.$to.pos;
      state.doc.nodesBetween(from, to, (node, pos, parent) => {
        if (!node.isText || parent === null || !parent.type.allowsMarkType(type)) return;
        const a = Math.max(pos, from);
        const b = Math.min(pos + node.nodeSize, to);
        const old = type.isInSet(node.marks)?.attrs ?? {};
        const attrs = dropNulls({ ...old, ...patch });
        tr.removeMark(a, b, type);
        if (Object.keys(attrs).length > 0) tr.addMark(a, b, type.create(attrs));
      });
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** The paragraph formatting of PO-20 (§0 S-19). A null value removes the override. */
export interface ParagraphFormat {
  align?: TextAlign;
  spacingBefore?: number | null;
  spacingAfter?: number | null;
  lineHeight?: LineHeight | null;
  indentLeft?: number | null;
  indentRight?: number | null;
  indentFirstLine?: number | null;
}

/**
 * Sets paragraph formatting (alignment, spacing before and after, line height, and left, right
 * and first-line indent; PO-20) on every paragraph and heading in the selection. Returns false,
 * changing nothing, when there is none or a value is invalid for the schema.
 */
export function setParagraphFormat(format: ParagraphFormat): Command {
  return (state, dispatch) => {
    const blocks = selectedTextblocks(state);
    const keys = FORMAT_ATTRS.filter((k) => format[k] !== undefined);
    if (blocks.length === 0 || keys.length === 0) return false;
    try {
      N.paragraph.create({ ...format });
    } catch {
      return false;
    }
    if (!dispatch) return true;
    const tr = state.tr;
    for (const { node, pos } of blocks) {
      for (const k of keys) {
        const v = format[k];
        if (JSON.stringify(node.attrs[k]) !== JSON.stringify(v)) tr.setNodeAttribute(pos, k, v);
      }
    }
    dispatch(tr);
    return true;
  };
}

/** Inserts a `hard_break` at the selection (Shift-Enter). */
export const insertHardBreak: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if (!$from.parent.isTextblock || !$from.parent.type.contentMatch.matchType(N.hard_break)) return false;
  if (dispatch) dispatch(state.tr.replaceSelectionWith(N.hard_break.create()).scrollIntoView());
  return true;
};

/** True when the selection is in a block that is a direct child of `body`. */
function inBodyTopLevelBlock(state: EditorState): boolean {
  const { $from, $to } = state.selection;
  return $from.depth === 2 && $from.node(1).type === N.body && $from.parent.isTextblock && $to.node(1)?.type === N.body;
}

/**
 * Replaces the selection with a `page_break` at the body's top level (Mod-Enter). The block
 * holding the caret is split at the caret; the caret moves to the block after the break.
 */
export const insertPageBreak: Command = (state, dispatch) => {
  if (!inBodyTopLevelBlock(state)) return false;
  if (!dispatch) return true;
  const tr = state.tr.deleteSelection();
  const $p = tr.selection.$from;
  if ($p.depth !== 2 || $p.node(1).type !== N.body || !$p.parent.isTextblock) return false;
  let at: number;
  if ($p.parentOffset === 0) at = $p.before();
  else if ($p.parentOffset === $p.parent.content.size) at = $p.after();
  else {
    tr.split($p.pos);
    at = $p.pos + 1;
  }
  tr.insert(at, N.page_break.create());
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(at + 1, tr.doc.content.size)), 1));
  dispatch(tr.scrollIntoView());
  return true;
};

/** Toggles the `header` (first child of `doc`) or `footer` (last child) region (LLD Part 3 §11). */
export function toggleRegion(kind: 'header' | 'footer'): Command {
  return (state, dispatch) => {
    if (!dispatch) return true;
    const doc = state.doc;
    const tr = state.tr;
    if (kind === 'header') {
      const first = doc.firstChild;
      if (first?.type === N.header) tr.delete(0, first.nodeSize);
      else tr.insert(0, N.header.create(null, N.paragraph.create()));
    } else {
      const last = doc.lastChild;
      const end = doc.content.size;
      if (last?.type === N.footer) tr.delete(end - last.nodeSize, end);
      else tr.insert(end, N.footer.create(null, N.paragraph.create()));
    }
    dispatch(tr);
    return true;
  };
}

/** True when the margins leave at least 36 pt of body each way. Mirrors shared `pageSettingsFit`. */
function pageSettingsFit(p: PageSettings): boolean {
  return p.margins.left + p.margins.right <= p.size.width - 36 && p.margins.top + p.margins.bottom <= p.size.height - 36;
}

/**
 * Changes page settings with one `DocAttrStep` per changed attribute (LLD Part 3 §9, L2).
 * Returns false, changing nothing, for values the schema rejects or margins that don't fit the
 * page, so the server never receives a step it would refuse.
 */
export function setPageSettings(patch: Partial<PageSettings>): Command {
  return (state, dispatch) => {
    const doc = state.doc;
    const current = getPageSettings(doc);
    const next: PageSettings = { ...current, ...patch };
    if (!pageSettingsFit(next)) return false;
    const tr = state.tr;
    try {
      for (const key of ['size', 'orientation', 'margins'] as const) {
        const v = patch[key];
        if (v !== undefined && JSON.stringify(v) !== JSON.stringify(current[key])) tr.setDocAttribute(key, v);
      }
    } catch {
      return false;
    }
    if (dispatch && tr.docChanged) dispatch(tr);
    return true;
  };
}

/** Inserts a `rows` × `cols` table of empty cells at the selection, with the caret in the first cell. */
export function insertTable(rows: number, cols: number): Command {
  return (state, dispatch) => {
    const ok = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= MAX_TABLE_SIZE;
    if (!ok(rows) || !ok(cols) || !canInsertBlock(state, N.table)) return false;
    if (!dispatch) return true;
    const row = (): PMNode =>
      N.table_row.create(null, Array.from({ length: cols }, () => N.table_cell.create(null, N.paragraph.create())));
    const table = N.table.create(null, Array.from({ length: rows }, row));
    const tr = state.tr.replaceSelectionWith(table);
    let at = -1;
    tr.doc.descendants((node, pos) => {
      if (at >= 0) return false;
      if (node === table) at = pos;
      return at < 0;
    });
    if (at >= 0) tr.setSelection(TextSelection.near(tr.doc.resolve(at + 3)));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/**
 * Wraps a prosemirror-tables command so that it can't fail on `colwidth`.
 *
 * Some table commands (adding a column through a merged cell, merging cells) insert `0` into a
 * resized cell's `colwidth`, which the schema rejects (widths are 1–10 000 px, §0 S-27); the
 * command then throws. In that case the command runs again on a copy of the table without
 * saved column widths, and both changes are dispatched as one transaction (LLD choice: the
 * table's columns go back to automatic widths rather than the edit failing).
 */
export function tableCommand(cmd: Command): Command {
  return (state, dispatch, view) => {
    if (!dispatch) return cmd(state, undefined, view);
    try {
      return cmd(state, dispatch, view);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
    }
    const found = findTable(state.selection.$from);
    if (!found) return false;
    const start = found.pos + 1;
    const clear = state.tr;
    found.node.descendants((node, offset) => {
      const role = node.type.spec.tableRole as string | undefined;
      if (role === 'row') return true;
      if (node.attrs.colwidth !== null && node.attrs.colwidth !== undefined) {
        clear.setNodeAttribute(start + offset, 'colwidth', null);
      }
      return false;
    });
    if (!clear.docChanged) return false;
    let second: Transaction | null = null;
    try {
      cmd(state.apply(clear), (t) => {
        second = t;
      });
    } catch {
      return false;
    }
    const done = second as Transaction | null;
    if (done === null) return false;
    const tr = state.tr;
    for (const s of clear.steps) tr.step(s);
    for (const s of done.steps) tr.step(s);
    if (done.selectionSet) tr.setSelection(Selection.fromJSON(tr.doc, done.selection.toJSON()));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Opens a hidden file input for PNG, JPEG and GIF and resolves the chosen file. */
function pickImageFile(view: EditorView): Promise<File | null> {
  return new Promise((resolve) => {
    const input = view.dom.ownerDocument.createElement('input');
    input.type = 'file';
    input.accept = IMAGE_ACCEPT;
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

// ---------------------------------------------------------------------------
// The toolbar command table
// ---------------------------------------------------------------------------

const run =
  (cmd: Command) =>
  (view: EditorView): boolean =>
    cmd(view.state, view.dispatch, view);

function markCommand(id: TextToolbarItemId, type: MarkType): EditorCommand {
  return {
    id,
    label: id,
    isEnabled: (s) => isEditable(s) && toggleMark(type)(s),
    isActive: (s) => markActive(s, type),
    run: run(toggleMark(type)),
  };
}

function textStyleCommand(id: 'fontFamily' | 'fontSize' | 'textColor'): EditorCommand {
  const attr = id === 'textColor' ? 'color' : id;
  return {
    id,
    label: id,
    isEnabled: (s) => isEditable(s) && toggleMark(M.text_style)(s),
    value: (s) => (M.text_style.isInSet(selectionMarks(s))?.attrs[attr] as string | number | null | undefined) ?? null,
    run(view, arg) {
      if (!isEditable(view.state)) return false;
      let v = arg;
      if (id === 'textColor' && typeof v === 'string') v = v.toLowerCase();
      if (v !== null && (id === 'fontSize' ? typeof v !== 'number' : typeof v !== 'string')) return false;
      const patch: TextStylePatch = { [attr]: v };
      return setTextStyle(patch)(view.state, view.dispatch);
    },
  };
}

function alignCommand(id: TextToolbarItemId, align: TextAlign): EditorCommand {
  return {
    id,
    label: id,
    isEnabled: (s) => isEditable(s) && selectedTextblocks(s).length > 0,
    isActive: (s) => {
      const blocks = selectedTextblocks(s);
      return blocks.length > 0 && blocks.every((b) => b.node.attrs.align === align);
    },
    run: (view) => isEditable(view.state) && setParagraphFormat({ align })(view.state, view.dispatch),
  };
}

function listCommand(id: TextToolbarItemId, type: NodeType): EditorCommand {
  const inThis = (s: EditorState): boolean => listAround(s.selection.$from)?.type === type;
  return {
    id,
    label: id,
    isEnabled: (s) => isEditable(s) && (inThis(s) || wrapInList(type)(s)),
    isActive: inThis,
    run(view) {
      const s = view.state;
      if (!isEditable(s)) return false;
      return inThis(s) ? liftListItem(N.list_item)(s, view.dispatch) : wrapInList(type)(s, view.dispatch);
    },
  };
}

function listIndentCommand(id: 'indent' | 'outdent'): EditorCommand {
  const cmd = id === 'indent' ? sinkListItem(N.list_item) : liftListItem(N.list_item);
  return {
    id,
    label: id,
    isEnabled: (s) => isEditable(s) && listAround(s.selection.$from) !== null && cmd(s),
    run: (view) => isEditable(view.state) && cmd(view.state, view.dispatch, view),
  };
}

function tableItem(id: TextToolbarItemId, cmd: Command): EditorCommand {
  const wrapped = tableCommand(cmd);
  return {
    id,
    label: id,
    isEnabled: (s) => isEditable(s) && isInTable(s) && cmd(s),
    run: (view) => isEditable(view.state) && isInTable(view.state) && wrapped(view.state, view.dispatch, view),
  };
}

/** A dialog command: without `arg` it asks for its dialog; with one it applies it. */
function dialogRun(
  id: DialogCommandId,
  deps: CommandDeps,
  enabled: (s: EditorState) => boolean,
  apply: (view: EditorView, arg: unknown) => boolean,
): (view: EditorView, arg?: unknown) => boolean {
  return (view, arg) => {
    if (!enabled(view.state)) return false;
    if (arg === undefined) {
      if (!deps.requestDialog) return false;
      deps.requestDialog(id);
      return true;
    }
    return apply(view, arg);
  };
}

/**
 * Builds the toolbar commands for `items` (LLD Part 3 §9), in the given order. Unknown items
 * are skipped.
 */
export function buildCommands(items: readonly TextToolbarItemId[], deps: CommandDeps): ReadonlyMap<TextToolbarItemId, EditorCommand> {
  const all = new Map<TextToolbarItemId, EditorCommand>();
  const add = (c: EditorCommand): void => {
    all.set(c.id, c);
  };

  const inStyledBlock = (s: EditorState): boolean => {
    const p = s.selection.$from.parent;
    return p.type === N.paragraph || p.type === N.heading;
  };
  add({
    id: 'paragraphStyle',
    label: 'paragraphStyle',
    isEnabled: (s) => isEditable(s) && inStyledBlock(s),
    value: (s) => {
      const blocks = selectedTextblocks(s);
      if (blocks.length === 0) return null;
      const level = (n: PMNode): number => (n.type === N.heading ? (n.attrs.level as number) : 0);
      const first = level((blocks[0] as { node: PMNode }).node);
      return blocks.every((b) => level(b.node) === first) ? first : null;
    },
    run(view, arg) {
      const s = view.state;
      if (!isEditable(s) || !inStyledBlock(s) || !Number.isInteger(arg) || (arg as number) < 0 || (arg as number) > 6) {
        return false;
      }
      const level = arg as number;
      const type = level === 0 ? N.paragraph : N.heading;
      const attrsFor = (old: PMNode): Attrs => (level === 0 ? formatAttrsOf(old) : { ...formatAttrsOf(old), level });
      const tr = s.tr;
      for (const r of s.selection.ranges) tr.setBlockType(r.$from.pos, r.$to.pos, type, attrsFor);
      if (tr.docChanged) view.dispatch(tr.scrollIntoView());
      return true;
    },
  });

  add(markCommand('bold', M.bold));
  add(markCommand('italic', M.italic));
  add(markCommand('underline', M.underline));
  add(markCommand('strike', M.strike));
  add(textStyleCommand('fontFamily'));
  add(textStyleCommand('fontSize'));
  add(textStyleCommand('textColor'));

  const linkEnabled = (s: EditorState): boolean =>
    isEditable(s) && (s.selection.empty ? markExtent(s.selection.$from, M.link) !== null : toggleMark(M.link)(s));
  add({
    id: 'link',
    label: 'link',
    isEnabled: linkEnabled,
    isActive: (s) => markActive(s, M.link),
    value: (s) => (M.link.isInSet(selectionMarks(s))?.attrs.href as string | undefined) ?? null,
    run: dialogRun('link', deps, linkEnabled, (view, arg) => (typeof arg === 'string' ? setLink(arg)(view.state, view.dispatch) : false)),
  });

  add(alignCommand('alignLeft', 'left'));
  add(alignCommand('alignCenter', 'center'));
  add(alignCommand('alignRight', 'right'));
  add(alignCommand('alignJustify', 'justify'));
  add(listCommand('bulletList', N.bullet_list));
  add(listCommand('orderedList', N.ordered_list));
  add(listIndentCommand('indent'));
  add(listIndentCommand('outdent'));

  const tableEnabled = (s: EditorState): boolean => isEditable(s) && canInsertBlock(s, N.table);
  add({
    id: 'insertTable',
    label: 'insertTable',
    isEnabled: tableEnabled,
    run: dialogRun('insertTable', deps, tableEnabled, (view, arg) => {
      const a = arg as Partial<CommandArgs['insertTable']> | null;
      if (typeof a !== 'object' || a === null) return false;
      return insertTable(a.rows as number, a.cols as number)(view.state, view.dispatch);
    }),
  });
  add(tableItem('tableAddRowBefore', addRowBefore));
  add(tableItem('tableAddRowAfter', addRowAfter));
  add(tableItem('tableAddColBefore', addColumnBefore));
  add(tableItem('tableAddColAfter', addColumnAfter));
  add(tableItem('tableDeleteRow', deleteRow));
  add(tableItem('tableDeleteCol', deleteColumn));
  add(tableItem('tableMerge', mergeCells));
  add(tableItem('tableSplit', splitCell));
  add(tableItem('tableToggleHeaderRow', toggleHeader('row')));
  add(tableItem('tableDelete', deleteTable));

  add({
    id: 'insertImage',
    label: 'insertImage',
    isEnabled: isEditable,
    async run(view, arg) {
      if (!isEditable(view.state)) return false;
      const file = arg instanceof File ? arg : await (deps.pickFile ?? pickImageFile)(view);
      return file === null ? false : insertImage(view, file, deps.images);
    },
  });

  const altEnabled = (s: EditorState): boolean => isEditable(s) && selectedImage(s) !== null;
  add({
    id: 'imageAlt',
    label: 'imageAlt',
    isEnabled: altEnabled,
    value: (s) => (selectedImage(s)?.node.attrs.alt as string | undefined) ?? null,
    run: dialogRun('imageAlt', deps, altEnabled, (view, arg) => {
      const img = selectedImage(view.state);
      if (img === null || typeof arg !== 'string' || arg.length > MAX_ALT) return false;
      view.dispatch(view.state.tr.setNodeAttribute(img.pos, 'alt', arg));
      return true;
    }),
  });

  add({
    id: 'pageBreak',
    label: 'pageBreak',
    isEnabled: (s) => isEditable(s) && insertPageBreak(s),
    run: (view) => isEditable(view.state) && insertPageBreak(view.state, view.dispatch, view),
  });

  for (const kind of ['header', 'footer'] as const) {
    add({
      id: kind,
      label: kind,
      isEnabled: isEditable,
      isActive: (s) => (kind === 'header' ? s.doc.firstChild?.type === N.header : s.doc.lastChild?.type === N.footer),
      run: (view) => isEditable(view.state) && toggleRegion(kind)(view.state, view.dispatch, view),
    });
  }

  add({
    id: 'pageSetup',
    label: 'pageSetup',
    isEnabled: isEditable,
    run: dialogRun('pageSetup', deps, isEditable, (view, arg) =>
      typeof arg === 'object' && arg !== null ? setPageSettings(arg)(view.state, view.dispatch) : false,
    ),
  });

  const out = new Map<TextToolbarItemId, EditorCommand>();
  for (const id of items) {
    const c = all.get(id);
    if (c) out.set(id, c);
  }
  return out;
}

/**
 * Sets or removes the link on the selection (LLD Part 3 §9, §15). `href` is trimmed and must
 * pass `isAllowedHref` (`http:`, `https:`, `mailto:`); an empty `href` removes the link. With
 * an empty selection, the link around the caret is changed.
 */
export function setLink(rawHref: string): Command {
  return (state, dispatch) => {
    const href = rawHref.trim();
    if (href !== '' && !isAllowedHref(href)) return false;
    const sel = state.selection;
    const ranges: { from: number; to: number }[] = [];
    if (sel.empty) {
      const ext = markExtent(sel.$from, M.link);
      if (ext === null) return false;
      ranges.push(ext);
    } else {
      for (const r of sel.ranges) ranges.push({ from: r.$from.pos, to: r.$to.pos });
    }
    if (!dispatch) return true;
    const tr = state.tr;
    for (const { from, to } of ranges) {
      tr.removeMark(from, to, M.link);
      if (href !== '') tr.addMark(from, to, M.link.create({ href }));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}
