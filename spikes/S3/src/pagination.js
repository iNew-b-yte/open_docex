// LLD P3 §10 PaginationPlugin, spike version. See docs/spikes/S3.md for the deviations.
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { pageGeometry } from './geometry.js';
import { fillFields } from './regions.js';

export const paginationKey = new PluginKey('pagination');

const EMPTY = {
  breaks: [],
  pageCount: 1,
  tailSpacerPx: 0,
  pageExtra: [0],
  bodyTop: 0,
  footBox: 0,
  geom: null,
  deco: DecorationSet.empty,
};

/**
 * @param {{ regions: import('./regions.js').HeaderFooterRegions, measure?: 'rect' | 'offset', stats?: object[] }} deps
 */
export function PaginationPlugin(deps) {
  const measure = deps.measure ?? 'rect';
  return new Plugin({
    key: paginationKey,
    state: {
      init: () => EMPTY,
      apply(tr, v) {
        const meta = tr.getMeta(paginationKey);
        if (meta) return meta;
        if (tr.docChanged) return { ...v, deco: v.deco.map(tr.mapping, tr.doc) };
        return v;
      },
    },
    props: {
      decorations: (state) => paginationKey.getState(state).deco,
      attributes(state) {
        const p = paginationKey.getState(state);
        const g = pageGeometry(state.doc.attrs);
        const hasHeader = state.doc.firstChild.type.name === 'header';
        const hasFooter = state.doc.lastChild.type.name === 'footer';
        const top = hasHeader ? 0 : p.bodyTop || g.margin.top;
        const bottom = hasFooter ? 0 : p.footBox || g.margin.bottom;
        return {
          style: `width:${g.widthPx}px;padding:${top}px ${g.margin.right}px ${bottom}px ${g.margin.left}px`,
        };
      },
    },
    view: (view) => new PaginationView(view, deps.regions, measure, deps.stats ?? { list: [], onPass: null }),
  });
}

class PaginationView {
  constructor(view, regions, measure, stats) {
    this.view = view;
    this.regions = regions;
    this.measureMode = measure;
    this.stats = stats;
    this.cache = new WeakMap(); // block node → px height
    this.last = null; // resume data of the last pass
    this.invalid = 'init';
    this.raf = 0;
    this.passesThisFrame = 0;
    this.frames = document.createElement('div');
    this.frames.className = 'odx-page-frames';
    view.dom.parentNode.insertBefore(this.frames, view.dom);
    this.framesSig = '';
    this.spacers = new Set();
    this.copyGen = '';
    this.io = new IntersectionObserver((entries) => this.onIntersect(entries), {
      rootMargin: '200% 0px', // ±2 viewports
    });
    regions.onResize = () => {
      this.invalid = 'header/footer resize';
      this.schedule();
    };
    this.onFonts = () => {
      this.cache = new WeakMap();
      this.invalid = 'fonts';
      this.schedule();
    };
    document.fonts.addEventListener('loadingdone', this.onFonts);
    this.schedule();
  }

  update(view, prev) {
    if (view.state.doc !== prev.doc || this.invalid) this.schedule();
    this.refreshCopies();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.io.disconnect();
    this.frames.remove();
    document.fonts.removeEventListener('loadingdone', this.onFonts);
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.passesThisFrame = 0;
      this.pass();
    });
  }

  heightOf(dom) {
    if (this.measureMode === 'offset') return dom.offsetHeight;
    // 'style': the used border-box height (blocks are box-sizing: border-box). Chromium prints it
    // rounded (error <= 0.005 px), so snap back to the 1/64 px layout unit it came from.
    if (this.measureMode === 'style') return snap64(parseFloat(getComputedStyle(dom).height));
    // 'rect': float geometry; loses precision far from the viewport (see report).
    return dom.getBoundingClientRect().height;
  }

  /** The measure pass. DOM reads only, then at most one meta dispatch. */
  pass() {
    const view = this.view;
    if (view.composing) return this.schedule();
    if (++this.passesThisFrame > 2) return this.schedule(); // loop guard
    const t0 = performance.now();
    const doc = view.state.doc;
    const g = pageGeometry(doc.attrs);
    const hH = this.regions.measuredHeight('header');
    const fH = this.regions.measuredHeight('footer');
    const bodyTop = Math.max(g.margin.top, hH);
    const bodyBottom = g.heightPx - Math.max(g.margin.bottom, fH);
    const cap = bodyBottom - bodyTop;
    const footBox = g.heightPx - bodyBottom;
    const geomKey = [g.widthPx, g.heightPx, g.margin.top, g.margin.bottom, g.margin.left, g.margin.right, hH, fH].join();

    const headerNode = doc.firstChild.type.name === 'header' ? doc.firstChild : null;
    const body = headerNode ? doc.child(1) : doc.firstChild;
    const bodyStart = headerNode ? headerNode.nodeSize : 0;
    const n = body.childCount;
    const last = this.last;

    let s = 0;
    const full = !last || this.invalid || last.geomKey !== geomKey;
    const reason = !last ? 'first' : this.invalid || (last.geomKey !== geomKey ? 'geometry/header/footer height' : null);
    if (!full) {
      const m = Math.min(n, last.nodes.length);
      while (s < m && body.child(s) === last.nodes[s]) s++;
      if (s === n && n === last.nodes.length) {
        this.invalid = false;
        this.record({ t0, s, n, measured: 0, dispatched: false, reason });
        return;
      }
    }
    this.invalid = false;

    // Resume state *before* the break decision of block s.
    const nodes = new Array(n);
    const yPre = new Float64Array(n);
    const pagePre = new Int32Array(n);
    const posOf = new Float64Array(n);
    let y = 0;
    let page = 0;
    let pos = bodyStart + 1;
    let breaks = [];
    let pageExtra = [];
    if (s > 0) {
      for (let i = 0; i < s; i++) {
        nodes[i] = last.nodes[i];
        yPre[i] = last.yPre[i];
        pagePre[i] = last.pagePre[i];
        posOf[i] = last.posOf[i];
      }
      y = last.yPre[s];
      page = last.pagePre[s];
      pos = last.posOf[s];
      breaks = last.breaks.filter((b) => b.index < s);
      pageExtra = last.pageExtra.slice(0, page);
    }

    let measured = 0;
    for (let i = s; i < n; i++) {
      const node = body.child(i);
      nodes[i] = node;
      posOf[i] = pos;
      let h = this.cache.get(node);
      if (h === undefined) {
        h = this.heightOf(view.nodeDOM(pos));
        this.cache.set(node, h);
        measured++;
      }
      yPre[i] = y;
      pagePre[i] = page;
      const forced = i > 0 && body.child(i - 1).type.name === 'page_break';
      if (forced || (y + h > cap && y > 0)) {
        // PO-23: when the page overflowed (y > cap), its frame is stretched by `overflow`
        // instead of a negative spacer (the LLD formula `cap − y` goes negative here).
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
    const tMeasured = performance.now();

    this.last = { nodes, yPre, pagePre, posOf, breaks, pageExtra, geomKey };

    const prev = paginationKey.getState(view.state);
    const same =
      prev.pageCount === pageCount &&
      prev.tailSpacerPx === tailSpacerPx &&
      prev.bodyTop === bodyTop &&
      prev.footBox === footBox &&
      prev.breaks.length === breaks.length &&
      prev.breaks.every((b, i) => b.beforePos === breaks[i].beforePos && b.spacerPx === breaks[i].spacerPx);
    let changedBreaks = 0;
    if (!same) {
      for (let i = 0; i < breaks.length; i++) {
        const b = prev.breaks[i];
        if (!b || b.beforePos !== breaks[i].beforePos || b.spacerPx !== breaks[i].spacerPx) changedBreaks++;
      }
      const next = {
        breaks,
        pageCount,
        tailSpacerPx,
        pageExtra,
        bodyTop,
        footBox,
        geom: g,
        deco: this.buildDeco(doc, headerNode, bodyStart, body, breaks, tailSpacerPx, bodyTop, footBox, g),
      };
      view.dispatch(view.state.tr.setMeta(paginationKey, next).setMeta('addToHistory', false));
      this.updateFrames(next);
    }
    this.record({ t0, tMeasured, s, n, measured, dispatched: !same, changedBreaks, pageCount, reason });
  }

  record(r) {
    const t1 = performance.now();
    const entry = {
      resumeIndex: r.s,
      fullReason: r.reason,
      blocks: r.n,
      measured: r.measured,
      dispatched: r.dispatched,
      changedBreaks: r.changedBreaks ?? 0,
      pageCount: r.pageCount,
      measureMs: (r.tMeasured ?? t1) - r.t0,
      totalMs: t1 - r.t0,
      end: t1,
    };
    this.stats.list.push(entry);
    if (this.stats.onPass) this.stats.onPass(entry);
  }

  buildDeco(doc, headerNode, bodyStart, body, breaks, tailSpacerPx, bodyTop, footBox, g) {
    const decos = [];
    if (headerNode) {
      decos.push(Decoration.node(0, headerNode.nodeSize, { style: `height:${bodyTop}px` }));
    }
    const bodyEnd = bodyStart + body.nodeSize;
    if (doc.lastChild.type.name === 'footer') {
      decos.push(Decoration.node(bodyEnd, doc.content.size, { style: `height:${footBox}px` }));
    }
    for (const b of breaks) {
      const page = b.page;
      const spacerPx = b.spacerPx;
      decos.push(
        Decoration.widget(b.beforePos, () => this.makeSpacer(page, spacerPx, footBox, g.gapPx, bodyTop), {
          side: -1,
          key: 'pb' + page + ':' + spacerPx + ':' + footBox + ':' + bodyTop,
          ignoreSelection: true,
          destroy: (dom) => {
            this.spacers.delete(dom);
            this.io.unobserve(dom);
          },
        }),
      );
    }
    decos.push(
      Decoration.widget(bodyEnd, () => {
        const d = document.createElement('div');
        d.className = 'odx-tail';
        d.contentEditable = 'false';
        d.style.height = tailSpacerPx + 'px';
        return d;
      }, { side: -1, key: 'tail:' + tailSpacerPx, ignoreSelection: true }),
    );
    return DecorationSet.create(doc, decos);
  }

  /** Spacer: filler, footer copy for page−1, gap, header copy for page. Copies filled lazily. */
  makeSpacer(page, spacerPx, footBox, gapPx, bodyTop) {
    const d = document.createElement('div');
    d.className = 'odx-spacer';
    d.contentEditable = 'false';
    d.style.height = spacerPx + 'px';
    d.dataset.page = String(page);
    const filler = document.createElement('div');
    filler.className = 'odx-spacer-fill';
    const foot = document.createElement('div');
    foot.className = 'odx-slot-footer';
    foot.style.height = footBox + 'px';
    const gap = document.createElement('div');
    gap.style.height = gapPx + 'px';
    const head = document.createElement('div');
    head.className = 'odx-slot-header';
    head.style.height = bodyTop + 'px';
    d.append(filler, foot, gap, head);
    this.spacers.add(d);
    this.io.observe(d);
    return d;
  }

  onIntersect(entries) {
    for (const e of entries) {
      e.target._visible = e.isIntersecting;
      if (e.isIntersecting && e.target._gen !== this.copyGen) this.fillSpacer(e.target);
    }
  }

  fillSpacer(d) {
    const doc = this.view.state.doc;
    const header = doc.firstChild.type.name === 'header' ? doc.firstChild : null;
    const footer = doc.lastChild.type.name === 'footer' ? doc.lastChild : null;
    const count = paginationKey.getState(this.view.state).pageCount;
    const page = Number(d.dataset.page); // 0-based index of the page that starts here
    d.children[1].replaceChildren(this.regions.renderCopy('footer', footer, page, count));
    d.children[3].replaceChildren(this.regions.renderCopy('header', header, page + 1, count));
    d._gen = this.copyGen;
  }

  /** When header/footer content or the page count changes, refresh visible copies only. */
  refreshCopies() {
    const doc = this.view.state.doc;
    const header = doc.firstChild.type.name === 'header' ? doc.firstChild : null;
    const footer = doc.lastChild.type.name === 'footer' ? doc.lastChild : null;
    const count = paginationKey.getState(this.view.state).pageCount;
    const gen = idOf(header) + '/' + idOf(footer) + '/' + count;
    // Real regions: header is on page 1, footer on the last page.
    const { header: hc, footer: fc } = this.regions.contents;
    if (hc) fillFields(hc, 1, count);
    if (fc) fillFields(fc, count, count);
    if (gen === this.copyGen) return;
    this.copyGen = gen;
    for (const d of this.spacers) {
      if (d._visible) this.fillSpacer(d);
      else if (d._gen) {
        d.children[1].replaceChildren();
        d.children[3].replaceChildren();
        d._gen = undefined;
      }
    }
  }

  updateFrames(p) {
    const H = p.geom.heightPx;
    const sig = p.pageCount + ':' + H + ':' + p.geom.widthPx + ':' + p.pageExtra.join(',');
    if (sig === this.framesSig) return;
    this.framesSig = sig;
    const kids = this.frames.children;
    while (kids.length > p.pageCount) this.frames.lastChild.remove();
    while (kids.length < p.pageCount) {
      const f = document.createElement('div');
      f.className = 'odx-page';
      this.frames.appendChild(f);
    }
    let top = 0;
    for (let i = 0; i < p.pageCount; i++) {
      const h = H + (p.pageExtra[i] || 0);
      const f = kids[i];
      const st = `top:${top}px;height:${h}px;width:${p.geom.widthPx}px`;
      if (f.getAttribute('style') !== st) f.setAttribute('style', st);
      top += h + p.geom.gapPx;
    }
    this.frames.style.height = top - p.geom.gapPx + 'px';
  }
}

export const snap64 = (px) => Math.round(px * 64) / 64;

const ids = new WeakMap();
let nextId = 1;
function idOf(node) {
  if (!node) return 0;
  let id = ids.get(node);
  if (!id) ids.set(node, (id = nextId++));
  return id;
}

export { fillFields };
