import { describe, expect, it } from 'vitest';
import type { UnsupportedFinding } from '@open-docex/shared/protocol';
import { UnsupportedDetector } from '../../../src/codec/unsupported-detector.js';
import { bodyOf, importFodt, PNG_1x1, textOf, type Fodt, type Node } from './fodt-helpers.js';

const other = (detail: string, count = 1): UnsupportedFinding => ({ feature: 'other', count, detail });
const known = (feature: UnsupportedFinding['feature'], detail: string, count = 1): UnsupportedFinding => ({ feature, count, detail });

interface Case {
  name: string;
  doc: Fodt;
  expected: UnsupportedFinding[];
}

const png = Buffer.from(PNG_1x1).toString('base64');
const master = (inner: string, attrs = ''): string => `<style:master-page style:name="Standard" style:page-layout-name="pm1"${attrs}>${inner}</style:master-page>`;

const cases: Case[] = [
  {
    name: 'tracked changes (a changed region with children)',
    doc: {
      body: '<text:tracked-changes><text:changed-region text:id="c1"><text:deletion><text:p>gone</text:p></text:deletion></text:changed-region></text:tracked-changes><text:p>kept</text:p>',
    },
    expected: [known('tracked-changes', 'text:changed-region')],
  },
  { name: 'an empty tracked-changes element is not a finding', doc: { body: '<text:tracked-changes text:track-changes="false"/><text:p>x</text:p>' }, expected: [] },
  {
    name: 'comments (office:annotation)',
    doc: { body: '<text:p>a<office:annotation><dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">me</dc:creator><text:p>note</text:p></office:annotation>b</text:p>' },
    expected: [known('comments', 'office:annotation')],
  },
  {
    name: 'footnotes',
    doc: { body: '<text:p>a<text:note text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body><text:p>fn</text:p></text:note-body></text:note></text:p>' },
    expected: [known('footnotes', 'text:note')],
  },
  {
    name: 'fields other than page number and count (date, author, reference, variable)',
    doc: { body: '<text:p><text:date>2020</text:date><text:author-name>x</text:author-name><text:bookmark-ref text:ref-name="a">1</text:bookmark-ref><text:variable-set text:name="v"/></text:p>' },
    expected: [known('fields', 'text:date', 4)],
  },
  {
    name: 'a date field in a header',
    doc: { master: master('<style:header><text:p><text:date>1</text:date><text:page-number>1</text:page-number></text:p></style:header>'), body: '<text:p>x</text:p>' },
    expected: [known('fields', 'text:date')],
  },
  {
    name: 'a table of contents',
    doc: { body: '<text:table-of-content><text:table-of-content-source/><text:index-body><text:p>1 Intro</text:p></text:index-body></text:table-of-content><text:p>x</text:p>' },
    expected: [other('toc-index')],
  },
  {
    name: 'text boxes and shapes',
    doc: {
      body: '<text:p><draw:frame><draw:text-box><text:p>in a box</text:p></draw:text-box></draw:frame><draw:custom-shape><text:p>shape</text:p></draw:custom-shape><draw:rect/></text:p>',
    },
    expected: [known('text-boxes', 'draw:text-box', 3)],
  },
  {
    name: 'equations and charts are told apart by MIME',
    doc: {
      body:
        '<text:p><draw:frame><draw:object><office:document office:mimetype="application/vnd.oasis.opendocument.formula"><math/></office:document></draw:object></draw:frame>' +
        '<draw:frame><draw:object><office:document office:mimetype="application/vnd.oasis.opendocument.chart"><chart/></office:document></draw:object></draw:frame>' +
        '<draw:frame><draw:object-ole xlink:href="x"/></draw:frame></text:p>',
    },
    expected: [known('equations', 'draw:object'), known('charts', 'draw:object'), other('ole-object')],
  },
  { name: 'sections', doc: { body: '<text:section text:name="S1"><text:p>inside</text:p></text:section>' }, expected: [other('sections')] },
  {
    name: 'multiple page styles reachable from the body',
    doc: {
      auto: '<style:style style:name="P1" style:family="paragraph" style:master-page-name="Second"/>',
      master: master('') + '<style:master-page style:name="Second" style:page-layout-name="pm1"/>',
      body: '<text:p>one</text:p><text:p text:style-name="P1">two</text:p>',
    },
    expected: [known('multiple-page-styles', 'style:master-page')],
  },
  {
    name: 'a next-page-style chain counts as multiple page styles',
    doc: {
      master: master('', ' style:next-style-name="Second"') + '<style:master-page style:name="Second" style:page-layout-name="pm1"/>',
      body: '<text:p>one</text:p>',
    },
    expected: [known('multiple-page-styles', 'style:master-page')],
  },
  {
    name: 'an unused second page style is not a finding',
    doc: { master: master('') + '<style:master-page style:name="Unused" style:page-layout-name="pm1"/>', body: '<text:p>one</text:p>' },
    expected: [],
  },
  {
    name: 'a first-page header with content',
    doc: { master: master('<style:header><text:p>h</text:p></style:header><style:header-first><text:p>first</text:p></style:header-first>'), body: '<text:p>x</text:p>' },
    expected: [known('first-page-header', 'style:header-first')],
  },
  {
    name: 'odd/even footers, but not when hidden',
    doc: {
      master: master('<style:footer><text:p>f</text:p></style:footer><style:footer-left><text:p>left</text:p></style:footer-left><style:header-left style:display="false"><text:p>h</text:p></style:header-left>'),
      body: '<text:p>x</text:p>',
    },
    expected: [known('odd-even-header', 'style:footer-left')],
  },
  {
    name: 'columns (fo:column-count > 1)',
    doc: { auto: '<style:style style:name="Sect1" style:family="section"><style:section-properties><style:columns fo:column-count="2"/></style:section-properties></style:style>', body: '<text:p>x</text:p>' },
    expected: [other('columns')],
  },
  { name: 'one column is fine', doc: { auto: '<style:style style:name="Sect1" style:family="section"><style:section-properties><style:columns fo:column-count="1"/></style:section-properties></style:style>', body: '<text:p>x</text:p>' }, expected: [] },
  { name: 'a heading level above 6', doc: { body: '<text:h text:outline-level="7">deep</text:h>' }, expected: [other('heading-level')] },
  {
    name: 'a link that is not http, https or mailto',
    doc: { body: '<text:p><text:a xlink:href="ftp://x/y">a</text:a><text:a xlink:href="data:text/html,x">b</text:a></text:p>' },
    expected: [other('link-scheme', 2)],
  },
  {
    name: 'macros (a Basic library, and a script event)',
    doc: {
      head: '<office:scripts><office:script script:language="ooo:Basic"><ooo:libraries><ooo:library-embedded ooo:name="Standard"/></ooo:libraries></office:script></office:scripts>',
      body: '<text:p>x</text:p>',
    },
    expected: [other('macros')],
  },
  {
    name: 'the empty scripts element LibreOffice always writes is not a finding',
    doc: { head: '<office:scripts><office:script script:language="ooo:Basic"><ooo:libraries/></office:script></office:scripts>', body: '<text:p>x</text:p>' },
    expected: [],
  },
  {
    name: 'a non-Basic script is a macro',
    doc: { head: '<office:scripts><office:script script:language="ooo:python"/></office:scripts>', body: '<text:p>x</text:p>' },
    expected: [other('macros')],
  },
  {
    name: 'form controls',
    doc: { body: '<office:forms><form:form form:name="F"><form:text form:name="t"/><form:button form:name="b"/></form:form></office:forms><text:p>x</text:p>' },
    expected: [other('form-controls')],
  },
  { name: 'an unknown text element', doc: { body: '<text:p><text:ruby><text:ruby-base>a</text:ruby-base></text:ruby></text:p>' }, expected: [other('unknown-element', 2)] },
  {
    name: 'a bookmark that does not start with an underscore',
    doc: { body: '<text:p><text:bookmark text:name="_Hidden"/><text:bookmark text:name="Visible"/>x</text:p>' },
    expected: [other('unknown-element')],
  },
  {
    name: 'an image mixed with text, and a linked image',
    doc: {
      body:
        `<text:p>text <draw:frame text:anchor-type="as-char" svg:width="5mm" svg:height="5mm"><draw:image><office:binary-data>${png}</office:binary-data></draw:image></draw:frame></text:p>` +
        '<text:p><draw:frame text:anchor-type="as-char" svg:width="5mm" svg:height="5mm"><draw:image xlink:href="https://example.com/a.png"/></draw:frame></text:p>',
    },
    expected: [other('image-position'), other('linked-image')],
  },
  {
    name: 'findings count every occurrence of the same feature',
    doc: { body: '<text:p><text:note><text:note-body><text:p>a</text:p></text:note-body></text:note><text:note><text:note-body><text:p>b</text:p></text:note-body></text:note></text:p>' },
    expected: [known('footnotes', 'text:note', 2)],
  },
];

describe('UnsupportedDetector (§14.7), through the FodtMapper', () => {
  for (const c of cases) {
    it(c.name, async () => {
      const r = await importFodt(c.doc);
      const sort = (f: UnsupportedFinding[]): UnsupportedFinding[] => [...f].sort((a, b) => (a.detail ?? '').localeCompare(b.detail ?? ''));
      expect(sort(r.findings)).toEqual(sort(c.expected));
    });
  }

  it('does not report content inside an unsupported container', async () => {
    const r = await importFodt({
      body: '<text:p><draw:frame><draw:text-box><text:p><text:date>1</text:date><text:note><text:note-body><text:p>x</text:p></text:note-body></text:note></text:p></draw:text-box></draw:frame></text:p>',
    });
    expect(r.findings).toEqual([known('text-boxes', 'draw:text-box')]);
  });

  it('drops the text of an unsupported container from the model but keeps the surrounding text', async () => {
    const r = await importFodt({ body: '<text:p>a<text:note><text:note-body><text:p>hidden</text:p></text:note-body></text:note>b</text:p>' });
    expect(textOf(bodyOf(r.doc)[0] as Node)).toBe('ab');
  });

  it('flattens a section so its content is still shown', async () => {
    const r = await importFodt({ body: '<text:section><text:p>inside</text:p></text:section>' });
    expect(bodyOf(r.doc).map(textOf)).toEqual(['inside']);
  });

  it('uses only members of the shared union, or "other" with a table id as detail', () => {
    const d = new UnsupportedDetector();
    d.onElement('text:section', {}, { depth: 3, region: 'body' });
    d.onElement('office:annotation', {}, { depth: 3, region: 'body' });
    expect(d.finish()).toEqual([other('sections'), known('comments', 'office:annotation')]);
  });

  it('PO-20: paragraph and heading borders and shading are findings, with counts', async () => {
    const r = await importFodt({
      styles: '<style:style style:name="Boxed" style:family="paragraph"><style:paragraph-properties fo:border="0.5pt solid #000000"/></style:style>',
      auto:
        '<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Boxed"/>' +
        '<style:style style:name="P2" style:family="paragraph"><style:paragraph-properties fo:border-bottom="1pt solid #ff0000" fo:background-color="#ffff00"/></style:style>' +
        '<style:style style:name="P3" style:family="paragraph"><style:paragraph-properties fo:border="none" fo:background-color="transparent"/></style:style>',
      body: '<text:p text:style-name="P1">a</text:p><text:h text:style-name="P2" text:outline-level="1">b</text:h><text:p text:style-name="P3">c</text:p>',
    });
    const sort = (f: UnsupportedFinding[]): UnsupportedFinding[] => [...f].sort((a, b) => (a.detail ?? '').localeCompare(b.detail ?? ''));
    expect(sort(r.findings)).toEqual([other('paragraph-border', 2), other('paragraph-shading')]);
  });

  it('table-cell borders and backgrounds are dropped silently', async () => {
    const r = await importFodt({
      auto: '<style:style style:name="C1" style:family="table-cell"><style:table-cell-properties fo:border="1pt solid #000000" fo:background-color="#cccccc"/></style:style>',
      body: '<table:table><table:table-row><table:table-cell table:style-name="C1"><text:p>x</text:p></table:table-cell></table:table-row></table:table>',
    });
    expect(r.findings).toEqual([]);
  });
});
