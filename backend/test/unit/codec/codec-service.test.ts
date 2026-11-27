import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CodecService, FLAT_XML_FACTOR } from '../../../src/codec/codec-service.js';
import type { CodecJob, CodecPoolLike } from '../../../src/codec/codec-pool.js';
import { engineError } from '../../../src/errors/engine-error.js';
import { noopLogger } from '../../../src/log/logger.js';
import { buildZip } from './zip-builder.js';
import { waitFor } from '../../wait-for.js';

const root = mkdtempSync(join(tmpdir(), 'docex-svc-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const tmp = () => join(root, `t${String(n++)}`);
const docx = () => buildZip([{ name: 'word/document.xml', data: '<d/>' }]);
const okImport = { kind: 'text' as const, snapshot: { s: 1 }, findings: [], assetIds: ['a'] };

class FakePool implements CodecPoolLike {
  jobs: CodecJob[] = [];
  running = 0;
  peak = 0;
  closed = false;
  handler: (j: CodecJob) => Promise<unknown> = () => Promise.resolve(okImport);
  async run<R>(job: CodecJob): Promise<R> {
    this.jobs.push(job);
    this.running += 1;
    this.peak = Math.max(this.peak, this.running);
    try {
      return (await this.handler(job)) as R;
    } finally {
      this.running -= 1;
    }
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

function make(pool: FakePool, over: { maxConcurrent?: number; validate?: () => void; locate?: () => Promise<string> } = {}) {
  return new CodecService({
    pool,
    tmpDir: tmp(),
    libreoffice: { maxConcurrent: over.maxConcurrent ?? 2, timeoutMs: 1000 },
    maxFileBytes: 1_000_000,
    logger: noopLogger,
    locate: over.locate ?? (() => Promise.resolve('/fake/soffice')),
    validateSnapshot: over.validate ?? (() => undefined),
  });
}

describe('CodecService', () => {
  it('imports, passes limits (flat XML cap 64x) and removes the work folder', async () => {
    const pool = new FakePool();
    const svc = make(pool);
    const r = await svc.import({ bytes: docx(), format: 'docx', assetDir: '/assets' });
    expect(r).toEqual({ ...okImport, findings: [] });
    const job = pool.jobs[0];
    expect(job?.limits).toMatchObject({ soffice: '/fake/soffice', timeoutMs: 1000, maxFlatXmlBytes: FLAT_XML_FACTOR * 1_000_000 });
    expect(job?.op === 'import' && job.inPath.endsWith('in.docx')).toBe(true);
    expect(job?.workDir && existsSync(job.workDir)).toBe(false);
    expect(job?.profileDir.endsWith(join('lo', 'slot-0'))).toBe(true);
  });
  it('adds a macros finding from the zip guard', async () => {
    const bytes = buildZip([
      { name: 'word/document.xml', data: '<d/>' },
      { name: 'word/vbaProject.bin', data: 'x' },
    ]);
    const r = await make(new FakePool()).import({ bytes, format: 'docx', assetDir: '/a' });
    expect(r.findings).toEqual([{ feature: 'other', count: 1, detail: 'macros' }]);
  });
  it('rejects bad files before any job runs', async () => {
    const pool = new FakePool();
    const svc = make(pool);
    await expect(svc.import({ bytes: new Uint8Array(10), format: 'docx', assetDir: '/a' })).rejects.toMatchObject({
      code: 'CONVERSION_FAILED',
    });
    expect(pool.jobs).toHaveLength(0);
  });
  it('an invalid snapshot is CONVERSION_FAILED', async () => {
    const svc = make(new FakePool(), {
      validate: () => {
        throw new Error('schema');
      },
    });
    await expect(svc.import({ bytes: docx(), format: 'docx', assetDir: '/a' })).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
  });
  it('caps concurrency at maxConcurrent and gives distinct slots', async () => {
    const pool = new FakePool();
    const release: Array<() => void> = [];
    pool.handler = () => new Promise((res) => release.push(() => res(okImport)));
    const svc = make(pool, { maxConcurrent: 2 });
    const all = Array.from({ length: 5 }, () => svc.import({ bytes: docx(), format: 'docx', assetDir: '/a' }));
    // Wait for the condition, not a fixed 100 ms: on a slow runner the jobs had not started yet (CI run
    // 45977431369). The cap itself is asserted at the end, through `pool.peak`.
    await waitFor(() => expect(pool.running).toBe(2));
    expect(new Set(pool.jobs.map((j) => j.profileDir)).size).toBe(2);
    while (release.length > 0 || pool.jobs.length < 5) {
      release.shift()?.();
      await new Promise((r) => setTimeout(r, 20));
    }
    await Promise.all(all);
    expect(pool.peak).toBe(2);
  });
  it('resets the profile slot after a timeout, and releases the permit', async () => {
    const pool = new FakePool();
    let first = true;
    pool.handler = () => {
      if (first) {
        first = false;
        return Promise.reject(engineError('CONVERSION_TIMEOUT'));
      }
      return Promise.resolve(okImport);
    };
    const svc = make(pool, { maxConcurrent: 1 });
    await expect(svc.import({ bytes: docx(), format: 'docx', assetDir: '/a' })).rejects.toMatchObject({ code: 'CONVERSION_TIMEOUT' });
    const slot = pool.jobs[0]?.profileDir ?? '';
    expect(existsSync(join(slot, 'user', 'registrymodifications.xcu'))).toBe(true);
    await expect(svc.import({ bytes: docx(), format: 'docx', assetDir: '/a' })).resolves.toBeDefined();
  });
  it('exports bytes', async () => {
    const pool = new FakePool();
    pool.handler = () => Promise.resolve({ bytes: new Uint8Array([1, 2, 3]).buffer });
    const out = await make(pool).export({ kind: 'text', format: 'docx', model: { a: 1 }, assetDir: '/a' });
    expect([...out]).toEqual([1, 2, 3]);
    const j = pool.jobs[0];
    expect(j?.op === 'export' && j.modelJson).toBe('{"a":1}');
  });
  it('probe: missing LibreOffice is CONFIG_LIBREOFFICE_NOT_FOUND', async () => {
    const svc = make(new FakePool(), { locate: () => Promise.reject(engineError('CONFIG_LIBREOFFICE_NOT_FOUND')) });
    await expect(svc.probe()).rejects.toMatchObject({ code: 'CONFIG_LIBREOFFICE_NOT_FOUND' });
  });
  it('probe: a binary that does not run headless is CONFIG_LIBREOFFICE_NOT_FOUND', async () => {
    const pool = new FakePool();
    pool.handler = () => Promise.reject(engineError('CONVERSION_FAILED'));
    await expect(make(pool).probe()).rejects.toMatchObject({ code: 'CONFIG_LIBREOFFICE_NOT_FOUND' });
  });
  it('boot creates every profile slot; close closes the pool and refuses new work', async () => {
    const pool = new FakePool();
    const dirRoot = tmp();
    const svc = new CodecService({
      pool, tmpDir: dirRoot, libreoffice: { maxConcurrent: 3, timeoutMs: 1 }, maxFileBytes: 10, logger: noopLogger,
      locate: () => Promise.resolve('/x'),
    });
    await svc.probe();
    expect(readdirSync(join(dirRoot, 'lo')).sort()).toEqual(['slot-0', 'slot-1', 'slot-2']);
    await svc.close();
    expect(pool.closed).toBe(true);
    await expect(svc.import({ bytes: docx(), format: 'docx', assetDir: '/a' })).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
  });
});
