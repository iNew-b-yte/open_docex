import { describe, expect, it } from 'vitest';
import { OpenDocexError } from '../../src/errors/index.js';
import {
  decodeClientMessage,
  decodeServerMessage,
  encodeMessage,
  type ClientMessage,
  type DecodeResult,
  type ServerMessage,
} from '../../src/protocol/index.js';
import { ALL_TYPES, expectedOf, frameOf, loadFixtures, type FixtureCase } from './fixtures.js';

function decodeFor(c: FixtureCase, data: string | Uint8Array): DecodeResult<ClientMessage | ServerMessage> {
  return c.direction === 'client' ? decodeClientMessage(data) : decodeServerMessage(data);
}

describe.each(ALL_TYPES)('protocol fixtures: %s', (type) => {
  it('has valid and invalid fixtures', async () => {
    expect((await loadFixtures('valid', type)).length).toBeGreaterThan(0);
    expect((await loadFixtures('invalid', type)).length).toBeGreaterThan(0);
  });

  it('decodes every valid fixture to the expected message, and re-encodes it losslessly', async () => {
    for (const c of await loadFixtures('valid', type)) {
      expect(c.message['type'], c.name).toBe(type);
      const result = decodeFor(c, frameOf(c));
      expect(result, c.name).toEqual({ kind: 'message', message: expectedOf(c) });
      if (result.kind !== 'message') continue;
      const encoded = encodeMessage(result.message);
      expect(typeof encoded === 'string' ? 'text' : 'binary', c.name).toBe(c.frame);
      expect(decodeFor(c, encoded), c.name).toEqual(result);
    }
  });

  it('rejects every invalid fixture with PROTOCOL_INVALID_MESSAGE', async () => {
    for (const c of await loadFixtures('invalid', type)) {
      const result = decodeFor(c, frameOf(c));
      expect(result.kind, c.name).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.error).toBeInstanceOf(OpenDocexError);
        expect(result.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      }
    }
  });
});
