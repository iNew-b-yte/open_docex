import { describe, expect, expectTypeOf, it } from 'vitest';
import type { OpenDocexError } from '@open-docex/shared/errors';
import { asDocumentId, newClientId } from '@open-docex/shared/ids';
import type { AuditEvent, EngineEventMap } from '../../../src/api/events.js';
import type { AuthorizeContext, AuthorizeDenial, EngineOptions } from '../../../src/api/options.js';
import { TypedEmitter } from '../../../src/api/typed-emitter.js';
import { engineError } from '../../../src/errors/engine-error.js';
import type { Logger } from '../../../src/log/logger.js';

function errorLogger(): { logger: Logger; errors: string[] } {
  const errors: string[] = [];
  const none = (): void => {};
  return { logger: { debug: none, info: none, warn: none, error: (m) => errors.push(m) }, errors };
}

describe('EngineEventMap', () => {
  it('has the HLD §15 event names', () => {
    expectTypeOf<keyof EngineEventMap>().toEqualTypeOf<'error' | 'fatal' | 'audit' | 'storage' | 'engine' | 'document'>();
    expectTypeOf<EngineEventMap['error']>().toEqualTypeOf<OpenDocexError>();
  });

  it('works with TypedEmitter, which never throws on an unhandled error event', () => {
    const { logger, errors } = errorLogger();
    const em = new TypedEmitter<EngineEventMap>(logger);
    expect(() => em.emit('error', engineError('CONFIG_INVALID', { message: 'x: bad' }))).not.toThrow();
    expect(errors).toHaveLength(1);

    const seen: AuditEvent[] = [];
    em.on('audit', (e) => seen.push(e));
    const event: AuditEvent = {
      documentId: asDocumentId('doc-1'),
      kind: 'text',
      rev: 2,
      fromRev: 1,
      at: 0,
      userId: 'u',
      clientId: newClientId(),
      clientSeq: 1,
      sessionId: null,
      ops: [],
      replayed: false,
    };
    em.emit('audit', event);
    expect(seen).toEqual([event]);
  });

  it('AuditEvent carries replayed (PO-17, R-19)', () => {
    expectTypeOf<AuditEvent['replayed']>().toEqualTypeOf<boolean>();
  });
});

describe('authorize contract (L-7, S-24, S-25)', () => {
  it('purpose is document in V1', () => {
    expectTypeOf<AuthorizeContext['purpose']>().toEqualTypeOf<'document'>();
  });

  it('may return a denial of 401 or 403, or null', () => {
    expectTypeOf<AuthorizeDenial['deny']>().toEqualTypeOf<401 | 403>();
    expectTypeOf<null>().toExtend<Awaited<ReturnType<EngineOptions['authorize']>>>();
    expectTypeOf<AuthorizeDenial>().toExtend<Awaited<ReturnType<EngineOptions['authorize']>>>();
  });
});
