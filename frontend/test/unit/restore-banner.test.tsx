// @vitest-environment jsdom
import type { DocumentId } from '@open-docex/shared/ids';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionStatus } from '../../src/events.js';
import { DEFAULT_LABELS } from '../../src/labels.js';
import { DEFAULT_FONT_FAMILIES, DEFAULT_FONT_SIZES, TEXT_TOOLBAR_ITEMS } from '../../src/options.js';
import { createDialogBus } from '../../src/ui/dialogBus.js';
import { Shell } from '../../src/ui/Shell.js';
import type { ShellEnv, ShellSession, ShellSnapshot } from '../../src/ui/useSession.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STATUS: SessionStatus = {
  connection: 'open', load: 'ready', access: 'edit', readOnlyReason: null, sync: 'synced', storage: 'normal',
};

let host: HTMLElement;
let root: Root;
let snap: ShellSnapshot;
const listeners = new Set<() => void>();
const session: ShellSession = {
  subscribe: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  getSnapshot: () => snap,
  retry: vi.fn(),
  attachEditor: vi.fn(),
};
const set = (patch: Partial<ShellSnapshot>): void => {
  snap = { ...snap, ...patch };
  act(() => listeners.forEach((f) => f()));
};
/** Like the real session: every notice, even a repeat, advances the counter. */
let seq = 0;
const notify = (n: 'discarded' | 'partialLoss' | 'lost'): void => {
  seq += 1;
  set({ restoreNotice: n, restoreNoticeSeq: seq });
};
const banner = (): HTMLElement | null => host.querySelector('.odx-banner-restore');

beforeEach(() => {
  snap = { phase: 'live', status: STATUS, progress: null, error: null, ready: null };
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  const env: ShellEnv = {
    session, labels: DEFAULT_LABELS, documentId: 'd' as DocumentId, hooks: {}, container: host,
    toolbar: {
      text: { items: TEXT_TOOLBAR_ITEMS, fontFamilies: DEFAULT_FONT_FAMILIES, fontSizes: DEFAULT_FONT_SIZES },
      shell: { items: [] },
    },
    getEditor: () => null, dialogs: createDialogBus(),
  };
  act(() => root.render(<Shell env={env} />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  listeners.clear();
});

describe('restore notice banner', () => {
  it('is absent without a notice', () => {
    expect(banner()).toBeNull();
  });

  it('shows the label of each notice, and can be dismissed', () => {
    notify('partialLoss');
    expect(banner()?.textContent).toContain(DEFAULT_LABELS.restore.partialLoss);
    act(() => banner()?.querySelector('button')?.click());
    expect(banner()).toBeNull();
    // A different notice shows again.
    notify('lost');
    expect(banner()?.textContent).toContain(DEFAULT_LABELS.restore.lost);
  });

  it('shows the same notice again after it was dismissed (V1-40 bug)', () => {
    notify('discarded');
    act(() => banner()?.querySelector('button')?.click());
    expect(banner()).toBeNull();
    notify('discarded');
    expect(banner()?.textContent).toContain(DEFAULT_LABELS.restore.discarded);
  });
});
