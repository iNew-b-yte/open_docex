// Connection loss, slow consumers, read-only documents and engine restarts (LLD Part 3 §17
// items 3, 4, 6, 7; the restore-notice case of EXECUTION_PLAN.md).
import { expect, openEditor, test, textOf } from '../harness/fixtures.mjs';

const newPage = async (browser) => (await browser.newContext()).newPage();

test('reconnect after a dropped socket loses and duplicates nothing', async ({ browser, startServer }) => {
  const h = await startServer();
  await h.addDoc('doc', 'start');
  const a = await newPage(browser);
  const b = await newPage(browser);
  const ea = await openEditor(a, h, { user: 'alice' });
  await openEditor(b, h, { user: 'bob' });
  await expect(ea).toHaveText('start');
  await ea.click();
  await a.keyboard.press('End');
  await a.keyboard.type(' one');
  h.dropSockets('alice');
  await a.keyboard.type(' two');
  await a.keyboard.type(' three');

  await expect.poll(() => textOf(a)).toBe('start one two three');
  await expect.poll(() => textOf(b)).toBe('start one two three');
  expect(h.connectionCount('alice')).toBeGreaterThan(1);
  await expect.poll(() => h.storedText('doc'), { timeout: 30_000 }).toBe('start one two three');
});

test('a slow consumer is closed and recovers by reloading', async ({ browser, startServer }) => {
  // The smallest allowed high-water mark is 64 KiB; two 40 KB edits to a stalled socket pass it.
  const h = await startServer({ highWaterMarkBytes: 64 * 1024 });
  await h.addDoc('doc', 'x');
  const a = await newPage(browser);
  const b = await newPage(browser);
  const ea = await openEditor(a, h, { user: 'alice' });
  const eb = await openEditor(b, h, { user: 'bob' });
  await expect(eb).toHaveText('x');
  await ea.click();
  await a.keyboard.press('End');

  h.stall('bob');
  const big = 'a'.repeat(40_000);
  await a.keyboard.insertText(big);
  await expect.poll(() => a.evaluate(() => window.odx.log.statuses.at(-1)?.sync)).toBe('synced');
  await a.keyboard.insertText(big);

  const expected = 'x' + big + big;
  await expect.poll(async () => (await textOf(a)).length).toBe(expected.length);
  // Bob's socket was cut and reopened (a new connection), and Bob converges.
  await expect.poll(() => h.connectionCount('bob'), { timeout: 40_000 }).toBeGreaterThan(1);
  await expect.poll(async () => (await textOf(b)).length, { timeout: 40_000 }).toBe(expected.length);
});

test('a document with unsupported content opens read-only; "Edit anyway" makes it editable', async ({ page, startServer }) => {
  const h = await startServer();
  await h.addDoc('doc', 'UNSUPPORTED report');
  const e = await openEditor(page, h, { user: 'alice' });
  await expect(e).toHaveText('UNSUPPORTED report');
  await expect(page.locator('.odx-banner')).toContainText("can't be edited here");
  await expect(page.locator('.odx-badge')).toHaveText('Read-only: unsupported content');
  await expect(e).toHaveAttribute('contenteditable', 'false');

  await page.getByRole('button', { name: 'Edit anyway' }).click();
  await expect(page.locator('.odx-banner')).toContainText('will be removed when the document is saved');
  await expect(e).toHaveAttribute('contenteditable', 'true');
  await e.click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await expect.poll(() => textOf(page)).toBe('UNSUPPORTED report!');
  await expect.poll(() => h.storedText('doc'), { timeout: 30_000 }).toBe('UNSUPPORTED report!');
});

test('worker mode: the Core restarts, clients reconnect and resume', async ({ browser, startServer }) => {
  const h = await startServer({ mode: 'worker' });
  await h.addDoc('doc', 'before');
  const a = await newPage(browser);
  const b = await newPage(browser);
  const ea = await openEditor(a, h, { user: 'alice' });
  await openEditor(b, h, { user: 'bob' });
  await expect(ea).toHaveText('before');
  await ea.click();
  await a.keyboard.press('End');
  await a.keyboard.type(' typed');
  await expect.poll(() => textOf(b)).toBe('before typed');

  await h.restartCore();
  await expect.poll(() => a.evaluate(() => window.odx.log.statuses.at(-1)), { timeout: 60_000 }).toMatchObject({ connection: 'open', load: 'ready' });
  await expect.poll(() => b.evaluate(() => window.odx.log.statuses.at(-1)), { timeout: 60_000 }).toMatchObject({ connection: 'open', load: 'ready' });

  await ea.click();
  await a.keyboard.press('End');
  await a.keyboard.type(' after');
  await expect.poll(() => textOf(a), { timeout: 30_000 }).toBe('before typed after');
  await expect.poll(() => textOf(b), { timeout: 30_000 }).toBe('before typed after');
  await expect.poll(() => h.storedText('doc'), { timeout: 30_000 }).toBe('before typed after');
});
