import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newClientId, newEpoch, type DocumentId, type Epoch } from '@open-docex/shared/ids';
import { CloseCode, PROTOCOL_VERSION, type HelloMsg, type RemoteMsg, type ServerMessage } from '@open-docex/shared/protocol';
import { Emitter, type ClientError, type MountEvents } from '../../src/events.js';
import { resolveLabels } from '../../src/labels.js';
import { createMount, type MountContext } from '../../src/mount.js';
import { withDefaults, type MountOptions } from '../../src/options.js';
import { MAX_FAILED_CONNECT_ATTEMPTS } from '../../src/errors/policy.js';
import { DocumentSession } from '../../src/session/DocumentSession.js';
import type { BindingContext, DocumentBinding, SessionSync } from '../../src/session/ports.js';
import { socketFactory } from './fake-socket.js';

const OTHER = newClientId();

const options = (extra: Partial<MountOptions> = {}): MountOptions => ({
  url: 'wss://example.test/odx',
  documentId: 'doc-1' as DocumentId,
  kind: 'text',
  ...extra,
});

/** A sync client that records calls and keeps a confirmed rev, like TextSyncClient. */
function fakeSync() {
  const calls: string[] = [];
  let state: { epoch: string; rev: number } | null = null;
  let pending: string[] = [];
  const m = {
    start: vi.fn((p: { epoch: string; rev: number; readOnly: boolean }) => {
      calls.push(`start:${p.rev}:${p.readOnly}`);
      state = { epoch: p.epoch, rev: p.rev };
    }),
    onRemote: vi.fn((m: RemoteMsg) => {
      calls.push(`remote:${m.fromRev}`);
      if (state !== null) state.rev = m.fromRev + m.ops.length;
    }),
    onAck: vi.fn(() => calls.push('ack')),
    onSubmitError: vi.fn(() => calls.push('submit-error')),
    onDisconnected: vi.fn(() => calls.push('disconnected')),
    onReconnected: vi.fn(() => calls.push('reconnected')),
    setReadOnly: vi.fn((ro: boolean) => calls.push(`read-only:${ro}`)),
    exportOrphans: vi.fn(() => {
      calls.push('export');
      return pending.length > 0 ? [...pending] : null;
    }),
    restoreOrphans: vi.fn((o: string[] | null) => calls.push(`restore:${o?.join(',') ?? 'null'}`)),
    destroy: vi.fn(() => calls.push('sync.destroy')),
  };
  const sync: SessionSync<string[]> = { ...m, resumeInfo: () => state };
  return { sync, m, calls, setPending: (p: string[]) => (pending = p) };
}

function harness(extra: Partial<MountOptions> = {}) {
  const f = socketFactory();
  const s = fakeSync();
  const shows: unknown[] = [];
  const emitter = new Emitter<MountEvents>();
  const errors: ClientError[] = [];
  emitter.on('error', (e) => errors.push(e));
  const events: string[] = [];
  emitter.on('ready', () => events.push('ready'));
  emitter.on('notice', (n) => events.push(`notice:${n.notice}`));
  let bctx: BindingContext | undefined;
  const binding: DocumentBinding<unknown> = {
    assembler: { assemble: (chunks) => chunks.map((c) => c.data) },
    sync: s.sync,
    show: (snap) => {
      shows.push(snap);
      s.calls.push('show');
    },
    destroy: vi.fn(() => s.calls.push('binding.destroy')),
  };
  const ctx: MountContext = {
    options: withDefaults(options(extra)),
    labels: resolveLabels(undefined),
    emitter,
    container: document.createElement('div'),
    clientId: newClientId(),
    idPrefix: 'odx0-',
  };
  const session = new DocumentSession(ctx, {
    createBinding: (c) => ((bctx = c), binding),
    createSocket: f.create,
    random: () => 0.5,
    onlineTarget: null,
  });
  return { f, s, session, ctx, errors, events, shows, binding, bctx: () => bctx! };
}

const epochA = newEpoch();
const epochB = newEpoch();

/** Plays a full load of `n` chunks at `rev`. */
function load(ws: { receive(m: ServerMessage): void }, rev: number, epoch: Epoch = epochA, n = 1, extra = {}): void {
  ws.receive({ type: 'load-start', epoch, rev, kind: 'text', access: 'edit', readOnly: false, ...extra });
  for (let i = 0; i < n; i++) ws.receive({ type: 'load-chunk', seq: i, data: { i } });
  ws.receive({ type: 'load-done', rev });
}

const hellos = (ws: { messages: unknown[] }) => ws.messages.filter((m) => (m as { type: string }).type === 'hello') as HelloMsg[];

describe('DocumentSession', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fits the MountSession seam of createMount', () => {
    const f = socketFactory();
    const host = document.createElement('div');
    const handle = createMount(host, options(), {
      createSession: (ctx) =>
        new DocumentSession(ctx, { createBinding: () => harness().binding, createSocket: f.create, onlineTarget: null }),
      renderShell: () => ({ unmount() {} }),
    });
    expect(f.sockets).toHaveLength(1);
    handle.destroy();
    expect(f.last().closedWith).toEqual({ code: 1000 });
  });

  it('sends hello without resume on the first open, then loads', () => {
    const h = harness();
    h.session.start();
    const ws = h.f.last();
    ws.open();
    expect(hellos(ws)).toEqual([{ type: 'hello', protocol: PROTOCOL_VERSION, clientId: h.ctx.clientId }]);
    expect(h.session.phase).toBe('handshake');
    load(ws, 4, epochA, 2);
    expect(h.shows).toEqual([[{ i: 0 }, { i: 1 }]]);
    expect(h.s.calls).toEqual(['show', 'start:4:false', 'restore:null']);
    expect(h.session.phase).toBe('live');
    expect(h.events).toEqual(['ready']);
    expect(h.session.getSnapshot().status).toMatchObject({ connection: 'open', load: 'ready', access: 'edit', readOnlyReason: null });
  });

  it('buffers remotes until load-done, then replays them in order before restoring orphans', () => {
    const h = harness();
    h.session.start();
    const ws = h.f.last();
    ws.open();
    ws.receive({ type: 'load-start', epoch: epochA, rev: 4, kind: 'text', access: 'edit', readOnly: false });
    ws.receive({ type: 'load-chunk', seq: 0, data: {} });
    ws.receive({ type: 'remote', fromRev: 4, ops: [{}], clientId: OTHER });
    ws.receive({ type: 'load-chunk', seq: 1, data: {} });
    ws.receive({ type: 'remote', fromRev: 5, ops: [{}, {}], clientId: OTHER });
    expect(h.s.m.onRemote).not.toHaveBeenCalled();
    ws.receive({ type: 'load-done', rev: 4 });
    expect(h.s.calls).toEqual(['show', 'start:4:false', 'remote:4', 'remote:5', 'restore:null']);
    ws.receive({ type: 'remote', fromRev: 7, ops: [{}], clientId: OTHER });
    expect(h.s.calls.at(-1)).toBe('remote:7');
  });

  it('reconnects with jitter and resumes from the confirmed rev (§6.1, R-8)', () => {
    const h = harness();
    h.session.start();
    let ws = h.f.last();
    ws.open();
    load(ws, 4);
    ws.receive({ type: 'remote', fromRev: 4, ops: [{}], clientId: OTHER });
    ws.serverClose(1006);
    expect(h.s.calls.at(-1)).toBe('disconnected');
    expect(h.session.getSnapshot().status.connection).toBe('reconnecting');
    // attempt 0: 0.5 × 500 ms.
    vi.advanceTimersByTime(249);
    expect(h.f.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    ws = h.f.last();
    ws.open();
    expect(hellos(ws)).toEqual([
      { type: 'hello', protocol: PROTOCOL_VERSION, clientId: h.ctx.clientId, resume: { epoch: epochA, rev: 5 } },
    ]);
    expect(h.s.calls.at(-1)).toBe('reconnected');
    expect(h.session.phase).toBe('handshake');
    // N4: notice first, then an ack for our own entry and a remote for another client's.
    ws.receive({ type: 'notice', notice: 'read-only', readOnly: false, reason: 'unsupported-content' });
    expect(h.session.phase).toBe('live');
    ws.receive({ type: 'ack', clientSeq: 1, rev: 6 });
    ws.receive({ type: 'remote', fromRev: 6, ops: [{}], clientId: OTHER });
    expect(h.s.calls.slice(-3)).toEqual(['read-only:false', 'ack', 'remote:6']);
    expect(h.s.m.start).toHaveBeenCalledOnce(); // no reload
  });

  it('backoff grows across failed attempts and resets once live', () => {
    const h = harness();
    h.session.start();
    h.f.last().open();
    load(h.f.last(), 1);
    h.f.last().serverClose(1006); // attempt 0: 250 ms
    vi.advanceTimersByTime(250);
    h.f.last().reject(); // attempt 1: 500 ms
    vi.advanceTimersByTime(499);
    expect(h.f.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(h.f.sockets).toHaveLength(3);
    h.f.last().open();
    h.f.last().receive({ type: 'notice', notice: 'storage', state: 'normal' }); // resume accepted → live
    h.f.last().serverClose(1001); // back to attempt 0: 250 ms
    vi.advanceTimersByTime(250);
    expect(h.f.sockets).toHaveLength(4);
  });

  it('resync: exports orphans and takes the full load on the same socket, with no new hello (R-9)', () => {
    const h = harness();
    h.session.start();
    let ws = h.f.last();
    ws.open();
    load(ws, 4);
    // An engine restart: reconnect with resume, and the old epoch triggers resync (PO-16).
    ws.serverClose(CloseCode.ENGINE_RESTARTING);
    vi.advanceTimersByTime(1000);
    ws = h.f.last();
    ws.open();
    expect(hellos(ws)[0]!.resume).toEqual({ epoch: epochA, rev: 4 });
    h.s.setPending(['p1', 'p2']);
    ws.receive({ type: 'resync', reason: 'epoch-changed' });
    expect(h.s.calls.slice(-2)).toEqual(['export', 'disconnected']);
    load(ws, 9, epochB);
    expect(h.f.sockets).toHaveLength(2);
    expect(hellos(ws)).toHaveLength(1);
    expect(ws.closedWith).toBeNull();
    expect(h.s.calls.slice(-3)).toEqual(['show', 'start:9:false', 'restore:p1,p2']);
    expect(h.session.phase).toBe('live');
    expect(h.events.filter((e) => e === 'ready')).toHaveLength(2);
  });

  it('resync while live does not reconnect; a later reconnect resumes the new load', () => {
    const h = harness();
    h.session.start();
    const ws = h.f.last();
    ws.open();
    load(ws, 4);
    ws.receive({ type: 'resync', reason: 'inconsistent' });
    expect(h.session.phase).toBe('handshake');
    ws.receive({ type: 'remote', fromRev: 4, ops: [{}], clientId: OTHER }); // not before load-start
    expect(h.s.m.onRemote).not.toHaveBeenCalled();
    load(ws, 6, epochB);
    ws.serverClose(1001);
    vi.advanceTimersByTime(250);
    h.f.last().open();
    expect(hellos(h.f.last())[0]!.resume).toEqual({ epoch: epochB, rev: 6 });
  });

  it('a close during the resync load reconnects without resume', () => {
    const h = harness();
    h.session.start();
    const ws = h.f.last();
    ws.open();
    load(ws, 4);
    ws.receive({ type: 'resync', reason: 'history-unavailable' });
    ws.receive({ type: 'load-start', epoch: epochB, rev: 6, kind: 'text', access: 'edit', readOnly: false });
    ws.serverClose(1006);
    vi.advanceTimersByTime(250);
    h.f.last().open();
    expect(hellos(h.f.last())[0]!.resume).toBeUndefined();
  });

  it('a reload decided by the sync client closes with 1000 and reconnects at once without resume, keeping orphans', () => {
    const h = harness();
    h.session.start();
    const ws = h.f.last();
    ws.open();
    load(ws, 4);
    h.s.setPending(['x']);
    h.bctx().reload('gap', false);
    expect(ws.closedWith).toEqual({ code: 1000 });
    expect(h.f.sockets).toHaveLength(2);
    h.f.last().open();
    expect(hellos(h.f.last())[0]!.resume).toBeUndefined();
    load(h.f.last(), 5);
    expect(h.s.calls.at(-1)).toBe('restore:x');
  });

  it('a discard reload restores no orphans', () => {
    const h = harness();
    h.session.start();
    h.f.last().open();
    load(h.f.last(), 4);
    h.s.setPending(['x']);
    h.bctx().reload('PROTOCOL_OP_REJECTED', true);
    h.f.last().open();
    load(h.f.last(), 5);
    expect(h.s.calls.at(-1)).toBe('restore:null');
  });

  it('an ErrorMsg then close with a reload policy reloads (SESSION_SLOW_CONSUMER)', () => {
    const h = harness();
    h.session.start();
    const ws = h.f.last();
    ws.open();
    load(ws, 4);
    ws.receive({ type: 'error', code: 'SESSION_SLOW_CONSUMER', retryable: true, message: 'slow' });
    ws.serverClose(CloseCode.SLOW_CONSUMER);
    expect(h.f.sockets).toHaveLength(2); // at once, no backoff
    h.f.last().open();
    expect(hellos(h.f.last())[0]!.resume).toBeUndefined();
    expect(h.errors.map((e) => e.code)).toEqual(['SESSION_SLOW_CONSUMER']);
    expect(h.errors[0]!.message).not.toBe('slow'); // sanitized catalogue text
  });

  it(`L-12: ${MAX_FAILED_CONNECT_ATTEMPTS} failed attempts → CLIENT_CONNECT_FAILED, then Retry reconnects`, () => {
    const onError = vi.fn();
    const h = harness({ hooks: { onError } });
    h.ctx.emitter.on('error', onError);
    h.session.start();
    for (let i = 0; i < MAX_FAILED_CONNECT_ATTEMPTS; i++) {
      h.f.last().reject();
      vi.advanceTimersByTime(60_000);
    }
    expect(h.f.sockets).toHaveLength(MAX_FAILED_CONNECT_ATTEMPTS);
    expect(h.session.phase).toBe('terminal');
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toMatchObject({ code: 'CLIENT_CONNECT_FAILED', terminal: true });
    const snap = h.session.getSnapshot();
    expect(snap.status.connection).toBe('failed');
    expect(snap.error?.code).toBe('CLIENT_CONNECT_FAILED');
    vi.advanceTimersByTime(600_000);
    expect(h.f.sockets).toHaveLength(MAX_FAILED_CONNECT_ATTEMPTS); // never retries on its own

    h.session.retry();
    expect(h.session.phase).toBe('connecting');
    expect(h.session.getSnapshot().error).toBeNull();
    expect(h.f.sockets).toHaveLength(MAX_FAILED_CONNECT_ATTEMPTS + 1);
    h.f.last().open();
    load(h.f.last(), 1);
    expect(h.session.phase).toBe('live');
  });

  it('an attempt that opens resets the L-12 count', () => {
    const h = harness();
    h.session.start();
    for (let i = 0; i < MAX_FAILED_CONNECT_ATTEMPTS - 1; i++) {
      h.f.last().reject();
      vi.advanceTimersByTime(60_000);
    }
    h.f.last().open();
    h.f.last().serverClose(1006);
    vi.advanceTimersByTime(60_000);
    for (let i = 0; i < MAX_FAILED_CONNECT_ATTEMPTS - 1; i++) {
      h.f.last().reject();
      vi.advanceTimersByTime(60_000);
    }
    expect(h.session.phase).not.toBe('terminal');
  });

  it('a kind mismatch is terminal with CONFIG_INVALID', () => {
    const h = harness();
    h.session.start();
    const ws = h.f.last();
    ws.open();
    ws.receive({ type: 'load-start', epoch: epochA, rev: 0, kind: 'sheet', access: 'edit', readOnly: false });
    expect(h.session.phase).toBe('terminal');
    expect(h.errors).toEqual([expect.objectContaining({ code: 'CONFIG_INVALID', terminal: true })]);
    expect(ws.closedWith).toEqual({ code: 1000 });
  });

  it('close 1000 is terminal with SESSION_CLOSED; 1008 with ACCESS_DENIED', () => {
    for (const [code, expected] of [[1000, 'SESSION_CLOSED'], [1008, 'ACCESS_DENIED']] as const) {
      const h = harness();
      h.session.start();
      h.f.last().open();
      load(h.f.last(), 1);
      h.f.last().serverClose(code);
      expect(h.session.phase).toBe('terminal');
      expect(h.errors.at(-1)).toMatchObject({ code: expected, terminal: true });
    }
  });

  it('a terminal ErrorMsg stops at once', () => {
    const h = harness();
    h.session.start();
    const ws = h.f.last();
    ws.open();
    ws.receive({ type: 'error', code: 'DOCUMENT_NOT_FOUND', retryable: false, message: 'm' });
    expect(h.session.phase).toBe('terminal');
    expect(ws.closedWith).toEqual({ code: 1000 });
    expect(h.errors).toHaveLength(1);
  });

  it('decode failures reload, and two in a row are terminal', () => {
    const h = harness();
    h.session.start();
    h.f.last().open();
    h.f.last().receiveRaw('garbage');
    expect(h.errors.at(-1)).toMatchObject({ code: 'PROTOCOL_INVALID_MESSAGE', terminal: false });
    expect(h.f.sockets).toHaveLength(2);
    h.f.last().open();
    h.f.last().receiveRaw('{"type":"load-chunk"}');
    expect(h.session.phase).toBe('terminal');
    expect(h.errors.at(-1)).toMatchObject({ code: 'PROTOCOL_INVALID_MESSAGE', terminal: true });
  });

  it('an out-of-order chunk reloads', () => {
    const h = harness();
    h.session.start();
    h.f.last().open();
    h.f.last().receive({ type: 'load-start', epoch: epochA, rev: 0, kind: 'text', access: 'edit', readOnly: false });
    h.f.last().receive({ type: 'load-chunk', seq: 1, data: {} });
    expect(h.f.sockets).toHaveLength(2);
    expect(h.s.m.start).not.toHaveBeenCalled();
  });

  it('routes submit errors to the sync client and surfaces them; notices update status', () => {
    const h = harness();
    h.session.start();
    const ws = h.f.last();
    ws.open();
    load(ws, 1);
    ws.receive({ type: 'error', code: 'QUEUE_FULL', retryable: true, message: 'm', clientSeq: 1 });
    expect(h.s.m.onSubmitError).toHaveBeenCalledOnce();
    expect(h.errors.at(-1)).toMatchObject({ code: 'QUEUE_FULL', terminal: false });
    ws.receive({ type: 'notice', notice: 'storage', state: 'local' });
    ws.receive({ type: 'notice', notice: 'read-only', readOnly: true, reason: 'unsupported-content' });
    expect(h.session.getSnapshot().status).toMatchObject({ storage: 'local', readOnlyReason: 'unsupported' });
    expect(h.s.m.setReadOnly).toHaveBeenCalledWith(true, 'unsupported');
    ws.receive({ type: 'notice', notice: 'engine-restarting' });
    expect(h.session.getSnapshot().status.connection).toBe('reconnecting');
    expect(h.events.slice(-3)).toEqual(['notice:storage', 'notice:read-only', 'notice:engine-restarting']);
  });

  it('a view session is read-only with reason view', () => {
    const h = harness();
    h.session.start();
    h.f.last().open();
    load(h.f.last(), 2, epochA, 1, { access: 'view', readOnly: false });
    expect(h.s.calls).toContain('start:2:true');
    expect(h.session.getSnapshot().ready).toMatchObject({ access: 'view', readOnly: true });
    expect(h.session.getSnapshot().status.readOnlyReason).toBe('view');
  });

  it('emits load-progress and sync, and publishes immutable snapshots', () => {
    const h = harness();
    const progress: unknown[] = [];
    const syncs: unknown[] = [];
    h.ctx.emitter.on('load-progress', (p) => progress.push(p));
    h.ctx.emitter.on('sync', (e) => syncs.push(e));
    const seen = vi.fn();
    h.session.subscribe(seen);
    const before = h.session.getSnapshot();
    h.session.start();
    h.f.last().open();
    load(h.f.last(), 3, epochA, 1, { totalChunks: 1 });
    expect(progress.at(-1)).toEqual({ chunksReceived: 1, bytesReceived: expect.any(Number) as number, totalChunks: 1 });
    h.bctx().emitSync({ pendingCount: 2, confirmedRev: 3 });
    expect(syncs).toEqual([{ pendingCount: 2, confirmedRev: 3 }]);
    expect(h.session.getSnapshot().status.sync).toBe('pending');
    expect(seen).toHaveBeenCalled();
    expect(h.session.getSnapshot()).not.toBe(before);
    expect(Object.isFrozen(h.session.getSnapshot())).toBe(true);
  });

  it('destroy() closes with 1000, clears timers, destroys sync and binding once', () => {
    const h = harness();
    h.session.start();
    h.f.last().open();
    load(h.f.last(), 1);
    h.session.destroy();
    h.session.destroy();
    expect(h.f.last().closedWith).toEqual({ code: 1000 });
    expect(vi.getTimerCount()).toBe(0);
    expect(h.s.calls.filter((c) => c === 'sync.destroy' || c === 'binding.destroy')).toEqual(['sync.destroy', 'binding.destroy']);
    h.f.last().serverClose(1006);
    expect(h.f.sockets).toHaveLength(1);
  });
});
