/**
 * Mapping-only rebase of text steps (LLD Part 1 §8.3, §0 R-6).
 *
 * `rebaseSteps` needs no document, so the server and every client compute the same
 * result from the same `(steps, over)`. It uses only `getMap`, `StepMap.invert`,
 * `Step.map`, `Mapping.slice` and `Mapping.appendMap`. Unlike prosemirror-collab, a
 * mirror is recorded for every step that maps, so content of earlier own steps is
 * recovered even when a later step fails to apply; failures are handled by
 * {@link applyStepsWithDrop}.
 *
 * Prefix consistency: `rebaseSteps([...A, ...B], R)` starts with `rebaseSteps(A, R)`.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { Mapping, Transform } from 'prosemirror-transform';
import type { Step, StepMap } from 'prosemirror-transform';
import { applyIndexedWithDrop } from './apply.js';

/** Rebased steps plus, for each, the index of its source in the input. */
export interface IndexedSteps {
  steps: Step[];
  index: number[];
}

/**
 * {@link rebaseOverMaps} with index tracking. `index[j]` is `inputIndex[k]` for the
 * input step `k` that produced `steps[j]`. Internal.
 */
export function rebaseOverMapsIndexed(
  steps: readonly Step[],
  overMaps: readonly StepMap[],
  inputIndex: readonly number[],
): IndexedSteps {
  const n = steps.length;
  const mapping = new Mapping();
  // steps[i]⁻¹ sits at index n-1-i.
  for (let i = n - 1; i >= 0; i--) mapping.appendMap((steps[i] as Step).getMap().invert());
  for (const m of overMaps) mapping.appendMap(m);
  const out: Step[] = [];
  const index: number[] = [];
  for (let i = 0; i < n; i++) {
    // slice(n - i) skips the inverses of steps[i..n-1].
    const mapped = (steps[i] as Step).map(mapping.slice(n - i));
    if (mapped) {
      // Mirror of steps[i]⁻¹, so positions inside earlier own content are recovered.
      mapping.appendMap(mapped.getMap(), n - 1 - i);
      out.push(mapped);
      index.push(inputIndex[i] as number);
    }
  }
  return { steps: out, index };
}

/**
 * Rebases `steps` (made on some document D) over the step maps `overMaps` (also made on
 * D, in order). Steps the mapping deletes are left out. Internal: callers outside the
 * text module use {@link rebaseSteps}.
 */
export function rebaseOverMaps(steps: readonly Step[], overMaps: readonly StepMap[]): Step[] {
  return rebaseOverMapsIndexed(
    steps,
    overMaps,
    steps.map((_, i) => i),
  ).steps;
}

/**
 * Rebases `steps` over `over`, both made on the same document and each in FIFO order.
 * Pure and document-free: the result depends only on the inputs. Steps whose range was
 * deleted by `over` are left out. This is the form behind `TextOtType.rebase`.
 */
export function rebaseSteps(steps: readonly Step[], over: readonly Step[]): Step[] {
  return rebaseOverMaps(
    steps,
    over.map((s) => s.getMap()),
  );
}

/**
 * Rebases `steps` over `over` and applies the result to `doc` with the
 * {@link applyStepsWithDrop} semantics (§0 R-6). `doc` is the document with `over`
 * already applied. A step that fails to apply is dropped, and so are its dependents.
 *
 * @returns `steps`: the surviving rebased steps; `kept[j]`: the index in the input
 *   `steps` of `steps[j]`; `doc`: `doc` with the surviving steps applied.
 */
export function rebaseStepsOnDoc(
  steps: readonly Step[],
  over: readonly Step[],
  doc: PMNode,
): { steps: Step[]; kept: number[]; doc: PMNode } {
  const rebased = rebaseOverMapsIndexed(
    steps,
    over.map((s) => s.getMap()),
    steps.map((_, i) => i),
  );
  const tr = new Transform(doc);
  const r = applyIndexedWithDrop(tr, rebased.steps, rebased.index);
  return { steps: r.applied, kept: r.index, doc: tr.doc };
}
