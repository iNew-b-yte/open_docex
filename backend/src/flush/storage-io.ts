/**
 * Export and storage-call helpers shared by `FlushScheduler` and `RecoveryManager` (LLD Part 2
 * §12, §13).
 *
 * - {@link exportSnapshot}: `codec.export({ kind, format, model: ot.serializeSnapshot(model),
 *   assetDir })` for one instance snapshot.
 * - {@link callStorage}: runs one adapter call with the {@link STORAGE_CALL_TIMEOUT_MS} abort
 *   (§11.1, S-28: callers enforce it).
 *
 * @module
 */
import { OpenDocexError, type ErrorCode } from '@open-docex/shared/errors';
import type { DocumentId } from '@open-docex/shared/ids';
import type { DocKind, FileFormat } from '@open-docex/shared/protocol';
import { TextOtType, type TextSnapshot } from '@open-docex/shared/text';
import type { Clock, FlushTarget } from '../core/seams.js';
import { engineError } from '../errors/engine-error.js';
import { assetsDir } from '../persistence/layout.js';
import { STORAGE_CALL_TIMEOUT_MS, type StorageAdapter, type StorageRef } from '../storage/storage-adapter.js';

/**
 * The export half of `CodecService` (LLD Part 2 §14.1). `CodecSeam` (core/seams.ts) has only
 * the import side, so flush and recovery take the codec through this interface.
 */
export interface CodecExport {
  /** Returns the file bytes. Throws `CONVERSION_FAILED` or `CONVERSION_TIMEOUT`. */
  export(i: { kind: DocKind; format: FileFormat; model: unknown; assetDir: string }): Promise<Uint8Array>;
}

/** Routes a ref to its adapter. `StorageRouter` implements it. */
export interface StorageRoute {
  route(ref: StorageRef): StorageAdapter;
}

/**
 * `ot.serializeSnapshot(model)` for `kind`. V1 has only the text kind.
 *
 * @throws {OpenDocexError} `DOCUMENT_UNSUPPORTED_CONTENT` for sheets (V2).
 */
export function serializeModel(kind: DocKind, model: unknown): unknown {
  if (kind === 'text') return TextOtType.serializeSnapshot(model as TextSnapshot);
  throw engineError('DOCUMENT_UNSUPPORTED_CONTENT', { message: 'Spreadsheets need V2.' });
}

/** Exports one snapshot of `t` to file bytes through the codec. */
export async function exportSnapshot(codec: CodecExport, dataDir: string, t: FlushTarget, model: unknown): Promise<Uint8Array> {
  return codec.export({ kind: t.kind, format: t.format, model: serializeModel(t.kind, model), assetDir: assetsDir(dataDir, t.docKey) });
}

/**
 * Runs `fn` with an abort signal that fires after `ms` (default {@link STORAGE_CALL_TIMEOUT_MS}).
 * On timeout the call is aborted and the result rejects with `code`. Any throw from `fn` is
 * wrapped as `code` with the throw as `cause`, unless it already is an `OpenDocexError`.
 */
export async function callStorage<T>(
  clock: Clock,
  code: Extract<ErrorCode, 'STORAGE_READ_FAILED' | 'STORAGE_WRITE_FAILED'>,
  documentId: DocumentId,
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number = STORAGE_CALL_TIMEOUT_MS,
): Promise<T> {
  const ac = new AbortController();
  let timer: unknown;
  const timeout = new Promise<never>((_, reject) => {
    timer = clock.setTimeout(() => {
      ac.abort();
      reject(engineError(code, { documentId, message: 'The storage call timed out.' }));
    }, ms);
  });
  try {
    return await Promise.race([fn(ac.signal), timeout]);
  } catch (err) {
    throw err instanceof OpenDocexError ? err : engineError(code, { documentId, cause: err });
  } finally {
    clock.clearTimeout(timer);
  }
}
