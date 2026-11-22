import { createHash } from 'node:crypto';
import { asDocumentId } from '@open-docex/shared/ids';
import { CloseCode } from '@open-docex/shared/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { docKeyOf } from '../../../src/persistence/layout.js';
import { SnapshotStore } from '../../../src/persistence/snapshot-store.js';
import { cid, ins, makeHarness, spyJournal, textOf, type Harness } from './harness.js';

let harnesses: Harness[] = [];
async function harness(...a: Parameters<typeof makeHarness>): Promise<Harness> {
  const h = await makeHarness(...a);
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of harnesses) await h.dispose();
  harnesses = [];
});

describe('DocumentInstance: first load', () => {
  it('imports through the codec at rev 0 and streams load-start, chunks and load-done', async () => {
    const h = await harness();
    const id = h.file('a.docx', 'hello');
    const { sid, rev } = await h.open(id, 'cA');
    expect(rev).toBe(0);
    const msgs = h.sink.messages(sid).map((m) => m.type);
    expect(msgs[0]).toBe('load-start');
    expect(msgs.at(-1)).toBe('load-done');
    expect(msgs).toContain('load-chunk');
    const inst = h.registry.get(id);
    expect(inst?.state).toBe('ACTIVE');
    expect(textOf(inst?.model)).toBe('hello');
    expect(h.meta.get(docKeyOf(id))?.rev).toBe(0);
    expect(h.sink.events.some((e) => e.kind === 'document' && e.ev.state === 'loaded' && e.ev.source === 'storage')).toBe(true);
  });

  it('loads once for concurrent joins (single-flight)', async () => {
    const h = await harness();
    const id = h.file('a.docx', 'x');
    await Promise.all([h.open(id, 'c1'), h.open(id, 'c2')]);
    expect(h.codec.imports).toBe(1);
  });

  it('a missing file closes the session with DOCUMENT_NOT_FOUND and LOAD_FAILED', async () => {
    const h = await harness();
    const sid = h.join(asDocumentId('nope.docx'));
    h.hello(sid, 'c');
    await vi.waitFor(() => expect(h.sink.closes(sid)).toEqual([CloseCode.LOAD_FAILED]));
    expect(h.sink.of(sid, 'error')[0]?.code).toBe('DOCUMENT_NOT_FOUND');
    expect(h.registry.get(asDocumentId('nope.docx'))).toBeUndefined();
  });

  it('a file over maxFileBytes fails with DOCUMENT_TOO_LARGE', async () => {
    const h = await harness({ config: { limits: { maxFileBytes: 4 } } });
    const id = h.file('big.docx', 'too large');
    const sid = h.join(id);
    await vi.waitFor(() => expect(h.sink.of(sid, 'error')[0]?.code).toBe('DOCUMENT_TOO_LARGE'));
  });

  it('a sheet format fails with DOCUMENT_UNSUPPORTED_CONTENT in V1', async () => {
    const h = await harness();
    const id = h.file('s.xlsx', 'x');
    const sid = h.join(id, 'edit', 'xlsx');
    await vi.waitFor(() => expect(h.sink.of(sid, 'error')[0]?.code).toBe('DOCUMENT_UNSUPPORTED_CONTENT'));
  });
});

describe('DocumentInstance: FIFO loop', () => {
  it('orders journal → ack → broadcast → audit → queue ack, with ack and remote in one send', async () => {
    const h = await harness();
    const j = spyJournal(h.order);
    const id = h.file('a.docx', 'ab');
    const a = await h.open(id, 'cA');
    const b = await h.open(id, 'cB');
    h.order.length = 0;
    h.submit(a.sid, 'cA', 1, a.epoch, 0, [ins(2, 'X')]);
    await vi.waitFor(() => expect(h.order).toContain('queue.ack'));
    expect(h.order).toEqual(['journal', 'send:ack', 'send:remote', 'audit', 'queue.ack']);
    expect(j.spy).toHaveBeenCalledTimes(1);
    const send = h.sink.events.filter((e) => e.kind === 'send').at(-1);
    expect(send?.kind === 'send' && send.frames.map((f) => f.sessionIds)).toEqual([[a.sid], [b.sid]]);
    expect(h.sink.of(a.sid, 'ack')).toEqual([{ type: 'ack', clientSeq: 1, rev: 1 }]);
    expect(h.sink.of(b.sid, 'remote')).toEqual([{ type: 'remote', fromRev: 0, ops: [ins(2, 'X')], clientId: cid('cA') }]);
    expect(h.audits).toMatchObject([{ documentId: id, rev: 1, fromRev: 0, clientId: cid('cA'), clientSeq: 1, sessionId: a.sid, replayed: false }]);
    expect(textOf(h.registry.get(id)?.model)).toBe('Xab');
    expect(h.flush.dirty).toBe(1);
  });

  it('acks with committed when the batch was rebased over newer ops', async () => {
    const h = await harness();
    const id = h.file('a.docx', 'ab');
    const a = await h.open(id, 'cA');
    const b = await h.open(id, 'cB');
    h.submit(a.sid, 'cA', 1, a.epoch, 0, [ins(2, 'X')]);
    h.submit(b.sid, 'cB', 1, b.epoch, 0, [ins(4, 'Y')]);
    await vi.waitFor(() => expect(h.sink.of(b.sid, 'ack')).toHaveLength(1));
    expect(h.sink.of(a.sid, 'ack')[0]?.committed).toBeUndefined();
    expect(h.sink.of(b.sid, 'ack')[0]).toEqual({ type: 'ack', clientSeq: 1, rev: 2, committed: [ins(5, 'Y')] });
    expect(textOf(h.registry.get(id)?.model)).toBe('XabY');
  });

  it('acks a resent (clientId, clientSeq) with the original rev and does not apply it again', async () => {
    const h = await harness();
    const j = spyJournal(h.order);
    const id = h.file('a.docx', 'ab');
    const a = await h.open(id, 'cA');
    const b = await h.open(id, 'cB');
    h.submit(a.sid, 'cA', 1, a.epoch, 0, [ins(2, 'X')]);
    h.submit(b.sid, 'cB', 1, b.epoch, 0, [ins(2, 'Y')]);
    await vi.waitFor(() => expect(h.sink.of(b.sid, 'ack')).toHaveLength(1));
    // b resends its transformed batch; a resends its plain one.
    h.submit(b.sid, 'cB', 1, b.epoch, 0, [ins(2, 'Y')]);
    h.submit(a.sid, 'cA', 1, a.epoch, 0, [ins(2, 'X')]);
    await vi.waitFor(() => expect(h.sink.of(a.sid, 'ack')).toHaveLength(2));
    const bAcks = h.sink.of(b.sid, 'ack');
    expect(bAcks[1]).toEqual(bAcks[0]);
    expect(bAcks[1]?.committed).toBeDefined();
    expect(h.sink.of(a.sid, 'ack')[1]).toEqual({ type: 'ack', clientSeq: 1, rev: 1 });
    expect(j.spy).toHaveBeenCalledTimes(2);
    expect(h.registry.get(id)?.rev).toBe(2);
    expect(h.sink.of(b.sid, 'remote')).toHaveLength(1);
  });

  it('a stale baseRev beyond the head gets resync(inconsistent) and a full load', async () => {
    const h = await harness();
    const id = h.file('a.docx', 'ab');
    const a = await h.open(id, 'cA');
    h.submit(a.sid, 'cA', 1, a.epoch, 5, [ins(2, 'X')]);
    await vi.waitFor(() => expect(h.sink.of(a.sid, 'resync')).toEqual([{ type: 'resync', reason: 'inconsistent' }]));
    await vi.waitFor(() => expect(h.sink.of(a.sid, 'load-done')).toHaveLength(2));
    expect(h.registry.get(id)?.rev).toBe(0);
  });

  it('a submit with another epoch gets resync(epoch-changed)', async () => {
    const h = await harness();
    const id = h.file('a.docx', 'ab');
    const a = await h.open(id, 'cA');
    h.submit(a.sid, 'cA', 1, 'other-epoch', 0, [ins(2, 'X')]);
    await vi.waitFor(() => expect(h.sink.of(a.sid, 'resync')).toEqual([{ type: 'resync', reason: 'epoch-changed' }]));
  });

  it('rejects a view session with ACCESS_DENIED', async () => {
    const h = await harness();
    const id = h.file('a.docx', 'ab');
    const v = await h.open(id, 'cV', 'view');
    h.submit(v.sid, 'cV', 1, v.epoch, 0, [ins(2, 'X')]);
    await vi.waitFor(() => expect(h.sink.of(v.sid, 'error')).toMatchObject([{ code: 'ACCESS_DENIED', clientSeq: 1 }]));
  });

  it('an op-level throw rejects only that batch with PROTOCOL_OP_REJECTED; the instance stays ACTIVE', async () => {
    const h = await harness();
    const id = h.file('a.docx', 'ab');
    const a = await h.open(id, 'cA');
    h.submit(a.sid, 'cA', 1, a.epoch, 0, [{ stepType: 'bogus' }]);
    await vi.waitFor(() => expect(h.sink.of(a.sid, 'error')).toMatchObject([{ code: 'PROTOCOL_OP_REJECTED', clientSeq: 1 }]));
    expect(h.registry.get(id)?.state).toBe('ACTIVE');
    expect(h.sink.events.some((e) => e.kind === 'error' && e.err.code === 'PROTOCOL_OP_REJECTED')).toBe(true);
    h.submit(a.sid, 'cA', 2, a.epoch, 0, [ins(2, 'X')]);
    await vi.waitFor(() => expect(h.sink.of(a.sid, 'ack')).toEqual([{ type: 'ack', clientSeq: 2, rev: 1 }]));
  });

  it('rejects an image op whose asset is not stored, and accepts it after asset-put', async () => {
    const h = await harness();
    const id = h.file('a.docx', 'ab');
    const a = await h.open(id, 'cA');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const assetId = createHash('sha256').update(png).digest('hex');
    const imageOp = { stepType: 'replace', from: 1, to: 1, slice: { content: [{ type: 'image', attrs: { assetId } }] } };
    h.submit(a.sid, 'cA', 1, a.epoch, 0, [imageOp]);
    await vi.waitFor(() => expect(h.sink.of(a.sid, 'error')[0]?.code).toBe('PROTOCOL_OP_REJECTED'));
    h.send(a.sid, { type: 'asset-put', reqId: 7, mime: 'image/png', bytes: png });
    await vi.waitFor(() =>
      expect(h.sink.of(a.sid, 'asset')).toEqual([{ type: 'asset', reqId: 7, assetId, mime: 'image/png', size: png.length }]),
    );
    h.submit(a.sid, 'cA', 2, a.epoch, 0, [imageOp]);
    await vi.waitFor(() => expect(h.sink.of(a.sid, 'ack')).toEqual([{ type: 'ack', clientSeq: 2, rev: 1 }]));
    h.send(a.sid, { type: 'asset-get', reqId: 8, assetId });
    await vi.waitFor(() => expect(h.sink.of(a.sid, 'asset')[1]).toMatchObject({ reqId: 8, assetId, size: png.length }));
    h.send(a.sid, { type: 'asset-get', reqId: 9, assetId: 'b'.repeat(64) });
    await vi.waitFor(() => expect(h.sink.of(a.sid, 'error').at(-1)).toMatchObject({ code: 'DOCUMENT_NOT_FOUND', reqId: 9 }));
  });

  it('refuses asset-put from a view session and with bytes that are not an image', async () => {
    const h = await harness();
    const id = h.file('a.docx', 'ab');
    const v = await h.open(id, 'cV', 'view');
    const a = await h.open(id, 'cA');
    h.send(v.sid, { type: 'asset-put', reqId: 1, mime: 'image/png', bytes: new Uint8Array([0x89, 0x50]) });
    h.send(a.sid, { type: 'asset-put', reqId: 2, mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) });
    await vi.waitFor(() => expect(h.sink.of(a.sid, 'error')).toMatchObject([{ code: 'PROTOCOL_OP_REJECTED', reqId: 2 }]));
    expect(h.sink.of(v.sid, 'error')).toMatchObject([{ code: 'ACCESS_DENIED', reqId: 1 }]);
  });

  it('an all-dropped batch is journaled, acked with committed: [] and neither broadcast nor audited', async () => {
    const h = await harness();
    const id = h.file('a.docx', 'ab');
    const a = await h.open(id, 'cA');
    const b = await h.open(id, 'cB');
    h.submit(a.sid, 'cA', 1, a.epoch, 0, [ins(999, 'X')]);
    await vi.waitFor(() => expect(h.sink.of(a.sid, 'ack')).toEqual([{ type: 'ack', clientSeq: 1, rev: 0, committed: [] }]));
    expect(h.sink.of(b.sid, 'remote')).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('refuses a submit before hello and a clientId other than the bound one', async () => {
    const h = await harness();
    const id = h.file('a.docx', 'ab');
    const early = h.join(id);
    h.submit(early, 'cE', 1, 'e', 0, [ins(2, 'X')]);
    await vi.waitFor(() => expect(h.sink.of(early, 'error')[0]?.code).toBe('PROTOCOL_INVALID_MESSAGE'));
    const a = await h.open(id, 'cA');
    h.submit(a.sid, 'cOther', 1, a.epoch, 0, [ins(2, 'X')]);
    await vi.waitFor(() => expect(h.sink.of(a.sid, 'error')).toMatchObject([{ code: 'PROTOCOL_INVALID_MESSAGE', clientSeq: 1 }]));
  });

  it('refuses an unsupported protocol version', async () => {
    const h = await harness();
    const id = h.file('a.docx', 'ab');
    const sid = h.join(id);
    h.send(sid, { type: 'hello', protocol: 99, clientId: cid('c') as never });
    await vi.waitFor(() => expect(h.sink.closes(sid)).toEqual([CloseCode.PROTOCOL_ERROR]));
    expect(h.sink.of(sid, 'error')[0]?.code).toBe('PROTOCOL_VERSION_UNSUPPORTED');
  });

  it('snapshots and rotates every snapshot.everyOps ops', async () => {
    const h = await harness({ config: { snapshot: { everyOps: 2 } } });
    const id = h.file('a.docx', 'ab');
    const a = await h.open(id, 'cA');
    h.submit(a.sid, 'cA', 1, a.epoch, 0, [ins(2, 'X'), ins(3, 'Y')]);
    await vi.waitFor(() => expect(h.sink.of(a.sid, 'ack')).toHaveLength(1));
    await vi.waitFor(async () => expect((await new SnapshotStore(h.dataDir).read(docKeyOf(id)))?.rev).toBe(2));
  });
});

describe('DocumentInstance: read-only for unsupported content', () => {
  it('opens read-only, rejects submits with DOCUMENT_READ_ONLY, and allowUnsupportedEdit lifts it', async () => {
    const h = await harness();
    const id = h.file('u.docx', 'UNSUPPORTED stuff');
    const a = await h.open(id, 'cA');
    const start = h.sink.of(a.sid, 'load-start')[0];
    expect(start?.readOnly).toBe(true);
    expect(start?.unsupported).toEqual([{ feature: 'comments', count: 1 }]);
    expect(h.sink.events.some((e) => e.kind === 'document' && e.ev.state === 'unsupported')).toBe(true);
    h.submit(a.sid, 'cA', 1, a.epoch, 0, [ins(2, 'X')]);
    await vi.waitFor(() => expect(h.sink.of(a.sid, 'error')).toMatchObject([{ code: 'DOCUMENT_READ_ONLY', clientSeq: 1 }]));
    await h.registry.get(id)?.allowUnsupportedEdit();
    expect(h.sink.of(a.sid, 'notice')).toEqual([{ type: 'notice', notice: 'read-only', readOnly: false, reason: 'unsupported-content' }]);
    expect(h.meta.get(docKeyOf(id))?.readOnly.allowedEdit).toBe(true);
    h.submit(a.sid, 'cA', 2, a.epoch, 0, [ins(2, 'X')]);
    await vi.waitFor(() => expect(h.sink.of(a.sid, 'ack')).toHaveLength(1));
  });
});

describe('DocumentInstance: faults', () => {
  it('a journal failure sends no ack and faults only that instance', async () => {
    const h = await harness();
    const j = spyJournal(h.order);
    const id1 = h.file('one.docx', 'ab');
    const id2 = h.file('two.docx', 'cd');
    const a = await h.open(id1, 'cA');
    const b = await h.open(id2, 'cB');
    const inst1 = h.registry.get(id1);
    j.failNext();
    h.submit(a.sid, 'cA', 1, a.epoch, 0, [ins(2, 'X')]);
    await vi.waitFor(() => expect(inst1?.state).toBe('CLOSED'));
    expect(h.sink.of(a.sid, 'ack')).toEqual([]);
    expect(h.sink.of(a.sid, 'error').map((e) => e.code)).toEqual(['DOCUMENT_FAULTED']);
    expect(h.sink.closes(a.sid)).toEqual([CloseCode.DOCUMENT_FAULTED]);
    expect(h.registry.get(id1)).toBeUndefined();
    expect(h.sink.events.some((e) => e.kind === 'document' && e.ev.state === 'faulted' && e.ev.documentId === id1)).toBe(true);
    // The other document keeps working.
    h.submit(b.sid, 'cB', 1, b.epoch, 0, [ins(2, 'Y')]);
    await vi.waitFor(() => expect(h.sink.of(b.sid, 'ack')).toEqual([{ type: 'ack', clientSeq: 1, rev: 1 }]));
    // The next join reloads with a new epoch.
    const again = await h.open(id1, 'cA2');
    expect(again.epoch).not.toBe(a.epoch);
  });
});

describe('DocumentInstance: load source and replay', () => {
  async function edited(h: Harness, text = 'ab') {
    const id = h.file('a.docx', text, 'v1');
    const a = await h.open(id, 'cA');
    const b = await h.open(id, 'cB');
    h.submit(a.sid, 'cA', 1, a.epoch, 0, [ins(2, 'X')]);
    h.submit(b.sid, 'cB', 1, b.epoch, 0, [ins(4, 'Y')]);
    await vi.waitFor(() => expect(h.sink.of(b.sid, 'ack')).toHaveLength(1));
    const model = JSON.stringify(h.registry.get(id)?.model.toJSON());
    await h.closeAll();
    return { id, a, b, model };
  }

  it('replays the journal over the snapshot when the local copy is newer, keeping rev and dedupe', async () => {
    const h = await harness();
    const { id, model } = await edited(h);
    h.storage.setFile('a.docx', new TextEncoder().encode('changed'), 'v2'); // storage changed too: local still wins
    const c = await h.open(id, 'cC');
    const inst = h.registry.get(id);
    expect(c.rev).toBe(2);
    expect(JSON.stringify(inst?.model.toJSON())).toBe(model);
    expect(h.codec.imports).toBe(1);
    expect(h.sink.events.some((e) => e.kind === 'document' && e.ev.state === 'loaded' && e.ev.source === 'local')).toBe(true);
    // Dedupe survived: a resend is acked with its original rev.
    h.submit(c.sid, 'cC', 1, c.epoch, 2, [ins(2, 'Z')]);
    await vi.waitFor(() => expect(h.sink.of(c.sid, 'ack')).toHaveLength(1));
    const late = h.join(id);
    h.hello(late, 'cA');
    await vi.waitFor(() => expect(h.sink.of(late, 'load-start')[0]?.ackedClientSeq).toBe(1));
  });

  it('a clean local copy with the same storage version replays locally', async () => {
    const h = await harness();
    const { id } = await edited(h);
    const key = docKeyOf(id);
    const m = h.meta.get(key);
    if (m === undefined) throw new Error('no meta');
    await h.meta.put({ ...m, lastFlushedRev: 2, rev: 2, lastKnownVersion: 'v1' }); // as after a flush
    const c = await h.open(id, 'cC');
    expect(c.rev).toBe(2);
    expect(h.codec.imports).toBe(1);
  });

  it('a clean local copy whose storage file changed is imported fresh, and rev never decreases', async () => {
    const h = await harness();
    const { id } = await edited(h);
    const m = h.meta.get(docKeyOf(id));
    if (m === undefined) throw new Error('no meta');
    await h.meta.put({ ...m, lastFlushedRev: 2, rev: 2, lastKnownVersion: 'v1' });
    h.storage.setFile('a.docx', new TextEncoder().encode('new content'), 'v2');
    const c = await h.open(id, 'cC');
    expect(h.codec.imports).toBe(2);
    expect(c.rev).toBe(2);
    const inst = h.registry.get(id);
    expect(textOf(inst?.model)).toBe('new content');
    expect(inst?.history.floorRev).toBe(2);
    expect(inst?.dedupe.size).toBe(0);
    expect(h.meta.get(docKeyOf(id))?.lastKnownVersion).toBe('v2');
  });

  it('a clean local copy replays locally when storage stat throws', async () => {
    const h = await harness();
    const { id } = await edited(h);
    const m = h.meta.get(docKeyOf(id));
    if (m === undefined) throw new Error('no meta');
    await h.meta.put({ ...m, lastFlushedRev: 2, rev: 2, lastKnownVersion: 'v1' });
    h.storage.failNext('stat');
    const c = await h.open(id, 'cC');
    expect(c.rev).toBe(2);
    expect(h.codec.imports).toBe(1);
  });

  it('a non-NORMAL storage state always replays locally', async () => {
    const h = await harness();
    const { id } = await edited(h);
    const m = h.meta.get(docKeyOf(id));
    if (m === undefined) throw new Error('no meta');
    await h.meta.put({ ...m, storageState: 'LOCAL', lastFlushedRev: 2 });
    h.storage.deleteFile('a.docx');
    const c = await h.open(id, 'cC');
    expect(c.rev).toBe(2);
  });
});

describe('DocumentInstance: resume (R11, PO-16, R-8)', () => {
  it('a same-epoch resume catches up with acks for own batches and remotes for others, without a load', async () => {
    const h = await harness();
    const id = h.file('a.docx', 'ab');
    const a = await h.open(id, 'cA');
    const b = await h.open(id, 'cB');
    h.submit(b.sid, 'cB', 1, b.epoch, 0, [ins(4, 'Y')]);
    h.submit(a.sid, 'cA', 1, a.epoch, 0, [ins(2, 'X')]); // transformed over b's batch
    await vi.waitFor(() => expect(h.sink.of(a.sid, 'ack')).toHaveLength(1));
    h.dispatcher.leave(a.sid);
    const r = h.join(id);
    h.hello(r, 'cA', { epoch: a.epoch, rev: 0 });
    await h.idle();
    expect(h.sink.messages(r)).toEqual([
      { type: 'notice', notice: 'read-only', readOnly: false, reason: 'unsupported-content' },
      { type: 'remote', fromRev: 0, ops: [ins(4, 'Y')], clientId: cid('cB') },
      { type: 'ack', clientSeq: 1, rev: 2, committed: [ins(2, 'X')] },
    ]);
    // Live traffic follows.
    h.submit(b.sid, 'cB', 2, b.epoch, 2, [ins(2, 'Z')]);
    await vi.waitFor(() => expect(h.sink.of(r, 'remote')).toHaveLength(2));
  });

  it('a same-epoch resume outside the window gets resync and a full load', async () => {
    const h = await harness();
    const id = h.file('a.docx', 'ab');
    const a = await h.open(id, 'cA');
    const r = h.join(id);
    h.hello(r, 'cA', { epoch: a.epoch, rev: 7 });
    await vi.waitFor(() => expect(h.sink.of(r, 'load-done')).toHaveLength(1));
    expect(h.sink.messages(r)[0]).toEqual({ type: 'resync', reason: 'inconsistent' });
  });

  it('an old-epoch resume replays retained entries (own ack, others remote), then resync and a full load', async () => {
    const h = await harness();
    const id = h.file('a.docx', 'ab');
    const a = await h.open(id, 'cA');
    const b = await h.open(id, 'cB');
    h.submit(a.sid, 'cA', 1, a.epoch, 0, [ins(2, 'X')]);
    await vi.waitFor(() => expect(h.sink.of(a.sid, 'ack')).toHaveLength(1));
    h.submit(b.sid, 'cB', 1, b.epoch, 1, [ins(2, 'Y')]);
    await vi.waitFor(() => expect(h.sink.of(b.sid, 'ack')).toHaveLength(1));
    // The Core restarts: sessions end, the instance is rebuilt from the journal with a new epoch.
    await h.closeAll();
    const r = h.join(id);
    h.hello(r, 'cA', { epoch: a.epoch, rev: 0 }); // the client never saw its ack
    await vi.waitFor(() => expect(h.sink.of(r, 'load-done')).toHaveLength(1));
    const msgs = h.sink.messages(r);
    expect(msgs.slice(0, 3)).toEqual([
      { type: 'ack', clientSeq: 1, rev: 1 },
      { type: 'remote', fromRev: 1, ops: [ins(2, 'Y')], clientId: cid('cB') },
      { type: 'resync', reason: 'epoch-changed' },
    ]);
    const start = msgs[3];
    expect(start).toMatchObject({ type: 'load-start', rev: 2, ackedClientSeq: 1 });
    expect(start?.type === 'load-start' && start.epoch).not.toBe(a.epoch);
  });

  it('an old-epoch resume whose rev is no longer retained gets resync and a load only', async () => {
    const h = await harness();
    const id = h.file('a.docx', 'ab');
    await h.open(id, 'cA');
    await h.closeAll();
    const r = h.join(id);
    h.hello(r, 'cA', { epoch: 'old', rev: 50 });
    await vi.waitFor(() => expect(h.sink.of(r, 'load-done')).toHaveLength(1));
    expect(h.sink.messages(r).map((m) => m.type).slice(0, 2)).toEqual(['resync', 'load-start']);
  });

  it('a rescue submit in the new epoch with the old baseRev is rebased over the retained history', async () => {
    const h = await harness();
    const id = h.file('a.docx', 'ab');
    const a = await h.open(id, 'cA');
    const b = await h.open(id, 'cB');
    h.submit(b.sid, 'cB', 1, b.epoch, 0, [ins(2, 'Y')]);
    await vi.waitFor(() => expect(h.sink.of(b.sid, 'ack')).toHaveLength(1));
    await h.closeAll();
    const c = await h.open(id, 'cA');
    expect(c.epoch).not.toBe(a.epoch);
    h.submit(c.sid, 'cA', 1, c.epoch, 0, [ins(4, 'X')]);
    await vi.waitFor(() => expect(h.sink.of(c.sid, 'ack')).toEqual([{ type: 'ack', clientSeq: 1, rev: 2, committed: [ins(5, 'X')] }]));
  });
});

describe('LoadStreamer pacing', () => {
  it('keeps at most 4 chunks unwritten and refills on written; remotes may interleave after load-start', async () => {
    const h = await harness({ config: { load: { chunk: { textBlocks: 1 } } } });
    const id = h.file('a.docx', 'p0\np1\np2\np3\np4\np5\np6\np7');
    const a = await h.open(id, 'cA'); // answered with written automatically
    const sid = h.join(id);
    h.sink.manualWrite.add(sid);
    h.hello(sid, 'cL');
    await h.idle();
    expect(h.sink.of(sid, 'load-chunk')).toHaveLength(4);
    expect(h.sink.of(sid, 'load-done')).toHaveLength(0);
    const tokens = h.sink.tokens(sid);
    h.dispatcher.handle({ type: 'written', sessionId: sid, token: tokens[0] as number });
    await h.idle();
    expect(h.sink.of(sid, 'load-chunk')).toHaveLength(5);
    // A remote during the load.
    h.submit(a.sid, 'cA', 1, a.epoch, 0, [ins(2, 'X')]);
    await vi.waitFor(() => expect(h.sink.of(sid, 'remote')).toHaveLength(1));
    for (const t of h.sink.tokens(sid).slice(1)) h.dispatcher.handle({ type: 'written', sessionId: sid, token: t });
    await h.idle();
    const types = h.sink.messages(sid).map((m) => m.type);
    const seqs = h.sink.of(sid, 'load-chunk').map((c) => c.seq);
    expect(seqs.length).toBeGreaterThan(4);
    expect(seqs).toEqual([...seqs.keys()]);
    expect(h.sink.of(sid, 'load-start')[0]?.totalChunks).toBe(seqs.length);
    expect(types.at(-1)).toBe('load-done');
    expect(types.indexOf('remote')).toBeGreaterThan(types.indexOf('load-start'));
    expect(h.sink.of(sid, 'load-done')[0]?.rev).toBe(0);
  });
});
