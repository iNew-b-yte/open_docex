/**
 * Public option types: the main-process `EngineOptions` and the worker config module's
 * `WorkerConfig` (LLD Part 2 §2.2–§2.3, HLD §12), plus their resolved forms with every
 * default filled in (LLD Part 2 §2.4).
 *
 * These are public option types, so they are a frozen contract (AGENTS.md §2). Defaults are
 * in `validate-options.ts`.
 *
 * Left out until their version (LLD §0.5 S-22): `onUploaded`/`UploadedContext` (V4),
 * `annotations`/`AnnotationStore` (V5) and the Redis and Kafka queue configs (V3).
 *
 * @module
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { DocumentId } from '@open-docex/shared/ids';
import type { FileFormat } from '@open-docex/shared/protocol';
// Type-only, so ProseMirror never loads in the main process (LLD §0.5 S-23).
import type { PageSettings } from '@open-docex/shared/text';
import type { Logger, LogLevel } from '../log/logger.js';
import type { MemoryQueueConfig } from '../queue/memory-queue.js';
import type { StorageAdapter, StorageRef } from '../storage/storage-adapter.js';

export type { DocKind, FileFormat } from '@open-docex/shared/protocol';
export type { Logger, LogLevel } from '../log/logger.js';
export type { MemoryQueueConfig } from '../queue/memory-queue.js';
export type { PageSettings } from '@open-docex/shared/text';

/** An HTTP or HTTPS server whose `upgrade` events the engine handles. */
export type HttpServerLike = HttpServer | HttpsServer;

/** What `authorize` receives for each WebSocket upgrade (LLD Part 2 §2.2). */
export interface AuthorizeContext {
  /** The upgrade request. The adopter reads its own cookie or token from it. */
  request: IncomingMessage;
  /** The parsed request URL. */
  url: URL;
  /** From `?doc=` (CL-13). */
  documentId: DocumentId;
  /** Always `'document'` in V1. V4 widens it to `'upload'` (LLD §0.5 S-25, L-3). */
  purpose: 'document';
}

/** A successful `authorize` result: who the user is, their access, and which file to open. */
export interface AuthorizeResult {
  userId: string;
  access: 'edit' | 'view';
  document: { ref: StorageRef; format: FileFormat };
}

/**
 * An explicit refusal from `authorize` (L-7, LLD §0.5 S-24). `401` or `403` becomes that HTTP
 * status. Any other `deny` value is a malformed result: HTTP 500 and a `CONFIG_INVALID` error
 * event. Browsers see close code 1006 either way.
 */
export interface AuthorizeDenial {
  deny: 401 | 403;
}

/** A read-only view of a session, handed to `canSubmit` and `sessions.close`. */
export interface Session {
  readonly id: string;
  readonly documentId: DocumentId;
  readonly userId: string;
  readonly access: 'edit' | 'view';
  /** Epoch milliseconds. */
  readonly openedAt: number;
}

/** Core process supervision (LLD Part 2 §2.2, HLD §12). All times in milliseconds. */
export interface SupervisorOptions {
  /** Default 5 000. */
  heartbeatIntervalMs?: number;
  /** Default 15 000. Must be greater than `heartbeatIntervalMs`. */
  heartbeatTimeoutMs?: number;
  /** Restart delays. Default `[1000, 2000, 4000, 8000, 16000]`. */
  backoffMs?: readonly number[];
  /** Default 5 restarts per `restartWindowMs`. */
  maxRestarts?: number;
  /** Default 600 000 (10 minutes). */
  restartWindowMs?: number;
  /** Default 60 000 (LLD choice). */
  bootTimeoutMs?: number;
  /** Default 10 000 (LLD choice). */
  shutdownTimeoutMs?: number;
}

/** Options for `createEngine`, read in the adopter's main process (LLD Part 2 §2.2, HLD §12). */
export interface EngineOptions {
  /** Where the Core runs. Default `'worker'` (a child process). */
  mode?: 'worker' | 'main';
  /** Required (CL-2): an absolute path or `file:` URL of the worker config module. */
  workerConfigModule: string | URL;
  /** Default path `'/open-docex'`. Without `server`, call `engine.attach()` later. */
  http?: { server?: HttpServerLike; path?: string };
  /**
   * Decides each upgrade. `null` refuses with 403; an {@link AuthorizeDenial} refuses with its
   * status; a throw gives HTTP 500 and an `ACCESS_DENIED` error event.
   */
  authorize(
    ctx: AuthorizeContext,
  ): AuthorizeResult | AuthorizeDenial | null | Promise<AuthorizeResult | AuthorizeDenial | null>;
  /** An optional per-change gate. */
  canSubmit?(session: Session): boolean | Promise<boolean>;
  supervisor?: SupervisorOptions;
  /** Default 8 MiB (HLD §11.4). */
  send?: { highWaterMarkBytes?: number };
  ws?: {
    /** Default 16 MiB (LLD choice). */
    maxPayloadBytes?: number;
    /** Default 30 000 (LLD choice: detects dead TCP connections). */
    pingIntervalMs?: number;
    /** Default 30 000 (LLD choice). */
    helloTimeoutMs?: number;
  };
  /** Default: a no-op logger (HLD §15). */
  logger?: Logger;
  /** Default `'info'`. The Core does not forward lower levels over IPC. */
  logLevel?: LogLevel;
}

/** The worker config module's default export (LLD Part 2 §2.3, CL-2, HLD §12). */
export interface WorkerConfig {
  /** Absent: `LocalFsStorage(<dataDir>/local-storage)` is the primary storage [§4]. */
  storage?: StorageAdapter;
  /** Default `path.resolve(process.cwd(), 'open-docex-data')` (CL-14). */
  dataDir?: string;
  /** Default `{ type: 'memory', perDocument: 1000, global: 50000 }`. */
  queue?: MemoryQueueConfig;
  /** Default `'interval'` every 1 000 ms. */
  journal?: { fsync?: 'interval' | 'always'; fsyncIntervalMs?: number };
  /** Default 500. */
  snapshot?: { everyOps?: number };
  /** Default 30 000 / 300 000 ms. */
  flush?: { quietMs?: number; maxIntervalMs?: number };
  /** Default `[60000, 300000, 900000]` [A4]. */
  recovery?: { retryDelaysMs?: readonly [number, number, number] };
  /** Default: auto-detect / 2 / 120 000 ms. */
  libreoffice?: { path?: string; maxConcurrent?: number; timeoutMs?: number };
  /** Default 1. */
  codecThreads?: number;
  /** Default 200 text blocks / 500 sheet rows / 262 144 bytes per chunk. */
  load?: { chunk?: { textBlocks?: number; sheetRows?: number; maxBytes?: number } };
  /** Default 52 428 800 bytes (50 MiB). */
  limits?: { maxFileBytes?: number };
  /** Page settings for new blank text documents. Default A4 portrait, 2.54 cm margins (PO-26, R-20). */
  blankDocument?: { page?: PageSettings };
}

/**
 * Declares the worker config module's default export: `export default defineWorkerConfig({...})`.
 * An identity function that exists for type inference; it returns `config` unchanged.
 */
export function defineWorkerConfig(config: WorkerConfig): WorkerConfig {
  return config;
}

/** {@link SupervisorOptions} with every default filled in. */
export type ResolvedSupervisorOptions = Readonly<Required<SupervisorOptions>>;

/** {@link EngineOptions} after `validateEngineOptions`, with every default filled in. */
export interface ResolvedEngineOptions {
  readonly mode: 'worker' | 'main';
  /** The worker config module as an absolute file path. */
  readonly workerConfigModule: string;
  readonly http: { readonly server?: HttpServerLike; readonly path: string };
  readonly authorize: EngineOptions['authorize'];
  readonly canSubmit?: NonNullable<EngineOptions['canSubmit']>;
  readonly supervisor: ResolvedSupervisorOptions;
  readonly send: { readonly highWaterMarkBytes: number };
  readonly ws: { readonly maxPayloadBytes: number; readonly pingIntervalMs: number; readonly helloTimeoutMs: number };
  readonly logger: Logger;
  readonly logLevel: LogLevel;
}

/** {@link WorkerConfig} after `resolveWorkerConfig`, with every default filled in. */
export interface ResolvedWorkerConfig {
  /** Absent: the built-in local storage is primary. */
  readonly storage?: StorageAdapter;
  /** Absolute. */
  readonly dataDir: string;
  readonly queue: { readonly type: 'memory'; readonly perDocument: number; readonly global: number };
  readonly journal: { readonly fsync: 'interval' | 'always'; readonly fsyncIntervalMs: number };
  readonly snapshot: { readonly everyOps: number };
  readonly flush: { readonly quietMs: number; readonly maxIntervalMs: number };
  readonly recovery: { readonly retryDelaysMs: readonly [number, number, number] };
  /** `path` absent: auto-detect. */
  readonly libreoffice: { readonly path?: string; readonly maxConcurrent: number; readonly timeoutMs: number };
  readonly codecThreads: number;
  readonly load: { readonly chunk: { readonly textBlocks: number; readonly sheetRows: number; readonly maxBytes: number } };
  readonly limits: { readonly maxFileBytes: number };
  readonly blankDocument: { readonly page: PageSettings };
}
