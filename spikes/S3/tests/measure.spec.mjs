// Spike S3 measurements in a real browser. Writes results/<browser>.json.
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import os from 'node:os';

const ROOT = join(import.meta.dirname, '..');
const BLOCKS = Number(process.env.S3_BLOCKS ?? 1420);
const N = Number(process.env.S3_SAMPLES ?? 30);

function summary(samples) {
  const keys = Object.keys(samples[0]).filter((k) => k.endsWith('Ms'));
  const out = { n: samples.length };
  for (const k of keys) {
    const v = samples.map((s) => s[k]).sort((a, b) => a - b);
    const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
    out[k] = { median: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +v[v.length - 1].toFixed(2) };
  }
  out.measuredBlocks = [...new Set(samples.map((s) => s.measured))];
  out.resumeIndex = [Math.min(...samples.map((s) => s.resumeIndex)), Math.max(...samples.map((s) => s.resumeIndex))];
  if ('changedBreaks' in samples[0]) out.changedBreaks = [Math.min(...samples.map((s) => s.changedBreaks)), Math.max(...samples.map((s) => s.changedBreaks))];
  return out;
}

async function repeat(page, n, fn) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await page.evaluate(fn));
  return out;
}

test('S3 pagination measurements', async ({ page, browser, browserName }) => {
  await page.goto(pathToFileURL(join(ROOT, 'index.html')).href);
  const res = {
    browser: browserName,
    browserVersion: browser.version(),
    userAgent: await page.evaluate(() => navigator.userAgent),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0].model,
    cores: os.cpus().length,
    memGB: +(os.totalmem() / 2 ** 30).toFixed(1),
    node: process.version,
    viewport: page.viewportSize(),
    blocks: BLOCKS,
  };

  // Measurement mode check: offsetHeight (LLD) vs getBoundingClientRect (fractional).
  res.offsetMode = { init: await page.evaluate((b) => S3.init({ blocks: b, measure: 'offset' }), BLOCKS) };
  res.offsetMode.verify = await page.evaluate(() => S3.verify());

  res.init = await page.evaluate((b) => S3.init({ blocks: b, measure: 'rect' }), BLOCKS);
  res.verifyInitial = await page.evaluate(() => S3.verify());
  console.log(JSON.stringify({ offsetMode: res.offsetMode, init: res.init, verifyInitial: res.verifyInitial }, null, 1));
  const pages = res.init.pageCount;
  expect(pages).toBeGreaterThanOrEqual(200);
  expect(res.verifyInitial.blocksOutsideBodyBox).toBe(0);

  await repeat(page, 5, () => S3.typeOnPage(0)); // warm-up
  const mid = Math.floor(pages / 2);
  res.typePage1 = summary(await repeat(page, N, () => S3.typeOnPage(0)));
  res.typePageMid = summary(await page.evaluate(async ([n, p]) => { const o = []; for (let i = 0; i < n; i++) o.push(await S3.typeOnPage(p)); return o; }, [N, mid]));
  res.typeLastPage = summary(await page.evaluate(async (n) => { const o = []; for (let i = 0; i < n; i++) o.push(await S3.typeOnPage(S3.pageCount() - 1)); return o; }, N));
  res.insertParagraphPage1 = summary(await repeat(page, 15, () => S3.insertParagraphOnPage(0)));
  res.deleteParagraphPage1 = summary(await repeat(page, 15, () => S3.deleteBlockOnPage(0)));
  res.insertTallBlockPage1 = summary(await repeat(page, 5, () => S3.insertTallOnPage(0)));
  res.typeInHeader = summary(await repeat(page, 10, () => S3.typeInHeader()));
  res.growHeader = summary(await repeat(page, 3, () => S3.growHeader()));
  res.verifyAfterEdits = await page.evaluate(() => S3.verify());
  expect(res.verifyAfterEdits.blocksOutsideBodyBox).toBe(0);

  // Real keyboard input (Playwright â†’ CDP key events), caret on page 1 and on the last page.
  for (const [label, which] of [['keyboardPage1', 0], ['keyboardLastPage', -1]]) {
    await page.evaluate((w) => S3.caretOnPage(w < 0 ? S3.pageCount() - 1 : w), which);
    await page.evaluate(() => S3.idle());
    const samples = [];
    for (let i = 0; i < N; i++) {
      await page.keyboard.press('KeyA');
      samples.push(await page.evaluate(() => S3.keyTiming()));
    }
    res[label] = summary(samples);
  }
  // Copies are lazy: count after scrolling to the end.
  res.copiesBuiltTotal = await page.evaluate(() => S3.copiesBuilt());
  res.verifyFinal = await page.evaluate(() => S3.verify());
  expect(res.verifyFinal.blocksOutsideBodyBox).toBe(0);

  mkdirSync(join(ROOT, 'results'), { recursive: true });
  writeFileSync(join(ROOT, 'results', `${browserName}.json`), JSON.stringify(res, null, 2));
  await page.screenshot({ path: join(ROOT, 'results', `${browserName}-viewport.png`) });
});
