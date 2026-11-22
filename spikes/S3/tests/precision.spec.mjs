// Which DOM height read is exact (1/64 px layout units) for blocks far below the viewport?
// Reference: ResizeObserver borderBoxSize (a size, not a viewport position).
import { test } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

const ROOT = join(import.meta.dirname, '..');

test('height read precision', async ({ page, browserName }) => {
  await page.goto(pathToFileURL(join(ROOT, 'index.html')).href);
  await page.evaluate(() => S3.init({ blocks: 3550, measure: 'rect' }));
  const r = await page.evaluate(async () => {
    const els = [...document.querySelectorAll('.odx-body > p, .odx-body > h2')];
    const ref = new Map();
    await new Promise((res) => {
      let left = els.length;
      const ro = new ResizeObserver((entries) => {
        for (const e of entries) ref.set(e.target, e.borderBoxSize[0].blockSize);
        left -= entries.length;
        if (left <= 0) (ro.disconnect(), res());
      });
      for (const e of els) ro.observe(e);
    });
    const modes = {
      rect: (e) => e.getBoundingClientRect().height,
      computedStyle: (e) => parseFloat(getComputedStyle(e).height),
      computedStyleMap: (e) => e.computedStyleMap().get('height').value,
      offsetHeight: (e) => e.offsetHeight,
    };
    const out = { blocks: els.length };
    for (const [name, f] of Object.entries(modes)) {
      let sumErr = 0;
      let maxErr = 0;
      let wrong = 0;
      let t = performance.now();
      const vals = els.map(f);
      t = performance.now() - t;
      els.forEach((e, i) => {
        const d = vals[i] - ref.get(e);
        sumErr += d;
        maxErr = Math.max(maxErr, Math.abs(d));
        if (d !== 0) wrong++;
      });
      out[name] = { blocksNotExact: wrong, maxAbsErrPx: maxErr, summedErrPx: sumErr, readAllMs: t };
    }
    return out;
  });
  mkdirSync(join(ROOT, 'results'), { recursive: true });
  writeFileSync(join(ROOT, 'results', `${browserName}-precision.json`), JSON.stringify(r, null, 2));
  console.log(JSON.stringify(r, null, 1));
});
