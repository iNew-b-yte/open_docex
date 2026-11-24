/** Test helpers for the FodtMapper unit tests: build small flat ODF files and run the mapper on them. */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodecLimits, ImportJobResult } from '../../../src/codec/codec-pool.js';
import type { MapperLo } from '../../../src/codec/codec-thread.js';
import { FodtMapper } from '../../../src/codec/fodt-mapper.js';

export const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:form="urn:oasis:names:tc:opendocument:xmlns:form:1.0" xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0" xmlns:ooo="http://openoffice.org/2004/office" office:version="1.3"';

/** Parts of a flat ODF text document. Each defaults to a minimal valid value. */
export interface Fodt {
  body: string;
  /** Inside `office:styles`. */
  styles?: string;
  /** Inside `office:automatic-styles`. */
  auto?: string;
  /** Inside `office:master-styles`. Defaults to one master page `Standard` on layout `pm1`. */
  master?: string;
  /** Replaces the default A4 `pm1` page layout. */
  layout?: string;
  /** Before `office:body`, for example `office:scripts`. */
  head?: string;
}

const DEFAULT_LAYOUT =
  '<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" style:print-orientation="portrait" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2.5cm" fo:margin-right="2.5cm"/></style:page-layout>';

export function fodt(p: Fodt): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><office:document ${NS} office:mimetype="application/vnd.oasis.opendocument.text">` +
    (p.head ?? '') +
    '<office:font-face-decls><style:font-face style:name="Liberation Sans" svg:font-family="\'Liberation Sans\'"/></office:font-face-decls>' +
    `<office:styles><style:default-style style:family="paragraph"><style:text-properties style:font-name="Liberation Sans" fo:font-size="11pt" fo:color="#333333"/></style:default-style>${p.styles ?? ''}</office:styles>` +
    `<office:automatic-styles>${p.layout ?? DEFAULT_LAYOUT}${p.auto ?? ''}</office:automatic-styles>` +
    `<office:master-styles>${p.master ?? '<style:master-page style:name="Standard" style:page-layout-name="pm1"/>'}</office:master-styles>` +
    `<office:body><office:text>${p.body}</office:text></office:body></office:document>`
  );
}

export const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
export const GIF_1x1 = Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');

export interface RunResult extends ImportJobResult {
  assetDir: string;
  dir: string;
}

const limits: CodecLimits = { soffice: 'unused', timeoutMs: 10_000, maxFlatXmlBytes: 64 * 1024 * 1024, maxFileBytes: 1024 * 1024 };

/** The model as the mapper returns it. */
export interface Doc {
  type: 'doc';
  attrs: Record<string, unknown>;
  content: Node[];
}
export interface Node {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

/** Imports flat ODF text through the mapper (no LibreOffice). `lo` lets a test stub image conversion. */
export async function importFodt(xml: string | Fodt, lo?: Partial<MapperLo>): Promise<RunResult & { doc: Doc }> {
  const dir = mkdtempSync(join(tmpdir(), 'fodt-unit-'));
  const flatXmlPath = join(dir, 'in.fodt');
  writeFileSync(flatXmlPath, typeof xml === 'string' ? xml : fodt(xml));
  const assetDir = join(dir, 'assets');
  const full: MapperLo = { convertImageToPng: () => Promise.reject(new Error('no LibreOffice in this test')), ...lo };
  const r = await new FodtMapper().import({ format: 'odt', flatXmlPath, assetDir, limits, lo: full });
  return { ...r, assetDir, dir, doc: r.snapshot as Doc };
}

/** Exports a model through the mapper and returns the flat XML. */
export async function exportFodt(model: unknown, assetDir: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'fodt-unit-'));
  const flatXmlPath = join(dir, 'doc.fodt');
  await new FodtMapper().export({ kind: 'text', format: 'odt', model, flatXmlPath, assetDir, limits, lo: {} as MapperLo });
  return readFileSync(flatXmlPath, 'utf8');
}

/** The body blocks of an imported document. */
export function bodyOf(d: Doc): Node[] {
  return d.content.find((n) => n.type === 'body')?.content ?? [];
}

/** The text of a node, ignoring marks. */
export function textOf(n: Node): string {
  return n.text ?? (n.content ?? []).map(textOf).join('');
}

/** A paragraph attribute set with every value at its default. */
export function paraAttrs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { align: 'left', spacingBefore: null, spacingAfter: null, lineHeight: null, indentLeft: null, indentRight: null, indentFirstLine: null, ...over };
}

/** A minimal valid model around `body` blocks. */
export function model(body: Node[], extra: { header?: Node[]; footer?: Node[]; attrs?: Record<string, unknown> } = {}): Doc {
  return {
    type: 'doc',
    attrs: {
      size: { width: 595.25, height: 841.75 },
      orientation: 'portrait',
      margins: { top: 72, right: 72, bottom: 72, left: 72 },
      textDefaults: { fontFamily: 'Liberation Sans', fontSize: 11, color: '#333333' },
      ...extra.attrs,
    },
    content: [
      ...(extra.header === undefined ? [] : [{ type: 'header', content: extra.header }]),
      { type: 'body', content: body },
      ...(extra.footer === undefined ? [] : [{ type: 'footer', content: extra.footer }]),
    ],
  };
}

export const para = (text: string, attrs: Record<string, unknown> = {}, marks?: Node['marks']): Node => ({
  type: 'paragraph',
  attrs: paraAttrs(attrs),
  ...(text === '' ? {} : { content: [{ type: 'text', text, ...(marks === undefined ? {} : { marks }) }] }),
});
