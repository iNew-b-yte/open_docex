// @vitest-environment jsdom
/**
 * `mount` end to end against a scripted fake server (V1-36): load with chunks, remote and local
 * changes, the unsupported banner with "Edit anyway", and a clean `destroy`. The check against
 * the real server is the E2E suite (V1-40).
 */
import { newClientId, type DocumentId } from '@open-docex/shared/ids';
import type { ServerMessage, SubmitMsg } from '@open-docex/shared/protocol';
import { TextOtType } from '@open-docex/shared/text';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSeams, createMount, type MountHandle } from '../../src/mount.js';
import type { MountOptions } from '../../src/options.js';
import type { TextEditorView } from '../../src/text/TextEditorView.js';
import { socketFactory } from './fake-socket.js';
import { bodyDoc, insertOps } from './sync/fake-server.js';
import { installDomStubs } from './text-fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EPOCH = 'e'.repeat(22) as never;
const OTHER = newClientId();
const flush = (): Promise<void> => act(async () => {});

function setup(extra: Partial<MountOptions> = {}) {
  installDomStubs();
  const f = socketFactory();
  const host = document.body.appendChild(document.createElement('div'));
  let editor: TextEditorView | undefined;
  const handle: MountHandle = createMount(
    host,
    { url: 'wss://example.test/odx', documentId: 'doc-1' as DocumentId, kind: 'text', ...extra },
    createDefaultSeams({ createSocket: f.create, random: () => 0.5, onlineTarget: null, onEditor: (e) => (editor = e) }),
  );
  return { f, host, handle, editor: (): TextEditorView => editor as TextEditorView, ws: () => f.last() };
}

/** Plays a load of `texts` as chunks at `rev`. */
function playLoad(ws: { receive(m: ServerMessage): void }, texts: string[], extra: object = {}, rev = 0): void {
  const chunks = TextOtType.chunk(bodyDoc(...texts), { textBlocks: 1, sheetRows: 100, maxBytes: 1_000_000 });
  ws.receive({
    type: 'load-start', epoch: EPOCH, rev, kind: 'text', access: 'edit', readOnly: false, totalChunks: chunks.length, ...extra,
  });
  for (const c of chunks) ws.receive({ type: 'load-chunk', seq: c.seq, data: c.data });
  ws.receive({ type: 'load-done', rev });
}

const submits = (ws: { messages: unknown[] }): SubmitMsg[] =>
  ws.messages.filter((m) => (m as { type: string }).type === 'submit') as SubmitMsg[];

let live: MountHandle[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(async () => {
  for (const h of live) h.destroy();
  live = [];
  await flush();
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('mount wiring', () => {
  it('loads a chunked document, renders the editor, applies a remote and acks a local change', async () => {
    const s = setup();
    live.push(s.handle);
    const events: string[] = [];
    s.handle.on('ready', () => events.push('ready'));
    const syncs: number[] = [];
    s.handle.on('sync', (e) => syncs.push(e.pendingCount));
    await flush();
    s.ws().open();
    playLoad(s.ws(), ['one', 'two', 'three']);
    await flush();
    expect(events).toEqual(['ready']);
    const dom = s.host.querySelector('.odx-root .odx-editor-host .odx-editor-surface .odx-text-editor');
    expect(dom).not.toBeNull();
    expect(s.editor().view.state.doc.textContent).toContain('onetwothree');
    expect(s.host.querySelector('.odx-toolbar')).not.toBeNull();

    // A remote change from another client.
    s.ws().receive({
      type: 'remote', fromRev: 0, ops: insertOps(s.editor().view.state.doc, 2, 'R'), clientId: OTHER,
    });
    await flush();
    expect(s.editor().view.state.doc.textContent).toContain('Rone');

    // A local change is submitted, then confirmed.
    const view = s.editor().view;
    view.dispatch(view.state.tr.insertText('L', 2));
    await flush();
    const sent = submits(s.ws());
    expect(sent).toHaveLength(1);
    expect(sent[0]?.baseRev).toBe(1);
    expect(syncs.at(-1)).toBe(1);
    expect(s.host.querySelector('.odx-statusbar')?.textContent).toContain('1');
    s.ws().receive({ type: 'ack', clientSeq: sent[0]!.clientSeq, rev: 2 });
    await flush();
    expect(syncs.at(-1)).toBe(0);
    expect(view.state.doc.textContent).toContain('LRone');
  });

  it('shows the unsupported banner and enables editing after "Edit anyway"', async () => {
    const onEditAnyway = vi.fn(() => Promise.resolve());
    const s = setup({ hooks: { onEditAnyway } });
    live.push(s.handle);
    await flush();
    s.ws().open();
    playLoad(s.ws(), ['text'], { readOnly: true, unsupported: [{ feature: 'comments', count: 2 }] });
    await flush();
    expect(s.host.querySelector('.odx-banner')).not.toBeNull();
    expect(s.host.querySelector('.odx-badge')).not.toBeNull();
    expect(s.editor().view.editable).toBe(false);
    const btn = s.host.querySelector<HTMLButtonElement>('.odx-banner .odx-btn');
    expect(btn).not.toBeNull();
    act(() => { btn!.click(); });
    expect(onEditAnyway).toHaveBeenCalledWith('doc-1');

    s.ws().receive({ type: 'notice', notice: 'read-only', readOnly: false, reason: 'unsupported-content' });
    await flush();
    expect(s.editor().view.editable).toBe(true);
    expect(s.host.querySelector('.odx-badge')).toBeNull();
    expect(s.host.querySelector('.odx-banner .odx-btn')).toBeNull();
  });

  it('exposes conversions and the pending count to the shell', async () => {
    const s = setup();
    live.push(s.handle);
    await flush();
    s.ws().open();
    playLoad(s.ws(), ['x'], { conversions: [{ feature: 'image-to-png', count: 3 }] });
    await flush();
    expect(s.host.querySelector('.odx-banner-conversions')?.textContent).toContain('3');
  });

  it('destroy leaves no listener, timer, blob URL, React root or DOM behind', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const s = setup();
    await flush();
    s.ws().open();
    playLoad(s.ws(), ['one', 'two']);
    await flush();
    const view = s.editor().view;
    view.dispatch(view.state.tr.insertText('L', 2));
    await flush();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const unload = add.mock.calls.filter(([t]) => t === 'beforeunload');
    expect(unload).toHaveLength(1);

    s.handle.destroy();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(remove.mock.calls.filter(([t]) => t === 'beforeunload')).toHaveLength(1);
    expect(s.ws().closedWith).toEqual({ code: 1000 });
    expect(s.host.childElementCount).toBe(0);
    expect(view.isDestroyed).toBe(true);
    const created = (URL.createObjectURL as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect((URL.revokeObjectURL as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(created);
    // Destroying again, or a late message, does nothing.
    s.handle.destroy();
    s.ws().receive({ type: 'remote', fromRev: 1, ops: [], clientId: OTHER });
    expect(s.host.childElementCount).toBe(0);
  });
});
