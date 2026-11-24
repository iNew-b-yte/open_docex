// Shared setup for the real-LibreOffice FodtMapper tests: a CodecService wired to the real mapper.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import type { FileFormat } from '@open-docex/shared/protocol';
import type { CodecJob, CodecPoolLike } from '../../src/codec/codec-pool.js';
import { CodecService } from '../../src/codec/codec-service.js';
import { handleJob } from '../../src/codec/codec-thread.js';
import { FodtMapper } from '../../src/codec/fodt-mapper.js';
import { createRunner } from '../../src/codec/libreoffice-runner.js';
import { noopLogger } from '../../src/log/logger.js';

export const fixtures = join(import.meta.dirname, '..', 'fixtures', 'text');
export const root = mkdtempSync(join(tmpdir(), 'docex-fodt-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Runs jobs in this thread with the real mapper (the thread entry does the same in a worker). */
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

export const service = new CodecService({
  pool: new InProcessPool(),
  tmpDir: mkdtempSync(join(root, 'svc-')),
  libreoffice: { maxConcurrent: 2, timeoutMs: 120_000 },
  maxFileBytes: 50 * 1024 * 1024,
  logger: noopLogger,
});

export const read = (n: string): Uint8Array => new Uint8Array(readFileSync(join(fixtures, n)));

export function importFile(name: string, format: FileFormat, assetDir = join(root, `assets-${name}`)) {
  return service.import({ bytes: read(name), format, assetDir });
}

export const lo = process.env['OPEN_DOCEX_LO_TESTS'] === '1';
