// DocumentInstance.reloadFromStorage() (V1-16; LLD Part 2 §13 `discard-local`, §0 S-36): a
// fresh import, then resync plus a full load for the sessions; the old local copy goes only
// after the new snapshot is durable.
import { readdir } from 'node:fs/promises';
import type { DocumentId } from '@open-docex/shared/ids';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '../../wait-for.js';
import { CloseCode } from '@open-docex/shared/protocol';
import { Journal, segmentName } from '../../../src/persistence/journal.js';
import { docKeyOf, journalDir } from '../../../src/persistence/layout.js';
import { SnapshotStore } from '../../../src/persistence/snapshot-store.js';
import { ins, makeHarness, textOf, type Harness } from './harness.js';

let harnesses: Harness[] = [];
async function harness(): Promise<Harness> {
  const h = await makeHarness();
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of harnesses) await h.dispose();
  harnesses = [];
});

/**
 * `a.docx` ("ab", version v1) edited by two clients to rev 2 ("XabY"), then put in CONFLICT
 * while an outside editor stored `outside` as v2.
 */
async function conflicted(h: Harness, outside = 'outside') {
  const id = h.file('a.docx', 'ab', 'v1');
  const a = await h.open(id, 'cA');
  const b = await h.open(id, 'cB');
  h.submit(a.sid, 'cA', 1, a.epoch, 0, [ins(2, 'X')]);
  h.submit(b.sid, 'cB', 1, b.epoch, 0, [ins(4, 'Y')]);
  await waitFor(() => expect(h.sink.of(b.sid, 'ack')).toHaveLength(1));
  const m = h.meta.get(docKeyOf(id));
  if (m === undefined) throw new Error('no meta');
  await h.meta.put({ ...m, storageState: 'CONFLICT', conflict: { detectedAt: 1, storageVersion: 'v2' }, localSince: 1 });
  h.storage.setFile('a.docx', new TextEncoder().encode(outside), 'v2');
  const inst = h.registry.get(id);
  if (inst === undefined) throw new Error('not loaded');
  return { id, a, b, inst };
}

function segments(h: Harness, id: DocumentId): Promise<string[]> {
  return readdir(journalDir(h.dataDir, docKeyOf(id)));
}

/** Message types a session received after `from`, once its reload is done. */
async function after(h: Harness, sid: string, from: number): Promise<string[]> {
  await waitFor(() => expect(h.sink.messages(sid).slice(from).some((m) => m.type === 'load-done')).toBe(true));
  return h.sink.messages(sid).slice(from).map((m) => m.type);
}

describe('DocumentInstance.reloadFromStorage', () => {
  it('imports the storage file fresh at rev + 1 and writes a NORMAL meta', async () => {
    const h = await harness();
    const { id, inst } = await conflicted(h);
    expect(textOf(inst.model)).toBe('XabY');
    await inst.reloadFromStorage();
    expect(inst.state).toBe('ACTIVE');
    expect(textOf(inst.model)).toBe('outside');
    expect(inst.rev).toBe(3);
    expect(inst.history.floorRev).toBe(3);
    expect(inst.dedupe.size).toBe(0);
    expect(h.codec.imports).toBe(2);
    const m = h.meta.get(docKeyOf(id));
    expect(m).toMatchObject({ storageState: 'NORMAL', lastKnownVersion: 'v2', lastFlushedRev: 3, rev: 3, retryCount: 0, localSince: null, nextRetryAt: null });
    expect(m?.conflict).toBeUndefined();
    expect(m?.lineage).toEqual([{ epoch: inst.epoch, fromRev: 3 }]);
    // The old local copy is gone: the snapshot is the new content and only the new segment is left.
    const snap = await new SnapshotStore(h.dataDir).read(docKeyOf(id));
    expect(snap?.rev).toBe(3);
    expect(await segments(h, id)).toEqual([segmentName(3)]);
  });

  it('sends every loaded session resync, then a full load of the new content', async () => {
    const h = await harness();
    const { a, b, inst } = await conflicted(h);
    const fromA = h.sink.messages(a.sid).length;
    const fromB = h.sink.messages(b.sid).length;
    const waiting = h.join(inst.documentId); // no hello yet: gets the new content on hello
    await inst.reloadFromStorage();
    for (const [sid, from] of [
      [a.sid, fromA],
      [b.sid, fromB],
    ] as const) {
      const types = await after(h, sid, from);
      expect(types[0]).toBe('resync');
      expect(types[1]).toBe('load-start');
      expect(types.at(-1)).toBe('load-done');
      expect(h.sink.of(sid, 'resync').at(-1)?.reason).toBe('history-unavailable');
      expect(h.sink.of(sid, 'load-start').at(-1)).toMatchObject({ epoch: a.epoch, rev: 3 });
    }
    expect(h.sink.messages(waiting)).toEqual([]);
    h.hello(waiting, 'cW');
    await waitFor(() => expect(h.sink.of(waiting, 'load-start')[0]?.rev).toBe(3));
  });

  it('a stale submit or resume based on the discarded content gets resync; new edits apply', async () => {
    const h = await harness();
    const { a, inst } = await conflicted(h);
    await inst.reloadFromStorage();
    await after(h, a.sid, 0);
    const resyncs = h.sink.of(a.sid, 'resync').length;
    h.submit(a.sid, 'cA', 2, a.epoch, 2, [ins(2, 'Z')]); // sent before the client saw the reload
    await waitFor(() => expect(h.sink.of(a.sid, 'resync')).toHaveLength(resyncs + 1));
    expect(h.sink.of(a.sid, 'resync').at(-1)?.reason).toBe('history-unavailable');
    expect(textOf(inst.model)).toBe('outside');
    expect(inst.rev).toBe(3);
    h.submit(a.sid, 'cA', 3, a.epoch, 3, [ins(2, 'N')]);
    await waitFor(() => expect(h.sink.of(a.sid, 'ack').at(-1)).toMatchObject({ clientSeq: 3, rev: 4 }));
    expect(textOf(inst.model)).toBe('Noutside');
    // A same-epoch resume at the old rev 2 is not caught up: it reloads.
    const c = h.join(inst.documentId);
    h.hello(c, 'cC', { epoch: a.epoch, rev: 2 });
    await waitFor(() => expect(h.sink.of(c, 'load-start')[0]?.rev).toBe(4));
    expect(h.sink.of(c, 'resync')[0]?.reason).toBe('history-unavailable');
  });

  it('resets allowedEdit: storage content with unsupported features opens read-only', async () => {
    const h = await harness();
    const { id, inst } = await conflicted(h, 'UNSUPPORTED stuff');
    const m = h.meta.get(docKeyOf(id));
    if (m === undefined) throw new Error('no meta');
    await h.meta.put({ ...m, readOnly: { findings: [], allowedEdit: true } });
    await inst.reloadFromStorage();
    expect(inst.readOnly).toBe(true);
    expect(inst.findings).toEqual([{ feature: 'comments', count: 1 }]);
    expect(h.meta.get(docKeyOf(id))?.readOnly).toEqual({ findings: [{ feature: 'comments', count: 1 }], allowedEdit: false });
  });

  it('replaces the snapshot before it touches the journal', async () => {
    const h = await harness();
    const { inst } = await conflicted(h);
    const order: string[] = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with .call(this)
    const write = SnapshotStore.prototype.write;
    vi.spyOn(SnapshotStore.prototype, 'write').mockImplementation(async function (this: SnapshotStore, k, f) {
      await write.call(this, k, f);
      order.push('snapshot durable');
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with .call(this)
    const rotate = Journal.prototype.rotate;
    vi.spyOn(Journal.prototype, 'rotate').mockImplementation(function (this: Journal, r) {
      order.push('journal rotate');
      return rotate.call(this, r);
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with .call(this)
    const trim = Journal.prototype.trimBefore;
    vi.spyOn(Journal.prototype, 'trimBefore').mockImplementation(function (this: Journal, r) {
      order.push('journal trim');
      return trim.call(this, r);
    });
    await inst.reloadFromStorage();
    expect(order).toEqual(['snapshot durable', 'journal rotate', 'journal trim']);
  });

  it('a failed storage read keeps the local copy and the instance running', async () => {
    const h = await harness();
    const { id, a, inst } = await conflicted(h);
    const before = await segments(h, id);
    h.storage.failNext('stat');
    await expect(inst.reloadFromStorage()).rejects.toMatchObject({ code: 'STORAGE_READ_FAILED' });
    expect(inst.state).toBe('ACTIVE');
    expect(textOf(inst.model)).toBe('XabY');
    expect(inst.rev).toBe(2);
    expect(h.meta.get(docKeyOf(id))?.storageState).toBe('CONFLICT');
    expect(await segments(h, id)).toEqual(before);
    expect((await new SnapshotStore(h.dataDir).read(docKeyOf(id)))?.rev).toBe(0);
    // The FIFO loop runs again.
    h.submit(a.sid, 'cA', 2, a.epoch, 2, [ins(2, 'Z')]);
    await waitFor(() => expect(h.sink.of(a.sid, 'ack').at(-1)).toMatchObject({ clientSeq: 2, rev: 3 }));
  });

  it('a failed snapshot write deletes nothing: the old snapshot and journal stay', async () => {
    const h = await harness();
    const { id, inst } = await conflicted(h);
    const before = await segments(h, id);
    vi.spyOn(SnapshotStore.prototype, 'write').mockRejectedValueOnce(new Error('disk full'));
    await expect(inst.reloadFromStorage()).rejects.toBeDefined();
    expect(inst.state).toBe('ACTIVE');
    expect(inst.rev).toBe(2);
    expect(await segments(h, id)).toEqual(before);
    expect((await new SnapshotStore(h.dataDir).read(docKeyOf(id)))?.rev).toBe(0);
    expect(h.meta.get(docKeyOf(id))?.storageState).toBe('CONFLICT');
  });

  it('a failure after the snapshot was replaced faults the instance; the next join loads the new content', async () => {
    const h = await harness();
    const { id, a, inst } = await conflicted(h);
    vi.spyOn(Journal.prototype, 'trimBefore').mockRejectedValueOnce(new Error('disk full'));
    await expect(inst.reloadFromStorage()).rejects.toMatchObject({ code: 'DOCUMENT_FAULTED' });
    expect(inst.state).toBe('CLOSED');
    expect(h.sink.closes(a.sid)).toContain(CloseCode.DOCUMENT_FAULTED);
    const c = await h.open(id, 'cC');
    expect(c.rev).toBe(3);
    expect(textOf(h.registry.get(id)?.model)).toBe('outside');
  });

  it('refuses when the instance is not active', async () => {
    const h = await harness();
    const { inst } = await conflicted(h);
    await inst.close();
    await expect(inst.reloadFromStorage()).rejects.toMatchObject({ code: 'DOCUMENT_FAULTED' });
  });
});
