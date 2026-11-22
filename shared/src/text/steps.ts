/**
 * Text ops (LLD Part 1 §8.2, §0 S-21). A text op is the JSON form of a ProseMirror
 * step (`Step.toJSON()`).
 */
import { Step } from 'prosemirror-transform';
import { textSchema } from './schema.js';

/** Every step JSON id that prosemirror-transform registers. */
export type TextStepType =
  | 'replace'
  | 'replaceAround'
  | 'addMark'
  | 'removeMark'
  | 'markSet'
  | 'addNodeMark'
  | 'removeNodeMark'
  | 'attr'
  | 'docAttr';

/** One text op: the output of `Step.toJSON()`. */
export type TextOp = { stepType: TextStepType } & Record<string, unknown>;

/**
 * Parses ops into steps of {@link textSchema} with `Step.fromJSON`. Callers pass ops
 * that `validateOps` already accepted; invalid JSON makes `Step.fromJSON` throw.
 */
export function parseTextOps(ops: readonly TextOp[]): Step[] {
  return ops.map((j) => Step.fromJSON(textSchema, j));
}
