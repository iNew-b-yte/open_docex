// A busy server: `QUEUE_FULL` answers to a submit (LLD Part 3 §17 item 5). The client keeps the
// change, shows the busy status, retries the same envelope, and the document converges with
// nothing lost or duplicated.
// Only the intercepted QUEUE_FULL is tested here. A "real server with a one-slot queue" variant was
// removed (V1-40 follow-up): it needed a real QUEUE_FULL by chance, so it timed out in Firefox in about
// 2 of 10 runs. The server side is bounded in backend/test/unit/queue/memory-queue.test.ts.
import { expect, openEditor, test, textOf } from '../harness/fixtures.mjs';

const newPage = async (browser) => (await browser.newContext()).newPage();
const lastSync = (page) => page.evaluate(() => window.odx.log.statuses.at(-1)?.sync);
const everBusy = (page) => page.evaluate(() => window.odx.log.statuses.some((s) => s.sync === 'busy'));

test('a QUEUE_FULL answer is retried with the same envelope until accepted, and the document converges', async ({ browser, startServer }) => {
  const h = await startServer();
  await h.addDoc('doc', 'start');
  const a = await newPage(browser);
  const b = await newPage(browser);

  // Alice's socket is proxied: the first three submits are not forwarded; the page gets the
  // answer a full queue gives (an `error` with `QUEUE_FULL`, `retryable`, and the `clientSeq`).
  const rejected = [];
  const forwarded = [];
  await a.routeWebSocket(/\/open-docex/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const text = typeof message === 'string' ? message : message.toString('utf8');
      const frame = text.startsWith('{') ? JSON.parse(text) : null;
      if (frame?.type !== 'submit') return server.send(message);
      if (rejected.length < 3) {
        rejected.push(frame);
        ws.send(JSON.stringify({ type: 'error', code: 'QUEUE_FULL', retryable: true, message: 'busy', clientSeq: frame.clientSeq }));
        return;
      }
      forwarded.push(frame);
      server.send(message);
    });
  });

  const ea = await openEditor(a, h, { user: 'alice' });
  const eb = await openEditor(b, h, { user: 'bob' });
  await expect(ea).toHaveText('start');
  await expect(eb).toHaveText('start');
  await ea.click();
  await a.keyboard.press('End');
  await a.keyboard.type(' one');
  await a.keyboard.type(' two');

  // The change is kept (not dropped) while the server is busy: Alice sees her own text, and the
  // busy status was shown.
  await expect.poll(() => rejected.length).toBe(3);
  await expect.poll(() => everBusy(a)).toBe(true);
  await expect.poll(() => textOf(a)).toBe('start one two');

  // Retried until accepted: converges for Bob and in storage, once.
  await expect.poll(() => textOf(b), { timeout: 30_000 }).toBe('start one two');
  await expect.poll(() => textOf(a)).toBe('start one two');
  await expect.poll(() => lastSync(a), { timeout: 30_000 }).toBe('synced');
  await expect.poll(() => h.storedText('doc'), { timeout: 30_000 }).toBe('start one two');

  // The first retry is the rejected envelope sent again, unchanged (CL-12), and no batch was
  // accepted twice.
  expect(forwarded.length).toBeGreaterThan(0);
  expect(forwarded[0]).toEqual(rejected[0]);
  const seqs = forwarded.map((f) => f.clientSeq);
  expect(new Set(seqs).size).toBe(seqs.length);
});
