/**
 * `CoreRuntime`: boots the Core, routes `CoreRequest`s and shuts down (LLD Part 2 §7).
 *
 * Boot steps, in order (any throw ends boot with `result { ok: false }`):
 * 1. Import the worker config module and `resolveWorkerConfig` it (`CONFIG_INVALID`).
 * 2. `ensureLayout`: folders plus a write probe (`CONFIG_DATA_DIR_UNWRITABLE`).
 * 3. `DataDirLock.acquire()` (`CONFIG_DATA_DIR_UNWRITABLE`, naming the holder's pid).
 * 4. Empty `tmp/` and start the codec.
 * 5. `codec.probe()` (`CONFIG_LIBREOFFICE_NOT_FOUND`).
 * 6. `MetaStore.loadAll()`; build the router, flush scheduler, recovery manager, audit
 *    emitter, registry and session dispatcher.
 * 7. `queue.start({ onBacklog })`.
 * 8. Recovery scan (schedules work only).
 * 9. Start the journal fsync timer and reply `ready` with a {@link BootReport}.
 *
 * **Fault isolation:** every request handler is wrapped. An error that belongs to one instance
 * goes to that instance's `fault()`; any other error is logged and emitted as `error`, and the
 * Core keeps running.
 *
 * The codec, flush, recovery and audit modules are built by other tasks, so the runtime takes
 * factories for them ({@link CoreServices}).
 *
 * @module
 */
import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import { OpenDocexError } from '@open-docex/shared/errors';
import type { DocumentEvent } from '../api/events.js';
import type { ResolvedWorkerConfig } from '../api/options.js';
import { resolveWorkerConfig } from '../api/validate-options.js';
import { engineError } from '../errors/engine-error.js';
import { levelEnabled, sanitizeFields, type Logger, type LogLevel } from '../log/logger.js';
import { AssetStore } from '../persistence/asset-store.js';
import { DataDirLock } from '../persistence/data-dir-lock.js';
import { JournalSyncTimer } from '../persistence/journal.js';
import { emptyTmp, ensureLayout } from '../persistence/layout.js';
import { MetaStore } from '../persistence/meta-store.js';
import { SnapshotStore } from '../persistence/snapshot-store.js';
import { MemoryQueue } from '../queue/memory-queue.js';
import type { QueueAdapter } from '../queue/queue-adapter.js';
import { StorageRouter } from '../storage/storage-router.js';
import { DocumentInstanceFactory } from './instance-factory.js';
import { DocumentRegistry } from './registry.js';
import type { CoreChannelSide } from '../channel/engine-channel.js';
import type { BootReport, CoreEvent, CoreRequest } from '../channel/messages.js';
import { toWire } from '../channel/wire-error.js';
import {
  realClock,
  type AuditSink,
  type Clock,
  type CodecSeam,
  type CoreSink,
  type FlushSeam,
  type RecoverySeam,
} from './seams.js';
import { SessionDispatcher } from './session-record.js';

/** What the service factories receive. */
export interface CoreServiceContext {
  config: ResolvedWorkerConfig;
  clock: Clock;
  logger: Logger;
  meta: MetaStore;
  router: StorageRouter;
  /** Sends `emit` events (for example `storage` and `audit`) to the main process. */
  emit(event: 'error' | 'audit' | 'storage' | 'document', payload: unknown): void;
}

/** Factories for the modules other tasks build (V1-14, V1-16, V1-17). */
export interface CoreServices {
  /** Builds the codec (boot step 4); `probe()` runs in step 5. */
  codec(c: CoreServiceContext): CodecSeam;
  flush(c: CoreServiceContext & { codec: CodecSeam }): FlushSeam;
  recovery(c: CoreServiceContext & { codec: CodecSeam; registry: DocumentRegistry }): RecoverySeam;
  audit(c: CoreServiceContext): AuditSink;
  /** Default: `MemoryQueue` with the configured bounds. */
  queue?(c: CoreServiceContext): QueueAdapter;
  /** Default: `import(url)`. Seam for tests. */
  importModule?(url: string): Promise<unknown>;
}

interface Booted {
  config: ResolvedWorkerConfig;
  lock: DataDirLock;
  codec: CodecSeam;
  flush: FlushSeam;
  queue: QueueAdapter;
  registry: DocumentRegistry;
  dispatcher: SessionDispatcher;
  syncTimer: JournalSyncTimer;
}

/** The Core's top level (LLD Part 2 §7). */
export class CoreRuntime {
  readonly #side: CoreChannelSide;
  readonly #clock: Clock;
  readonly #services: CoreServices;
  readonly sink: CoreSink;
  #logLevel: LogLevel = 'info';
  readonly logger: Logger;
  #booted: Booted | null = null;
  #shuttingDown = false;

  /**
   * @param side the Core end of the channel: `IpcCoreChannelSide.fromProcess()` in worker mode,
   *   or the second element of `InProcessEngineChannel.pair()` in main mode.
   * @param o.services factories for the modules built by other tasks (LLD §7 has only
   *   `(side, clock?)`; the factories are how they are wired in).
   */
  constructor(side: CoreChannelSide, o: { services: CoreServices; clock?: Clock }) {
    this.#side = side;
    this.#clock = o.clock ?? realClock;
    this.#services = o.services;
    this.logger = this.#makeLogger();
    this.sink = this.#makeSink();
    side.onRequest((msg) => this.#onRequest(msg));
  }

  /** The registry, once booted. */
  get registry(): DocumentRegistry | undefined {
    return this.#booted?.registry;
  }

  /** The session dispatcher, once booted. */
  get dispatcher(): SessionDispatcher | undefined {
    return this.#booted?.dispatcher;
  }

  /**
   * Runs boot steps 1–9.
   *
   * @throws {OpenDocexError} the failing step's code. Resources taken before the failure are
   *   released.
   */
  async boot(init: { workerConfigModule: string; logLevel: LogLevel }): Promise<BootReport> {
    if (this.#booted !== null) throw engineError('CONFIG_INVALID', { message: 'The Core is already booted.' });
    this.#logLevel = init.logLevel;
    const cleanup: Array<() => Promise<void>> = [];
    try {
      // 1. Worker config.
      const config = await this.#loadConfig(init.workerConfigModule);
      // 2. Layout and write probe.
      await ensureLayout(config.dataDir);
      // 3. LOCK.
      const lock = new DataDirLock(config.dataDir);
      await lock.acquire();
      cleanup.push(() => lock.release());
      // 4. tmp/ and codec.
      await emptyTmp(config.dataDir);
      const meta = new MetaStore(config.dataDir, { logger: this.logger });
      const router = new StorageRouter({
        dataDir: config.dataDir,
        logger: this.logger,
        ...(config.storage !== undefined ? { storage: config.storage } : {}),
      });
      const ctx: CoreServiceContext = {
        config,
        clock: this.#clock,
        logger: this.logger,
        meta,
        router,
        emit: (event, payload) => this.#side.emit({ type: 'emit', event, payload }),
      };
      const codec = this.#services.codec(ctx);
      cleanup.push(() => codec.close());
      // 5. Probe LibreOffice.
      try {
        await codec.probe();
      } catch (err) {
        throw OpenDocexError.is(err) ? err : engineError('CONFIG_LIBREOFFICE_NOT_FOUND', { cause: err });
      }
      // 6. Stores and services.
      await meta.loadAll();
      const flush = this.#services.flush({ ...ctx, codec });
      const audit = this.#services.audit(ctx);
      const queue = this.#services.queue?.(ctx) ?? new MemoryQueue({ perDocument: config.queue.perDocument, global: config.queue.global });
      cleanup.push(() => queue.close());
      const syncTimer = new JournalSyncTimer({ intervalMs: config.journal.fsyncIntervalMs, clock: this.#clock, logger: this.logger });
      const factory = new DocumentInstanceFactory({
        config,
        meta,
        snapshots: new SnapshotStore(config.dataDir),
        assets: new AssetStore(config.dataDir),
        router,
        codec,
        queue,
        flush,
        audit,
        sink: this.sink,
        clock: this.#clock,
        logger: this.logger,
        syncTimer,
      });
      const registry = new DocumentRegistry({ factory, logger: this.logger, meta });
      const recovery = this.#services.recovery({ ...ctx, codec, registry });
      const dispatcher = new SessionDispatcher({ registry, sink: this.sink, logger: this.logger });
      // 7. Queue.
      try {
        await queue.start({ onBacklog: (id) => void registry.ensureLoadedForBacklog(id).catch((e: unknown) => this.#report(e)) });
      } catch (err) {
        throw OpenDocexError.is(err) ? err : engineError('QUEUE_UNAVAILABLE', { cause: err });
      }
      // 8. Recovery scan: schedules work only.
      recovery.resumeAfterBoot();
      // 9. fsync timer and report.
      if (config.journal.fsync === 'interval') syncTimer.start();
      this.#booted = { config, lock, codec, flush, queue, registry, dispatcher, syncTimer };
      const metas = meta.list();
      return {
        documents: metas.length,
        recovering: metas.filter((m) => m.storageState !== 'NORMAL').length,
        dirty: metas.filter((m) => m.rev > m.lastFlushedRev).length,
        queueBacklog: 0,
      };
    } catch (err) {
      for (const c of cleanup.reverse()) await c().catch(() => undefined);
      throw OpenDocexError.is(err) ? err : engineError('CONFIG_INVALID', { cause: err });
    }
  }

  /**
   * Closes every instance (stop intake, wait for the current delivery, sync), flushes best
   * effort until the deadline, then releases the queue, codec and LOCK.
   */
  async shutdown(timeoutMs: number): Promise<void> {
    const b = this.#booted;
    if (b === null || this.#shuttingDown) return;
    this.#shuttingDown = true;
    const deadline = this.#clock.now() + timeoutMs;
    await Promise.all([...b.registry.all()].map((i) => i.close().catch((e: unknown) => this.#report(e))));
    await b.flush.flushAll(deadline).catch((e: unknown) => this.#report(e));
    b.syncTimer.stop();
    await b.syncTimer.syncAll().catch((e: unknown) => this.#report(e));
    await b.queue.close().catch((e: unknown) => this.#report(e));
    await b.codec.close().catch((e: unknown) => this.#report(e));
    await b.lock.release().catch(() => undefined);
    this.#booted = null;
  }

  async #loadConfig(module: string): Promise<ResolvedWorkerConfig> {
    let mod: unknown;
    try {
      const url = isAbsolute(module) ? pathToFileURL(module).href : module;
      mod = await (this.#services.importModule ?? ((u: string) => import(u) as Promise<unknown>))(url);
    } catch (err) {
      throw engineError('CONFIG_INVALID', { message: 'worker config: the module could not be imported.', cause: err });
    }
    const def = typeof mod === 'object' && mod !== null ? (mod as { default?: unknown }).default : undefined;
    if (def === undefined) throw engineError('CONFIG_INVALID', { message: 'worker config: the module has no default export.' });
    return resolveWorkerConfig(def);
  }

  #onRequest(msg: CoreRequest): void {
    try {
      switch (msg.type) {
        case 'init':
          void this.boot({ workerConfigModule: msg.workerConfigModule, logLevel: msg.logLevel }).then(
            (boot) => this.#emit({ type: 'ready', id: msg.id, pid: process.pid, boot }),
            (err: unknown) => this.#emit({ type: 'result', id: msg.id, ok: false, error: toWire(err, { where: 'boot' }) }),
          );
          return;
        case 'ping':
          this.#emit({ type: 'pong', seq: msg.seq });
          return;
        case 'shutdown':
          // shutdown() reports its own failures and never rejects.
          void this.shutdown(msg.timeoutMs).then(() => this.#emit({ type: 'result', id: msg.id, ok: true, value: undefined }));
          return;
        case 'call':
          // The engine API (documents.*, recovery.*, audit.enable) is wired by V1-19.
          this.#emit({
            type: 'result',
            id: msg.id,
            ok: false,
            error: toWire(engineError('ENGINE_UNAVAILABLE', { message: `${msg.method} is not available in the Core yet.` }), {
              where: 'boot',
            }),
          });
          return;
        case 'hook-result':
          return; // consumed by the channel (V4 hooks)
        default: {
          const d = this.#booted?.dispatcher;
          if (d === undefined || this.#shuttingDown) {
            this.logger.debug('Session request before boot or during shutdown dropped.', { sessionId: msg.sessionId });
            return;
          }
          d.handle(msg);
        }
      }
    } catch (err) {
      this.#report(err);
    }
  }

  /**
   * An error that belongs to no instance: logged, and emitted as `error` only when it names a
   * document (§0.5 S-34).
   */
  #report(err: unknown): void {
    const code = OpenDocexError.is(err) ? err.code : 'UNKNOWN';
    this.logger.error('Core error.', { code });
    if (OpenDocexError.is(err) && typeof err.documentId === 'string') {
      this.#emit({ type: 'emit', event: 'error', payload: toWire(err, { where: 'document', documentId: err.documentId }) });
    }
  }

  #emit(ev: CoreEvent): void {
    this.#side.emit(ev);
  }

  #makeLogger(): Logger {
    const at =
      (level: LogLevel) =>
      (m: string, f?: Parameters<Logger['info']>[1]): void => {
        if (!levelEnabled(level, this.#logLevel)) return;
        const fields = sanitizeFields(f);
        this.#emit(fields === undefined ? { type: 'log', level, msg: m } : { type: 'log', level, msg: m, fields });
      };
    return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
  }

  #makeSink(): CoreSink {
    return {
      send: (frames) => this.#emit({ type: 'send', frames }),
      close: (sessionIds, code, reason) => this.#emit({ type: 'close', sessionIds, code, reason }),
      error: (err) => this.#report(err),
      document: (ev: DocumentEvent) => {
        const { error, ...rest } = ev;
        const payload =
          error === undefined ? rest : { ...rest, error: toWire(error, { where: 'instance', documentId: ev.documentId }) };
        this.#emit({ type: 'emit', event: 'document', payload });
      },
      whenWritable: () => this.#side.whenWritable(),
    };
  }
}
