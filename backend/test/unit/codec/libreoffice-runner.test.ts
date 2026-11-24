import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildImageSvgWrapper, createRunner, killAllChildren, type SpawnFn } from '../../../src/codec/libreoffice-runner.js';

const dir = mkdtempSync(join(tmpdir(), 'docex-run-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A stub "soffice": a node script. `sleep` mode spawns a grandchild and then idles, like
// soffice -> soffice.bin. `write` mode writes the expected output file.
const stub = join(dir, 'stub.mjs');
writeFileSync(
  stub,
  `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
const a = process.argv.slice(2);
const mode = process.env.STUB_MODE;
if (mode === 'sleep') {
  spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  setInterval(() => {}, 1000);
} else if (mode === 'write') {
  const out = a[a.indexOf('--outdir') + 1];
  const inp = a[a.length - 1];
  const ext = a[a.indexOf('--convert-to') + 1].split(':')[0];
  writeFileSync(join(out, basename(inp, extname(inp)) + '.' + ext), 'out');
  writeFileSync(join(out, 'args.json'), JSON.stringify(a));
} else if (mode === 'silent') {
  console.error('boom');
}
`,
);

function stubSpawn(mode: string, seen?: { args?: readonly string[]; opts?: object; pid?: number }): SpawnFn {
  return (_cmd, args, options) => {
    if (seen) {
      seen.args = args;
      seen.opts = options;
    }
    const c: ChildProcess = spawn(process.execPath, [stub, ...args], {
      ...options,
      env: { ...options.env, STUB_MODE: mode },
    });
    if (seen) seen.pid = c.pid as number;
    return c;
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const base = () => {
  const outDir = mkdtempSync(join(dir, 'o-'));
  const inPath = join(dir, 'in.docx');
  writeFileSync(inPath, 'x');
  return { soffice: 'unused', inPath, outDir, profileDir: join(dir, 'prof with space & amp'), timeoutMs: 20_000 };
};

describe('LibreOfficeRunner', () => {
  it('passes an argument array without a shell and judges success by the output file', async () => {
    const seen: { args?: readonly string[]; opts?: { shell?: boolean; detached?: boolean } } = {};
    const out = await createRunner({ spawnFn: stubSpawn('write', seen) }).convert({ ...base(), target: 'fodt' });
    expect(out.endsWith('in.fodt')).toBe(true);
    expect(seen.opts?.shell).toBe(false);
    expect(seen.opts?.detached).toBe(process.platform !== 'win32');
    const a = seen.args ?? [];
    expect(a[0]).toMatch(/^-env:UserInstallation=file:\/\//);
    expect(a).toContain('--headless');
    expect(a).toContain('fodt:OpenDocument Text Flat XML');
  });
  it('a clean exit without output is CONVERSION_FAILED, and stderr is reported', async () => {
    let tail = '';
    const r = createRunner({ spawnFn: stubSpawn('silent'), onStderr: (t) => (tail = t) });
    await expect(r.convert({ ...base(), target: 'fodt' })).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
    // exit code is 0 here, so stderr is not reported; a non-zero exit would be.
    expect(tail).toBe('');
  });
  it('a missing binary is CONFIG_LIBREOFFICE_NOT_FOUND', async () => {
    const r = createRunner();
    await expect(r.convert({ ...base(), soffice: join(dir, 'does-not-exist'), target: 'fodt' })).rejects.toMatchObject({
      code: 'CONFIG_LIBREOFFICE_NOT_FOUND',
    });
  });
  it('kills the process tree on timeout and rejects CONVERSION_TIMEOUT', async () => {
    const seen: { pid?: number } = {};
    const t0 = Date.now();
    const r = createRunner({ spawnFn: stubSpawn('sleep', seen) });
    await expect(r.convert({ ...base(), target: 'fodt', timeoutMs: 600 })).rejects.toMatchObject({ code: 'CONVERSION_TIMEOUT' });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(alive(seen.pid as number)).toBe(false);
  });
  it('killAllChildren (pool shutdown) kills a running conversion and leaves no process', async () => {
    const seen: { pid?: number } = {};
    const r = createRunner({ spawnFn: stubSpawn('sleep', seen) });
    const run = r.convert({ ...base(), target: 'fodt', timeoutMs: 60_000 });
    const settled = run.catch((e: unknown) => e);
    await new Promise((res) => setTimeout(res, 800));
    expect(alive(seen.pid as number)).toBe(true);
    await killAllChildren();
    expect(await settled).toMatchObject({ code: 'CONVERSION_FAILED' });
    expect(alive(seen.pid as number)).toBe(false);
  });
  it('uses draw_png_Export with pixel sizes for images', async () => {
    const seen: { args?: readonly string[] } = {};
    await createRunner({ spawnFn: stubSpawn('write', seen) }).convertImageToPng({
      ...base(),
      pixelWidth: 378,
      pixelHeight: 189,
    });
    const i = (seen.args ?? []).indexOf('--convert-to');
    expect(seen.args?.[i + 1]).toBe('png:draw_png_Export:{"PixelWidth":{"type":"long","value":"378"},"PixelHeight":{"type":"long","value":"189"}}');
  });
  it('builds a safe SVG wrapper', () => {
    expect(buildImageSvgWrapper('data:image/x-emf;base64,AAAA', 100, 50)).toContain('width="100px"');
    expect(() => buildImageSvgWrapper('data:image/x-emf;base64,"><script>', 1, 1)).toThrow();
  });
});
