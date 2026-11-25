/**
 * `@open-docex/server`: the open_docex engine for Node.js (LLD Part 2 §2.1).
 *
 * ```ts
 * const engine = await createEngine({
 *   workerConfigModule: new URL('./worker-config.js', import.meta.url),
 *   http: { server },
 *   authorize: async ({ request }) => ({ userId, access: 'edit', document: { ref, format: 'docx' } }),
 * });
 * ```
 *
 * @module
 */
export { createEngine } from './api/create-engine.js';
export { defineWorkerConfig } from './api/options.js';
export { LocalFsStorage } from './storage/local-fs-storage.js';
// A re-export so adopters need one import. The subpath keeps ProseMirror out of the main process (N4).
export { OpenDocexError } from '@open-docex/shared/errors';

export type {
  AuthorizeContext,
  AuthorizeDenial,
  AuthorizeResult,
  DocKind,
  EngineOptions,
  FileFormat,
  Logger,
  LogLevel,
  Session,
  WorkerConfig,
} from './api/options.js';
export type { AuditEvent, DocumentEvent, EngineEventMap, EngineStateEvent, StorageEvent } from './api/events.js';
export type {
  CreateDocumentInput,
  Engine,
  EngineState,
  LocalCopy,
  RecoveryEntry,
  RecoveryResolution,
  SessionFilter,
  ShareInfo,
} from './api/engine-facade.js';
export type {
  StorageAdapter,
  StorageCreateInput,
  StorageReadResult,
  StorageRef,
  StorageStat,
  StorageVersion,
  StorageWriteResult,
} from './storage/storage-adapter.js';
