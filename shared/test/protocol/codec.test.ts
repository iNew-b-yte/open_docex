import { describe, expect, it } from 'vitest';
import { ERROR_CATALOGUE, type ErrorCode } from '../../src/errors/index.js';
import {
  CloseCode,
  DOC_QUERY_PARAM,
  PROTOCOL_VERSION,
  WS_SUBPROTOCOL,
  closeCodeFor,
  decodeClientMessage,
  decodeServerMessage,
  encodeMessage,
  isBinaryType,
  type AssetMsg,
  type ClientMessage,
} from '../../src/protocol/index.js';
import { decodeUtf8, readBinaryFrame, writeBinaryFrame } from '../../src/protocol/frames.js';
import { utf8Length } from '../../src/util/index.js';

const CID = 'cLiEnT0123456789abcdef';
const ASSET = '0123456789abcdef'.repeat(4);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function frame(prefix: number[], rest: Uint8Array = new Uint8Array()): Uint8Array {
  const out = new Uint8Array(prefix.length + rest.length);
  out.set(prefix);
  out.set(rest, prefix.length);
  return out;
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

describe('constants', () => {
  it('match LLD §0 R-12 and Part 1 §5.2', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(WS_SUBPROTOCOL).toBe('open-docex.v1');
    expect(DOC_QUERY_PARAM).toBe('doc');
  });
});

describe('isBinaryType', () => {
  it('is true only for the binary-only types', () => {
    expect(isBinaryType('asset-put')).toBe(true);
    expect(isBinaryType('upload-chunk')).toBe(true);
    expect(isBinaryType('asset')).toBe(false);
    expect(isBinaryType('hello')).toBe(false);
    expect(isBinaryType('__proto__')).toBe(false);
  });
});

describe('text frames', () => {
  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"hello"'],
    ['no type', '{"protocol":1}'],
    ['a numeric type', '{"type":1}'],
  ])('rejects %s', (_name, data) => {
    const r = decodeClientMessage(data);
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') expect(r.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
  });

  it('ignores an unknown type in either direction', () => {
    expect(decodeClientMessage('{"type":"future-thing","x":1}')).toEqual({ kind: 'ignored', type: 'future-thing' });
    expect(decodeServerMessage('{"type":"future-thing"}')).toEqual({ kind: 'ignored', type: 'future-thing' });
  });

  it('ignores the other direction’s types', () => {
    expect(decodeClientMessage('{"type":"load-done","rev":1}')).toEqual({ kind: 'ignored', type: 'load-done' });
    expect(decodeServerMessage('{"type":"ping","n":1}')).toEqual({ kind: 'ignored', type: 'ping' });
  });

  it('does not treat Object.prototype keys as message types', () => {
    expect(decodeClientMessage('{"type":"toString"}')).toEqual({ kind: 'ignored', type: 'toString' });
    expect(decodeClientMessage('{"type":"__proto__"}')).toEqual({ kind: 'ignored', type: '__proto__' });
  });

  it('strips __proto__, constructor and prototype keys without polluting prototypes', () => {
    const data = `{"type":"hello","protocol":1,"clientId":"${CID}","__proto__":{"polluted":true},"constructor":1,"prototype":2,"resume":{"__proto__":{"polluted":true},"epoch":"${CID}","rev":0}}`;
    const r = decodeClientMessage(data);
    expect(r).toEqual({
      kind: 'message',
      message: { type: 'hello', protocol: 1, clientId: CID, resume: { epoch: CID, rev: 0 } },
    });
    if (r.kind !== 'message') return;
    expect(Object.prototype.hasOwnProperty.call(r.message, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(r.message)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('rejects an optional field that is null', () => {
    expect(decodeServerMessage('{"type":"ack","clientSeq":1,"rev":0,"committed":null}').kind).toBe('invalid');
  });

  it('reports the failing path but never echoes the input value', () => {
    const r = decodeClientMessage('{"type":"hello","protocol":1,"clientId":"<script>secret-token</script>"}');
    expect(r.kind).toBe('invalid');
    if (r.kind !== 'invalid') return;
    expect(r.error.message).toContain('$.clientId');
    expect(r.error.message).not.toContain('secret-token');
  });

  it('does not mutate the parsed ops but keeps their content', () => {
    const msg = { type: 'submit', clientId: CID, clientSeq: 1, epoch: CID, baseRev: 0, ops: [{ a: 1 }] };
    const r = decodeClientMessage(JSON.stringify(msg));
    expect(r).toEqual({ kind: 'message', message: msg });
  });
});

describe('binary frames', () => {
  const put: ClientMessage = { type: 'asset-put', reqId: 1, mime: 'image/png', bytes: Uint8Array.from([1, 2, 3]) };

  it('encodes with magic, version and a big-endian header length', () => {
    const out = encodeMessage(put);
    expect(out).toBeInstanceOf(Uint8Array);
    const header = enc(JSON.stringify({ type: 'asset-put', reqId: 1, mime: 'image/png' }));
    expect(Array.from((out as Uint8Array).subarray(0, 6))).toEqual([0xd0, 1, ...u32(header.length)]);
    expect(Array.from((out as Uint8Array).subarray(6 + header.length))).toEqual([1, 2, 3]);
  });

  it('round-trips asset-put and returns the payload as a view, not a copy', () => {
    const data = encodeMessage(put) as Uint8Array;
    const r = decodeClientMessage(data);
    expect(r).toEqual({ kind: 'message', message: put });
    if (r.kind === 'message' && r.message.type === 'asset-put') expect(r.message.bytes.buffer).toBe(data.buffer);
  });

  it('decodes a frame that is a view with a byte offset', () => {
    const data = encodeMessage(put) as Uint8Array;
    const padded = new Uint8Array(data.length + 10);
    padded.set(data, 10);
    expect(decodeClientMessage(padded.subarray(10))).toEqual({ kind: 'message', message: put });
  });

  it('sends an asset with bytes as binary and without bytes as text', () => {
    const base: AssetMsg = { type: 'asset', reqId: 1, assetId: ASSET, mime: 'image/png', size: 1 };
    expect(typeof encodeMessage(base)).toBe('string');
    const bin = encodeMessage({ ...base, bytes: Uint8Array.from([9]) });
    expect(bin).toBeInstanceOf(Uint8Array);
    expect(decodeServerMessage(bin)).toEqual({ kind: 'message', message: { ...base, bytes: Uint8Array.from([9]) } });
    expect(decodeServerMessage(encodeMessage(base))).toEqual({ kind: 'message', message: base });
  });

  it.each([
    ['empty', []],
    ['shorter than 6 bytes', [0xd0, 1, 0, 0, 0]],
    ['wrong magic', [0xd1, 1, ...u32(2)]],
    ['wrong version', [0xd0, 2, ...u32(2)]],
    ['header length 0', [0xd0, 1, ...u32(0)]],
    ['header length 65 537', [0xd0, 1, ...u32(65_537)]],
    ['header length past the end', [0xd0, 1, ...u32(100), 0x7b, 0x7d]],
    ['header length 2^32-1', [0xd0, 1, ...u32(0xffffffff)]],
  ])('rejects a frame with %s', (_name, bytes) => {
    const r = decodeClientMessage(Uint8Array.from(bytes));
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') expect(r.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
  });

  it('rejects a header that is not UTF-8 or not a JSON object with a string type', () => {
    const bad = [Uint8Array.from([0xff, 0xfe]), enc('[1]'), enc('{"type":3}'), enc('not json')];
    for (const h of bad) expect(decodeClientMessage(frame([0xd0, 1, ...u32(h.length)], h)).kind).toBe('invalid');
  });

  it('rejects a text type in a binary frame and ignores an unknown type', () => {
    const hello = enc(JSON.stringify({ type: 'hello', protocol: 1, clientId: CID }));
    expect(decodeClientMessage(frame([0xd0, 1, ...u32(hello.length)], hello)).kind).toBe('invalid');
    const unknown = enc('{"type":"future-binary"}');
    expect(decodeClientMessage(frame([0xd0, 1, ...u32(unknown.length)], unknown))).toEqual({
      kind: 'ignored',
      type: 'future-binary',
    });
  });

  it('the payload overrides a bytes field in the header', () => {
    const h = enc(JSON.stringify({ type: 'asset-put', reqId: 1, mime: 'image/png', bytes: [7, 7] }));
    const r = decodeClientMessage(frame([0xd0, 1, ...u32(h.length)], h).slice());
    expect(r.kind).toBe('message');
    if (r.kind === 'message' && r.message.type === 'asset-put') expect(r.message.bytes.length).toBe(0);
  });

  it('accepts a 64 KiB header and refuses to encode a larger one', () => {
    const pre = '{"type":"asset-put","reqId":1,"mime":"image/png","p":"';
    const header = enc(pre + 'x'.repeat(65_536 - pre.length - 2) + '"}');
    expect(header.length).toBe(65_536);
    const max = writeBinaryFrame(header, new Uint8Array(1));
    expect(max).toBeDefined();
    expect(readBinaryFrame(max!)!.header.length).toBe(65_536);
    expect(decodeClientMessage(max!).kind).toBe('message');
    expect(() =>
      encodeMessage({ type: 'asset-put', reqId: 1, mime: 'image/png', bytes: new Uint8Array(), pad: 'x'.repeat(65_536) } as ClientMessage),
    ).toThrow(expect.objectContaining({ code: 'PROTOCOL_INVALID_MESSAGE' }));
  });

  it('never throws for non-frame input', () => {
    expect(decodeClientMessage(42 as unknown as string).kind).toBe('invalid');
    expect(decodeServerMessage(null as unknown as string).kind).toBe('invalid');
  });
});

describe('decodeUtf8', () => {
  it.each(['', 'plain ascii', 'ünïcødé', '€ and 漢字', '😀 emoji 𝄞', 'x'.repeat(10_000) + 'é'])(
    'matches TextEncoder for %j',
    (s) => {
      expect(decodeUtf8(enc(s))).toBe(s);
    },
  );

  it.each([
    ['a lone continuation byte', [0x80]],
    ['an overlong 2-byte form', [0xc0, 0xaf]],
    ['an overlong 3-byte form', [0xe0, 0x80, 0xaf]],
    ['an encoded surrogate', [0xed, 0xa0, 0x80]],
    ['a code point above U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
    ['a truncated sequence', [0xe2, 0x82]],
    ['an invalid lead byte', [0xff]],
  ])('rejects %s', (_name, bytes) => {
    expect(decodeUtf8(Uint8Array.from(bytes))).toBeUndefined();
  });
});

describe('closeCodeFor', () => {
  const TABLE: Array<[ErrorCode, number]> = [
    ['ENGINE_RESTARTING', 4001],
    ['ENGINE_UNAVAILABLE', 4002],
    ['ACCESS_DENIED', 4003],
    ['SESSION_SLOW_CONSUMER', 4004],
    ['SESSION_CLOSED', 4005],
    ['DOCUMENT_FAULTED', 4006],
    ['PROTOCOL_VERSION_UNSUPPORTED', 4007],
    ['PROTOCOL_INVALID_MESSAGE', 4007],
    ['DOCUMENT_NOT_FOUND', 4008],
    ['DOCUMENT_TOO_LARGE', 4008],
    ['CONVERSION_FAILED', 4008],
    ['CONVERSION_TIMEOUT', 4008],
    ['STORAGE_READ_FAILED', 4008],
  ];

  it.each(TABLE)('maps %s to %i', (code, close) => {
    expect(closeCodeFor(code)).toBe(close);
  });

  it('returns undefined for every code not in the table', () => {
    const mapped = new Set(TABLE.map(([c]) => c));
    for (const code of Object.keys(ERROR_CATALOGUE) as ErrorCode[]) {
      if (!mapped.has(code)) expect(closeCodeFor(code), code).toBeUndefined();
    }
    expect(closeCodeFor('toString' as ErrorCode)).toBeUndefined();
  });

  it('has the LLD §5.5 values and every error code fits a close reason (≤ 123 bytes)', () => {
    expect(CloseCode).toEqual({
      NORMAL: 1000, GOING_AWAY: 1001, ENGINE_RESTARTING: 4001, ENGINE_UNAVAILABLE: 4002, ACCESS_DENIED: 4003,
      SLOW_CONSUMER: 4004, SESSION_CLOSED: 4005, DOCUMENT_FAULTED: 4006, PROTOCOL_ERROR: 4007, LOAD_FAILED: 4008,
    });
    for (const code of Object.keys(ERROR_CATALOGUE)) expect(utf8Length(code)).toBeLessThanOrEqual(123);
  });
});
