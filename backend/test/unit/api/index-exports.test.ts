// The public surface of `@open-docex/server` (LLD Part 2 §2.1, §0 S-28): four values and the types.
import { OpenDocexError } from '@open-docex/shared/errors';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as api from '../../../src/index.js';
import type {
  AuditEvent,
  AuthorizeContext,
  AuthorizeDenial,
  AuthorizeResult,
  CreateDocumentInput,
  DocKind,
  DocumentEvent,
  Engine,
  EngineEventMap,
  EngineOptions,
  EngineStateEvent,
  FileFormat,
  LocalCopy,
  Logger,
  LogLevel,
  RecoveryEntry,
  RecoveryResolution,
  Session,
  SessionFilter,
  ShareInfo,
  StorageAdapter,
  StorageCreateInput,
  StorageEvent,
  StorageReadResult,
  StorageRef,
  StorageStat,
  StorageVersion,
  StorageWriteResult,
  WorkerConfig,
} from '../../../src/index.js';
import { LocalFsStorage } from '../../../src/storage/local-fs-storage.js';

describe('index.ts', () => {
  it('exports exactly createEngine, defineWorkerConfig, LocalFsStorage and OpenDocexError as values', () => {
    expect(Object.keys(api).sort()).toEqual(['LocalFsStorage', 'OpenDocexError', 'createEngine', 'defineWorkerConfig']);
    expect(typeof api.createEngine).toBe('function');
  });

  it('re-exports the shared OpenDocexError class itself, so adopters need one import', () => {
    expect(api.OpenDocexError).toBe(OpenDocexError);
    expect(api.OpenDocexError.is(new OpenDocexError('CONFIG_INVALID'))).toBe(true);
  });

  it('exports LocalFsStorage (S-28)', () => {
    expect(api.LocalFsStorage).toBe(LocalFsStorage);
  });

  it('defineWorkerConfig returns its argument unchanged', () => {
    const config = { dataDir: '/data' };
    expect(api.defineWorkerConfig(config)).toBe(config);
  });

  it('exports the public types of LLD §2.1', () => {
    expectTypeOf<Engine['state']>().toEqualTypeOf<'starting' | 'running' | 'restarting' | 'failed' | 'stopping' | 'stopped'>();
    expectTypeOf<RecoveryResolution>().toEqualTypeOf<'overwrite-storage' | 'discard-local' | 'mark-resolved'>();
    expectTypeOf<ShareInfo['sessions']>().toEqualTypeOf<{ edit: number; view: number }>();
    expectTypeOf<AuthorizeContext['purpose']>().toEqualTypeOf<'document'>();
    expectTypeOf<AuthorizeDenial>().toEqualTypeOf<{ deny: 401 | 403 }>();
    expectTypeOf<DocKind>().toEqualTypeOf<'text' | 'sheet'>();
    expectTypeOf<FileFormat>().toEqualTypeOf<'docx' | 'odt' | 'xlsx' | 'ods'>();
    expectTypeOf<LogLevel>().toEqualTypeOf<'debug' | 'info' | 'warn' | 'error'>();
    // These only have to exist and be importable.
    expectTypeOf<
      [
        AuditEvent,
        AuthorizeResult,
        CreateDocumentInput,
        DocumentEvent,
        EngineEventMap,
        EngineOptions,
        EngineStateEvent,
        LocalCopy,
        Logger,
        RecoveryEntry,
        Session,
        SessionFilter,
        StorageAdapter,
        StorageCreateInput,
        StorageEvent,
        StorageReadResult,
        StorageRef,
        StorageStat,
        StorageVersion,
        StorageWriteResult,
        WorkerConfig,
      ]
    >().not.toBeNever();
  });
});
