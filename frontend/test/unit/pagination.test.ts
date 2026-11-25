/**
 * PaginationPlugin, HeaderFooterRegions and geometry (LLD Part 3 §10–§11; §0 S-1 to S-8).
 * jsdom has no layout, so the S-1 height read is stubbed: a block's height comes from its
 * element and text (see `stubHeight`).
 */
import { getPageSettings, textSchema } from '@open-docex/shared/text';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { afterEach, describe, expect, it } from 'vitest';
import { GAP_PX, pageGeometry, snap64 } from '../../src/text/geometry.js';
import { HeaderFooterRegions } from '../../src/text/HeaderFooterRegions.js';
import { PaginationPlugin, caretAtEndOnTailClick, paginationKey, type PaginationState } from '../../src/text/PaginationPlugin.js';
import { BlockResizeSignal } from '../../src/text/nodeviews/BlockResizeSignal.js';
import { DEFAULT_LABELS } from '../../src/labels.js';
import { assetHarness, ASSET_A, cell, li, makeEditor, n, p, PAGE, row, table, ul } from './text-fixtures.js';

const REGION_HEIGHT = 40;

/**
 * The stubbed S-1 read. A paragraph or heading whose text is a number is that tall; any other
 * paragraph is 100 px. A table is 60 px per row, a list 30 px per item, an image 80 px, a page
 * break 0, and a header or footer content box `REGION_HEIGHT`.
 */
function stubHeight(el: HTMLElement): number {
  if (el.classList.contains('odx-region-content')) return REGION_HEIGHT;
  if (el.classList.contains('odx-image')) return 80;
  if (el.classList.contains('odx-page-break')) return 0;
  if (el.classList.contains('tableWrapper') || el.tagName === 'TABLE') return el.querySelectorAll('tr').length * 60;
  if (el.tagName === 'UL' || el.tagName === 'OL') return el.querySelectorAll('li').length * 30;
  const t = Number(el.textContent);
  return Number.isFinite(t) && el.textContent !== '' ? t : 100;
}

const G = pageGeometry(getPageSettings(n.doc.create(PAGE, [n.body.create(null, [p()])])));
const CAP = G.heightPx - G.margin.top - G.margin.bottom;
const FOOT = G.margin.bottom;
const TOP = G.margin.top;

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
/** Waits until the pass (scheduled in a frame) and its follow-up have run. */
async function settle(): Promise<void> {
  await frame();
  await frame();
}

const editors: { destroy(): void }[] = [];
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy();
  document.body.replaceChildren();
});

/** An editor with the regions and pagination plugins, the stubbed height read and one S-7 signal. */
function make(d: PMNode, readOnly = false, read: (el: HTMLElement) => number = stubHeight) {
  const h = assetHarness();
  const regions = new HeaderFooterRegions({ assets: h.assets, labels: DEFAULT_LABELS, readHeight: read });
  const signal = new BlockResizeSignal();
  const e = makeEditor(
    d,
    {
      assets: h.assets,
      blockResize: signal,
      plugins: () => ({
        regions: [regions.plugin()],
        pagination: [PaginationPlugin({ regions, readHeight: read, resize: signal })],
      }),
    },
    readOnly,
  );
  editors.push(e.editor, { destroy: () => regions.destroy() });
  return { ...e, assets: h.assets, sent: h.sent, regions, signal, state: (): PaginationState => paginationKey.getState(e.view.state) as PaginationState };
}

const body = (...blocks: PMNode[]): PMNode => n.doc.create(PAGE, [n.body.create(null, blocks)]);
const withRegions = (header: PMNode | null, blocks: PMNode[], footer: PMNode | null, page: object = PAGE): PMNode =>
  n.doc.create(page, [...(header ? [header] : []), n.body.create(null, blocks), ...(footer ? [footer] : [])]);
const sized = (px: number): PMNode => p(String(px));
const pageBreak = (): PMNode => n.page_break.create();
const field = (kind: 'number' | 'count'): PMNode => n.page_field.create({ kind });

describe('geometry (§0 S-2)', () => {
  it('converts pt to px, snapped to 1/64 px', () => {
    expect(G.widthPx).toBe(snap64((595.28 * 96) / 72));
    expect(G.heightPx * 64).toBe(Math.round(G.heightPx * 64));
    expect(G.margin.top).toBe(96);
    expect(G.gapPx).toBe(GAP_PX);
  });

  it('landscape swaps width and height', () => {
    const land = pageGeometry({ ...getPageSettings(body(p())), orientation: 'landscape' });
    expect(land.widthPx).toBe(G.heightPx);
    expect(land.heightPx).toBe(G.widthPx);
  });

  it('sizes the editor DOM to the page width in a landscape document', async () => {
    const d = n.doc.create({ ...PAGE, orientation: 'landscape' }, [n.body.create(null, [p('a')])]);
    const { view } = make(d);
    await settle();
    expect(parseFloat(view.dom.style.width)).toBeCloseTo(G.heightPx, 1);
  });
});

describe('page breaks (§10)', () => {
  it('a document that fits has one page and no breaks', async () => {
    const e = make(body(sized(100), sized(200)));
    await settle();
    expect(e.state().pageCount).toBe(1);
    expect(e.state().breaks).toHaveLength(0);
    expect(e.state().tailSpacerPx).toBe(CAP - 300);
  });

  it('an exact fill stays on the page; one more px moves the block', async () => {
    const e = make(body(sized(CAP), sized(1)));
    await settle();
    expect(e.state().pageCount).toBe(2);
    expect(e.state().breaks.map((b) => b.index)).toEqual([1]);
    const exact = make(body(sized(CAP - 1), sized(1)));
    await settle();
    expect(exact.state().pageCount).toBe(1);
  });

  it('moves the whole block that does not fit, with the spacer of the LLD formula', async () => {
    const e = make(body(sized(600), sized(600), sized(100)));
    await settle();
    const s = e.state();
    expect(s.pageCount).toBe(2);
    expect(s.breaks).toHaveLength(1);
    expect(s.breaks[0]).toMatchObject({ index: 1, page: 1, spacerPx: CAP - 600 + FOOT + GAP_PX + TOP });
    expect(s.tailSpacerPx).toBe(CAP - 700);
  });

  it('a page_break forces the next block onto a new page', async () => {
    const e = make(body(sized(100), pageBreak(), sized(100)));
    await settle();
    expect(e.state().pageCount).toBe(2);
    expect(e.state().breaks.map((b) => b.index)).toEqual([2]);
  });

  it('view-only documents paginate the same', async () => {
    const d = body(sized(600), sized(600));
    const rw = make(d);
    const ro = make(d, true);
    await settle();
    expect(ro.state().breaks).toEqual(rw.state().breaks);
  });

  it('does not dispatch when nothing changed', async () => {
    const e = make(body(sized(600), sized(600)));
    await settle();
    const before = e.view.state;
    e.signal.emit({ node: before.doc.child(0).child(0), pos: 1, dom: document.body });
    await settle();
    expect(e.view.state).toBe(before);
  });
});

describe('tall blocks (§0 S-3, PO-23)', () => {
  it('overflow stays inside page-sized frames; later frames move down cumulatively', async () => {
    const tall = CAP * 2 + 50;
    const e = make(body(sized(100), sized(tall), sized(100)));
    await settle();
    const s = e.state();
    expect(s.pageCount).toBe(3);
    const overflow = tall - CAP;
    expect(s.pageExtra).toEqual([0, overflow, 0]);
    // The tall block starts page 2, and the block after it follows its overflow with no negative spacer.
    expect(s.breaks[0]).toMatchObject({ index: 1 });
    expect(s.breaks[1]).toMatchObject({ index: 2, spacerPx: FOOT + GAP_PX + TOP });
    expect(s.breaks.every((b) => b.spacerPx > 0)).toBe(true);
    const frames = [...e.host.querySelectorAll<HTMLElement>('.odx-page')];
    expect(frames).toHaveLength(3);
    for (const f of frames) expect(parseFloat(f.style.height)).toBeCloseTo(G.heightPx, 1); // never stretched
    // jsdom prints lengths with two decimals, so compare to that precision.
    const tops = frames.map((f) => parseFloat(f.style.top));
    const want = [0, G.heightPx + GAP_PX, 2 * (G.heightPx + GAP_PX) + overflow];
    tops.forEach((t, i) => expect(t).toBeCloseTo(want[i] as number, 1));
  });

  it('every block that fits lies inside its page body box', async () => {
    const e = make(body(sized(100), sized(CAP + 400), sized(300), sized(300), sized(900), sized(50)));
    await settle();
    const s = e.state();
    // Replay the layout from the recorded breaks: each page's blocks fit unless a single block is taller than CAP.
    const doc = e.view.state.doc.child(0);
    let page = 0;
    let y = 0;
    doc.forEach((node, _o, i) => {
      if (s.breaks.some((b) => b.index === i)) {
        page++;
        y = 0;
      }
      const h = Number(node.textContent);
      if (h <= CAP) expect(y + h).toBeLessThanOrEqual(CAP);
      y += h;
    });
    expect(page + 1).toBe(s.pageCount);
  });
});

describe('resume from the first change (§0 S-4)', () => {
  /** A small seeded random generator. */
  function rng(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('gives the same breaks as a full recompute after random edits', async () => {
    for (let seed = 1; seed <= 5; seed++) {
      const r = rng(seed);
      const blocks = (): PMNode[] => Array.from({ length: 25 }, () => sized(50 + Math.floor(r() * 500)));
      const e = make(body(...blocks()));
      await settle();
      for (let step = 0; step < 6; step++) {
        const bodyNode = e.view.state.doc.child(0);
        const i = Math.floor(r() * bodyNode.childCount);
        let pos = 1;
        for (let k = 0; k < i; k++) pos += bodyNode.child(k).nodeSize;
        const op = r();
        const tr = e.view.state.tr;
        if (op < 0.4) tr.replaceWith(pos, pos + bodyNode.child(i).nodeSize, sized(50 + Math.floor(r() * 600)));
        else if (op < 0.7) tr.insert(pos, op < 0.55 ? sized(50 + Math.floor(r() * 600)) : pageBreak());
        else if (bodyNode.childCount > 3) tr.delete(pos, pos + bodyNode.child(i).nodeSize);
        e.view.dispatch(tr);
        await settle();
        const fresh = make(e.view.state.doc);
        await settle();
        expect(e.state().breaks, `seed ${String(seed)} step ${String(step)}`).toEqual(fresh.state().breaks);
        expect(e.state().pageCount).toBe(fresh.state().pageCount);
        expect(e.state().tailSpacerPx).toBe(fresh.state().tailSpacerPx);
        expect(e.state().pageExtra).toEqual(fresh.state().pageExtra);
      }
    }
  });

  it('re-measures only the changed block when typing', async () => {
    let reads = 0;
    const counting = (el: HTMLElement): number => {
      reads++;
      return stubHeight(el);
    };
    const h = assetHarness();
    const regions = new HeaderFooterRegions({ assets: h.assets, labels: DEFAULT_LABELS, readHeight: counting });
    const e = makeEditor(body(...Array.from({ length: 30 }, () => sized(300))), {
      plugins: () => ({
        regions: [regions.plugin()],
        pagination: [PaginationPlugin({ regions, readHeight: counting })],
      }),
    });
    editors.push(e.editor);
    await settle();
    expect(reads).toBe(30);
    reads = 0;
    e.view.dispatch(e.view.state.tr.insertText('1', 2)); // paragraph 0: "300" → "3100"
    await settle();
    expect(reads).toBe(1);
  });

  it('a pass that finds a break moved dispatches exactly the new state', async () => {
    const e = make(body(sized(500), sized(400)));
    await settle();
    expect(e.state().pageCount).toBe(1);
    e.view.dispatch(e.view.state.tr.insertText('9', 2)); // 500 → 5900: tall block
    await settle();
    expect(e.state().pageCount).toBe(2);
  });
});

describe('late-loading blocks (§0 S-7)', () => {
  it('a block-resize signal drops the cached height and re-flows', async () => {
    let imageHeight = 80;
    const stub = (el: HTMLElement): number => (el.classList.contains('odx-image') ? imageHeight : stubHeight(el));
    const e = make(body(sized(400), n.image.create({ assetId: ASSET_A, alt: '' }), sized(100)), false, stub);
    await settle();
    expect(e.state().pageCount).toBe(1);
    imageHeight = CAP; // the image finished loading and is now a page tall
    const imagePos = 1 + e.view.state.doc.child(0).child(0).nodeSize;
    e.signal.emit({ node: e.view.state.doc.child(0).child(1), pos: imagePos, dom: document.body });
    await settle();
    expect(e.state().pageCount).toBe(3);
    expect(e.state().breaks[0]).toMatchObject({ index: 1 });
  });
});

describe('tables and lists (§0 S-8)', () => {
  const tbl = (rows: number): PMNode => table(...Array.from({ length: rows }, () => row(cell(null, p('x')))));
  const list = (items: number): PMNode => ul(...Array.from({ length: items }, () => li(p('i'))));

  it('moves a whole table to the next page when it does not fit', async () => {
    const e = make(body(sized(700), tbl(5), sized(100))); // 300 px table after 700 px
    await settle();
    expect(e.state().breaks.map((b) => b.index)).toEqual([1]);
    expect(e.state().pageCount).toBe(2);
  });

  it('a table taller than a page overflows its frame and the next block follows it', async () => {
    const rows = Math.ceil(CAP / 60) + 4;
    const e = make(body(sized(100), tbl(rows), sized(100)));
    await settle();
    const over = rows * 60 - CAP;
    expect(e.state().pageExtra[1]).toBe(over);
    expect(e.state().breaks.map((b) => b.index)).toEqual([1, 2]);
  });

  it('breaks before a list that does not fit and keeps a list that does', async () => {
    const e = make(body(sized(800), list(6), list(2))); // 180 px list after 800: break; then 60
    await settle();
    expect(e.state().breaks.map((b) => b.index)).toEqual([1]);
    expect(e.state().pageCount).toBe(2);
  });

  it('resuming after an edit inside a table or list matches a fresh layout', async () => {
    const e = make(body(sized(300), tbl(4), list(3), sized(500), tbl(6)));
    await settle();
    const tablePos = 1 + e.view.state.doc.child(0).child(0).nodeSize;
    e.view.dispatch(e.view.state.tr.insertText('yy', tablePos + 4));
    await settle();
    const fresh = make(e.view.state.doc);
    await settle();
    expect(e.state().breaks).toEqual(fresh.state().breaks);
  });
});

describe('header and footer (§11, PO-21)', () => {
  const hdr = (...c: PMNode[]): PMNode => n.header.create(null, [n.paragraph.create(null, c)]);
  const ftr = (...c: PMNode[]): PMNode => n.footer.create(null, [n.paragraph.create(null, c)]);
  const pageOf = (c: PMNode[]): PMNode =>
    withRegions(hdr(textSchema.text('Page '), field('number'), textSchema.text(' of '), field('count')), c, ftr(field('number'), textSchema.text('/'), field('count')));

  it('measuredHeight drives bodyTop and the footer box', async () => {
    const e = make(withRegions(hdr(textSchema.text('H')), [sized(10)], ftr(textSchema.text('F'))));
    await settle();
    expect(e.regions.measuredHeight('header')).toBe(REGION_HEIGHT);
    expect(e.state().bodyTop).toBe(Math.max(TOP, REGION_HEIGHT)); // the margin is larger than the stub
    expect(e.state().footBox).toBe(Math.max(FOOT, REGION_HEIGHT));
    expect(make(body(p())).regions.measuredHeight('header')).toBe(0);
  });

  it('a tall header grows bodyTop and shrinks the page body', async () => {
    const tallHeader = (el: HTMLElement): number => (el.classList.contains('odx-region-content') ? 200 : stubHeight(el));
    const h = assetHarness();
    const regions = new HeaderFooterRegions({ assets: h.assets, labels: DEFAULT_LABELS, readHeight: tallHeader });
    const e = makeEditor(withRegions(hdr(textSchema.text('H')), [sized(10)], null), {
      plugins: () => ({
        regions: [regions.plugin()],
        pagination: [PaginationPlugin({ regions, readHeight: tallHeader })],
      }),
    });
    editors.push(e.editor);
    await settle();
    const s = paginationKey.getState(e.view.state) as PaginationState;
    expect(s.bodyTop).toBe(200);
    expect(s.tailSpacerPx).toBe(G.heightPx - FOOT - 200 - 10);
  });

  it('shows the right page number and count in the real regions and every copy', async () => {
    const e = make(pageOf([sized(600), sized(600), sized(600), sized(100)]));
    await settle();
    expect(e.state().pageCount).toBe(3);
    const header = e.host.querySelector('.odx-header .odx-region-content') as HTMLElement;
    const footer = e.host.querySelector('.odx-footer .odx-region-content') as HTMLElement;
    expect(header.textContent).toBe('Page 1 of 3'); // the real header is on page 1
    expect(footer.textContent).toBe('3/3'); // the real footer is on the last page
    const spacers = [...e.host.querySelectorAll<HTMLElement>('.odx-spacer')];
    expect(spacers).toHaveLength(2);
    // jsdom has no IntersectionObserver, so all copies are filled.
    expect(spacers.map((s) => s.querySelector('.odx-slot-footer')?.textContent)).toEqual(['1/3', '2/3']);
    expect(spacers.map((s) => s.querySelector('.odx-slot-header')?.textContent)).toEqual(['Page 2 of 3', 'Page 3 of 3']);
  });

  it('refreshes the count in real regions and copies when the page count changes (§0 S-5)', async () => {
    const e = make(pageOf([sized(600), sized(600)]));
    await settle();
    expect(e.host.querySelector('.odx-spacer .odx-slot-header')?.textContent).toBe('Page 2 of 2');
    const end = e.view.state.doc.child(1).nodeSize + 1; // after the first body block… append a block at the body end
    void end;
    const bodyEnd = e.view.state.doc.child(1).nodeSize + e.view.state.doc.child(0).nodeSize - 1;
    e.view.dispatch(e.view.state.tr.insert(bodyEnd, sized(600)));
    await settle();
    expect(e.state().pageCount).toBe(3);
    expect(e.host.querySelector('.odx-header .odx-region-content')?.textContent).toBe('Page 1 of 3');
    expect(e.host.querySelector('.odx-spacer .odx-slot-header')?.textContent).toBe('Page 2 of 3');
  });

  it('editing the header updates every copy', async () => {
    const e = make(pageOf([sized(600), sized(600), sized(600)]));
    await settle();
    e.view.dispatch(e.view.state.tr.insertText('X', 2));
    await settle();
    const heads = [...e.host.querySelectorAll('.odx-slot-header')].map((x) => x.textContent);
    expect(heads.every((t) => t?.startsWith('X') === true)).toBe(true);
  });

  it('copies are read-only: not editable, hidden from assistive tech and inert', async () => {
    const e = make(pageOf([sized(600), sized(600)]));
    await settle();
    const copy = e.regions.renderCopy('header', e.view.state, 2, 2);
    expect(copy.getAttribute('contenteditable')).toBe('false');
    expect(copy.getAttribute('aria-hidden')).toBe('true');
    expect(copy.inert).toBe(true);
    expect(copy.querySelector('[contenteditable="true"]')).toBeNull();
    expect(copy.textContent).toBe('Page 2 of 2');
    expect(e.regions.renderCopy('footer', make(body(p())).view.state).childNodes).toHaveLength(0);
  });

  it('copies show images through blob URLs from the asset cache only', async () => {
    const img = n.image.create({ assetId: ASSET_A, alt: 'logo', width: 40, height: 20 });
    const d = withRegions(n.header.create(null, [img]), [sized(600), sized(600)], null);
    const e = make(d);
    await settle();
    const first = e.regions.renderCopy('header', e.view.state, 2, 2);
    expect(first.querySelector('img')?.hasAttribute('src')).toBe(false); // not loaded yet
    const get = e.sent.at(-1) as { reqId: number; type: string };
    expect(get.type).toBe('asset-get');
    e.assets.onAsset({
      type: 'asset',
      reqId: get.reqId,
      assetId: ASSET_A,
      mime: 'image/png',
      size: 3,
      bytes: new Uint8Array([1, 2, 3]),
    });
    await settle();
    const src = e.regions.renderCopy('header', e.view.state, 2, 2).querySelector('img')?.getAttribute('src');
    expect(src).toMatch(/^blob:/);
    expect(e.host.querySelector('.odx-spacer .odx-slot-header img')?.getAttribute('src')).toMatch(/^blob:/);
  });

  it('add and remove commands insert and delete the regions as ordinary steps', async () => {
    const e = make(body(sized(100)));
    const c = e.regions.commands();
    expect(c.removeHeader(e.view.state)).toBe(false);
    expect(c.addHeader(e.view.state, e.view.dispatch)).toBe(true);
    expect(e.view.state.doc.firstChild?.type.name).toBe('header');
    expect(c.addHeader(e.view.state)).toBe(false);
    expect(c.addFooter(e.view.state, e.view.dispatch)).toBe(true);
    expect(e.view.state.doc.lastChild?.type.name).toBe('footer');
    expect(e.view.state.doc.childCount).toBe(3);
    expect(c.removeHeader(e.view.state, e.view.dispatch)).toBe(true);
    expect(c.removeFooter(e.view.state, e.view.dispatch)).toBe(true);
    expect(e.view.state.doc.childCount).toBe(1);
    await settle();
    expect(e.state().pageCount).toBe(1);
  });

  it('commands do nothing in a read-only editor', () => {
    const e = make(body(sized(100)), true);
    expect(e.regions.commands().addHeader(e.view.state)).toBe(false);
  });

  it('the node views carry the region class names', async () => {
    const e = make(withRegions(hdr(textSchema.text('H')), [sized(10)], ftr(textSchema.text('F'))));
    await settle();
    expect(e.host.querySelector('header.odx-header')).not.toBeNull();
    expect(e.host.querySelector('footer.odx-footer')).not.toBeNull();
  });
});

describe('lifecycle', () => {
  it('removes the frames layer and stops observing on destroy', async () => {
    const e = make(body(sized(100)));
    await settle();
    expect(e.host.querySelector('.odx-page-frames')).not.toBeNull();
    e.editor.destroy();
    expect(e.host.querySelector('.odx-page-frames')).toBeNull();
  });

  it('a reload rebuilds the plugin state from scratch', async () => {
    const e = make(body(sized(600), sized(600)));
    await settle();
    expect(e.state().pageCount).toBe(2);
    e.editor.load(body(sized(100)), { readOnly: false });
    await settle();
    expect(paginationKey.getState(e.editor.view.state)?.pageCount).toBe(1);
  });
});

export type { EditorView };

describe('click on the tail spacer (V1-40, Firefox)', () => {
  it('puts the caret at the end of the document, in the DOM selection too', async () => {
    const e = make(body(p('abc'), p('def')));
    await settle();
    e.view.focus();
    const tail = e.view.dom.querySelector('.odx-tail');
    expect(tail).not.toBeNull();
    const ev = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(ev, 'target', { value: tail });
    expect(caretAtEndOnTailClick(e.view, ev)).toBe(false);
    const end = e.view.state.selection;
    expect(end.empty).toBe(true);
    expect(e.view.state.doc.textBetween(end.head, e.view.state.doc.content.size)).toBe('');
    expect(e.view.state.doc.resolve(end.head).parent.textContent).toBe('def');
    expect(e.view.dom.ownerDocument.getSelection()?.anchorNode).not.toBeNull();
  });

  it('ignores clicks elsewhere and a read-only view', async () => {
    const e = make(body(p('abc')), true);
    await settle();
    const before = e.view.state.selection;
    const ev = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(ev, 'target', { value: e.view.dom.querySelector('.odx-tail') });
    caretAtEndOnTailClick(e.view, ev);
    expect(e.view.state.selection.eq(before)).toBe(true);
    const ev2 = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(ev2, 'target', { value: e.view.dom.querySelector('p') });
    expect(caretAtEndOnTailClick(e.view, ev2)).toBe(false);
  });
});
