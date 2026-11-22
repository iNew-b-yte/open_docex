import { describe, expect, it, vi } from 'vitest';
import { ERROR_CATALOGUE } from '@open-docex/shared/errors';
import { Emitter } from '../../src/events.js';
import { DEFAULT_LABELS, errorLabel, resolveLabels, type Labels } from '../../src/labels.js';
import type { DeepPartial } from '../../src/options.js';
import { applyTheme, THEME_VAR_NAMES } from '../../src/theme.js';
import {
  forcedBlobMime,
  isAllowedHref,
  isBlobUrl,
  LINK_REL,
  openLink,
} from '../../src/security/href.js';
import { isAllowedHref as sharedIsAllowedHref } from '@open-docex/shared/text';

describe('applyTheme', () => {
  it('sets only allow-listed --odx-* variables', () => {
    const el = document.createElement('div');
    applyTheme(el, {
      '--odx-color-bg': '#fff',
      '--odx-radius': '4px',
      // Unknown keys are ignored.
      ...({ '--other': 'x', color: 'red', '--odx-unknown': '1' } as object),
    });
    expect(el.style.getPropertyValue('--odx-color-bg')).toBe('#fff');
    expect(el.style.getPropertyValue('--odx-radius')).toBe('4px');
    expect(el.style.getPropertyValue('--other')).toBe('');
    expect(el.style.getPropertyValue('--odx-unknown')).toBe('');
    expect(el.style.color).toBe('');
    expect(el.style.length).toBe(2);
  });

  it('ignores non-string values and a missing theme', () => {
    const el = document.createElement('div');
    applyTheme(el, undefined);
    applyTheme(el, { '--odx-radius': 4 as unknown as string });
    expect(el.style.length).toBe(0);
    expect(THEME_VAR_NAMES).toHaveLength(12);
  });
});

describe('Emitter', () => {
  it('on() returns a working unsubscribe', () => {
    const em = new Emitter<{ a: number }>();
    const fn = vi.fn();
    const off = em.on('a', fn);
    em.emit('a', 1);
    off();
    off();
    em.emit('a', 2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(em.listenerCount).toBe(0);
  });

  it('a throwing listener does not stop the others', async () => {
    const em = new Emitter<{ a: number }>();
    const errors: unknown[] = [];
    const orig = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (cb) => orig(() => { try { cb(); } catch (e) { errors.push(e); } });
    try {
      const second = vi.fn();
      em.on('a', () => { throw new Error('boom'); });
      em.on('a', second);
      em.emit('a', 1);
      expect(second).toHaveBeenCalledWith(1);
      await Promise.resolve();
      expect(errors).toHaveLength(1);
    } finally {
      globalThis.queueMicrotask = orig;
    }
  });

  it('clear() removes every listener', () => {
    const em = new Emitter<{ a: number; b: string }>();
    em.on('a', () => {});
    em.on('b', () => {});
    em.clear();
    expect(em.listenerCount).toBe(0);
  });
});

describe('labels', () => {
  it('has a label for every error code', () => {
    for (const code of Object.keys(ERROR_CATALOGUE)) {
      expect(DEFAULT_LABELS.errors[code as keyof Labels['errors']]).toMatch(/\S/);
    }
  });

  it('overrides replace defaults; unknown and prototype keys are ignored', () => {
    const overrides = JSON.parse(
      '{"toolbar":{"bold":"Gras","nope":"x"},"errors":{"ACCESS_DENIED":"Interdit"},"__proto__":{"polluted":"yes"},"status":{"synced":5}}',
    ) as DeepPartial<Labels>;
    const labels = resolveLabels(overrides);
    expect(labels.toolbar.bold).toBe('Gras');
    expect(labels.toolbar.italic).toBe(DEFAULT_LABELS.toolbar.italic);
    expect(labels.errors.ACCESS_DENIED).toBe('Interdit');
    expect(labels.status.synced).toBe(DEFAULT_LABELS.status.synced);
    expect('nope' in labels.toolbar).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.isFrozen(labels.toolbar)).toBe(true);
    expect(resolveLabels(undefined)).toBe(DEFAULT_LABELS);
  });

  it('errorLabel prefers the label, then the message, then the catalogue', () => {
    expect(errorLabel(DEFAULT_LABELS, 'DOCUMENT_NOT_FOUND', 'server text')).toBe('Document not found');
    const empty = resolveLabels({ errors: { DOCUMENT_NOT_FOUND: '' } });
    expect(errorLabel(empty, 'DOCUMENT_NOT_FOUND', 'server text')).toBe('server text');
    expect(errorLabel(empty, 'DOCUMENT_NOT_FOUND')).toBe(ERROR_CATALOGUE.DOCUMENT_NOT_FOUND.clientMessage);
    expect(errorLabel(DEFAULT_LABELS, 'toString')).toBe('');
  });
});

describe('security/href', () => {
  it('uses the shared isAllowedHref (R-11), not a copy', () => {
    expect(isAllowedHref).toBe(sharedIsAllowedHref);
    expect(isAllowedHref('https://example.test/')).toBe(true);
    expect(isAllowedHref('mailto:a@example.test')).toBe(true);
    expect(isAllowedHref('javascript:alert(1)')).toBe(false);
    expect(isAllowedHref(' JavaScript:alert(1)')).toBe(false);
    expect(isAllowedHref('data:text/html,x')).toBe(false);
  });

  it('openLink re-validates and opens without opener or referrer', () => {
    const open = vi.fn();
    expect(openLink('javascript:alert(1)', { open })).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(openLink('https://example.test/a', { open })).toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.test/a', '_blank', 'noopener,noreferrer');
    expect(LINK_REL).toBe('noopener noreferrer nofollow');
  });

  it('forces blob MIME types to the image allowlist', () => {
    expect(forcedBlobMime('image/png')).toBe('image/png');
    expect(forcedBlobMime('image/jpeg')).toBe('image/jpeg');
    expect(forcedBlobMime('image/gif')).toBe('image/gif');
    expect(forcedBlobMime('image/svg+xml')).toBe('application/octet-stream');
    expect(forcedBlobMime('text/html')).toBe('application/octet-stream');
    expect(forcedBlobMime(undefined)).toBe('application/octet-stream');
  });

  it('isBlobUrl accepts only blob: URLs', () => {
    expect(isBlobUrl('blob:https://example.test/0b5c')).toBe(true);
    expect(isBlobUrl('https://example.test/a.png')).toBe(false);
    expect(isBlobUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isBlobUrl('javascript:alert(1)')).toBe(false);
    expect(isBlobUrl(42)).toBe(false);
  });
});
