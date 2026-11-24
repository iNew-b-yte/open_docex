/**
 * The shell's session binding (LLD Part 3 §2.2, §14). Internal: nothing here is exported from
 * the package (PO-12).
 *
 * @module
 */
import type { ConversionNotice } from '@open-docex/shared/protocol';
import type { DocumentId } from '@open-docex/shared/ids';
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Labels } from '../labels.js';
import type { MountHooks, ResolvedOptions } from '../options.js';
import type { SessionSnapshot } from '../session/DocumentSession.js';
import type { TextEditorView } from '../text/TextEditorView.js';
import type { DialogBus } from './dialogBus.js';

/** The session snapshot plus values the shell shows that the snapshot does not carry yet. */
export interface ShellSnapshot extends SessionSnapshot {
  /** Images converted on import (PO-22). The session supplies it when it has them (V1-36). */
  readonly conversions?: readonly ConversionNotice[];
  /** Unconfirmed changes (the `sync` event's `pendingCount`), for the status bar. */
  readonly pendingCount?: number;
}

/** The part of `DocumentSession` the shell uses. */
export interface ShellSession {
  subscribe: (fn: () => void) => () => void;
  getSnapshot: () => ShellSnapshot;
  retry: () => void;
  attachEditor: (el: HTMLElement | null) => void;
}

/** Everything the shell components read. Built by `mount`'s wiring (V1-36). */
export interface ShellEnv {
  session: ShellSession;
  labels: Readonly<Labels>;
  documentId: DocumentId;
  hooks: MountHooks;
  toolbar: ResolvedOptions['toolbar'];
  /** The `.odx-root` element: dialogs render in a portal inside it. */
  container: HTMLElement;
  /** The text editor, or null before the first load and for sheets. */
  getEditor: () => TextEditorView | null;
  dialogs: DialogBus;
}

/** Provides the {@link ShellEnv}. */
export const ShellContext = createContext<ShellEnv | null>(null);

/** The shell environment. Throws outside a `Shell`. */
export function useShell(): ShellEnv {
  const env = useContext(ShellContext);
  if (env === null) throw new Error('useShell: no Shell above this component.');
  return env;
}

/** The current session snapshot, re-read on every change (`useSyncExternalStore`). */
export function useSession(): ShellSnapshot {
  const { session } = useShell();
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}

/** Replaces `{name}` placeholders in a label. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) =>
    Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : m,
  );
}
