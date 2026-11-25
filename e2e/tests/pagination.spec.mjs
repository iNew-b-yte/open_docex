// Pagination (LLD Part 3 §17 item 9; §10, §0 S-1 to S-8): page frames for a long document, typing
// in the middle keeps the caret and re-paginates, a block taller than a page overflows its frame
// (S-3), and the header and footer copies on the other pages are read-only.
import { expect, openEditor, test, textOf } from '../harness/fixtures.mjs';

const lines = (n, prefix = 'Line') => Array.from({ length: n }, (_, i) => `${prefix} ${String(i + 1).padStart(3, '0')}`);

/** The page frames drawn behind the body: their sizes and tops (page coordinates). */
const frames = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.odx-page-frames .odx-page')].map((f) => {
      const r = f.getBoundingClientRect();
      return { top: r.top + window.scrollY, height: r.height, width: r.width };
    }),
  );
const frameCount = (page) => page.locator('.odx-page-frames .odx-page').count();
const spacerCount = (page) => page.locator('.odx-spacer').count();

/**
 * How many pages `n` one-line paragraphs fill: the body area of a page (frame height less the
 * 1-inch margins of the default A4 page) holds `floor(body / lineHeight)` of them.
 */
const expectedPages = (page, n) =>
  page.evaluate((n) => {
    const frame = document.querySelector('.odx-page-frames .odx-page').getBoundingClientRect().height;
    const p = document.querySelector('.odx-editor-surface .ProseMirror p').getBoundingClientRect().height;
    return Math.ceil(n / Math.floor((frame - 2 * 96) / p));
  }, n);

/** The text of the paragraph the DOM selection is in. */
const caretParagraph = (page) =>
  page.evaluate(() => {
    const n = window.getSelection()?.anchorNode;
    const el = n instanceof Element ? n : n?.parentElement;
    return el?.closest('p')?.textContent ?? null;
  });

const newPage = async (browser) => (await browser.newContext()).newPage();

test('a long document is drawn as page frames, one more than the page breaks', async ({ page, startServer }) => {
  const h = await startServer();
  await h.addDoc('doc', lines(150).join('\n'));
  const e = await openEditor(page, h, { user: 'alice' });
  await expect(e.locator('p')).toHaveCount(150);

  const pages = await expectedPages(page, 150);
  expect(pages).toBeGreaterThan(1);
  await expect.poll(() => frameCount(page)).toBe(pages);
  // A page break is a spacer before a block, so pages = breaks + 1.
  await expect.poll(() => spacerCount(page)).toBe(pages - 1);
  // Frames are page-sized (A4 at 96 dpi is about 794 x 1123 px) and all alike, one below the other.
  const f = await frames(page);
  for (const frame of f) {
    expect(Math.abs(frame.width - 793.7)).toBeLessThan(2);
    expect(Math.abs(frame.height - 1122.5)).toBeLessThan(2);
  }
  for (let i = 1; i < f.length; i++) expect(f[i].top).toBeGreaterThan(f[i - 1].top + f[i - 1].height);
});

test('typing in the middle keeps the caret and re-paginates, for the other user too', async ({ browser, startServer }) => {
  const h = await startServer();
  await h.addDoc('doc', lines(150).join('\n'));
  const a = await newPage(browser);
  const b = await newPage(browser);
  const ea = await openEditor(a, h, { user: 'alice' });
  const eb = await openEditor(b, h, { user: 'bob' });
  await expect(ea.locator('p')).toHaveCount(150);
  await expect(eb.locator('p')).toHaveCount(150);
  const before = await expectedPages(a, 150);
  await expect.poll(() => frameCount(a)).toBe(before);

  // Put the caret at the end of line 75 and type: the caret stays in that paragraph.
  await ea.getByText('Line 075', { exact: true }).click();
  await a.keyboard.press('End');
  await a.keyboard.type(' MID');
  await expect.poll(() => caretParagraph(a)).toBe('Line 075 MID');

  // Sixty more lines in the middle push the rest down: more pages, the caret still where typing is.
  const added = lines(60, 'new');
  await a.keyboard.type('\n' + added.join('\n'));
  const total = 150 + added.length;
  await expect(ea.locator('p')).toHaveCount(total);
  const after = await expectedPages(a, total);
  expect(after).toBeGreaterThan(before);
  await expect.poll(() => frameCount(a)).toBe(after);
  await expect.poll(() => spacerCount(a)).toBe(after - 1);
  await expect.poll(() => caretParagraph(a)).toBe('new 060');
  await a.keyboard.type('!');
  await expect.poll(() => caretParagraph(a)).toBe('new 060!');

  // Bob converges on the same text and the same number of pages.
  const expected = [...lines(150).slice(0, 74), 'Line 075 MID', ...added.slice(0, -1), 'new 060!', ...lines(150).slice(75)];
  await expect.poll(() => h.storedText('doc'), { timeout: 30_000 }).toBe(expected.join('\n'));
  await expect(eb.locator('p')).toHaveCount(total);
  await expect.poll(() => frameCount(b)).toBe(after);
  await expect.poll(() => textOf(b)).toBe(expected.join(''));
});

// A paragraph of about 12,600 characters is about 2,600 px tall, more than two pages of body.
const GIANT = 'lorem ipsum dolor '.repeat(700).trim();

for (const [name, blocks] of [
  ['in the middle', ['before', GIANT, 'after']],
  ['at the top', [GIANT, 'after']],
]) {
  test(`a block taller than a page overflows its frame, ${name}; frames are not stretched (S-3)`, async ({ page, startServer }) => {
    const h = await startServer();
    await h.addDoc('doc', blocks.join('\n'));
    const e = await openEditor(page, h, { user: 'alice' });
    await expect(e.locator('p')).toHaveCount(blocks.length);
    await expect.poll(() => frameCount(page)).toBeGreaterThan(1);

    // Pagination settles over a pass or two, so the whole check is retried until it holds.
    await expect(async () => {
      const m = await page.evaluate(() => {
        const sy = window.scrollY;
        const abs = (r) => ({ top: r.top + sy, bottom: r.bottom + sy, height: r.height, width: r.width });
        const ps = [...document.querySelectorAll('.odx-editor-surface .ProseMirror p')].map((p) => abs(p.getBoundingClientRect()));
        return { ps, frames: [...document.querySelectorAll('.odx-page-frames .odx-page')].map((f) => abs(f.getBoundingClientRect())) };
      });
      const giant = m.ps.reduce((tallest, p) => (p.height > tallest.height ? p : tallest));
      const after = m.ps.at(-1);
      const fr = m.frames;
      // The frame the block starts in. The block is taller than a page and runs past its bottom.
      const own = fr.findIndex((f) => giant.top >= f.top && giant.top < f.bottom);
      expect(own).toBeGreaterThanOrEqual(0);
      expect(giant.height).toBeGreaterThan(fr[own].height);
      expect(giant.bottom).toBeGreaterThan(fr[own].bottom);
      // No frame was stretched: all are page-sized (A4 at 96 dpi is about 794 x 1123 px).
      for (const f of fr) {
        expect(Math.abs(f.height - 1122.5)).toBeLessThan(2);
        expect(Math.abs(f.width - 793.7)).toBeLessThan(2);
      }
      // The frame after the block was pushed down by the overflow, so it starts below the block's end,
      // and the paragraph that follows sits inside the last frame.
      expect(fr.length).toBeGreaterThan(own + 1);
      expect(fr[own + 1].top).toBeGreaterThanOrEqual(giant.bottom - 1);
      const last = fr.at(-1);
      expect(after.top).toBeGreaterThanOrEqual(last.top);
      expect(after.bottom).toBeLessThanOrEqual(last.bottom + 1);
    }).toPass({ timeout: 20_000 });
  });
}

test('header and footer copies on the other pages are read-only, and follow the real ones', async ({ page, startServer }) => {
  const h = await startServer();
  await h.addDoc('doc', lines(150).join('\n'));
  const e = await openEditor(page, h, { user: 'alice' });
  await expect(e.locator('p').first()).toHaveText('Line 001');
  const pages = await expectedPages(page, 150);
  await expect.poll(() => frameCount(page)).toBe(pages);

  // Add a header and a footer with the toolbar and type into them.
  await page.getByRole('button', { name: 'Header', exact: true }).click();
  await page.getByRole('button', { name: 'Footer', exact: true }).click();
  const header = e.locator('header .odx-region-content p');
  const footer = e.locator('footer .odx-region-content p');
  await header.click();
  await page.keyboard.type('HEAD');
  await footer.click();
  await page.keyboard.type('FOOT');
  await expect(header).toHaveText('HEAD');
  await expect(footer).toHaveText('FOOT');

  // The header is on page 1 and the footer on the last page; every other page break carries a
  // footer copy (end of the page before) and a header copy (top of the page after). Copies are
  // filled when they scroll into view, so each is brought into view first.
  await expect.poll(() => spacerCount(page)).toBe(pages - 1);
  const spacers = page.locator('.odx-spacer');
  for (let i = 0; i < pages - 1; i++) {
    const spacer = spacers.nth(i);
    await spacer.scrollIntoViewIfNeeded();
    const headCopy = spacer.locator('.odx-slot-header');
    const footCopy = spacer.locator('.odx-slot-footer');
    await expect(headCopy).toHaveText('HEAD');
    await expect(footCopy).toHaveText('FOOT');
    // Read-only: the browser reports it as not editable, and a fill is refused.
    for (const copy of [headCopy, footCopy]) {
      expect(await copy.evaluate((el) => el.isContentEditable)).toBe(false);
      await expect(copy.fill('x', { timeout: 2000 })).rejects.toThrow(/not an <input>|not editable|contenteditable/i);
    }
  }
  // The copies are not part of the document: the real header and footer are one each.
  await expect(e.locator('header')).toHaveCount(1);
  await expect(e.locator('footer')).toHaveCount(1);
  await expect(header).toHaveText('HEAD');
  await expect(footer).toHaveText('FOOT');

  // A copy follows the real region: change the header and the copies change with it.
  await header.click();
  await page.keyboard.press('End');
  await page.keyboard.type('ER');
  await expect(header).toHaveText('HEADER');
  await spacers.first().scrollIntoViewIfNeeded();
  await expect(spacers.first().locator('.odx-slot-header')).toHaveText('HEADER');
});
