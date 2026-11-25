// Link safety (LLD Part 3 §17 item 10; the allowlist of Part 1 §8 `isAllowedHref`: absolute
// `http:`, `https:` and `mailto:` only). A `javascript:` href is refused through the link dialog
// and through paste, and nothing clickable is left in the document.
import { expect, openEditor, test, textOf } from '../harness/fixtures.mjs';

const BAD_HREFS = ['javascript:window.__pwned=1', 'JaVaScRiPt:window.__pwned=1', 'data:text/html,<b>x</b>', 'vbscript:msgbox(1)'];

/** Records `submit` frames the page sends and any dialog or popup a click might open. */
function watch(page) {
  const seen = { submits: [], dialogs: [], popups: [] };
  page.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      if (typeof f.payload === 'string' && f.payload.includes('"submit"')) seen.submits.push(f.payload);
    }),
  );
  page.on('dialog', (d) => {
    seen.dialogs.push(d.message());
    void d.dismiss();
  });
  page.context().on('page', (p) => seen.popups.push(p.url()));
  return seen;
}

/** Fires a paste event carrying `html` and `text` at the editor (as the collab spec does for images). */
const paste = (editor, html, text) =>
  editor.evaluate(
    (el, { html, text }) => {
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', text);
      // Firefox ignores the data object in the event constructors, so it is set as a property.
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: dt });
      el.dispatchEvent(ev);
    },
    { html, text },
  );

test('the link dialog refuses a javascript: href and accepts an https one', async ({ page, startServer }) => {
  const h = await startServer();
  await h.addDoc('doc', 'hello');
  const seen = watch(page);
  const e = await openEditor(page, h, { user: 'alice' });
  await expect(e).toHaveText('hello');
  await e.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');

  await page.getByRole('button', { name: 'Link', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Link' });
  await expect(dialog).toBeVisible();
  const address = dialog.getByLabel('Address');
  for (const bad of BAD_HREFS) {
    await address.fill(bad);
    await dialog.getByRole('button', { name: 'OK' }).click();
    // Refused: the dialog stays open and says why; the document has no link.
    await expect(dialog.getByRole('alert')).toHaveText('Only http, https and mailto links are allowed.');
    await expect(dialog).toBeVisible();
    await expect(e.locator('a')).toHaveCount(0);
  }
  // Nothing changed, so nothing was sent.
  expect(seen.submits).toEqual([]);

  // The same dialog accepts a safe address (the check is the allowlist, not "any link fails").
  await address.fill('https://example.com/ok');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  const link = e.locator('a');
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', 'https://example.com/ok');
  await expect(link).toHaveText('hello');
  await expect.poll(() => seen.submits.length).toBeGreaterThan(0);
  expect(seen.dialogs).toEqual([]);
});

test('pasting a javascript: link keeps the text but no link, and clicking does nothing', async ({ page, startServer }) => {
  const h = await startServer();
  await h.addDoc('doc', 'start');
  const seen = watch(page);
  const e = await openEditor(page, h, { user: 'alice' });
  await expect(e).toHaveText('start');
  await e.click();
  await page.keyboard.press('End');

  const anchors = BAD_HREFS.map((href, i) => `<a href="${href.replace(/"/g, '&quot;')}">bad${String(i)}</a>`);
  // A leading space and an entity-encoded scheme are the usual ways around a naive check.
  anchors.push('<a href=" javascript:window.__pwned=1">padded</a>', '<a href="&#106;avascript:window.__pwned=1">entity</a>');
  await paste(e, `<p>${anchors.join(' ')}</p>`, 'plain');

  // The text arrives (the paste worked) but no `a` element and no link mark with that href.
  await expect.poll(() => textOf(page)).toContain('bad0');
  await expect.poll(() => textOf(page)).toContain('entity');
  await expect(e.locator('a')).toHaveCount(0);
  await expect(e.locator('[href]')).toHaveCount(0);

  // A (Mod-)click on the pasted text opens nothing and runs nothing.
  const target = e.getByText('bad0');
  await target.click({ modifiers: ['ControlOrMeta'] });
  await target.click();
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(seen.popups).toEqual([]);
  expect(seen.dialogs).toEqual([]);

  // A safe link in the same kind of paste does become a link.
  await e.click();
  await page.keyboard.press('End');
  await paste(e, '<p><a href="https://example.com/ok">fine</a></p>', 'fine');
  await expect(e.locator('a')).toHaveCount(1);
  await expect(e.locator('a')).toHaveAttribute('href', 'https://example.com/ok');
  await expect(e.locator('a')).toHaveText('fine');
});
