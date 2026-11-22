/**
 * The OtType laws L1–L8 (LLD Part 1 §7) as a reusable Vitest suite. The text and sheet
 * suites call `runOtLaws(type, fixtures)` inside a `describe`.
 */
import { expect, it } from 'vitest';
import { OpenDocexError } from '../../src/errors/index.js';
import type { Chunk, ChunkLimits, OtType } from '../../src/ot/index.js';
import { utf8Length } from '../../src/util/index.js';

export interface OtLawFixtures<S, O, D> {
  /** Snapshots to check L1, L4, L5, L6 and L8 on. */
  snapshots: S[];
  /** Op lists applied to a snapshot (L2, L8). They may include ops that get dropped. */
  applyCases: { snapshot: S; ops: O[] }[];
  /** Op lists for L3 and L8 (`rebase`). */
  rebaseCases: { ops: O[]; over: O[] }[];
  /** Chunk limits for L5 and L6. */
  limits: ChunkLimits[];
  /** Number of indivisible units (blocks, rows) a chunk holds (L6). */
  unitsIn(chunk: Chunk<D>): number;
  /** Untrusted input that `validateOps` accepts, with its normalized result (L7). */
  validOps: { input: unknown; expected: O[] }[];
  /** Untrusted input that `validateOps` rejects (L7). */
  invalidOps: unknown[];
}

function rejectedCode(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    return e instanceof OpenDocexError ? e.code : 'not-an-OpenDocexError';
  }
  return undefined;
}

/** Registers one test per law for `type`. */
export function runOtLaws<S, O, D>(type: OtType<S, O, D>, fx: OtLawFixtures<S, O, D>): void {
  const ser = (s: S): unknown => type.serializeSnapshot(s);

  it('L1: apply(s, []) returns s unchanged with dropped 0', () => {
    for (const s of fx.snapshots) {
      const before = ser(s);
      const r = type.apply(s, []);
      expect(ser(r.snapshot)).toEqual(before);
      expect(r.applied).toEqual([]);
      expect(r.dropped).toBe(0);
    }
  });

  it('L2: applied.length + dropped == ops.length', () => {
    for (const c of fx.applyCases) {
      const r = type.apply(c.snapshot, c.ops);
      expect(r.applied.length + r.dropped).toBe(c.ops.length);
    }
  });

  it('L3: rebase(ops, []) ≡ ops and rebase([], over) ≡ []', () => {
    for (const c of fx.rebaseCases) {
      expect(type.rebase(c.ops, [])).toEqual(c.ops);
      expect(type.rebase([], c.over)).toEqual([]);
    }
  });

  it('L4: deserializeSnapshot(serializeSnapshot(s)) ≡ s', () => {
    for (const s of fx.snapshots) {
      expect(ser(type.deserializeSnapshot(ser(s)))).toEqual(ser(s));
      // Through a JSON round trip, as when read from disk.
      expect(ser(type.deserializeSnapshot(JSON.parse(JSON.stringify(ser(s))) as unknown))).toEqual(ser(s));
    }
  });

  it('L5: assemble(chunk(s, l)) ≡ s for every l', () => {
    for (const s of fx.snapshots) {
      for (const l of fx.limits) {
        expect(ser(type.assemble(type.chunk(s, l)))).toEqual(ser(s));
      }
    }
  });

  it('L6: chunk seq values are 0…n-1, and each chunk is ≤ maxBytes unless it holds one unit', () => {
    for (const s of fx.snapshots) {
      for (const l of fx.limits) {
        const chunks = type.chunk(s, l);
        chunks.forEach((c, i) => {
          expect(c.seq).toBe(i);
          const bytes = utf8Length(JSON.stringify(c.data));
          if (bytes > l.maxBytes) expect(fx.unitsIn(c)).toBe(1);
        });
      }
    }
  });

  it('L7: validateOps returns normalized ops and throws PROTOCOL_OP_REJECTED', () => {
    for (const v of fx.validOps) expect(type.validateOps(v.input)).toEqual(v.expected);
    for (const bad of fx.invalidOps) expect(rejectedCode(() => type.validateOps(bad))).toBe('PROTOCOL_OP_REJECTED');
  });

  it('L8: every method is deterministic and does not mutate its inputs', () => {
    for (const c of fx.applyCases) {
      const sBefore = ser(c.snapshot);
      const oBefore = JSON.stringify(c.ops);
      const a = type.apply(c.snapshot, c.ops);
      const b = type.apply(c.snapshot, c.ops);
      expect(ser(a.snapshot)).toEqual(ser(b.snapshot));
      expect(a.applied).toEqual(b.applied);
      expect(a.dropped).toBe(b.dropped);
      expect(ser(c.snapshot)).toEqual(sBefore);
      expect(JSON.stringify(c.ops)).toBe(oBefore);
    }
    for (const c of fx.rebaseCases) {
      const before = JSON.stringify([c.ops, c.over]);
      expect(type.rebase(c.ops, c.over)).toEqual(type.rebase(c.ops, c.over));
      expect(JSON.stringify([c.ops, c.over])).toBe(before);
    }
    for (const s of fx.snapshots) {
      const before = ser(s);
      for (const l of fx.limits) expect(type.chunk(s, l)).toEqual(type.chunk(s, l));
      expect(ser(s)).toEqual(before);
    }
    for (const v of fx.validOps) {
      const before = JSON.stringify(v.input);
      expect(type.validateOps(v.input)).toEqual(type.validateOps(v.input));
      expect(JSON.stringify(v.input)).toBe(before);
    }
  });
}
