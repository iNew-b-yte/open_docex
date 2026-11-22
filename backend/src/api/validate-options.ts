/**
 * Validation and defaults for `EngineOptions` and `WorkerConfig` (LLD Part 2 §2.4, HLD §12).
 *
 * - {@link validateEngineOptions} runs in main, synchronously, inside `createEngine`.
 * - {@link resolveWorkerConfig} runs in the Core at boot.
 *
 * Both throw `CONFIG_INVALID` on the first failure. The catalogue remediation tells the
 * adopter to fix the option named in `message`, so every message starts with the field path.
 * Unknown keys are ignored.
 *
 * @module
 */
import { accessSync, constants as fsConstants } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpenDocexError } from '@open-docex/shared/errors';
import { engineError } from '../errors/engine-error.js';
import { LOG_LEVELS, noopLogger, type Logger, type LogLevel } from '../log/logger.js';
import type {
  EngineOptions,
  PageSettings,
  ResolvedEngineOptions,
  ResolvedSupervisorOptions,
  ResolvedWorkerConfig,
} from './options.js';

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

/** Points per millimetre (1 pt = 1/72 in). */
const PT_PER_MM = 72 / 25.4;

/** `EngineOptions` defaults (LLD Part 2 §2.2, HLD §12). */
export const ENGINE_DEFAULTS: Readonly<{
  mode: 'worker';
  httpPath: string;
  supervisor: ResolvedSupervisorOptions;
  highWaterMarkBytes: number;
  ws: ResolvedEngineOptions['ws'];
  logLevel: LogLevel;
}> = Object.freeze({
  mode: 'worker' as const,
  httpPath: '/open-docex',
  supervisor: Object.freeze({
    heartbeatIntervalMs: 5_000,
    heartbeatTimeoutMs: 15_000,
    backoffMs: Object.freeze<readonly number[]>([1_000, 2_000, 4_000, 8_000, 16_000]),
    maxRestarts: 5,
    restartWindowMs: 600_000,
    bootTimeoutMs: 60_000,
    shutdownTimeoutMs: 10_000,
  }),
  highWaterMarkBytes: 8 * MIB,
  ws: Object.freeze({ maxPayloadBytes: 16 * MIB, pingIntervalMs: 30_000, helloTimeoutMs: 30_000 }),
  logLevel: 'info',
});

/** `WorkerConfig` defaults (LLD Part 2 §2.3, HLD §12, PO-26). `dataDir` is relative to `cwd`. */
export const WORKER_DEFAULTS: Readonly<{
  dataDirName: string;
  queue: ResolvedWorkerConfig['queue'];
  journal: ResolvedWorkerConfig['journal'];
  snapshot: ResolvedWorkerConfig['snapshot'];
  flush: ResolvedWorkerConfig['flush'];
  recovery: ResolvedWorkerConfig['recovery'];
  libreoffice: { readonly maxConcurrent: number; readonly timeoutMs: number };
  codecThreads: number;
  loadChunk: ResolvedWorkerConfig['load']['chunk'];
  maxFileBytes: number;
  blankPage: PageSettings;
}> = Object.freeze({
  dataDirName: 'open-docex-data',
  queue: Object.freeze({ type: 'memory' as const, perDocument: 1_000, global: 50_000 }),
  journal: Object.freeze({ fsync: 'interval' as const, fsyncIntervalMs: 1_000 }),
  snapshot: Object.freeze({ everyOps: 500 }),
  flush: Object.freeze({ quietMs: 30_000, maxIntervalMs: 300_000 }),
  recovery: Object.freeze({
    retryDelaysMs: Object.freeze<readonly [number, number, number]>([60_000, 300_000, 900_000]),
  }),
  libreoffice: Object.freeze({ maxConcurrent: 2, timeoutMs: 120_000 }),
  codecThreads: 1,
  loadChunk: Object.freeze({ textBlocks: 200, sheetRows: 500, maxBytes: 256 * KIB }),
  maxFileBytes: 50 * MIB,
  /** A4 portrait (210 × 297 mm) with 2.54 cm (72 pt) margins (PO-26, R-20). */
  blankPage: Object.freeze({
    size: Object.freeze({ width: 210 * PT_PER_MM, height: 297 * PT_PER_MM }),
    orientation: 'portrait' as const,
    margins: Object.freeze({ top: 72, right: 72, bottom: 72, left: 72 }),
  }),
});

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function invalid(field: string, rule: string): OpenDocexError {
  return engineError('CONFIG_INVALID', { message: `${field}: ${rule}` });
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `v` as an object, `{}` when absent; throws when present and not an object. */
function section(v: unknown, field: string): Obj {
  if (v === undefined) return {};
  if (!isObj(v)) throw invalid(field, 'must be an object');
  return v;
}

/** An integer ≥ `min` (and ≤ `max`), or `fallback` when absent. */
function int(v: unknown, field: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) {
    throw invalid(field, max === Number.MAX_SAFE_INTEGER ? `must be an integer ≥ ${min}` : `must be an integer from ${min} to ${max}`);
  }
  return v;
}

function oneOf<T extends string>(v: unknown, field: string, fallback: T, allowed: readonly T[]): T {
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw invalid(field, `must be one of ${allowed.map((a) => `'${a}'`).join(', ')}`);
  }
  return v as T;
}

function optionalFn(v: unknown, field: string): void {
  if (v !== undefined && typeof v !== 'function') throw invalid(field, 'must be a function');
}

// ---------------------------------------------------------------------------
// EngineOptions
// ---------------------------------------------------------------------------

/** Resolves `workerConfigModule` to an absolute path and checks it is readable. */
function workerModulePath(v: unknown): string {
  const field = 'workerConfigModule';
  let path: string;
  if (v instanceof URL || (typeof v === 'string' && v.startsWith('file:'))) {
    const url = v instanceof URL ? v : URL.canParse(v) ? new URL(v) : null;
    if (url === null || url.protocol !== 'file:') throw invalid(field, 'must be an absolute path or a file: URL');
    try {
      path = fileURLToPath(url);
    } catch (cause) {
      throw engineError('CONFIG_INVALID', { message: `${field}: must be an absolute path or a file: URL`, cause });
    }
  } else if (typeof v === 'string' && v.length > 0 && isAbsolute(v)) {
    path = v;
  } else {
    throw invalid(field, 'is required: an absolute path or a file: URL');
  }
  try {
    accessSync(path, fsConstants.R_OK);
  } catch (cause) {
    throw engineError('CONFIG_INVALID', { message: `${field}: the file is not readable`, cause });
  }
  return path;
}

function httpPath(v: unknown): string {
  if (v === undefined) return ENGINE_DEFAULTS.httpPath;
  if (typeof v !== 'string' || !v.startsWith('/') || v.includes('?') || v.includes('#')) {
    throw invalid('http.path', "must start with '/' and contain no '?' or '#'");
  }
  return v;
}

function logger(v: unknown): Logger {
  if (v === undefined) return noopLogger;
  if (!isObj(v)) throw invalid('logger', 'must be an object');
  for (const level of LOG_LEVELS) {
    if (typeof v[level] !== 'function') throw invalid(`logger.${level}`, 'must be a function');
  }
  return v as unknown as Logger;
}

function supervisor(v: unknown): ResolvedSupervisorOptions {
  const s = section(v, 'supervisor');
  const d = ENGINE_DEFAULTS.supervisor;
  const heartbeatIntervalMs = int(s['heartbeatIntervalMs'], 'supervisor.heartbeatIntervalMs', d.heartbeatIntervalMs, 1);
  const heartbeatTimeoutMs = int(s['heartbeatTimeoutMs'], 'supervisor.heartbeatTimeoutMs', d.heartbeatTimeoutMs, 1);
  if (heartbeatTimeoutMs <= heartbeatIntervalMs) {
    throw invalid('supervisor.heartbeatTimeoutMs', 'must be greater than supervisor.heartbeatIntervalMs');
  }
  let backoffMs = d.backoffMs;
  const rawBackoff = s['backoffMs'];
  if (rawBackoff !== undefined) {
    if (!Array.isArray(rawBackoff) || rawBackoff.length === 0) {
      throw invalid('supervisor.backoffMs', 'must be a non-empty list of integers ≥ 0');
    }
    backoffMs = Object.freeze(rawBackoff.map((x: unknown, i) => int(x, `supervisor.backoffMs[${i}]`, 0, 0)));
  }
  return Object.freeze({
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    backoffMs,
    maxRestarts: int(s['maxRestarts'], 'supervisor.maxRestarts', d.maxRestarts, 1),
    restartWindowMs: int(s['restartWindowMs'], 'supervisor.restartWindowMs', d.restartWindowMs, 1),
    bootTimeoutMs: int(s['bootTimeoutMs'], 'supervisor.bootTimeoutMs', d.bootTimeoutMs, 1),
    shutdownTimeoutMs: int(s['shutdownTimeoutMs'], 'supervisor.shutdownTimeoutMs', d.shutdownTimeoutMs, 1),
  });
}

/**
 * Checks `EngineOptions` and fills in the defaults (LLD Part 2 §2.4). Runs in main,
 * synchronously, inside `createEngine`.
 *
 * @throws OpenDocexError `CONFIG_INVALID` at the first failure; `message` names the field.
 */
export function validateEngineOptions(o: EngineOptions): ResolvedEngineOptions {
  const raw: unknown = o;
  if (!isObj(raw)) throw invalid('options', 'must be an object');
  const mode = oneOf(raw['mode'], 'mode', ENGINE_DEFAULTS.mode, ['worker', 'main']);
  const workerConfigModule = workerModulePath(raw['workerConfigModule']);
  const http = section(raw['http'], 'http');
  const path = httpPath(http['path']);
  if (typeof raw['authorize'] !== 'function') throw invalid('authorize', 'is required and must be a function');
  optionalFn(raw['canSubmit'], 'canSubmit');
  const log = logger(raw['logger']);
  const sup = supervisor(raw['supervisor']);
  const send = section(raw['send'], 'send');
  const highWaterMarkBytes = int(send['highWaterMarkBytes'], 'send.highWaterMarkBytes', ENGINE_DEFAULTS.highWaterMarkBytes, 64 * KIB);
  const ws = section(raw['ws'], 'ws');
  const wsd = ENGINE_DEFAULTS.ws;
  const resolvedWs = Object.freeze({
    maxPayloadBytes: int(ws['maxPayloadBytes'], 'ws.maxPayloadBytes', wsd.maxPayloadBytes, 64 * KIB, GIB),
    pingIntervalMs: int(ws['pingIntervalMs'], 'ws.pingIntervalMs', wsd.pingIntervalMs, 1),
    helloTimeoutMs: int(ws['helloTimeoutMs'], 'ws.helloTimeoutMs', wsd.helloTimeoutMs, 1),
  });
  const logLevel = oneOf(raw['logLevel'], 'logLevel', ENGINE_DEFAULTS.logLevel, LOG_LEVELS);

  const server = http['server'] as ResolvedEngineOptions['http']['server'];
  const canSubmit = raw['canSubmit'] as EngineOptions['canSubmit'];
  return Object.freeze({
    mode,
    workerConfigModule,
    http: Object.freeze(server === undefined ? { path } : { server, path }),
    authorize: raw['authorize'] as EngineOptions['authorize'],
    ...(canSubmit === undefined ? {} : { canSubmit }),
    supervisor: sup,
    send: Object.freeze({ highWaterMarkBytes }),
    ws: resolvedWs,
    logger: log,
    logLevel,
  });
}

// ---------------------------------------------------------------------------
// WorkerConfig
// ---------------------------------------------------------------------------

/** Page bounds, in pt, matching the `doc` attribute validators in `@open-docex/shared/text`. */
const PAGE_SIZE_MIN = 36;
const PAGE_SIZE_MAX = 4000;
const MARGIN_MAX = 1000;
const MIN_BODY = 36;

function finiteIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

function pageSettings(v: unknown): PageSettings {
  const field = 'blankDocument.page';
  if (v === undefined) return WORKER_DEFAULTS.blankPage;
  if (!isObj(v)) throw invalid(field, 'must be an object');
  const size = v['size'];
  if (!isObj(size) || !finiteIn(size['width'], PAGE_SIZE_MIN, PAGE_SIZE_MAX) || !finiteIn(size['height'], PAGE_SIZE_MIN, PAGE_SIZE_MAX)) {
    throw invalid(`${field}.size`, `width and height must be numbers from ${PAGE_SIZE_MIN} to ${PAGE_SIZE_MAX} pt`);
  }
  const orientation = v['orientation'];
  if (orientation !== 'portrait' && orientation !== 'landscape') {
    throw invalid(`${field}.orientation`, "must be 'portrait' or 'landscape'");
  }
  const m = v['margins'];
  if (
    !isObj(m) ||
    !finiteIn(m['top'], 0, MARGIN_MAX) ||
    !finiteIn(m['right'], 0, MARGIN_MAX) ||
    !finiteIn(m['bottom'], 0, MARGIN_MAX) ||
    !finiteIn(m['left'], 0, MARGIN_MAX)
  ) {
    throw invalid(`${field}.margins`, `top, right, bottom and left must be numbers from 0 to ${MARGIN_MAX} pt`);
  }
  const page: PageSettings = {
    size: { width: size['width'], height: size['height'] },
    orientation,
    margins: { top: m['top'], right: m['right'], bottom: m['bottom'], left: m['left'] },
  };
  if (
    page.margins.left + page.margins.right > page.size.width - MIN_BODY ||
    page.margins.top + page.margins.bottom > page.size.height - MIN_BODY
  ) {
    throw invalid(`${field}.margins`, `must leave at least ${MIN_BODY} pt of body width and height`);
  }
  return page;
}

function storage(v: unknown): ResolvedWorkerConfig['storage'] {
  if (v === undefined) return undefined;
  if (!isObj(v)) throw invalid('storage', 'must be an object');
  for (const m of ['read', 'write', 'stat', 'create'] as const) {
    if (typeof v[m] !== 'function') throw invalid(`storage.${m}`, 'must be a function');
  }
  return v as unknown as ResolvedWorkerConfig['storage'];
}

function queue(v: unknown): ResolvedWorkerConfig['queue'] {
  const d = WORKER_DEFAULTS.queue;
  if (v === undefined) return d;
  if (!isObj(v)) throw invalid('queue', 'must be an object');
  const type = v['type'];
  if (type === 'redis' || type === 'kafka') {
    throw invalid('queue.type', `'${type}' is not available in this version; use 'memory'`);
  }
  if (type !== 'memory') throw invalid('queue.type', "must be 'memory'");
  const perDocument = int(v['perDocument'], 'queue.perDocument', d.perDocument, 1);
  const global = int(v['global'], 'queue.global', d.global, 1);
  if (perDocument > global) throw invalid('queue.perDocument', 'must not exceed queue.global');
  return Object.freeze({ type, perDocument, global });
}

function retryDelays(v: unknown): readonly [number, number, number] {
  if (v === undefined) return WORKER_DEFAULTS.recovery.retryDelaysMs;
  if (!Array.isArray(v) || v.length !== 3) throw invalid('recovery.retryDelaysMs', 'must be exactly 3 integers ≥ 0');
  const [a, b, c] = v.map((x: unknown, i) => int(x, `recovery.retryDelaysMs[${i}]`, 0, 0)) as [number, number, number];
  return Object.freeze<readonly [number, number, number]>([a, b, c]);
}

/**
 * Checks the worker config module's default export and fills in the defaults (LLD Part 2
 * §2.4). Runs in the Core at boot.
 *
 * @param raw the module's default export, unchecked.
 * @param cwd resolves a relative `dataDir`; defaults to `process.cwd()`.
 * @throws OpenDocexError `CONFIG_INVALID` at the first failure; `message` names the field.
 */
export function resolveWorkerConfig(raw: unknown, cwd: string = process.cwd()): ResolvedWorkerConfig {
  if (!isObj(raw)) throw invalid('worker config', 'the module must default-export defineWorkerConfig({...})');
  const store = storage(raw['storage']);

  const rawDataDir = raw['dataDir'];
  if (rawDataDir !== undefined && (typeof rawDataDir !== 'string' || rawDataDir.length === 0)) {
    throw invalid('dataDir', 'must be a non-empty string');
  }
  const dataDir = resolvePath(cwd, rawDataDir ?? WORKER_DEFAULTS.dataDirName);

  const q = queue(raw['queue']);

  const journal = section(raw['journal'], 'journal');
  const jd = WORKER_DEFAULTS.journal;
  const resolvedJournal = Object.freeze({
    fsync: oneOf(journal['fsync'], 'journal.fsync', jd.fsync, ['interval', 'always']),
    fsyncIntervalMs: int(journal['fsyncIntervalMs'], 'journal.fsyncIntervalMs', jd.fsyncIntervalMs, 10),
  });

  const snapshot = section(raw['snapshot'], 'snapshot');
  const everyOps = int(snapshot['everyOps'], 'snapshot.everyOps', WORKER_DEFAULTS.snapshot.everyOps, 1);

  const flush = section(raw['flush'], 'flush');
  const quietMs = int(flush['quietMs'], 'flush.quietMs', WORKER_DEFAULTS.flush.quietMs, 1000);
  const maxIntervalMs = int(flush['maxIntervalMs'], 'flush.maxIntervalMs', WORKER_DEFAULTS.flush.maxIntervalMs, 1000);
  if (quietMs > maxIntervalMs) throw invalid('flush.quietMs', 'must not exceed flush.maxIntervalMs');

  const recovery = section(raw['recovery'], 'recovery');
  const retryDelaysMs = retryDelays(recovery['retryDelaysMs']);

  const lo = section(raw['libreoffice'], 'libreoffice');
  const loPath = lo['path'];
  if (loPath !== undefined && (typeof loPath !== 'string' || loPath.length === 0)) {
    throw invalid('libreoffice.path', 'must be a non-empty string');
  }
  const lod = WORKER_DEFAULTS.libreoffice;
  const maxConcurrent = int(lo['maxConcurrent'], 'libreoffice.maxConcurrent', lod.maxConcurrent, 1);
  const timeoutMs = int(lo['timeoutMs'], 'libreoffice.timeoutMs', lod.timeoutMs, 1000);

  const codecThreads = int(raw['codecThreads'], 'codecThreads', WORKER_DEFAULTS.codecThreads, 1);

  const chunk = section(section(raw['load'], 'load')['chunk'], 'load.chunk');
  const cd = WORKER_DEFAULTS.loadChunk;
  const resolvedChunk = Object.freeze({
    textBlocks: int(chunk['textBlocks'], 'load.chunk.textBlocks', cd.textBlocks, 1),
    sheetRows: int(chunk['sheetRows'], 'load.chunk.sheetRows', cd.sheetRows, 1),
    maxBytes: int(chunk['maxBytes'], 'load.chunk.maxBytes', cd.maxBytes, 16 * KIB),
  });

  const limits = section(raw['limits'], 'limits');
  const maxFileBytes = int(limits['maxFileBytes'], 'limits.maxFileBytes', WORKER_DEFAULTS.maxFileBytes, 1);

  const page = pageSettings(section(raw['blankDocument'], 'blankDocument')['page']);

  return Object.freeze({
    ...(store === undefined ? {} : { storage: store }),
    dataDir,
    queue: q,
    journal: resolvedJournal,
    snapshot: Object.freeze({ everyOps }),
    flush: Object.freeze({ quietMs, maxIntervalMs }),
    recovery: Object.freeze({ retryDelaysMs }),
    libreoffice: Object.freeze(loPath === undefined ? { maxConcurrent, timeoutMs } : { path: loPath, maxConcurrent, timeoutMs }),
    codecThreads,
    load: Object.freeze({ chunk: resolvedChunk }),
    limits: Object.freeze({ maxFileBytes }),
    blankDocument: Object.freeze({ page }),
  });
}
