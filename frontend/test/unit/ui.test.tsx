// @vitest-environment jsdom
import type { DocumentId } from '@open-docex/shared/ids';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientError, SessionStatus } from '../../src/events.js';
import { DEFAULT_LABELS, resolveLabels } from '../../src/labels.js';
import { DEFAULT_FONT_FAMILIES, DEFAULT_FONT_SIZES, TEXT_TOOLBAR_ITEMS, type MountHooks, type ResolvedOptions } from '../../src/options.js';
import { createDialogBus } from '../../src/ui/dialogBus.js';
import { parseParagraphForm } from '../../src/ui/dialogs.js';
import { Shell } from '../../src/ui/Shell.js';
import type { ShellEnv, ShellSession, ShellSnapshot } from '../../src/ui/useSession.js';
import { doc, makeEditor, p, posOf, select } from './text-fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DOC = 'doc-1' as DocumentId;
const READY_STATUS: SessionStatus = {
  connection: 'open', load: 'ready', access: 'edit', readOnlyReason: null, sync: 'synced', storage: 'normal',
};

class FakeSession implements ShellSession {
  snap: ShellSnapshot;
  listeners = new Set<() => void>();
  retry = vi.fn();
  attachEditor = vi.fn();
  constructor(patch: Partial<ShellSnapshot> = {}) {
    this.snap = { phase: 'live', status: READY_STATUS, progress: null, error: null, ready: null, ...patch };
  }
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): ShellSnapshot => this.snap;
  set(patch: Partial<ShellSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    act(() => this.listeners.forEach((f) => f()));
  }
}

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  host.className = 'odx-root';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function env(session: FakeSession, over: Partial<ShellEnv> = {}, hooks: MountHooks = {}): ShellEnv {
  const toolbar: ResolvedOptions['toolbar'] = {
    text: { items: [...TEXT_TOOLBAR_ITEMS, 'paragraph'], fontFamilies: DEFAULT_FONT_FAMILIES, fontSizes: DEFAULT_FONT_SIZES },
    shell: { items: ['share'] },
  };
  return {
    session, labels: DEFAULT_LABELS, documentId: DOC, hooks, toolbar, container: host,
    getEditor: () => null, dialogs: createDialogBus(), ...over,
  };
}
const render = (e: ShellEnv): void => act(() => root.render(<Shell env={e} />));
const q = (sel: string): HTMLElement | null => host.querySelector<HTMLElement>(sel);
const buttonByText = (t: string): HTMLButtonElement =>
  Array.from(host.querySelectorAll('button')).find((b) => b.textContent === t) as HTMLButtonElement;

describe('shell components', () => {
  it('renders roles and attaches the editor host', () => {
    const s = new FakeSession();
    render(env(s));
    expect(q('[role=toolbar]')).not.toBeNull();
    expect(q('[role=status]')?.getAttribute('aria-live')).toBe('polite');
    expect(s.attachEditor).toHaveBeenCalledWith(q('.odx-editor-host'));
  });

  it('hides the toolbar when ui.toolbar is false', () => {
    render(env(new FakeSession(), { toolbar: false }));
    expect(q('[role=toolbar]')).toBeNull();
  });

  it('ShareButton is hidden without onShare and calls it with the document id', () => {
    render(env(new FakeSession()));
    expect(buttonByText('Share')).toBeUndefined();
    const onShare = vi.fn();
    render(env(new FakeSession(), {}, { onShare }));
    act(() => buttonByText('Share').click());
    expect(onShare).toHaveBeenCalledWith(DOC);
  });

  it('labels override the defaults', () => {
    const labels = resolveLabels({ toolbar: { share: 'Partager' }, status: { synced: 'Tout est confirmé' } });
    render(env(new FakeSession(), { labels }, { onShare: () => {} }));
    expect(buttonByText('Partager')).toBeDefined();
    expect(q('[role=status]')?.textContent).toContain('Tout est confirmé');
  });

  it('StatusBar shows the unconfirmed count and storage notice', () => {
    render(env(new FakeSession({ pendingCount: 3, status: { ...READY_STATUS, sync: 'pending', storage: 'local' } })));
    const t = q('[role=status]')?.textContent ?? '';
    expect(t).toContain('3 changes unconfirmed');
    expect(t).toContain(DEFAULT_LABELS.status.storageLocal);
  });

  it('shows the read-only badge', () => {
    render(env(new FakeSession({ status: { ...READY_STATUS, access: 'view', readOnlyReason: 'view' } })));
    expect(host.textContent).toContain('View only');
  });

  it('ErrorScreen shows the label and Reload calls retry', () => {
    const s = new FakeSession({
      phase: 'terminal',
      error: { code: 'DOCUMENT_NOT_FOUND', retryable: false, message: 'x', terminal: true } satisfies ClientError,
    });
    render(env(s));
    expect(q('[role=alert]')?.textContent).toContain('Document not found');
    expect(q('.odx-editor-host')).toBeNull();
    act(() => buttonByText('Reload').click());
    expect(s.retry).toHaveBeenCalled();
  });

  it("shows \"Can't connect\" with Retry for CLIENT_CONNECT_FAILED", () => {
    render(env(new FakeSession({
      phase: 'terminal',
      error: { code: 'CLIENT_CONNECT_FAILED', retryable: false, message: 'x', terminal: true },
    })));
    expect(q('[role=alert]')?.textContent).toContain("Can't connect");
    expect(buttonByText('Retry')).toBeDefined();
  });
});

describe('UnsupportedBanner', () => {
  const unsupportedStatus: SessionStatus = { ...READY_STATUS, readOnlyReason: 'unsupported' };
  const ready = {
    kind: 'text', access: 'edit', readOnly: true,
    unsupported: [{ feature: 'comments', count: 2 }],
  } as const;

  it('lists findings with labels and the removal warning', () => {
    render(env(new FakeSession({ status: unsupportedStatus, ready })));
    expect(q('.odx-banner')?.textContent).toContain('Comments (2)');
    expect(q('.odx-banner')?.textContent).toContain(DEFAULT_LABELS.banner.removedOnSave);
  });

  it('hides Edit anyway without the hook', () => {
    render(env(new FakeSession({ status: unsupportedStatus, ready })));
    expect(buttonByText('Edit anyway')).toBeUndefined();
  });

  it('Edit anyway calls onEditAnyway, disables, then collapses after the notice', async () => {
    let resolve!: () => void;
    const onEditAnyway = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const s = new FakeSession({ status: unsupportedStatus, ready });
    render(env(s, {}, { onEditAnyway }));
    await act(async () => { buttonByText("Edit anyway").click(); await Promise.resolve(); });
    expect(onEditAnyway).toHaveBeenCalledWith(DOC);
    expect(buttonByText('Edit anyway').disabled).toBe(true);
    await act(async () => { resolve(); await Promise.resolve(); });
    expect(buttonByText('Edit anyway').disabled).toBe(true); // still waiting for the notice
    s.set({ status: { ...READY_STATUS, readOnlyReason: null } });
    expect(buttonByText('Edit anyway')).toBeUndefined();
    expect(q('.odx-banner')?.textContent).toBe(DEFAULT_LABELS.banner.editingAnyway);
  });

  it('shows an inline error and re-enables when onEditAnyway rejects', async () => {
    const onEditAnyway = vi.fn(() => Promise.reject(new Error('no')));
    render(env(new FakeSession({ status: unsupportedStatus, ready }), {}, { onEditAnyway }));
    await act(async () => { buttonByText("Edit anyway").click(); await Promise.resolve(); });
    expect(q('.odx-banner-error')?.textContent).toBe(DEFAULT_LABELS.banner.editAnywayFailed);
    expect(buttonByText('Edit anyway').disabled).toBe(false);
  });

  it('shows the PO-22 conversion notice and no Edit anyway for it', () => {
    render(env(new FakeSession({
      status: READY_STATUS,
      ready: { ...ready, readOnly: false, unsupported: [] },
      conversions: [{ feature: 'image-to-png', count: 2 }, { feature: 'image-to-png', count: 1 }],
    })));
    expect(q('.odx-banner')?.textContent).toBe('3 images were converted and will be saved as PNG.');
    expect(buttonByText('Edit anyway')).toBeUndefined();
  });
});

describe('Paragraph dialog (PO-20, S-39)', () => {
  const setInput = (label: string, value: string): void => {
    const input = Array.from(host.querySelectorAll('label')).find((l) => l.textContent?.startsWith(label))?.querySelector('input');
    if (!input) throw new Error(`no field ${label}`);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set as ((this: HTMLInputElement, v: string) => void) | undefined;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  function open() {
    const { editor, view } = makeEditor(doc(p('hello'), p('world')));
    select(view, posOf(view.state.doc, 'hello') + 1);
    const e = env(new FakeSession(), { getEditor: () => editor });
    render(e);
    return { editor, view, e };
  }

  it('is a toolbar item that opens the dialog and applies via formatParagraph', () => {
    const { view, editor } = open();
    const spy = vi.spyOn(editor, 'formatParagraph');
    act(() => buttonByText(DEFAULT_LABELS.toolbar.paragraph).click());
    expect(q('[role=dialog]')).not.toBeNull();
    setInput('Spacing before', '12');
    setInput('Left indent', '36');
    setInput('First-line indent', '-18');
    act(() => buttonByText('OK').click());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(q('[role=dialog]')).toBeNull();
    const first = view.state.doc.firstChild?.firstChild;
    expect(first?.attrs.spacingBefore).toBe(12);
    expect(first?.attrs.indentLeft).toBe(36);
    expect(first?.attrs.indentFirstLine).toBe(-18);
    expect(view.state.doc.firstChild?.child(1).attrs.spacingBefore).toBeNull();
  });

  it('keeps the dialog open with an error for an out-of-range value', () => {
    const { view } = open();
    act(() => buttonByText(DEFAULT_LABELS.toolbar.paragraph).click());
    setInput('Spacing before', '5000');
    act(() => buttonByText('OK').click());
    expect(q('[role=dialog]')).not.toBeNull();
    expect(q('.odx-dialog-error')?.textContent).toBe(DEFAULT_LABELS.dialogs.invalidValue);
    expect(view.state.doc.firstChild?.firstChild?.attrs.spacingBefore).toBeNull();
  });

  it('parseParagraphForm enforces the S-19 ranges', () => {
    const base = { spacingBefore: '', spacingAfter: '', indentLeft: '', indentRight: '', indentFirstLine: '', lineKind: 'none', lineValue: '' } as const;
    expect(parseParagraphForm({ ...base, indentFirstLine: '-1584' })).toMatchObject({ indentFirstLine: -1584, lineHeight: null });
    expect(parseParagraphForm({ ...base, indentFirstLine: '-1585' })).toBeNull();
    expect(parseParagraphForm({ ...base, indentLeft: '-1' })).toBeNull();
    expect(parseParagraphForm({ ...base, spacingAfter: 'abc' })).toBeNull();
    expect(parseParagraphForm({ ...base, lineKind: 'multiple', lineValue: '0.4' })).toBeNull();
    expect(parseParagraphForm({ ...base, lineKind: 'multiple', lineValue: '1.5' })?.lineHeight).toEqual({ kind: 'multiple', value: 1.5 });
    expect(parseParagraphForm({ ...base, lineKind: 'exact', lineValue: '0' })).toBeNull();
    expect(parseParagraphForm({ ...base, lineKind: 'atLeast', lineValue: '14' })?.lineHeight).toEqual({ kind: 'atLeast', pt: 14 });
    expect(parseParagraphForm({ ...base, lineKind: 'exact', lineValue: '' })).toBeNull();
  });
});
