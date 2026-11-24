// Real-LibreOffice tests of the FodtMapper (V1-14b). Run with OPEN_DOCEX_LO_TESTS=1 (CI sets it).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { FileFormat } from '@open-docex/shared/protocol';
import type { CodecJob, CodecPoolLike } from '../../src/codec/codec-pool.js';
import { CodecService } from '../../src/codec/codec-service.js';
import { handleJob } from '../../src/codec/codec-thread.js';
import { FodtMapper } from '../../src/codec/fodt-mapper.js';
import { createRunner } from '../../src/codec/libreoffice-runner.js';
import { noopLogger } from '../../src/log/logger.js';

const fixtures = join(import.meta.dirname, '..', 'fixtures', 'text');
const root = mkdtempSync(join(tmpdir(), 'docex-fodt-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

class InProcessPool implements CodecPoolLike {
  readonly runner = createRunner();
  readonly mapper = new FodtMapper();
  run<R>(job: CodecJob): Promise<R> {
    return handleJob(job, { mapper: this.mapper, runner: this.runner }) as Promise<R>;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

const service = new CodecService({
  pool: new InProcessPool(),
  tmpDir: mkdtempSync(join(root, 'svc-')),
  libreoffice: { maxConcurrent: 2, timeoutMs: 120_000 },
  maxFileBytes: 50 * 1024 * 1024,
  logger: noopLogger,
});

const read = (n: string): Uint8Array => new Uint8Array(readFileSync(join(fixtures, n)));

async function importFile(name: string, format: FileFormat, assetDir = join(root, `assets-${name}`)) {
  return service.import({ bytes: read(name), format, assetDir });
}

describe.skipIf(process.env['OPEN_DOCEX_LO_TESTS'] !== '1')('FodtMapper with real LibreOffice', () => {
  for (const [name, format] of [
    ['features.docx', 'docx'],
    ['features.odt', 'odt'],
    ['features-word.docx', 'docx'],
  ] as const) {
    it(`round-trips ${name}: import, export, re-import give the same model`, async () => {
      const assetDir = join(root, `assets-rt-${name}`);
      const first = await importFile(name, format, assetDir);
      const bytes = await service.export({ kind: 'text', format, model: first.snapshot, assetDir });
      if (process.env['DUMP_DIR'] !== undefined) (await import('node:fs')).writeFileSync(join(process.env['DUMP_DIR'], `rt-${name}`), bytes);
      if (process.env['DUMP_DIR'] !== undefined) await new FodtMapper().export({ kind: 'text', format, model: first.snapshot, flatXmlPath: join(process.env['DUMP_DIR'], `rt-${name}.fodt`), assetDir, limits: {} as never, lo: {} as never });
      const second = await service.import({ bytes, format, assetDir });
      expect(second.snapshot).toEqual(first.snapshot);
      expect(second.findings).toEqual([]);
    }, 240_000);
  }
});
