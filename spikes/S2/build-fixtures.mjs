// Spike S2: builds the text fixture corpus in backend/test/fixtures/text/.
//   node spikes/S2/build-fixtures.mjs
// Everything is generated from hand-written sources in fixtures/text/src (no third-party content).
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { convert, resetProfile } from './lib/soffice.mjs';
import { FIXTURES, SRC, WORK } from './lib/paths.mjs';
import { writeZip } from './lib/zip.mjs';

const IMG = join(FIXTURES, 'images');
mkdirSync(IMG, { recursive: true });
const profileDir = join(WORK, 'profile-build');
resetProfile(profileDir);

async function lo(inPath, outDir, target) {
  const r = await convert({ inPath, outDir, target, profileDir });
  if (!r.ok) throw new Error(`convert ${inPath} -> ${target} failed: ${r.stderr}`);
  console.log(`  ${relative(FIXTURES, r.outPath)}  ${Math.round(r.ms)} ms`);
  return r.outPath;
}

// 1. Images: one hand-written SVG, rendered by LibreOffice Draw into every format.
const svgPath = join(IMG, 'probe.svg');
copyFileSync(join(SRC, 'probe.svg'), svgPath);
console.log('images');
for (const t of ['png', 'jpg', 'gif', 'emf', 'wmf', 'tif']) await lo(svgPath, IMG, t);
const b64 = (ext) => readFileSync(join(IMG, `probe.${ext}`)).toString('base64');

// 2. Flat ODF fixtures from templates.
const fill = (tpl) => readFileSync(join(SRC, tpl), 'utf8').replace(/@@IMG:(png|jpg|gif|emf|wmf|tif|svg)@@/g, (_, e) => b64(e));
writeFileSync(join(FIXTURES, 'features.fodt'), fill('features.template.fodt'));
writeFileSync(join(FIXTURES, 'legacy-images.fodt'), fill('legacy-images.template.fodt'));

// 3. LibreOffice-written .odt and .docx.
console.log('documents');
for (const base of ['features', 'legacy-images'])
  for (const t of ['odt', 'docx']) await lo(join(FIXTURES, `${base}.fodt`), FIXTURES, t);

// 4. Hand-written WordprocessingML package (independent of LibreOffice's writer).
const wordSrc = join(SRC, 'word-features');
const parts = [];
const walk = (dir) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else parts.push([relative(wordSrc, p).replaceAll('\\', '/'), readFileSync(p)]);
  }
};
walk(wordSrc);
parts.sort((a, b) => (a[0] === '[Content_Types].xml' ? -1 : b[0] === '[Content_Types].xml' ? 1 : 0));
parts.push(['word/media/image1.png', readFileSync(join(IMG, 'probe.png'))]);
parts.push(['word/media/image2.jpeg', readFileSync(join(IMG, 'probe.jpg'))]);
parts.push(['word/media/image3.gif', readFileSync(join(IMG, 'probe.gif'))]);
writeFileSync(join(FIXTURES, 'features-word.docx'), writeZip(parts));
console.log('  features-word.docx (hand-written)');
