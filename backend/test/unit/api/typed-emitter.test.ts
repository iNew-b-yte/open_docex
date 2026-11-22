import { describe, expect, it } from 'vitest';
import { TypedEmitter } from '../../../src/api/typed-emitter.js';
import { engineError } from '../../../src/errors/engine-error.js';
import type { OpenDocexError } from '@open-docex/shared/errors';
import type { LogFields, Logger } from '../../../src/log/logger.js';

type Events = { error: OpenDocexError; tick: number };

function recordingLogger(): { logger: Logger; errors: [string, LogFields | undefined][] } {
  const errors: [string, LogFields | undefined][] = [];
  const none = (): void => {};
  return {
    logger: { debug: none, info: none, warn: none, error: (m, f) => errors.push([m, f]) },
    errors,
  };
}

describe('TypedEmitter', () => {
  it('calls listeners in order with the payload', () => {
    const em = new TypedEmitter<Events>(recordingLogger().logger);
    const seen: string[] = [];
    em.on('tick', (n) => seen.push(`a${n}`));
    em.on('tick', (n) => seen.push(`b${n}`));
    expect(em.emit('tick', 1)).toBe(true);
    expect(seen).toEqual(['a1', 'b1']);
  });

  it('on returns an unsubscribe function, and off removes a listener', () => {
    const em = new TypedEmitter<Events>(recordingLogger().logger);
    const seen: number[] = [];
    const fn = (n: number): void => {
      seen.push(n);
    };
    const un = em.on('tick', fn);
    un();
    expect(em.emit('tick', 1)).toBe(false);
    em.on('tick', fn);
    em.off('tick', fn);
    em.off('tick', fn);
    expect(em.listenerCount('tick')).toBe(0);
    expect(seen).toEqual([]);
  });

  it('logs an error event with no listener instead of throwing', () => {
    const { logger, errors } = recordingLogger();
    const em = new TypedEmitter<Events>(logger);
    expect(() => em.emit('error', engineError('QUEUE_FULL'))).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[1]).toEqual({ code: 'QUEUE_FULL' });
  });

  it('does not log other events with no listener', () => {
    const { logger, errors } = recordingLogger();
    expect(new TypedEmitter<Events>(logger).emit('tick', 1)).toBe(false);
    expect(errors).toEqual([]);
  });

  it('catches and logs a listener exception, and still calls the other listeners', () => {
    const { logger, errors } = recordingLogger();
    const em = new TypedEmitter<Events>(logger);
    const seen: number[] = [];
    em.on('tick', () => {
      throw new Error('bad listener');
    });
    em.on('tick', (n) => seen.push(n));
    expect(() => em.emit('tick', 7)).not.toThrow();
    expect(seen).toEqual([7]);
    expect(errors[0]?.[0]).toMatch(/bad listener/);
  });

  it('never throws even when the logger throws', () => {
    const boom = (): void => {
      throw new Error('logger down');
    };
    const em = new TypedEmitter<Events>({ debug: boom, info: boom, warn: boom, error: boom });
    em.on('tick', () => {
      throw new Error('x');
    });
    expect(() => em.emit('tick', 1)).not.toThrow();
    expect(() => em.emit('error', engineError('ENGINE_FAILED'))).not.toThrow();
  });

  it('a listener that unsubscribes during emit does not disturb the current emit', () => {
    const em = new TypedEmitter<Events>(recordingLogger().logger);
    const seen: string[] = [];
    const un = em.on('tick', () => {
      seen.push('a');
      un();
    });
    em.on('tick', () => seen.push('b'));
    em.emit('tick', 1);
    em.emit('tick', 2);
    expect(seen).toEqual(['a', 'b', 'b']);
  });
});
