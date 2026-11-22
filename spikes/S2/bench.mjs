// Spike S2: conversion timings and concurrent profile behaviour.
//   node spikes/S2/bench.mjs   -> spikes/S2/results/bench-<platform>.json + summary on stdout
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { convert, resetProfile } from './lib/soffice.mjs';
import { FIXTURES, SPIKE, WORK } from './lib/paths.mjs';

const W = join(WORK, 'bench');
const res = { meta: { platform: process.platform, node: process.version, cpus: cpus().length, cpu: cpus()[0]?.model, memGB: Math.round(totalmem() / 2 ** 30), date: new Date().toISOString() } };
const stat = (xs) => { const s = [...xs].sort((a, b) => a - b); return { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], max: s.at(-1) }; };
let seq = 0;
const out = () => join(W, 'o', String(++seq));
async function one(inPath, target, profileDir) {
  const r = await convert({ inPath, outDir: out(), target, profileDir });
  if (!r.ok) console.log('  FAILED', inPath, target, r.code, r.stderr.slice(-300));
  return r;
}

// 1. Cold start: a freshly created (seeded) profile, first conversion.
const cold = [];
for (let i = 0; i < 3; i++) {
  const p = join(W, `cold-${i}`);
  resetProfile(p);
  cold.push(Math.round((await one(join(FIXTURES, 'features.docx'), 'fodt', p)).ms));
}
res.coldFirstConversionMs = cold;
console.log('cold first conversion (docx->fodt), ms:', cold);

// 2. Warm: reused profile slot.
const warmP = join(W, 'warm');
resetProfile(warmP);
await one(join(FIXTURES, 'features.odt'), 'fodt', warmP);
const fodtFromDocx = (await one(join(FIXTURES, 'features.docx'), 'fodt', warmP)).outPath;
const cases = [
  ['docx->fodt (import)', join(FIXTURES, 'features.docx'), 'fodt'],
  ['odt->fodt (import)', join(FIXTURES, 'features.odt'), 'fodt'],
  ['fodt->docx (export)', join(FIXTURES, 'features.fodt'), 'docx'],
  ['fodt->odt (export)', join(FIXTURES, 'features.fodt'), 'odt'],
];
// A larger document: the features body repeated 100 times (generated, not committed).
const src = readFileSync(join(FIXTURES, 'features.fodt'), 'utf8');
const body = src.slice(src.indexOf('<office:text>') + 13, src.indexOf('</office:text>'));
const big = src.replace(body, body.repeat(100).replaceAll('table:name="Table1"', () => `table:name="T${++seq}"`));
const bigPath = join(W, 'big.fodt');
mkdirSync(W, { recursive: true });
writeFileSync(bigPath, big);
const bigDocx = (await one(bigPath, 'docx', warmP)).outPath;
const bigOdt = (await one(bigPath, 'odt', warmP)).outPath;
cases.push(['big fodt->docx (export)', bigPath, 'docx'], ['big fodt->odt (export)', bigPath, 'odt'], ['big docx->fodt (import)', bigDocx, 'fodt'], ['big odt->fodt (import)', bigOdt, 'fodt']);
res.sizes = { 'features.docx': statSync(join(FIXTURES, 'features.docx')).size, 'features.odt': statSync(join(FIXTURES, 'features.odt')).size, 'features.fodt': statSync(join(FIXTURES, 'features.fodt')).size,
  'features.fodt from docx import': statSync(fodtFromDocx).size, 'big.fodt': statSync(bigPath).size, 'big.docx': statSync(bigDocx).size, 'big.odt': statSync(bigOdt).size };
res.warm = {};
for (const [label, inPath, target] of cases) {
  const ms = [];
  for (let i = 0; i < 5; i++) ms.push(Math.round((await one(inPath, target, warmP)).ms));
  res.warm[label] = stat(ms);
  console.log(`warm ${label}:`, res.warm[label]);
}

// 3. Concurrency.
const sofficeBins = () => {
  if (process.platform !== 'win32') return Number(spawnSync('pgrep', ['-c', 'soffice.bin'], { encoding: 'utf8' }).stdout.trim() || 0);
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq soffice.bin', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return r.stdout.split('\n').filter((l) => l.includes('soffice.bin')).length;
};
async function parallel(label, n, profileFor) {
  const t0 = performance.now();
  const rs = await Promise.all(Array.from({ length: n }, (_, i) => one(join(FIXTURES, 'features.docx'), 'fodt', profileFor(i))));
  const wall = Math.round(performance.now() - t0);
  const r = { n, wallMs: wall, ok: rs.filter((x) => x.ok).length, perJobMs: rs.map((x) => Math.round(x.ms)), exitCodes: rs.map((x) => x.code), leftoverSofficeBin: sofficeBins() };
  const fails = rs.filter((x) => !x.ok);
  if (fails.length) r.failureOutput = fails.map((x) => (x.stdout + ' ' + x.stderr).trim().slice(-300));
  console.log(`concurrency ${label}:`, JSON.stringify(r));
  return r;
}
res.concurrency = { sofficeBinBefore: sofficeBins() };
for (const n of [2, 4, 8]) {
  for (let i = 0; i < n; i++) { const p = join(W, `slot-${i}`); resetProfile(p); await one(join(FIXTURES, 'features.odt'), 'fodt', p); }
  res.concurrency[`own profiles (warm) x${n}`] = await parallel(`own profiles x${n}`, n, (i) => join(W, `slot-${i}`));
}
res.concurrency['shared profile x4'] = await parallel('shared profile x4', 4, () => warmP);
for (let i = 0; i < 4; i++) resetProfile(join(W, `fresh-${i}`));
res.concurrency['own fresh profiles (cold) x4'] = await parallel('own fresh profiles x4', 4, (i) => join(W, `fresh-${i}`));

// 4. Timeout -> kill tree.
const killP = join(W, 'kill');
resetProfile(killP);
const before = sofficeBins();
const k = await convert({ inPath: bigPath, outDir: out(), target: 'docx', profileDir: killP, timeoutMs: 1500 });
await new Promise((r) => setTimeout(r, 1500));
res.timeoutKill = { timedOut: k.timedOut, ok: k.ok, ms: Math.round(k.ms), sofficeBinBefore: before, sofficeBinAfter: sofficeBins() };
console.log('timeout kill:', JSON.stringify(res.timeoutKill));
const after = await one(join(FIXTURES, 'features.docx'), 'fodt', (resetProfile(killP), killP));
res.timeoutKill.slotUsableAfterReset = after.ok;

mkdirSync(join(SPIKE, 'results'), { recursive: true });
writeFileSync(join(SPIKE, 'results', `bench-${process.platform}.json`), JSON.stringify(res, null, 1));
