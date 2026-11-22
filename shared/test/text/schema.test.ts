import { Node as PMNode } from 'prosemirror-model';
import { DocAttrStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { getPageSettings, pageSettingStep, pageSettingsFit } from '../../src/text/page.js';
import { textSchema } from '../../src/text/schema.js';
import { A4, ASSET, everythingJson, para } from './fixtures.js';

const s = textSchema;

/** Builds a doc from JSON and runs the full content/attribute check. */
function load(json: unknown): PMNode {
  const doc = PMNode.fromJSON(s, json);
  doc.check();
  return doc;
}

function docWith(bodyBlocks: unknown[], docAttrs: Record<string, unknown> = A4): unknown {
  return { type: 'doc', attrs: docAttrs, content: [{ type: 'body', content: bodyBlocks }] };
}

describe('textSchema JSON round trip', () => {
  it('round-trips a document using every node, mark and attribute', () => {
    const doc = load(everythingJson());
    const json: unknown = JSON.parse(JSON.stringify(doc.toJSON()));
    const back = load(json);
    expect(back.eq(doc)).toBe(true);
    expect(back.toJSON()).toEqual(json);
    expect(back.child(1).child(0).attrs).toMatchObject({ indentFirstLine: -14.5, lineHeight: { kind: 'exact', pt: 18 } });
  });

  it('covers every node and mark type of the schema', () => {
    const doc = load(everythingJson());
    const nodeTypes = new Set<string>([doc.type.name]);
    const markTypes = new Set<string>();
    doc.descendants((n) => {
      nodeTypes.add(n.type.name);
      n.marks.forEach((m) => markTypes.add(m.type.name));
    });
    expect([...nodeTypes].sort()).toEqual(Object.keys(s.nodes).sort());
    expect([...markTypes].sort()).toEqual(Object.keys(s.marks).sort());
  });

  it('gives defaults: all-null textDefaults, left align, null formatting', () => {
    const doc = load(docWith([para('x')]));
    expect(doc.attrs.textDefaults).toEqual({ fontFamily: null, fontSize: null, color: null });
    expect(doc.firstChild?.firstChild?.attrs).toEqual({
      align: 'left',
      spacingBefore: null,
      spacingAfter: null,
      lineHeight: null,
      indentLeft: null,
      indentRight: null,
      indentFirstLine: null,
    });
    expect(Object.keys(s.marks)).toEqual(['link', 'bold', 'italic', 'underline', 'strike', 'text_style']);
  });
});

describe('textSchema structure', () => {
  it('requires a body and allows page_break only in the body', () => {
    expect(() => load({ type: 'doc', attrs: A4, content: [{ type: 'header', content: [para('h')] }] })).toThrow();
    expect(() => load(docWith([{ type: 'bullet_list', content: [{ type: 'list_item', content: [para('a'), { type: 'page_break' }] }] }]))).toThrow();
    expect(() =>
      load({ type: 'doc', attrs: A4, content: [{ type: 'header', content: [{ type: 'page_break' }] }, { type: 'body', content: [para('x')] }] }),
    ).toThrow();
  });

  it('requires the doc page attributes', () => {
    expect(() => s.nodes.doc.create({}, s.nodes.body.create(null, s.nodes.paragraph.create()))).toThrow(RangeError);
  });
});

describe('textSchema attribute validators', () => {
  const cell = (attrs: Record<string, unknown>): unknown =>
    docWith([{ type: 'table', content: [{ type: 'table_row', content: [{ type: 'table_cell', attrs, content: [para('a')] }] }] }]);

  it.each([0, 1.5, Number.NaN, 1001, '2'])('rejects colspan %p', (colspan) => {
    expect(() => s.nodes.table_cell.create({ colspan }, s.nodes.paragraph.create())).toThrow(RangeError);
    expect(() => s.nodes.table_header.create({ rowspan: colspan }, s.nodes.paragraph.create())).toThrow(RangeError);
  });

  it('accepts colspan/rowspan 1 and 1000', () => {
    expect(() => load(cell({ colspan: 1000, rowspan: 1000 }))).not.toThrow();
  });

  it.each([[[]], [[0]], [[1.5]], [[10_001]], ['100'], [[100, 'x']]])('rejects colwidth %j', (colwidth) => {
    expect(() => load(cell({ colwidth }))).toThrow(RangeError);
  });

  it('accepts colwidth null and px integers 1–10000', () => {
    expect(() => load(cell({ colwidth: null }))).not.toThrow();
    expect(() => load(cell({ colwidth: [1, 10_000], colspan: 2 }))).not.toThrow();
  });

  it.each([
    ['margin above 1000', { ...A4, margins: { ...A4.margins, top: 1001 } }],
    ['negative margin', { ...A4, margins: { ...A4.margins, left: -1 } }],
    ['missing margin', { ...A4, margins: { top: 1, right: 1, bottom: 1 } }],
    ['extra margin key', { ...A4, margins: { ...A4.margins, gutter: 1 } }],
    ['page too small', { ...A4, size: { width: 35, height: 800 } }],
    ['page too large', { ...A4, size: { width: 600, height: 4001 } }],
    ['non-finite size', { ...A4, size: { width: Infinity, height: 800 } }],
    ['orientation', { ...A4, orientation: 'sideways' }],
  ])('rejects doc attributes: %s', (_label, attrs) => {
    expect(() => load(docWith([para('x')], attrs))).toThrow(RangeError);
  });

  it.each([
    ['CSS injection in fontFamily', { fontFamily: 'a;background:url(x)', fontSize: null, color: null }],
    ['fontSize 0', { fontFamily: null, fontSize: 0, color: null }],
    ['uppercase color', { fontFamily: null, fontSize: null, color: '#FFFFFF' }],
    ['missing key', { fontFamily: null, fontSize: null }],
    ['extra key', { fontFamily: null, fontSize: null, color: null, x: 1 }],
    ['null', null],
  ])('rejects textDefaults: %s', (_label, textDefaults) => {
    expect(() => load(docWith([para('x')], { ...A4, textDefaults }))).toThrow(RangeError);
  });

  it.each([
    ['CSS injection', { fontFamily: 'a;background:url(x)' }],
    ['quote in family', { fontFamily: 'a"b' }],
    ['family over 64 chars', { fontFamily: 'a'.repeat(65) }],
    ['fontSize over 1638', { fontSize: 1639 }],
    ['color name', { color: 'red' }],
  ])('rejects text_style: %s', (_label, attrs) => {
    expect(() => s.marks.text_style.create(attrs)).toThrow(RangeError);
  });

  it('accepts a text_style family with letters, digits and allowed punctuation', () => {
    expect(() => s.marks.text_style.create({ fontFamily: 'Noto Sans (CJK) & 中文 1.0+_-', fontSize: 1, color: '#000000' })).not.toThrow();
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', '/relative', ''])('rejects link href %p', (href) => {
    expect(() => s.marks.link.create({ href })).toThrow(RangeError);
  });

  it.each([
    ['spacingBefore', -1],
    ['spacingAfter', 1585],
    ['indentLeft', -0.5],
    ['indentRight', Number.NaN],
    ['indentFirstLine', -1585],
    ['indentFirstLine', 1585],
    ['lineHeight', { kind: 'multiple', value: 0.4 }],
    ['lineHeight', { kind: 'multiple', value: 10.5 }],
    ['lineHeight', { kind: 'exact', pt: 0 }],
    ['lineHeight', { kind: 'atLeast', pt: 1585 }],
    ['lineHeight', { kind: 'exact', value: 2 }],
    ['lineHeight', { kind: 'multiple', value: 2, pt: 3 }],
    ['lineHeight', 1.5],
    ['align', 'start'],
  ])('rejects paragraph/heading %s = %j', (attr, value) => {
    expect(() => s.nodes.paragraph.create({ [attr]: value })).toThrow(RangeError);
    expect(() => s.nodes.heading.create({ [attr]: value })).toThrow(RangeError);
  });

  it('accepts the formatting range ends and a hanging indent', () => {
    const attrs = { spacingBefore: 0, spacingAfter: 1584, indentLeft: 0, indentRight: 1584, indentFirstLine: -1584 };
    expect(() => s.nodes.paragraph.create(attrs).check()).not.toThrow();
    expect(() => s.nodes.heading.create({ ...attrs, level: 6, lineHeight: { kind: 'multiple', value: 0.5 } }).check()).not.toThrow();
  });

  it.each([0, 7, 1.5])('rejects heading level %p', (level) => {
    expect(() => s.nodes.heading.create({ level })).toThrow(RangeError);
  });

  it.each([-1, 1.5, 1_000_001])('rejects ordered_list order %p', (order) => {
    expect(() => s.nodes.ordered_list.create({ order }, s.nodes.list_item.create(null, s.nodes.paragraph.create()))).toThrow(RangeError);
  });

  it.each([
    ['bad assetId', { assetId: 'nope' }],
    ['missing assetId', {}],
    ['long alt', { assetId: ASSET, alt: 'x'.repeat(1001) }],
    ['width 0', { assetId: ASSET, width: 0 }],
    ['height over 10000', { assetId: ASSET, height: 10_001 }],
  ])('rejects image: %s', (_label, attrs) => {
    expect(() => s.nodes.image.create(attrs)).toThrow(RangeError);
  });

  it.each([undefined, 'date', 1])('rejects page_field kind %p', (kind) => {
    expect(() => s.nodes.page_field.create(kind === undefined ? {} : { kind })).toThrow(RangeError);
  });
});

describe('page settings', () => {
  it('reads the page settings from the doc attributes', () => {
    expect(getPageSettings(load(docWith([para('x')])))).toEqual(A4);
  });

  it('builds a DocAttrStep that sets one attribute', () => {
    const doc = load(docWith([para('x')]));
    const step = pageSettingStep('orientation', 'landscape');
    expect(step).toBeInstanceOf(DocAttrStep);
    const r = step.apply(doc);
    expect(r.doc?.attrs.orientation).toBe('landscape');
    expect(r.doc?.attrs.margins).toEqual(A4.margins);
  });

  it('checks that margins leave at least 36 pt of body', () => {
    const size = { width: 200, height: 300 };
    expect(pageSettingsFit({ ...A4, size, margins: { top: 132, bottom: 132, left: 82, right: 82 } })).toBe(true);
    expect(pageSettingsFit({ ...A4, size, margins: { top: 0, bottom: 0, left: 82, right: 82.5 } })).toBe(false);
    expect(pageSettingsFit({ ...A4, size, margins: { top: 133, bottom: 132, left: 0, right: 0 } })).toBe(false);
  });
});
