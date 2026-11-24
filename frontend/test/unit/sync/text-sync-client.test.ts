import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { newClientId } from '@open-docex/shared/ids';
import type { RemoteMsg } from '@open-docex/shared/protocol';
import { getSyncState } from '../../../src/sync/collabSyncPlugin.js';
import { FakeServer, TestClient, bodyDoc, insertOps, settle, texts, tick } from './fake-server.js';

const OTHER = newClientId();
const clients: TestClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.destroy();
  vi.useRealTimers();
});

function client(server: FakeServer, opts: ConstructorParameters<typeof TestClient>[1] = {}): TestClient {
  const c = new TestClient(server, opts);
  clients.push(c);
  return c;
}

/** Another user commits `text` at `pos` on the server's current document. */
function otherTypes(server: FakeServer, pos: number, text: string): void {
  server.commitFrom(OTHER, insertOps(server.doc, pos, text));
}

function expectConverged(server: FakeServer, ...cs: TestClient[]): void {
  for (const c of cs) {
    expect(texts(c.doc)).toEqual(texts(server.doc));
    expect(c.doc.eq(server.doc)).toBe(true);
    expect(c.pending).toBe(0);
    expect(c.client.resumeInfo()?.rev).toBe(server.rev);
  }
}

describe('TextSyncClient: concurrency (§7.4)', () => {
  // "cat": c [2,3), a [3,4), t [4,5). Both users type right after "c".
  it.each(['A', 'B'])('BRD "cat": the server takes %s first, and both converge', async (first) => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    const b = client(server);
    server.holdInbox = true;
    await a.type('h', 3);
    await b.type('o', 3);
    expect(server.inbox).toHaveLength(2);
    if (first === 'B') server.inbox.reverse();
    server.holdInbox = false;
    server.processInbox();
    await settle(a, b);

    expectConverged(server, a, b);
    const [winner, loser] = first === 'A' ? [a, b] : [b, a];
    const [wl, ll] = first === 'A' ? ['h', 'o'] : ['o', 'h'];
    expect(texts(server.doc)).toEqual([`c${wl}${ll}at`]);
    // §0.5 S-37: each caret stays right after its own letter. The later letter is re-applied
    // with a mirror; the earlier writer's caret stays before the remote letter inserted at it.
    expect(loser.caret).toBe(5);
    expect(winner.caret).toBe(4);
    const shown = (c: TestClient): string => {
      const t = texts(c.doc)[0] ?? '';
      return `${t.slice(0, c.caret - 2)}|${t.slice(c.caret - 2)}`;
    };
    expect(shown(winner)).toBe(`c${wl}|${ll}at`);
    expect(shown(a)).toBe(first === 'A' ? 'ch|oat' : 'coh|at');
  });

  it('applies a remote in one transaction while typing is in flight and buffered, and keeps the caret', async () => {
    const server = new FakeServer(bodyDoc('hello'));
    const a = client(server);
    server.holdInbox = true;
    await a.type('X', 7); // in flight
    await a.type('YZ', 8); // buffered
    expect(a.inflightCount).toBe(1);
    expect(a.pending).toBe(2);
    a.view.dispatch(a.view.state.tr.setSelection(TextSelection.create(a.doc, 9))); // between Y and Z
    otherTypes(server, 2, 'Q');

    const dispatch = vi.spyOn(a.view, 'dispatch');
    await a.deliver();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(texts(a.doc)).toEqual(['QhelloXYZ']);
    expect(a.caret).toBe(10);
    expect(a.doc.textBetween(a.caret - 1, a.caret + 1)).toBe('YZ');
    expect(a.inflightCount).toBe(1);

    server.holdInbox = false;
    server.processInbox();
    await settle(a);
    expectConverged(server, a);
    expect(texts(server.doc)).toEqual(['QhelloXYZ']);
  });

  it('a remote insert just before the caret still shifts the caret right', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    a.view.dispatch(a.view.state.tr.setSelection(TextSelection.create(a.doc, 4))); // ca|t
    otherTypes(server, 3, 'Q'); // before the caret, not at it
    await a.deliver();
    expect(texts(a.doc)).toEqual(['cQat']);
    expect(a.caret).toBe(5); // cQa|t
  });

  it('a remote insert exactly at the caret stays after it', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    a.view.dispatch(a.view.state.tr.setSelection(TextSelection.create(a.doc, 4)));
    otherTypes(server, 4, 'Q');
    await a.deliver();
    expect(texts(a.doc)).toEqual(['caQt']);
    expect(a.caret).toBe(4); // ca|Qt
  });

  it('keeps one batch in flight: later typing waits for the ack', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    await a.type('X', 2);
    await a.type('Y', 3);
    await a.type('Z', 4);
    expect(a.sent).toHaveLength(1);
    expect(a.inflightCount).toBe(1);
    expect(a.pending).toBe(3);
    await a.deliver(1);
    expect(a.sent).toHaveLength(2);
    expect(a.sent[1]?.ops).toHaveLength(2);
    await settle(a);
    expect(a.sent).toHaveLength(2);
    expectConverged(server, a);
  });

  it('splits pending steps into batches of maxBatchSteps', async () => {
    const server = new FakeServer(bodyDoc(''));
    const a = client(server, { maxBatchSteps: 2 });
    const tr = a.view.state.tr;
    for (let i = 0; i < 5; i++) tr.insertText(String(i), 2 + i);
    a.view.dispatch(tr);
    await tick();
    expect(a.sent.map((m) => m.ops.length)).toEqual([2]);
    await settle(a);
    expect(a.sent.map((m) => m.ops.length)).toEqual([2, 2, 1]);
    expect(a.sent.map((m) => m.clientSeq)).toEqual([1, 2, 3]);
    expectConverged(server, a);
    expect(texts(server.doc)).toEqual(['01234']);
  });

  it('flushes same-tick transactions as one batch', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    a.view.dispatch(a.view.state.tr.insertText('X', 2));
    a.view.dispatch(a.view.state.tr.insertText('Y', 3));
    await tick();
    expect(a.sent).toHaveLength(1);
    expect(a.sent[0]?.ops).toHaveLength(2);
  });
});

describe('TextSyncClient: acks and the committed echo (§7.3, Part 1 §8.6)', () => {
  it('an ack without committed trims pending, and the next batch uses the new baseRev', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    await a.type('X', 2);
    await a.type('Y', 3);
    expect(server.queue(a.id)[0]).toEqual({ type: 'ack', clientSeq: 1, rev: 1 });
    await a.deliver(1);
    expect(a.pending).toBe(1);
    expect(a.inflightCount).toBe(1);
    expect(a.sent[1]).toMatchObject({ type: 'submit', clientId: a.id, clientSeq: 2, baseRev: 1, epoch: server.epoch });
    await settle(a);
    expectConverged(server, a);
    expect(a.syncs.at(-1)).toEqual({ pendingCount: 0, confirmedRev: 2 });
  });

  it('an ack whose committed equals the in-flight steps changes nothing', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    server.holdInbox = true;
    await a.type('X', 4);
    otherTypes(server, 2, 'Q');
    await a.deliver(); // the remote: X is rebased locally
    server.holdInbox = false;
    server.processInbox();
    const ack = server.queue(a.id)[0];
    expect(ack).toMatchObject({ type: 'ack', committed: expect.any(Array) as unknown });
    const before = a.doc;
    const dispatch = vi.spyOn(a.view, 'dispatch');
    await a.deliver();
    expect(a.doc).toBe(before);
    expect(dispatch).toHaveBeenCalledTimes(1); // the metadata-only confirmation
    expectConverged(server, a);
  });

  it('an ack with a different committed corrects the document, and the client converges', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    server.holdInbox = true;
    a.view.dispatch(a.view.state.tr.insertText('X', 2).insertText('Y', 3)); // two steps in flight
    await tick();
    await a.type('Z', 4); // buffered after them
    expect(texts(a.doc)).toEqual(['XYZcat']);
    server.dropLastOfNext = true; // the server drops Y
    server.holdInbox = false;
    server.processInbox();
    expect(texts(server.doc)).toEqual(['Xcat']);

    await a.deliver();
    expect(texts(a.doc)).toEqual(['XZcat']);
    expect(a.pending).toBe(1);
    await settle(a);
    expectConverged(server, a);
    expect(texts(server.doc)).toEqual(['XZcat']);
  });

  it('ignores an ack for a clientSeq that is not in flight (C-4)', () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    a.client.onAck({ type: 'ack', clientSeq: 9, rev: 1 });
    expect(a.reloads).toEqual([]);
    expect(a.client.resumeInfo()?.rev).toBe(0);
  });

  it('reloads when ack.rev does not match', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    server.holdInbox = true;
    await a.type('X', 2);
    a.client.onAck({ type: 'ack', clientSeq: 1, rev: 5 });
    expect(a.reloads).toEqual([{ reason: 'ack-rev', discard: false }]);
    expect(a.orphansAtReload).toMatchObject({ baseRev: 0, inflightSeq: 1, inflightCount: 1 });
  });
});

describe('TextSyncClient: remotes (§7.3)', () => {
  const remote = (fromRev: number, ops: unknown[]): RemoteMsg => ({ type: 'remote', fromRev, ops, clientId: OTHER });

  it('requests a reload on a gap in fromRev', () => {
    const a = client(new FakeServer(bodyDoc('cat')));
    a.client.onRemote(remote(3, insertOps(a.doc, 2, 'Q')));
    expect(a.reloads).toEqual([{ reason: 'gap', discard: false }]);
  });

  it('ignores a remote it already has (overlap after a resume)', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    otherTypes(server, 2, 'Q');
    const m = server.queue(a.id)[0] as RemoteMsg;
    await a.deliver();
    a.client.onRemote(m);
    expect(a.reloads).toEqual([]);
    expect(texts(a.doc)).toEqual(['Qcat']);
  });

  it('requests a reload on malformed remote JSON', () => {
    const a = client(new FakeServer(bodyDoc('cat')));
    a.client.onRemote(remote(0, [{ stepType: 'replace', slice: { content: [{ type: 'nope' }] }, from: 2, to: 2 }]));
    expect(a.reloads).toEqual([{ reason: 'bad-step', discard: false }]);
    expect(texts(a.doc)).toEqual(['cat']);
  });

  it('requests a reload when a remote does not apply', () => {
    const a = client(new FakeServer(bodyDoc('cat')));
    a.client.onRemote(remote(0, insertOps(bodyDoc('a much longer paragraph'), 20, 'Q')));
    expect(a.reloads).toEqual([{ reason: 'remote-apply', discard: false }]);
  });

  it('confirms the in-flight batch from a remote with its own clientId (defensive, R-8)', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    await a.type('X', 2);
    const ops = a.sent[0]?.ops as unknown[];
    server.take(a.id);
    a.client.onRemote({ type: 'remote', fromRev: 0, ops, clientId: a.id });
    expect(a.pending).toBe(0);
    expect(a.client.resumeInfo()?.rev).toBe(1);
  });

  it('reloads on its own remote with nothing in flight', () => {
    const a = client(new FakeServer(bodyDoc('cat')));
    a.client.onRemote({ type: 'remote', fromRev: 0, ops: insertOps(a.doc, 2, 'Q'), clientId: a.id });
    expect(a.reloads).toEqual([{ reason: 'own-without-inflight', discard: false }]);
  });
});

describe('TextSyncClient: QUEUE_FULL (§7.3, §16)', () => {
  it('resends the same envelope after backoff while typing keeps buffering', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    server.queueFull = 2;
    await a.type('X', 2);
    await a.deliver(); // QUEUE_FULL, attempt 1: 0.5 × min(10 000, 250 × 2) = 250 ms
    expect(a.activity.at(-1)).toBe('busy');
    await a.type('Y', 3);
    expect(a.sent).toHaveLength(1);
    expect(a.pending).toBe(2);

    vi.advanceTimersByTime(249);
    expect(a.sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(a.sent).toHaveLength(2);
    expect(a.sent[1]).toEqual(a.sent[0]);

    await a.deliver(); // QUEUE_FULL again, attempt 2: 0.5 × 1000 = 500 ms
    vi.advanceTimersByTime(499);
    expect(a.sent).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(a.sent).toHaveLength(3);
    expect(a.sent[2]).toEqual(a.sent[0]);

    await settle(a);
    expect(a.activity.at(-1)).toBe('idle');
    expect(a.sent).toHaveLength(4);
    expectConverged(server, a);
    expect(texts(server.doc)).toEqual(['XYcat']);
  });

  it('does not resend while disconnected; the resume resends instead', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    server.queueFull = 1;
    await a.type('X', 2);
    await a.deliver();
    a.disconnect();
    vi.advanceTimersByTime(20_000);
    expect(a.sent).toHaveLength(1);
    await a.resume();
    expect(a.sent).toHaveLength(2);
    await settle(a);
    expectConverged(server, a);
  });
});

describe('TextSyncClient: submit errors (§16)', () => {
  it.each(['PROTOCOL_OP_REJECTED', 'ACCESS_DENIED', 'DOCUMENT_READ_ONLY'] as const)(
    '%s discards pending changes with a notice and reloads',
    async (code) => {
      const server = new FakeServer(bodyDoc('cat'));
      const a = client(server);
      server.rejectNext = code;
      await a.type('X', 2);
      await a.deliver();
      expect(a.notices).toEqual(['discarded']);
      expect(a.reloads).toEqual([{ reason: code, discard: true }]);
    },
  );

  it('SESSION_RESYNC_REQUIRED reloads and keeps the changes for the rescue', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    server.rejectNext = 'SESSION_RESYNC_REQUIRED';
    await a.type('X', 2);
    await a.deliver();
    expect(a.notices).toEqual([]);
    expect(a.reloads).toEqual([{ reason: 'SESSION_RESYNC_REQUIRED', discard: false }]);
    expect(a.orphansAtReload?.pending).toHaveLength(1);
  });

  it('ignores an error for a clientSeq that is not in flight', () => {
    const a = client(new FakeServer(bodyDoc('cat')));
    a.client.onSubmitError({ type: 'error', code: 'PROTOCOL_OP_REJECTED', retryable: false, message: '', clientSeq: 4 });
    expect(a.reloads).toEqual([]);
  });
});

describe('TextSyncClient: disconnect and resume (§6.1)', () => {
  it('(a) committed before the drop: the replayed ack confirms it and the duplicate ack is ignored', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    await a.type('X', 2); // committed; the ack is lost with the socket
    a.disconnect();
    await a.type('Y', 3); // buffered while offline
    expect(a.syncs.at(-1)?.pendingCount).toBe(2);
    await a.resume();
    expect(a.sent[1]).toEqual(a.sent[0]); // the original envelope
    expect(server.queue(a.id).map((m) => m.type)).toEqual(['ack', 'ack']);
    await settle(a);
    expectConverged(server, a);
    expect(server.history.map((e) => e.q)).toEqual([1, 2]);
    expect(texts(server.doc)).toEqual(['XYcat']);
  });

  it('(b) not committed: the resend commits it once', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    server.holdInbox = true;
    await a.type('X', 2);
    a.disconnect();
    server.inbox.splice(0); // lost with the socket
    server.holdInbox = false;
    await a.resume();
    await settle(a);
    expectConverged(server, a);
    expect(server.history.filter((e) => e.c === a.id)).toHaveLength(1);
  });

  it('flushes on resume when nothing was in flight', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    a.disconnect();
    await a.type('X', 2);
    expect(a.sent).toHaveLength(0);
    await a.resume();
    expect(a.sent).toHaveLength(1);
    await settle(a);
    expectConverged(server, a);
  });
});

describe('TextSyncClient: reload and rescue (§6.2, §0 PO-16)', () => {
  it('N == R: re-applies the orphans locally and sends them with a fresh clientSeq', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    server.holdInbox = true;
    await a.type('X', 2); // in flight, never committed
    await a.type('Y', 3);
    server.inbox.splice(0);
    server.holdInbox = false;
    server.restart();
    const o = await a.reload();
    expect(o).toMatchObject({ baseRev: 0, inflightSeq: 1, inflightCount: 1, rescueSent: false });
    expect(o?.pending).toHaveLength(2);
    expect(a.sent.at(-1)).toMatchObject({ clientSeq: 2, baseRev: 0, epoch: server.epoch });
    await settle(a);
    expectConverged(server, a);
    expect(texts(server.doc)).toEqual(['XYcat']);
    expect(a.notices).toEqual([]);
  });

  it('N == R: rebases the orphans over remotes buffered during the load', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    server.holdInbox = true;
    await a.type('X', 4); // "caXt"
    server.inbox.splice(0);
    server.holdInbox = false;
    const o = a.client.exportOrphans();
    a.client.onDisconnected();
    // The load: a snapshot at rev 0, then another user's remote that arrived during it.
    const snapshot = server.doc;
    otherTypes(server, 2, 'Q');
    a.show(snapshot);
    a.client.start({ epoch: server.epoch, rev: 0, readOnly: false });
    await a.deliver();
    a.client.restoreOrphans(o, { epoch: server.epoch, rev: 0 });
    await tick();
    expect(texts(a.doc)).toEqual(['QcaXt']);
    await settle(a);
    expectConverged(server, a);
  });

  it('N > R: sends a rescue, read-only until the ack, then applies it as confirmed', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    server.holdInbox = true;
    await a.type('X', 2); // in flight, never committed
    await a.type('Y', 3);
    server.inbox.splice(0);
    otherTypes(server, 5, 'Q'); // committed by someone else; a never sees it before the reload
    server.restart();
    await a.reload(); // N = 1 > R = 0
    const rescue = a.sent.at(-1);
    expect(rescue).toMatchObject({ clientSeq: 1, baseRev: 0, epoch: server.epoch });
    expect(rescue?.ops).toHaveLength(2);
    expect(getSyncState(a.view.state).readOnly).toBe(true);
    expect(a.view.editable).toBe(false);
    expect(a.activity.at(-1)).toBe('restoring');
    expect(a.syncs.at(-1)?.pendingCount).toBe(2);
    await a.type('nope', 2); // blocked while restoring
    expect(texts(a.doc)).toEqual(['catQ']);

    server.holdInbox = false;
    server.processInbox();
    await settle(a);
    expectConverged(server, a);
    expect(texts(server.doc)).toEqual(['XYcatQ']);
    expect(getSyncState(a.view.state).readOnly).toBe(false);
    expect(a.activity.at(-1)).toBe('idle');
    expect(a.notices).toEqual([]);
    // Typing works again.
    await a.type('!', 2);
    await settle(a);
    expectConverged(server, a);
  });

  it('N > R with a duplicate ack: the in-flight batch was committed; buffered changes are lost with a notice', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    await a.type('X', 2); // committed at rev 1; the ack is lost
    server.take(a.id);
    await a.type('Y', 3); // buffered
    server.restart();
    await a.reload(); // N = 1 > R = 0: rescue with clientSeq 1 → duplicate
    await settle(a);
    expect(a.notices).toEqual(['partialLoss']);
    expect(a.errors).toEqual(['SESSION_RESYNC_REQUIRED']);
    expectConverged(server, a);
    expect(texts(server.doc)).toEqual(['Xcat']);
    expect(getSyncState(a.view.state).readOnly).toBe(false);
  });

  it('N > R with a duplicate ack and nothing buffered: no notice', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    await a.type('X', 2);
    server.take(a.id);
    server.restart();
    await a.reload();
    await settle(a);
    expect(a.notices).toEqual([]);
    expect(a.errors).toEqual([]);
    expectConverged(server, a);
  });

  it('a rescue the server rejects is lost with a notice', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    server.holdInbox = true;
    await a.type('X', 2);
    server.inbox.splice(0);
    server.holdInbox = false;
    otherTypes(server, 2, 'Q');
    server.restart();
    server.rejectNext = 'PROTOCOL_OP_REJECTED';
    await a.reload();
    await settle(a);
    expect(a.notices).toEqual(['lost']);
    expect(a.reloads).toEqual([{ reason: 'PROTOCOL_OP_REJECTED', discard: true }]);
    expect(getSyncState(a.view.state).readOnly).toBe(false);
    expect(a.syncs.at(-1)?.pendingCount).toBe(0);
  });

  it('a rescue answered with QUEUE_FULL is retried, not lost', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    server.holdInbox = true;
    await a.type('X', 2);
    server.inbox.splice(0);
    server.holdInbox = false;
    otherTypes(server, 2, 'Q');
    server.restart();
    server.queueFull = 1;
    await a.reload();
    await a.deliver();
    const sends = a.sent.length;
    vi.advanceTimersByTime(250);
    expect(a.sent).toHaveLength(sends + 1);
    expect(a.sent.at(-1)).toEqual(a.sent.at(-2));
    await settle(a);
    expect(a.notices).toEqual([]);
    expectConverged(server, a);
    expect(texts(server.doc)).toEqual(['QXcat']);
  });

  it('PO-16: a rescue left unanswered by a reload is not sent again; the changes are dropped with a notice', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    server.holdInbox = true;
    await a.type('X', 2);
    server.inbox.splice(0);
    server.holdInbox = false;
    otherTypes(server, 5, 'Q');
    server.restart();
    server.floorRev = 1; // the entries after R are trimmed: the server answers with resync
    await a.reload();
    expect(server.queue(a.id).map((m) => m.type)).toEqual(['resync']);
    const sends = a.sent.length;
    const o = await a.reload(); // the session's reload after the resync
    expect(o).toMatchObject({ baseRev: 0, inflightSeq: 1, rescueSent: true });
    expect(a.sent).toHaveLength(sends);
    expect(a.notices).toEqual(['partialLoss']);
    expect(a.errors).toEqual(['SESSION_RESYNC_REQUIRED']);
    expect(getSyncState(a.view.state).readOnly).toBe(false);
    expectConverged(server, a);
  });

  it('exports nothing when nothing is pending', () => {
    const a = client(new FakeServer(bodyDoc('cat')));
    expect(a.client.exportOrphans()).toBeNull();
  });
});

describe('TextSyncClient: read-only (§7.3, §0 L-15)', () => {
  it('a view session never sends, yet applies remotes', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const v = client(server, { readOnly: true });
    expect(v.view.editable).toBe(false);
    await v.type('X', 2);
    expect(texts(v.doc)).toEqual(['cat']);
    otherTypes(server, 2, 'Q');
    await v.deliver();
    expect(texts(v.doc)).toEqual(['Qcat']);
    v.client.onDisconnected();
    v.client.onReconnected();
    v.client.setReadOnly(true, 'view');
    await tick();
    expect(v.sent).toEqual([]);
    expect(server.received.filter((m) => m.clientId === v.id)).toEqual([]);
  });

  it('turning read-only with unconfirmed changes discards them with a notice and reloads', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    server.holdInbox = true;
    await a.type('X', 2);
    await a.type('Y', 3);
    a.client.setReadOnly(true, 'server');
    expect(a.notices).toEqual(['discarded']);
    expect(a.reloads).toEqual([{ reason: 'read-only', discard: true }]);
    expect(a.view.editable).toBe(false);
  });

  it('turning read-only with nothing pending only blocks editing; turning it off allows edits again', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    a.client.setReadOnly(true, 'unsupported');
    expect(a.reloads).toEqual([]);
    expect(a.notices).toEqual([]);
    await a.type('X', 2);
    expect(texts(a.doc)).toEqual(['cat']);
    a.client.setReadOnly(false, 'unsupported');
    expect(a.view.editable).toBe(true);
    await a.type('X', 2);
    await settle(a);
    expectConverged(server, a);
  });

  it('orphans restored into a read-only document are discarded with a notice', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    server.holdInbox = true;
    await a.type('X', 2);
    server.inbox.splice(0);
    server.holdInbox = false;
    const sends = a.sent.length;
    await a.reload({ readOnly: true });
    expect(a.notices).toEqual(['discarded']);
    expect(a.sent).toHaveLength(sends);
    expect(texts(a.doc)).toEqual(['cat']);
  });
});

describe('TextSyncClient: lifecycle', () => {
  it('has no resume info before start and after destroy', () => {
    const server = new FakeServer(bodyDoc('cat'), 4);
    const a = client(server);
    expect(a.client.resumeInfo()).toEqual({ epoch: server.epoch, rev: 4 });
    a.client.destroy();
    expect(a.client.resumeInfo()).toBeNull();
  });

  it('does not send after destroy', async () => {
    const server = new FakeServer(bodyDoc('cat'));
    const a = client(server);
    a.client.destroy();
    await a.type('X', 2);
    expect(a.sent).toEqual([]);
  });
});
