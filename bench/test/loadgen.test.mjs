// Functional test of the load generator: it runs against a fake server that speaks just enough of
// the protocol (hello -> load-start/load-done, submit -> ack after 25 ms, `remote` to the other
// clients of the document after 40 ms), so the expected latencies are known. Run: node --test bench/test/
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
let http;
let wss;
let port;
let gen;
let nextId = 0;
const waiters = new Map();

const call = (msg) =>
  new Promise((resolve) => {
    const id = ++nextId;
    waiters.set(id, resolve);
    gen.send({ ...msg, id });
  });

before(async () => {
  http = createServer();
  wss = new WebSocketServer({ server: http, handleProtocols: (p) => [...p][0] });
  const byDoc = new Map();
  wss.on('connection', (ws, req) => {
    const doc = new URL(req.url, 'http://x').searchParams.get('doc');
    const set = byDoc.get(doc) ?? new Set();
    byDoc.set(doc, set);
    set.add(ws);
    ws.on('close', () => set.delete(ws));
    let rev = 0;
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === 'hello') {
        ws.send(JSON.stringify({ type: 'load-start', epoch: 'e1' }));
        ws.send(JSON.stringify({ type: 'load-done', rev: 0 }));
      } else if (m.type === 'submit') {
        rev++;
        setTimeout(() => ws.send(JSON.stringify({ type: 'ack', clientSeq: m.clientSeq, rev })), 25);
        setTimeout(() => {
          for (const other of set) if (other !== ws) other.send(JSON.stringify({ type: 'remote', fromRev: rev - 1, ops: m.ops, clientId: m.clientId }));
        }, 40);
      }
    });
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  port = http.address().port;
  gen = fork(path.join(here, '..', 'lib', 'loadgen.mjs'), [], { execArgv: [], env: { ...process.env, NODE_OPTIONS: '' } });
  gen.on('message', (m) => waiters.get(m.id)?.(m));
  await call({ cmd: 'init', port });
});

after(async () => {
  gen.send({ cmd: 'stop' });
  for (const c of wss.clients) c.terminate();
  await new Promise((resolve) => http.close(resolve));
});

test('typist and observer: every submit is acked, latencies match the fake server', async () => {
  const failed = (await call({ cmd: 'add', rate: 20, specs: [{ doc: 'd', role: 'observer', user: 'o' }, { doc: 'd', role: 'typist', user: 't' }, { doc: 'd', role: 'idle', user: 'i' }] })).failed;
  assert.equal(failed, 0);
  await call({ cmd: 'reset' });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const r = (await call({ cmd: 'collect' })).result;
  assert.equal(r.open, 3);
  assert.ok(r.sent >= 30 && r.sent <= 90, `sent ${r.sent} (20/s for 3 s with jitter)`);
  assert.ok(r.acked >= r.sent - 3 && r.acked <= r.sent + 3, `acked ${r.acked} of ${r.sent}`);
  assert.equal(r.errors, 0);
  assert.equal(r.closes, 0);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(r.ack.length === r.acked);
  assert.ok(mean(r.ack) >= 24 && mean(r.ack) < 60, `ack mean ${mean(r.ack)} ms, server delay is 25`);
  assert.ok(r.remote.length >= r.acked - 3, `remote ${r.remote.length}`);
  assert.ok(mean(r.remote) >= 39 && mean(r.remote) < 75, `remote mean ${mean(r.remote)} ms, server delay is 40`);
});
