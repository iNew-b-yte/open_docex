/**
 * Kind policies: what differs between text and sheet documents inside the Core (LLD Part 2
 * §8.3). V1 has the text policy only; the sheet policy comes in V2.
 *
 * @module
 */
import type { ChunkLimits, OtType } from '@open-docex/shared/ot';
import type { DocKind } from '@open-docex/shared/protocol';
import { parseTextOps, rebaseStepsOnDoc, TextOtType, textSchema } from '@open-docex/shared/text';
import type { TextOp, TextSnapshot } from '@open-docex/shared/text';

/** The result of {@link KindPolicy.rebaseApply}. */
export interface RebaseApplyResult<S, O> {
  snapshot: S;
  /** The applied ops, as stored and broadcast. */
  applied: O[];
  /** Ops dropped by the rebase or by apply. */
  dropped: number;
}

/** Per-kind behaviour of a {@link DocumentInstance}. */
export interface KindPolicy<S, O> {
  kind: DocKind;
  ot: OtType<S, O, unknown>;
  /** Text uses `textBlocks` and `maxBytes`; sheets use `sheetRows` and `maxBytes`. */
  chunkLimits: ChunkLimits;
  /** A new, empty document. */
  emptySnapshot(): S;
  /** Asset IDs the ops refer to. Text: image `assetId`s inside inserted slices and `attr` steps. */
  assetRefs(ops: readonly O[]): string[];
  /**
   * Rebases validated `ops` over the committed `over` and applies the result to `model` (the
   * head). Pure: never mutates its inputs. Text uses `rebaseStepsOnDoc` (§0 R-6).
   */
  rebaseApply(model: S, ops: O[], over: O[]): RebaseApplyResult<S, O>;
}

/** The generic `rebaseApply`: `ot.rebase` then `ot.apply`, as in the §8.4 pseudocode. */
export function genericRebaseApply<S, O>(ot: OtType<S, O, unknown>, model: S, ops: O[], over: O[]): RebaseApplyResult<S, O> {
  const rebased = over.length > 0 ? ot.rebase(ops, over) : ops;
  const r = ot.apply(model, rebased);
  return { snapshot: r.snapshot, applied: r.applied, dropped: r.dropped + (ops.length - rebased.length) };
}

function collectAssetIds(x: unknown, out: Set<string>): void {
  if (Array.isArray(x)) {
    for (const v of x) collectAssetIds(v, out);
    return;
  }
  if (typeof x !== 'object' || x === null) return;
  const o = x as Record<string, unknown>;
  if (o['type'] === 'image') {
    const attrs = o['attrs'] as Record<string, unknown> | undefined;
    const id = attrs?.['assetId'];
    if (typeof id === 'string') out.add(id);
  }
  if (o['content'] !== undefined) collectAssetIds(o['content'], out);
}

/** Image asset IDs referenced by text ops. */
export function textAssetRefs(ops: readonly TextOp[]): string[] {
  const out = new Set<string>();
  for (const op of ops) {
    if (op.stepType === 'attr' && op['attr'] === 'assetId' && typeof op['value'] === 'string') out.add(op['value']);
    const slice = op['slice'] as { content?: unknown } | undefined;
    if (slice?.content !== undefined) collectAssetIds(slice.content, out);
  }
  return [...out];
}

/** Builds the text policy with the configured chunk limits. */
export function textKindPolicy(chunkLimits: ChunkLimits): KindPolicy<TextSnapshot, TextOp> {
  return {
    kind: 'text',
    ot: TextOtType,
    chunkLimits,
    emptySnapshot(): TextSnapshot {
      const doc = textSchema.topNodeType.createAndFill();
      if (doc === null) throw new Error('The text schema cannot create an empty document.');
      return doc;
    },
    assetRefs: textAssetRefs,
    rebaseApply(model, ops, over) {
      const steps = parseTextOps(ops);
      const r = rebaseStepsOnDoc(steps, parseTextOps(over), model);
      return {
        snapshot: r.doc,
        applied: r.steps.map((s) => s.toJSON() as TextOp),
        dropped: steps.length - r.steps.length,
      };
    },
  };
}
