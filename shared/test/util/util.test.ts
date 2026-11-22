import { describe, expect, it } from 'vitest';
import { base64url, canonicalJson, randomBytes, utf8Length } from '../../src/util/index.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}',
    );
  });

  it('gives equal strings for structurally equal values with different key order', () => {
    expect(canonicalJson({ x: 1, y: [1, 2] })).toBe(canonicalJson({ y: [1, 2], x: 1 }));
  });

  it('keeps array order and follows JSON.stringify for undefined members', () => {
    expect(canonicalJson([3, 1, undefined])).toBe('[3,1,null]');
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
  });

  it('serializes primitives like JSON.stringify', () => {
    expect(canonicalJson('s')).toBe('"s"');
    expect(canonicalJson(1.5)).toBe('1.5');
    expect(canonicalJson(null)).toBe('null');
  });

  it('keeps a __proto__ member as data and does not mutate the input', () => {
    const input = JSON.parse('{"b":1,"__proto__":{"x":1}}') as object;
    const before = JSON.stringify(input);
    expect(canonicalJson(input)).toBe('{"__proto__":{"x":1},"b":1}');
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('utf8Length', () => {
  const cases = ['', 'abc', 'é', '€', '😀', 'a€😀é', '\ud800', '\udc00x', '\ud800\ud800'];
  it.each(cases)('matches TextEncoder for %j', (s) => {
    expect(utf8Length(s)).toBe(new TextEncoder().encode(s).length);
  });
});

describe('randomBytes', () => {
  it('returns the requested number of bytes', () => {
    expect(randomBytes(0)).toHaveLength(0);
    expect(randomBytes(16)).toHaveLength(16);
  });

  it('returns different values on each call', () => {
    expect(base64url(randomBytes(16))).not.toBe(base64url(randomBytes(16)));
  });
});

describe('base64url', () => {
  // RFC 4648 §10 test vectors, unpadded, in the URL-safe alphabet.
  it.each([
    ['', ''],
    ['f', 'Zg'],
    ['fo', 'Zm8'],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg'],
    ['fooba', 'Zm9vYmE'],
    ['foobar', 'Zm9vYmFy'],
  ])('encodes %j as %j', (input, expected) => {
    expect(base64url(new TextEncoder().encode(input))).toBe(expected);
  });

  it('uses - and _ instead of + and /', () => {
    expect(base64url(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe('-_-_');
  });

  it('encodes 16 bytes as 22 characters', () => {
    expect(base64url(new Uint8Array(16))).toHaveLength(22);
  });
});
