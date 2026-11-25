// Network benchmarks (V1-41 items 1, 2 and 3): connections per Core, op latency, IPC fan-out.
// The engine runs in its own process (`lib/server-proc.mjs`, fake text codec, real Gateway, Core,
// queue, journal and storage); the clients run in separate load-generator processes
// (`lib/loadgen.mjs`) so that neither starves the other. Each load generator reports its
// event-loop delay, which is how a saturated generator is recognised.
import { fork } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, summarize } from './lib/stats.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** A started engine plus `k` load generators. */
export class Cluster {
  #id = 0;
  #waiters = new Map();
  #docOwner = new Map();
  #nextOwner = 0;

  static async start(mode, k) {
    const c = new Cluster(mode, k);
    await c.#boot();
    return c;
  }

  constructor(mode, k) {
    this.mode = mode;
    this.k = k;
    this.users = 0;
    this.concurrency = undefined; // connects in flight per generator (default: ODX_BENCH_CONCURRENCY or 50)
  }

  async #boot() {
    const clean = (env) => {
      const e = { ...env };
      delete e.NODE_OPTIONS;
      return e;
    };
    this.server = fork(path.join(here, 'lib', 'server-proc.mjs'), [], { env: clean({ ...process.env, ODX_BENCH_MODE: this.mode }), execArgv: [] });
    this.server.on('message', (m) => this.#onMessage(m));
    const ready = await new Promise((resolve) => this.server.once('message', (m) => m.type === 'ready' && resolve(m)));
    this.port = ready.port;
    this.gens = [];
    for (let i = 0; i < this.k; i++) {
      const g = fork(path.join(here, 'lib', 'loadgen.mjs'), [], { env: clean(process.env), execArgv: [] });
      g.on('message', (m) => this.#onMessage(m));
      this.gens.push(g);
    }
    await Promise.all(this.gens.map((g) => this.#call(g, { cmd: 'init', port: this.port })));
  }

  #onMessage(m) {
    const w = this.#waiters.get(m.id);
    if (w !== undefined) {
      this.#waiters.delete(m.id);
      w(m);
    }
  }

  #call(proc, msg) {
    const id = ++this.#id;
    return new Promise((resolve) => {
      this.#waiters.set(id, resolve);
      proc.send({ ...msg, id });
    });
  }

  /** The generator that owns `doc` (all clients of a document live in one generator). */
  #owner(doc) {
    let o = this.#docOwner.get(doc);
    if (o === undefined) {
      o = this.#nextOwner++ % this.k;
      this.#docOwner.set(doc, o);
    }
    return o;
  }

  /** Adds clients; `specs` are `{ doc, role, rate? }`. Resolves with the number that failed to load. */
  async add(specs, rate = 2) {
    const per = Array.from({ length: this.k }, () => []);
    for (const s of specs) per[this.#owner(s.doc)].push({ ...s, user: `u${this.users++}` });
    const r = await Promise.all(per.map((list, i) => (list.length ? this.#call(this.gens[i], { cmd: 'add', specs: list, rate, concurrency: this.concurrency }) : { failed: 0 })));
    // Failure reasons, merged over the generators: reason -> { n, minMs, maxMs } (times since that client's connect()).
    this.lastFailReasons = {};
    this.lastLoadMsMax = 0;
    for (const x of r) {
      this.lastLoadMsMax = Math.max(this.lastLoadMsMax, x.loadMsMax ?? 0);
      for (const [k, v] of Object.entries(x.reasons ?? {})) {
        const m = (this.lastFailReasons[k] ??= { n: 0, minMs: Infinity, maxMs: 0 });
        m.n += v.n;
        m.minMs = Math.min(m.minMs, v.minMs);
        m.maxMs = Math.max(m.maxMs, v.maxMs);
      }
    }
    return r.reduce((a, x) => a + (x.failed ?? 0), 0);
  }

  async serverStats() {
    return (await this.#call(this.server, { cmd: 'stats' })).stats;
  }

  /** Runs one measurement window of `ms` and returns latency, CPU and memory figures. */
  async window(ms) {
    await Promise.all(this.gens.map((g) => this.#call(g, { cmd: 'reset' })));
    const s0 = await this.serverStats();
    const t0 = performance.now();
    await sleep(ms);
    const s1 = await this.serverStats();
    const wall = performance.now() - t0;
    const parts = await Promise.all(this.gens.map((g) => this.#call(g, { cmd: 'collect' })));
    const res = parts.map((p) => p.result);
    const sum = (f) => res.reduce((a, r) => a + r[f], 0);
    const cpuPct = (a, b) => (a && b ? Math.round(((b.cpuUs - a.cpuUs) / 1000 / wall) * 1000) / 10 : null);
    return {
      wallMs: Math.round(wall),
      sent: sum('sent'),
      acked: sum('acked'),
      errors: sum('errors'),
      closes: sum('closes'),
      closeCodes: res.reduce((a, r) => {
        for (const [k, v] of Object.entries(r.closeCodes)) a[k] = (a[k] ?? 0) + v;
        return a;
      }, {}),
      open: sum('open'),
      ack: summarize(res.flatMap((r) => r.ack)),
      remote: summarize(res.flatMap((r) => r.remote)),
      genLagP99Ms: Math.max(...res.map((r) => r.lagP99Ms)),
      mainCpuPct: cpuPct(s0.main, s1.main),
      coreCpuPct: cpuPct(s0.core, s1.core),
      mainCpuUs: s1.main.cpuUs - s0.main.cpuUs,
      coreCpuUs: s0.core && s1.core ? s1.core.cpuUs - s0.core.cpuUs : null,
      mainRssMiB: Math.round(s1.main.rss / 2 ** 20),
      coreRssMiB: s1.core ? Math.round(s1.core.rss / 2 ** 20) : null,
    };
  }

  async stop() {
    for (const g of this.gens) g.send({ cmd: 'stop' });
    this.server.send({ cmd: 'stop' });
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 20_000);
      this.server.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    for (const g of this.gens) g.kill();
    this.server.kill();
  }
}

/** Load generators: leave cores for the engine (one or two processes) and the OS. */
export const genCount = () => Math.max(2, Math.min(8, Math.floor(os.cpus().length / 4)));

const t00 = Date.now();
const log = (...a) => console.log(`[net +${Math.round((Date.now() - t00) / 1000)}s]`, ...a);

/** Item 2: latency on one document (n clients) and across many documents (2 clients each). */
export async function latencyBench(mode, o) {
  const out = { oneDoc: [], manyDocs: [] };
  for (const n of o.oneDocClients) {
    const c = await Cluster.start(mode, genCount());
    const specs = n === 1 ? [{ doc: 'd0', role: 'typist' }] : [{ doc: 'd0', role: 'observer' }, ...Array.from({ length: n - 1 }, () => ({ doc: 'd0', role: 'typist' }))];
    const failed = await c.add(specs, o.rate);
    await sleep(o.warmMs);
    await c.window(1000); // discard
    const w = await c.window(o.measureMs);
    out.oneDoc.push({ mode, clients: n, docs: 1, typists: n === 1 ? 1 : n - 1, failed, ...w });
    log(mode, 'one doc', n, 'ack p99', w.ack.p99, 'remote p99', w.remote.p99);
    o.progress?.(out);
    await c.stop();
  }
  for (const d of o.manyDocs) {
    const c = await Cluster.start(mode, genCount());
    const specs = [];
    for (let i = 0; i < d; i++) specs.push({ doc: `m${i}`, role: 'observer' }, { doc: `m${i}`, role: 'typist' });
    const failed = await c.add(specs, o.rate);
    await sleep(o.warmMs);
    await c.window(1000);
    const w = await c.window(o.measureMs);
    out.manyDocs.push({ mode, clients: d * 2, docs: d, typists: d, failed, ...w });
    log(mode, 'many docs', d, 'ack p99', w.ack.p99, 'remote p99', w.remote.p99);
    o.progress?.(out);
    await c.stop();
  }
  return out;
}

/** Item 1: ramp connections until p99 ack latency passes `limitMs` or the engine saturates. */
export async function capacityBench(mode, variant, o) {
  const c = await Cluster.start(mode, genCount());
  const stages = [];
  let have = 0;
  let docSeq = 0;
  let stop = '';
  for (const target of o.stages) {
    const specs = [];
    while (have + specs.length < target) {
      const doc = `c${docSeq++}`;
      specs.push({ doc, role: 'observer' });
      specs.push({ doc, role: variant === 'typing' ? 'typist' : 'idle' });
      for (let i = 0; i < 3; i++) specs.push({ doc, role: 'idle' });
    }
    const t0 = performance.now();
    const failed = await c.add(specs, o.rate);
    have += specs.length;
    await sleep(o.warmMs);
    await c.window(1000);
    const w = await c.window(o.capMeasureMs ?? o.measureMs);
    if (failed > 0) log(mode, variant, have, 'load failures:', JSON.stringify(c.lastFailReasons), 'close codes', JSON.stringify(w.closeCodes));
    log(mode, variant, have, 'slowest successful load (ms since connect)', c.lastLoadMsMax);
    const row = { mode, variant, clients: have, docs: docSeq, failedToLoad: failed, failReasons: c.lastFailReasons, rampSeconds: Math.round((performance.now() - t0) / 100) / 10, ...w };
    stages.push(row);
    log(mode, variant, have, 'ack p99', w.ack.p99, 'main cpu', w.mainCpuPct, 'core cpu', w.coreCpuPct, 'open', w.open, 'failed', failed);
    o.progress?.({ stages, stoppedBecause: 'in progress' });
    if (w.ack.p99 !== null && w.ack.p99 > o.limitMs) stop = `p99 ack ${w.ack.p99} ms > ${o.limitMs} ms`;
    else if (failed > 0 || w.open < have * 0.99) stop = `${failed} clients failed to load, ${have - w.open} sockets lost`;
    else if (w.errors > 0 || w.closes > 0) stop = `${w.errors} errors, ${w.closes} closes ${JSON.stringify(w.closeCodes)}`;
    else if (w.genLagP99Ms > 75) stop = `load generator saturated (event-loop p99 ${w.genLagP99Ms} ms): result not valid beyond this stage`;
    else if ((w.mainCpuPct ?? 0) > 95 || (w.coreCpuPct ?? 0) > 95) stop = 'a server process used more than 95% of one core';
    if (stop) break;
  }
  await c.stop();
  return { stages, stoppedBecause: stop || 'last stage reached without exceeding the limit' };
}

/** Item 3: cost of one op against the number of sessions on its document. */
export async function fanoutBench(mode, o) {
  const rows = [];
  for (const s of o.sessions) {
    const c = await Cluster.start(mode, genCount());
    const idle = Array.from({ length: s }, () => ({ doc: 'f0', role: 'idle' }));
    const failedIdle = await c.add([{ doc: 'f0', role: 'observer' }, ...idle]);
    await sleep(o.warmMs);
    const base = await c.window(o.measureMs / 2);
    const failedT = await c.add([{ doc: 'f0', role: 'typist', rate: o.opsPerSec }], o.opsPerSec);
    await sleep(o.warmMs);
    await c.window(1000);
    const w = await c.window(o.measureMs);
    const ops = w.acked;
    const perRaw = (us) => (ops > 0 && us !== null ? Math.round((us / ops) * 10) / 10 : null);
    // Net of the idle baseline measured before the typist joined (null when the baseline was noisier than the signal).
    const perNet = (us, b) => (ops > 0 && us !== null && b !== null && us - b * (w.wallMs / base.wallMs) > 0 ? Math.round(((us - b * (w.wallMs / base.wallMs)) / ops) * 10) / 10 : null);
    rows.push({
      mode,
      sessions: s + 2,
      ops,
      failed: failedIdle + failedT,
      mainCpuUsPerOp: perNet(w.mainCpuUs, base.mainCpuUs),
      coreCpuUsPerOp: perNet(w.coreCpuUs, base.coreCpuUs),
      mainCpuUsPerOpRaw: perRaw(w.mainCpuUs),
      coreCpuUsPerOpRaw: perRaw(w.coreCpuUs),
      mainCpuPct: w.mainCpuPct,
      coreCpuPct: w.coreCpuPct,
      baselineMainCpuPct: base.mainCpuPct,
      baselineCoreCpuPct: base.coreCpuPct,
      ack: w.ack,
      remote: w.remote,
      genLagP99Ms: w.genLagP99Ms,
    });
    log(mode, 'fanout', s + 2, 'main us/op', rows.at(-1).mainCpuUsPerOp, 'core us/op', rows.at(-1).coreCpuUsPerOp, 'remote p99', w.remote.p99);
    o.progress?.(rows);
    await c.stop();
  }
  return rows;
}
