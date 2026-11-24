/**
 * LibreOffice runner (LLD Part 2 §14.2). Runs inside a codec thread. Arguments are always an
 * array, a shell is never used and every file name is generated (HLD §14).
 *
 * @module
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { engineError } from '../errors/engine-error.js';

/** Formats LibreOffice converts to or from. */
export type LoTarget = 'fodt' | 'fods' | 'docx' | 'odt' | 'xlsx' | 'ods';

/** Export filter names (help.libreoffice.org, convertfilters). */
export const FILTER: Readonly<Record<LoTarget, string>> = {
  fodt: 'OpenDocument Text Flat XML',
  fods: 'OpenDocument Spreadsheet Flat XML',
  docx: 'MS Word 2007 XML',
  xlsx: 'Calc MS Excel 2007 XML',
  odt: 'writer8',
  ods: 'calc8',
};

/** Arguments of one conversion. */
export interface ConvertInput {
  soffice: string;
  inPath: string;
  outDir: string;
  target: LoTarget;
  profileDir: string;
  timeoutMs: number;
}

/** Arguments of one image to PNG conversion (§0.5 S-11). */
export interface ImageToPngInput {
  soffice: string;
  /** A generated SVG wrapper, or an SVG image itself (plain `--convert-to png`). */
  inPath: string;
  outDir: string;
  profileDir: string;
  timeoutMs: number;
  /** With both set, `draw_png_Export` is used with these pixel sizes. Without, plain `png`. */
  pixelWidth?: number;
  pixelHeight?: number;
}

/** The runner contract (§14.2). Both methods resolve to the output file path. */
export interface LibreOfficeRunner {
  convert(i: ConvertInput): Promise<string>;
  convertImageToPng(i: ImageToPngInput): Promise<string>;
}

/** Spawn function, injectable so tests can substitute a stub binary. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** Options of {@link createRunner}. */
export interface RunnerOptions {
  spawnFn?: SpawnFn;
  platform?: NodeJS.Platform;
  /** Receives the last 4 KiB of stderr of a failed run. Never sent to clients. */
  onStderr?: (tail: string) => void;
}

/** Kills `child` and its descendants (soffice → oosplash → soffice.bin). Resolves when done. */
export function killTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve();
  if (platform === 'win32') {
    return new Promise((resolve) => {
      const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      k.on('error', () => resolve());
      k.on('exit', () => resolve());
    });
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  return Promise.resolve();
}

/** The wrapper SVG for an EMF/WMF/TIFF image (S-11). `dataUri` must be a base64 data URI. */
export function buildImageSvgWrapper(dataUri: string, widthPx: number, heightPx: number): string {
  if (!/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]*$/i.test(dataUri)) {
    throw engineError('CONVERSION_FAILED', { message: 'Invalid image data URI' });
  }
  const w = String(Math.max(1, Math.round(widthPx)));
  const h = String(Math.max(1, Math.round(heightPx)));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}px" height="${h}px" viewBox="0 0 ${w} ${h}">` +
    `<image x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" xlink:href="${dataUri}"/></svg>`
  );
}

/** Creates the runner. */
export function createRunner(o: RunnerOptions = {}): LibreOfficeRunner {
  const spawnFn: SpawnFn = o.spawnFn ?? spawn;
  const platform = o.platform ?? process.platform;

  async function run(
    soffice: string,
    convertTo: string,
    ext: string,
    i: { inPath: string; outDir: string; profileDir: string; timeoutMs: number },
  ): Promise<string> {
    const args = [
      `-env:UserInstallation=${pathToFileURL(i.profileDir).href}`,
      '--headless',
      '--invisible',
      '--norestore',
      '--nologo',
      '--nodefault',
      '--nolockcheck',
      '--convert-to',
      convertTo,
      '--outdir',
      i.outDir,
      i.inPath,
    ];
    const env = { ...process.env };
    if (platform !== 'win32') env['HOME'] = i.profileDir;

    const code = await new Promise<'timeout' | number | null>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawnFn(soffice, args, {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: platform !== 'win32',
          env,
        });
      } catch (e) {
        reject(engineError('CONFIG_LIBREOFFICE_NOT_FOUND', { message: 'Cannot start LibreOffice', cause: e }));
        return;
      }
      let stderr = '';
      child.stdout?.resume();
      child.stderr?.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString('utf8')).slice(-4096);
      });
      let timedOut = false;
      let settled = false;
      const finish = (v: 'timeout' | number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (v !== 0 && stderr !== '') o.onStderr?.(stderr);
        resolve(v);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        void killTree(child, platform).then(() => {
          // 'exit' normally follows; do not hang if it does not.
          setTimeout(() => finish('timeout'), 2000).unref();
        });
      }, i.timeoutMs);
      child.on('error', (e: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          e.code === 'ENOENT'
            ? engineError('CONFIG_LIBREOFFICE_NOT_FOUND', { message: 'LibreOffice binary not found', cause: e })
            : engineError('CONVERSION_FAILED', { message: 'Cannot start LibreOffice', cause: e }),
        );
      });
      child.on('exit', (c) => finish(timedOut ? 'timeout' : c));
    });

    if (code === 'timeout') throw engineError('CONVERSION_TIMEOUT', { message: 'LibreOffice timed out and was killed' });
    // The exit code is not trusted; success is the output file (§14.2).
    const out = join(i.outDir, basename(i.inPath, extname(i.inPath)) + '.' + ext);
    try {
      if ((await stat(out)).size > 0) return out;
    } catch {
      /* fall through */
    }
    throw engineError('CONVERSION_FAILED', { message: 'LibreOffice produced no output' });
  }

  return {
    convert: (i) => run(i.soffice, `${i.target}:${FILTER[i.target]}`, i.target, i),
    convertImageToPng: (i) => {
      const hasSize = i.pixelWidth !== undefined && i.pixelHeight !== undefined;
      const to = hasSize
        ? `png:draw_png_Export:${JSON.stringify({
            PixelWidth: { type: 'long', value: String(Math.round(i.pixelWidth as number)) },
            PixelHeight: { type: 'long', value: String(Math.round(i.pixelHeight as number)) },
          })}`
        : 'png';
      return run(i.soffice, to, 'png', i);
    },
  };
}
