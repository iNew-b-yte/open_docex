/**
 * `TextOtType`: the OT Strategy for text documents (LLD Part 1 §8.5, §7, §0 S-20,
 * S-21, S-27). Snapshots are ProseMirror `doc` nodes of {@link textSchema}; ops are
 * `Step.toJSON()` output.
 */
import { Node as PMNode } from 'prosemirror-model';
import { Step, Transform } from 'prosemirror-transform';
import { OpenDocexError } from '../errors/index.js';
import type { OtType } from '../ot/index.js';
import { applyStepsWithDrop, colwidthFits } from './apply.js';
import { assembleText, chunkText } from './chunk.js';
import type { TextChunkData } from './chunk.js';
import { getPageSettings, pageSettingsFit } from './page.js';
import { rebaseSteps } from './rebase.js';
import { textSchema } from './schema.js';
import type { TextSnapshot } from './schema.js';
import { parseTextOps } from './steps.js';
import type { TextOp, TextStepType } from './steps.js';

const STEP_TYPES: ReadonlySet<string> = new Set<TextStepType>([
  'replace',
  'replaceAround',
  'addMark',
  'removeMark',
  'markSet',
  'addNodeMark',
  'removeNodeMark',
  'attr',
  'docAttr',
]);

/** Position fields that must be safe integers ≥ 0 when present (§8.2). */
const POSITION_FIELDS = ['from', 'to', 'gapFrom', 'gapTo', 'insert', 'pos'] as const;

/** `attr` steps may name any node attribute of the schema (§8.2). */
const NODE_ATTRS: ReadonlySet<string> = new Set(
  Object.values(textSchema.nodes).flatMap((t) => Object.keys(t.spec.attrs ?? {})),
);

/** `docAttr` steps may change only the page settings (§8.2, §0 S-18). */
const DOC_ATTRS: ReadonlySet<string> = new Set(['size', 'orientation', 'margins']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function rejectOp(detail: string): never {
  throw new OpenDocexError('PROTOCOL_OP_REJECTED', `Invalid text op: ${detail}`);
}

/**
 * Checks untrusted ops without the document and returns them normalized (unknown fields
 * dropped). Content validity, `attr` values and positions need the document and are
 * checked in `apply`. Throws `PROTOCOL_OP_REJECTED`.
 */
function validateTextOps(x: unknown): TextOp[] {
  if (!Array.isArray(x) || x.length === 0) rejectOp('not a non-empty array');
  const out: TextOp[] = [];
  for (const j of x as unknown[]) {
    if (!isPlainObject(j) || typeof j.stepType !== 'string' || !STEP_TYPES.has(j.stepType)) rejectOp('stepType');
    for (const f of POSITION_FIELDS) {
      const v = j[f];
      if (v !== undefined && !(Number.isSafeInteger(v) && (v as number) >= 0)) rejectOp(f);
    }
    if (j.stepType === 'attr' || j.stepType === 'docAttr') {
      const allowed = j.stepType === 'attr' ? NODE_ATTRS : DOC_ATTRS;
      if (typeof j.attr !== 'string' || !allowed.has(j.attr)) rejectOp('attr');
    }
    let step: Step;
    try {
      // Unknown node and mark types and attribute validators throw here.
      step = Step.fromJSON(textSchema, j);
    } catch {
      rejectOp('step');
    }
    out.push(step.toJSON() as TextOp);
  }
  return out;
}

/**
 * Applies ops to a document. A step that fails is dropped with its dependents (§8.4).
 * An op that does not parse is dropped too, so `apply` never throws for a bad op.
 */
function applyTextOps(doc: TextSnapshot, ops: TextOp[]): { snapshot: TextSnapshot; applied: TextOp[]; dropped: number } {
  const steps: Step[] = [];
  let unparsed = 0;
  for (const op of ops) {
    try {
      steps.push(Step.fromJSON(textSchema, op));
    } catch {
      unparsed += 1;
    }
  }
  const tr = new Transform(doc);
  const r = applyStepsWithDrop(tr, steps);
  return { snapshot: tr.doc, applied: r.applied.map((s) => s.toJSON() as TextOp), dropped: r.dropped + unparsed };
}

/**
 * Rebuilds a snapshot from JSON. Every failure throws `DOCUMENT_FAULTED` (a corrupt
 * local snapshot): bad JSON, content or attributes, a root that is not `doc`, and the
 * cross-attribute rules of §0 S-27 (`colwidth` length = `colspan`, margins fit the page).
 */
function deserializeText(j: unknown): TextSnapshot {
  let doc: PMNode;
  try {
    doc = PMNode.fromJSON(textSchema, j);
    doc.check();
  } catch (err) {
    throw new OpenDocexError('DOCUMENT_FAULTED', 'Corrupt text snapshot', { cause: err });
  }
  if (doc.type !== textSchema.topNodeType) throw new OpenDocexError('DOCUMENT_FAULTED', 'Text snapshot root is not doc');
  if (!pageSettingsFit(getPageSettings(doc))) {
    throw new OpenDocexError('DOCUMENT_FAULTED', 'Text snapshot margins do not fit the page');
  }
  let cellsFit = true;
  doc.descendants((node) => {
    if (!cellsFit) return false;
    if ((node.type.name === 'table_cell' || node.type.name === 'table_header') && !colwidthFits(node)) cellsFit = false;
    return cellsFit;
  });
  if (!cellsFit) throw new OpenDocexError('DOCUMENT_FAULTED', 'Text snapshot colwidth does not match colspan');
  return doc;
}

/** The OT Strategy for text documents (§8.5). Every method is pure and deterministic. */
export const TextOtType: OtType<TextSnapshot, TextOp, TextChunkData> = Object.freeze({
  kind: 'text' as const,
  apply: applyTextOps,
  rebase: (ops: TextOp[], over: TextOp[]): TextOp[] =>
    rebaseSteps(parseTextOps(ops), parseTextOps(over)).map((s) => s.toJSON() as TextOp),
  validateOps: validateTextOps,
  serializeSnapshot: (doc: TextSnapshot): unknown => doc.toJSON(),
  deserializeSnapshot: deserializeText,
  chunk: chunkText,
  assemble: assembleText,
});
