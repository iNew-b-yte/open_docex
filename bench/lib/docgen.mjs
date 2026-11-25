// Generates text documents of a given size and counts their pages with real LibreOffice.
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { textSchema } from '@open-docex/shared/text';
import { resolveWorkerConfig } from '../../backend/dist/api/validate-options.js';

const run = promisify(execFile);

const SENTENCES = [
  'The quick brown fox jumps over the lazy dog while the committee reviews the quarterly figures.',
  'Collaborative editing needs every participant to see the same document within a fraction of a second.',
  'A paragraph of ordinary prose has long words, short words, numbers like 3.14159 and the odd comma, semicolon; or colon: for variety.',
  'Pagination is computed from measured block heights, so line wrapping and fonts decide where each page ends.',
];

/** A paragraph of about 600 characters, with one bold run so that the export has marks to write. */
export function paragraph(i) {
  let text = '';
  for (let k = 0; text.length < 600; k++) text += `${SENTENCES[(i + k) % SENTENCES.length]} `;
  text = text.trim();
  const cut = 40 + (i % 50);
  return textSchema.node('paragraph', null, [
    textSchema.text(text.slice(0, cut)),
    textSchema.text(text.slice(cut, cut + 25), [textSchema.marks.bold.create()]),
    textSchema.text(text.slice(cut + 25)),
  ]);
}

/** A model (doc JSON) of `n` paragraphs, a heading before every tenth. */
export function buildModel(n) {
  const page = resolveWorkerConfig({}).blankDocument.page;
  const blocks = [];
  for (let i = 0; i < n; i++) {
    if (i % 10 === 0) blocks.push(textSchema.node('heading', { level: 1 + ((i / 10) % 3) }, [textSchema.text(`Section ${i / 10 + 1}`)]));
    blocks.push(paragraph(i));
  }
  const { size, orientation, margins } = page;
  return textSchema.node('doc', { size, orientation, margins }, [textSchema.node('body', null, blocks)]).toJSON();
}

/**
 * The page count of a docx: LibreOffice renders it to PDF (own throw-away profile) and the
 * `/Type /Page` objects are counted. LibreOffice does not write a page count into docProps.
 */
export async function pagesOf(sofficePath, docxPath, root) {
  const base = path.basename(docxPath, '.docx');
  const outDir = path.join(root, `pdf-${base}`);
  const profile = pathToFileURL(path.join(root, 'profile-pdf')).href;
  try {
    await run(sofficePath, [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', 'pdf', '--outdir', outDir, docxPath], { timeout: 600_000 });
    const pdf = await readFile(path.join(outDir, `${base}.pdf`));
    return (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length || null;
  } catch {
    return null;
  }
}

/**
 * A model whose real LibreOffice page count is within `tolerance` (default 3%) of `target`.
 * `exportDocx(model)` returns docx bytes. Pages grow almost linearly with the paragraph count, so
 * each attempt rescales the paragraph count by target / measured pages. Throws when it cannot converge.
 */
export async function modelForPages({ target, exportDocx, sofficePath, root, tolerance = 0.03, perPage = 5.6, maxAttempts = 8 }) {
  let n = Math.round(target * perPage);
  const tried = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const model = buildModel(n);
    const bytes = await exportDocx(model);
    const file = path.join(root, `cal-${target}.docx`);
    await writeFile(file, bytes);
    const pages = await pagesOf(sofficePath, file, root);
    tried.push(`${n}->${pages}`);
    if (pages === null) throw new Error(`cannot count pages of the generated document (${tried.join(', ')})`);
    if (Math.abs(pages - target) / target <= tolerance) return { model, bytes, pages, paragraphs: n };
    const next = Math.round(n * (target / pages));
    n = next === n ? n + (pages < target ? 1 : -1) : next;
  }
  throw new Error(`page count did not converge to ${target} +-${tolerance * 100}% (${tried.join(', ')})`);
}