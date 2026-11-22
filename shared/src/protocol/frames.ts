/**
 * Binary frame layout (LLD Part 1 §5.1):
 *
 * | Offset | Size | Field |
 * |---|---|---|
 * | 0 | 1 | Magic `0xD0` |
 * | 1 | 1 | Layout version `1` |
 * | 2 | 4 | Header length H, uint32 big-endian, 1 ≤ H ≤ 65 536 |
 * | 6 | H | Header: UTF-8 JSON of the message without `bytes` |
 * | 6+H | rest | Payload, which becomes the `bytes` field |
 *
 * @module
 */

/** First byte of every binary frame. */
export const FRAME_MAGIC = 0xd0;
/** Binary frame layout version. */
export const FRAME_VERSION = 1;
/** Bytes before the header: magic, version and the header length. */
export const FRAME_PREFIX_BYTES = 6;
/** Largest allowed header, in bytes. */
export const MAX_FRAME_HEADER_BYTES = 65_536;

/** The parts of a binary frame. `payload` is a view into the frame, not a copy. */
export interface BinaryFrameParts {
  header: Uint8Array;
  payload: Uint8Array;
}

/**
 * Builds a binary frame from a UTF-8 header and a payload. Returns `undefined` when the header
 * length is outside 1…65 536 bytes.
 */
export function writeBinaryFrame(header: Uint8Array, payload: Uint8Array): Uint8Array | undefined {
  const h = header.byteLength;
  if (h < 1 || h > MAX_FRAME_HEADER_BYTES) return undefined;
  const out = new Uint8Array(FRAME_PREFIX_BYTES + h + payload.byteLength);
  out[0] = FRAME_MAGIC;
  out[1] = FRAME_VERSION;
  out[2] = (h >>> 24) & 0xff;
  out[3] = (h >>> 16) & 0xff;
  out[4] = (h >>> 8) & 0xff;
  out[5] = h & 0xff;
  out.set(header, FRAME_PREFIX_BYTES);
  out.set(payload, FRAME_PREFIX_BYTES + h);
  return out;
}

/**
 * Splits a binary frame. Returns `undefined` when the frame is shorter than 6 bytes, the magic
 * or version is wrong, or the header length is outside 1…65 536 or past the end of the frame.
 */
export function readBinaryFrame(data: Uint8Array): BinaryFrameParts | undefined {
  if (data.byteLength < FRAME_PREFIX_BYTES || data[0] !== FRAME_MAGIC || data[1] !== FRAME_VERSION) {
    return undefined;
  }
  const h = ((data[2]! << 24) >>> 0) + (data[3]! << 16) + (data[4]! << 8) + data[5]!;
  if (h < 1 || h > MAX_FRAME_HEADER_BYTES || FRAME_PREFIX_BYTES + h > data.byteLength) return undefined;
  return {
    header: data.subarray(FRAME_PREFIX_BYTES, FRAME_PREFIX_BYTES + h),
    payload: data.subarray(FRAME_PREFIX_BYTES + h),
  };
}

/**
 * Strict UTF-8 decoding of a frame header. Returns `undefined` for malformed UTF-8 (overlong
 * forms, surrogates, code points above U+10FFFF, truncated sequences).
 *
 * Written by hand because shared may use only the globals in `env.d.ts`, which has no
 * `TextDecoder` (LLD Part 1 §1.4).
 */
export function decodeUtf8(b: Uint8Array): string | undefined {
  const units: number[] = [];
  let out = '';
  let i = 0;
  while (i < b.length) {
    const c = b[i]!;
    let cp: number;
    if (c < 0x80) {
      cp = c;
      i += 1;
    } else if (c >= 0xc2 && c <= 0xdf) {
      const c1 = cont(b, i + 1);
      if (c1 < 0) return undefined;
      cp = ((c & 0x1f) << 6) | c1;
      i += 2;
    } else if (c >= 0xe0 && c <= 0xef) {
      const c1 = cont(b, i + 1);
      const c2 = cont(b, i + 2);
      if (c1 < 0 || c2 < 0) return undefined;
      cp = ((c & 0x0f) << 12) | (c1 << 6) | c2;
      if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) return undefined;
      i += 3;
    } else if (c >= 0xf0 && c <= 0xf4) {
      const c1 = cont(b, i + 1);
      const c2 = cont(b, i + 2);
      const c3 = cont(b, i + 3);
      if (c1 < 0 || c2 < 0 || c3 < 0) return undefined;
      cp = ((c & 0x07) << 18) | (c1 << 12) | (c2 << 6) | c3;
      if (cp < 0x10000 || cp > 0x10ffff) return undefined;
      i += 4;
    } else {
      return undefined;
    }
    if (cp >= 0x10000) {
      cp -= 0x10000;
      units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      units.push(cp);
    }
    if (units.length >= 4096) {
      out += String.fromCharCode(...units);
      units.length = 0;
    }
  }
  return out + String.fromCharCode(...units);
}

/** The 6 payload bits of a continuation byte at `i`, or -1. */
function cont(b: Uint8Array, i: number): number {
  const x = b[i];
  return x !== undefined && (x & 0xc0) === 0x80 ? x & 0x3f : -1;
}
