/**
 * Every user-visible string, with English defaults (LLD Part 3 §2.1).
 *
 * The adopter overrides any string through `ui.labels`. No label is built from server text;
 * the one exception is that an error's sanitized `message` is shown when `errors[code]` has
 * no label (see {@link errorLabel}).
 *
 * @module
 */
import { ERROR_CATALOGUE, type ErrorCode } from '@open-docex/shared/errors';
import type { UnsupportedFeature } from '@open-docex/shared/protocol';
import type { DeepPartial, TextToolbarItemId } from './options.js';

/** All user-visible strings (LLD Part 3 §2.1). `{n}` is replaced by a number. */
export interface Labels {
  toolbar: Record<TextToolbarItemId | 'share', string>;
  status: {
    connecting: string;
    open: string;
    reconnecting: string;
    failed: string;
    closed: string;
    loading: string;
    synced: string;
    /** `{n}` is the number of unconfirmed changes. */
    pending: string;
    busy: string;
    restoring: string;
    storageLocal: string;
    storagePending: string;
    storageConflict: string;
    reload: string;
    retry: string;
    /** `{done}` of `{total}` chunks while loading. */
    loadingProgress: string;
    toolbarLabel: string;
  };
  banner: {
    unsupported: string;
    removedOnSave: string;
    editAnyway: string;
    editAnywayFailed: string;
    editingAnyway: string;
    /** `{n}` is the number of converted images (PO-22). */
    imagesConverted: string;
    /** `{n}` is the number of findings of one kind. */
    findingCount: string;
  };
  /** Names in the paragraph-style select. `{n}` is the heading level. */
  styles: { paragraph: string; heading: string };
  badge: Record<'view' | 'unsupported' | 'server' | 'restoring', string>;
  dialogs: {
    ok: string;
    cancel: string;
    linkTitle: string;
    linkHref: string;
    linkInvalid: string;
    imageAltTitle: string;
    imageAlt: string;
    pageSetupTitle: string;
    pageSize: string;
    orientation: string;
    portrait: string;
    landscape: string;
    margins: string;
    tableTitle: string;
    /** `{rows}` × `{cols}`. */
    tableSize: string;
    paragraphTitle: string;
    spacingBefore: string;
    spacingAfter: string;
    lineHeight: string;
    lineHeightNone: string;
    lineHeightMultiple: string;
    lineHeightExact: string;
    lineHeightAtLeast: string;
    indentLeft: string;
    indentRight: string;
    indentFirstLine: string;
    /** Shown when a Paragraph dialog value is outside its range. */
    invalidValue: string;
    rows: string;
    columns: string;
    pageWidth: string;
    pageHeight: string;
    marginTop: string;
    marginRight: string;
    marginBottom: string;
    marginLeft: string;
    invalidPage: string;
  };
  errors: Record<ErrorCode, string>;
  findings: Record<UnsupportedFeature, string>;
  notices: {
    readOnlyOn: string;
    readOnlyOff: string;
    engineRestarting: string;
    reloading: string;
    opRejected: string;
  };
  restore: {
    discarded: string;
    partialLoss: string;
    lost: string;
  };
}

const SERVICE_PROBLEM = 'The editing service hit a server problem.';

/** The English defaults. Frozen. */
export const DEFAULT_LABELS: Readonly<Labels> = deepFreeze({
  toolbar: {
    paragraphStyle: 'Paragraph style',
    bold: 'Bold',
    italic: 'Italic',
    underline: 'Underline',
    strike: 'Strikethrough',
    fontFamily: 'Font',
    fontSize: 'Font size',
    textColor: 'Text colour',
    link: 'Link',
    alignLeft: 'Align left',
    alignCenter: 'Centre',
    alignRight: 'Align right',
    alignJustify: 'Justify',
    bulletList: 'Bulleted list',
    orderedList: 'Numbered list',
    indent: 'Increase indent',
    outdent: 'Decrease indent',
    insertTable: 'Insert table',
    tableAddRowBefore: 'Insert row above',
    tableAddRowAfter: 'Insert row below',
    tableAddColBefore: 'Insert column left',
    tableAddColAfter: 'Insert column right',
    tableDeleteRow: 'Delete row',
    tableDeleteCol: 'Delete column',
    tableMerge: 'Merge cells',
    tableSplit: 'Split cell',
    tableToggleHeaderRow: 'Header row',
    tableDelete: 'Delete table',
    insertImage: 'Insert image',
    imageAlt: 'Alt text',
    pageBreak: 'Page break',
    header: 'Header',
    footer: 'Footer',
    pageSetup: 'Page setup',
    paragraph: 'Paragraph…',
    share: 'Share',
  },
  status: {
    connecting: 'Connecting…',
    open: 'Connected',
    reconnecting: 'Reconnecting…',
    failed: "Can't connect",
    closed: 'Disconnected',
    loading: 'Loading…',
    synced: 'All changes confirmed',
    pending: '{n} changes unconfirmed',
    busy: 'Server busy — retrying',
    restoring: 'Restoring unconfirmed changes',
    storageLocal: 'Saved on the server; storage unavailable',
    storagePending: 'Saved locally on the server; administrator action needed',
    storageConflict: 'Saved on the server; the stored file changed elsewhere',
    reload: 'Reload',
    retry: 'Retry',
    loadingProgress: '{done} of {total}',
    toolbarLabel: 'Formatting',
  },
  banner: {
    unsupported: "Parts of this file can't be edited here, so it opened read-only.",
    removedOnSave: 'If you edit anyway, those parts are removed when the document is saved.',
    editAnyway: 'Edit anyway',
    editAnywayFailed: 'Editing could not be enabled.',
    editingAnyway: 'Unsupported parts will be removed when the document is saved.',
    imagesConverted: '{n} images were converted and will be saved as PNG.',
    findingCount: '{n}',
  },
  styles: { paragraph: 'Paragraph', heading: 'Heading {n}' },
  badge: {
    view: 'View only',
    unsupported: 'Read-only: unsupported content',
    server: 'Read-only',
    restoring: 'Restoring…',
  },
  dialogs: {
    ok: 'OK',
    cancel: 'Cancel',
    linkTitle: 'Link',
    linkHref: 'Address',
    linkInvalid: 'Only http, https and mailto links are allowed.',
    imageAltTitle: 'Alt text',
    imageAlt: 'Description',
    pageSetupTitle: 'Page setup',
    pageSize: 'Page size',
    orientation: 'Orientation',
    portrait: 'Portrait',
    landscape: 'Landscape',
    margins: 'Margins',
    tableTitle: 'Insert table',
    tableSize: '{rows} × {cols}',
    paragraphTitle: 'Paragraph',
    spacingBefore: 'Spacing before (pt)',
    spacingAfter: 'Spacing after (pt)',
    lineHeight: 'Line height',
    lineHeightNone: 'Default',
    lineHeightMultiple: 'Multiple',
    lineHeightExact: 'Exactly (pt)',
    lineHeightAtLeast: 'At least (pt)',
    indentLeft: 'Left indent (pt)',
    indentRight: 'Right indent (pt)',
    indentFirstLine: 'First-line indent (pt, negative for hanging)',
    invalidValue: 'A value is outside its allowed range.',
    rows: 'Rows',
    columns: 'Columns',
    pageWidth: 'Width (pt)',
    pageHeight: 'Height (pt)',
    marginTop: 'Top (pt)',
    marginRight: 'Right (pt)',
    marginBottom: 'Bottom (pt)',
    marginLeft: 'Left (pt)',
    invalidPage: 'These page settings are not allowed.',
  },
  // User-facing behaviour column of LLD Part 3 §16.
  errors: {
    CONFIG_INVALID: 'Editor is misconfigured',
    CONFIG_LIBREOFFICE_NOT_FOUND: SERVICE_PROBLEM,
    CONFIG_DATA_DIR_UNWRITABLE: SERVICE_PROBLEM,
    STORAGE_READ_FAILED: 'Document could not be loaded',
    STORAGE_WRITE_FAILED: 'The document could not be written to storage. Editing continues.',
    STORAGE_LOCAL_MODE: 'Saved on the server; storage unavailable',
    STORAGE_PENDING: 'Saved locally on the server; administrator action needed',
    STORAGE_CONFLICT: 'Saved on the server; the stored file changed elsewhere',
    QUEUE_FULL: 'Server busy — retrying',
    QUEUE_UNAVAILABLE: 'Server busy — retrying',
    ENGINE_RESTARTING: 'Reconnecting — server restarting',
    ENGINE_UNAVAILABLE: 'Service unavailable',
    ENGINE_FAILED: 'Service unavailable',
    DOCUMENT_FAULTED: 'This document hit an error',
    DOCUMENT_UNSUPPORTED_CONTENT: "Parts of this file can't be edited here, so it opened read-only.",
    DOCUMENT_READ_ONLY: 'This document is read-only.',
    DOCUMENT_NOT_FOUND: 'Document not found',
    DOCUMENT_TOO_LARGE: 'The file is too large.',
    CONVERSION_FAILED: 'Document could not be opened',
    CONVERSION_TIMEOUT: 'Opening is taking too long',
    SESSION_SLOW_CONSUMER: 'Reloading…',
    SESSION_CLOSED: 'Session ended',
    SESSION_RESYNC_REQUIRED: 'Reloading…',
    ACCESS_DENIED: "You don't have permission",
    PROTOCOL_INVALID_MESSAGE: 'Reloading…',
    PROTOCOL_VERSION_UNSUPPORTED: 'Please refresh the page to update the editor',
    PROTOCOL_OP_REJECTED: 'A change could not be applied and was discarded',
    CLIENT_CONNECT_FAILED: "Can't connect",
    CLIENT_ASSET_TOO_LARGE: 'Image too large',
    CLIENT_IMAGE_TYPE_UNSUPPORTED: 'Only PNG, JPEG and GIF images can be added.',
  },
  findings: {
    'tracked-changes': 'Tracked changes',
    comments: 'Comments',
    footnotes: 'Footnotes',
    fields: 'Fields',
    'text-boxes': 'Text boxes',
    equations: 'Equations',
    charts: 'Charts',
    'multiple-page-styles': 'Multiple page styles',
    'first-page-header': 'First-page header or footer',
    'odd-even-header': 'Odd and even headers or footers',
    'conditional-formatting': 'Conditional formatting',
    'data-validation': 'Data validation',
    'pivot-tables': 'Pivot tables',
    'sheet-images': 'Images in sheets',
    'cell-comments': 'Cell comments',
    other: 'Other content',
  },
  notices: {
    readOnlyOn: 'This document is now read-only.',
    readOnlyOff: 'Editing is enabled.',
    engineRestarting: 'Reconnecting — server restarting',
    reloading: 'Reloading…',
    opRejected: 'A change could not be applied and was discarded',
  },
  restore: {
    discarded: 'Unconfirmed changes were discarded.',
    partialLoss: 'Some changes could not be restored.',
    lost: 'Unconfirmed changes could not be restored.',
  },
});

function deepFreeze<T extends object>(o: T): Readonly<T> {
  for (const v of Object.values(o)) if (typeof v === 'object' && v !== null) deepFreeze(v as object);
  return Object.freeze(o);
}

/**
 * Merges adopter overrides into the defaults. Only keys that exist in the defaults are read,
 * and only string values replace a default, so unknown or prototype keys (`__proto__`) are
 * never copied. The result is frozen.
 */
export function resolveLabels(overrides: DeepPartial<Labels> | undefined): Readonly<Labels> {
  if (overrides === undefined || overrides === null || typeof overrides !== 'object') return DEFAULT_LABELS;
  return deepFreeze(merge(DEFAULT_LABELS, overrides) as Labels);
}

function merge(defaults: object, overrides: unknown): object {
  const out: Record<string, unknown> = {};
  const over = typeof overrides === 'object' && overrides !== null ? (overrides as Record<string, unknown>) : {};
  for (const [key, def] of Object.entries(defaults)) {
    const has = Object.prototype.hasOwnProperty.call(over, key);
    const value = has ? over[key] : undefined;
    if (typeof def === 'string') out[key] = typeof value === 'string' ? value : def;
    else out[key] = merge(def as object, value);
  }
  return out;
}

/**
 * The text shown for an error: `labels.errors[code]` when it has a label, otherwise the
 * error's sanitized `message`, otherwise the catalogue's client message (LLD Part 3 §2.1, §15).
 * An unknown `code` never indexes the label table.
 */
export function errorLabel(labels: Readonly<Labels>, code: string, message?: string): string {
  if (Object.prototype.hasOwnProperty.call(labels.errors, code)) {
    const label = labels.errors[code as ErrorCode];
    if (label.length > 0) return label;
  }
  if (message !== undefined && message.length > 0) return message;
  if (Object.prototype.hasOwnProperty.call(ERROR_CATALOGUE, code)) return ERROR_CATALOGUE[code as ErrorCode].clientMessage;
  return '';
}
