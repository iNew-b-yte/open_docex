/**
 * `DedupeTable`: the last committed `clientSeq` and its `rev` per client (LLD Part 2 §8.7,
 * Part 1 §6 R10, HLD CL-12).
 *
 * - An envelope with `clientSeq ≤ lastSeq[clientId]` is a duplicate.
 * - The table is updated only when a batch's journal write resolves, rebuilt from the journal
 *   on load, and stored in each snapshot.
 * - At most {@link DEDUPE_MAX_CLIENTS} clients are kept; the lowest `rev` is evicted first.
 *   Records arrive in commit order, so the Map's insertion order (a record is re-inserted on
 *   update) is ascending by `rev`, and eviction takes the first key in O(1).
 *
 * @module
 */
import type { ClientId } from '@open-docex/shared/ids';

/** The client cap (LLD choice, §8.7). Client IDs are created per tab load. */
export const DEDUPE_MAX_CLIENTS = 10_000;

/** Per-document dedupe state. */
export class DedupeTable {
  readonly #byClient = new Map<ClientId, { seq: number; rev: number }>();
  readonly #max: number;

  constructor(maxClients: number = DEDUPE_MAX_CLIENTS) {
    this.#max = maxClients;
  }

  /** True when `seq` is at most the last committed seq for `c`. */
  lookup(c: ClientId, seq: number): boolean {
    const e = this.#byClient.get(c);
    return e !== undefined && seq <= e.seq;
  }

  /**
   * Records that `c`'s envelope `seq` was committed at `rev`. A `seq` not above the one held is
   * ignored, since seqs only grow per client (R9).
   */
  record(c: ClientId, seq: number, rev: number): void {
    const e = this.#byClient.get(c);
    if (e !== undefined && seq <= e.seq) return;
    this.#byClient.delete(c);
    this.#byClient.set(c, { seq, rev });
    while (this.#byClient.size > this.#max) {
      const oldest = this.#byClient.keys().next();
      if (oldest.done === true) break;
      this.#byClient.delete(oldest.value);
    }
  }

  /** The last committed seq for `c`; fills `load-start.ackedClientSeq` (R12). */
  lastSeq(c: ClientId): number | undefined {
    return this.#byClient.get(c)?.seq;
  }

  /** The rev at which `c`'s last committed seq was committed. */
  lastRev(c: ClientId): number | undefined {
    return this.#byClient.get(c)?.rev;
  }

  /** Number of clients held. */
  get size(): number {
    return this.#byClient.size;
  }

  /** Rows `[clientId, seq, rev]`, ascending by rev, for the snapshot file. */
  toJSON(): Array<[ClientId, number, number]> {
    return [...this.#byClient].map(([c, e]) => [c, e.seq, e.rev]);
  }

  /** Rebuilds a table from {@link DedupeTable.toJSON} rows. */
  static fromJSON(a: ReadonlyArray<readonly [ClientId, number, number]>, maxClients?: number): DedupeTable {
    const t = new DedupeTable(maxClients);
    for (const [c, seq, rev] of [...a].sort((x, y) => x[2] - y[2])) t.record(c, seq, rev);
    return t;
  }
}
