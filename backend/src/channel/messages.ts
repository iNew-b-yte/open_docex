/**
 * The IPC message catalogue between the main process and the Core (LLD Part 2 §6.2).
 *
 * Every message is plain data: it crosses `child_process` IPC with `serialization: 'advanced'`,
 * which keeps `Uint8Array`, `Map` and `BigInt` but drops properties set on built-in objects such
 * as `Error`. Errors therefore always travel as {@link WireError} (see `wire-error.ts`).
 *
 * @module
 */
import type { ErrorCode } from '@open-docex/shared/errors';
import type { DocumentId } from '@open-docex/shared/ids';
import type { FileFormat } from '@open-docex/shared/protocol';
import type { LogFields, LogLevel } from '../log/logger.js';
import type { StorageRef } from '../storage/storage-adapter.js';

/**
 * An error as it crosses IPC. Category, retryable, severity and remediation are not carried:
 * main rebuilds them from the catalogue with `fromWire` (LLD Part 2 §6.2).
 */
export interface WireError {
  code: ErrorCode;
  message: string;
  documentId?: string;
  instanceId?: string;
  /** The message of the original cause, when there was one. */
  causeMessage?: string;
}

/** The Core's boot summary, carried by `ready`. */
export interface BootReport {
  documents: number;
  recovering: number;
  dirty: number;
  queueBacklog: number;
}

/** The engine API methods main forwards to the Core with a `call` message. */
export type ApiMethod =
  | 'documents.create'
  | 'documents.allowUnsupportedEdit'
  | 'documents.info'
  | 'recovery.list'
  | 'recovery.retry'
  | 'recovery.readLocalCopy'
  | 'recovery.resolve'
  | 'audit.enable';

/** Every {@link ApiMethod}, in catalogue order. */
export const API_METHODS: readonly ApiMethod[] = Object.freeze([
  'documents.create',
  'documents.allowUnsupportedEdit',
  'documents.info',
  'recovery.list',
  'recovery.retry',
  'recovery.readLocalCopy',
  'recovery.resolve',
  'audit.enable',
]);

/**
 * Arguments per API method. LLD Part 2 §6.2 types only `audit.enable` here; the other argument
 * shapes belong to the engine facade (V1-19), so they are `unknown` until it narrows them.
 */
export type ApiArgs = {
  'documents.create': unknown;
  'documents.allowUnsupportedEdit': unknown;
  'documents.info': unknown;
  'recovery.list': unknown;
  'recovery.retry': unknown;
  'recovery.readLocalCopy': unknown;
  'recovery.resolve': unknown;
  'audit.enable': { enabled: boolean };
};

/** Results per API method. `unknown` until the engine facade (V1-19) narrows them. */
export type ApiResult = { [M in ApiMethod]: unknown };

/** Core → main hooks (V4). */
export type HookName = 'onUploaded';

/** Why a session leaves a document. */
export type LeaveReason = 'client-closed' | 'slow-consumer' | 'admin' | 'shutdown';

/** Main → Core messages. */
export type CoreRequest =
  | { type: 'init'; id: number; workerConfigModule: string; logLevel: LogLevel }
  | { type: 'ping'; seq: number }
  | {
      type: 'join';
      sessionId: string;
      documentId: DocumentId;
      userId: string;
      access: 'edit' | 'view';
      document: { ref: StorageRef; format: FileFormat };
    }
  | { type: 'frame'; sessionId: string; data: Uint8Array; binary: boolean }
  | { type: 'leave'; sessionId: string; reason: LeaveReason }
  | { type: 'written'; sessionId: string; token: number }
  | { type: 'call'; id: number; method: ApiMethod; args: unknown }
  | { type: 'hook-result'; id: number; ok: true; value: unknown }
  | { type: 'hook-result'; id: number; ok: false; error: WireError }
  | { type: 'shutdown'; id: number; timeoutMs: number };

/** One outbound WebSocket frame for one or more sessions. */
export interface OutFrame {
  sessionIds: string[];
  data: string | Uint8Array;
  binary: boolean;
  /** When set, main answers with `written { token }` once the frame left the socket. */
  token?: number;
}

/** Core → main messages. */
export type CoreEvent =
  | { type: 'ready'; id: number; pid: number; boot: BootReport }
  | { type: 'pong'; seq: number }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: WireError }
  | { type: 'send'; frames: OutFrame[] }
  | { type: 'close'; sessionIds: string[]; code: number; reason: string }
  /** Errors inside payloads are {@link WireError}s. */
  | { type: 'emit'; event: 'error' | 'audit' | 'storage' | 'document'; payload: unknown }
  | { type: 'log'; level: LogLevel; msg: string; fields?: LogFields }
  | { type: 'hook'; id: number; name: HookName; args: unknown };

/** The request types answered through `EngineChannel.request`. */
export type RequestType = 'init' | 'shutdown';

/** The body of each {@link RequestType}; the channel adds `type` and `id`. */
export type RequestBody = {
  init: { workerConfigModule: string; logLevel: LogLevel };
  shutdown: { timeoutMs: number };
};

/** What each {@link RequestType} resolves with: `ready`'s fields for `init`, nothing for `shutdown`. */
export type RequestResult = {
  init: { pid: number; boot: BootReport };
  shutdown: void;
};

/** Core events the channel consumes itself and does not pass to `onEvent` handlers. */
export type ReplyEvent = Extract<CoreEvent, { type: 'ready' | 'result' | 'hook' }>;

/** Core events delivered to `onEvent` handlers. */
export type ForwardedEvent = Exclude<CoreEvent, ReplyEvent>;
