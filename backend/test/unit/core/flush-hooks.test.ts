// V1-16 follow-ups (§0.5 S-38): DocumentInstance.compactAfterFlush (LLD Part 2 §12) and the
// storage notice a session gets after loading while storage is not NORMAL.
import { readdir } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { historyMaxOps } from '../../../src/core/op-history.js';
import { Journal } from '../../../src/persistence/journal.js';
import { docKeyOf, journalDir } from '../../../src/persistence/layout.js';
import type { StorageState } from '../../../src/persistence/meta-store.js';
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

/** `a.docx` edited to rev 2 by one client. */
async function edited(h: Harness) {
  const id = h.file('a.docx', 'ab', 'v1');
  const a = await h.open(id, 'cA');
  h.submit(a.sid, 'cA', 1, a.epoch, 0, [ins(2, 'X')]);
  h.submit(a.sid, 'cA', 2, a.epoch, 1, [ins(2, 'Y')]);
  await vi.waitFor(() => expect(h.sink.of(a.sid, 'ack')).toHaveLength(2));
  const inst = h.registry.get(id);
  if (inst === undefined) throw new Error('not loaded');
  return { id, a, inst };
}

describe('DocumentInstance.compactAfterFlush', () => {
  it('snapshots and rotates at the current rev, then trims before min(flushedRev, snapshotRev) − historyMaxOps', async () => {
    const h = await harness();
    const { id, inst } = await edited(h);
    const trims = vi.spyOn(Journal.prototype, 'trimBefore');
    const hist = historyMaxOps(h.config.snapshot.everyOps);
    await inst.compactAfterFlush(1);
    expect((await new SnapshotStore(h.dataDir).read(docKeyOf(id)))?.rev).toBe(2);
    expect(await readdir(journalDir(h.dataDir, docKeyOf(id)))).toContain('000000000002.ndjson');
    expect(trims.mock.calls).toEqual([[1 - hist]]);
    // No ops since the snapshot: no new snapshot, only the trim (bounded by the snapshot rev).
    const writes = vi.spyOn(SnapshotStore.prototype, 'write');
    await inst.compactAfterFlush(5);
    expect(writes).not.toHaveBeenCalled();
    expect(trims.mock.calls.at(-1)).toEqual([2 - hist]);
  });

  it('deletes the journal segments behind the trim floor', async () => {
    const h = await harness();
    const { id, inst } = await edited(h);
    const hist = historyMaxOps(h.config.snapshot.everyOps);
    // Shift the floor past rev 2, as if the document had historyMaxOps more history.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with .call(this)
    const trim = Journal.prototype.trimBefore;
    vi.spyOn(Journal.prototype, 'trimBefore').mockImplementation(function (this: Journal, r) {
      return trim.call(this, r + hist + 1);
    });
    const dir = journalDir(h.dataDir, docKeyOf(id));
    expect(await readdir(dir)).toEqual(['000000000000.ndjson']);
    await inst.compactAfterFlush(2);
    expect(await readdir(dir)).toEqual(['000000000002.ndjson']);
  });

  it('a crash between the snapshot and the trim loses nothing', async () => {
    const h = await harness();
    const { id, a, inst } = await edited(h);
    const model = textOf(inst.model);
    vi.spyOn(Journal.prototype, 'trimBefore').mockRejectedValueOnce(new Error('crash'));
    await inst.compactAfterFlush(2); // never rejects: the failure faults the instance
    await vi.waitFor(() => expect(inst.state).toBe('CLOSED'));
    expect(h.sink.closes(a.sid)).not.toHaveLength(0);
    expect((await new SnapshotStore(h.dataDir).read(docKeyOf(id)))?.rev).toBe(2);
    const c = await h.open(id, 'cC');
    expect(c.rev).toBe(2);
    expect(textOf(h.registry.get(id)?.model)).toBe(model);
  });
});

describe('storage notice after loading (S-38)', () => {
  const cases: Array<[StorageState, 'local' | 'pending' | null]> = [
    ['LOCAL', 'local'],
    ['PENDING', 'pending'],
    ['CONFLICT', 'pending'],
    ['NORMAL', null],
  ];
  for (const [state, notice] of cases) {
    it(`${state}: a session that finishes loading gets ${notice ?? 'no'} storage notice after load-done`, async () => {
      const h = await harness();
      const { id } = await edited(h);
      const m = h.meta.get(docKeyOf(id));
      if (m === undefined) throw new Error('no meta');
      await h.meta.put({ ...m, storageState: state });
      const b = await h.open(id, 'cB');
      await vi.waitFor(() => expect(h.sink.messages(b.sid).length).toBeGreaterThan(0));
      const types = h.sink.messages(b.sid).map((x) => (x.type === 'notice' && x.notice === 'storage' ? `notice:${x.state}` : x.type));
      const done = types.indexOf('load-done');
      if (notice === null) expect(types.some((t) => t.startsWith('notice:'))).toBe(false);
      else expect(types.slice(done + 1)).toEqual([`notice:${notice}`]);
    });
  }
});
