// A load generator process: it owns a set of WebSocket clients and measures, per window, the
// submit-to-ack latency of every typist and the submit-to-`remote` latency from each typist to
// the observer of its document (same process, so one clock). Driven over IPC by `net.mjs`.
//
// Roles: `idle` (connects, loads, then ignores every frame), `typist` (submits one op of one
// character at position 2 at `rate` ops/s with random jitter), `observer` (parses every frame;
// its `remote` frames give the second-client latency of the typists on its document).
import { monitorEventLoopDelay } from 'node:perf_hooks';
import WebSocket from 'ws';
import { newClientId } from '@open-docex/shared/ids';
import { PROTOCOL_VERSION, WS_SUBPROTOCOL } from '@open-docex/shared/protocol';

const now = () => performance.now();
let port = 0;
const clients = [];
const typistByClientId = new Map();
const observerByDoc = new Map();
let win = fresh();
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();

function fresh() {
  return { ack: [], remote: [], sent: 0, acked: 0, errors: 0, closes: 0, closeCodes: {} };
}

class Client {
  constructor(spec) {
    this.spec = spec;
    this.id = newClientId();
    this.rev = 0;
    this.seq = 0;
    this.epoch = undefined;
    this.loaded = false;
    this.open = false;
    this.pending = new Map(); // clientSeq -> submit time
    this.submitTimes = []; // ordinal -> time (for remote matching)
    this.remoteSeen = new Map(); // typist client -> ops seen (observer only)
    this.timer = undefined;
    this.ready = new Promise((resolve) => (this.resolveReady = resolve));
  }

  connect() {
    const { doc, user } = this.spec;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/open-docex?doc=${encodeURIComponent(doc)}&token=edit:${user}`, [WS_SUBPROTOCOL]);
    this.ws = ws;
    ws.on('open', () => {
      this.open = true;
      ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, clientId: this.id }));
    });
    const parseAll = this.spec.role !== 'idle';
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      if (!this.loaded) {
        const m = JSON.parse(data.toString());
        if (m.type === 'load-start') this.epoch = m.epoch;
        else if (m.type === 'load-done') {
          this.rev = m.rev;
          this.loaded = true;
          this.resolveReady(true);
        } else if (m.type === 'error') this.resolveReady(false);
        return;
      }
      if (!parseAll) return;
      const m = JSON.parse(data.toString());
      if (m.type === 'ack') {
        this.rev = Math.max(this.rev, m.rev);
        const t0 = this.pending.get(m.clientSeq);
        if (t0 !== undefined) {
          this.pending.delete(m.clientSeq);
          win.ack.push(now() - t0);
          win.acked++;
        }
      } else if (m.type === 'remote') {
        this.rev = Math.max(this.rev, m.fromRev + m.ops.length);
        if (this.spec.role === 'observer') this.onRemote(m);
      } else if (m.type === 'error') win.errors++;
    });
    ws.on('close', (code) => {
      this.open = false;
      this.closeCode = code;
      if (this.loaded) {
        win.closes++;
        win.closeCodes[code] = (win.closeCodes[code] ?? 0) + 1;
      }
      this.resolveReady(false);
      clearTimeout(this.timer);
    });
    ws.on('error', (e) => {
      this.failReason = String(e.message ?? e).slice(0, 80);
      this.resolveReady(false);
    });
    ws.on('unexpected-response', (_req, res) => {
      this.failReason = `HTTP ${res.statusCode}`;
      this.resolveReady(false);
    });
  }

  onRemote(m) {
    const typist = typistByClientId.get(m.clientId);
    if (typist === undefined) return;
    const seen = this.remoteSeen.get(typist) ?? 0;
    const t = now();
    for (let i = 0; i < m.ops.length; i++) {
      const t0 = typist.submitTimes[seen + i];
      if (t0 !== undefined) win.remote.push(t - t0);
    }
    this.remoteSeen.set(typist, seen + m.ops.length);
  }

  startTyping(rate) {
    const mean = 1000 / rate;
    const tick = () => {
      if (!this.open) return;
      const seq = ++this.seq;
      const t0 = now();
      this.pending.set(seq, t0);
      this.submitTimes.push(t0);
      win.sent++;
      this.ws.send(
        JSON.stringify({
          type: 'submit',
          clientId: this.id,
          clientSeq: seq,
          epoch: this.epoch,
          baseRev: this.rev,
          ops: [{ stepType: 'replace', from: 2, to: 2, slice: { content: [{ type: 'text', text: 'x' }] } }],
        }),
      );
      this.timer = setTimeout(tick, mean * (0.5 + Math.random()));
    };
    this.timer = setTimeout(tick, Math.random() * mean);
  }
}

async function add(specs, rate, concurrency = 50) {
  let failed = 0;
  const reasons = {};
  const created = specs.map((s) => new Client(s));
  for (const c of created) {
    clients.push(c);
    if (c.spec.role === 'typist') typistByClientId.set(c.id, c);
  }
  let i = 0;
  const worker = async () => {
    while (i < created.length) {
      const c = created[i++];
      c.connect();
      if (!(await Promise.race([c.ready, new Promise((r) => setTimeout(() => r(false), 60_000))]))) {
        failed++;
        const why = c.failReason ?? (c.closeCode !== undefined ? `closed ${c.closeCode} before load` : 'no load-done in 60 s');
        reasons[why] = (reasons[why] ?? 0) + 1;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  for (const c of created) if (c.loaded && c.spec.role === 'typist') c.startTyping(c.spec.rate ?? rate);
  return { failed, reasons };
}

process.on('message', async (msg) => {
  if (msg.cmd === 'init') {
    port = msg.port;
    process.send({ type: 'done', id: msg.id });
  } else if (msg.cmd === 'add') {
    const { failed, reasons } = await add(msg.specs, msg.rate);
    process.send({ type: 'done', id: msg.id, failed, reasons });
  } else if (msg.cmd === 'reset') {
    win = fresh();
    lag.reset();
    process.send({ type: 'done', id: msg.id });
  } else if (msg.cmd === 'collect') {
    const w = win;
    process.send({
      type: 'done',
      id: msg.id,
      result: {
        ack: w.ack,
        remote: w.remote,
        sent: w.sent,
        acked: w.acked,
        errors: w.errors,
        closes: w.closes,
        closeCodes: w.closeCodes,
        open: clients.filter((c) => c.open).length,
        lagP99Ms: Math.round((lag.percentile(99) / 1e6) * 100) / 100,
      },
    });
  } else if (msg.cmd === 'stop') {
    for (const c of clients) {
      clearTimeout(c.timer);
      c.ws?.terminate();
    }
    process.exit(0);
  }
});
void observerByDoc;

// Never outlive the orchestrator (a stage killed on its time limit).
process.on('disconnect', () => process.exit(0));
