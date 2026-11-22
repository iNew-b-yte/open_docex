/**
 * `@open-docex/shared/errors`: error codes, the catalogue, `OpenDocexError` and the
 * sanitized client form (HLD §11, LLD Part 1 §4).
 *
 * @module
 */
export {
  ERROR_CATALOGUE,
  type CatalogueEntry,
  type ErrorCategory,
  type ErrorCode,
  type ErrorSeverity,
} from './catalogue.js';
export {
  OpenDocexError,
  toClientError,
  type ClientErrorPayload,
  type OpenDocexErrorShape,
} from './open-docex-error.js';
