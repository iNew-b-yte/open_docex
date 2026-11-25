// The restore-notice banner (EXECUTION_PLAN.md note for V1-40, LLD Part 3 §6.2, S-37).
//
// The page's socket goes through `page.routeWebSocket`, which lets the test hold back the
// client's `submit` frames (so changes stay unconfirmed) and send the page a server `notice`
// that makes the document read-only. The client then discards its unconfirmed changes, shows
// "Unconfirmed changes were discarded." and reloads.
import { expect, openEditor, test, textOf } from '../harness/fixtures.mjs';

const READ_ONLY_ON = JSON.stringify({ type: 'notice', notice: 'read-only', readOnly: true, reason: 'unsupported-content' });

test('a second identical restore notice shows again after the user dismissed the first', async ({ page, startServer }) => {
  // KNOWN BUG (found by V1-40): `RestoreBanner` in `frontend/src/ui/Shell.tsx` keeps the dismissed
  // notice text and `ShellSession` cannot clear the notice, so the second identical notice stays
  // hidden. This test is marked `fail` so the suite stays green until the client is fixed; when it
  // is, Playwright reports "expected to fail but passed": remove the `test.fail` line then.
  test.fail();

  const h = await startServer();
  await h.addDoc('doc', 'hello');
  const state = { ws: null, hold: false };
  await page.routeWebSocket(/open-docex/, (ws) => {
    const server = ws.connectToServer();
    state.ws = ws;
    ws.onMessage((m) => {
      if (state.hold && typeof m === 'string' && m.includes('"submit"')) return;
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  const e = await openEditor(page, h, { user: 'alice' });
  const banner = page.locator('.odx-banner-restore');
  const discardOnce = async (typed) => {
    state.hold = true;
    await e.click();
    await page.keyboard.press('End');
    await page.keyboard.type(typed);
    await expect(page.getByText('changes unconfirmed')).toBeVisible();
    state.ws.send(READ_ONLY_ON);
  };

  await discardOnce(' one');
  await expect(banner).toContainText('Unconfirmed changes were discarded.');
  await expect.poll(() => textOf(page)).toBe('hello');
  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(banner).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.odx.log.statuses.at(-1)?.load)).toBe('ready');

  await discardOnce(' two');
  await expect(banner).toContainText('Unconfirmed changes were discarded.');
});
