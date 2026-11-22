/**
 * The ProseMirror schema for text documents (LLD Part 1 §8.1; §0 R-14, R-17, L-2,
 * S-18, S-19, S-20).
 *
 * Every attribute has a validator, which ProseMirror runs on `create` and again in
 * `Node.check()`. Every `toDOM` output is built only from validated attribute values,
 * and ProseMirror's `DOMSerializer` sets attributes, never HTML. Specs have no
 * `parseDOM` unless the LLD lists one, so pasted HTML can never create the
 * `header`/`body`/`footer` regions or a `page_field`.
 *
 * Schema evolution: node types, mark types and attributes are only ever added, and
 * every new attribute has a default, so older snapshots and journals keep parsing.
 */
import { Schema } from 'prosemirror-model';
import type { AttributeSpec, DOMOutputSpec, Mark, MarkSpec, Node as PMNode, NodeSpec } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';
import { isAssetId } from '../ids/index.js';
import { isAllowedHref } from './href.js';

/** Every node type name in {@link textSchema}. */
export type TextNodeName =
  | 'doc'
  | 'header'
  | 'body'
  | 'footer'
  | 'paragraph'
  | 'heading'
  | 'bullet_list'
  | 'ordered_list'
  | 'list_item'
  | 'table'
  | 'table_row'
  | 'table_cell'
  | 'table_header'
  | 'image'
  | 'page_break'
  | 'text'
  | 'hard_break'
  | 'page_field';

/** Every mark type name in {@link textSchema}, in rank order. */
export type TextMarkName = 'link' | 'bold' | 'italic' | 'underline' | 'strike' | 'text_style';

/** A text document: a prosemirror-model `Node` of {@link textSchema} with type `doc`. */
export type TextSnapshot = PMNode;

/** Paragraph alignment, used by `paragraph.align` and `heading.align`. */
export type TextAlign = 'left' | 'center' | 'right' | 'justify';

/** `paragraph.lineHeight` and `heading.lineHeight` (§0 S-19). `pt` values are points. */
export type LineHeight =
  | { kind: 'multiple'; value: number }
  | { kind: 'exact'; pt: number }
  | { kind: 'atLeast'; pt: number };

/** The `doc` attribute `textDefaults` (§0 R-14, S-18): the document's default run style. */
export interface TextDefaults {
  fontFamily: string | null;
  fontSize: number | null;
  color: string | null;
}

// ---------------------------------------------------------------------------
// Validators. Each throws a RangeError for an invalid value (AttributeSpec.validate).
// ---------------------------------------------------------------------------

const FONT_FAMILY_RE = /^[\p{L}\p{N} _.\-()&+]{1,64}$/u;
const COLOR_RE = /^#[0-9a-f]{6}$/;
const ALIGNS: readonly string[] = ['left', 'center', 'right', 'justify'];

function fail(what: string): never {
  throw new RangeError(`Invalid ${what}`);
}

function isFiniteIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

function isIntIn(v: unknown, min: number, max: number): v is number {
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** True when `v` is a plain object whose own keys are exactly `keys`. */
function hasExactKeys(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  if (!isPlainObject(v)) return false;
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
}

function isFontFamily(v: unknown): v is string {
  return typeof v === 'string' && FONT_FAMILY_RE.test(v);
}

function isFontSize(v: unknown): v is number {
  return isFiniteIn(v, 1, 1638);
}

function isColor(v: unknown): v is string {
  return typeof v === 'string' && COLOR_RE.test(v);
}

function nullOr(test: (v: unknown) => boolean, what: string): (v: unknown) => void {
  return (v) => {
    if (v !== null && !test(v)) fail(what);
  };
}

function isLineHeight(v: unknown): v is LineHeight {
  if (!isPlainObject(v)) return false;
  if (v.kind === 'multiple') return hasExactKeys(v, ['kind', 'value']) && isFiniteIn(v.value, 0.5, 10);
  if (v.kind === 'exact' || v.kind === 'atLeast') return hasExactKeys(v, ['kind', 'pt']) && isFiniteIn(v.pt, 1, 1584);
  return false;
}

function validateTextDefaults(v: unknown): void {
  if (
    !hasExactKeys(v, ['fontFamily', 'fontSize', 'color']) ||
    (v.fontFamily !== null && !isFontFamily(v.fontFamily)) ||
    (v.fontSize !== null && !isFontSize(v.fontSize)) ||
    (v.color !== null && !isColor(v.color))
  ) {
    fail('textDefaults');
  }
}

function validatePageSize(v: unknown): void {
  if (!hasExactKeys(v, ['width', 'height']) || !isFiniteIn(v.width, 36, 4000) || !isFiniteIn(v.height, 36, 4000)) {
    fail('page size');
  }
}

function validateOrientation(v: unknown): void {
  if (v !== 'portrait' && v !== 'landscape') fail('orientation');
}

function validateMargins(v: unknown): void {
  if (
    !hasExactKeys(v, ['top', 'right', 'bottom', 'left']) ||
    !isFiniteIn(v.top, 0, 1000) ||
    !isFiniteIn(v.right, 0, 1000) ||
    !isFiniteIn(v.bottom, 0, 1000) ||
    !isFiniteIn(v.left, 0, 1000)
  ) {
    fail('margins');
  }
}

function validateAlign(v: unknown): void {
  if (typeof v !== 'string' || !ALIGNS.includes(v)) fail('align');
}

function validateColwidth(v: unknown): void {
  // "length = colspan" needs the colspan attribute, which a per-attribute validator
  // cannot see. Each value is checked here; the length is bounded by the colspan range.
  if (v === null) return;
  if (!Array.isArray(v) || v.length < 1 || v.length > 1000 || !v.every((w) => isIntIn(w, 1, 10_000))) {
    fail('colwidth');
  }
}

// ---------------------------------------------------------------------------
// Minimal DOM view used by parseDOM rules. shared compiles without the DOM lib, and
// these rules run only inside ProseMirror's DOMParser, in a browser or jsdom.
// ---------------------------------------------------------------------------

interface ParsedElement {
  getAttribute(name: string): string | null;
  readonly style: { getPropertyValue(property: string): string };
}

function el(dom: unknown): ParsedElement {
  return dom as ParsedElement;
}

/** Parses a CSS length in px or pt to pt (px × 0.75). Other units give null. */
function cssLengthToPt(value: string): number | null {
  const m = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|pt)$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'px' ? n * 0.75 : n;
}

function ptCss(n: number): string {
  return `${String(n)}pt`;
}

// ---------------------------------------------------------------------------
// Paragraph formatting (§0 PO-20, S-19), shared by paragraph and heading.
// ---------------------------------------------------------------------------

const NON_NEGATIVE_PT = (v: unknown): boolean => isFiniteIn(v, 0, 1584);

const blockFormatAttrs: Record<string, AttributeSpec> = {
  align: { default: 'left', validate: validateAlign },
  spacingBefore: { default: null, validate: nullOr(NON_NEGATIVE_PT, 'spacingBefore') },
  spacingAfter: { default: null, validate: nullOr(NON_NEGATIVE_PT, 'spacingAfter') },
  lineHeight: { default: null, validate: nullOr(isLineHeight, 'lineHeight') },
  indentLeft: { default: null, validate: nullOr(NON_NEGATIVE_PT, 'indentLeft') },
  indentRight: { default: null, validate: nullOr(NON_NEGATIVE_PT, 'indentRight') },
  indentFirstLine: { default: null, validate: nullOr((v) => isFiniteIn(v, -1584, 1584), 'indentFirstLine') },
};

/** CSS property → pt attribute, for the five length attributes (S-19). */
const LENGTH_PROPS: readonly (readonly [css: string, attr: string, min: number])[] = [
  ['margin-top', 'spacingBefore', 0],
  ['margin-bottom', 'spacingAfter', 0],
  ['margin-left', 'indentLeft', 0],
  ['margin-right', 'indentRight', 0],
  ['text-indent', 'indentFirstLine', -1584],
];

/** The inline `style` for a paragraph or heading; empty when every value is a default. */
function blockFormatStyle(node: PMNode): string {
  const parts: string[] = [];
  const align = node.attrs.align as TextAlign;
  if (align !== 'left') parts.push(`text-align: ${align}`);
  for (const [css, attr] of LENGTH_PROPS) {
    const v = node.attrs[attr] as number | null;
    if (v !== null) parts.push(`${css}: ${ptCss(v)}`);
  }
  const lh = node.attrs.lineHeight as LineHeight | null;
  if (lh !== null) parts.push(`line-height: ${lh.kind === 'multiple' ? String(lh.value) : ptCss(lh.pt)}`);
  return parts.join('; ');
}

function blockFormatDomAttrs(node: PMNode): Record<string, string> {
  const style = blockFormatStyle(node);
  return style === '' ? {} : { style };
}

function parseLineHeight(value: string): LineHeight | null {
  const v = value.trim();
  if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(v)) {
    const lh: LineHeight = { kind: 'multiple', value: Number(v) };
    return isLineHeight(lh) ? lh : null;
  }
  const pt = cssLengthToPt(v);
  if (pt === null) return null;
  const lh: LineHeight = { kind: 'exact', pt };
  return isLineHeight(lh) ? lh : null;
}

/** Reads alignment and S-19 formatting from an element's style. Invalid values are skipped. */
function parseBlockFormat(dom: ParsedElement): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  const align = dom.style.getPropertyValue('text-align').trim();
  if (ALIGNS.includes(align)) attrs.align = align;
  for (const [css, attr, min] of LENGTH_PROPS) {
    const pt = cssLengthToPt(dom.style.getPropertyValue(css));
    if (pt !== null && isFiniteIn(pt, min, 1584)) attrs[attr] = pt;
  }
  const lh = parseLineHeight(dom.style.getPropertyValue('line-height'));
  if (lh !== null) attrs.lineHeight = lh;
  return attrs;
}

// ---------------------------------------------------------------------------
// Tables (prosemirror-tables), with colspan/rowspan/colwidth tightened.
// ---------------------------------------------------------------------------

function tightenedTableNodes(): Record<'table' | 'table_row' | 'table_cell' | 'table_header', NodeSpec> {
  const specs = tableNodes({ tableGroup: 'block', cellContent: 'block+', cellAttributes: {} });
  const tighten = (spec: NodeSpec): NodeSpec => ({
    ...spec,
    attrs: {
      ...spec.attrs,
      colspan: { default: 1, validate: (v: unknown) => { if (!isIntIn(v, 1, 1000)) fail('colspan'); } },
      rowspan: { default: 1, validate: (v: unknown) => { if (!isIntIn(v, 1, 1000)) fail('rowspan'); } },
      colwidth: { default: null, validate: validateColwidth },
    },
  });
  return {
    table: specs.table,
    table_row: specs.table_row,
    table_cell: tighten(specs.table_cell),
    table_header: tighten(specs.table_header),
  };
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

function parseOptionalPt(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return isFiniteIn(n, 1, 10_000) ? n : null;
}

const tables = tightenedTableNodes();

const nodes: Record<TextNodeName, NodeSpec> = {
  doc: {
    content: 'header? body footer?',
    attrs: {
      size: { validate: validatePageSize },
      orientation: { validate: validateOrientation },
      margins: { validate: validateMargins },
      textDefaults: { default: { fontFamily: null, fontSize: null, color: null }, validate: validateTextDefaults },
    },
  },
  header: {
    content: 'block+',
    isolating: true,
    toDOM: () => ['header', { class: 'odx-header' }, 0],
  },
  body: {
    content: '(block | page_break)+',
    isolating: true,
    toDOM: () => ['div', { class: 'odx-body' }, 0],
  },
  footer: {
    content: 'block+',
    isolating: true,
    toDOM: () => ['footer', { class: 'odx-footer' }, 0],
  },
  paragraph: {
    group: 'block',
    content: 'inline*',
    attrs: blockFormatAttrs,
    parseDOM: [{ tag: 'p', getAttrs: (dom: unknown) => parseBlockFormat(el(dom)) }],
    toDOM: (node): DOMOutputSpec => ['p', blockFormatDomAttrs(node), 0],
  },
  heading: {
    group: 'block',
    content: 'inline*',
    attrs: {
      level: { default: 1, validate: (v: unknown) => { if (!isIntIn(v, 1, 6)) fail('heading level'); } },
      ...blockFormatAttrs,
    },
    parseDOM: HEADING_LEVELS.map((level) => ({
      tag: `h${String(level)}`,
      getAttrs: (dom: unknown) => ({ level, ...parseBlockFormat(el(dom)) }),
    })),
    toDOM: (node): DOMOutputSpec => [`h${String(node.attrs.level as number)}`, blockFormatDomAttrs(node), 0],
  },
  bullet_list: {
    group: 'block',
    content: 'list_item+',
    parseDOM: [{ tag: 'ul' }],
    toDOM: () => ['ul', 0],
  },
  ordered_list: {
    group: 'block',
    content: 'list_item+',
    attrs: { order: { default: 1, validate: (v: unknown) => { if (!isIntIn(v, 0, 1_000_000)) fail('order'); } } },
    parseDOM: [
      {
        tag: 'ol',
        getAttrs: (dom: unknown) => {
          const raw = el(dom).getAttribute('start');
          const n = raw === null ? 1 : Number(raw);
          return { order: isIntIn(n, 0, 1_000_000) ? n : 1 };
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => {
      const order = node.attrs.order as number;
      return ['ol', order !== 1 ? { start: String(order) } : {}, 0];
    },
  },
  list_item: {
    content: 'paragraph block*',
    defining: true,
    parseDOM: [{ tag: 'li' }],
    toDOM: () => ['li', 0],
  },
  ...tables,
  image: {
    group: 'block',
    atom: true,
    draggable: true,
    attrs: {
      assetId: { validate: (v: unknown) => { if (!isAssetId(v)) fail('assetId'); } },
      alt: { default: '', validate: (v: unknown) => { if (typeof v !== 'string' || v.length > 1000) fail('alt'); } },
      width: { default: null, validate: nullOr((v) => isFiniteIn(v, 1, 10_000), 'width') },
      height: { default: null, validate: nullOr((v) => isFiniteIn(v, 1, 10_000), 'height') },
    },
    parseDOM: [
      {
        tag: 'img[data-asset-id]',
        getAttrs: (dom: unknown) => {
          const e = el(dom);
          const assetId = e.getAttribute('data-asset-id');
          if (!isAssetId(assetId)) return false;
          const alt = e.getAttribute('alt') ?? '';
          return {
            assetId,
            alt: alt.length <= 1000 ? alt : '',
            width: parseOptionalPt(e.getAttribute('data-width')),
            height: parseOptionalPt(e.getAttribute('data-height')),
          };
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => {
      // No `src`: the editor view sets a blob URL (HLD §14).
      const attrs: Record<string, string> = {
        'data-asset-id': node.attrs.assetId as string,
        alt: node.attrs.alt as string,
      };
      const width = node.attrs.width as number | null;
      const height = node.attrs.height as number | null;
      if (width !== null) attrs['data-width'] = String(width);
      if (height !== null) attrs['data-height'] = String(height);
      return ['img', attrs];
    },
  },
  page_break: {
    atom: true,
    parseDOM: [{ tag: 'div[data-page-break]' }],
    toDOM: () => ['div', { class: 'odx-page-break', 'data-page-break': 'true' }],
  },
  text: { group: 'inline' },
  hard_break: {
    inline: true,
    group: 'inline',
    atom: true,
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: () => ['br'],
  },
  page_field: {
    // §0 S-20: allowed anywhere inline by the schema; V1-04's apply keeps it inside
    // header/footer. No parseDOM, so pasting can't create one.
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { kind: { validate: (v: unknown) => { if (v !== 'number' && v !== 'count') fail('page_field kind'); } } },
    toDOM: (node): DOMOutputSpec => ['span', { class: 'odx-page-field', 'data-page-field': node.attrs.kind as string }],
  },
};

// ---------------------------------------------------------------------------
// Marks (order = rank)
// ---------------------------------------------------------------------------

function isBoldWeight(v: string): boolean {
  const w = v.trim();
  if (w === 'bold' || w === 'bolder') return true;
  if (!/^\d+$/.test(w)) return false;
  const n = Number(w);
  return n >= 500 && n <= 900;
}

/** `rgb(r, g, b)` or `#rrggbb` → lowercase `#rrggbb`; anything else gives null. */
function parseCssColor(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (COLOR_RE.test(v)) return v;
  const m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(v);
  if (!m) return null;
  const channels = [m[1], m[2], m[3]].map(Number);
  if (!channels.every((c) => c <= 255)) return null;
  return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** The first family of a CSS `font-family` list, with quotes stripped. */
function parseFontFamily(value: string): string | null {
  const first = value.split(',')[0]?.trim().replace(/^["']|["']$/g, '').trim() ?? '';
  return isFontFamily(first) ? first : null;
}

function parseTextStyle(dom: ParsedElement): Record<string, unknown> | false {
  const attrs: Record<string, unknown> = {};
  const family = parseFontFamily(dom.style.getPropertyValue('font-family'));
  if (family !== null) attrs.fontFamily = family;
  const size = cssLengthToPt(dom.style.getPropertyValue('font-size'));
  if (size !== null && isFontSize(size)) attrs.fontSize = size;
  const color = parseCssColor(dom.style.getPropertyValue('color'));
  if (color !== null) attrs.color = color;
  return Object.keys(attrs).length > 0 ? attrs : false;
}

function textStyleCss(mark: Mark): string {
  const parts: string[] = [];
  const { fontFamily, fontSize, color } = mark.attrs as TextDefaults;
  if (fontFamily !== null) parts.push(`font-family: "${fontFamily}"`);
  if (fontSize !== null) parts.push(`font-size: ${ptCss(fontSize)}`);
  if (color !== null) parts.push(`color: ${color}`);
  return parts.join('; ');
}

const marks: Record<TextMarkName, MarkSpec> = {
  link: {
    inclusive: false,
    attrs: { href: { validate: (v: unknown) => { if (!isAllowedHref(v)) fail('href'); } } },
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs: (dom: unknown) => {
          const href = el(dom).getAttribute('href');
          return isAllowedHref(href) ? { href } : false;
        },
      },
    ],
    toDOM: (mark): DOMOutputSpec => ['a', { href: mark.attrs.href as string, rel: 'noopener noreferrer nofollow' }, 0],
  },
  bold: {
    parseDOM: [
      { tag: 'strong' },
      { tag: 'b', getAttrs: (dom: unknown) => el(dom).style.getPropertyValue('font-weight').trim() !== 'normal' && null },
      { style: 'font-weight', getAttrs: (v: string) => isBoldWeight(v) && null },
    ],
    toDOM: () => ['strong', 0],
  },
  italic: {
    parseDOM: [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' }],
    toDOM: () => ['em', 0],
  },
  underline: {
    parseDOM: [{ tag: 'u' }, { style: 'text-decoration', consuming: false, getAttrs: (v: string) => v.includes('underline') && null }],
    toDOM: () => ['u', 0],
  },
  strike: {
    parseDOM: [
      { tag: 's' },
      { tag: 'del' },
      { tag: 'strike' },
      { style: 'text-decoration', consuming: false, getAttrs: (v: string) => v.includes('line-through') && null },
    ],
    toDOM: () => ['s', 0],
  },
  text_style: {
    attrs: {
      fontFamily: { default: null, validate: nullOr(isFontFamily, 'fontFamily') },
      fontSize: { default: null, validate: nullOr(isFontSize, 'fontSize') },
      color: { default: null, validate: nullOr(isColor, 'color') },
    },
    parseDOM: [{ tag: 'span[style]', getAttrs: (dom: unknown) => parseTextStyle(el(dom)) }],
    toDOM: (mark): DOMOutputSpec => ['span', { style: textStyleCss(mark) }, 0],
  },
};

/** The text document schema (LLD Part 1 §8.1). */
export const textSchema: Schema<TextNodeName, TextMarkName> = new Schema<TextNodeName, TextMarkName>({ nodes, marks });
