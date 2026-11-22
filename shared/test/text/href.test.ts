import { describe, expect, it } from 'vitest';
import { isAllowedHref } from '../../src/text/href.js';

describe('isAllowedHref', () => {
  it.each([
    'http://example.com',
    'https://example.com/a?b=c#d',
    'mailto:someone@example.com',
    'HTTPS://EXAMPLE.COM',
  ])('accepts %s', (href) => {
    expect(isAllowedHref(href)).toBe(true);
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['mixed-case javascript:', 'JaVaScRiPt:alert(1)'],
    ['newline inside the scheme', 'java\nscript:alert(1)'],
    ['tab inside the scheme', 'java\tscript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['protocol-relative', '//evil.example'],
    ['relative path', '/path'],
    ['ftp:', 'ftp://example.com'],
    ['a space', 'https://exa mple.com'],
    ['a NUL', 'https://example.com/\u0000'],
    ['a C1 control', 'https://example.com/\u0085'],
    ['DEL', 'https://example.com/\u007F'],
    ['leading whitespace', ' https://example.com'],
    ['empty string', ''],
  ])('rejects %s', (_label, href) => {
    expect(isAllowedHref(href)).toBe(false);
  });

  it('accepts 2048 characters and rejects 2049', () => {
    const base = 'https://example.com/';
    const ok = base + 'a'.repeat(2048 - base.length);
    expect(ok.length).toBe(2048);
    expect(isAllowedHref(ok)).toBe(true);
    expect(isAllowedHref(ok + 'a')).toBe(false);
  });

  it.each([null, undefined, 42, {}, ['https://example.com']])('rejects non-string %p', (v) => {
    expect(isAllowedHref(v)).toBe(false);
  });
});
