import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenDocexError } from '@open-docex/shared/errors';
import type { DocumentId } from '@open-docex/shared/ids';
import { createMount, mount, type MountContext, type MountSeams } from '../../src/mount.js';
import type { MountOptions } from '../../src/options.js';

// Vite's `import.meta.glob`, typed locally (the client tests have no vite/client types).
declare global {
  interface ImportMeta {
    glob(pattern: string, opts: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
  }
}

const options = (extra: Partial<MountOptions> = {}): MountOptions => ({
  url: 'wss://example.test/odx',
  documentId: 'doc-1' as DocumentId,
  kind: 'text',
  ...extra,
});

function fakeSeams() {
  const calls: string[] = [];
  let ctx: MountContext | undefined;
  const seams: MountSeams = {
    createSession: (c) => {
      ctx = c;
      calls.push('createSession');
      return { start: () => calls.push('start'), destroy: () => calls.push('session.destroy') };
    },
    renderShell: () => {
      calls.push('renderShell');
      return { unmount: () => calls.push('unmount') };
    },
  };
  return { seams, calls, ctx: () => ctx! };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('mount', () => {
  it('creates an .odx-root container inside the element, themed', () => {
    const host = document.body.appendChild(document.createElement('div'));
    const handle = mount(host, options({ ui: { theme: { '--odx-color-bg': 'black' } } }));
    const root = host.querySelector(':scope > .odx-root') as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.style.getPropertyValue('--odx-color-bg')).toBe('black');
    handle.destroy();
  });

  it('throws CONFIG_INVALID for invalid options and non-elements', () => {
    const host = document.createElement('div');
    expect(() => mount(host, options({ url: 'http://x' }))).toThrow(OpenDocexError);
    expect(() => mount(null as unknown as HTMLElement, options())).toThrow(/element/);
    expect(host.childElementCount).toBe(0);
  });

  it('throws CONFIG_INVALID on a double mount of one element', () => {
    const host = document.createElement('div');
    const handle = mount(host, options());
    let err: unknown;
    try {
      mount(host, options());
    } catch (e) {
      err = e;
    }
    expect((err as OpenDocexError).code).toBe('CONFIG_INVALID');
    expect(host.childElementCount).toBe(1);
    handle.destroy();
  });

  it('runs the seams in order and starts the session', () => {
    const f = fakeSeams();
    const handle = createMount(document.createElement('div'), options(), f.seams);
    expect(f.calls).toEqual(['createSession', 'renderShell', 'start']);
    expect(f.ctx().idPrefix).toMatch(/^odx\d+-$/);
    expect(f.ctx().options.confirmUnload).toBe(true);
    handle.destroy();
    expect(f.calls.slice(3)).toEqual(['session.destroy', 'unmount']);
  });

  it('gives each mount its own client id and prefix', () => {
    const a = fakeSeams();
    const b = fakeSeams();
    const ha = createMount(document.createElement('div'), options(), a.seams);
    const hb = createMount(document.createElement('div'), options(), b.seams);
    expect(a.ctx().clientId).not.toBe(b.ctx().clientId);
    expect(a.ctx().idPrefix).not.toBe(b.ctx().idPrefix);
    ha.destroy();
    hb.destroy();
  });

  it('forwards error events to hooks.onError', () => {
    const onError = vi.fn();
    const f = fakeSeams();
    const handle = createMount(document.createElement('div'), options({ hooks: { onError } }), f.seams);
    const err = { code: 'SESSION_CLOSED', retryable: false, message: 'm', terminal: true } as const;
    f.ctx().emitter.emit('error', err);
    expect(onError).toHaveBeenCalledWith(err);
    handle.destroy();
  });

  it('on() returns a working unsubscribe', () => {
    const f = fakeSeams();
    const handle = createMount(document.createElement('div'), options(), f.seams);
    const fn = vi.fn();
    const off = handle.on('sync', fn);
    f.ctx().emitter.emit('sync', { pendingCount: 1, confirmedRev: 2 });
    off();
    f.ctx().emitter.emit('sync', { pendingCount: 2, confirmedRev: 3 });
    expect(fn).toHaveBeenCalledTimes(1);
    handle.destroy();
  });

  it('cleans up when a seam throws during mount', () => {
    const host = document.createElement('div');
    const destroy = vi.fn();
    const seams: MountSeams = {
      createSession: () => ({ start: () => { throw new Error('boom'); }, destroy }),
      renderShell: () => ({ unmount() {} }),
    };
    expect(() => createMount(host, options(), seams)).toThrow('boom');
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(host.childElementCount).toBe(0);
    // The element is free again.
    mount(host, options()).destroy();
  });
});

describe('L-14 confirmUnload', () => {
  const fire = (): Event => {
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    return ev;
  };

  it('warns only while changes are unconfirmed', () => {
    const f = fakeSeams();
    const handle = createMount(document.createElement('div'), options(), f.seams);
    expect(fire().defaultPrevented).toBe(false);
    f.ctx().emitter.emit('sync', { pendingCount: 2, confirmedRev: 1 });
    expect(fire().defaultPrevented).toBe(true);
    f.ctx().emitter.emit('sync', { pendingCount: 0, confirmedRev: 3 });
    expect(fire().defaultPrevented).toBe(false);
    handle.destroy();
  });

  it('adds no listener when confirmUnload is false', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const handle = mount(document.createElement('div'), options({ ui: { confirmUnload: false } }));
    expect(add.mock.calls.filter(([t]) => t === 'beforeunload')).toHaveLength(0);
    handle.destroy();
  });
});

describe('destroy leaves no leaks', () => {
  it('is idempotent and releases everything', () => {
    const host = document.body.appendChild(document.createElement('div'));
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const f = fakeSeams();
    const handle = createMount(host, options(), f.seams);
    const emitter = f.ctx().emitter;
    const destroyed = vi.fn();
    handle.on('destroyed', destroyed);
    handle.on('status', () => {});
    f.ctx().emitter.emit('sync', { pendingCount: 3, confirmedRev: 1 });

    handle.destroy();
    handle.destroy();

    // Container removed, element free, destroyed fired once, listeners gone.
    expect(host.childElementCount).toBe(0);
    expect(f.ctx().container.isConnected).toBe(false);
    expect(destroyed).toHaveBeenCalledTimes(1);
    expect(emitter.listenerCount).toBe(0);
    expect(f.calls.filter((c) => c === 'session.destroy')).toHaveLength(1);
    expect(f.calls.filter((c) => c === 'unmount')).toHaveLength(1);

    // Every window listener added was removed with the same function.
    const added = add.mock.calls.filter(([t]) => t === 'beforeunload').map(([, fn]) => fn);
    const removed = remove.mock.calls.filter(([t]) => t === 'beforeunload').map(([, fn]) => fn);
    expect(added).toHaveLength(1);
    expect(removed).toEqual(added);
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);

    // on() after destroy is inert.
    const late = vi.fn();
    handle.on('status', late)();
    expect(emitter.listenerCount).toBe(0);

    // Re-mount in the same element works (§2.3 E2E, done here in jsdom).
    const again = mount(host, options());
    expect(host.childElementCount).toBe(1);
    again.destroy();
    expect(host.childElementCount).toBe(0);
  });

  it('many mount/destroy cycles leave the DOM and window clean', () => {
    const host = document.body.appendChild(document.createElement('div'));
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    for (let i = 0; i < 50; i++) mount(host, options()).destroy();
    expect(host.childElementCount).toBe(0);
    expect(document.querySelectorAll('.odx-root')).toHaveLength(0);
    expect(add.mock.calls.length).toBe(remove.mock.calls.length);
  });

  it('cleans up even if session.destroy throws', () => {
    const host = document.createElement('div');
    const seams: MountSeams = {
      createSession: () => ({ start() {}, destroy: () => { throw new Error('x'); } }),
      renderShell: () => ({ unmount() {} }),
    };
    const handle = createMount(host, options(), seams);
    expect(() => handle.destroy()).toThrow('x');
    expect(host.childElementCount).toBe(0);
    mount(host, options()).destroy();
  });
});

describe('no innerHTML (LLD Part 3 §15)', () => {
  it('no source file uses innerHTML, outerHTML, insertAdjacentHTML or dangerouslySetInnerHTML', () => {
    const sources = import.meta.glob('../../src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true });
    const files = Object.entries(sources);
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const [path, text] of files) {
      expect(text, path).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML/);
    }
  });
});
