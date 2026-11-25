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
  const editor = editorOf(page);
  // A key pressed within ProseMirror's focus window after a click is taken as "the browser reset the
  // caret" and undone (prosemirror-view: `lastFocus` under 200 ms old, last click over 300 ms old).
  // Measured in Firefox: Home 8-12 ms after the click was reverted in about 3 of 10 runs, and with a
  // 350 ms wait in 0 of 20 (V1-40 follow-up). A real user does not press a key that fast, so the
  // wait belongs to the test, not the client. Every `click()` on the editor therefore waits it out.
  const click = editor.click.bind(editor);
  editor.click = async (options) => {
    await click(options);
    await page.waitForTimeout(350);
  };
  return editor;
}

/** The text of the document as shown. */
export const textOf = (page) => editorOf(page).textContent();
