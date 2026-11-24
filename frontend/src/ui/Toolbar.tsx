import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ShellItemId, TextToolbarItemId } from '../options.js';
import type { EditorCommand, TextEditorView } from '../text/TextEditorView.js';
import type { DialogId } from './dialogBus.js';
import { ShareButton } from './ShareButton.js';
import { fill, useSession, useShell } from './useSession.js';

/** Props of {@link Toolbar}. */
export interface ToolbarProps {
  /** The text editor, or null before the first load (every item is then disabled). */
  editor: TextEditorView | null;
  items: readonly TextToolbarItemId[];
  fontFamilies: readonly string[];
  fontSizes: readonly number[];
  shellItems: readonly ShellItemId[];
}

/** Items that open a dialog instead of running at once. */
const DIALOG_ITEMS: Partial<Record<TextToolbarItemId, DialogId>> = {
  link: 'link',
  insertTable: 'insertTable',
  imageAlt: 'imageAlt',
  pageSetup: 'pageSetup',
  paragraph: 'paragraph',
};

/**
 * The formatting toolbar (LLD Part 3 §14): `role="toolbar"`, roving tabindex (arrow keys move
 * between controls), `aria-pressed` for toggles and the current value for selects. It
 * re-renders on every editor state change.
 */
export function Toolbar({ editor, items, fontFamilies, fontSizes, shellItems }: ToolbarProps) {
  const { labels, dialogs } = useShell();
  const { status } = useSession();
  const [, setTick] = useState(0);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => editor?.subscribe(() => setTick((t) => t + 1)), [editor]);

  let state = null;
  try {
    state = editor?.view.state ?? null;
  } catch {
    state = null; // no document loaded yet
  }
  const commands = editor?.commands();
  const view = state !== null ? editor?.view : undefined;

  const controls: { key: string; node: (tab: number) => React.ReactNode }[] = [];
  let n = 0;
  const push = (key: string, node: (tab: number) => React.ReactNode): void => {
    controls.push({ key, node });
    n++;
  };

  for (const id of items) {
    const label = labels.toolbar[id];
    const dialog = DIALOG_ITEMS[id];
    if (id === 'paragraph') {
      const parent = state?.selection.$from.parent.type.name;
      const enabled = state !== null && status.readOnlyReason === null && (parent === 'paragraph' || parent === 'heading');
      push(id, (tab) => (
        <button type="button" className="odx-btn" data-odx-tb="" tabIndex={tab} disabled={!enabled} onClick={() => dialogs.request('paragraph')}>
          {label}
        </button>
      ));
      continue;
    }
    const cmd: EditorCommand | undefined = commands?.get(id);
    if (cmd === undefined) continue;
    const enabled = state !== null && cmd.isEnabled(state);
    const value = state !== null ? (cmd.value?.(state) ?? null) : null;
    if (id === 'paragraphStyle') {
      push(id, (tab) => (
        <select aria-label={label} data-odx-tb="" tabIndex={tab} disabled={!enabled} value={String(value ?? '')}
          onChange={(e) => view && void cmd.run(view, Number(e.target.value))}>
          {value === null && <option value="" />}
          <option value="0">{labels.styles.paragraph}</option>
          {[1, 2, 3, 4, 5, 6].map((l) => (
            <option key={l} value={l}>{fill(labels.styles.heading, { n: l })}</option>
          ))}
        </select>
      ));
    } else if (id === 'fontFamily' || id === 'fontSize') {
      const options: readonly (string | number)[] = id === 'fontFamily' ? fontFamilies : fontSizes;
      push(id, (tab) => (
        <select aria-label={label} data-odx-tb="" tabIndex={tab} disabled={!enabled} value={String(value ?? '')}
          onChange={(e) => {
            const v = e.target.value;
            if (view) void cmd.run(view, v === '' ? null : id === 'fontSize' ? Number(v) : v);
          }}>
          <option value="" />
          {options.map((o) => (
            <option key={o} value={String(o)}>{String(o)}</option>
          ))}
        </select>
      ));
    } else if (id === 'textColor') {
      push(id, (tab) => (
        <input type="color" aria-label={label} data-odx-tb="" tabIndex={tab} disabled={!enabled}
          value={typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
          onChange={(e) => view && void cmd.run(view, e.target.value)} />
      ));
    } else {
      const active_ = state !== null && cmd.isActive?.(state) === true;
      push(id, (tab) => (
        <button type="button" className="odx-btn" data-odx-tb="" tabIndex={tab} disabled={!enabled}
          {...(cmd.isActive ? { 'aria-pressed': active_ } : {})}
          onClick={() => {
            if (dialog !== undefined) dialogs.request(dialog);
            else if (view) void cmd.run(view);
          }}>
          {label}
        </button>
      ));
    }
  }
  if (shellItems.includes('share')) push('share', () => <ShareButton />);

  const onKeyDown = (e: KeyboardEvent): void => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const home = e.key === 'Home';
    const end = e.key === 'End';
    if (step === 0 && !home && !end) return;
    const els = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-odx-tb]:not(:disabled)') ?? []);
    if (els.length === 0) return;
    const at = els.indexOf(document.activeElement as HTMLElement);
    const next = home ? 0 : end ? els.length - 1 : (at + step + els.length) % els.length;
    e.preventDefault();
    els[next]?.focus();
    const all = Array.from(rootRef.current?.querySelectorAll('[data-odx-tb]') ?? []);
    setActive(Math.max(0, all.indexOf(els[next] as Element)));
  };

  return (
    <div ref={rootRef} className="odx-toolbar" role="toolbar" aria-label={labels.status.toolbarLabel} onKeyDown={onKeyDown}>
      {controls.map((c, i) => (
        <span key={c.key} className="odx-toolbar-item">{c.node(i === Math.min(active, n - 1) ? 0 : -1)}</span>
      ))}
    </div>
  );
}
