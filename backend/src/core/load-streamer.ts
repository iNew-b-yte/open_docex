/**
 * First load, resync and resume for one document (LLD Part 2 §8.5 [A7], Part 1 §6 R11–R12,
 * §0 PO-16, R-8, R-9).
 *
 * - **Full load:** `load-start` (carrying `limits.maxAssetBytes`, §0 R-3 and S-45), then the
 *   chunks, then `load-done`. Only chunks are paced: at
 *   most {@link LOAD_WINDOW} are unwritten at a time, each carrying a token that the main side
 *   answers with `written`. The session joins the broadcast set before `load-start`, so remotes
 *   for later revs may arrive between chunks (the client buffers them until `load-done`).
 * - **Catch-up:** one message per batch committed after the client's rev, in rev order: an
 *   `ack` for the client's own batches (with `committed` when transformed) and a `remote` for
 *   other clients' batches. All-dropped batches of other clients send nothing.
 *
 * @module
 */
import type { ClientId, Epoch } from '@open-docex/shared/ids';
import type { Chunk } from '@open-docex/shared/ot';
import type { ConversionNotice, DocKind, LoadStartMsg, ServerMessage, UnsupportedFinding } from '@open-docex/shared/protocol';
import { encodeMessage } from '@open-docex/shared/protocol';
import type { JournalEntry } from '../persistence/journal.js';
import type { DedupeTable } from './dedupe-table.js';
import type { KindPolicy } from './kind-policy.js';
import type { OpHistory } from './op-history.js';
import type { CoreSink } from './seams.js';
import { sendTo, type SessionRecord } from './session-record.js';

/** Most load chunks sent and not yet written, per session (LLD choice, §8.5). */
export const LOAD_WINDOW = 4;

/**
 * The `limits.maxAssetBytes` that `load-start` announces (§0 R-3, S-45): the largest image an
 * `asset-put` may carry, so a client can refuse an oversized image before the edge closes the
 * socket with 1009.
 *
 * The edge limit is the Gateway's `ws.maxPayloadBytes` (default 16 MiB) for the whole binary
 * frame, which is a 6-byte prefix, a header of at most 65 536 bytes and then the image
 * (Part 1 §5.1). The Core does not learn `maxPayloadBytes` from the main process, so this is
 * the default's bound: a smaller adopter setting is not reflected here (LLD gap-fill, see the
 * V1-20 report).
 */
export const MAX_ASSET_BYTES = 16 * 1024 * 1024 - 6 - 65_536;

/** The instance state the streamer reads. `DocumentInstance` provides it. */
export interface LoadSource<S> {
  readonly epoch: Epoch;
  readonly rev: number;
  readonly kind: DocKind;
  readonly readOnly: boolean;
  readonly model: S;
  readonly findings: readonly UnsupportedFinding[];
  readonly conversions: readonly ConversionNotice[];
  readonly policy: KindPolicy<S, unknown>;
  readonly dedupe: DedupeTable;
  readonly history: OpHistory;
  /** The storage notice for a session that just finished loading, or `null` in NORMAL (S-38). */
  storageNotice?(): 'local' | 'pending' | null;
}

interface Stream {
  record: SessionRecord;
  rev: number;
  chunks: Chunk[];
  next: number;
  unwritten: Set<number>;
}

/** Streams loads and catch-ups to the sessions of one instance. */
export class LoadStreamer<S> {
  readonly #src: LoadSource<S>;
  readonly #sink: CoreSink;
  readonly #streams = new Map<string, Stream>();
  #cache: { rev: number; chunks: Chunk[] } | null = null;
  #nextToken = 1;

  constructor(src: LoadSource<S>, sink: CoreSink) {
    this.#src = src;
    this.#sink = sink;
  }

  /** Sessions with a load in progress. */
  get activeLoads(): number {
    return this.#streams.size;
  }

  /**
   * Starts a full load (R12). Synchronous up to the first chunk window. Any earlier load for
   * the same session is abandoned.
   */
  fullLoad(r: SessionRecord): void {
    this.#streams.delete(r.sessionId);
    const src = this.#src;
    const n = src.rev;
    const chunks = this.#chunksAt(n);
    r.state = 'loading';
    const start: LoadStartMsg = {
      type: 'load-start',
      epoch: src.epoch,
      rev: n,
      kind: src.kind,
      access: r.access,
      readOnly: src.readOnly,
      totalChunks: chunks.length,
      limits: { maxAssetBytes: MAX_ASSET_BYTES },
    };
    if (src.findings.length > 0) start.unsupported = [...src.findings];
    if (src.conversions.length > 0) start.conversions = [...src.conversions];
    const acked = r.clientId === undefined ? undefined : src.dedupe.lastSeq(r.clientId);
    if (acked !== undefined) start.ackedClientSeq = acked;
    sendTo(this.#sink, r.sessionId, start);
    const s: Stream = { record: r, rev: n, chunks, next: 0, unwritten: new Set() };
    this.#streams.set(r.sessionId, s);
    this.#pump(s);
  }

  /** Same-epoch resume (R11): a read-only notice, the missed batches, then live traffic. */
  catchUp(r: SessionRecord, from: number): void {
    sendTo(this.#sink, r.sessionId, {
      type: 'notice',
      notice: 'read-only',
      readOnly: r.access === 'view' || this.#src.readOnly,
      reason: 'unsupported-content',
    });
    this.replay(r, from);
    r.state = 'live';
  }

  /**
   * Sends the batches committed after `from` as acks (own) and remotes (others), in rev order
   * (R11, PO-16, R-8). `from` must be inside the history window.
   */
  replay(r: SessionRecord, from: number): void {
    const own = r.clientId;
    const frames: ServerMessage[] = [];
    for (const e of this.#src.history.entriesAfter(from)) {
      const m = replayMessage(e, own);
      if (m !== null) frames.push(m);
    }
    if (frames.length === 0) return;
    this.#sink.send(
      frames.map((m) => {
        const data = encodeMessage(m);
        return { sessionIds: [r.sessionId], data, binary: typeof data !== 'string' };
      }),
    );
  }

  /** A `written` event for a paced chunk: refills the session's window. */
  onWritten(sessionId: string, token: number): void {
    const s = this.#streams.get(sessionId);
    if (s === undefined || !s.unwritten.delete(token)) return;
    this.#pump(s);
  }

  /** Abandons a session's load (it left or was closed). */
  cancel(sessionId: string): void {
    this.#streams.delete(sessionId);
  }

  #chunksAt(rev: number): Chunk[] {
    if (this.#cache?.rev === rev) return this.#cache.chunks;
    const chunks = this.#src.policy.ot.chunk(this.#src.model, this.#src.policy.chunkLimits);
    this.#cache = { rev, chunks };
    return chunks;
  }

  #pump(s: Stream): void {
    if (this.#streams.get(s.record.sessionId) !== s) return;
    while (s.next < s.chunks.length && s.unwritten.size < LOAD_WINDOW) {
      const c = s.chunks[s.next] as Chunk;
      s.next++;
      const token = this.#nextToken++;
      s.unwritten.add(token);
      const data = encodeMessage({ type: 'load-chunk', seq: c.seq, data: c.data });
      this.#sink.send([{ sessionIds: [s.record.sessionId], data, binary: typeof data !== 'string', token }]);
    }
    if (s.next === s.chunks.length) {
      this.#streams.delete(s.record.sessionId);
      sendTo(this.#sink, s.record.sessionId, { type: 'load-done', rev: s.rev });
      if (s.record.state === 'loading') s.record.state = 'live';
      const notice = this.#src.storageNotice?.() ?? null;
      if (notice !== null) sendTo(this.#sink, s.record.sessionId, { type: 'notice', notice: 'storage', state: notice });
    }
  }
}

/** The catch-up message for one committed batch, or `null` for another client's all-dropped batch. */
export function replayMessage(e: JournalEntry, own: ClientId | undefined): ServerMessage | null {
  if (own !== undefined && e.c === own) {
    return e.x ? { type: 'ack', clientSeq: e.q, rev: e.r, committed: e.o } : { type: 'ack', clientSeq: e.q, rev: e.r };
  }
  if (e.o.length === 0) return null;
  return { type: 'remote', fromRev: e.f, ops: e.o, clientId: e.c };
}
