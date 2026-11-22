/**
 * Comparison of text op lists (LLD Part 1 §8.2, §8.6, §0 S-21). The client uses it to
 * compare an `ack`'s `committed` steps with its in-flight steps.
 */
import { canonicalJson } from '../util/index.js';
import type { TextOp } from './steps.js';

/** True when `a` and `b` have the same length and each pair has the same canonical JSON. */
export function textOpsEqual(a: readonly TextOp[], b: readonly TextOp[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (canonicalJson(a[i]) !== canonicalJson(b[i])) return false;
  }
  return true;
}
