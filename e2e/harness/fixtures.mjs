// Playwright fixtures: `startServer(opts)` starts a harness that is disposed after the test, and
// `openEditor(page, harness, opts)` mounts an editor for one user in a page.
import { test as base, expect } from '@playwright/test';
import { startHarness } from './server.mjs';

export { expect };

export const test = base.extend({
  startServer: async ({}, use) => {
    const started = [];
    await use(async (opts) => {
      const h = await startHarness(opts);
      started.push(h);
      return h;
    });
    for (const h of started) await h.dispose();
  },
});

/** The editable surface of a page. */
export const editorOf = (page) => page.locator('.odx-editor-surface .ProseMirror');

/**
 * Opens the harness page and mounts an editor on `documentId` for `user`. Resolves when the
 * document is shown (`ready`). `access` is `'edit'` or `'view'`.
 */
export async function openEditor(page, harness, { documentId = 'doc', user, access = 'edit', editAnyway = true, waitReady = true }) {
  await page.goto(harness.baseUrl);
  await page.evaluate((args) => window.odx.start(args), { documentId, token: `${access}:${user}`, editAnyway });
  if (waitReady) {
    await expect(editorOf(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.odx.log.statuses.at(-1)?.load)).toBe('ready');
  }
  return editorOf(page);
}

/** The text of the document as shown. */
export const textOf = (page) => editorOf(page).textContent();
