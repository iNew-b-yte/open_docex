// The compiled thread entry (S-43) running in a real worker thread through CodecPool.
// Needs `npm run build` (or `tsc -b`) first; skipped when the compiled files are not there.
// It runs in a child `node` process: Vitest's own `--conditions` flag would send a worker to
// shared's TypeScript sources instead of its compiled files, which is not how production runs.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fixtures, root } from './lo-setup.js';

const dist = join(import.meta.dirname, '..', '..', 'dist');
const run = process.env['OPEN_DOCEX_LO_TESTS'] === '1' && existsSync(join(dist, 'codec', 'codec-thread-entry.js'));

describe.skipIf(!run)('codec thread entry with a real worker thread', () => {
  it('imports and exports through the pool', () => {
    const url = (...parts: string[]): string => JSON.stringify(pathToFileURL(join(dist, ...parts)).href);
    const work = mkdtempSync(join(root, 'pool-'));
    const script = `
import { readFileSync } from 'node:fs';
import { CodecPool } from ${url('codec', 'codec-pool.js')};
import { CodecService } from ${url('codec', 'codec-service.js')};
import { noopLogger } from ${url('log', 'logger.js')};
const pool = new CodecPool({ size: 1, entry: new URL(${url('codec', 'codec-thread-entry.js')}), logger: noopLogger });
const service = new CodecService({ pool, tmpDir: ${JSON.stringify(join(work, 'tmp'))}, libreoffice: { maxConcurrent: 1, timeoutMs: 120000 }, maxFileBytes: 50 * 1024 * 1024, logger: noopLogger });
const assetDir = ${JSON.stringify(join(work, 'assets'))};
try {
  const bytes = new Uint8Array(readFileSync(${JSON.stringify(join(fixtures, 'features.odt'))}));
  const first = await service.import({ bytes, format: 'odt', assetDir });
  const out = await service.export({ kind: 'text', format: 'odt', model: first.snapshot, assetDir });
  const second = await service.import({ bytes: out, format: 'odt', assetDir });
  console.log(JSON.stringify({ same: JSON.stringify(first.snapshot) === JSON.stringify(second.snapshot), kind: first.kind, findings: first.findings.length }));
} finally {
  await service.close();
}
`;
    const file = join(work, 'run.mjs');
    writeFileSync(file, script);
    const env = { ...process.env };
    delete env['NODE_OPTIONS'];
    const r = spawnSync(process.execPath, [file], { env, encoding: 'utf8', timeout: 200_000, cwd: work });
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}')).toEqual({ same: true, kind: 'text', findings: 0 });
  }, 240_000);
});
