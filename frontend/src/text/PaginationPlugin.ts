/**
 * Pagination for the text editor (LLD Part 3 §10; §0 PO-23, S-1 to S-8; the S3 spike).
 *
 * The editor DOM is exactly one page wide, with padding equal to the margins. A measure pass
 * (in `requestAnimationFrame`) reads block heights, decides where pages break, and dispatches
 * one meta transaction (no document change) that carries the breaks and the decorations. The
 * decorations are spacer widgets, which hold read-only copies of the footer and header, and a
 * tail spacer that pushes the real footer into the last page. A background layer
 * `.odx-page-frames` draws the page rectangles.
 *
 * Styles the surrounding stylesheet (`style.css`) must provide, as S3 used them:
 * `.odx-body > * { margin: 0; box-sizing: border-box }` (block heights then add up exactly),
 * `.odx-page-frames { position: absolute; left: 0; top: 0; width: 100%; z-index: 0 }` and
 * `.odx-page { position: absolute; left: 0; background: #fff }`. This module sets the rest
 * inline, and never adds a `<style>` element.
 *
 * @module
 */
import { getPageSettings } from '@open-docex/shared/text';
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, Selection, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { BlockResizeSignal } from './nodeviews/BlockResizeSignal.js';
import { fillFields, footerOf, headerOf, type HeaderFooterRegions } from './HeaderFooterRegions.js';
import { pageGeometry, readHeight, type HeightReader, type PageGeometry } from './geometry.js';

/** A page break before a body block. */
export interface PageBreakMark {
  /** Position of the first block of the new page. */
  beforePos: number;
  /** The 0-based index of the page that starts here (page 1 is index 0). */
  page: number;
  /** The height of the spacer widget placed before the block. */
  spacerPx: number;
  /** Index of the block among the body's children (§0 S-4). */
  index: number;
}

/** The plugin state. It changes only through the plugin's own meta transaction. */
export interface PaginationState {
  breaks: readonly PageBreakMark[];
  pageCount: number;
  tailSpacerPx: number;
  /** Per page, how far its content runs past the frame (§0 S-3). Frames are placed cumulatively. */
  pageExtra: readonly number[];
  /** Height of the top margin box: `max(margin.top, header height)`. */
  bodyTop: number;
  /** Height of the bottom margin box: `max(margin.bottom, footer height)`. */
  footBox: number;
  geom: PageGeometry | null;
  deco: DecorationSet;
}

/** The plugin key. */
export const paginationKey = new PluginKey<PaginationState>('odx-pagination');

const EMPTY: PaginationState = {
  breaks: [],
  pageCount: 1,
  tailSpacerPx: 0,
  pageExtra: [0],
  bodyTop: 0,
  footBox: 0,
  geom: null,
  deco: DecorationSet.empty,
};

/** What {@link PaginationPlugin} needs. */
export interface PaginationDeps {
  regions: HeaderFooterRegions;
  /** The §0 S-7 signal from the image node views. */
  resize?: BlockResizeSignal;
  /** The §0 S-1 height read. Tests stub it. Default: {@link readHeight}. */
  readHeight?: HeightReader;
}

/** What one pass remembers so the next can resume from the first changed block (§0 S-4). */
interface PassMemo {
  nodes: PMNode[];
  yPre: Float64Array;
  pagePre: Int32Array;
  posOf: Float64Array;
  breaks: PageBreakMark[];
  pageExtra: number[];
  /** The state after the last block: used when the next pass resumes past the end. */
  yEnd: number;
  pageEnd: number;
  posEnd: number;
  geomKey: string;
}

/**
 * A click on the blank space below the last block lands on the tail spacer, which is not
 * editable. Firefox then puts the caret on the editor root, outside any text, and typing and
 * Home/End do nothing. This puts the caret at the end of the document instead. It runs on
 * `click`, not `mousedown`, so ProseMirror still records the mousedown (its "the browser reset
 * the caret after focus" check relies on that, and would undo a Home pressed soon after).
 * The DOM selection is set too, because the state selection may already be the end.
 */
export function caretAtEndOnTailClick(view: EditorView, event: Event): boolean {
  const target = event.target;
  if (!view.editable || !(target instanceof Element) || target.closest('.odx-tail') === null) return false;
  const end = Selection.atEnd(view.state.doc);
  view.dispatch(view.state.tr.setSelection(end).scrollIntoView());
  const at = view.domAtPos(end.head);
  view.dom.ownerDocument.getSelection()?.collapse(at.node, at.offset);
  return false;
}

/** Creates the pagination plugin. */
export function PaginationPlugin(deps: PaginationDeps): Plugin<PaginationState> {
  return new Plugin<PaginationState>({
    key: paginationKey,
    state: {
      init: () => EMPTY,
      apply(tr, value) {
        const meta = tr.getMeta(paginationKey) as PaginationState | undefined;
        if (meta) return meta;
        if (tr.docChanged) return { ...value, deco: value.deco.map(tr.mapping, tr.doc) };
        return value;
      },
    },
    props: {
      decorations: (state) => paginationKey.getState(state)?.deco ?? DecorationSet.empty,
      handleDOMEvents: { click: caretAtEndOnTailClick },
      attributes(state) {
        const p = paginationKey.getState(state) ?? EMPTY;
        const g = pageGeometry(getPageSettings(state.doc));
        // With a real header the header box carries the top margin; likewise for the footer.
        const top = headerOf(state.doc) ? 0 : p.bodyTop || g.margin.top;
        const bottom = footerOf(state.doc) ? 0 : p.footBox || g.margin.bottom;
        return {
          style: `position:relative;z-index:1;box-sizing:border-box;width:${String(g.widthPx)}px;padding:${String(top)}px ${String(g.margin.right)}px ${String(bottom)}px ${String(g.margin.left)}px`,
        };
      },
    },
    view: (view) => new PaginationView(view, deps),
  });
}

interface SpacerEl extends HTMLElement {
  _visible?: boolean;
  _gen?: string | undefined;
}

class PaginationView {
  readonly #view: EditorView;
  readonly #regions: HeaderFooterRegions;
  readonly #read: HeightReader;
  readonly #frames: HTMLElement;
  readonly #spacers = new Set<SpacerEl>();
  readonly #io: IntersectionObserver | undefined;
  readonly #win: Window & typeof globalThis;
  readonly #unsubscribe: (() => void) | undefined;
  readonly #onFonts: () => void;
  #cache = new WeakMap<PMNode, number>();
  #cacheKey = '';
  #last: PassMemo | null = null;
  #invalid: string | null = 'init';
  /** The lowest block index whose height was invalidated since the last pass (§0 S-7). */
  #dirtyFrom = Infinity;
  #raf = 0;
  #passesThisFrame = 0;
  #framesSig = '';
  #copyGen = '';
  #destroyed = false;

  constructor(view: EditorView, deps: PaginationDeps) {
    this.#view = view;
    this.#regions = deps.regions;
    this.#read = deps.readHeight ?? readHeight;
    const doc = view.dom.ownerDocument;
    this.#win = (doc.defaultView ?? window);
    this.#frames = doc.createElement('div');
    this.#frames.className = 'odx-page-frames';
    this.#frames.setAttribute('aria-hidden', 'true');
    const parent = view.dom.parentNode as HTMLElement | null;
    if (parent) {
      // The frames are absolutely positioned against the editor's host.
      if (parent.style.position === '') parent.style.position = 'relative';
      parent.insertBefore(this.#frames, view.dom);
    }
    if (typeof this.#win.IntersectionObserver === 'function') {
      this.#io = new this.#win.IntersectionObserver((entries) => this.#onIntersect(entries), {
        rootMargin: '200% 0px', // render copies within ±2 viewports only
      });
    }
    this.#regions.onResize = () => {
      this.#invalid = 'header/footer resize';
      this.#schedule();
    };
    this.#regions.onCopyStale = () => {
      this.#copyGen = '';
      this.#refreshCopies();
    };
    this.#unsubscribe = deps.resize?.subscribe((e) => this.#onBlockResize(e.pos));
    this.#onFonts = () => {
      this.#cache = new WeakMap();
      this.#invalid = 'fonts';
      this.#schedule();
    };
    doc.fonts?.addEventListener('loadingdone', this.#onFonts);
    this.#schedule();
  }

  update(view: EditorView, prev: EditorState): void {
    if (view.state.doc !== prev.doc || this.#invalid !== null) this.#schedule();
    this.#refreshCopies();
  }

  destroy(): void {
    this.#destroyed = true;
    this.#win.cancelAnimationFrame(this.#raf);
    this.#io?.disconnect();
    this.#frames.remove();
    this.#unsubscribe?.();
    this.#view.dom.ownerDocument.fonts?.removeEventListener('loadingdone', this.#onFonts);
    this.#regions.onResize = null;
    this.#regions.onCopyStale = null;
  }

  /** §0 S-7: the block that contains `pos` has a new height. Forget it and re-run from there. */
  #onBlockResize(pos: number | undefined): void {
    if (pos === undefined || this.#destroyed) return;
    const doc = this.#view.state.doc;
    if (pos < 0 || pos > doc.content.size) return;
    const $pos = doc.resolve(pos);
    for (let d = $pos.depth; d >= 0; d--) {
      if ($pos.node(d).type.name === 'body') {
        const index = $pos.index(d);
        const block = $pos.node(d).maybeChild(index);
        if (block) this.#cache.delete(block);
        this.#dirtyFrom = Math.min(this.#dirtyFrom, index);
        this.#schedule();
        return;
      }
    }
  }

  #schedule(): void {
    if (this.#raf !== 0 || this.#destroyed) return;
    this.#raf = this.#win.requestAnimationFrame(() => {
      this.#raf = 0;
      this.#passesThisFrame = 0;
      this.#pass();
    });
  }

  /** The measure pass: DOM reads only, then at most one meta dispatch. */
  #pass(): void {
    const view = this.#view;
    if (this.#destroyed || view.isDestroyed) return;
    if (view.composing) return this.#schedule();
    if (++this.#passesThisFrame > 2) return this.#schedule(); // loop guard
    const doc = view.state.doc;
    const g = pageGeometry(getPageSettings(doc));
    const hH = this.#regions.measuredHeight('header');
    const fH = this.#regions.measuredHeight('footer');
    const bodyTop = Math.max(g.margin.top, hH);
    const bodyBottom = g.heightPx - Math.max(g.margin.bottom, fH);
    const cap = bodyBottom - bodyTop;
    const footBox = g.heightPx - bodyBottom;
    const geomKey = [g.widthPx, g.heightPx, g.margin.top, g.margin.bottom, g.margin.left, g.margin.right, hH, fH].join();
    // Line wrapping depends on the text width only, so only a width change drops cached heights.
    const cacheKey = [g.widthPx, g.margin.left, g.margin.right].join();
    if (cacheKey !== this.#cacheKey) {
      this.#cache = new WeakMap();
      this.#cacheKey = cacheKey;
    }

    const headerNode = headerOf(doc);
    const bodyIndex = headerNode ? 1 : 0;
    const body = doc.child(bodyIndex);
    const bodyStart = headerNode ? headerNode.nodeSize : 0;
    const n = body.childCount;
    const last = this.#last;

    let s = 0;
    const full = last === null || this.#invalid !== null || last.geomKey !== geomKey;
    if (!full) {
      const m = Math.min(n, last.nodes.length, this.#dirtyFrom);
      while (s < m && body.child(s) === last.nodes[s]) s++;
      if (s === n && n === last.nodes.length) {
        this.#invalid = null;
        this.#dirtyFrom = Infinity;
        return;
      }
    }
    this.#invalid = null;
    this.#dirtyFrom = Infinity;

    // The resume state is the one before block s's own break decision (§0 S-4).
    const nodes: PMNode[] = new Array<PMNode>(n);
    const yPre = new Float64Array(n);
    const pagePre = new Int32Array(n);
    const posOf = new Float64Array(n);
    let y = 0;
    let page = 0;
    let pos = bodyStart + 1;
    let breaks: PageBreakMark[] = [];
    let pageExtra: number[] = [];
    if (s > 0 && last !== null) {
      for (let i = 0; i < s; i++) {
        nodes[i] = last.nodes[i] as PMNode;
        yPre[i] = last.yPre[i] as number;
        pagePre[i] = last.pagePre[i] as number;
        posOf[i] = last.posOf[i] as number;
      }
      // `s` can be one past the last pass's blocks (a block appended at the end). Then the state
      // after that pass's last block is the resume state.
      const atEnd = s >= last.nodes.length;
      y = atEnd ? last.yEnd : (last.yPre[s] as number);
      page = atEnd ? last.pageEnd : (last.pagePre[s] as number);
      pos = atEnd ? last.posEnd : (last.posOf[s] as number);
      breaks = last.breaks.filter((b) => b.index < s);
      pageExtra = last.pageExtra.slice(0, page);
    }

    for (let i = s; i < n; i++) {
      const node = body.child(i);
      nodes[i] = node;
      posOf[i] = pos;
      let h = this.#cache.get(node);
      if (h === undefined) {
        const dom = view.nodeDOM(pos);
        if (dom instanceof HTMLElement) {
          h = this.#read(dom);
          this.#cache.set(node, h);
        } else {
          h = 0;
        }
      }
      yPre[i] = y;
      pagePre[i] = page;
      const forced = i > 0 && body.child(i - 1).type.name === 'page_break';
      if (forced || (y + h > cap && y > 0)) {
        // §0 S-3: a page whose content ran past `cap` records the overflow. The spacer adds it,
        // so the next page starts below the content and the frame is never stretched.
        const overflow = Math.max(0, y - cap);
        pageExtra[page] = overflow;
        breaks.push({
          index: i,
          beforePos: pos,
          page: page + 1,
          spacerPx: cap - y + overflow + footBox + g.gapPx + bodyTop,
        });
        page++;
        y = 0;
      }
      y += h;
      pos += node.nodeSize;
    }
    const overflow = Math.max(0, y - cap);
    pageExtra[page] = overflow;
    const pageCount = page + 1;
    const tailSpacerPx = cap - y + overflow;

    this.#last = { nodes, yPre, pagePre, posOf, yEnd: y, pageEnd: page, posEnd: pos, breaks, pageExtra, geomKey };

    const prev = paginationKey.getState(view.state) ?? EMPTY;
    const same =
      prev.pageCount === pageCount &&
      prev.tailSpacerPx === tailSpacerPx &&
      prev.bodyTop === bodyTop &&
      prev.footBox === footBox &&
      prev.geom !== null &&
      prev.geom.widthPx === g.widthPx &&
      prev.geom.heightPx === g.heightPx &&
      prev.pageExtra.length === pageExtra.length &&
      prev.pageExtra.every((e, i) => e === pageExtra[i]) &&
      prev.breaks.length === breaks.length &&
      prev.breaks.every((b, i) => b.beforePos === breaks[i]?.beforePos && b.spacerPx === breaks[i]?.spacerPx);
    if (same) return;
    const next: PaginationState = {
      breaks,
      pageCount,
      tailSpacerPx,
      pageExtra,
      bodyTop,
      footBox,
      geom: g,
      deco: this.#buildDeco(doc, headerNode, bodyStart, body, breaks, tailSpacerPx, bodyTop, footBox, g),
    };
    view.dispatch(view.state.tr.setMeta(paginationKey, next).setMeta('addToHistory', false));
    this.#updateFrames(next);
  }

  #buildDeco(
    doc: PMNode,
    headerNode: PMNode | null,
    bodyStart: number,
    body: PMNode,
    breaks: readonly PageBreakMark[],
    tailSpacerPx: number,
    bodyTop: number,
    footBox: number,
    g: PageGeometry,
  ): DecorationSet {
    const decos: Decoration[] = [];
    if (headerNode) decos.push(Decoration.node(0, headerNode.nodeSize, { style: `height:${String(bodyTop)}px` }));
    const bodyEnd = bodyStart + body.nodeSize;
    if (footerOf(doc)) decos.push(Decoration.node(bodyEnd, doc.content.size, { style: `height:${String(footBox)}px` }));
    for (const b of breaks) {
      const { page, spacerPx } = b;
      decos.push(
        Decoration.widget(b.beforePos, () => this.#makeSpacer(page, spacerPx, footBox, g.gapPx, bodyTop), {
          side: -1,
          // The slot heights depend on bodyTop and footBox, so the key has both (§0 S-5).
          key: `pb${String(page)}:${String(spacerPx)}:${String(footBox)}:${String(bodyTop)}`,
          ignoreSelection: true,
          destroy: (dom) => {
            this.#spacers.delete(dom as SpacerEl);
            this.#io?.unobserve(dom as Element);
          },
        }),
      );
    }
    decos.push(
      Decoration.widget(
        bodyEnd,
        () => {
          const d = document.createElement('div');
          d.className = 'odx-tail';
          d.contentEditable = 'false';
          d.style.height = `${String(tailSpacerPx)}px`;
          return d;
        },
        { side: -1, key: `tail:${String(tailSpacerPx)}`, ignoreSelection: true },
      ),
    );
    return DecorationSet.create(doc, decos);
  }

  /** Spacer: filler, footer copy of page − 1, gap, header copy of the new page. */
  #makeSpacer(page: number, spacerPx: number, footBox: number, gapPx: number, bodyTop: number): HTMLElement {
    const d = document.createElement('div') as SpacerEl;
    d.className = 'odx-spacer';
    d.contentEditable = 'false';
    d.style.cssText = `display:flex;flex-direction:column;user-select:none;height:${String(spacerPx)}px`;
    d.dataset.page = String(page);
    const filler = document.createElement('div');
    filler.className = 'odx-spacer-fill';
    filler.style.flex = '1 1 auto';
    const foot = document.createElement('div');
    foot.className = 'odx-slot-footer';
    foot.style.cssText = `flex:none;display:flex;flex-direction:column;height:${String(footBox)}px`;
    const gap = document.createElement('div');
    gap.style.height = `${String(gapPx)}px`;
    const head = document.createElement('div');
    head.className = 'odx-slot-header';
    head.style.cssText = `flex:none;display:flex;flex-direction:column;justify-content:flex-end;height:${String(bodyTop)}px`;
    d.append(filler, foot, gap, head);
    this.#spacers.add(d);
    if (this.#io) this.#io.observe(d);
    else d._visible = true; // no IntersectionObserver: every copy is visible
    return d;
  }

  #onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const el = e.target as SpacerEl;
      el._visible = e.isIntersecting;
      if (e.isIntersecting && el._gen !== this.#copyGen) this.#fillSpacer(el);
    }
  }

  #fillSpacer(d: SpacerEl): void {
    const state = this.#view.state;
    const count = (paginationKey.getState(state) ?? EMPTY).pageCount;
    const page = Number(d.dataset.page); // 0-based index of the page that starts here
    d.children[1]?.replaceChildren(this.#regions.renderCopy('footer', state, page, count));
    d.children[3]?.replaceChildren(this.#regions.renderCopy('header', state, page + 1, count));
    d._gen = this.#copyGen;
  }

  /**
   * §0 S-5: updates the real regions' page fields in place, and when the copy generation
   * (header node, footer node, page count) changed, re-fills visible copies and clears hidden ones.
   */
  #refreshCopies(): void {
    const state = this.#view.state;
    const doc = state.doc;
    const count = (paginationKey.getState(state) ?? EMPTY).pageCount;
    const gen = `${String(idOf(headerOf(doc)))}/${String(idOf(footerOf(doc)))}/${String(count)}`;
    // The real header is on page 1, and the real footer on the last page.
    const hc = this.#regions.content('header');
    const fc = this.#regions.content('footer');
    if (hc) fillFields(hc, 1, count);
    if (fc) fillFields(fc, count, count);
    if (gen === this.#copyGen) return;
    this.#copyGen = gen;
    for (const d of this.#spacers) {
      if (d._visible === true) {
        this.#fillSpacer(d);
      } else if (d._gen !== undefined) {
        d.children[1]?.replaceChildren();
        d.children[3]?.replaceChildren();
        d._gen = undefined;
      }
    }
  }

  #updateFrames(p: PaginationState): void {
    const g = p.geom;
    if (g === null) return;
    const sig = `${String(p.pageCount)}:${String(g.heightPx)}:${String(g.widthPx)}:${p.pageExtra.join(',')}`;
    if (sig === this.#framesSig) return;
    this.#framesSig = sig;
    const kids = this.#frames.children;
    while (kids.length > p.pageCount) this.#frames.lastChild?.remove();
    while (kids.length < p.pageCount) {
      const f = document.createElement('div');
      f.className = 'odx-page';
      f.style.position = 'absolute';
      f.style.left = '0';
      this.#frames.appendChild(f);
    }
    this.#frames.style.cssText = 'position:absolute;left:0;top:0;width:100%;z-index:0;pointer-events:none';
    // §0 S-3: frames are page-sized. A page whose content overflowed pushes later frames down.
    let top = 0;
    for (let i = 0; i < p.pageCount; i++) {
      const f = kids[i] as HTMLElement;
      f.style.top = `${String(top)}px`;
      f.style.height = `${String(g.heightPx)}px`;
      f.style.width = `${String(g.widthPx)}px`;
      top += g.heightPx + (p.pageExtra[i] ?? 0) + g.gapPx;
    }
    this.#frames.style.height = `${String(top - g.gapPx)}px`;
  }
}

const ids = new WeakMap<PMNode, number>();
let nextId = 1;
function idOf(node: PMNode | null): number {
  if (!node) return 0;
  let id = ids.get(node);
  if (id === undefined) ids.set(node, (id = nextId++));
  return id;
}
