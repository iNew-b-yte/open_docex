// Spike S2: EMF / WMF / TIFF / SVG -> PNG (PO-22).
//   node spikes/S2/images.mjs   -> spikes/S2/results/images-<platform>.json + summary on stdout
// a) standalone: each image file --LO (Draw import)--> .png
// b) in documents: legacy-images.{fodt,odt,docx} --LO--> .fodt; which formats LibreOffice keeps
// c) pipeline shape: bytes taken out of the imported .fodt, written under a generated name, --LO--> .png
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { convert, resetProfile } from './lib/soffice.mjs';
import { FIXTURES, SPIKE, WORK } from './lib/paths.mjs';
import { inspect, sniff } from './lib/inspect.mjs';
import { readZip } from './lib/zip.mjs';

const W = join(WORK, 'images');
const profileDir = join(W, 'profile');
resetProfile(profileDir);
let seq = 0;
const png = (buf) => (sniff(buf) === 'image/png' ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length } : { notPng: sniff(buf) });
async function toPng(inPath) {
  const r = await convert({ inPath, outDir: join(W, 'o', String(++seq)), target: 'png', profileDir });
  return { ok: r.ok, ms: Math.round(r.ms), ...(r.ok ? png(readFileSync(r.outPath)) : { stderr: r.stderr, stdout: r.stdout }), filter: /using filter : (\S+)/.exec(r.stdout)?.[1] };
}
await toPng(join(FIXTURES, 'images', 'probe.svg')); // warm the profile
const res = { meta: { platform: process.platform, date: new Date().toISOString() }, standalone: {}, inDocument: {}, pipeline: {} };

for (const ext of ['emf', 'wmf', 'tif', 'svg']) {
  res.standalone[ext] = await toPng(join(FIXTURES, 'images', `probe.${ext}`));
  console.log('standalone', ext, JSON.stringify(res.standalone[ext]));
}

const EXT = { 'image/x-emf': 'emf', 'image/x-wmf': 'wmf', 'image/tiff': 'tif', 'image/svg+xml': 'svg', 'image/png': 'png' };
for (const file of ['legacy-images.fodt', 'legacy-images.odt', 'legacy-images.docx']) {
  const r = await convert({ inPath: join(FIXTURES, file), outDir: join(W, 'o', String(++seq)), target: 'fodt', profileDir });
  const m = inspect(readFileSync(r.outPath, 'utf8'));
  const frames = m.blocks.flatMap((b) => b.frames);
  res.inDocument[file] = frames.map((f) => ({ title: f.title, size: `${f.width?.toFixed(1)}x${f.height?.toFixed(1)}mm`, images: f.images.map((i) => `${i.declared ?? '-'} / sniffed ${i.sniffed}${i.href ? ` href=${i.href}` : ''}`) }));
  console.log('in-document', file, JSON.stringify(res.inDocument[file]));
  res.pipeline[file] = [];
  for (const f of frames) {
    const first = f.images[0];
    if (!first?.bytes) continue;
    const ext = EXT[first.sniffed] ?? 'bin';
    const p = join(W, 'pipe', String(++seq), `img.${ext}`);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, first.bytes);
    res.pipeline[file].push({ title: f.title, from: first.sniffed, ...(ext === 'png' ? { skipped: 'already png' } : await toPng(p)) });
  }
  console.log('pipeline', file, JSON.stringify(res.pipeline[file]));
}
// d) SVG-wrapper route: a generated SVG (frame size in mm) that holds the image as a data: URI.
//    Draw sizes its page to the SVG, so the PNG is the image only; PixelWidth/PixelHeight set the raster size.
res.wrapper = {};
const MIME = { emf: 'image/x-emf', wmf: 'image/x-wmf', tif: 'image/tiff' };
for (const ext of Object.keys(MIME)) {
  const p = join(W, 'wrap', `img-${ext}.svg`);
  mkdirSync(join(p, '..'), { recursive: true });
  const b64 = readFileSync(join(FIXTURES, 'images', `probe.${ext}`)).toString('base64');
  writeFileSync(p, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="32mm" height="16mm" viewBox="0 0 320 160"><image x="0" y="0" width="320" height="160" preserveAspectRatio="none" xlink:href="data:${MIME[ext]};base64,${b64}"/></svg>`);
  for (const [label, target] of [['default', 'png'], ['PixelWidth 378 x 189 (32x16mm at 300 dpi)', 'png:draw_png_Export:{"PixelWidth":{"type":"long","value":"378"},"PixelHeight":{"type":"long","value":"189"}}']]) {
    const r = await convert({ inPath: p, outDir: join(W, 'o', String(++seq)), target, profileDir });
    res.wrapper[`${ext} ${label}`] = { ok: r.ok, ms: Math.round(r.ms), ...(r.ok ? png(readFileSync(r.outPath)) : {}) };
  }
}
console.log('wrapper', JSON.stringify(res.wrapper));
// e) The PNG fallbacks LibreOffice itself adds next to EMF/WMF in flat ODF.
res.fallbackPng = {};
for (const file of ['legacy-images.fodt', 'legacy-images.docx']) {
  const r = await convert({ inPath: join(FIXTURES, file), outDir: join(W, 'o', String(++seq)), target: 'fodt', profileDir });
  const frames = inspect(readFileSync(r.outPath, 'utf8')).blocks.flatMap((b) => b.frames);
  res.fallbackPng[file] = frames.map((f) => `${f.title}: ${f.images.map((i) => (i.sniffed === 'image/png' ? `png ${i.bytes.readUInt32BE(16)}x${i.bytes.readUInt32BE(20)}` : i.sniffed)).join(' + ')}`);
}
console.log('fallback', JSON.stringify(res.fallbackPng));
// What LibreOffice writes into .docx / .odt for these images.
res.packaged = {
  'legacy-images.docx': [...readZip(readFileSync(join(FIXTURES, 'legacy-images.docx'))).keys()].filter((k) => k.startsWith('word/media/')),
  'legacy-images.odt': [...readZip(readFileSync(join(FIXTURES, 'legacy-images.odt'))).keys()].filter((k) => k.startsWith('Pictures/')),
};
console.log('packaged', JSON.stringify(res.packaged));
mkdirSync(join(SPIKE, 'results'), { recursive: true });
writeFileSync(join(SPIKE, 'results', `images-${process.platform}.json`), JSON.stringify(res, null, 1));
