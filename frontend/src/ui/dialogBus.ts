/**
 * A tiny bus that carries "open this dialog" requests to the shell. The editor's
 * `requestDialog` (Mod+K, toolbar commands) and the toolbar both post to it. Internal.
 *
 * @module
 */
/** The dialogs the shell can show. */
export type DialogId = 'link' | 'imageAlt' | 'insertTable' | 'pageSetup' | 'paragraph';

/** Posts and receives dialog requests. */
export interface DialogBus {
  request: (id: DialogId) => void;
  subscribe: (fn: (id: DialogId) => void) => () => void;
}

/** Creates a bus. */
export function createDialogBus(): DialogBus {
  const listeners = new Set<(id: DialogId) => void>();
  return {
    request: (id) => {
      for (const fn of [...listeners]) fn(id);
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
