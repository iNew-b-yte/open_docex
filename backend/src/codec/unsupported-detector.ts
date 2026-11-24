/**
 * UnsupportedDetector for text documents (LLD Part 2 §14.7; §0 PO-13, PO-14, PO-21, R-15, S-12,
 * S-43). The mapper reports every element it reads, plus a few facts only it knows (an image mixed
 * with text, a linked image, several page styles). `finish()` groups them into
 * `UnsupportedFinding`s.
 *
 * Feature ids (S-43): the shared `UnsupportedFeature` union is frozen and has fewer members than
 * the §14.7 table. A table id with a union member uses that member; every other id is reported as
 * `feature: 'other'` with `detail` set to the table's id (for example `'macros'`).
 * `detail` of a union member is the name of the first element seen (§14.7: "never document text").
 *
 * Formatting outside the schema is dropped silently, except paragraph and heading borders and
 * shading, which are findings (PO-20, HLD §8.1). Table-cell borders and backgrounds are dropped.
 *
 * V2 sheet signals are out of scope here (V2).
 *
 * @module
 */
import type { UnsupportedFeature, UnsupportedFinding } from '@open-docex/shared/protocol';
import { isAllowedHref } from '@open-docex/shared/text';

/** The ids of the §14.7 table that apply to text. */
export type TextFindingId =
  | 'tracked-changes'
  | 'comments'
  | 'footnotes'
  | 'fields'
  | 'toc-index'
  | 'text-box-shape'
  | 'equation-object'
  | 'chart'
  | 'sections'
  | 'multiple-page-styles'
  | 'first-page-header-footer'
  | 'odd-even-header-footer'
  | 'columns'
  | 'heading-level'
  | 'link-scheme'
  | 'image-position'
  | 'image-format'
  | 'macros'
  | 'form-controls'
  | 'unknown-element'
  // Not in the §14.7 table. `linked-image` is S-12; `ole-object` is a `draw:object` that is
  // neither a formula nor a chart.
  | 'linked-image'
  | 'ole-object'
  // PO-20: paragraph and heading borders and shading (table-cell ones are dropped silently).
  | 'paragraph-border'
  | 'paragraph-shading';

/** The §14.7 id → shared union member. Ids that are missing here are reported as `'other'`. */
const UNION_MEMBER: Readonly<Partial<Record<TextFindingId, UnsupportedFeature>>> = {
  'tracked-changes': 'tracked-changes',
  comments: 'comments',
  footnotes: 'footnotes',
  fields: 'fields',
  'text-box-shape': 'text-boxes',
  'equation-object': 'equations',
  chart: 'charts',
  'multiple-page-styles': 'multiple-page-styles',
  'first-page-header-footer': 'first-page-header',
  'odd-even-header-footer': 'odd-even-header',
};

/** Where an element sits. Header and footer content of a page style that is not in use is never reported. */
export interface DetectCtx {
  /** 0 = the root element. Used to skip the content of an unsupported container. */
  depth: number;
  region: 'body' | 'header' | 'footer' | 'styles';
}

/** What the mapper calls for each element, and at the end. */
export interface UnsupportedDetectorApi {
  onElement(name: string, attrs: Readonly<Record<string, string>>, ctx: DetectCtx): void;
  finish(): UnsupportedFinding[];
}

const FIELD =
  /^text:(date|time|page-number|page-count|page-continuation|author-name|author-initials|file-name|chapter|sender-[a-z-]+|initial-creator|creator|description|keywords|subject|title|[a-z]+-(date|time)|[a-z]+-count|editing-[a-z]+|printed-by|variable-(set|get|input)|user-field-(get|input)|expression|sequence|[a-z-]+-ref|placeholder|conditional-text|hidden-text|hidden-paragraph|database-[a-z-]+|text-input|measure|template-name|script|page-variable-(get|set)|drop-down)$/;
const TOC_INDEX = /^text:(table-of-content|bibliography|[a-z]+-index)$/;
const SHAPE = new Set([
  'draw:text-box',
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
  'draw:regular-polygon',
  'draw:page-thumbnail',
]);
const FORM_CONTROL = new Set([
  'form:form',
  'form:text',
  'form:textarea',
  'form:password',
  'form:file',
  'form:formatted-text',
  'form:number',
  'form:date',
  'form:time',
  'form:combobox',
  'form:listbox',
  'form:checkbox',
  'form:radio',
  'form:button',
  'form:image',
  'form:image-frame',
  'form:hidden',
  'form:grid',
  'form:value-range',
  'form:generic-control',
]);
/** Elements the mapper maps or silently ignores (§14.5 "ignored" row, §14.7 `unknown-element`). */
const KNOWN = new Set([
  'office:document',
  'office:meta',
  'office:settings',
  'office:scripts',
  'office:script',
  'office:master-styles',
  'office:body',
  'office:text',
  'office:forms',
  'office:event-listeners',
  'office:annotation-end',
  'text:p',
  'text:h',
  'text:span',
  'text:a',
  'text:s',
  'text:tab',
  'text:line-break',
  'text:list',
  'text:list-item',
  'text:list-header',
  'text:soft-page-break',
  'text:sequence-decls',
  'text:sequence-decl',
  'text:variable-decls',
  'text:variable-decl',
  'text:user-field-decls',
  'text:user-field-decl',
  'text:dde-connection-decls',
  'text:alphabetical-index-auto-mark-file',
  'text:tracked-changes',
  'text:change',
  'text:change-start',
  'text:change-end',
  'table:table',
  'table:table-column',
  'table:table-columns',
  'table:table-header-columns',
  'table:table-column-group',
  'table:table-header-rows',
  'table:table-rows',
  'table:table-row-group',
  'table:table-row',
  'table:table-cell',
  'table:covered-table-cell',
  'table:desc',
  'table:title',
  'draw:frame',
  'draw:image',
  'draw:contour-polygon',
  'draw:contour-path',
]);
const BOOKMARK = new Set(['text:bookmark', 'text:bookmark-start', 'text:bookmark-end']);
const CHECKED_PREFIX = new Set(['text', 'table', 'draw', 'office']);

interface Group {
  feature: UnsupportedFeature;
  count: number;
  detail: string;
}

/** The concrete detector. One instance per import. */
export class UnsupportedDetector implements UnsupportedDetectorApi {
  readonly #groups = new Map<string, Group>();
  #skipDepth: number | null = null;
  #pendingObject: { depth: number; name: string } | null = null;
  #region: DetectCtx['region'] | null = null;

  /** Adds `n` occurrences of `id`. `sample` is an element name for a union member. */
  report(id: TextFindingId, n = 1, sample?: string): void {
    const member = UNION_MEMBER[id];
    const key = member ?? `other:${id}`;
    const g = this.#groups.get(key);
    if (g !== undefined) g.count += n;
    else this.#groups.set(key, { feature: member ?? 'other', count: n, detail: member === undefined ? id : (sample ?? id) });
  }

  onElement(name: string, attrs: Readonly<Record<string, string>>, ctx: DetectCtx): void {
    if (this.#region !== ctx.region) {
      this.#region = ctx.region;
      this.#skipDepth = null;
      this.#flushObject();
    }
    const pending = this.#pendingObject;
    if (pending !== null) {
      if (name === 'office:document' && ctx.depth === pending.depth + 1) {
        const mime = attrs['office:mimetype'] ?? '';
        this.report(mime.includes('formula') ? 'equation-object' : mime.includes('chart') ? 'chart' : 'ole-object', 1, pending.name);
        this.#pendingObject = null;
        return;
      }
      this.#flushObject();
    }
    if (this.#skipDepth !== null) {
      if (ctx.depth > this.#skipDepth) return;
      this.#skipDepth = null;
    }
    this.#classify(name, attrs, ctx);
  }

  finish(): UnsupportedFinding[] {
    this.#flushObject();
    return [...this.#groups.values()].map((g) => ({ feature: g.feature, count: g.count, detail: g.detail }));
  }

  #flushObject(): void {
    if (this.#pendingObject !== null) {
      this.report('ole-object', 1, this.#pendingObject.name);
      this.#pendingObject = null;
    }
  }

  #suppress(ctx: DetectCtx): void {
    this.#skipDepth = ctx.depth;
  }

  #classify(name: string, attrs: Readonly<Record<string, string>>, ctx: DetectCtx): void {
    if (name === 'text:changed-region') {
      this.report('tracked-changes', 1, name);
      this.#suppress(ctx);
    } else if (name === 'office:annotation') {
      this.report('comments', 1, name);
      this.#suppress(ctx);
    } else if (name === 'text:note') {
      this.report('footnotes', 1, name);
      this.#suppress(ctx);
    } else if (FIELD.test(name)) {
      const pageField = name === 'text:page-number' || name === 'text:page-count';
      if (!(pageField && (ctx.region === 'header' || ctx.region === 'footer'))) this.report('fields', 1, name);
    } else if (TOC_INDEX.test(name)) {
      this.report('toc-index', 1, name);
      this.#suppress(ctx);
    } else if (name === 'text:section') {
      this.report('sections', 1, name);
    } else if (SHAPE.has(name)) {
      this.report('text-box-shape', 1, name);
      this.#suppress(ctx);
    } else if (name === 'draw:object' || name === 'draw:object-ole') {
      this.#pendingObject = { depth: ctx.depth, name };
      this.#suppress(ctx);
    } else if (FORM_CONTROL.has(name)) {
      this.report('form-controls', 1, name);
      this.#suppress(ctx);
    } else if (name === 'style:columns') {
      if (Number(attrs['fo:column-count'] ?? '1') > 1) this.report('columns', 1, name);
    } else if (this.#isMacro(name, attrs)) {
      this.report('macros', 1, name);
    } else if (BOOKMARK.has(name)) {
      if (!(attrs['text:name'] ?? '').startsWith('_')) this.report('unknown-element', 1, name);
    } else if (KNOWN.has(name)) {
      if (name === 'text:h') {
        const level = Number(attrs['text:outline-level'] ?? '1');
        if (Number.isFinite(level) && level > 6) this.report('heading-level', 1, name);
      } else if (name === 'text:a') {
        const href = attrs['xlink:href'];
        if (href !== undefined && !isAllowedHref(href)) this.report('link-scheme', 1, name);
      }
    } else {
      const prefix = name.slice(0, name.indexOf(':'));
      if (CHECKED_PREFIX.has(prefix)) this.report('unknown-element', 1, name);
    }
  }

  #isMacro(name: string, attrs: Readonly<Record<string, string>>): boolean {
    if (name.endsWith(':library-embedded') || name.endsWith(':library-linked') || name === 'script:module') return true;
    if (name === 'office:script') return (attrs['script:language'] ?? 'ooo:Basic') !== 'ooo:Basic';
    if (name === 'script:event-listener') return (attrs['xlink:href'] ?? '').startsWith('vnd.sun.star.script:');
    return false;
  }
}
