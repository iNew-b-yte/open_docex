// Spike S2: does the seeded profile (LLD §14.3) block external links and keep cached formula values?
//   node spikes/S2/profile-settings.mjs   -> spikes/S2/results/profile-settings-<platform>.json + stdout
// Each case runs twice: with the seeded registrymodifications.xcu and with an empty profile.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { convert, resetProfile } from './lib/soffice.mjs';
import { FIXTURES, SPIKE, SRC, WORK } from './lib/paths.mjs';
import { readZip, writeZip } from './lib/zip.mjs';

const W = join(WORK, 'settings');
mkdirSync(W, { recursive: true });
const pngBytes = readFileSync(join(FIXTURES, 'images', 'probe.png'));
const hits = [];
const server = createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'image/png' }); res.end(pngBytes); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const profiles = { seeded: join(W, 'p-seeded'), empty: join(W, 'p-empty') };
let seq = 0;
const res = { meta: { platform: process.platform, date: new Date().toISOString() }, externalImage: {}, recalc: {} };

// External image: a flat ODF and a .docx that link (not embed) an image on a local HTTP server.
const fodt = readFileSync(join(FIXTURES, 'legacy-images.fodt'), 'utf8')
  .replace(/<office:text>[\s\S]*<\/office:text>/, `<office:text><text:p text:style-name="Standard"><draw:frame draw:style-name="fr1" draw:name="Linked" text:anchor-type="as-char" svg:width="20mm" svg:height="10mm"><draw:image xlink:href="${base}/odf.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></text:p></office:text>`);
writeFileSync(join(W, 'linked.fodt'), fodt);
const wordDir = join(SRC, 'word-features');
const parts = [
  ['[Content_Types].xml', readFileSync(join(wordDir, '[Content_Types].xml'))],
  ['_rels/.rels', readFileSync(join(wordDir, '_rels', '.rels'))],
  ['word/styles.xml', readFileSync(join(wordDir, 'word', 'styles.xml'))],
  ['word/numbering.xml', readFileSync(join(wordDir, 'word', 'numbering.xml'))],
  ['word/header1.xml', readFileSync(join(wordDir, 'word', 'header1.xml'))],
  ['word/footer1.xml', readFileSync(join(wordDir, 'word', 'footer1.xml'))],
  ['word/_rels/document.xml.rels', Buffer.from(readFileSync(join(wordDir, 'word', '_rels', 'document.xml.rels'), 'utf8')
    .replace('Target="media/image1.png"', `Target="${base}/docx.png" TargetMode="External"`))],
  ['word/document.xml', Buffer.from(readFileSync(join(wordDir, 'word', 'document.xml'), 'utf8').replace('r:embed="rId5"', 'r:link="rId5"'))],
  ['word/media/image2.jpeg', readFileSync(join(FIXTURES, 'images', 'probe.jpg'))],
  ['word/media/image3.gif', readFileSync(join(FIXTURES, 'images', 'probe.gif'))],
];
writeFileSync(join(W, 'linked.docx'), writeZip(parts));

for (const [pname, pdir] of Object.entries(profiles)) {
  resetProfile(pdir, { seed: pname === 'seeded' });
  for (const [file, target] of [['linked.fodt', 'docx'], ['linked.docx', 'fodt'], ['linked.fodt', 'odt']]) {
    hits.length = 0;
    const r = await convert({ inPath: join(W, file), outDir: join(W, 'o', String(++seq)), target, profileDir: pdir });
    let embedded = 'n/a';
    if (r.ok && target === 'docx') embedded = [...readZip(readFileSync(r.outPath)).keys()].filter((k) => k.startsWith('word/media/')).join(',') || 'none';
    if (r.ok && target === 'odt') embedded = [...readZip(readFileSync(r.outPath)).keys()].filter((k) => k.startsWith('Pictures/')).join(',') || 'none';
    if (r.ok && target === 'fodt') { const x = readFileSync(r.outPath, 'utf8'); embedded = `binary-data:${(x.match(/<office:binary-data>/g) ?? []).length} hrefs:${(x.match(/xlink:href="http[^"]*"/g) ?? []).join(',')}`; }
    res.externalImage[`${pname} ${file}->${target}`] = { ok: r.ok, httpRequests: [...hits], output: embedded };
    console.log('external', pname, file, '->', target, JSON.stringify(res.externalImage[`${pname} ${file}->${target}`]));
  }
}
server.close();

// Recalc: a cell whose formula is =1+1 but whose saved value is 99.
const fods = `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
<office:body><office:spreadsheet><table:table table:name="S"><table:table-row><table:table-cell table:formula="of:=1+1" office:value-type="float" office:value="99"><text:p>99</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document>`;
writeFileSync(join(W, 'stale.fods'), fods);
// The same file with a LibreOffice generator string (LibreOffice treats its own files differently on load).
writeFileSync(join(W, 'stale-lo.fods'), fods.replace('office:version="1.3"', 'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.3"')
  .replace('<office:body>', '<office:meta><meta:generator>LibreOffice/26.8.3.1$Windows_X86_64 LibreOffice_project/861effc5289d539f15c4c18d1ba8579ffd78728b</meta:generator></office:meta><office:body>'));
for (const [pname, pdir] of Object.entries(profiles)) {
  const xlsxCellOf = (p) => /<c [^>]*r="A1"[^>]*>[\s\S]*?<\/c>/.exec(readZip(readFileSync(p)).get('xl/worksheets/sheet1.xml').toString('utf8'))?.[0];
  const y = await convert({ inPath: join(W, 'stale-lo.fods'), outDir: join(W, 'o', String(++seq)), target: 'xlsx', profileDir: pdir });
  res.recalc[`${pname} fods(LO generator)->xlsx`] = { ok: y.ok, cell: y.ok ? xlsxCellOf(y.outPath) : undefined };
  const x = await convert({ inPath: join(W, 'stale.fods'), outDir: join(W, 'o', String(++seq)), target: 'xlsx', profileDir: pdir });
  res.recalc[`${pname} fods->xlsx`] = { ok: x.ok, cell: x.ok ? xlsxCellOf(x.outPath) : undefined };
  console.log('recalc', pname, JSON.stringify(res.recalc[`${pname} fods(LO generator)->xlsx`]));
  res.recalc[`${pname} profile xcu still has DisableMacrosExecution=true`] = readFileSync(join(pdir, 'user', 'registrymodifications.xcu'), 'utf8').includes('DisableMacrosExecution" oor:op="fuse"><value>true');
  // OOXML side: a hand-patched xlsx whose A1 is <f>1+1</f><v>99</v>.
  const z = x.ok ? readZip(readFileSync(x.outPath)) : null;
  if (z) {
    const patched = [...z.entries()].map(([k, v]) => [k, k === 'xl/worksheets/sheet1.xml' ? Buffer.from(v.toString('utf8').replace(/<v>[^<]*<\/v>/, '<v>99</v>')) : v]);
    const ct = patched.findIndex(([k]) => k === '[Content_Types].xml');
    patched.unshift(...patched.splice(ct, 1));
    const xp = join(W, `stale-${pname}.xlsx`);
    writeFileSync(xp, writeZip(patched));
    const back = await convert({ inPath: xp, outDir: join(W, 'o', String(++seq)), target: 'fods', profileDir: pdir });
    const cell = back.ok ? /<table:table-cell[^>]*table:formula[^>]*>/.exec(readFileSync(back.outPath, 'utf8'))?.[0] : undefined;
    res.recalc[`${pname} xlsx->fods`] = { ok: back.ok, cell };
  }
  console.log('recalc', pname, JSON.stringify(res.recalc[`${pname} fods->xlsx`]), JSON.stringify(res.recalc[`${pname} xlsx->fods`]));
}
mkdirSync(join(SPIKE, 'results'), { recursive: true });
writeFileSync(join(SPIKE, 'results', `profile-settings-${process.platform}.json`), JSON.stringify(res, null, 1));
