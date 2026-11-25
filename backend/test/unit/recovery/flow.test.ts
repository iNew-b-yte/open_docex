// The flush scheduler and the recovery manager wired to the real Core instances (registry,
// journal, snapshots, meta), with a fake clock and FakeStorage (LLD Part 2 §13 "Integration").
import { appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ClientId, DocumentId } from '@open-docex/shared/ids';
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from '../../wait-for.js';
import type { DocumentInstance } from '../../../src/core/document-instance.js';
import type { DocumentRegistry } from '../../../src/core/registry.js';
import { FlushScheduler } from '../../../src/flush/flush-scheduler.js';
import { Journal, segmentName } from '../../../src/persistence/journal.js';
import { docKeyOf, journalDir } from '../../../src/persistence/layout.js';
import { RecoveryManager, type RecoveryRegistry, type RecoveryTarget } from '../../../src/recovery/recovery-manager.js';
import { readLocalRev } from '../../../src/recovery/local-rev.js';
import { ins, makeHarness, textOf, type Harness } from '../core/harness.js';
import { decodeText, FakeClock, FakeExport, Recorder, tempDir } from './helpers.js';

// The real Core types satisfy the recovery seams.
const registryFits = (r: DocumentRegistry): RecoveryRegistry => r;
const instanceFits = (i: DocumentInstance): RecoveryTarget => i;
void registryFits;
void instanceFits;

const MIN = 60_000;
const QUIET = 30_000;
let harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses) await h.dispose();
  harnesses = [];
});

async function wired() {
  const h = await makeHarness();
  harnesses.push(h);
  const clock = new FakeClock(0);
  const codec = new FakeExport();
  const rec = new Recorder();
  const router = { route: () => h.storage };
  // The recovery manager needs the registry, so the scheduler forwards to it once built.
  const late: { recovery?: RecoveryManager } = {};
  const flush = new FlushScheduler({
    codec,
    router,
    meta: h.meta,
    recovery: {
      onWriteFailed: (i, e) => (late.recovery as RecoveryManager).onWriteFailed(i, e),
      onConflict: (i, v) => (late.recovery as RecoveryManager).onConflict(i, v),
    },
    clock,
    quietMs: QUIET,
    maxIntervalMs: 5 * MIN,
    dataDir: h.dataDir,
    emit: rec.emit,
  });
  const recovery = new RecoveryManager({
    meta: h.meta,
    registry: h.registry,
    codec,
    router,
    sink: h.sink,
    emit: rec.emit,
    flush,
    clock,
    delays: [1 * MIN, 5 * MIN, 15 * MIN],
    dataDir: h.dataDir,
  });
  late.recovery = recovery;
  h.deps.flush = flush; // instances read their deps at use time
  return { h, clock, rec, flush, recovery };
}

function state(h: Harness, id: DocumentId): string | undefined {
  return h.meta.get(docKeyOf(id))?.storageState;
}

function storageNotices(h: Harness, sid: string): string[] {
  return h.sink.of(sid, 'notice').flatMap((n) => (n.notice === 'storage' ? [n.state] : []));
}

describe('flush and recovery with real instances', () => {
  it('storage goes down, editing continues, storage comes back: the stored file equals the local model', async () => {
    const { h, clock, rec } = await wired();
    const id = h.file('a.docx', 'ab');
    const a = await h.open(id, 'cA');
    h.submit(a.sid, 'cA', 1, a.epoch, 0, [ins(2, 'X')]);
    await waitFor(() => expect(h.sink.of(a.sid, 'ack')).toHaveLength(1));

    h.storage.failNext('write');
    await clock.advance(QUIET);
    await waitFor(() => expect(state(h, id)).toBe('LOCAL'));
    expect(storageNotices(h, a.sid)).toEqual(['local']);

    // Editing continues while local.
    h.submit(a.sid, 'cA', 2, a.epoch, 1, [ins(2, 'Y')]);
    await waitFor(() => expect(h.sink.of(a.sid, 'ack')).toHaveLength(2));

    h.storage.failNext('stat');
    await clock.advance(1 * MIN);
    await waitFor(() => expect(h.meta.get(docKeyOf(id))?.retryCount).toBe(1));
    expect(decodeText(h.storage.getFile(id)?.bytes)).toBe('ab');

    await clock.advance(5 * MIN);
    await waitFor(() => expect(state(h, id)).toBe('NORMAL'));
    const inst = h.registry.get(id);
    expect(decodeText(h.storage.getFile(id)?.bytes)).toBe(textOf(inst?.model));
    expect(textOf(inst?.model)).toBe('YXab');
    expect(h.meta.get(docKeyOf(id))).toMatchObject({ lastFlushedRev: 2, lastKnownVersion: h.storage.getFile(id)?.version });
    expect(storageNotices(h, a.sid)).toEqual(['local', 'normal']);
    expect(rec.storage().map((e) => e['state'])).toEqual(['local', 'recovered']);

    // Back in NORMAL, the scheduler flushes again.
    h.submit(a.sid, 'cA', 3, a.epoch, 2, [ins(2, 'Z')]);
    await waitFor(() => expect(h.sink.of(a.sid, 'ack')).toHaveLength(3));
    await clock.advance(QUIET);
    await waitFor(() => expect(decodeText(h.storage.getFile(id)?.bytes)).toBe('ZYXab'));
  });

  it('a conflict, then resolve(discard-local): sessions reload the storage content and flushing resumes', async () => {
    const { h, clock, rec, recovery } = await wired();
    const id = h.file('a.docx', 'ab');
    const a = await h.open(id, 'cA');
    h.submit(a.sid, 'cA', 1, a.epoch, 0, [ins(2, 'X')]);
    await waitFor(() => expect(h.sink.of(a.sid, 'ack')).toHaveLength(1));
    h.storage.setFile(id, new TextEncoder().encode('outside'));

    await clock.advance(QUIET);
    await waitFor(() => expect(state(h, id)).toBe('CONFLICT'));
    expect(storageNotices(h, a.sid)).toEqual(['pending']);
    expect(rec.errors().map((e) => e.code)).toEqual(['STORAGE_CONFLICT']);
    expect(decodeText(h.storage.getFile(id)?.bytes)).toBe('outside');
    expect(recovery.list().map((e) => [e.documentId, e.state, e.localRev])).toEqual([[id, 'CONFLICT', 1]]);

    const before = h.sink.messages(a.sid).length;
    const entry = await recovery.resolve(id, 'discard-local');
    expect(entry.state).toBe('NORMAL');
    await waitFor(() => expect(h.sink.of(a.sid, 'load-done').length).toBeGreaterThan(1));
    const types = h.sink.messages(a.sid).slice(before).map((m) => m.type);
    expect(types.slice(0, 2)).toEqual(['resync', 'load-start']);
    expect(storageNotices(h, a.sid)).toEqual(['pending', 'normal']);
    expect(textOf(h.registry.get(id)?.model)).toBe('outside');
    expect(recovery.list()).toEqual([]);

    h.submit(a.sid, 'cA', 2, a.epoch, 2, [ins(2, 'N')]);
    await waitFor(() => expect(h.sink.of(a.sid, 'ack').at(-1)?.rev).toBe(3));
    await clock.advance(QUIET);
    await waitFor(() => expect(decodeText(h.storage.getFile(id)?.bytes)).toBe('Noutside'));
  });

  it('a conflict, then resolve(overwrite-storage): the local model replaces the outside edit', async () => {
    const { h, clock, recovery } = await wired();
    const id = h.file('a.docx', 'ab');
    const a = await h.open(id, 'cA');
    h.submit(a.sid, 'cA', 1, a.epoch, 0, [ins(2, 'X')]);
    await waitFor(() => expect(h.sink.of(a.sid, 'ack')).toHaveLength(1));
    h.storage.setFile(id, new TextEncoder().encode('outside'));
    await clock.advance(QUIET);
    await waitFor(() => expect(state(h, id)).toBe('CONFLICT'));
    expect(decodeText((await recovery.readLocalCopy(id)).bytes)).toBe('Xab');
    await recovery.resolve(id, 'overwrite-storage');
    expect(decodeText(h.storage.getFile(id)?.bytes)).toBe('Xab');
    expect(state(h, id)).toBe('NORMAL');
  });
});

describe('readLocalRev', () => {
  it('reads the last entry of the last segment, skips a torn tail, and falls back to the segment rev', async () => {
    const dataDir = await tempDir();
    const key = docKeyOf('d' as DocumentId);
    expect(await readLocalRev(dataDir, key)).toBeNull();
    const dir = journalDir(dataDir, key);
    const j = await Journal.open(dir, { fsync: 'always' });
    const entry = (f: number, r: number) => ({ f, r, c: 'c' as ClientId, q: f + 1, u: 'u', t: 0, x: false, o: new Array<unknown>(r - f).fill({}) });
    await j.append(entry(0, 2));
    await j.append(entry(2, 5));
    expect(await readLocalRev(dataDir, key)).toBe(5);
    await j.rotate(5); // as snapshotAndRotate does: an empty segment named after the snapshot rev
    expect(await readLocalRev(dataDir, key)).toBe(5);
    await j.append(entry(5, 6));
    await j.close();
    await appendFile(path.join(dir, segmentName(5)), '{"k":"00000000","e":{"f":6'); // torn
    expect(await readLocalRev(dataDir, key)).toBe(6);
    await rm(dataDir, { recursive: true, force: true });
  });
});
