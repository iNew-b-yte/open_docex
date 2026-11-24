/**
 * `collabSyncPlugin`: holds the unconfirmed local steps in plugin state (LLD Part 3 §7.1), as
 * prosemirror-collab does, so every local transaction is captured, including those other
 * plugins append. `TextSyncClient` holds the network state.
 *
 * It also enforces read-only mode and PO-18: there is no undo or redo before V6, so Mod-z,
 * Mod-y and Mod-Shift-z are swallowed, and native `historyUndo`/`historyRedo` input is
 * cancelled so contenteditable undo cannot change the DOM behind ProseMirror (§9).
 *
 * @module
 */
import { keydownHandler } from 'prosemirror-keymap';
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import type { Step } from 'prosemirror-transform';
import type { SyncMeta, SyncPluginState } from './types.js';

/** The key of the sync plugin's state and meta. */
export const syncKey = new PluginKey<SyncPluginState>('odx-sync');

/** The part of `TextSyncClient` the plugin calls. */
export interface FlushScheduler {
  /** Called after every view update; coalesces same-tick transactions into one flush. */
  scheduleFlush(): void;
}

/** The sync meta of a transaction, if any. */
export function syncMeta(tr: Transaction): SyncMeta | undefined {
  return tr.getMeta(syncKey) as SyncMeta | undefined;
}

/**
 * True for the sync client's rebuild transactions (remote, correction, confirmation). The
 * wrapped `tableEditing()` skips `fixTables` after them (LLD Part 3 §7.3, L5).
 */
export function isRebuild(tr: Transaction): boolean {
  return syncMeta(tr)?.kind === 'rebuild';
}

/** The sync plugin state of `state`. Throws if the plugin is not installed. */
export function getSyncState(state: EditorState): SyncPluginState {
  const s = syncKey.getState(state);
  if (s === undefined) throw new Error('collabSyncPlugin is not installed.');
  return s;
}

/** PO-18: undo and redo keys do nothing. */
const swallowHistoryKeys = keydownHandler({
  'Mod-z': () => true,
  'Mod-y': () => true,
  'Mod-Shift-z': () => true,
});

/**
 * The sync plugin (LLD Part 3 §7.1). Install it first. `init.readOnly` is the initial
 * read-only state; the client changes it with the `read-only` meta.
 */
export function collabSyncPlugin(client: FlushScheduler, init: { readOnly: boolean }): Plugin<SyncPluginState> {
  return new Plugin<SyncPluginState>({
    key: syncKey,
    state: {
      init: (): SyncPluginState => ({ pending: [], inflightCount: 0, readOnly: init.readOnly }),
      apply(tr, prev): SyncPluginState {
        const m = syncMeta(tr);
        if (m?.kind === 'rebuild') return { ...prev, pending: m.pending, inflightCount: m.inflightCount };
        if (m?.kind === 'set-inflight') return { ...prev, inflightCount: m.inflightCount };
        if (m?.kind === 'read-only') return { ...prev, readOnly: m.readOnly };
        if (tr.docChanged) {
          const added = tr.steps.map((s: Step, i) => ({ step: s, inverted: s.invert(tr.docs[i] as PMNode) }));
          return { ...prev, pending: [...prev.pending, ...added] };
        }
        return prev;
      },
    },
    // Local document changes are blocked while read-only, including appended ones; rebuilds pass.
    filterTransaction: (tr, state) => !tr.docChanged || isRebuild(tr) || !getSyncState(state).readOnly,
    props: {
      editable: (state) => !getSyncState(state).readOnly,
      handleKeyDown: (view, event) => swallowHistoryKeys(view, event),
      handleDOMEvents: {
        beforeinput: (_view, event) => {
          if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
            event.preventDefault();
            return true;
          }
          return false;
        },
      },
    },
    view: () => ({ update: () => client.scheduleFlush() }),
  });
}
