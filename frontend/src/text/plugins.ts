/**
 * The text editor's plugin list (LLD Part 3 §9, §7.3; §0 PO-18, PO-25, S-7).
 *
 * Order (LLD Part 3 §9):
 * 1. the sync plugin (`collabSyncPlugin`, V1-32), passed in
 * 2. the header/footer node views (`HeaderFooterRegions`, V1-34), passed in
 * 3. `imageUploadPlugin` (placeholders, paste and drop)
 * 4. `PaginationPlugin` (V1-34), passed in
 * 5. the editor core (read-only flag, image node view, links, undo guard) and the keymaps
 * 6. `gapCursor()`
 * 7. `dropCursor()`
 * 8. `columnResizing()` and the wrapped `tableEditing()`, last as prosemirror-tables asks
 *
 * There are no input rules and no history plugin: there is no undo or redo in V1–V5 (PO-18),
 * so Mod-z, Mod-y and Mod-Shift-z are swallowed and native `historyUndo`/`historyRedo` input
 * is cancelled.
 *
 * @module
 */
import { textSchema } from '@open-docex/shared/text';
import { baseKeymap, chainCommands, toggleMark } from 'prosemirror-commands';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { keymap } from 'prosemirror-keymap';
import type { Node as PMNode } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list';
import { Plugin, PluginKey, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { columnResizing, columnResizingPluginKey, goToNextCell, tableEditing, TableMap } from 'prosemirror-tables';
import type { EditorView, MarkViewConstructor, NodeViewConstructor } from 'prosemirror-view';
import type { AssetCache } from '../assets/AssetCache.js';
import { LINK_REL, LINK_TARGET, isAllowedHref, openLink, type LinkOpener } from '../security/href.js';
import { insertHardBreak, insertPageBreak, isEditable } from './commands.js';
import { imageUploadPlugin, type ImageUploadDeps } from './imageUpload.js';
import type { BlockResizeSignal } from './nodeviews/BlockResizeSignal.js';
import { ImageView } from './nodeviews/ImageView.js';

const N = textSchema.nodes;
const M = textSchema.marks;

/**
 * Plugins the editor takes from other modules, by slot (LLD Part 3 §9's order). The editor
 * does not import them, so each can be built and tested on its own.
 */
export interface EditorPluginSlots {
  /** Slot 1: the sync plugin (`collabSyncPlugin`, V1-32). */
  sync?: readonly Plugin[];
  /** Slot 2: the header and footer node views (`HeaderFooterRegions`, V1-34). */
  regions?: readonly Plugin[];
  /** Slot 4: `PaginationPlugin` (V1-34). */
  pagination?: readonly Plugin[];
  /**
   * True for a transaction the sync plugin made from server changes (a rebuild). For those,
   * `tableEditing()` does not append `fixTables`, so clients never submit the same repair
   * concurrently (LLD Part 3 §7.3). Without it, every transaction counts as local.
   */
  isRemote?: (tr: Transaction) => boolean;
}

/** What {@link buildPlugins} needs. */
export interface PluginDeps {
  assets: AssetCache;
  images: ImageUploadDeps;
  resize: BlockResizeSignal;
  readOnly: boolean;
  slots: EditorPluginSlots;
  /** Opens the link dialog for Mod-k. */
  requestLinkDialog?: () => boolean;
  /** For Mod+click on a link. Default `window`. */
  opener?: LinkOpener;
}

// ---------------------------------------------------------------------------
// Editor core: read-only flag, node and mark views, link clicks, undo guard
// ---------------------------------------------------------------------------

/** The editor's own read-only flag (LLD Part 3 §9 `load(doc, { readOnly })`). */
export const readOnlyKey = new PluginKey<boolean>('odx-read-only');

/** Swallows a key so the browser does nothing (PO-18: no undo or redo). */
export const swallow: Command = () => true;

function linkMarkView(): MarkViewConstructor {
  return (mark, view) => {
    const a = view.dom.ownerDocument.createElement('a');
    const href = mark.attrs.href as unknown;
    // The schema already validated the href; checking again means a bad one renders as text (§15).
    if (isAllowedHref(href)) a.setAttribute('href', href);
    a.rel = LINK_REL;
    a.target = LINK_TARGET;
    return { dom: a };
  };
}

/** The core plugin: read-only flag, `image` node view, link rendering and clicks, undo guard. */
function corePlugin(deps: PluginDeps): Plugin<boolean> {
  const image: NodeViewConstructor = (node, view, getPos) =>
    new ImageView(node, view, getPos, { assets: deps.assets, resize: deps.resize });
  return new Plugin<boolean>({
    key: readOnlyKey,
    state: {
      init: () => deps.readOnly,
      apply: (tr, prev) => {
        const m = tr.getMeta(readOnlyKey) as boolean | undefined;
        return typeof m === 'boolean' ? m : prev;
      },
    },
    props: {
      editable: (state) => readOnlyKey.getState(state) !== true,
      nodeViews: { image },
      markViews: { link: linkMarkView() },
      handleClick(view, pos, event) {
        // In edit mode a link opens with Mod+click, after re-validating it (LLD Part 3 §15).
        // In view mode the browser follows the link itself.
        if (!view.editable || !(event.ctrlKey || event.metaKey)) return false;
        const $pos = view.state.doc.resolve(pos);
        const link = M.link.isInSet($pos.marks()) ?? M.link.isInSet($pos.nodeAfter?.marks ?? []);
        if (!link) return false;
        openLink(link.attrs.href, deps.opener ?? window);
        return true;
      },
      handleDOMEvents: {
        beforeinput(_view, event) {
          const type = event.inputType;
          if (type === 'historyUndo' || type === 'historyRedo') {
            event.preventDefault();
            return true;
          }
          return false;
        },
      },
    },
  });
}

/** Keys (LLD Part 3 §9 keymap table). Commands that change the document check `isEditable`. */
function editorKeymap(deps: PluginDeps): Plugin {
  const editable =
    (cmd: Command): Command =>
    (state, dispatch, view) =>
      isEditable(state) && cmd(state, dispatch, view);
  const li = N.list_item;
  const tableOrList = (dir: 1 | -1): Command =>
    editable(chainCommands(goToNextCell(dir), dir === 1 ? sinkListItem(li) : liftListItem(li)));
  return keymap({
    'Mod-z': swallow,
    'Mod-y': swallow,
    'Mod-Shift-z': swallow,
    'Mod-Shift-Z': swallow,
    'Mod-b': editable(toggleMark(M.bold)),
    'Mod-i': editable(toggleMark(M.italic)),
    'Mod-u': editable(toggleMark(M.underline)),
    'Mod-Shift-x': editable(toggleMark(M.strike)),
    'Mod-Shift-X': editable(toggleMark(M.strike)),
    'Shift-Enter': editable(insertHardBreak),
    'Mod-Enter': editable(insertPageBreak),
    'Mod-k': (state) => isEditable(state) && (deps.requestLinkDialog?.() ?? false),
    Enter: editable(splitListItem(li)),
    Tab: tableOrList(1),
    'Shift-Tab': tableOrList(-1),
  });
}

// ---------------------------------------------------------------------------
// Tables: column resizing (PO-25) and the wrapped tableEditing (LLD Part 3 §7.3)
// ---------------------------------------------------------------------------

/** prosemirror-tables' defaults for the smallest column and for a column with no width. */
const CELL_MIN_WIDTH = 25;
const DEFAULT_CELL_MIN_WIDTH = 100;
/** The largest `colwidth` entry the schema allows (LLD Part 1 §8.1). */
const MAX_COL_WIDTH = 10_000;

/** A width the schema accepts: a whole number of px in [1, 10 000]. */
function validWidth(w: number): number {
  return Math.min(MAX_COL_WIDTH, Math.max(1, Math.round(w)));
}

/** A saved width for column `col`, taken from any cell that covers it, or null. */
function knownColumnWidth(map: TableMap, table: PMNode, col: number): number | null {
  for (let row = 0; row < map.height; row++) {
    const pos = map.map[row * map.width + col] as number;
    const cell = table.nodeAt(pos);
    const w = (cell?.attrs.colwidth as number[] | null | undefined)?.[col - map.colCount(pos)];
    if (typeof w === 'number' && w >= 1) return w;
  }
  return null;
}

/**
 * The transaction that sets column `col`'s width to `width` px in every row, with attribute
 * steps. This replaces prosemirror-tables' own update, which fills a merged cell's other
 * entries with 0 and can save fractional widths; the schema rejects both (§0 S-27), so the
 * resize would throw. Other entries of a merged cell take a saved width of their column, or
 * prosemirror-tables' default of 100 px (LLD choice).
 */
export function columnWidthTransaction(state: EditorState, cellPos: number, width: number): Transaction | null {
  const $cell = state.doc.resolve(cellPos);
  const cellNode = $cell.nodeAfter;
  const table = $cell.node(-1);
  if (cellNode === null || table.type !== N.table) return null;
  const map = TableMap.get(table);
  const start = $cell.start(-1);
  const col = map.colCount($cell.pos - start) + (cellNode.attrs.colspan as number) - 1;
  const w = validWidth(width);
  const tr = state.tr;
  for (let row = 0; row < map.height; row++) {
    const index = row * map.width + col;
    if (row > 0 && map.map[index] === map.map[index - map.width]) continue;
    const pos = map.map[index] as number;
    const cell = table.nodeAt(pos);
    if (cell === null) continue;
    const span = cell.attrs.colspan as number;
    const first = map.colCount(pos);
    const old = (cell.attrs.colwidth as number[] | null) ?? [];
    const next: number[] = [];
    for (let i = 0; i < span; i++) {
      const known = old[i];
      next.push(first + i === col ? w : typeof known === 'number' && known >= 1 ? validWidth(known) : validWidth(knownColumnWidth(map, table, first + i) ?? DEFAULT_CELL_MIN_WIDTH));
    }
    if (JSON.stringify(next) !== JSON.stringify(cell.attrs.colwidth)) tr.setNodeAttribute(start + pos, 'colwidth', next);
  }
  return tr;
}

/**
 * Commits a column drag with {@link columnWidthTransaction}. It listens on the window in the
 * capture phase, so it runs before prosemirror-tables' own `mouseup`, which then finds the
 * drag already finished.
 */
function columnResizeCommit(): Plugin {
  return new Plugin({
    view(view: EditorView) {
      const win = view.dom.ownerDocument.defaultView;
      const finish = (event: MouseEvent): void => {
        const st = columnResizingPluginKey.getState(view.state);
        if (!st || !st.dragging || st.activeHandle < 0) return;
        const width = Math.max(CELL_MIN_WIDTH, st.dragging.startWidth + event.clientX - st.dragging.startX);
        const tr = view.editable ? columnWidthTransaction(view.state, st.activeHandle, width) : null;
        if (tr?.docChanged) view.dispatch(tr);
        view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setDragging: null }));
      };
      const move = (event: MouseEvent): void => {
        // prosemirror-tables ends a drag on a move with no button held; so does this.
        if (event.buttons === 0 && columnResizingPluginKey.getState(view.state)?.dragging) finish(event);
      };
      win?.addEventListener('mouseup', finish, true);
      win?.addEventListener('mousemove', move, true);
      return {
        destroy() {
          win?.removeEventListener('mouseup', finish, true);
          win?.removeEventListener('mousemove', move, true);
        },
      };
    },
  });
}

/**
 * `tableEditing()` with its `appendTransaction` (`fixTables`) skipped after a remote rebuild
 * (LLD Part 3 §7.3), so tables are repaired only by local edits. A repair the schema rejects
 * (a `colwidth` with a 0) is dropped instead of failing the user's transaction.
 */
export function wrappedTableEditing(isRemote: (tr: Transaction) => boolean): Plugin {
  const orig = tableEditing();
  const append = orig.spec.appendTransaction;
  return new Plugin({
    ...orig.spec,
    appendTransaction(trs, oldState, newState) {
      if (!append || trs.some(isRemote)) return null;
      try {
        return append.call(orig, trs, oldState, newState);
      } catch (e) {
        if (e instanceof RangeError) return null;
        throw e;
      }
    },
  });
}

/** The editor's plugins, in LLD Part 3 §9's order. */
export function buildPlugins(deps: PluginDeps): Plugin[] {
  const isRemote = deps.slots.isRemote ?? ((): boolean => false);
  return [
    ...(deps.slots.sync ?? []),
    ...(deps.slots.regions ?? []),
    imageUploadPlugin(deps.images),
    ...(deps.slots.pagination ?? []),
    corePlugin(deps),
    editorKeymap(deps),
    keymap(baseKeymap),
    gapCursor(),
    dropCursor(),
    columnResizeCommit(),
    columnResizing({ cellMinWidth: CELL_MIN_WIDTH, defaultCellMinWidth: DEFAULT_CELL_MIN_WIDTH }),
    wrappedTableEditing(isRemote),
  ];
}
