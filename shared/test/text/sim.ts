/**
 * A small server/client simulation of the text sync path (LLD Part 1 §8.3–§8.6), used by
 * the concurrency scenarios and the S5 equivalence enumeration.
 *
 * - Server: `rebaseStepsOnDoc(batch, committed-since-base, head)` (§0 R-6).
 * - Client: on a remote, invert pending, apply the remote, `rebaseStepsOnDoc(pending,
 *   remote, doc)`. On an ack, compare `committed` with the in-flight steps with
 *   `textOpsEqual`; if different, invert in-flight and apply `committed` (the echo).
 */
import type { Node as PMNode } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import type { Step } from 'prosemirror-transform';
import { textOpsEqual } from '../../src/text/equal.js';
import { rebaseStepsOnDoc } from '../../src/text/rebase.js';
import { textSchema } from '../../src/text/schema.js';
import type { TextOp } from '../../src/text/steps.js';
import { A4 } from './fixtures.js';

/** A body-only document with one paragraph per text (an empty string gives an empty paragraph). */
export function bodyDoc(...texts: string[]): PMNode {
  return textSchema.nodeFromJSON({
    type: 'doc',
    attrs: A4,
    content: [
      {
        type: 'body',
        content: texts.map((t) => ({ type: 'paragraph', ...(t ? { content: [{ type: 'text', text: t }] } : {}) })),
      },
    ],
  });
}

export const json = (steps: readonly Step[]): TextOp[] => steps.map((s) => s.toJSON() as TextOp);

/** Texts of the body's paragraphs, for readable assertions. */
export function texts(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (n.isTextblock) {
      out.push(n.textContent);
      return false;
    }
    return true;
  });
  return out;
}

export class SimServer {
  head: PMNode;
  /** Committed steps per rev (index = rev - 1). */
  readonly log: Step[][] = [];
  constructor(doc: PMNode) {
    this.head = doc;
  }
  /** Commits a batch made at `baseRev`. Returns the committed (rebased, applied) steps. */
  submit(steps: readonly Step[], baseRev: number): Step[] {
    const over = this.log.slice(baseRev).flat();
    const r = rebaseStepsOnDoc(steps, over, this.head);
    this.head = r.doc;
    this.log.push(r.steps);
    return r.steps;
  }
}

export class SimClient {
  /** The document as confirmed by the server. */
  conf: PMNode;
  /** The document the user sees: `conf` plus `pending`. */
  doc: PMNode;
  pending: Step[] = [];
  rev = 0;
  echoCorrections = 0;
  constructor(doc: PMNode) {
    this.conf = doc;
    this.doc = doc;
  }

  /** A local edit; each step must apply. */
  edit(steps: readonly Step[]): void {
    const tr = new Transform(this.doc);
    for (const s of steps) tr.step(s);
    this.doc = tr.doc;
    this.pending.push(...steps);
  }

  /** A transform from `doc` that inverts the pending steps; its doc equals `conf`. */
  private invertPending(): Transform {
    const before: PMNode[] = [];
    let d = this.conf;
    for (const s of this.pending) {
      before.push(d);
      const r = s.apply(d);
      if (!r.doc) throw new Error('pending step does not apply');
      d = r.doc;
    }
    const tr = new Transform(this.doc);
    for (let i = this.pending.length - 1; i >= 0; i--) {
      tr.step((this.pending[i] as Step).invert(before[i] as PMNode));
    }
    if (!tr.doc.eq(this.conf)) throw new Error('inverting pending did not reach conf');
    return tr;
  }

  remote(steps: readonly Step[]): void {
    const tr = this.invertPending();
    for (const s of steps) tr.step(s);
    this.conf = tr.doc;
    this.rev += 1;
    const r = rebaseStepsOnDoc(this.pending, steps, this.conf);
    this.pending = r.steps;
    this.doc = r.doc;
  }

  ack(committed: readonly Step[]): void {
    if (!textOpsEqual(json(committed), json(this.pending))) {
      this.echoCorrections += 1;
      const tr = this.invertPending();
      for (const s of committed) tr.step(s);
      this.doc = tr.doc;
    }
    this.conf = this.doc;
    this.pending = [];
    this.rev += 1;
  }
}

export interface PairResult {
  server: PMNode;
  a: PMNode;
  b: PMNode;
  committedA: Step[];
  committedB: Step[];
  /** B's in-flight steps after its own rebase over A, before B's ack. */
  bRebased: Step[];
  echoCorrections: number;
}

/**
 * A and B edit the same `base` concurrently; the server receives A's batch first. A gets
 * its ack, then B's remote. B gets A's remote, then its ack.
 */
export function runPair(base: PMNode, a: readonly Step[], b: readonly Step[]): PairResult {
  const server = new SimServer(base);
  const A = new SimClient(base);
  const B = new SimClient(base);
  A.edit(a);
  B.edit(b);
  const committedA = server.submit(A.pending, A.rev);
  const committedB = server.submit(B.pending, B.rev);
  A.ack(committedA);
  A.remote(committedB);
  B.remote(committedA);
  const bRebased = B.pending.slice();
  B.ack(committedB);
  return {
    server: server.head,
    a: A.doc,
    b: B.doc,
    committedA,
    committedB,
    bRebased,
    echoCorrections: A.echoCorrections + B.echoCorrections,
  };
}
