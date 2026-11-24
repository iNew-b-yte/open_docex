import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TextOtType } from '@open-docex/shared/text';
import { mergeFindings } from '../../../src/codec/codec-service.js';
import { FodtMapper } from '../../../src/codec/fodt-mapper.js';
import { engineError } from '../../../src/errors/engine-error.js';
import {
  bodyOf,
  exportFodt,
  fodt,
  GIF_1x1,
  importFodt,
  model,
  para,
  paraAttrs,
  PNG_1x1,
  textOf,
  type Node,
} from './fodt-helpers.js';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

describe('FodtMapper import: styles and marks (§14.5 style resolution, R-14, L-10)', () => {
  it('puts the default run style in textDefaults and emits marks only where a run differs from it', async () => {
    const { doc } = await importFodt({
      styles:
        '<style:style style:name="Standard" style:family="paragraph"/>' +
        '<style:style style:name="Title" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:font-weight="bold" fo:font-size="11pt"/></style:style>',
      auto:
        '<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Title"/>' +
        '<style:style style:name="T1" style:family="text"><style:text-properties fo:font-style="italic" style:text-underline-style="solid" style:text-line-through-style="solid"/></style:style>' +
        '<style:style style:name="T2" style:family="text"><style:text-properties fo:font-size="18pt" fo:color="#C00000" fo:font-family="\'DejaVu Sans\'"/></style:style>',
      body:
        '<text:p text:style-name="Standard">plain <text:span text:style-name="T1">ius</text:span><text:span text:style-name="T2">big</text:span></text:p>' +
        '<text:p text:style-name="P1">title</text:p>',
    });
    expect(doc.attrs['textDefaults']).toEqual({ fontFamily: 'Liberation Sans', fontSize: 11, color: '#333333' });
    const [p1, p2] = bodyOf(doc);
    expect(p1?.content).toEqual([
      { type: 'text', text: 'plain ' },
      { type: 'text', text: 'ius', marks: [{ type: 'italic' }, { type: 'underline' }, { type: 'strike' }] },
      { type: 'text', text: 'big', marks: [{ type: 'text_style', attrs: { fontFamily: 'DejaVu Sans', fontSize: 18, color: '#c00000' } }] },
    ]);
    // A named style other than a heading is flattened: its bold becomes a mark (L-10).
    expect(p2?.content).toEqual([{ type: 'text', text: 'title', marks: [{ type: 'bold' }] }]);
  });

  it('does not turn properties of a heading style into marks (the level carries them)', async () => {
    const { doc } = await importFodt({
      styles:
        '<style:style style:name="Heading_20_1" style:family="paragraph" style:default-outline-level="1"><style:text-properties fo:font-weight="bold" fo:font-size="20pt" fo:color="#0000ff"/></style:style>',
      auto: '<style:style style:name="T1" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>',
      body: '<text:h text:style-name="Heading_20_1" text:outline-level="1">Big <text:span text:style-name="T1">it</text:span></text:h>',
    });
    const [h] = bodyOf(doc);
    expect(h?.type).toBe('heading');
    expect(h?.attrs?.['level']).toBe(1);
    expect(h?.content).toEqual([
      { type: 'text', text: 'Big ' },
      { type: 'text', text: 'it', marks: [{ type: 'italic' }] },
    ]);
  });

  it('layers default style, named chain, automatic style, then the text style chain', async () => {
    const { doc } = await importFodt({
      styles:
        '<style:style style:name="A" style:family="paragraph"><style:text-properties fo:font-size="14pt"/></style:style>' +
        '<style:style style:name="B" style:family="paragraph" style:parent-style-name="A"><style:text-properties fo:color="#00ff00"/></style:style>' +
        '<style:style style:name="Strong" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>',
      auto:
        '<style:style style:name="P1" style:family="paragraph" style:parent-style-name="B"><style:text-properties fo:font-size="16pt"/></style:style>' +
        '<style:style style:name="T1" style:family="text" style:parent-style-name="Strong"><style:text-properties fo:color="#ff0000"/></style:style>',
      body: '<text:p text:style-name="P1">x<text:span text:style-name="T1">y</text:span></text:p>',
    });
    const [p] = bodyOf(doc);
    // x: size 16 from P1 (over A's 14), green from B. y: also bold, and red over green.
    expect(p?.content).toEqual([
      { type: 'text', text: 'x', marks: [{ type: 'text_style', attrs: { fontFamily: null, fontSize: 16, color: '#00ff00' } }] },
      { type: 'text', text: 'y', marks: [{ type: 'bold' }, { type: 'text_style', attrs: { fontFamily: null, fontSize: 16, color: '#ff0000' } }] },
    ]);
  });

  it('resolves a font through style:font-name and font-face-decls, and fo:font-family wins in the same layer', async () => {
    const { doc } = await importFodt({
      auto:
        '<style:style style:name="T1" style:family="text"><style:text-properties style:font-name="Liberation Sans"/></style:style>' +
        '<style:style style:name="T2" style:family="text"><style:text-properties style:font-name="Liberation Sans" fo:font-family="Georgia"/></style:style>',
      body: '<text:p><text:span text:style-name="T1">a</text:span><text:span text:style-name="T2">b</text:span></text:p>',
    });
    const content = bodyOf(doc)[0]?.content ?? [];
    expect(content[0]?.marks).toBeUndefined(); // same as the default
    expect(content[1]?.marks).toEqual([{ type: 'text_style', attrs: { fontFamily: 'Georgia', fontSize: null, color: null } }]);
  });

  it('keeps https and mailto links, drops other schemes (text stays) and ignores the link style', async () => {
    const r = await importFodt({
      styles: '<style:style style:name="Internet_20_link" style:family="text"><style:text-properties fo:color="#000080" style:text-underline-style="solid"/></style:style>',
      body:
        '<text:p><text:a xlink:type="simple" xlink:href="https://example.com/?a=1&amp;b=2" text:style-name="Internet_20_link">web</text:a> ' +
        '<text:a xlink:href="mailto:a@b.co">mail</text:a> <text:a xlink:href="javascript:alert(1)">js</text:a> <text:a xlink:href="#bm">anchor</text:a></text:p>',
    });
    const content = bodyOf(r.doc)[0]?.content ?? [];
    expect(content.map((n) => [n.text, n.marks?.map((m) => m.type)])).toEqual([
      ['web', ['link']],
      [' ', undefined],
      ['mail', ['link']],
      [' js anchor', undefined],
    ]);
    expect(content[0]?.marks?.[0]?.attrs).toEqual({ href: 'https://example.com/?a=1&b=2' });
    expect(r.findings).toEqual([{ feature: 'other', count: 2, detail: 'link-scheme' }]);
  });
});

describe('FodtMapper import: paragraphs (PO-20, S-19)', () => {
  it('maps alignment, spacing, line height and indents, flattening named styles', async () => {
    const { doc } = await importFodt({
      styles:
        '<style:style style:name="Text_20_body" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="8pt" fo:line-height="115%"/></style:style>',
      auto:
        '<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Text_20_body"><style:paragraph-properties fo:text-align="end" fo:margin-top="6pt" fo:margin-left="18pt" fo:margin-right="9pt" fo:text-indent="-9pt"/></style:style>' +
        '<style:style style:name="P2" style:family="paragraph"><style:paragraph-properties fo:text-align="start" fo:line-height="100%" fo:margin-top="0pt" style:line-height-at-least="12pt"/></style:style>' +
        '<style:style style:name="P3" style:family="paragraph"><style:paragraph-properties fo:text-align="justify" style:line-height-at-least="20pt"/></style:style>' +
        '<style:style style:name="P4" style:family="paragraph"><style:paragraph-properties fo:line-height="24pt" fo:text-align="center"/></style:style>',
      body:
        '<text:p text:style-name="P1">a</text:p><text:p text:style-name="P2">b</text:p><text:p text:style-name="P3">c</text:p><text:p text:style-name="P4">d</text:p>',
    });
    const [a, b, c, d] = bodyOf(doc).map((n) => n.attrs);
    expect(a).toEqual(paraAttrs({ align: 'right', spacingBefore: 6, spacingAfter: 8, lineHeight: { kind: 'multiple', value: 1.15 }, indentLeft: 18, indentRight: 9, indentFirstLine: -9 }));
    expect(b).toEqual(paraAttrs()); // 100%, 0 and left are the defaults
    expect(c).toEqual(paraAttrs({ align: 'justify', lineHeight: { kind: 'atLeast', pt: 20 } }));
    expect(d).toEqual(paraAttrs({ align: 'center', lineHeight: { kind: 'exact', pt: 24 } }));
  });

  it('rejects a length in an unknown unit', async () => {
    await expect(
      importFodt({
        auto: '<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:margin-top="3em"/></style:style>',
        body: '<text:p text:style-name="P1">x</text:p>',
      }),
    ).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
  });

  it('collapses whitespace as ODF defines and keeps text:s, text:tab and line breaks', async () => {
    const { doc } = await importFodt({
      body:
        '<text:p>  lead   and\n   trail  </text:p>' +
        '<text:p>A <text:s text:c="3"/>B</text:p>' +
        '<text:p><text:s/>C<text:tab/>D<text:line-break/>  E</text:p>',
    });
    const [p1, p2, p3] = bodyOf(doc);
    expect(textOf(p1 as Node)).toBe('lead and trail ');
    expect(textOf(p2 as Node)).toBe('A    B');
    expect(p3?.content).toEqual([{ type: 'text', text: ' C\tD' }, { type: 'hard_break' }, { type: 'text', text: 'E' }]);
  });

  it('ignores soft page breaks, empty declarations and bookmarks named _... (L-10)', async () => {
    const r = await importFodt({
      body:
        '<text:sequence-decls><text:sequence-decl text:display-outline-level="0" text:name="Table"/></text:sequence-decls>' +
        '<text:p>a<text:soft-page-break/>b<text:bookmark text:name="_GoBack"/><text:bookmark-start text:name="_Toc1"/>c<text:bookmark-end text:name="_Toc1"/></text:p><office:forms/>',
    });
    expect(textOf(bodyOf(r.doc)[0] as Node)).toBe('abc');
    expect(r.findings).toEqual([]);
  });

  it('keeps an empty document valid: one empty paragraph', async () => {
    const { doc } = await importFodt({ body: '' });
    expect(bodyOf(doc)).toEqual([{ type: 'paragraph', attrs: paraAttrs() }]);
  });
});

describe('FodtMapper import: lists and tables', () => {
  const lists =
    '<text:list-style style:name="LB"><text:list-level-style-bullet text:level="1" text:bullet-char="•"/><text:list-level-style-bullet text:level="2" text:bullet-char="o"/></text:list-style>' +
    '<text:list-style style:name="LN"><text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="." text:start-value="3"/><text:list-level-style-number text:level="2" style:num-format="a"/></text:list-style>' +
    '<text:list-style style:name="LX"><text:list-level-style-number text:level="1" style:num-format=""/><text:list-level-style-number text:level="2" style:num-format=""/></text:list-style>';

  it('maps bullet and ordered lists, nesting, start values and a first item that is not a paragraph', async () => {
    const { doc } = await importFodt({
      auto: lists,
      body:
        '<text:list text:style-name="LB"><text:list-item><text:p>one</text:p><text:list><text:list-item><text:p>one-one</text:p></text:list-item></text:list></text:list-item><text:list-item><text:list><text:list-item><text:p>deep</text:p></text:list-item></text:list></text:list-item></text:list>' +
        '<text:list text:style-name="LN"><text:list-item><text:p>n1</text:p></text:list-item></text:list>' +
        '<text:list text:style-name="LN"><text:list-item text:start-value="9"><text:p>n9</text:p></text:list-item></text:list>',
    });
    const [bullets, ordered, ordered9] = bodyOf(doc);
    expect(bullets?.type).toBe('bullet_list');
    const items = bullets?.content ?? [];
    expect(items.map((i) => i.content?.map((c) => c.type))).toEqual([['paragraph', 'bullet_list'], ['paragraph', 'bullet_list']]);
    expect(items[1]?.content?.[0]?.content).toBeUndefined(); // the added empty first paragraph
    expect(ordered).toMatchObject({ type: 'ordered_list', attrs: { order: 3 } });
    expect(ordered9).toMatchObject({ type: 'ordered_list', attrs: { order: 9 } });
  });

  it('flattens a list whose label is empty (numbered Word headings) into plain blocks', async () => {
    const { doc } = await importFodt({
      auto: lists,
      body:
        '<text:list text:style-name="LX"><text:list-item><text:h text:outline-level="1">H1</text:h><text:list><text:list-item><text:h text:outline-level="2">H2</text:h></text:list-item></text:list></text:list-item></text:list>',
    });
    expect(bodyOf(doc).map((n) => [n.type, n.attrs?.['level'], textOf(n)])).toEqual([['heading', 1, 'H1'], ['heading', 2, 'H2']]);
  });

  it('ignores the indent of paragraphs in lists, which LibreOffice copies from the list style', async () => {
    const { doc } = await importFodt({
      auto:
        lists +
        '<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:margin-left="36pt" fo:text-indent="-18pt" fo:margin-top="4pt"/></style:style>',
      body: '<text:list text:style-name="LB"><text:list-item><text:p text:style-name="P1">x</text:p></text:list-item></text:list>',
    });
    const p = bodyOf(doc)[0]?.content?.[0]?.content?.[0];
    expect(p?.attrs).toEqual(paraAttrs({ spacingBefore: 4 }));
  });

  it('maps tables: header rows, spans, covered cells and column widths in px', async () => {
    const { doc } = await importFodt({
      auto:
        '<style:style style:name="C1" style:family="table-column"><style:table-column-properties style:column-width="75pt"/></style:style>' +
        '<style:style style:name="C2" style:family="table-column"><style:table-column-properties style:column-width="150pt"/></style:style>',
      body:
        '<table:table><table:table-column table:style-name="C1"/><table:table-column table:style-name="C2" table:number-columns-repeated="2"/>' +
        '<table:table-header-rows><table:table-row><table:table-cell><text:p>A</text:p></table:table-cell><table:table-cell table:number-columns-spanned="2"><text:p>BC</text:p></table:table-cell><table:covered-table-cell/></table:table-row></table:table-header-rows>' +
        '<table:table-row><table:table-cell table:number-rows-spanned="2"><text:p>R</text:p></table:table-cell><table:table-cell/><table:table-cell><text:p>x</text:p></table:table-cell></table:table-row>' +
        '<table:table-row><table:covered-table-cell/><table:table-cell><text:p>y</text:p></table:table-cell><table:table-cell><text:p>z</text:p></table:table-cell></table:table-row></table:table>',
    });
    const t = bodyOf(doc)[0];
    expect(t?.type).toBe('table');
    const rows = t?.content ?? [];
    expect(rows.map((r) => r.content?.map((c) => c.type))).toEqual([
      ['table_header', 'table_header'],
      ['table_cell', 'table_cell', 'table_cell'],
      ['table_cell', 'table_cell'],
    ]);
    expect(rows[0]?.content?.[0]?.attrs).toEqual({ colspan: 1, rowspan: 1, colwidth: [100] });
    expect(rows[0]?.content?.[1]?.attrs).toEqual({ colspan: 2, rowspan: 1, colwidth: [200, 200] });
    expect(rows[1]?.content?.[0]?.attrs).toEqual({ colspan: 1, rowspan: 2, colwidth: [100] });
    expect(rows[1]?.content?.[1]?.content).toEqual([{ type: 'paragraph', attrs: paraAttrs() }]); // empty cell
    expect(() => TextOtType.deserializeSnapshot(doc)).not.toThrow();
  });

  it('rejects a huge repeat count', async () => {
    await expect(
      importFodt({ body: '<table:table><table:table-row><table:table-cell table:number-columns-repeated="100000"/></table:table-row></table:table>' }),
    ).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
  });
});

describe('FodtMapper import: page breaks, page settings and header/footer (CL-9, S-9, PO-21)', () => {
  it('maps break-before and break-after to page_break nodes, and drops one at the start', async () => {
    const { doc } = await importFodt({
      auto:
        '<style:style style:name="B" style:family="paragraph"><style:paragraph-properties fo:break-before="page"/></style:style>' +
        '<style:style style:name="A" style:family="paragraph"><style:paragraph-properties fo:break-after="page"/></style:style>',
      body: '<text:p text:style-name="B">first</text:p><text:p text:style-name="A">second</text:p><text:p text:style-name="B">third</text:p>',
    });
    expect(bodyOf(doc).map((n) => (n.type === 'page_break' ? '--' : textOf(n)))).toEqual(['first', 'second', '--', '--', 'third']);
  });

  it('reads page size, orientation and margins without a header', async () => {
    const { doc } = await importFodt({
      layout:
        '<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="14.8cm" style:print-orientation="landscape" fo:margin-top="1.5cm" fo:margin-bottom="2cm" fo:margin-left="2.5cm" fo:margin-right="3cm"/></style:page-layout>',
      body: '<text:p>x</text:p>',
    });
    expect(doc.attrs['orientation']).toBe('landscape');
    expect(doc.attrs['size']).toEqual({ width: 595.25, height: 419.5 });
    expect(doc.attrs['margins']).toEqual({ top: 42.5, right: 85, bottom: 56.75, left: 70.75 });
  });

  it('S-9: the margin is the page edge to the body; header height and spacing are added back', async () => {
    const layout = (hf: string): string =>
      `<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="600pt" fo:page-height="800pt" fo:margin-top="30pt" fo:margin-bottom="20pt" fo:margin-left="50pt" fo:margin-right="50pt"/>${hf}</style:page-layout>`;
    const master =
      '<style:master-page style:name="Standard" style:page-layout-name="pm1"><style:header><text:p>h</text:p></style:header><style:footer><text:p>f</text:p></style:footer></style:master-page>';
    // Spacing is separate from the height unless the page style uses dynamic spacing.
    const sep = await importFodt({
      layout: layout('<style:header-style><style:header-footer-properties fo:min-height="12pt" fo:margin-bottom="6pt"/></style:header-style><style:footer-style><style:header-footer-properties fo:min-height="10pt" fo:margin-top="4pt"/></style:footer-style>'),
      master,
      body: '<text:p>x</text:p>',
    });
    expect(sep.doc.attrs['margins']).toMatchObject({ top: 48, bottom: 34 });
    // With dynamic spacing the spacing is inside the height (what LibreOffice writes for Word files).
    const dyn = await importFodt({
      layout: layout('<style:header-style><style:header-footer-properties fo:min-height="12pt" fo:margin-bottom="6pt" style:dynamic-spacing="true"/></style:header-style><style:footer-style><style:header-footer-properties fo:min-height="10pt" fo:margin-top="4pt" style:dynamic-spacing="true"/></style:footer-style>'),
      master,
      body: '<text:p>x</text:p>',
    });
    expect(dyn.doc.attrs['margins']).toMatchObject({ top: 42, bottom: 30 });
    // A header that is not in the model does not count.
    const none = await importFodt({
      layout: layout('<style:header-style><style:header-footer-properties fo:min-height="12pt"/></style:header-style>'),
      body: '<text:p>x</text:p>',
    });
    expect(none.doc.attrs['margins']).toMatchObject({ top: 30, bottom: 20 });
  });

  it('rejects margins the schema cannot hold', async () => {
    await expect(
      importFodt({
        layout: '<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="100pt" fo:page-height="800pt" fo:margin-left="60pt" fo:margin-right="60pt"/></style:page-layout>',
        body: '<text:p>x</text:p>',
      }),
    ).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
  });

  it('maps page number and page count in the header and footer to page_field atoms', async () => {
    const r = await importFodt({
      master:
        '<style:master-page style:name="Standard" style:page-layout-name="pm1"><style:header><text:p>Page <text:page-number text:select-page="current">3</text:page-number> of <text:page-count>9</text:page-count></text:p></style:header><style:footer><text:p><text:page-number>1</text:page-number></text:p></style:footer></style:master-page>',
      body: '<text:p>x</text:p>',
    });
    const header = r.doc.content.find((n) => n.type === 'header');
    const footer = r.doc.content.find((n) => n.type === 'footer');
    expect(header?.content?.[0]?.content).toEqual([
      { type: 'text', text: 'Page ' },
      { type: 'page_field', attrs: { kind: 'number' } },
      { type: 'text', text: ' of ' },
      { type: 'page_field', attrs: { kind: 'count' } },
    ]);
    expect(footer?.content?.[0]?.content).toEqual([{ type: 'page_field', attrs: { kind: 'number' } }]);
    expect(r.findings).toEqual([]);
    expect(() => TextOtType.deserializeSnapshot(r.doc)).not.toThrow();
  });

  it('a page number in the body is an unsupported field, and keeps its value as text', async () => {
    const r = await importFodt({ body: '<text:p>n<text:page-number>5</text:page-number></text:p>' });
    expect(textOf(bodyOf(r.doc)[0] as Node)).toBe('n5');
    expect(r.findings).toEqual([{ feature: 'fields', count: 1, detail: 'text:page-number' }]);
  });
});

describe('FodtMapper import: images (PO-22, PO-24, S-10, S-11, S-12)', () => {
  const frame = (img: string, extra = '', size = 'svg:width="40mm" svg:height="20mm"'): string =>
    `<draw:frame text:anchor-type="as-char" ${size}>${img}${extra}</draw:frame>`;
  const png = `<draw:image><office:binary-data>${b64(PNG_1x1)}</office:binary-data></draw:image>`;

  it('stores the image under its SHA-256, sizes it, and takes alt text from svg:desc only', async () => {
    const r = await importFodt({
      body: `<text:p>${frame(png, '<svg:title>TITLE</svg:title><svg:desc>DESC</svg:desc>')}</text:p><text:p>${frame(`<draw:image><office:binary-data>${b64(GIF_1x1)}</office:binary-data></draw:image>`, '<svg:title>only title</svg:title>')}</text:p>`,
    });
    const [a, b] = bodyOf(r.doc);
    expect(a).toEqual({ type: 'image', attrs: { assetId: sha(PNG_1x1), alt: 'DESC', width: 113.5, height: 56.75 } });
    expect(b?.attrs?.['alt']).toBe('');
    expect(r.assetIds).toEqual([sha(PNG_1x1), sha(GIF_1x1)]);
    expect(readFileSync(join(r.assetDir, sha(PNG_1x1)))).toEqual(PNG_1x1);
    expect(r.findings).toEqual([]);
  });

  it('writes one file per distinct image, even when it is used twice', async () => {
    const r = await importFodt({ body: `<text:p>${frame(png)}</text:p><text:p>${frame(png)}</text:p>` });
    expect(r.assetIds).toEqual([sha(PNG_1x1)]);
    expect(bodyOf(r.doc).map((n) => n.type)).toEqual(['image', 'image']);
  });

  it('reports an image mixed with text, keeps the text and puts the image after it', async () => {
    const r = await importFodt({ body: `<text:p>before ${frame(png)} after</text:p>` });
    expect(bodyOf(r.doc).map((n) => n.type)).toEqual(['paragraph', 'image']);
    expect(r.findings).toEqual([{ feature: 'other', count: 1, detail: 'image-position' }]);
  });

  it('reports an image anchored to the page', async () => {
    const r = await importFodt({
      body: `<text:p><draw:frame text:anchor-type="page" svg:width="10mm" svg:height="10mm">${png}</draw:frame></text:p>`,
    });
    expect(r.findings).toEqual([{ feature: 'other', count: 1, detail: 'image-position' }]);
  });

  it('S-12: a linked image has no data, is reported and never fetched', async () => {
    const r = await importFodt({
      body: `<text:p>${frame('<draw:image xlink:href="http://127.0.0.1:1/x.png" xlink:type="simple"/>')}</text:p>`,
    });
    expect(bodyOf(r.doc).map((n) => n.type)).toEqual(['paragraph']);
    expect(r.findings).toEqual([{ feature: 'other', count: 1, detail: 'linked-image' }]);
    expect(r.assetIds).toEqual([]);
  });

  it('reports an image format that is not PNG, JPEG, GIF or convertible, and drops it', async () => {
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
    const r = await importFodt({ body: `<text:p>${frame(`<draw:image><office:binary-data>${b64(webp)}</office:binary-data></draw:image>`)}</text:p>` });
    expect(bodyOf(r.doc).map((n) => n.type)).toEqual(['paragraph']);
    expect(r.findings).toEqual([{ feature: 'other', count: 1, detail: 'image-format' }]);
  });

  it('S-11: EMF is wrapped in an SVG and converted at twice its displayed pixel size; PO-22 notice', async () => {
    const emf = Buffer.alloc(88);
    emf.writeUInt32LE(1, 0);
    emf.write(' EMF', 40, 'latin1');
    const calls: Array<{ inPath: string; pixelWidth?: number; pixelHeight?: number }> = [];
    const r = await importFodt(
      {
        body: `<text:p>${frame(`<draw:image><office:binary-data>${b64(emf)}</office:binary-data></draw:image>`, '<svg:desc>emf alt</svg:desc>', 'svg:width="30pt" svg:height="15pt"')}</text:p>`,
      },
      {
        convertImageToPng: (i) => {
          calls.push(i);
          const out = i.inPath.replace(/\.svg$/, '.png');
          writeFileSync(out, PNG_1x1);
          expect(readFileSync(i.inPath, 'utf8')).toContain('data:image/x-emf;base64,');
          return Promise.resolve(out);
        },
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ pixelWidth: 80, pixelHeight: 40 }); // 30pt = 40px; twice = 80
    expect(bodyOf(r.doc)[0]).toEqual({ type: 'image', attrs: { assetId: sha(PNG_1x1), alt: 'emf alt', width: 30, height: 15 } });
    expect(r.conversions).toEqual([{ feature: 'image-to-png', count: 1, where: ['EMF image 1'] }]);
    expect(r.findings).toEqual([]);
  });

  it('S-11: SVG uses a plain conversion without a size', async () => {
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    const calls: Array<{ pixelWidth?: number }> = [];
    const r = await importFodt(
      { body: `<text:p>${frame(`<draw:image><office:binary-data>${b64(svg)}</office:binary-data></draw:image>`)}</text:p>` },
      {
        convertImageToPng: (i) => {
          calls.push(i);
          const out = i.inPath.replace(/\.svg$/, '.png');
          writeFileSync(out, PNG_1x1);
          return Promise.resolve(out);
        },
      },
    );
    expect(calls[0]?.pixelWidth).toBeUndefined();
    expect(r.conversions).toEqual([{ feature: 'image-to-png', count: 1, where: ['SVG image 1'] }]);
  });

  it('a failed image conversion is a finding, not a failed import', async () => {
    const tiff = Buffer.from([0x49, 0x49, 0x2a, 0, 0, 0, 0, 0]);
    const r = await importFodt(
      { body: `<text:p>${frame(`<draw:image><office:binary-data>${b64(tiff)}</office:binary-data></draw:image>`)}</text:p>` },
      { convertImageToPng: () => Promise.reject(engineError('CONVERSION_FAILED')) },
    );
    expect(r.findings).toEqual([{ feature: 'other', count: 1, detail: 'image-format' }]);
  });

  it('a conversion timeout fails the import', async () => {
    const tiff = Buffer.from([0x49, 0x49, 0x2a, 0, 0, 0, 0, 0]);
    await expect(
      importFodt(
        { body: `<text:p>${frame(`<draw:image><office:binary-data>${b64(tiff)}</office:binary-data></draw:image>`)}</text:p>` },
        { convertImageToPng: () => Promise.reject(engineError('CONVERSION_TIMEOUT')) },
      ),
    ).rejects.toMatchObject({ code: 'CONVERSION_TIMEOUT' });
  });

  it('ignores a fallback image inside the same frame', async () => {
    const r = await importFodt({ body: `<text:p>${frame(png + `<draw:image><office:binary-data>${b64(GIF_1x1)}</office:binary-data></draw:image>`)}</text:p>` });
    expect(r.assetIds).toEqual([sha(PNG_1x1)]);
  });

  it('puts an image from a header into the header', async () => {
    const r = await importFodt({
      master: `<style:master-page style:name="Standard" style:page-layout-name="pm1"><style:header><text:p>${frame(png)}</text:p></style:header></style:master-page>`,
      body: '<text:p>x</text:p>',
    });
    const header = r.doc.content.find((n) => n.type === 'header');
    expect(header?.content?.map((n) => n.type)).toEqual(['image']);
  });
});

describe('FodtMapper: formats and limits', () => {
  it('rejects sheet formats before V2', async () => {
    await expect(
      new FodtMapper().import({ format: 'xlsx', flatXmlPath: 'x', assetDir: 'x', limits: {} as never, lo: {} as never }),
    ).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
    await expect(
      new FodtMapper().export({ kind: 'sheet', format: 'xlsx', model: {}, flatXmlPath: 'x', assetDir: 'x', limits: {} as never, lo: {} as never }),
    ).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
  });

  it('rejects a DTD', async () => {
    await expect(importFodt('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "boom">]><office:document/>')).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
  });
});

describe('FodtMapper export', () => {
  it('writes styles, escapes text, strips control characters and encodes spaces', async () => {
    const dir = await importFodt({ body: '' });
    const xml = await exportFodt(
      model([
        para('a & b < c > "d" \u0001x', {}),
        para('  lead    four  ', {}),
        { type: 'paragraph', attrs: paraAttrs({ align: 'center', spacingBefore: 6, lineHeight: { kind: 'multiple', value: 1.5 } }), content: [{ type: 'text', text: 'T\tab' }, { type: 'hard_break' }, { type: 'text', text: 'end' }] },
        { type: 'heading', attrs: { ...paraAttrs(), level: 3 }, content: [{ type: 'text', text: 'Head' }] },
      ]),
      dir.assetDir,
    );
    expect(xml).toContain('a &amp; b &lt; c &gt; &quot;d&quot; x');
    expect(xml).not.toContain('\u0001');
    expect(xml).toContain('<text:s text:c="2"/>lead<text:s text:c="4"/>four<text:s text:c="2"/>');
    expect(xml).toContain('T<text:tab/>ab<text:line-break/>end');
    expect(xml).toContain('fo:text-align="center"');
    expect(xml).toContain('fo:margin-top="6pt"');
    expect(xml).toContain('fo:line-height="150%"');
    expect(xml).toMatch(/<text:h text:style-name="Heading_20_3" text:outline-level="3">Head<\/text:h>/);
    expect(xml).toContain('office:version="1.3"');
    expect(xml).toContain('office:mimetype="application/vnd.oasis.opendocument.text"');
  });

  it('writes marks as spans, links as text:a, and only the fonts in use', async () => {
    const dir = await importFodt({ body: '' });
    const xml = await exportFodt(
      model([
        {
          type: 'paragraph',
          attrs: paraAttrs(),
          content: [
            { type: 'text', text: 'b', marks: [{ type: 'bold' }, { type: 'italic' }] },
            { type: 'text', text: 'k', marks: [{ type: 'link', attrs: { href: 'https://e.com/?a=1&b=2' } }, { type: 'text_style', attrs: { fontFamily: 'Georgia', fontSize: 14, color: '#112233' } }] },
          ],
        },
      ]),
      dir.assetDir,
    );
    expect(xml).toContain('fo:font-weight="bold"');
    expect(xml).toContain('fo:font-style="italic"');
    expect(xml).toContain('<text:a xlink:type="simple" xlink:href="https://e.com/?a=1&amp;b=2">');
    expect(xml).toContain('style:font-name="Georgia" fo:font-size="14pt" fo:color="#112233"');
    expect(xml).toContain('<style:font-face style:name="Georgia"');
    expect(xml).toContain('<style:font-face style:name="Liberation Sans"');
    expect(xml).not.toContain('Verdana');
  });

  it('S-9: splits the body margin into the page margin and the header or footer height', async () => {
    const dir = await importFodt({ body: '' });
    const xml = await exportFodt(
      model([para('x')], { header: [para('h')], footer: [para('f')], attrs: { margins: { top: 90, right: 50, bottom: 40, left: 60 } } }),
      dir.assetDir,
    );
    expect(xml).toContain('fo:margin-top="36pt"');
    expect(xml).toContain('<style:header-footer-properties fo:min-height="54pt" fo:margin-bottom="0pt"/>');
    expect(xml).toContain('fo:margin-bottom="20pt"');
    expect(xml).toContain('<style:header-footer-properties fo:min-height="20pt" fo:margin-top="0pt"/>');
    expect(xml).toMatch(/<style:header><text:p text:style-name="Header">h<\/text:p>\s*<\/style:header>/);
  });

  it('writes page_field atoms in the header and footer', async () => {
    const dir = await importFodt({ body: '' });
    const fields: Node[] = [{ type: 'paragraph', attrs: paraAttrs(), content: [{ type: 'text', text: 'P ' }, { type: 'page_field', attrs: { kind: 'number' } }, { type: 'text', text: '/' }, { type: 'page_field', attrs: { kind: 'count' } }] }];
    const xml = await exportFodt(model([para('x')], { header: fields, footer: fields }), dir.assetDir);
    expect(xml).toContain('<text:page-number text:select-page="current">1</text:page-number>');
    expect(xml).toContain('<text:page-count>1</text:page-count>');
  });

  it('writes a page break as break-before on the next block, and an empty paragraph for a trailing one', async () => {
    const dir = await importFodt({ body: '' });
    const xml = await exportFodt(model([para('a'), { type: 'page_break' }, para('b'), { type: 'page_break' }]), dir.assetDir);
    expect(xml).toContain('fo:break-before="page"');
    expect(xml).toMatch(/<text:p text:style-name="Standard">a<\/text:p>\s*<text:p text:style-name="P1">b<\/text:p>\s*<text:p text:style-name="P1"\/>/);
  });

  it('writes lists, tables with covered cells, and start values', async () => {
    const dir = await importFodt({ body: '' });
    const cell = (text: string, a: Record<string, unknown> = {}, type = 'table_cell'): Node => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, ...a }, content: [para(text)] });
    const xml = await exportFodt(
      model([
        { type: 'ordered_list', attrs: { order: 4 }, content: [{ type: 'list_item', content: [para('o'), { type: 'bullet_list', content: [{ type: 'list_item', content: [para('b')] }] }] }] },
        {
          type: 'table',
          content: [
            { type: 'table_row', content: [cell('H1', { colwidth: [100] }, 'table_header'), cell('H2', { colwidth: [200] }, 'table_header')] },
            { type: 'table_row', content: [cell('M', { rowspan: 2 }), cell('x')] },
            { type: 'table_row', content: [cell('y')] },
          ],
        },
      ]),
      dir.assetDir,
    );
    expect(xml).toContain('<text:list text:style-name="L_number"><text:list-item text:start-value="4">');
    expect(xml).toContain('<text:list text:style-name="L_bullet">');
    expect(xml).toContain('<table:table-header-rows><table:table-row>');
    expect(xml).toContain('table:number-rows-spanned="2"');
    expect(xml).toMatch(/<table:table-row><table:covered-table-cell\/><table:table-cell office:value-type="string"><text:p text:style-name="Standard">y/);
    expect(xml).toContain('style:column-width="75pt"');
    expect(xml).toContain('style:column-width="150pt"');
  });

  it('embeds images as base64 with their size and alt text', async () => {
    const dir = await importFodt({ body: `<text:p><draw:frame svg:width="10mm" svg:height="10mm"><draw:image><office:binary-data>${b64(PNG_1x1)}</office:binary-data></draw:image></draw:frame></text:p>` });
    const xml = await exportFodt(
      model([{ type: 'image', attrs: { assetId: sha(PNG_1x1), alt: 'a <b>', width: 100, height: null } }]),
      dir.assetDir,
    );
    expect(xml).toContain(`<draw:image draw:mime-type="image/png"><office:binary-data>${b64(PNG_1x1)}</office:binary-data></draw:image>`);
    expect(xml).toContain('svg:width="100pt" svg:height="0.75pt"'); // a 1x1 px image: the intrinsic height is used for the null
    expect(xml).toContain('<svg:desc>a &lt;b&gt;</svg:desc>');
  });

  it('fails clearly for a missing image, an invalid asset id and an invalid model', async () => {
    const dir = await importFodt({ body: '' });
    await expect(exportFodt(model([{ type: 'image', attrs: { assetId: 'a'.repeat(64), alt: '', width: null, height: null } }]), dir.assetDir)).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
    await expect(exportFodt(model([{ type: 'image', attrs: { assetId: '../../etc/passwd', alt: '', width: null, height: null } }]), dir.assetDir)).rejects.toBeDefined();
    await expect(exportFodt({ type: 'doc', content: [] }, dir.assetDir)).rejects.toBeDefined();
  });
});

describe('FodtMapper own round trip (no LibreOffice): export then import gives the same model', () => {
  it('keeps every supported construct', async () => {
    const dir = await importFodt({ body: `<text:p><draw:frame svg:width="40pt" svg:height="20pt"><draw:image><office:binary-data>${b64(PNG_1x1)}</office:binary-data></draw:image></draw:frame></text:p>` });
    const id = sha(PNG_1x1);
    const cell = (text: string, a: Record<string, unknown> = {}, type = 'table_cell'): Node => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, ...a }, content: [para(text)] });
    const original = model(
      [
        { type: 'heading', attrs: { ...paraAttrs({ align: 'center' }), level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        para('plain', { spacingBefore: 6, spacingAfter: 12.25, lineHeight: { kind: 'exact', pt: 20 }, indentLeft: 18, indentRight: 9, indentFirstLine: -9 }),
        {
          type: 'paragraph',
          attrs: paraAttrs({ align: 'justify' }),
          content: [
            { type: 'text', text: 'a ' },
            { type: 'text', text: 'bold', marks: [{ type: 'bold' }, { type: 'underline' }] },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'mailto:a@b.co' } }, { type: 'italic' }, { type: 'strike' }] },
            { type: 'text', text: ' ' },
            { type: 'text', text: 'styled', marks: [{ type: 'text_style', attrs: { fontFamily: 'Georgia', fontSize: 14, color: '#112233' } }] },
            { type: 'hard_break' },
            { type: 'text', text: 'x\ty   z' },
          ],
        },
        { type: 'bullet_list', content: [{ type: 'list_item', content: [para('b1'), { type: 'ordered_list', attrs: { order: 1 }, content: [{ type: 'list_item', content: [para('n1')] }] }] }, { type: 'list_item', content: [para('b2')] }] },
        { type: 'ordered_list', attrs: { order: 7 }, content: [{ type: 'list_item', content: [para('seven')] }] },
        { type: 'page_break' },
        {
          type: 'table',
          content: [
            { type: 'table_row', content: [cell('H1', { colwidth: [100] }, 'table_header'), cell('H2', { colwidth: [150] }, 'table_header')] },
            { type: 'table_row', content: [cell('M', { colwidth: [100], rowspan: 2 }), cell('c', { colwidth: [150] })] },
            { type: 'table_row', content: [cell('d', { colwidth: [150] })] },
          ],
        },
        { type: 'image', attrs: { assetId: id, alt: 'alt text', width: 40, height: 20 } },
        para(''),
      ],
      { header: [{ type: 'paragraph', attrs: paraAttrs(), content: [{ type: 'text', text: 'P' }, { type: 'page_field', attrs: { kind: 'number' } }] }], footer: [para('foot')], attrs: { margins: { top: 90, right: 50, bottom: 40, left: 60 } } },
    );
    expect(() => TextOtType.deserializeSnapshot(original)).not.toThrow();
    const xml = await exportFodt(original, dir.assetDir);
    const back = await importFodt(xml);
    expect(back.doc).toEqual(original);
    expect(back.findings).toEqual([]);
    expect(existsSync(join(dir.assetDir, id))).toBe(true);
  });

  it('keeps a page break between blocks, and the document defaults', async () => {
    const dir = await importFodt({ body: '' });
    const original = model([para('a'), { type: 'page_break' }, para('b')], { attrs: { textDefaults: { fontFamily: null, fontSize: null, color: null } } });
    const back = await importFodt(await exportFodt(original, dir.assetDir));
    expect(back.doc).toEqual(original);
  });
});

describe('fodt helper', () => {
  it('builds a document the reader accepts', () => {
    expect(fodt({ body: '<text:p/>' })).toContain('<office:text><text:p/></office:text>');
  });
});

describe('mergeFindings (codec service)', () => {
  it('merges findings with the same feature and detail and sums their counts', () => {
    expect(
      mergeFindings([
        { feature: 'other', count: 1, detail: 'macros' },
        { feature: 'comments', count: 2, detail: 'office:annotation' },
        { feature: 'other', count: 3, detail: 'macros' },
        { feature: 'other', count: 1, detail: 'columns' },
      ]),
    ).toEqual([
      { feature: 'other', count: 4, detail: 'macros' },
      { feature: 'comments', count: 2, detail: 'office:annotation' },
      { feature: 'other', count: 1, detail: 'columns' },
    ]);
  });
});
