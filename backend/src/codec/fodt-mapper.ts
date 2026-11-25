/**
 * FodtMapper (LLD Part 2 §14.5; §0 PO-13, PO-14, PO-20, PO-21, PO-22, PO-24, PO-25, L-10, R-14,
 * R-15, R-17, S-9, S-10, S-11, S-12, S-18, S-19, S-20, S-27, S-30, S-43): maps LibreOffice's flat
 * ODF text (`.fodt`) to and from the text document model, as JSON of `textSchema`.
 *
 * - **import**: `XmlReader` streams the file. Styles arrive as small trees, the body as events.
 *   Each top-level block is collected as a small ordered tree, mapped, and dropped. Images are
 *   hashed and written to the asset folder as they stream by. EMF/WMF/TIFF/SVG are converted to
 *   PNG through LibreOffice (S-11).
 * - **export**: writes `doc.fodt`; LibreOffice converts it to docx or odt (§14.2).
 *
 * Fidelity rules (L-10): headings map to Heading 1-6; every other named paragraph style is
 * flattened to direct formatting; LibreOffice artefacts (soft page breaks, empty declarations,
 * bookmarks named `_...`) are dropped silently.
 *
 * @module
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Writable } from 'node:stream';
import { once } from 'node:events';
import type { ConversionNotice, UnsupportedFinding } from '@open-docex/shared/protocol';
import { isAssetId } from '@open-docex/shared/ids';
import { isAllowedHref, pageSettingsFit, TextOtType } from '@open-docex/shared/text';
import { engineError } from '../errors/engine-error.js';
import { sniffAssetMime } from '../persistence/asset-store.js';
import { writeFileAtomic } from '../persistence/atomic-file.js';
import type { CodecMapper, MapperLo } from './codec-thread.js';
import type { ImportJobResult } from './codec-pool.js';
import { buildImageSvgWrapper } from './libreoffice-runner.js';
import { parseLengthPt } from './odf-units.js';
import { UnsupportedDetector } from './unsupported-detector.js';
import { parseXmlFile, type XmlNode } from './xml-reader.js';

// ---------------------------------------------------------------------------------------------
// Shared small types and helpers
// ---------------------------------------------------------------------------------------------

/** One node of the model JSON (`Node.toJSON()` of `textSchema`). */
interface J {
  type: string;
  attrs?: Record<string, unknown>;
  content?: J[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

type Attrs = Record<string, string>;

const r2 = (n: number): number => Math.round(n * 100) / 100;
/**
 * Snaps a length to 1/4 pt. LibreOffice keeps lengths in its own units (twips, 1/100 mm, EMU) and
 * writes them back as cm or mm with 3 decimals, so a length drifts by up to about 0.05 pt per
 * pass. A value on this grid survives export and re-import, because the drift is far below
 * half a grid step (0.125 pt). Without it the model would shift on every save.
 */
const snap = (n: number): number => Math.round(n * 4) / 4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
/** The `text_style` font-family rule of the schema (§8.1). */
const FONT_FAMILY_RE = /^[\p{L}\p{N} _.\-()&+]{1,64}$/u;
const MAX_REPEAT = 1000;
const MAX_IMAGE_PX = 4096;

/** A length attribute in pt, or null for `%`, `auto`, `normal`, empty or missing. Other units throw. */
function lengthPt(v: string | undefined): number | null {
  if (v === undefined) return null;
  const s = v.trim();
  if (s === '' || s.endsWith('%') || s === 'auto' || s === 'normal') return null;
  return parseLengthPt(s);
}

function fail(message: string, cause?: unknown): Error {
  return engineError('CONVERSION_FAILED', { message, ...(cause === undefined ? {} : { cause }) });
}

// ---------------------------------------------------------------------------------------------
// Style sheet (§14.5 "Style resolution")
// ---------------------------------------------------------------------------------------------

interface StyleDef {
  name: string;
  family: string;
  parent: string | undefined;
  auto: boolean;
  masterPage: string | undefined;
  listStyle: string | undefined;
  para: Attrs;
  text: Attrs;
  table: Attrs;
  col: Attrs;
}

function emptyStyle(name: string, family: string, auto: boolean): StyleDef {
  return { name, family, parent: undefined, auto, masterPage: undefined, listStyle: undefined, para: {}, text: {}, table: {}, col: {} };
}

/** The styles of one document: named and automatic styles, defaults, list styles, fonts, page layouts. */
class StyleSheet {
  readonly #styles = new Map<string, StyleDef>();
  readonly #defaults = new Map<string, StyleDef>();
  readonly listStyles = new Map<string, XmlNode>();
  readonly fonts = new Map<string, string>();
  readonly layouts = new Map<string, XmlNode>();

  /** Adds one of `office:font-face-decls`, `office:styles` or `office:automatic-styles`. */
  add(tree: XmlNode): void {
    const auto = tree.name === 'office:automatic-styles';
    for (const c of tree.children) {
      if (c.name === 'style:font-face') {
        const name = c.attrs['style:name'];
        const family = c.attrs['svg:font-family'];
        if (name !== undefined) this.fonts.set(name, stripQuotes(family ?? name));
      } else if (c.name === 'style:style' || c.name === 'style:default-style') {
        const family = c.attrs['style:family'] ?? '';
        const isDefault = c.name === 'style:default-style';
        const def = emptyStyle(c.attrs['style:name'] ?? '', family, auto);
        def.parent = c.attrs['style:parent-style-name'];
        def.masterPage = emptyToUndefined(c.attrs['style:master-page-name']);
        def.listStyle = emptyToUndefined(c.attrs['style:list-style-name']);
        for (const p of c.children) {
          if (p.name === 'style:paragraph-properties') Object.assign(def.para, p.attrs);
          else if (p.name === 'style:text-properties') Object.assign(def.text, p.attrs);
          else if (p.name === 'style:table-properties') Object.assign(def.table, p.attrs);
          else if (p.name === 'style:table-column-properties') Object.assign(def.col, p.attrs);
        }
        if (isDefault) this.#defaults.set(family, def);
        else this.#styles.set(`${family}:${def.name}`, def);
      } else if (c.name === 'text:list-style') {
        const name = c.attrs['style:name'];
        if (name !== undefined) this.listStyles.set(name, c);
      } else if (c.name === 'style:page-layout') {
        const name = c.attrs['style:name'];
        if (name !== undefined) this.layouts.set(name, c);
      }
    }
  }

  get(family: string, name: string | undefined): StyleDef | undefined {
    return name === undefined ? undefined : this.#styles.get(`${family}:${name}`);
  }

  defaultOf(family: string): StyleDef | undefined {
    return this.#defaults.get(family);
  }

  /** The style and its parents, root first. Cycles and absurd depth end the walk. */
  chain(family: string, name: string | undefined): StyleDef[] {
    const out: StyleDef[] = [];
    const seen = new Set<string>();
    let cur = this.get(family, name);
    while (cur !== undefined && !seen.has(cur.name) && out.length < 32) {
      seen.add(cur.name);
      out.unshift(cur);
      cur = this.get(family, cur.parent);
    }
    return out;
  }
}

function emptyToUndefined(v: string | undefined): string | undefined {
  return v === undefined || v === '' ? undefined : v;
}

function stripQuotes(v: string): string {
  const first = v.split(',')[0] ?? v;
  return first.trim().replace(/^['"]+|['"]+$/g, '').trim();
}

// --- text properties --------------------------------------------------------------------------

interface TextProps {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  fontFamily: string | null;
  fontSize: number | null;
  color: string | null;
}

const NO_TEXT: TextProps = { bold: false, italic: false, underline: false, strike: false, fontFamily: null, fontSize: null, color: null };

function validFamily(v: string | null): string | null {
  return v !== null && FONT_FAMILY_RE.test(v) ? v : null;
}

/** Layers one style's text properties over `tp`. */
function applyText(tp: TextProps, p: Attrs, fonts: ReadonlyMap<string, string>): TextProps {
  const o = { ...tp };
  const weight = p['fo:font-weight'];
  if (weight !== undefined) o.bold = weight === 'bold' || (/^\d+$/.test(weight) && Number(weight) >= 600);
  const style = p['fo:font-style'];
  if (style !== undefined) o.italic = style === 'italic' || style === 'oblique';
  const ul = p['style:text-underline-style'];
  if (ul !== undefined) o.underline = ul !== 'none';
  const st = p['style:text-line-through-style'];
  if (st !== undefined) o.strike = st !== 'none';
  const fam = p['fo:font-family'];
  const faceName = p['style:font-name'];
  if (fam !== undefined) o.fontFamily = validFamily(stripQuotes(fam));
  else if (faceName !== undefined) o.fontFamily = validFamily(fonts.get(faceName) ?? stripQuotes(faceName));
  const size = p['fo:font-size'];
  if (size !== undefined) {
    if (size.endsWith('%')) {
      const base = o.fontSize ?? 12;
      o.fontSize = clampSize(base * (Number(size.slice(0, -1)) / 100));
    } else o.fontSize = clampSize(lengthPt(size));
  }
  const color = p['fo:color'];
  if (color !== undefined && /^#[0-9a-fA-F]{6}$/.test(color)) o.color = color.toLowerCase();
  return o;
}

function clampSize(v: number | null): number | null {
  return v !== null && Number.isFinite(v) && v >= 1 && v <= 1638 ? snap(v) : null;
}

// --- paragraph properties ---------------------------------------------------------------------

type LineHeight = { kind: 'multiple'; value: number } | { kind: 'exact'; pt: number } | { kind: 'atLeast'; pt: number };

interface ParaProps {
  align: 'left' | 'center' | 'right' | 'justify';
  before: number | null;
  after: number | null;
  left: number | null;
  right: number | null;
  first: number | null;
  lineHeight: LineHeight | null;
  breakBefore: boolean;
  breakAfter: boolean;
  /** Which sides have a border (PO-20: unsupported content). */
  border: { top: boolean; bottom: boolean; left: boolean; right: boolean };
  shading: boolean;
}

const NO_PARA: ParaProps = { align: 'left', before: null, after: null, left: null, right: null, first: null, lineHeight: null, breakBefore: false, breakAfter: false, border: { top: false, bottom: false, left: false, right: false }, shading: false };

function parseAlign(v: string): ParaProps['align'] | null {
  if (v === 'start' || v === 'left') return 'left';
  if (v === 'end' || v === 'right') return 'right';
  if (v === 'center' || v === 'justify') return v;
  return null;
}

/** Layers one style's paragraph properties over `pp`. `indents` false skips left/right/first-line. */
function applyPara(pp: ParaProps, p: Attrs, indents: boolean): ParaProps {
  const o = { ...pp };
  const align = p['fo:text-align'];
  if (align !== undefined) o.align = parseAlign(align) ?? o.align;
  const all = p['fo:margin'];
  if (all !== undefined) {
    const v = lengthPt(all);
    o.before = v;
    o.after = v;
    if (indents) {
      o.left = v;
      o.right = v;
    }
  }
  if (p['fo:margin-top'] !== undefined) o.before = lengthPt(p['fo:margin-top']);
  if (p['fo:margin-bottom'] !== undefined) o.after = lengthPt(p['fo:margin-bottom']);
  if (indents) {
    if (p['fo:margin-left'] !== undefined) o.left = lengthPt(p['fo:margin-left']);
    if (p['fo:margin-right'] !== undefined) o.right = lengthPt(p['fo:margin-right']);
    if (p['fo:text-indent'] !== undefined) o.first = lengthPt(p['fo:text-indent']);
  }
  const lh = p['fo:line-height'];
  if (lh !== undefined) {
    if (lh.endsWith('%')) o.lineHeight = { kind: 'multiple', value: Number(lh.slice(0, -1)) / 100 };
    else {
      const pt = lengthPt(lh);
      o.lineHeight = pt === null ? null : { kind: 'exact', pt };
    }
  } else if (p['style:line-height-at-least'] !== undefined) {
    const pt = lengthPt(p['style:line-height-at-least']);
    o.lineHeight = pt === null ? null : { kind: 'atLeast', pt };
  }
  const visible = (v: string): boolean => !/(^|\s)none(\s|$)/.test(v) && !/^0(\.0+)?[a-z]*(\s|$)/.test(v.trim());
  o.border = { ...o.border };
  const allB = p['fo:border'];
  if (allB !== undefined) o.border = { top: visible(allB), bottom: visible(allB), left: visible(allB), right: visible(allB) };
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    const v = p[`fo:border-${side}`];
    if (v !== undefined) o.border[side] = visible(v);
  }
  const bg = p['fo:background-color'];
  if (bg !== undefined) o.shading = bg !== 'transparent' && bg !== 'none';
  const bb = p['fo:break-before'];
  if (bb !== undefined) o.breakBefore = bb === 'page';
  const ba = p['fo:break-after'];
  if (ba !== undefined) o.breakAfter = ba === 'page';
  return o;
}

/** Normalizes an effective length to a schema value: null when zero, missing or out of range. */
function lengthAttr(v: number | null, min: number): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const n = snap(clamp(v, min, 1584));
  return n === 0 ? null : n;
}

function lineHeightAttr(lh: LineHeight | null): LineHeight | null {
  if (lh === null) return null;
  if (lh.kind === 'multiple') {
    const v = Math.round(lh.value * 1000) / 1000;
    return v === 1 || v < 0.5 || v > 10 ? null : { kind: 'multiple', value: v };
  }
  return lh.pt >= 1 && lh.pt <= 1584 ? { kind: lh.kind, pt: snap(lh.pt) } : null;
}

// ---------------------------------------------------------------------------------------------
// Ordered element tree for the body, headers and footers
// ---------------------------------------------------------------------------------------------

/** An element with its children in document order (text and elements interleaved). */
interface ENode {
  name: string;
  attrs: Attrs;
  kids: Array<ENode | string>;
  /** For `draw:image`: the asset being stored from its `office:binary-data`. */
  asset?: Promise<string | null>;
  /** The settled `asset`. `undefined` when the element had no binary data. */
  assetId?: string | null;
}

function eKids(n: ENode): ENode[] {
  return n.kids.filter((k): k is ENode => typeof k !== 'string');
}

function eText(n: ENode): string {
  let s = '';
  for (const k of n.kids) s += typeof k === 'string' ? k : eText(k);
  return s;
}

async function resolveAssets(n: ENode): Promise<void> {
  if (n.asset !== undefined) n.assetId = await n.asset;
  for (const k of n.kids) if (typeof k !== 'string') await resolveAssets(k);
}

// ---------------------------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------------------------

type ImageKind = 'png' | 'jpeg' | 'gif' | 'emf' | 'wmf' | 'tiff' | 'svg';

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean => sig.every((v, i) => b[at + i] === v);

function sniffImage(b: Uint8Array): ImageKind | null {
  const m = sniffAssetMime(b);
  if (m === 'image/png') return 'png';
  if (m === 'image/jpeg') return 'jpeg';
  if (m === 'image/gif') return 'gif';
  if (startsWith(b, [1, 0, 0, 0]) && startsWith(b, [0x20, 0x45, 0x4d, 0x46], 40)) return 'emf';
  if (startsWith(b, [0xd7, 0xcd, 0xc6, 0x9a]) || startsWith(b, [1, 0, 9, 0]) || startsWith(b, [2, 0, 9, 0])) return 'wmf';
  if (startsWith(b, [0x49, 0x49, 0x2a, 0]) || startsWith(b, [0x4d, 0x4d, 0, 0x2a])) return 'tiff';
  const head = Buffer.from(b.subarray(0, 1024)).toString('latin1').toLowerCase();
  if (head.includes('<svg')) return 'svg';
  return null;
}

const DATA_MIME: Readonly<Record<'emf' | 'wmf' | 'tiff', string>> = { emf: 'image/x-emf', wmf: 'image/x-wmf', tiff: 'image/tiff' };

/** Intrinsic size in px of a PNG, GIF or JPEG, or null. */
function imageSizePx(b: Uint8Array): { w: number; h: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length >= 24 && startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return { w: dv.getUint32(16), h: dv.getUint32(20) };
  if (b.length >= 10 && startsWith(b, [0x47, 0x49, 0x46])) return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
  if (startsWith(b, [0xff, 0xd8])) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1] ?? 0;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7) };
      }
      i += 2 + dv.getUint16(i + 2);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

interface MasterPage {
  name: string;
  layout: string | undefined;
  next: string | undefined;
  /** `style:header`, `style:footer-left`, ... → its attributes and captured child blocks. */
  regions: Map<string, { attrs: Attrs; roots: ENode[] }>;
}

interface Ctx {
  region: 'body' | 'header' | 'footer';
  /** Page breaks are allowed (body, outside tables and lists). */
  top: boolean;
  inList: boolean;
}

/** Inline content and the frames found while reading one paragraph. */
interface Inline {
  nodes: J[];
  frames: ENode[];
}

const SKIP_INLINE = new Set([
  'text:note',
  'office:annotation',
  'office:annotation-end',
  'text:changed-region',
  'text:tracked-changes',
  'text:soft-page-break',
  'text:bookmark',
  'text:bookmark-start',
  'text:bookmark-end',
  'text:change',
  'text:change-start',
  'text:change-end',
  'draw:text-box',
  'draw:object',
  'draw:object-ole',
  'draw:custom-shape',
  'draw:rect',
  'draw:line',
  'draw:g',
  'draw:ellipse',
  'draw:circle',
  'draw:polygon',
  'draw:polyline',
  'draw:path',
  'draw:connector',
  'draw:caption',
  'draw:measure',
  'draw:control',
]);

const ALT_MAX = 1000;
const LINK_STYLES = new Set(['Internet_20_link', 'Visited_20_Internet_20_Link', 'Visited_20_link']);

class Importer {
  readonly sheet = new StyleSheet();
  readonly detector = new UnsupportedDetector();
  readonly assetIds: string[] = [];
  readonly #assetSeen = new Set<string>();
  readonly conversionWhere: string[] = [];
  conversionCount = 0;
  readonly #converted = new Map<string, Promise<string | null>>();
  #convChain: Promise<void> = Promise.resolve();
  #imageSeq = 0;

  readonly #path: string[] = [];
  readonly #stack: ENode[] = [];
  #chain: Promise<void> = Promise.resolve();
  readonly body: J[] = [];
  readonly masters: MasterPage[] = [];
  #masterCapture: { master: MasterPage; region: string } | null = null;
  readonly usedMasters = new Set<string>();
  #firstBlock = true;
  firstBlockMaster: string | undefined;
  textDefaults: { fontFamily: string | null; fontSize: number | null; color: string | null } = { fontFamily: null, fontSize: null, color: null };
  #baseText: TextProps = NO_TEXT;

  constructor(
    readonly o: { assetDir: string; flatXmlPath: string; lo: MapperLo },
  ) {}

  // --- streaming ------------------------------------------------------------------------------

  readonly handlers = {
    open: (name: string, attrs: Record<string, string>, depth: number): void => {
      this.#path.length = depth;
      this.#path[depth] = name;
      const inMaster = this.#path[1] === 'office:master-styles';
      if (!inMaster) this.detector.onElement(name, attrs, { depth, region: 'body' });
      if (inMaster) {
        if (depth === 2 && name === 'style:master-page') {
          const m: MasterPage = {
            name: attrs['style:name'] ?? '',
            layout: attrs['style:page-layout-name'],
            next: attrs['style:next-style-name'],
            regions: new Map(),
          };
          this.masters.push(m);
        } else if (depth === 3) {
          const master = this.masters[this.masters.length - 1];
          if (master !== undefined) {
            master.regions.set(name, { attrs, roots: [] });
            this.#masterCapture = { master, region: name };
          }
        }
      }
      const startsBody = !inMaster && depth === 3 && this.#path[2] === 'office:text';
      const startsMaster = inMaster && depth === 4 && this.#masterCapture !== null;
      const top = this.#stack[this.#stack.length - 1];
      if (top !== undefined || startsBody || startsMaster) {
        const node: ENode = { name, attrs, kids: [] };
        top?.kids.push(node);
        this.#stack.push(node);
      }
    },
    text: (text: string): void => {
      const top = this.#stack[this.#stack.length - 1];
      if (top === undefined) return;
      const last = top.kids[top.kids.length - 1];
      if (typeof last === 'string') top.kids[top.kids.length - 1] = last + text;
      else top.kids.push(text);
    },
    close: (_name: string, depth: number): void => {
      if (this.#stack.length === 0) return;
      const node = this.#stack.pop();
      if (node === undefined || this.#stack.length > 0) return;
      if (this.#path[1] === 'office:master-styles') {
        const cap = this.#masterCapture;
        cap?.master.regions.get(cap.region)?.roots.push(node);
      } else if (depth === 3) {
        const link = this.#chain.then(() => this.#mapBodyBlock(node));
        link.catch(() => undefined); // the final await reports it; this avoids an unhandled rejection
        this.#chain = link;
      }
    },
    binary: (bytes: Uint8Array): Promise<void> | void => {
      const img = this.#stack[this.#stack.length - 1];
      if (img === undefined || img.name !== 'draw:image') return undefined;
      const frame = this.#stack[this.#stack.length - 2];
      const hasEarlier = frame !== undefined && frame.kids.some((k) => typeof k !== 'string' && k !== img && k.name === 'draw:image' && k.asset !== undefined);
      if (hasEarlier) {
        img.asset = Promise.resolve(null); // a fallback copy of the first image
        return undefined;
      }
      const p = this.#processImage(bytes, frame?.name === 'draw:frame' ? frame.attrs : {});
      img.asset = p;
      return p.then(() => undefined);
    },
    tree: (node: XmlNode): void => {
      this.sheet.add(node);
      if (node.name === 'office:automatic-styles') this.#scanColumns(node, 1);
      if (node.name === 'office:styles') this.#readDefaults();
    },
  };

  #scanColumns(n: XmlNode, depth: number): void {
    if (n.name === 'style:columns') this.detector.onElement(n.name, n.attrs, { depth, region: 'styles' });
    for (const c of n.children) this.#scanColumns(c, depth + 1);
  }

  #readDefaults(): void {
    const def = this.sheet.defaultOf('paragraph');
    this.#baseText = def === undefined ? NO_TEXT : applyText(NO_TEXT, def.text, this.sheet.fonts);
    this.textDefaults = { fontFamily: this.#baseText.fontFamily, fontSize: this.#baseText.fontSize, color: this.#baseText.color };
  }

  async finishStream(): Promise<void> {
    await this.#chain;
  }

  // --- images ---------------------------------------------------------------------------------

  async #storeAsset(bytes: Uint8Array): Promise<string> {
    const id = createHash('sha256').update(bytes).digest('hex');
    if (!this.#assetSeen.has(id)) {
      this.#assetSeen.add(id);
      this.assetIds.push(id);
    }
    const file = join(this.o.assetDir, id);
    try {
      await access(file);
    } catch {
      await mkdir(this.o.assetDir, { recursive: true });
      await writeFileAtomic(file, bytes);
    }
    return id;
  }

  /** Stores a PNG, JPEG or GIF; converts EMF, WMF, TIFF and SVG to PNG first (S-11). */
  #processImage(bytes: Uint8Array, frame: Attrs): Promise<string | null> {
    const kind = sniffImage(bytes);
    if (kind === null) {
      this.detector.report('image-format');
      return Promise.resolve(null);
    }
    if (kind === 'png' || kind === 'jpeg' || kind === 'gif') return this.#storeAsset(bytes);
    const key = createHash('sha256').update(bytes).digest('hex');
    const seq = (this.#imageSeq += 1);
    this.conversionCount += 1;
    if (this.conversionWhere.length < 20) this.conversionWhere.push(`${kind.toUpperCase()} image ${String(seq)}`);
    let p = this.#converted.get(key);
    if (p === undefined) {
      // One LibreOffice process at a time: the job owns a single profile slot (§14.3), and two
      // processes on one profile fail silently (S2 §7).
      const run = this.#convChain.then(() => this.#convert(bytes, kind, frame, seq));
      this.#convChain = run.then(
        () => undefined,
        () => undefined,
      );
      p = run.catch((e: unknown) => {
        if (e instanceof Error && 'code' in e && (e as { code?: unknown }).code === 'CONVERSION_FAILED') {
          this.detector.report('image-format');
          return null;
        }
        throw e;
      });
      this.#converted.set(key, p);
    }
    return p;
  }

  async #convert(bytes: Uint8Array, kind: 'emf' | 'wmf' | 'tiff' | 'svg', frame: Attrs, seq: number): Promise<string | null> {
    const dir = dirname(this.o.flatXmlPath);
    const base = join(dir, `odx-image-${String(seq)}`);
    let png: string;
    if (kind === 'svg') {
      await writeFile(`${base}.svg`, bytes);
      png = await this.o.lo.convertImageToPng({ inPath: `${base}.svg` });
    } else {
      const w = lengthPt(frame['svg:width']);
      const h = lengthPt(frame['svg:height']);
      const wPx = Math.max(1, Math.round((w ?? 144) / 0.75));
      const hPx = Math.max(1, Math.round((h ?? 144) / 0.75));
      const uri = `data:${DATA_MIME[kind]};base64,${Buffer.from(bytes).toString('base64')}`;
      await writeFile(`${base}.svg`, buildImageSvgWrapper(uri, wPx, hPx));
      png = await this.o.lo.convertImageToPng({
        inPath: `${base}.svg`,
        pixelWidth: Math.min(MAX_IMAGE_PX, wPx * 2),
        pixelHeight: Math.min(MAX_IMAGE_PX, hPx * 2),
      });
    }
    const out = new Uint8Array(await readFile(png));
    if (sniffAssetMime(out) !== 'image/png') throw fail('Image conversion produced no PNG');
    return this.#storeAsset(out);
  }

  // --- blocks ---------------------------------------------------------------------------------

  async #mapBodyBlock(root: ENode): Promise<void> {
    await resolveAssets(root);
    if (this.#firstBlock && root.name !== 'text:sequence-decls') {
      // The first real block names the first page style (§14.7 `multiple-page-styles`).
      if (['text:p', 'text:h', 'table:table', 'text:list'].includes(root.name)) {
        this.#firstBlock = false;
        this.firstBlockMaster = this.#masterOf(root);
      }
    }
    for (const j of this.mapBlock(root, { region: 'body', top: true, inList: false })) this.body.push(j);
  }

  #masterOf(n: ENode): string | undefined {
    const family = n.name === 'table:table' ? 'table' : 'paragraph';
    return this.sheet.chain(family, n.attrs[family === 'table' ? 'table:style-name' : 'text:style-name']).find((s) => s.masterPage !== undefined)?.masterPage;
  }

  /** Maps one block-level element; unknown ones give nothing (the detector has reported them). */
  mapBlock(n: ENode, ctx: Ctx): J[] {
    switch (n.name) {
      case 'text:p':
        return this.#mapPara(n, null, ctx);
      case 'text:h': {
        const raw = Number(n.attrs['text:outline-level'] ?? '1');
        const level = Number.isFinite(raw) ? clamp(Math.trunc(raw), 1, 6) : 1;
        return this.#mapPara(n, level, ctx);
      }
      case 'text:list':
        return this.#mapList(n, ctx, 0, undefined);
      case 'table:table':
        return this.#mapTable(n, ctx);
      case 'text:section':
        return this.mapBlocks(eKids(n), ctx);
      case 'draw:frame': {
        const img = this.#frameImage(n);
        if (img !== null) this.detector.report('image-position');
        return img === null ? [] : [img];
      }
      default:
        return [];
    }
  }

  mapBlocks(kids: ENode[], ctx: Ctx): J[] {
    const out: J[] = [];
    for (const k of kids) out.push(...this.mapBlock(k, ctx));
    return out;
  }

  // --- paragraphs and inline ------------------------------------------------------------------

  #paraProps(styleName: string | undefined, inList: boolean): { pp: ParaProps; chain: StyleDef[] } {
    const chain = this.sheet.chain('paragraph', styleName);
    let pp = NO_PARA;
    const def = this.sheet.defaultOf('paragraph');
    if (def !== undefined) pp = applyPara(pp, def.para, !inList);
    // In a list the list style's label alignment sets the indent, and LibreOffice copies it into the
    // paragraph when it writes docx. So the indent of a list paragraph is never read.
    for (const s of chain) pp = applyPara(pp, s.para, !inList);
    return { pp, chain };
  }

  #textOf(chain: StyleDef[]): TextProps {
    let tp = this.#baseText;
    for (const s of chain) tp = applyText(tp, s.text, this.sheet.fonts);
    return tp;
  }

  #mapPara(n: ENode, level: number | null, ctx: Ctx): J[] {
    const { pp, chain } = this.#paraProps(n.attrs['text:style-name'], ctx.inList);
    if (ctx.region === 'body') {
      for (const s of chain) if (s.masterPage !== undefined) this.usedMasters.add(s.masterPage);
    }
    // PO-20: paragraph borders and shading are unsupported content (the file opens read-only).
    if (Object.values(pp.border).some(Boolean)) this.detector.report('paragraph-border');
    if (pp.shading) this.detector.report('paragraph-shading');
    const paraText = this.#textOf(chain);
    const base = level === null ? this.#baseText : paraText;
    const inline: Inline = { nodes: [], frames: [] };
    new InlineReader(this, inline, ctx, base).walk(n, paraText, null);

    const out: J[] = [];
    if (pp.breakBefore && ctx.top) out.push({ type: 'page_break' });
    const hasContent = inline.nodes.length > 0;
    if (hasContent || inline.frames.length === 0) {
      const attrs: Record<string, unknown> = {
        ...(level === null ? {} : { level }),
        align: pp.align,
        spacingBefore: lengthAttr(pp.before, 0),
        spacingAfter: lengthAttr(pp.after, 0),
        lineHeight: lineHeightAttr(pp.lineHeight),
        indentLeft: lengthAttr(pp.left, 0),
        indentRight: lengthAttr(pp.right, 0),
        indentFirstLine: lengthAttr(pp.first, -1584),
      };
      const j: J = { type: level === null ? 'paragraph' : 'heading', attrs };
      if (hasContent) j.content = inline.nodes;
      out.push(j);
    }
    for (const f of inline.frames) {
      const img = this.#frameImage(f);
      if (img === null) continue;
      if (hasContent || f.attrs['text:anchor-type'] === 'page') this.detector.report('image-position');
      out.push(img);
    }
    if (pp.breakAfter && ctx.top) out.push({ type: 'page_break' });
    return out;
  }

  /** The `image` block for a frame, or null when it has no usable image. */
  #frameImage(frame: ENode): J | null {
    const img = eKids(frame).find((k) => k.name === 'draw:image');
    if (img === undefined) return null;
    if (img.assetId === undefined) {
      if ((img.attrs['xlink:href'] ?? '') !== '') this.detector.report('linked-image'); // S-12: never fetched
      return null;
    }
    if (img.assetId === null) return null;
    const dim = (v: string | undefined): number | null => {
      const pt = lengthPt(v);
      return pt === null || !(pt >= 1 && pt <= 10_000) ? null : snap(pt);
    };
    const desc = eKids(frame).find((k) => k.name === 'svg:desc'); // S-10: alt is svg:desc, svg:title is ignored
    const alt = desc === undefined ? '' : eText(desc).trim();
    return {
      type: 'image',
      attrs: {
        assetId: img.assetId,
        alt: alt.length <= ALT_MAX ? alt : '',
        width: dim(frame.attrs['svg:width']),
        height: dim(frame.attrs['svg:height']),
      },
    };
  }

  // --- lists ----------------------------------------------------------------------------------

  #listIsOrdered(styleName: string | undefined, depth: number): { ordered: boolean; start: number | null; invisible: boolean } {
    const style = styleName === undefined ? undefined : this.sheet.listStyles.get(styleName);
    const lvl = style?.children.find((c) => c.attrs['text:level'] === String(depth + 1));
    if (lvl === undefined) return { ordered: false, start: null, invisible: false };
    const startRaw = lvl.attrs['text:start-value'];
    const start = startRaw === undefined ? NaN : Number(startRaw);
    const isNumber = lvl.name === 'text:list-level-style-number';
    const invisible =
      isNumber && lvl.attrs['style:num-format'] === '' && (lvl.attrs['style:num-prefix'] ?? '') === '' && (lvl.attrs['style:num-suffix'] ?? '') === '';
    return { ordered: isNumber, start: Number.isInteger(start) ? start : null, invisible };
  }

  #mapList(n: ENode, ctx: Ctx, depth: number, inherited: string | undefined): J[] {
    const items = eKids(n).filter((k) => k.name === 'text:list-item' || k.name === 'text:list-header');
    let styleName = emptyToUndefined(n.attrs['text:style-name']) ?? inherited;
    if (styleName === undefined) {
      const firstPara = items.flatMap(eKids).find((k) => k.name === 'text:p' || k.name === 'text:h');
      styleName = this.sheet.chain('paragraph', firstPara?.attrs['text:style-name']).find((s) => s.listStyle !== undefined)?.listStyle;
    }
    const { ordered, start, invisible } = this.#listIsOrdered(styleName, depth);
    if (invisible) {
      // A list with no label (LibreOffice wraps numbered Word headings like this) is only a container.
      const flat: J[] = [];
      for (const item of items) {
        for (const k of eKids(item)) flat.push(...(k.name === 'text:list' ? this.#mapList(k, ctx, depth + 1, styleName) : this.mapBlock(k, ctx)));
      }
      return flat;
    }
    const lctx: Ctx = { ...ctx, top: false, inList: true };
    const out: J[] = [];
    for (const item of items) {
      const content: J[] = [];
      for (const k of eKids(item)) {
        if (k.name === 'text:list') content.push(...this.#mapList(k, lctx, depth + 1, styleName));
        else content.push(...this.mapBlock(k, lctx));
      }
      if (content[0]?.type !== 'paragraph') content.unshift({ type: 'paragraph', attrs: { ...emptyParaAttrs() } });
      out.push({ type: 'list_item', content });
    }
    if (out.length === 0) return [];
    if (!ordered) return [{ type: 'bullet_list', content: out }];
    const itemStart = eKids(n)[0]?.attrs['text:start-value'];
    const first = itemStart === undefined ? (start ?? 1) : Number(itemStart);
    const order = Number.isInteger(first) && first >= 0 && first <= 1_000_000 ? first : 1;
    return [{ type: 'ordered_list', attrs: { order }, content: out }];
  }

  // --- tables ---------------------------------------------------------------------------------

  #mapTable(n: ENode, ctx: Ctx): J[] {
    const style = this.sheet.get('table', n.attrs['table:style-name']);
    if (style !== undefined && ctx.region === 'body') {
      if (style.masterPage !== undefined) this.usedMasters.add(style.masterPage);
    }
    const cols: Array<number | null> = [];
    const rows: J[] = [];
    const cctx: Ctx = { ...ctx, top: false };

    const column = (c: ENode): void => {
      const rep = repeat(c.attrs['table:number-columns-repeated']);
      const w = lengthPt(this.sheet.get('table-column', c.attrs['table:style-name'])?.col['style:column-width']);
      const px = w === null ? null : clamp(Math.round(w / 0.75), 1, 10_000);
      for (let i = 0; i < rep; i += 1) cols.push(px);
    };
    const collect = (kids: ENode[], header: boolean): void => {
      for (const k of kids) {
        switch (k.name) {
          case 'table:table-column':
            column(k);
            break;
          case 'table:table-columns':
          case 'table:table-column-group':
            collect(eKids(k), header);
            break;
          case 'table:table-header-rows':
            collect(eKids(k), true);
            break;
          case 'table:table-rows':
          case 'table:table-row-group':
            collect(eKids(k), header);
            break;
          case 'table:table-row': {
            const row = this.#mapRow(k, header, cols, cctx);
            const rep = repeat(k.attrs['table:number-rows-repeated']);
            for (let i = 0; i < rep && row !== null; i += 1) rows.push(i === 0 ? row : (JSON.parse(JSON.stringify(row)) as J));
            break;
          }
          default:
        }
      }
    };
    collect(eKids(n), false);
    if (rows.length === 0) return [];
    const out: J[] = [];
    if (style?.table['fo:break-before'] === 'page' && ctx.top) out.push({ type: 'page_break' });
    out.push({ type: 'table', content: rows });
    if (style?.table['fo:break-after'] === 'page' && ctx.top) out.push({ type: 'page_break' });
    return out;
  }

  #mapRow(row: ENode, header: boolean, cols: Array<number | null>, ctx: Ctx): J | null {
    const cells: J[] = [];
    let c = 0;
    for (const k of eKids(row)) {
      const rep = repeat(k.attrs['table:number-columns-repeated']);
      if (k.name === 'table:covered-table-cell') {
        c += rep;
      } else if (k.name === 'table:table-cell') {
        const colspan = clamp(spanOf(k.attrs['table:number-columns-spanned']), 1, 1000);
        const rowspan = clamp(spanOf(k.attrs['table:number-rows-spanned']), 1, 1000);
        const widths = cols.slice(c, c + colspan);
        const colwidth = widths.length === colspan && widths.every((w): w is number => w !== null) ? widths : null;
        const content = this.mapBlocks(eKids(k), ctx);
        if (content.length === 0) content.push({ type: 'paragraph', attrs: { ...emptyParaAttrs() } });
        for (let i = 0; i < rep; i += 1) {
          const cell: J = {
            type: header ? 'table_header' : 'table_cell',
            attrs: { colspan, rowspan, colwidth },
            content: i === 0 ? content : (JSON.parse(JSON.stringify(content)) as J[]),
          };
          cells.push(cell);
        }
        c += colspan * rep;
      }
    }
    return cells.length === 0 ? null : { type: 'table_row', content: cells };
  }

  // --- the whole document ---------------------------------------------------------------------

  async buildDoc(): Promise<J> {
    const initial = this.#initialMaster();
    // Reachable page styles: the first one, those named by styles in the body, and next-style chains.
    const reachable = new Set<string>();
    if (initial !== undefined) reachable.add(initial.name);
    for (const m of this.usedMasters) reachable.add(m);
    for (const name of [...reachable]) {
      let cur = this.masters.find((m) => m.name === name);
      for (let i = 0; i < 8 && cur?.next !== undefined && cur.next !== cur.name; i += 1) {
        reachable.add(cur.next);
        cur = this.masters.find((m) => m.name === cur?.next);
      }
    }
    if (reachable.size > 1) this.detector.report('multiple-page-styles', 1, 'style:master-page');

    let header: J[] = [];
    let footer: J[] = [];
    if (initial !== undefined) {
      for (const key of ['style:header-first', 'style:footer-first']) {
        if ((initial.regions.get(key)?.roots.length ?? 0) > 0) this.detector.report('first-page-header-footer', 1, key);
      }
      for (const key of ['style:header-left', 'style:footer-left']) {
        const r = initial.regions.get(key);
        if (r !== undefined && r.attrs['style:display'] !== 'false') this.detector.report('odd-even-header-footer', 1, key);
      }
      header = await this.#mapRegion(initial, 'style:header', 'header');
      footer = await this.#mapRegion(initial, 'style:footer', 'footer');
    }

    let body = this.body;
    while (body[0]?.type === 'page_break') body = body.slice(1); // a leading page break only adds a blank page
    if (body.length === 0) body = [{ type: 'paragraph', attrs: { ...emptyParaAttrs() } }];

    const page = this.#pageSettings(initial, header.length > 0, footer.length > 0);
    const content: J[] = [];
    if (header.length > 0) content.push({ type: 'header', content: header });
    content.push({ type: 'body', content: body });
    if (footer.length > 0) content.push({ type: 'footer', content: footer });
    return {
      type: 'doc',
      attrs: { size: page.size, orientation: page.orientation, margins: page.margins, textDefaults: this.textDefaults },
      content,
    };
  }

  #initialMaster(): MasterPage | undefined {
    if (this.firstBlockMaster !== undefined) {
      const m = this.masters.find((x) => x.name === this.firstBlockMaster);
      if (m !== undefined) return m;
    }
    return this.masters.find((m) => m.name === 'Standard') ?? this.masters[0];
  }

  async #mapRegion(m: MasterPage, key: string, region: 'header' | 'footer'): Promise<J[]> {
    const r = m.regions.get(key);
    if (r === undefined || r.attrs['style:display'] === 'false') return [];
    const ctx: Ctx = { region, top: false, inList: false };
    const out: J[] = [];
    for (const root of r.roots) {
      await resolveAssets(root);
      this.#detectTree(root, 4, region);
      out.push(...this.mapBlock(root, ctx));
    }
    return out;
  }

  #detectTree(n: ENode, depth: number, region: 'header' | 'footer'): void {
    this.detector.onElement(n.name, n.attrs, { depth, region });
    for (const k of eKids(n)) this.#detectTree(k, depth + 1, region);
  }

  #pageSettings(master: MasterPage | undefined, hasHeader: boolean, hasFooter: boolean): {
    size: { width: number; height: number };
    orientation: 'portrait' | 'landscape';
    margins: { top: number; right: number; bottom: number; left: number };
  } {
    const layout = master?.layout === undefined ? undefined : this.sheet.layouts.get(master.layout);
    const props = layout?.children.find((c) => c.name === 'style:page-layout-properties')?.attrs ?? {};
    const width = snap(lengthPt(props['fo:page-width']) ?? A4_WIDTH_PT);
    const height = snap(lengthPt(props['fo:page-height']) ?? A4_HEIGHT_PT);
    const orientation = props['style:print-orientation'] === 'landscape' || props['style:print-orientation'] === 'portrait'
      ? props['style:print-orientation']
      : width > height ? 'landscape' : 'portrait';
    const all = lengthPt(props['fo:margin']) ?? 0;
    const side = (k: string): number => lengthPt(props[`fo:margin-${k}`]) ?? all;
    // S-9: our margin is the page edge to the body text. ODF's margin stops at the header or footer.
    const hf = (kind: 'header' | 'footer'): number => {
      const p = layout?.children.find((c) => c.name === `style:${kind}-style`)?.children.find((c) => c.name === 'style:header-footer-properties')?.attrs ?? {};
      const h = lengthPt(p['svg:height']) ?? lengthPt(p['fo:min-height']) ?? 0;
      // With dynamic spacing (what LibreOffice writes for Word files) the spacing is inside the
      // height; otherwise it is added. features-word.docx (15/20 mm margins) confirms this.
      const gap = p['style:dynamic-spacing'] === 'true' ? 0 : (lengthPt(p[kind === 'header' ? 'fo:margin-bottom' : 'fo:margin-top']) ?? 0);
      return h + gap;
    };
    const margins = {
      top: snap(side('top') + (hasHeader ? hf('header') : 0)),
      right: snap(side('right')),
      bottom: snap(side('bottom') + (hasFooter ? hf('footer') : 0)),
      left: snap(side('left')),
    };
    const ok =
      width >= 36 && width <= 4000 && height >= 36 && height <= 4000 &&
      Object.values(margins).every((v) => v >= 0 && v <= 1000) &&
      pageSettingsFit({ size: { width, height }, orientation, margins });
    if (!ok) throw fail('The page size or margins are outside what the editor supports');
    return { size: { width, height }, orientation, margins };
  }
}

function repeat(v: string | undefined): number {
  const n = v === undefined ? 1 : Number(v);
  if (!Number.isInteger(n) || n < 1) return 1;
  if (n > MAX_REPEAT) throw fail('A repeated table row or cell count is too large');
  return n;
}

function spanOf(v: string | undefined): number {
  const n = v === undefined ? 1 : Number(v);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

function emptyParaAttrs(): Record<string, unknown> {
  return { align: 'left', spacingBefore: null, spacingAfter: null, lineHeight: null, indentLeft: null, indentRight: null, indentFirstLine: null };
}

type RunMarks = { link: string | null; tp: TextProps };

/** Reads the inline content of one paragraph, collapsing whitespace as ODF defines (§14.5). */
class InlineReader {
  #lastSpace = true;

  constructor(
    private readonly imp: Importer,
    private readonly out: Inline,
    private readonly ctx: Ctx,
    private readonly base: TextProps,
  ) {}

  walk(n: ENode, tp: TextProps, link: string | null): void {
    for (const k of n.kids) {
      if (typeof k === 'string') {
        this.#raw(k, { link, tp });
        continue;
      }
      switch (k.name) {
        case 'text:span': {
          const chain = this.imp.sheet.chain('text', k.attrs['text:style-name']);
          let next = tp;
          // LibreOffice styles a link's text as "Internet link" (blue, underlined) when it saves docx.
          // That is how a link looks, not formatting of the text, so it is not kept as marks.
          for (const s of chain) if (link === null || !LINK_STYLES.has(s.name)) next = applyText(next, s.text, this.imp.sheet.fonts);
          this.walk(k, next, link);
          break;
        }
        case 'text:a': {
          const href = k.attrs['xlink:href'];
          // The style of a link (LibreOffice's "Internet link") is not formatting we keep.
          this.walk(k, tp, href !== undefined && isAllowedHref(href) ? href : link);
          break;
        }
        case 'text:s': {
          const c = Number(k.attrs['text:c'] ?? '1');
          const count = Number.isInteger(c) && c >= 1 ? Math.min(c, 10_000) : 1;
          this.#push(' '.repeat(count), { link, tp });
          this.#lastSpace = false;
          break;
        }
        case 'text:tab':
          this.#push('\t', { link, tp });
          this.#lastSpace = false;
          break;
        case 'text:line-break':
          this.out.nodes.push(withMarks({ type: 'hard_break' }, this.#marks({ link, tp })));
          this.#lastSpace = true;
          break;
        case 'text:page-number':
        case 'text:page-count':
          if (this.ctx.region === 'body') this.walk(k, tp, link); // reported as a field; keep its value
          else {
            const kind = k.name === 'text:page-number' ? 'number' : 'count';
            this.out.nodes.push(withMarks({ type: 'page_field', attrs: { kind } }, this.#marks({ link: null, tp })));
            this.#lastSpace = false;
          }
          break;
        case 'draw:frame':
          this.out.frames.push(k);
          break;
        default:
          if (!SKIP_INLINE.has(k.name)) this.walk(k, tp, link);
      }
    }
  }

  #raw(s: string, m: RunMarks): void {
    let out = '';
    for (const ch of s) {
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        if (!this.#lastSpace) {
          out += ' ';
          this.#lastSpace = true;
        }
      } else {
        out += ch;
        this.#lastSpace = false;
      }
    }
    if (out !== '') this.#push(out, m);
  }

  #push(text: string, m: RunMarks): void {
    const marks = this.#marks(m);
    const last = this.out.nodes[this.out.nodes.length - 1];
    if (last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(marks)) {
      last.text = (last.text ?? '') + text;
      return;
    }
    const node: J = { type: 'text', text };
    this.out.nodes.push(withMarks(node, marks));
  }

  #marks(m: RunMarks): NonNullable<J['marks']> {
    const marks: NonNullable<J['marks']> = [];
    const e = m.tp;
    const b = this.base;
    if (m.link !== null) marks.push({ type: 'link', attrs: { href: m.link } });
    if (e.bold && !b.bold) marks.push({ type: 'bold' });
    if (e.italic && !b.italic) marks.push({ type: 'italic' });
    if (e.underline && !b.underline) marks.push({ type: 'underline' });
    if (e.strike && !b.strike) marks.push({ type: 'strike' });
    const fontFamily = e.fontFamily !== null && e.fontFamily.toLowerCase() !== b.fontFamily?.toLowerCase() ? e.fontFamily : null;
    const fontSize = e.fontSize !== null && e.fontSize !== b.fontSize ? e.fontSize : null;
    const color = e.color !== null && e.color !== b.color ? e.color : null;
    if (fontFamily !== null || fontSize !== null || color !== null) {
      marks.push({ type: 'text_style', attrs: { fontFamily, fontSize, color } });
    }
    return marks;
  }
}

function withMarks(node: J, marks: NonNullable<J['marks']>): J {
  if (marks.length > 0) node.marks = marks;
  return node;
}

/** Reads a `.fodt` into the model JSON. */
async function readFodt(i: {
  flatXmlPath: string;
  assetDir: string;
  maxBytes: number;
  lo: MapperLo;
}): Promise<ImportJobResult> {
  const imp = new Importer({ assetDir: i.assetDir, flatXmlPath: i.flatXmlPath, lo: i.lo });
  await parseXmlFile(
    i.flatXmlPath,
    { maxBytes: i.maxBytes, treeElements: new Set(['office:font-face-decls', 'office:styles', 'office:automatic-styles']) },
    imp.handlers,
  );
  await imp.finishStream();
  const doc = await imp.buildDoc();
  const findings: UnsupportedFinding[] = imp.detector.finish();
  const conversions: ConversionNotice[] =
    imp.conversionCount > 0 ? [{ feature: 'image-to-png', count: imp.conversionCount, where: imp.conversionWhere }] : [];
  return { kind: 'text', snapshot: doc, findings, assetIds: imp.assetIds, ...(conversions.length > 0 ? { conversions } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function esc(s: string): string {
  return s.replace(XML_BAD, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const pt = (n: number): string => `${String(r2(n))}pt`;

/** A piece of the output: markup, or an image to embed as base64 when written. */
type Part = string | { image: string; mime: string };

interface Mark {
  type: string;
  attrs?: Record<string, unknown>;
}

const HEADING_SIZE: readonly number[] = [20, 17, 15, 13, 12, 11];
const LIST_BULLETS = ['•', '◦', '▪'];
const LIST_NUMBERS: ReadonlyArray<[format: string, suffix: string]> = [['1', '.'], ['a', ')'], ['i', '.']];

/** Collects styles while the body is written, then lays out the whole file. */
class Exporter {
  readonly #body: Part[] = [];
  readonly #paraStyles = new Map<string, string>();
  readonly #paraXml: string[] = [];
  readonly #textStyles = new Map<string, string>();
  readonly #textXml: string[] = [];
  readonly #tableXml: string[] = [];
  readonly #fonts = new Set<string>();
  readonly #assets = new Map<string, { mime: string; w: number; h: number }>();
  #pendingBreak = false;
  #listDepth = 0;
  #tables = 0;
  #frames = 0;

  constructor(
    private readonly doc: J,
    private readonly assetDir: string,
  ) {}

  async run(out: Writable): Promise<void> {
    const attrs = this.doc.attrs ?? {};
    const kids = this.doc.content ?? [];
    const header = kids.find((k) => k.type === 'header');
    const body = kids.find((k) => k.type === 'body');
    const footer = kids.find((k) => k.type === 'footer');
    await this.#prefetch(this.doc);
    const td = attrs['textDefaults'] as { fontFamily: string | null; fontSize: number | null; color: string | null };
    if (td.fontFamily !== null) this.#fonts.add(td.fontFamily);

    const bodyParts = this.#region(body?.content ?? [], 'Standard');
    const headerParts = header === undefined ? null : this.#region(header.content ?? [], 'Header');
    const footerParts = footer === undefined ? null : this.#region(footer.content ?? [], 'Footer');

    const head: string[] = [];
    head.push(
      '<?xml version="1.0" encoding="UTF-8"?>\n',
      '<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">\n',
      '<office:font-face-decls>',
      ...[...this.#fonts].map((f) => `<style:font-face style:name="${esc(f)}" svg:font-family="'${esc(f)}'"/>`),
      '</office:font-face-decls>\n',
      '<office:styles>',
      `<style:default-style style:family="paragraph"><style:text-properties${td.fontFamily === null ? '' : ` style:font-name="${esc(td.fontFamily)}"`}${td.fontSize === null ? '' : ` fo:font-size="${pt(td.fontSize)}"`}${td.color === null ? '' : ` fo:color="${td.color}"`}/></style:default-style>`,
      '<style:style style:name="Standard" style:family="paragraph" style:class="text"><style:paragraph-properties fo:margin-top="0pt" fo:margin-bottom="0pt" fo:margin-left="0pt" fo:margin-right="0pt" fo:text-indent="0pt" fo:line-height="100%" fo:text-align="start"/></style:style>',
      '<style:style style:name="Header" style:family="paragraph" style:parent-style-name="Standard"/>',
      '<style:style style:name="Footer" style:family="paragraph" style:parent-style-name="Standard"/>',
      '<style:style style:name="Heading" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:font-weight="bold"/></style:style>',
      ...HEADING_SIZE.map(
        (size, i) =>
          `<style:style style:name="Heading_20_${String(i + 1)}" style:display-name="Heading ${String(i + 1)}" style:family="paragraph" style:parent-style-name="Heading" style:default-outline-level="${String(i + 1)}"><style:text-properties fo:font-size="${String(size)}pt"/></style:style>`,
      ),
      '</office:styles>\n',
      '<office:automatic-styles>',
      this.#pageLayout(attrs, header !== undefined, footer !== undefined),
      ...this.#paraXml,
      ...this.#textXml,
      ...this.#tableXml,
      '<style:style style:name="fr1" style:family="graphic"><style:graphic-properties style:wrap="none" style:vertical-pos="top" style:vertical-rel="baseline"/></style:style>',
      listStyleXml('L_bullet', 'bullet'),
      listStyleXml('L_number', 'number'),
      '</office:automatic-styles>\n',
      '<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1">',
    );
    const write = async (s: string): Promise<void> => {
      if (!out.write(s)) await once(out, 'drain');
    };
    // The font list above was built from every style; it is complete now that the body is mapped.
    for (const s of head) await write(s);
    const writeParts = async (parts: Part[]): Promise<void> => {
      for (const p of parts) {
        if (typeof p === 'string') await write(p);
        else {
          const bytes = await this.#readAsset(p.image);
          await write(`<draw:image draw:mime-type="${p.mime}"><office:binary-data>${Buffer.from(bytes).toString('base64')}</office:binary-data></draw:image>`);
        }
      }
    };
    if (headerParts !== null) {
      await write('<style:header>');
      await writeParts(headerParts);
      await write('</style:header>');
    }
    if (footerParts !== null) {
      await write('<style:footer>');
      await writeParts(footerParts);
      await write('</style:footer>');
    }
    await write('</style:master-page></office:master-styles>\n<office:body><office:text>\n');
    await writeParts(bodyParts);
    await write('</office:text></office:body></office:document>\n');
  }

  async #readAsset(id: string): Promise<Uint8Array> {
    if (!isAssetId(id)) throw fail('The document refers to an invalid image id');
    try {
      return new Uint8Array(await readFile(join(this.assetDir, id)));
    } catch (e) {
      throw fail('An image of the document is missing', e);
    }
  }

  // --- page ------------------------------------------------------------------------------------

  #pageLayout(attrs: Record<string, unknown>, hasHeader: boolean, hasFooter: boolean): string {
    const size = attrs['size'] as { width: number; height: number };
    const m = attrs['margins'] as { top: number; right: number; bottom: number; left: number };
    // S-9: split our body margin into ODF's page margin plus the header or footer height.
    const edge = (v: number): number => Math.min(36, v / 2);
    const top = hasHeader ? edge(m.top) : m.top;
    const bottom = hasFooter ? edge(m.bottom) : m.bottom;
    return (
      `<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="${pt(size.width)}" fo:page-height="${pt(size.height)}" style:print-orientation="${String(attrs['orientation'])}" fo:margin-top="${pt(top)}" fo:margin-bottom="${pt(bottom)}" fo:margin-left="${pt(m.left)}" fo:margin-right="${pt(m.right)}"/>` +
      (hasHeader ? `<style:header-style><style:header-footer-properties fo:min-height="${pt(m.top - top)}" fo:margin-bottom="0pt"/></style:header-style>` : '') +
      (hasFooter ? `<style:footer-style><style:header-footer-properties fo:min-height="${pt(m.bottom - bottom)}" fo:margin-top="0pt"/></style:footer-style>` : '') +
      '</style:page-layout>'
    );
  }

  // --- blocks ----------------------------------------------------------------------------------

  #region(blocks: J[], paraParent: string): Part[] {
    const parts: Part[] = [];
    for (const b of blocks) this.#block(b, paraParent, parts);
    if (this.#pendingBreak) parts.push(`<text:p text:style-name="${this.#paraStyle('Standard', {})}"/>`);
    this.#pendingBreak = false;
    return parts;
  }

  #block(b: J, parent: string, out: Part[]): void {
    switch (b.type) {
      case 'paragraph':
        out.push(`<text:p text:style-name="${this.#paraStyle(parent, b.attrs ?? {})}">`, ...this.#inline(b.content ?? []), '</text:p>\n');
        break;
      case 'heading': {
        const level = clamp(Number(b.attrs?.['level'] ?? 1), 1, 6);
        out.push(`<text:h text:style-name="${this.#paraStyle(`Heading_20_${String(level)}`, b.attrs ?? {})}" text:outline-level="${String(level)}">`, ...this.#inline(b.content ?? []), '</text:h>\n');
        break;
      }
      case 'page_break':
        if (this.#pendingBreak) out.push(`<text:p text:style-name="${this.#paraStyle('Standard', {})}"/>\n`);
        this.#pendingBreak = true;
        break;
      case 'bullet_list':
      case 'ordered_list':
        this.#list(b, parent, out);
        break;
      case 'table':
        this.#table(b, parent, out);
        break;
      case 'image':
        this.#image(b, out);
        break;
      default:
        throw fail(`Cannot write a "${b.type}" block`);
    }
  }

  #paraStyle(parent: string, a: Record<string, unknown>): string {
    const props: string[] = [];
    const align = a['align'] as string | undefined;
    if (align === 'center' || align === 'justify') props.push(`fo:text-align="${align}"`);
    else if (align === 'right') props.push('fo:text-align="right"');
    const len = (key: string, css: string): void => {
      const v = a[key];
      if (typeof v === 'number') props.push(`${css}="${pt(v)}"`);
    };
    len('spacingBefore', 'fo:margin-top');
    len('spacingAfter', 'fo:margin-bottom');
    if (this.#listDepth === 0) {
      len('indentLeft', 'fo:margin-left');
      len('indentRight', 'fo:margin-right');
      len('indentFirstLine', 'fo:text-indent');
    }
    const lh = a['lineHeight'] as { kind: string; value?: number; pt?: number } | null | undefined;
    if (lh) {
      if (lh.kind === 'multiple') props.push(`fo:line-height="${String(r2((lh.value ?? 1) * 100))}%"`);
      else if (lh.kind === 'exact') props.push(`fo:line-height="${pt(lh.pt ?? 1)}"`);
      else props.push(`style:line-height-at-least="${pt(lh.pt ?? 1)}"`);
    }
    if (this.#pendingBreak) {
      props.push('fo:break-before="page"');
      this.#pendingBreak = false;
    }
    if (props.length === 0) return parent;
    const key = `${parent}|${props.join(' ')}`;
    let name = this.#paraStyles.get(key);
    if (name === undefined) {
      name = `P${String(this.#paraStyles.size + 1)}`;
      this.#paraStyles.set(key, name);
      this.#paraXml.push(`<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="${parent}"><style:paragraph-properties ${props.join(' ')}/></style:style>`);
    }
    return name;
  }

  #list(l: J, parent: string, out: Part[]): void {
    const ordered = l.type === 'ordered_list';
    const order = Number(l.attrs?.['order'] ?? 1);
    out.push(`<text:list text:style-name="${ordered ? 'L_number' : 'L_bullet'}">`);
    this.#listDepth += 1;
    (l.content ?? []).forEach((item, idx) => {
      out.push(ordered && idx === 0 && order !== 1 ? `<text:list-item text:start-value="${String(order)}">` : '<text:list-item>');
      for (const c of item.content ?? []) {
        if (c.type === 'bullet_list' || c.type === 'ordered_list') this.#list(c, parent, out);
        else this.#block(c, parent, out);
      }
      out.push('</text:list-item>');
    });
    out.push('</text:list>\n');
  }

  #table(t: J, parent: string, out: Part[]): void {
    const rows = t.content ?? [];
    // Lay the cells out on a grid first: the column count and widths are needed before any row is written.
    interface Placed {
      cell: J;
      col: number;
      colspan: number;
      rowspan: number;
    }
    const grid: Placed[][] = [];
    const cover: number[] = []; // rows still covered below, per column
    const covered: number[][] = []; // per row: columns that hold a covered placeholder
    const widths: Array<number | undefined> = [];
    let ncols = 0;
    for (const row of rows) {
      const placed: Placed[] = [];
      const cov: number[] = [];
      let c = 0;
      const skipCovered = (): void => {
        while ((cover[c] ?? 0) > 0) {
          cov.push(c);
          cover[c] = (cover[c] ?? 0) - 1;
          c += 1;
        }
      };
      for (const cell of row.content ?? []) {
        skipCovered();
        const colspan = Number(cell.attrs?.['colspan'] ?? 1);
        const rowspan = Number(cell.attrs?.['rowspan'] ?? 1);
        const cw = cell.attrs?.['colwidth'] as number[] | null | undefined;
        placed.push({ cell, col: c, colspan, rowspan });
        for (let k = 0; k < colspan; k += 1) {
          const w = cw?.[k];
          if (w !== undefined && widths[c + k] === undefined) widths[c + k] = w;
          if (k > 0) cov.push(c + k);
          cover[c + k] = rowspan - 1;
        }
        c += colspan;
      }
      skipCovered();
      ncols = Math.max(ncols, c);
      grid.push(placed);
      covered.push(cov);
    }
    const colWidth = (i: number): number => widths[i] ?? 100;
    this.#tables += 1;
    const tname = `Tbl${String(this.#tables)}`;
    const total = Array.from({ length: ncols }, (_, i) => colWidth(i)).reduce((a, b) => a + b, 0) * 0.75;
    this.#tableXml.push(
      `<style:style style:name="${tname}" style:family="table"><style:table-properties style:width="${pt(total)}" table:align="left"${this.#pendingBreak ? ' fo:break-before="page"' : ''}/></style:style>`,
    );
    this.#pendingBreak = false;
    for (let i = 0; i < ncols; i += 1) {
      this.#tableXml.push(`<style:style style:name="${tname}.C${String(i + 1)}" style:family="table-column"><style:table-column-properties style:column-width="${pt(colWidth(i) * 0.75)}"/></style:style>`);
    }
    out.push(`<table:table table:name="${tname}" table:style-name="${tname}">`);
    for (let i = 0; i < ncols; i += 1) out.push(`<table:table-column table:style-name="${tname}.C${String(i + 1)}"/>`);
    const isHeaderRow = (r: J): boolean => (r.content ?? []).length > 0 && (r.content ?? []).every((c) => c.type === 'table_header');
    let headerRows = 0;
    while (headerRows < rows.length && isHeaderRow(rows[headerRows] as J)) headerRows += 1;
    grid.forEach((placed, ri) => {
      if (ri === 0 && headerRows > 0) out.push('<table:table-header-rows>');
      out.push('<table:table-row>');
      const coveredCols = new Set(covered[ri]);
      const byCol = new Map(placed.map((p) => [p.col, p]));
      for (let c = 0; c < ncols; c += 1) {
        const p = byCol.get(c);
        if (p !== undefined) {
          out.push(`<table:table-cell office:value-type="string"${p.colspan > 1 ? ` table:number-columns-spanned="${String(p.colspan)}"` : ''}${p.rowspan > 1 ? ` table:number-rows-spanned="${String(p.rowspan)}"` : ''}>`);
          for (const b of p.cell.content ?? []) this.#block(b, parent, out);
          out.push('</table:table-cell>');
        } else if (coveredCols.has(c)) out.push('<table:covered-table-cell/>');
        else out.push('<table:table-cell office:value-type="string"><text:p text:style-name="Standard"/></table:table-cell>');
      }
      out.push('</table:table-row>');
      if (ri === headerRows - 1 && headerRows > 0) out.push('</table:table-header-rows>');
    });
    out.push('</table:table>\n');
  }

  #image(b: J, out: Part[]): void {
    const a = b.attrs ?? {};
    const id = String(a['assetId']);
    const meta = this.#assets.get(id);
    if (meta === undefined) throw fail('An image of the document is missing');
    this.#frames += 1;
    const w = typeof a['width'] === 'number' ? a['width'] : meta.w * 0.75;
    const h = typeof a['height'] === 'number' ? a['height'] : meta.h * 0.75;
    const style = this.#paraStyle('Standard', {});
    out.push(
      `<text:p text:style-name="${style}"><draw:frame draw:style-name="fr1" draw:name="Image${String(this.#frames)}" text:anchor-type="as-char" svg:width="${pt(w)}" svg:height="${pt(h)}">`,
      { image: id, mime: meta.mime },
      `${typeof a['alt'] === 'string' && a['alt'] !== '' ? `<svg:desc>${esc(a['alt'])}</svg:desc>` : ''}</draw:frame></text:p>\n`,
    );
  }

  /** Reads every image once, so the writer knows its type and size. Only the metadata is kept. */
  async #prefetch(n: J): Promise<void> {
    if (n.type === 'image') {
      const id = String(n.attrs?.['assetId']);
      if (!this.#assets.has(id)) {
        const bytes = await this.#readAsset(id);
        const mime = sniffAssetMime(bytes);
        if (mime === null) throw fail('An image of the document is not a PNG, JPEG or GIF');
        const size = imageSizePx(bytes) ?? { w: 100 / 0.75, h: 100 / 0.75 };
        this.#assets.set(id, { mime, w: size.w, h: size.h });
      }
    }
    for (const c of n.content ?? []) await this.#prefetch(c);
  }

  // --- inline ----------------------------------------------------------------------------------

  #inline(content: J[]): Part[] {
    interface Tok {
      kind: 'char' | 'br' | 'field';
      ch?: string;
      field?: string;
      marks: Mark[];
    }
    const toks: Tok[] = [];
    for (const n of content) {
      const marks = n.marks ?? [];
      if (n.type === 'text') {
        for (const ch of n.text ?? '') toks.push({ kind: 'char', ch, marks });
      } else if (n.type === 'hard_break') toks.push({ kind: 'br', marks });
      else if (n.type === 'page_field') toks.push({ kind: 'field', field: String(n.attrs?.['kind']), marks });
      else throw fail(`Cannot write a "${n.type}" inline node`);
    }
    const isVisible = (t: Tok | undefined): boolean => t !== undefined && t.kind === 'char' && t.ch !== ' ' && t.ch !== '\n' && t.ch !== '\r';
    const enc = toks.map((t, i): string => {
      if (t.kind === 'br') return '<text:line-break/>';
      if (t.kind === 'field') return t.field === 'count' ? '<text:page-count>1</text:page-count>' : '<text:page-number text:select-page="current">1</text:page-number>';
      const ch = t.ch ?? '';
      if (ch === '\t') return '<text:tab/>';
      if (ch === '\n') return '<text:line-break/>';
      if (ch === '\r') return '';
      if (ch === ' ') return isVisible(toks[i - 1]) && isVisible(toks[i + 1]) ? ' ' : '<text:s/>';
      return esc(ch);
    });
    const parts: Part[] = [];
    const markKey = (t: Tok): string => JSON.stringify(t.marks.filter((m) => m.type !== 'link'));
    const linkOf = (t: Tok): string | null => (t.marks.find((m) => m.type === 'link')?.attrs?.['href'] as string | undefined) ?? null;
    let i = 0;
    while (i < toks.length) {
      const link = linkOf(toks[i] as Tok);
      let j = i;
      while (j < toks.length && linkOf(toks[j] as Tok) === link) j += 1;
      if (link !== null) parts.push(`<text:a xlink:type="simple" xlink:href="${esc(link)}">`);
      let k = i;
      while (k < j) {
        const key = markKey(toks[k] as Tok);
        let m = k;
        let s = '';
        while (m < j && markKey(toks[m] as Tok) === key) {
          s += enc[m] ?? '';
          m += 1;
        }
        s = s.replace(/(?:<text:s\/>){2,}/g, (run) => `<text:s text:c="${String(run.length / '<text:s/>'.length)}"/>`);
        const style = this.#textStyle(toks[k]?.marks ?? []);
        parts.push(style === null ? s : `<text:span text:style-name="${style}">${s}</text:span>`);
        k = m;
      }
      if (link !== null) parts.push('</text:a>');
      i = j;
    }
    return parts;
  }

  #textStyle(allMarks: Mark[]): string | null {
    const marks = allMarks.filter((m) => m.type !== 'link');
    if (marks.length === 0) return null;
    const props: string[] = [];
    for (const m of marks) {
      if (m.type === 'bold') props.push('fo:font-weight="bold"');
      else if (m.type === 'italic') props.push('fo:font-style="italic"');
      else if (m.type === 'underline') props.push('style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"');
      else if (m.type === 'strike') props.push('style:text-line-through-style="solid" style:text-line-through-type="single"');
      else if (m.type === 'text_style') {
        const a = m.attrs ?? {};
        if (typeof a['fontFamily'] === 'string') {
          this.#fonts.add(a['fontFamily']);
          props.push(`style:font-name="${esc(a['fontFamily'])}"`);
        }
        if (typeof a['fontSize'] === 'number') props.push(`fo:font-size="${pt(a['fontSize'])}"`);
        if (typeof a['color'] === 'string') props.push(`fo:color="${esc(a['color'])}"`);
      }
    }
    if (props.length === 0) return null;
    const key = props.join(' ');
    let name = this.#textStyles.get(key);
    if (name === undefined) {
      name = `T${String(this.#textStyles.size + 1)}`;
      this.#textStyles.set(key, name);
      this.#textXml.push(`<style:style style:name="${name}" style:family="text"><style:text-properties ${key}/></style:style>`);
    }
    return name;
  }
}

function listStyleXml(name: string, kind: 'bullet' | 'number'): string {
  const levels: string[] = [];
  for (let l = 1; l <= 10; l += 1) {
    const margin = `${String(r2(l * 36))}pt`;
    const props = `<style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-18pt" fo:margin-left="${margin}"/></style:list-level-properties>`;
    if (kind === 'bullet') {
      levels.push(`<text:list-level-style-bullet text:level="${String(l)}" text:bullet-char="${LIST_BULLETS[(l - 1) % 3] ?? '•'}">${props}</text:list-level-style-bullet>`);
    } else {
      const [format, suffix] = LIST_NUMBERS[(l - 1) % 3] ?? ['1', '.'];
      levels.push(`<text:list-level-style-number text:level="${String(l)}" style:num-format="${format}" style:num-suffix="${suffix}">${props}</text:list-level-style-number>`);
    }
  }
  return `<text:list-style style:name="${name}">${levels.join('')}</text:list-style>`;
}

/** Writes the model as `.fodt`. Exposed for tests; the thread calls it through {@link FodtMapper}. */
async function writeFodt(i: { model: unknown; flatXmlPath: string; assetDir: string }): Promise<void> {
  TextOtType.deserializeSnapshot(i.model); // the model must be valid before anything is written
  const doc = i.model as J;
  const stream = createWriteStream(i.flatXmlPath);
  const done = once(stream, 'close');
  try {
    await new Exporter(doc, i.assetDir).run(stream);
    stream.end();
    await done;
  } catch (e) {
    stream.destroy();
    throw e;
  }
}

/**
 * The text mapper the codec thread calls (§14.5). `import` and `export` implement
 * {@link CodecMapper}; sheet formats are not supported before V2.
 */
export class FodtMapper implements CodecMapper {
  async import(i: Parameters<CodecMapper['import']>[0]): Promise<ImportJobResult> {
    if (i.format !== 'docx' && i.format !== 'odt') throw fail('Sheet documents are not supported yet');
    return readFodt({ flatXmlPath: i.flatXmlPath, assetDir: i.assetDir, maxBytes: i.limits.maxFlatXmlBytes, lo: i.lo });
  }

  async export(i: Parameters<CodecMapper['export']>[0]): Promise<void> {
    if (i.kind !== 'text') throw fail('Sheet documents are not supported yet');
    await writeFodt({ model: i.model, flatXmlPath: i.flatXmlPath, assetDir: i.assetDir });
  }
}
