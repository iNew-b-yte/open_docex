/**
 * Apply text steps, dropping the ones that fail (LLD Part 1 §8.4, §0 S-20, S-27).
 *
 * A step fails when `Step.apply` fails or throws, or when the document it produces is
 * invalid in the touched range. A failed step is dropped, and the steps after it are
 * rebased over its inverse, so steps that depend on it (for example, typing inside a
 * dropped insert) are dropped too. Nothing here throws for a bad step.
 */
import { Mark } from 'prosemirror-model';
import type { Node as PMNode } from 'prosemirror-model';
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  DocAttrStep,
  RemoveMarkStep,
  RemoveNodeMarkStep,
} from 'prosemirror-transform';
import type { Step, Transform } from 'prosemirror-transform';
import { getPageSettings, pageSettingsFit } from './page.js';
import { rebaseOverMapsIndexed } from './rebase.js';

/** Regions where a `page_field` may appear (§0 S-20). */
const PAGE_FIELD_REGIONS: ReadonlySet<string> = new Set(['header', 'footer']);

/**
 * Applies `steps` to `tr` in order. Each step that applies and leaves a valid document
 * is added with `tr.step`, so the transform's mapping (and a transaction's selection)
 * tracks it. A step that fails is dropped, the remaining steps are rebased over its
 * inverse, and any that map to nothing are dropped as its dependents.
 *
 * @returns the steps applied (as positioned when applied) and the number dropped;
 *   `applied.length + dropped == steps.length`.
 */
export function applyStepsWithDrop(tr: Transform, steps: readonly Step[]): { applied: Step[]; dropped: number } {
  const r = applyIndexedWithDrop(
    tr,
    steps,
    steps.map((_, i) => i),
  );
  return { applied: r.applied, dropped: r.dropped };
}

/**
 * {@link applyStepsWithDrop} with index tracking: `index[j]` is `inputIndex[k]` for the
 * input step `k` that `applied[j]` came from. Internal.
 */
export function applyIndexedWithDrop(
  tr: Transform,
  steps: readonly Step[],
  inputIndex: readonly number[],
): { applied: Step[]; index: number[]; dropped: number } {
  let queue = steps.slice();
  let queueIndex = inputIndex.slice();
  const applied: Step[] = [];
  const index: number[] = [];
  let dropped = 0;
  while (queue.length > 0) {
    const s = queue.shift() as Step;
    const si = queueIndex.shift() as number;
    let ok = false;
    try {
      const r = s.apply(tr.doc); // throws RangeError for bad positions or attributes (§0)
      ok = r.doc !== null && r.failed === null && touchedValid(r.doc, s);
    } catch {
      ok = false;
    }
    if (ok) {
      tr.step(s);
      applied.push(s);
      index.push(si);
    } else {
      dropped += 1;
      const before = queue.length;
      // Later steps were positioned as if s had applied.
      const rebased = rebaseOverMapsIndexed(queue, [s.getMap().invert()], queueIndex);
      queue = rebased.steps;
      queueIndex = rebased.index;
      dropped += before - queue.length;
    }
  }
  return { applied, index, dropped };
}

/**
 * Checks the document a step produced, in the range the step touched. `ReplaceStep`'s own
 * check skips the inner nodes of an inserted slice, so every node intersecting the
 * touched range is checked shallowly here.
 */
function touchedValid(doc: PMNode, s: Step): boolean {
  // DocAttrStep: the attribute validators already ran in NodeType.create; the margin fit
  // spans two attributes, so it is checked here (§0 S-27).
  if (s instanceof DocAttrStep) return pageSettingsFit(getPageSettings(doc));
  const ranges: [number, number][] = [];
  if (s instanceof AttrStep || s instanceof AddNodeMarkStep || s instanceof RemoveNodeMarkStep) {
    const node = doc.nodeAt(s.pos);
    if (node === null) return false;
    ranges.push([s.pos, s.pos + node.nodeSize]);
  } else if (s instanceof AddMarkStep || s instanceof RemoveMarkStep) {
    // Mark steps have an empty step map, so their own range is the touched range.
    ranges.push([s.from, s.to]);
  } else {
    s.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      ranges.push([newStart, newEnd]);
    });
  }
  if (!doc.type.validContent(doc.content)) return false;
  const size = doc.content.size;
  for (const [a, b] of ranges) {
    let region = '';
    let valid = true;
    doc.nodesBetween(Math.max(0, a - 1), Math.min(size, b + 1), (node, _pos, parent) => {
      if (!valid) return false;
      if (parent === doc) region = node.type.name;
      if (!shallowValid(node, region)) valid = false;
      return valid;
    });
    if (!valid) return false;
  }
  return true;
}

/**
 * One node's own content, attributes and marks, without descending. Adds the rules a
 * per-attribute validator can't make: `colwidth` length = `colspan` (§0 S-27) and
 * `page_field` only inside `header`/`footer` (§0 S-20).
 */
function shallowValid(node: PMNode, region: string): boolean {
  try {
    if (!node.isText) {
      // createChecked checks the content (including allowed marks of the children) and
      // runs every attribute validator on the supplied values.
      node.type.createChecked(node.attrs, node.content);
    }
    let set = Mark.none;
    for (const m of node.marks) {
      m.type.create(m.attrs); // runs the mark's attribute validators
      set = m.addToSet(set);
    }
    if (!Mark.sameSet(set, node.marks)) return false;
  } catch {
    return false;
  }
  return extraRulesValid(node, region);
}

/** The cross-attribute and placement rules of §0 S-20 and S-27(1). */
function extraRulesValid(node: PMNode, region: string): boolean {
  const name = node.type.name;
  if (name === 'page_field') return PAGE_FIELD_REGIONS.has(region);
  if (name === 'table_cell' || name === 'table_header') return colwidthFits(node);
  return true;
}

/** True when a cell's `colwidth` is null or has `colspan` entries (§0 S-27(1)). */
export function colwidthFits(cell: PMNode): boolean {
  const w = cell.attrs.colwidth as unknown;
  return w === null || (Array.isArray(w) && w.length === cell.attrs.colspan);
}
