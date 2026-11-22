import { ERROR_CATALOGUE, OpenDocexError, type ErrorCode } from '@open-docex/shared/errors';
import { describe, expect, it } from 'vitest';
import { engineError } from '../../../src/errors/engine-error.js';

describe('engineError', () => {
  it.each(Object.keys(ERROR_CATALOGUE) as ErrorCode[])('fills %s from the catalogue', (code) => {
    const e = engineError(code);
    const entry = ERROR_CATALOGUE[code];
    expect(e).toBeInstanceOf(OpenDocexError);
    expect(e.code).toBe(code);
    expect(e.category).toBe(entry.category);
    expect(e.retryable).toBe(entry.retryable);
    expect(e.severity).toBe(entry.severity);
    expect(e.remediation).toBe(entry.remediation);
    expect(e.message).toBe(entry.clientMessage);
  });

  it('carries message, documentId, instanceId and cause', () => {
    const cause = new Error('boom');
    const e = engineError('DOCUMENT_FAULTED', { message: 'm', documentId: 'd', instanceId: 'i', cause });
    expect(e.message).toBe('m');
    expect(e.documentId).toBe('d');
    expect(e.instanceId).toBe('i');
    expect(e.cause).toBe(cause);
  });

  it('omits fields that are not given', () => {
    const e = engineError('CONFIG_INVALID', {});
    expect(e.documentId).toBeUndefined();
    expect(e.instanceId).toBeUndefined();
    expect(e.cause).toBeUndefined();
  });
});
