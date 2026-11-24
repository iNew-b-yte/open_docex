/**
 * The text editor: a ProseMirror `EditorView` over the shared `textSchema`, with the toolbar
 * commands (LLD Part 3 §9; §0 PO-18, PO-20, PO-24, PO-25, S-7).
 *
 * The editor does not import the sync client. Its plugins (V1-32) and the header/footer and
 * pagination plugins (V1-34) are passed in through {@link TextEditorDeps.plugins}, which is
 * called on every {@link TextEditorView.load} so each load starts with fresh plugin state.
 *
 * @module
 */
import { textSchema, type TextSnapshot } from '@open-docex/shared/text';
import { EditorState, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { AssetCache } from '../assets/AssetCache.js';
import type { ClientError } from '../events.js';
import type { Labels } from '../labels.js';
import type { TextToolbarItemId, ToolbarConfig } from '../options.js';
import type { LinkOpener } from '../security/href.js';
import { buildCommands, setParagraphFormat, type DialogCommandId, type EditorCommand, type ParagraphFormat } from './commands.js';
import type { NaturalSize } from './imageUpload.js';
import { BlockResizeSignal } from './nodeviews/BlockResizeSignal.js';
import { buildPlugins, readOnlyKey, type EditorPluginSlots } from './plugins.js';

export type { EditorCommand, DialogCommandId, ParagraphFormat } from './commands.js';
export type { EditorPluginSlots } from './plugins.js';

/** What the editor needs (LLD Part 3 §9). */
export interface TextEditorDeps {
  assets: AssetCache;
  labels: Labels;
  toolbar: Required<NonNullable<ToolbarConfig['text']>>;
  /** Asset failures (`CLIENT_IMAGE_TYPE_UNSUPPORTED`, `CLIENT_ASSET_TOO_LARGE`, server codes). */
  onError(e: ClientError): void;
  /**
   * The plugins from other modules, by slot: the sync plugin (V1-32), header/footer regions
   * and pagination (V1-34). Called on every `load`, with that load's read-only flag.
   */
  plugins?(load: { readOnly: boolean }): EditorPluginSlots;
  /**
   * The S-7 size signal shared with the pagination plugin. When omitted the editor makes its
   * own, exposed as {@link TextEditorView.blockResize}.
   */
  blockResize?: BlockResizeSignal;
  /** Opens a command's dialog (V1-35). Without it, dialog commands need their `arg`. */
  requestDialog?: (id: DialogCommandId) => void;
  /** Picks an image file for `insertImage`. Default: a hidden file input. */
  pickFile?: (view: EditorView) => Promise<File | null>;
  /** Measures an image's natural size in CSS px. Default: `createImageBitmap`. */
  measureImage?: (blob: Blob) => Promise<NaturalSize | null>;
  /** Opens links on Mod+click. Default `window`. */
  opener?: LinkOpener;
}

/** The text editor (LLD Part 3 §9). */
export class TextEditorView {
  readonly #host: HTMLElement;
  readonly #deps: TextEditorDeps;
  readonly #commands: ReadonlyMap<TextToolbarItemId, EditorCommand>;
  readonly #listeners = new Set<() => void>();
  /** The S-7 size signal: image node views report size changes here. */
  readonly blockResize: BlockResizeSignal;
  #view: EditorView | null = null;
  #destroyed = false;

  constructor(host: HTMLElement, deps: TextEditorDeps) {
    this.#host = host;
    this.#deps = deps;
    this.blockResize = deps.blockResize ?? new BlockResizeSignal();
    const commandDeps = {
      images: this.#imageDeps(),
      ...(deps.requestDialog ? { requestDialog: deps.requestDialog } : {}),
      ...(deps.pickFile ? { pickFile: deps.pickFile } : {}),
    };
    this.#commands = buildCommands(deps.toolbar.items, commandDeps);
  }

  /**
   * Shows `doc` (an assembled `TextSnapshot`), creating the view on the first call and
   * replacing its state on later ones (a reload). Plugins are rebuilt from `deps.plugins`.
   */
  load(doc: TextSnapshot, opts: { readOnly: boolean }): void {
    if (this.#destroyed) throw new Error('TextEditorView: load after destroy.');
    const state = EditorState.create({ schema: textSchema, doc, plugins: this.#plugins(opts.readOnly) });
    if (this.#view === null) {
      this.#view = new EditorView(this.#host, {
        state,
        dispatchTransaction: (tr) => this.#dispatch(tr),
        attributes: { class: 'odx-text-editor' },
      });
    } else {
      this.#view.updateState(state);
    }
    this.#notify();
  }

  /** The ProseMirror view. Throws before the first {@link load}. */
  get view(): EditorView {
    if (this.#view === null) throw new Error('TextEditorView: no document loaded yet.');
    return this.#view;
  }

  /**
   * Sets the editor's own read-only flag. The session calls this alongside the sync client's
   * `setReadOnly`, so a document that becomes editable mid-session (for example, after "Edit
   * anyway") is editable here too.
   */
  setReadOnly(readOnly: boolean): void {
    const view = this.#view;
    if (view === null || readOnlyKey.getState(view.state) === readOnly) return;
    view.dispatch(view.state.tr.setMeta(readOnlyKey, readOnly));
  }

  /** The toolbar commands for `deps.toolbar.items`, in that order. */
  commands(): ReadonlyMap<TextToolbarItemId, EditorCommand> {
    return this.#commands;
  }

  /**
   * Sets paragraph formatting (spacing, indents, line height, alignment; PO-20) on the selected
   * paragraphs and headings. The toolbar item list has no items for these (see
   * `TextToolbarItemId`), so they are offered here.
   */
  formatParagraph(format: ParagraphFormat): boolean {
    const view = this.view;
    return setParagraphFormat(format)(view.state, view.dispatch);
  }

  /** Calls `fn` after every state change, for toolbar re-renders. Returns the unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  /**
   * Destroys the view and its node views. Blob URLs belong to the `AssetCache`, which the
   * owner destroys (`AssetCache.destroy` revokes them).
   */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#listeners.clear();
    this.#view?.destroy();
    this.#view = null;
  }

  #imageDeps() {
    const deps = this.#deps;
    return {
      assets: deps.assets,
      onError: (e: ClientError) => deps.onError(e),
      ...(deps.measureImage ? { measure: deps.measureImage } : {}),
    };
  }

  #plugins(readOnly: boolean) {
    const deps = this.#deps;
    return buildPlugins({
      assets: deps.assets,
      images: this.#imageDeps(),
      resize: this.blockResize,
      readOnly,
      slots: deps.plugins?.({ readOnly }) ?? {},
      requestLinkDialog: () => {
        if (!deps.requestDialog || !this.#commands.get('link')?.isEnabled(this.view.state)) return false;
        deps.requestDialog('link');
        return true;
      },
      ...(deps.opener ? { opener: deps.opener } : {}),
    });
  }

  #dispatch(tr: Transaction): void {
    const view = this.#view;
    if (view === null || view.isDestroyed) return;
    view.updateState(view.state.apply(tr));
    this.#notify();
  }

  #notify(): void {
    for (const fn of [...this.#listeners]) fn();
  }
}
