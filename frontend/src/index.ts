/**
 * `@open-docex/client`: the open_docex browser client (LLD Part 3).
 *
 * The package exports `mount` and its public types only (LLD Part 3 §1). No React type or
 * component is exported (PO-12). The adopter also imports `@open-docex/client/style.css`.
 *
 * @module
 */
export { mount, type MountHandle } from './mount.js';
export type {
  AuthOption,
  ConnectOptions,
  DeepPartial,
  DocumentKind,
  MountHooks,
  MountOptions,
  ShellItemId,
  TextToolbarItemId,
  ToolbarConfig,
  UiOptions,
} from './options.js';
export type {
  ClientError,
  LoadProgress,
  MountEvents,
  ReadyEvent,
  SessionStatus,
  SyncEvent,
} from './events.js';
export type { Labels } from './labels.js';
export type { Theme, ThemeVarName } from './theme.js';
