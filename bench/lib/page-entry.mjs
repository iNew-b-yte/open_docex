// The benchmark page: the e2e harness page plus a hook that hands the benchmark the editor's
// ProseMirror `EditorView` (`mount()` does not expose it). The client library keeps
// `prosemirror-view` external, so this bundle and the client share one `EditorView` class.
import { EditorView } from 'prosemirror-view';
import '../../e2e/harness/page-entry.mjs';

const originalUpdateState = EditorView.prototype.updateState;
EditorView.prototype.updateState = function (state) {
  window.__odxView = this;
  return originalUpdateState.call(this, state);
};
