// RecoveryManager (LLD Part 2 §13, HLD §11.3; §0 L-8, L-11): every state-machine row with a
// fake clock and FakeStorage, restart in each state, and the order of meta, notice and events.
import { rm } from 'node:fs/promises';
import { asDocumentId, type DocumentId } from '@open-docex/shared/ids';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenDocexError } from '@open-docex/shared/errors';
import { engineError } from '../../../src/errors/engine-error.js';
import { Journal } from '../../../src/persistence/journal.js';
import { docKeyOf, journalDir } from '../../../src/persistence/layout.js';
import type { DocumentMeta, MetaStore } from '../../../src/persistence/meta-store.js';
import { BOOT_SETTLE_MS, RecoveryManager } from '../../../src/recovery/recovery-manager.js';
import { FakeStorage } from '../../../test-kit/storage/fake-storage.js';
import {
  decodeText,
  encodeText,
  FakeClock,
  FakeExport,
  FakeRegistry,
  FakeTarget,
  makeMeta,
  metaStoreWith,
  Recorder,
  settle,
  tempDir,
} from './helpers.js';

const MIN = 60_000;
const DELAYS = [1 * MIN, 5 * MIN, 15 * MIN] as const;
const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

interface Setup {
  id: DocumentId;
  dataDir: string;
  clock: FakeClock;
  storage: FakeStorage;
  meta: MetaStore;
  registry: FakeRegistry;
  target: FakeTarget;
  codec: FakeExport;
  rec: Recorder;
  flush: { markDirty: ReturnType<typeof vi.fn> };
  rm: RecoveryManager;
  /** The meta of the document. */
  m(): DocumentMeta;
}

/**
 * A NORMAL document `doc-1` stored as "hello", loaded with local edits up to rev 2 ("hello
 * world"), of which rev 1 was flushed. `o.meta` overrides the meta; `o.dataDir` reuses a folder.
 */
async function setup(o: { meta?: Partial<DocumentMeta>; dataDir?: string; now?: number; storage?: FakeStorage } = {}): Promise<Setup> {
  const id = asDocumentId('doc-1');
  const dataDir = o.dataDir ?? (await tempDir());
  if (o.dataDir === undefined) dirs.push(dataDir);
  const storage = o.storage ?? new FakeStorage();
  const v = storage.getFile(id)?.version ?? storage.setFile(id, encodeText('hello'));
  const meta = await metaStoreWith(dataDir);
  if (o.dataDir === undefined || o.meta !== undefined) {
    await meta.put(makeMeta(id, { lastKnownVersion: v, lastFlushedRev: 1, rev: 1, ...o.meta }));
  }
  const target = new FakeTarget(id, id, 'hello');
  target.edit('hello');
  target.edit('hello world');
  const registry = new FakeRegistry(() => target);
  registry.loaded.set(id, target);
  const clock = new FakeClock(o.now ?? 0);
  const codec = new FakeExport();
  const rec = new Recorder();
  const flush = { markDirty: vi.fn() };
  const mgr = new RecoveryManager({
    meta,
    registry,
    codec,
    router: { route: () => storage },
    sink: rec.sink,
    emit: rec.emit,
    flush,
    clock,
    delays: DELAYS,
    dataDir,
  });
  return { id, dataDir, clock, storage, meta, registry, target, codec, rec, flush, rm: mgr, m: () => meta.get(docKeyOf(id)) as DocumentMeta };
}

const writeError = (): OpenDocexError => engineError('STORAGE_WRITE_FAILED', { documentId: asDocumentId('doc-1'), cause: new Error('down') });

/** Waits until the document's meta satisfies `pred`. */
async function until(s: Setup, pred: (m: DocumentMeta) => boolean): Promise<void> {
  await vi.waitFor(() => {
    if (!pred(s.m())) throw new Error(`meta not there yet: ${s.m().storageState}`);
  });
  await settle();
}

describe('RecoveryManager: NORMAL → LOCAL → PENDING with retries at 1, 5 and 15 minutes', () => {
  it('arms retries at +1 min, +5 min and +15 min, then goes PENDING after the third failure', async () => {
    const s = await setup();
    s.storage.failNext('stat', { times: 3 });
    await s.rm.onWriteFailed(s.target, writeError());
    expect(s.m()).toMatchObject({ storageState: 'LOCAL', retryCount: 0, localSince: 0, nextRetryAt: 1 * MIN, rev: 2 });
    expect(s.m().lastError?.code).toBe('STORAGE_WRITE_FAILED');
    expect(s.rec.log).toEqual(['notice:local', 'storage:local', 'error:STORAGE_LOCAL_MODE']);

    await s.clock.advance(1 * MIN - 1);
    expect(s.storage.calls).toHaveLength(0);
    await s.clock.advance(1);
    await until(s, (m) => m.retryCount === 1);
    expect(s.m()).toMatchObject({ storageState: 'LOCAL', nextRetryAt: 6 * MIN });
    expect(s.m().lastError?.code).toBe('STORAGE_READ_FAILED');

    await s.clock.advance(5 * MIN - 1);
    expect(s.storage.calls).toHaveLength(1);
    await s.clock.advance(1);
    await until(s, (m) => m.retryCount === 2);
    expect(s.m()).toMatchObject({ storageState: 'LOCAL', nextRetryAt: 21 * MIN });

    await s.clock.advance(15 * MIN - 1);
    expect(s.storage.calls).toHaveLength(2);
    await s.clock.advance(1);
    await until(s, (m) => m.storageState === 'PENDING');
    expect(s.m()).toMatchObject({ retryCount: 3, nextRetryAt: null });
    // The LOCAL→LOCAL retries are log-only; PENDING sends a notice and two events.
    expect(s.rec.log).toEqual(['notice:local', 'storage:local', 'error:STORAGE_LOCAL_MODE', 'notice:pending', 'storage:pending', 'error:STORAGE_PENDING']);
    expect(s.rec.storage().at(-1)).toMatchObject({ documentId: s.id, state: 'pending', retryCount: 3, nextRetryAt: null });
    expect(s.clock.pending).toEqual([]);
  });

  it('a retry that finds storage unchanged writes the local model back and returns to NORMAL', async () => {
    const s = await setup();
    await s.rm.onWriteFailed(s.target, writeError());
    await s.clock.advance(1 * MIN);
    await until(s, (m) => m.storageState === 'NORMAL');
    const file = s.storage.getFile(s.id);
    expect(decodeText(file?.bytes)).toBe('hello world');
    expect(s.m()).toMatchObject({ lastKnownVersion: file?.version, lastFlushedRev: 2, retryCount: 0, localSince: null, nextRetryAt: null });
    expect(s.m().lastError).toBeUndefined();
    expect(s.rec.log.slice(-2)).toEqual(['notice:normal', 'storage:recovered']);
    expect(s.flush.markDirty).not.toHaveBeenCalled(); // nothing newer than the write-back
  });

  it('a failed write-back during CHECK counts as a failed retry (L-11)', async () => {
    const s = await setup();
    await s.rm.onWriteFailed(s.target, writeError());
    s.storage.failNext('write');
    await s.clock.advance(1 * MIN);
    await until(s, (m) => m.retryCount === 1);
    expect(s.m()).toMatchObject({ storageState: 'LOCAL', nextRetryAt: 6 * MIN });
    expect(s.m().lastError?.code).toBe('STORAGE_WRITE_FAILED');
    expect(decodeText(s.storage.getFile(s.id)?.bytes)).toBe('hello');
  });

  it('an export failure during the write-back also counts as a failed retry', async () => {
    const s = await setup();
    await s.rm.onWriteFailed(s.target, writeError());
    s.codec.failures.push(engineError('CONVERSION_FAILED'));
    await s.clock.advance(1 * MIN);
    await until(s, (m) => m.retryCount === 1);
    expect(s.m().lastError?.code).toBe('CONVERSION_FAILED');
  });

  it('marks the instance dirty after a write-back when it moved on meanwhile', async () => {
    const s = await setup();
    await s.rm.onWriteFailed(s.target, writeError());
    let release!: () => void;
    s.codec.gate = new Promise((r) => (release = r));
    await s.clock.advance(1 * MIN);
    await vi.waitFor(() => expect(s.codec.calls).toBe(1));
    s.target.edit('hello world!'); // rev 3 arrives during the export of rev 2
    release();
    await until(s, (m) => m.storageState === 'NORMAL');
    expect(s.m().lastFlushedRev).toBe(2);
    expect(s.flush.markDirty).toHaveBeenCalledWith(s.target);
  });
});

describe('RecoveryManager: CONFLICT', () => {
  it('CHECK → CONFLICT when the storage version changed', async () => {
    const s = await setup();
    await s.rm.onWriteFailed(s.target, writeError());
    const outside = s.storage.setFile(s.id, encodeText('edited elsewhere'));
    await s.clock.advance(1 * MIN);
    await until(s, (m) => m.storageState === 'CONFLICT');
    expect(s.m().conflict).toEqual({ detectedAt: 1 * MIN, storageVersion: outside });
    expect(decodeText(s.storage.getFile(s.id)?.bytes)).toBe('edited elsewhere'); // never overwritten
    expect(s.rec.log.slice(-3)).toEqual(['notice:pending', 'storage:conflict', 'error:STORAGE_CONFLICT']);
  });

  it('CHECK → CONFLICT when the storage file was deleted', async () => {
    const s = await setup();
    await s.rm.onWriteFailed(s.target, writeError());
    s.storage.deleteFile(s.id);
    await s.clock.advance(1 * MIN);
    await until(s, (m) => m.storageState === 'CONFLICT');
    expect(s.m().conflict).toEqual({ detectedAt: 1 * MIN, storageVersion: null });
  });

  it('CHECK → CONFLICT when the write-back itself returns a conflict', async () => {
    const s = await setup();
    await s.rm.onWriteFailed(s.target, writeError());
    let release!: () => void;
    s.codec.gate = new Promise((r) => (release = r));
    await s.clock.advance(1 * MIN);
    await vi.waitFor(() => expect(s.codec.calls).toBe(1));
    const outside = s.storage.setFile(s.id, encodeText('raced'));
    release();
    await until(s, (m) => m.storageState === 'CONFLICT');
    expect(s.m().conflict?.storageVersion).toBe(outside);
    expect(decodeText(s.storage.getFile(s.id)?.bytes)).toBe('raced');
  });

  it('NORMAL → CONFLICT on a flush conflict (L-11), and retry() then rejects with STORAGE_CONFLICT', async () => {
    const s = await setup();
    await s.rm.onConflict(s.target, 'v-outside');
    expect(s.m()).toMatchObject({ storageState: 'CONFLICT', conflict: { detectedAt: 0, storageVersion: 'v-outside' }, localSince: 0, rev: 2 });
    expect(s.rec.log).toEqual(['notice:pending', 'storage:conflict', 'error:STORAGE_CONFLICT']);
    await expect(s.rm.retry(s.id)).rejects.toMatchObject({ code: 'STORAGE_CONFLICT' });
    expect(s.m().storageState).toBe('CONFLICT');
    expect(s.clock.pending).toEqual([]);
  });

  it('ignores onWriteFailed and onConflict outside NORMAL', async () => {
    const s = await setup({ meta: { storageState: 'PENDING', retryCount: 3 } });
    await s.rm.onWriteFailed(s.target, writeError());
    await s.rm.onConflict(s.target, 'x');
    expect(s.m().storageState).toBe('PENDING');
    expect(s.rec.log).toEqual([]);
  });
});

describe('RecoveryManager: adopter retry()', () => {
  it('NORMAL: a no-op that returns the entry', async () => {
    const s = await setup();
    const e = await s.rm.retry(s.id);
    expect(e).toMatchObject({ documentId: s.id, state: 'NORMAL', retryCount: 0 });
    expect(s.storage.calls).toHaveLength(0);
  });

  it('LOCAL: checks at once and cancels the pending timer', async () => {
    const s = await setup();
    await s.rm.onWriteFailed(s.target, writeError());
    const e = await s.rm.retry(s.id);
    expect(e).toMatchObject({ state: 'NORMAL', retryCount: 0, lastFlushedRev: 2, localRev: 2 });
    expect(s.clock.pending).toEqual([]);
  });

  it('PENDING: one CHECK; storage still unreachable keeps PENDING with retryCount unchanged', async () => {
    const s = await setup({ meta: { storageState: 'PENDING', retryCount: 3, localSince: 0 } });
    s.storage.failNext('stat');
    const e = await s.rm.retry(s.id);
    expect(e).toMatchObject({ state: 'PENDING', retryCount: 3, nextRetryAt: null });
    expect(s.storage.calls.map((c) => c.op)).toEqual(['stat']);
    expect(s.rec.log).toEqual(['notice:pending', 'storage:pending', 'error:STORAGE_PENDING']);
    expect(s.clock.pending).toEqual([]);
  });

  it('PENDING: one CHECK; storage back and unchanged returns to NORMAL', async () => {
    const s = await setup({ meta: { storageState: 'PENDING', retryCount: 3, localSince: 0 } });
    const e = await s.rm.retry(s.id);
    expect(e.state).toBe('NORMAL');
    expect(decodeText(s.storage.getFile(s.id)?.bytes)).toBe('hello world');
  });

  it('PENDING: one CHECK; storage changed goes to CONFLICT', async () => {
    const s = await setup({ meta: { storageState: 'PENDING', retryCount: 3, localSince: 0 } });
    s.storage.setFile(s.id, encodeText('edited elsewhere'));
    expect((await s.rm.retry(s.id)).state).toBe('CONFLICT');
  });

  it('a retry() during a CHECK awaits it instead of starting another', async () => {
    const s = await setup();
    await s.rm.onWriteFailed(s.target, writeError());
    s.storage.latencyMs = 1;
    const p1 = s.rm.retry(s.id);
    const p2 = s.rm.retry(s.id);
    const [a, b] = await Promise.all([p1, p2]);
    expect(a.state).toBe('NORMAL');
    expect(b.state).toBe('NORMAL');
    expect(s.storage.calls.filter((c) => c.op === 'stat')).toHaveLength(1);
  });

  it('an unknown document gives DOCUMENT_NOT_FOUND', async () => {
    const s = await setup();
    await expect(s.rm.retry(asDocumentId('nope'))).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
    await expect(s.rm.resolve(asDocumentId('nope'), 'discard-local')).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
    await expect(s.rm.readLocalCopy(asDocumentId('nope'))).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
  });
});

describe('RecoveryManager: resolve() (L-8)', () => {
  for (const state of ['CONFLICT', 'PENDING'] as const) {
    it(`${state} + overwrite-storage writes the local model over the current version`, async () => {
      const s = await setup({ meta: { storageState: state, retryCount: 3, conflict: { detectedAt: 0, storageVersion: null } } });
      s.storage.setFile(s.id, encodeText('edited elsewhere'));
      const e = await s.rm.resolve(s.id, 'overwrite-storage');
      const file = s.storage.getFile(s.id);
      expect(decodeText(file?.bytes)).toBe('hello world');
      expect(e).toMatchObject({ state: 'NORMAL', retryCount: 0, lastFlushedRev: 2 });
      expect(s.m()).toMatchObject({ lastKnownVersion: file?.version, localSince: null });
      expect(s.m().conflict).toBeUndefined();
      expect(s.rec.log).toEqual(['notice:normal', 'storage:recovered']);
    });

    it(`${state} + discard-local reloads the instance from storage`, async () => {
      const s = await setup({ meta: { storageState: state, retryCount: 3 } });
      s.target.onReload = () => s.meta.put(makeMeta(s.id, { lastKnownVersion: 'v-new', lastFlushedRev: 3, rev: 3 }));
      const e = await s.rm.resolve(s.id, 'discard-local');
      expect(s.target.reloads).toBe(1);
      expect(e).toMatchObject({ state: 'NORMAL', lastFlushedRev: 3 });
      expect(s.storage.calls.filter((c) => c.op === 'write')).toHaveLength(0);
      expect(s.rec.log).toEqual(['notice:normal', 'storage:recovered']);
    });

    it(`${state} + mark-resolved takes the storage version as known and the local rev as flushed`, async () => {
      const s = await setup({ meta: { storageState: state, retryCount: 3 } });
      const outside = s.storage.setFile(s.id, encodeText('handled by the adopter'));
      const e = await s.rm.resolve(s.id, 'mark-resolved');
      expect(e).toMatchObject({ state: 'NORMAL', lastFlushedRev: 2 });
      expect(s.m().lastKnownVersion).toBe(outside);
      expect(decodeText(s.storage.getFile(s.id)?.bytes)).toBe('handled by the adopter');
      expect(s.target.reloads).toBe(0);
    });
  }

  it('a failed discard-local keeps the state and rejects', async () => {
    const s = await setup({ meta: { storageState: 'CONFLICT' } });
    s.target.onReload = () => Promise.reject(engineError('DOCUMENT_NOT_FOUND'));
    await expect(s.rm.resolve(s.id, 'discard-local')).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
    expect(s.m().storageState).toBe('CONFLICT');
    expect(s.rec.log).toEqual([]);
  });

  it('a failed overwrite-storage keeps the state and rejects', async () => {
    const s = await setup({ meta: { storageState: 'PENDING', retryCount: 3 } });
    s.storage.failNext('write');
    await expect(s.rm.resolve(s.id, 'overwrite-storage')).rejects.toMatchObject({ code: 'STORAGE_WRITE_FAILED' });
    expect(s.m().storageState).toBe('PENDING');
  });

  it('loads the instance through getOrLoad when it is not loaded', async () => {
    const s = await setup({ meta: { storageState: 'CONFLICT' } });
    s.registry.loaded.clear();
    await s.rm.resolve(s.id, 'overwrite-storage');
    expect(s.registry.loads).toBe(1);
    expect(s.m().storageState).toBe('NORMAL');
  });

  it('NORMAL, LOCAL: a no-op that returns the entry; an unknown resolution is CONFIG_INVALID', async () => {
    const s = await setup();
    expect((await s.rm.resolve(s.id, 'discard-local')).state).toBe('NORMAL');
    await s.rm.onWriteFailed(s.target, writeError());
    expect((await s.rm.resolve(s.id, 'overwrite-storage')).state).toBe('LOCAL');
    expect(s.target.reloads).toBe(0);
    await expect(s.rm.resolve(s.id, 'bogus' as 'discard-local')).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
});

describe('RecoveryManager: list() and readLocalCopy()', () => {
  it('list() returns every document not in NORMAL', async () => {
    const s = await setup();
    await s.meta.put(makeMeta('doc-2', { storageState: 'PENDING', retryCount: 3, rev: 7, lastFlushedRev: 4, lastError: { code: 'STORAGE_READ_FAILED', message: 'm', at: 1 } }));
    expect(s.rm.list()).toEqual([
      { documentId: 'doc-2', state: 'PENDING', retryCount: 3, nextRetryAt: null, localSince: null, localRev: 7, lastFlushedRev: 4, lastError: { code: 'STORAGE_READ_FAILED', message: 'm' } },
    ]);
  });

  it('readLocalCopy() exports the current local model', async () => {
    const s = await setup({ meta: { storageState: 'CONFLICT' } });
    const c = await s.rm.readLocalCopy(s.id);
    expect(c).toMatchObject({ format: 'docx', rev: 2 });
    expect(decodeText(c.bytes)).toBe('hello world');
  });
});

describe('RecoveryManager: order of meta, notice and events', () => {
  it('writes meta before the notice, and the notice before the storage and error events', async () => {
    const s = await setup();
    s.rec.beforeSend = () => s.rec.log.push(`meta:${s.m().storageState}`);
    await s.rm.onWriteFailed(s.target, writeError());
    await s.rm.retry(s.id);
    expect(s.rec.log).toEqual(['meta:LOCAL', 'notice:local', 'storage:local', 'error:STORAGE_LOCAL_MODE', 'meta:NORMAL', 'notice:normal', 'storage:recovered']);
    expect(s.rec.notices.every((n) => n.sessionIds.join() === 's1')).toBe(true);
    const local = s.rec.storage()[0];
    expect(local).toMatchObject({ documentId: s.id, state: 'local', at: 0, retryCount: 0, nextRetryAt: 1 * MIN });
    expect(local?.['error']).toMatchObject({ code: 'STORAGE_LOCAL_MODE', documentId: s.id });
    expect(s.rec.errors()[0]).toMatchObject({ code: 'STORAGE_LOCAL_MODE', documentId: s.id });
  });
});

describe('RecoveryManager: restart (state persists in meta)', () => {
  /** Rebuilds the manager over the same data folder, as after a Core restart. */
  async function restart(s: Setup, now: number): Promise<Setup> {
    s.rm.close();
    const r = await setup({ dataDir: s.dataDir, now, storage: s.storage });
    r.registry.loaded.clear(); // nothing is loaded after a restart
    return r;
  }

  it('LOCAL: resumes the retry at nextRetryAt with the same retryCount', async () => {
    const s = await setup();
    s.storage.failNext('stat');
    await s.rm.onWriteFailed(s.target, writeError());
    await s.clock.advance(1 * MIN);
    await until(s, (m) => m.retryCount === 1); // next retry at 6 min
    const r = await restart(s, 2 * MIN);
    r.rm.resumeAfterBoot();
    expect(r.m()).toMatchObject({ storageState: 'LOCAL', retryCount: 1, nextRetryAt: 6 * MIN });
    expect(r.clock.pending).toEqual([6 * MIN]);
    r.storage.failNext('stat', { times: 2 });
    await r.clock.advance(4 * MIN);
    await until(r, (m) => m.retryCount === 2);
    expect(r.m().nextRetryAt).toBe(21 * MIN);
    await r.clock.advance(15 * MIN);
    await until(r, (m) => m.storageState === 'PENDING');
  });

  it('LOCAL with nextRetryAt already past: retries 5 s after boot', async () => {
    const s = await setup({ meta: { storageState: 'LOCAL', retryCount: 0, nextRetryAt: 1 * MIN, localSince: 0 } });
    const r = await restart(s, 60 * MIN);
    r.rm.resumeAfterBoot();
    expect(r.clock.pending).toEqual([60 * MIN + BOOT_SETTLE_MS]);
    await r.clock.advance(BOOT_SETTLE_MS);
    await until(r, (m) => m.storageState === 'NORMAL');
    expect(r.registry.loads).toBe(1); // loaded from local state for the write-back
  });

  it('CHECK (crashed mid-check): treated as LOCAL with the same retryCount, at now + 5 s', async () => {
    const s = await setup({ meta: { storageState: 'CHECK', retryCount: 2, nextRetryAt: null, localSince: 0 } });
    const r = await restart(s, 30 * MIN);
    r.rm.resumeAfterBoot();
    expect(r.clock.pending).toEqual([30 * MIN + BOOT_SETTLE_MS]);
    r.storage.failNext('stat');
    await r.clock.advance(BOOT_SETTLE_MS);
    await until(r, (m) => m.storageState === 'PENDING'); // the third failed attempt
    expect(r.m().retryCount).toBe(3);
  });

  it('PENDING and CONFLICT: no automatic action; the storage event is re-emitted once', async () => {
    const s = await setup({ meta: { storageState: 'PENDING', retryCount: 3 } });
    await s.meta.put(makeMeta('doc-2', { storageState: 'CONFLICT', conflict: { detectedAt: 0, storageVersion: 'x' } }));
    const r = await restart(s, 10 * MIN);
    r.rm.resumeAfterBoot();
    await settle();
    expect(r.clock.pending).toEqual([]);
    expect(r.rec.storage().map((e) => [e['documentId'], e['state']]).sort()).toEqual([
      ['doc-1', 'pending'],
      ['doc-2', 'conflict'],
    ]);
    expect(r.rec.errors()).toEqual([]);
    await r.clock.advance(60 * MIN);
    expect(r.storage.calls).toHaveLength(0);
  });

  it('NORMAL with a journal newer than lastFlushedRev: loads from local state and marks it dirty', async () => {
    const s = await setup({ meta: { lastFlushedRev: 1 } });
    await s.meta.put(makeMeta('doc-2', { lastFlushedRev: 4 }));
    const j1 = await Journal.open(journalDir(s.dataDir, docKeyOf(s.id)), { fsync: 'always' });
    await j1.append({ f: 1, r: 2, c: 'c', q: 1, u: 'u', t: 0, x: false, o: [{}] });
    await j1.close();
    const j2 = await Journal.open(journalDir(s.dataDir, docKeyOf(asDocumentId('doc-2'))), { fsync: 'always' });
    await j2.append({ f: 3, r: 4, c: 'c', q: 1, u: 'u', t: 0, x: false, o: [{}] });
    await j2.close();
    const r = await restart(s, 0);
    r.rm.resumeAfterBoot();
    await vi.waitFor(() => expect(r.flush.markDirty).toHaveBeenCalledTimes(1));
    expect(r.flush.markDirty).toHaveBeenCalledWith(r.target);
    expect(r.registry.loads).toBe(1); // doc-2 is clean: not loaded
    expect(r.clock.pending).toEqual([]);
  });

  it('close() stops the retry timers', async () => {
    const s = await setup();
    await s.rm.onWriteFailed(s.target, writeError());
    expect(s.clock.pending).toEqual([1 * MIN]);
    s.rm.close();
    expect(s.clock.pending).toEqual([]);
  });
});
