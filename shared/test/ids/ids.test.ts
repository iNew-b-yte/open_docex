import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenDocexError } from '../../src/errors/index.js';
import {
  asDocumentId,
  computeAssetId,
  isAssetId,
  isClientId,
  isEpoch,
  newClientId,
  newEpoch,
  newRandomId,
} from '../../src/ids/index.js';

const FORMAT = /^[A-Za-z0-9_-]{22}$/;

describe('random ids', () => {
  it.each([
    ['newClientId', newClientId],
    ['newEpoch', newEpoch],
    ['newRandomId', newRandomId],
  ])('%s returns 22 base64url characters', (_name, make) => {
    expect(make()).toMatch(FORMAT);
  });

  it('generates 100 000 ids with no duplicates', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100_000; i++) seen.add(newRandomId());
    expect(seen.size).toBe(100_000);
  });

  it('isClientId and isEpoch accept the format and reject anything else', () => {
    expect(isClientId(newClientId())).toBe(true);
    expect(isEpoch(newEpoch())).toBe(true);
    for (const bad of ['', 'a'.repeat(21), 'a'.repeat(23), `${'a'.repeat(21)}+`, `${'a'.repeat(21)}=`, 22, null, undefined]) {
      expect(isClientId(bad)).toBe(false);
      expect(isEpoch(bad)).toBe(false);
    }
  });
});

describe('isAssetId', () => {
  it('accepts 64 lowercase hex characters only', () => {
    expect(isAssetId('0123456789abcdef'.repeat(4))).toBe(true);
    expect(isAssetId('0123456789ABCDEF'.repeat(4))).toBe(false);
    expect(isAssetId('a'.repeat(63))).toBe(false);
    expect(isAssetId('a'.repeat(65))).toBe(false);
    expect(isAssetId('g'.repeat(64))).toBe(false);
    expect(isAssetId(undefined)).toBe(false);
  });
});

describe('computeAssetId', () => {
  // FIPS 180-2 SHA-256 test vectors.
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ])('hashes %j to its lowercase hex SHA-256', async (input, expected) => {
    const id = await computeAssetId(new TextEncoder().encode(input));
    expect(id).toBe(expected);
    expect(isAssetId(id)).toBe(true);
  });

  it('does not mutate its input', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await computeAssetId(bytes);
    expect([...bytes]).toEqual([1, 2, 3]);
  });
});

describe('asDocumentId', () => {
  const rejects = (raw: string): void => {
    let thrown: unknown;
    try {
      asDocumentId(raw);
    } catch (e) {
      thrown = e;
    }
    expect(OpenDocexError.is(thrown, 'PROTOCOL_INVALID_MESSAGE')).toBe(true);
  };

  it('accepts 1 and 1024 code units', () => {
    expect(asDocumentId('a')).toBe('a');
    const max = 'x'.repeat(1024);
    expect(asDocumentId(max)).toBe(max);
  });

  it('rejects empty and 1025 code units', () => {
    rejects('');
    rejects('x'.repeat(1025));
  });

  it('rejects C0 control characters', () => {
    rejects('\u0000');
    rejects('doc\u0000id');
    rejects('doc\nid');
    rejects('\u001f');
  });

  it('accepts other characters, including path-like and non-ASCII text', () => {
    for (const ok of ['../etc/passwd', 'folder/file.docx', 'résumé 😀', '\u007f']) {
      expect(asDocumentId(ok)).toBe(ok);
    }
  });
});

describe('isomorphism', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // shared/src cannot import `node:crypto` (lint forbids Node built-ins there and env.d.ts
  // declares only Web Crypto), so randomness and hashing must come from `globalThis.crypto`.
  it('draws random bytes from globalThis.crypto.getRandomValues', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((a) => {
      (a as Uint8Array).fill(0xff);
      return a;
    });
    expect(newRandomId()).toBe('_'.repeat(21) + 'w');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('hashes with globalThis.crypto.subtle.digest', async () => {
    const spy = vi.spyOn(globalThis.crypto.subtle, 'digest');
    await computeAssetId(new Uint8Array([1]));
    expect(spy).toHaveBeenCalledWith('SHA-256', expect.any(Uint8Array));
  });
});
