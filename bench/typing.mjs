// Item 5: typing work in a real Chromium on a document of about 300 pages, against the S-6
// budget (p95 <= 8 ms). The page is the e2e harness page (the built client, `mount()`), served
// by the e2e harness (real engine, fake text codec), so the editor, the sync plugin and the
// pagination plugin are the production code.
//
// One keystroke is timed in three parts, as the spike did (spikes/S3):
//   1. `sync`   view.dispatch(tr.insertText(c).scrollIntoView()) plus a forced layout read
//   2. `pass`   the requestAnimationFrame callbacks of the next frame (the pagination measure
//               pass and its meta dispatch); a wrapper times them
//   3. `layout` a forced layout read after the pass (last callback of that frame)
// `total` = sync + pass + layout. Keys are sent one per frame, after a warm-up, at the document
// start, middle and end.
import { chromium } from '@playwright/test';
import { startHarness } from '../e2e/harness/server.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { pageDir } from '../e2e/harness/global-setup.mjs';
import { summarize } from './lib/stats.mjs';

const WORDS = 'the quick brown fox jumps over the lazy dog while collaborative editors keep every participant in step'.split(' ');
/** One paragraph of about 600 characters, different for each `i`. */
function paragraph(i) {
  let s = '';
  for (let k = 0; s.length < 600; k++) s += `${WORDS[(i * 7 + k * 3) % WORDS.length]} `;
  return s.trim();
}
const docText = (n) => Array.from({ length: n }, (_, i) => paragraph(i)).join('\n');

const here = path.dirname(fileURLToPath(import.meta.url));

/** Bundles the benchmark page (e2e page + view hook) over the harness's page folder. */
async function buildPage() {
  await build({
    root: here,
    configFile: false,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: pageDir,
      emptyOutDir: true,
      target: 'es2022',
      minify: false,
      lib: { entry: path.join(here, 'lib', 'page-entry.mjs'), formats: ['iife'], name: 'odxBenchPage', fileName: () => 'page.js', cssFileName: 'page' },
    },
  });
}

async function open(browser, h, id) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(h.baseUrl);
  await page.evaluate((args) => window.odx.start(args), { documentId: id, token: 'edit:bench', editAnyway: true });
  await page.waitForSelector('.odx-editor-surface .ProseMirror', { timeout: 120_000 });
  await page.waitForFunction(() => window.odx.log.statuses.at(-1)?.load === 'ready', null, { timeout: 120_000 });
  // The first pagination pass runs in a requestAnimationFrame; wait until the page count is stable.
  let last = -1;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(500);
    const n = await page.evaluate(() => document.querySelectorAll('.odx-page-frames .odx-page').length);
    if (n === last && n > 0) break;
    last = n;
  }
  await page.click('.odx-editor-surface .ProseMirror'); // makes the editor dispatch once, which hands the benchmark its view
  return { ctx, page, pages: last };
}

const IN_PAGE = async ({ where, keys, warm }) => {
  const root = document.querySelector('.odx-editor-surface .ProseMirror');
  if (!window.__odxView) throw new Error('no EditorView captured');
  const view = window.__odxView;
  const nativeRaf = window.requestAnimationFrame.bind(window);
  let passMs = 0;
  window.requestAnimationFrame = (cb) => nativeRaf((t) => {
    const s = performance.now();
    cb(t);
    passMs += performance.now() - s;
  });
  // The caret: the end of the first, middle or last body paragraph.
  const doc = view.state.doc;
  const paras = [];
  doc.forEach((region, off) => {
    if (region.type.name === 'body') region.forEach((b, o) => paras.push(off + 1 + o + b.nodeSize - 1));
  });
  const idx = where === 'start' ? 0 : where === 'middle' ? Math.floor(paras.length / 2) : paras.length - 1;
  const Sel = view.state.selection.constructor;
  view.focus();
  view.dispatch(view.state.tr.setSelection(Sel.create(view.state.doc, paras[idx])).scrollIntoView());
  await new Promise((r) => nativeRaf(() => nativeRaf(r)));
  await new Promise((r) => setTimeout(r, 500));
  const rows = [];
  for (let i = 0; i < warm + keys; i++) {
    passMs = 0;
    const t0 = performance.now();
    view.dispatch(view.state.tr.insertText(i % 6 === 5 ? ' ' : 'x').scrollIntoView());
    void root.getBoundingClientRect(); // forced layout
    const sync = performance.now() - t0;
    let layout = 0;
    await new Promise((resolve) => nativeRaf(() => {
      // Registered after the pagination pass of this frame, so it runs after it.
      const t1 = performance.now();
      void root.getBoundingClientRect();
      layout = performance.now() - t1;
      resolve();
    }));
    if (i >= warm) rows.push({ sync, pass: passMs, layout, total: sync + passMs + layout });
  }
  window.requestAnimationFrame = nativeRaf;
  return { rows, blocks: paras.length };
};

export async function typingBench(P) {
  await buildPage();
  const h = await startHarness({ mode: 'main' });
  const browser = await chromium.launch();
  const out = { browser: browser.version(), keystrokesPerLocation: P.keystrokes, warmup: 60, budgetP95Ms: 8 };
  try {
    // Calibrate: paragraphs per page in this editor's CSS, then build the document.
    let n = Math.round(P.typingPages * 6);
    let pages = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      const id = `typing-${attempt}`;
      await h.addDoc(id, docText(n));
      const o = await open(browser, h, id);
      pages = o.pages;
      console.log('[typing] calibrate', n, 'paragraphs ->', pages, 'pages');
      if (Math.abs(pages - P.typingPages) / P.typingPages <= 0.05 || attempt === 3) {
        out.documentId = id;
        out.paragraphs = n;
        out.pages = pages;
        out.session = o;
        break;
      }
      await o.ctx.close();
      n = Math.round((n / pages) * P.typingPages);
    }
    out.locations = {};
    for (const where of ['start', 'middle', 'end']) {
      const o = out.session;
      const r = await o.page.evaluate(IN_PAGE, { where, keys: P.keystrokes, warm: 60 });
      const col = (k) => summarize(r.rows.map((x) => x[k]));
      out.locations[where] = { keystrokes: r.rows.length, total: col('total'), sync: col('sync'), pass: col('pass'), layout: col('layout') };
      console.log('[typing]', where, 'total p50/p95/p99', out.locations[where].total.p50, out.locations[where].total.p95, out.locations[where].total.p99);
    }
    out.documentBlocks = out.paragraphs;
    await out.session.ctx.close();
    delete out.session;
  } finally {
    await browser.close();
    await h.dispose();
  }
  return out;
}
