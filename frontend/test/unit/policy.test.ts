import { describe, expect, it } from 'vitest';
import { ERROR_CATALOGUE, type ErrorCode } from '@open-docex/shared/errors';
import {
  connectAttemptsExhausted,
  MAX_FAILED_CONNECT_ATTEMPTS,
  policyFor,
  toClientErrorEvent,
  type ClientPolicy,
  type PolicyInput,
} from '../../src/errors/policy.js';

type Case = [label: string, input: PolicyInput, expected: ClientPolicy];

/** Every row of LLD Part 3 §16, with its `retryable` / `clientSeq` / `reqId` variants. */
const ROWS: Record<ErrorCode, Case[]> = {
  CONFIG_INVALID: [['from server', { code: 'CONFIG_INVALID', retryable: false }, 'terminal']],
  CONFIG_LIBREOFFICE_NOT_FOUND: [['always', { code: 'CONFIG_LIBREOFFICE_NOT_FOUND', retryable: false }, 'terminal']],
  CONFIG_DATA_DIR_UNWRITABLE: [['always', { code: 'CONFIG_DATA_DIR_UNWRITABLE', retryable: false }, 'terminal']],
  STORAGE_READ_FAILED: [
    ['retryable', { code: 'STORAGE_READ_FAILED', retryable: true }, 'reconnect'],
    ['not retryable', { code: 'STORAGE_READ_FAILED', retryable: false }, 'terminal'],
  ],
  STORAGE_WRITE_FAILED: [['always', { code: 'STORAGE_WRITE_FAILED', retryable: true }, 'notice']],
  STORAGE_LOCAL_MODE: [['always', { code: 'STORAGE_LOCAL_MODE', retryable: false }, 'notice']],
  STORAGE_PENDING: [['always', { code: 'STORAGE_PENDING', retryable: false }, 'notice']],
  STORAGE_CONFLICT: [['always', { code: 'STORAGE_CONFLICT', retryable: false }, 'notice']],
  QUEUE_FULL: [['always', { code: 'QUEUE_FULL', retryable: true, clientSeq: 3 }, 'retry-submit']],
  QUEUE_UNAVAILABLE: [
    ['retryable', { code: 'QUEUE_UNAVAILABLE', retryable: true, clientSeq: 3 }, 'retry-submit'],
    ['not retryable', { code: 'QUEUE_UNAVAILABLE', retryable: false }, 'terminal'],
  ],
  ENGINE_RESTARTING: [['always', { code: 'ENGINE_RESTARTING', retryable: true }, 'reconnect']],
  ENGINE_UNAVAILABLE: [['always', { code: 'ENGINE_UNAVAILABLE', retryable: false }, 'terminal']],
  ENGINE_FAILED: [['always', { code: 'ENGINE_FAILED', retryable: false }, 'terminal']],
  DOCUMENT_FAULTED: [
    ['retryable', { code: 'DOCUMENT_FAULTED', retryable: true }, 'reload'],
    ['not retryable', { code: 'DOCUMENT_FAULTED', retryable: false }, 'terminal'],
  ],
  DOCUMENT_UNSUPPORTED_CONTENT: [['always', { code: 'DOCUMENT_UNSUPPORTED_CONTENT', retryable: false }, 'read-only']],
  DOCUMENT_READ_ONLY: [
    ['no submission', { code: 'DOCUMENT_READ_ONLY', retryable: false }, 'read-only'],
    ['on submit', { code: 'DOCUMENT_READ_ONLY', retryable: false, clientSeq: 2 }, 'discard-reload'],
  ],
  DOCUMENT_NOT_FOUND: [['always', { code: 'DOCUMENT_NOT_FOUND', retryable: false }, 'terminal']],
  DOCUMENT_TOO_LARGE: [
    ['on load', { code: 'DOCUMENT_TOO_LARGE', retryable: false }, 'terminal'],
    ['asset request', { code: 'DOCUMENT_TOO_LARGE', retryable: false, reqId: 7 }, 'asset-failed'],
  ],
  CONVERSION_FAILED: [['always', { code: 'CONVERSION_FAILED', retryable: false }, 'terminal']],
  CONVERSION_TIMEOUT: [
    ['retryable', { code: 'CONVERSION_TIMEOUT', retryable: true }, 'reconnect'],
    ['not retryable', { code: 'CONVERSION_TIMEOUT', retryable: false }, 'terminal'],
  ],
  SESSION_SLOW_CONSUMER: [['always', { code: 'SESSION_SLOW_CONSUMER', retryable: true }, 'reload']],
  SESSION_CLOSED: [['always', { code: 'SESSION_CLOSED', retryable: false }, 'terminal']],
  SESSION_RESYNC_REQUIRED: [['always', { code: 'SESSION_RESYNC_REQUIRED', retryable: true }, 'reload']],
  ACCESS_DENIED: [
    ['no submission', { code: 'ACCESS_DENIED', retryable: false }, 'terminal'],
    ['on submit', { code: 'ACCESS_DENIED', retryable: false, clientSeq: 4 }, 'discard-reload'],
  ],
  PROTOCOL_INVALID_MESSAGE: [
    ['no submission', { code: 'PROTOCOL_INVALID_MESSAGE', retryable: false }, 'reload'],
    ['on submit', { code: 'PROTOCOL_INVALID_MESSAGE', retryable: false, clientSeq: 1 }, 'discard-reload'],
  ],
  PROTOCOL_VERSION_UNSUPPORTED: [['always', { code: 'PROTOCOL_VERSION_UNSUPPORTED', retryable: false }, 'terminal']],
  PROTOCOL_OP_REJECTED: [['always', { code: 'PROTOCOL_OP_REJECTED', retryable: false, clientSeq: 5 }, 'discard-reload']],
  CLIENT_CONNECT_FAILED: [['always', { code: 'CLIENT_CONNECT_FAILED', retryable: true }, 'terminal']],
  CLIENT_ASSET_TOO_LARGE: [['always', { code: 'CLIENT_ASSET_TOO_LARGE', retryable: false }, 'asset-failed']],
  CLIENT_IMAGE_TYPE_UNSUPPORTED: [['always', { code: 'CLIENT_IMAGE_TYPE_UNSUPPORTED', retryable: false }, 'asset-failed']],
};

describe('policyFor', () => {
  it('has a row for every catalogue code (30, including CLIENT_*)', () => {
    const codes = Object.keys(ERROR_CATALOGUE);
    expect(codes).toHaveLength(30);
    expect(Object.keys(ROWS).sort()).toEqual([...codes].sort());
    expect(codes.filter((c) => c.startsWith('CLIENT_'))).toHaveLength(3);
  });

  const cases = Object.values(ROWS).flat();
  it.each(cases)('%s: %o → %s', (_label, input, expected) => {
    expect(policyFor(input, 'live')).toBe(expected);
  });

  it('applies the unknown-code rule', () => {
    expect(policyFor({ code: 'SOMETHING_NEW', retryable: true }, 'live')).toBe('reconnect');
    expect(policyFor({ code: 'SOMETHING_NEW', retryable: false }, 'live')).toBe('terminal');
    expect(policyFor({ code: '__proto__', retryable: false }, 'live')).toBe('terminal');
    expect(policyFor({ code: 'toString', retryable: true }, 'live')).toBe('reconnect');
  });
});

describe('L-12 connect failures', () => {
  it('gives up after 5 failed attempts in a row', () => {
    expect(MAX_FAILED_CONNECT_ATTEMPTS).toBe(5);
    expect(connectAttemptsExhausted(0)).toBe(false);
    expect(connectAttemptsExhausted(4)).toBe(false);
    expect(connectAttemptsExhausted(5)).toBe(true);
    expect(connectAttemptsExhausted(6)).toBe(true);
  });

  it('CLIENT_CONNECT_FAILED is terminal and reported as such', () => {
    const input = { code: 'CLIENT_CONNECT_FAILED', retryable: true };
    const policy = policyFor(input, 'connecting');
    expect(toClientErrorEvent(input, policy)).toEqual({
      code: 'CLIENT_CONNECT_FAILED',
      retryable: true,
      message: "Can't connect.",
      terminal: true,
    });
  });
});

describe('toClientErrorEvent', () => {
  it('uses the catalogue message, never the given one', () => {
    const e = { code: 'STORAGE_WRITE_FAILED', retryable: true, message: 'secret path /var/x?token=abc' };
    const out = toClientErrorEvent(e, 'notice');
    expect(out.message).toBe(ERROR_CATALOGUE.STORAGE_WRITE_FAILED.clientMessage);
    expect(out.terminal).toBe(false);
    expect(Object.keys(out).sort()).toEqual(['code', 'message', 'retryable', 'terminal']);
  });

  it('reports an unknown code as PROTOCOL_INVALID_MESSAGE', () => {
    expect(toClientErrorEvent({ code: 'NOPE', retryable: false }, 'terminal').code).toBe('PROTOCOL_INVALID_MESSAGE');
  });
});
