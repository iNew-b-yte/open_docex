/**
 * `DocumentInstanceFactory` (LLD Part 2 §8.3): picks the kind policy for a file format and
 * builds instances in state `LOADING`.
 *
 * @module
 */
import type { DocumentId } from '@open-docex/shared/ids';
import type { DocKind, FileFormat } from '@open-docex/shared/protocol';
import { engineError } from '../errors/engine-error.js';
import type { StorageRef } from '../storage/storage-adapter.js';
import { DocumentInstance, type CoreDeps, type InstanceHooks } from './document-instance.js';
import { textKindPolicy, type KindPolicy } from './kind-policy.js';

/** Builds document instances. */
export class DocumentInstanceFactory {
  readonly deps: CoreDeps;
  readonly #text: KindPolicy<unknown, unknown>;

  constructor(deps: CoreDeps) {
    this.deps = deps;
    const c = deps.config.load.chunk;
    const text = textKindPolicy(
      { textBlocks: c.textBlocks, sheetRows: c.sheetRows, maxBytes: c.maxBytes },
      deps.config.blankDocument.page,
    );
    this.#text = text;
  }

  /**
   * The document kind of a file format.
   *
   * @throws {OpenDocexError} `DOCUMENT_UNSUPPORTED_CONTENT` for sheet formats in V1.
   */
  kindOf(format: FileFormat): DocKind {
    if (format === 'docx' || format === 'odt') return 'text';
    throw engineError('DOCUMENT_UNSUPPORTED_CONTENT', { message: 'Spreadsheets need V2.' });
  }

  /** The kind policy for `kind`. */
  policyFor(kind: DocKind): KindPolicy<unknown, unknown> {
    if (kind === 'text') return this.#text;
    throw engineError('DOCUMENT_UNSUPPORTED_CONTENT', { message: 'Spreadsheets need V2.' });
  }

  /** Creates an instance in state `LOADING`. Call `load()` next. */
  create(id: DocumentId, doc: { ref: StorageRef; format: FileFormat }, hooks?: InstanceHooks): DocumentInstance {
    return new DocumentInstance(this.deps, id, doc, this.policyFor(this.kindOf(doc.format)), hooks);
  }
}
