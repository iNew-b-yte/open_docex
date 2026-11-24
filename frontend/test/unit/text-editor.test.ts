import { afterEach, describe, expect, it, vi } from 'vitest';
import { textSchema } from '@open-docex/shared/text';
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, type Transaction } from 'prosemirror-state';
import { CellSelection, columnResizingPluginKey } from 'prosemirror-tables';
import type { EditorView } from 'prosemirror-view';
import type { TextToolbarItemId } from '../../src/options.js';
import type { EditorCommand } from '../../src/text/TextEditorView.js';
import {
  cell,
  doc,
  h,
  li,
  m,
  makeEditor,
  n,
  p,
  posOf,
  row,
  select,
  table,
  ul,
} from './text-fixtures.js';

const editors: { destroy(): void }[] = [];
function setup(d: PMNode, extra: Parameters<typeof makeEditor>[1] = {}, readOnly = false) {
  const e = makeEditor(d, extra, readOnly);
  editors.push(e.editor);
  const cmd = (id: TextToolbarItemId): EditorCommand => {
    const c = e.editor.commands().get(id);
    if (!c) throw new Error(`no command ${id}`);
    return c;
  };
  return { ...e, cmd };
}
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy();
  document.body.replaceChildren();
});

const body = (v: EditorView): PMNode => {
  let b: PMNode | null = null;
  v.state.doc.forEach((c) => {
    if (c.type === n.body) b = c;
  });
  if (b === null) throw new Error('no body');
  return b;
};
const key = (v: EditorView, init: KeyboardEventInit): KeyboardEvent => {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  v.dom.dispatchEvent(ev);
  return ev;
};

describe('TextEditorView basics', () => {
  it('builds every toolbar command, in toolbar order', () => {
    const { editor } = setup(doc(p('x')));
    expect([...editor.commands().keys()]).toContain('bold');
    expect(editor.commands().size).toBe(34);
  });

  it('builds only the configured items', () => {
    const { editor } = setup(doc(p('x')), {
      toolbar: { items: ['bold', 'link'], fontFamilies: [], fontSizes: [] },
    });
    expect([...editor.commands().keys()]).toEqual(['bold', 'link']);
  });

  it('notifies subscribers on state changes and replaces the state on a reload', () => {
    const { editor, view } = setup(doc(p('one')));
    const fn = vi.fn();
    const off = editor.subscribe(fn);
    select(view, 3);
    expect(fn).toHaveBeenCalledTimes(1);
    editor.load(doc(p('two')), { readOnly: false });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(editor.view.state.doc.textContent).toBe('two');
    off();
    select(editor.view, 3);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('puts plugin slots in the LLD order and rebuilds them on every load', () => {
    const made: string[] = [];
    const mk = (name: string) => new Plugin({ key: new PluginKey(name) });
    const { editor } = setup(doc(p('x')), {
      plugins: ({ readOnly }) => {
        made.push(String(readOnly));
        return { sync: [mk('sync')], regions: [mk('regions')], pagination: [mk('pagination')] };
      },
    });
    const keys = editor.view.state.plugins.map((pl) => (pl.spec.key as { key?: string } | undefined)?.key ?? '');
    const at = (k: string): number => keys.findIndex((x) => x.startsWith(k));
    expect(at('sync')).toBe(0);
    expect(at('regions')).toBe(1);
    expect(at('odx-image-upload')).toBe(2);
    expect(at('pagination')).toBe(3);
    expect(at('tableColumnResizing')).toBeLessThan(at('selectingCells'));
    expect(at('selectingCells')).toBe(keys.length - 1);
    editor.load(doc(p('y')), { readOnly: true });
    expect(made).toEqual(['false', 'true']);
  });

  it('has no history plugin, and swallows the undo and redo keys (PO-18)', () => {
    const { view } = setup(doc(p('abc')));
    expect(view.state.plugins.some((pl) => /history/i.test(String((pl.spec.key as { key?: string } | undefined)?.key)))).toBe(false);
    select(view, 3);
    const before = view.state.doc;
    for (const init of [
      { key: 'z', ctrlKey: true },
      { key: 'y', ctrlKey: true },
      { key: 'Z', ctrlKey: true, shiftKey: true },
    ]) {
      expect(key(view, init).defaultPrevented).toBe(true);
    }
    expect(view.state.doc.eq(before)).toBe(true);
    for (const inputType of ['historyUndo', 'historyRedo']) {
      const ev = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true });
      view.dom.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    }
  });

  it('disables every command while read-only, and setReadOnly switches it', () => {
    const { editor, view, cmd } = setup(doc(p('abc')), {}, true);
    select(view, 2, 4);
    expect(view.editable).toBe(false);
    for (const c of editor.commands().values()) expect(c.isEnabled(view.state)).toBe(false);
    expect(cmd('bold').run(view)).toBe(false);
    editor.setReadOnly(false);
    expect(view.editable).toBe(true);
    expect(cmd('bold').isEnabled(view.state)).toBe(true);
  });

  it('treats a read-only sync plugin as read-only too', () => {
    const syncRo = new Plugin({ props: { editable: () => false } });
    const { view, cmd } = setup(doc(p('abc')), { plugins: () => ({ sync: [syncRo] }) });
    select(view, 2, 4);
    expect(cmd('bold').isEnabled(view.state)).toBe(false);
  });
});

describe('marks and text style', () => {
  it('toggles bold, italic, underline and strike from the toolbar and the keys', () => {
    const { view, cmd } = setup(doc(p('hello')));
    select(view, 2, 4);
    for (const id of ['bold', 'italic', 'underline', 'strike'] as const) {
      expect(cmd(id).isActive?.(view.state)).toBe(false);
      expect(cmd(id).run(view)).toBe(true);
      expect(cmd(id).isActive?.(view.state)).toBe(true);
    }
    expect(view.state.doc.rangeHasMark(2, 4, m.strike)).toBe(true);
    key(view, { key: 'b', ctrlKey: true });
    expect(view.state.doc.rangeHasMark(2, 4, m.bold)).toBe(false);
    key(view, { key: 'X', ctrlKey: true, shiftKey: true });
    expect(view.state.doc.rangeHasMark(2, 4, m.strike)).toBe(false);
  });

  it('setTextStyle merges attributes per segment', () => {
    const red = m.text_style.create({ color: '#ff0000' });
    const big = m.text_style.create({ fontSize: 20 });
    const d = doc(n.paragraph.create(null, [textSchema.text('ab', [red]), textSchema.text('cd', [big])]));
    const { view, cmd } = setup(d);
    select(view, 2, 6);
    expect(cmd('fontFamily').run(view, 'Georgia')).toBe(true);
    const at = (pos: number) => m.text_style.isInSet(view.state.doc.resolve(pos).marks())?.attrs;
    expect(at(3)).toEqual({ fontFamily: 'Georgia', fontSize: null, color: '#ff0000' });
    expect(at(5)).toEqual({ fontFamily: 'Georgia', fontSize: 20, color: null });
    expect(cmd('fontFamily').value?.(view.state)).toBe('Georgia');
    expect(cmd('textColor').run(view, '#00FF00')).toBe(true);
    expect(at(3)?.color).toBe('#00ff00');
    expect(cmd('fontSize').run(view, 12)).toBe(true);
    expect(cmd('fontSize').value?.(view.state)).toBe(12);
    expect(cmd('textColor').run(view, null)).toBe(true);
    expect(at(5)).toEqual({ fontFamily: 'Georgia', fontSize: 12, color: null });
  });

  it('rejects invalid style values without changing the document', () => {
    const { view, cmd } = setup(doc(p('abc')));
    select(view, 2, 4);
    const before = view.state.doc;
    expect(cmd('textColor').run(view, 'red')).toBe(false);
    expect(cmd('fontSize').run(view, 0)).toBe(false);
    expect(cmd('fontFamily').run(view, '<script>')).toBe(false);
    expect(view.state.doc.eq(before)).toBe(true);
  });

  it('sets stored marks on an empty selection', () => {
    const { view, cmd } = setup(doc(p('abc')));
    select(view, 3);
    cmd('fontSize').run(view, 18);
    expect(m.text_style.isInSet(view.state.storedMarks ?? [])?.attrs.fontSize).toBe(18);
  });
});

describe('links', () => {
  it('adds, updates and removes a link; renders it with rel and target', () => {
    const requested: string[] = [];
    const { view, cmd } = setup(doc(p('go here')), { requestDialog: (id) => requested.push(id) });
    select(view, 2, 4);
    expect(cmd('link').run(view)).toBe(true);
    expect(requested).toEqual(['link']);
    expect(cmd('link').run(view, ' https://example.com/a ')).toBe(true);
    expect(cmd('link').value?.(view.state)).toBe('https://example.com/a');
    const a = view.dom.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.com/a');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(a?.getAttribute('target')).toBe('_blank');
    select(view, 3);
    expect(cmd('link').isEnabled(view.state)).toBe(true);
    expect(cmd('link').run(view, 'mailto:x@example.com')).toBe(true);
    expect(view.state.doc.rangeHasMark(2, 4, m.link)).toBe(true);
    expect(m.link.isInSet(view.state.doc.resolve(3).marks())?.attrs.href).toBe('mailto:x@example.com');
    expect(cmd('link').run(view, '')).toBe(true);
    expect(view.state.doc.rangeHasMark(2, 4, m.link)).toBe(false);
  });

  it('rejects javascript: and data: hrefs', () => {
    const { view, cmd } = setup(doc(p('click')));
    select(view, 2, 5);
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x']) {
      expect(cmd('link').run(view, bad)).toBe(false);
    }
    expect(view.state.doc.rangeHasMark(2, 5, m.link)).toBe(false);
  });

  it('is disabled with an empty selection outside a link', () => {
    const { view, cmd } = setup(doc(p('abc')));
    select(view, 3);
    expect(cmd('link').isEnabled(view.state)).toBe(false);
  });

  it('opens a link on Mod+click after re-validating it', () => {
    const open = vi.fn();
    const linked = n.paragraph.create(null, [textSchema.text('site', [m.link.create({ href: 'https://example.com' })])]);
    const { view } = setup(doc(linked), { opener: { open } });
    const handled = view.someProp('handleClick', (f) =>
      f(view, 3, new MouseEvent('click', { ctrlKey: true })),
    );
    expect(handled).toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    expect(view.someProp('handleClick', (f) => f(view, 3, new MouseEvent('click')))).toBeFalsy();
  });

  it('requests the link dialog with Mod-k', () => {
    const requested: string[] = [];
    const { view } = setup(doc(p('abc')), { requestDialog: (id) => requested.push(id) });
    select(view, 2, 4);
    expect(key(view, { key: 'k', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(requested).toEqual(['link']);
  });
});

describe('paragraphs and headings', () => {
  it('switches paragraph style and keeps the paragraph formatting', () => {
    const d = doc(n.paragraph.create({ align: 'center', spacingBefore: 6 }, [textSchema.text('T')]));
    const { view, cmd } = setup(d);
    select(view, 2);
    expect(cmd('paragraphStyle').value?.(view.state)).toBe(0);
    expect(cmd('paragraphStyle').run(view, 2)).toBe(true);
    const node = body(view).child(0);
    expect(node.type).toBe(n.heading);
    expect(node.attrs).toMatchObject({ level: 2, align: 'center', spacingBefore: 6 });
    expect(cmd('paragraphStyle').value?.(view.state)).toBe(2);
    expect(cmd('paragraphStyle').run(view, 0)).toBe(true);
    expect(body(view).child(0).type).toBe(n.paragraph);
    expect(cmd('paragraphStyle').run(view, 7)).toBe(false);
  });

  it('aligns every selected paragraph and heading', () => {
    const { view, cmd } = setup(doc(p('a'), h(1, 'b')));
    select(view, 2, 6);
    expect(cmd('alignLeft').isActive?.(view.state)).toBe(true);
    expect(cmd('alignJustify').run(view)).toBe(true);
    expect(body(view).child(0).attrs.align).toBe('justify');
    expect(body(view).child(1).attrs.align).toBe('justify');
    expect(cmd('alignJustify').isActive?.(view.state)).toBe(true);
    expect(cmd('alignCenter').run(view)).toBe(true);
    expect(cmd('alignRight').run(view)).toBe(true);
    expect(body(view).child(1).attrs.align).toBe('right');
  });

  it('sets spacing, indents and line height (PO-20)', () => {
    const { editor, view } = setup(doc(p('a'), h(2, 'b')));
    select(view, 2, 6);
    expect(
      editor.formatParagraph({
        spacingBefore: 12,
        spacingAfter: 6,
        indentLeft: 36,
        indentRight: 18,
        indentFirstLine: -18,
        lineHeight: { kind: 'multiple', value: 1.5 },
      }),
    ).toBe(true);
    for (const i of [0, 1]) {
      expect(body(view).child(i).attrs).toMatchObject({
        spacingBefore: 12,
        spacingAfter: 6,
        indentLeft: 36,
        indentRight: 18,
        indentFirstLine: -18,
        lineHeight: { kind: 'multiple', value: 1.5 },
      });
    }
    expect(editor.formatParagraph({ lineHeight: { kind: 'exact', pt: 14 }, spacingBefore: null })).toBe(true);
    expect(body(view).child(0).attrs).toMatchObject({ lineHeight: { kind: 'exact', pt: 14 }, spacingBefore: null });
    const before = view.state.doc;
    expect(editor.formatParagraph({ indentLeft: -1 })).toBe(false);
    expect(editor.formatParagraph({ lineHeight: { kind: 'multiple', value: 20 } })).toBe(false);
    expect(view.state.doc.eq(before)).toBe(true);
    expect(view.dom.querySelector('p')?.getAttribute('style')).toContain('line-height: 14pt');
  });

  it('inserts a hard break with Shift-Enter', () => {
    const { view } = setup(doc(p('ab')));
    select(view, 3);
    key(view, { key: 'Enter', shiftKey: true });
    expect(body(view).child(0).child(1).type).toBe(n.hard_break);
  });
});

describe('lists', () => {
  it('wraps in a list, indents, outdents and lifts', () => {
    const { view, cmd } = setup(doc(p('one'), p('two')));
    select(view, 3, 8);
    expect(cmd('bulletList').isActive?.(view.state)).toBe(false);
    expect(cmd('bulletList').run(view)).toBe(true);
    expect(body(view).child(0).type).toBe(n.bullet_list);
    expect(cmd('bulletList').isActive?.(view.state)).toBe(true);
    expect(cmd('orderedList').isActive?.(view.state)).toBe(false);
    select(view, posOf(view.state.doc, 'two'));
    expect(cmd('indent').isEnabled(view.state)).toBe(true);
    expect(cmd('indent').run(view)).toBe(true);
    expect(body(view).child(0).childCount).toBe(1);
    expect(cmd('outdent').run(view)).toBe(true);
    expect(body(view).child(0).childCount).toBe(2);
    select(view, posOf(view.state.doc, 'one'));
    expect(cmd('bulletList').run(view)).toBe(true);
    expect(body(view).child(0).type).toBe(n.paragraph);
  });

  it('makes an ordered list and is disabled for indent outside a list', () => {
    const { view, cmd } = setup(doc(p('x')));
    select(view, 2);
    expect(cmd('indent').isEnabled(view.state)).toBe(false);
    expect(cmd('orderedList').run(view)).toBe(true);
    expect(body(view).child(0).type).toBe(n.ordered_list);
  });

  it('splits list items with Enter and sinks them with Tab', () => {
    const { view } = setup(doc(ul(li(p('ab')))));
    select(view, posOf(view.state.doc, 'b') + 1);
    key(view, { key: 'Enter' });
    expect(body(view).child(0).childCount).toBe(2);
    key(view, { key: 'Tab' });
    expect(body(view).child(0).childCount).toBe(1);
  });
});

describe('tables', () => {
  it('inserts a table from the picker and puts the caret in the first cell', () => {
    const requested: string[] = [];
    const { view, cmd } = setup(doc(p('ab')), { requestDialog: (id) => requested.push(id) });
    select(view, 3);
    expect(cmd('insertTable').run(view)).toBe(true);
    expect(requested).toEqual(['insertTable']);
    expect(cmd('insertTable').run(view, { rows: 21, cols: 2 })).toBe(false);
    expect(cmd('insertTable').run(view, { rows: 2, cols: 3 })).toBe(true);
    const t = body(view).child(1);
    expect(t.type).toBe(n.table);
    expect(t.childCount).toBe(2);
    expect(t.child(0).childCount).toBe(3);
    expect(view.state.selection.$from.node(-1).type).toBe(n.table_cell);
    expect(cmd('tableAddRowAfter').isEnabled(view.state)).toBe(true);
  });

  it('runs the table commands', () => {
    const { view, cmd } = setup(doc(table(row(cell(null, p('a')), cell(null, p('b'))), row(cell(null), cell(null)))));
    select(view, posOf(view.state.doc, 'a'));
    const t = (): PMNode => body(view).child(0);
    expect(cmd('tableAddRowBefore').run(view)).toBe(true);
    expect(t().childCount).toBe(3);
    expect(cmd('tableDeleteRow').run(view)).toBe(true);
    expect(cmd('tableAddColAfter').run(view)).toBe(true);
    expect(t().child(0).childCount).toBe(3);
    expect(cmd('tableAddColBefore').run(view)).toBe(true);
    expect(cmd('tableDeleteCol').run(view)).toBe(true);
    expect(t().child(0).childCount).toBe(3);
    expect(cmd('tableToggleHeaderRow').run(view)).toBe(true);
    expect(t().child(0).child(0).type).toBe(n.table_header);
    expect(cmd('tableMerge').isEnabled(view.state)).toBe(false);
    const cells: number[] = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type.spec.tableRole === 'cell' || node.type.spec.tableRole === 'header_cell') cells.push(pos);
    });
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[0] as number, cells[1] as number)));
    expect(cmd('tableMerge').run(view)).toBe(true);
    expect(t().child(0).child(0).attrs.colspan).toBe(2);
    expect(cmd('tableSplit').run(view)).toBe(true);
    expect(t().child(0).child(0).attrs.colspan).toBe(1);
    expect(cmd('tableDelete').run(view)).toBe(true);
    expect(body(view).child(0).type).not.toBe(n.table);
  });

  it('merges resized cells by falling back to automatic widths instead of failing', () => {
    const { view, cmd } = setup(doc(table(row(cell({ colwidth: [80] }, p('a')), cell({ colwidth: [90] }, p('b'))))));
    const cells: number[] = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type === n.table_cell) cells.push(pos);
    });
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[0] as number, cells[1] as number)));
    expect(cmd('tableMerge').run(view)).toBe(true);
    const merged = body(view).child(0).child(0).child(0);
    expect(merged.attrs.colspan).toBe(2);
    expect(merged.attrs.colwidth).toBeNull();
    view.state.doc.check();
  });

  it('saves a whole-pixel colwidth on a column drag (PO-25)', () => {
    const d = doc(table(row(cell(null, p('a')), cell(null, p('b'))), row(cell(null, p('c')), cell({ colwidth: [70] }, p('d')))));
    const { view } = setup(d);
    const cells: number[] = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type === n.table_cell) cells.push(pos);
    });
    view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setHandle: cells[0] }));
    view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setDragging: { startX: 100, startWidth: 80.5 } }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 150.25 }));
    const t = body(view).child(0);
    expect(t.child(0).child(0).attrs.colwidth).toEqual([131]);
    expect(t.child(1).child(0).attrs.colwidth).toEqual([131]);
    expect(t.child(1).child(1).attrs.colwidth).toEqual([70]);
    expect(columnResizingPluginKey.getState(view.state)?.dragging).toBeFalsy();
    view.state.doc.check();
  });

  it('fills a merged cell’s other columns when one of them is resized', () => {
    const d = doc(table(row(cell({ colspan: 2 }, p('ab'))), row(cell({ colwidth: [60] }, p('c')), cell(null, p('d')))));
    const { view } = setup(d);
    let merged = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type === n.table_cell && node.attrs.colspan === 2) merged = pos;
    });
    view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setHandle: merged }));
    view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setDragging: { startX: 0, startWidth: 100 } }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 20 }));
    const t = body(view).child(0);
    expect(t.child(0).child(0).attrs.colwidth).toEqual([60, 120]);
    expect(t.child(1).child(1).attrs.colwidth).toEqual([120]);
    view.state.doc.check();
  });

  it('moves between cells with Tab', () => {
    const { view } = setup(doc(table(row(cell(null, p('a')), cell(null, p('b'))))));
    select(view, posOf(view.state.doc, 'a'));
    key(view, { key: 'Tab' });
    expect(view.state.selection.$from.parent.textContent).toBe('b');
  });

  it('skips fixTables after a remote transaction', () => {
    let remote = false;
    const ragged = doc(table(row(cell(null, p('a')), cell(null, p('b'))), row(cell(null, p('c')))));
    const { view } = setup(doc(p('x')), {
      plugins: () => ({ isRemote: (tr: Transaction) => tr.getMeta('remote') === true }),
    });
    remote = true;
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, ragged.content).setMeta('remote', remote);
    view.dispatch(tr);
    expect(body(view).child(0).child(1).childCount).toBe(1);
    view.dispatch(view.state.tr.insertText('!', posOf(view.state.doc, 'c')));
    expect(body(view).child(0).child(1).childCount).toBe(2);
  });
});

describe('page breaks, regions and page setup', () => {
  it('inserts a page break at the body top level, splitting the paragraph', () => {
    const { view, cmd } = setup(doc(p('abcd')));
    select(view, 4);
    expect(cmd('pageBreak').run(view)).toBe(true);
    const b = body(view);
    expect([b.child(0).textContent, b.child(1).type.name, b.child(2).textContent]).toEqual(['ab', 'page_break', 'cd']);
    expect(view.state.selection.$from.parent.textContent).toBe('cd');
    select(view, posOf(view.state.doc, 'cd') + 2);
    key(view, { key: 'Enter', ctrlKey: true });
    expect(body(view).child(3).type).toBe(n.page_break);
    view.state.doc.check();
  });

  it('is disabled inside a list or table', () => {
    const { view, cmd } = setup(doc(ul(li(p('a')))));
    select(view, posOf(view.state.doc, 'a'));
    expect(cmd('pageBreak').isEnabled(view.state)).toBe(false);
  });

  it('adds and removes the header and footer', () => {
    const { view, cmd } = setup(doc(p('a')));
    expect(cmd('header').isActive?.(view.state)).toBe(false);
    expect(cmd('header').run(view)).toBe(true);
    expect(view.state.doc.firstChild?.type).toBe(n.header);
    expect(cmd('header').isActive?.(view.state)).toBe(true);
    expect(cmd('footer').run(view)).toBe(true);
    expect(view.state.doc.lastChild?.type).toBe(n.footer);
    expect(cmd('header').run(view)).toBe(true);
    expect(cmd('footer').run(view)).toBe(true);
    expect(view.state.doc.childCount).toBe(1);
  });

  it('changes page settings with DocAttrSteps and refuses margins that do not fit', () => {
    const requested: string[] = [];
    const { view, cmd } = setup(doc(p('a')), { requestDialog: (id) => requested.push(id) });
    expect(cmd('pageSetup').run(view)).toBe(true);
    expect(requested).toEqual(['pageSetup']);
    expect(cmd('pageSetup').run(view, { orientation: 'landscape', size: { width: 612, height: 792 } })).toBe(true);
    expect(view.state.doc.attrs.orientation).toBe('landscape');
    expect(view.state.doc.attrs.size).toEqual({ width: 612, height: 792 });
    const before = view.state.doc;
    expect(cmd('pageSetup').run(view, { margins: { top: 10, right: 300, bottom: 10, left: 300 } })).toBe(false);
    expect(cmd('pageSetup').run(view, { orientation: 'sideways' as never })).toBe(false);
    expect(view.state.doc.eq(before)).toBe(true);
  });
});
