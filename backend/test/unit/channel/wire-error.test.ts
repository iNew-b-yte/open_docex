import { describe, expect, it } from 'vitest';
import { ERROR_CATALOGUE, OpenDocexError } from '@open-docex/shared/errors';
import { fromWire, isWireError, toWire } from '../../../src/channel/wire-error.js';
import { engineError } from '../../../src/errors/engine-error.js';

describe('toWire', () => {
  it('keeps an OpenDocexError code, message, ids and cause message', () => {
    const e = engineError('STORAGE_READ_FAILED', { message: 'read d1', documentId: 'd1', instanceId: 'i1', cause: new Error('EIO') });
    expect(toWire(e, { where: 'boot' })).toEqual({
      code: 'STORAGE_READ_FAILED',
      message: 'read d1',
      documentId: 'd1',
      instanceId: 'i1',
      causeMessage: 'EIO',
    });
  });

  it('accepts a plain error shape after a structured clone (S-17)', () => {
    const shape = structuredClone(engineError('QUEUE_FULL', { documentId: 'd2' }).toShape());
    expect(toWire(shape, { where: 'instance' })).toMatchObject({ code: 'QUEUE_FULL', documentId: 'd2' });
  });

  it('maps a foreign error inside an instance to DOCUMENT_FAULTED', () => {
    expect(toWire(new TypeError('boom'), { where: 'instance', documentId: 'd1', instanceId: 'i1' })).toEqual({
      code: 'DOCUMENT_FAULTED',
      message: ERROR_CATALOGUE.DOCUMENT_FAULTED.clientMessage,
      documentId: 'd1',
      instanceId: 'i1',
      causeMessage: 'boom',
    });
  });

  it('maps a foreign error during boot to CONFIG_INVALID', () => {
    expect(toWire('bad config', { where: 'boot' })).toEqual({
      code: 'CONFIG_INVALID',
      message: ERROR_CATALOGUE.CONFIG_INVALID.clientMessage,
      causeMessage: 'bad config',
    });
  });

  it('maps a foreign error elsewhere with a document to DOCUMENT_FAULTED', () => {
    expect(toWire({ message: 'x' }, { where: 'document', documentId: 'd9' })).toMatchObject({
      code: 'DOCUMENT_FAULTED',
      documentId: 'd9',
      causeMessage: 'x',
    });
  });

  it('produces plain data that survives structured clone', () => {
    const w = toWire(new Error('e'), { where: 'boot' });
    expect(structuredClone(w)).toEqual(w);
  });
});

describe('fromWire', () => {
  it('rebuilds catalogue fields from the code', () => {
    const e = fromWire({ code: 'DOCUMENT_NOT_FOUND', message: 'no such doc', documentId: 'd1', causeMessage: 'ENOENT' });
    expect(e).toBeInstanceOf(OpenDocexError);
    expect(e.code).toBe('DOCUMENT_NOT_FOUND');
    expect(e.message).toBe('no such doc');
    expect(e.documentId).toBe('d1');
    expect(e.cause).toBe('ENOENT');
    expect(e.retryable).toBe(ERROR_CATALOGUE.DOCUMENT_NOT_FOUND.retryable);
    expect(e.remediation).toBe(ERROR_CATALOGUE.DOCUMENT_NOT_FOUND.remediation);
  });

  it('round-trips toWire', () => {
    const src = engineError('ENGINE_RESTARTING', { instanceId: 'i' });
    const back = fromWire(toWire(src, { where: 'boot' }));
    expect(back.toShape()).toEqual(src.toShape());
  });
});

describe('isWireError', () => {
  it('accepts wire errors and rejects others', () => {
    expect(isWireError({ code: 'QUEUE_FULL', message: 'm' })).toBe(true);
    expect(isWireError({ code: 'NOPE', message: 'm' })).toBe(false);
    expect(isWireError({ code: 'QUEUE_FULL' })).toBe(false);
    expect(isWireError({ code: 'QUEUE_FULL', message: 'm', documentId: 1 })).toBe(false);
    expect(isWireError({ code: 'toString', message: 'm' })).toBe(false);
    expect(isWireError(null)).toBe(false);
  });
});
