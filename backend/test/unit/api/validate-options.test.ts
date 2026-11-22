import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OpenDocexError } from '@open-docex/shared/errors';
import { defineWorkerConfig, type EngineOptions, type WorkerConfig } from '../../../src/api/options.js';
import {
  ENGINE_DEFAULTS,
  WORKER_DEFAULTS,
  resolveWorkerConfig,
  validateEngineOptions,
} from '../../../src/api/validate-options.js';
import { noopLogger } from '../../../src/log/logger.js';

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

/** A readable file: this test file. */
const READABLE = fileURLToPath(import.meta.url);
const MISSING = resolve(READABLE, '..', 'does-not-exist.mjs');
const CWD = resolve(READABLE, '..');

const authorize: EngineOptions['authorize'] = () => null;

function opts(extra: Record<string, unknown> = {}): EngineOptions {
  return { workerConfigModule: READABLE, authorize, ...extra };
}

/** Runs `fn` and returns the thrown error, checking it is CONFIG_INVALID naming `field`. */
function expectConfigInvalid(fn: () => unknown, field: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(OpenDocexError);
  const e = thrown as OpenDocexError;
  expect(e.code).toBe('CONFIG_INVALID');
  expect(e.category).toBe('config');
  expect(e.message.startsWith(`${field}:`)).toBe(true);
}

describe('validateEngineOptions: defaults (HLD §12)', () => {
  it('fills every default', () => {
    const r = validateEngineOptions(opts());
    expect(r.mode).toBe('worker');
    expect(r.workerConfigModule).toBe(READABLE);
    expect(r.http).toEqual({ path: '/open-docex' });
    expect(r.supervisor).toEqual({
      heartbeatIntervalMs: 5_000,
      heartbeatTimeoutMs: 15_000,
      backoffMs: [1_000, 2_000, 4_000, 8_000, 16_000],
      maxRestarts: 5,
      restartWindowMs: 600_000,
      bootTimeoutMs: 60_000,
      shutdownTimeoutMs: 10_000,
    });
    expect(r.send.highWaterMarkBytes).toBe(8 * MIB);
    expect(r.ws).toEqual({ maxPayloadBytes: 16 * MIB, pingIntervalMs: 30_000, helloTimeoutMs: 30_000 });
    expect(r.logger).toBe(noopLogger);
    expect(r.logLevel).toBe('info');
    expect(r.authorize).toBe(authorize);
    expect('canSubmit' in r).toBe(false);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(ENGINE_DEFAULTS.supervisor.backoffMs)).toBe(true);
  });

  it('keeps supplied values', () => {
    const canSubmit = (): boolean => true;
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const server = {} as never;
    const r = validateEngineOptions(
      opts({
        mode: 'main',
        http: { server, path: '/x' },
        canSubmit,
        logger,
        logLevel: 'debug',
        supervisor: { heartbeatIntervalMs: 100, heartbeatTimeoutMs: 200, backoffMs: [0, 5] },
        send: { highWaterMarkBytes: 64 * KIB },
        ws: { maxPayloadBytes: GIB },
      }),
    );
    expect(r.mode).toBe('main');
    expect(r.http).toEqual({ server, path: '/x' });
    expect(r.canSubmit).toBe(canSubmit);
    expect(r.logger).toBe(logger);
    expect(r.logLevel).toBe('debug');
    expect(r.supervisor.backoffMs).toEqual([0, 5]);
    expect(r.supervisor.maxRestarts).toBe(5);
    expect(r.send.highWaterMarkBytes).toBe(64 * KIB);
    expect(r.ws.maxPayloadBytes).toBe(GIB);
  });

  it('accepts a file: URL, as a URL or a string, and resolves it to a path', () => {
    const url = pathToFileURL(READABLE);
    expect(validateEngineOptions(opts({ workerConfigModule: url })).workerConfigModule).toBe(READABLE);
    expect(validateEngineOptions(opts({ workerConfigModule: url.href })).workerConfigModule).toBe(READABLE);
  });

  it('copies the backoff list, so later changes to the input have no effect', () => {
    const backoffMs = [10, 20];
    const r = validateEngineOptions(opts({ supervisor: { backoffMs } }));
    backoffMs[0] = 99;
    expect(r.supervisor.backoffMs).toEqual([10, 20]);
  });
});

describe('validateEngineOptions: one case per rule (LLD Part 2 §2.4)', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['mode not worker/main', { mode: 'thread' }, 'mode'],
    ['workerConfigModule missing', { workerConfigModule: undefined }, 'workerConfigModule'],
    ['workerConfigModule relative', { workerConfigModule: 'config.mjs' }, 'workerConfigModule'],
    ['workerConfigModule not a string', { workerConfigModule: 42 }, 'workerConfigModule'],
    ['workerConfigModule http URL', { workerConfigModule: new URL('http://example.com/c.mjs') }, 'workerConfigModule'],
    ['workerConfigModule unreadable', { workerConfigModule: MISSING }, 'workerConfigModule'],
    ['workerConfigModule unreadable file URL', { workerConfigModule: pathToFileURL(MISSING) }, 'workerConfigModule'],
    ['http not an object', { http: '/x' }, 'http'],
    ['http.path without leading /', { http: { path: 'open-docex' } }, 'http.path'],
    ['http.path with ?', { http: { path: '/x?y' } }, 'http.path'],
    ['http.path with #', { http: { path: '/x#y' } }, 'http.path'],
    ['authorize missing', { authorize: undefined }, 'authorize'],
    ['authorize not a function', { authorize: {} }, 'authorize'],
    ['canSubmit not a function', { canSubmit: true }, 'canSubmit'],
    ['logger not an object', { logger: () => {} }, 'logger'],
    ['logger.warn missing', { logger: { debug() {}, info() {}, error() {} } }, 'logger.warn'],
    ['logLevel unknown', { logLevel: 'trace' }, 'logLevel'],
    ['heartbeatIntervalMs 0', { supervisor: { heartbeatIntervalMs: 0 } }, 'supervisor.heartbeatIntervalMs'],
    [
      'heartbeatTimeoutMs equal to interval',
      { supervisor: { heartbeatIntervalMs: 100, heartbeatTimeoutMs: 100 } },
      'supervisor.heartbeatTimeoutMs',
    ],
    ['heartbeatTimeoutMs below default interval', { supervisor: { heartbeatTimeoutMs: 4_000 } }, 'supervisor.heartbeatTimeoutMs'],
    ['backoffMs empty', { supervisor: { backoffMs: [] } }, 'supervisor.backoffMs'],
    ['backoffMs not a list', { supervisor: { backoffMs: 1000 } }, 'supervisor.backoffMs'],
    ['backoffMs negative', { supervisor: { backoffMs: [1000, -1] } }, 'supervisor.backoffMs[1]'],
    ['backoffMs fraction', { supervisor: { backoffMs: [1.5] } }, 'supervisor.backoffMs[0]'],
    ['maxRestarts 0', { supervisor: { maxRestarts: 0 } }, 'supervisor.maxRestarts'],
    ['restartWindowMs 0', { supervisor: { restartWindowMs: 0 } }, 'supervisor.restartWindowMs'],
    ['bootTimeoutMs 0', { supervisor: { bootTimeoutMs: 0 } }, 'supervisor.bootTimeoutMs'],
    ['shutdownTimeoutMs NaN', { supervisor: { shutdownTimeoutMs: Number.NaN } }, 'supervisor.shutdownTimeoutMs'],
    ['highWaterMarkBytes below 64 KiB', { send: { highWaterMarkBytes: 64 * KIB - 1 } }, 'send.highWaterMarkBytes'],
    ['maxPayloadBytes below 64 KiB', { ws: { maxPayloadBytes: 64 * KIB - 1 } }, 'ws.maxPayloadBytes'],
    ['maxPayloadBytes above 1 GiB', { ws: { maxPayloadBytes: GIB + 1 } }, 'ws.maxPayloadBytes'],
    ['pingIntervalMs 0', { ws: { pingIntervalMs: 0 } }, 'ws.pingIntervalMs'],
    ['helloTimeoutMs a string', { ws: { helloTimeoutMs: '30000' } }, 'ws.helloTimeoutMs'],
  ];

  it.each(cases)('%s → CONFIG_INVALID', (_name, extra, field) => {
    expectConfigInvalid(() => validateEngineOptions(opts(extra)), field);
  });

  it('rejects a non-object', () => {
    expectConfigInvalid(() => validateEngineOptions(null as unknown as EngineOptions), 'options');
  });

  it('keeps the fs error as cause for an unreadable module', () => {
    try {
      validateEngineOptions(opts({ workerConfigModule: MISSING }));
      expect.unreachable();
    } catch (err) {
      expect((err as OpenDocexError).cause).toBeInstanceOf(Error);
    }
  });
});

describe('defineWorkerConfig', () => {
  it('returns its argument unchanged', () => {
    const c: WorkerConfig = { codecThreads: 2 };
    expect(defineWorkerConfig(c)).toBe(c);
  });
});

describe('resolveWorkerConfig: defaults (HLD §12, PO-26)', () => {
  it('fills every default', () => {
    const r = resolveWorkerConfig({}, CWD);
    expect('storage' in r).toBe(false);
    expect(r.dataDir).toBe(resolve(CWD, 'open-docex-data'));
    expect(r.queue).toEqual({ type: 'memory', perDocument: 1_000, global: 50_000 });
    expect(r.journal).toEqual({ fsync: 'interval', fsyncIntervalMs: 1_000 });
    expect(r.snapshot).toEqual({ everyOps: 500 });
    expect(r.flush).toEqual({ quietMs: 30_000, maxIntervalMs: 300_000 });
    expect(r.recovery.retryDelaysMs).toEqual([60_000, 300_000, 900_000]);
    expect(r.libreoffice).toEqual({ maxConcurrent: 2, timeoutMs: 120_000 });
    expect(r.codecThreads).toBe(1);
    expect(r.load.chunk).toEqual({ textBlocks: 200, sheetRows: 500, maxBytes: 262_144 });
    expect(r.limits.maxFileBytes).toBe(52_428_800);
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('defaults blank documents to A4 portrait with 2.54 cm margins', () => {
    const page = resolveWorkerConfig({}, CWD).blankDocument.page;
    expect(page.orientation).toBe('portrait');
    expect(page.size.width).toBeCloseTo(595.2756, 4);
    expect(page.size.height).toBeCloseTo(841.8898, 4);
    expect(page.margins).toEqual({ top: 72, right: 72, bottom: 72, left: 72 });
    expect(page).toBe(WORKER_DEFAULTS.blankPage);
  });

  it('uses process.cwd() when no cwd is given', () => {
    expect(resolveWorkerConfig({}).dataDir).toBe(resolve(process.cwd(), 'open-docex-data'));
  });

  it('keeps supplied values', () => {
    const storage = { read() {}, write() {}, stat() {}, create() {} };
    const page = { size: { width: 612, height: 792 }, orientation: 'landscape', margins: { top: 0, right: 0, bottom: 0, left: 0 } };
    const r = resolveWorkerConfig(
      {
        storage,
        dataDir: 'data',
        queue: { type: 'memory', perDocument: 5, global: 5 },
        journal: { fsync: 'always', fsyncIntervalMs: 10 },
        snapshot: { everyOps: 1 },
        flush: { quietMs: 1000, maxIntervalMs: 1000 },
        recovery: { retryDelaysMs: [0, 0, 0] },
        libreoffice: { path: '/usr/bin/soffice', maxConcurrent: 1, timeoutMs: 1000 },
        codecThreads: 3,
        load: { chunk: { textBlocks: 1, sheetRows: 1, maxBytes: 16 * KIB } },
        limits: { maxFileBytes: 1 },
        blankDocument: { page },
      },
      CWD,
    );
    expect(r.storage).toBe(storage);
    expect(r.dataDir).toBe(resolve(CWD, 'data'));
    expect(r.queue).toEqual({ type: 'memory', perDocument: 5, global: 5 });
    expect(r.journal).toEqual({ fsync: 'always', fsyncIntervalMs: 10 });
    expect(r.flush).toEqual({ quietMs: 1000, maxIntervalMs: 1000 });
    expect(r.recovery.retryDelaysMs).toEqual([0, 0, 0]);
    expect(r.libreoffice).toEqual({ path: '/usr/bin/soffice', maxConcurrent: 1, timeoutMs: 1000 });
    expect(r.codecThreads).toBe(3);
    expect(r.load.chunk).toEqual({ textBlocks: 1, sheetRows: 1, maxBytes: 16 * KIB });
    expect(r.limits.maxFileBytes).toBe(1);
    expect(r.blankDocument.page).toEqual(page);
    expect(r.blankDocument.page).not.toBe(page);
  });

  it('fills defaults inside a partly given section', () => {
    const r = resolveWorkerConfig({ queue: { type: 'memory', perDocument: 10 }, flush: { quietMs: 2000 } }, CWD);
    expect(r.queue).toEqual({ type: 'memory', perDocument: 10, global: 50_000 });
    expect(r.flush).toEqual({ quietMs: 2000, maxIntervalMs: 300_000 });
  });
});

describe('resolveWorkerConfig: one case per rule (LLD Part 2 §2.4)', () => {
  const okPage = { size: { width: 612, height: 792 }, orientation: 'portrait', margins: { top: 72, right: 72, bottom: 72, left: 72 } };
  const cases: [string, Record<string, unknown>, string][] = [
    ['storage not an object', { storage: 'fs' }, 'storage'],
    ['storage.read missing', { storage: { write() {}, stat() {}, create() {} } }, 'storage.read'],
    ['storage.create not a function', { storage: { read() {}, write() {}, stat() {}, create: 1 } }, 'storage.create'],
    ['dataDir not a string', { dataDir: 1 }, 'dataDir'],
    ['dataDir empty', { dataDir: '' }, 'dataDir'],
    ['queue not an object', { queue: 'memory' }, 'queue'],
    ['queue.type missing', { queue: {} }, 'queue.type'],
    ['queue.type redis (V3)', { queue: { type: 'redis' } }, 'queue.type'],
    ['queue.type kafka (V3)', { queue: { type: 'kafka' } }, 'queue.type'],
    ['queue.perDocument 0', { queue: { type: 'memory', perDocument: 0 } }, 'queue.perDocument'],
    ['queue.global fraction', { queue: { type: 'memory', global: 1.5 } }, 'queue.global'],
    ['queue.perDocument > global', { queue: { type: 'memory', perDocument: 11, global: 10 } }, 'queue.perDocument'],
    ['journal.fsync unknown', { journal: { fsync: 'never' } }, 'journal.fsync'],
    ['journal.fsyncIntervalMs below 10', { journal: { fsyncIntervalMs: 9 } }, 'journal.fsyncIntervalMs'],
    ['snapshot.everyOps 0', { snapshot: { everyOps: 0 } }, 'snapshot.everyOps'],
    ['flush.quietMs below 1000', { flush: { quietMs: 999 } }, 'flush.quietMs'],
    ['flush.quietMs > maxIntervalMs', { flush: { quietMs: 5000, maxIntervalMs: 4000 } }, 'flush.quietMs'],
    ['flush.maxIntervalMs below 1000', { flush: { quietMs: 1000, maxIntervalMs: 999 } }, 'flush.maxIntervalMs'],
    ['retryDelaysMs two items', { recovery: { retryDelaysMs: [1, 2] } }, 'recovery.retryDelaysMs'],
    ['retryDelaysMs four items', { recovery: { retryDelaysMs: [1, 2, 3, 4] } }, 'recovery.retryDelaysMs'],
    ['retryDelaysMs negative', { recovery: { retryDelaysMs: [1, -2, 3] } }, 'recovery.retryDelaysMs[1]'],
    ['retryDelaysMs fraction', { recovery: { retryDelaysMs: [1, 2, 3.5] } }, 'recovery.retryDelaysMs[2]'],
    ['libreoffice.path empty', { libreoffice: { path: '' } }, 'libreoffice.path'],
    ['libreoffice.maxConcurrent 0', { libreoffice: { maxConcurrent: 0 } }, 'libreoffice.maxConcurrent'],
    ['libreoffice.timeoutMs below 1000', { libreoffice: { timeoutMs: 999 } }, 'libreoffice.timeoutMs'],
    ['codecThreads 0', { codecThreads: 0 }, 'codecThreads'],
    ['load.chunk.textBlocks 0', { load: { chunk: { textBlocks: 0 } } }, 'load.chunk.textBlocks'],
    ['load.chunk.sheetRows 0', { load: { chunk: { sheetRows: 0 } } }, 'load.chunk.sheetRows'],
    ['load.chunk.maxBytes below 16 KiB', { load: { chunk: { maxBytes: 16 * KIB - 1 } } }, 'load.chunk.maxBytes'],
    ['load not an object', { load: 5 }, 'load'],
    ['limits.maxFileBytes 0', { limits: { maxFileBytes: 0 } }, 'limits.maxFileBytes'],
    ['blankDocument.page not an object', { blankDocument: { page: 'A4' } }, 'blankDocument.page'],
    [
      'blankDocument.page size too small',
      { blankDocument: { page: { ...okPage, size: { width: 35, height: 792 } } } },
      'blankDocument.page.size',
    ],
    [
      'blankDocument.page orientation unknown',
      { blankDocument: { page: { ...okPage, orientation: 'square' } } },
      'blankDocument.page.orientation',
    ],
    [
      'blankDocument.page margin negative',
      { blankDocument: { page: { ...okPage, margins: { top: -1, right: 0, bottom: 0, left: 0 } } } },
      'blankDocument.page.margins',
    ],
    [
      'blankDocument.page margins leave no body',
      { blankDocument: { page: { ...okPage, margins: { top: 0, right: 300, bottom: 0, left: 300 } } } },
      'blankDocument.page.margins',
    ],
  ];

  it.each(cases)('%s → CONFIG_INVALID', (_name, raw, field) => {
    expectConfigInvalid(() => resolveWorkerConfig(raw, CWD), field);
  });

  it.each([null, undefined, 'config', [], 42])('rejects a default export of %j', (raw) => {
    expectConfigInvalid(() => resolveWorkerConfig(raw, CWD), 'worker config');
  });
});
