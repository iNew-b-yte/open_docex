/**
 * Random bytes and base64url (LLD Part 1 §2, Utilities).
 *
 * @module
 */

/**
 * Returns `n` cryptographically random bytes from `globalThis.crypto.getRandomValues`.
 *
 * `getRandomValues` is used rather than `randomUUID` because it also works in insecure
 * browser contexts (LLD Part 1 §0). It accepts at most 65,536 bytes per call.
 */
export function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function char(sextet: number): string {
  return ALPHABET.charAt(sextet & 63);
}

/**
 * Encodes `b` as base64url (RFC 4648 §5) without `=` padding, so 16 bytes give 22 characters.
 */
export function base64url(b: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
    out += char(n >> 18) + char(n >> 12) + char(n >> 6) + char(n);
  }
  const rest = b.length - i;
  if (rest === 1) {
    const n = b[i]! << 16;
    out += char(n >> 18) + char(n >> 12);
  } else if (rest === 2) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8);
    out += char(n >> 18) + char(n >> 12) + char(n >> 6);
  }
  return out;
}
