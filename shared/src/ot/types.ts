/**
 * The OT Strategy interface shared by both document kinds (LLD Part 1 §7, HLD §7,
 * §0 S-21), plus the chunk types used to send a snapshot in pieces.
 */

/** Limits for splitting a snapshot into chunks (HLD §12). */
export interface ChunkLimits {
  /** Most top-level text blocks in one chunk. */
  textBlocks: number;
  /** Most sheet rows in one chunk. */
  sheetRows: number;
  /** Most bytes in one chunk's `data`, as `utf8Length(JSON.stringify(data))`. */
  maxBytes: number;
}

/** Default chunk limits (HLD §12). */
export const DEFAULT_CHUNK_LIMITS: ChunkLimits = Object.freeze({
  textBlocks: 200,
  sheetRows: 500,
  maxBytes: 262_144,
});

/** One piece of a snapshot. `seq` runs 0…n-1. `D` is the kind's chunk data type. */
export interface Chunk<D = unknown> {
  seq: number;
  data: D;
}

/**
 * The operations a document kind provides to the engine. Every method is deterministic
 * and pure, and never mutates its inputs.
 *
 * Laws (LLD Part 1 §7):
 * - L1: `apply(s, [])` returns `s` unchanged with `dropped: 0`.
 * - L2: `applied.length + dropped == ops.length`.
 * - L3: `rebase(ops, []) ≡ ops` and `rebase([], over) ≡ []`.
 * - L4: `deserializeSnapshot(serializeSnapshot(s)) ≡ s`.
 * - L5: `assemble(chunk(s, l)) ≡ s` for every `l`.
 * - L6: chunk `seq` values are 0…n-1, and each chunk is ≤ `maxBytes`, except a chunk
 *   holding one indivisible unit that is larger by itself.
 * - L7: `validateOps` returns normalized ops with unknown fields stripped, and throws
 *   `PROTOCOL_OP_REJECTED`.
 * - L8: every method is deterministic and pure.
 *
 * @typeParam S - snapshot type
 * @typeParam O - op type
 * @typeParam D - chunk data type
 */
export interface OtType<S, O, D> {
  kind: 'text' | 'sheet';
  apply(s: S, ops: O[]): { snapshot: S; applied: O[]; dropped: number };
  rebase(ops: O[], over: O[]): O[];
  validateOps(ops: unknown): O[];
  serializeSnapshot(s: S): unknown;
  deserializeSnapshot(j: unknown): S;
  chunk(s: S, limits: ChunkLimits): Chunk<D>[];
  assemble(chunks: Chunk<D>[]): S;
}
