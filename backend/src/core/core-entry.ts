/**
 * The Core's entry and wiring (LLD Part 2 §5, §7, §0.5 S-36, S-38, S-40, S-43).
 *
 * This module has two uses:
 * - **Child main** (`mode: 'worker'`): the Supervisor forks this file. When it is the process's
 *   entry script, {@link main} runs: it builds the real services, starts a {@link CoreRuntime}
 *   on the IPC channel and installs the process handlers (parent death, uncaught errors).
 * - **Library** (`mode: 'main'`, and tests): {@link createCoreWiring} returns the
 *   {@link CoreServices} that wire the real `CodecService` over `CodecPool`, `FlushScheduler`,
 *   `RecoveryManager`, `AuditEmitter` and `MemoryQueue`, and a channel-side wrapper that answers
 *   the engine API calls (`documents.*`, `recovery.*`, `audit.enable`). Importing the module
 *   starts nothing.
 *
 * Wiring notes:
 * - The scheduler is built before the recovery manager and reaches it through a forwarder
 *   (S-38): the scheduler needs recovery's `onWriteFailed` and `onConflict`, and recovery needs
 *   the scheduler's `markDirty`.
 * - The audit emitter is enabled and `replayAll()` runs at boot, after `meta.loadAll()` and
 *   before sessions are accepted and before any document loads (S-40). The queue's `start()` is
 *   the first awaited boot step after `meta.loadAll()`, so the replay runs inside it.
 * - Shutdown: after the instances closed and the scheduler flushed, recovery is closed and the
 *   audit emitter flushed. The runtime then closes the queue and the codec (S-38, S-40).
 *
 * @module
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OpenDocexError } from '@open-docex/shared/errors';
import { asDocumentId, type DocumentId } from '@open-docex/shared/ids';
import type { DocKind, FileFormat } from '@open-docex/shared/protocol';
import type { AuditEvent } from '../api/events.js';
import { AuditEmitter } from '../audit/audit-emitter.js';
import type { CoreChannelSide } from '../channel/engine-channel.js';
import { IpcCoreChannelSide } from '../channel/ipc-engine-channel.js';
import type { CoreRequest } from '../channel/messages.js';
import { toWire } from '../channel/wire-error.js';
import { CodecPool } from '../codec/codec-pool.js';
import { CodecService } from '../codec/codec-service.js';
import { engineError } from '../errors/engine-error.js';
import { FlushScheduler } from '../flush/flush-scheduler.js';
import { serializeModel, type CodecExport } from '../flush/storage-io.js';
import { docKeyOf, tmpRoot } from '../persistence/layout.js';
import { MemoryQueue } from '../queue/memory-queue.js';
import type { QueueAdapter } from '../queue/queue-adapter.js';
import { RecoveryManager, type RecoveryResolution } from '../recovery/recovery-manager.js';
import { STORAGE_CALL_TIMEOUT_MS } from '../storage/storage-adapter.js';
import { CoreRuntime, type CoreServiceContext, type CoreServices } from './core-runtime.js';
import { textKindPolicy } from './kind-policy.js';
import type { DocumentRegistry } from './registry.js';
import type { CodecSeam, FlushSeam } from './seams.js';

export type { RecoveryEntry, RecoveryResolution, LocalCopy } from '../recovery/recovery-manager.js';

/** The codec the wiring needs: the Core's import side plus the export side flush and recovery use. */
export type WiredCodec = CodecSeam & CodecExport;

/** Overrides for tests. Production passes none. */
export interface CoreWiringOptions {
  /** Replaces the real `CodecService` over `CodecPool`. */
  codec?: (c: CoreServiceContext) => WiredCodec;
  /** The compiled codec thread entry. Default: `../codec/codec-thread-entry.js` next to this module. */
  codecEntry?: URL;
}

/** What {@link createCoreWiring} returns. */
export interface CoreWiring {
  /** The factories to pass to `new CoreRuntime(side, { services })`. */
  services: CoreServices;
  /** Wraps the Core end of a channel so that API `call`s are answered by the engine API. */
  wrap(side: CoreChannelSide): CoreChannelSide;
}

/** The checked arguments of `documents.create` (LLD Part 2 §2.6). */
export interface CreateDocumentArgs {
  kind: DocKind;
  format: FileFormat;
  name: string;
  target: 'storage' | 'local';
}

/** What the engine API needs, filled in as boot builds it. */
interface Parts {
  side?: CoreChannelSide;
  ctx?: CoreServiceContext;
  codec?: WiredCodec;
  scheduler?: FlushScheduler;
  recovery?: RecoveryManager;
  audit?: AuditEmitter;
  registry?: DocumentRegistry;
}

const TEXT_FORMATS: ReadonlySet<string> = new Set(['docx', 'odt']);
const SHEET_FORMATS: ReadonlySet<string> = new Set(['xlsx', 'ods']);

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function bad(message: string): OpenDocexError {
  return engineError('CONFIG_INVALID', { message });
}

function docIdOf(args: unknown): DocumentId {
  const id = isObj(args) ? args['documentId'] : undefined;
  if (typeof id !== 'string') throw bad('documentId: expected a string.');
  try {
    return asDocumentId(id);
  } catch {
    throw bad('documentId: not a valid document ID.');
  }
}

/**
 * Checks `documents.create` arguments.
 *
 * @throws {OpenDocexError} `CONFIG_INVALID`, for example when `kind` does not match `format`.
 */
export function parseCreateArgs(a: unknown): CreateDocumentArgs {
  if (!isObj(a)) throw bad('documents.create: expected an object.');
  const { kind, format, name, target } = a;
  if (kind !== 'text' && kind !== 'sheet') throw bad('kind: expected "text" or "sheet".');
  if (typeof format !== 'string' || !(TEXT_FORMATS.has(format) || SHEET_FORMATS.has(format))) {
    throw bad('format: expected "docx", "odt", "xlsx" or "ods".');
  }
  if ((kind === 'text') !== TEXT_FORMATS.has(format)) throw bad(`format: "${format}" does not match kind "${kind}".`);
  if (typeof name !== 'string' || name.length === 0) throw bad('name: expected a non-empty string.');
  if (target !== 'storage' && target !== 'local') throw bad('target: expected "storage" or "local".');
  return { kind, format: format as FileFormat, name, target };
}

/**
 * Wraps `q` so that `start()` first enables the audit emitter and replays pending events
 * (S-40). A replay failure is logged and never blocks boot.
 */
function replayBeforeStart(q: QueueAdapter, parts: Parts): QueueAdapter {
  return {
    get kind() {
      return q.kind;
    },
    async start(hooks) {
      const audit = parts.audit;
      if (audit !== undefined) {
        audit.setEnabled(true);
        try {
          await audit.replayAll();
        } catch (err) {
          parts.ctx?.logger.error('Audit replay failed.', { code: OpenDocexError.is(err) ? err.code : 'UNKNOWN' });
        }
      }
      return q.start(hooks);
    },
    enqueue: (item) => q.enqueue(item),
    consume: (id, deliver) => q.consume(id, deliver),
    depth: (id) => q.depth(id),
    close: () => q.close(),
  };
}

/** The scheduler plus the shutdown steps that follow its flush (S-38, S-40). */
function flushWithShutdown(parts: Parts, scheduler: FlushScheduler): FlushSeam {
  return {
    markDirty: (inst) => scheduler.markDirty(inst),
    flushNow: (inst, o) => scheduler.flushNow(inst, o),
    async flushAll(deadline) {
      try {
        await scheduler.flushAll(deadline);
      } finally {
        // Even when the flush failed: stop the retry timers and let pending `auditEmittedRev`
        // writes finish, so the next boot does not replay events that were already delivered.
        parts.recovery?.close();
        await parts.audit?.flush();
      }
    },
  };
}

/** Builds the real services and the API wrapper (see the module comment). */
export function createCoreWiring(o: CoreWiringOptions = {}): CoreWiring {
  const parts: Parts = {};

  const services: CoreServices = {
    codec(c) {
      parts.ctx = c;
      const codec =
        o.codec?.(c) ??
        new CodecService({
          pool: new CodecPool({
            size: c.config.codecThreads,
            entry: o.codecEntry ?? new URL('../codec/codec-thread-entry.js', import.meta.url),
            logger: c.logger,
          }),
          tmpDir: tmpRoot(c.config.dataDir),
          libreoffice: c.config.libreoffice,
          maxFileBytes: c.config.limits.maxFileBytes,
          logger: c.logger,
        });
      parts.codec = codec;
      return codec;
    },
    flush(c) {
      // Built before the recovery manager; the forwarder reaches it once it exists (S-38).
      const scheduler = new FlushScheduler({
        codec: parts.codec as WiredCodec,
        router: c.router,
        meta: c.meta,
        recovery: {
          onWriteFailed: (inst, err) => parts.recovery?.onWriteFailed(inst, err) ?? Promise.resolve(),
          onConflict: (inst, v) => parts.recovery?.onConflict(inst, v) ?? Promise.resolve(),
        },
        clock: c.clock,
        quietMs: c.config.flush.quietMs,
        maxIntervalMs: c.config.flush.maxIntervalMs,
        dataDir: c.config.dataDir,
        emit: (event, payload) => c.emit(event, payload),
        logger: c.logger,
      });
      parts.scheduler = scheduler;
      return flushWithShutdown(parts, scheduler);
    },
    audit(c) {
      const audit = new AuditEmitter({
        dataDir: c.config.dataDir,
        meta: c.meta,
        emit: (_event, payload: AuditEvent) => c.emit('audit', payload),
        logger: c.logger,
        fsync: c.config.journal.fsync,
      });
      parts.audit = audit;
      return audit;
    },
    queue(c) {
      const q = new MemoryQueue({ perDocument: c.config.queue.perDocument, global: c.config.queue.global });
      return replayBeforeStart(q, parts);
    },
    recovery(c) {
      parts.registry = c.registry;
      const recovery = new RecoveryManager({
        meta: c.meta,
        registry: c.registry,
        codec: parts.codec as WiredCodec,
        router: c.router,
        sink: { send: (frames) => parts.side?.emit({ type: 'send', frames }) },
        emit: (event, payload) => c.emit(event, payload),
        flush: { markDirty: (inst) => parts.scheduler?.markDirty(inst) },
        clock: c.clock,
        delays: c.config.recovery.retryDelaysMs,
        dataDir: c.config.dataDir,
        logger: c.logger,
      });
      parts.recovery = recovery;
      return recovery;
    },
  };

  const wrap = (side: CoreChannelSide): CoreChannelSide => {
    parts.side = side;
    return {
      onRequest(handler) {
        side.onRequest((msg: CoreRequest) => {
          if (msg.type === 'call') void answerCall(side, parts, msg);
          else handler(msg);
        });
      },
      emit: (ev) => side.emit(ev),
      whenWritable: () => side.whenWritable(),
      hook: (name, args) => side.hook(name, args),
    };
  };

  return { services, wrap };
}

// --- the engine API (LLD Part 2 §2.6) ----------------------------------------------------------

async function answerCall(side: CoreChannelSide, parts: Parts, msg: Extract<CoreRequest, { type: 'call' }>): Promise<void> {
  try {
    const value = await callApi(parts, msg.method, msg.args);
    side.emit({ type: 'result', id: msg.id, ok: true, value });
  } catch (err) {
    side.emit({ type: 'result', id: msg.id, ok: false, error: toWire(err, { where: 'instance' }) });
  }
}

function booted(parts: Parts): Required<Pick<Parts, 'ctx' | 'codec' | 'recovery' | 'audit' | 'registry'>> {
  const { ctx, codec, recovery, audit, registry } = parts;
  if (ctx === undefined || codec === undefined || recovery === undefined || audit === undefined || registry === undefined) {
    throw engineError('ENGINE_UNAVAILABLE', { message: 'The Core has not finished booting.' });
  }
  return { ctx, codec, recovery, audit, registry };
}

async function callApi(parts: Parts, method: string, args: unknown): Promise<unknown> {
  const p = booted(parts);
  switch (method) {
    case 'documents.create':
      return createDocument(p, parseCreateArgs(args));
    case 'documents.allowUnsupportedEdit':
      return allowUnsupportedEdit(p, docIdOf(args));
    case 'documents.info': {
      const id = docIdOf(args);
      const loaded = p.registry.get(id);
      if (loaded !== undefined) return { documentId: id, loaded: true, kind: loaded.kind };
      const meta = p.ctx.meta.get(docKeyOf(id));
      return meta === undefined ? { documentId: id, loaded: false } : { documentId: id, loaded: false, kind: meta.kind };
    }
    case 'recovery.list':
      return p.recovery.list();
    case 'recovery.retry':
      return p.recovery.retry(docIdOf(args));
    case 'recovery.readLocalCopy':
      return p.recovery.readLocalCopy(docIdOf(args));
    case 'recovery.resolve': {
      const r = isObj(args) ? args['resolution'] : undefined;
      if (r !== 'overwrite-storage' && r !== 'discard-local' && r !== 'mark-resolved') {
        throw bad('resolution: expected "overwrite-storage", "discard-local" or "mark-resolved".');
      }
      return p.recovery.resolve(docIdOf(args), r satisfies RecoveryResolution);
    }
    case 'audit.enable': {
      const enabled = isObj(args) ? args['enabled'] : undefined;
      if (typeof enabled !== 'boolean') throw bad('enabled: expected a boolean.');
      p.audit.setEnabled(enabled);
      return undefined;
    }
    default:
      throw bad(`Unknown API method "${method}".`);
  }
}

/** `documents.create` (HLD §10.6): export the kind's empty snapshot, then `storage.create`. */
async function createDocument(p: ReturnType<typeof booted>, a: CreateDocumentArgs): Promise<{ ref: unknown }> {
  if (a.kind !== 'text') throw engineError('DOCUMENT_UNSUPPORTED_CONTENT', { message: 'Spreadsheets need V2.' });
  const cfg = p.ctx.config;
  const c = cfg.load.chunk;
  const policy = textKindPolicy({ textBlocks: c.textBlocks, sheetRows: c.sheetRows, maxBytes: c.maxBytes }, cfg.blankDocument.page);
  const model = serializeModel('text', policy.emptySnapshot());
  const bytes = await p.codec.export({ kind: 'text', format: a.format, model, assetDir: tmpRoot(cfg.dataDir) });
  const adapter = p.ctx.router.forCreate(a.target);
  const ac = new AbortController();
  const clock = p.ctx.clock;
  const timer = clock.setTimeout(() => ac.abort(), STORAGE_CALL_TIMEOUT_MS);
  try {
    const made = await adapter.create({ kind: a.kind, format: a.format, name: a.name, bytes }, { signal: ac.signal });
    return { ref: made.ref };
  } catch (err) {
    throw OpenDocexError.is(err) ? err : engineError('STORAGE_WRITE_FAILED', { cause: err });
  } finally {
    clock.clearTimeout(timer);
  }
}

/** `documents.allowUnsupportedEdit`: a loaded instance updates its sessions; otherwise only the meta. */
async function allowUnsupportedEdit(p: ReturnType<typeof booted>, id: DocumentId): Promise<void> {
  const inst = p.registry.get(id);
  if (inst !== undefined) {
    await inst.allowUnsupportedEdit();
    return;
  }
  const meta = p.ctx.meta.get(docKeyOf(id));
  if (meta === undefined) throw engineError('DOCUMENT_NOT_FOUND', { documentId: id });
  meta.readOnly = { ...meta.readOnly, allowedEdit: true };
  meta.updatedAt = p.ctx.clock.now();
  await p.ctx.meta.put(meta);
}

// --- child main (LLD Part 2 §5, "Core side of the process boundary") --------------------------

/** Waits this long after the last IPC message before the child exits, so the reply is written. */
const EXIT_DELAY_MS = 200;
/** The budget of the fast shutdown when the parent died. */
const ORPHAN_SHUTDOWN_MS = 2000;

/**
 * Runs the Core as a child process: real services over the IPC channel, with the process
 * handlers of LLD Part 2 §5. The process exits after answering `shutdown`, and with code 1 when
 * boot fails.
 *
 * @param o test seams for {@link createCoreWiring}. Production passes none: the Supervisor forks
 *   this module and it calls `main()` itself.
 */
export function main(o: CoreWiringOptions = {}): void {
  const ipc = IpcCoreChannelSide.fromProcess();
  const wiring = createCoreWiring(o);
  const wrapped = wiring.wrap(ipc);
  let initId: number | undefined;
  let shutdownId: number | undefined;
  const side: CoreChannelSide = {
    onRequest(handler) {
      wrapped.onRequest((m) => {
        if (m.type === 'init') initId = m.id;
        else if (m.type === 'shutdown') shutdownId = m.id;
        handler(m);
      });
    },
    emit(ev) {
      wrapped.emit(ev);
      if (ev.type === 'result' && ev.id === shutdownId) setTimeout(() => process.exit(0), EXIT_DELAY_MS);
      if (ev.type === 'result' && !ev.ok && ev.id === initId) setTimeout(() => process.exit(1), EXIT_DELAY_MS);
    },
    whenWritable: () => wrapped.whenWritable(),
    hook: (name, args) => wrapped.hook(name, args),
  };
  const runtime = new CoreRuntime(side, { services: wiring.services });

  // The parent died: run a fast shutdown (journal datasync, release LOCK), then exit, so the
  // Core never lives on as an orphan.
  process.on('disconnect', () => {
    void runtime.shutdown(ORPHAN_SHUTDOWN_MS).finally(() => process.exit(0));
  });
  // The state may be corrupt: report and exit; the Supervisor restarts the Core.
  process.on('uncaughtException', (err) => {
    process.stderr.write(`open_docex Core: uncaught exception: ${err.message}\n`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`open_docex Core: unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`);
    process.exit(1);
  });
}

/** True when this module is the process's entry script (the Supervisor forked it). */
function isEntryScript(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined || typeof process.send !== 'function') return false;
  try {
    return realpathSync.native(argv1) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryScript()) main();
