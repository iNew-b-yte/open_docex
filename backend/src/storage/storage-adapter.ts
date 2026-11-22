/**
 * The `StorageAdapter` port (LLD Part 2 §11.1, HLD PO-8, [A5]). Adopters implement it to
 * connect the engine to their own storage; `LocalFsStorage` is the built-in implementation.
 *
 * This file is a frozen contract (AGENTS.md §2): it changes only through an approved
 * HLD/LLD update.
 *
 * Rules for adapter authors:
 * - `write` must compare `expectedVersion` with the current version and return a conflict
 *   when they differ. `null` means the target must not exist.
 * - Any throw counts as a failure: `STORAGE_READ_FAILED` or `STORAGE_WRITE_FAILED`, with the
 *   throw as `cause`.
 * - The engine aborts every call after {@link STORAGE_CALL_TIMEOUT_MS} and treats the abort
 *   as a failure.
 *
 * @module
 */
import type { DocKind, FileFormat } from '@open-docex/shared/protocol';

/** A JSON value. Refs are made of these so that they survive IPC and JSON. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** Adopter-defined and opaque to the engine. Must survive IPC and JSON. */
export type StorageRef = string | { readonly [k: string]: JsonValue };

/**
 * An ETag, version id or similar. The engine compares versions only for equality. It must
 * change whenever the content changes.
 */
export type StorageVersion = string;

/** The result of {@link StorageAdapter.stat}. */
export interface StorageStat {
  version: StorageVersion;
  /** Size in bytes. */
  size: number;
}

/** The result of {@link StorageAdapter.read}. */
export interface StorageReadResult {
  bytes: Uint8Array;
  version: StorageVersion;
}

/** The result of {@link StorageAdapter.write}: the new version, or a version conflict. */
export type StorageWriteResult =
  | { ok: true; version: StorageVersion }
  | { ok: false; reason: 'conflict'; currentVersion?: StorageVersion };

/** What {@link StorageAdapter.create} stores. */
export interface StorageCreateInput {
  kind: DocKind;
  format: FileFormat;
  /** A display name. Adapters must not trust it as a path. */
  name: string;
  bytes: Uint8Array;
}

/** The storage port the engine calls to load and save documents. */
export interface StorageAdapter {
  /** Reads the whole document. `null` means not found. Must not return more than `maxBytes`. */
  read(ref: StorageRef, o: { signal: AbortSignal; maxBytes: number }): Promise<StorageReadResult | null>;
  /**
   * Writes the document if its current version equals `expectedVersion` (`null`: the target
   * must not exist); otherwise returns a conflict and leaves the content unchanged.
   */
  write(
    ref: StorageRef,
    bytes: Uint8Array,
    o: { expectedVersion: StorageVersion | null; signal: AbortSignal },
  ): Promise<StorageWriteResult>;
  /** The current version and size. `null` means not found. */
  stat(ref: StorageRef, o: { signal: AbortSignal }): Promise<StorageStat | null>;
  /** Stores a new document and returns its ref and version. */
  create(input: StorageCreateInput, o: { signal: AbortSignal }): Promise<{ ref: StorageRef; version: StorageVersion }>;
}

/** The engine aborts every storage call after this many milliseconds (LLD Part 2 §11.1, LLD choice). */
export const STORAGE_CALL_TIMEOUT_MS = 60_000;
