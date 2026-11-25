// Functional test of the document generator: the model has the stated paragraph count and, through
// real LibreOffice, the page count the benchmark assumes (about 5.6 paragraphs per page).
// Skipped when LibreOffice is not installed. Run: node --test bench/test/
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CodecPool } from '../../backend/dist/codec/codec-pool.js';
import { CodecService } from '../../backend/dist/codec/codec-service.js';
import { locateLibreOffice } from '../../backend/dist/codec/libreoffice-locate.js';
import { noopLogger } from '../../backend/dist/log/logger.js';
import { buildModel, pagesOf } from '../lib/docgen.mjs';

test('buildModel makes the stated number of paragraphs plus a heading per ten', () => {
  const model = buildModel(25);
  const body = model.content.find((c) => c.type === 'body');
  assert.equal(body.content.filter((b) => b.type === 'paragraph').length, 25);
  assert.equal(body.content.filter((b) => b.type === 'heading').length, 3);
  assert.ok(body.content[1].content.some((n) => n.marks?.some((m) => m.type === 'bold')));
});

test('a 56-paragraph model is 10 pages (+-1) in real LibreOffice', async (t) => {
  let soffice;
  try {
    soffice = await locateLibreOffice();
  } catch {
    return t.skip('LibreOffice is not installed');
  }
  const root = await mkdtemp(path.join(tmpdir(), 'odx-bench-test-'));
  const codec = new CodecService({
    pool: new CodecPool({ size: 1, entry: new URL('../../backend/dist/codec/codec-thread-entry.js', import.meta.url), logger: noopLogger }),
    tmpDir: path.join(root, 'tmp'),
    libreoffice: { maxConcurrent: 1, timeoutMs: 300_000 },
    maxFileBytes: 50 * 2 ** 20,
    logger: noopLogger,
  });
  try {
    const bytes = await codec.export({ kind: 'text', format: 'docx', model: buildModel(56), assetDir: root });
    const file = path.join(root, 'gen.docx');
    await writeFile(file, bytes);
    const pages = await pagesOf(soffice, file, root);
    assert.ok(pages !== null && Math.abs(pages - 10) <= 1, `pages: ${pages}`);
  } finally {
    await codec.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
