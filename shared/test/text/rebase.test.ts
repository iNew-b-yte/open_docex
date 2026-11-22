import { Fragment, Slice } from 'prosemirror-model';
import type { Node as PMNode } from 'prosemirror-model';
import { ReplaceStep, Transform } from 'prosemirror-transform';
import type { Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { rebaseOverMaps, rebaseSteps, rebaseStepsOnDoc } from '../../src/text/rebase.js';
import { textSchema } from '../../src/text/schema.js';
import { A4, para } from './fixtures.js';
import { bodyDoc, json, runPair, texts } from './sim.js';
import type { PairResult } from './sim.js';

const steps = (doc: PMNode, f: (tr: Transform) => void): Step[] => {
  const tr = new Transform(doc);
  f(tr);
  return tr.steps;
};

function expectConverged(r: PairResult): void {
  expect(r.a.eq(r.server)).toBe(true);
  expect(r.b.eq(r.server)).toBe(true);
}

const bold = textSchema.marks.bold.create();

describe('rebaseSteps: fixed concurrency scenarios', () => {
  it('BRD §3 "cat": both inserts after "c" are kept, FIFO-earlier first', () => {
    const base = bodyDoc('cat');
    const r = runPair(
      base,
      steps(base, (tr) => tr.insert(3, textSchema.text('h'))),
      steps(base, (tr) => tr.insert(3, textSchema.text('o'))),
    );
    expectConverged(r);
    expect(texts(r.server)).toEqual(['choat']);
    expect(r.echoCorrections).toBe(0);
  });

  it('drops an insert inside a concurrently deleted range', () => {
    const base = bodyDoc('abcdef');
    const r = runPair(
      base,
      steps(base, (tr) => tr.delete(3, 7)),
      steps(base, (tr) => tr.insert(5, textSchema.text('X'))),
    );
    expectConverged(r);
    expect(texts(r.server)).toEqual(['af']);
    expect(r.committedB).toEqual([]);
  });

  it('merges overlapping deletes', () => {
    const base = bodyDoc('abcdef');
    const r = runPair(
      base,
      steps(base, (tr) => tr.delete(3, 6)),
      steps(base, (tr) => tr.delete(4, 7)),
    );
    expectConverged(r);
    expect(texts(r.server)).toEqual(['af']);
  });

  it('keeps addMark on the text that survives a concurrent delete', () => {
    const base = bodyDoc('abcdef');
    const r = runPair(
      base,
      steps(base, (tr) => tr.delete(3, 5)),
      steps(base, (tr) => tr.addMark(2, 7, bold)),
    );
    expectConverged(r);
    expect(texts(r.server)).toEqual(['adef']);
    const marked: string[] = [];
    r.server.descendants((n) => {
      if (n.isText && bold.isInSet(n.marks)) marked.push(n.text ?? '');
    });
    expect(marked.join('')).toBe('ade');
  });

  it('split paragraph vs typing at the split point', () => {
    const base = bodyDoc('abcd');
    const r = runPair(
      base,
      steps(base, (tr) => tr.split(4)),
      steps(base, (tr) => tr.insert(4, textSchema.text('X'))),
    );
    expectConverged(r);
    expect(texts(r.server)).toEqual(['ab', 'Xcd']);
  });

  it('typing vs split at the same point, split second', () => {
    const base = bodyDoc('abcd');
    const r = runPair(
      base,
      steps(base, (tr) => tr.insert(4, textSchema.text('X'))),
      steps(base, (tr) => tr.split(4)),
    );
    expectConverged(r);
    expect(texts(r.server)).toEqual(['abX', 'cd']);
  });

  it('edits in different table cells both survive', () => {
    const base = textSchema.nodeFromJSON({
      type: 'doc',
      attrs: A4,
      content: [
        {
          type: 'body',
          content: [
            {
              type: 'table',
              content: [
                { type: 'table_row', content: [{ type: 'table_cell', content: [para('a')] }, { type: 'table_cell', content: [para('b')] }] },
              ],
            },
          ],
        },
      ],
    });
    // body 0, table 1, row 2, cell 3, para 4, "a" 5..6; cell2 at 8, para 9, "b" 10..11.
    expect(base.textBetween(5, 6)).toBe('a');
    expect(base.textBetween(10, 11)).toBe('b');
    const r = runPair(
      base,
      steps(base, (tr) => tr.insert(6, textSchema.text('1'))),
      steps(base, (tr) => tr.insert(11, textSchema.text('2'))),
    );
    expectConverged(r);
    expect(texts(r.server)).toEqual(['a1', 'b2']);
  });

  it('drops an attr step on a concurrently deleted node', () => {
    const base = bodyDoc('ab', 'cd');
    const r = runPair(
      base,
      steps(base, (tr) => tr.delete(5, 9)),
      steps(base, (tr) => tr.setNodeAttribute(5, 'align', 'center')),
    );
    expectConverged(r);
    expect(texts(r.server)).toEqual(['ab']);
    expect(r.committedB).toEqual([]);
  });

  it('concurrent docAttr on the same key: the later one wins', () => {
    const base = bodyDoc('ab');
    const mA = { top: 50, right: 50, bottom: 50, left: 50 };
    const mB = { top: 60, right: 60, bottom: 60, left: 60 };
    const r = runPair(
      base,
      steps(base, (tr) => tr.setDocAttribute('margins', mA)),
      steps(base, (tr) => tr.setDocAttribute('margins', mB)),
    );
    expectConverged(r);
    expect(r.server.attrs.margins).toEqual(mB);
  });

  it('concurrent docAttr on different keys keeps both', () => {
    const base = bodyDoc('ab');
    const m = { top: 60, right: 60, bottom: 60, left: 60 };
    const r = runPair(
      base,
      steps(base, (tr) => tr.setDocAttribute('margins', m)),
      steps(base, (tr) => tr.setDocAttribute('orientation', 'landscape')),
    );
    expectConverged(r);
    expect(r.server.attrs.margins).toEqual(m);
    expect(r.server.attrs.orientation).toBe('landscape');
  });

  it('header vs body edits both survive', () => {
    const base = textSchema.nodeFromJSON({
      type: 'doc',
      attrs: A4,
      content: [
        { type: 'header', content: [para('h')] },
        { type: 'body', content: [para('b')] },
      ],
    });
    // header 0, para 1, "h" 2..3; body 5, para 6, "b" 7..8.
    const r = runPair(
      base,
      steps(base, (tr) => tr.insert(3, textSchema.text('1'))),
      steps(base, (tr) => tr.insert(8, textSchema.text('2'))),
    );
    expectConverged(r);
    expect(texts(r.server)).toEqual(['h1', 'b2']);
  });

  it('a step dropped on apply takes its dependents with it, and the echo converges', () => {
    const base = bodyDoc('ab', 'cd');
    // s1 puts a page_field in the body (§0 S-20: rejected by apply), s2 types inside
    // s1's insert (a dependent), s3 types in the other paragraph (independent).
    const field = textSchema.nodes.page_field.create({ kind: 'number' });
    const s1 = new ReplaceStep(3, 3, new Slice(Fragment.from([textSchema.text('xy'), field]), 0, 0));
    const tr = new Transform(base);
    tr.step(s1);
    tr.insert(4, textSchema.text('Z'));
    tr.insert(11, textSchema.text('Y'));
    const b = tr.steps;
    const a = steps(base, (t) => t.insert(2, textSchema.text('A')));

    const direct = rebaseStepsOnDoc(b, a, a[0]!.apply(base).doc!);
    expect(direct.kept).toEqual([2]);
    expect(texts(direct.doc)).toEqual(['Aab', 'cYd']);

    const r = runPair(base, a, b);
    expectConverged(r);
    expect(texts(r.server)).toEqual(['Aab', 'cYd']);
    expect(r.committedB).toHaveLength(1);
  });
});

describe('rebaseSteps properties', () => {
  it('is mapping-only: rebaseSteps equals rebaseOverMaps over the step maps', () => {
    const base = bodyDoc('abcd', 'efgh');
    const mine = steps(base, (tr) => tr.insert(3, textSchema.text('x')).split(5));
    const over = steps(base, (tr) => tr.delete(2, 4).insert(8, textSchema.text('y')));
    expect(json(rebaseSteps(mine, over))).toEqual(
      json(
        rebaseOverMaps(
          mine,
          over.map((s) => s.getMap()),
        ),
      ),
    );
  });

  it('keeps content of earlier own steps when a later step is typed inside it', () => {
    const base = bodyDoc('abcd');
    const mine = steps(base, (tr) => tr.insert(3, textSchema.text('XY')).insert(4, textSchema.text('Z')));
    const over = steps(base, (tr) => tr.insert(5, textSchema.text('q')));
    const out = rebaseSteps(mine, over);
    const tr = new Transform(base);
    over.forEach((s) => tr.step(s));
    out.forEach((s) => tr.step(s));
    expect(texts(tr.doc)).toEqual(['aXZYbcqd']);
  });

  it('prefix consistency: rebaseSteps([...A, ...B], R) starts with rebaseSteps(A, R)', () => {
    const base = bodyDoc('abcdef', 'ghij', 'klm');
    const locals: Step[][] = [
      steps(base, (tr) => tr.insert(3, textSchema.text('x')).insert(4, textSchema.text('y')).delete(2, 3).split(4).addMark(2, 6, bold)),
      steps(base, (tr) => tr.delete(3, 7).insert(3, textSchema.text('z')).insert(4, textSchema.text('w'))),
      steps(base, (tr) => tr.split(5).insert(7, textSchema.text('q')).setNodeAttribute(1, 'align', 'right')),
      steps(base, (tr) => tr.insert(18, textSchema.text('HI')).delete(10, 13).split(3)),
    ];
    const overs: Step[][] = [
      [],
      steps(base, (tr) => tr.insert(3, textSchema.text('r'))),
      steps(base, (tr) => tr.delete(2, 6)),
      steps(base, (tr) => tr.split(4).addMark(2, 12, bold)),
      steps(base, (tr) => tr.delete(1, 17)),
      steps(base, (tr) => tr.setNodeAttribute(1, 'align', 'center').insert(12, textSchema.text('s'))),
    ];
    let checked = 0;
    for (const local of locals) {
      for (const R of overs) {
        const whole = json(rebaseSteps(local, R));
        for (let k = 0; k <= local.length; k++) {
          const prefix = json(rebaseSteps(local.slice(0, k), R));
          expect(whole.slice(0, prefix.length)).toEqual(prefix);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('rebaseStepsOnDoc is deterministic and reports kept indices', () => {
    const base = bodyDoc('abcdef');
    const mine = steps(base, (tr) => tr.insert(5, textSchema.text('X')).insert(8, textSchema.text('Y')));
    const over = steps(base, (tr) => tr.delete(3, 7));
    const head = over[0]!.apply(base).doc!;
    const r1 = rebaseStepsOnDoc(mine, over, head);
    const r2 = rebaseStepsOnDoc(mine, over, head);
    expect(json(r1.steps)).toEqual(json(r2.steps));
    expect(r1.doc.eq(r2.doc)).toBe(true);
    expect(r1.kept).toEqual([1]);
    expect(texts(r1.doc)).toEqual(['aYf']);
  });
});
