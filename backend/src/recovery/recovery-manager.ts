/**
 * `RecoveryManager` (LLD Part 2 §13, HLD §10.4 and §11.3 [§4][§5][A4]): the storage state
 * machine NORMAL → LOCAL → CHECK → NORMAL | CONFLICT | PENDING, with retries after
 * `recovery.retryDelaysMs` (default 1, 5 and 15 minutes).
 *
 * | From | Trigger | To |
 * |---|---|---|
 * | NORMAL | a flush write throws ({@link RecoveryManager.onWriteFailed}) | LOCAL, retry after `d[0]` |
 * | NORMAL | a flush write conflicts ({@link RecoveryManager.onConflict}, §0 L-11) | CONFLICT |
 * | LOCAL | the timer fires, or `retry()` | CHECK |
 * | CHECK | `stat` or the write-back throws, attempt 1–2 (§0 L-11) | LOCAL, retry after `d[retryCount]` |
 * | CHECK | `stat` or the write-back throws, attempt 3 | PENDING |
 * | CHECK | storage unchanged: export, write back | NORMAL |
 * | CHECK | storage deleted or changed, or the write-back conflicts | CONFLICT |
 * | PENDING | `retry()`: one CHECK; still unreachable → PENDING, `retryCount` unchanged | NORMAL / CONFLICT / PENDING |
 * | CONFLICT, PENDING | `resolve(…)` | NORMAL |
 *
 * Each transition writes meta first, then sends the `notice` to the document's sessions, then
 * emits the `storage` event (and the `error` event where §13 names one).
 *
 * **Invariants:** editing continues in every state; local snapshots and journal compaction carry
 * on; the local snapshot plus journal is the durable local copy; local state is deleted only by
 * `resolve('discard-local')`.
 *
 * **Concurrency:** state changes of one document run one at a time (a per-document chain). At
 * most one CHECK runs per document, and a `retry()` during a CHECK awaits it.
 *
 * **V1-16 choices (the LLD does not say; flagged for review):**
 * - `resolve('mark-resolved')` (§0 L-8): the adopter has handled the local copy, so the engine
 *   takes the current storage version as known and the current local rev as flushed, then
 *   returns to NORMAL. It neither writes storage nor deletes local state.
 * - `resolve()` in LOCAL or CHECK is a no-op that returns the entry, as in NORMAL: automatic
 *   retries are still running.
 * - A failed `overwrite-storage` or `mark-resolved` (storage unreachable, or a write conflict
 *   that races the `stat`) rejects and leaves the state unchanged.
 * - `close()` stops the retry timers at shutdown; `RecoverySeam` has no such method yet.
 *
 * @module
 */
import { OpenDocexError, type ErrorCode } from '@open-docex/shared/errors';
import type { DocumentId } from '@open-docex/shared/ids';
import { encodeMessage, type FileFormat } from '@open-docex/shared/protocol';
import type { StorageEvent } from '../api/events.js';
import { toWire } from '../channel/wire-error.js';
import type { Clock, CoreSink, FlushSeam, FlushTarget, RecoverySeam } from '../core/seams.js';
import { engineError } from '../errors/engine-error.js';
import { callStorage, exportSnapshot, type CodecExport, type StorageRoute } from '../flush/storage-io.js';
import { noopLogger, type Logger } from '../log/logger.js';
import { docKeyOf } from '../persistence/layout.js';
import type { DocumentMeta, MetaStore, StorageState } from '../persistence/meta-store.js';
import type { StorageRef, StorageStat, StorageVersion, StorageWriteResult } from '../storage/storage-adapter.js';
import { readLocalRev } from './local-rev.js';

/** Settle time before the first retry after a restart (§13, LLD choice): 5 s. */
export const BOOT_SETTLE_MS = 5_000;
/** Failed attempts before PENDING (the BRD fixes three retries [§4]). */
export const MAX_RETRIES = 3;

/** How the adopter resolves a CONFLICT or PENDING document (§0 L-8). */
export type RecoveryResolution = 'overwrite-storage' | 'discard-local' | 'mark-resolved';

/** One document's recovery state, as `recovery.list()` returns it (LLD Part 2 §2). */
export interface RecoveryEntry {
  documentId: DocumentId;
  state: StorageState;
  retryCount: number;
  nextRetryAt: number | null;
  localSince: number | null;
  /** The latest local rev known: the loaded instance's, else the boot journal tail or meta. */
  localRev: number;
  lastFlushedRev: number;
  lastError?: { code: ErrorCode; message: string };
}

/** The local model exported to file bytes (`recovery.readLocalCopy`). */
export interface LocalCopy {
  bytes: Uint8Array;
  format: FileFormat;
  rev: number;
}

/** What recovery needs from a loaded instance. `DocumentInstance` implements it. */
export interface RecoveryTarget extends FlushTarget {
  readonly sessions: ReadonlyMap<string, unknown>;
  /** The `discard-local` reload (§13, S-36). */
  reloadFromStorage(): Promise<void>;
}

/** What recovery needs from the registry. `DocumentRegistry` implements it. */
export interface RecoveryRegistry {
  get(id: DocumentId): RecoveryTarget | undefined;
  getOrLoad(id: DocumentId, doc: { ref: StorageRef; format: FileFormat }): Promise<RecoveryTarget>;
}

/**
 * Dependencies of {@link RecoveryManager}. §13 lists `meta`, `registry`, `codec`, `router`,
 * `emit`, `clock` and `delays`. Added: `sink` (the notices to sessions), `flush` (§13's
 * `flush.markDirty` after a restart and after a write-back), `dataDir` (asset folder and journal
 * tail) and `logger`.
 */
export interface RecoveryManagerDeps {
  meta: MetaStore;
  registry: RecoveryRegistry;
  codec: CodecExport;
  router: StorageRoute;
  sink: Pick<CoreSink, 'send'>;
  /** `CoreServiceContext.emit`. Errors inside payloads are sent as `WireError`s. */
  emit(event: 'error' | 'storage', payload: unknown): void;
  flush: Pick<FlushSeam, 'markDirty'>;
  clock: Clock;
  /** `recovery.retryDelaysMs`. */
  delays: readonly [number, number, number];
  dataDir: string;
  logger?: Logger;
}

type CheckOrigin = 'local' | 'pending';
type NoticeState = 'normal' | 'local' | 'pending';

/** The storage recovery state machine of one Core. */
export class RecoveryManager implements RecoverySeam {
  readonly #d: RecoveryManagerDeps;
  readonly #logger: Logger;
  readonly #timers = new Map<DocumentId, unknown>();
  readonly #checks = new Map<DocumentId, Promise<void>>();
  readonly #chains = new Map<DocumentId, Promise<unknown>>();
  /** `localRev` read from the journal tail at boot. */
  readonly #bootLocalRev = new Map<DocumentId, number>();
  #closed = false;

  constructor(d: RecoveryManagerDeps) {
    this.#d = d;
    this.#logger = d.logger ?? noopLogger;
  }

  // --- from the flush scheduler ------------------------------------------------------------

  /** NORMAL → LOCAL: the flush write threw. Arms the first retry at `now + d[0]`. */
  onWriteFailed(inst: FlushTarget, err: OpenDocexError): Promise<void> {
    return this.#serial(inst.documentId, async () => {
      const m = this.#d.meta.get(inst.docKey);
      if (m?.storageState !== 'NORMAL') return; // the scheduler writes only in NORMAL
      const now = this.#d.clock.now();
      m.storageState = 'LOCAL';
      m.retryCount = 0;
      m.localSince = now;
      m.nextRetryAt = now + this.#d.delays[0];
      m.lastError = { code: err.code, message: err.message, at: now };
      this.#touch(m, inst.currentSnapshot().rev);
      await this.#d.meta.put(m);
      this.#arm(m.documentId, m.nextRetryAt);
      this.#notify(m.documentId, 'local');
      const e = engineError('STORAGE_LOCAL_MODE', { documentId: m.documentId, cause: err });
      this.#emitStorage(m, 'local', e);
      this.#emitError(e);
    });
  }

  /** NORMAL → CONFLICT: the flush found the storage file changed (§0 L-11). */
  onConflict(inst: FlushTarget, v?: StorageVersion): Promise<void> {
    return this.#serial(inst.documentId, async () => {
      const m = this.#d.meta.get(inst.docKey);
      if (m?.storageState !== 'NORMAL') return;
      await this.#toConflict(m, v ?? null, inst.currentSnapshot().rev);
    });
  }

  // --- adopter actions ---------------------------------------------------------------------

  /** Every document whose state is not NORMAL. */
  list(): RecoveryEntry[] {
    return this.#d.meta
      .list()
      .filter((m) => m.storageState !== 'NORMAL')
      .map((m) => this.#entryOf(m));
  }

  /**
   * NORMAL: no-op. LOCAL (or a CHECK left by a crash): one CHECK now. PENDING: one CHECK; if
   * storage is still unreachable it stays PENDING with `retryCount` unchanged. During a CHECK:
   * awaits it.
   *
   * @throws {OpenDocexError} `DOCUMENT_NOT_FOUND` for an unknown id; `STORAGE_CONFLICT` in
   *   CONFLICT, where a decision is needed.
   */
  async retry(id: DocumentId): Promise<RecoveryEntry> {
    const m = this.#metaOf(id);
    const running = this.#checks.get(id);
    if (running !== undefined) {
      await running;
      return this.#entryOf(this.#metaOf(id));
    }
    switch (m.storageState) {
      case 'NORMAL':
        return this.#entryOf(m);
      case 'CONFLICT':
        throw engineError('STORAGE_CONFLICT', { documentId: id, message: 'The storage file changed: resolve the conflict.' });
      case 'PENDING':
        await this.#startCheck(id, 'pending');
        break;
      case 'LOCAL':
      case 'CHECK':
        this.#disarm(id);
        await this.#startCheck(id, 'local');
        break;
    }
    return this.#entryOf(this.#metaOf(id));
  }

  /**
   * Exports the local model (loading the instance from local state when needed).
   *
   * @throws {OpenDocexError} `DOCUMENT_NOT_FOUND` for an unknown id; the codec's error.
   */
  async readLocalCopy(id: DocumentId): Promise<LocalCopy> {
    const m = this.#metaOf(id);
    const inst = await this.#d.registry.getOrLoad(id, { ref: m.ref, format: m.format });
    const { rev, model } = inst.currentSnapshot();
    const bytes = await exportSnapshot(this.#d.codec, this.#d.dataDir, inst, model);
    return { bytes, format: inst.format, rev };
  }

  /**
   * Resolves a CONFLICT or PENDING document (§13, §0 L-8). In other states it is a no-op that
   * returns the entry.
   * - `'overwrite-storage'`: export the local model; `write(expectedVersion = stat().version)`.
   * - `'discard-local'`: `instance.reloadFromStorage()`: a fresh import, then `resync` and a
   *   full load for the sessions. The old snapshot and journal go only after the new snapshot
   *   is durable.
   * - `'mark-resolved'`: see the module notes.
   *
   * @throws {OpenDocexError} `DOCUMENT_NOT_FOUND`; `CONFIG_INVALID` for an unknown resolution;
   *   the storage, codec or load error, with the state unchanged.
   */
  async resolve(id: DocumentId, r: RecoveryResolution): Promise<RecoveryEntry> {
    if (r !== 'overwrite-storage' && r !== 'discard-local' && r !== 'mark-resolved') {
      throw engineError('CONFIG_INVALID', { message: 'resolution: must be overwrite-storage, discard-local or mark-resolved' });
    }
    this.#metaOf(id);
    return this.#serial(id, async () => {
      const m = this.#metaOf(id);
      if (m.storageState !== 'CONFLICT' && m.storageState !== 'PENDING') return this.#entryOf(m);
      const inst = await this.#d.registry.getOrLoad(id, { ref: m.ref, format: m.format });
      if (r === 'discard-local') {
        await inst.reloadFromStorage(); // writes the fresh NORMAL meta
        this.#disarm(id);
        this.#notify(id, 'normal');
        this.#emitStorage(this.#metaOf(id), 'recovered');
      } else if (r === 'overwrite-storage') {
        const { rev: f, model } = inst.currentSnapshot();
        const bytes = await exportSnapshot(this.#d.codec, this.#d.dataDir, inst, model);
        const st = await this.#stat(m);
        const res = await this.#write(m, bytes, st?.version ?? null);
        if (!res.ok) throw engineError('STORAGE_CONFLICT', { documentId: id, message: 'The storage file changed during the overwrite.' });
        await this.#toNormal(id, res.version, f, inst);
      } else {
        const st = await this.#stat(m);
        await this.#toNormal(id, st?.version ?? null, inst.currentSnapshot().rev, inst);
      }
      return this.#entryOf(this.#metaOf(id));
    });
  }

  // --- boot and shutdown -------------------------------------------------------------------

  /**
   * Boot step 8 (§13). Schedules work only; never waits for storage.
   * - LOCAL: retry at `max(nextRetryAt, now + 5 s)`.
   * - CHECK (crashed mid-check): LOCAL with the same `retryCount`, retry at `now + 5 s`.
   * - PENDING, CONFLICT: re-emit the `storage` event once.
   * - NORMAL with `localRev > lastFlushedRev`: load from local state, then `flush.markDirty`.
   */
  resumeAfterBoot(): void {
    const now = this.#d.clock.now();
    for (const m of this.#d.meta.list()) {
      const id = m.documentId;
      switch (m.storageState) {
        case 'LOCAL':
          this.#arm(id, Math.max(m.nextRetryAt ?? now, now + BOOT_SETTLE_MS));
          break;
        case 'CHECK':
          this.#arm(id, now + BOOT_SETTLE_MS);
          break;
        case 'PENDING':
          this.#emitStorage(m, 'pending', engineError('STORAGE_PENDING', { documentId: id }));
          break;
        case 'CONFLICT':
          this.#emitStorage(m, 'conflict', engineError('STORAGE_CONFLICT', { documentId: id }));
          break;
        case 'NORMAL':
          break;
      }
      this.#scanTail(m).catch((err: unknown) => this.#logFailure(id, 'Recovery boot scan failed.', err));
    }
  }

  /** Stops every retry timer (shutdown). Later transitions arm none. */
  close(): void {
    this.#closed = true;
    for (const id of [...this.#timers.keys()]) this.#disarm(id);
  }

  // --- the CHECK ---------------------------------------------------------------------------

  #startCheck(id: DocumentId, origin: CheckOrigin): Promise<void> {
    const running = this.#checks.get(id);
    if (running !== undefined) return running;
    const p = this.#serial(id, () => this.#check(id, origin));
    this.#checks.set(id, p);
    const done = (): void => {
      if (this.#checks.get(id) === p) this.#checks.delete(id);
    };
    p.then(done, done);
    return p;
  }

  async #check(id: DocumentId, origin: CheckOrigin): Promise<void> {
    const m = this.#d.meta.get(docKeyOf(id));
    if (m === undefined) return;
    const expected: StorageState[] = origin === 'pending' ? ['PENDING'] : ['LOCAL', 'CHECK'];
    if (!expected.includes(m.storageState)) return; // resolved or moved on meanwhile
    m.storageState = 'CHECK';
    m.nextRetryAt = null;
    m.updatedAt = this.#d.clock.now();
    await this.#d.meta.put(m);
    let st: StorageStat | null;
    try {
      st = await this.#stat(m);
    } catch (err) {
      return this.#failedAttempt(id, origin, err);
    }
    if (st === null || st.version !== m.lastKnownVersion) return this.#toConflict(m, st?.version ?? null);
    // Storage unchanged: write the local model back. Any throw counts as a failed attempt (L-11).
    let inst: RecoveryTarget;
    let f: number;
    let res: StorageWriteResult;
    try {
      inst = await this.#d.registry.getOrLoad(id, { ref: m.ref, format: m.format });
      const snap = inst.currentSnapshot();
      f = snap.rev;
      const bytes = await exportSnapshot(this.#d.codec, this.#d.dataDir, inst, snap.model);
      res = await this.#write(m, bytes, m.lastKnownVersion);
    } catch (err) {
      return this.#failedAttempt(id, origin, err);
    }
    if (!res.ok) return this.#toConflict(m, res.currentVersion ?? null, f);
    await this.#toNormal(id, res.version, f, inst);
  }

  /** A failed CHECK attempt: back to LOCAL with the next delay, or PENDING after the third. */
  async #failedAttempt(id: DocumentId, origin: CheckOrigin, cause: unknown): Promise<void> {
    const m = this.#metaOf(id);
    const now = this.#d.clock.now();
    const err = OpenDocexError.is(cause) ? cause : engineError('STORAGE_WRITE_FAILED', { documentId: id, cause });
    m.lastError = { code: err.code, message: err.message, at: now };
    m.updatedAt = now;
    if (origin === 'local') m.retryCount = Math.min(m.retryCount + 1, MAX_RETRIES);
    if (origin === 'local' && m.retryCount < MAX_RETRIES) {
      m.storageState = 'LOCAL';
      m.nextRetryAt = now + (this.#d.delays[m.retryCount] as number);
      await this.#d.meta.put(m);
      this.#arm(id, m.nextRetryAt);
      this.#logger.warn('Storage retry failed; staying local.', { documentId: id, attempt: m.retryCount, code: err.code });
      return;
    }
    m.storageState = 'PENDING';
    m.nextRetryAt = null;
    await this.#d.meta.put(m);
    this.#notify(id, 'pending');
    const e = engineError('STORAGE_PENDING', { documentId: id, cause: err });
    this.#emitStorage(m, 'pending', e);
    this.#emitError(e);
  }

  async #toConflict(m: DocumentMeta, storageVersion: StorageVersion | null, localRev?: number): Promise<void> {
    const now = this.#d.clock.now();
    m.storageState = 'CONFLICT';
    m.conflict = { detectedAt: now, storageVersion };
    m.nextRetryAt = null;
    m.localSince ??= now;
    this.#touch(m, localRev);
    await this.#d.meta.put(m);
    this.#disarm(m.documentId);
    this.#notify(m.documentId, 'pending');
    const e = engineError('STORAGE_CONFLICT', { documentId: m.documentId });
    this.#emitStorage(m, 'conflict', e);
    this.#emitError(e);
  }

  /** → NORMAL at storage `version`, with `f` flushed. Marks the instance dirty if it moved on. */
  async #toNormal(id: DocumentId, version: StorageVersion | null, f: number, inst: RecoveryTarget): Promise<void> {
    const m = this.#metaOf(id);
    m.storageState = 'NORMAL';
    m.lastKnownVersion = version;
    m.lastFlushedRev = f;
    m.retryCount = 0;
    m.nextRetryAt = null;
    m.localSince = null;
    delete m.conflict;
    delete m.lastError;
    this.#touch(m, f);
    await this.#d.meta.put(m);
    this.#disarm(id);
    this.#notify(id, 'normal');
    this.#emitStorage(m, 'recovered');
    if (inst.currentSnapshot().rev > f) this.#d.flush.markDirty(inst);
  }

  // --- helpers -----------------------------------------------------------------------------

  /** `stat` through the router with the 60 s abort. Throws `STORAGE_READ_FAILED`. */
  #stat(m: DocumentMeta): Promise<StorageStat | null> {
    return callStorage(this.#d.clock, 'STORAGE_READ_FAILED', m.documentId, (signal) => this.#d.router.route(m.ref).stat(m.ref, { signal }));
  }

  /** `write` through the router with the 60 s abort. Throws `STORAGE_WRITE_FAILED`. */
  #write(m: DocumentMeta, bytes: Uint8Array, expectedVersion: StorageVersion | null): Promise<StorageWriteResult> {
    return callStorage(this.#d.clock, 'STORAGE_WRITE_FAILED', m.documentId, (signal) =>
      this.#d.router.route(m.ref).write(m.ref, bytes, { expectedVersion, signal }),
    );
  }

  #metaOf(id: DocumentId): DocumentMeta {
    const m = this.#d.meta.get(docKeyOf(id));
    if (m === undefined) throw engineError('DOCUMENT_NOT_FOUND', { documentId: id });
    return m;
  }

  #entryOf(m: DocumentMeta): RecoveryEntry {
    const loaded = this.#d.registry.get(m.documentId)?.currentSnapshot().rev ?? 0;
    const e: RecoveryEntry = {
      documentId: m.documentId,
      state: m.storageState,
      retryCount: m.retryCount,
      nextRetryAt: m.nextRetryAt,
      localSince: m.localSince,
      localRev: Math.max(m.rev, loaded, this.#bootLocalRev.get(m.documentId) ?? 0),
      lastFlushedRev: m.lastFlushedRev,
    };
    if (m.lastError !== undefined) e.lastError = { code: m.lastError.code, message: m.lastError.message };
    return e;
  }

  /** Records the latest known local rev and the update time in `m`. */
  #touch(m: DocumentMeta, localRev?: number): void {
    const loaded = this.#d.registry.get(m.documentId)?.currentSnapshot().rev;
    m.rev = Math.max(m.rev, localRev ?? 0, loaded ?? 0);
    m.updatedAt = this.#d.clock.now();
  }

  async #scanTail(m: DocumentMeta): Promise<void> {
    const rev = await readLocalRev(this.#d.dataDir, docKeyOf(m.documentId));
    if (rev === null) return;
    this.#bootLocalRev.set(m.documentId, rev);
    if (m.storageState !== 'NORMAL' || rev <= m.lastFlushedRev || this.#closed) return;
    const inst = await this.#d.registry.getOrLoad(m.documentId, { ref: m.ref, format: m.format });
    this.#d.flush.markDirty(inst);
  }

  /** Runs `fn` after every earlier state change of `id` has settled. */
  #serial<T>(id: DocumentId, fn: () => Promise<T>): Promise<T> {
    const prev = this.#chains.get(id) ?? Promise.resolve();
    const next = prev.then(fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.#chains.set(id, settled);
    void settled.then(() => {
      if (this.#chains.get(id) === settled) this.#chains.delete(id);
    });
    return next;
  }

  #arm(id: DocumentId, at: number): void {
    if (this.#closed) return;
    this.#disarm(id);
    const clock = this.#d.clock;
    const handle = clock.setTimeout(
      () => {
        if (this.#timers.get(id) !== handle) return;
        this.#timers.delete(id);
        this.#startCheck(id, 'local').catch((err: unknown) => this.#logFailure(id, 'Storage retry failed.', err));
      },
      Math.max(0, at - clock.now()),
    );
    this.#timers.set(id, handle);
  }

  #disarm(id: DocumentId): void {
    if (!this.#timers.has(id)) return;
    this.#d.clock.clearTimeout(this.#timers.get(id));
    this.#timers.delete(id);
  }

  /** Sends `notice { notice: 'storage', state }` to every session of the loaded instance. */
  #notify(id: DocumentId, state: NoticeState): void {
    const ids = [...(this.#d.registry.get(id)?.sessions.keys() ?? [])];
    if (ids.length === 0) return;
    const data = encodeMessage({ type: 'notice', notice: 'storage', state });
    this.#d.sink.send([{ sessionIds: ids, data, binary: typeof data !== 'string' }]);
  }

  #emitStorage(m: DocumentMeta, state: StorageEvent['state'], error?: OpenDocexError): void {
    const ev = { documentId: m.documentId, state, at: this.#d.clock.now(), retryCount: m.retryCount, nextRetryAt: m.nextRetryAt };
    this.#d.emit(
      'storage',
      error === undefined ? ev : { ...ev, error: toWire(error, { where: 'document', documentId: m.documentId }) },
    );
  }

  #emitError(err: OpenDocexError): void {
    this.#d.emit('error', toWire(err, { where: 'document', documentId: err.documentId ?? '' }));
  }

  #logFailure(id: DocumentId, msg: string, err: unknown): void {
    this.#logger.error(msg, { documentId: id, code: OpenDocexError.is(err) ? err.code : 'UNKNOWN' });
  }
}
