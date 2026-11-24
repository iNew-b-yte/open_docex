/**
 * `FlushScheduler` (LLD Part 2 §12, HLD §10.3 [A5]): writes dirty documents back to storage
 * after a quiet period, and at least every `maxIntervalMs` while edits continue.
 *
 * **Scheduling.** `markDirty` sets `lastOpAt = now` and, if unset, `dirtySince = now`. One timer
 * per dirty document fires at `min(lastOpAt + quietMs, dirtySince + maxIntervalMs)`. A timer
 * that fires early re-arms itself, so constant typing causes no timer churn.
 *
 * **One flush** (§12):
 * 1. Outside `NORMAL` it returns `'skipped'`: `RecoveryManager` owns writes there.
 * 2. `F = currentSnapshot().rev`; when `F == meta.lastFlushedRev` the document is `'clean'`.
 * 3. Export the snapshot at `F`. The instance keeps processing ops meanwhile, because the
 *    snapshot is immutable (N11). An export failure emits `error`, stays dirty and retries at
 *    `now + quietMs`.
 * 4. `write(ref, bytes, { expectedVersion: meta.lastKnownVersion })`. A throw goes to
 *    `recovery.onWriteFailed` (→ LOCAL); a conflict goes to `recovery.onConflict` (→ CONFLICT,
 *    §0 L-11).
 * 5. On success `meta.lastKnownVersion`, `lastFlushedRev` and `rev` move to the new version
 *    and `F`, then the instance compacts. The document stays dirty if ops arrived during the
 *    flush.
 *
 * Flushes of one document never overlap. A timer that fires during a flush sets `again`;
 * `flushNow` waits for the running flush and then flushes again.
 *
 * After a successful flush the scheduler calls `inst.compactAfterFlush(F)` (§12, S-38):
 * snapshot and rotate when ops arrived since the last snapshot, then trim the journal.
 *
 * **Wiring (V1-19).** The recovery manager is built after the scheduler (it needs the
 * registry), so `recovery` is usually a forwarding object filled in once both exist.
 *
 * @module
 */
import { OpenDocexError } from '@open-docex/shared/errors';
import type { DocumentId } from '@open-docex/shared/ids';
import { toWire } from '../channel/wire-error.js';
import type { Clock, FlushSeam, FlushTarget } from '../core/seams.js';
import { engineError } from '../errors/engine-error.js';
import { noopLogger, type Logger } from '../log/logger.js';
import type { MetaStore } from '../persistence/meta-store.js';
import type { StorageVersion, StorageWriteResult } from '../storage/storage-adapter.js';
import { callStorage, exportSnapshot, type CodecExport, type StorageRoute } from './storage-io.js';

/** The result of one flush (§12). */
export type FlushResult = 'clean' | 'flushed' | 'skipped' | 'failed';

/** What the scheduler calls on `RecoveryManager` when a flush cannot write (§13). */
export interface FlushRecovery {
  /** NORMAL → LOCAL. */
  onWriteFailed(inst: FlushTarget, err: OpenDocexError): Promise<void>;
  /** NORMAL → CONFLICT (§0 L-11). */
  onConflict(inst: FlushTarget, v?: StorageVersion): Promise<void>;
}

/** Dependencies of {@link FlushScheduler} (§12; `dataDir`, `emit` and `logger` added). */
export interface FlushSchedulerDeps {
  codec: CodecExport;
  router: StorageRoute;
  meta: MetaStore;
  recovery: FlushRecovery;
  clock: Clock;
  /** `flush.quietMs`. */
  quietMs: number;
  /** `flush.maxIntervalMs`. */
  maxIntervalMs: number;
  /** Locates each document's asset folder for the export. */
  dataDir: string;
  /** `CoreServiceContext.emit`: export failures are emitted as `error`. */
  emit(event: 'error', payload: unknown): void;
  logger?: Logger;
}

/** Per-document state (§12). */
interface Entry {
  inst: FlushTarget;
  dirtySince: number | null;
  lastOpAt: number;
  timer: { handle: unknown } | null;
  running: Promise<FlushResult> | null;
  again: boolean;
}

/** How a write attempt ended, before the scheduler re-arms. */
type WriteOutcome = 'flushed' | 'export-failed' | 'handed-to-recovery';

/** The flush scheduler of one Core. */
export class FlushScheduler implements FlushSeam {
  readonly #d: FlushSchedulerDeps;
  readonly #logger: Logger;
  readonly #entries = new Map<DocumentId, Entry>();
  #closed = false;

  constructor(d: FlushSchedulerDeps) {
    this.#d = d;
    this.#logger = d.logger ?? noopLogger;
  }

  /** Records an applied op (§8.4 step 7) and arms the document's timer if it has none. */
  markDirty(inst: FlushTarget): void {
    const now = this.#d.clock.now();
    const e = this.#entry(inst);
    e.lastOpAt = now;
    e.dirtySince ??= now;
    if (e.timer === null && e.running === null) this.#arm(e, this.#due(e));
  }

  /**
   * Flushes now: waits for a running flush of the same document, then runs one more.
   * With `timeoutMs`, gives up waiting after that long and returns `'failed'`; the flush
   * itself carries on in the background (its storage call has its own 60 s abort).
   */
  async flushNow(inst: FlushTarget, o: { timeoutMs?: number } = {}): Promise<FlushResult> {
    const run = this.#flushWhenIdle(inst);
    if (o.timeoutMs === undefined) return run;
    const clock = this.#d.clock;
    let timer: unknown;
    const timeout = new Promise<FlushResult>((resolve) => {
      timer = clock.setTimeout(() => resolve('failed'), o.timeoutMs as number);
    });
    try {
      return await Promise.race([run, timeout]);
    } finally {
      clock.clearTimeout(timer);
    }
  }

  /**
   * Shutdown, best effort: stops every timer, then flushes each dirty document until
   * `deadline` (epoch ms). No timer is armed afterwards.
   */
  async flushAll(deadline: number): Promise<void> {
    this.#closed = true;
    const timeoutMs = Math.max(0, deadline - this.#d.clock.now());
    const runs: Array<Promise<unknown>> = [];
    for (const e of [...this.#entries.values()]) {
      this.#disarm(e);
      if (e.dirtySince !== null || e.running !== null) {
        runs.push(this.flushNow(e.inst, { timeoutMs }).catch((err: unknown) => this.#logFailure(e.inst, err)));
      }
    }
    await Promise.all(runs);
  }

  /** The tracked documents (tests and diagnostics). */
  get size(): number {
    return this.#entries.size;
  }

  #entry(inst: FlushTarget): Entry {
    let e = this.#entries.get(inst.documentId);
    if (e === undefined) {
      e = { inst, dirtySince: null, lastOpAt: this.#d.clock.now(), timer: null, running: null, again: false };
      this.#entries.set(inst.documentId, e);
    } else {
      e.inst = inst;
    }
    return e;
  }

  #due(e: Entry): number {
    return Math.min(e.lastOpAt + this.#d.quietMs, (e.dirtySince ?? e.lastOpAt) + this.#d.maxIntervalMs);
  }

  #arm(e: Entry, at: number): void {
    if (this.#closed) return;
    this.#disarm(e);
    const clock = this.#d.clock;
    const timer = { handle: undefined as unknown };
    timer.handle = clock.setTimeout(() => this.#onTimer(e, timer), Math.max(0, at - clock.now()));
    e.timer = timer;
  }

  #disarm(e: Entry): void {
    if (e.timer === null) return;
    this.#d.clock.clearTimeout(e.timer.handle);
    e.timer = null;
  }

  #onTimer(e: Entry, timer: { handle: unknown }): void {
    if (e.timer !== timer) return;
    e.timer = null;
    if (e.dirtySince === null) {
      this.#forgetIfIdle(e);
      return;
    }
    if (e.running !== null) {
      e.again = true;
      return;
    }
    const due = this.#due(e);
    if (this.#d.clock.now() < due) {
      this.#arm(e, due);
      return;
    }
    this.#flush(e).catch((err: unknown) => this.#logFailure(e.inst, err));
  }

  async #flushWhenIdle(inst: FlushTarget): Promise<FlushResult> {
    for (;;) {
      const e = this.#entry(inst);
      if (e.running === null) return this.#flush(e);
      await e.running.catch(() => undefined);
    }
  }

  /** One flush (§12). Synchronous up to the export, so two callers never both start. */
  #flush(e: Entry): Promise<FlushResult> {
    const inst = e.inst;
    const meta = this.#d.meta.get(inst.docKey);
    if (meta === undefined || meta.storageState !== 'NORMAL') {
      // RecoveryManager owns writes outside NORMAL. Stay dirty without a timer: the next op
      // (or the recovery manager's markDirty) arms one; restarting dirtySince avoids churn.
      if (e.dirtySince !== null) e.dirtySince = this.#d.clock.now();
      this.#disarm(e);
      return Promise.resolve('skipped');
    }
    const { rev: f, model } = inst.currentSnapshot();
    if (f === meta.lastFlushedRev) {
      e.dirtySince = null;
      this.#disarm(e);
      this.#forgetIfIdle(e);
      return Promise.resolve('clean');
    }
    e.again = false;
    const run = (async (): Promise<FlushResult> => {
      let outcome: WriteOutcome | 'error' = 'error';
      try {
        outcome = await this.#write(e, inst, f, model, meta.lastKnownVersion);
        return outcome === 'flushed' ? 'flushed' : 'failed';
      } finally {
        e.running = null;
        this.#afterRun(e, outcome);
      }
    })();
    e.running = run;
    return run;
  }

  async #write(e: Entry, inst: FlushTarget, f: number, model: unknown, expected: StorageVersion | null): Promise<WriteOutcome> {
    const d = this.#d;
    let bytes: Uint8Array;
    try {
      bytes = await exportSnapshot(d.codec, d.dataDir, inst, model);
    } catch (err) {
      const error =
        err instanceof OpenDocexError && err.documentId === inst.documentId
          ? err
          : engineError(err instanceof OpenDocexError ? err.code : 'CONVERSION_FAILED', { documentId: inst.documentId, cause: err });
      this.#logger.warn('Flush export failed; retrying after the quiet period.', { documentId: inst.documentId, code: error.code });
      d.emit('error', toWire(error, { where: 'document', documentId: inst.documentId }));
      return 'export-failed';
    }
    let res: StorageWriteResult;
    try {
      res = await callStorage(d.clock, 'STORAGE_WRITE_FAILED', inst.documentId, (signal) =>
        d.router.route(inst.ref).write(inst.ref, bytes, { expectedVersion: expected, signal }),
      );
    } catch (err) {
      const error = engineError('STORAGE_WRITE_FAILED', { documentId: inst.documentId, cause: err });
      await d.recovery.onWriteFailed(inst, error).catch((x: unknown) => this.#logFailure(inst, x));
      return 'handed-to-recovery';
    }
    if (!res.ok) {
      await d.recovery.onConflict(inst, res.currentVersion).catch((x: unknown) => this.#logFailure(inst, x));
      return 'handed-to-recovery';
    }
    const meta = d.meta.get(inst.docKey);
    if (meta === undefined) throw engineError('DOCUMENT_FAULTED', { documentId: inst.documentId, message: 'Document meta is missing.' });
    meta.lastKnownVersion = res.version;
    meta.lastFlushedRev = f;
    meta.rev = Math.max(meta.rev, f);
    meta.updatedAt = d.clock.now();
    await d.meta.put(meta);
    await inst.compactAfterFlush(f); // only after success (§12); never rejects
    e.dirtySince = e.inst.currentSnapshot().rev > f ? d.clock.now() : null;
    return 'flushed';
  }

  /** Re-arms after a flush that wrote or tried to write. */
  #afterRun(e: Entry, outcome: WriteOutcome | 'error'): void {
    const now = this.#d.clock.now();
    switch (outcome) {
      case 'flushed':
        if (e.dirtySince !== null || e.again) this.#arm(e, this.#due(e));
        else this.#forgetIfIdle(e);
        return;
      case 'export-failed':
      case 'error':
        // Stay dirty and retry after the quiet period (§12).
        e.dirtySince ??= now;
        this.#arm(e, now + this.#d.quietMs);
        return;
      case 'handed-to-recovery':
        // Now LOCAL or CONFLICT: stay dirty without a timer, as for 'skipped'.
        e.dirtySince = now;
        this.#disarm(e);
        return;
    }
  }

  /** Drops a clean, idle entry so closed instances are not kept alive. */
  #forgetIfIdle(e: Entry): void {
    if (e.dirtySince === null && e.running === null && e.timer === null && this.#entries.get(e.inst.documentId) === e) {
      this.#entries.delete(e.inst.documentId);
    }
  }

  #logFailure(inst: FlushTarget, err: unknown): void {
    this.#logger.error('Flush failed.', { documentId: inst.documentId, code: err instanceof OpenDocexError ? err.code : 'UNKNOWN' });
  }
}
