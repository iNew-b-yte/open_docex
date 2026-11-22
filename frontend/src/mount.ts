/**
 * `mount`: puts an editor into an element of the adopter's page (LLD Part 3 §2.2).
 *
 * This is the V1-30 skeleton. It validates options, owns the `.odx-root` container, the theme,
 * the event emitter, the `onError` hook, the unload warning (L-14) and the teardown. The
 * session (V1-31) and the React shell (V1-35) plug in through {@link MountSeams}; V1-36 wires
 * the real ones in as the defaults.
 *
 * @module
 */
import { OpenDocexError } from '@open-docex/shared/errors';
import { newClientId, type ClientId } from '@open-docex/shared/ids';
import { Emitter, type MountEvents } from './events.js';
import { resolveLabels, type Labels } from './labels.js';
import { validateOptions, withDefaults, type MountOptions, type ResolvedOptions } from './options.js';
import { applyTheme } from './theme.js';

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

/** Until V1-36: a session and shell that do nothing. */
const SKELETON_SEAMS: MountSeams = {
  createSession: () => ({ start() {}, destroy() {} }),
  renderShell: () => ({ unmount() {} }),
};

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
  return createMount(element, options, SKELETON_SEAMS);
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
