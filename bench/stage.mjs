// Runs ONE benchmark stage (in one engine mode, for the per-mode stages) and writes
// `bench/results/<quick|full>/<stage>[-<mode>].json`. `run.mjs` starts this as a child process
// under a hard time limit; it can also be run by hand:
//
//   node bench/stage.mjs capacity main --quick
//
// The file is rewritten after every step with `complete: false` and once more at the end with
// `complete: true`, so a stage killed on its time limit keeps what it measured.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkResult } from './lib/check.mjs';
import { describeEnvironment } from './lib/env.mjs';
import { PER_MODE, STAGES, params } from './lib/params.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const quick = argv.includes('--quick');
const [stage, modeArg] = argv.filter((a) => !a.startsWith('--'));
if (!STAGES.includes(stage)) {
  console.error(`usage: node bench/stage.mjs <${STAGES.join('|')}> [main|worker] [--quick]`);
  process.exit(64);
}
const mode = PER_MODE.has(stage) ? modeArg : undefined;
if (PER_MODE.has(stage) && mode !== 'main' && mode !== 'worker') {
  console.error(`${stage} needs a mode: main or worker`);
  process.exit(64);
}

const outDir = path.join(here, 'results', quick ? 'quick' : 'full');
mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `${stage}${mode ? `-${mode}` : ''}.json`);
const P = params(quick);
const env = await describeEnvironment({ browser: stage === 'typing' });
const save = (data, complete) => writeFileSync(file, JSON.stringify({ stage, mode: mode ?? null, quick, complete, startedAt: env.date, environment: env, params: P, data }, null, 2));
P.progress = (data) => save(data, false);

let data;
if (stage === 'latency') data = await (await import('./net.mjs')).latencyBench(mode, P);
else if (stage === 'capacity') {
  const { capacityBench } = await import('./net.mjs');
  data = {};
  for (const variant of ['idle', 'typing']) {
    data[variant] = await capacityBench(mode, variant, { ...P, progress: (d) => save({ ...data, [variant]: d }, false) });
    save(data, false);
  }
} else if (stage === 'fanout') data = await (await import('./net.mjs')).fanoutBench(mode, P);
else if (stage === 'lo') data = await (await import('./lo.mjs')).loBench(P);
else data = await (await import('./typing.mjs')).typingBench(P);

save(data, true);
const problems = checkResult(data);
console.log(`[stage ${stage}${mode ? ` ${mode}` : ''}${quick ? ' quick' : ''}] wrote ${file}`);
if (problems.length > 0) {
  console.error('[stage] result is NOT sane:\n  ' + problems.join('\n  '));
  process.exit(2);
}
console.log('[stage] result is sane (non-empty, finite, percentiles ordered)');
process.exit(0);
