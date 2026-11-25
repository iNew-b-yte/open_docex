// Two users, one document (LLD Part 3 §17 items 1, 2, 3, 8, 12).
import { expect, openEditor, test, textOf } from '../harness/fixtures.mjs';

test('two users type at once and converge, including the BRD "cat" case', async ({ browser, startServer }) => {
  const h = await startServer();
  await h.addDoc('doc', 'cat');
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const ea = await openEditor(a, h, { user: 'alice' });
  const eb = await openEditor(b, h, { user: 'bob' });
  await expect(ea).toHaveText('cat');
  await expect(eb).toHaveText('cat');

  // Alice puts the caret before "cat" and types; Bob puts it after "cat" and types.
  await ea.click();
  await a.keyboard.press('Home');
  await eb.click();
  await b.keyboard.press('End');
  await a.keyboard.type('big ');
  await b.keyboard.type('s');

  await expect.poll(() => textOf(a)).toBe('big cats');
  await expect.poll(() => textOf(b)).toBe('big cats');

  // Carets stay where the users left them: more typing lands after the user's own text.
  await a.keyboard.type('X');
  await b.keyboard.type('Y');
  await expect.poll(() => textOf(a)).toBe('big Xcatsy'.replace('y', 'Y'));
  await expect.poll(() => textOf(b)).toBe('big Xcatsy'.replace('y', 'Y'));

  // The server saved the converged text.
  await expect.poll(() => h.storedText('doc'), { timeout: 30_000 }).toBe('big XcatsY');
});

test('a view-only user cannot edit, sends no change, and still sees remote edits', async ({ browser, startServer }) => {
  const h = await startServer();
  await h.addDoc('doc', 'hello');
  const a = await (await browser.newContext()).newPage();
  const v = await (await browser.newContext()).newPage();
  const submits = [];
  v.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      if (typeof f.payload === 'string' && f.payload.includes('"submit"')) submits.push(f.payload);
    }),
  );
  const ea = await openEditor(a, h, { user: 'alice' });
  const ev = await openEditor(v, h, { user: 'victor', access: 'view' });
  await expect(ev).toHaveText('hello');
  await expect(v.locator('.odx-badge')).toHaveText('View only');
  await expect(ev).toHaveAttribute('contenteditable', 'false');
  await expect(v.locator('.odx-toolbar button, [role="toolbar"] button').first()).toBeDisabled();

  await ev.click();
  await v.keyboard.type('nope');
  await ea.click();
  await a.keyboard.press('End');
  await a.keyboard.type(' world');
  await expect.poll(() => textOf(v)).toBe('hello world');
  expect(submits).toEqual([]);
});

test('paste and drag-drop an image: it appears for the other user with a blob src', async ({ browser, startServer }) => {
  const h = await startServer();
  await h.addDoc('doc', 'pic');
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const ea = await openEditor(a, h, { user: 'alice' });
  await openEditor(b, h, { user: 'bob' });
  await expect(ea).toHaveText('pic');

  // A 1x1 PNG.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const dispatch = (kind) =>
    ea.evaluate(
      (el, { b64, kind }) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], `${kind}.png`, { type: 'image/png' }));
        const r = (el.querySelector('p') ?? el).getBoundingClientRect();
        const init = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 3, clientY: r.top + r.height / 2 };
        // Firefox ignores the data object in the event constructors, so it is set as a property.
        const ev = new Event(kind, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, kind === 'paste' ? 'clipboardData' : 'dataTransfer', { value: dt });
        if (kind === 'drop') Object.assign(ev, { clientX: init.clientX, clientY: init.clientY });
        el.dispatchEvent(ev);
      },
      { b64: png, kind },
    );

  await ea.click();
  await dispatch('paste');
  await expect(ea.locator('img')).toHaveCount(1);
  await expect(b.locator('.odx-editor-surface .ProseMirror img')).toHaveCount(1);
  await expect(b.locator('.odx-editor-surface .ProseMirror img')).toHaveAttribute('src', /^blob:/);

  await dispatch('drop');
  await expect(ea.locator('img')).toHaveCount(2);
  await expect(b.locator('.odx-editor-surface .ProseMirror img')).toHaveCount(2);
});

test('destroy() while connected leaves no open socket', async ({ page, startServer }) => {
  const h = await startServer();
  await h.addDoc('doc', 'bye');
  const e = await openEditor(page, h, { user: 'alice' });
  await expect(e).toHaveText('bye');
  await expect.poll(() => page.evaluate(() => window.odx.openSockets)).toBe(1);
  await page.evaluate(() => window.odx.handle.destroy());
  await expect.poll(() => page.evaluate(() => window.odx.openSockets)).toBe(0);
});
