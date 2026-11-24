/**
 * `AuditEmitter`: the Core's {@link AuditSink}, delivering audit events at least once
 * (LLD Part 2 §15, §0 PO-17, R-19, S-36).
 *
 * - **Live events:** `emit(e)` hands the event to the main process (a `CoreEvent` `emit` with
 *   event `audit`), then advances the document's `meta.auditEmittedRev` to `e.rev`. The rev
 *   advances only after the hand-off, never before, so a crash in between re-emits the entry
 *   (as `replayed: true`) rather than losing it. Advances are coalesced and written in the
 *   background, in order per document; `auditEmittedRev` never moves backwards.
 * - **Boot replay (R-19):** {@link AuditEmitter.replayPending} / {@link AuditEmitter.replayAll}
 *   re-emit journal entries with `rev > auditEmittedRev`, flagged `replayed: true`, then advance
 *   `auditEmittedRev`. Entries at or below it are never re-emitted.
 * - **Disabled** (`audit.enable` false, the default): nothing is sent and `auditEmittedRev` does
 *   not move, because nothing was handed off. Replay is skipped while disabled.
 *
 * Adopters deduplicate by `(documentId, rev)`. Delivery is at least once: a crash after the
 * hand-off but before the meta write re-emits that event once more.
 *
 * @module
 */
import type { DocumentId } from '@open-docex/shared/ids';
import type { AuditEvent } from '../api/events.js';
import type { AuditSink } from '../core/seams.js';
import { noopLogger, type Logger } from '../log/logger.js';
import { Journal, type FsyncPolicy, type JournalEntry } from '../persistence/journal.js';
import { docKeyOf, journalDir } from '../persistence/layout.js';
import type { MetaStore } from '../persistence/meta-store.js';

/** Dependencies of {@link AuditEmitter}. */
export interface AuditEmitterOptions {
  dataDir: string;
  meta: MetaStore;
  /** Hands an event to the main process: `ctx.emit('audit', event)` from `CoreServiceContext`. */
  readonly emit: (event: 'audit', payload: AuditEvent) => void;
  logger?: Logger;
  /** Used only to open journals for replay. Default `'interval'`. */
  fsync?: FsyncPolicy;
  /** Initial state. Default false; `audit.enable` turns it on via {@link AuditEmitter.setEnabled}. */
  enabled?: boolean;
}

/** The audit emitter. Implements {@link AuditSink}. */
export class AuditEmitter implements AuditSink {
  readonly #dataDir: string;
  readonly #meta: MetaStore;
  readonly #send: (event: 'audit', payload: AuditEvent) => void;
  readonly #logger: Logger;
  readonly #fsync: FsyncPolicy;
  #enabled: boolean;
  /** Highest handed-off rev not yet written to meta, per document. */
  readonly #want = new Map<DocumentId, number>();
  /** Documents with a running advance loop. */
  readonly #running = new Map<DocumentId, Promise<void>>();

  constructor(o: AuditEmitterOptions) {
    this.#dataDir = o.dataDir;
    this.#meta = o.meta;
    this.#send = o.emit;
    this.#logger = o.logger ?? noopLogger;
    this.#fsync = o.fsync ?? 'interval';
    this.#enabled = o.enabled ?? false;
  }

  /** `audit.enable` (§6.2). While off, no event is sent and no rev advances. */
  setEnabled(on: boolean): void {
    this.#enabled = on;
  }

  /** True when audit events are being sent. */
  get enabled(): boolean {
    return this.#enabled;
  }

  /**
   * Hands `e` to the main process, then schedules the `auditEmittedRev` advance. Never throws:
   * a failed hand-off is logged and the rev stays put, so boot replay will re-emit it.
   */
  emit(e: AuditEvent): void {
    if (!this.#enabled) return;
    if (!this.#handOff(e)) return;
    void this.#advance(e.documentId, e.rev);
  }

  /**
   * Re-emits, as `replayed: true`, every journal entry of `documentId` with
   * `rev > auditEmittedRev`, in order, then advances `auditEmittedRev`. Returns the number
   * re-emitted. Returns 0 when audit is disabled or the document has no meta.
   *
   * Must run before the document accepts sessions (it reads the journal on its own and would
   * race with live emits). A corrupt journal rejects with `DOCUMENT_FAULTED`; `replayAll`
   * isolates that per document.
   */
  async replayPending(documentId: DocumentId): Promise<number> {
    if (!this.#enabled) return 0;
    const key = docKeyOf(documentId);
    const meta = this.#meta.get(key);
    if (meta === undefined) return 0;
    const from = meta.auditEmittedRev;
    const journal = await Journal.open(journalDir(this.#dataDir, key), { fsync: this.#fsync, logger: this.#logger });
    let count = 0;
    let last = from;
    try {
      for await (const entry of journal.read()) {
        if (entry.r <= from) continue;
        if (!this.#handOff(toEvent(documentId, meta.kind, entry))) break;
        last = entry.r;
        count++;
      }
    } finally {
      await journal.close();
    }
    if (last > from) await this.#advance(documentId, last);
    return count;
  }

  /**
   * Boot replay (R-19) for every document in the MetaStore, one after another. A document whose
   * journal cannot be read is logged and skipped. Returns the total number re-emitted.
   * V1-19 calls this once at boot, after `audit.enable` is applied and before sessions are accepted.
   */
  async replayAll(): Promise<number> {
    let total = 0;
    for (const m of this.#meta.list()) {
      try {
        total += await this.replayPending(m.documentId);
      } catch (err) {
        this.#logger.error('AuditEmitter: audit replay failed for a document; skipped.', {
          documentId: m.documentId,
          code: (err as { code?: string }).code,
        });
      }
    }
    return total;
  }

  /** Resolves when every scheduled `auditEmittedRev` write has finished. For shutdown and tests. */
  async flush(): Promise<void> {
    while (this.#running.size > 0) await Promise.all([...this.#running.values()]);
  }

  #handOff(e: AuditEvent): boolean {
    try {
      this.#send('audit', e);
      return true;
    } catch (err) {
      this.#logger.error('AuditEmitter: hand-off failed.', { documentId: e.documentId, error: String(err) });
      return false;
    }
  }

  /** Records that `rev` was handed off; resolves when the meta write has finished. */
  #advance(id: DocumentId, rev: number): Promise<void> {
    this.#want.set(id, Math.max(this.#want.get(id) ?? 0, rev));
    const running = this.#running.get(id);
    if (running !== undefined) return running;
    const p = this.#drain(id).finally(() => this.#running.delete(id));
    this.#running.set(id, p);
    return p;
  }

  async #drain(id: DocumentId): Promise<void> {
    const key = docKeyOf(id);
    for (;;) {
      const rev = this.#want.get(id);
      if (rev === undefined) return;
      this.#want.delete(id);
      try {
        const m = this.#meta.get(key);
        if (m !== undefined && m.auditEmittedRev < rev) {
          m.auditEmittedRev = rev;
          await this.#meta.put(m);
        }
      } catch (err) {
        // The rev stays behind, so a replay re-emits it (at least once).
        this.#logger.warn('AuditEmitter: could not persist auditEmittedRev.', { documentId: id, error: String(err) });
      }
    }
  }
}

function toEvent(documentId: DocumentId, kind: AuditEvent['kind'], e: JournalEntry): AuditEvent {
  return {
    documentId,
    kind,
    rev: e.r,
    fromRev: e.f,
    at: e.t,
    userId: e.u,
    clientId: e.c,
    clientSeq: e.q,
    sessionId: null,
    ops: e.o,
    replayed: true,
  };
}
