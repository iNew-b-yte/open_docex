import { describe, expect, it } from 'vitest';
import {
  ERROR_CATALOGUE,
  OpenDocexError,
  toClientError,
  type CatalogueEntry,
  type ErrorCode,
} from '../../src/errors/index.js';

// shared tests compile without @types/node, so the few host APIs used here are typed locally.
interface V8 {
  serialize(v: unknown): Uint8Array;
  deserialize(b: Uint8Array): unknown;
}
const { structuredClone } = globalThis as unknown as { structuredClone<T>(this: void, v: T): T };

// Every code of HLD §11.2, written out so that a missing catalogue entry fails at runtime too.
const HLD_CODES = [
  'CONFIG_INVALID', 'CONFIG_LIBREOFFICE_NOT_FOUND', 'CONFIG_DATA_DIR_UNWRITABLE',
  'STORAGE_READ_FAILED', 'STORAGE_WRITE_FAILED', 'STORAGE_LOCAL_MODE', 'STORAGE_PENDING', 'STORAGE_CONFLICT',
  'QUEUE_FULL', 'QUEUE_UNAVAILABLE',
  'ENGINE_RESTARTING', 'ENGINE_UNAVAILABLE', 'ENGINE_FAILED',
  'DOCUMENT_FAULTED', 'DOCUMENT_UNSUPPORTED_CONTENT', 'DOCUMENT_READ_ONLY', 'DOCUMENT_NOT_FOUND', 'DOCUMENT_TOO_LARGE',
  'CONVERSION_FAILED', 'CONVERSION_TIMEOUT',
  'SESSION_SLOW_CONSUMER', 'SESSION_CLOSED', 'SESSION_RESYNC_REQUIRED',
  'ACCESS_DENIED',
  'PROTOCOL_INVALID_MESSAGE', 'PROTOCOL_VERSION_UNSUPPORTED', 'PROTOCOL_OP_REJECTED',
  'CLIENT_CONNECT_FAILED', 'CLIENT_ASSET_TOO_LARGE', 'CLIENT_IMAGE_TYPE_UNSUPPORTED',
] as const satisfies readonly ErrorCode[];

// Compile-time check: HLD_CODES covers every ErrorCode (fails to compile if one is missing).
type Missing = Exclude<ErrorCode, (typeof HLD_CODES)[number]>;
const noneMissing: [Missing] extends [never] ? true : false = true;

describe('ERROR_CATALOGUE', () => {
  it('has exactly the 30 HLD §11.2 codes', () => {
    expect(noneMissing).toBe(true);
    expect(Object.keys(ERROR_CATALOGUE)).toHaveLength(30);
    expect(Object.keys(ERROR_CATALOGUE).sort()).toEqual([...HLD_CODES].sort());
  });

  it.each(HLD_CODES)('%s has a complete entry', (code) => {
    const e: Readonly<CatalogueEntry> = ERROR_CATALOGUE[code];
    expect(e.remediation.length).toBeGreaterThan(0);
    expect(e.clientMessage.length).toBeGreaterThan(0);
    expect(['info', 'warning', 'error', 'fatal']).toContain(e.severity);
    expect(typeof e.retryable).toBe('boolean');
  });

  it('puts each CLIENT_* code in the client category', () => {
    for (const code of HLD_CODES) {
      expect(ERROR_CATALOGUE[code].category === 'client').toBe(code.startsWith('CLIENT_'));
    }
  });

  it('is frozen, entries included', () => {
    expect(Object.isFrozen(ERROR_CATALOGUE)).toBe(true);
    for (const code of HLD_CODES) expect(Object.isFrozen(ERROR_CATALOGUE[code])).toBe(true);
    expect(() => {
      (ERROR_CATALOGUE.QUEUE_FULL as { retryable: boolean }).retryable = false;
    }).toThrow(TypeError);
  });
});

describe('OpenDocexError', () => {
  it('takes catalogue fields from the code and defaults message to the client message', () => {
    const e = new OpenDocexError('QUEUE_FULL');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('OpenDocexError');
    expect(e.message).toBe(ERROR_CATALOGUE.QUEUE_FULL.clientMessage);
    expect(e).toMatchObject({ code: 'QUEUE_FULL', category: 'queue', retryable: true, severity: 'warning' });
    expect(e.remediation).toBe(ERROR_CATALOGUE.QUEUE_FULL.remediation);
  });

  it('keeps message, ids and cause', () => {
    const cause = new Error('disk gone');
    const e = new OpenDocexError('STORAGE_WRITE_FAILED', 'write failed', { documentId: 'd', instanceId: 'i', cause });
    expect(e.message).toBe('write failed');
    expect(e.documentId).toBe('d');
    expect(e.instanceId).toBe('i');
    expect(e.cause).toBe(cause);
  });

  it('toShape turns cause into a plain { name, message } object', () => {
    const shape = new OpenDocexError('STORAGE_READ_FAILED', 'm', { cause: new TypeError('bad') }).toShape();
    expect(shape.cause).toEqual({ name: 'TypeError', message: 'bad' });
    expect(Object.getPrototypeOf(shape.cause)).toBe(Object.prototype);
    expect(new OpenDocexError('STORAGE_READ_FAILED', 'm', { cause: 'text' }).toShape().cause).toEqual({
      name: 'Error',
      message: 'text',
    });
    expect('cause' in new OpenDocexError('STORAGE_READ_FAILED').toShape()).toBe(false);
  });

  it('round-trips toShape → v8.serialize → deserialize → fromShape', async () => {
    const moduleName = 'node:v8';
    const v8 = (await import(moduleName)) as V8;
    const original = new OpenDocexError('DOCUMENT_FAULTED', 'boom', {
      documentId: 'doc-1',
      instanceId: 'inst-1',
      cause: new RangeError('out of range'),
    });
    const shape = v8.deserialize(v8.serialize(original.toShape())) as ReturnType<OpenDocexError['toShape']>;
    const back = OpenDocexError.fromShape(shape);
    expect(back).toBeInstanceOf(OpenDocexError);
    expect(back.toShape()).toEqual(original.toShape());
  });

  it('is() checks the code and works across a structured clone', () => {
    const e = new OpenDocexError('ACCESS_DENIED');
    expect(OpenDocexError.is(e)).toBe(true);
    expect(OpenDocexError.is(e, 'ACCESS_DENIED')).toBe(true);
    expect(OpenDocexError.is(e, 'QUEUE_FULL')).toBe(false);
    const cloned = structuredClone(e.toShape());
    expect(OpenDocexError.is(cloned, 'ACCESS_DENIED')).toBe(true);
  });

  it('is() rejects other values', () => {
    for (const x of [null, undefined, 'ACCESS_DENIED', 1, new Error('x'), { code: 'NOPE' }, { code: 'ACCESS_DENIED' }]) {
      expect(OpenDocexError.is(x)).toBe(false);
    }
    expect(OpenDocexError.is({ code: '__proto__', category: 'x', retryable: true, severity: 'x', message: '', remediation: '' })).toBe(false);
  });
});

describe('toClientError', () => {
  const secret = 'C:\\data\\secret-path token=abc';

  it('sends only the catalogue client message for an OpenDocexError', () => {
    const err = new OpenDocexError('STORAGE_READ_FAILED', secret, { cause: new Error(secret) });
    const payload = toClientError(err, { clientSeq: 3, reqId: 9 });
    expect(payload).toEqual({
      code: 'STORAGE_READ_FAILED',
      retryable: true,
      message: ERROR_CATALOGUE.STORAGE_READ_FAILED.clientMessage,
      clientSeq: 3,
      reqId: 9,
    });
    expect(JSON.stringify(payload)).not.toContain('secret');
    expect('cause' in payload).toBe(false);
    expect('stack' in payload).toBe(false);
  });

  it.each([new Error(secret), secret, null, undefined, { message: secret, stack: secret }])(
    'maps a non-OpenDocexError value (%j) to DOCUMENT_FAULTED without leaking it',
    (value) => {
      const payload = toClientError(value);
      expect(payload).toEqual({
        code: 'DOCUMENT_FAULTED',
        retryable: false,
        message: ERROR_CATALOGUE.DOCUMENT_FAULTED.clientMessage,
      });
    },
  );

  it('uses ctx.fallback for a non-OpenDocexError value', () => {
    expect(toClientError(new Error(secret), { fallback: 'PROTOCOL_OP_REJECTED' }).code).toBe('PROTOCOL_OP_REJECTED');
  });

  it('sends the generic text for codes not meant to reach a client', () => {
    expect(toClientError(new OpenDocexError('CONFIG_INVALID', secret)).message).toBe(
      'The editing service hit a server problem.',
    );
  });
});
