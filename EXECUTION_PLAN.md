# open_docex — Execution Plan

| | |
|---|---|
| **Status** | Active. The orchestrator (main agent) owns this file and keeps the Status column current (AGENTS.md §4). |
| **Built from** | `HLD.md`, `LLD.md` (§0 wins over Parts 1–3) and `VERSION_PLAN.md` |
| **Rules** | AGENTS.md. Never start a task whose dependencies aren't `done`. Tasks with the same track and disjoint file scopes may run in parallel. |

**Status values:** `todo`, `in-progress`, `review`, `done`, `blocked (reason)`.

**Columns:**
- **Files:** the only paths the task may create or change. Every task also owns its own tests under the package's `test/` mirror of those paths.
- **LLD:** the sections to implement.
- **Deps:** task IDs that must be `done` first.

**Every task's acceptance** also includes the AGENTS.md §5 definition of done.

---

## V1 — Collaborative text documents

### V1 parallelism map

```
V1-00 ─┬─ V1-01 ─┬─ V1-02 ───────────────┬─ V1-18 ─┐
       │         ├─ V1-03 ─ V1-04 ───────┤          │
       │         ├─ V1-10, V1-11, V1-12, V1-13 ─────┼─ V1-15 ─ V1-16, V1-17 ─ V1-19 ─ V1-20 ─┬─ V1-40 ─ V1-43
       │         └─ V1-30 ─ V1-31 ─ V1-32 ──────────┘                                       │
       ├─ V1-S2 (spike) ─ V1-14a ─ V1-14b ────────────────────────────────────────────────── ┤
       ├─ V1-S3 (spike) ─ V1-33 ─ V1-34 ─ V1-35 ─ V1-36 ────────────────────────────────────┘
       └─ V2-S1 (spike; may run during V1)          V1-41 and V1-42 after V1-20
```

### V1 tasks

| ID | Task | Track | Files | LLD | Deps | Acceptance | Status |
|---|---|---|---|---|---|---|---|
| V1-00 | **Monorepo bootstrap** | tooling | root `package.json`, `package-lock.json`, `tsconfig.base.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `.gitignore`, `.github/workflows/ci.yml` (jobs `static`, `test`, `test-windows` only), `scripts/`, `shared/package.json`, `backend/package.json`, `frontend/package.json`, `shared/src/env.d.ts`, `frontend/vite.config.ts` (minimal lib-mode settings of P1 §1.5 only) and each package's tsconfig, Vitest config and `src/index.ts` stub | P1 §1; §0 L-1 | — | `npm ci`, `build`, `typecheck`, `lint` and `test` pass locally. CI runs on Node 22/24/26 with LibreOffice installed. The licence check passes. The `.gitkeep` files are removed. | done |
| V1-S2 | **Spike S2: LibreOffice ↔ flat ODF round trip**, covering every V1 feature (§8.1, PO-20/21/22/24/25) for .docx and .odt, timings, concurrent profiles on Linux and Windows, and EMF/WMF/TIFF/SVG → PNG | spike | `spikes/S2/**`, `docs/spikes/S2.md`, `backend/test/fixtures/text/**` (corpus) | HLD §20 S2; P2 §14 | V1-00 | A written report gives, per feature, whether it imports, exports and round-trips. The fixture corpus is committed. Any blocker goes to the project owner. | in-progress |
| V1-S3 | **Spike S3: pagination prototype** in ProseMirror: page frames, whole-block moves, overflow (PO-23), header/footer copies, a 200-page document | spike | `spikes/S3/**`, `docs/spikes/S3.md` | HLD §20 S3; P3 §10–§11 | V1-00 | The report gives measured re-layout times and the chosen approach. | in-progress |
| V1-01 | **shared: ids, errors and util,** including the `CLIENT_*` codes and `computeAssetId` | shared | `shared/src/{ids,errors,util}/**` | P1 §3, §4; §0 R-12, L-16 | V1-00 | Every HLD §11.2 code is in `ERROR_CATALOGUE`. `toClientError` strips the cause. Unit tests. | in-progress |
| V1-02 | **shared: protocol.** All messages, validation, encode/decode, binary frames and close codes, plus `WS_SUBPROTOCOL` and `DOC_QUERY_PARAM` | shared | `shared/src/protocol/**`, `shared/fixtures/protocol/**` | P1 §5, §6; §0 R-3, R-4, R-5, R-10, R-12, R-13 | V1-01 | Contract fixtures exist for every message, including V4/V5 shapes. Invalid input is rejected. | todo |
| V1-03 | **shared: the `OtType` interface and the text schema.** Includes `textDefaults`, the paragraph and heading attributes, `page_field`, `colwidth`, image size, the href allowlist, and text chunk/assemble. | shared | `shared/src/ot/**`, `shared/src/text/schema*.ts`, `shared/src/text/chunk.ts` | P1 §7, §8.1–§8.2; §0 R-14, R-17, L-2 | V1-01 | The schema round-trips JSON. Unsafe hrefs are refused. `chunk` then `assemble` gives an identical document. | todo |
| V1-04 | **shared: text OT.** `rebaseSteps`, `rebaseOverMaps`, `rebaseStepsOnDoc`, `applyStepsWithDrop`, `TextOtType` and `textOpsEqual` | shared | `shared/src/text/{rebase,apply,ot,equal}.ts` | P1 §8.3–§8.6; §0 R-6 | V1-03 | The fixed concurrency scenarios converge, including BRD §3 "cat", overlapping deletes, a split versus typing, and a dropped step with dependents. Prefix consistency holds. Spike S5 is covered. | todo |
| V1-10 | **server: options, validation, events, logger and error mapping** | server | `backend/src/api/{options,validate-options,events,typed-emitter}.ts`, `backend/src/log/**`, `backend/src/errors/**` | P2 §2–§3, §19; §0 L-7, L-8, L-9, R-20 | V1-01 | Invalid config fails with the right `CONFIG_*` code. Defaults match HLD §12. | todo |
| V1-11 | **server: persistence.** Layout, atomic files, journal, snapshots, meta (including `auditEmittedRev`), assets and the data-dir lock | server | `backend/src/persistence/**` | P2 §10; §0 R-19 | V1-01 | Journal append and replay; a crash mid-write leaves no corrupt entry; fsync modes; hashed names only. | todo |
| V1-12 | **server: storage.** The port, `LocalFsStorage`, the storage router and the conformance kit | server | `backend/src/storage/**`, `backend/test-kit/storage/**` | P2 §11, §21 | V1-01 | `LocalFsStorage` passes the conformance kit. Path traversal is rejected. | todo |
| V1-13 | **server: the queue port and `MemoryQueue`** | server | `backend/src/queue/{queue-adapter,memory-queue}.ts` | P2 §9.1–§9.3 | V1-01 | FIFO per document; per-document and global bounds give `QUEUE_FULL`; one consumer per document. | todo |
| V1-14a | **server: codec infrastructure.** Pool and thread, LibreOffice locate/runner/profile, zip guard, hardened XML reader, ODF units | server | `backend/src/codec/{codec-service,codec-pool,codec-thread,libreoffice-locate,libreoffice-runner,lo-profile,zip-guard,xml-reader,odf-units}.ts` | P2 §14.1–§14.4 | V1-S2, V1-10 | Concurrency cap, timeout and kill work. A missing LibreOffice gives `CONFIG_LIBREOFFICE_NOT_FOUND`. A zip bomb and XXE fixtures are rejected. | todo |
| V1-14b | **server: `FodtMapper` and the unsupported-content detector for text.** Import and export of every V1 feature, page fields, image → PNG conversion notices, and the L-10 rules | server | `backend/src/codec/{fodt-mapper,unsupported-detector}.ts` | P2 §14.5–§14.7; §0 PO-20/21/22, L-10, R-15, R-17 | V1-14a, V1-03 | The S2 corpus round-trips for the supported features. Every unsupported fixture produces the right finding. | todo |
| V1-15 | **server: Core.** Runtime, registry, factory, kind policy, `DocumentInstance`, dedupe, op history, load streamer and session record | server | `backend/src/core/**` | P2 §7–§8; §0 PO-16, R-1, R-2, R-6, R-8, R-9 | V1-02, V1-04, V1-11, V1-12, V1-13 | With a fake codec: ordering is journal → ack → broadcast → audit; ack with `committed`; dedupe on resend; fault isolation; replay for an old epoch; read-only for unsupported content. | todo |
| V1-16 | **server: `FlushScheduler` and `RecoveryManager`** | server | `backend/src/flush/**`, `backend/src/recovery/**` | P2 §12–§13; §0 L-11 | V1-11, V1-12, V1-15 | The HLD §11.3 machine with a fake clock: retries at 1/5/15 min, PENDING, CONFLICT, and restart persistence. | todo |
| V1-17 | **server: `AuditEmitter`,** delivered at least once with `replayed` | server | `backend/src/audit/**` | P2 §15; §0 PO-17, R-19 | V1-11, V1-15 | Re-emits after a simulated crash with `replayed: true`. | todo |
| V1-18 | **server: `EngineChannel` (IPC and in-process) and `Supervisor`** | server | `backend/src/channel/**`, `backend/src/supervisor/**` | P2 §5–§6 | V1-02, V1-10 | Heartbeat timeout, backoff of 1/2/4/8/16 s, FAILED after 5 restarts in 10 min (fake timers). Typed IPC messages. | todo |
| V1-19 | **server: Gateway and engine facade.** `createEngine`, `defineWorkerConfig`, upgrade with `authorize`, session table, send queue with slow-consumer close, and the admin APIs | server | `backend/src/gateway/**`, `backend/src/api/{create-engine,engine-facade}.ts`, `backend/src/index.ts` | P2 §2, §4; §0 L-3 (V1 part: `purpose: 'document'`), L-7 | V1-14b, V1-16, V1-17, V1-18 | Frames are forwarded without parsing. 401/403 handling. Close code 4001 on restart. `canSubmit` works. | todo |
| V1-20 | **server: integration suite** in main mode and worker mode, with real LibreOffice: crash and restart, storage failure through recovery, conflict, dedupe after resend, at-least-once audit | server | `backend/test/integration/**` | P2 §21; HLD §17 | V1-19 | All HLD §10 flows pass in both modes. | todo |
| V1-30 | **client: scaffold.** Options, events, labels, theme, `mount` skeleton, error policy (including L-12), href security | client | `frontend/src/{index,mount,options,events,labels,theme}.ts`, `frontend/src/errors/**`, `frontend/src/security/**`, `frontend/vite.config.ts` (completion of the V1-00 minimal config) | P3 §1–§2, §15–§16; §0 L-12, L-13, L-14, L-16 | V1-02 | `mount` and `destroy` leave no leaks (jsdom). Every error code has a policy. | todo |
| V1-31 | **client: `Connection`, backoff, close codes, `ChunkLoader`, `DocumentSession`** | client | `frontend/src/{net,load,session}/**` | P3 §3–§5; §0 R-5, R-8, R-9 | V1-30 | Reconnect with jitter; resume; resync followed by a full load; remotes buffered until `load-done`. | todo |
| V1-32 | **client: `TextSyncClient` and `collabSyncPlugin`** | client | `frontend/src/sync/{collabSyncPlugin,TextSyncClient,xform,types}.ts` | P3 §6–§7; §0 PO-16, PO-18, R-6, R-8, L-15 | V1-04, V1-31 | Against a fake server: one batch in flight; `committed` correction; `QUEUE_FULL` retry; the rescue path with its notice; no history (no undo). | todo |
| V1-33 | **client: `TextEditorView`.** Plugins, commands, toolbar commands, images (toolbar, paste, drop, resize), `AssetCache`, table column resize, undo keys disabled | client | `frontend/src/text/{TextEditorView,plugins,commands,imageUpload}.ts`, `frontend/src/text/nodeviews/**`, `frontend/src/assets/**` | P3 §9, §13; §0 PO-18, PO-24, PO-25, R-10 | V1-03, V1-30 | Each V1 feature can be edited. Image types are enforced. Blob URLs are revoked on destroy. | todo |
| V1-34 | **client: `PaginationPlugin` and `HeaderFooterRegions`,** with page fields | client | `frontend/src/text/{PaginationPlugin,HeaderFooterRegions,geometry}.ts` | P3 §10–§11; §0 PO-21, PO-23 | V1-33, V1-S3 | Matches the S3 measurements. Tall blocks overflow. Header copies are read-only. | todo |
| V1-35 | **client: React shell.** Shell, Toolbar, StatusBar, UnsupportedBanner (findings and conversions), ReadOnlyBadge, ShareButton, ErrorScreen, EditorHost, useSession, dialogs | client | `frontend/src/ui/**` (except UploadButton and AnnotationsPanel) | P3 §14; §0 PO-22, L-12 | V1-30, V1-33 | Component tests (Testing Library). "Edit anyway" calls `onEditAnyway`. | todo |
| V1-36 | **client: end-to-end `mount` wiring** of session, editor and shell | client | `frontend/src/mount.ts` (completion), `frontend/src/ui/EditorHost.tsx` | P3 §2–§3 | V1-31, V1-32, V1-34, V1-35 | It works against the real server from V1-19 in a dev harness. | todo |
| V1-40 | **End-to-end suite (Playwright)** on Chromium, Firefox and WebKit: two users converge, view-only, reconnect, slow consumer, read-only for unsupported content and "edit anyway", paste images, engine restart | e2e | `e2e/**`, `playwright.config.ts`, `.github/workflows/ci.yml` (`e2e` job) | P3 §17; HLD §17; §0 L-6 | V1-20, V1-36 | Green on all three engines in CI. | todo |
| V1-41 | **Benchmark (S4)** of connections per Core, op latency p50/p99, IPC fan-out and export time, followed by a **proposal** for new default limits | perf | `bench/**`, `docs/benchmarks/V1.md` | HLD §16; PO-4 | V1-20 | Numbers are reported. Any change to the defaults goes to the project owner as an HLD/LLD change. | todo |
| V1-42 | **Adopter documentation:** README per package (install, LibreOffice requirement, configuration, `authorize`, worker config module, security notes, error-code table) | docs | `shared/README.md`, `backend/README.md`, `frontend/README.md` | HLD §12, §14, §18 | V1-20, V1-36 | Each example in the docs runs. | todo |
| V1-43 | **V1 release gate.** `ship` skill checklist, CHANGELOG, versions, `npm publish --dry-run`. The real publish happens only on the project owner's go (they own the `@open-docex` npm org). | release | `CHANGELOG.md`, `*/package.json` (version), `.github/workflows/release.yml` | AGENTS.md §5–§6 | V1-40, V1-41, V1-42 | The project owner approves. | todo |

---

## V2 — Collaborative spreadsheets

| ID | Task | Track | Files | LLD | Deps | Acceptance | Status |
|---|---|---|---|---|---|---|---|
| V2-S1 | **Spike S1: Univer** (pinned version). Local vs `fromCollab` mutations, applying remote mutations with the selection kept, display of cached values with formula execution off (PO-19), the mutation list for V2 content, blocking unsupported features (L-17) | spike | `spikes/S1/**`, `docs/spikes/S1.md` | HLD §20 S1; P3 §12 | V1-00 (may run during V1) | The report confirms or corrects every "VERIFY IN SPIKE S1" mark in P3 §12. Any correction is an LLD change. | todo |
| V2-01 | **shared: sheet model and OT.** Ops, the transform table, the per-field same-cell rule, formula shifting including sheet rename/remove, unshiftable detection, row chunking | shared | `shared/src/sheet/**` | P1 §9; §0 PO-28, PO-29, L-4, R-18 | V1-04 | The transform table is tested for every op pair. Formula fixtures pass, including `#REF!`. | todo |
| V2-02 | **server: `FodsMapper` and `odf-formula`** (ODF ↔ A1), with sheet unsupported detection | server | `backend/src/codec/{fods-mapper,odf-formula}.ts`, `backend/src/codec/unsupported-detector.ts` (sheet rules), `backend/test/fixtures/sheet/**` | P2 §14 (V2 parts); §0 PO-28 | V2-01, V1-14b | The .xlsx/.ods corpus round-trips V2 content. Advanced features are flagged. | todo |
| V2-03 | **server: wiring the sheet kind.** Kind policy, factory, and audit `superseded` values | server | `backend/src/core/{kind-policy,instance-factory}.ts`, `backend/src/audit/audit-emitter.ts` | P2 §8, §15 | V2-01, V1-20 | Sheet integration tests run in both modes. | todo |
| V2-04 | **client: `SheetSyncClient`** | client | `frontend/src/sync/SheetSyncClient.ts` | P3 §8; §0 R-7 | V2-01, V1-31 | Against a fake server: convergence and the same-cell rule. | todo |
| V2-05 | **client: `SheetEditorView` and `UniverBridge`.** Setup with formula execution off, mapping, selection mapping, blocked features, formula text display, undo disabled, `sheet.css` | client | `frontend/src/sheet/**` | P3 §12; §0 PO-18, PO-19, PO-30, L-17, L-18 | V2-S1, V2-04 | Each V2 feature can be edited. Unsupported Univer actions are blocked. | todo |
| V2-06 | **End-to-end tests and the V2 release gate** | e2e/release | `e2e/sheet/**`, `CHANGELOG.md`, versions | P3 §17 | V2-02, V2-03, V2-05 | The project owner approves the release. | todo |

## V3 — External queues

| ID | Task | Track | Files | LLD | Deps | Acceptance | Status |
|---|---|---|---|---|---|---|---|
| V3-01 | **`RedisStreamsQueue`** (node-redis; tested on Redis and Valkey) | server | `backend/src/queue/redis-streams-queue.ts` | P2 §9.4 | V1-20 | Bounds; FIFO across a restart; redelivery is deduplicated. | todo |
| V3-02 | **`KafkaQueue`** (`@confluentinc/kafka-javascript`), plus the S6 install test | server | `backend/src/queue/kafka-queue.ts`, `.github/workflows/ci.yml` (`queues` job) | P2 §9.5; HLD §20 S6 | V1-20 | Per-document order; commit low-watermark; crash replay. | todo |
| V3-03 | **Epoch lineage acceptance, integration tests and the V3 release gate** | server/release | `backend/src/core/document-instance.ts` (lineage), `backend/test/integration/queues/**` | P2 §8.6 | V3-01, V3-02 | The project owner approves the release. | todo |

## V4 — End-user upload

| ID | Task | Track | Files | LLD | Deps | Acceptance | Status |
|---|---|---|---|---|---|---|---|
| V4-01 | **server: `UploadService`,** `?upload=1` on the Gateway, `AuthorizeContext.purpose`, and the `onUploaded` hook | server | `backend/src/upload/**`, `backend/src/gateway/upgrade.ts` | P2 §16; §0 L-3 | V1-20 | Size and zip validation; the unsupported check; the file is created in storage. | todo |
| V4-02 | **client: `UploadButton` and the upload flow** | client | `frontend/src/ui/UploadButton.tsx`, `frontend/src/net/upload.ts` | P3 §14 | V1-36, V4-01 | Progress display; errors. | todo |
| V4-03 | **End-to-end tests and the V4 release gate** | e2e/release | `e2e/upload/**` | — | V4-02 | The project owner approves the release. | todo |

## V5 — Bookmarks and side notes/reviews (text documents only, PO-27)

| ID | Task | Track | Files | LLD | Deps | Acceptance | Status |
|---|---|---|---|---|---|---|---|
| V5-01 | **shared:** the `bookmark` node, the `annotation` mark and annotation messages | shared | `shared/src/text/annotations.ts`, `shared/src/protocol/annotations.ts` | P1 §5, §8 (V5) | V1-04 | Schema and contract tests. | todo |
| V5-02 | **server:** `AnnotationService` and the `AnnotationStore` port; view-only sessions read only | server | `backend/src/annotation/**` | P2 §17; §0 PO-31 | V5-01, V1-20 | A conformance kit for the store. | todo |
| V5-03 | **client:** `AnnotationsPanel` and the anchor UI | client | `frontend/src/ui/AnnotationsPanel.tsx`, `frontend/src/text/annotations/**` | P3 §14 | V5-01, V1-36 | Component tests. | todo |
| V5-04 | **End-to-end tests and the V5 release gate.** The main (own-OT) BRD scope is complete. | e2e/release | `e2e/annotations/**` | — | V5-02, V5-03 | The project owner approves the release. | todo |

## V6 — Section B features (separate version, on the own-OT engine)

| ID | Task | Deps | Status |
|---|---|---|---|
| V6-00 | **Design update.** HLD/LLD sections for B1–B6 and B8–B10, notably B2 undo with collaboration and B3 formula authority. Needs the project owner's approval. | V5-04 | todo |
| V6-01…V6-n | One task per B item, created by V6-00 | V6-00 | todo |

## V7 — ShareDB-based version (separate version)

| ID | Task | Deps | Status |
|---|---|---|---|
| V7-00 | **Design update.** LLD for the ShareDB core:<br>• the database adapter on Persistence and storage<br>• the queue feeding submit<br>• the pub/sub adapters, including a custom Kafka one<br>• registration of the shared OT types<br>• an own chunked load path (ShareDB 8.0.0 sends the whole snapshot, verified 2026-11-18)<br>Needs the project owner's approval. | V5-04 | todo |
| V7-01…V7-n | Tasks created by V7-00, plus a V1–V5 parity suite | V7-00 | todo |

---

## Open questions

The orchestrator records questions here and asks the project owner. None are open right now.

**Resolved 2026-11-22 (project owner):**
- V1-00 scope extended with root `tsconfig.json`, `eslint.config.js`, root `vitest.config.ts`, `package-lock.json` and `shared/src/env.d.ts`, which its acceptance needs (P1 §1.1–§1.4).
- V1-00 creates a minimal `frontend/vite.config.ts` (P1 §1.5 lib mode) so the root `build` works. V1-30 completes it.
- V1-00's `ci.yml` has the `static`, `test` and `test-windows` jobs. V1-40 adds `e2e`, V3-02 adds `queues`, and V1-43 adds `release.yml`.
- After V1-00 is merged, the orchestrator may push `main` to origin once, to verify the CI acceptance.

**Resolved 2026-11-22 after V1-00 (project owner):**
- ESLint type-aware linting uses each package's `tsconfig.test.json`, so test files are linted (LLD P1 §1.6 updated).
- `@types/ws`, `@types/yauzl`, `@types/react` and `@types/react-dom` were added as devDependencies (LLD P1 §1.3 updated).
- LLD P1 §1.7 (`*.lo.test.ts` use `describe.skipIf`) and §1.9 (packages flagged dev, including peers of dev tools, are report-only per L-1) were updated to match the implementation.

**Resolved 2026-11-22 during V1-01 (project owner):**
- Catalogue entries for the three `CLIENT_*` codes and a new `ErrorCategory` value, `'client'` (LLD P1 §4; the catalogue now has 30 codes).
- The five codes marked "never sent" get the client message "The editing service hit a server problem." (LLD P1 §4).
- shared's root index re-exports every public module. The server re-exports `OpenDocexError` from `@open-docex/shared/errors` (LLD P1 §2, P2 §2.1).
- `env.d.ts` also declares `crypto.subtle.digest`. ids depends on errors. P3 §13 AssetCache uses the `CLIENT_*` codes (LLD P1 §1.4, §2; P3 §13).

**Notes for later tasks (from the V1-00 review):**
- V1-30: `frontend/package.json` has `"sideEffects": false`. Because `./style.css` is exported, V1-30 must check that bundlers keep the CSS import, and raise it if not.
- V1-43: `dist/tsconfig.tsbuildinfo` is included in the npm tarballs. Decide whether to exclude it.

## Change log

| Date | Change |
|---|---|
| 2026-11-19 | Plan created from the HLD and LLD. |
| 2026-11-22 | V1-00/V1-30/V1-40/V1-43/V3-02 file scopes adjusted per the resolved questions above. V1-00 started. |
| 2026-11-22 | V1-00 done (CI run 45012148604 green). Post-review fixes to lint, @types and LLD §1.3/§1.6/§1.7/§1.9 approved and applied. |
