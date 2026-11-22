import { describe, expect, it } from 'vitest';
import { IpcLogger, type LogLine } from '../../../src/log/ipc-logger.js';
import {
  LOG_FIELD_ALLOWLIST,
  LOG_LEVELS,
  levelFilter,
  noopLogger,
  sanitizeFields,
  type LogFields,
  type Logger,
  type LogLevel,
} from '../../../src/log/logger.js';

type Call = [LogLevel, string, LogFields | undefined];

function recorder(): { logger: Logger; calls: Call[] } {
  const calls: Call[] = [];
  const at = (level: LogLevel) => (m: string, f?: LogFields) => {
    calls.push([level, m, f]);
  };
  return { logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }, calls };
}

describe('levelFilter', () => {
  it.each<[LogLevel, LogLevel[]]>([
    ['debug', ['debug', 'info', 'warn', 'error']],
    ['info', ['info', 'warn', 'error']],
    ['warn', ['warn', 'error']],
    ['error', ['error']],
  ])('at %s passes %j', (min, passed) => {
    const { logger, calls } = recorder();
    const filtered = levelFilter(logger, min);
    for (const level of LOG_LEVELS) filtered[level](level);
    expect(calls.map(([level]) => level)).toEqual(passed);
  });

  it('passes allowlisted fields unchanged', () => {
    const { logger, calls } = recorder();
    levelFilter(logger, 'debug').info('m', { documentId: 'd', rev: 3 });
    expect(calls).toEqual([['info', 'm', { documentId: 'd', rev: 3 }]]);
  });

  it('calls without fields when none are given', () => {
    const { logger, calls } = recorder();
    levelFilter(logger, 'debug').warn('m');
    expect(calls).toEqual([['warn', 'm', undefined]]);
  });

  it('throws on an unknown field key in tests', () => {
    const { logger } = recorder();
    expect(() => levelFilter(logger, 'debug').info('m', { token: 'secret' })).toThrow(/token/);
  });
});

describe('sanitizeFields', () => {
  it('accepts every allowlisted key', () => {
    const fields = Object.fromEntries([...LOG_FIELD_ALLOWLIST].map((k) => [k, 1]));
    expect(sanitizeFields(fields, true)).toEqual(fields);
  });

  it.each(['authorization', 'cookie', 'query', 'token', 'bytes', 'ops'])('drops %s in production', (key) => {
    expect(sanitizeFields({ documentId: 'd', [key]: 'x' }, false)).toEqual({ documentId: 'd' });
  });

  it('does not mutate the input', () => {
    const fields = { documentId: 'd', token: 't' };
    sanitizeFields(fields, false);
    expect(fields).toEqual({ documentId: 'd', token: 't' });
  });

  it('throws on an unknown key when strict', () => {
    expect(() => sanitizeFields({ cookie: 'c' }, true)).toThrow(/cookie/);
  });

  it('is strict by default under Vitest', () => {
    expect(() => sanitizeFields({ cookie: 'c' })).toThrow();
  });
});

describe('noopLogger', () => {
  it('discards every line', () => {
    for (const level of LOG_LEVELS) expect(noopLogger[level]('m', { rev: 1 })).toBeUndefined();
  });
});

describe('IpcLogger', () => {
  it('drops lines below logLevel and posts the rest', () => {
    const lines: LogLine[] = [];
    const log = new IpcLogger((l) => lines.push(l), 'warn');
    log.debug('a');
    log.info('b');
    log.warn('c', { code: 'QUEUE_FULL' });
    log.error('d');
    expect(lines).toEqual([
      { type: 'log', level: 'warn', msg: 'c', fields: { code: 'QUEUE_FULL' } },
      { type: 'log', level: 'error', msg: 'd' },
    ]);
  });

  it('applies the allowlist before posting', () => {
    const log = new IpcLogger(() => {}, 'debug');
    expect(() => log.error('m', { headers: 'h' })).toThrow(/headers/);
  });
});
