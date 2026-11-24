import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState, Plugin, TextSelection, type Transaction } from 'prosemirror-state';
import { Transform } from 'prosemirror-transform';
import { EditorView } from 'prosemirror-view';
import { collabSyncPlugin, getSyncState, isRebuild, syncKey } from '../../../src/sync/collabSyncPlugin.js';
import { Divergence, parseSteps, rebuild, stepsJson } from '../../../src/sync/xform.js';
import { bodyDoc, insertSteps, texts } from './fake-server.js';

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
});

function makeView(opts: { readOnly?: boolean; plugins?: Plugin[]; text?: string } = {}) {
  const scheduler = { scheduleFlush: vi.fn() };
  const state = EditorState.create({
    doc: bodyDoc(opts.text ?? 'cat'),
    plugins: [collabSyncPlugin(scheduler, { readOnly: opts.readOnly ?? false }), ...(opts.plugins ?? [])],
  });
  const view = new EditorView(document.createElement('div'), { state });
  views.push(view);
  return { view, scheduler };
}

const insert = (view: EditorView, text: string, pos: number): void => view.dispatch(view.state.tr.insertText(text, pos));

function key(view: EditorView, init: KeyboardEventInit & { keyCode?: number }): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(ev, 'keyCode', { value: init.keyCode });
  view.dom.dispatchEvent(ev);
  return ev;
}

describe('collabSyncPlugin', () => {
  it('records each local step as pending with its inverse', () => {
    const { view } = makeView();
    insert(view, 'X', 2);
    view.dispatch(view.state.tr.insertText('Y', 3).insertText('Z', 4));
    const ps = getSyncState(view.state);
    expect(ps.pending).toHaveLength(3);
    expect(ps.inflightCount).toBe(0);
    // The inverses, newest first, take the document back to the start.
    const tr = view.state.tr;
    for (const p of [...ps.pending].reverse()) tr.step(p.inverted);
    expect(texts(tr.doc)).toEqual(['cat']);
  });

  it('captures steps that other plugins append', () => {
    const appender = new Plugin({
      appendTransaction: (trs, _old, state) =>
        trs.some((t) => t.docChanged && t.getMeta('appended') !== true)
          ? state.tr.insertText('!', state.doc.content.size - 2).setMeta('appended', true)
          : null,
    });
    const { view } = makeView({ plugins: [appender] });
    insert(view, 'X', 2);
    expect(texts(view.state.doc)).toEqual(['Xcat!']);
    expect(getSyncState(view.state).pending).toHaveLength(2);
  });

  it('applies the set-inflight, rebuild and read-only metas', () => {
    const { view } = makeView();
    insert(view, 'X', 2);
    view.dispatch(view.state.tr.setMeta(syncKey, { kind: 'set-inflight', inflightCount: 1 }));
    expect(getSyncState(view.state).inflightCount).toBe(1);
    view.dispatch(view.state.tr.setMeta(syncKey, { kind: 'rebuild', pending: [], inflightCount: 0 }));
    expect(getSyncState(view.state)).toMatchObject({ pending: [], inflightCount: 0 });
    view.dispatch(view.state.tr.setMeta(syncKey, { kind: 'read-only', readOnly: true }));
    expect(getSyncState(view.state).readOnly).toBe(true);
  });

  it('blocks local document changes while read-only, including appended ones, but not rebuilds', () => {
    const appender = new Plugin({
      appendTransaction: (trs, _old, state) =>
        trs.some((t) => isRebuild(t)) ? state.tr.insertText('!', 2) : null,
    });
    const { view } = makeView({ readOnly: true, plugins: [appender] });
    expect(view.editable).toBe(false);
    insert(view, 'X', 2);
    expect(texts(view.state.doc)).toEqual(['cat']);
    // A selection change is not a document change.
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
    expect(view.state.selection.head).toBe(3);
    // A rebuild (a remote) still applies; the appended local change is filtered out.
    const remote = view.state.tr.insertText('R', 2);
    remote.setMeta(syncKey, { kind: 'rebuild', pending: [], inflightCount: 0 });
    view.dispatch(remote);
    expect(texts(view.state.doc)).toEqual(['Rcat']);
    expect(getSyncState(view.state).pending).toHaveLength(0);
    view.dispatch(view.state.tr.setMeta(syncKey, { kind: 'read-only', readOnly: false }));
    expect(view.editable).toBe(true);
  });

  it('schedules a flush after every view update', () => {
    const { view, scheduler } = makeView();
    scheduler.scheduleFlush.mockClear();
    insert(view, 'X', 2);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    expect(scheduler.scheduleFlush).toHaveBeenCalledTimes(2);
  });

  it('isRebuild is true only for rebuild transactions', () => {
    const { view } = makeView();
    const tr: Transaction = view.state.tr;
    expect(isRebuild(tr)).toBe(false);
    expect(isRebuild(tr.setMeta(syncKey, { kind: 'rebuild', pending: [], inflightCount: 0 }))).toBe(true);
  });

  describe('no undo or redo (PO-18)', () => {
    it.each([
      ['Ctrl+Z', { key: 'z', ctrlKey: true, keyCode: 90 }],
      ['Ctrl+Y', { key: 'y', ctrlKey: true, keyCode: 89 }],
      ['Ctrl+Shift+Z', { key: 'Z', ctrlKey: true, shiftKey: true, keyCode: 90 }],
    ])('%s is swallowed and changes nothing', (_name, init) => {
      const { view } = makeView();
      insert(view, 'X', 2);
      const ev = key(view, init);
      expect(ev.defaultPrevented).toBe(true);
      expect(texts(view.state.doc)).toEqual(['Xcat']);
      expect(getSyncState(view.state).pending).toHaveLength(1);
    });

    it('leaves other keys alone', () => {
      const { view } = makeView();
      expect(key(view, { key: 'q', ctrlKey: true, keyCode: 81 }).defaultPrevented).toBe(false);
    });

    it.each(['historyUndo', 'historyRedo'])('cancels native %s input', (inputType) => {
      const { view } = makeView();
      const ev = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true });
      view.dom.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    });

    it('does not cancel ordinary input', () => {
      const { view } = makeView();
      const ev = new InputEvent('beforeinput', { inputType: 'insertText', data: 'a', bubbles: true, cancelable: true });
      view.dom.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    });
  });
});

describe('rebuild (§7.2)', () => {
  it('undoes local steps, applies over and re-applies the rest in one transaction', () => {
    const { view } = makeView({ text: 'hello' });
    insert(view, 'XY', 7); // "helloXY"
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 8))); // between X and Y
    const over = insertSteps(bodyDoc('hello'), 2, 'Q');
    const r = rebuild(view.state, getSyncState(view.state).pending, over);
    expect(texts(r.tr.doc)).toEqual(['QhelloXY']);
    expect(r.kept).toEqual([0]);
    expect(r.newKeep).toHaveLength(1);
    expect(r.tr.getMeta('addToHistory')).toBe(false);
    // The caret stays between X and Y (mirror mapping).
    expect(r.tr.selection.head).toBe(9);
    expect(r.tr.doc.textBetween(r.tr.selection.head - 1, r.tr.selection.head + 1)).toBe('XY');
    // The new inverses undo the rebased steps.
    const undo = new Transform(r.tr.doc);
    for (const p of [...r.newKeep].reverse()) undo.step(p.inverted);
    expect(texts(undo.doc)).toEqual(['Qhello']);
  });

  it('drops local steps whose range the remote deleted', () => {
    const { view } = makeView({ text: 'hello' });
    insert(view, 'X', 4); // "heXllo"
    const over = new Transform(bodyDoc('hello')).delete(3, 6).steps; // deletes "ell"
    const r = rebuild(view.state, getSyncState(view.state).pending, over);
    expect(texts(r.tr.doc)).toEqual(['ho']);
    expect(r.kept).toEqual([]);
    expect(r.newKeep).toEqual([]);
  });

  it('throws Divergence when over does not apply', () => {
    const { view } = makeView({ text: 'hi' });
    const over = insertSteps(bodyDoc('a much longer text'), 15, 'Q');
    expect(() => rebuild(view.state, [], over)).toThrow(Divergence);
  });

  it('parseSteps rejects ops that are not steps', () => {
    expect(parseSteps([{ stepType: 'nope' }])).toBeNull();
    expect(parseSteps([null])).toBeNull();
    expect(parseSteps([{ stepType: 'replace', from: 2, to: 2, slice: { content: [{ type: 'bogus' }] } }])).toBeNull();
    const steps = insertSteps(bodyDoc('a'), 2, 'b');
    expect(stepsJson(parseSteps(stepsJson(steps)) ?? [])).toEqual(stepsJson(steps));
  });
});
