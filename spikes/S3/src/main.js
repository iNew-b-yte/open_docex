// Spike S3 entry: builds a long document and exposes a benchmark API on window.S3.
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from './schema.js';
import { A4 } from './geometry.js';
import { HeaderFooterRegions } from './regions.js';
import { PaginationPlugin, paginationKey } from './pagination.js';

const WORDS = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et ' +
  'dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea ' +
  'commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur'
).split(' ');

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

function text(r, words) {
  const out = [];
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(r() * WORDS.length)]);
  return out.join(' ');
}

/** Deterministic fixture: paragraphs, headings, images, page breaks, plus PO-23 tall blocks. */
export function buildDoc({ blocks, header = true, footer = true }) {
  const r = rng(42);
  const s = schema;
  const p = (t) => s.node('paragraph', null, t ? [s.text(t)] : []);
  const children = [];
  for (let i = 0; i < blocks; i++) {
    if (i === 30) children.push(s.node('image', { height: 1200 })); // taller than one page (PO-23)
    else if (i === 60) children.push(p(text(r, 2500))); // a very long paragraph (PO-23)
    else if (i > 0 && i % 150 === 0) children.push(s.node('page_break'));
    else if (i % 50 === 25) children.push(s.node('image', { height: 120 + Math.floor(r() * 300) }));
    else if (i % 12 === 0) children.push(s.node('heading', { level: 2 }, [s.text(text(r, 3 + Math.floor(r() * 6)))]));
    else children.push(p(text(r, 20 + Math.floor(r() * 100))));
  }
  const content = [];
  if (header) {
    content.push(
      s.node('header', null, [
        s.node('paragraph', null, [
          s.text('open_docex spike S3, page '),
          s.node('page_field', { kind: 'number' }),
          s.text(' of '),
          s.node('page_field', { kind: 'count' }),
        ]),
      ]),
    );
  }
  content.push(s.node('body', null, children));
  if (footer) {
    content.push(
      s.node('footer', null, [s.node('paragraph', null, [s.text('Footer, page '), s.node('page_field', { kind: 'number' })])]),
    );
  }
  return s.node('doc', A4, content);
}

const nextPass = () => new Promise((res) => (stats.onPass = (e) => ((stats.onPass = null), res(e))));
const afterFrame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));

let view = null;
let regions = null;
const stats = { list: [], onPass: null };

function bodyInfo() {
  const doc = view.state.doc;
  const hasHeader = doc.firstChild.type.name === 'header';
  const body = hasHeader ? doc.child(1) : doc.firstChild;
  return { body, bodyStart: hasHeader ? doc.firstChild.nodeSize : 0 };
}

function posOfBlock(index) {
  const { body, bodyStart } = bodyInfo();
  let pos = bodyStart + 1;
  for (let i = 0; i < index; i++) pos += body.child(i).nodeSize;
  return pos;
}

/** First paragraph index on page `page` (0-based), from the pagination state. */
function blockOnPage(page) {
  const p = paginationKey.getState(view.state);
  const { body } = bodyInfo();
  let start = 0;
  if (page > 0) {
    const b = p.breaks.find((x) => x.page === page);
    if (!b) throw new Error('no page ' + page);
    start = b.index;
  }
  for (let i = start; i < body.childCount; i++) if (body.child(i).type.name === 'paragraph') return i;
  throw new Error('no paragraph on page ' + page);
}

const S3 = {
  async init({ blocks, measure = 'rect', header = true, footer = true }) {
    const container = document.getElementById('container');
    if (view) view.destroy();
    container.replaceChildren();
    stats.list.length = 0;
    regions = new HeaderFooterRegions(schema);
    const t0 = performance.now();
    const state = EditorState.create({ doc: buildDoc({ blocks, header, footer }), plugins: [PaginationPlugin({ regions, measure, stats })] });
    const first = nextPass();
    view = new EditorView(container, { state, nodeViews: regions.nodeViews() });
    const tView = performance.now();
    const e = await first;
    const tPass = performance.now();
    container.offsetHeight; // flush layout of the paginated result
    const tLayout = performance.now();
    await S3.idle();
    window.view = view;
    return {
      createViewMs: tView - t0,
      firstPassMs: e.totalMs,
      firstPassMeasureMs: e.measureMs,
      layoutAfterFirstPassMs: tLayout - tPass,
      blocks: e.blocks,
      pageCount: paginationKey.getState(view.state).pageCount,
    };
  },

  /** Waits until a pass runs with nothing left to change. */
  async idle() {
    for (let i = 0; i < 20; i++) {
      await afterFrame();
      const last = stats.list[stats.list.length - 1];
      if (!view.state || !last || last.dispatched === false || performance.now() - last.end > 50) {
        await afterFrame();
        return;
      }
    }
  },

  pageCount: () => paginationKey.getState(view.state).pageCount,
  blockOnPage,

  /** One measured edit. `op` mutates via view.dispatch. Returns per-phase timings in ms. */
  async timed(op) {
    const pass = nextPass();
    const t0 = performance.now();
    op();
    const tDispatch = performance.now();
    const e = await pass;
    const tPassEnd = performance.now();
    view.dom.offsetHeight; // the layout the browser would do for the frame after pagination
    const tLayout = performance.now();
    await afterFrame();
    const tFrame = performance.now();
    await S3.idle();
    return {
      dispatchMs: tDispatch - t0, // ProseMirror transaction + DOM update
      passMs: e.totalMs, // measure pass (includes the forced layout of its DOM reads) + meta dispatch
      passMeasureMs: e.measureMs,
      layoutAfterPassMs: tLayout - tPassEnd,
      workMs: tDispatch - t0 + e.totalMs + (tLayout - tPassEnd),
      toNextFrameMs: tFrame - t0, // includes waiting for vsync
      resumeIndex: e.resumeIndex,
      measured: e.measured,
      changedBreaks: e.changedBreaks,
      pageCount: e.pageCount,
    };
  },

  typeOnPage(page, ch = 'x') {
    const i = blockOnPage(page);
    const pos = posOfBlock(i) + 1 + Math.floor(view.state.doc.resolve(posOfBlock(i) + 1).parent.content.size / 2);
    return S3.timed(() => view.dispatch(view.state.tr.insertText(ch, pos)));
  },

  /** Inserts a new multi-line paragraph before the first paragraph of `page`: moves blocks across pages. */
  insertParagraphOnPage(page, words = 60) {
    const i = blockOnPage(page);
    const pos = posOfBlock(i);
    const node = schema.node('paragraph', null, [schema.text(text(rng(7), words))]);
    return S3.timed(() => view.dispatch(view.state.tr.insert(pos, node)));
  },

  deleteBlockOnPage(page) {
    const i = blockOnPage(page);
    const pos = posOfBlock(i);
    return S3.timed(() => view.dispatch(view.state.tr.delete(pos, pos + view.state.doc.nodeAt(pos).nodeSize)));
  },

  insertTallOnPage(page) {
    const i = blockOnPage(page);
    return S3.timed(() => view.dispatch(view.state.tr.insert(posOfBlock(i), schema.node('image', { height: 1500 }))));
  },

  /** Types into the real header (changes every copy; height change → full recompute). */
  typeInHeader(ch = 'H') {
    return S3.timed(() => view.dispatch(view.state.tr.insertText(ch, 2)));
  },

  /** Adds a header line: header height grows → bodyTop changes → re-layout from block 0. */
  growHeader() {
    const h = view.state.doc.firstChild;
    return S3.timed(() =>
      view.dispatch(view.state.tr.insert(h.nodeSize - 1, schema.node('paragraph', null, [schema.text('second header line')]))),
    );
  },

  /** Puts the caret in the middle of the first paragraph of `page` and scrolls it into view. */
  caretOnPage(page) {
    const i = blockOnPage(page);
    const pos = posOfBlock(i) + 2;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)).scrollIntoView());
    view.focus();
  },

  lastPass: () => stats.list[stats.list.length - 1],
  passes: () => stats.list.slice(),
  copiesBuilt: () => regions.copiesBuilt,

  /** Checks the real layout against the model: every block inside its page's body box. */
  verify() {
    const p = paginationKey.getState(view.state);
    const container = document.getElementById('container');
    const c0 = container.getBoundingClientRect().top;
    const frames = [...container.querySelector('.odx-page-frames').children].map((f) => {
      const r = f.getBoundingClientRect();
      return { top: r.top - c0, bottom: r.bottom - c0 };
    });
    const { body, bodyStart } = bodyInfo();
    const breakAt = new Map(p.breaks.map((b) => [b.index, b.page]));
    let page = 0;
    let pos = bodyStart + 1;
    let maxTopErr = 0;
    let outside = 0;
    let overflowBlocks = 0;
    let firstOutside = null;
    const cap = p.geom.heightPx - p.footBox - p.bodyTop;
    for (let i = 0; i < body.childCount; i++) {
      if (breakAt.has(i)) page = breakAt.get(i);
      const node = body.child(i);
      const r = view.nodeDOM(pos).getBoundingClientRect();
      const top = r.top - c0;
      const bottom = r.bottom - c0;
      const f = frames[page];
      const bodyTopY = f.top + p.bodyTop;
      const bodyBottomY = f.bottom - p.footBox;
      if (r.height > cap) overflowBlocks++;
      const err = Math.max(0, bodyTopY - top, bottom - bodyBottomY);
      if (r.height <= cap) maxTopErr = Math.max(maxTopErr, err);
      if (err > 0.5 && r.height <= cap) {
        if (!outside) firstOutside = { i, type: node.type.name, page, top, bottom, bodyTopY, bodyBottomY, h: r.height };
        outside++;
      }
      pos += node.nodeSize;
    }
    const lastFrame = frames[frames.length - 1];
    const ed = view.dom.getBoundingClientRect();
    const hc = container.querySelectorAll('.odx-copy-header').length;
    const fc = container.querySelectorAll('.odx-copy-footer').length;
    const firstVisibleCopy = container.querySelector('.odx-copy-header');
    return {
      pageCount: p.pageCount,
      frames: frames.length,
      editorBottomVsLastFrameBottomPx: ed.bottom - c0 - lastFrame.bottom,
      maxBlockOutsideBodyBoxPx: maxTopErr,
      blocksOutsideBodyBox: outside,
      firstOutside,
      overflowBlocks,
      headerCopiesInDom: hc,
      footerCopiesInDom: fc,
      sampleHeaderCopyText: firstVisibleCopy ? firstVisibleCopy.textContent : null,
      realFooterText: container.querySelector('.odx-footer').textContent,
    };
  },
};

// Real keyboard typing: time from the keydown event to the end of the pagination pass and to the next frame.
let keyStart = 0;
let keyPass = null;
document.addEventListener(
  'keydown',
  () => {
    keyStart = performance.now();
    keyPass = nextPass();
  },
  true,
);
S3.keyTiming = async () => {
  const e = await keyPass;
  const passEnd = performance.now();
  view.dom.offsetHeight;
  const tLayout = performance.now();
  await afterFrame();
  const r = {
    keyToPassEndMs: e.end - keyStart,
    passMs: e.totalMs,
    layoutAfterPassMs: tLayout - passEnd,
    keyToNextFrameMs: performance.now() - keyStart,
    resumeIndex: e.resumeIndex,
    measured: e.measured,
  };
  await S3.idle();
  return r;
};

window.S3 = S3;
