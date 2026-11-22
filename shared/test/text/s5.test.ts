/**
 * Spike S5 (HLD §20): server-side rebase gives the same result as client-side rebase,
 * including steps that get dropped (LLD Part 1 §8.8, "Server/client equivalence").
 *
 * Every ordered pair of single-step edits from a fixed finite set, over a fixed
 * three-block document, is simulated through the server and two clients (see `sim.ts`).
 * The enumeration is deterministic; randomized fuzzing is B10 (V6).
 */
import { Transform } from 'prosemirror-transform';
import type { Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { applyStepsWithDrop } from '../../src/text/apply.js';
import { textOpsEqual } from '../../src/text/equal.js';
import { textSchema } from '../../src/text/schema.js';
import { SimClient, bodyDoc, json, runPair } from './sim.js';

const base = bodyDoc('ab', 'cd', 'ef');
const size = base.content.size;
const bold = textSchema.marks.bold.create();

/** Text positions: inside a paragraph's content. */
const textPositions: number[] = [];
base.descendants((n, pos) => {
  if (n.isTextblock) for (let p = pos + 1; p <= pos + 1 + n.content.size; p++) textPositions.push(p);
  return !n.isTextblock;
});

interface Edit {
  name: string;
  step: Step;
}

/** The single step a transform makes on `base`, if it makes exactly one valid step. */
function single(name: string, f: (tr: Transform) => void): Edit | null {
  try {
    const tr = new Transform(base);
    f(tr);
    if (tr.steps.length !== 1) return null;
    const step = tr.steps[0] as Step;
    if (applyStepsWithDrop(new Transform(base), [step]).applied.length !== 1) return null;
    return { name, step };
  } catch {
    return null;
  }
}

const edits: Edit[] = [];
const push = (e: Edit | null): void => {
  if (e) edits.push(e);
};
for (const p of textPositions) push(single(`insert@${String(p)}`, (tr) => tr.insert(p, textSchema.text('x'))));
for (let from = 1; from < size - 1; from++) {
  for (const w of [1, 2]) {
    if (from + w > size - 1) continue;
    push(single(`delete ${String(from)}-${String(from + w)}`, (tr) => tr.delete(from, from + w)));
    push(single(`bold ${String(from)}-${String(from + w)}`, (tr) => tr.addMark(from, from + w, bold)));
  }
}
for (const p of textPositions) push(single(`split@${String(p)}`, (tr) => tr.split(p)));

describe('spike S5: server/client equivalence over every pair of single-step edits', () => {
  it('has a fixed, non-trivial edit set', () => {
    expect(textPositions).toEqual([2, 3, 4, 6, 7, 8, 10, 11, 12]);
    const kinds = new Set(edits.map((e) => e.name.split(/[@ ]/)[0]));
    expect([...kinds].sort()).toEqual(['bold', 'delete', 'insert', 'split']);
    expect(edits.length).toBeGreaterThan(40);
  });

  it('server, client A and client B converge, and B’s local rebase equals the committed steps', { timeout: 120_000 }, () => {
    let pairs = 0;
    let droppedB = 0;
    const failures: string[] = [];
    for (const a of edits) {
      for (const b of edits) {
        pairs++;
        const r = runPair(base, [a.step], [b.step]);
        if (r.committedB.length === 0) droppedB++;
        const ok =
          r.a.eq(r.server) &&
          r.b.eq(r.server) &&
          textOpsEqual(json(r.committedA), [a.step.toJSON()] as never) &&
          textOpsEqual(json(r.bRebased), json(r.committedB)) &&
          r.echoCorrections === 0;
        if (!ok) failures.push(`${a.name} | ${b.name}`);
      }
    }
    expect(failures).toEqual([]);
    expect(pairs).toBe(edits.length * edits.length);
    // Some pairs drop B's step (an edit inside a concurrently deleted range).
    expect(droppedB).toBeGreaterThan(0);
  });

  it('the committed echo replaces in-flight steps that differ (§8.6)', () => {
    const insX = edits.find((e) => e.name === 'insert@3')?.step as Step;
    const insY = edits.find((e) => e.name === 'insert@7')?.step as Step;
    const c = new SimClient(base);
    c.edit([insX]);
    // The server committed something else for this batch (for example, after dropping it).
    c.ack([insY]);
    expect(c.echoCorrections).toBe(1);
    expect(c.doc.eq(insY.apply(base).doc as typeof base)).toBe(true);
    expect(c.pending).toEqual([]);
  });
});
