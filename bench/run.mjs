// `npm run bench` entry. Runs the V1-41 benchmark stages one after another, each as its own
// child process (`stage.mjs`) under a hard time limit, and writes JSON to `bench/results/`.
//
//   npm run bench                                 every stage, both modes (about an hour)
//   npm run bench -- --quick                      CI smoke: tiny sizes, numbers not meaningful
//   npm run bench -- --only=capacity              one stage (latency|capacity|fanout|lo|typing, comma list)
//   npm run bench -- --only=latency --mode=main   one engine mode of a per-mode stage
//   npm run bench -- --limit-min=20               hard time limit per stage and mode (default 10)
//
// Stages: latency (item 2), capacity (item 1), fanout (item 3), lo (item 4), typing (item 5).
// Run nothing else on the machine while it measures. `npm run build` must come first.
// A stage that passes its limit is killed; its partial result stays on disk with `complete: false`.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkResult } from './lib/check.mjs';
import { PER_MODE, STAGES } from './lib/params.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const quick = args.includes('--quick');
const val = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = (val('only') ?? STAGES.join(',')).split(',');
const modes = (val('mode') ?? 'main,worker').split(',');
const limitMs = Number(val('limit-min') ?? 10) * 60_000;
for (const s of only) if (!STAGES.includes(s)) throw new Error(`unknown stage ${s}`);

const jobs = only.flatMap((s) => (PER_MODE.has(s) ? modes.map((m) => [s, m]) : [[s]]));
const summary = [];
for (const [stage, mode] of jobs) {
  const label = `${stage}${mode ? ` ${mode}` : ''}${quick ? ' quick' : ''}`;
  const t0 = Date.now();
  const child = spawn(process.execPath, [path.join(here, 'stage.mjs'), stage, ...(mode ? [mode] : []), ...(quick ? ['--quick'] : [])], { stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' } });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.error(`[bench] ${label}: time limit of ${limitMs / 60_000} min reached, killing it`);
    child.kill();
  }, limitMs);
  const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
  clearTimeout(timer);
  const file = path.join(here, 'results', quick ? 'quick' : 'full', `${stage}${mode ? `-${mode}` : ''}.json`);
  let status = timedOut ? 'TIME LIMIT (partial result kept)' : code === 0 ? 'ok' : `FAILED (exit ${code})`;
  try {
    const problems = checkResult(JSON.parse(readFileSync(file, 'utf8')).data);
    if (problems.length > 0) status += `; not sane: ${problems[0]}`;
  } catch {
    status += '; no result file';
  }
  summary.push(`${label}: ${status} in ${Math.round((Date.now() - t0) / 1000)} s`);
  console.log('[bench]', summary.at(-1));
}
console.log('[bench] summary\n  ' + summary.join('\n  '));
process.exit(summary.some((s) => !s.includes(': ok in')) ? 1 : 0);
