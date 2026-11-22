/**
 * UTF-8 size measurement (LLD Part 1 §2, Utilities).
 *
 * @module
 */

/**
 * Returns the number of bytes `s` occupies when encoded as UTF-8, without allocating.
 *
 * The count matches `new TextEncoder().encode(s).length`: a lone surrogate counts as the
 * 3 bytes of U+FFFD, which is what `TextEncoder` writes in its place.
 */
export function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      bytes += 1;
    } else if (c < 0x800) {
      bytes += 2;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
