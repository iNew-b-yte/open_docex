/**
 * Codec thread (LLD Part 2 §14.1–§14.2). Runs one job at a time per message: converts through
 * LibreOffice and hands the flat XML to the mapper. The mapper (`FodtMapper`, V1-14b) is
 * injected, so this module does not depend on it; the thread entry calls
 * {@link startCodecThread} with the real mapper.
 *
 * @module
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import type { DocKind, FileFormat } from '@open-docex/shared/protocol';
import { OpenDocexError } from '@open-docex/shared/errors';
import { engineError } from '../errors/engine-error.js';
import type { Logger } from '../log/logger.js';
import type { CodecJob, CodecLimits, ExportJobResult, ImportJobResult, ThreadMessage } from './codec-pool.js';
import { createRunner, killAllChildren, type LibreOfficeRunner, type LoTarget } from './libreoffice-runner.js';

/** Lets the mapper convert images inside the job's permit and profile slot (S-11). */
export interface MapperLo {
  /** Converts an SVG (wrapper or plain) to PNG; returns the PNG path. */
  convertImageToPng(i: { inPath: string; pixelWidth?: number; pixelHeight?: number }): Promise<string>;
}

/** The mapper this thread calls; implemented by V1-14b. */
export interface CodecMapper {
  /** Reads `flatXmlPath` (already size-checked) and writes images into `assetDir`. */
  import(i: { format: FileFormat; flatXmlPath: string; assetDir: string; limits: CodecLimits; lo: MapperLo }): Promise<ImportJobResult>;
  /** Writes the flat XML for `model` to `flatXmlPath`. */
  export(i: { kind: DocKind; format: FileFormat; model: unknown; flatXmlPath: string; assetDir: string; limits: CodecLimits; lo: MapperLo }): Promise<void>;
}

/** What {@link handleJob} needs. */
export interface ThreadDeps {
  mapper?: CodecMapper;
  runner: LibreOfficeRunner;
}

const FLAT: Readonly<Record<FileFormat, LoTarget>> = { docx: 'fodt', odt: 'fodt', xlsx: 'fods', ods: 'fods' };
const FLAT_EXT: Readonly<Record<FileFormat, 'fodt' | 'fods'>> = FLAT as Record<FileFormat, 'fodt' | 'fods'>;

const PROBE_FODT =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">' +
  '<office:body><office:text><text:p>probe</text:p></office:text></office:body></office:document>';

/** Executes one job and returns its result. Throws `OpenDocexError`s. */
export async function handleJob(job: CodecJob, deps: ThreadDeps): Promise<unknown> {
  const { runner } = deps;
  const base = { soffice: job.limits.soffice, profileDir: job.profileDir, timeoutMs: job.limits.timeoutMs };
  const lo: MapperLo = {
    convertImageToPng: async (i) => {
      const outDir = join(job.workDir, 'img');
      await mkdir(outDir, { recursive: true });
      return runner.convertImageToPng({ ...base, ...i, outDir });
    },
  };

  if (job.op === 'probe') {
    const inPath = join(job.workDir, 'probe.fodt');
    await writeFile(inPath, PROBE_FODT);
    await runner.convert({ ...base, inPath, outDir: join(job.workDir, 'out'), target: 'odt' });
    return { ok: true };
  }

  const mapper = deps.mapper;
  if (mapper === undefined) throw engineError('CONVERSION_FAILED', { message: 'No document mapper is installed' });

  if (job.op === 'import') {
    const outDir = join(job.workDir, 'out');
    const flatXmlPath = await runner.convert({ ...base, inPath: job.inPath, outDir, target: FLAT[job.format] });
    if ((await stat(flatXmlPath)).size > job.limits.maxFlatXmlBytes) {
      throw engineError('DOCUMENT_TOO_LARGE', { message: 'Flat XML too large' });
    }
    return mapper.import({ format: job.format, flatXmlPath, assetDir: job.assetDir, limits: job.limits, lo });
  }

  // export
  const flatXmlPath = join(job.workDir, `doc.${FLAT_EXT[job.format]}`);
  await mapper.export({
    kind: job.kind,
    format: job.format,
    model: JSON.parse(job.modelJson) as unknown,
    flatXmlPath,
    assetDir: job.assetDir,
    limits: job.limits,
    lo,
  });
  const out = await runner.convert({ ...base, inPath: flatXmlPath, outDir: join(job.workDir, 'out'), target: job.format });
  const buf = await readFile(out);
  const bytes = new Uint8Array(buf).buffer; // an own copy, so transferring it is always safe
  return { bytes } satisfies ExportJobResult;
}

/**
 * The thread entry body. Call it from the compiled entry file with the real mapper. Jobs run
 * concurrently; the pool sends at most `maxConcurrent` of them to LibreOffice at a time.
 */
export function startCodecThread(mapper: CodecMapper): void {
  const port = parentPort;
  if (port === null) throw new Error('startCodecThread must run in a worker thread');
  const post = (m: ThreadMessage, transfer: ArrayBuffer[] = []): void => port.postMessage(m, transfer);
  const logger: Pick<Logger, 'warn'> = { warn: (message) => post({ log: 'warn', message }) };
  const runner = createRunner({ onStderr: (tail) => logger.warn(`soffice stderr: ${tail}`) });
  port.on('message', (msg: { id: number; job: CodecJob } | { close: true }) => {
    if ('close' in msg) {
      // Pool shutdown: kill every soffice tree, then tell the pool it may terminate this thread.
      void killAllChildren().finally(() => post({ closed: true }));
      return;
    }
    handleJob(msg.job, { mapper, runner }).then(
      (result) => post({ id: msg.id, ok: true, result }, result instanceof Object && 'bytes' in result && result.bytes instanceof ArrayBuffer ? [result.bytes] : []),
      (e: unknown) => {
        const err = e instanceof OpenDocexError ? e : engineError('CONVERSION_FAILED', { cause: e });
        post({ id: msg.id, ok: false, code: err.code, message: err.message });
      },
    );
  });
}
