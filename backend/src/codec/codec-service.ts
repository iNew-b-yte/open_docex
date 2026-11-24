/**
 * CodecService (LLD Part 2 §14.1): zip guard, temp work folder, LibreOffice permit and profile
 * slot, pool job, then snapshot validation. Satisfies {@link CodecSeam}, plus `export`.
 *
 * @module
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OpenDocexError } from '@open-docex/shared/errors';
import type { DocKind, FileFormat, UnsupportedFinding } from '@open-docex/shared/protocol';
import { TextOtType } from '@open-docex/shared/text';
import { engineError } from '../errors/engine-error.js';
import type { CodecImportResult, CodecSeam } from '../core/seams.js';
import type { Logger } from '../log/logger.js';
import {
  ThreadCrashError,
  type CodecJob,
  type CodecLimits,
  type CodecPoolLike,
  type ExportJobResult,
  type ImportJobResult,
} from './codec-pool.js';
import { locateLibreOffice } from './libreoffice-locate.js';
import { resetProfile, slotDir } from './lo-profile.js';
import { zipGuard } from './zip-guard.js';

/** Flat XML cap multiple (§0.5 S-15). */
export const FLAT_XML_FACTOR = 64;

/** Options of {@link CodecService}. */
export interface CodecServiceOptions {
  pool: CodecPoolLike;
  /** Holds `lo/slot-<n>` and one work folder per job. */
  tmpDir: string;
  libreoffice: { path?: string; maxConcurrent: number; timeoutMs: number };
  maxFileBytes: number;
  logger: Logger;
  /** Validates the mapper's snapshot (step 6). Default: `TextOtType.deserializeSnapshot` for text. */
  validateSnapshot?: (kind: DocKind, snapshot: unknown) => void;
  /** Overrides binary lookup (tests). */
  locate?: (configured?: string) => Promise<string>;
}

function defaultValidate(kind: DocKind, snapshot: unknown): void {
  if (kind !== 'text') throw engineError('CONVERSION_FAILED', { message: 'Sheet documents are not supported yet' });
  TextOtType.deserializeSnapshot(snapshot);
}

/** A counting semaphore where each permit is a LibreOffice profile slot index. */
class SlotSemaphore {
  readonly #free: number[];
  readonly #waiters: Array<{ resolve(n: number): void; reject(e: unknown): void }> = [];
  #closed = false;

  constructor(n: number) {
    this.#free = Array.from({ length: n }, (_, i) => i);
  }

  acquire(): Promise<number> {
    if (this.#closed) return Promise.reject(engineError('CONVERSION_FAILED', { message: 'The codec is closed' }));
    const n = this.#free.shift();
    if (n !== undefined) return Promise.resolve(n);
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  release(n: number): void {
    const w = this.#waiters.shift();
    if (w !== undefined) w.resolve(n);
    else this.#free.push(n);
  }

  close(): void {
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w.reject(engineError('CONVERSION_FAILED', { message: 'The codec is closed' }));
  }
}

/** The codec. */
export class CodecService implements CodecSeam {
  readonly #o: CodecServiceOptions;
  readonly #sem: SlotSemaphore;
  #ready: Promise<string> | undefined;
  #closed = false;

  constructor(o: CodecServiceOptions) {
    if (!Number.isInteger(o.libreoffice.maxConcurrent) || o.libreoffice.maxConcurrent < 1) {
      throw new RangeError('libreoffice.maxConcurrent must be a positive integer');
    }
    this.#o = o;
    this.#sem = new SlotSemaphore(o.libreoffice.maxConcurrent);
  }

  /** Locates soffice and re-creates every profile slot, once (boot). */
  #ensureReady(): Promise<string> {
    this.#ready ??= (async () => {
      const soffice = await (this.#o.locate ?? locateLibreOffice)(this.#o.libreoffice.path);
      await mkdir(this.#o.tmpDir, { recursive: true, mode: 0o700 });
      for (let n = 0; n < this.#o.libreoffice.maxConcurrent; n += 1) await resetProfile(slotDir(this.#o.tmpDir, n));
      return soffice;
    })();
    // A failed attempt may be retried by the next call.
    this.#ready.catch(() => {
      this.#ready = undefined;
    });
    return this.#ready;
  }

  #limits(soffice: string): CodecLimits {
    return {
      soffice,
      timeoutMs: this.#o.libreoffice.timeoutMs,
      maxFlatXmlBytes: FLAT_XML_FACTOR * this.#o.maxFileBytes,
      maxFileBytes: this.#o.maxFileBytes,
    };
  }

  /** Steps 2 to 5 of the pipeline: work folder, permit, pool job, release and cleanup. */
  async #runJob<R>(make: (c: { workDir: string; profileDir: string; limits: CodecLimits }) => Promise<CodecJob>, transferOf?: () => ArrayBuffer[]): Promise<R> {
    const soffice = await this.#ensureReady();
    const workDir = join(this.#o.tmpDir, randomUUID());
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    let slot: number | undefined;
    try {
      slot = await this.#sem.acquire();
      const profileDir = slotDir(this.#o.tmpDir, slot);
      const job = await make({ workDir, profileDir, limits: this.#limits(soffice) });
      try {
        return await this.#o.pool.run<R>(job, transferOf?.() ?? []);
      } catch (e) {
        if (
          (e instanceof OpenDocexError && e.code === 'CONVERSION_TIMEOUT') ||
          (e instanceof OpenDocexError && e.cause instanceof ThreadCrashError)
        ) {
          // The profile may be corrupt or locked after a kill: re-create it (§14.3).
          await resetProfile(profileDir).catch((re: unknown) => {
            this.#o.logger.error(`profile slot reset failed: ${String(re)}`);
          });
        }
        throw e;
      }
    } finally {
      if (slot !== undefined) this.#sem.release(slot);
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Imports `bytes` (§14.1). */
  async import(i: { bytes: Uint8Array; format: FileFormat; assetDir: string }): Promise<CodecImportResult> {
    if (this.#closed) throw engineError('CONVERSION_FAILED', { message: 'The codec is closed' });
    const guard = await zipGuard(i.bytes, i.format, this.#o.maxFileBytes);
    const r = await this.#runJob<ImportJobResult>(async ({ workDir, profileDir, limits }) => {
      const inPath = join(workDir, `in.${i.format}`);
      await writeFile(inPath, i.bytes, { mode: 0o600 });
      return { op: 'import', format: i.format, inPath, workDir, profileDir, assetDir: i.assetDir, limits };
    });
    try {
      (this.#o.validateSnapshot ?? defaultValidate)(r.kind, r.snapshot);
    } catch (e) {
      if (e instanceof OpenDocexError && e.code === 'CONVERSION_FAILED') throw e;
      throw engineError('CONVERSION_FAILED', { message: 'The mapper produced an invalid snapshot', cause: e });
    }
    const findings: UnsupportedFinding[] = [...r.findings];
    if (guard.macros) findings.push({ feature: 'other', count: 1, detail: 'macros' });
    const out: CodecImportResult = { kind: r.kind, snapshot: r.snapshot, findings, assetIds: r.assetIds };
    if (r.conversions !== undefined) out.conversions = r.conversions;
    return out;
  }

  /** Exports a model to `format` (§14.1). */
  async export(i: { kind: DocKind; format: FileFormat; model: unknown; assetDir: string }): Promise<Uint8Array> {
    if (this.#closed) throw engineError('CONVERSION_FAILED', { message: 'The codec is closed' });
    const r = await this.#runJob<ExportJobResult>(({ workDir, profileDir, limits }) =>
      Promise.resolve({
        op: 'export',
        kind: i.kind,
        format: i.format,
        modelJson: JSON.stringify(i.model),
        workDir,
        profileDir,
        assetDir: i.assetDir,
        limits,
      }),
    );
    return new Uint8Array(r.bytes);
  }

  /** Boot step 5: proves LibreOffice works headless. Throws `CONFIG_LIBREOFFICE_NOT_FOUND`. */
  async probe(): Promise<void> {
    await this.#ensureReady();
    try {
      await this.#runJob<{ ok: true }>(({ workDir, profileDir, limits }) =>
        Promise.resolve({ op: 'probe', workDir, profileDir, limits }),
      );
    } catch (e) {
      if (e instanceof OpenDocexError && e.code === 'CONFIG_LIBREOFFICE_NOT_FOUND') throw e;
      throw engineError('CONFIG_LIBREOFFICE_NOT_FOUND', { message: 'LibreOffice did not run headless', cause: e });
    }
  }

  /** Rejects waiting jobs and closes the pool. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#sem.close();
    await this.#o.pool.close();
  }
}
