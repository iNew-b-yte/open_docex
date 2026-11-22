import { Fragment, Slice } from 'prosemirror-model';
import type { Node as PMNode } from 'prosemirror-model';
import { AttrStep, DocAttrStep, ReplaceStep, Step, Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { applyStepsWithDrop } from '../../src/text/apply.js';
import { textSchema } from '../../src/text/schema.js';
import { A4, para } from './fixtures.js';
import { bodyDoc, json, texts } from './sim.js';

const T = (t: string): PMNode => textSchema.text(t);
const insert = (pos: number, nodes: PMNode[] | Fragment, openStart = 0, openEnd = 0): ReplaceStep =>
  new ReplaceStep(pos, pos, new Slice(Fragment.from(nodes), openStart, openEnd));
const fromJson = (j: Record<string, unknown>): PMNode => textSchema.nodeFromJSON(j);

function run(doc: PMNode, steps: Step[]): { doc: PMNode; applied: Step[]; dropped: number; tr: Transform } {
  const tr = new Transform(doc);
  const r = applyStepsWithDrop(tr, steps);
  expect(r.applied.length + r.dropped).toBe(steps.length); // L2
  return { doc: tr.doc, ...r, tr };
}

const field = (kind: 'number' | 'count' = 'number'): PMNode => textSchema.nodes.page_field.create({ kind });

/** header "h", body "b" + a 1Ã—1 table with cell "c", footer "f". */
function regionsDoc(): PMNode {
  return fromJson({
    type: 'doc',
    attrs: A4,
    content: [
      { type: 'header', content: [para('h')] },
      {
        type: 'body',
        content: [
          para('b'),
          { type: 'table', content: [{ type: 'table_row', content: [{ type: 'table_cell', content: [para('c')] }] }] },
        ],
      },
      { type: 'footer', content: [para('f')] },
    ],
  });
}
// header 0, para 1, "h" 2..3, header end 5. body 5, para 6, "b" 7..8, para end 9,
// table 9, row 10, cell 11, para 12, "c" 13..14, â€¦ body end 19. footer 19, para 20, "f" 21..22.

describe('applyStepsWithDrop', () => {
  it('applies valid steps through tr.step, so the transform tracks them', () => {
    const doc = bodyDoc('ab');
    const s = [insert(3, [T('x')]), insert(4, [T('y')])];
    const r = run(doc, s);
    expect(r.dropped).toBe(0);
    expect(texts(r.doc)).toEqual(['axyb']);
    expect(json(r.tr.steps)).toEqual(json(r.applied));
  });

  it('applies nothing for an empty list', () => {
    const doc = bodyDoc('ab');
    const r = run(doc, []);
    expect(r.doc).toBe(doc);
    expect(r.dropped).toBe(0);
  });

  it('drops out-of-range positions without throwing', () => {
    const doc = bodyDoc('ab');
    const r = run(doc, [insert(3, [T('y')]), insert(1000, [T('x')]), new ReplaceStep(2, 999, Slice.empty)]);
    expect(r.dropped).toBe(2);
    expect(texts(r.doc)).toEqual(['ayb']);
  });

  it('drops a table inserted directly into a paragraph', () => {
    const doc = bodyDoc('ab');
    const table = fromJson({ type: 'table', content: [{ type: 'table_row', content: [{ type: 'table_cell', content: [para('c')] }] }] });
    const r = run(doc, [insert(3, [table])]);
    expect(r.dropped).toBe(1);
    expect(r.doc.eq(doc)).toBe(true);
  });

  it('drops a crafted slice whose inner node holds a table (replace does not check inner nodes)', () => {
    const doc = bodyDoc('ab');
    // Node.fromJSON does not check content, so this paragraph-with-a-table parses.
    const bad = fromJson({
      type: 'paragraph',
      content: [{ type: 'table', content: [{ type: 'table_row', content: [{ type: 'table_cell', content: [para('c')] }] }] }],
    });
    const step = insert(5, [bad]); // between the body's paragraphs: the top level fits
    expect(step.apply(doc).failed).toBeNull();
    const r = run(doc, [step]);
    expect(r.dropped).toBe(1);
  });

  it('drops text with an invalid mark set and a block with a disallowed mark', () => {
    const doc = bodyDoc('ab');
    const b = textSchema.marks.bold.create();
    const dup = textSchema.text('x', [b, b]);
    const markedImage = textSchema.nodes.image.create({ assetId: 'a'.repeat(64) }, null, [b]);
    const r = run(doc, [insert(3, [dup]), insert(5, [markedImage])]);
    expect(r.dropped).toBe(2);
    expect(r.doc.eq(doc)).toBe(true);
  });

  it('drops an attr step whose value fails the attribute validator', () => {
    const doc = bodyDoc('ab');
    const r = run(doc, [new AttrStep(1, 'align', 'bogus'), new AttrStep(1, 'align', 'center')]);
    expect(r.dropped).toBe(1);
    expect(r.doc.child(0).child(0).attrs.align).toBe('center');
  });

  it('drops the dependents of a dropped insert and keeps independent steps', () => {
    const doc = bodyDoc('ab', 'cd');
    // s1 inserts "xy" + a page_field into the body (rejected, Â§0 S-20); s2 types inside
    // s1's content; s3 types in the second paragraph, positioned after s1 and s2.
    const s1 = insert(3, [T('xy'), field()]);
    const s2 = insert(4, [T('Z')]);
    const s3 = insert(11, [T('Y')]);
    const r = run(doc, [s1, s2, s3]);
    expect(r.dropped).toBe(2);
    expect(texts(r.doc)).toEqual(['ab', 'cYd']);
    expect(json(r.applied)).toEqual(json([insert(7, [T('Y')])]));
  });

  it('keeps ReplaceStep.MAP_BIAS at 1 (Â§8.3)', () => {
    expect(ReplaceStep.MAP_BIAS).toBe(1);
  });
});

describe('applyStepsWithDrop: page_field only in header/footer (Â§0 S-20)', () => {
  it('accepts a page_field in the header and the footer', () => {
    const doc = regionsDoc();
    const r = run(doc, [insert(3, [field('number')]), insert(23, [field('count')])]);
    expect(r.dropped).toBe(0);
  });

  it('drops a page_field in the body and in a body table cell', () => {
    const doc = regionsDoc();
    const r = run(doc, [insert(8, [field()]), insert(14, [field()])]);
    expect(r.dropped).toBe(2);
    expect(r.doc.eq(doc)).toBe(true);
  });

  it('drops a body paragraph slice that carries a page_field inside it', () => {
    const doc = regionsDoc();
    const p = textSchema.nodes.paragraph.create(null, [T('p'), field()]);
    const r = run(doc, [insert(9, [p])]);
    expect(r.dropped).toBe(1);
  });
});

describe('applyStepsWithDrop: cross-attribute rules (Â§0 S-27)', () => {
  const tableDoc = (cell: Record<string, unknown>): PMNode =>
    fromJson({
      type: 'doc',
      attrs: A4,
      content: [
        {
          type: 'body',
          content: [{ type: 'table', content: [{ type: 'table_row', content: [{ type: 'table_cell', attrs: cell, content: [para('c')] }] }] }],
        },
      ],
    });
  // body 0, table 1, row 2, cell 3.

  it('drops an attr step that leaves colwidth length â‰  colspan', () => {
    const doc = tableDoc({ colspan: 1, colwidth: [100] });
    const r = run(doc, [new AttrStep(3, 'colspan', 2), new AttrStep(3, 'colwidth', [100, 120, 140])]);
    expect(r.dropped).toBe(2);
  });

  it('accepts colwidth and colspan changed together in order', () => {
    const doc = tableDoc({ colspan: 1, colwidth: null });
    const r = run(doc, [new AttrStep(3, 'colspan', 2), new AttrStep(3, 'colwidth', [100, 120])]);
    expect(r.dropped).toBe(0);
  });

  it('drops an inserted table whose cell colwidth does not match colspan', () => {
    const doc = bodyDoc('ab');
    const table = fromJson({
      type: 'table',
      content: [{ type: 'table_row', content: [{ type: 'table_cell', attrs: { colspan: 2, colwidth: [100] }, content: [para('c')] }] }],
    });
    const r = run(doc, [insert(5, [table])]);
    expect(r.dropped).toBe(1);
  });

  it('drops a docAttr step whose margins do not fit the page, and keeps one that fits', () => {
    const doc = bodyDoc('ab');
    const tooWide = { top: 72, right: 300, bottom: 72, left: 300 }; // 600 > 595.28 âˆ’ 36
    const ok = { top: 72, right: 200, bottom: 72, left: 200 };
    const r = run(doc, [new DocAttrStep('margins', tooWide), new DocAttrStep('margins', ok)]);
    expect(r.dropped).toBe(1);
    expect(r.doc.attrs.margins).toEqual(ok);
  });

  it('drops a docAttr step that shrinks the page under the margins', () => {
    const doc = bodyDoc('ab');
    const r = run(doc, [new DocAttrStep('size', { width: 150, height: 841.89 })]);
    expect(r.dropped).toBe(1);
  });

  it('drops a step that parses but fails on an attribute validator in apply', () => {
    const doc = bodyDoc('ab');
    const step = Step.fromJSON(textSchema, { stepType: 'docAttr', attr: 'orientation', value: 'sideways' });
    const r = run(doc, [step]);
    expect(r.dropped).toBe(1);
  });
});
