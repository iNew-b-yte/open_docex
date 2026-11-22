// Spike S2: import / export / round-trip matrix for the text features.
//   node spikes/S2/roundtrip.mjs            -> spikes/S2/results/roundtrip-<platform>.json + markdown on stdout
// import    : fixture (.docx/.odt) --LO--> .fodt, checked
// export    : features.fodt (shaped like the planned FodtMapper output) --LO--> .docx/.odt --LO--> .fodt, checked
// roundtrip : fixture --LO--> .fodt --LO--> same format --LO--> .fodt, checked (2 cycles)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { convert, resetProfile } from './lib/soffice.mjs';
import { FIXTURES, SPIKE, WORK } from './lib/paths.mjs';
import { inspect } from './lib/inspect.mjs';
import { FEATURES, runChecks } from './lib/checks.mjs';

const profileDir = join(WORK, 'profile-rt');
resetProfile(profileDir);
const timings = [];
let n = 0;
async function lo(inPath, target, label) {
  const outDir = join(WORK, 'rt', String(++n).padStart(3, '0'));
  const r = await convert({ inPath, outDir, target, profileDir });
  timings.push({ label, target, ms: Math.round(r.ms), ok: r.ok });
  if (!r.ok) throw new Error(`${label}: ${inPath} -> ${target} failed (code ${r.code}) ${r.stderr}`);
  return r.outPath;
}
const check = (fodt) => {
  const m = inspect(readFileSync(fodt, 'utf8'));
  return { checks: runChecks(m), unknown: m.unknown, ignored: m.ignored };
};

const columns = {};
columns['source features.fodt'] = check(join(FIXTURES, 'features.fodt'));

const imports = [
  ['docx (hand-written)', 'features-word.docx', 'docx'],
  ['docx (LO-written)', 'features.docx', 'docx'],
  ['odt', 'features.odt', 'odt'],
];
for (const [name, file, fmt] of imports) {
  const f1 = await lo(join(FIXTURES, file), 'fodt', `import ${fmt}`);
  columns[`import ${name}`] = check(f1);
  let cur = f1;
  for (let cycle = 1; cycle <= 2; cycle++) {
    const back = await lo(cur, fmt, `export ${fmt}`);
    cur = await lo(back, 'fodt', `import ${fmt}`);
    columns[`roundtrip x${cycle} ${name}`] = check(cur);
  }
}
for (const fmt of ['docx', 'odt']) {
  const out = await lo(join(FIXTURES, 'features.fodt'), fmt, `export ${fmt}`);
  columns[`export ${fmt}`] = check(await lo(out, 'fodt', `import ${fmt}`));
}

const resultsDir = join(SPIKE, 'results');
mkdirSync(resultsDir, { recursive: true });
const meta = { platform: process.platform, node: process.version, date: new Date().toISOString() };
writeFileSync(join(resultsDir, `roundtrip-${process.platform}.json`), JSON.stringify({ meta, columns, timings }, null, 1));

// Markdown: per-check table, then per-feature summary.
const cols = Object.keys(columns);
const ids = columns[cols[0]].checks.map((c) => `${c.feature}|${c.id}`);
const lines = [`| Feature | Check | ${cols.join(' | ')} |`, `|---|---|${cols.map(() => '---').join('|')}|`];
for (const key of ids) {
  const [feat, id] = key.split('|');
  const cells = cols.map((c) => {
    const x = columns[c].checks.find((y) => `${y.feature}|${y.id}` === key);
    return x.pass ? 'ok' : `**FAIL** ${String(x.detail ?? '').replace(/\|/g, '/').replace(/\n/g, '\\n')}`;
  });
  lines.push(`| ${feat} | ${id} | ${cells.join(' | ')} |`);
}
lines.push('', `| Feature | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`);
for (const [f, title] of FEATURES) {
  lines.push(`| ${f} ${title} | ${cols.map((c) => { const xs = columns[c].checks.filter((x) => x.feature === f); const p = xs.filter((x) => x.pass).length; return p === xs.length ? 'pass' : `${p}/${xs.length}`; }).join(' | ')} |`);
}
lines.push('', 'unknown/ignored body elements:');
for (const c of cols) lines.push(`- ${c}: unknown ${JSON.stringify(columns[c].unknown)} ignored ${JSON.stringify(columns[c].ignored)}`);
console.log(lines.join('\n'));
