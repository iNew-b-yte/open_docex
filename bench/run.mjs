// `npm run bench` entry. Runs the V1-41 benchmarks and writes JSON to `bench/results/`.
//
//   npm run bench                       full run (about an hour on the reference machine)
//   npm run bench -- --quick            CI smoke: tiny sizes, a few minutes, numbers not meaningful
//   npm run bench -- --only=net,lo,typing   pick parts (net = items 1-3, lo = item 4, typing = item 5)
//
// Run nothing else on the machine while it measures. `npm run build` must come first.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeEnvironment } from './lib/env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const quick = args.includes('--quick');
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = new Set((onlyArg ? onlyArg.slice(7) : 'net,lo,typing').split(','));
const outDir = path.join(here, 'results', quick ? 'quick' : 'full');
mkdirSync(outDir, { recursive: true });
const save = (name, data) => writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(data, null, 2));

const P = quick
  ? {
      rate: 2, warmMs: 1500, measureMs: 3000,
      oneDocClients: [1, 10], manyDocs: [10], stages: [100, 200], limitMs: 100, fanout: [0, 10], opsPerSec: 20,
      pages: [10], loConcurrency: [1, 2], loRepeats: 1, keystrokes: 60, typingPages: 20,
    }
  : {
      rate: 2, warmMs: 5000, measureMs: 20_000,
      oneDocClients: [1, 10, 50, 100], manyDocs: [10, 100, 500],
      stages: [250, 500, 1000, 2000, 3000, 4000, 6000, 8000, 10_000, 12_000], limitMs: 100,
      fanout: [0, 10, 50, 100, 250, 500, 1000, 2000], opsPerSec: 20,
      pages: [10, 100, 300], loConcurrency: [1, 2], loRepeats: 3, keystrokes: 400, typingPages: 300,
    };

const env = await describeEnvironment({ browser: only.has('typing') });
save('environment', { quick, params: P, ...env });
console.log('[bench]', quick ? 'quick' : 'full', env.cpuModel, `${env.logicalCores} cores`, `${env.ramGiB} GiB`, env.libreoffice);

if (only.has('net')) {
  const { latencyBench, capacityBench, fanoutBench } = await import('./net.mjs');
  const latency = {};
  const capacity = {};
  const fanout = {};
  for (const mode of ['main', 'worker']) {
    latency[mode] = await latencyBench(mode, P);
    save('latency', latency);
    for (const variant of ['idle', 'typing']) {
      capacity[`${mode}-${variant}`] = await capacityBench(mode, variant, P);
      save('capacity', capacity);
    }
    fanout[mode] = await fanoutBench(mode, { sessions: P.fanout, opsPerSec: P.opsPerSec, warmMs: P.warmMs, measureMs: P.measureMs });
    save('fanout', fanout);
  }
}
if (only.has('lo')) {
  const { loBench } = await import('./lo.mjs');
  save('libreoffice', await loBench(P));
}
if (only.has('typing')) {
  const { typingBench } = await import('./typing.mjs');
  save('typing', await typingBench(P));
}
console.log('[bench] done; results in', outDir);
