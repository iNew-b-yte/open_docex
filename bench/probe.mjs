// Load-failure probe (V1-41 follow-up): connects N idle clients (5 per document, as the capacity
// ramp does) to one engine and prints how many failed to load, why, and what the engine reported.
//
//   node bench/probe.mjs <main|worker> <clients> [--gens K] [--conc C] [--batch B] [--pause MS]
//
// --gens   load-generator processes (default: the benchmark's own count)
// --conc   connects in flight per generator (default 50, or ODX_BENCH_CONCURRENCY)
// --batch  add the clients in batches of B with --pause ms between them (a paced ramp); default one batch
// ODX_BENCH_LOAD_TIMEOUT_MS sets how long a client has to load (default 60000).
import { Cluster, genCount } from './net.mjs';
import { sleep } from './lib/stats.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const [mode, nStr] = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const n = Number(nStr);
const gens = opt('gens', genCount());
const batch = opt('batch', n);
const pause = opt('pause', 0);

const c = await Cluster.start(mode, gens);
c.concurrency = opt('conc', undefined);
const t0 = performance.now();
const total = { failed: 0, reasons: {}, loadMsMax: 0 };
let have = 0;
let doc = 0;
while (have < n) {
  const specs = [];
  while (specs.length < Math.min(batch, n - have)) {
    const d = `p${doc++}`;
    specs.push({ doc: d, role: 'observer' });
    for (let i = 0; i < 4; i++) specs.push({ doc: d, role: 'idle' });
  }
  total.failed += await c.add(specs);
  have += specs.length;
  total.loadMsMax = Math.max(total.loadMsMax, c.lastLoadMsMax);
  for (const [k, v] of Object.entries(c.lastFailReasons)) {
    const m = (total.reasons[k] ??= { n: 0, minMs: Infinity, maxMs: 0 });
    m.n += v.n;
    m.minMs = Math.min(m.minMs, v.minMs);
    m.maxMs = Math.max(m.maxMs, v.maxMs);
  }
  if (pause > 0) await sleep(pause);
}
await sleep(1000);
const w = await c.window(1000);
const st = await c.serverStats();
console.log(JSON.stringify({ mode, clients: have, gens, conc: c.concurrency ?? Number(process.env.ODX_BENCH_CONCURRENCY ?? 50), batch, pause, seconds: Math.round((performance.now() - t0) / 100) / 10, failed: total.failed, open: w.open, closes: w.closes, closeCodes: w.closeCodes, slowestLoadMs: total.loadMsMax, genLagP99Ms: w.genLagP99Ms, reasons: total.reasons, engine: st.events }, null, 1));
await c.stop();
process.exit(0);
