# Changelog

All notable changes to `@open-docex/shared`, `@open-docex/server` and `@open-docex/client` are listed here. The three packages share one version number (lockstep).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Dates are UTC.

## [0.1.1] - not yet published

Package metadata only. There are no code changes.

### Changed

- **Discoverability on npm.** Each package now carries `keywords`, a `repository` link (with the package folder), `homepage`, `bugs` and `author`, and a clearer `description`, so the npm page links back to the source and the project README and shows up in searches. Version 0.1.0 was published without these fields, and npm does not allow changing a published version, so this is a new version.

## [0.1.0] - 2026-11-27

First release: **V1, collaborative text documents.**

### Added

- **Collaborative editing of `.docx` and `.odt` documents.** Many users edit one document at the same time. The server orders every change, acknowledges it after it is written to a journal, and broadcasts it. Typing shows at once on the typist's screen and is corrected if another change came first.
- **Server (`@open-docex/server`):**
  - `createEngine`, with the engine in a worker process (default) or in your main process. A supervisor restarts the worker with back-off and gives up after repeated crashes.
  - Import and export through an installed LibreOffice, which the adopter provides (it is not bundled). A missing LibreOffice fails at start-up with `CONFIG_LIBREOFFICE_NOT_FOUND`.
  - Storage through an adapter port. `LocalFsStorage` is included.
  - A local journal and snapshots per document, so a crash of the engine process does not lose acknowledged changes made since the last flush. With the default `journal.fsync` of `interval` (1 s), a power loss can lose up to about one second of them; `always` closes that gap.
  - Flush to storage on a schedule, with the recovery states LOCAL, PENDING and CONFLICT, and `recovery.resolve` with `'overwrite-storage'`, `'discard-local'` and `'mark-resolved'`.
  - Audit events, delivered at least once and flagged `replayed` after a crash.
  - An `authorize` callback for every connection (401, 403, edit or view access), view-only sessions, slow-consumer protection and size limits.
  - Documents with content the editor cannot represent open read-only, with a list of what was found, until the adopter allows editing.
  - An in-memory queue per document.
- **Client (`@open-docex/client`):**
  - `mount()` into your page. React is used inside it and needs no setup from you.
  - Text editing with headings, lists, tables (including column resizing), links, images (toolbar, paste and drag-and-drop, with resizing), character and paragraph formatting, page breaks, page-number and page-count fields, and headers and footers.
  - Page frames on screen, as in a word processor.
  - Reconnect and resume after a dropped connection, a notice when changes could not be restored, and a warning before leaving a page with unconfirmed changes.
- **Shared (`@open-docex/shared`):** the protocol, the error catalogue (`ERROR_CATALOGUE`), ids, the text model and the text operational transform, used by both sides.
- **Documentation:** a README for each package, with the configuration, the `authorize` callback, the worker configuration module, security notes and the error-code table.

### Known limits

- **Text documents only.** Spreadsheets arrive in a later version, so `@open-docex/shared` has no `./sheet` export yet.
- **No undo or redo** in the editor, by design (PO-18).
- **Unsupported content** (for example tracked changes, comments, footnotes, linked images and macros) makes a document open read-only. Named paragraph styles are flattened to direct formatting on import, and an indent set inside a list item is not kept on save.
- **One server per document.** The queue is in memory, so running several servers on the same document is the adopter's responsibility.
- **Capacity,** measured on one Windows machine with a fake codec (`docs/benchmarks/V1.md`): 8,000 idle connections per process with no failures; about 1,000 active typists keep the 99th-percentile acknowledgement under 100 ms and 2,000 do not. Thousands of active connections are therefore not met. On Windows, a burst of more than about 230 new connections at once was refused by the operating system in the benchmark.
- **LibreOffice versions** 26.2.7.3 and 26.8.3.1 were tested.
