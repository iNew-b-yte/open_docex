/**
 * `OpHistory`: the recent committed batches of one document, in rev order (LLD Part 2 §8.4,
 * §8.5). It serves rebasing (`opsSince`), resume catch-up (`entriesAfter`) and duplicate acks
 * (`findByClient`).
 *
 * - It keeps at most `maxOps` ops (and at most `maxOps` entries, so that all-dropped batches
 *   with no ops cannot grow it without bound). The newest entry is always kept.
 * - `floorRev` is the rev just before the oldest kept entry; with no entries it equals the head.
 * - Entries are contiguous: each entry's `f` equals the previous entry's `r`.
 *
 * @module
 */
import type { ClientId } from '@open-docex/shared/ids';
import type { JournalEntry } from '../persistence/journal.js';

/** `historyMaxOps = max(1000, 2 × snapshot.everyOps)` (LLD choice, §8.5). */
export function historyMaxOps(everyOps: number): number {
  return Math.max(1000, 2 * everyOps);
}

const keyOf = (c: ClientId, q: number): string => `${c}\u0000${q}`;

/** The in-memory history window. */
export class OpHistory {
  readonly #max: number;
  /** Entries in rev order; `#start` is the index of the oldest kept one. */
  #entries: JournalEntry[] = [];
  #start = 0;
  #ops = 0;
  #head: number;
  readonly #byClient = new Map<string, JournalEntry>();

  constructor(maxOps: number, headRev: number) {
    this.#max = maxOps;
    this.#head = headRev;
  }

  /** The rev after the newest entry. */
  get headRev(): number {
    return this.#head;
  }

  /** The rev just before the oldest kept entry. */
  get floorRev(): number {
    return this.#start < this.#entries.length ? (this.#entries[this.#start] as JournalEntry).f : this.#head;
  }

  /** Number of entries kept. */
  get length(): number {
    return this.#entries.length - this.#start;
  }

  /** Forgets every entry and moves the head to `rev`. */
  reset(rev: number): void {
    this.#entries = [];
    this.#start = 0;
    this.#ops = 0;
    this.#head = rev;
    this.#byClient.clear();
  }

  /**
   * Appends a committed entry.
   *
   * @throws {RangeError} when `e.f` is not the head rev (a broken invariant).
   */
  push(e: JournalEntry): void {
    if (e.f !== this.#head || e.r !== e.f + e.o.length) {
      throw new RangeError(`History is not contiguous: head ${this.#head}, entry ${e.f}→${e.r}.`);
    }
    this.#entries.push(e);
    this.#ops += e.o.length;
    this.#head = e.r;
    this.#byClient.set(keyOf(e.c, e.q), e);
    while (this.length > 1 && (this.#ops > this.#max || this.length > this.#max)) {
      const old = this.#entries[this.#start] as JournalEntry;
      this.#start++;
      this.#ops -= old.o.length;
      const k = keyOf(old.c, old.q);
      if (this.#byClient.get(k) === old) this.#byClient.delete(k);
    }
    // Compact the array now and then, so evicted entries can be collected.
    if (this.#start > 1024 && this.#start * 2 > this.#entries.length) {
      this.#entries = this.#entries.slice(this.#start);
      this.#start = 0;
    }
  }

  /** True when `rev` is inside the window: `floorRev ≤ rev ≤ headRev`. */
  covers(rev: number): boolean {
    return rev >= this.floorRev && rev <= this.#head;
  }

  /**
   * The committed ops after `baseRev`, in order: the `over` of a rebase (Part 1 §6 R4).
   *
   * @throws {RangeError} when `baseRev` is outside the window.
   */
  opsSince(baseRev: number): unknown[] {
    if (!this.covers(baseRev)) throw new RangeError(`rev ${baseRev} is outside the history window.`);
    const out: unknown[] = [];
    for (const e of this.#iterAfter(baseRev)) {
      // A baseRev inside an entry keeps only that entry's later ops (rev counts ops, R1).
      out.push(...(e.f >= baseRev ? e.o : e.o.slice(baseRev - e.f)));
    }
    return out;
  }

  /** The entries that end after `rev`, in rev order (resume catch-up, R11). */
  entriesAfter(rev: number): JournalEntry[] {
    return [...this.#iterAfter(rev)];
  }

  /** The kept entry committed for `(c, q)`, if any. */
  findByClient(c: ClientId, q: number): JournalEntry | undefined {
    return this.#byClient.get(keyOf(c, q));
  }

  /**
   * Entries committed after `rev`: those with `r > rev`, plus all-dropped entries (`f == r ==
   * rev`), which were committed after the state at `rev` but moved no rev.
   */
  *#iterAfter(rev: number): Iterable<JournalEntry> {
    // Binary search for the first entry with r >= rev; entries are sorted by r.
    let lo = this.#start;
    let hi = this.#entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.#entries[mid] as JournalEntry).r >= rev) hi = mid;
      else lo = mid + 1;
    }
    for (let i = lo; i < this.#entries.length; i++) {
      const e = this.#entries[i] as JournalEntry;
      if (e.r === rev && e.o.length > 0) continue;
      yield e;
    }
  }
}
