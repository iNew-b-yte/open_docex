/**
 * The core rebuild of the text sync client (LLD Part 3 §7.2, HLD §13, §0 R-6). Internal.
 *
 * One transaction takes the editor from "confirmed + pending" to "confirmed + `over` + pending
 * rebased over `over`". The rebase is the shared, mapping-only `rebaseStepsOnDoc`, the same
 * code the server runs (CL-6).
 *
 * @module
 */
import type { EditorState, Transaction } from 'prosemirror-state';
import { Mapping, type Step } from 'prosemirror-transform';
import { parseTextOps, rebaseStepsOnDoc, type TextOp } from '@open-docex/shared/text';
import type { PendingStep } from './types.js';

/** `over` does not apply to the confirmed document: the client and server have diverged. */
export class Divergence extends Error {
  constructor(message = 'Remote steps do not apply to the confirmed document.') {
    super(message);
    this.name = 'Divergence';
  }
}

/** The result of {@link rebuild}. */
export interface Rebuild {
  /** The one transaction to dispatch. The caller adds the `rebuild` sync meta. */
  readonly tr: Transaction;
  /** The pending steps after the rebuild, with inverses on their new documents. */
  readonly newKeep: PendingStep[];
  /** `kept[j]` is the index in `keep` of the step `newKeep[j]` came from. */
  readonly kept: number[];
}

/**
 * Builds the transaction that undoes the local `keep` steps (newest first), applies `over`
 * and re-applies `keep` rebased over `over` (LLD Part 3 §7.2). Rebased steps that no longer
 * apply are dropped, with their dependents (`applyStepsWithDrop` semantics).
 *
 * The selection is mapped through the public `Mapping` API with mirrors, so a caret inside
 * re-applied local typing stays where it was. The transaction carries `addToHistory: false`.
 *
 * @throws {Divergence} when an inverse or a step of `over` does not apply.
 */
export function rebuild(state: EditorState, keep: readonly PendingStep[], over: readonly Step[]): Rebuild {
  const tr = state.tr;
  const n = keep.length;
  for (let i = n - 1; i >= 0; i--) {
    if (tr.maybeStep((keep[i] as PendingStep).inverted).failed !== null) throw new Divergence('A local inverse does not apply.');
  }
  for (const s of over) {
    if (tr.maybeStep(s).failed !== null) throw new Divergence();
  }
  const r = rebaseStepsOnDoc(
    keep.map((k) => k.step),
    over,
    tr.doc,
  );
  const sel = new Mapping();
  // The inverse of keep[i] sits at mapping index n-1-i.
  for (let i = n - 1; i >= 0; i--) sel.appendMap((keep[i] as PendingStep).step.getMap().invert());
  for (const s of over) sel.appendMap(s.getMap());
  const newKeep: PendingStep[] = [];
  for (let j = 0; j < r.steps.length; j++) {
    const step = r.steps[j] as Step;
    const before = tr.doc;
    // Cannot fail: rebaseStepsOnDoc applied the same steps to the same document.
    if (tr.maybeStep(step).failed !== null) throw new Divergence('A rebased step does not apply.');
    newKeep.push({ step, inverted: step.invert(before) });
    // The mirror of its own inverse, so positions inside earlier local content are recovered.
    sel.appendMap(step.getMap(), n - 1 - (r.kept[j] as number));
  }
  tr.setSelection(state.selection.map(tr.doc, sel));
  tr.setMeta('addToHistory', false);
  return { tr, newKeep, kept: r.kept };
}

/**
 * Parses server ops into text steps, or returns null when any op is not a valid step of the
 * shared text schema (a malformed `remote` or `committed` → reload).
 */
export function parseSteps(ops: readonly unknown[]): Step[] | null {
  try {
    return parseTextOps(ops as readonly TextOp[]);
  } catch {
    return null;
  }
}

/** The JSON form of steps, as sent in `submit.ops`. */
export function stepsJson(steps: readonly Step[]): TextOp[] {
  return steps.map((s) => s.toJSON() as TextOp);
}
