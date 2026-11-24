// Real-LibreOffice tests: unsupported content is found in files LibreOffice reads (PO-13, PO-14, S-12).
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UnsupportedFinding } from '@open-docex/shared/protocol';
import { buildZip } from '../unit/codec/zip-builder.js';
import { root, service } from './lo-setup.js';

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.3"';
const MANIFEST =
  '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>';
const PAGE =
  '<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"/></style:page-layout>';

function odt(content: string, styles: string): Uint8Array {
  return buildZip([
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text', store: true },
    { name: 'META-INF/manifest.xml', data: MANIFEST },
    { name: 'content.xml', data: `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS}>${content}</office:document-content>` },
    { name: 'styles.xml', data: `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS}>${styles}</office:document-styles>` },
  ]);
}

const plainStyles = `<office:styles/><office:automatic-styles>${PAGE}</office:automatic-styles><office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles>`;
const features = (r: { findings: UnsupportedFinding[] }): string[] => r.findings.map((f) => (f.feature === 'other' ? `other:${f.detail ?? ''}` : f.feature)).sort();

describe.skipIf(process.env['OPEN_DOCEX_LO_TESTS'] !== '1')('unsupported content in files read by real LibreOffice', () => {
  it('finds tracked changes, comments, footnotes, fields, text boxes, an index and a linked image', async () => {
    const content =
      '<office:automatic-styles/><office:body><office:text>' +
      '<text:tracked-changes><text:changed-region text:id="c1"><text:insertion><office:change-info><dc:creator>a</dc:creator><dc:date>2020-01-01T00:00:00</dc:date></office:change-info></text:insertion></text:changed-region></text:tracked-changes>' +
      '<text:p>plain <text:change-start text:change-id="c1"/>inserted<text:change-end text:change-id="c1"/></text:p>' +
      '<text:p>comment<office:annotation><dc:creator>me</dc:creator><text:p>a note</text:p></office:annotation></text:p>' +
      '<text:p>foot<text:note text:id="ftn1" text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body><text:p>fn</text:p></text:note-body></text:note></text:p>' +
      '<text:p>date <text:date text:fixed="true" text:date-value="2020-01-01">1 Jan</text:date></text:p>' +
      '<text:p><draw:frame draw:name="TB" text:anchor-type="paragraph" svg:width="3cm" svg:height="2cm"><draw:text-box><text:p>in a box</text:p></draw:text-box></draw:frame></text:p>' +
      '<text:p><draw:frame text:anchor-type="as-char" svg:width="3cm" svg:height="2cm"><draw:image xlink:href="http://127.0.0.1:9/never-fetched.png" xlink:type="simple"/></draw:frame></text:p>' +
      '<text:table-of-content text:name="Toc"><text:table-of-content-source/><text:index-body><text:p>1 Intro</text:p></text:index-body></text:table-of-content>' +
      '</office:text></office:body>';
    const r = await service.import({ bytes: odt(content, plainStyles), format: 'odt', assetDir: join(root, 'assets-unsupported') });
    expect(features(r)).toEqual(expect.arrayContaining(['tracked-changes', 'comments', 'footnotes', 'fields', 'text-boxes', 'other:linked-image', 'other:toc-index']));
  }, 240_000);

  it('finds several page styles, first-page and odd/even headers, a section and columns', async () => {
    const content =
      '<office:automatic-styles><style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard" style:master-page-name="Second"/>' +
      '<style:style style:name="Sect1" style:family="section"><style:section-properties><style:columns fo:column-count="2" fo:column-gap="0.5cm"/></style:section-properties></style:style></office:automatic-styles>' +
      '<office:body><office:text><text:p text:style-name="Standard">one</text:p><text:p text:style-name="P1">two</text:p>' +
      '<text:section text:style-name="Sect1" text:name="S"><text:p text:style-name="Standard">in a section</text:p></text:section></office:text></office:body>';
    const styles =
      '<office:styles><style:style style:name="Standard" style:family="paragraph" style:class="text"/></office:styles>' +
      `<office:automatic-styles>${PAGE}</office:automatic-styles>` +
      '<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"><style:header><text:p>head</text:p></style:header><style:header-first><text:p>first</text:p></style:header-first><style:header-left><text:p>left</text:p></style:header-left></style:master-page>' +
      '<style:master-page style:name="Second" style:page-layout-name="pm1"/></office:master-styles>';
    const r = await service.import({ bytes: odt(content, styles), format: 'odt', assetDir: join(root, 'assets-pages') });
    expect(features(r)).toEqual(expect.arrayContaining(['multiple-page-styles', 'first-page-header', 'odd-even-header', 'other:sections', 'other:columns']));
  }, 240_000);

  it('a plain document has no findings', async () => {
    const content = '<office:automatic-styles/><office:body><office:text><text:p>x</text:p></office:text></office:body>';
    const r = await service.import({ bytes: odt(content, plainStyles), format: 'odt', assetDir: join(root, 'assets-plain') });
    expect(r.findings).toEqual([]);
  }, 240_000);
});
