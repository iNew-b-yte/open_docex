/**
 * `ChunkLoader`: collects one full load (LLD Part 3 §5, HLD §12).
 *
 * It gathers the `load-chunk`s that follow a `load-start`, buffers `remote`s until `load-done`
 * (A7, N5), assembles the snapshot with the kind's `OtType.assemble` and reports progress.
 *
 * @module
 */
import type { Chunk, OtType } from '@open-docex/shared/ot';
import type { Access, DocKind, LoadChunkMsg, LoadDoneMsg, LoadStartMsg, RemoteMsg, UnsupportedFinding } from '@open-docex/shared/protocol';
import type { Epoch } from '@open-docex/shared/ids';
import type { LoadProgress } from '../events.js';

export type { LoadProgress } from '../events.js';

/** Why a load is broken. The session treats it as `PROTOCOL_INVALID_MESSAGE` and reloads. */
export class LoaderError extends Error {
  /** `seq`: a chunk out of order. `rev`: `load-done.rev` differs from `load-start.rev`. `state`: no load is active. */
  readonly reason: 'seq' | 'rev' | 'state';
  constructor(reason: 'seq' | 'rev' | 'state') {
    super(`Load failed: ${reason}.`);
    this.name = 'LoaderError';
    this.reason = reason;
  }
}

/** What a finished load gives the session. */
export interface LoadResult<S> {
  snapshot: S;
  rev: number;
  epoch: Epoch;
  /** Remotes received during the load, in arrival order (server FIFO order). Not yet applied. */
  buffered: RemoteMsg[];
}

/** What `begin` remembers from `load-start`. */
export interface LoadInfo {
  epoch: Epoch;
  rev: number;
  kind: DocKind;
  access: Access;
  readOnly: boolean;
  unsupported: readonly UnsupportedFinding[];
}

/** The `assemble` part of an `OtType`. */
export type Assembler<S> = Pick<OtType<S, unknown, unknown>, 'assemble'>;

/** Collects one load at a time (LLD Part 3 §5). */
export class ChunkLoader<S> {
  readonly #otType: Assembler<S>;
  readonly #onProgress: (p: LoadProgress) => void;
  #chunks: Chunk[] = [];
  #nextSeq = 0;
  #buffered: RemoteMsg[] = [];
  #start: LoadStartMsg | null = null;
  #bytes = 0;
  #active = false;

  constructor(otType: Assembler<S>, onProgress: (p: LoadProgress) => void) {
    this.#otType = otType;
    this.#onProgress = onProgress;
  }

  /** True between `begin` and a successful `finish` (or `reset`). */
  get active(): boolean {
    return this.#active;
  }

  /** What the current or last `load-start` said, or null before the first. */
  get info(): LoadInfo | null {
    const m = this.#start;
    if (m === null) return null;
    return { epoch: m.epoch, rev: m.rev, kind: m.kind, access: m.access, readOnly: m.readOnly, unsupported: m.unsupported ?? [] };
  }

  /** Starts a load, dropping any previous one. */
  begin(msg: LoadStartMsg): void {
    this.#chunks = [];
    this.#nextSeq = 0;
    this.#buffered = [];
    this.#start = msg;
    this.#bytes = 0;
    this.#active = true;
    this.#report();
  }

  /**
   * Adds a chunk. `frameBytes` is the raw frame's byte length, passed in by `Connection`, so no
   * chunk is serialised again.
   *
   * @throws {LoaderError} `seq` for a chunk out of order; `state` with no active load.
   */
  onChunk(msg: LoadChunkMsg, frameBytes = 0): void {
    if (!this.#active) throw new LoaderError('state');
    if (msg.seq !== this.#nextSeq) throw new LoaderError('seq');
    this.#chunks.push({ seq: msg.seq, data: msg.data });
    this.#nextSeq++;
    this.#bytes += frameBytes;
    this.#report();
  }

  /**
   * Keeps a `remote` until `load-done`. It is not applied early.
   *
   * @throws {LoaderError} `state` with no active load.
   */
  bufferRemote(msg: RemoteMsg): void {
    if (!this.#active) throw new LoaderError('state');
    this.#buffered.push(msg);
  }

  /**
   * Ends the load and assembles the snapshot. The chunks are released whether or not
   * `assemble` succeeds.
   *
   * @throws {LoaderError} `rev` when `load-done.rev` differs from `load-start.rev`; `state`
   *   with no active load.
   * @throws whatever `assemble` throws for invalid chunk data.
   */
  finish(msg: LoadDoneMsg): LoadResult<S> {
    const start = this.#start;
    if (!this.#active || start === null) throw new LoaderError('state');
    if (msg.rev !== start.rev) throw new LoaderError('rev');
    const chunks = this.#chunks;
    const buffered = this.#buffered;
    this.#chunks = [];
    this.#buffered = [];
    this.#active = false;
    // Arrival order is the server's FIFO order; the sync client checks `fromRev` contiguity.
    const snapshot = this.#otType.assemble(chunks);
    return { snapshot, rev: msg.rev, epoch: start.epoch, buffered };
  }

  /** Abandons the current load, releasing its chunks and remotes. */
  reset(): void {
    this.#chunks = [];
    this.#buffered = [];
    this.#active = false;
  }

  #report(): void {
    const total = this.#start?.totalChunks;
    const p: LoadProgress = { chunksReceived: this.#chunks.length, bytesReceived: this.#bytes };
    if (total !== undefined) p.totalChunks = total;
    this.#onProgress(p);
  }
}
