// Upgrade helpers (LLD Part 2 §4.2, §0 S-24): the URL checks, the `authorize` result checks and the
// HTTP reject.
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  hasDeny,
  isValidAuthorizeResult,
  isValidDenial,
  MAX_DOCUMENT_ID_LENGTH,
  parseUpgrade,
  rejectSocket,
} from '../../../src/gateway/upgrade.js';

const req = (url: string | undefined): IncomingMessage => ({ url }) as IncomingMessage;

describe('parseUpgrade', () => {
  it('accepts our path with a document id and keeps the parsed URL', () => {
    const r = parseUpgrade(req('/open-docex?doc=abc&x=1'), '/open-docex');
    expect(r.kind).toBe('ours');
    if (r.kind === 'ours') {
      expect(r.documentId).toBe('abc');
      expect(r.url.searchParams.get('x')).toBe('1');
    }
  });

  it('leaves other paths to other upgrade listeners, whatever the query says', () => {
    expect(parseUpgrade(req('/other?doc=abc'), '/open-docex').kind).toBe('other');
    expect(parseUpgrade(req('/open-docex/extra?doc=abc'), '/open-docex').kind).toBe('other');
    expect(parseUpgrade(req(undefined), '/open-docex').kind).toBe('other');
  });

  it.each([
    ['a missing doc', '/open-docex'],
    ['an empty doc', '/open-docex?doc='],
    ['a doc with a control character', '/open-docex?doc=a%00b'],
    ['a doc with a newline', '/open-docex?doc=a%0Ab'],
    ['an overlong doc', `/open-docex?doc=${'x'.repeat(MAX_DOCUMENT_ID_LENGTH + 1)}`],
  ])('answers 400 for %s', (_name, url) => {
    expect(parseUpgrade(req(url), '/open-docex').kind).toBe('bad-request');
  });

  it('accepts a document id of exactly the maximum length', () => {
    expect(parseUpgrade(req(`/open-docex?doc=${'x'.repeat(MAX_DOCUMENT_ID_LENGTH)}`), '/open-docex').kind).toBe('ours');
  });

  it('decodes percent-escapes in the document id', () => {
    const r = parseUpgrade(req('/open-docex?doc=a%2Fb%20c'), '/open-docex');
    expect(r.kind === 'ours' && r.documentId).toBe('a/b c');
  });
});

describe('isValidAuthorizeResult', () => {
  const ok = { userId: 'u1', access: 'edit', document: { ref: 'a.docx', format: 'docx' } };

  it('accepts string and object refs, edit and view', () => {
    expect(isValidAuthorizeResult(ok)).toBe(true);
    expect(isValidAuthorizeResult({ ...ok, access: 'view' })).toBe(true);
    expect(isValidAuthorizeResult({ ...ok, document: { ref: { bucket: 'b', key: 'k' }, format: 'odt' } })).toBe(true);
    expect(isValidAuthorizeResult({ ...ok, document: { ref: { $local: 'x' }, format: 'xlsx' } })).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['a string', 'edit'],
    ['an array', []],
    ['an empty userId', { ...ok, userId: '' }],
    ['a numeric userId', { ...ok, userId: 7 }],
    ['an unknown access', { ...ok, access: 'admin' }],
    ['a missing document', { userId: 'u', access: 'edit' }],
    ['an unknown format', { ...ok, document: { ref: 'a', format: 'pdf' } }],
    ['an empty string ref', { ...ok, document: { ref: '', format: 'docx' } }],
    ['a null ref', { ...ok, document: { ref: null, format: 'docx' } }],
    ['an array ref', { ...ok, document: { ref: ['a'], format: 'docx' } }],
    ['a numeric ref', { ...ok, document: { ref: 5, format: 'docx' } }],
  ])('rejects %s', (_name, value) => {
    expect(isValidAuthorizeResult(value)).toBe(false);
  });
});

describe('deny results (S-24)', () => {
  it('recognises an own deny key', () => {
    expect(hasDeny({ deny: 401 })).toBe(true);
    expect(hasDeny({ deny: 'x' })).toBe(true);
    expect(hasDeny(null)).toBe(false);
    expect(hasDeny({})).toBe(false);
    expect(hasDeny(Object.create({ deny: 401 }))).toBe(false);
  });

  it('accepts only 401 and 403', () => {
    expect(isValidDenial({ deny: 401 })).toBe(true);
    expect(isValidDenial({ deny: 403 })).toBe(true);
    for (const bad of [200, 404, 500, '401', null, undefined, 401.5]) expect(isValidDenial({ deny: bad })).toBe(false);
  });
});

describe('rejectSocket', () => {
  function capture(): { socket: PassThrough; written: () => string } {
    const socket = new PassThrough();
    const chunks: Buffer[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c));
    return { socket, written: () => Buffer.concat(chunks).toString('utf8') };
  }

  it('writes a bodyless HTTP response and destroys the socket', async () => {
    const { socket, written } = capture();
    rejectSocket(socket, 403);
    await new Promise((r) => setImmediate(r));
    expect(written()).toBe('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    expect(socket.destroyed).toBe(true);
  });

  it('adds the given headers (Retry-After on 503)', async () => {
    const { socket, written } = capture();
    rejectSocket(socket, 503, { 'Retry-After': 3 });
    await new Promise((r) => setImmediate(r));
    expect(written()).toContain('HTTP/1.1 503 Service Unavailable\r\n');
    expect(written()).toContain('Retry-After: 3\r\n');
  });

  it('only destroys a socket that is already gone', () => {
    const socket = new PassThrough();
    socket.destroy();
    expect(() => rejectSocket(socket, 500)).not.toThrow();
  });
});
