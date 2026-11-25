// FlushScheduler (LLD Part 2 §12, HLD §10.3): quiet period, maximum interval under constant
// typing, no overlapping flushes, conversion retry, write failure and conflict hand-off.
import { rm } from 'node:fs/promises';
import { asDocumentId } from '@open-docex/shared/ids';
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from '../../wait-for.js';
import { engineError } from '../../../src/errors/engine-error.js';
import { FlushScheduler, type FlushRecovery } from '../../../src/flush/flush-scheduler.js';
import { docKeyOf } from '../../../src/persistence/layout.js';
import type { DocumentMeta, MetaStore } from '../../../src/persistence/meta-store.js';
import { FakeStorage } from '../../../test-kit/storage/fake-storage.js';
import { decodeText, encodeText, FakeClock, FakeExport, FakeTarget, makeMeta, metaStoreWith, Recorder, settle, tempDir } from '../recovery/helpers.js';

const QUIET = 30_000;
const MAX = 300_000;
const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setup(o: { meta?: Partial<DocumentMeta> } = {}) {
  const id = asDocumentId('doc-1');
  const dataDir = await tempDir();
  dirs.push(dataDir);
  const storage = new FakeStorage();
  const v = storage.setFile(id, encodeText('hello'));
  const meta: MetaStore = await metaStoreWith(dataDir, makeMeta(id, { lastKnownVersion: v, ...o.meta }));
  const target = new FakeTarget(id, id, 'hello');
  const clock = new FakeClock(0);
  const codec = new FakeExport();
  const rec = new Recorder();
  const recovery: FlushRecovery & { failed: unknown[]; conflicts: unknown[] } = {
    failed: [],
    conflicts: [],
    onWriteFailed(inst, err) {
      this.failed.push({ inst, err });
      return Promise.resolve();
    },
    onConflict(inst, v2) {
      this.conflicts.push({ inst, v: v2 });
      return Promise.resolve();
    },
  };
  const flush = new FlushScheduler({
    codec,
    router: { route: () => storage },
    meta,
    recovery,
    clock,
    quietMs: QUIET,
    maxIntervalMs: MAX,
    dataDir,
    emit: rec.emit,
  });
  /** Commits one op on the target and tells the scheduler. */
  const type = (text: string): void => {
    target.edit(text);
    flush.markDirty(target);
  };
  return { id, storage, meta, target, clock, codec, rec, recovery, flush, type, m: () => meta.get(docKeyOf(id)) as DocumentMeta };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function flushed(s: Setup, rev: number): Promise<void> {
  await waitFor(() => expect(s.m().lastFlushedRev).toBe(rev));
  await settle();
}

describe('FlushScheduler: scheduling', () => {
  it('flushes after the quiet period', async () => {
    const s = await setup();
    s.type('hello world');
    await s.clock.advance(QUIET - 1);
    expect(s.codec.calls).toBe(0);
    await s.clock.advance(1);
    await flushed(s, 1);
    const file = s.storage.getFile(s.id);
    expect(decodeText(file?.bytes)).toBe('hello world');
    expect(s.m()).toMatchObject({ lastKnownVersion: file?.version, lastFlushedRev: 1, rev: 1, storageState: 'NORMAL' });
    expect(s.flush.size).toBe(0); // clean entries are dropped
    expect(s.target.compactions).toEqual([1]); // compaction after the successful flush
    expect(s.clock.pending).toEqual([]);
  });

  it('flushes at least every maxIntervalMs under constant typing, without timer churn', async () => {
    const s = await setup();
    const STEP = 1_000;
    for (let t = 0; t < MAX; t += STEP) {
      s.type(`text ${t}`);
      await s.clock.advance(STEP);
    }
    await flushed(s, MAX / STEP);
    expect(s.codec.calls).toBe(1);
    // A timer re-arms once per quiet window that typing pushed back, never once per op.
    expect(s.clock.armed).toBeLessThanOrEqual(Math.ceil(MAX / (QUIET - STEP)) + 1);
  });

  it('a quiet period after typing flushes again, then stays idle', async () => {
    const s = await setup();
    s.type('a');
    await s.clock.advance(QUIET);
    await flushed(s, 1);
    s.type('ab');
    s.type('abc');
    await s.clock.advance(QUIET);
    await flushed(s, 3);
    await s.clock.advance(10 * MAX);
    expect(s.codec.calls).toBe(2);
  });

  it('flushNow on a clean document is a no-op', async () => {
    const s = await setup();
    expect(await s.flush.flushNow(s.target)).toBe('clean');
    expect(s.storage.calls).toHaveLength(0);
  });
});

describe('FlushScheduler: one flush at a time', () => {
  it('never overlaps flushes; ops during a flush keep the document dirty and flush later', async () => {
    const s = await setup();
    let release!: () => void;
    s.codec.gate = new Promise((r) => (release = r));
    s.type('one');
    await s.clock.advance(QUIET);
    expect(s.codec.calls).toBe(1);
    s.type('two'); // rev 2 during the export of rev 1
    const now = s.flush.flushNow(s.target); // waits for the running flush, then flushes rev 2
    await s.clock.advance(MAX); // timers that fire meanwhile only set `again`
    expect(s.codec.inFlight).toBe(1);
    s.codec.gate = null;
    release();
    expect(await now).toBe('flushed');
    expect(s.codec.maxInFlight).toBe(1);
    expect(s.m().lastFlushedRev).toBe(2);
    expect(decodeText(s.storage.getFile(s.id)?.bytes)).toBe('two');
  });

  it('flushNow with timeoutMs gives up waiting with failed', async () => {
    const s = await setup();
    s.codec.gate = new Promise(() => undefined);
    s.type('one');
    const p = s.flush.flushNow(s.target, { timeoutMs: 1_000 });
    await s.clock.advance(1_000);
    expect(await p).toBe('failed');
  });
});

describe('FlushScheduler: failures', () => {
  it('a conversion failure emits error, stays dirty and retries after the quiet period', async () => {
    const s = await setup();
    s.codec.failures.push(engineError('CONVERSION_FAILED'));
    s.type('hello world');
    await s.clock.advance(QUIET);
    await waitFor(() => expect(s.rec.errors()).toHaveLength(1));
    expect(s.rec.errors()[0]).toMatchObject({ code: 'CONVERSION_FAILED', documentId: s.id });
    expect(s.m().lastFlushedRev).toBe(0);
    await s.clock.advance(QUIET);
    await flushed(s, 1);
    expect(s.codec.calls).toBe(2);
  });

  it('a write failure goes to recovery.onWriteFailed with STORAGE_WRITE_FAILED and arms no timer', async () => {
    const s = await setup();
    s.storage.failNext('write');
    s.type('hello world');
    expect(await s.flush.flushNow(s.target)).toBe('failed');
    expect(s.recovery.failed).toHaveLength(1);
    expect(s.recovery.failed[0]).toMatchObject({ inst: s.target, err: { code: 'STORAGE_WRITE_FAILED', documentId: s.id } });
    expect(s.m().lastFlushedRev).toBe(0);
    expect(s.clock.pending).toEqual([]);
    expect(s.target.compactions).toEqual([]); // no compaction without a successful flush
  });

  it('a write conflict goes to recovery.onConflict with the current version (L-11)', async () => {
    const s = await setup();
    const outside = s.storage.setFile(s.id, encodeText('edited elsewhere'));
    s.type('hello world');
    expect(await s.flush.flushNow(s.target)).toBe('failed');
    expect(s.recovery.conflicts).toEqual([{ inst: s.target, v: outside }]);
    expect(decodeText(s.storage.getFile(s.id)?.bytes)).toBe('edited elsewhere');
    expect(s.target.compactions).toEqual([]);
  });

  it('skips outside NORMAL (recovery owns the writes) and flushes once NORMAL again', async () => {
    const s = await setup({ meta: { storageState: 'LOCAL' } });
    s.type('a');
    await s.clock.advance(QUIET);
    expect(await s.flush.flushNow(s.target)).toBe('skipped');
    expect(s.storage.calls).toHaveLength(0);
    await s.meta.put({ ...s.m(), storageState: 'NORMAL' });
    s.flush.markDirty(s.target); // what RecoveryManager does after a write-back
    await s.clock.advance(MAX);
    await flushed(s, 1);
  });
});

describe('FlushScheduler: shutdown', () => {
  it('flushAll flushes every dirty document and leaves no timer', async () => {
    const s = await setup();
    s.type('bye');
    await s.flush.flushAll(s.clock.now() + 10_000);
    expect(s.m().lastFlushedRev).toBe(1);
    s.type('after');
    expect(s.clock.pending).toEqual([]);
  });
});
