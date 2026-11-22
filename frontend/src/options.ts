/**
 * Public mount options, their defaults and `validateOptions` (LLD Part 3 §2.1–§2.2,
 * LLD §0 L-13, L-14).
 *
 * @module
 */
import { OpenDocexError } from '@open-docex/shared/errors';
import type { DocumentId } from '@open-docex/shared/ids';
import type { ClientError } from './events.js';
import type { Labels } from './labels.js';
import type { Theme } from './theme.js';

/** The kind of document. `'sheet'` requires V2. */
export type DocumentKind = 'text' | 'sheet';

/** Options for `mount` (LLD Part 3 §2.1). */
export interface MountOptions {
  /** The `ws:` or `wss:` endpoint, for example `'wss://app.example.com/open-docex'` (HLD §10.1). */
  url: string;
  /** Sent as the `doc` query parameter. */
  documentId: DocumentId;
  /** Chooses the editor. It must equal the server's `load-start.kind`. */
  kind: DocumentKind;
  connect?: ConnectOptions;
  hooks?: MountHooks;
  ui?: UiOptions;
}

/** Connection settings (LLD Part 3 §2.1). */
export interface ConnectOptions {
  /** How the session authenticates. Default `{ type: 'cookie' }`. */
  auth?: AuthOption;
  /** Default 25 000 / 10 000 ms. */
  heartbeat?: { intervalMs?: number; timeoutMs?: number };
  /** Default 500 / 30 000 ms. */
  reconnect?: { baseDelayMs?: number; maxDelayMs?: number };
}

/**
 * Authentication on the WebSocket upgrade (HLD §14): a cookie, or a token in the query string
 * or the subprotocol. `getToken` is called on every connect. A query-string token can appear in
 * proxy and server logs.
 */
export type AuthOption =
  | { type: 'cookie' }
  | { type: 'query'; param: string; getToken: () => string | Promise<string> }
  | { type: 'subprotocol'; getToken: () => string | Promise<string> };

/** Adopter callbacks (LLD Part 3 §2.1). */
export interface MountHooks {
  /** The share button is hidden when this is absent. */
  onShare?: (documentId: DocumentId) => void;
  /** The "Edit anyway" button is hidden when this is absent (PO-13). */
  onEditAnyway?: (documentId: DocumentId) => void | Promise<void>;
  /** Called for every error the editor surfaces. */
  onError?: (error: ClientError) => void;
}

/** UI settings (LLD Part 3 §2.1, §0 L-14). */
export interface UiOptions {
  /** `false` hides the toolbar entirely. */
  toolbar?: false | ToolbarConfig;
  theme?: Theme;
  labels?: DeepPartial<Labels>;
  /** Warn before the page is left while changes are unconfirmed. Default `true` (L-14). */
  confirmUnload?: boolean;
}

/** Toolbar settings (LLD Part 3 §2.1, §0 L-13). */
export interface ToolbarConfig {
  text?: { items?: readonly TextToolbarItemId[]; fontFamilies?: readonly string[]; fontSizes?: readonly number[] };
  shell?: { items?: readonly ShellItemId[] };
}

/** Text toolbar items (LLD Part 3 §9). */
export type TextToolbarItemId =
  | 'paragraphStyle'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'fontFamily'
  | 'fontSize'
  | 'textColor'
  | 'link'
  | 'alignLeft'
  | 'alignCenter'
  | 'alignRight'
  | 'alignJustify'
  | 'bulletList'
  | 'orderedList'
  | 'indent'
  | 'outdent'
  | 'insertTable'
  | 'tableAddRowBefore'
  | 'tableAddRowAfter'
  | 'tableAddColBefore'
  | 'tableAddColAfter'
  | 'tableDeleteRow'
  | 'tableDeleteCol'
  | 'tableMerge'
  | 'tableSplit'
  | 'tableToggleHeaderRow'
  | 'tableDelete'
  | 'insertImage'
  | 'imageAlt'
  | 'pageBreak'
  | 'header'
  | 'footer'
  | 'pageSetup';

/** Shell toolbar items. V1 has only `'share'`; `'upload'` comes in V4 and `'annotations'` in V5. */
export type ShellItemId = 'share';

/** Every property optional, recursively. Arrays and functions are kept whole. */
export type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? T
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

/** Every text toolbar item, in toolbar order (LLD Part 3 §9). */
export const TEXT_TOOLBAR_ITEMS: readonly TextToolbarItemId[] = Object.freeze([
  'paragraphStyle', 'fontFamily', 'fontSize', 'bold', 'italic', 'underline', 'strike', 'textColor',
  'link', 'alignLeft', 'alignCenter', 'alignRight', 'alignJustify', 'bulletList', 'orderedList',
  'indent', 'outdent', 'insertTable', 'tableAddRowBefore', 'tableAddRowAfter', 'tableAddColBefore',
  'tableAddColAfter', 'tableDeleteRow', 'tableDeleteCol', 'tableMerge', 'tableSplit',
  'tableToggleHeaderRow', 'tableDelete', 'insertImage', 'imageAlt', 'pageBreak', 'header', 'footer',
  'pageSetup',
]);

/** Every shell toolbar item (V1). */
export const SHELL_ITEMS: readonly ShellItemId[] = Object.freeze(['share']);

/** Default font families (LLD §0 L-13). */
export const DEFAULT_FONT_FAMILIES: readonly string[] = Object.freeze([
  'Arial', 'Times New Roman', 'Courier New', 'Georgia', 'Verdana',
]);

/**
 * Default font sizes in pt, spanning 8–72 (LLD §0 L-13). L-13 gives only the range; the steps
 * are the common word-processor list.
 */
export const DEFAULT_FONT_SIZES: readonly number[] = Object.freeze([
  8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72,
]);

/** A page-size preset for the page setup dialog, portrait, in pt. */
export interface PagePreset {
  id: 'A4' | 'Letter' | 'Legal' | 'A3' | 'A5';
  width: number;
  height: number;
}

const MM = 72 / 25.4;
const mm = (n: number): number => Math.round(n * MM * 100) / 100;

/** Default page presets (LLD §0 L-13), in pt. ISO sizes are rounded to 0.01 pt. */
export const DEFAULT_PAGE_PRESETS: readonly Readonly<PagePreset>[] = Object.freeze([
  Object.freeze({ id: 'A4', width: mm(210), height: mm(297) } as const),
  Object.freeze({ id: 'Letter', width: 612, height: 792 } as const),
  Object.freeze({ id: 'Legal', width: 612, height: 1008 } as const),
  Object.freeze({ id: 'A3', width: mm(297), height: mm(420) } as const),
  Object.freeze({ id: 'A5', width: mm(148), height: mm(210) } as const),
]);

/** Default heartbeat and reconnect timings, in ms (LLD Part 3 §2.1). */
export const DEFAULT_HEARTBEAT = Object.freeze({ intervalMs: 25_000, timeoutMs: 10_000 });
export const DEFAULT_RECONNECT = Object.freeze({ baseDelayMs: 500, maxDelayMs: 30_000 });

/** Options after defaults are applied. Internal; the session (V1-31) consumes it. */
export interface ResolvedOptions {
  url: string;
  documentId: DocumentId;
  kind: DocumentKind;
  auth: AuthOption;
  heartbeat: { intervalMs: number; timeoutMs: number };
  reconnect: { baseDelayMs: number; maxDelayMs: number };
  hooks: MountHooks;
  toolbar: false | {
    text: { items: readonly TextToolbarItemId[]; fontFamilies: readonly string[]; fontSizes: readonly number[] };
    shell: { items: readonly ShellItemId[] };
  };
  theme: Theme;
  labels: DeepPartial<Labels> | undefined;
  confirmUnload: boolean;
}

/** Longest document ID, matching shared `asDocumentId` (LLD §0 L-5). */
const MAX_DOCUMENT_ID_LENGTH = 1024;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/u;

function invalid(message: string): OpenDocexError {
  return new OpenDocexError('CONFIG_INVALID', message);
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

/**
 * Checks `options` (LLD Part 3 §2.2). The element check (already mounted) is done by `mount`.
 * Messages name the option but never echo its value, so a token can't leak into them.
 *
 * @throws {OpenDocexError} `CONFIG_INVALID` for a missing `url` or `documentId`, a `url` that
 *   isn't `ws:` or `wss:`, a `kind` other than `'text'` or `'sheet'`, or a `query` auth
 *   without `param`.
 */
export function validateOptions(options: unknown): asserts options is MountOptions {
  if (!isObject(options)) throw invalid('mount: options must be an object.');
  const { url, documentId, kind, connect } = options;
  if (typeof url !== 'string' || url.length === 0) throw invalid('mount: `url` is required.');
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw invalid('mount: `url` is not a valid URL.');
  }
  if (protocol !== 'ws:' && protocol !== 'wss:') throw invalid('mount: `url` must use ws: or wss:.');
  if (typeof documentId !== 'string' || documentId.length === 0) {
    throw invalid('mount: `documentId` is required.');
  }
  if (documentId.length > MAX_DOCUMENT_ID_LENGTH || CONTROL_CHARS.test(documentId)) {
    throw invalid('mount: `documentId` must be 1–1024 characters with no control characters.');
  }
  if (kind !== 'text' && kind !== 'sheet') throw invalid("mount: `kind` must be 'text' or 'sheet'.");
  if (connect !== undefined) {
    if (!isObject(connect)) throw invalid('mount: `connect` must be an object.');
    const auth = connect.auth;
    if (auth !== undefined) {
      if (!isObject(auth)) throw invalid('mount: `connect.auth` must be an object.');
      if (auth.type === 'query') {
        if (typeof auth.param !== 'string' || auth.param.length === 0) {
          throw invalid('mount: `connect.auth.param` is required for query auth.');
        }
      }
      if ((auth.type === 'query' || auth.type === 'subprotocol') && typeof auth.getToken !== 'function') {
        throw invalid('mount: `connect.auth.getToken` must be a function.');
      }
      if (auth.type !== 'cookie' && auth.type !== 'query' && auth.type !== 'subprotocol') {
        throw invalid("mount: `connect.auth.type` must be 'cookie', 'query' or 'subprotocol'.");
      }
    }
  }
}

/** Applies the defaults of LLD Part 3 §2.1 and §0 L-13, L-14 to validated options. */
export function withDefaults(options: MountOptions): ResolvedOptions {
  const { connect, ui } = options;
  const toolbar = ui?.toolbar;
  return {
    url: options.url,
    documentId: options.documentId,
    kind: options.kind,
    auth: connect?.auth ?? { type: 'cookie' },
    heartbeat: {
      intervalMs: connect?.heartbeat?.intervalMs ?? DEFAULT_HEARTBEAT.intervalMs,
      timeoutMs: connect?.heartbeat?.timeoutMs ?? DEFAULT_HEARTBEAT.timeoutMs,
    },
    reconnect: {
      baseDelayMs: connect?.reconnect?.baseDelayMs ?? DEFAULT_RECONNECT.baseDelayMs,
      maxDelayMs: connect?.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT.maxDelayMs,
    },
    hooks: options.hooks ?? {},
    toolbar: toolbar === false
      ? false
      : {
          text: {
            items: toolbar?.text?.items ?? TEXT_TOOLBAR_ITEMS,
            fontFamilies: toolbar?.text?.fontFamilies ?? DEFAULT_FONT_FAMILIES,
            fontSizes: toolbar?.text?.fontSizes ?? DEFAULT_FONT_SIZES,
          },
          shell: { items: toolbar?.shell?.items ?? SHELL_ITEMS },
        },
    theme: ui?.theme ?? {},
    labels: ui?.labels,
    confirmUnload: ui?.confirmUnload ?? true,
  };
}
