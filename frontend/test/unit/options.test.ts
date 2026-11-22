import { describe, expect, it } from 'vitest';
import { OpenDocexError } from '@open-docex/shared/errors';
import {
  DEFAULT_FONT_FAMILIES,
  DEFAULT_FONT_SIZES,
  DEFAULT_PAGE_PRESETS,
  TEXT_TOOLBAR_ITEMS,
  validateOptions,
  withDefaults,
  type MountOptions,
} from '../../src/options.js';

const base = { url: 'wss://example.test/odx', documentId: 'doc-1', kind: 'text' } as const;

function rejects(options: unknown): OpenDocexError {
  try {
    validateOptions(options);
  } catch (err) {
    expect(err).toBeInstanceOf(OpenDocexError);
    expect((err as OpenDocexError).code).toBe('CONFIG_INVALID');
    return err as OpenDocexError;
  }
  throw new Error('expected validateOptions to throw');
}

describe('validateOptions', () => {
  it('accepts valid options', () => {
    expect(() => validateOptions(base)).not.toThrow();
    expect(() => validateOptions({ ...base, url: 'ws://localhost:3000/x', kind: 'sheet' })).not.toThrow();
    expect(() => validateOptions({ ...base, connect: { auth: { type: 'query', param: 't', getToken: () => 'x' } } })).not.toThrow();
    expect(() => validateOptions({ ...base, connect: { auth: { type: 'subprotocol', getToken: () => 'x' } } })).not.toThrow();
  });

  it('rejects non-object options', () => {
    rejects(undefined);
    rejects(null);
    rejects('x');
  });

  it('rejects a missing url', () => {
    rejects({ ...base, url: undefined });
    rejects({ ...base, url: '' });
  });

  it('rejects a url that is not ws: or wss:', () => {
    rejects({ ...base, url: 'https://example.test/odx' });
    rejects({ ...base, url: 'javascript:alert(1)' });
    rejects({ ...base, url: 'not a url' });
  });

  it('rejects a missing or invalid documentId', () => {
    rejects({ ...base, documentId: undefined });
    rejects({ ...base, documentId: '' });
    rejects({ ...base, documentId: 'a\u0000b' });
    rejects({ ...base, documentId: 'x'.repeat(1025) });
    expect(() => validateOptions({ ...base, documentId: 'x'.repeat(1024) })).not.toThrow();
  });

  it('rejects a kind other than text or sheet', () => {
    rejects({ ...base, kind: 'slides' });
    rejects({ ...base, kind: undefined });
  });

  it('rejects query auth without param', () => {
    rejects({ ...base, connect: { auth: { type: 'query', getToken: () => 'x' } } });
    rejects({ ...base, connect: { auth: { type: 'query', param: '', getToken: () => 'x' } } });
  });

  it('rejects token auth without getToken, and unknown auth types', () => {
    rejects({ ...base, connect: { auth: { type: 'subprotocol' } } });
    rejects({ ...base, connect: { auth: { type: 'basic' } } });
  });

  it('never echoes a token or url into the message', () => {
    const err = rejects({ ...base, url: 'https://example.test/?token=SECRET' });
    expect(err.message).not.toContain('SECRET');
  });
});

describe('withDefaults', () => {
  it('fills the documented defaults (§2.1, L-13, L-14)', () => {
    const r = withDefaults(base as unknown as MountOptions);
    expect(r.auth).toEqual({ type: 'cookie' });
    expect(r.heartbeat).toEqual({ intervalMs: 25_000, timeoutMs: 10_000 });
    expect(r.reconnect).toEqual({ baseDelayMs: 500, maxDelayMs: 30_000 });
    expect(r.confirmUnload).toBe(true);
    expect(r.toolbar).not.toBe(false);
    if (r.toolbar === false) return;
    expect(r.toolbar.text.items).toBe(TEXT_TOOLBAR_ITEMS);
    expect(r.toolbar.text.fontFamilies).toEqual(['Arial', 'Times New Roman', 'Courier New', 'Georgia', 'Verdana']);
    expect(r.toolbar.shell.items).toEqual(['share']);
  });

  it('keeps adopter values', () => {
    const r = withDefaults({
      ...base,
      connect: { heartbeat: { intervalMs: 1000 }, reconnect: { maxDelayMs: 5000 } },
      ui: { toolbar: { text: { fontSizes: [10, 12] } }, confirmUnload: false },
    } as unknown as MountOptions);
    expect(r.heartbeat).toEqual({ intervalMs: 1000, timeoutMs: 10_000 });
    expect(r.reconnect).toEqual({ baseDelayMs: 500, maxDelayMs: 5000 });
    expect(r.confirmUnload).toBe(false);
    expect(r.toolbar !== false && r.toolbar.text.fontSizes).toEqual([10, 12]);
    expect(withDefaults({ ...base, ui: { toolbar: false } } as unknown as MountOptions).toolbar).toBe(false);
  });
});

describe('L-13 defaults', () => {
  it('font sizes span 8–72 pt', () => {
    expect(DEFAULT_FONT_SIZES[0]).toBe(8);
    expect(DEFAULT_FONT_SIZES.at(-1)).toBe(72);
    expect([...DEFAULT_FONT_SIZES].sort((a, b) => a - b)).toEqual(DEFAULT_FONT_SIZES);
    expect(DEFAULT_FONT_FAMILIES).toHaveLength(5);
  });

  it('page presets are A4, Letter, Legal, A3, A5 in pt', () => {
    expect(DEFAULT_PAGE_PRESETS.map((p) => p.id)).toEqual(['A4', 'Letter', 'Legal', 'A3', 'A5']);
    expect(DEFAULT_PAGE_PRESETS[0]).toEqual({ id: 'A4', width: 595.28, height: 841.89 });
    expect(DEFAULT_PAGE_PRESETS[1]).toEqual({ id: 'Letter', width: 612, height: 792 });
  });
});
