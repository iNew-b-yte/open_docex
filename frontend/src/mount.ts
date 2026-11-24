/**
 * `mount`: puts an editor into an element of the adopter's page (LLD Part 3 §2.2).
 *
 * It validates options, owns the `.odx-root` container, the theme, the event emitter, the
 * `onError` hook, the unload warning (L-14) and the teardown. The session (V1-31) and the React
 * shell (V1-35) plug in through {@link MountSeams}; {@link createDefaultSeams} (V1-36) wires the
 * real ones: the `DocumentSession`, the text binding (sync client, editor, asset cache,
 * regions and pagination) and a React root that renders the shell.
 *
 * @module
 */
import { OpenDocexError, type ErrorCode } from '@open-docex/shared/errors';
import { newClientId, type ClientId } from '@open-docex/shared/ids';
import type { LoadStartMsg } from '@open-docex/shared/protocol';
import { TextOtType, type TextSnapshot } from '@open-docex/shared/text';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AssetCache } from './assets/AssetCache.js';
import { Emitter, type ClientError, type MountEvents } from './events.js';
import { resolveLabels, type Labels } from './labels.js';
import type { RandomSource } from './net/backoff.js';
import type { OnlineTarget, WebSocketFactory } from './net/Connection.js';
import {
  DEFAULT_FONT_FAMILIES,
  DEFAULT_FONT_SIZES,
  validateOptions,
  withDefaults,
  type MountOptions,
  type ResolvedOptions,
} from './options.js';
import { DocumentSession } from './session/DocumentSession.js';
import type { BindingContext, DocumentBinding, ReadOnlyReason, SessionSync } from './session/ports.js';
import { collabSyncPlugin, isRebuild } from './sync/collabSyncPlugin.js';
import { TextSyncClient } from './sync/TextSyncClient.js';
import { HeaderFooterRegions } from './text/HeaderFooterRegions.js';
import { PaginationPlugin } from './text/PaginationPlugin.js';
import { TextEditorView } from './text/TextEditorView.js';
import { applyTheme } from './theme.js';
import { createDialogBus, type DialogBus } from './ui/dialogBus.js';
import { Shell } from './ui/Shell.js';
import type { ShellEnv } from './ui/useSession.js';

/** What `mount` returns (LLD Part 3 §2.1). */
export interface MountHandle {
  /** Subscribes to an event. Returns a function that unsubscribes. */
  on<E extends keyof MountEvents>(event: E, fn: (payload: MountEvents[E]) => void): () => void;
  /** Tears the editor down. Unconfirmed changes are lost. Calling it again does nothing. */
  destroy(): void;
}

/** Everything a session and shell get from `mount`. Internal. */
export interface MountContext {
  readonly options: ResolvedOptions;
  readonly labels: Readonly<Labels>;
  readonly emitter: Emitter<MountEvents>;
  /** The `.odx-root` container `mount` created and owns. */
  readonly container: HTMLElement;
  readonly clientId: ClientId;
  /** A per-mount prefix, for React's `identifierPrefix`. */
  readonly idPrefix: string;
}

/** The session seam (`DocumentSession`, V1-31). Internal. */
export interface MountSession {
  start(): void;
  /** Closes the socket with 1000, stops timers, destroys the editor and revokes blob URLs. */
  destroy(): void;
}

/** The shell seam (the React root, V1-35/V1-36). Internal. */
export interface ShellRoot {
  unmount(): void;
}

/** The parts of a mount that later tasks supply. Internal; not exported from the package. */
export interface MountSeams {
  createSession(ctx: MountContext): MountSession;
  renderShell(ctx: MountContext, session: MountSession): ShellRoot;
}

/** Elements that currently hold a mounted editor. */
const mounted = new WeakSet<HTMLElement>();
let mountSeq = 0;

function isElement(x: unknown): x is HTMLElement {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as Node).nodeType === 1 &&
    typeof (x as HTMLElement).append === 'function' &&
    (x as HTMLElement).ownerDocument !== null
  );
}

/**
 * Mounts an editor into `element` (LLD Part 3 §2.2). Several mounts on one page are
 * independent.
 *
 * @throws {OpenDocexError} `CONFIG_INVALID`, synchronously, for invalid options, a value that
 *   isn't an element, or an element that already holds an editor.
 */
export function mount(element: HTMLElement, options: MountOptions): MountHandle {
  return createMount(element, options, createDefaultSeams());
}

/**
 * `mount` with explicit seams. Internal: used by tests and by V1-36's wiring.
 */
export function createMount(element: HTMLElement, options: MountOptions, seams: MountSeams): MountHandle {
  if (!isElement(element)) throw new OpenDocexError('CONFIG_INVALID', 'mount: `element` must be an HTML element.');
  validateOptions(options);
  if (mounted.has(element)) throw new OpenDocexError('CONFIG_INVALID', 'mount: this element already holds an editor.');

  const resolved = withDefaults(options);
  const doc = element.ownerDocument;
  const win = doc.defaultView;
  const container = doc.createElement('div');
  container.className = 'odx-root';
  applyTheme(container, resolved.theme);

  const emitter = new Emitter<MountEvents>();
  const ctx: MountContext = {
    options: resolved,
    labels: resolveLabels(resolved.labels),
    emitter,
    container,
    clientId: newClientId(),
    idPrefix: `odx${mountSeq++}-`,
  };

  // Every surfaced error reaches `hooks.onError` (LLD Part 3 §16). The session only emits.
  const internal: Array<() => void> = [];
  const onError = resolved.hooks.onError;
  if (onError !== undefined) internal.push(emitter.on('error', (e) => onError(e)));

  // L-14: warn before leaving while changes are unconfirmed.
  let pendingCount = 0;
  internal.push(emitter.on('sync', (s) => (pendingCount = s.pendingCount)));
  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (pendingCount <= 0) return;
    event.preventDefault();
    // Older browsers show the prompt only when `returnValue` is set.
    event.returnValue = true;
  };
  const guardUnload = resolved.confirmUnload && win !== null;
  if (guardUnload) win.addEventListener('beforeunload', onBeforeUnload);

  let session: MountSession | undefined;
  let shell: ShellRoot | undefined;
  mounted.add(element);
  element.append(container);
  const teardown = (): void => {
    if (guardUnload) win.removeEventListener('beforeunload', onBeforeUnload);
    for (const off of internal.splice(0)) off();
    container.remove();
    mounted.delete(element);
  };
  try {
    session = seams.createSession(ctx);
    shell = seams.renderShell(ctx, session);
    session.start();
  } catch (err) {
    shell?.unmount();
    session?.destroy();
    teardown();
    emitter.clear();
    throw err;
  }

  let destroyed = false;
  const live = { session, shell };
  return {
    on: (event, fn) => (destroyed ? () => {} : emitter.on(event, fn)),
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      try {
        live.session.destroy();
        live.shell.unmount();
      } finally {
        teardown();
        emitter.emit('destroyed', undefined);
        emitter.clear();
      }
    },
  };
}

/** Test seams for the default wiring: the socket, the jitter source and the `online` target. */
export interface DefaultSeamOptions {
  createSocket?: WebSocketFactory;
  random?: RandomSource;
  onlineTarget?: OnlineTarget | null;
}

/** The text editor, shared between the binding (which creates it) and the shell (which reads it). */
interface EditorRef {
  current: TextEditorView | null;
}

/**
 * The text binding (LLD Part 3 §3, §6, §7, §9; S-37, S-39): builds the asset cache, the
 * editor (with the sync, regions and pagination plugins) and the sync client, and routes the
 * session's calls to them. The editor lives in a holder element this binding owns; `attach`
 * moves the holder into the element `EditorHost` renders, so the editor survives the shell
 * swapping `EditorHost` for the error screen and back.
 */
function createTextBinding(
  ctx: MountContext,
  b: BindingContext,
  bus: DialogBus,
  ref: EditorRef,
): DocumentBinding<TextSnapshot> {
  const holder = ctx.container.ownerDocument.createElement('div');
  holder.className = 'odx-editor-surface';
  const assets = new AssetCache({ send: (m) => b.send(m), connected: () => b.connected() });
  const regions = new HeaderFooterRegions({ assets, labels: ctx.labels });
  const toolbar = ctx.options.toolbar === false
    ? { items: [], fontFamilies: DEFAULT_FONT_FAMILIES, fontSizes: DEFAULT_FONT_SIZES }
    : ctx.options.toolbar.text;
  // The sync client reaches the editor through `view()`, which is only called after `show`.
  const editor: TextEditorView = new TextEditorView(holder, {
    assets,
    labels: ctx.labels,
    toolbar,
    onError: (e: ClientError) => ctx.emitter.emit('error', e),
    requestDialog: (id) => bus.request(id),
    plugins: ({ readOnly }) => ({
      sync: [collabSyncPlugin(client, { readOnly })],
      regions: [regions.plugin()],
      pagination: [PaginationPlugin({ regions, resize: editor.blockResize })],
      isRemote: isRebuild,
    }),
  });
  const client: TextSyncClient = new TextSyncClient({
    view: () => editor.view,
    send: (m) => b.send(m),
    clientId: b.clientId,
    emit: (e) => b.emitSync(e),
    reload: (reason, discard) => b.reload(reason, discard),
    notify: (n) => b.notify(n),
    onError: (code: ErrorCode) => b.reportError(code),
    activity: (a) => b.activity(a),
  });
  // The session calls the sync client; "Edit anyway" and the other read-only changes also
  // reach the editor (S-39), and a reconnect re-sends the outstanding asset requests.
  const sync: SessionSync = {
    start: (p) => client.start(p),
    onRemote: (m) => client.onRemote(m),
    onAck: (m) => client.onAck(m),
    onSubmitError: (m) => client.onSubmitError(m),
    onDisconnected: () => client.onDisconnected(),
    onReconnected: () => {
      client.onReconnected();
      assets.onReconnected();
    },
    setReadOnly: (ro: boolean, reason: ReadOnlyReason) => {
      client.setReadOnly(ro, reason);
      editor.setReadOnly(ro);
    },
    exportOrphans: () => client.exportOrphans(),
    restoreOrphans: (o, load) => client.restoreOrphans(o as ReturnType<TextSyncClient['exportOrphans']>, load),
    resumeInfo: () => client.resumeInfo(),
    destroy: () => client.destroy(),
  };
  return {
    assembler: TextOtType,
    sync,
    show: (snapshot, load) => {
      editor.load(snapshot, { readOnly: load.readOnly || load.access === 'view' });
      ref.current = editor;
    },
    onLoadStart: (m: LoadStartMsg) => assets.setMaxAssetBytes(m.limits?.maxAssetBytes),
    attach: (el) => {
      if (el === null) holder.remove();
      else el.append(holder);
    },
    onAsset: (m) => (m.type === 'error' ? assets.onAssetError(m) : assets.onAsset(m)),
    failAssetUpload: () => assets.failPuts(),
    destroy: () => {
      ref.current = null;
      editor.destroy();
      regions.destroy();
      assets.destroy();
      holder.remove();
    },
  };
}

/**
 * The default {@link MountSeams} (V1-36): a `DocumentSession` with the text binding, and a
 * React root on the container `mount` created. Each call makes the seams for one mount.
 * No StrictMode, and no React type leaves this module (PO-12).
 */
export function createDefaultSeams(extra: DefaultSeamOptions = {}): MountSeams {
  const bus = createDialogBus();
  const ref: EditorRef = { current: null };
  let session: DocumentSession | undefined;
  return {
    createSession: (ctx) => {
      session = new DocumentSession(ctx, {
        createBinding: (b) => createTextBinding(ctx, b, bus, ref),
        ...(extra.createSocket !== undefined ? { createSocket: extra.createSocket } : {}),
        ...(extra.random !== undefined ? { random: extra.random } : {}),
        ...(extra.onlineTarget !== undefined ? { onlineTarget: extra.onlineTarget } : {}),
      });
      return session;
    },
    renderShell: (ctx) => {
      const s = session;
      if (s === undefined) throw new Error('mount: renderShell before createSession.');
      const env: ShellEnv = {
        session: s,
        labels: ctx.labels,
        documentId: ctx.options.documentId,
        hooks: ctx.options.hooks,
        toolbar: ctx.options.toolbar,
        container: ctx.container,
        getEditor: () => ref.current,
        dialogs: bus,
      };
      const root = createRoot(ctx.container, { identifierPrefix: ctx.idPrefix });
      root.render(createElement(Shell, { env }));
      return { unmount: () => root.unmount() };
    },
  };
}
