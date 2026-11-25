// Real-LibreOffice codec tests. Run with OPEN_DOCEX_LO_TESTS=1 (CI sets it).
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CodecJob, CodecPoolLike } from '../../src/codec/codec-pool.js';
import { CodecService } from '../../src/codec/codec-service.js';
import { handleJob, type CodecMapper } from '../../src/codec/codec-thread.js';
import { locateLibreOffice } from '../../src/codec/libreoffice-locate.js';
import { buildImageSvgWrapper, createRunner } from '../../src/codec/libreoffice-runner.js';
import { parseXmlFile } from '../../src/codec/xml-reader.js';
import { noopLogger } from '../../src/log/logger.js';

const fixtures = join(import.meta.dirname, '..', 'fixtures', 'text');
const root = mkdtempSync(join(tmpdir(), 'docex-lo-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A mapper that only counts paragraphs with the hardened reader; the real one is V1-14b. */
const countingMapper: CodecMapper = {
  async import(i) {
    let paragraphs = 0;
    let images = 0;
    await parseXmlFile(
      i.flatXmlPath,
      { maxBytes: i.limits.maxFlatXmlBytes },
      { open: (name) => void (name === 'text:p' && (paragraphs += 1)), binary: () => void (images += 1) },
    );
    return { kind: 'text', snapshot: { paragraphs, images }, findings: [], assetIds: [] };
  },
  export(i) {
    copyFileSync(join(fixtures, 'features.fodt'), i.flatXmlPath);
    return Promise.resolve();
  },
};

class InProcessPool implements CodecPoolLike {
  running = 0;
  peak = 0;
  readonly runner = createRunner();
  async run<R>(job: CodecJob): Promise<R> {
    this.running += 1;
    this.peak = Math.max(this.peak, this.running);
    try {
      return (await handleJob(job, { mapper: countingMapper, runner: this.runner })) as R;
    } finally {
      this.running -= 1;
    }
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function service(pool: CodecPoolLike, o: { maxConcurrent?: number; timeoutMs?: number; path?: string; tmpDir?: string } = {}) {
  return new CodecService({
    pool,
    tmpDir: o.tmpDir ?? mkdtempSync(join(root, 's-')),
    libreoffice: {
      maxConcurrent: o.maxConcurrent ?? 2,
      timeoutMs: o.timeoutMs ?? 120_000,
      ...(o.path !== undefined ? { path: o.path } : {}),
    },
    maxFileBytes: 50 * 1024 * 1024,
    logger: noopLogger,
    validateSnapshot: () => undefined,
  });
}

const read = (n: string): Uint8Array => new Uint8Array(readFileSync(join(fixtures, n)));

describe.skipIf(process.env['OPEN_DOCEX_LO_TESTS'] !== '1')('codec with real LibreOffice', () => {
  it('locates the binary and the boot probe passes', async () => {
    expect(existsSync(await locateLibreOffice())).toBe(true);
    await service(new InProcessPool()).probe();
  }, 120_000);

  it('a missing LibreOffice is CONFIG_LIBREOFFICE_NOT_FOUND', async () => {
    await expect(service(new InProcessPool(), { path: join(root, 'nope') }).probe()).rejects.toMatchObject({
      code: 'CONFIG_LIBREOFFICE_NOT_FOUND',
    });
  });

  it('imports docx and odt to flat XML and maps them', async () => {
    const svc = service(new InProcessPool());
    for (const [name, format] of [['features.docx', 'docx'], ['features.odt', 'odt']] as const) {
      const r = await svc.import({ bytes: read(name), format, assetDir: join(root, 'assets') });
      const s = r.snapshot as { paragraphs: number; images: number };
      expect(s.paragraphs).toBeGreaterThan(10);
      expect(s.images).toBeGreaterThan(0);
    }
  }, 120_000);

  it('exports flat XML to docx and odt packages', async () => {
    const svc = service(new InProcessPool());
    for (const format of ['docx', 'odt'] as const) {
      const bytes = await svc.export({ kind: 'text', format, model: {}, assetDir: join(root, 'assets') });
      expect(bytes.length).toBeGreaterThan(1000);
      expect(String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0)).toBe('PK');
    }
  }, 120_000);

  it('runs concurrent imports on separate profile slots within the cap, and reuses slots', async () => {
    const pool = new InProcessPool();
    const svc = service(pool, { maxConcurrent: 2 });
    const all = await Promise.all(
      Array.from({ length: 4 }, () => svc.import({ bytes: read('features.docx'), format: 'docx', assetDir: root })),
    );
    expect(all).toHaveLength(4);
    expect(pool.peak).toBe(2);
  }, 180_000);

  it('kills LibreOffice on timeout, resets the slot, and the next job works', async () => {
    const pool = new InProcessPool();
    const tmpDir = mkdtempSync(join(root, 'to-'));
    // 1 ms: no soffice start can finish in it, on a slow or a fast machine alike. A fixed
    // 400 ms let a fast CI runner (Node 22 job of run 45551669411) finish the import in time.
    const slow = service(pool, { maxConcurrent: 1, timeoutMs: 1, tmpDir });
    await expect(slow.import({ bytes: read('features.docx'), format: 'docx', assetDir: root })).rejects.toMatchObject({
      code: 'CONVERSION_TIMEOUT',
    });
    // The same tmp dir and slot, with a sane timeout.
    const ok = service(pool, { maxConcurrent: 1, tmpDir });
    await expect(ok.import({ bytes: read('features.docx'), format: 'docx', assetDir: root })).resolves.toBeDefined();
  }, 180_000);

  it('converts an EMF to a PNG of the requested size through the SVG wrapper (S-11)', async () => {
    const soffice = await locateLibreOffice();
    const dir = mkdtempSync(join(root, 'img-'));
    const emf = readFileSync(join(fixtures, 'images', 'probe.emf')).toString('base64');
    const svg = join(dir, 'wrap.svg');
    writeFileSync(svg, buildImageSvgWrapper(`data:image/x-emf;base64,${emf}`, 378, 189));
    const profileDir = join(dir, 'profile');
    const { resetProfile } = await import('../../src/codec/lo-profile.js');
    await resetProfile(profileDir);
    const png = await createRunner().convertImageToPng({
      soffice, inPath: svg, outDir: join(dir, 'out'), profileDir, timeoutMs: 120_000, pixelWidth: 378, pixelHeight: 189,
    });
    const b = readFileSync(png);
    expect(b.subarray(1, 4).toString()).toBe('PNG');
    expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([378, 189]);
  }, 120_000);
});
