// Types for `suite-env.mjs`, so the TypeScript tests can import it.
import type { WorkerConfig } from '../../../src/api/options.js';
import type { WiredCodec } from '../../../src/core/core-entry.js';
import type { StorageAdapter } from '../../../src/storage/storage-adapter.js';

/** What a test hands to the Core: folders and `WorkerConfig` overrides. */
export interface SuiteSettings {
  dataDir: string;
  storageRoot: string;
  /** The folder of the flag files. */
  ctlDir: string;
  config?: WorkerConfig;
}

export function flagOn(ctlDir: string, name: string): boolean;
export function createControlledStorage(inner: StorageAdapter, ctlDir: string): StorageAdapter;
export function textOfModel(model: unknown): string;
export function createSuiteCodec(o: { textSchema: unknown; page: unknown; ctlDir: string }): WiredCodec;
export function buildWorkerConfig(o: {
  LocalFsStorage: new (o: { root: string }) => StorageAdapter;
  settings: SuiteSettings;
}): WorkerConfig;
