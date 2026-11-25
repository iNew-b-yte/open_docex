// Item 4: real LibreOffice export and import time for generated documents of about 10, 100 and
// 300 pages, with LibreOffice concurrency 1 and 2, plus the flat-XML size against the S-15 cap
// (`maxFlatXmlBytes` = 64 x `maxFileBytes`). Uses the real `CodecService` over the real
// compiled `CodecPool` (a worker thread), the production path. Nothing else may run meanwhile.
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodecPool } from '../backend/dist/codec/codec-pool.js';
import { CodecService, FLAT_XML_FACTOR } from '../backend/dist/codec/codec-service.js';
import { FodtMapper } from '../backend/dist/codec/fodt-mapper.js';
import { locateLibreOffice } from '../backend/dist/codec/libreoffice-locate.js';
import { createRunner } from '../backend/dist/codec/libreoffice-runner.js';
import { noopLogger } from '../backend/dist/log/logger.js';
import { buildModel, pagesOf } from './lib/docgen.mjs';
import { quantile } from './lib/stats.mjs';

const MAX_FILE_BYTES = 50 * 2 ** 20; // the default `limits.maxFileBytes`

const median = (a) => quantile(Float64Array.from(a).sort(), 0.5);
const r1 = (x) => Math.round(x * 10) / 10;

export async function loBench(P) {
  const root = await mkdtemp(path.join(tmpdir(), 'odx-bench-lo-'));
  const soffice = await locateLibreOffice();
  const runner = createRunner();
  const mapper = new FodtMapper();
  const limits = { soffice, timeoutMs: 600_000, maxFlatXmlBytes: FLAT_XML_FACTOR * MAX_FILE_BYTES, maxFileBytes: MAX_FILE_BYTES };
  const progress = P.progress ?? (() => undefined);
  const result = { maxFileBytes: MAX_FILE_BYTES, maxFlatXmlBytes: limits.maxFlatXmlBytes, documents: [], timing: [] };
  const mkCodec = (maxConcurrent) =>
    new CodecService({
      pool: new CodecPool({ size: 1, entry: new URL('../backend/dist/codec/codec-thread-entry.js', import.meta.url), logger: noopLogger }),
      tmpDir: path.join(root, `tmp-c${maxConcurrent}`),
      libreoffice: { maxConcurrent, timeoutMs: 600_000 },
      maxFileBytes: MAX_FILE_BYTES,
      logger: noopLogger,
    });

  // 1. Generate documents of the target page counts (calibrated against LibreOffice's page count).
  const codec1 = mkCodec(1);
  let paraPerPage = 4.5;
  const docs = [];
  for (const target of P.pages) {
    let n = Math.round(target * paraPerPage);
    let model, bytes, pages;
    for (let attempt = 0; attempt < 3; attempt++) {
      model = buildModel(n);
      bytes = await codec1.export({ kind: 'text', format: 'docx', model, assetDir: root });
      const calPath = path.join(root, `cal-${target}.docx`);
      await writeFile(calPath, bytes);
      pages = await pagesOf(soffice, calPath, root);
      console.log('[lo] calibrate: target', target, 'paragraphs', n, '-> pages', pages);
      if (pages === null || Math.abs(pages - target) / target <= 0.1) break;
      paraPerPage = n / pages;
      n = Math.round(target * paraPerPage);
    }
    // Flat XML sizes: the mapper's export, and LibreOffice's docx -> fodt (what import reads).
    const exportFlat = path.join(root, `doc-${target}.fodt`);
    await mapper.export({ kind: 'text', format: 'docx', model, flatXmlPath: exportFlat, assetDir: root, limits, lo: {} });
    const docxPath = path.join(root, `doc-${target}.docx`);
    await writeFile(docxPath, bytes);
    const outDir = path.join(root, `flat-${target}`);
    const profileDir = path.join(root, 'profile-flat');
    const importFlatPath = await runner.convert({ soffice, inPath: docxPath, outDir, target: 'fodt', profileDir, timeoutMs: 600_000 });
    const exportFlatBytes = (await stat(exportFlat)).size;
    const importFlatBytes = (await stat(importFlatPath)).size;
    docs.push({ target, model, bytes });
    result.documents.push({
      targetPages: target,
      actualPages: pages,
      paragraphs: n,
      docxBytes: bytes.byteLength,
      exportFlatXmlBytes: exportFlatBytes,
      importFlatXmlBytes: importFlatBytes,
      importFlatToDocxRatio: r1(importFlatBytes / bytes.byteLength),
      exportFlatToDocxRatio: r1(exportFlatBytes / bytes.byteLength),
      importFlatPctOfCap: Math.round((importFlatBytes / limits.maxFlatXmlBytes) * 100000) / 1000,
      capMultipleNeededAtThisRatio: r1(importFlatBytes / bytes.byteLength),
    });
  }
  await codec1.close();
  progress(result);

  // 2. Timing, sequential (one job at a time) and 4 jobs submitted at once, per concurrency.
  for (const conc of P.loConcurrency) {
    const codec = mkCodec(conc);
    await codec.export({ kind: 'text', format: 'docx', model: docs[0].model, assetDir: root }); // warm-up: locates soffice, creates profiles, first start
    await codec.import({ bytes: docs[0].bytes, format: 'docx', assetDir: root });
    for (const d of docs) {
      const exp = [];
      const imp = [];
      for (let i = 0; i < P.loRepeats; i++) {
        let t = performance.now();
        await codec.export({ kind: 'text', format: 'docx', model: d.model, assetDir: root });
        exp.push(performance.now() - t);
        t = performance.now();
        await codec.import({ bytes: d.bytes, format: 'docx', assetDir: root });
        imp.push(performance.now() - t);
      }
      const batch = 4;
      let t = performance.now();
      const each = [];
      await Promise.all(Array.from({ length: batch }, async () => {
        const s = performance.now();
        await codec.export({ kind: 'text', format: 'docx', model: d.model, assetDir: root });
        each.push(performance.now() - s);
      }));
      const batchExportWall = performance.now() - t;
      t = performance.now();
      await Promise.all(Array.from({ length: batch }, () => codec.import({ bytes: d.bytes, format: 'docx', assetDir: root })));
      const batchImportWall = performance.now() - t;
      const row = {
        libreofficeConcurrency: conc,
        targetPages: d.target,
        repeats: P.loRepeats,
        exportMsMedian: Math.round(median(exp)),
        exportMsMin: Math.round(Math.min(...exp)),
        exportMsMax: Math.round(Math.max(...exp)),
        importMsMedian: Math.round(median(imp)),
        importMsMin: Math.round(Math.min(...imp)),
        importMsMax: Math.round(Math.max(...imp)),
        batchOf4: {
          exportWallMs: Math.round(batchExportWall),
          exportSlowestJobMs: Math.round(Math.max(...each)),
          importWallMs: Math.round(batchImportWall),
        },
      };
      result.timing.push(row);
      console.log('[lo]', JSON.stringify(row));
      progress(result);
    }
    await codec.close();
  }
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }).catch(() => undefined);
  return result;
}
