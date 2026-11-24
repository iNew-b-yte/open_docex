# open_docex — Low-Level Design (LLD)

| | |
|---|---|
| **Status** | Master document. Source of truth for implementation, together with `HLD.md`. |
| **Inputs** | BRD (scope), `HLD.md` (architecture and contracts), and the project-owner decisions of 2026-11-18 and 2026-11-19 |
| **Structure** | §0: integration, decisions and reconciliation. **§0 wins over Parts 1–3 wherever they differ.** Then Part 1 (tooling and `@open-docex/shared`), Part 2 (`@open-docex/server`) and Part 3 (`@open-docex/client`). |
| **Authors** | Claude (orchestrator) with three parallel writer agents, 2026-11-18/19 |
| **Change rule** | As in `HLD.md` and `AGENTS.md` §7: changes need project-owner approval, and the HLD and LLD are updated in the same commit. |

---

## 0. Integration

### 0.1 Project-owner decisions (2026-11-19)

These resolve the open questions raised in Parts 1–3. Each is also recorded in HLD §3.3.

| ID | Decision | Resolves |
|---|---|---|
| PO-16 | **Unconfirmed changes after a reload with a new epoch:** `rev` persists across loads. For an old-epoch `resume`, the server replays the retained journal entries after the client's `rev`: an `ack` for each of the client's own entries and a `remote` for each other client's, in rev order. Only if those entries have already been trimmed does the client drop its unconfirmed changes and show "some changes could not be restored". | P1 Q2; P3 OQ-6 |
| PO-17 | **Audit is delivered at least once.** After a crash, the Core re-emits journal entries it had not yet emitted, with `AuditEvent.replayed = true`. Adopters deduplicate by `(documentId, rev)`. | P2 Q7 |
| PO-18 | **No undo or redo in V1–V5,** in either editor. This includes Univer's built-in undo, and the Ctrl+Z and Ctrl+Y keys are disabled. | P3 OQ-7 |
| PO-19 | **HLD CL-16 revised:** Univer's formula engine plugin is registered with `notExecuteFormula: true`, and the sheets-formula plugins are not registered. There is still no recalculation before V6. | P3 OQ-8 |
| PO-20 | **Paragraph formatting is supported:** spacing before and after, line height, and left, right and first-line indent on `paragraph` and `heading`. Paragraph borders and shading are unsupported. | P2 Q4a |
| PO-21 | **Page number and page count fields** in the header and footer are supported. All other fields are unsupported. | P2 Q4c |
| PO-22 | **EMF, WMF, TIFF and SVG images** are converted to PNG on import, through LibreOffice. The document opens editable with a notice that lists the converted images, which will be saved as PNG. | P2 Q6 |
| PO-23 | **A block taller than one page** (a table or image) overflows its page frame on screen. Export pagination is LibreOffice's job. | P3 OQ-2 |
| PO-24 | **Images:** PNG, JPEG and GIF, with SVG excluded. Users can insert by toolbar, paste or drag-and-drop, and can resize with handles (width and height are saved). | P1 Q4; P3 OQ-4 |
| PO-25 | **Table column resizing** in V1. Column widths are saved. | P3 OQ-3 |
| PO-26 | **Blank documents default to A4 portrait with 2.54 cm margins.** The adopter can override this through `WorkerConfig.blankDocument.page`. | P1 Q11 |
| PO-27 | **Annotations (V5) are for text documents only.** | P1 Q12; P3 OQ-11 |
| PO-28 | **Formulas the shifter can't adjust** (3-D references, structured table references, external references) count as unsupported content, so the file opens read-only. | P1 Q7 |
| PO-29 | **Renaming a sheet rewrites the formulas that refer to it. Removing a sheet turns those references into `#REF!`.** | P1 Q8 |
| PO-30 | **A formula typed before V6 shows its formula text,** styled as "not calculated". | P3 OQ-9 |
| PO-31 | **View-only sessions can read annotations in V5 but not add or change them.** | P2 Q9 |

### 0.2 LLD choices (Claude, open to the project owner's review)

These are technical choices that resolve the remaining part questions. None of them changes BRD scope.

| ID | Choice | Resolves |
|---|---|---|
| L-1 | **Licences.** ISC is allowed, as it is equivalent to MIT. Violations in the production and peer dependency trees fail CI; violations in dev-only dependencies are reported. | P1 Q1 |
| L-2 | `heading` has an `align` attribute. PO-14's "core text" includes alignment. | P1 Q3 |
| L-3 | **Upload (V4).** A separate WebSocket on the same path with `?upload=1`. `AuthorizeContext.purpose` is `'document'` or `'upload'`, and an upload has no `documentId`. | P1 Q5; P2 Q8 |
| L-4 | **The same-cell rule works per field.** Value and formula form one field and style the other. BRD §6 speaks of the "visible cell value", so a concurrent style change survives. | P1 Q6 |
| L-5 | **Adopter document IDs** are 1–1,024 characters with no control characters. | P1 Q9 |
| L-6 | **The E2E browser matrix** is the latest Chromium, Firefox and WebKit, through Playwright. The draft calls for the UI to be platform-agnostic. | P1 Q10 |
| L-7 | **`authorize`** returns `null` for 403, and may return `{ deny: 401 \| 403 }`. Browsers see close code 1006 either way. | P2 Q1 |
| L-8 | **`recovery.resolve(documentId, choice)`** takes `'overwrite-storage'`, `'discard-local'` or `'mark-resolved'`. The last is for when the adopter has already handled the copy. | P2 Q2 |
| L-9 | **`shareInfo` returns `{ documentId, loaded, kind?, sessions: { edit, view } }`** (Part 2 §2). | P2 Q3 |
| L-10 | **Import fidelity.** LibreOffice artefacts are dropped silently: hidden `_…` bookmarks, soft page breaks and empty declarations. Headings map to Heading 1–6. **Other named paragraph styles are flattened to direct formatting on import, so their style names are not kept on save. Flagged for the project owner's review.** | P2 Q4b |
| L-11 | **Recovery edge cases.** A normal flush that finds the storage file changed goes to CONFLICT. A failed write-back during CHECK counts as a failed retry. | P2 Q5 |
| L-12 | **Connection failure.** After 5 failed attempts in a row with no successful open, the client stops retrying on its own. It shows "Can't connect" with a Retry button and calls `onError` with `CLIENT_CONNECT_FAILED`. | P3 OQ-1 |
| L-13 | **Toolbar defaults,** all adopter-configurable: fonts Arial, Times New Roman, Courier New, Georgia, Verdana; sizes 8–72 pt; page presets A4, Letter, Legal, A3, A5. | P3 OQ-5 |
| L-14 | **`ui.confirmUnload`** defaults to `true`, so the browser warns before leaving a page that has unconfirmed changes. | P3 OQ-12 |
| L-15 | **A document that becomes read-only mid-session** (for example, after access is re-checked) discards unconfirmed changes and shows a notice. | P3 OQ-13 |
| L-16 | **A client-only error family, `CLIENT_*`,** is added to the catalogue: `CLIENT_CONNECT_FAILED`, `CLIENT_ASSET_TOO_LARGE`, `CLIENT_IMAGE_TYPE_UNSUPPORTED`. It is recorded in HLD §11.2. | P3 OQ-14 |
| L-17 | **Univer features the V2 model can't represent are hidden or blocked:** row and column styles, hiding or moving rows and columns, tab colour, the gridline toggle and rich text inside a cell. Number formats are part of cell formatting, per PO-15. | P3 OQ-10 |
| L-18 | **`ui.theme` and `ui.labels` reach Univer** only as far as its public locale and theme APIs allow. | P3 OQ-15 |

### 0.3 Contract reconciliation

Part 1 owns the shared contracts. Where Parts 2 and 3 assumed something different, the rows below are the canonical answer. Mechanical renames have already been applied in the part texts.

| ID | Canonical contract | Changed in |
|---|---|---|
| R-1 | `FileFormat` and `DocKind` (Part 1) replace Part 2's `DocumentFormat` and `DocumentKind`. | P2 (renamed) |
| R-2 | `LoadStartMsg.ackedClientSeq` (Part 1) replaces Part 2's `committedClientSeq`. | P2 (renamed) |
| R-3 | `LoadStartMsg` gains `readOnly: boolean` (P2 N1), `totalChunks?: number` and `limits?: { maxAssetBytes?: number }` (Part 3), and `conversions?: ConversionNotice[]` (PO-22), where `ConversionNotice = { feature: 'image-to-png'; count: number; where?: string[] }`. | P1 §5 |
| R-4 | `NoticeMsg` uses `notice` as its discriminating field (Part 1), not `kind`. | P2 (renamed) |
| R-5 | `PingMsg` and `PongMsg` carry `n: number` (Part 1). Part 3's `id` is superseded. | P3 |
| R-6 | `rebaseStepsOnDoc(steps, over, doc) → { steps, kept, doc }` is added to shared text (Part 1 §8.3). The client `TextSyncClient` and the server `DocumentInstance` both use it. `rebaseSteps` stays the pure mapping-only form behind `OtType.rebase`. | P1, P3 |
| R-7 | `transformSheetOp(a, b, side: Side)` (Part 1) replaces Part 3's `opIsLater`. | P3 |
| R-8 | **Resume.** For a same-epoch resume (Part 2 N4) and an old-epoch resume (PO-16), the server sends an `ack` for each of the client's own missed entries (with `committed` when it was transformed) and a `remote` for each other client's. Part 3's "own `clientId` in a remote" branch is only defensive. | P3 |
| R-9 | `resync` is followed at once by a full load on the same socket, and the client sends no new `hello` (P2 N3). | — |
| R-10 | **Assets are correlated by `reqId`** (Part 1). A successful `asset-put` is confirmed by an `AssetMsg` without `bytes`. Asset errors carry `reqId`, not `assetId`. | P3 |
| R-11 | `isAllowedHref` (Part 1) replaces Part 3's `isAllowedLinkHref`. | P3 (renamed) |
| R-12 | Shared additions: `computeAssetId(bytes): Promise<string>` in ids (lowercase hex SHA-256 via WebCrypto); `WS_SUBPROTOCOL = 'open-docex.v1'` and `DOC_QUERY_PARAM = 'doc'` in protocol. | P1 |
| R-13 | The upload and annotation message names come from Part 1 §5. Part 3's proposals are superseded. | P3 |
| R-14 | **The `doc` gains `textDefaults: { fontFamily, fontSize, color }`** (P2 N6), so that export keeps the document's default font. | P1 §8 |
| R-15 | `UnsupportedFinding = { feature, count, where?, detail? }` (Part 1). Part 2's `sample` becomes `detail`. | P2 |
| R-16 | `CloseCode` names and values come from Part 1 §5.5. The server maps error codes to close codes with `closeCodeFor(ErrorCode)`. | P2 |
| R-17 | **Schema additions from PO decisions,** with units as in Part 1's page settings:<br>• `paragraph` and `heading` get `spacingBefore`, `spacingAfter`, `lineHeight`, `indentLeft`, `indentRight` and `indentFirstLine` (PO-20), and `heading.align` (L-2).<br>• A new inline atom, `page_field { kind: 'number' \| 'count' }`, is allowed only inside `header` and `footer` (PO-21).<br>• `image` gets editable `width` and `height` (PO-24).<br>• Table cells get prosemirror-tables' `colwidth` (PO-25). | P1 §8; P2 §14 mappers; P3 §9–§11 |
| R-18 | **Sheet formula rewriting** also covers sheet rename and remove (PO-29). Unshiftable references produce the `UnsupportedFinding` feature `'formula-reference'` (PO-28). | P1 §9; P2 §14 |
| R-19 | `AuditEvent.replayed: boolean` (PO-17). `MetaStore` records `auditEmittedRev` per document. On boot, the Core re-emits journal entries with `rev > auditEmittedRev`. | P2 §10, §15 |
| R-20 | `WorkerConfig.blankDocument.page` defaults to A4 portrait with 2.54 cm margins (PO-26). | P2 §2 |

### 0.5 Spike outcomes (approved by the project owner, 2026-11-22)

These come from `docs/spikes/S2.md`, `docs/spikes/S3.md` and the V1-01 review. Like all of §0, they win over Parts 1–3.

| ID | Decision | Affects |
|---|---|---|
| S-1 | **Height reads (S3 C1).** Block heights are `Math.round(parseFloat(getComputedStyle(el).height) * 64) / 64` on `box-sizing: border-box` blocks, including in `measuredHeight()`. Never `offsetHeight` or `getBoundingClientRect()`. The jsdom unit tests stub this read. | P3 §10–§11; V1-34 |
| S-2 | **Geometry snapping (S3 C2).** All `pageGeometry` values are snapped to 1/64 px. | P3 §10; V1-34 |
| S-3 | **A block taller than a page (S3 C3, PO-23).** Frames stay page-sized, and the block runs past its frame. Each page records `overflow = max(0, y − cap)`, which is added to the spacer. Frames are positioned cumulatively (`pageExtra` in `PaginationState`), so later frames move down by the overflow. The frame is never stretched. | P3 §10; V1-34 |
| S-4 | **Resume state (S3 C4).** The pass stores the state before each block's break decision (`yPre[i]`, `pagePre[i]`, `posOf[i]`), and on resume keeps only breaks with `index < s`. Breaks carry an `index`. | P3 §10; V1-34 |
| S-5 | **Spacer key and copies (S3 C5).** The spacer key includes `bodyTop` and `footBox`. A copy generation (header node id, footer node id, `pageCount`) re-fills visible header/footer copies and clears hidden ones when it changes. The real header's and footer's page fields are updated in place. | P3 §10–§11; V1-34 |
| S-6 | **Budget.** At 300 pages, typing work (transaction, pagination pass and layout) has p95 ≤ 8 ms in Chromium. | P3 §10 tests; V1-34, V1-41 |
| S-7 | **Late-loading images.** Image node views observe their own size with `ResizeObserver` and invalidate that block's cached height. | P3 §9–§10; V1-33, V1-34 |
| S-8 | **Coverage S3 did not measure.** V1-34's tests cover tables and lists. V1-40 covers Firefox and WebKit. | V1-34, V1-40 |
| S-9 | **Page margins (S2 Q1, CL-9).** A margin in our model is the distance from the page edge to the body text, as Word shows it. The FodtMapper converts to and from ODF's page margin plus header/footer height and spacing, in both directions. | P2 §14.5; V1-14b |
| S-10 | **Image alt text (S2 Q2).** Alt text is `svg:desc`. `svg:title` is ignored on import and not written on export. | P2 §14.5; V1-14b |
| S-11 | **EMF/WMF/TIFF → PNG (S2 Q3, PO-22).** Wrap the image in a generated SVG, then export with LibreOffice's `draw_png_Export` filter, with `PixelWidth`/`PixelHeight` set to twice the displayed size in px. One LibreOffice call per image, run through the codec pool and its concurrency cap. SVG uses plain `--convert-to png`. | P2 §14.2, §14.5; V1-14a, V1-14b |
| S-12 | **Linked external images (S2 Q4).** An image that is a link without embedded data is unsupported content (an `UnsupportedFinding`, so the file opens read-only). It is never fetched. | P2 §14.7; V1-14b |
| S-13 | **Profile settings (S2 Q5).** `BlockUntrustedRefererLinks` stays set, even though S2 saw no effect. | P2 §14.3; V1-14a |
| S-14 | **Sheet recalculation (S2 Q6).** S2 saw a stale cached value recalculated on ODF → xlsx export, even with `ODFRecalcMode=1`. Handling is deferred to V2-S1 and V2-02. | V2-S1, V2-02 |
| S-15 | **Flat XML cap (S2 Q7).** `maxFlatXmlBytes` defaults to 64 × `maxFileBytes`, not 4 ×. Recheck in the V1-41 benchmark. | P2 §14; V1-14a, V1-41 |
| S-16 | **Linux S2 run (S2 Q8).** A temporary manual CI workflow, `.github/workflows/spike-s2-linux.yml`, runs the S2 scripts on ubuntu-24.04. Its results go into `docs/spikes/S2.md`. | V1-S2 |
| S-17 | **`OpenDocexError.is` (V1-01).** `is(x)` returns true for an `OpenDocexError` instance, and also for a plain object with a known catalogue `code` and the `OpenDocexErrorShape` field types, such as the output of `toShape()` after IPC or a structured clone. A value accepted this way may be a plain shape with no methods. Call `fromShape` before using methods. | P1 §4 |
| S-18 | **`textDefaults` (R-14, V1-03).** The `doc` attribute `textDefaults: { fontFamily, fontSize, color }` defaults to all-null and uses the same validators as the `text_style` mark. Import sets it. Steps can't change it in V1, so it is not in the `docAttr` allowlist (§8.2). The `'doc'` chunk (§8.7) gains `textDefaults`, so `assemble(chunk(doc))` keeps it. | P1 §8.1, §8.2, §8.7 |
| S-19 | **Paragraph formatting (PO-20, V1-03).** `paragraph` and `heading` get these attributes, all defaulting to null (no override):<br>• `spacingBefore`, `spacingAfter`, `indentLeft` and `indentRight`: finite pt in [0, 1584]<br>• `indentFirstLine`: finite pt in [−1584, 1584]; negative means a hanging indent<br>• `lineHeight`: `{ kind: 'multiple'; value: 0.5–10 } \| { kind: 'exact'; pt: 1–1584 } \| { kind: 'atLeast'; pt: 1–1584 }`<br>`toDOM` writes non-null values as CSS: `margin-top`, `margin-bottom`, `margin-left`, `margin-right` and `text-indent` in pt, and `line-height` as a number for multiple, or in pt for exact and atLeast (CSS has no at-least, so it shows like exact). `parseDOM` reads the same properties (px→pt ×0.75) and skips invalid values. | P1 §8.1 |
| S-20 | **`page_field` (PO-21, V1-03/V1-04).**<br>• An inline atom in the `inline` group, with `kind` required, `'number' \| 'count'`.<br>• `toDOM`: `['span', {class:'odx-page-field','data-page-field': kind}]`. It has no `parseDOM`, so pasting can't create one.<br>• The schema allows it anywhere inline. V1-04's `apply` rejects a step that leaves a `page_field` outside `header`/`footer` (touched-range check). | P1 §8.1, §8.4 |
| S-21 | **Generic chunk type and scope split (V1-03/V1-04).** `ot` declares `Chunk<D = unknown> { seq; data: D }` and `OtType<S, O, D>`, where `chunk` returns `Chunk<D>[]`. `TextChunkData` stays in `text`, and `SheetChunkData` comes in V2. V1-03 writes `text/steps.ts` (`TextStepType`, `TextOp`, `parseTextOps`). V1-04 writes `textOpsEqual` (in `text/equal.ts`) and `test/ot/laws.ts`. | P1 §7, §8.2 |
| S-22 | **V1-10 ordering and type ownership.**<br>• The rest of V1-10 (`options.ts`, `validate-options.ts`, `events.ts`) depends on V1-02, V1-12 and V1-13, and imports the protocol, storage-port and queue-config types from them.<br>• The `AuditEvent` type is defined in V1-10's `api/events.ts`. V1-17 implements the emitter against it.<br>• `toWire` (§19.1) belongs to V1-18, which owns `WireError` in `channel/messages.ts`.<br>• `RecoveryResolution` and `ShareInfo` belong to V1-19 (`engine-facade.ts`).<br>• `maxFlatXmlBytes` is not a config field. The codec derives it as 64 × `limits.maxFileBytes` (S-15).<br>• `UploadedContext` and `AnnotationStore` are left out until V4/V5. | P2 §2, §15, §19; plan |
| S-23 | **Type-only imports in the main process.** The main-process lint rule (P1 §1.6) uses `@typescript-eslint/no-restricted-imports` with `allowTypeImports: true`, so `import type` from any shared subpath is allowed there. Value imports stay limited to `/protocol`, `/errors` and `/ids`. `WorkerConfig.blankDocument.page` uses `import type { PageSettings } from '@open-docex/shared/text'`. | P1 §1.6; P2 §2.3 |
| S-24 | **`AuthorizeDenial` (L-7).** `authorize` returns `AuthorizeResult \| AuthorizeDenial \| null`, where `AuthorizeDenial = { deny: 401 \| 403 }`. `null` means 403. A `deny` value other than 401 or 403 is a malformed result: HTTP 500 and a `CONFIG_INVALID` error event. | P2 §2.2, §4.2 |
| S-25 | **`purpose` and log strictness.**<br>• In V1, `AuthorizeContext.purpose` is `'document'` (L-3), and V4 widens it to `'upload'`.<br>• An unknown log field (P2 §3) throws when `process.env.NODE_ENV === 'test'`, which Vitest sets. Otherwise it is dropped. Callers may pass `strict` explicitly. | P2 §2.2, §3 |
| S-26 | **Protocol gap-fills (V1-02).**<br>• **(a)** `LoadChunkMsg` is `{ type: 'load-chunk'; seq; data: unknown }`. protocol does not depend on ot, and `OtType.assemble` does the deep check. `data` must be a plain object.<br>• **(b)** `asset` is valid as a text frame without bytes and as a binary frame with bytes (§5.1, §5.2 and R-10 win over the §5.4 pseudocode). `isBinaryType` is true only for `asset-put` and `upload-chunk`.<br>• **(c)** The keys `__proto__`, `constructor` and `prototype` are stripped, never read or copied.<br>• **(d)** Bounds:<br>&nbsp;&nbsp;– counts and sizes are ≥ 0, and `ackedClientSeq` is ≥ 1<br>&nbsp;&nbsp;– `ack.committed` may be empty, and `remote.ops` has ≥ 1 item<br>&nbsp;&nbsp;– `upload-chunk` bytes are ≤ 256 KiB<br>&nbsp;&nbsp;– annotation `id`, `replyTo` and `deletedId` use the `newRandomId` format<br>&nbsp;&nbsp;– `name` is ≤ 255 characters<br>&nbsp;&nbsp;– `annotation-changed` carries exactly one of `annotation` or `deletedId`<br>• **(e)** `codec.ts` may import the internal `isErrorCode` from `errors/catalogue`. | P1 §5 |
| S-27 | **Text schema gap-fills (V1-03).**<br>• **(1)** Each `colwidth` length must equal its `colspan`.<br>• **(2)** Margins must fit the page: left + right ≤ width − 36, and top + bottom ≤ height − 36.<br>&nbsp;&nbsp;Per-attribute validators can't check rules (1) and (2), so V1-04 enforces both: in `apply` (the touched-range check, plus `pageSettingsFit` after a `docAttr` step) with `PROTOCOL_OP_REJECTED`, and in `deserializeSnapshot` with `DOCUMENT_FAULTED` (corrected 2026-11-22, S-30). `assembleText` checks both rules.<br>• **(3)** A chunk's byte count includes its wrapper JSON, so L6 holds for the whole `data`.<br>• **(4)** Names: `chunkText`, `assembleText`, `TextAlign`, `LineHeight`, `TextDefaults`, `TextRegion`.<br>• **(5)** Paste: the `text-decoration` rules don't consume, so `underline line-through` gives both marks. `text_style` colour accepts `#rrggbb` and `rgb()`. An `alt` over 1000 characters becomes `''`, and an invalid `ol start` becomes 1.<br>• **(6)** jsdom tests type their DOM globals locally. | P1 §8.1, §8.4, §8.7; V1-04 |
| S-28 | **Storage gap-fills (V1-12).**<br>• **Versions on Windows:** when the file clock hasn't moved, `write` sets the new file's mtime 1 ms past the old one, so `${mtimeNs}:${size}` never repeats. An outside same-size edit within one clock tick can still go unnoticed (documented).<br>• **Refs:** all control characters, any `:` and Windows reserved names are rejected. Only a leading `..` segment counts as traversal, so `..x` is allowed. `create` checks the format.<br>• **Files:** missing parent folders are not created (→ `STORAGE_WRITE_FAILED`). A folder path reads as not found. A read over `maxBytes` → `DOCUMENT_TOO_LARGE`. Other failures are wrapped with `cause`. Files are written as 0600. `create` retries name clashes up to 3 times.<br>• **Logging:** rejection reasons are logged without the ref.<br>• **Router:** `route(ref)` returns an adapter. `forCreate('storage' \| 'local')`, `hasAdopterStorage` and `local` are added.<br>• **Test kit:** it lives at `backend/test-kit/storage/` and includes `FakeStorage`. `STORAGE_CALL_TIMEOUT_MS` is exported, and callers enforce it.<br>• **Public export:** `LocalFsStorage` is exported from `backend/src/index.ts` by V1-19. | P2 §11, §21 |
| S-29 | **Memory queue gap-fills (V1-13).**<br>• A second `consume` on a document, or `consume` after `close()`, throws `QUEUE_UNAVAILABLE`. `enqueue` after close returns `{ ok: false, code: 'QUEUE_UNAVAILABLE' }`.<br>• A consumer's `stop()` drops that document's queued items (including an unacked one), frees their capacity, waits for an in-flight delivery and ignores late acks. Senders learn of the fault through `DOCUMENT_FAULTED` (§8.4).<br>• A delivery that returns without acking pauses the document until acked. A delivery that throws counts as unacked.<br>• Deliveries run on a microtask, never inside `enqueue`, and never overlap for one document.<br>• Bounds are validated by V1-10. | P2 §9.1–§9.2 |
| S-30 | **Text OT gap-fills (V1-04).**<br>• The TextOtType file is `text/ot.ts`. `rebaseOverMaps` is internal.<br>• `addMark`/`removeMark` steps are checked against their own range.<br>• An op that won't parse is dropped, not thrown, so apply never throws (§8.8).<br>• `deserializeSnapshot` throws `DOCUMENT_FAULTED` for every failure, and `PROTOCOL_OP_REJECTED` is only for client ops.<br>• `assembleText` also checks colwidth = colspan. | P1 §8.3–§8.5, §8.7 |
| S-31 | **Server options gap-fills (V1-10).**<br>• `CONFIG_INVALID` names the failing field in `message`, as `<field path>: <rule>`.<br>• `EngineEventMap` is a type alias.<br>• V3, V4 and V5 options are left out. A queue `type` of `'redis'` or `'kafka'` fails with "not available in this version".<br>• Extra rules: numbers must be safe integers; timeouts and `maxFileBytes` must be ≥ 1; enum values are checked; paths must be non-empty; a custom logger must have all four methods; unknown keys are ignored.<br>• The blank-page bounds are copied in `validate-options.ts`, and a parity test against shared's validators keeps the copy from drifting.<br>• `defineWorkerConfig` is a plain identity function. | P2 §2.2–§2.4, §2.7 |
| S-32 | **Persistence gap-fills (V1-11).**<br>• WebP is not an asset type (PO-24; §10.5 fixed).<br>• `auditEmittedRev` is required in `meta.json`. A meta file without it is skipped at boot.<br>• `TimerClock` and `JournalSyncTimer` live in `journal.ts` until a shared Clock exists.<br>• Journal: the torn-tail repair runs only on the last segment, at open. `rotate` syncs first. Trim keeps the current segment. Write failures throw `DOCUMENT_FAULTED`.<br>• Lock: an unreadable LOCK file is refused and must be removed by hand. A narrow race when two engines take over the same stale lock is documented.<br>• An unreadable snapshot throws `DOCUMENT_FAULTED`, and the file is kept.<br>• An invalid or unknown asset ID returns null, which becomes `DOCUMENT_NOT_FOUND`.<br>• `ensureLayout` and `emptyTmp` are included. The LAYOUT version is `1`. | P2 §10 |
| S-33 | **Client scaffold gap-fills (V1-30).**<br>• `frontend/package.json` sets `"sideEffects": ["**/*.css"]`. The §15 lint rule bans `innerHTML`, `outerHTML`, `insertAdjacentHTML` and `dangerouslySetInnerHTML` in `frontend/src`.<br>• `CLIENT_*` policies: the two asset codes fail the asset. `CLIENT_CONNECT_FAILED` is terminal, showing "Can't connect" with a Retry button.<br>• Default font sizes: 8–28, 36, 48 and 72 pt.<br>• Page presets are exported as `DEFAULT_PAGE_PRESETS`.<br>• An unknown error code is shown as `PROTOCOL_INVALID_MESSAGE`.<br>• All UI strings live in `labels.ts`. V1-35 may extend it. | P3 §1, §2, §15, §16 |
| S-34 | **Channel and Supervisor gap-fills (V1-18).**<br>• `toWire(e, ctx: WireContext)` lives in `channel/wire-error.ts`. The `instance` and `document` contexts give `DOCUMENT_FAULTED`, and `boot` gives `CONFIG_INVALID`. An error with no document is only logged and never wired. Known codes are kept.<br>• A request timeout, an exit during the first boot and a failed fork give `ENGINE_FAILED`. A call on an unbound IPC channel gives `ENGINE_RESTARTING`, and on a closed in-process channel `ENGINE_UNAVAILABLE`.<br>• Per-method `ApiArgs`/`ApiResult` types stay `unknown` until V1-19 narrows them.<br>• Test seams:<br>&nbsp;&nbsp;– an optional `{fork, coreEntryPath}` on `Supervisor`<br>&nbsp;&nbsp;– a minimal `SupervisorGateway { onCoreDown }`<br>&nbsp;&nbsp;– a `Clock` in `supervisor.ts`<br>• `IpcCoreChannelSide` (the Core end) is in `channel/`, and V1-15 uses it.<br>• `stop()` works from FAILED. `restartCount` includes the current restart.<br>• The state machine never branches on exit codes or signals (Windows differs). | P2 §5, §6, §19.1 |
| S-35 | **Client connection and session gap-fills (V1-31).**<br>• A `resync` reloads on the same socket (R-9; P3 §3 fixed). A close during that reload reconnects with normal backoff and no resume.<br>• `Connection` gains `terminate()` and `resetBackoff()`. `onMessage(msg, frameBytes)` carries the frame size. `closeAndReconnect(fresh)` resets the backoff.<br>• Close codes not in the table reconnect.<br>• A `getToken` that throws counts as a failed attempt (1006), and its error is never reported.<br>• `session/ports.ts` defines `SessionSync` and `DocumentBinding`. V1-32's `TextSyncClient` implements `SessionSync`.<br>• An out-of-order chunk or a failed assembly reloads. Two in a row is terminal. | P3 §3–§5 |
| S-36 | **Server Core gap-fills (V1-15).**<br>• **Old-epoch resume (PO-16):** the server replays the retained entries after the client's `rev` (an `ack` for the client's own, a `remote` for others), then sends `resync('epoch-changed')` and a full load, so the client learns the new epoch. If the entries are no longer retained, it sends only the resync and the load.<br>• **Constructor:** `CoreRuntime(side, { services, clock? })`, where `services` holds the factories for the codec, flush, recovery, audit and queue.<br>• **Close codes:** a failed load closes with `closeCodeFor(code)`, and a wrong protocol version closes with `PROTOCOL_ERROR` (§8.4 and §8.5 fixed).<br>• **Messages:**<br>&nbsp;&nbsp;– A second `hello` gets `PROTOCOL_INVALID_MESSAGE`.<br>&nbsp;&nbsp;– A submit during shutdown is dropped silently; the client resends.<br>&nbsp;&nbsp;– A batch where every op is dropped gets no audit event.<br>&nbsp;&nbsp;– `PROTOCOL_OP_REJECTED` uses the catalogue severity.<br>&nbsp;&nbsp;– A `ping` that reaches the Core gets a `pong`.<br>• **Documents:** a fresh re-import resets `allowedEdit` and deletes the old journal segments. A blank document uses `blankDocument.page`.<br>• **Gateway:** enforces the `asset-put` size limit.<br>• **Seams:** `core/seams.ts` holds `CodecSeam`, `FlushSeam`, `RecoverySeam`, `AuditSink`, `CoreSink` and `Clock`. V1-14a/b, V1-16 and V1-17 implement them.<br>• **Other owners:** `core-entry.ts` belongs to V1-19, the audit replay at boot (R-19) to V1-17, and `reloadFromStorage()` to V1-16. | P2 §7, §8 |
| S-37 | **Text sync client gap-fills (V1-32).**<br>• **Caret:** when a remote change inserts text exactly at the local caret, the caret stays before it (assoc −1 in the §7.2 rebuild). In the BRD §3 "cat" case, the writer committed first sees "ch\|oat".<br>• **Callbacks:** `TextSyncClient` takes `notify(RestoreNotice)`, `onError` and `activity('idle'\|'busy'\|'restoring')` as its own dependencies. V1-36 connects them through `session/ports.ts` and `DocumentSession`.<br>• **Rescue:**<br>&nbsp;&nbsp;– `QUEUE_FULL` retries it.<br>&nbsp;&nbsp;– Reconnect and terminal codes keep it for after the resume.<br>&nbsp;&nbsp;– Reload codes report it as lost.<br>&nbsp;&nbsp;– Errors are not reported twice.<br>&nbsp;&nbsp;– A rescue still unanswered at the next reload is dropped with the partial-loss notice.<br>&nbsp;&nbsp;– Orphans are rebased over the remotes buffered during the load.<br>&nbsp;&nbsp;– `onReconnected` resends an unanswered rescue.<br>• **Offline typing** still updates the pending count.<br>• **Undo keys** are also blocked in the sync plugin.<br>• **Safety check:** submitting while read-only throws an internal error. | P3 §6–§7 |
| S-38 | **Flush and recovery gap-fills (V1-16).**<br>• **Reload:** `reloadFromStorage` moves `rev` up by 1, so stale submits and resumes get `resync('history-unavailable')`.<br>• **`mark-resolved`:** accepts the current storage version as known, marks local changes as flushed and returns to NORMAL. It writes nothing to storage and deletes nothing locally.<br>• **Edge cases:** `resolve()` in LOCAL or CHECK does nothing. A failed `overwrite-storage` or `mark-resolved` leaves the state unchanged. An export failure during CHECK counts as a failed retry. `reloadFromStorage` emits no `document` event.<br>• **After a successful flush:** the `FlushTarget` seam gains a post-flush compaction (snapshot, rotate, trim; P2 §12).<br>• **Joining while storage is down:** a session that finishes loading while storage is LOCAL, PENDING or CONFLICT gets the current storage notice.<br>• **Wiring for V1-19:** both modules take the codec's export function, `dataDir`, a logger and emitters. V1-19 calls `RecoveryManager.close()` on shutdown and re-exports `RecoveryEntry`, `RecoveryResolution` and `LocalCopy` from `recovery-manager.ts`. | P2 §8.4, §12, §13 |
| S-39 | **Text editor gap-fills (V1-33).**<br>• **Plugins:** the sync plugin and an `isRemote(tr)` check are passed in on each load. `TextEditorView.setReadOnly()` follows "Edit anyway". Attribute changes use per-attribute steps.<br>• **Table column resize:** V1-33 saves whole-pixel widths itself, because prosemirror-tables writes 0 or fractional widths for merged cells. A merged cell's other columns default to 100 px. A table command that would hit this clears the table's widths and re-runs, in one transaction.<br>• **Paste:** files with no text are an image paste. Anything with text pastes as content.<br>• **Images:** an image that won't decode gives `CLIENT_IMAGE_TYPE_UNSUPPORTED`. The 60 s upload timeout gives `DOCUMENT_TOO_LARGE` (the LLD fallback).<br>• **Shared helper:** `pageSettingsFit` is exported from `@open-docex/shared/text`, and the client uses it instead of a copy. Main-process code keeps its copy and the parity test (S-31).<br>• **Paragraph formatting UI (PO-20):** a new toolbar item `'paragraph'` (in the public `TextToolbarItemId`) opens a Paragraph dialog with spacing before and after, line height (multiple, exact or at least), and left, right and first-line indent. V1-35 builds it, and `labels.ts` gains its strings.<br>• **V1-36:** extends `BindingContext.send` for `asset-put` and `asset-get`, and destroys the `AssetCache` together with the editor. | P3 §9, §13, §14 |
| S-40 | **AuditEmitter gap-fills (V1-17).**<br>• `AuditEmitter({ dataDir, meta, emit, logger?, fsync?, enabled? })` implements `AuditSink`. It starts disabled. While disabled it sends nothing, does not advance `auditEmittedRev`, and replay returns 0.<br>• A live `emit(e)` passes the event on unchanged (`replayed: false`). `auditEmittedRev` advances only after the hand-off, coalesced per document and never backwards. A failed hand-off is logged, and the next boot replays it.<br>• `replayPending(documentId)` re-emits journal entries after `auditEmittedRev` with `replayed: true` and `sessionId: null`. `replayAll()` runs it for every document in the MetaStore, skips a document with a corrupt journal and logs it. `flush()` waits for pending meta writes.<br>• **V1-19 wiring:** build the emitter in `CoreServices.audit(ctx)`; call `setEnabled(true)` before replay; run `await replayAll()` at boot after `meta.loadAll()` and before sessions are accepted and before any `DocumentInstance` loads (replay opens its own journal handle); call `setEnabled(on)` on `audit.enable`; call `await flush()` on shutdown.<br>• Replay can duplicate events after a crash. That is allowed (PO-17). | P2 §15 |
| S-41 | **React shell gap-fills (V1-35).**<br>• **Dialogs:** a `DialogBus` carries every dialog request. V1-36 passes `requestDialog: (id) => bus.request(id)` to `TextEditorView`. The Toolbar handles the `'paragraph'` item itself and opens the Paragraph dialog through the bus.<br>• **Default toolbar:** `'paragraph'` is added to `TEXT_TOOLBAR_ITEMS` by V1-36, after the Link item.<br>• **Session snapshot:** V1-36 adds `conversions` (PO-22) and `pendingCount` to what `DocumentSession` exposes. The shell takes them as optional fields until then.<br>• **V1-36 provides the shell environment:** `ShellEnv` is `{ session, labels, documentId, hooks, toolbar, container, getEditor, dialogs }`, rendered as `<Shell env=… />`.<br>• **CSS:** `frontend/src/ui/shell.css` and `frontend/src/text/editor.css` are written by V1-36 and imported from `frontend/src/index.ts`, so Vite emits `style.css`. `shell.css` covers the `odx-shell`, `odx-toolbar`, `odx-toolbar-item`, `odx-btn`, `odx-badge`, `odx-banner` (and `-error`, `-conversions`), `odx-error`, `odx-editor-host`, `odx-progress`, `odx-statusbar`, `odx-dialog-backdrop`, `odx-dialog` (and `-actions`, `-error`) and `odx-field` classes. `editor.css` covers ProseMirror, prosemirror-tables and the page frames of V1-34.<br>• **Banner:** after "Edit anyway" it collapses to the `editingAnyway` line once `readOnlyReason` leaves `'unsupported'` while `access === 'edit'`.<br>• **Sheets:** the toolbar is text-only in V1. The table picker uses number inputs for rows and columns.<br>• **Tests:** they use `react-dom/client` with `act`, with no Testing Library. | P3 §14 |
| S-42 | **Pagination gap-fills (V1-34).**<br>• **Resume fix (corrects S-4 and P3 §10):** the pass memo also stores the end state (`yEnd`, `pageEnd`, `posEnd`). Without it, appending a block at the end of the body resumed one past the stored arrays and produced NaN. The S3 prototype has the same flaw.<br>• **`PageBreakMark.page`** is the 0-based index of the page that starts at that break.<br>• **Height cache:** it resets only when the page width or the left or right margins change.<br>• **Tables** are measured as the `.tableWrapper` div that prosemirror-tables renders. Its CSS must keep that wrapper free of margins.<br>• **Copies** are `contenteditable=false`, `aria-hidden` and `inert`. A copy whose images haven't loaded is not cached, and is rebuilt when the asset arrives. `HeaderFooterRegions` gains `plugin()`, `commands()`, `measuredHeight` and `fillFields`.<br>• **Editor host:** it gets inline `position: relative` if its style is empty. Everything else is inline, with no `<style>` tags.<br>• **CSS** that V1-36 writes in `frontend/src/text/editor.css`: `.odx-body > * { margin: 0; box-sizing: border-box }`, `.odx-page-frames { position: absolute; left: 0; top: 0; width: 100%; z-index: 0 }` and `.odx-page { position: absolute; left: 0; background: #fff }`.<br>• **S-6 (8 ms at 300 pages):** the spike figures stand. V1-41 re-measures it on the real code, and V1-40 covers Firefox, WebKit, IME and web fonts. | P3 §10, §11 |
| S-43 | **Codec infrastructure gap-fills (V1-14a), and unsupported-feature ids (V1-14b).**<br>• `CodecService` adds `export()` (§14.1). `conversions` stays optional on the seam.<br>• The mapper is injected through `CodecMapper` in `codec-thread.ts`. V1-14b implements `FodtMapper` and the compiled thread entry that calls `startCodecThread(mapper)`. `CodecPool` takes that entry's URL.<br>• `XmlReader` is a streaming `parseXmlFile(path, opts, handlers)` with `open`, `text`, `close`, `binary` and `tree` handlers. The mapper does the hashing and the writing of binary data to the asset folder. Input that ends inside an element is rejected as unbalanced.<br>• `probe()` turns any failure of its probe job, other than not-found, into `CONFIG_LIBREOFFICE_NOT_FOUND`. A configured `libreoffice.path` that doesn't exist throws it too, with no fallback to auto-detect.<br>• The default snapshot validation uses `TextOtType.deserializeSnapshot`. A `sheet` kind gives `CONVERSION_FAILED` until V2.<br>• `pool.close()` kills any running soffice process tree and rejects pending jobs with `ENGINE_UNAVAILABLE`.<br>• The wrapper SVG uses px sizes with `preserveAspectRatio="none"`. The `PixelWidth` and `PixelHeight` filter options use `{"type":"long","value":"…"}`.<br>• **Feature ids (V1-14b):** the shared `UnsupportedFeature` union is a frozen contract and has fewer ids than the §14.7 table. The detector uses the shared union member where one exists. Otherwise it reports `feature: 'other'` with `detail` set to the table's id (for example `'macros'`, `'columns'`, `'form-controls'`). Adding union members needs an HLD/LLD contract change, which is not done in V1. | P2 §14 |

### 0.4 How to read Parts 1–3

- Each part's "Open questions" table is **resolved by §0.1 and §0.2**. Each part's "New contract names" and "Cross-part assumptions" tables are **resolved by §0.3**.
- Where a part's body text still contradicts §0, §0 wins. Implementers raise any such spot with the orchestrator, who fixes the text in the same commit as the code.


---

# Part 1 — Monorepo tooling and @open-docex/shared

Scope: repository tooling for all three packages (§1) and every module of `@open-docex/shared` (§2–§9). Part 2 (backend) and Part 3 (frontend) consume these contracts by their canonical names. Nothing here goes beyond the BRD and the HLD. Items that need a project-owner decision are in §10. New shared names are in §11.

## 0. Conventions and verified library facts

- **Version tags:** `[V1]`…`[V5]` per HLD §19. Nothing is designed for V6/V7, apart from one note that V7 registers our OT types with ShareDB (HLD §21).
- **(LLD choice)** marks an implementation detail decided here that follows from the HLD.
- **Units:** all lengths in shared models are in points (pt, 1/72 in) (LLD choice). The one exception is prosemirror-tables' `colwidth`, which stays in px as that library defines it.
- **Indices** are 0-based. A1 strings are 1-based.
- **Errors:** every failure is an `OpenDocexError` carrying a code from HLD §11.2.

These library facts were read from the published npm tarballs on 2026-11-18. The design relies on them.

| Library (version read) | Fact relied on | Reference |
|---|---|---|
| prosemirror-transform 1.12.6 (MIT) | `Mapping.appendMap(map, mirrors?)` records a mirror pair. `setMirror` is `@internal` and absent from `index.d.ts`, so we only use `appendMap`'s 2nd argument. When a position has a recover value at map *i* whose mirror *j>i* lies inside the slice, `Mapping._map` jumps straight to *j*. This keeps positions inside content that was removed and then re-inserted. `Mapping.slice(from,to)` shares the maps and mirror arrays. | https://prosemirror.net/docs/ref/#transform.Mapping.appendMap , src/map.ts |
| | `StepMap.invert()` needs no document. `Step.getMap()` is public. | https://prosemirror.net/docs/ref/#transform.StepMap.invert |
| | `Step.map(m)` returns `null` when the mapping deleted the step. `ReplaceStep` checks both ends with `deletedAcross`; `AttrStep` checks `deletedAfter`; `DocAttrStep` never returns null. | https://prosemirror.net/docs/ref/#transform.Step.map |
| | `Step.apply` returns `StepResult.fail` only for `ReplaceError`. It **throws** `RangeError` for out-of-range positions (`doc.resolve`) and for attribute validation failures (`NodeType.create` → `AttributeSpec.validate`). | src/replace_step.ts, src/attr_step.ts |
| | `ReplaceStep.MAP_BIAS` (static, default `1`, added in 1.12.0) decides how an insertion maps over an insertion at the same position. It is global and mutable. | CHANGELOG 1.12.0 |
| | Registered step JSON ids: `replace`, `replaceAround`, `addMark`, `removeMark`, `markSet`, `addNodeMark`, `removeNodeMark`, `attr`, `docAttr`. | src/*.ts `Step.jsonID` |
| prosemirror-model 1.25.13 (MIT) | `Node.fromJSON` does **not** check content. `Node.check()` checks content, marks and attributes recursively. `AttributeSpec.validate` runs on `create` for supplied values and again in `check()`. `Fragment.nodesBetween(a,b)` visits a child when `start < b && end > a`. | https://prosemirror.net/docs/ref/#model.Node.check , https://prosemirror.net/docs/ref/#model.AttributeSpec.validate |
| prosemirror-tables 1.8.5 (MIT) | `tableNodes({tableGroup, cellContent, cellAttributes})` returns `table`, `table_row`, `table_cell` and `table_header` specs. `colspan` and `rowspan` validate only `"number"`. `colwidth` is `null` or `number[]` (px). The package root also imports prosemirror-view, -state and -keymap. prosemirror-view 1.42.9 guards `navigator`/`document` with `typeof`, so importing it in Node is safe. | https://github.com/ProseMirror/prosemirror-tables#documentation |
| prosemirror-collab 1.3.1 | Its `rebaseSteps` needs a `Transform` and sets a mirror only for steps that applied, so its result depends on the document. **We do not use it.** | https://prosemirror.net/docs/ref/#collab.rebaseSteps |
| typescript-eslint 8.73.0 | Peer range `typescript >=4.8.4 <6.1.0`, so TypeScript is pinned to `~6.0.3` even though 7.0.2 is `latest`. | `npm view typescript-eslint peerDependencies` |
| vite 8.3.8 | `build.lib {entry, formats, fileName, cssFileName}`. `build.rolldownOptions` (`rollupOptions` is deprecated). Exports `defaultClientConditions` and `defaultServerConditions`. | https://vite.dev/config/build-options |
| vitest 5.1.1 | Root `test.projects`. Engines `^22.12 \|\| ^24 \|\| >=26` (matches CL-10). | https://vitest.dev/guide/projects |
| npm 11 | `npm query ".prod"` returns production dependency nodes, each with its `license`. | https://docs.npmjs.com/cli/v11/commands/npm-query |
| Web Crypto | `crypto.getRandomValues` works in insecure contexts. `crypto.randomUUID` is secure-context only. Both are global in Node ≥ 19. | https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID |
| RFC 6455 | Close codes 4000–4999 are reserved for applications (§7.4.2). A close reason is at most 123 bytes of UTF-8. | https://www.rfc-editor.org/rfc/rfc6455#section-7.4.2 |

---

## 1. Monorepo and tooling [V1]

### 1.1 Repository layout

```
open_docex/
  package.json  package-lock.json  tsconfig.base.json  tsconfig.json  eslint.config.js
  vitest.config.ts  playwright.config.ts
  scripts/  check-licenses.mjs  check-versions.mjs  set-version.mjs  licence-exceptions.json
  e2e/      harness/server.ts (http server + createEngine + built client page)   tests/*.spec.ts
  .github/workflows/  ci.yml  release.yml
  shared/  backend/  frontend/
```

`e2e/` is not a workspace, because its tests span server and client (LLD choice). GitHub Actions is the CI host (LLD choice).

### 1.2 Root `package.json`

```json
{
  "name": "open-docex-monorepo",
  "private": true,
  "type": "module",
  "workspaces": ["shared", "backend", "frontend"],
  "engines": { "node": ">=22.12" },
  "scripts": {
    "build": "tsc -b && npm run build:lib --workspace @open-docex/client",
    "typecheck": "tsc -b && npm run typecheck --workspaces",
    "lint": "eslint .",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "check:licenses": "node scripts/check-licenses.mjs",
    "check:versions": "node scripts/check-versions.mjs",
    "audit:prod": "npm audit --omit=dev --audit-level=high",
    "clean": "node -e \"for (const p of ['shared','backend','frontend']) require('fs').rmSync(p + '/dist', {recursive: true, force: true})\""
  },
  "devDependencies": {
    "typescript": "~6.0.3", "vitest": "^5.1.1", "@playwright/test": "^1.65.1",
    "eslint": "^10.15.0", "typescript-eslint": "^8.73.0", "jsdom": "<current>", "@types/node": "^22.12.0"
  }
}
```

`@types/node` is pinned to the lowest supported line, so the code cannot use APIs that are newer than Node 22 (LLD choice).

### 1.3 Package manifests

| Package | Folder | `exports` | Runtime deps | Build output |
|---|---|---|---|---|
| `@open-docex/shared` | `shared/` | `.`, `./protocol`, `./errors`, `./ids`, `./ot`, `./text`, `./sheet` | `prosemirror-model ^1.25.13`, `prosemirror-transform ^1.12.6`, `prosemirror-tables ^1.8.5` | `dist/**/*.js` + `.d.ts` (tsc) |
| `@open-docex/server` | `backend/` | `.` | `@open-docex/shared` **exact** same version, `ws`, XML parser (Part 2); optional peers `redis`, `@confluentinc/kafka-javascript` [V3]. Dev: `@types/ws`, `@types/yauzl` (MIT) | `dist/` (tsc) |
| `@open-docex/client` | `frontend/` | `.`, `./style.css` | `@open-docex/shared` exact, ProseMirror packages, `@univerjs/*` pinned [V2]; peer React (Part 3). Dev: `@types/react`, `@types/react-dom` (MIT) | `dist/lib/` (Vite) + `dist/types/` (tsc) |

Example entry in shared's `exports`. The other subpaths have the same shape.

```json
"./protocol": { "@open-docex/source": "./src/protocol/index.ts", "types": "./dist/protocol/index.d.ts", "import": "./dist/protocol/index.js" }
```

- **Common fields:** `"type": "module"`, `"sideEffects": false` (the client's value is set in Part 3), `"files": ["dist"]`, `"engines": {"node": ">=22.12"}`, `"publishConfig": {"access": "public"}`, `"license": "MIT"`. `prepack` copies the root `LICENSE` into the package.
- **ESM only:** there is no `require` condition (CL-15).
- **Why subpaths:** main-process modules (Gateway, Engine API) import only `/protocol`, `/errors` and `/ids`. That keeps ProseMirror out of the adopter's main process (N4). (LLD choice)
- **`@open-docex/source`:** a custom export condition used only by tests and type-checking in this repository, so they run against shared's `src` without a build. No consumer environment sets this condition. (LLD choice)
- **Caret ranges for ProseMirror:** exact pins would duplicate `prosemirror-model` in adopter bundles and break `instanceof` checks. If the server and the browser resolve different patch versions, their rebase results can differ. The `committed` echo corrects that (§8.6, CL-6).

### 1.4 TypeScript configuration

`tsconfig.base.json`:

```json
{ "compilerOptions": {
  "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "lib": ["ES2023"],
  "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
  "noImplicitOverride": true, "noFallthroughCasesInSwitch": true, "verbatimModuleSyntax": true,
  "isolatedModules": true, "declaration": true, "declarationMap": true, "sourceMap": true,
  "composite": true, "skipLibCheck": true, "forceConsistentCasingInFileNames": true, "types": [] } }
```

| File | Purpose | Overrides |
|---|---|---|
| `tsconfig.json` (root) | Solution file for `tsc -b` | `"files": []`, `references: shared, backend, frontend` |
| `shared/tsconfig.json` | Build | `rootDir: src`, `outDir: dist`. No DOM lib and no `@types/node`, so isomorphism (HLD §5) is enforced at compile time. `src/env.d.ts` declares only `crypto.getRandomValues`, `crypto.subtle.digest` (for `computeAssetId`, R-12), `TextEncoder` and `URL` (constructor + `protocol`). |
| `backend/tsconfig.json` | Build | `types: ["node"]`, references shared |
| `frontend/tsconfig.json` | Declarations only | `lib: [ES2023, DOM, DOM.Iterable]`, `jsx: react-jsx`, `emitDeclarationOnly`, `declarationDir: dist/types`, references shared |
| `<pkg>/tsconfig.test.json` | Type-check `src` + `test` | `composite: false`, `noEmit`, `customConditions: ["@open-docex/source"]`. This condition is never set in a build config: in a composite build it would pull shared's sources into another project (TS6307). |

`NodeNext` is used everywhere, including the client, with `.js` extensions in relative imports. Vite resolves `./x.js` to `./x.ts`. Emitted `.d.ts` files then work for both NodeNext and bundler consumers (LLD choice).

### 1.5 Build

- **shared and server:** `tsc -b` emits JS, `.d.ts` and maps to `dist/`.
- **client:** `tsc -b` emits declarations to `dist/types`. `vite build` runs in library mode with `build.lib = { entry: 'src/index.ts', formats: ['es'], fileName: 'index', cssFileName: 'style' }` and `build.outDir = 'dist/lib'`. Every `dependencies` and `peerDependencies` entry, and their subpaths, goes in `build.rolldownOptions.external`. `build.target` is `'es2022'`.
- **Order:** the root `build` script runs `tsc -b` first (shared → backend, frontend), then the client's Vite build.

### 1.6 Lint and dependency boundaries

`eslint.config.js` (flat config) uses `typescript-eslint` `recommendedTypeChecked` with `parserOptions.project` set to the three `<pkg>/tsconfig.test.json` files, which cover both `src` and `test` (`projectService` only finds `tsconfig.json`, which excludes tests; changed 2026-11-22 with the project owner's approval). Repository scripts and `*.config.ts` files are linted without type information. `no-restricted-imports` enforces the HLD §5 dependency rule:

| Files | Forbidden imports |
|---|---|
| `shared/src/**` | `node:*` and Node built-ins, `ws`, `react*`, `@univerjs/*`, `prosemirror-view`, `prosemirror-state`, `@open-docex/server`, `@open-docex/client` |
| `backend/src/**` | `@open-docex/client`, `react*`, `prosemirror-view` |
| backend main-process folders (named in Part 2) | `@open-docex/shared` root, `/text`, `/sheet`, `/ot` (only `/protocol`, `/errors`, `/ids` are allowed; N4) |
| `frontend/src/**` | `@open-docex/server`, `node:*` |

### 1.7 Tests

- **Root `vitest.config.ts`:** `test.projects: ['shared', 'backend', 'frontend']`. Each package has its own `vitest.config.ts`:

| Package | Environment | Notes |
|---|---|---|
| shared | `node` | DOM parse/serialize tests opt in with `// @vitest-environment jsdom`. `resolve.conditions` and `ssr.resolve.conditions` are `['@open-docex/source', ...defaultServerConditions]`. |
| backend | `node`, `pool: 'forks'`; conditions as for shared | `*.lo.test.ts` (real LibreOffice) are always collected and wrap their suites in `describe.skipIf(process.env.OPEN_DOCEX_LO_TESTS !== '1')`, so they are listed as skipped unless `OPEN_DOCEX_LO_TESTS=1` (Vitest cannot list excluded files; changed 2026-11-22 with the project owner's approval). |
| frontend | `jsdom` | Conditions `['@open-docex/source', ...defaultClientConditions]` |

- **Playwright:** `playwright.config.ts` at the root and specs in `e2e/tests`. `webServer` starts `e2e/harness/server.ts` against built packages. CI runs Chromium (LLD choice until §10 Q10 is decided).
- **Contract fixtures:** `shared/fixtures/protocol/{valid,invalid}/*.json` (not published). Backend and frontend contract tests import them by relative path.

### 1.8 Scripts

| Script | Where | Does |
|---|---|---|
| `build` | root | Builds all packages in dependency order |
| `typecheck` | root + each package (`tsc -p tsconfig.test.json`) | Type-checks sources and tests |
| `lint` | root | ESLint over all packages |
| `test` | root | Vitest, all projects |
| `test:e2e` | root | Playwright |
| `check:licenses`, `audit:prod`, `check:versions` | root | §1.9, §1.11 |
| `build:lib` | frontend | `vite build` |

### 1.9 Supply chain: licence allowlist and audit

`scripts/check-licenses.mjs` uses only Node and npm (LLD choice: it reads the hoisted workspace tree reliably).

```
prod  = npm query ".prod" ∪ npm query ".peer", minus nodes npm flags `dev`, minus the root and workspaces
dev   = npm query ".dev" (and nodes flagged `dev`)       // report-only (L-1)
nodes = prod
allow = {MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0}
exceptions = read licence-exceptions.json           // [{name, version, licence, reason, approvedBy}]; starts empty
for n in nodes where n is not a workspace:
  lic = n.license
  if lic is a string: ok = evalSpdx(lic)  // "(A OR B)": any alternative allowed; "A AND B": all allowed
  else ok = false                           // legacy object/array/missing → unknown → fail
  if !ok and not in exceptions(n.name, n.version): fail(n.name@n.version, lic)
exit 1 if any fail
```

- **MPL:** MPL-2.0 is never allowed as an npm dependency. LibreOffice is an external program and is never in the tree (N5, PO-6).
- **Dev-only dependencies:** reported but not failed (§0 L-1). A peer of a dev tool (for example lightningcss, MPL-2.0, from vite) is flagged `dev` by npm and is therefore report-only. Changed 2026-11-22 with the project owner's approval: the literal `".prod, .peer"` query also returned such peers.
- **Audit:** `npm audit --omit=dev --audit-level=high` fails CI. A full `npm audit` runs report-only.
- **Tests (`scripts/test/check-licenses.test.mjs`):** the SPDX evaluator handles OR, AND, parentheses, `WITH` (fail), unknown identifiers, and the exception file. The test runs in the shared project.

### 1.10 CI (`.github/workflows/ci.yml`)

| Job | Runs on | Steps |
|---|---|---|
| `static` | ubuntu, Node 24 | `npm ci` → `lint` → `build` → `typecheck` → `check:licenses` → `audit:prod` → `check:versions` |
| `test` | ubuntu × Node **22, 24, 26** | Install LibreOffice: `sudo apt-get install -y --no-install-recommends libreoffice-writer libreoffice-calc`. Then `npm ci`, `build`, `OPEN_DOCEX_LO_TESTS=1 npm test`. |
| `test-windows` | windows-latest, Node 24 | `choco install libreoffice-fresh -y --no-progress`, then the same test command (spike S2: concurrent profiles on Windows) |
| `e2e` | ubuntu, Node 24 | `npx playwright install --with-deps chromium`, `build`, `test:e2e` |
| `queues` [V3] | ubuntu, Node 24 | Redis/Valkey and Kafka service containers; V3 adapter integration tests; `@confluentinc/kafka-javascript` install on all three Node lines (S6) |

The matrix drops a Node line at its end-of-life (CL-10).

### 1.11 Versioning and release

- **Lockstep:** all three packages carry the same version and are released together. Server and client depend on the exact same version of shared, so protocol, schema and OT code are identical on both sides (LLD choice). npm version numbers are chosen at publish time (VERSION_PLAN.md).
- **`set-version.mjs <x.y.z>`:** writes the version to the three manifests, pins `@open-docex/shared` to `x.y.z` in server and client, then runs `npm install --package-lock-only`.
- **`check-versions.mjs`:** fails unless all three versions are equal and both pins match.
- **`release.yml`** (manual dispatch): runs `ci.yml` jobs, then `npm publish -w shared -w backend -w frontend` in that order.

### 1.12 Package folder layouts

Only the top level is fixed here. Part 2 and Part 3 own the internals.

```
shared/   src/{index.ts, env.d.ts, util/, ids/, errors/, protocol/, ot/, text/, sheet/}   test/{same folders, contract/}   fixtures/protocol/
backend/  src/{index.ts, …Part 2}   test/{unit/, integration/, codec/ (*.lo.test.ts), fixtures/}
frontend/ src/{index.ts, …Part 3}   test/{unit/, component/}
```

---

## 2. `@open-docex/shared` overview

| Module | Files (`shared/src/…`) | Version | Depends on |
|---|---|---|---|
| util | `util/canonical-json.ts`, `util/utf8.ts`, `util/random.ts` | V1 | — |
| ids | `ids/index.ts` | V1 | util, errors |
| errors | `errors/catalogue.ts`, `errors/open-docex-error.ts`, `errors/index.ts` | V1 | — |
| protocol | `protocol/messages.ts`, `protocol/validate.ts`, `protocol/frames.ts`, `protocol/codec.ts`, `protocol/close-codes.ts`, `protocol/index.ts` | V1 (upload V4, annotation V5) | ids, errors |
| ot | `ot/types.ts`, `ot/index.ts` | V1 | — |
| text | `text/schema.ts`, `text/href.ts`, `text/page.ts`, `text/steps.ts`, `text/rebase.ts`, `text/apply.ts`, `text/chunk.ts`, `text/ot-type.ts`, `text/index.ts` | V1 (anchors V5) | ot, errors, util, prosemirror-* |
| sheet | `sheet/model.ts`, `sheet/ops.ts`, `sheet/validate.ts`, `sheet/a1.ts`, `sheet/shift.ts`, `sheet/order-key.ts`, `sheet/transform.ts`, `sheet/apply.ts`, `sheet/chunk.ts`, `sheet/ot-type.ts`, `sheet/index.ts` | V2 | ot, errors, util |

**Rules for every module:**
- Pure functions, with no I/O, timers or host globals other than those declared in `env.d.ts`.
- **Root export:** `shared/src/index.ts` re-exports every public module. Main-process code still imports only the `/protocol`, `/errors` and `/ids` subpaths (N4). Approved 2026-11-22.
- Inputs are never mutated.
- Objects built from untrusted JSON use null-prototype dictionaries, and only known fields are copied (prototype-pollution safe).

**Utilities [V1]:**
- `canonicalJson(v: unknown): string`: JSON with recursively sorted object keys, used for equality checks.
- `utf8Length(s: string): number`: counts UTF-8 bytes without allocating.
- `randomBytes(n: number): Uint8Array`: `globalThis.crypto.getRandomValues`.
- `base64url(b: Uint8Array): string`.

---

## 3. `ids` [V1]

**Responsibility:** typed identifiers and random ID generation, identical in Node and browsers.

```ts
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };
export type DocumentId = Brand<string, 'DocumentId'>;
export type ClientId   = Brand<string, 'ClientId'>;
export type Epoch      = Brand<string, 'Epoch'>;
export function newClientId(): ClientId;          // 16 random bytes → base64url, 22 chars
export function newEpoch(): Epoch;                 // same format
export function newRandomId(): string;             // same format; sheet ids, style ids, annotation ids
export function asDocumentId(raw: string): DocumentId;   // throws PROTOCOL_INVALID_MESSAGE
export function isClientId(x: unknown): x is ClientId;   // /^[A-Za-z0-9_-]{22}$/
export function isEpoch(x: unknown): x is Epoch;         // same regex
export function isAssetId(x: unknown): x is string;      // /^[0-9a-f]{64}$/ (lowercase hex SHA-256 of the bytes)
```

- **`asDocumentId`:** accepts 1–1024 UTF-16 code units with no C0 control characters (LLD choice; see §10 Q9). The ID is never used as a file name (HLD §14).
- **Randomness:** uses `getRandomValues`, not `randomUUID`, because `randomUUID` fails on non-secure origins.
- **Errors:** `PROTOCOL_INVALID_MESSAGE` from `asDocumentId`.
- **Concurrency:** none.

**Tests (unit):**
- format regexes;
- 100 000 generated IDs with no duplicates;
- works with only `globalThis.crypto` (no `node:crypto` import);
- `asDocumentId` boundary cases (empty, 1024, 1025, `\u0000`).

---

## 4. `errors` [V1]

**Responsibility:** the HLD §11.1 error shape, the error class, the full catalogue, and the sanitized client form.

```ts
export type ErrorCode = 'CONFIG_INVALID' | 'CONFIG_LIBREOFFICE_NOT_FOUND' | 'CONFIG_DATA_DIR_UNWRITABLE'
  | 'STORAGE_READ_FAILED' | 'STORAGE_WRITE_FAILED' | 'STORAGE_LOCAL_MODE' | 'STORAGE_PENDING' | 'STORAGE_CONFLICT'
  | 'QUEUE_FULL' | 'QUEUE_UNAVAILABLE' | 'ENGINE_RESTARTING' | 'ENGINE_UNAVAILABLE' | 'ENGINE_FAILED'
  | 'DOCUMENT_FAULTED' | 'DOCUMENT_UNSUPPORTED_CONTENT' | 'DOCUMENT_READ_ONLY' | 'DOCUMENT_NOT_FOUND' | 'DOCUMENT_TOO_LARGE'
  | 'CONVERSION_FAILED' | 'CONVERSION_TIMEOUT' | 'SESSION_SLOW_CONSUMER' | 'SESSION_CLOSED' | 'SESSION_RESYNC_REQUIRED'
  | 'ACCESS_DENIED' | 'PROTOCOL_INVALID_MESSAGE' | 'PROTOCOL_VERSION_UNSUPPORTED' | 'PROTOCOL_OP_REJECTED'
  | 'CLIENT_CONNECT_FAILED' | 'CLIENT_ASSET_TOO_LARGE' | 'CLIENT_IMAGE_TYPE_UNSUPPORTED';   // CLIENT_*: browser only (L-16)
export type ErrorCategory = 'config'|'storage'|'queue'|'engine'|'session'|'access'|'protocol'|'document'|'conversion'|'recovery'|'client';
export type ErrorSeverity = 'info'|'warning'|'error'|'fatal';
export interface OpenDocexErrorShape {               // HLD §11.1, verbatim
  code: ErrorCode; category: ErrorCategory; retryable: boolean; severity: ErrorSeverity;
  documentId?: string; instanceId?: string; message: string; remediation: string; cause?: unknown;
}
export interface CatalogueEntry { category: ErrorCategory; retryable: boolean; severity: ErrorSeverity; clientMessage: string; remediation: string }
export const ERROR_CATALOGUE: Readonly<Record<ErrorCode, CatalogueEntry>>;
export class OpenDocexError extends Error implements OpenDocexErrorShape {
  override readonly name: 'OpenDocexError';
  readonly code: ErrorCode; readonly category: ErrorCategory; readonly retryable: boolean; readonly severity: ErrorSeverity;
  readonly remediation: string; readonly documentId?: string; readonly instanceId?: string;
  constructor(code: ErrorCode, message?: string, opts?: { documentId?: string; instanceId?: string; cause?: unknown });
  toShape(): OpenDocexErrorShape;                  // cause → { name, message } plain object (IPC-safe)
  static fromShape(s: OpenDocexErrorShape): OpenDocexError;
  static is(x: unknown, code?: ErrorCode): x is OpenDocexError;   // structural check, safe across realms and IPC
}
export interface ClientErrorPayload { code: ErrorCode; retryable: boolean; message: string; clientSeq?: number; reqId?: number }
export function toClientError(err: unknown, ctx?: { clientSeq?: number; reqId?: number; fallback?: ErrorCode }): ClientErrorPayload;
```

**Algorithm:**
- **Constructor:** `category`, `retryable`, `severity` and `remediation` always come from `ERROR_CATALOGUE[code]`, so they cannot drift. `message` defaults to `clientMessage`. `cause` is passed to `super(message, { cause })`.
- **Why `toShape`/`fromShape`:** IPC with `serialization: 'advanced'` keeps only `name`, `message` and `stack` of an `Error` (CL-1), so the Core sends `toShape()` and the main process rebuilds the error.
- **`toClientError`:**
  - `code` is `err.code` for an `OpenDocexError`, otherwise `ctx.fallback ?? 'DOCUMENT_FAULTED'`.
  - `message` is always `ERROR_CATALOGUE[code].clientMessage`, never `err.message`. No `cause`, stack, path or storage detail reaches a client (HLD §11.1, §14).

**Catalogue.** STORAGE_PENDING and STORAGE_CONFLICT use the category `recovery` because the HLD §11.3 recovery machine raises them (LLD choice).

| Code | Category | Retry | Severity | Client message | Remediation (adopter) |
|---|---|---|---|---|---|
| CONFIG_INVALID | config | no | fatal | The editing service hit a server problem. | Fix the option named in `message` (see the configuration reference) and restart. |
| CONFIG_LIBREOFFICE_NOT_FOUND | config | no | fatal | The editing service hit a server problem. | Install LibreOffice on the server, or set `libreoffice.path` to the `soffice` executable. |
| CONFIG_DATA_DIR_UNWRITABLE | config | no | fatal | The editing service hit a server problem. | Create `dataDir` and make it writable by the Node.js process user, or point `dataDir` elsewhere. |
| STORAGE_READ_FAILED | storage | yes | error | The document could not be loaded. Retrying. | Check that the storage adapter can reach its backend and that `ref` exists; see `cause`. |
| STORAGE_WRITE_FAILED | storage | yes | warning | The editing service hit a server problem. | The engine kept a local copy and retries after 1, 5 and 15 min. Check storage availability and credentials. |
| STORAGE_LOCAL_MODE | storage | no | warning | Changes are saved on the server and will be copied to storage later. | No action needed while retries run. Watch the `storage` events. |
| STORAGE_PENDING | recovery | no | error | Changes are saved on the server; storage sync is pending. | Retries are exhausted. Fix storage, then call the recovery `retry()` for this document, or `resolve()` it. |
| STORAGE_CONFLICT | recovery | no | error | Changes are saved on the server; storage sync is pending. | The storage file changed while a newer local copy existed. Compare both and call `resolve()` with your choice. The engine never overwrites it on its own. |
| QUEUE_FULL | queue | yes | warning | The server is busy. Your change will be retried. | Clients retry automatically. If this is frequent, raise `queue.perDocument`/`queue.global` or reduce load. |
| QUEUE_UNAVAILABLE | queue | yes | error | The server is busy. Your change will be retried. | Check connectivity and credentials for the configured Redis/Valkey or Kafka [V3]. |
| ENGINE_RESTARTING | engine | yes | warning | Reconnecting… | Clients reconnect automatically. Inspect the preceding `error` event for the crash cause. |
| ENGINE_UNAVAILABLE | engine | no | error | The editing service is unavailable. | The engine is FAILED. Fix the cause in the `fatal` event and restart the application. |
| ENGINE_FAILED | engine | no | fatal | The editing service hit a server problem. | The restart limit was exceeded. Inspect the preceding `error` events and logs, fix, and restart. |
| DOCUMENT_FAULTED | document | no | error | This document hit an internal error. Reload to continue. | Inspect the `error` event's `cause`. Other documents keep running. Reopening reloads from the journal. |
| DOCUMENT_UNSUPPORTED_CONTENT | document | no | warning | Parts of this file can't be edited here, so it opened read-only. | See `unsupported`. Call `documents.allowUnsupportedEdit(documentId)` to allow editing; those parts are removed on save. |
| DOCUMENT_READ_ONLY | document | no | warning | This document is read-only. | The session is view-only or the document is read-only. The change was discarded. |
| DOCUMENT_NOT_FOUND | document | no | error | The document was not found. | The storage adapter reports no file for the `ref` returned by `authorize`. Check the mapping. |
| DOCUMENT_TOO_LARGE | document | no | error | The file is too large. | The file exceeds `limits.maxFileBytes`. Raise the limit or reduce the file. |
| CONVERSION_FAILED | conversion | no | error | The file could not be opened. | LibreOffice could not convert it. Check that the file is a valid .docx/.odt/.xlsx/.ods and that `soffice --headless --version` works for the server user. |
| CONVERSION_TIMEOUT | conversion | yes | error | Opening the file took too long. Retrying. | Raise `libreoffice.timeoutMs`, or add capacity (`maxConcurrent`, `codecThreads`). |
| SESSION_SLOW_CONSUMER | session | yes | warning | Connection too slow. Reloading. | The client fell behind its send buffer. Raise `send.highWaterMarkBytes` if this happens on healthy networks. |
| SESSION_CLOSED | session | no | info | The session was closed. | Closed by the server or the adopter. No action is needed unless unexpected. |
| SESSION_RESYNC_REQUIRED | session | yes | info | Reloading the latest version… | The client reloads automatically. |
| ACCESS_DENIED | access | no | error | You don't have access to this document. | Your `authorize` or `canSubmit` hook rejected the request. |
| PROTOCOL_INVALID_MESSAGE | protocol | no | error | Client and server are out of sync. Reload the page. | Make sure `@open-docex/client` and `@open-docex/server` are the same release. Otherwise a client sent a malformed frame. |
| PROTOCOL_VERSION_UNSUPPORTED | protocol | no | error | Please reload the page to update the editor. | Deploy the same release of client and server. |
| PROTOCOL_OP_REJECTED | protocol | no | error | A change could not be applied. Reloading. | The change failed validation and was discarded. If this is frequent, report a bug with the `error` event. |
| CLIENT_CONNECT_FAILED | client | yes | error | Can't connect. | Check the server is running and that proxies allow WebSocket upgrades on the engine path. |
| CLIENT_ASSET_TOO_LARGE | client | no | warning | This image is too large. | Raise limits.maxAssetBytes or use a smaller image. |
| CLIENT_IMAGE_TYPE_UNSUPPORTED | client | no | warning | Only PNG, JPEG and GIF images can be added. | Only PNG, JPEG and GIF are supported (PO-24). |

Codes whose client message is "The editing service hit a server problem." (the three `CONFIG_*`, `STORAGE_WRITE_FAILED`, `ENGINE_FAILED`) are not meant to reach a client; the generic text is what `toClientError` sends if one does. The `CLIENT_*` rows and these messages were approved by the project owner on 2026-11-22.

- **Concurrency:** none.
- **Tests (unit):**
  - every `ErrorCode` has an entry with non-empty remediation (a runtime count of 30 plus a compile-time `Record` check);
  - catalogue values are frozen;
  - `toShape` → `v8.serialize` → `deserialize` → `fromShape` round trip (in a Node-only test);
  - `toClientError` never leaks `message`, `cause` or `stack`, including for non-`OpenDocexError` values, strings and `null`;
  - `OpenDocexError.is` works across a structured clone.

---

## 5. `protocol` [V1; upload V4; annotation V5]

**Responsibility:** every HLD §9 message with exact fields, framing, hand-written runtime validation, encode/decode, and close codes. Transport and session logic belong to Parts 2 and 3.

### 5.1 Framing

- **Text frame:** a UTF-8 JSON object with a string `type`.
- **Binary frame:** used only for messages that carry bytes: `asset-put` (C→S), `asset` when it carries bytes (S→C), and `upload-chunk` (C→S, V4). Layout (LLD choice):

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | Magic `0xD0` |
| 1 | 1 | Layout version `1` |
| 2 | 4 | Header length *H*, uint32 big-endian, 1 ≤ *H* ≤ 65 536 |
| 6 | *H* | Header: UTF-8 JSON of the message without `bytes` |
| 6+*H* | rest | Payload, which becomes the `bytes` field |

- A binary-only type in a text frame is invalid. A text-only type in a binary frame is invalid.
- An unknown `type` is ignored in either frame kind (HLD §9).
- The overall frame size is bounded by the server's `ws` `maxPayload` (Part 2).

### 5.2 Messages

```ts
export const PROTOCOL_VERSION = 1 as const;
export type DocKind = 'text' | 'sheet';
export type Access = 'edit' | 'view';
export type AssetMime = 'image/png' | 'image/jpeg' | 'image/gif';          // §10 Q4
export type FileFormat = 'docx' | 'odt' | 'xlsx' | 'ods';
export interface SubmitEnvelope<O = unknown> { clientId: ClientId; clientSeq: number; epoch: Epoch; baseRev: number; ops: O[] }
export type UnsupportedFeature = 'tracked-changes' | 'comments' | 'footnotes' | 'fields' | 'text-boxes' | 'equations' | 'charts'
  | 'multiple-page-styles' | 'first-page-header' | 'odd-even-header' | 'conditional-formatting' | 'data-validation'
  | 'pivot-tables' | 'sheet-images' | 'cell-comments' | 'other';
export interface UnsupportedFinding { feature: UnsupportedFeature; count: number; where?: string[]; detail?: string }  // where: ≤ 20 human-readable locations

// C→S
export interface HelloMsg { type: 'hello'; protocol: number; clientId: ClientId; resume?: { epoch: Epoch; rev: number } }
export interface SubmitMsg<O = unknown> extends SubmitEnvelope<O> { type: 'submit' }
export interface AssetPutMsg { type: 'asset-put'; reqId: number; mime: AssetMime; bytes: Uint8Array }            // binary
export interface AssetGetMsg { type: 'asset-get'; reqId: number; assetId: string }
export interface PingMsg { type: 'ping'; n: number }
export interface UploadStartMsg { type: 'upload-start'; reqId: number; name: string; format: FileFormat; size: number }   // V4
export interface UploadChunkMsg { type: 'upload-chunk'; reqId: number; seq: number; bytes: Uint8Array }  // V4, binary
export interface UploadEndMsg { type: 'upload-end'; reqId: number }                                       // V4
export interface AnnotationListMsg { type: 'annotation-list'; reqId: number }                             // V5
export interface AnnotationPutMsg { type: 'annotation-put'; reqId: number; annotation: AnnotationInput }  // V5
export interface AnnotationDeleteMsg { type: 'annotation-delete'; reqId: number; id: string }             // V5
export type ClientMessage = HelloMsg | SubmitMsg | AssetPutMsg | AssetGetMsg | PingMsg | UploadStartMsg | UploadChunkMsg
  | UploadEndMsg | AnnotationListMsg | AnnotationPutMsg | AnnotationDeleteMsg;

// S→C
export interface LoadStartMsg { type: 'load-start'; epoch: Epoch; rev: number; kind: DocKind; access: Access;
  unsupported?: UnsupportedFinding[]; ackedClientSeq?: number }
export interface LoadChunkMsg extends Chunk { type: 'load-chunk' }                 // { seq, data } (§7)
export interface LoadDoneMsg { type: 'load-done'; rev: number }
export interface AckMsg<O = unknown> { type: 'ack'; clientSeq: number; rev: number; committed?: O[] }
export interface RemoteMsg<O = unknown> { type: 'remote'; fromRev: number; ops: O[]; clientId: ClientId }
export interface ErrorMsg extends ClientErrorPayload { type: 'error' }             // { code, retryable, message, clientSeq?, reqId? }
export interface ResyncMsg { type: 'resync'; reason: 'epoch-changed' | 'history-unavailable' | 'inconsistent' }
export type NoticeMsg =
  | { type: 'notice'; notice: 'storage'; state: 'normal' | 'local' | 'pending' }
  | { type: 'notice'; notice: 'read-only'; readOnly: boolean; reason: 'unsupported-content' }
  | { type: 'notice'; notice: 'engine-restarting' };
export interface AssetMsg { type: 'asset'; reqId: number; assetId: string; mime: AssetMime; size: number; bytes?: Uint8Array }
export interface PongMsg { type: 'pong'; n: number }
export interface UploadAckMsg { type: 'upload-ack'; reqId: number; receivedBytes: number }              // V4
export interface UploadDoneMsg { type: 'upload-done'; reqId: number; documentId: DocumentId }           // V4
export interface Annotation { id: string; kind: 'bookmark' | 'note'; body: string; authorId: string;    // V5
  createdAt: string; updatedAt: string; resolved: boolean; replyTo?: string }
export type AnnotationInput = Pick<Annotation, 'id' | 'kind' | 'body' | 'resolved'> & { replyTo?: string };
export interface AnnotationResultMsg { type: 'annotation-result'; reqId: number; annotations: Annotation[] }       // V5
export interface AnnotationChangedMsg { type: 'annotation-changed'; annotation?: Annotation; deletedId?: string }  // V5
export type ServerMessage = LoadStartMsg | LoadChunkMsg | LoadDoneMsg | AckMsg | RemoteMsg | ErrorMsg | ResyncMsg
  | NoticeMsg | AssetMsg | PongMsg | UploadAckMsg | UploadDoneMsg | AnnotationResultMsg | AnnotationChangedMsg;
```

**Message rules** (beyond the field list in HLD §9):

- **`hello`** must be the first client frame. The server binds `clientId` to the session. A later `submit.clientId` that differs gets `PROTOCOL_INVALID_MESSAGE` and close `4007`, so a client cannot spoof another client's dedupe key.
- **`load-start`, `ackedClientSeq` (new field, §11):** the highest `clientSeq` of `hello.clientId` that the snapshot already contains (§6 R12).
- **`notice`:**
  - **Read-only on load:** sent right after `load-start` when the instance is read-only because of unsupported content (PO-13). After `allowUnsupportedEdit`, every session gets `readOnly: false`.
  - **Storage state:** maps recovery states (HLD §11.3) as NORMAL → `normal`; LOCAL and CHECK → `local`; PENDING and CONFLICT → `pending` (LLD choice).
  - **`engine-restarting`:** sent by the Gateway just before closing with `4001`.
- **`asset-put`:**
  - The server derives `assetId` as the SHA-256 hex of `bytes` and answers with a text-frame `asset` without `bytes`.
  - `asset-get` is answered with a binary-frame `asset` carrying `bytes`.
  - View sessions may only `asset-get`.
  - Asset errors come back as `error` with `reqId`: `PROTOCOL_OP_REJECTED` (bad MIME or bytes, unknown asset), `DOCUMENT_TOO_LARGE`, `DOCUMENT_READ_ONLY`.
- **`ping`/`pong` (new, §11):** the client heartbeat (HLD §13 Connection). Browsers cannot send WebSocket ping frames. The server echoes `n`.
- **Upload [V4]:**
  - The client sends `upload-start`, then `upload-chunk`s of at most 256 KiB with `seq` from 0, then `upload-end`.
  - The server sends `upload-ack` after it persists each chunk. The client keeps at most 4 chunks unacknowledged (LLD choice).
  - The result is `upload-done { documentId }` from the `onUploaded` hook, or `error { reqId }`.
  - Which connection carries an upload is §10 Q5.
- **Annotation [V5]:** `id` comes from `newRandomId()`. The server sets `authorId` from the session's `userId`, and sets the timestamps (ISO 8601 UTC). `annotation-changed` is broadcast to the document's other sessions. Part 2 owns the `AnnotationStore` semantics.

### 5.3 Validation (hand-written)

**Why hand-written (LLD choice):**
- zero dependencies, so there is no supply-chain or licence surface (N5, HLD §14);
- no `eval`/`new Function`, so it is CSP-safe in adopter pages (Ajv-style code generation is not);
- exact control over error paths;
- it runs in the Core hot path;
- the surface is small (about 25 shapes).

Internal file `protocol/validate.ts`:

```ts
type Check<T> = (x: unknown, path: string) => T;          // throws ValidationError(path, reason)
export const v: {
  int(min: number, max: number): Check<number>;            // Number.isSafeInteger
  str(maxLen: number, re?: RegExp): Check<string>;
  lit<T extends string>(...values: T[]): Check<T>;
  arr<T>(item: Check<T>, o: { min?: number; max: number }): Check<T[]>;
  obj<S extends Record<string, Check<unknown>>>(req: S, opt?: Record<string, Check<unknown>>): Check<{ [K in keyof S]: ReturnType<S[K]> }>;
  bytes(maxLen: number): Check<Uint8Array>;
};
```

- **`obj`:**
  - requires a plain object and copies **only** declared keys into a fresh object, so unknown fields are dropped;
  - rejects `__proto__`, `constructor` and `prototype` keys;
  - fails a missing required field;
  - with `exactOptionalPropertyTypes`, never emits `undefined` for an optional field.
- **Bounds:**
  - `clientSeq` ≥ 1; `rev`, `baseRev`, `fromRev` and `seq` ≥ 0. All are safe integers.
  - `clientId` and `epoch` match the §3 regexes.
  - `ops` is an array of 1…`Number.MAX_SAFE_INTEGER` plain objects. Deep op validation is done by `OtType.validateOps` in the Core, which knows the document kind.
  - `name` ≤ 255 characters. `reqId` ≥ 0.
  - String lengths are otherwise bounded only by `maxPayload`. Per-user size and rate limits are B9 (V6) and are not added here.

### 5.4 Encode and decode

```ts
export type DecodeResult<M> = { kind: 'message'; message: M } | { kind: 'ignored'; type: string } | { kind: 'invalid'; error: OpenDocexError };
export function encodeMessage(msg: ClientMessage | ServerMessage): string | Uint8Array;
export function decodeClientMessage(data: string | Uint8Array): DecodeResult<ClientMessage>;
export function decodeServerMessage(data: string | Uint8Array): DecodeResult<ServerMessage>;
export function isBinaryType(type: string): boolean;
```

```
encodeMessage(m):
  if m has bytes: header = utf8(JSON.stringify(m without bytes)); assert 1 ≤ |header| ≤ 65536
                  return [0xD0, 1, u32be(|header|), header, m.bytes]
  else return JSON.stringify(m)
decodeXMessage(data):
  if string: obj = try JSON.parse(data) catch → invalid
             if !plainObject(obj) or typeof obj.type != 'string' → invalid
             if isBinaryType(obj.type) → invalid
             check = X_TEXT_VALIDATORS[obj.type]; if !check → ignored(obj.type)
             try return message(check(obj, '$')) catch ValidationError → invalid(PROTOCOL_INVALID_MESSAGE, path)
  else:      if len < 6 or data[0] != 0xD0 or data[1] != 1 → invalid
             H = u32be(data, 2); if H < 1 or H > 65536 or 6 + H > len → invalid
             hdr = JSON.parse(utf8decode(data[6 .. 6+H]))      // same object checks as above
             if !isBinaryType(hdr.type): known text type → invalid; unknown → ignored
             return message(check({...hdr, bytes: data.subarray(6+H)}))
```

`subarray` avoids copying the payload. In the browser the client sets `binaryType = 'arraybuffer'` and wraps the data in a `Uint8Array`.

### 5.5 Close codes

```ts
export const CloseCode = { NORMAL: 1000, GOING_AWAY: 1001, ENGINE_RESTARTING: 4001, ENGINE_UNAVAILABLE: 4002,
  ACCESS_DENIED: 4003, SLOW_CONSUMER: 4004, SESSION_CLOSED: 4005, DOCUMENT_FAULTED: 4006,
  PROTOCOL_ERROR: 4007, LOAD_FAILED: 4008 } as const;
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];
export function closeCodeFor(code: ErrorCode): CloseCode | undefined;
```

The close reason is the `ErrorCode` string, which is at most 123 bytes. When there is an error code, the server first sends an `error` frame with it, then closes.

| Close | Sent when (error codes) | Client reaction |
|---|---|---|
| 1000 | Client `destroy()` | None |
| 1001 | Engine shutdown | Reconnect with backoff; `hello` with `resume` |
| 4001 | Worker crash (`ENGINE_RESTARTING`, HLD §10.5) | Reconnect with backoff; `hello` with `resume` |
| 4002 | Engine FAILED (`ENGINE_UNAVAILABLE`) | Show error; no automatic reconnect |
| 4003 | Adopter closed the session by user or document (`ACCESS_DENIED`) | Show error; no reconnect |
| 4004 | `SESSION_SLOW_CONSUMER` | Reconnect at once with **no** `resume` (full reload, HLD §11.4) |
| 4005 | `SESSION_CLOSED` (adopter or engine closed the session or document) | No reconnect |
| 4006 | `DOCUMENT_FAULTED` | Show error; reload on user action |
| 4007 | `PROTOCOL_VERSION_UNSUPPORTED`, `PROTOCOL_INVALID_MESSAGE` (unparseable frame or `clientId` mismatch) | No reconnect |
| 4008 | Load failed: `DOCUMENT_NOT_FOUND`, `DOCUMENT_TOO_LARGE`, `CONVERSION_*`, `STORAGE_READ_FAILED` | Reconnect with backoff if the code is retryable, otherwise stop |

These errors do **not** close the connection:
- `QUEUE_FULL`, `DOCUMENT_READ_ONLY`, `ACCESS_DENIED` from `canSubmit`, and `PROTOCOL_OP_REJECTED` for a submit: the client keeps the connection. After the last three, the server sends `resync { reason: 'inconsistent' }` and a full load, because the client's local state holds rejected changes (LLD choice).
- Asset errors: these are sent with `reqId` only.

Refusals before the upgrade use HTTP status (401/403/503, HLD §10.1, §10.5) and are Part 2's.

- **Concurrency/ordering:** codecs are pure. Ordering guarantees come from the per-connection FIFO (Part 2).
- **Tests:**
  - **Unit:** encode→decode round trip for every type, in both frame kinds where they apply; every invalid fixture gives `invalid`; an unknown type is `ignored`; `__proto__` is stripped; header-length bounds and magic/version mismatch; a 64 KiB header; `closeCodeFor` is total over the codes in the table.
  - **Contract:** golden JSON fixtures in `shared/fixtures/protocol/` decode identically through `decodeServerMessage` and `decodeClientMessage`. Backend and frontend run the same fixtures against their real send and receive paths.

---

## 6. Exact semantics of `rev`, `epoch` and `clientSeq` [V1]

| # | Rule |
|---|---|
| R1 | **`rev`** is a safe integer ≥ 0: the number of committed ops in the document's history. Committing a batch of *k* applied ops moves the head from `fromRev` to `fromRev + k`. Text counts steps; sheets count sheet ops (HLD §8.3). Dropped ops do not count. |
| R2 | `rev` is persisted with the local snapshot and journal. An instance restored from local state continues from the persisted value. An instance built from storage bytes with no local state starts at 0 (LLD choice). |
| R3 | **`epoch`** is `newEpoch()`, created each time an instance is created (CL-7). A `rev` is meaningful only together with its epoch. Clients must not compare revs across epochs, nor assume a new epoch starts at 0. |
| R4 | **`baseRev`:** the envelope's ops are expressed against the document state at `baseRev` in the current epoch. That is the client's confirmed state (Jupiter: one batch in flight; HLD §13). The server rebases over `over` = the committed ops in (`baseRev`, head]. If `baseRev` > head → `resync('inconsistent')`. If ops after `baseRev` are no longer retained → `resync('history-unavailable')`. Both are followed by a full load, and the envelope is not applied. |
| R5 | **`ack.rev`:** `fromRev + applied`, where `fromRev` is the head when the batch was processed. If every op was dropped, `ack.rev` is the head and no `remote` is sent. |
| R6 | **`ack.committed`:** the applied ops, as stored, when `over` was non-empty **or** at least one op was dropped (LLD choice, CL-6). It is omitted otherwise. |
| R7 | **`remote.fromRev`** is the head before the batch. A client applies a `remote` only when `fromRev` equals its confirmed rev. A mismatch means it missed messages: it reconnects without `resume` (Part 3). |
| R8 | **`clientId`** is created once per `mount()` with `newClientId()`. It survives reconnects and resyncs within that mount and is never reused. The server binds it at `hello` (§5.2). |
| R9 | **`clientSeq`** is an integer ≥ 1. It starts at 1 for each `clientId` and goes up by 1 for each **new** envelope. A re-sent envelope (after `QUEUE_FULL`, a reconnect or a resync) keeps its `clientSeq`. Its `epoch`, `baseRev` and `ops` may be refreshed. |
| R10 | **Dedupe (CL-12):** per document, the server keeps `lastSeq[clientId]` and `lastRev[clientId]`. They are updated when the batch's journal write resolves, are persisted through the journal, and survive epoch changes. An envelope with `clientSeq ≤ lastSeq` is a duplicate: it is not applied, and the server answers `ack { clientSeq, rev: lastRev }` without `committed`. A client ignores an ack for a `clientSeq` it does not have in flight. Gaps are allowed: rejected envelopes are not recorded. |
| R11 | **Resume:** `hello.resume.epoch` equals the current epoch and `resume.rev` is within retained history → there is no load. The server sends, in rev order, one message for each batch committed after `resume.rev`: an `ack { clientSeq, rev, committed }` when `batch.clientId == hello.clientId`, otherwise a `remote`. Live traffic follows. Otherwise the server sends `resync` (`'epoch-changed'` or `'history-unavailable'`) and a full load on the same connection. The client re-sends its in-flight envelope right after `hello`; R10 makes this safe. |
| R12 | **Full load:** `load-start.rev` is the snapshot's rev N. `ackedClientSeq` is `lastSeq[hello.clientId]` when it exists. The client discards pending envelopes with `clientSeq ≤ ackedClientSeq`, because the snapshot already contains them. How the remaining pending envelopes are rebased onto a snapshot from a **new epoch** is §10 Q2. |
| R13 | A `submit` whose `epoch` is not the current one → `resync('epoch-changed')` and a full load. The envelope is not applied. |

---

## 7. `ot` [V1]

**Responsibility:** the Strategy interface shared by both document kinds (HLD §7), plus the chunk types.

```ts
export interface ChunkLimits { textBlocks: number; sheetRows: number; maxBytes: number }
export const DEFAULT_CHUNK_LIMITS: ChunkLimits;            // { textBlocks: 200, sheetRows: 500, maxBytes: 262144 } (HLD §12)
export interface Chunk { seq: number; data: TextChunkData | SheetChunkData }
export interface OtType<S, O> {
  kind: 'text' | 'sheet';
  apply(s: S, ops: O[]): { snapshot: S; applied: O[]; dropped: number };
  rebase(ops: O[], over: O[]): O[];
  validateOps(ops: unknown): O[];
  serializeSnapshot(s: S): unknown;
  deserializeSnapshot(j: unknown): S;
  chunk(s: S, limits: ChunkLimits): Chunk[];
  assemble(chunks: Chunk[]): S;
}
```

**Laws** every implementation must satisfy:
- **L1:** `apply(s, [])` returns `s` unchanged with `dropped: 0`.
- **L2:** `applied.length + dropped == ops.length`.
- **L3:** `rebase(ops, []) ≡ ops` and `rebase([], over) ≡ []`.
- **L4:** `deserializeSnapshot(serializeSnapshot(s)) ≡ s`.
- **L5:** `assemble(chunk(s, l)) ≡ s` for every `l`.
- **L6:** chunk `seq` values are 0…n-1. Each chunk is ≤ `maxBytes` (measured as `utf8Length(JSON.stringify(data))`), except a chunk holding one indivisible unit (one top-level block or one sheet row) that is larger by itself (LLD choice).
- **L7:** `validateOps` returns normalized ops. Unknown fields are stripped. It throws `PROTOCOL_OP_REJECTED`.
- **L8:** every method is deterministic and pure.

**Server path (Part 2):** `validateOps` → `rebase(ops, over)` → `apply(head, rebased)` → journal write → ack and broadcast.

**Tests:** `test/ot/laws.ts` exports `runOtLaws(type, fixtures)`. The text and sheet suites call it.

---

## 8. `text` [V1; anchors V5]

### 8.1 Schema (`text/schema.ts`)

```ts
export const textSchema: Schema<TextNodeName, TextMarkName>;
export type TextSnapshot = PMNode;                       // a prosemirror-model Node of textSchema, type 'doc'
export interface PageSettings { size: { width: number; height: number }; orientation: 'portrait' | 'landscape';
  margins: { top: number; right: number; bottom: number; left: number } }   // pt
export function getPageSettings(doc: TextSnapshot): PageSettings;
export function pageSettingStep(key: keyof PageSettings, value: PageSettings[keyof PageSettings]): DocAttrStep;
export function isAllowedHref(href: unknown): href is string;
```

**Document structure (CL-9):** `doc` → `header? body footer?`. There is one page style per document, held in doc attributes. Page settings change through `DocAttrStep`, one attribute at a time, so a concurrent change to `margins` and to `orientation` keeps both. The same attribute is last-writer-wins in FIFO order.

**Nodes.** Specs carry no `parseDOM` where one is not listed. Every `toDOM` attribute is built only from validated attribute values. ProseMirror's `DOMSerializer` sets attributes, never HTML.

| Node | Group | Content | Attributes (default; validation) | parseDOM | toDOM |
|---|---|---|---|---|---|
| `doc` | — | `header? body footer?` | `size` (required; width/height finite in [36, 4000]), `orientation` (required; enum), `margins` (required; each in [0, 1000]; left+right ≤ width−36; top+bottom ≤ height−36) | — | — |
| `header` / `footer` | — | `block+` | — (`isolating`) | — | `['header'\|'footer', {class:'odx-header'\|'odx-footer'}, 0]` |
| `body` | — | `(block \| page_break)+` | — (`isolating`) | — | `['div', {class:'odx-body'}, 0]` |
| `paragraph` | block | `inline*` | `align` ('left'; enum left\|center\|right\|justify) | `p` (text-align from style) | `['p', align≠left ? {style:'text-align: <align>'} : {}, 0]` |
| `heading` | block | `inline*` | `level` (1; int 1–6), `align` ('left'; enum) — `align` per §10 Q3 | `h1`…`h6` | `['h<level>', …, 0]` |
| `bullet_list` | block | `list_item+` | — | `ul` | `['ul', 0]` |
| `ordered_list` | block | `list_item+` | `order` (1; int 0–1 000 000) | `ol` (`start`) | `['ol', order≠1 ? {start} : {}, 0]` |
| `list_item` | — | `paragraph block*` | — (`defining`) | `li` | `['li', 0]` |
| `table`, `table_row`, `table_cell`, `table_header` | table: block | from `tableNodes({ tableGroup: 'block', cellContent: 'block+', cellAttributes: {} })` | `colspan`/`rowspan` (1; **tightened** to int 1–1000), `colwidth` (null; **tightened** to null or int[] with length = colspan, each 1–10 000 px) | prosemirror-tables | prosemirror-tables |
| `image` | block | atom, `draggable` | `assetId` (required; `isAssetId`), `alt` (''; string ≤ 1000), `width`/`height` (null; null or finite in [1, 10 000] pt) | `img[data-asset-id]` with valid `assetId`. Other `<img>` elements are ignored. | `['img', {'data-asset-id', alt, 'data-width'?, 'data-height'?}]` — **no `src`** (the view sets a blob URL, HLD §14) |
| `page_break` | — | atom | — | `div[data-page-break]` | `['div', {class:'odx-page-break','data-page-break':'true'}]` |
| `text` | inline | — | — | — | — |
| `hard_break` | inline | atom, `selectable: false` | — | `br` | `['br']` |
| `bookmark` [V5] | inline | atom | `id` (required; `/^[A-Za-z0-9_-]{1,64}$/`) | `span[data-bookmark-id]` | `['span', {'data-bookmark-id': id, class:'odx-bookmark'}]` |

- **Tightening table attributes:** `tableNodes()` returns plain specs, so `schema.ts` replaces `attrs.colspan.validate`, `attrs.rowspan.validate` and `attrs.colwidth.validate` before calling `new Schema` (LLD choice).
- **Why `page_break` is outside `block`:** it is only allowed in `body`, not in cells, lists or header/footer.
- **No `parseDOM` for `header`/`body`/`footer`:** pasted HTML can never create regions (LLD choice).

**Marks** (order = rank):

| Mark | Attributes | parseDOM | toDOM |
|---|---|---|---|
| `link` (`inclusive: false`) | `href` (required; `isAllowedHref`) | `a[href]`; `getAttrs` returns `false` when the href is not allowed (text kept, link dropped) | `['a', {href, rel:'noopener noreferrer nofollow'}, 0]` |
| `bold` | — | `strong`; `b` unless `font-weight: normal`; style `font-weight` bold\|bolder\|500–900 | `['strong', 0]` |
| `italic` | — | `em`, `i`, style `font-style=italic` | `['em', 0]` |
| `underline` | — | `u`, style `text-decoration` containing `underline` | `['u', 0]` |
| `strike` | — | `s`, `del`, `strike`, style `text-decoration` containing `line-through` | `['s', 0]` |
| `text_style` | `fontFamily` (null; `/^[\p{L}\p{N} _.\-()&+]{1,64}$/u`), `fontSize` (null; finite pt in [1, 1638]), `color` (null; `/^#[0-9a-f]{6}$/`) | `span[style]`: reads font-family (first family, quotes stripped), font-size (px→pt ×0.75, pt kept), color (`rgb()`→hex). Invalid properties are skipped. No valid property → `false`. | `['span', {style: css}, 0]` with `font-family: "<f>"; font-size: <n>pt; color: <c>` for non-null values |
| `annotation` [V5] (`inclusive: false`, `excludes: ''`) | `id` (required; same regex as bookmark) | `span[data-annotation-id]` | `['span', {'data-annotation-id': id, class:'odx-annotation'}, 0]` |

**Link allowlist (`text/href.ts`):** `isAllowedHref(h)` is true only when:
- `h` is a string of 1–2048 characters with no whitespace or C0/C1 control characters;
- `new URL(h)` parses (absolute URLs only; relative links are rejected; LLD choice);
- `protocol` ∈ {`http:`, `https:`, `mailto:`}.

The string is stored as given. The test table covers `javascript:`, `JaVaScRiPt:`, `java\nscript:`, `data:`, `vbscript:`, `//evil`, a 2049-character href, and `mailto:`.

**Schema evolution:** node and mark types and attributes are only ever added, and every new attribute has a default. The V5 additions follow this rule, so V1–V4 snapshots and journals parse unchanged.

### 8.2 Text ops (`text/steps.ts`)

```ts
export type TextStepType = 'replace' | 'replaceAround' | 'addMark' | 'removeMark' | 'markSet' | 'addNodeMark' | 'removeNodeMark' | 'attr' | 'docAttr';
export type TextOp = { stepType: TextStepType } & Record<string, unknown>;   // Step.toJSON() output
export function parseTextOps(ops: readonly TextOp[]): Step[];                // Step.fromJSON(textSchema, j)
export function textOpsEqual(a: readonly TextOp[], b: readonly TextOp[]): boolean;   // same length && canonicalJson equal pairwise
```

`TextOtType.validateOps(x)`:

```
if !Array.isArray(x) or x.length == 0 → reject
for j in x:
  require plainObject(j) and j.stepType ∈ TextStepType            // allowlist = every id prosemirror-transform registers
  require each present field of {from,to,gapFrom,gapTo,insert,pos} is a safe integer ≥ 0
  if j.stepType in {attr, docAttr}: require typeof j.attr == 'string'
     and j.attr ∈ (attr ? union of all node attribute names in textSchema : {'size','orientation','margins'})
  step = try Step.fromJSON(textSchema, j) catch → reject      // unknown node/mark types and attribute validators throw here
  out.push(step.toJSON())                                      // normalized: unknown fields dropped
on any reject: throw OpenDocexError('PROTOCOL_OP_REJECTED')
```

- **What `validateOps` does not check:** content validity, attribute values set by `attr` steps, and positions. These need the document and are checked in `apply`.

### 8.3 `rebaseSteps`: mapping-only rebase (`text/rebase.ts`)

```ts
export function rebaseSteps(steps: readonly Step[], over: readonly Step[]): Step[];
export function rebaseOverMaps(steps: readonly Step[], overMaps: readonly StepMap[]): Step[];   // internal; over → over.map(s => s.getMap())
// Added during LLD reconciliation (LLD §0 R-6). Used by the server's DocumentInstance and the client's TextSyncClient.
export function rebaseStepsOnDoc(steps: readonly Step[], over: readonly Step[], doc: Node):
  { steps: Step[]; kept: number[]; doc: Node };
```

`rebaseStepsOnDoc` = `rebaseOverMaps` with index tracking, then the `applyStepsWithDrop` semantics (§8.4) on `doc`. A step that fails is dropped, and so are its dependents.
- `steps`: the surviving rebased steps.
- `kept[j]`: the index in the input `steps` of `steps[j]`.
- `doc`: `doc` with the surviving steps applied.

Server and client both call it with the same inputs, so they produce the same output.

```
rebaseOverMaps(steps, overMaps):
  n = steps.length; mapping = new Mapping()
  for i = n-1 down to 0: mapping.appendMap(steps[i].getMap().invert())   // steps[i]⁻¹ sits at index n-1-i
  for m in overMaps:     mapping.appendMap(m)
  out = []
  for i = 0 .. n-1:
    mapped = steps[i].map(mapping.slice(n - i))     // skips the inverses of steps[i..n-1]
    if mapped:
      mapping.appendMap(mapped.getMap(), n - 1 - i) // mirror of steps[i]⁻¹ → content of earlier own steps is recovered
      out.push(mapped)
  return out
```

- **Purity:** it uses only `getMap`, `StepMap.invert`, `Step.map`, `Mapping.slice` and `Mapping.appendMap` (all verified, §0). It needs no document, so the server and every client compute **the same** result from the same `(steps, over)`.
- **How it differs from prosemirror-collab:** collab's `rebaseSteps` sets a mirror only for steps that applied. Here a mirror is set for every non-null mapped step, and failures are handled by `applyStepsWithDrop`.
- **Prefix consistency:** for any `A`, `B`, `R`, `rebaseSteps([...A, ...B], R)` starts with `rebaseSteps(A, R)`. B's inverses come first in the mapping and are excluded by `slice`. This is what lets a client rebase in-flight and buffered steps together while the server rebases only the in-flight batch.
- **`MAP_BIAS`:** shared never changes `ReplaceStep.MAP_BIAS`. A unit test asserts it is `1`. The adopter docs (Part 3) say it must not be changed, because it would alter tie order. Even so, the `committed` echo (R6) restores convergence.
- **Deterministic tie (BRD §3 "cat" example):** two inserts at the same position end with the FIFO-earlier text first. With bias 1, the later insert maps after the earlier one.

### 8.4 Apply with drop (`text/apply.ts`)

```ts
export function applyStepsWithDrop(tr: Transform, steps: readonly Step[]): { applied: Step[]; dropped: number };
```

```
applyStepsWithDrop(tr, steps):
  queue = steps.slice(); applied = []; dropped = 0
  while queue not empty:
    s = queue.shift()
    ok = false
    try:
      r = s.apply(tr.doc)                                   // may throw (RangeError), see §0
      ok = !r.failed && touchedValid(r.doc, s)
    catch: ok = false
    if ok: tr.step(s); applied.push(s)                      // re-apply via tr so mapping/selection track it
    else:
      dropped += 1
      before = queue.length
      queue = rebaseOverMaps(queue, [s.getMap().invert()])  // later steps were positioned as if s had applied
      dropped += before - queue.length                      // dependents mapped to null (e.g. typing inside a dropped insert)
  return { applied, dropped }

touchedValid(doc, s):                                       // replace's own check skips inner nodes of an inserted slice
  if s is DocAttrStep: return true                          // attribute validators already ran in NodeType.create
  ranges = s is AttrStep|AddNodeMarkStep|RemoveNodeMarkStep ? [[s.pos, s.pos + doc.nodeAt(s.pos).nodeSize]]
           : ranges from s.getMap().forEach((_, _, newFrom, newTo) => …)
  doc.type.checkContent-equivalent: require doc.type.validContent(doc.content)
  for [a, b] in ranges:
    doc.nodesBetween(max(0, a-1), min(doc.content.size, b+1), node => { shallowCheck(node); return true })
  shallowCheck(node) = node.type.validContent(node.content) && every attribute validator passes
                       && node.marks are allowed and form a valid set           // else throw → step failed
```

- **Cost:** proportional to the nodes that intersect the change. Ancestors are checked shallowly, so a keystroke in a big table checks the table's row list, not every cell.
- **Server use:** `tr = new Transform(head)`, then `head' = tr.doc`.
- **Client use:** call it on the `Transaction` that already inverted the pending steps and applied the remote steps (Part 3), so selection and cursor map through it (HLD §13).

### 8.5 TextOtType (`text/ot-type.ts`)

```ts
export const TextOtType: OtType<TextSnapshot, TextOp>;
```

| Method | Behaviour |
|---|---|
| `kind` | `'text'` |
| `apply(doc, ops)` | `tr = new Transform(doc)`; `applyStepsWithDrop(tr, parseTextOps(ops))` → `{ snapshot: tr.doc, applied: applied.map(s => s.toJSON()), dropped }` |
| `rebase(ops, over)` | `rebaseSteps(parseTextOps(ops), parseTextOps(over)).map(toJSON)`. The server may keep `over` parsed and call `rebaseSteps` directly. |
| `validateOps` | §8.2 |
| `serializeSnapshot(doc)` | `doc.toJSON()` |
| `deserializeSnapshot(j)` | `Node.fromJSON(textSchema, j)`, `doc.check()`, and a check that the root is `doc`. A failure throws `DOCUMENT_FAULTED` (corrupt local snapshot). |
| `chunk(doc, l)` | §8.7 |
| `assemble(chunks)` | §8.7. A failure throws `PROTOCOL_INVALID_MESSAGE`. |

### 8.6 The `committed` echo comparison [V1]

When an `ack` carries `committed`, the client compares it with the JSON of its in-flight steps **as currently held** (after its own local rebases), using `textOpsEqual(committed, inflight.map(toJSON))`. Equal: nothing to do. Different: the client treats `committed` as the authoritative replacement for its in-flight steps. It inverts the local in-flight steps, applies `committed`, and re-applies its buffered steps via `rebaseSteps(buffered, committed)` plus `applyStepsWithDrop` (Part 3 owns the transaction).

The local and server results can differ for three reasons, which is why the echo exists (CL-6):
1. Repeated incremental local rebases are not guaranteed to equal one server rebase over the same total `over`.
2. A step dropped on one side.
3. Different ProseMirror patch versions.

### 8.7 Chunking and assembly

```ts
export type TextChunkData =
  | { kind: 'text'; part: 'doc'; page: PageSettings; header: boolean; footer: boolean }
  | { kind: 'text'; part: 'blocks'; region: 'header' | 'body' | 'footer'; blocks: unknown[] };   // node JSON of top-level blocks
```

```
chunk(doc, l):
  out = [{ seq: 0, data: { kind:'text', part:'doc', page: getPageSettings(doc), header: hasHeader, footer: hasFooter } }]
  for region in [header?, body, footer?]:
    cur = []; bytes = 0
    for block in region.content:
      j = block.toJSON(); b = utf8Length(JSON.stringify(j))
      if cur.length > 0 and (cur.length == l.textBlocks or bytes + b > l.maxBytes): emit(region, cur); cur = []; bytes = 0
      cur.push(j); bytes += b
    emit(region, cur)                                    // regions are non-empty by schema
assemble(chunks):
  require chunks[i].seq == i for all i; chunks[0].data.part == 'doc'
  require region order header* → body+ → footer*, and header/footer presence matches chunk 0
  json = { type:'doc', attrs: page, content: [ header?{content: concat}, body{…}, footer?{…} ] }
  doc = Node.fromJSON(textSchema, json); doc.check(); return doc
```

### 8.8 Errors, concurrency and tests

- **Errors:** `PROTOCOL_OP_REJECTED` (validateOps), `PROTOCOL_INVALID_MESSAGE` (assemble), `DOCUMENT_FAULTED` (deserializeSnapshot). `apply` never throws for a bad step; it drops it.
- **Ordering:** `rebase` and `apply` must receive `over` and `ops` in FIFO/rev order. They are pure. Determinism also depends on identical ProseMirror versions; otherwise the echo corrects the result.

**Tests:**
- **Schema (jsdom):**
  - parse/serialize round trip for every node and mark;
  - XSS cases: href table; CSS injection through `fontFamily` (`a;background:url(x)`) rejected; `<img src=…>` without `data-asset-id` ignored;
  - attribute validators: colspan 0, 1.5, NaN and 1001 rejected; page margins over the limit rejected.
- **`rebaseSteps` fixed scenarios:**
  - the BRD "cat" case, with both inserts kept and FIFO-earlier first;
  - insert inside a concurrently deleted range (dropped);
  - overlapping deletes;
  - addMark vs delete;
  - split paragraph vs typing at the split point;
  - edits in different table cells;
  - an `attr` step on a deleted node (dropped);
  - concurrent `docAttr` on the same key (later wins);
  - header vs body edits;
  - prefix-consistency property on the fixtures.
- **Server/client equivalence (spike S5):**
  - Enumerate every pair of single-step edits from a fixed finite set over a fixed three-block document: insert one char at each position, delete each 1–2 width range, addMark over each range, split at each position.
  - For each pair, simulate the server (rebase + apply-with-drop on the head), client A, and client B (invert pending, apply remote, rebase, apply-with-drop, echo correction).
  - Assert all three documents are equal and `committed` JSON is equal.
  - The enumeration is deterministic. Randomized fuzzing is B10 (V6).
- **`applyStepsWithDrop`:**
  - L2 invariant;
  - out-of-range positions and crafted invalid slices (a table inside a paragraph, a disallowed mark) are dropped without throwing;
  - dependents of a dropped insert are dropped;
  - `MAP_BIAS === 1`.
- **`validateOps`:** unknown stepType, negative or float positions, unknown node or mark types, unknown `docAttr` key, extra fields stripped.
- **Chunk/assemble:**
  - L5 with and without header/footer, at 1, 200 and 201 blocks;
  - a block larger than 256 KiB gets its own chunk;
  - a seq gap is rejected;
  - a missing `doc` part is rejected.

---

## 9. `sheet` [V2]

### 9.1 Model (`sheet/model.ts`)

```ts
export type CellErrorCode = '#NULL!' | '#DIV/0!' | '#VALUE!' | '#REF!' | '#NAME?' | '#NUM!' | '#N/A';
export type CellValue = number | string | boolean | { e: CellErrorCode };
export interface Cell { v?: CellValue; f?: string; s?: string }      // f: A1 formula WITHOUT leading '=' (LLD choice); s: style id
export interface RangeRect { r0: number; c0: number; r1: number; c1: number }   // inclusive, normalized r0≤r1, c0≤c1
export interface Sheet {
  id: string; name: string; order: string;                 // order: fractional sort key (LLD choice, §9.6)
  rowCount: number; colCount: number;
  cells: Record<string, Record<string, Cell>>;             // row → col → cell; decimal keys; null-prototype in memory
  merges: RangeRect[];
  colWidths: Record<string, number>; rowHeights: Record<string, number>;   // pt; absent = editor default (Part 3)
  frozen: { rows: number; cols: number };
}
export interface Workbook { sheets: Sheet[]; styles: Record<string, Style> }   // sheets sorted by (order, id)
export type BorderStyle = 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double';
export interface Style {
  font?: { family?: string; size?: number; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; color?: string };
  fill?: { color: string };
  border?: Partial<Record<'top' | 'right' | 'bottom' | 'left', { style: BorderStyle; color: string }>>;
  align?: { h?: 'left' | 'center' | 'right' | 'justify'; v?: 'top' | 'middle' | 'bottom'; wrap?: boolean };
  numFmt?: string;                                        // format code; needed to show cached dates and numbers (PO-15)
}
export function supersededValues(wb: Workbook, op: Extract<SheetOp, { type: 'setCells' }>):
  Array<{ sheetId: string; r: number; c: number; before: Cell | null }>;   // audit helper (HLD §7 Audit, §6)
```

- **Styles are immutable (LLD choice):** a style ID is `newRandomId()`. Changing a format means defining a new style and setting `s`.
- **Style set:** the set of properties is the contract between the codec (S2) and the Univer bridge (S1). Either spike may only remove properties, and only through this document.

### 9.2 Ops (`sheet/ops.ts`)

```ts
export interface CellPatch { r: number; c: number; v?: CellValue | null; f?: string | null; s?: string | null }  // absent = unchanged, null = clear
export type SheetOp =
  | { type: 'setCells'; sheetId: string; cells: CellPatch[] }
  | { type: 'insertRows' | 'deleteRows' | 'insertCols' | 'deleteCols'; sheetId: string; sheetName: string; at: number; count: number }
  | { type: 'addSheet'; sheet: { id: string; name: string; order: string; rowCount: number; colCount: number } }
  | { type: 'removeSheet'; sheetId: string; name: string }
  | { type: 'renameSheet'; sheetId: string; name: string; prevName: string }
  | { type: 'moveSheet'; sheetId: string; order: string }
  | { type: 'mergeCells'; sheetId: string; range: RangeRect }
  | { type: 'unmergeCells'; sheetId: string; ranges: RangeRect[] }          // exact existing merges to remove
  | { type: 'setColWidth'; sheetId: string; col: number; width: number | null }
  | { type: 'setRowHeight'; sheetId: string; row: number; height: number | null }
  | { type: 'setFrozen'; sheetId: string; rows: number; cols: number }
  | { type: 'defineStyle'; styleId: string; style: Style };
```

- **Why some ops carry sheet names:** `sheetName`, `name` and `prevName` hold the sheet's name in the op's base state. Formula rewriting in a stateless transform needs them. In `apply`, the current name from state is authoritative.
- **Why field-level patches:** the same-cell rule applies per field (§10 Q6).

### 9.3 Validation limits (`sheet/validate.ts`)

These are format-validity limits, not per-user change limits (B9 is V6).

| Item | Limit (LLD choice; from xlsx/ODF limits) |
|---|---|
| Rows / columns per sheet | 1 ≤ rowCount ≤ 1 048 576; 1 ≤ colCount ≤ 16 384 |
| Sheet name | 1–31 characters; none of `\ / ? * [ ] :`; not starting or ending with `'`. Uniqueness is case-insensitive (`toUpperCase`). |
| Formula `f` | ≤ 8192 characters, no leading `=` |
| String value | ≤ 32 767 characters; numbers finite |
| IDs | sheetId, styleId: `/^[A-Za-z0-9_-]{1,64}$/`; order key `/^[0-9A-Za-z]{1,64}$/` |
| Style | colours `#rrggbb`; font size 1–409; family as text_style (§8.1); numFmt ≤ 255 characters |
| Dimensions | width 0–2000 pt; height 0–409 pt; frozen rows ≤ rowCount, cols ≤ colCount |
| Counts | `at`, `count`, `r`, `c` are safe integers; count ≥ 1; a range is ≥ 2 cells for `mergeCells` |

`validateOps` checks each op's shape against these limits, without state, and throws `PROTOCOL_OP_REJECTED`. `validateWorkbook(j)` deep-checks a snapshot and rebuilds null-prototype dictionaries. It is used by `deserializeSnapshot` and `assemble`.

### 9.4 Apply (`sheet/apply.ts`)

- **Atomicity and sharing:** each op applies fully or is dropped. Updates are copy-on-write (sheet → row maps), so the input stays untouched.
- **Drop conditions:**
  - unknown `sheetId`;
  - out-of-bounds indices or patches;
  - an unknown style ID in a patch;
  - `rowCount + count > MAX` (or the column equivalent);
  - a delete that would leave 0 rows or columns;
  - `removeSheet` of the last sheet;
  - `mergeCells` that intersects an existing merge;
  - a duplicate `addSheet` ID.
- **Name collisions:** apply does **not** drop on a name collision; see §9.5 NC.

| Op | Effect |
|---|---|
| setCells | Per patch and field: `null` deletes the field, a value sets it. A cell with no fields is removed. |
| insertRows(at, n) | Shift cells, `rowHeights` and merges (rangeInsert) for rows ≥ at. Frozen rows += n when at < frozen.rows. rowCount += n. Every formula in every sheet → `shiftFormulaReferences(f, {kind:'insertRows', at, count: n}, {sheetName: S.name, sameSheet: host.id == S.id})`. |
| deleteRows(at, n) | Remove cells and heights in [at, at+n) and shift the rest. Merges → rangeDelete; collapsed or 1×1 merges are removed. Frozen rows -= overlap. Formulas rewritten as above. |
| insertCols / deleteCols | Column equivalents |
| addSheet | Insert, then sort by `(order, id)` |
| removeSheet | Remove. Formulas in other sheets: `{kind:'removeSheet'}` with target S.name. |
| renameSheet | Set the name. Formulas in all sheets: `{kind:'renameSheet', newName}` with target = the current name. |
| moveSheet | Set `order` and re-sort |
| mergeCells | Add the range |
| unmergeCells | Remove merges exactly equal to a listed range. Missing ones are ignored. |
| setColWidth / setRowHeight | Set the key, or delete it for `null` |
| setFrozen | Set |
| defineStyle | `styles[styleId] = style` |

- **Cost:** O(patches) for `setCells`. A structural op is O(cells of the sheet + formula cells of the workbook).

### 9.5 Transform (`sheet/transform.ts`)

```ts
export type Side = 'later' | 'earlier';      // a's FIFO position relative to b
export function transformSheetOp(a: SheetOp, b: SheetOp, side: Side): SheetOp[];   // a rebased to apply after b
export function xformSheetOps(A: SheetOp[], B: SheetOp[]): [SheetOp[], SheetOp[]]; // A later than B; both based on one state
```

**Required property (TP1):** for a state S, an op `a` (later) and an op `b` (earlier), these two must be equal:
- `apply(apply(S, [b]), transformSheetOp(a, b, 'later'))`
- `apply(apply(S, [a]), transformSheetOp(b, a, 'earlier'))`

**Rules:**

| Id | Rule |
|---|---|
| = | Unchanged: `[a]` |
| X | `b` removes `a`'s sheet → `[]`. If `a` is setCells on another sheet: rule F. |
| LW | Same target (same cell field set by both, same col, same row, same sheet's frozen, order, name or style ID): `a` later → `[a]` (renameSheet: `prevName := b.name`); `a` earlier → `[]` (setCells: remove the shared fields; patches left with no fields are removed; empty → `[]`) |
| SC | setCells vs setCells, same sheet: LW per (r, c, field) |
| P | Index mapping on the same sheet and axis. Insert(at, n): i ≥ at → i+n. Delete(at, n): i in [at, at+n) → deleted; i ≥ at+n → i−n. Patch, col, row: deleted → removed or `[]`. Ranges: rangeInsert (r0' = r0≥at ? r0+n : r0; r1' = r1≥at ? r1+n : r1) and rangeDelete (§9.7 rule). A collapsed or 1×1 merge → removed. |
| F | Rewrite each patch's `f` via `shiftFormulaReferences(f, change(b), {sheetName: b.sheetName \| b.name \| b.prevName, sameSheet: a.sheetId == b.sheetId})`, where `change` is the insert/delete, `removeSheet` or `renameSheet{newName: b.name}` |
| II | insert vs insert, same sheet and axis: `a.at > b.at \|\| (a.at == b.at && side=='later')` → `a.at += b.count` |
| ID | insert `a` vs delete `b`: `a.at ≤ b.at` → =; `a.at ≥ b.at+b.count` → `a.at −= b.count`; otherwise `a.at = b.at` |
| DI | delete `a` (s, n) vs insert `b` (p, m): `p ≤ s` → `a.at = s+m`; `p ≥ s+n` → =; otherwise split into `[delete(s, p−s), delete(s+m, n−(p−s))]` (keeps the inserted rows) |
| DD | delete vs delete: `start' = s1<s2 ? s1 : (s1≥e2 ? s1−n2 : s2)`; `count' = n1 − overlap`; `count' == 0` → `[]` |
| N | `b` renames sheet X → `a`'s `sheetName`, `name` or `prevName` that refers to X becomes `b.name` |
| NC | Different sheets end up with the same name (case-insensitive) through addSheet or renameSheet: `a` later → `a`'s name := `disambiguate(name)` = `name` cut to 27 characters + `" (2)"`; `a` earlier → `[renameSheet{sheetId: b's sheet, name: disambiguate(name), prevName: name}, a]` |
| MO | merge vs merge, intersecting: `a` later → `[unmergeCells{ranges:[b.range]}, a]`; `a` earlier → `[]` |
| UM | unmerge `a` vs merge `b`: remove from `a.ranges` every range intersecting `b.range`; empty → `[]` |
| FR | setFrozen vs insert/delete on its axis: rows' = at < rows ? rows+n (insert) or rows − overlap([at, at+n), [0, rows)) (delete) |

**Matrix** (row = `a` being transformed, column = `b`; both rules apply only when they concern the same sheet, unless noted):

| a \ b | setCells | ins/del Rows | ins/del Cols | addSheet | removeSheet | renameSheet | moveSheet | merge | unmerge | colW / rowH | frozen | defineStyle |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| setCells | SC | P (rows) + F (any sheet) | P (cols) + F (any sheet) | = | X / F | F | = | = | = | = | = | = |
| insertRows | = | II / ID | = | = | X | N | = | = | = | = | = | = |
| deleteRows | = | DI / DD | = | = | X | N | = | = | = | = | = | = |
| insertCols | = | = | II / ID | = | X | N | = | = | = | = | = | = |
| deleteCols | = | = | DI / DD | = | X | N | = | = | = | = | = | = |
| addSheet | = | = | = | NC | = | NC | = | = | = | = | = | = |
| removeSheet | = | = | = | = | same sheet → `[]` | N | = | = | = | = | = | = |
| renameSheet | = | = | = | NC | X | same sheet LW; else NC | = | = | = | = | = | = |
| moveSheet | = | = | = | = | X | = | same sheet LW | = | = | = | = | = |
| mergeCells | = | P (range) | P (range) | = | X | = | = | MO | = | = | = | = |
| unmergeCells | = | P (each range) | P (each range) | = | X | = | = | UM | = | = | = | = |
| setColWidth | = | = | P (col) | = | X | = | = | = | = | same col LW | = | = |
| setRowHeight | = | P (row) | = | = | X | = | = | = | = | same row LW | = | = |
| setFrozen | = | FR | FR | = | X | = | = | = | = | = | LW | = |
| defineStyle | = | = | = | = | = | = | = | = | = | = | = | same ID LW |

**Lists:**

```
xformSheetOps(A, B):                      // A later
  if A empty or B empty: return [A, B]
  if |A| == 1 and |B| == 1: return [transformSheetOp(A0, B0, 'later'), transformSheetOp(B0, A0, 'earlier')]
  if |A| > 1: [a1', B1] = xform([A0], B); [rest', B2] = xform(A[1:], B1); return [a1' ++ rest', B2]
  else:       [A1, b1'] = xform(A, [B0]); [A2, restB'] = xform(A1, B[1:]); return [A2, b1' ++ restB']
```

This terminates because a single transform yields at most 2 ops (DI, MO, NC).

**Known corners:**
- **State-dependent drops can break TP1:** examples are row overflow and two concurrent `removeSheet`s that would leave no sheet. The server result is authoritative and is echoed in `committed`. A client whose `apply` reports `dropped > 0` for a `remote` op requests a reload (Part 3).
- **Name collisions:** NC can still collide with an existing `"X (2)"`. Duplicate names are then tolerated in the model; formulas resolve to the first sheet in order, and the codec makes names unique on export (LLD choice).

### 9.6 SheetOtType (`sheet/ot-type.ts`) and sheet order keys

```ts
export const SheetOtType: OtType<Workbook, SheetOp> & {
  transform(remote: SheetOp[], pending: SheetOp[]): { remote: SheetOp[]; pending: SheetOp[] };   // client (HLD §13)
};
export function orderKeyBetween(a: string | null, b: string | null): string;   // a < key < b in code-unit order
```

| Method | Behaviour |
|---|---|
| `apply` | §9.4, op by op in order |
| `rebase(ops, over)` | `xformSheetOps(ops, over)[0]` (`ops` are later) |
| `transform(remote, pending)` | `[p', r'] = xformSheetOps(pending, remote)` → `{ remote: r', pending: p' }` (`pending` is later, because the server has not committed it yet) |
| `validateOps` | §9.3 |
| `serializeSnapshot` / `deserializeSnapshot` | identity (JSON-safe) / `validateWorkbook` (throws `DOCUMENT_FAULTED`) |
| `chunk` / `assemble` | §9.8 |

- **Why `Sheet.order`:** sheet order is a fractional key, so `moveSheet` and `addSheet` are plain property writes, and TP1 holds without list-move transforms.
- **Key format:** base-62 digits `0-9A-Za-z`. Keys never end in `0`. Ties between equal keys are broken by sheet `id`.
- **`orderKeyBetween`:** walks the digits of `a` and `b` and returns the shortest string strictly between them (midpoint digit, extending with a digit when they are adjacent). `null` means unbounded.
- **Import:** the codec assigns keys in file order.

### 9.7 A1 references and `shiftFormulaReferences` (`sheet/a1.ts`, `sheet/shift.ts`)

```ts
export type FormulaChange =
  | { kind: 'insertRows' | 'deleteRows' | 'insertCols' | 'deleteCols'; at: number; count: number }
  | { kind: 'removeSheet' } | { kind: 'renameSheet'; newName: string };
export interface FormulaTarget { sheetName: string; sameSheet: boolean }
export function shiftFormulaReferences(formula: string, change: FormulaChange, target: FormulaTarget): string;
export function isShiftableFormula(formula: string): boolean;    // false = opaque (see below)
export function quoteSheetName(name: string): string;
```

**Grammar** (A1, comma separators as stored in OOXML; letters are case-insensitive):

```
formula    := { string | errorLit | ref | other-char }
string     := '"' { any-but-'"' | '""' } '"'                         (copied verbatim, never scanned)
errorLit   := '#NULL!' | '#DIV/0!' | '#VALUE!' | '#REF!' | '#NAME?' | '#NUM!' | '#N/A' | '#SPILL!' | '#CALC!'
ref        := [ prefix ] body
prefix     := ( quoted | bare ) '!'
quoted     := "'" { any-but-"'" | "''" } "'"
bare       := ( letter | '_' ) { letter | digit | '_' | '.' }       (letter includes non-ASCII letters)
body       := cell [ ':' cell ] | col ':' col | row ':' row | '#REF!'
cell       := [ '$' ] COL [ '$' ] ROW
col        := [ '$' ] COL          row := [ '$' ] ROW
COL        := 1–3 letters, value 1..16384 (A..XFD)      ROW := digits without leading zero, 1..1048576
```

**Token boundaries:**
- A `ref` starts only when the previous character is not one of `[A-Za-z0-9_.$']`.
- It must not be followed by one of `[A-Za-z0-9_.(!$]`. A following `(` makes it a function name, as in `LOG10(`.
- A prefix followed by a body that is not a ref (`Sheet1!MyName`) is copied as text.
- Names that look like refs but are out of range (`ABCD1`) are not refs.
- `R1C1` fails the boundary rule and is left unchanged.

**Opaque formulas.** The formula is returned unchanged, and `isShiftableFormula` returns `false`, if it contains any of these outside strings:
- `[` (structured or external references);
- a 3-D prefix `Name:Name!`.

Whether such cells should be flagged as unsupported is §10 Q7. Defined names are not in the model and are never shifted.

**Shift rules** (0-based `lo..hi` on the change's axis; a single cell has `lo == hi`; whole-column refs ignore row changes and whole-row refs ignore column changes):

```
refersToTarget = token.sheet == null ? target.sameSheet : upper(token.sheet) == upper(target.sheetName)
insert(at, n):  lo' = lo ≥ at ? lo+n : lo;  hi' = hi ≥ at ? hi+n : hi
                lo' > MAX−1 → DELETED;  hi' > MAX−1 → hi' = MAX−1                 (LLD choice)
delete(at, n):  lo ≥ at and hi < at+n → DELETED
                lo' = lo < at ? lo : (lo < at+n ? at : lo−n);  hi' = hi < at ? hi : (hi < at+n ? at−1 : hi−n)
DELETED       → prefix kept + '#REF!'      e.g. Sheet2!#REF!   (Excel form)
removeSheet   → qualified refs to the target → '#REF!' (whole token, prefix dropped; LLD choice)
renameSheet   → qualified refs to the target → quoteSheetName(newName) + '!' + body
```

- **Preserved:** `$` flags and the source text of unchanged tokens. Column letters are written in upper case.
- **Reversed ranges:** a range written in reverse (`A5:A1`) is normalized only when its values change.
- **Absolute references still shift:** `$` affects copying, not insertion or deletion. This matches Excel.
- **`quoteSheetName`:** returns the bare form when the name matches `bare`, is not a cell ref and is not `TRUE`/`FALSE`. Otherwise it wraps the name in `'…'` and doubles any inner `'`.

**Tests (table-driven):**
- Tokens: `A1`, `$A$1`, `A1:B2`, `A:C`, `$1:$3`, `'My ''Q'' Sheet'!B2`, `Sheet1!#REF!`, `"A1"` inside a string, `LOG10(2)`, `TRUE`, `R1C1`, `ABCD1`, `XFD1048576`, `XFE1`.
- Each shift rule: before, at, inside and after the change, and the whole range deleted.
- Rename quoting.
- `removeSheet`.
- Opaque detection.
- Idempotence of `#REF!`.

### 9.8 Chunking and assembly (row ranges)

```ts
export type SheetMeta = Omit<Sheet, 'cells'>;
export type SheetChunkData =
  | { kind: 'sheet'; part: 'workbook'; sheets: SheetMeta[] }
  | { kind: 'sheet'; part: 'styles'; styles: Record<string, Style> }
  | { kind: 'sheet'; part: 'rows'; sheetId: string; rows: Array<[row: number, cells: Array<[col: number, cell: Cell]>]> };
```

```
chunk(wb, l):
  seq 0 = workbook part (no cells)
  styles split into 'styles' chunks by maxBytes
  for sheet in order: walk populated rows ascending
    close the chunk when it has l.sheetRows populated rows or the next row would pass l.maxBytes
    (empty rows are skipped; LLD choice)
assemble(chunks): seq contiguous from 0; part 0 = workbook; every sheetId known; rows ascending per sheet,
                  no duplicates → validateWorkbook → Workbook
```

### 9.9 Errors, concurrency and tests

- **Errors:** `PROTOCOL_OP_REJECTED` (validateOps), `PROTOCOL_INVALID_MESSAGE` (assemble), `DOCUMENT_FAULTED` (deserializeSnapshot). `apply` drops invalid ops and never throws.
- **Ordering:** `over`, `ops` and `remote` arrive in rev or FIFO order. The functions are pure and deterministic.

**Tests:**
- **Transform:** one table test per matrix cell (concrete cases for every rule id).
- **TP1:** exhaustive enumeration over a 2-sheet, 5×5 workbook with formulas and merges, for every ordered pair from a fixed op generator: every op type × small index, count and range sets. Both sides are checked.
- **`xformSheetOps`:** multi-op batches (an `addSheet` followed by formulas that reference it under NC; DI splits followed by `setCells`).
- **`apply`:**
  - every drop condition;
  - formula rewriting in other sheets;
  - merge, frozen and dimension shifting;
  - `supersededValues`.
- **Laws (§7):** L1–L8.
- **`orderKeyBetween`:** the null bounds, adjacent keys, and 1000 sequential inserts at one point that stay ordered.
- **Chunking:** limits 500 rows and 256 KiB; a single oversize row; styles split.

---

## 10. Open questions for the project owner — resolved in LLD §0.1–§0.2

| # | Question | Default used in this LLD until decided |
|---|---|---|
| Q1 | HLD N5 allows MIT, BSD and Apache-2.0. The task brief also lists ISC. Is ISC allowed? And should dev-only dependencies (TypeScript and Playwright are Apache-2.0; some transitive dev tools are CC0, CC-BY or Python-2.0) fail the licence check, or only be reported? | ISC allowed. Production and peer trees fail on violations; dev-only dependencies are reported. |
| Q2 | After an **epoch change**, HLD §10.5 says pending ops are "kept and resubmitted". If other users' edits are in the new snapshot, those ops cannot be positioned without the intervening history. Options: (a) persist `rev` across loads (R2) and let the server replay retained journal ops for an old-epoch `resume`, falling back to (b) when they are trimmed; (b) the client keeps pending ops only if the new snapshot equals its confirmed state plus its acked ops, otherwise drops them and tells the user. | R2 persists `rev`, so (a) stays possible. Part 2 and Part 3 must pick one; the behaviour is visible to users (possible loss of unconfirmed typing). |
| Q3 | HLD §8.1 gives `paragraph` alignment but `heading` only levels. Should headings also have `align`? Without it, centred titles in imported files lose their centring or must be flagged unsupported. | `heading` has `align`. |
| Q4 | Which image types may be inserted? SVG is excluded for XSS. | PNG, JPEG, GIF |
| Q5 | **Upload [V4]:** CL-13 binds a WebSocket to a document. Which connection or URL carries an upload, and which `authorize` context does it use? | Not decided here. Messages are defined in §5.2. |
| Q6 | Same-cell rule granularity: does the "later wins" rule apply per field (value/formula vs style), or does a later edit replace the whole cell? | Per field, so a concurrent style change survives a value edit. |
| Q7 | Formulas with references the shifter cannot handle (3-D `Sheet1:Sheet3!A1`, structured `Table[Col]`, external `[1]Sheet!A1`): flag them as unsupported content on import, or accept that they are not shifted? | Not shifted (opaque); no flag. |
| Q8 | Rename and remove of a sheet: should formulas referring to it be rewritten (rename → new name; remove → `#REF!`)? This goes beyond PO-9, which covers rows and columns only. | Yes, as Excel and LibreOffice do. |
| Q9 | Bounds for adopter document IDs | 1–1024 characters, no control characters |
| Q10 | Browser support matrix for the client and E2E | CI runs Chromium only |
| Q11 | **Default page settings for new blank documents** (A4 or Letter, margins). The schema keeps page attributes required, with no hidden default. | Decided by the backend's blank-document creation (Part 2) once the PO chooses. |
| Q12 | **Annotations [V5]:** do bookmarks and notes also apply to spreadsheets (cell anchors)? HLD §19 lists only anchor marks/nodes. | Text only (`bookmark` node, `annotation` mark) |

---

## 11. New contract names — reconciled in LLD §0.3

| Name | Module | Purpose |
|---|---|---|
| `Epoch` (branded type), `newRandomId`, `asDocumentId`, `isClientId`, `isEpoch`, `isAssetId`, `Brand` | ids | Typed IDs and validation |
| `ErrorCategory`, `ErrorSeverity`, `OpenDocexErrorShape`, `CatalogueEntry`, `ClientErrorPayload`, `OpenDocexError.toShape` / `fromShape` / `is` | errors | IPC-safe error transport; sanitized client payload |
| `DocKind`, `Access`, `AssetMime`, `FileFormat`, `UnsupportedFeature`, `DecodeResult`, `isBinaryType`, `closeCodeFor` | protocol | Supporting types |
| `PingMsg`, `PongMsg` | protocol | Client heartbeat (HLD §13) |
| `LoadStartMsg.ackedClientSeq`, `ErrorMsg.reqId`, `ResyncMsg.reason`, `NoticeMsg` variants (`storage` / `read-only` / `engine-restarting`) | protocol | Fields not spelled out in HLD §9 |
| `UploadStartMsg`, `UploadChunkMsg`, `UploadEndMsg`, `UploadAckMsg`, `UploadDoneMsg` [V4]; `AnnotationListMsg`, `AnnotationPutMsg`, `AnnotationDeleteMsg`, `AnnotationResultMsg`, `AnnotationChangedMsg`, `Annotation`, `AnnotationInput` [V5] | protocol | The `upload-*` and `annotation-*` families |
| Binary frame layout (`0xD0`, version 1, u32 header length) and `CloseCode` values 4002–4008 | protocol | Framing and close semantics |
| `DEFAULT_CHUNK_LIMITS`, `TextChunkData`, `SheetChunkData`, `SheetMeta` | ot / text / sheet | Chunk payloads |
| `TextStepType`, `parseTextOps`, `textOpsEqual`, `applyStepsWithDrop`, `rebaseOverMaps`, `getPageSettings`, `pageSettingStep`, `isAllowedHref` | text | Rebase, apply and echo helpers |
| `bookmark` node and `annotation` mark [V5] | text | Annotation anchors |
| `CellPatch`, `CellValue`, `CellErrorCode`, `RangeRect`, `BorderStyle`, `Side`, `xformSheetOps`, `SheetOtType.transform`, `FormulaChange`, `FormulaTarget`, `isShiftableFormula`, `quoteSheetName`, `orderKeyBetween`, `supersededValues`, `validateWorkbook` | sheet | Sheet OT helpers |
| `Sheet.order` field; `sheetName` / `name` / `prevName` on structural ops | sheet | Model and op fields beyond HLD §8.2 |
| `canonicalJson`, `utf8Length` | util | Equality and size measurement |
| Export condition `@open-docex/source`; subpath exports `./protocol`, `./errors`, `./ids`, `./ot`, `./text`, `./sheet` | tooling | Test-time source resolution; main-process import surface |

---

# Part 2 — @open-docex/server (backend/)

**Scope:** every server-side item in HLD §6, §7, §10, §11, §12, §14, §15, §16 and §18. Shared types (protocol, errors, OT, models, IDs) come from Part 1 under their canonical names. Client behaviour belongs to Part 3.

**Conventions**
- `(LLD choice)` marks an implementation detail chosen here. Anything that changes behaviour adopters or end users can see is not decided here; it is listed in §22.
- Version tags follow HLD §19. **V1** applies wherever no tag is given. References look like (HLD §x) and [A5].
- Errors are always built with `engineError(code, details)` (§19.1), which fills category, retryable, severity and remediation from `ERROR_CATALOGUE[code]`.
- Time comes from an injectable `Clock` (`now()`, `setTimeout`, `clearTimeout`), so tests can use fake time. Real timers are `unref()`'d.
- Platform and dependencies:
  - Node ≥ 22.12 (CL-10); ESM-only; built with `tsc` (CL-15)
  - runtime dependencies, all MIT (N5): `ws`; `htmlparser2` as the XML parser (§14.4); `yauzl` for zip inspection (§14.8)
  - optional peer dependencies (V3): `redis` and `@confluentinc/kafka-javascript`, both MIT

---

## 1. Package layout and module map

```
backend/src/
  index.ts                         public exports only (§2)
  api/         create-engine.ts  engine-facade.ts  options.ts  validate-options.ts  events.ts  typed-emitter.ts
  log/         logger.ts  ipc-logger.ts
  gateway/     gateway.ts  upgrade.ts  session-table.ts  send-queue.ts
  supervisor/  supervisor.ts
  channel/     messages.ts  engine-channel.ts  ipc-engine-channel.ts  in-process-engine-channel.ts  wire-error.ts
  core/        core-entry.ts (child main)  core-runtime.ts  registry.ts  instance-factory.ts  document-instance.ts
               session-record.ts  dedupe-table.ts  op-history.ts  load-streamer.ts  kind-policy.ts
  queue/       queue-adapter.ts  memory-queue.ts  redis-streams-queue.ts (V3)  kafka-queue.ts (V3)
  persistence/ layout.ts  atomic-file.ts  journal.ts  snapshot-store.ts  meta-store.ts  asset-store.ts  data-dir-lock.ts
  storage/     storage-adapter.ts  local-fs-storage.ts  storage-router.ts
  flush/       flush-scheduler.ts
  recovery/    recovery-manager.ts
  codec/       codec-service.ts  codec-pool.ts  codec-thread.ts (worker_threads entry)  libreoffice-runner.ts  libreoffice-locate.ts
               lo-profile.ts  zip-guard.ts  xml-reader.ts  odf-units.ts  fodt-mapper.ts  fods-mapper.ts (V2)  odf-formula.ts (V2)
               unsupported-detector.ts
  audit/       audit-emitter.ts
  upload/      upload-service.ts (V4)
  annotation/  annotation-service.ts  annotation-store.ts (V5)
  errors/      engine-error.ts
backend/test-kit/  fakes and the storage conformance suite (§21)
```

| Module | Process | Version |
|---|---|---|
| Engine facade, Gateway, Supervisor, `IpcEngineChannel` (side A) | main | V1 |
| `CoreRuntime` and everything below it | Core (child process, or main in `mode: 'main'`) | V1 |
| `FodsMapper`, `odf-formula`, sheet kind policy | Core / codec thread | V2 |
| `RedisStreamsQueue`, `KafkaQueue`, epoch lineage acceptance (§8.6) | Core | V3 |
| `UploadService`, `onUploaded` hook | Core, plus a hook in main | V4 |
| `AnnotationService`, `AnnotationStore` | Core | V5 |

**Dependency direction:**
- `api` uses `gateway`, `supervisor` and `channel`.
- `core` uses `queue`, `persistence`, `storage`, `flush`, `recovery`, `codec` and `audit`.
- `codec`, `persistence` and `storage` never import `core`.

---

## 2. Public API (`index.ts`, `api/*`) — V1

### 2.1 Exports

```ts
export { createEngine, defineWorkerConfig, LocalFsStorage };
export { OpenDocexError } from '@open-docex/shared/errors';   // re-export: adopters need one import; the subpath keeps ProseMirror out of the main process (N4)
export type {
  EngineOptions, WorkerConfig, Engine, AuthorizeContext, AuthorizeResult, Session, Logger, LogLevel,
  StorageAdapter, StorageRef, StorageVersion, StorageStat, StorageReadResult, StorageWriteResult, StorageCreateInput,
  FileFormat, DocKind, EngineEventMap, AuditEvent, StorageEvent, EngineStateEvent, DocumentEvent,
  CreateDocumentInput, RecoveryEntry, RecoveryResolution, LocalCopy, SessionFilter, ShareInfo,
  AnnotationStore /* V5 */, UploadedContext /* V4 */ };
```

### 2.2 Main-process options (HLD §12)

```ts
type HttpServerLike = import('node:http').Server | import('node:https').Server;
type FileFormat = 'docx' | 'odt' | 'xlsx' | 'ods';      // PO-5
type DocKind = 'text' | 'sheet';                        // docx|odt → text; xlsx|ods → sheet
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface EngineOptions {
  mode?: 'worker' | 'main';                                  // 'worker' [§2]
  workerConfigModule: string | URL;                          // required (CL-2): absolute path or file: URL
  http?: { server?: HttpServerLike; path?: string };         // path '/open-docex'; no server → call engine.attach() later
  authorize(ctx: AuthorizeContext): AuthorizeResult | null | Promise<AuthorizeResult | null>;
  canSubmit?(session: Session): boolean | Promise<boolean>;
  supervisor?: SupervisorOptions;
  send?: { highWaterMarkBytes?: number };                    // 8 MiB (HLD §11.4)
  ws?: { maxPayloadBytes?: number;                           // 16 MiB (LLD choice; ws's own default is 100 MiB; the PO-4 benchmark revises it)
         pingIntervalMs?: number;                            // 30 000 (LLD choice: detects dead TCP connections)
         helloTimeoutMs?: number };                          // 30 000 (LLD choice)
  logger?: Logger;                                           // no-op (HLD §15)
  logLevel?: LogLevel;                                       // 'info' (LLD choice: the Core does not forward lower levels over IPC)
  onUploaded?(ctx: UploadedContext): Promise<{ documentId: DocumentId }>;   // V4 (HLD §10.6)
}
interface SupervisorOptions {
  heartbeatIntervalMs?: number; heartbeatTimeoutMs?: number; // 5 000 / 15 000
  backoffMs?: readonly number[];                             // [1000, 2000, 4000, 8000, 16000]
  maxRestarts?: number; restartWindowMs?: number;            // 5 / 600 000
  bootTimeoutMs?: number; shutdownTimeoutMs?: number;        // 60 000 / 10 000 (LLD choice)
}
interface AuthorizeContext {
  request: import('node:http').IncomingMessage;              // the upgrade request; the adopter reads its own cookie or token
  url: URL;                                                  // parsed request URL (LLD choice)
  documentId: DocumentId;                                    // from ?doc= (CL-13)
}
interface AuthorizeResult { userId: string; access: 'edit' | 'view'; document: { ref: StorageRef; format: FileFormat } }
interface Session {                                          // read-only view handed to canSubmit and sessions.close
  readonly id: string; readonly documentId: DocumentId; readonly userId: string;
  readonly access: 'edit' | 'view'; readonly openedAt: number;
}
```

How the Gateway treats the result of `authorize`:
- **`null`:** the upgrade is refused with HTTP 403 (interim, Q1).
- **A throw:** HTTP 500, plus an `error` event with code `ACCESS_DENIED`. The adopter's error goes in `cause`.
- **A malformed result:** HTTP 500, plus an `error` event with code `CONFIG_INVALID`, again with `cause`.

### 2.3 Worker config module (CL-2, HLD §12)

```ts
interface WorkerConfig {
  storage?: StorageAdapter;                 // absent → LocalFsStorage(<dataDir>/local-storage) is the primary storage [§4]
  dataDir?: string;                         // path.resolve(process.cwd(), 'open-docex-data') (CL-14)
  queue?: MemoryQueueConfig | RedisQueueConfig /* V3 */ | KafkaQueueConfig /* V3 */;
  journal?: { fsync?: 'interval' | 'always'; fsyncIntervalMs?: number };          // 'interval' / 1000
  snapshot?: { everyOps?: number };                                                // 500
  flush?: { quietMs?: number; maxIntervalMs?: number };                            // 30 000 / 300 000
  recovery?: { retryDelaysMs?: readonly [number, number, number] };                // [60 000, 300 000, 900 000] [A4]
  libreoffice?: { path?: string; maxConcurrent?: number; timeoutMs?: number };     // auto-detect / 2 / 120 000
  codecThreads?: number;                                                           // 1
  load?: { chunk?: { textBlocks?: number; sheetRows?: number; maxBytes?: number } }; // 200 / 500 / 262 144
  limits?: { maxFileBytes?: number };                                              // 52 428 800
  annotations?: { store: AnnotationStore };                                        // V5
}
interface MemoryQueueConfig { type: 'memory'; perDocument?: number; global?: number }   // 1000 / 50 000
function defineWorkerConfig(config: WorkerConfig): WorkerConfig;   // identity function: type inference plus a brand
```

The module must use `export default defineWorkerConfig({...})`.
- **Worker mode:** the Core imports the module with `await import(pathToFileURL(path).href)`. Main never imports it, so the adopter's worker code never runs in main (N4).
- **Main mode:** main imports the same module in-process.

### 2.4 Validation and defaults

`validateEngineOptions(o)` runs in main, synchronously, inside `createEngine`. The first failure throws `CONFIG_INVALID`, and the `remediation` names the field.

| Field | Rule |
|---|---|
| `mode` | `'worker'` or `'main'` |
| `workerConfigModule` | absolute path or file URL; readable (`fs.accessSync(R_OK)`) |
| `http.path` | starts with `/`; contains no `?` or `#` |
| `authorize` | a function |
| `canSubmit`, `onUploaded`, `logger.*` | functions, when present |
| `supervisor` | `heartbeatTimeoutMs > heartbeatIntervalMs > 0`; `backoffMs` is a non-empty list of integers ≥ 0; `maxRestarts ≥ 1`; `restartWindowMs > 0` |
| `send.highWaterMarkBytes` | ≥ 64 KiB |
| `ws.maxPayloadBytes` | between 64 KiB and 1 GiB |

`resolveWorkerConfig(raw)` runs in the Core at boot (§7). It also throws `CONFIG_INVALID`.

| Field | Rule |
|---|---|
| `storage` | when present: `read`, `write`, `stat` and `create` are functions |
| `dataDir` | a string; resolved against `cwd` |
| queue limits | integers with `1 ≤ perDocument ≤ global` |
| `journal.fsyncIntervalMs` | ≥ 10 |
| `snapshot.everyOps` | ≥ 1 |
| `flush` | `1000 ≤ quietMs ≤ maxIntervalMs` |
| `recovery.retryDelaysMs` | exactly 3 integers ≥ 0 (the BRD fixes the count at three [§4]) |
| `libreoffice` | `maxConcurrent ≥ 1`; `timeoutMs ≥ 1000` |
| `codecThreads` | ≥ 1 |
| `load.chunk` | all values ≥ 1; `maxBytes` ≥ 16 KiB |
| `queue.type` `'redis'` or `'kafka'` | the peer dependency is present (checked with `import()`); the remediation names the npm package |

### 2.5 `createEngine` (`api/create-engine.ts`)

```ts
function createEngine(options: EngineOptions): Promise<Engine>;
```
```
opts = validateEngineOptions(options); gateway = new Gateway(opts, emitter, logger, clock)
if opts.mode == 'worker': sup = new Supervisor(...); await sup.start(); channel = sup.channel   // rejects with the Core's boot error
else: [mainSide, coreSide] = InProcessEngineChannel.pair(); await new CoreRuntime(coreSide).boot({ workerConfigModule, logLevel }); channel = mainSide
gateway.bind(channel, stateSource); if opts.http?.server: gateway.attach(opts.http.server)
return new EngineFacade(opts, gateway, channel, sup?, emitter)
```

- If boot fails, `createEngine` rejects with the Core's error, rebuilt from `WireError` (§6.2).
- No upgrade listener is attached before boot succeeds.

### 2.6 `Engine` (`api/engine-facade.ts`)

```ts
type EngineState = 'starting' | 'running' | 'restarting' | 'failed' | 'stopping' | 'stopped';
interface Engine {
  readonly state: EngineState;
  attach(server: HttpServerLike): void;                                      // one 'upgrade' listener per call; several servers allowed
  on<E extends keyof EngineEventMap>(event: E, fn: (p: EngineEventMap[E]) => void): () => void;   // returns unsubscribe
  off<E extends keyof EngineEventMap>(event: E, fn: (p: EngineEventMap[E]) => void): void;
  documents: { create(input: CreateDocumentInput): Promise<{ ref: StorageRef }>; allowUnsupportedEdit(documentId: DocumentId): Promise<void> };
  recovery: {
    list(): Promise<RecoveryEntry[]>; retry(documentId: DocumentId): Promise<RecoveryEntry>;
    readLocalCopy(documentId: DocumentId): Promise<LocalCopy>;
    resolve(documentId: DocumentId, resolution: RecoveryResolution): Promise<RecoveryEntry>;
  };
  sessions: { close(filter: SessionFilter): number };
  shareInfo(documentId: DocumentId): Promise<ShareInfo>;
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
}
interface CreateDocumentInput { kind: DocKind; format: FileFormat; name: string; target: 'storage' | 'local' }
interface SessionFilter { documentId?: DocumentId; userId?: string; sessionId?: string }   // at least one, else CONFIG_INVALID
interface LocalCopy { bytes: Uint8Array; format: FileFormat; rev: number }
type RecoveryResolution = 'overwrite-storage' | 'discard-local';                             // proposed, Q2
interface RecoveryEntry {
  documentId: DocumentId; state: 'NORMAL' | 'LOCAL' | 'CHECK' | 'PENDING' | 'CONFLICT'; retryCount: number;
  nextRetryAt: number | null; localSince: number | null; localRev: number; lastFlushedRev: number;
  lastError?: { code: ErrorCode; message: string };
}
interface ShareInfo { documentId: DocumentId; loaded: boolean; kind?: DocKind; sessions: { edit: number; view: number } } // proposed, Q3
```

Where each call runs:
- `sessions.close` runs only in main, on the Gateway session table.
- `shareInfo` combines Gateway session counts with a Core call (`documents.info`).
- Every other call goes to the Core through `channel.call(method, args)` (§6). The engine state decides what happens:

| Engine state | Calls that go to the Core |
|---|---|
| `restarting` | reject at once with `ENGINE_RESTARTING` (retryable) |
| `failed` | reject with `ENGINE_FAILED` |
| `stopped` | reject with `SESSION_CLOSED` (LLD choice) |

`documents.create` (HLD §10.6):
1. Check that `kind` matches `format`; otherwise fail with `CONFIG_INVALID`.
2. Export the kind's `emptySnapshot()` through the codec.
3. Write it with `storage.create` and return `{ ref }`.

With `target: 'local'` while an adopter storage is configured, the returned `ref` is `{ $local: string }`. `StorageRouter` (§11.3) recognises that shape when the adopter later returns it as `AuthorizeResult.document.ref` (LLD choice; refs stay opaque to adopters).

### 2.7 Events (HLD §15)

```ts
interface EngineEventMap { error: OpenDocexError; fatal: OpenDocexError; audit: AuditEvent /* §15 */; storage: StorageEvent; engine: EngineStateEvent; document: DocumentEvent }
interface StorageEvent { documentId: DocumentId; state: 'local' | 'pending' | 'conflict' | 'recovered'; at: number; retryCount: number; nextRetryAt: number | null; error?: OpenDocexError }
interface EngineStateEvent { state: 'started' | 'restarting' | 'failed'; at: number; restartCount?: number; delayMs?: number;
                             exit?: { code: number | null; signal: string | null }; error?: OpenDocexError }
interface DocumentEvent { documentId: DocumentId; state: 'loaded' | 'faulted' | 'unsupported'; at: number; epoch?: string; rev?: number;
                          source?: 'storage' | 'local'; findings?: UnsupportedFinding[]; error?: OpenDocexError }
```

`TypedEmitter` (LLD choice):
- An `error` event with no listener is logged with `logger.error`. Unlike Node's `EventEmitter`, it never throws, so the engine cannot crash the adopter's process this way.
- An exception thrown by a listener is caught and logged.

**Tests**
- Unit: one table-driven case per validation rule; defaults; the emitter never throws; the call-rejection table above.
- Integration, in both modes: `createEngine` rejects with `CONFIG_LIBREOFFICE_NOT_FOUND` when the LibreOffice path is wrong; `shutdown` leaves no `upgrade` listener and no child process.

---

## 3. Logger (`log/*`) — V1

```ts
interface Logger { debug(m: string, f?: LogFields): void; info(m: string, f?: LogFields): void; warn(m: string, f?: LogFields): void; error(m: string, f?: LogFields): void }
type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;
```

- **Default:** a no-op logger. Main wraps the adopter's logger in `levelFilter(logger, logLevel)`.
- **Core side:** `IpcLogger` drops lines below `logLevel`, then posts `{ type: 'log', level, msg, fields }` (§6). Main passes each line on to the adopter's logger.
- **What may be logged (HLD §14):** never request headers, cookies, query strings, tokens, document bytes or op payloads.
  - `fields` keys are limited to an allowlist: `documentId`, `sessionId`, `userId`, `epoch`, `rev`, `code`, `pid`, `durationMs`, `attempt`, `state`, `path` (the configured path only) and `count`.
  - An unknown key is dropped in production and throws in tests.
- **Tests:** unit tests for the level filter and the allowlist; an integration test that Core logs reach the main logger in both modes.

---

## 4. Gateway (`gateway/*`) — V1, main process

**Responsibility:**
- handle the upgrade and call `authorize`
- keep the session table
- forward raw frames to the Core
- run the per-connection outgoing FIFO
- run `canSubmit`
- apply close codes
- define behaviour while the Core is not running

### 4.1 API and data

```ts
class Gateway {
  constructor(opts: ResolvedEngineOptions, emitter: TypedEmitter<EngineEventMap>, logger: Logger, clock: Clock);
  bind(channel: EngineChannel, state: () => EngineState): void;  attach(server: HttpServerLike): void;
  onCoreDown(reason: 'restarting' | 'failed'): void;            // §4.4
  closeSessions(filter: SessionFilter, code: number, reason: string): number;
  countSessions(documentId: DocumentId): { edit: number; view: number };
  stopAccepting(): void; closeAll(code: number, reason: string): void; detach(): void;
}
interface GatewaySession extends Session { ws: WebSocket; send: SendQueue; inbound: Promise<void>; alive: boolean; helloTimer?: TimerHandle }
// SessionTable: Map<sessionId, GatewaySession>, plus indexes Map<documentId, Set<sessionId>> and Map<userId, Set<sessionId>>
```

The WebSocket server is created as `new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false, clientTracking: false })`.
- `maxPayload` must be set explicitly, because ws's own default is 100 MiB.
- `perMessageDeflate: false` is ws's server default. It saves CPU in main (N4) and rules out decompression bombs.
- `clientTracking: false`: the session table already tracks clients.
- Source: https://github.com/websockets/ws/blob/master/doc/ws.md.

### 4.2 Upgrade (`upgrade.ts`)

```
onUpgrade(req, socket, head):
  url = new URL(req.url ?? '/', 'http://localhost'); if url.pathname != path: return       // not ours: other 'upgrade' listeners handle it
  socket.on('error', onSocketError)                                                         // removed after the handshake
  if stopping or state() in {starting, restarting}: return reject(socket, 503, { 'Retry-After': max(1, ceil(nextBackoffMs/1000)) })
  documentId = url.searchParams.get('doc')
  if !documentId or documentId.length > 512 or /[\u0000-\u001f]/.test(documentId): return reject(socket, 400)   // (LLD choice)
  try result = await authorize({ request: req, url, documentId }) catch e: emit error(ACCESS_DENIED, cause e); return reject(socket, 500)
  if result == null: return reject(socket, 403)                                             // Q1
  if !isValidAuthorizeResult(result): emit error(CONFIG_INVALID); return reject(socket, 500)
  if socket.destroyed: return                                                               // client left during async authorize
  if state() == failed: return wss.handleUpgrade(req, socket, head, ws => ws.close(CloseCode.ENGINE_UNAVAILABLE, 'ENGINE_UNAVAILABLE'))
  if state() != running: return reject(socket, 503)
  wss.handleUpgrade(req, socket, head, ws => { socket.off('error', onSocketError); openSession(ws, documentId, result) })
reject(socket, status, headers): socket.write(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n${headers}\r\n`); socket.destroy()
```

- **Why FAILED accepts the socket and then closes it:** a browser `WebSocket` cannot read an HTTP status, so the client can only see `ENGINE_UNAVAILABLE` (HLD §10.5) as a close code.
- **Restarting:** the HTTP 503 follows HLD §10.5 as written.
- **Order:** `authorize` runs before the FAILED check, so an unauthenticated caller learns nothing about engine state.
- **Rejection pattern source:** https://github.com/websockets/ws#client-authentication.

### 4.3 Session open, inbound and outbound

```
openSession(ws, documentId, r):
  s = { id: randomUUID(), documentId, userId: r.userId, access: r.access, openedAt: now, ws, send: new SendQueue(ws, hwm, onOverflow), inbound: resolved, alive: true }
  table.add(s); channel.post({ type: 'join', sessionId: s.id, documentId, userId, access, document: r.document })   // the Core starts loading now
  s.helloTimer = setTimeout(() => close(s, CloseCode.PROTOCOL_INVALID_MESSAGE, 'PROTOCOL_INVALID_MESSAGE'), helloTimeoutMs)
  ws.on('message', (data: Buffer, isBinary) => onInbound(s, data, isBinary))
  ws.on('close', () => { table.remove(s); channel.post({ type: 'leave', sessionId: s.id, reason: 'client-closed' }) })
  ws.on('pong', () => s.alive = true); every pingIntervalMs: if !s.alive → ws.terminate() else { s.alive = false; ws.ping() }
onInbound(s, data, isBinary):
  clearTimeout(s.helloTimer)                                             // the Core enforces that hello comes first
  if !canSubmit or isBinary: channel.post({ type: 'frame', sessionId: s.id, data, binary: isBinary }); return
  s.inbound = s.inbound.then(async () => {                               // keeps per-session order while canSubmit awaits
    msg = tryDecodeClientMessage(data)                                   // on failure, forward unchanged; the Core reports the error
    if msg?.type == 'submit' and !(await safe(canSubmit, view(s))):      // a throw counts as false and emits error(ACCESS_DENIED)
      s.send.push(encodeMessage(toClientError(engineError('ACCESS_DENIED'), msg.clientSeq))); return
    channel.post({ type: 'frame', sessionId: s.id, data, binary: false }) })
```

- **Message type:** in ws 8+, text frames arrive as a `Buffer` with `isBinary === false`; they are not decoded to strings (https://github.com/websockets/ws/releases/tag/8.0.0).
- **Parsing cost:** without `canSubmit`, main never parses a frame (HLD §16). With `canSubmit`, main decodes text frames; that cost is the price of the hook (LLD choice). The alternatives were a Core→main round trip for every submit, or brittle prefix sniffing.

**`SendQueue`** (`send-queue.ts`) — the per-connection FIFO with a high-water mark (HLD §11.4):

```ts
class SendQueue {
  constructor(ws: WebSocket, highWaterMarkBytes: number, onOverflow: () => void);
  push(data: string | Uint8Array, o?: { binary?: boolean; onWritten?: () => void }): boolean;   // false once closed
  readonly pendingBytes: number;
}
```

- **Ordering:** `ws.send()` preserves order.
- **Accounting:** `pendingBytes` grows by the frame's byte length on `push`. It shrinks in the `ws.send` callback, which ws calls "when data is written out".
- **Overflow:** when `pendingBytes + size > highWaterMarkBytes`:
  1. mark the queue closed
  2. call `ws.close(CloseCode.SESSION_SLOW_CONSUMER, 'SESSION_SLOW_CONSUMER')`
  3. call `ws.terminate()` after 5 s. The close frame waits behind the backlog, and ws's own `closeTimeout` is 30 s.
  4. post `leave { reason: 'slow-consumer' }`. The Core treats `leave` as idempotent, because the later ws `'close'` event posts it again.
- **Close reasons** are always error-code names. That keeps them under the 123-byte limit.
- **Outbound frames from the Core:** `{ type: 'send', frames: OutFrame[] }`. For each frame and each listed session, the Gateway calls `table.get(id)?.send.push(data, { binary, onWritten })`.
  - `onWritten` is set only when the frame carries a `token`. It posts `{ type: 'written', sessionId, token }`, which drives load pacing (§8.5).
  - The Core encodes a broadcast once and sends the same string to all N sessions.

### 4.4 Core down, FAILED, admin close, shutdown

| Trigger | What the Gateway does |
|---|---|
| `onCoreDown('restarting')` | For each session: push `notice {notice: 'engine-restarting'}` (best effort), then `close(CloseCode.ENGINE_RESTARTING /* 4001 */)`. Then clear the table (HLD §10.5). New upgrades get HTTP 503 until the Core runs again. |
| `onCoreDown('failed')` | The same, with `CloseCode.ENGINE_UNAVAILABLE`. |
| `closeSessions(filter)` (`engine.sessions.close`) | Close the matching sessions with `CloseCode.SESSION_CLOSED`. |
| `shutdown` | `stopAccepting()` (503), then `closeAll(SESSION_CLOSED)`. After the Core is gone, `detach()` removes the listeners and calls `wss.close()`. |

**Tests**
- Unit (fake ws):
  - overflow closes with `SESSION_SLOW_CONSUMER` and terminates after 5 s
  - `pendingBytes` accounting
  - order is kept while `canSubmit` awaits
  - the reject matrix (400, 403, 500, 503)
  - paths other than ours are left untouched
- Integration (real `http` server and ws client):
  - `authorize` returns `null` → 403
  - FAILED → close code `ENGINE_UNAVAILABLE`
  - killing the Core → every client gets 4001
  - `sessions.close({ userId })` closes only that user's sockets

---

## 5. Supervisor (`supervisor/supervisor.ts`) — V1, worker mode only

```ts
type SupervisorState = 'STARTING' | 'RUNNING' | 'RESTARTING' | 'FAILED' | 'STOPPING' | 'STOPPED';
class Supervisor {
  constructor(opts: ResolvedEngineOptions, gateway: Gateway, emitter: TypedEmitter<EngineEventMap>, logger: Logger, clock: Clock);
  readonly state: SupervisorState; readonly channel: IpcEngineChannel; readonly nextBackoffMs: number;
  start(): Promise<void>;          // resolves on the first 'ready'; rejects with the first boot error (no retry at first start)
  stop(timeoutMs: number): Promise<void>;
}
```

**Fork:**

```ts
child = fork(fileURLToPath(new URL('../core/core-entry.js', import.meta.url)), [], {
  serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  execArgv: process.execArgv.filter(a => !a.startsWith('--inspect')), env: process.env, windowsHide: true });
channel.bind(child); await channel.request('init', { workerConfigModule, logLevel }, bootTimeoutMs);
```

- **Advanced serialization** carries `Uint8Array`/`Buffer`, `Map` and `BigInt`. It does **not** carry properties set on built-in objects such as `Error` (https://nodejs.org/api/child_process.html#advanced-serialization). Errors therefore always cross IPC as `WireError` (§6.2).
- **Child gone:** `'exit'` may not follow `'error'` (https://nodejs.org/api/child_process.html#event-error). Both handlers call one idempotent `onChildGone()`.

**State machine (HLD §11.3):**

| From | Event | Action | To |
|---|---|---|---|
| — | `start()` | fork | STARTING |
| STARTING | `ready` | `lastPong = now`; start the heartbeat; emit `engine {state:'started'}` | RUNNING |
| STARTING (first start) | boot error, boot timeout or exit | kill the child; reject `start()` | STOPPED |
| STARTING (after a restart) / RUNNING | child gone | stop the heartbeat; `channel.unbind(ENGINE_RESTARTING)`, which rejects pending requests; `gateway.onCoreDown('restarting')`; drop entries in `restarts[]` older than `restartWindowMs` | see the next two rows |
| ″ | `restarts.length >= maxRestarts` | `gateway.onCoreDown('failed')`; emit `fatal(ENGINE_FAILED)` and `engine {state:'failed'}` | FAILED |
| ″ | otherwise | `delay = backoffMs[min(restarts.length, backoffMs.length - 1)]`; `restarts.push(now)`; emit `engine {state:'restarting', delayMs, restartCount}`; `setTimeout(fork, delay)` | RESTARTING |
| RUNNING | heartbeat tick | if `now - lastPong > heartbeatTimeoutMs`: `child.kill('SIGKILL')` (the exit then runs "child gone"); otherwise post `ping{seq}` | RUNNING |
| RUNNING | `pong` | `lastPong = now` | RUNNING |
| RESTARTING | timer fires | fork | STARTING |
| any but STOPPED | `stop()` | graceful stop, below | STOPPING → STOPPED |
| FAILED | — | Terminal. FAILED is left only when the adopter's process restarts. | FAILED |

- With the defaults, the first five crashes inside 10 minutes restart after 1, 2, 4, 8 and 16 s. The sixth crash in that window leads to FAILED [A2].
- On Windows, `kill('SIGKILL')` terminates the child forcefully (https://nodejs.org/api/child_process.html#subprocesskillsignal).

**Graceful stop:**
1. Set `STOPPING` and stop the heartbeat.
2. `await channel.request('shutdown', { timeoutMs: t - 500 }, t)`. Errors are only logged.
3. Wait up to 1 s for the child to exit; if it is still alive, `kill('SIGKILL')`.
4. Set `STOPPED`.

**Core side of the process boundary:**
- `process.on('disconnect')`: the parent died. Run a fast shutdown (journal `datasync`, release LOCK), then exit, so the Core never lives on as an orphan.
- `uncaughtException` / `unhandledRejection`: log, then `process.exit(1)`. The state may be corrupt; the Supervisor restarts the Core.
- These handlers are installed only in `core-entry.ts`, never in main mode.

**Tests**
- Unit (fake clock, fake child): every row above; the backoff sequence; the window prune resets the backoff index; a heartbeat timeout kills the child.
- Integration: a test Core that exits on command reaches FAILED on the 6th crash; a busy-looping Core is killed after the heartbeat timeout (shortened in tests).

---

## 6. EngineChannel (`channel/*`) — V1 (Bridge: one API over two transports)

### 6.1 Interfaces

```ts
interface EngineChannel {                                          // main side (A)
  post(msg: CoreRequest): void;                                    // fire-and-forget, FIFO
  call<M extends ApiMethod>(method: M, args: ApiArgs[M]): Promise<ApiResult[M]>;
  request<T extends 'init' | 'shutdown'>(type: T, body: RequestBody[T], timeoutMs?: number): Promise<RequestResult[T]>;
  onEvent(handler: (ev: CoreEvent) => void): () => void;
  onHook(handler: (name: HookName, args: unknown) => Promise<unknown>): void;   // V4
}
interface CoreChannelSide {                                        // Core side (B)
  onRequest(handler: (msg: CoreRequest) => void): void; emit(ev: CoreEvent): void;
  whenWritable(): Promise<void>;                                   // §6.4
  hook(name: HookName, args: unknown): Promise<unknown>;
}
class IpcEngineChannel implements EngineChannel { bind(child: ChildProcess): void; unbind(reason: OpenDocexError): void }
class InProcessEngineChannel implements EngineChannel { static pair(): [InProcessEngineChannel, CoreChannelSide] }
```

### 6.2 Message catalogue (`channel/messages.ts`)

```ts
type CoreRequest =                                                                    // main → Core
  | { type: 'init'; id: number; workerConfigModule: string; logLevel: LogLevel }
  | { type: 'ping'; seq: number }
  | { type: 'join'; sessionId: string; documentId: DocumentId; userId: string; access: 'edit' | 'view'; document: { ref: StorageRef; format: FileFormat } }
  | { type: 'frame'; sessionId: string; data: Uint8Array; binary: boolean }
  | { type: 'leave'; sessionId: string; reason: 'client-closed' | 'slow-consumer' | 'admin' | 'shutdown' }
  | { type: 'written'; sessionId: string; token: number }
  | { type: 'call'; id: number; method: ApiMethod; args: unknown }
  | { type: 'hook-result'; id: number; ok: true; value: unknown } | { type: 'hook-result'; id: number; ok: false; error: WireError }
  | { type: 'shutdown'; id: number; timeoutMs: number };
type CoreEvent =                                                                      // Core → main
  | { type: 'ready'; id: number; pid: number; boot: BootReport }
  | { type: 'pong'; seq: number }
  | { type: 'result'; id: number; ok: true; value: unknown } | { type: 'result'; id: number; ok: false; error: WireError }
  | { type: 'send'; frames: OutFrame[] }
  | { type: 'close'; sessionIds: string[]; code: number; reason: string }
  | { type: 'emit'; event: 'error' | 'audit' | 'storage' | 'document'; payload: unknown }   // errors inside payloads are WireError
  | { type: 'log'; level: LogLevel; msg: string; fields?: LogFields }
  | { type: 'hook'; id: number; name: HookName; args: unknown };                       // V4
interface OutFrame { sessionIds: string[]; data: string | Uint8Array; binary: boolean; token?: number }
type ApiMethod = 'documents.create' | 'documents.allowUnsupportedEdit' | 'documents.info' | 'recovery.list'
  | 'recovery.retry' | 'recovery.readLocalCopy' | 'recovery.resolve' | 'audit.enable';
type HookName = 'onUploaded';
interface WireError { code: ErrorCode; message: string; documentId?: string; instanceId?: string; causeMessage?: string }
interface BootReport { documents: number; recovering: number; dirty: number; queueBacklog: number }
```

- **`init`** is answered by `ready`. A boot failure arrives as `result { id: initId, ok: false }`.
- **Errors in main:** a `WireError` becomes `engineError(code, { message, documentId, instanceId, cause: causeMessage })`. Category, severity and remediation come from the catalogue, so they never travel over IPC.
- **`audit.enable { enabled }`** is called when the first `audit` listener is added and when the last one is removed. With no listener, the Core sends no audit traffic over IPC (LLD choice, HLD §16).

### 6.3 Correlation

- Each side keeps an integer `nextId` and `pending: Map<id, { resolve, reject, timer? }>`.
- `unbind(reason)` rejects everything still pending with `ENGINE_RESTARTING`.
- **Timeouts:** API calls have none of their own (LLD choice). They are bounded by the Core's internal timeouts (conversion, storage) and by child death. `init` uses `bootTimeoutMs`; `shutdown` uses its own `timeoutMs`.
- A result whose `id` is unknown is logged and dropped.

### 6.4 IPC flow control

`send()` returns `false` once "the backlog of unsent messages exceeds a threshold", and Node offers no `drain` event; only the per-message callback signals that a message went out (https://nodejs.org/api/child_process.html#subprocesssendmessage-sendhandle-options-callback).

Both sides therefore count `inFlight`: messages sent whose callback has not fired yet.
- **Core side:** `whenWritable()` resolves at once while `inFlight < 1024`. Above that, it resolves when callbacks bring `inFlight` back below 512 (LLD choice). Every `DocumentInstance` awaits `whenWritable()` before taking the next envelope, so a busy main process slows intake instead of growing memory.
- **Main side:** client frames are not paused. Inbound volume is already bounded by `maxPayload` and the Core's queue limits.

### 6.5 In-process variant

- `pair()` returns two ends with one delivery queue per direction.
- `post` and `emit` push onto an array. A single `setImmediate` drains it, so delivery is asynchronous, FIFO and never re-entrant, just like IPC.
- Messages are not cloned (LLD choice). Both sides treat them as read-only (`Readonly` types), and byte arrays are never reused after posting.
- `whenWritable()` always resolves.

**Tests:** one contract suite runs against both channels. It covers ordering, call/result, error rebuilding (code, retryable and remediation survive), rejection on unbind, and the `whenWritable` hysteresis (IPC, with mocked send callbacks).

---

## 7. CoreRuntime boot (`core/core-entry.ts`, `core/core-runtime.ts`) — V1

```ts
class CoreRuntime {
  constructor(side: CoreChannelSide, clock?: Clock);
  boot(init: { workerConfigModule: string; logLevel: LogLevel }): Promise<BootReport>;
  shutdown(timeoutMs: number): Promise<void>;
}
```

Boot runs these steps in order. Any throw ends boot with `result{ok:false}`; in worker mode the process then exits with code 1.

| # | Step | Error |
|---|---|---|
| 1 | Import the worker config module (`pathToFileURL`), then `resolveWorkerConfig(mod.default)`. | `CONFIG_INVALID` (import failure, or no default export) |
| 2 | `mkdir -p` the dataDir and its subfolders (mode 0o700 on POSIX). Write-probe `tmp/.probe-<rand>`: write, `datasync`, unlink. | `CONFIG_DATA_DIR_UNWRITABLE` |
| 3 | `DataDirLock.acquire()`: create `LOCK` with flag `'wx'`, containing `{pid, hostname, startedAt}`. If it exists, it is stale only when it is from this host and `process.kill(pid, 0)` throws `ESRCH`; a stale lock is replaced. Otherwise boot fails. (LLD choice: two Cores on one dataDir would corrupt the journals.) | `CONFIG_DATA_DIR_UNWRITABLE`, naming the holder's pid |
| 4 | Empty `tmp/`. Create the LibreOffice profile slots (§14.3). Start the `CodecPool` (§14.1). | — |
| 5 | `LibreOfficeLocator.resolve(cfg.libreoffice.path)`, then `codec.probe()`: convert a built-in one-paragraph FODT to ODT on slot 0. | `CONFIG_LIBREOFFICE_NOT_FOUND` (cause: ENOENT, EACCES, timeout or no output) |
| 6 | `MetaStore.loadAll()`. Build `StorageRouter`, `FlushScheduler`, `RecoveryManager`, `AuditEmitter` and `DocumentRegistry`. | — |
| 7 | `queue.start({ onBacklog: id => registry.ensureLoadedForBacklog(id) })`. V3 adapters connect here, with a 10 s timeout. | `QUEUE_UNAVAILABLE` / `CONFIG_INVALID` |
| 8 | Recovery scan (§13.5). It only schedules work; boot never waits for storage. | — |
| 9 | Start the journal fsync timer (interval mode). Reply `ready` with a `BootReport`. | — |

**Fault isolation:**
- Every entry point (requests, timers, queue deliveries) is wrapped.
- An error that belongs to one instance goes to that instance's `fault()` (§8.4).
- Any other error is logged and emitted as `error`; the Core keeps running.
- Only an uncaught exception or unhandled rejection ends the process (§5).

**Tests:** integration tests in both modes: each failing step produces its error code; a stale LOCK is taken over; a live LOCK is refused; `tmp/` is emptied.

---

## 8. DocumentRegistry, DocumentInstanceFactory, DocumentInstance

### 8.1 Session records and frame dispatch (`core/session-record.ts`) — V1

```ts
interface SessionRecord { sessionId: string; documentId: DocumentId; userId: string; access: 'edit' | 'view';
                          clientId?: ClientId; state: 'joined' | 'loading' | 'live' | 'closed' }
```

- **`join`:** create the record, then `registry.getOrLoad(documentId, document)`.
- **`leave`:** idempotent. It removes the session from the instance and aborts its upload, if any (V4).
- **`frame`:**
  1. Decode. Text: `decodeClientMessage(new TextDecoder().decode(data))`. Binary: per Part 1's asset framing. A failure sends `error(PROTOCOL_INVALID_MESSAGE)` and drops the frame.
  2. Until `hello` arrives, every other message gets `PROTOCOL_INVALID_MESSAGE`.
  3. Route by type:

| Message | Handler |
|---|---|
| `hello` | `onHello` |
| `submit` | `onSubmit` |
| `asset-put`, `asset-get` | `onAsset*` |
| `upload-*` (V4) | `UploadService` |
| `annotation-*` (V5) | `AnnotationService` |
| unknown type | ignored (HLD §9) |

### 8.2 DocumentRegistry (`core/registry.ts`) — V1

```ts
class DocumentRegistry {
  get(id: DocumentId): DocumentInstance | undefined;
  getOrLoad(id: DocumentId, doc: { ref: StorageRef; format: FileFormat }): Promise<DocumentInstance>;   // single-flight
  ensureLoadedForBacklog(id: DocumentId): Promise<void>;   // V3: ref and format come from MetaStore; with no meta, the backlog is acked and dropped with a warn log
  remove(id: DocumentId): void; all(): Iterable<DocumentInstance>;
}
```

- **Single-flight:** concurrent loads of one document share `loading: Map<DocumentId, Promise<DocumentInstance>>`. A failed load removes its entry, so the next `join` retries.
- **First ref wins (LLD choice):** a `join` whose `ref` or `format` differs from the loaded instance's is logged at warn level, and the session joins the loaded instance.

### 8.3 DocumentInstanceFactory and kind policies (`core/instance-factory.ts`, `core/kind-policy.ts`) — V1 text, V2 sheet

```ts
interface KindPolicy<S, O> {
  kind: DocKind; ot: OtType<S, O>; chunkLimits: ChunkLimits;   // text: textBlocks + maxBytes; sheet: sheetRows + maxBytes (Part 1 field names)
  emptySnapshot(): S;
  assetRefs(ops: readonly O[]): string[];                          // text: image assetIds inside inserted slices; sheet: []
  supersededOf?(before: S, op: O): SupersededCell[];               // V2 (§15)
}
class DocumentInstanceFactory {
  constructor(deps: CoreDeps);                                     // persistence, router, codec, queue, flush, recovery, audit, channel side, config
  kindOf(format: FileFormat): DocKind;                    // in V1, sheet formats fail with DOCUMENT_UNSUPPORTED_CONTENT ("spreadsheets need V2")
  create(id: DocumentId, doc: { ref: StorageRef; format: FileFormat }): DocumentInstance;   // created in state LOADING
}
```

### 8.4 DocumentInstance (`core/document-instance.ts`) — V1

```ts
type InstanceState = 'LOADING' | 'ACTIVE' | 'FAULTED' | 'CLOSING' | 'CLOSED';
class DocumentInstance<S = unknown, O = unknown> {
  readonly documentId: DocumentId; readonly docKey: string;     // sha256hex(documentId)
  readonly epoch: string;                                       // newEpoch() on every load (CL-7); also used as instanceId
  state: InstanceState; rev: number; model: S;
  readOnly: boolean;                                            // true when there are findings and meta.readOnly.allowedEdit is false
  load(): Promise<void>; addSession(r: SessionRecord): void; removeSession(id: string): void;
  onHello(r: SessionRecord, m: HelloMsg): void; onSubmit(r: SessionRecord, m: SubmitMsg): Promise<void>;
  onAssetPut(r: SessionRecord, m: AssetPutMsg, bytes: Uint8Array): Promise<void>; onAssetGet(r: SessionRecord, m: AssetGetMsg): Promise<void>;
  allowUnsupportedEdit(): Promise<void>; currentSnapshot(): { rev: number; model: S };
  reloadFromStorage(): Promise<void>; fault(err: unknown): Promise<void>; close(): Promise<void>;
}
```

**Required from Part 1 (N11):** `OtType.apply` and `rebase` never mutate their inputs. The journal-first ordering and the zero-copy `currentSnapshot()` both depend on it.

**Lifecycle (HLD §11.3).** `CLOSED` is added here as an end state (LLD choice).

| From | Event | Action | To |
|---|---|---|---|
| LOADING | load ok | new epoch; persist meta; emit `document loaded` (and `unsupported` when there are findings); `queue.consume(documentId, deliver)`; serve waiting hellos | ACTIVE |
| LOADING | load error | each waiting session gets `error(code)` and is closed with `closeCodeFor(code)` (R-16, S-36); `registry.remove` | CLOSED |
| ACTIVE | `allowUnsupportedEdit` | persist `meta.readOnly.allowedEdit = true`; `readOnly = false`; send `notice {notice: 'read-only', readOnly:false}` to all sessions | ACTIVE |
| ACTIVE | unexpected throw (op-level throws excluded, see below) | `fault()` | FAULTED |
| ACTIVE | `close()` (shutdown) | stop intake; wait for the current delivery; journal `datasync` | CLOSING → CLOSED |
| FAULTED | `fault()` cleanup done | `registry.remove`; the next `join` reloads from local state with a new epoch | CLOSED |

**Choosing the load source (HLD §10.1, [§5]):**

```
meta = metaStore.get(docKey)
if !meta:                                                         // first load, including documents.create blanks
  st = stat(ref) → null: DOCUMENT_NOT_FOUND; st.size > maxFileBytes: DOCUMENT_TOO_LARGE
  r = read(ref, { maxBytes }); imp = codec.import(r.bytes, format, assetDir); model = ot.deserializeSnapshot(imp.snapshot); rev = 0
  snapshotStore.write(rev 0); meta = new NORMAL meta (lastKnownVersion = r.version, lastFlushedRev = 0, findings = imp.findings)
elif meta.storageState != NORMAL or localRev > meta.lastFlushedRev:   replayLocal()     // the local copy is newer [§5]
else:                                                                   // local copy is clean
  st = try stat(ref)
  if st ok and st.version == meta.lastKnownVersion:  replayLocal()      // same content; keeps rev continuity (LLD choice)
  elif stat threw and a local snapshot exists:        replayLocal()      // state stays NORMAL (LLD choice)
  else: fresh import as above, but rev = meta.rev (rev never decreases for a documentId, LLD choice); clear dedupe and lineage
meta.lineage.push({ epoch, fromRev: rev }) (keep the last 32; reset on a fresh import)                      // V3, §8.6
```

`replayLocal()`:
1. Load the snapshot `{ rev: S, model, dedupe }`.
2. Stream the journal and apply each entry with `f ≥ S` through `ot.apply`, checking continuity (`f == rev`).
3. Rebuild the dedupe table and the history, including the tail entries with `r ≤ S` (§10.3).

A gap, a bad checksum in the middle of a file, or a throw from `apply` fails the load with `DOCUMENT_FAULTED`. Local files are kept [§5].

**Intake (`onSubmit`, before the queue):**
- Rejected without enqueueing: a view session (`ACCESS_DENIED`), a read-only instance (`DOCUMENT_READ_ONLY`), or a `clientId` that differs from the session's bound one (`PROTOCOL_INVALID_MESSAGE`, §8.7).
- Otherwise: `queue.enqueue({ documentId, sessionId, userId, access, receivedAt: now, envelope })`. A result of `{ok:false}` is sent back as `error {code, clientSeq}`.

**FIFO processing loop.** One consumer per document; the `QueueAdapter` delivers serially (§9). Steps 1–2 repeat the intake checks, for items that were redelivered or that waited while the state changed.

```
deliver(d):
   await side.whenWritable()                                               // IPC backpressure (§6.4)
   env = d.item.envelope; s = sessions.get(d.item.sessionId)               // may be undefined (disconnected, or a V3 redelivery)
 1 if d.item.access == 'view': reply(s, error ACCESS_DENIED); return d.ack()
 2 if readOnly: reply(s, error DOCUMENT_READ_ONLY); return d.ack()
 3 if dedupe.lookup(env.clientId, env.clientSeq):                           // duplicate (CL-12)
     h = history.findByClient(env.clientId, env.clientSeq)
     reply(s, h ? ack{clientSeq, rev: h.r, committed: h.x ? h.o : undefined} : resync); return d.ack()
 4 if !epochAccepted(env.epoch, env.baseRev) or env.baseRev > rev or env.baseRev < history.floorRev:
     if s: sendResyncAndReload(s); return d.ack()                           // §8.5, §8.6
 5 try ops = ot.validateOps(env.ops); checkAssets(policy.assetRefs(ops))    // an unknown assetId is rejected
       over = history.opsSince(env.baseRev); rebased = over.length ? ot.rebase(ops, over) : ops
       { snapshot, applied, dropped } = ot.apply(model, rebased)          // sheet: one op at a time to capture superseded (§15)
   catch: reply(s, error PROTOCOL_OP_REJECTED); emit error (severity warning); return d.ack()   // LLD choice
 6 entry = { f: rev, r: rev + applied.length, c: env.clientId, q: env.clientSeq, u: d.item.userId, t: now, x: over.length > 0 || dropped.length > 0, o: applied }
   await journal.append(entry)                                              // JOURNAL FIRST; a throw → fault(), and no ack is sent
 7 model = snapshot; rev = entry.r; history.push(entry); dedupe.record(c, q, r); flush.markDirty(this); opsSinceSnapshot += applied.length
 8 ACK        → s: ack { clientSeq, rev: entry.r, committed: entry.x ? applied : undefined }
 9 BROADCAST  → all live and loading sessions except s, only if applied is non-empty: remote { fromRev: entry.f, ops: applied, clientId }
                (steps 8 and 9 go out as one 'send' CoreEvent with two OutFrames)
10 AUDIT      → audit.emit({ ...entry, documentId, sessionId, superseded })
11 await d.ack()                                                            // queue commit after the journal (V3: XACK / offset)
12 if opsSinceSnapshot >= snapshot.everyOps: await snapshotAndRotate()      // §10.3
```

- **Ordering guarantee:** journal → ack → broadcast → audit → queue commit (N1; HLD §10.2/§10.3).
- **No waiting for screens:** the next envelope is taken as soon as `deliver` returns [§2].
- **All-dropped batch:** it still writes a journal entry with `o: []` and `f == r`, so its dedupe record survives a crash. It is acked with `committed: []` and not broadcast.
- **Op-level throws (LLD choice):** a throw from `validateOps`, `rebase` or `apply` rejects only that envelope. This is safe because `apply` is pure. One editor's bad batch therefore cannot fault the document for everyone.
- **What does fault the instance:** journal or snapshot I/O failures, broken invariants, and bugs in the loop itself.

**`fault(err)`** (HLD §11.3, [A2]):
1. Stop consuming.
   - Durable-queue items stay unacked, for redelivery.
   - Memory-queue items are drained; each sender gets `error DOCUMENT_FAULTED`.
2. `journal.datasync()`.
3. If dirty and `storageState == NORMAL`: `flush.flushNow(this, { timeoutMs: 30 000 })`, best effort, from the last committed snapshot.
4. Every session gets `error DOCUMENT_FAULTED`, then a close with `CloseCode.DOCUMENT_FAULTED`.
5. Emit `document {state:'faulted'}` and `error(DOCUMENT_FAULTED)`.

The instance's `epoch` is the `instanceId` in all its errors (LLD choice).

**Assets** (CL-8):
- **`onAssetPut`:**
  - edit sessions on a writable instance only (`ACCESS_DENIED` or `DOCUMENT_READ_ONLY` otherwise)
  - size is bounded by `maxPayload`
  - the MIME type is sniffed from magic bytes and must be PNG, JPEG or GIF (PO-24; anything else is `PROTOCOL_OP_REJECTED`)
  - the bytes are stored with `assetStore.put`, and the reply is an `asset` message
- **`onAssetGet`:** serves only from this document's asset folder. An unknown id gets `DOCUMENT_NOT_FOUND`.

**Tests**
- Unit (fakes):
  - spy order `journal.append < ack < remote < audit < queue.ack`
  - a journal failure → no ack, and the instance becomes FAULTED
  - a duplicate → ack with the original rev, plus `committed` when it was transformed
  - a stale `baseRev` → resync
  - a view session or a read-only instance → its error code
  - an op-level throw → `PROTOCOL_OP_REJECTED`, and the instance stays ACTIVE
  - every row of the load-source decision
- Integration (both modes): two clients converge; faulting one document leaves another working; journal replay rebuilds the same model.

### 8.5 First load, resync and resume (`core/load-streamer.ts`) — V1 [A7]

A `hello` that arrives while the instance is LOADING waits until it is ACTIVE.

```
onHello(r, m):
  if m.protocol != PROTOCOL_VERSION: send error PROTOCOL_VERSION_UNSUPPORTED; close(CloseCode.PROTOCOL_ERROR); return   // CloseCode has no version code (S-36)
  r.clientId = m.clientId
  if m.resume?.epoch == epoch and history.floorRev <= m.resume.rev <= rev: return catchUp(r, m.resume.rev)
  if m.resume and m.resume.epoch != epoch: send resync                          // HLD §10.5 step 4; contract N3
  fullLoad(r)
fullLoad(r):                                                                    // synchronous up to the first send
  N = rev; chunks = loadCache.get(N) ?? ot.chunk(model, policy.chunkLimits)    // the cache is shared by joiners at the same rev
  r.state = 'loading'; broadcastSet.add(r)                                      // remotes for rev > N now follow load-start
  send load-start { epoch, rev: N, kind, access: r.access, unsupported?: findings, readOnly, ackedClientSeq: dedupe.lastSeq(r.clientId) }   // N1, N2
  send load-chunk { seq: i, data: chunks[i] } for each i, at most 4 not yet written (each carries a token; 'written' events refill the window)
  send load-done { rev: N }; r.state = 'live'
catchUp(r, from):                                                               // same epoch, so no reload (LLD choice; contract N4)
  send notice {notice: 'read-only', readOnly: r.access == 'view' || readOnly }   // access may have changed on re-authorize
  for e in history.entriesAfter(from): e.c == r.clientId ? send ack { clientSeq: e.q, rev: e.r, committed: e.x ? e.o : undefined }
                                                         : send remote { fromRev: e.f, ops: e.o, clientId: e.c }
  broadcastSet.add(r); r.state = 'live'
```

- **Remotes during a load:** they may arrive between chunks. The client buffers them until `load-done` (A7; N5).
- **Pacing (LLD choice):** only chunks are paced. Four chunks of 256 KiB stay well under the 8 MiB high-water mark. Remotes are not paced and do count against it, as HLD §11.4 intends.
- **`sendResyncAndReload(s)`** sends `resync`, then runs `fullLoad`.
- **`OpHistory`** keeps the last `historyMaxOps = max(1000, 2 × snapshot.everyOps)` ops in memory (LLD choice). `floorRev` is the rev just before the oldest kept entry.
- **Tests:**
  - Unit: the pacing window with fake `written` events; interleaved remotes arrive only after `load-start`; catch-up sends acks for own ops and remotes for others; a resume outside the window does a full load.
  - Integration: a 20 MiB document loads without `SESSION_SLOW_CONSUMER`.

### 8.6 Epoch acceptance and lineage — V3

`epochAccepted(e, baseRev)` is true when `e == epoch`. It is also true when `e` is in `meta.lineage` and `baseRev ≥ history.floorRev`.

- `meta.lineage` lists the epochs of the local reloads since the last fresh import. Their rev numbering continues one history.
- So a queue entry written before a crash is rebased and applied after the restart, not dropped. This is what "resume from the last committed offset" [A2] needs.
- Live sessions never carry an older epoch, because sessions do not survive a Core restart. In V1 (memory queue) only the first condition ever applies.

### 8.7 Dedupe table (`core/dedupe-table.ts`) — V1 (CL-12)

```ts
class DedupeTable {
  lookup(c: ClientId, seq: number): boolean;           // true when seq ≤ the last committed seq for c
  record(c: ClientId, seq: number, rev: number): void;
  lastSeq(c: ClientId): number | undefined;            // fills load-start.ackedClientSeq (N2)
  toJSON(): Array<[ClientId, number, number]>; static fromJSON(a: Array<[ClientId, number, number]>): DedupeTable;
}
```

- **Size:** a `Map<ClientId, {seq, rev}>` capped at 10 000 clients; the lowest `rev` is evicted first (LLD choice). Client IDs are created per tab load, so without a cap the map would grow without bound.
- **Persistence:** rebuilt from journal entries, and stored in each snapshot (§10.3).
- **Binding:** a `submit` whose `clientId` differs from the session's `hello` gets `PROTOCOL_INVALID_MESSAGE` and is never enqueued. This stops one session from poisoning another client's dedupe entries.

---

## 9. QueueAdapter (`queue/*`)

### 9.1 Port — V1

```ts
interface QueueItem { documentId: DocumentId; sessionId: string | null; userId: string; access: 'edit' | 'view'; receivedAt: number; envelope: SubmitEnvelope }
interface QueueDelivery { item: QueueItem; redelivered: boolean; ack(): Promise<void> }
type EnqueueResult = { ok: true } | { ok: false; code: 'QUEUE_FULL' | 'QUEUE_UNAVAILABLE' };
interface QueueAdapter {
  readonly kind: 'memory' | 'redis' | 'kafka';
  start(hooks: { onBacklog(documentId: DocumentId): void }): Promise<void>;
  enqueue(item: QueueItem): Promise<EnqueueResult>;
  consume(documentId: DocumentId, deliver: (d: QueueDelivery) => Promise<void>): { stop(): Promise<void> };   // one consumer per document
  depth(documentId: DocumentId): number; close(): Promise<void>;
}
```

**Contract for every adapter:**
- Deliveries for one document are serial and in FIFO order. Item n+1 is delivered only after item n's `ack()`.
- Depth counts an item from `enqueue` until its `ack`, including the item being processed.
- `QUEUE_FULL` is retryable (HLD §11.4). The client keeps the change pending and retries with backoff [A3].

### 9.2 MemoryQueue — V1

```ts
class MemoryQueue implements QueueAdapter { constructor(o: { perDocument: number; global: number }) }
// state: Map<DocumentId, { buf: RingDeque<QueueItem>; pumping: boolean; deliver?: DeliverFn }>, globalDepth: number
```
```
enqueue(item): q = get(item.documentId)
  if globalDepth >= global or q.buf.length >= perDocument: return { ok: false, code: 'QUEUE_FULL' }
  q.buf.push(item); globalDepth++; schedulePump(q); return { ok: true }
pump(q): if q.pumping or !q.deliver: return; q.pumping = true
  while q.buf.length and q.deliver: await q.deliver({ item: q.buf.peek(), redelivered: false, ack: once(() => { q.buf.shift(); globalDepth-- }) })
  q.pumping = false
```

- `RingDeque` gives O(1) push and shift.
- If a delivery leaves its item un-acked, that document's pump stops until `fault()` drains it.
- Items are lost in a crash, by design [A2]. Clients resend them, and dedupe drops the ones already committed.
- **Tests:** per-document and global limits; FIFO; a slow consumer does not block other documents; depth counts until ack.

### 9.3 RedisStreamsQueue — V3 (CL-11, node-redis v5)

```ts
interface RedisQueueConfig {
  type: 'redis'; perDocument?: number; global?: number;
  client?: RedisClientType;                              // owned by the adopter: used as given, never closed by us
  url?: string; clientOptions?: RedisClientOptions;      // otherwise createClient({ url, ...clientOptions }), closed on close()
  keyPrefix?: string;                                    // 'open-docex'
  consumerName?: string;                                 // 'core'; a stable name means the restarted Core re-reads its own PEL
  claimIdleMs?: number;                                  // 0: there is a single consumer, so any entry pending under another name is ours
}
```

| Key (`p` = prefix; `{docKey}` is a cluster hash tag) | Type | Content |
|---|---|---|
| `${p}:q:{${docKey}}` | stream | field `e` = JSON `{ v: 1, documentId, sessionId, userId, access, receivedAt, envelope }` |
| `${p}:q:docs` | set | documentIds that may have a backlog. `SADD` on the first enqueue per document per process. |
| group `${p}-core` | consumer group | `XGROUP CREATE key group 0 MKSTREAM`; a `BUSYGROUP` reply is ignored |

**Bounds and backpressure:**
- The Core is the only producer for its streams; multi-server deployment is the adopter's concern (HLD §18). Exact local counters can therefore be checked **before** `XADD`.
- `MAXLEN` is never used, because it would trim unprocessed entries.
- A processed entry is removed with `MULTI; XACK key g id; XDEL key id; EXEC`. So at boot, `XLEN` equals the backlog and seeds the counters.
- `XACKDEL` (Redis 8.2+) is avoided so that Valkey works (LLD choice).

**Reading without `BLOCK` (LLD choice):** the Core produces every entry, so it knows when there is something to read. Each document's pump reads non-blocking after an enqueue, and on boot. One shared connection is enough, because there are no blocking commands.

```
start(): connect; for id in SMEMBERS docs: n = XLEN key(id); n > 0 ? (depth[id] = n, globalDepth += n, onBacklog(id)) : SREM docs id
enqueue(item): over the limits → QUEUE_FULL; try XADD key '*' { e }; depth++; kick the pump   catch → QUEUE_UNAVAILABLE
pump(doc):
  pending = XREADGROUP GROUP g c COUNT 100 STREAMS key 0                       // own PEL: delivered before a crash, never acked
          ∪ XAUTOCLAIM key g c claimIdleMs <cursor> COUNT 100, looped until nextId == '0-0'   // entries left under another consumer name
  for e in sortById(pending): await deliver(e, redelivered = true)
  loop: batch = XREADGROUP GROUP g c COUNT 32 STREAMS key '>'; empty → idle until kicked; for e in batch: await deliver(e, redelivered = false)
ack(id): MULTI XACK, XDEL; depth--, globalDepth--
```

- **node-redis v5 signatures** (https://github.com/redis/node-redis/tree/master/packages/client/lib/commands):
  - `xReadGroup(group, consumer, { key, id }, { COUNT })`
  - `xAutoClaim(key, group, consumer, minIdleTime, start, { COUNT })`, which returns `{ nextId, messages, deletedMessages }`
  - `xAdd(key, id, fields, options)`
- **XAUTOCLAIM** (Redis ≥ 6.2) also removes PEL ids whose entries were deleted, and reports them (Redis ≥ 7.0) (https://redis.io/docs/latest/commands/xautoclaim/).
- **Connection errors:** the pump stops, emits `error QUEUE_UNAVAILABLE`, and retries with backoff 1, 2, 4 … 30 s.
- **Why redelivery is safe:**
  - A crash after `journal.append` but before `XACK` → the entry is redelivered, dedupe recognises it (acking the sender if still connected), and it is acked again.
  - A crash before the journal write → the entry is uncommitted, and its epoch is in the lineage (§8.6), so it is rebased and applied exactly once.
- **Tests** (real Redis and Valkey in CI): limits; FIFO across a restart; a kill between journal and `XACK` gives no duplicate op; a backlog after restart triggers `onBacklog` and drains before new submits.

### 9.4 KafkaQueue — V3 (CL-11, `@confluentinc/kafka-javascript`, KafkaJS-compatible API)

```ts
interface KafkaQueueConfig {
  type: 'kafka'; perDocument?: number; global?: number;
  kafkaJS: { brokers: string[]; clientId?: string; ssl?: boolean; sasl?: unknown };   // passed inside the `kafkaJS` block
  librdkafka?: Record<string, string | number | boolean>;                             // passed through outside the block
  topic?: string;        // 'open-docex.incoming'; must already exist (checked at start with admin.fetchTopicMetadata; missing → CONFIG_INVALID)
  groupId?: string;      // 'open-docex-core'
}
```
```ts
const { Kafka } = (await import('@confluentinc/kafka-javascript')).KafkaJS;
kafka = new Kafka({ kafkaJS: cfg.kafkaJS, ...cfg.librdkafka });
producer = kafka.producer({ kafkaJS: { acks: -1, idempotent: true, maxInFlightRequests: 5 } });   // idempotence needs ≤ 5 in flight
consumer = kafka.consumer({ kafkaJS: { groupId, fromBeginning: true, autoCommit: false } });
```

API source: https://github.com/confluentinc/confluent-kafka-javascript/blob/master/MIGRATION.md.

- **Layout:** a single topic. The message key is the `documentId`, so all of a document's messages land on one partition, in order; librdkafka's partitioner is consistent per key. The value is the same JSON as the Redis field `e`.
- **Produce:** check the local limits, then `await producer.send({ topic, messages: [{ key, value }] })`. Return `{ok:true}` only after `acks=all`. A send error gives `QUEUE_UNAVAILABLE`.
- **Consume:** `consumer.run({ eachMessage })` puts each message on its document's in-memory deque and returns at once. Documents that share a partition still run in parallel.
- **Backpressure:**
  - When buffered plus in-process items reach `global`, call `consumer.pause([{ topic, partitions: [p] }])`. Resume below `global / 2`.
  - Pausing works only once partitions are assigned, so it is called from inside `eachMessage` (MIGRATION.md).
- **Offsets:**
  - Each partition keeps a sorted set of in-process offsets.
  - The committable offset is the lowest offset still in process, or `highestSeen + 1` when nothing is in process. This is Kafka's "next offset to read" convention (https://kafka.js.org/docs/consuming: store `offset + 1`).
  - `consumer.commitOffsets([{ topic, partition, offset: String(o) }])` runs at most every 100 ms per partition (LLD choice), and once more in `close()`.
- **Restart:** the group resumes from the committed offsets, so messages after them are delivered again.
  - The adapter cannot tell which of them it saw before the crash. It flags every message read before its own first commit as `redelivered = true`.
  - Dedupe and lineage then make redelivery safe, exactly as in §9.3.
  - The first message for a document that has no consumer triggers `onBacklog`.
- **Tests:** Kafka in CI, plus the S6 install test: per-document order with two documents on one partition; the commit low-watermark when acks complete out of order; crash replay without duplicates; pause and resume.

---

## 10. Persistence (`persistence/*`) — V1

### 10.1 Layout (HLD §14: names are hashes, never raw input)

```
<dataDir>/
  LOCK                                {pid, hostname, startedAt} (§7)
  LAYOUT                              "1"; a higher value → CONFIG_DATA_DIR_UNWRITABLE ("written by a newer version")
  docs/<k0k1>/<docKey>/               docKey = sha256hex(utf8(documentId)); k0k1 = its first 2 hex chars
      meta.json                       MetaStore (§10.4)
      snapshot.json                   SnapshotStore (§10.3)
      journal/<fromRev:012d>.ndjson   Journal segments (§10.2)
      assets/<sha256hex>              AssetStore (§10.5), content-addressed per document
  local-storage/                      default LocalFsStorage root when no adopter storage is configured [§4]
  tmp/                                conversions, LibreOffice profile slots, upload parts (emptied at boot)
```

`atomic-file.ts` provides `writeFileAtomic(path, data)`:
1. Write `path.tmp-<rand>` with flag `'wx'` and mode 0o600.
2. `datasync()` the file, then close it.
3. `rename` it over `path`. On Windows, retry up to 3 × 50 ms on `EPERM`, `EBUSY` or `EACCES`, because antivirus may lock the file (LLD choice).
4. On POSIX, also `fsync` the parent directory. Windows cannot open a directory for this, so the step is skipped there.

### 10.2 Journal (`journal.ts`)

```ts
interface JournalEntry { f: number; r: number;     // fromRev; toRev = f + o.length
  c: ClientId; q: number; u: string; t: number;     // clientId, clientSeq, userId, time in ms
  x: boolean; o: unknown[] }                        // transformed (the ack echoes `committed`); applied ops
class Journal {
  static open(dir: string, p: { fsync: 'interval' | 'always' }): Promise<Journal>;
  append(e: JournalEntry): Promise<void>;           // resolves according to the fsync policy; calls never overlap
  rotate(atRev: number): Promise<void>;             // close the current segment; open <atRev>.ndjson
  trimBefore(rev: number): Promise<void>;           // delete whole segments whose last r < rev
  read(): AsyncIterable<JournalEntry>;              // in order, checksums verified
  datasync(): Promise<void>; close(): Promise<void>;
}
```

- **Line format:** `{"k":"<crc32 hex>","e":<entry JSON>}\n`, where `k = zlib.crc32(entryJson)`. `zlib.crc32` exists since Node 22.2 (https://nodejs.org/api/zlib.html#zlibcrc32data-value). Building a line costs one `JSON.stringify`.
- **Writing:**
  - The file handle is opened with flag `'a'`. Each append is `await fh.write(buf)`; with fsync `'always'`, it is followed by `await fh.datasync()`.
  - Writes never overlap: Node warns that concurrent `filehandle.write()` calls on one file are unsafe (https://nodejs.org/api/fs.html#filehandlewritebuffer-offset-length-position).
  - `append` runs only from the serial instance loop. `rotate`, `trimBefore` and the fsync timer share a per-journal mutex.
- **fsync policy (CL-5):**
  - `'interval'`: one Core-wide timer, every `fsyncIntervalMs`, calls `datasync()` on every journal written since its last sync. `'always'`: the sync happens inside `append`.
  - A resolved write already survives a process crash; `datasync` adds survival of an OS crash.
  - `datasync` skips metadata, which an append does not need. A new segment is made durable with a directory fsync (POSIX).
- **Reading and repair:**
  - A torn last line (no newline, bad JSON or bad CRC) is truncated away, with a warning.
  - A bad line anywhere else fails the load with `DOCUMENT_FAULTED`, and the file is kept.
- **Tests:** append/read round trip; torn-tail repair; mid-file corruption; rotate and trim; with `'always'`, exactly one `datasync` per append (spy).

### 10.3 SnapshotStore and compaction (`snapshot-store.ts`)

```ts
interface SnapshotFile { v: 1; kind: DocKind; rev: number; savedAt: number; model: unknown /* ot.serializeSnapshot */; dedupe: Array<[ClientId, number, number]> }
class SnapshotStore { read(docKey: string): Promise<SnapshotFile | null>; write(docKey: string, f: SnapshotFile): Promise<void> /* atomic */ }
```

`snapshotAndRotate()` runs inside the instance loop every `snapshot.everyOps` ops (HLD §10.3):
1. `journal.rotate(rev)`.
2. Atomic `snapshotStore.write`.
3. `journal.trimBefore(rev - historyMaxOps)`.
4. `opsSinceSnapshot = 0`.

Step 3 keeps a journal tail behind the snapshot. After a restart, the history window therefore still covers recent `baseRev`s for V3 redelivery (LLD choice).

If the Core crashes between rotate and snapshot, the old snapshot and all segments are still there, so replay stays correct.

### 10.4 MetaStore (`meta-store.ts`)

```ts
interface DocumentMeta {
  schema: 1; documentId: DocumentId; kind: DocKind; format: FileFormat; ref: StorageRef;   // ref must be JSON-serializable
  storageState: 'NORMAL' | 'LOCAL' | 'CHECK' | 'PENDING' | 'CONFLICT';
  lastKnownVersion: StorageVersion | null;            // version after our last successful read or write
  lastFlushedRev: number; rev: number;                // rev: the last rev written into meta (on flush, state change, snapshot)
  retryCount: number; nextRetryAt: number | null; localSince: number | null;   // retryCount is 0..3
  lastError?: { code: ErrorCode; message: string; at: number };
  conflict?: { detectedAt: number; storageVersion: StorageVersion | null };
  readOnly: { findings: UnsupportedFinding[]; allowedEdit: boolean };
  lineage: Array<{ epoch: string; fromRev: number }>; // V3 (§8.6), at most 32 entries
  createdAt: number; updatedAt: number;
}
class MetaStore { loadAll(): Promise<void>; get(docKey: string): DocumentMeta | undefined; put(m: DocumentMeta): Promise<void>; list(): DocumentMeta[] }
```

- `loadAll()` scans `docs/*/*/meta.json` at boot.
- `put` writes atomically and is serialized per docKey.
- A `meta.json` that does not parse is logged and skipped; its folder is never deleted.

### 10.5 AssetStore (`asset-store.ts`)

```ts
type AssetMime = 'image/png' | 'image/jpeg' | 'image/gif';   // PO-24
class AssetStore {
  put(docKey: string, bytes: Uint8Array): Promise<{ id: string; mime: AssetMime }>;      // id = sha256hex; idempotent; atomic
  get(docKey: string, id: string): Promise<{ bytes: Uint8Array; mime: AssetMime } | null>;   // id must match /^[0-9a-f]{64}$/
  dir(docKey: string): string;                                                           // passed to codec threads
}
```

Assets are not garbage-collected before V6 (YAGNI).

---

## 11. StorageAdapter (`storage/*`) — V1 (PO-8, [A5])

### 11.1 Port

```ts
type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
type StorageRef = string | { readonly [k: string]: JsonValue };   // adopter-defined and opaque; must survive IPC and JSON
type StorageVersion = string;    // ETag, version id or similar; compared only for equality; must change whenever the content changes
interface StorageStat { version: StorageVersion; size: number }
interface StorageReadResult { bytes: Uint8Array; version: StorageVersion }
type StorageWriteResult = { ok: true; version: StorageVersion } | { ok: false; reason: 'conflict'; currentVersion?: StorageVersion };
interface StorageCreateInput { kind: DocKind; format: FileFormat; name: string; bytes: Uint8Array }
interface StorageAdapter {
  read(ref: StorageRef, o: { signal: AbortSignal; maxBytes: number }): Promise<StorageReadResult | null>;   // null = not found
  write(ref: StorageRef, bytes: Uint8Array, o: { expectedVersion: StorageVersion | null; signal: AbortSignal }): Promise<StorageWriteResult>;
  stat(ref: StorageRef, o: { signal: AbortSignal }): Promise<StorageStat | null>;                           // null = not found
  create(input: StorageCreateInput, o: { signal: AbortSignal }): Promise<{ ref: StorageRef; version: StorageVersion }>;
}
```

Rules for adapter authors:
- `write` must compare `expectedVersion` with the current version, and return a conflict when they differ. `null` means the target must not exist.
- Any throw counts as a failure: `STORAGE_READ_FAILED` or `STORAGE_WRITE_FAILED`, with the throw as `cause`.
- The engine aborts every call after 60 s (LLD choice) and treats the abort as a failure.

### 11.2 LocalFsStorage (`local-fs-storage.ts`)

```ts
class LocalFsStorage implements StorageAdapter { constructor(o: { root: string }) }   // ref: a relative path with '/' separators
```

**Path confinement (HLD §14).** `resolveRef(ref)` checks, in order:
1. `ref` is a string of 1–1024 characters, with no `\0`, no `\`, no drive letter, and not absolute.
2. No path segment is `..`, and none matches `/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i` (Windows reserved names).
3. `abs = path.resolve(rootReal, ref)`.
4. `rel = path.relative(rootReal, realpath(nearest existing ancestor) + remainder)`. Reject when `rel` is empty, starts with `..`, or is absolute. This also catches symlink escapes. On Windows the comparison is case-insensitive.

Every rejection gives `DOCUMENT_NOT_FOUND` with a generic message; the reason is logged only.

**Operations:**
- **Version:** `${mtimeNs}:${size}`, from `fs.stat(abs, { bigint: true })`. Nanosecond mtimes still tell apart two writes in the same millisecond (LLD choice).
- **`write`:**
  1. Write `.<name>.<rand>.tmp` in the same folder and `datasync` it.
  2. `stat` the target and compare with `expectedVersion`. On a mismatch, remove the temp file and return a conflict.
  3. Rename over the target and return the new version.
  
  The gap between `stat` and `rename` is not atomic. Only outside editors can race it (documented).
- **`create`:** the file name is `sanitize(name)` (only `[\p{L}\p{N} ._-]`, at most 100 characters), plus `-<8 hex>.<format>`, written with flag `'wx'`. The returned `ref` is the relative path.

### 11.3 StorageRouter (`storage-router.ts`)

`route(ref)`:
- no adopter storage → `LocalFsStorage(<dataDir>/local-storage)`; refs are plain strings
- a ref shaped `{ $local: string }` → the built-in local adapter
- everything else → the adopter's adapter

**Tests**
- Unit: traversal cases (`../`, a literal `%2e%2e`, absolute paths, `C:\`, a symlink escape, reserved names); conflict detection; `create` naming.
- `backend/test-kit/storage-conformance.ts` is an exported conformance suite that adopters can run against their own adapter (LLD choice).

---

## 12. FlushScheduler (`flush/flush-scheduler.ts`) — V1 [A5]

```ts
class FlushScheduler {
  constructor(d: { codec: CodecService; router: StorageRouter; meta: MetaStore; recovery: RecoveryManager; clock: Clock; quietMs: number; maxIntervalMs: number });
  markDirty(inst: DocumentInstance): void;
  flushNow(inst: DocumentInstance, o?: { timeoutMs?: number }): Promise<'clean' | 'flushed' | 'skipped' | 'failed'>;
  flushAll(deadline: number): Promise<void>;       // shutdown, best effort
}
// per instance: { dirtySince: number | null; lastOpAt: number; timer?: TimerHandle; running: boolean; again: boolean }
```

**Scheduling:**
- `markDirty` sets `lastOpAt = now` and, if unset, `dirtySince = now`.
- One timer per dirty instance fires at `min(lastOpAt + quietMs, dirtySince + maxIntervalMs)`. When it fires early it re-arms itself, so constant typing causes no timer churn.

```
flush(inst):
  if running: again = true; return
  if meta.storageState != NORMAL: return 'skipped'                         // RecoveryManager owns writes outside NORMAL
  { rev: F, model } = inst.currentSnapshot(); if F == meta.lastFlushedRev: mark clean; return 'clean'
  running = true
  bytes = await codec.export({ kind, format, model: ot.serializeSnapshot(model), assetDir })
          catch CONVERSION_*: emit error; stay dirty; re-arm at now + quietMs; return 'failed'
  res = await router.route(ref).write(ref, bytes, { expectedVersion: meta.lastKnownVersion, signal })
          catch e: recovery.onWriteFailed(inst, engineError(STORAGE_WRITE_FAILED, { cause: e })); return 'failed'   // → LOCAL
  if !res.ok: recovery.onConflict(inst, res.currentVersion); return 'failed'                                         // → CONFLICT (Q5)
  meta.lastKnownVersion = res.version; meta.lastFlushedRev = meta.rev = F; await meta.put()
  post-success trim: if inst.opsSinceSnapshot > 0, ask the loop for snapshotAndRotate(); journal.trimBefore(min(F, snapshotRev) - historyMaxOps)
  dirtySince = inst.rev > F ? now : null; running = false; if again or dirtySince: re-arm
```

The instance keeps processing ops during an export, because the export reads the immutable snapshot taken at `F`.

**Tests** (fake clock and storage): the quiet period; the maximum interval under constant typing; no overlapping flushes; retry after a conversion failure; a write failure calls `onWriteFailed`; a conflict calls `onConflict`; the trim happens only after success.

---

## 13. RecoveryManager (`recovery/recovery-manager.ts`) — V1 (HLD §11.3, [§4][§5][A4])

```ts
class RecoveryManager {
  constructor(d: { meta: MetaStore; registry: DocumentRegistry; codec: CodecService; router: StorageRouter; emit: CoreEmit; clock: Clock; delays: readonly [number, number, number] });
  onWriteFailed(inst: DocumentInstance, err: OpenDocexError): Promise<void>; onConflict(inst: DocumentInstance, v?: StorageVersion): Promise<void>;
  list(): RecoveryEntry[]; retry(id: DocumentId): Promise<RecoveryEntry>; readLocalCopy(id: DocumentId): Promise<LocalCopy>;
  resolve(id: DocumentId, r: RecoveryResolution): Promise<RecoveryEntry>; resumeAfterBoot(): void;
}
```

**State machine.** Each transition writes meta first, then sends the `notice` to the document's sessions, then emits the `storage` event. `d` is `recovery.retryDelaysMs`.

| From | Trigger | Action | To | Event · notice |
|---|---|---|---|---|
| NORMAL | the flush write throws | `retryCount = 0`, `localSince = now`, `nextRetryAt = now + d[0]`; arm the timer | LOCAL | `storage local`, plus `error STORAGE_LOCAL_MODE` (warning; cause = the write error) · `local` |
| LOCAL | the timer fires, or `retry()` | `st = stat(ref)` | CHECK | — |
| CHECK | `stat` throws and, after `retryCount++`, `retryCount < 3` | `nextRetryAt = now + d[retryCount]` | LOCAL | log only (the diagram's LOCAL→LOCAL) |
| CHECK | `stat` throws and `retryCount` reaches 3 | `nextRetryAt = null` | PENDING | `storage pending`, plus `error STORAGE_PENDING` · `pending` |
| CHECK | `st.version == lastKnownVersion` | export the local model; `write(expectedVersion = lastKnownVersion)`; on ok, update `lastKnownVersion` and `lastFlushedRev`, set `retryCount = 0` and `localSince = null` | NORMAL | `storage recovered` · `normal` |
| CHECK | the write-back above throws | counts as a failed attempt (as in the two `stat` rows) | LOCAL / PENDING | (Q5) |
| CHECK | `st == null` (deleted), versions differ, or the write returns a conflict | `conflict = { detectedAt, storageVersion }` | CONFLICT | `storage conflict`, plus `error STORAGE_CONFLICT` · `pending` |
| NORMAL | the flush write returns a conflict | as the row above | CONFLICT | as above (Q5) |
| PENDING | adopter `retry()` | one CHECK attempt; if storage is still unreachable, return to PENDING with `retryCount` unchanged | NORMAL / CONFLICT / PENDING | as above |
| CONFLICT, PENDING | `resolve('overwrite-storage')` | export; `write(expectedVersion = stat().version)`; on ok, reset meta | NORMAL | `storage recovered` · `normal` |
| CONFLICT, PENDING | `resolve('discard-local')` | `instance.reloadFromStorage()`: fresh import; sessions get `resync` plus a full load. The old snapshot and journal are deleted only **after** the new snapshot is durable. | NORMAL | `storage recovered` · `normal` |
| CONFLICT | `retry()` | reject with `STORAGE_CONFLICT`: a decision is needed | CONFLICT | — |
| NORMAL | `retry()` or `resolve()` | no-op; returns the entry | NORMAL | — |

**Invariants:**
- Editing continues in every state.
- Local snapshots and journal compaction carry on as usual. The local snapshot plus journal **is** the durable local copy [§4].
- The engine deletes local state only on an explicit `resolve('discard-local')` [§5].

**Adopter actions:**
- `list()` returns every meta entry whose state is not NORMAL.
- `readLocalCopy(id)`: `registry.getOrLoad` (local state), then `codec.export(currentSnapshot())`, returning `{ bytes, format, rev }`. An unknown id gives `DOCUMENT_NOT_FOUND`.
- `retry` and `resolve` load the instance through `getOrLoad` when needed, using the `ref` and `format` stored in meta.

**Timers and concurrency:**
- One timer per document in LOCAL.
- At most one CHECK runs per document (a per-document promise); a `retry()` during a CHECK awaits it.
- `FlushScheduler` never writes outside NORMAL, so its writes and recovery writes never overlap.

**After a restart** (`resumeAfterBoot`, boot step 8):

| State in meta | Action |
|---|---|
| LOCAL | arm the timer at `max(nextRetryAt, now + 5 s)` (LLD choice: lets storage clients settle) |
| CHECK (the Core crashed mid-check) | treat as LOCAL with the same `retryCount`; attempt at `now + 5 s` |
| PENDING, CONFLICT | no automatic action; re-emit `storage pending` or `conflict` once (LLD choice) |
| NORMAL, with `localRev > lastFlushedRev` | `getOrLoad` from local state, then `flush.markDirty` (HLD §10.5 step 3) |

`localRev` is the snapshot rev advanced by the last journal entry. Boot reads only the tail line of the last segment.

**Tests**
- Unit (fake clock and storage):
  - every row of the state machine, with delays of 1, 5 and 15 minutes
  - a restart in each state
  - `discard-local` never deletes before the new snapshot is durable
  - the NORMAL → CONFLICT edge
  - notices and events come in order
- Integration: storage goes down, editing continues, storage comes back, and the stored file equals the local model; the conflict path.

---

## 14. CodecService (`codec/*`) — V1 text, V2 sheet (CL-3, CL-4)

### 14.1 Service and pool

```ts
interface ImportResult { kind: DocKind; snapshot: unknown /* for ot.deserializeSnapshot */; findings: UnsupportedFinding[]; assetIds: string[] }
interface CodecService {
  import(i: { bytes: Uint8Array; format: FileFormat; assetDir: string }): Promise<ImportResult>;
  export(i: { kind: DocKind; format: FileFormat; model: unknown; assetDir: string }): Promise<Uint8Array>;
  probe(): Promise<void>; close(): Promise<void>;
}
class CodecPool { constructor(o: { size: number; entry: URL; logger: Logger }); run<R>(job: CodecJob, transfer?: ArrayBuffer[]): Promise<R>; close(): Promise<void> }
type CodecJob =
  | { op: 'import'; format: FileFormat; inPath: string; workDir: string; profileDir: string; assetDir: string; limits: CodecLimits }
  | { op: 'export'; kind: DocKind; format: FileFormat; modelJson: string; workDir: string; profileDir: string; assetDir: string; limits: CodecLimits }
  | { op: 'probe'; workDir: string; profileDir: string; limits: CodecLimits };
interface CodecLimits { soffice: string; timeoutMs: number; maxFlatXmlBytes: number; maxFileBytes: number }
```

**Pipeline** (Core thread):
1. `zipGuard` (§14.8).
2. Write the input to `tmp/<rand>/in.<format>`.
3. `permit = await loSemaphore.acquire()`. There are `maxConcurrent` permits, and each permit is one LibreOffice profile slot.
4. `pool.run(job)`.
5. Release the permit and remove the work folder.
6. Import only: `ot.deserializeSnapshot(result.snapshot)`. This validates the mapper's output against the schema; a failure is `CONVERSION_FAILED`.

The permit covers the whole job, XML mapping included (KISS, LLD choice).

**Pool:**
- `codecThreads` workers. Each job goes to the thread with the fewest jobs in flight. A thread may run several jobs at once, since it mostly waits on LibreOffice.
- Results are returned as transferred `ArrayBuffer`s, which move instead of being copied (https://nodejs.org/api/worker_threads.html#portpostmessagevalue-transferlist).
- A thread `'error'` terminates that worker (https://nodejs.org/api/worker_threads.html#event-error). Its jobs reject with `CONVERSION_FAILED`, and a new thread replaces it.
- Threads read and write the document's `assetDir` directly. Images never cross threads as copies.

### 14.2 LibreOfficeRunner (`libreoffice-runner.ts`, inside codec threads)

```ts
type LoTarget = 'fodt' | 'fods' | 'docx' | 'odt' | 'xlsx' | 'ods';
const FILTER: Record<LoTarget, string> = { fodt: 'OpenDocument Text Flat XML', fods: 'OpenDocument Spreadsheet Flat XML',
  docx: 'MS Word 2007 XML', xlsx: 'Calc MS Excel 2007 XML', odt: 'writer8', ods: 'calc8' };   // help.libreoffice.org …/guide/convertfilters.html
interface LibreOfficeRunner { convert(i: { soffice: string; inPath: string; outDir: string; target: LoTarget; profileDir: string; timeoutMs: number }): Promise<string> }
```
```
args = [`-env:UserInstallation=${pathToFileURL(profileDir).href}`, '--headless', '--invisible', '--norestore', '--nologo', '--nodefault',
        '--nolockcheck', '--convert-to', `${target}:${FILTER[target]}`, '--outdir', outDir, inPath]
child = spawn(soffice, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: platform != 'win32', env: loEnv })
keep the last 4 KiB of stderr (logged; never sent to clients)
timeout → killTree(child); reject CONVERSION_TIMEOUT; mark the profile slot for reset
on exit: out = join(outDir, basename(inPath, extname(inPath)) + '.' + target); missing or empty → CONVERSION_FAILED
killTree: POSIX → process.kill(-child.pid, 'SIGKILL')   (detached gives a process group: soffice → oosplash → soffice.bin)
          Windows → spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false })   (child.kill would not reach soffice.bin)
```

- **Profile path:** `-env:` sets a bootstrap variable, and `UserInstallation` selects the profile directory (https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html).
- **Exit code:** the code is not trusted. LibreOffice exits with 0 even after "source file could not be loaded" (https://ask.libreoffice.org/t/error-source-file-could-not-be-loaded-from-libreoffice-headless-convert-to-pdf-some-odt/26563). Success is judged by the output file instead.
- **Environment:** `loEnv` is `process.env` with `HOME` (POSIX) pointed at `profileDir` (LLD choice).
- **Command injection (HLD §14):** arguments are always an array, a shell is never used, and every file name is generated.

**Locating the binary** (`libreoffice-locate.ts`): a configured `libreoffice.path` wins. Otherwise, the first candidate that exists:

| Platform | Candidates |
|---|---|
| Linux | `/usr/bin/soffice`; `/usr/lib/libreoffice/program/soffice`; `/opt/libreoffice*/program/soffice` (newest by name); `/snap/bin/libreoffice`; `soffice` on `PATH` |
| Windows | `%ProgramFiles%\LibreOffice\program\soffice.exe`; `%ProgramFiles(x86)%\LibreOffice\program\soffice.exe`; `soffice.exe` on `PATH` |
| macOS (development) | `/Applications/LibreOffice.app/Contents/MacOS/soffice` |

The boot probe (§7) proves that the binary works headless. Spike S2 confirms that `soffice.exe` blocks until the conversion ends.

### 14.3 Profile slots (`lo-profile.ts`)

- **Slots:** one folder per permit, `tmp/lo/slot-<n>` for `n` in `0..maxConcurrent-1`.
  - The semaphore gives each slot to one conversion at a time, so concurrent conversions never share a profile (HLD §6).
  - Slots are reused, avoiding LibreOffice's first-start cost (LLD choice).
  - A slot is re-created at boot, and after any timeout or kill.
- **Seeded settings:** each slot gets `user/registrymodifications.xcu`:

```xml
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>1</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="ODFRecalcMode" oor:op="fuse"><value>1</value></prop></item>
```

- `DisableMacrosExecution=true` overrides the macro security level and disables Basic, BeanShell, JavaScript and Python (https://bugs.documentfoundation.org/show_bug.cgi?id=154625).
- Spike S2 must verify the external-link blocking and the "never recalculate" modes before we rely on them. "Never recalculate" keeps cells at their last saved values, as CL-16 requires.

### 14.4 XML reading and hardening (`xml-reader.ts`)

- **Parser:** `htmlparser2`'s `Parser` with `{ xmlMode: true, decodeEntities: true, recognizeSelfClosing: true }`, fed from `fs.createReadStream` through `write()` and `end()` (https://github.com/fb55/htmlparser2/blob/master/src/Parser.ts).
- **No DTDs or entities:**
  - A `<!DOCTYPE` or `<!ENTITY` is reported through `onprocessinginstruction('!doctype' | '!entity', …)`, and parsing aborts with `CONVERSION_FAILED`.
  - The parser has no DTD support, and decodes only the predefined and numeric entities. External entities and entity expansion are therefore impossible.
- **Caps (LLD choice):**
  - flat XML larger than `maxFlatXmlBytes = 4 × maxFileBytes` → `DOCUMENT_TOO_LARGE` (base64 images inflate the XML)
  - element depth over 256 → `CONVERSION_FAILED`
  - more than 256 attributes on one element → `CONVERSION_FAILED`
- **Namespaces:** a resolver tracks `xmlns:*` declarations on a stack and maps every name to a canonical `prefix:local`, so mapping never depends on the prefixes LibreOffice happens to write. The canonical prefixes are `office`, `style`, `text`, `table`, `draw`, `fo`, `svg`, `xlink`, `number`, `config`, `calcext`, `loext` and `of`.
- **Images:** the text of `office:binary-data` is base64-decoded incrementally, hashed with SHA-256, MIME-sniffed, and written to `assetDir`.
- **Structure:** `XmlReader` builds small trees (`{ name, attrs, children, text }`) only for `office:styles`, `office:automatic-styles`, `office:master-styles` and `office:settings`. Body elements stream to the mapper as SAX-style events, so a huge body never becomes a full DOM.

### 14.5 FodtMapper (`fodt-mapper.ts`) — V1

```ts
interface FodtMapper {
  read(xml: XmlReader, sink: { asset(bytes: Uint8Array): Promise<string> }): Promise<{ doc: unknown /* textSchema JSON */; findings: UnsupportedFinding[] }>;
  write(docJson: unknown, assets: { get(id: string): Promise<{ bytes: Uint8Array; mime: string }> }, out: Writable): Promise<void>;
}
```

- **Style resolution:**
  - A run's effective properties are layered: `style:default-style`, then the paragraph's named-style chain (`style:parent-style-name`), then the paragraph's automatic style, then the text-style chain, then the span's automatic style.
  - A `text_style(fontFamily, fontSize, color)` mark is emitted only where the effective value differs from the document defaults. The defaults go in the doc attribute proposed in N6; if Part 1 declines N6, every run carries its resolved values.
  - Properties that come from `Heading_20_n` styles never become marks; the heading level carries them (LLD choice).
- **Units** (`odf-units.ts`): `cm`, `mm`, `in`, `pt`, `pc` and `px` are converted to the units Part 1 uses for `PageSettings` and image sizes. Any other unit is `CONVERSION_FAILED`.

| Flat ODF | Model (HLD §8.1) | Written back on export |
|---|---|---|
| The master page in use → its `style:page-layout-properties` (`fo:page-width`, `fo:page-height`, `style:print-orientation`, `fo:margin-*`) | doc attributes `PageSettings { size, orientation, margins }` (CL-9) | one page layout `pm1` plus master page `Standard` |
| That master page's `style:header` / `style:footer` | `header` / `footer` nodes | inside the master page |
| `text:p` with `fo:text-align` (`start`/`left` → left; `center`; `end`/`right` → right; `justify`) | `paragraph(alignment)` | automatic paragraph style `P<n>` |
| `text:h` with `text:outline-level` 1–6 | `heading(level)` | `text:h` with style `Heading_20_n` |
| `text:list` with list-level style bullet or number; `text:list-item` | `bullet_list` / `ordered_list` / `list_item`, nested | `text:list` with list styles `L_bullet` / `L_number` |
| `text:span` text properties: `fo:font-weight=bold`; `fo:font-style=italic`; underline style ≠ `none`; line-through style ≠ `none`; font name or family; `fo:font-size`; `fo:color` | marks `bold`, `italic`, `underline`, `strike`, `text_style` | automatic text styles `T<n>`; one span per run of identical marks |
| `text:a` with `xlink:href` (http, https, mailto) | `link(href)` | `text:a xlink:type="simple"` |
| `text:line-break` | `hard_break` | `text:line-break` |
| `text:tab` | `\t` inside the text (LLD choice) | `text:tab` |
| `text:s` (`text:c=n`); whitespace collapsed per ODF | spaces | `text:s` for runs of 2+ spaces and for leading spaces |
| `fo:break-before="page"` / `fo:break-after="page"` on a paragraph style | a `page_break` node before or after the paragraph | `fo:break-before="page"` on the next paragraph; a trailing break gets an empty paragraph |
| `table:table`, `table:table-column` (widths), `table:table-header-rows`, `table:table-row`, `table:table-cell` (columns and rows spanned), `table:covered-table-cell` | `table`, `table_row`, `table_header` (cells in header rows), `table_cell` (`colspan`, `rowspan`, column widths per prosemirror-tables) | the same constructs, with covered-cell placeholders |
| A `draw:frame` (`svg:width`, `svg:height`, `svg:title`/`svg:desc`) holding `draw:image` with `office:binary-data`, alone in its paragraph | `image(assetId, alt, width, height)` | an `as-char` frame in its own paragraph, image embedded as base64 |
| `text:soft-page-break`, `text:sequence-decls`, empty `office:forms`, `text:bookmark*` named `_…` | ignored (proposed ignorable list, Q4) | not written |

**Export writer:**
- Streams `work/doc.fodt` with `office:version="1.3"` and the text MIME type.
- Text and attribute values are escaped; invalid XML characters (C0 controls other than tab, LF and CR) are stripped.
- `font-face-decls` lists only the fonts actually used.
- LibreOffice then converts the result to the target format (§14.2).

### 14.6 FodsMapper and formula conversion (`fods-mapper.ts`, `odf-formula.ts`) — V2

| Flat ODF | Model (HLD §8.2) |
|---|---|
| `table:table` with `table:name` | `Sheet { id, name }`. The `id` is a random id assigned at import and stable from then on (LLD). |
| `table:table-column` (`number-columns-repeated`, column width, `table:default-cell-style-name`) | `colWidths` (sparse) and the column's default style |
| `table:table-row` (`number-rows-repeated`, `style:row-height`) | `rowHeights` (sparse). Repeated empty rows are never expanded. |
| cell `office:value-type` | `Cell.v`:<br>• `float`, `percentage`, `currency` → the number in `office:value`<br>• `boolean` → `office:boolean-value`<br>• `date`, `time` → an Excel serial number (days since 1899-12-30), plus a date number format<br>• `string` → the text of its `text:p` elements, joined with `\n` |
| `table:formula="of:=…"` | `Cell.f` in Excel A1 syntax (below) |
| a cell style:<br>• table-cell properties (background, borders, wrap, vertical alignment)<br>• `fo:text-align`<br>• text properties (font, size, weight, style, underline, strike, colour)<br>• `style:data-style-name` → a `number:*` style → an Excel format code | `Style` (fields per Part 1) through `defineStyle`; `Cell.s` |
| `number-columns-spanned` / `number-rows-spanned` | `merges[]` |
| `office:settings`, under `Views` → `Tables` → the sheet's name: `HorizontalSplitMode=2` / `VerticalSplitMode=2` with their split positions | `frozen { rows, cols }` |
| the used area | `rowCount = max(lastUsedRow + 1, 1000)`; `colCount = max(lastUsedCol + 1, 26)` (LLD choice) |

The export writes the same constructs back:
- empty rows and columns are compressed with `number-*-repeated`
- cell text is `String(v)`
- frozen panes go into `office:settings`

**Formula conversion** is done with a tokenizer, never with regex replacement: `odfToA1(f, sheet)` and `a1ToOdf(f, sheet)`.

| ODF (`of:=`) | Excel A1 |
|---|---|
| `SUM([.A1:.B2])` | `SUM(A1:B2)` |
| `[.$A$1]` | `$A$1` |
| `[$Sheet2.A1]`, `['My Sheet'.A1]` | `Sheet2!A1`, `'My Sheet'!A1` |
| `[$S.A1:$S.B2]` (the same sheet at both ends) | `S!A1:B2`. Different sheets at the two ends give the finding `formula-3d-ref`. |
| `[.A:.A]`, `[.1:.1]` | `A:A`, `1:1` |
| any `#REF!` part | `#REF!` |
| argument separator `;` | `,` |
| array `{1;2\|3;4}` | `{1,2;3,4}` |
| `~` (union), `!` (intersection) | finding `formula-operator` |
| `COM.MICROSOFT.X(` | `X(`, for a known list. Any other namespaced function gives the finding `formula-function`. |

- **References:** a same-sheet reference is written `.A1`. A cross-sheet reference always gets an absolute sheet (`$Name.A1`), since Excel has no relative sheet references.
- **Literals:** strings (`""` escapes) pass through unchanged; numbers always use `.` as the decimal separator.
- **Tests:** the round trip `a1ToOdf(odfToA1(x)) ≡ x` on fixtures; `#REF!`; quoted sheet names with a doubled `'`.

### 14.7 UnsupportedDetector (`unsupported-detector.ts`) — V1 text, V2 sheet (PO-13, PO-14, PO-15, CL-9)

```ts
interface UnsupportedDetector { onElement(name: string, attrs: Readonly<Record<string, string>>, ctx: DetectCtx): void; finish(): UnsupportedFinding[] }
```

- The mappers call `onElement`. `finish()` groups findings as `{ feature, count, sample? }`, which maps onto Part 1's `UnsupportedFinding` (N7).
- `sample` is an element name, never document text.

| Feature | Signal |
|---|---|
| `tracked-changes` | `text:tracked-changes` with children |
| `comments` | `office:annotation` (text and sheet) |
| `footnotes` | `text:note` |
| `fields` | page number or count, date, time, author, file name, chapter, sequence, `*-ref`, variables, user fields, database fields, conditional or hidden text, placeholders |
| `toc-index` | `text:table-of-content`, `text:*-index`, `text:bibliography` |
| `text-box-shape` | `draw:text-box`, `draw:custom-shape`, `draw:rect`, `draw:line`, `draw:g`, … |
| `equation-object`, `chart` | `draw:object`, `draw:object-ole` (told apart by MIME) |
| `sections` | `text:section` |
| `multiple-page-styles` | more than one master page reachable from the body |
| `first-page-header-footer` | `style:header-first` / `style:footer-first` with content |
| `odd-even-header-footer` | `style:header-left` / `style:footer-left` not hidden with `style:display="false"` |
| `columns` | `fo:column-count > 1` |
| `heading-level` | outline level > 6 |
| `link-scheme` | `href` not http, https or mailto |
| `image-position` | an image mixed with text in a paragraph, or anchored to the page |
| `image-format` | MIME not in `AssetMime` (Q6) |
| `macros` | non-empty `office:scripts`; zip entries `vbaProject.bin` or `Basic/` |
| `form-controls` | `form:*` elements |
| `unknown-element` | any `text`, `table`, `draw` or `office` element that is neither mapped nor ignorable |
| V2 sheet features | each feature id → its ODF signal:<br>• `conditional-formatting` → `calcext:conditional-formats`, or `style:map`<br>• `data-validation` → `table:content-validations`<br>• `pivot` → `table:data-pilot-tables`<br>• `named-ranges` → a non-empty `table:named-expressions`<br>• `autofilter` → `table:database-range` with `table:filter`<br>• `array-formula` → `table:number-matrix-*-spanned`<br>• `protection` → `table:protected="true"`<br>• `hidden-rows-cols` → `table:visibility` other than visible<br>• `hidden-sheet` → `table:display="false"`<br>• `external-link` → `table:table-source`, or a formula with a file reference<br>• `rich-text-cell` → mixed span styles inside one cell<br>• `number-format` → a `number:*` style that cannot be mapped<br>• `formula-function`, `formula-operator`, `formula-3d-ref` → §14.6<br>• `sheet-images` → `draw:frame` inside `table:shapes` |

Whether formatting outside the schema (spacing, indentation, line height, borders) is a finding is open (Q4). Until the project owner decides, the detector has a constant `formattingPolicy: 'finding' | 'drop'`.

### 14.8 Zip guard (`zip-guard.ts`) — V1

`yauzl.fromBuffer(buf, { lazyEntries: true })` reads only the central directory. It runs on the Core thread, before any conversion.

| Check | Result on failure |
|---|---|
| size > `maxFileBytes` | `DOCUMENT_TOO_LARGE` |
| not a zip (for example an encrypted OOXML file, which is a CFB container) | `CONVERSION_FAILED` ("not a valid or unencrypted file") |
| more than 10 000 entries, or total `uncompressedSize` > 20 × `maxFileBytes`, or any entry's compression ratio > 200 | `DOCUMENT_TOO_LARGE` (LLD choice) |
| a required part is missing: docx `word/document.xml`; xlsx `xl/workbook.xml`; odt/ods `mimetype` (with the right content) and `content.xml` | `CONVERSION_FAILED` |
| `word/vbaProject.bin`, `xl/vbaProject.bin` or `Basic/` present | finding `macros` (macros are removed on save, PO-13) |

Declared sizes can lie; LibreOffice's timeout and kill bound the real cost.

**Codec tests**
- Integration (real LibreOffice in the CI image, plus the S2 corpus):
  - a round trip per format, for every row of §14.5 and §14.6
  - every detector row
  - a zip bomb and a DTD are rejected
  - a stub binary that sleeps is killed on timeout
  - profile slots are reused and reset
  - `taskkill` is used on Windows
- Unit: style resolution, units, the formula converter, the namespace resolver.

---

## 15. AuditEmitter (`audit/audit-emitter.ts`) — V1; sheet `superseded` V2 [§3][§6]

```ts
interface AuditEvent {
  documentId: DocumentId; kind: DocKind; rev: number; fromRev: number; at: number;
  userId: string; clientId: ClientId; clientSeq: number; sessionId: string | null;
  ops: readonly unknown[];                         // the applied (committed) ops
  superseded?: SupersededCell[];                   // sheets: previous values of cells this batch overwrote
}
interface SupersededCell { sheetId: string; row: number; col: number; previous: Cell | null }
class AuditEmitter { setEnabled(on: boolean): void; emit(e: AuditEvent): void }   // sends a CoreEvent 'emit' with event 'audit'
```

- **Order:** events come in FIFO order per document, after the ack and the broadcast (§8.4).
- **Superseded values (V2):** the sheet instance applies a batch one op at a time. Before each `setCells`, `policy.supersededOf(working, op)` reads the current cells. A later op in the same batch therefore reports the earlier op's value (the same-cell rule, HLD §8.3).
- **Delivery:** at-most-once (interim, Q7). Events in flight are lost if the Core crashes.

**Tests:** order; no IPC traffic while disabled; superseded values within one batch and across batches.

---

## 16. UploadService — V4 (HLD §10.6; signatures and flow)

```ts
interface UploadedContext { userId: string; ref: StorageRef; format: FileFormat; kind: DocKind; name: string; findings: UnsupportedFinding[] }
class UploadService {
  begin(r: SessionRecord, m: { uploadId: string; name: string; format: FileFormat; size: number }): Promise<void>;
  chunk(r: SessionRecord, uploadId: string, bytes: Uint8Array): Promise<void>;
  end(r: SessionRecord, uploadId: string, m: { sha256: string }): Promise<void>;
  abort(r: SessionRecord, uploadId: string): Promise<void>;
}
```

**Flow:**
1. **begin:** requires `size ≤ maxFileBytes`, else `DOCUMENT_TOO_LARGE`. Opens `tmp/upload-<rand>.part` with flag `'wx'`.
2. **chunk:** binary frames are appended. Going past the declared size aborts the upload with `DOCUMENT_TOO_LARGE`.
3. **end:** verify the SHA-256, run `zipGuard`, then `codec.import`. The import validates the file and collects findings; its model is discarded.
4. `storage.create({ kind, format, name, bytes })` with the original bytes, not a re-export, for full fidelity.
5. `side.hook('onUploaded', ctx)` makes main call `opts.onUploaded(ctx)`, which returns `{ documentId }`.
6. Send `upload-done { documentId }` to the session.

- The `.part` file is deleted on end, on abort, on session leave and at boot.
- Each session has at most one active upload (LLD choice).
- Which connection carries the upload, and how it is authorized, is open (Q8).
- **Tests:** a streamed 10 MiB file creates a document; oversize, a checksum mismatch and a zip bomb are rejected; leave deletes the part file.

---

## 17. AnnotationService and AnnotationStore — V5 (HLD §7; signatures and flow) [A8]

```ts
interface Annotation {
  id: string; kind: 'bookmark' | 'note'; anchorId: string;     // the anchor lives in the document model (Part 1 schema, synced by OT)
  authorUserId: string; body?: string; status?: 'open' | 'resolved'; parentId?: string;
  createdAt: number; updatedAt: number; version: string;
}
interface AnnotationStore {                                     // adopter port, set in WorkerConfig.annotations.store
  list(documentId: DocumentId, o: { signal: AbortSignal }): Promise<Annotation[]>;
  put(documentId: DocumentId, a: Omit<Annotation, 'version'>, o: { expectedVersion: string | null; signal: AbortSignal }):
    Promise<{ ok: true; version: string } | { ok: false; reason: 'conflict' }>;
  delete(documentId: DocumentId, id: string, o: { expectedVersion: string; signal: AbortSignal }): Promise<{ ok: boolean }>;
}
class AnnotationService { onMessage(r: SessionRecord, m: AnnotationClientMsg): Promise<void> }   // annotation-* messages (Part 1)
```

**Flow:**
- `annotation-list` calls `store.list` and replies to the session.
- `annotation-put` / `annotation-delete`:
  1. Only edit sessions may write (pending Q9).
  2. The anchor must exist in the current model (`policy.anchorExists`).
  3. Call `store.put` or `store.delete`.
  4. Broadcast `annotation-changed` to the document's sessions. This runs serially per document, on the instance's own promise chain, separate from the op queue.
- A store throw is sent to the sender as `STORAGE_WRITE_FAILED` (retryable). A conflict is `STORAGE_CONFLICT`.
- A note whose anchor was deleted by an edit is listed with `orphan: true` (LLD choice).
- **Tests:** with a fake store: put, broadcast and conflict; a view session is rejected; orphans are detected.

---

## 18. Concurrency summary

| Resource | Owner | How access is serialized |
|---|---|---|
| model, rev, history, dedupe | `DocumentInstance` loop | one delivery at a time per document (queue contract) |
| journal file handle | `Journal` | the instance loop, plus a per-journal mutex shared with the fsync timer, rotate and trim |
| `meta.json` | `MetaStore` | a promise chain per docKey |
| storage writes | `FlushScheduler` in NORMAL; `RecoveryManager` in every other state | per document; the state makes the two owners exclusive |
| LibreOffice processes | the `CodecService` semaphore | `maxConcurrent` permits, one per profile slot |
| session outbound | Gateway `SendQueue` | ws send order |
| session inbound when `canSubmit` is set | Gateway | a promise chain per session |
| IPC | `EngineChannel` | FIFO in each direction; `whenWritable` backpressure |

---

## 19. Errors

### 19.1 Helpers (`errors/engine-error.ts`)

```ts
function engineError(code: ErrorCode, d?: { message?: string; documentId?: string; instanceId?: string; cause?: unknown }): OpenDocexError;
function toWire(e: unknown): WireError;
```

- `toWire` wraps errors that are not `OpenDocexError`s:
  - inside an instance → `DOCUMENT_FAULTED`
  - during boot → `CONFIG_INVALID`
  - elsewhere → `DOCUMENT_FAULTED` when a document is involved; otherwise the error is only logged
- The original message travels as `causeMessage`.
- Every message to a client goes through Part 1's `toClientError`, which strips the cause, the remediation and stack traces (HLD §11.1).

### 19.2 Which module raises which code (HLD §11.2)

| Code | Raised by | Client sees |
|---|---|---|
| `CONFIG_INVALID` | `validateEngineOptions`; `resolveWorkerConfig`; a missing Kafka topic; a malformed `AuthorizeResult` (as an event); `sessions.close({})`; `documents.create` with a kind/format mismatch | HTTP 500, only for a malformed authorize result |
| `CONFIG_LIBREOFFICE_NOT_FOUND` | boot step 5 | — |
| `CONFIG_DATA_DIR_UNWRITABLE` | boot steps 2–3; a newer `LAYOUT` | — |
| `STORAGE_READ_FAILED` | `DocumentInstance.load` (`stat` or `read` throws) | `error` (retryable), then close |
| `STORAGE_WRITE_FAILED` | `FlushScheduler` (the cause of LOCAL); `documents.create`; `recovery.resolve`; `AnnotationService` | only for annotations |
| `STORAGE_LOCAL_MODE` / `STORAGE_PENDING` / `STORAGE_CONFLICT` | `RecoveryManager` transitions; `retry()` while in CONFLICT | `notice` storage `local` / `pending` / `pending` |
| `QUEUE_FULL` | `QueueAdapter.enqueue` | `error { retryable: true, clientSeq }` |
| `QUEUE_UNAVAILABLE` | the Redis and Kafka adapters; boot step 7 | `error { clientSeq }` |
| `ENGINE_RESTARTING` | the Supervisor, through the Gateway; channel unbind; API calls while restarting | close 4001 |
| `ENGINE_UNAVAILABLE` | Gateway, on an upgrade while FAILED | close code |
| `ENGINE_FAILED` | Supervisor (`fatal`); API calls while FAILED | — |
| `DOCUMENT_FAULTED` | `fault()`; journal corruption; load failures | `error`, then close |
| `DOCUMENT_UNSUPPORTED_CONTENT` | the `document unsupported` event; sheet formats in V1 | `load-start.unsupported`; in V1, `error` then close for sheets |
| `DOCUMENT_READ_ONLY` | `DocumentInstance` (a submit or asset-put while read-only) | `error { clientSeq }` |
| `DOCUMENT_NOT_FOUND` | `load` (`stat` or `read` returns null); `LocalFsStorage` confinement; an unknown id in an API call; `asset-get` | `error`, then close (`asset-get`: `error` only) |
| `DOCUMENT_TOO_LARGE` | the load size check; the zip guard; the flat-XML cap; upload | `error`, then close |
| `CONVERSION_FAILED` / `CONVERSION_TIMEOUT` | `LibreOfficeRunner`; `XmlReader`; the mappers; `deserializeSnapshot`; a codec thread crash; the zip guard | `error`, then close (on load only) |
| `SESSION_SLOW_CONSUMER` / `SESSION_CLOSED` | Gateway `SendQueue` / `sessions.close` and `shutdown` | close code |
| `SESSION_RESYNC_REQUIRED` | `DocumentInstance` on an epoch or rev mismatch; the reason carried in `resync` | `resync` |
| `ACCESS_DENIED` | Gateway (`authorize` returns null → 403; `canSubmit` false; `authorize` throws → event); `DocumentInstance` (a view session submits or puts an asset) | HTTP 403 / `error { clientSeq }` |
| `PROTOCOL_INVALID_MESSAGE` | Core frame dispatch (decode failure, a message before `hello`, `clientId` binding); hello timeout | `error`, or close |
| `PROTOCOL_VERSION_UNSUPPORTED` | `onHello` | `error`, then close |
| `PROTOCOL_OP_REJECTED` | instance step 5; asset MIME check; an unknown `assetId` | `error { clientSeq }` |

---

## 20. Security controls by module (HLD §14)

| Control | Where |
|---|---|
| Default deny; `authorize` runs before `handleUpgrade`; view sessions cannot submit; optional `canSubmit`; admin close | Gateway §4.2–§4.3; `onSubmit` and the loop (§8.4); `sessions.close` |
| No tokens, headers or query strings in logs | logger allowlist (§3); the Gateway logs only the path and the documentId |
| `maxPayload`; no permessage-deflate; hello timeout; ping | Gateway §4.1, §4.3 |
| Size limits before parsing; zip entry count and size caps | the load size check; zip guard §14.8; flat-XML cap §14.4 |
| No DTDs or entities; depth and attribute caps | `XmlReader` §14.4 |
| Macros disabled; temporary profile; timeout and tree kill; no shell; generated file names | `LibreOfficeRunner`, `lo-profile` (§14.2–§14.3) |
| Hashed local file names; `LocalFsStorage` path confinement | `layout.ts` (§10.1); §11.2 |
| Link `href` allowlist at import; images served only from the document's own asset store, with a MIME allowlist (the client enforces the rest, Part 3) | `FodtMapper` §14.5; `AssetStore` §10.5; instance asset handling §8.4 |
| `clientId` bound to the session (no dedupe poisoning) | §8.7 |
| Sanitized client errors | `toClientError` on every client send (§19.1) |
| Data folder permissions 0o700 / 0o600 (POSIX); data folder LOCK | §7, §10.1 |
| Supply chain: MIT, BSD and Apache-2.0 only (ISC-licensed XML parsers deliberately avoided); optional peers pinned by the adopter | `package.json`; CI licence check |

---

## 21. Test infrastructure

- **`backend/test-kit/`:**
  - `FakeStorage` (scriptable failures, versions and latency)
  - `FakeClock`
  - `FakeChannel`
  - `TestCore` (a fork entry that can crash, hang or stall on command)
  - `wsClient` (speaks the Part 1 protocol)
  - the storage conformance suite
- Every integration suite runs twice, in `mode: 'main'` and `mode: 'worker'` (HLD §17).
- Codec suites are tagged `@libreoffice` and run in the CI image that has LibreOffice installed.
- Redis/Valkey and Kafka suites are tagged `@v3` and run against service containers.

---

## 22. Open questions for the project owner — resolved in LLD §0.1–§0.2

| # | Question | Interim behaviour in this LLD |
|---|---|---|
| Q1 | HLD §10.1 says `null` closes the connection with "401/403". How should `authorize` pick between them? Options: always 403, or a denial variant such as `{ deny: 401 \| 403 }`. | `null` → 403 |
| Q2 | Which choices should `recovery.resolve` offer? The proposal is `'overwrite-storage'` (write the local copy over the changed file) and `'discard-local'` (reload from storage and drop the local copy). Is a third one needed, such as "the adopter saved it elsewhere, just mark it clean"? | the two choices above |
| Q3 | What does `engine.shareInfo(documentId)` return? The HLD gives no shape. | `{ documentId, loaded, kind?, sessions: { edit, view } }` |
| Q4 | **Import fidelity.** (a) Should formatting outside the schema (paragraph spacing, indentation, line height, borders, named-style details) make a document read-only, or be dropped silently on save? (b) May hidden `_…` bookmarks, soft page breaks and empty declarations be dropped silently? (c) HLD §8.1 lists fields as unsupported, but page-number fields in footers are very common, so many business documents would open read-only. Please confirm. | (a) undecided (detector constant); (b) the ignorable list in §14.5; (c) fields are findings, per the HLD |
| Q5 | Two §11.3 edges are not in the diagram. (a) When a normal flush finds the storage file changed, should the state go straight to CONFLICT? (b) When the write-back during CHECK fails, should it count as a failed retry (→ LOCAL or PENDING)? | (a) CONFLICT; (b) it counts as a failed retry |
| Q6 | Imported images in EMF, WMF, TIFF or SVG: should they be unsupported (read-only), or converted to PNG through LibreOffice? | unsupported (`image-format`) |
| Q7 | Is at-most-once audit delivery enough, or must the Core re-emit journal entries after a crash (at-least-once, with a `replayed` flag)? | at-most-once |
| Q8 | V4: there is no document yet when a user uploads. Which connection carries the upload, and how is it authorized? For example, `AuthorizeContext.purpose: 'document' \| 'upload'` with no `documentId`. | not designed beyond §16 |
| Q9 | V5: may view-only sessions add notes and reviews, or only read them? | edit sessions only |

---

## 23. New contract names — reconciled in LLD §0.3

| # | Name | Definition | Parts |
|---|---|---|---|
| N1 | `LoadStartMsg.readOnly: boolean` | The instance's effective read-only state (unsupported content not yet allowed). It tells "view session" apart from "read-only until Edit anyway", and lets the warning stay visible after edit is allowed. | 1, 3 |
| N2 | `LoadStartMsg.ackedClientSeq?: number` | The last committed `clientSeq` for the hello's `clientId`. After a resync the client drops pending ops up to this value before resubmitting. Without it, an op committed just before a crash, whose ack was lost, would be applied twice on the client. | 1, 3 |
| N3 | Resync semantics | `resync` is followed at once by a full load (`load-start` … `load-done`) on the same socket. The client sends no new `hello`. | 1, 3 |
| N4 | Same-epoch resume | For `hello.resume` with the current epoch and a rev inside the history window, the server sends `notice {notice: 'read-only'}`, then, in order, an `ack` for each of the client's own missed entries and a `remote` for each of the others. No `load-start` is sent. | 1, 3 |
| N5 | Remotes during a load | A `remote` may arrive between `load-start` and `load-done`, interleaved with chunks. The client buffers it until `load-done`. | 3 |
| N6 | Text default style | A `doc` attribute, for example `textDefaults: { fontFamily, fontSize, color }`. It holds the imported default run style, so marks are needed only for differences and export keeps the default font. | 1, 3 |
| N7 | `UnsupportedFinding` content | `{ feature: string; count: number; sample?: string }`, using the feature ids in §14.7 | 1, 3 |
| N8 | `NoticeMsg` kinds sent by the server | `{kind:'storage', state:'normal'\|'local'\|'pending'}`, `{kind:'read-only', readOnly}`, `{kind:'engine-restarting'}` | 1, 3 |
| N9 | `CloseCode` members used by the server | `ENGINE_RESTARTING` (4001, from the HLD), `ENGINE_UNAVAILABLE`, `SESSION_SLOW_CONSUMER`, `SESSION_CLOSED`, `DOCUMENT_FAULTED`, `PROTOCOL_VERSION_UNSUPPORTED`, `PROTOCOL_INVALID_MESSAGE`. Values in the 4000–4999 range are set by Part 1. | 1, 3 |
| N10 | `FileFormat`, `DocKind` | `'docx' \| 'odt' \| 'xlsx' \| 'ods'` and `'text' \| 'sheet'`. Part 1 should own them if `LoadStartMsg.kind` uses them. | 1 |
| N11 | OT purity | `OtType.apply` and `rebase` never mutate their inputs (§8.4) | 1 |
| N12 | Server public types | `EngineEventMap`, `AuditEvent`, `SupersededCell`, `StorageEvent`, `EngineStateEvent`, `DocumentEvent`, `CreateDocumentInput`, `RecoveryEntry`, `RecoveryResolution`, `LocalCopy`, `SessionFilter`, `ShareInfo`, `StorageStat`, `StorageReadResult`, `StorageWriteResult`, `StorageCreateInput`, `UploadedContext`, `Annotation`. Internal: `WireError`, `OutFrame`, `QueueItem`, `QueueDelivery`, `JournalEntry`, `DocumentMeta`, `SnapshotFile`, `KindPolicy`, `CodecJob`. | 2 |
| N13 | Local ref shape | `{ $local: string }`, returned by `documents.create({ target: 'local' })` when an adopter storage is configured. Opaque to adopters. | 2 |

---

# Part 3 — @open-docex/client (frontend/)

| | |
|---|---|
| **Scope** | HLD §13, plus the client sides of §9, §10, §11.4 and §14. BRD scope only. |
| **Versions** | Every module is tagged V1–V5 (HLD §19). V6/V7 are not designed here. |
| **Ownership** | Shared names (protocol, errors, OT, schema, ids) are owned by Part 1. Server behaviour is owned by Part 2. This part states what it **assumes** from them in §19, and lists new shared names in §20. |
| **Markers** | **(LLD choice)** = an implementation detail that follows from the HLD. **VERIFY IN SPIKE S1** = Univer behaviour that could not be confirmed from source (HLD §20). **OQ-n** = open question for the project owner (§21). |

---

## 0. Verified library facts this part relies on

| # | Fact | Source |
|---|---|---|
| L1 | prosemirror-collab's rebase pattern is: invert unconfirmed steps (newest first), apply remote steps, re-apply each local step mapped through `mapping.slice(...)` with mirrors, dropping steps where `maybeStep` fails, recomputing each inverse against `tr.docs[last]`. It sets `addToHistory: false`. | https://github.com/ProseMirror/prosemirror-collab/blob/master/src/collab.ts |
| L2 | `Mapping.appendMap(map, mirrors?)` is public. `Mapping.setMirror` is `@internal` and missing from the typings, so we must not rely on it. `Transform.maybeStep`, `tr.docs`, `tr.setDocAttribute` (`DocAttrStep`), and `Step.invert(doc)` are public. | https://unpkg.com/prosemirror-transform@1.12.6/dist/index.d.ts |
| L3 | `Selection.map(doc, mapping: Mappable)` is public. Plugin specs support `filterTransaction` and `appendTransaction`, and the state checks appended transactions with `filterTransaction` too. | https://unpkg.com/prosemirror-state/dist/index.d.ts |
| L4 | `Decoration.widget(pos, toDOM, { side, key, ignoreSelection, stopEvent })`: a negative `side` draws the widget before a cursor at `pos`, and `key` lets the view reuse the widget's DOM. Also available: `EditorView.composing`, `nodeDOM(pos)`, `setProps`, and the props `editable(state)` and `handleDOMEvents`. | https://unpkg.com/prosemirror-view@1.42.9/dist/index.d.ts |
| L5 | `tableEditing()` runs `fixTables` in `appendTransaction` on every state change. Commands available: `addRowBefore/After`, `addColumnBefore/After`, `deleteRow/Column`, `mergeCells`, `splitCell`, `toggleHeaderRow`, `deleteTable`, `goToNextCell`, `isInTable`, `CellSelection`. | https://unpkg.com/prosemirror-tables@1.8.5/dist/index.js |
| L6 | Univer `IExecutionOptions` has `fromCollab`, `onlyLocal`, `fromChangeset` and `syncOnly`. `onCommandExecuted(listener)` and `beforeCommandExecuted(listener)` receive `(commandInfo, options)`, and the service never reads `fromCollab` itself. If a `beforeCommandExecuted` listener throws `CustomCommandExecutionError` (or `CanceledError`, exported by `@univerjs/core`), `executeCommand`/`syncExecuteCommand` return `false`, i.e. the command is cancelled. | https://github.com/dream-num/univer/blob/dev/packages/core/src/services/command/command.service.ts |
| L7 | Facade: `FUniver.newAPI(univer)` (`@univerjs/core/facade`); `univerAPI.addEvent(univerAPI.Event.CommandExecuted, ({id,type,params,options}) => …)`; `Event.BeforeCommandExecute` with `event.cancel = true`; `univerAPI.executeCommand/syncExecuteCommand(id, params, options)`; `FWorkbook.setEditable(false)`. | https://github.com/dream-num/univer/blob/dev/packages/core/src/facade/f-univer.ts , …/sheets/src/facade/f-workbook.ts |
| L8 | **`UniverSheetsPlugin` is `@DependentOn(UniverFormulaEnginePlugin)`.** Both `UniverSheetsPlugin` and `UniverFormulaEnginePlugin` accept `notExecuteFormula?: boolean`. | https://github.com/dream-num/univer/blob/dev/packages/sheets/src/plugin.ts , …/engine-formula/src/config/config.ts |
| L9 | Sheet mutation ids and params (Univer 1.5.2, dev branch) are listed in §12.3. In `set-range-values`, a `null` cell deletes the cell, and other values are merged into the old cell (`isOverrideStyle` replaces the style). | https://github.com/dream-num/univer/tree/dev/packages/sheets/src/commands/mutations , …/basics/interfaces/mutation-interface.ts |
| L10 | `@univerjs/ui` 1.5.2 is Apache-2.0 and has peer dependencies react/react-dom `^16.9 … ^19` and `rxjs >=7`. Plugin-mode setup order is documented. `createUnit(UniverInstanceType.UNIVER_SHEET, data)`. | https://unpkg.com/@univerjs/ui@1.5.2/package.json , https://docs.univer.ai/guides/sheets/getting-started/installation |
| L11 | `createRoot(domNode, { identifierPrefix, onRecoverableError, … })` returns `{ render, unmount }`. `unmount` is irreversible on that root. | https://react.dev/reference/react-dom/client/createRoot |
| L12 | A failed opening handshake (any non-101 status, e.g. 401/403/503) closes the socket with **1006**, and the page cannot see the HTTP status. `close(code)` accepts only 1000 or 3000–4999. | https://websockets.spec.whatwg.org/ |
| L13 | Close code registry: 1000–1015, and 4000–4999 for private use. | https://www.iana.org/assignments/websocket/websocket.xhtml (RFC 6455 §7.4) |
| L14 | `ws`: if `handleProtocols` is not set, the server selects the **first** subprotocol the client offered. | https://github.com/websockets/ws/blob/master/doc/ws.md |

---

## 1. Package layout, build and dependencies (V1; sheet chunk V2)

```
frontend/
  package.json        "@open-docex/client", type: module, exports: ".", "./style.css", "./sheet.css" (V2)
  vite.config.ts      library mode, ESM only, .d.ts; externals: react, react-dom, rxjs, prosemirror-*, @univerjs/*, @open-docex/shared
  src/
    index.ts                 export { mount } + public types only
    mount.ts                 mount(), MountHandle
    options.ts               MountOptions, defaults, validateOptions()
    events.ts                typed Emitter<MountEvents>
    labels.ts  theme.ts      Labels (+ English defaults), ThemeVarName, applyTheme()
    session/DocumentSession.ts   orchestrator (internal)
    net/Connection.ts  net/backoff.ts  net/closeCodes.ts
    load/ChunkLoader.ts
    sync/collabSyncPlugin.ts  sync/TextSyncClient.ts  sync/SheetSyncClient.ts  sync/xform.ts  sync/types.ts
    text/TextEditorView.ts  text/plugins.ts  text/commands.ts  text/imageUpload.ts
    text/nodeviews/ImageView.ts  text/PaginationPlugin.ts  text/HeaderFooterRegions.ts  text/geometry.ts
    sheet/SheetEditorView.ts  sheet/UniverBridge.ts  sheet/univerSetup.ts      (V2, lazy chunk)
    sheet/mapping.ts  sheet/selectionMap.ts  sheet/blocked.ts                    (V2)
    assets/AssetCache.ts
    security/href.ts
    errors/policy.ts
    ui/  Shell.tsx Toolbar.tsx StatusBar.tsx UnsupportedBanner.tsx ReadOnlyBadge.tsx ShareButton.tsx
         UploadButton.tsx (V4) AnnotationsPanel.tsx (V5) ErrorScreen.tsx EditorHost.tsx useSession.ts
         dialogs/ LinkDialog.tsx ImageAltDialog.tsx PageSetupDialog.tsx TablePicker.tsx
  test/   (Vitest + jsdom)      e2e/   (Playwright)
```

- **Dependencies:**
  - `@open-docex/shared`.
  - ProseMirror packages, all MIT: `prosemirror-model`, `prosemirror-state`, `prosemirror-view`, `prosemirror-transform`, `prosemirror-commands`, `prosemirror-keymap`, `prosemirror-schema-list`, `prosemirror-tables`, `prosemirror-gapcursor`, `prosemirror-dropcursor`.
  - V2 Univer packages, all Apache-2.0 and **pinned to the exact version** chosen in S1 (1.5.2 is current): `@univerjs/core`, `design`, `engine-render`, `engine-formula`, `ui`, `docs`, `docs-ui`, `sheets`, `sheets-ui`.
  - `rxjs` (Apache-2.0), a Univer peer dependency.
- **Peer dependencies:** `react` and `react-dom` `^18.2.0 || ^19.0.0` **(LLD choice)**. This range sits inside Univer's peer range (L10).
- **React stays internal (PO-12):**
  - `mount()` creates its own root with `createRoot` on a container `<div>` that it creates and owns.
  - No React type or component is exported.
  - A non-React adopter installs `react` and `react-dom` only because they are peers. A React adopter shares its single React copy.
  - We never wrap our tree in `StrictMode`, so editor views are not created twice in development.
- **Code splitting (LLD choice):**
  - `sheet/*` is loaded with `import('./sheet/SheetEditorView')` only when `kind === 'sheet'`, so text-only pages never download Univer.
  - CSS ships as `style.css` (shell, ProseMirror, prosemirror-tables) and `sheet.css` (Univer). The adopter imports them. We do not inject `<style>` tags at runtime, so the adopter's CSP stays under their control.

---

## 2. Public API — `mount` (V1)

### 2.1 Types (`src/options.ts`, `src/events.ts`)

```ts
import type { DocumentId, ErrorCode, UnsupportedFinding, NoticeMsg } from '@open-docex/shared';

export type DocumentKind = 'text' | 'sheet';                 // 'sheet' requires V2

export interface MountOptions {
  url: string;                    // ws(s) endpoint, e.g. 'wss://app.example.com/open-docex' (HLD §10.1)
  documentId: DocumentId;         // appended as ?doc=<documentId> (DOC_QUERY_PARAM, §20)
  kind: DocumentKind;             // chooses which editor chunk to load; must equal load-start.kind
  connect?: ConnectOptions;
  hooks?: MountHooks;
  ui?: UiOptions;
}

export interface ConnectOptions {
  auth?: AuthOption;                                        // default { type: 'cookie' }
  heartbeat?: { intervalMs?: number; timeoutMs?: number };   // default 25_000 / 10_000 (LLD choice)
  reconnect?: { baseDelayMs?: number; maxDelayMs?: number }; // default 500 / 30_000 (LLD choice)
}
/** HLD §14: cookie, or a token in the query string or the subprotocol; the adopter chooses. */
export type AuthOption =
  | { type: 'cookie' }                                                   // browser sends cookies on the upgrade
  | { type: 'query'; param: string; getToken: () => string | Promise<string> }
  | { type: 'subprotocol'; getToken: () => string | Promise<string> };   // Sec-WebSocket-Protocol: [WS_SUBPROTOCOL, token]

export interface MountHooks {
  onShare?: (documentId: DocumentId) => void;                     // ShareButton hidden if absent
  onEditAnyway?: (documentId: DocumentId) => void | Promise<void>; // "Edit anyway" hidden if absent (PO-13)
  onUpload?: (result: UploadResult) => void;                       // V4; UploadButton hidden if absent
  onError?: (error: ClientError) => void;
}
export interface UploadResult { documentId: DocumentId; fileName: string }   // V4
export interface ClientError { code: ErrorCode; retryable: boolean; message: string; terminal: boolean }

export interface UiOptions {
  toolbar?: false | ToolbarConfig;      // false hides the toolbar entirely
  theme?: Partial<Record<ThemeVarName, string>>;
  labels?: DeepPartial<Labels>;
}
export interface ToolbarConfig {
  text?: { items?: readonly TextToolbarItemId[]; fontFamilies?: readonly string[]; fontSizes?: readonly number[] };
  sheet?: { items?: readonly SheetToolbarItemId[] };              // V2, maps to Univer menu visibility (§12.6)
  shell?: { items?: readonly ShellItemId[] };                     // 'share' | 'upload' (V4) | 'annotations' (V5)
}
export type ThemeVarName =
  | '--odx-font-family' | '--odx-color-bg' | '--odx-color-fg' | '--odx-color-muted' | '--odx-color-accent'
  | '--odx-color-border' | '--odx-color-canvas' | '--odx-color-page' | '--odx-color-warning'
  | '--odx-color-error' | '--odx-radius' | '--odx-toolbar-height';

export interface MountHandle {
  on<E extends keyof MountEvents>(event: E, fn: (payload: MountEvents[E]) => void): () => void; // returns unsubscribe
  destroy(): void;                                                                             // idempotent
}
export interface MountEvents {
  status: SessionStatus;
  'load-progress': LoadProgress;
  ready: { kind: DocumentKind; access: 'edit' | 'view'; readOnly: boolean; unsupported: readonly UnsupportedFinding[] };
  sync: { pendingCount: number; confirmedRev: number };   // lets the adopter warn before leaving (OQ-12)
  notice: NoticeMsg;
  error: ClientError;
  destroyed: undefined;
}
export interface SessionStatus {
  connection: 'connecting' | 'open' | 'reconnecting' | 'failed' | 'closed';
  load: 'idle' | 'loading' | 'ready';
  access: 'edit' | 'view' | null;
  readOnlyReason: null | 'view' | 'unsupported' | 'server' | 'restoring';
  sync: 'synced' | 'pending' | 'busy' | 'restoring';
  storage: 'normal' | 'local' | 'pending' | 'conflict';
}
export declare function mount(element: HTMLElement, options: MountOptions): MountHandle;
```

`Labels` (`src/labels.ts`) holds every user-visible string, and each string can be overridden through `ui.labels`. The groups are:
- `toolbar.*`, `status.*`, `banner.*`, `badge.*`, `dialogs.*`
- `errors[ErrorCode]`
- `findings[kind]`
- `notices.*`, `restore.*`

The defaults are English. No string is built from server text, except that `ErrorMsg.message` is the fallback when `errors[code]` has no label.

### 2.2 `mount` lifecycle (pseudo-code)

```
mount(element, options):
  validateOptions(options)                 // throws OpenDocexError('CONFIG_INVALID') synchronously:
                                           //   missing url/documentId, url not ws:/wss:, kind ∉ {text,sheet},
                                           //   auth.query without param, element already mounted (WeakSet)
  container ← createElement('div', class 'odx-root'); applyTheme(container, ui.theme); element.append(container)
  emitter ← new Emitter<MountEvents>()
  session ← new DocumentSession({ options: withDefaults(options), emitter, clientId: newClientId() })
  root ← createRoot(container, { identifierPrefix: 'odx' + seq++ + '-' })
  root.render(<ShellErrorBoundary session><SessionContext value=session><Shell/></SessionContext></ShellErrorBoundary>)
  session.start()                          // Connection.start()
  return { on: emitter.on, destroy }

destroy():                                 // idempotent
  if destroyed: return; destroyed ← true
  session.destroy()   // Connection.close(1000); sync clients stop timers; EditorView.destroy() / univer.dispose();
                      // AssetCache.destroy() revokes every blob URL
  root.unmount(); container.remove(); mountedSet.delete(element)
  emitter.emit('destroyed'); emitter.clear()
```

- Unconfirmed changes that exist when `destroy()` runs are lost, because they live in memory only [§3]. The `sync` event tells the adopter when `pendingCount > 0` (see OQ-12).
- Multiple `mount()` calls on one page are independent: each has its own root, `clientId` and socket (CL-13).
- React state binding: `useSession()` uses `useSyncExternalStore(session.subscribe, session.getSnapshot)`. The session snapshot is immutable and is replaced on every change.
- `ShellErrorBoundary` catches React render errors. It shows `ErrorScreen` and calls `onError` (see OQ-14 for which code).

### 2.3 Tests

- **Unit:**
  - `validateOptions`: one case per rejection rule.
  - Double mount on the same element throws `CONFIG_INVALID`.
  - `destroy()` is idempotent: it unmounts the root, removes the container, revokes blob URLs (spy on `URL.revokeObjectURL`), closes the socket with 1000 and fires `destroyed` once.
  - `on()` returns a working unsubscribe.
- **Unit:** `applyTheme` sets only the allow-listed `--odx-*` variables. Unknown keys are ignored.
- **E2E:** mount in a plain HTML page with no React on the page except our peer, then destroy and re-mount in the same element.

---

## 3. `DocumentSession` (internal orchestrator, V1)

**Responsibility:** owns `Connection`, `ChunkLoader`, the sync client (text or sheet), the editor view, `AssetCache` and the status snapshot. It routes server messages and applies the error policy (§16). It is not a cross-part contract.

| Phase | Trigger | Action | Next |
|---|---|---|---|
| `init` | `start()` | `connection.start()` | `connecting` |
| `connecting` | socket open | send `hello { protocol: PROTOCOL_VERSION, clientId, resume? }`. `resume = { epoch, rev: confirmedRev }` only if a document was loaded and no reload is pending. If resuming, also call `sync.onReconnected()`. | `handshake` |
| `handshake` | `load-start` | `orphans ← sync?.exportOrphans()`; `loader.begin(msg)` | `loading` |
| `handshake` | `remote` / `ack` / `notice` (resume accepted) | route to sync / status | `live` |
| `loading` | `load-chunk` | `loader.onChunk` | `loading` |
| `loading` | `remote` | `loader.bufferRemote` | `loading` |
| `loading` | `load-done` | `{snapshot, rev, buffered} ← loader.finish()`; create the editor, or replace its state; `sync.start(...)`; replay `buffered` through `sync.onRemote`; `sync.restoreOrphans(orphans, {epoch, rev})`; emit `ready` | `live` |
| `live` | `remote` / `ack` / `error{clientSeq}` | route to the sync client | `live` |
| any | `resync` | export orphans; wait for `load-start` on the same socket (no reconnect, no new `hello`; R-9, S-35) | `loading` |
| any | a reload decided by the policy or sync client | `reloadPending ← true`; close the socket with 1000; reconnect immediately (no resume) | `connecting` |
| any | socket closed, retryable | `sync.onDisconnected()`; backoff | `connecting` |
| any | terminal policy | close the socket; show `ErrorScreen` | `terminal` |
| `terminal` | user clicks "Reload" (`session.retry()`) | reset backoff; reconnect fresh, keeping orphans | `connecting` |
| any | `destroy()` | tear down | `destroyed` |

- `kind` mismatch: if `load-start.kind !== options.kind`, the session goes terminal with `CONFIG_INVALID` (an adopter integration error) **(LLD choice)**.
- Message routing: an unknown `type` is ignored (HLD §9). If `decodeServerMessage` throws, the session handles it as `PROTOCOL_INVALID_MESSAGE` (reload). Two consecutive decode failures make it terminal.
- The editor DOM is created inside `EditorHost` (a React component) through a ref. The session calls `attachEditor(el)` from `useLayoutEffect`, and React never renders children into that element.
- On a reload, the session keeps the same `EditorView` and calls `view.updateState(EditorState.create(...))`. The selection head is clamped to the new document size **(LLD choice)**. For sheets, it disposes the old Univer unit and creates a new one.

**Tests:** a routing table test with a `FakeConnection` (each message × phase). Also test that a `kind` mismatch is terminal, and that a `resync` while `live` exports orphans and reloads on the same socket without reconnecting (R-9, S-35).

---

## 4. `Connection` (V1)

**File:** `src/net/Connection.ts`. **Responsibility:** owns one browser `WebSocket` at a time. It handles auth placement, the heartbeat, reconnect with backoff, and classifying close events. It does not interpret document messages.

```ts
export type ConnState = 'idle' | 'connecting' | 'open' | 'waiting' | 'terminal' | 'destroyed';
export interface ConnectionDeps {
  url: string; documentId: DocumentId; auth: AuthOption;
  heartbeat: { intervalMs: number; timeoutMs: number }; reconnect: { baseDelayMs: number; maxDelayMs: number };
  onOpen(): void; onMessage(msg: ServerMessage): void; onDecodeError(e: unknown): void;
  onClosed(info: CloseInfo): CloseDecision;            // DocumentSession applies §16 policy
  onState(s: ConnState): void;
}
export interface CloseInfo { code: number; reason: string; everOpened: boolean; lastError?: ErrorMsg }
export type CloseDecision = { action: 'reconnect'; minDelayMs?: number } | { action: 'terminal' } | { action: 'reload' };
export declare class Connection {
  constructor(deps: ConnectionDeps);
  start(): void;
  send(msg: ClientMessage): boolean;                   // false if not open (caller keeps state)
  closeAndReconnect(fresh: boolean): void;             // used for reload
  retry(): void;                                       // from terminal
  close(): void;                                       // destroy: ws.close(1000), clear timers
  readonly state: ConnState;
  readonly bufferedAmount: number;                     // for upload throttling (V4)
}
```

**Opening a socket** (`ws.binaryType = 'arraybuffer'`):
```
open():
  u ← new URL(url); u.searchParams.set(DOC_QUERY_PARAM /* 'doc' */, documentId)
  protocols ← undefined
  if auth.type == 'query':       u.searchParams.set(auth.param, await auth.getToken())     // HLD §14: tokens in logs → documented
  if auth.type == 'subprotocol': protocols ← [WS_SUBPROTOCOL, await auth.getToken()]      // the server echoes WS_SUBPROTOCOL (L14)
  ws ← new WebSocket(u, protocols); everOpened ← false
```
- `getToken` is called on **every** connect, so the adopter can refresh tokens **(LLD choice)**.
- The token is never logged. `CloseInfo` never includes the URL.

**State machine:**

| State | Event | Action | Next |
|---|---|---|---|
| idle | `start()` | `open()` | connecting |
| connecting | `open` | `everOpened ← true`; `attempt ← 0` once the session reaches `live`; start the heartbeat; `onOpen()` | open |
| connecting / open | `message` | `lastInbound ← now`; `decodeServerMessage`; a `pong` stays internal; anything else → `onMessage` | same |
| open | heartbeat tick | if `now − lastInbound ≥ intervalMs`, send `ping { id }` (`PingMsg`, §20); if no inbound within `timeoutMs`, it is a **dead link**: call `ws.close()` and immediately treat the socket as closed with code 1006 without waiting for the browser's close event | open / waiting |
| connecting / open | `close(code)` | `decision ← onClosed(info)` | waiting / terminal / connecting (reload) |
| waiting | timer fires, or the `online` window event | `open()` | connecting |
| any | `close()` | `ws.close(1000)`; clear timers | destroyed |

**Backoff** (`src/net/backoff.ts`, full jitter, **LLD choice**):
`delay(attempt) = max(minDelayMs ?? 0, random(0, min(maxDelayMs, baseDelayMs · 2^attempt)))`, and `attempt++` after each failed attempt.

**Close-code classification** (`src/net/closeCodes.ts`). `lastError` is the `ErrorMsg` received just before the close. When it exists, its `code` wins (contract C-8, §19).
- Closes the client starts itself (reload, dead link, `destroy()`) skip this table.
- A close that arrives after a `resync` message counts as part of the reload.

| Close code | Meaning (L13) | Decision without `lastError` |
|---|---|---|
| 1000 | Normal | terminal, with `SESSION_CLOSED` (the adopter ended the session) |
| 1001 | Going away (server shutdown) | reconnect |
| 1006 | Abnormal, including **handshake rejected** (401/403/503 cannot be seen, L12) | reconnect. If `everOpened` was never true for K consecutive attempts, see **OQ-1** |
| 1008 | Policy violation | terminal, with `ACCESS_DENIED` |
| 1009 | Message too big (we sent an oversized frame) | reconnect; fail the asset upload that was in flight (`DOCUMENT_TOO_LARGE`) |
| 1011 / 1012 | Internal error / service restart | reconnect |
| 1013 | Try again later | reconnect, `minDelayMs 5000` |
| `CloseCode.ENGINE_RESTARTING` (4001, HLD §10.5) | Engine restarting | reconnect, `minDelayMs 1000` (matches the supervisor's first 1 s backoff) |
| other `CloseCode.*` (4000–4999) | app-defined (Part 1) | reconnect (conservative), unless `lastError` says otherwise |

**Tests (Vitest, fake timers, a `FakeWebSocket` class injected through a factory):**
- The `doc` param is set, and the query token is placed under the adopter's param name.
- The subprotocol array is `[WS_SUBPROTOCOL, token]`.
- `getToken` is called again on reconnect.
- The heartbeat sends `ping` only when idle, and declares the link dead after `timeoutMs`.
- Every row of the close-code table.
- Backoff bounds with a seeded `random`.
- The `online` event short-circuits the wait.
- `close()` clears all timers (assert no pending timers).

**E2E:**
- Kill the server-side socket (Playwright `page.route` / server hook): the client reconnects and the status bar goes from reconnecting back to open.
- A 403 at upgrade behaves as described in OQ-1.

---

## 5. `ChunkLoader` (V1; row-range chunks V2)

**File:** `src/load/ChunkLoader.ts`. **Responsibility:** collects `load-chunk`s for one `load-start`, buffers `remote` messages until `load-done` [A7], assembles the snapshot with the shared `OtType.assemble`, and reports progress.

```ts
export interface LoadProgress { chunksReceived: number; bytesReceived: number; totalChunks?: number }
export declare class ChunkLoader<S> {
  constructor(otType: Pick<OtType<S, unknown>, 'assemble'>, onProgress: (p: LoadProgress) => void);
  begin(msg: LoadStartMsg): void;                 // resets; remembers epoch, rev, kind, access, unsupported
  onChunk(msg: LoadChunkMsg): void;               // throws LoaderError on out-of-order seq
  bufferRemote(msg: RemoteMsg): void;
  finish(msg: LoadDoneMsg): { snapshot: S; rev: number; epoch: string; buffered: RemoteMsg[] };
  readonly active: boolean;
}
```

**Algorithm:**
```
begin(m):    chunks ← []; nextSeq ← 0; buffered ← []; start ← m; bytes ← 0; active ← true
onChunk(m):  if m.seq ≠ nextSeq: throw LoaderError('seq')        → session: PROTOCOL_INVALID_MESSAGE → reload
             chunks.push(m.data); nextSeq++; bytes += approxSize(m) ; onProgress({...})
             // approxSize = byte length of the raw frame, passed in by Connection (no re-serialisation)
bufferRemote(m): buffered.push(m)
finish(d):   if d.rev ≠ start.rev: throw LoaderError('rev')
             snapshot ← otType.assemble(chunks)                 // TextOtType or SheetOtType (V2)
             chunks ← []  (release memory); active ← false
             buffered.sort? NO: arrival order is server FIFO order; the sync client checks fromRev contiguity
             return { snapshot, rev: d.rev, epoch: start.epoch, buffered }
```
- **Progress** is indeterminate unless the server supplies the optional `LoadStartMsg.totalChunks` (§20). The status bar shows a bar when the total is known, and a spinner with the chunk count otherwise.
- **Rendering (LLD choice):** the editor state is created once, at `load-done` (HLD §13: "assembles chunks"). The page shows the progress UI until then.

**Tests:**
- In-order chunks assemble through a stub `assemble`.
- Out-of-order `seq` and `rev` mismatch throw.
- Remotes received during loading are returned in arrival order and are not applied early.
- Chunk references are released after `finish` (WeakRef or spy).
- Progress counts are correct, with and without `totalChunks`.

---

## 6. Sync core shared by text and sheets (V1/V2)

- **Revision arithmetic** (HLD §8.3):
  - A batch committed from `fromRev` with `n` ops ends at `fromRev + n` (steps for text, `SheetOp`s for sheets).
  - `ack.rev` is the revision after the sender's batch.
  - `remote.fromRev` is the revision before the remote ops.
- **Jupiter discipline (HLD §13):** at most one batch is in flight per client, and the rest stays in a local buffer. Because the server sends through one FIFO per connection (HLD §10.1, §11.4), every `remote` committed before our batch arrives **before** our `ack`.
- **`clientSeq`** starts at 1 per `clientId` and increases strictly. A `clientSeq` is reused only to resend the **same** envelope (dedupe, CL-12), with the single documented exception in §6.2 (N > R).
- **Envelope:** `SubmitEnvelope { clientId, clientSeq, epoch, baseRev, ops }`. The client sends it as the canonical `SubmitMsg` built by a local helper `toSubmitMsg(env)`.

### 6.1 Reconnect with resume (epoch unchanged)

```
onDisconnected():  connected ← false; cancel QUEUE_FULL retry timer      // keep inflight + buffer; their fate is unknown
onReconnected():   connected ← true                                      // called right after hello{resume} was sent
                   if inflight: send(inflight.sent)                      // ORIGINAL envelope, same clientSeq/baseRev → dedupe-safe
                   else flush()
```
- **Catch-up** (contract C-3):
  - The server replays the ops committed after `resume.rev` as `remote` messages, **including our own**, with `clientId = ours`.
  - A `remote` carrying our `clientId` confirms the in-flight batch.
  - A duplicate `ack` for that `clientSeq` is ignored later (C-4).
- If the server answers `resync` instead, the session reloads (§6.2). An `ErrorMsg` for the stale-epoch resend is ignored, because its `clientSeq` no longer matches.

### 6.2 Reload with unconfirmed changes ("rescue", HLD §10.5 step 4)

Before reloading, `exportOrphans()` captures `{ epoch: E0, baseRev: R (confirmedRev), inflightSeq?: s, pending: P }`.
- P is the in-flight steps or ops followed by the buffer, in current local form, all based on the confirmed state at R.
- After `load-done { rev: N, epoch: E }`, `restoreOrphans` runs:

```
restoreOrphans(o, {epoch: E, rev: N}):
  if o == null or o.pending is empty: return
  if N == o.baseRev:                      // nothing was committed after our base (so s was not committed with any effect)
     apply o.pending locally on the fresh state (text: tr.maybeStep each, drop failures; sheet: SheetOtType.apply)
     → they become ordinary local pending; flush() sends them with a FRESH clientSeq
  else:                                   // N > R: we lack ops (R..N]; ask the server to rebase from R
     rescue ← { clientSeq: o.inflightSeq ?? nextSeq++, count: |P| }
     readOnly('restoring'); send(submit{ clientSeq: rescue.clientSeq, epoch: E, baseRev: o.baseRev, ops: P })
on ack(m) while rescue && m.clientSeq == rescue.clientSeq:
     if m.rev ≤ N:   // duplicate: s had been committed before the restart and is already in the snapshot
        if |P| > |original inflight|: notify(restore.partialLoss); onError(SESSION_RESYNC_REQUIRED)   // OQ-6
     else: apply (m.committed ?? P) locally as CONFIRMED (not pending); confirmedRev ← m.rev
     rescue ← null; readOnly(off); flush()
on error(m) while rescue && m.clientSeq == rescue.clientSeq:
     notify(restore.lost); onError(m.code); rescue ← null; readOnly(off)          // OQ-6
```
- The rescue relies on contract C-5: revision numbering continues across epochs when an instance is rebuilt from its journal. While rescue is active, `remote`s from other users apply normally, because there is no local pending in the document.
- Pending changes are discarded instead of rescued in these cases: `PROTOCOL_OP_REJECTED`, `ACCESS_DENIED` / `DOCUMENT_READ_ONLY` on submit, and a read-only switch with pending changes (OQ-13). The user sees `labels.restore.discarded`.

---

## 7. `TextSyncClient` and `collabSyncPlugin` (V1)

**Files:** `src/sync/collabSyncPlugin.ts`, `src/sync/TextSyncClient.ts`. Implements the client side of CL-6.

### 7.1 Data structures and plugin

```ts
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import type { Step } from 'prosemirror-transform';

export interface PendingStep { readonly step: Step; readonly inverted: Step }   // inverted = step.invert(docBefore)
export interface SyncPluginState {
  readonly pending: readonly PendingStep[];   // [in-flight prefix | buffer]
  readonly inflightCount: number;
  readonly readOnly: boolean;                 // view access, unsupported content, server read-only, or restoring
}
export type SyncMeta =
  | { kind: 'rebuild'; pending: readonly PendingStep[]; inflightCount: number }   // remote / correction / confirm
  | { kind: 'set-inflight'; inflightCount: number }
  | { kind: 'read-only'; readOnly: boolean };
export const syncKey: PluginKey<SyncPluginState>;
export declare function collabSyncPlugin(client: TextSyncClient, init: { readOnly: boolean }): Plugin<SyncPluginState>;
```

```
state.init  → { pending: [], inflightCount: 0, readOnly: init.readOnly }
state.apply(tr, prev):
  m ← tr.getMeta(syncKey)
  if m?.kind == 'rebuild':      return { ...prev, pending: m.pending, inflightCount: m.inflightCount }
  if m?.kind == 'set-inflight': return { ...prev, inflightCount: m.inflightCount }
  if m?.kind == 'read-only':    return { ...prev, readOnly: m.readOnly }
  if tr.docChanged:             return { ...prev, pending: prev.pending ++ tr.steps.map((s,i) ⇒ ({ step: s, inverted: s.invert(tr.docs[i]) })) }
  return prev
props.filterTransaction(tr, state): tr.docChanged ⇒ (tr.getMeta(syncKey)?.kind == 'rebuild' || !getState(state).readOnly)
props.editable(state): !getState(state).readOnly
view(): { update: () ⇒ client.scheduleFlush() }          // queueMicrotask coalesces same-tick transactions
```

Pending steps live in plugin state, as in prosemirror-collab, so every local transaction, including those appended by other plugins, is captured. `TextSyncClient` holds the network state:

```ts
export declare class TextSyncClient {
  constructor(deps: { view(): EditorView; send(m: SubmitMsg): boolean; clientId: ClientId;
                      emit(e: SyncEvent): void; reload(reason: ReloadReason, discard: boolean): void;
                      maxBatchSteps?: number /* default 200, LLD choice */ });
  start(p: { epoch: string; rev: number; readOnly: boolean }): void;
  scheduleFlush(): void;  onRemote(m: RemoteMsg): void;  onAck(m: AckMsg): void;  onSubmitError(m: ErrorMsg): void;
  onDisconnected(): void; onReconnected(): void;  setReadOnly(ro: boolean, reason: ReadOnlyReason): void;
  exportOrphans(): Orphans | null;  restoreOrphans(o: Orphans | null, load: { epoch: string; rev: number }): void;
  resumeInfo(): { epoch: string; rev: number } | null;  destroy(): void;
}
// private: confirmedRev, epoch, inflight: { clientSeq; sent: SubmitEnvelope; attempts: number } | null,
//          nextSeq, connected, rescue, retryTimer
```

### 7.2 Core rebuild: one transaction (HLD §13)

The shared signature (Part 1 §8.3, reconciled in LLD §0 R-6):
`rebaseStepsOnDoc(steps: readonly Step[], over: readonly Step[], doc: Node): { steps: Step[]; kept: number[]; doc: Node }`.
- `steps` are based on document B, and `over` takes B to B′, with `doc === B′`.
- The result holds the surviving rebased steps, the indexes of their originals, and B′ plus those steps.
- The function is mapping-only, the same code the server uses (CL-6).

```
rebuild(state, keep: PendingStep[], over: Step[]) → { tr, newKeep, kept }:
  tr ← state.tr
  for i ← keep.length−1 downto 0: tr.step(keep[i].inverted)              // undo local, newest first
  for s in over: if tr.maybeStep(s).failed: throw Divergence               // remote/committed must apply
  { steps: rebased, kept } ← rebaseStepsOnDoc(keep.map(k ⇒ k.step), over, tr.doc)
  // selection mapping with mirrors via the PUBLIC Mapping API (L2), not tr.mapping
  sel ← new Mapping(); n ← keep.length
  for i ← n−1 downto 0: sel.appendMap(keep[i].step.getMap().invert())     // map index of inverse(keep[i]) = n−1−i
  for s in over:        sel.appendMap(s.getMap())
  newKeep ← []
  for j in 0 ..< rebased.length:
     tr.step(rebased[j])                                                   // cannot fail: validated on the same doc
     newKeep.push({ step: rebased[j], inverted: rebased[j].invert(tr.docs[tr.docs.length−1]) })
     sel.appendMap(rebased[j].getMap(), n−1−kept[j])                       // mirror of its own inverse
  tr.setSelection(state.selection.map(tr.doc, sel))                        // keeps caret inside re-applied typing
  tr.setMeta('addToHistory', false)                                        // future-proof for V6 history (B2)
  return { tr, newKeep, kept }
```

### 7.3 Messages

```
flush():                                   // after scheduleFlush microtask, on ack, on reconnect
  if !connected or inflight or rescue or ps.readOnly: return
  ps ← syncKey.getState(view.state); if ps.pending empty: return
  batch ← ps.pending[0 ..< min(maxBatchSteps, len)]
  env ← { clientId, clientSeq: nextSeq++, epoch, baseRev: confirmedRev, ops: batch.map(p ⇒ p.step.toJSON()) }
  inflight ← { clientSeq: env.clientSeq, sent: env, attempts: 0 }
  view.dispatch(view.state.tr.setMeta(syncKey, { kind: 'set-inflight', inflightCount: batch.length }))
  send(toSubmitMsg(env)); emit sync

onRemote(m):
  if m.fromRev + m.ops.length ≤ confirmedRev: return                       // overlap after resume
  if m.fromRev ≠ confirmedRev: return reload('gap', false)
  if m.clientId == clientId:                                               // own commit replayed (C-3)
     return inflight ? confirm(m.ops, m.fromRev + m.ops.length) : reload('own-without-inflight', false)
  over ← parseSteps(m.ops) or return reload('bad-step', false)             // Step.fromJSON(textSchema, j)
  ps ← state
  try r ← rebuild(view.state, ps.pending, over) catch Divergence: return reload('remote-apply', false)
  k′ ← |{ j : r.kept[j] < ps.inflightCount }|
  view.dispatch(r.tr.setMeta(syncKey, { kind: 'rebuild', pending: r.newKeep, inflightCount: k′ }))
  confirmedRev ← m.fromRev + over.length; emit sync

onAck(m):
  if rescue and m.clientSeq == rescue.clientSeq: return rescueAck(m)        // §6.2
  if !inflight or m.clientSeq ≠ inflight.clientSeq: return                  // duplicate ack (C-4)
  confirm(m.committed, m.rev)

confirm(committedJSON?, rev):
  ps ← state; k ← ps.inflightCount; local ← ps.pending[0 ..< k]
  n ← committedJSON ? committedJSON.length : k
  if rev ≠ confirmedRev + n: return reload('ack-rev', false)
  if committedJSON == undefined or deepEqual(local.map(p ⇒ p.step.toJSON()), committedJSON):
     view.dispatch(tr.setMeta(syncKey, { kind: 'rebuild', pending: ps.pending[k ..], inflightCount: 0 }))   // no doc change
  else:                                                                    // CL-6 correction transaction
     committed ← parseSteps(committedJSON) or return reload('bad-step', false)
     over ← [local[k−1].inverted, …, local[0].inverted] ++ committed       // swap our in-flight for the server's
     try r ← rebuild(view.state, ps.pending[k ..], over) catch Divergence: return reload('correction', false)
     view.dispatch(r.tr.setMeta(syncKey, { kind: 'rebuild', pending: r.newKeep, inflightCount: 0 }))
  confirmedRev ← rev; inflight ← null; clearTimeout(retryTimer); emit sync; flush()

onSubmitError(m):                          // ErrorMsg with clientSeq
  if rescue and m.clientSeq == rescue.clientSeq: return rescueFailed(m)
  if !inflight or m.clientSeq ≠ inflight.clientSeq: return
  switch policy(m.code)                    // §16
    'retry-submit':  inflight.attempts++; status busy
                     retryTimer ← setTimeout(() ⇒ connected && send(toSubmitMsg(inflight.sent)),
                                             fullJitter(250, 10_000, inflight.attempts))      // LLD choice
    'reload':         reload(m.code, false)
    'discard-reload': reload(m.code, true)                                 // pending dropped; notify
```

- **Deep equality:** `deepEqual` is a structural comparison that ignores key order, because JSON key order is not guaranteed after server serialisation. If in-flight steps were all dropped locally, `k = 0`. In that case either `committed = []` confirms, or a non-empty `committed` triggers the correction path.
- **Read-only:**
  - `setReadOnly(true)` dispatches the `read-only` meta. `filterTransaction` then blocks local document changes, including appended ones, and `editable` turns false.
  - `view` sessions start read-only and **never send `submit`**. `send` asserts `access === 'edit'`, and a violation throws internally in tests (HLD §13).
  - If read-only arrives while changes are pending, the client calls `reload(…, discard = true)` (OQ-13).
  - `setReadOnly(false)` (after "edit anyway", or an access change notice) calls `flush()`.
- **Interaction with prosemirror-tables (L5), LLD choice:**
  - `tableEditing()`'s `appendTransaction` would run `fixTables` after **remote** rebuilds. Several clients would then submit the same repair concurrently, and the repairs could be duplicated.
  - So `text/plugins.ts` wraps the plugin: `new Plugin({ ...orig.spec, appendTransaction: (trs, a, b) => trs.some(isRebuild) ? null : orig.spec.appendTransaction!(trs, a, b) })`.
  - Tables are therefore repaired only by local edits. `fixTables(state, oldState)` rescans tables that changed.

### 7.4 Tests (Vitest + jsdom, `FakeServer`)

`test/FakeServer.ts` is an in-memory authority:
- It keeps a document and a revision and applies shared `rebaseSteps` and `TextOtType.apply`.
- It keeps one FIFO per client, with controllable delivery: hold, release, drop or duplicate.

Scenarios:
- BRD "cat" example [§3]: A and B both insert after "c", in both delivery orders → identical documents, and each caret stays after its own letter.
- Typing during a remote (pending is in flight plus buffered) → one dispatched transaction per remote (spy on `dispatch`), and the caret position is preserved (mirror test: caret in the middle of pending inserted text).
- `ack` without `committed` → pending is trimmed and the next batch is sent with the new `baseRev`.
- `ack` with an equal `committed` → no document change.
- `ack` with a different `committed` (forced by the FakeServer dropping a step) → correction, and the client converges with the server.
- `QUEUE_FULL` → the same envelope is resent after backoff (fake timers), and typing continues to buffer.
- Disconnect while a batch is in flight:
  - (a) the server had committed it, and catch-up includes our own op → confirmed, and the duplicate ack is ignored;
  - (b) not committed → the resend commits once.
- Gap in `fromRev` → reload is requested.
- Rescue `N == R` and `N > R` (including the duplicate-ack partial-loss path).
- A view session never calls `send`.
- `fixTables` is not appended after a remote rebuild.
- Malformed remote JSON → reload.

**E2E:**
- Two browsers type in the same paragraph with artificial latency (Playwright `route` delay on the WebSocket via a server test hook) and converge.
- Selection survives a remote paste above it.

---

## 8. `SheetSyncClient` (V2)

**File:** `src/sync/SheetSyncClient.ts` and `src/sync/xform.ts`. This is the same Jupiter state machine applied to `SheetOp`s. There are no inverses: sheet inverse ops are V6 (B2).

**Expected shared signature** (contract C-6, owned by Part 1):
- `transformSheetOp(op: SheetOp, over: SheetOp, side: Side): SheetOp[]` (Part 1 §9) returns `op` rewritten to apply after `over`. `side` (`'later'` or `'earlier'`) decides the winner on the same cell (HLD §8.3: the later op in FIFO order wins).
- `SheetOtType.rebase(ops, over)` must equal `xform(ops, true, over)[0]` below. The server then computes the same `committed` as the client's local in-flight form.

```ts
/** a and b are based on the same state. Returns [a′ applying after b, b′ applying after a]. */
export function xform(a: readonly SheetOp[], aIsLater: boolean, b: readonly SheetOp[]): [SheetOp[], SheetOp[]];
```
```
xform(a, aLater, b):
  if a empty or b empty: return [a, b]
  if |a| == 1 and |b| == 1: return [transformSheetOp(a0, b0, aLater), transformSheetOp(b0, a0, !aLater)]
  if |a| > 1: [a0′, b1] ← xform([a0], aLater, b); [rest′, b2] ← xform(a[1..], aLater, b1); return [a0′ ++ rest′, b2]
  else:       [a1, b0′] ← xform(a, aLater, [b0]); [a2, rest′] ← xform(a1, aLater, b[1..]); return [a2, b0′ ++ rest′]
```

**State:**
- `confirmedRev`, `epoch`, `inflight { clientSeq, sent, ops /* local current form */, attempts }`, `buffer: SheetOp[]`.
- `shadow: Workbook` holds the confirmed state plus in-flight plus buffer, i.e. exactly what Univer should show. It is maintained with `SheetOtType.apply`, the same function the server uses. Shadow memory roughly equals the model size **(LLD choice)**.

```
onLocalOps(ops):                            // from UniverBridge; already visible in Univer
  r ← SheetOtType.apply(shadow, ops); shadow ← r.snapshot
  if r.dropped non-empty: bridge.reconcileSheets(sheetsOf(r.dropped))      // Univer showed something the model rejects
  buffer.push(...r.applied); scheduleFlush()
flush(): as text, batch ← buffer.splice(0, maxBatchOps /* 100, LLD choice */); inflight.ops ← batch
onRemote(m):
  gap/overlap/own-clientId checks exactly as §7.3
  R ← m.ops                                                 // decoded by decodeServerMessage
  [I′, R1] ← xform(inflight?.ops ?? [], true, R)            // ours are later → ours win the same cell
  [B′, R2] ← xform(buffer, true, R1)
  sel ← bridge.captureSelection()
  shadow ← SheetOtType.apply(shadow, R2).snapshot
  bridge.applyRemote(R2)                                    // fromCollab, §12.4
  bridge.restoreSelection(mapSelection(sel, R2))            // §12.5
  inflight.ops ← I′; buffer ← B′; confirmedRev ← m.fromRev + R.length
onAck(m):
  rescue / duplicate handling as §7.3
  n ← m.committed?.length ?? |inflight.ops|; if m.rev ≠ confirmedRev + n: reload('ack-rev')
  if m.committed and !deepEqual(m.committed, inflight.ops): reload('sheet-commit-mismatch')   // violates C-6
  confirmedRev ← m.rev; inflight ← null; flush()
```
- `QUEUE_FULL`, reconnect, rescue (§6.2) and read-only behave as in §7.
- For rescue `N == R`, the orphan ops are applied to the new shadow and to Univer through `bridge.applyLocalReplay(ops)`. That method executes the mapped mutations with `{ fromCollab: true }` so they are not captured twice, and the ops then go back into `buffer`.

**Tests:**
- `xform` properties with a stub `transformSheetOp` (TP1 on generated pairs; multi-op outputs; empty lists).
- Same-cell concurrent `setCells` in both orders: the later in FIFO order wins on both clients [§6].
- `insertRows` concurrent with `setCells` below the insertion point: the shifted cell lands on the right row.
- Formula reference shifting is visible through the shadow (`shiftFormulaReferences`, PO-9), including `#REF!`.
- `committed` mismatch → reload.
- `QUEUE_FULL` and reconnect, as in text.
- The shadow equals the FakeServer model after every delivery.

---

## 9. `TextEditorView` (V1)

**File:** `src/text/TextEditorView.ts`. **Responsibility:** builds the ProseMirror `EditorView` from the shared `textSchema` for the V1 content in HLD §8.1, and exposes toolbar commands.

```ts
export interface TextEditorDeps { assets: AssetCache; sync: TextSyncClient; labels: Labels;
                                  toolbar: Required<NonNullable<ToolbarConfig['text']>>; onError(e: ClientError): void }
export declare class TextEditorView {
  constructor(host: HTMLElement, deps: TextEditorDeps);
  load(doc: Node /* from TextSnapshot */, opts: { readOnly: boolean }): void;   // create or replace state
  readonly view: EditorView;
  commands(): ReadonlyMap<TextToolbarItemId, EditorCommand>;
  subscribe(fn: () => void): () => void;           // toolbar re-render on state change
  destroy(): void;
}
export interface EditorCommand {
  id: TextToolbarItemId; label: keyof Labels['toolbar'];
  isEnabled(s: EditorState): boolean; isActive?(s: EditorState): boolean; value?(s: EditorState): string | number | null;
  run(view: EditorView, arg?: unknown): boolean | Promise<boolean>;
}
```

- `TextSnapshot` → document: `textSnapshotToDoc(s)` is a one-line adapter, `Node.fromJSON(textSchema, s.doc)` or `s.doc`, depending on Part 1's definition (C-2).

**Plugin order** (`src/text/plugins.ts`):
1. `collabSyncPlugin`
2. `HeaderFooterRegions` nodeViews (props)
3. `imageUploadPlugin` (placeholders)
4. `PaginationPlugin`
5. keymaps
6. `gapCursor()` (cursor next to tables and images)
7. `dropCursor()`
8. wrapped `tableEditing()` (last, per its docs, L5)

- **No input rules** (LLD choice): none are needed for HLD §8.1.
- **No history plugin:** undo is B2 (V6). See OQ-7.

**Keymaps** (LLD choice, standard bindings):

| Keys | Command |
|---|---|
| `baseKeymap` (prosemirror-commands) | Enter, Backspace, Delete, select-all, … |
| Mod-b / Mod-i / Mod-u / Mod-Shift-x | `toggleMark(bold / italic / underline / strike)` |
| Shift-Enter | insert `hard_break` |
| Enter (in a list) / Tab / Shift-Tab | `splitListItem` / `sinkListItem` / `liftListItem` (prosemirror-schema-list) |
| Tab / Shift-Tab (in a table) | `goToNextCell(1 / -1)` |
| Mod-Enter | insert `page_break` (body top level only) |
| Mod-k | open `LinkDialog` |
| Mod-z, Mod-y, Mod-Shift-z | swallowed (`() => true`). `handleDOMEvents.beforeinput` also calls `preventDefault()` for `historyUndo`/`historyRedo`, so native contenteditable undo cannot change the DOM behind ProseMirror |

**Toolbar commands** (`src/text/commands.ts`). Every command is disabled when the editor is read-only.

| Item id | Run | Enabled / active |
|---|---|---|
| `paragraphStyle` | `setBlockType(paragraph)` or `setBlockType(heading, { level })` for levels 1–6 | in a textblock / current type and level |
| `bold` `italic` `underline` `strike` | `toggleMark` | mark allowed / `markActive` |
| `fontFamily` `fontSize` `textColor` | `setTextStyle(patch)`, see below | text selection / attribute shown in `value()` |
| `link` | `LinkDialog` → `isAllowedHref(href)` (§20) → `addMark(link{href})`; an empty href removes the mark | non-empty selection or caret inside a link |
| `alignLeft` `alignCenter` `alignRight` `alignJustify` | `setNodeMarkup(pos, null, { ...attrs, alignment })` on each selected paragraph or heading | — / current alignment |
| `bulletList` `orderedList` | `wrapInList(type)`; when already in that list type, `liftListItem` | — / inside that list type |
| `indent` `outdent` | `sinkListItem` / `liftListItem` | inside a list |
| `insertTable` | `TablePicker` (rows × cols, ≤ 20 × 20) → insert a `table` of `table_cell`s, each holding an empty paragraph | allowed by schema at the selection |
| `tableAddRowBefore` `tableAddRowAfter` `tableAddColBefore` `tableAddColAfter` `tableDeleteRow` `tableDeleteCol` `tableMerge` `tableSplit` `tableToggleHeaderRow` `tableDelete` | the matching prosemirror-tables command (L5) | `isInTable` and the command's own dry run (`cmd(state)`) |
| `insertImage` | file picker → `insertImage(file)` (below) | editable |
| `imageAlt` | `ImageAltDialog` → `setNodeMarkup` alt | `NodeSelection` on an `image` |
| `pageBreak` | replace the selection with `page_break` at body top level | caret in a body top-level block |
| `header` / `footer` | add or remove the `header`/`footer` node (§11) | — / present |
| `pageSetup` | `PageSetupDialog` → `tr.setDocAttribute('size' / 'orientation' / 'margins', v)` (L2) | editable |

Defaults for `fontFamilies`, `fontSizes`, the page-size presets in `PageSetupDialog`, accepted image types, table-column drag-resize and image resize handles are **OQ-3/OQ-4/OQ-5**. Until they are answered, implementers add only what this table lists.

**`setTextStyle(patch)`** (`text_style` has the attributes `fontFamily`, `fontSize` and `color`, HLD §8.1):
```
if selection.empty: tr.setStoredMarks(merge(storedOrCursorMarks, patch)); return
for each text node segment [from,to] inside selection ranges:
  old ← segment.marks.find(text_style)?.attrs ?? {}
  attrs ← drop nulls({ ...old, ...patch })
  tr.removeMark(from, to, text_style)
  if attrs non-empty: tr.addMark(from, to, text_style.create(attrs))
dispatch(tr)
```

**Image insertion** (`src/text/imageUpload.ts`, through `AssetCache` and `asset-put`, CL-8):
```
insertImage(file):
  if file.type ∉ IMAGE_TYPES: notify(errors.imageType); return                 // OQ-4
  bytes ← new Uint8Array(await file.arrayBuffer())
  { w, h } ← natural size via createImageBitmap(new Blob([bytes])) ; scale to ≤ content width (keep ratio)
  id ← uid(); dispatch(tr.setMeta(imageUploadKey, { add: { id, pos: selection.from } }))
     // placeholder = Decoration.widget(pos, spinner, { side: -1, key: id }); positions map through every tr
  try assetId ← await assets.put(bytes, file.type)
  catch e: dispatch(remove id); notify(e.code ?? 'DOCUMENT_TOO_LARGE'); return
  pos ← placeholder position (null if its surroundings were deleted); dispatch(remove id)
  if pos ≠ null and still editable: dispatch(tr.insert(pos, image.create({ assetId, alt: '', width: w, height: h })))
```
- The step that references `assetId` is created only **after** the server has confirmed storage (C-7). Other clients' `asset-get` therefore never races the upload **(LLD choice)**.
- **`ImageView` node view:**
  - It creates an `<img>`, sets `alt`, `width` and `height` from attributes, and sets `src = assets.url(assetId)` when the asset is cached.
  - Otherwise it shows a sized placeholder and calls `assets.load(assetId).then(url ⇒ img.src = url)`.
  - On failure it shows a broken-image box.
  - `src` is only ever a `blob:` URL from `AssetCache` (HLD §14).

**Tests:**
- jsdom: each toolbar command's enabled, active and run behaviour on fixture documents.
- `setTextStyle` merges attributes per segment.
- Link command rejects `javascript:` and `data:`.
- Undo keys are swallowed.
- Image flow with a fake `AssetCache`: the placeholder maps through a concurrent remote insert above it, and nothing is inserted on failure.
- `ImageView` never sets a non-`blob:` `src`.

**E2E:**
- Image inserted in browser A appears in browser B.
- Page setup change in A repaginates B.

---

## 10. `PaginationPlugin` (V1; the S3 spike confirms the performance numbers)

**File:** `src/text/PaginationPlugin.ts`, with geometry in `src/text/geometry.ts`.

```ts
export interface PageGeometry { widthPx: number; heightPx: number; margin: { top: number; right: number; bottom: number; left: number }; gapPx: number }
export declare function pageGeometry(p: PageSettings): PageGeometry;   // units → CSS px (96/in); landscape swaps w/h (C-2)
export interface PageBreakMark { beforePos: number; page: number /* page that starts here */; spacerPx: number }
export interface PaginationState { breaks: readonly PageBreakMark[]; pageCount: number; tailSpacerPx: number; deco: DecorationSet }
export const paginationKey: PluginKey<PaginationState>;
export declare function PaginationPlugin(deps: { regions: HeaderFooterRegions }): Plugin<PaginationState>;
```

**Layout model** (LLD choice):
- The editor DOM is exactly one page wide (`widthPx`), with left and right padding equal to the margins. Line wrapping therefore depends only on `PageSettings`, not on the window width.
- Direct children of `body` get `margin: 0` (spacing comes from padding). Block heights then add up exactly, with no margin collapsing.
- A background layer `.odx-page-frames` draws `pageCount` page rectangles at `top = p · (heightPx + gapPx)`.
- The real `header` node renders as page 1's top-margin box: height `bodyTop`, content aligned to the bottom.
- The real `footer` node is the document's last child. A tail spacer pushes it into the last page's bottom-margin box: height `heightPx − bodyBottom`, content aligned to the top.

**Measure pass** (scheduled with `requestAnimationFrame` after view updates; skipped and rescheduled while `view.composing`):
```
g ← pageGeometry(doc.attrs)
hH ← regions.measuredHeight('header'); fH ← regions.measuredHeight('footer')
bodyTop ← max(g.margin.top, hH);  bodyBottom ← g.heightPx − max(g.margin.bottom, fH);  cap ← bodyBottom − bodyTop
blocks ← [(node, pos)] for top-level children of body
s ← first index where blocks[s].node !== last.blocks[s].node   (0 if geometry, hH or fH changed, or fonts loaded)
y ← last.yBefore[s]; page ← last.pageOf[s]                        // resume from the first changed block
for i ← s ..< blocks.length:
   h ← cache.get(node) ?? (cache.set(node, view.nodeDOM(pos).offsetHeight))   // DOM reads only, no writes
   forced ← i > 0 and blocks[i−1].node.type == page_break
   if forced or (y + h > cap and y > 0):                         // whole block moves to the next page
       breaks.push({ beforePos: pos, page: page + 1, spacerPx: (cap − y) + (g.heightPx − bodyBottom) + g.gapPx + bodyTop })
       page++; y ← 0
   yBefore[i] ← y; pageOf[i] ← page; y += h
pageCount ← page + 1; tailSpacerPx ← cap − y
if (breaks, pageCount, tailSpacerPx) differ from state: view.dispatch(tr.setMeta(paginationKey, {...}))  // no doc change
```
- **Spacer widget:**
  - `Decoration.widget(beforePos, toDOM, { side: -1, key: 'pb' + page + ':' + spacerPx, ignoreSelection: true })`.
  - Its DOM is a non-editable `div` of height `spacerPx`. It holds, in order: the read-only footer copy for page `page − 1`, the gap, and the read-only header copy for page `page`.
  - A `tail` widget before the real footer has height `tailSpacerPx`.
- **Blocks taller than `cap`:** a block such as a long table, a big image or a very long paragraph starts at the top of a new page and overflows the frame. Whether tables should split by rows is **OQ-2**.
- **Performance:**
  - ProseMirror reuses unchanged node objects across transactions, so the `WeakMap<Node, number>` height cache re-measures only changed blocks.
  - The arithmetic is O(blocks after the first change).
  - All DOM reads happen before the single meta dispatch, so there is no layout thrash.
  - Widget keys let the view reuse spacer DOM.
  - Header and footer copies are filled lazily: an `IntersectionObserver` on spacer widgets renders the copy only within ±2 viewports, so a 500-page document does not build 1,000 copies.
  - Caches are invalidated on `document.fonts` `loadingdone` and when `PageSettings` change.
  - Loop guard: at most 2 measure passes per frame.
- **View-only** documents paginate identically.

**Tests:**
- Unit (jsdom with a stubbed `offsetHeight` per node type):
  - break positions for fixtures: fits on one page; exact fill; `page_break`; a block taller than a page;
  - resume-from-first-change produces the same breaks as a full recompute (property test);
  - no dispatch when nothing changed;
  - landscape swaps width and height.
- **E2E (real layout):**
  - a fixture DOCX with a known page count renders the same page count;
  - typing at the end of page 1 moves the whole last paragraph to page 2;
  - a 300-page document stays under the S3 spike's frame-time budget while typing.

---

## 11. `HeaderFooterRegions` (V1, CL-9)

**File:** `src/text/HeaderFooterRegions.ts`.
- The document may contain one default `header` and one default `footer` (HLD §8.1).
- Each is **editable once**: the real node, inside the single `EditorView`, so its steps flow through the same OT stream. It is **shown read-only on every page**, as copies.

```ts
export declare class HeaderFooterRegions {
  constructor(deps: { assets: AssetCache; labels: Labels });
  nodeViews(): { header: NodeViewConstructor; footer: NodeViewConstructor };   // real, editable regions
  measuredHeight(kind: 'header' | 'footer'): number;                            // 0 when absent
  renderCopy(kind: 'header' | 'footer', state: EditorState): HTMLElement;       // read-only copy
  commands(): { addHeader: Command; removeHeader: Command; addFooter: Command; removeFooter: Command };
  destroy(): void;
}
```
- **Real regions:**
  - The node views add the classes `odx-header` and `odx-footer` and a `ResizeObserver`. A height change invalidates pagination from block 0.
  - The real header sits on page 1. The real footer sits on the last page, pushed down by the tail spacer.
- **Copies:**
  - A `DOMSerializer` is built from `DOMSerializer.nodesFromSchema(textSchema)` and `marksFromSchema`, with `image` overridden to produce an `<img>` whose `src` comes from `AssetCache` (blob only).
  - The copy root gets `contenteditable="false"`, `aria-hidden="true"` and `inert`.
  - Copies are cached per node identity, so an edit to the header rebuilds the copies once and spacer widgets swap them in.
- **Commands:**
  - `addHeader` inserts `header(paragraph())` at document position 0, and `addFooter` inserts `footer(paragraph())` at the end.
  - The remove commands delete the node.
  - These are ordinary steps, synced like any other.
- **Not supported (CL-9):** first-page and odd/even variants. Their absence comes from the codec as unsupported findings, not from the client.

**Tests:**
- A copy has no `contenteditable`, and its images are blob URLs.
- Editing the header changes every visible copy (E2E).
- Add and remove header round-trips through `TextSyncClient`.
- `measuredHeight` drives `bodyTop`.

---

## 12. `SheetEditorView` and `UniverBridge` (V2)

### 12.1 Univer setup (`src/sheet/univerSetup.ts`)

```
univer ← new Univer({ locale: LocaleType.EN_US, locales: { EN_US: mergeLocales(design, ui, docsUi, sheets, sheetsUi) } })
univer.registerPlugin(UniverRenderEnginePlugin)
univer.registerPlugin(UniverFormulaEnginePlugin, { notExecuteFormula: true })   // L8: hard dependency of sheets
univer.registerPlugin(UniverUIPlugin, { container: hostEl, header: true, footer: true, menu: hiddenMenus() })
univer.registerPlugin(UniverDocsPlugin); univer.registerPlugin(UniverDocsUIPlugin)        // cell editor
univer.registerPlugin(UniverSheetsPlugin, { notExecuteFormula: true })
univer.registerPlugin(UniverSheetsUIPlugin, { menu: hiddenMenus() })
// NOT registered: @univerjs/sheets-formula, sheets-formula-ui, numfmt-ui, conditional-formatting,
//                 data-validation, drawing, thread-comment, filter, sort, hyper-link (advanced = unsupported, PO-15)
univer.createUnit(UniverInstanceType.UNIVER_SHEET, workbookToUniver(snapshot, unitId))
api ← FUniver.newAPI(univer)   // + side-effect import '@univerjs/sheets/facade'
```

**CL-16 note:**
- Univer's sheets plugin cannot run without `UniverFormulaEnginePlugin` (L8).
- This LLD therefore registers it with `notExecuteFormula: true` and leaves out the sheets-formula plugins. The intended behaviour is the same as CL-16: no live recalculation, and cells show the last saved value.
- This needs the HLD wording change in **OQ-8**.
- **VERIFY IN SPIKE S1** that:
  - no recalculation happens;
  - a cell `{ v, f }` displays `v`;
  - the formula bar shows `f`.

**Read-only and view mode:** `api.getActiveWorkbook().setEditable(false)` (L7). As a backstop, the bridge's `beforeCommandExecuted` cancels every non-collab mutation while read-only (§12.6).

**Destroy:** `univer.dispose()`. **VERIFY IN SPIKE S1** that this also unmounts Univer's own React root.

### 12.2 Load mapping (`src/sheet/mapping.ts`)

```ts
export declare function workbookToUniver(wb: Workbook, unitId: string): IWorkbookData;
// sheetOrder ← wb.sheets.map(s ⇒ s.id); styles ← { [styleId]: styleToUniver(wb.styles[styleId]) }
// per sheet: { id, name, rowCount, columnCount: colCount, cellData: {r:{c:{ v, f, s: styleId }}},
//              mergeData: merges (IRange), columnData: {c:{ w }}, rowData: {r:{ h }},
//              freeze: { xSplit: frozen.cols, ySplit: frozen.rows, startRow: frozen.rows, startColumn: frozen.cols } }
export declare function styleToUniver(s: Style): IStyleData;
export declare function univerToStyle(u: IStyleData): Style;
```

| Our `Style` field (Part 1 names) | Univer `IStyleData` |
|---|---|
| font family / size | `ff` / `fs` |
| bold / italic | `bl` / `it` (BooleanNumber) |
| underline / strikethrough | `ul { s: 1 }` / `st { s: 1 }` |
| text colour / fill | `cl { rgb }` / `bg { rgb }` |
| borders | `bd { t, r, b, l: { s, cl } }` |
| horizontal / vertical alignment | `ht` / `vt` |
| wrap | `tb` (WrapStrategy) |
| number format | `n { pattern }` (if Part 1's `Style` has it; editing UI is OQ-10) |

- Fields that Univer has but our `Style` lacks (`tr`, `td`, `pd`, `ol`, `bbl`, `va`) are dropped when mapping a local change.
- Styles are compared as canonical JSON (sorted keys). The bridge keeps `styleIndex: Map<canonicalJson, styleId>`, built from `shadow.styles`.

### 12.3 Local Univer mutation → `SheetOp`

**Capture:**
- The bridge listens with `api.addEvent(Event.CommandExecuted, e ⇒ …)` (L7).
- It captures only events where `e.type === CommandType.MUTATION`, `!e.options?.fromCollab`, `!e.options?.onlyLocal`, and `applyingRemote === false`.
- Mutations are **grouped per top-level command**. A group opens at `BeforeCommandExecute` for a `COMMAND` at stack depth 0 and closes at its `CommandExecuted`. A `queueMicrotask` fallback closes the group otherwise. **VERIFY IN SPIKE S1** that the nesting order holds for async commands.

**Read-after-apply (LLD choice):** cell content is never interpreted from mutation params. After the group, the bridge reads the affected cells from the worksheet, so merge semantics such as partial styles (L9) are already resolved.
```
cellOut(ws, r, c): ICellData | undefined → our Cell | null:
  u ← ws.getCellRaw(r, c)  (VERIFY S1: exact accessor) ; if empty: null
  style ← u.s ? univerToStyle(workbook.getStyles().getStyleByCell(u)) : undefined
  sid ← style ? (styleIndex.get(canon(style)) ?? defineNew(style)) : undefined     // defineNew emits defineStyle first
  return { v: u.v ?? undefined, f: u.f || undefined, s: sid }                       // u.p (rich text) → plain text; OQ-10
```
New style ids are `${clientId}.${n}` **(LLD choice)**: unique per client, with no hashing and no collisions. A style equal to an existing one reuses that id.

| Univer mutation id (L9) | Params used | Emitted `SheetOp`s (in order) |
|---|---|---|
| `sheet.mutation.set-range-values` | `subUnitId`, keys of `cellValue` | `defineStyle`* , `setCells{ sheetId, cells: [(r, c, cellOut)] }` |
| `sheet.mutation.insert-row` | `range.startRow..endRow` | `insertRows{ at: startRow, count }`, then `setCells` for non-empty cells in the new rows (inherited styles) |
| `sheet.mutation.remove-rows` | `range` | `deleteRows{ at, count }` |
| `sheet.mutation.insert-col` / `sheet.mutation.remove-col` | `range.startColumn..endColumn` | `insertCols` / `deleteCols` (+ `setCells` for new columns) |
| `sheet.mutation.add-worksheet-merge` / `sheet.mutation.remove-worksheet-merge` | `ranges[]` | `mergeCells` / `unmergeCells`, one per range. **Skipped inside a group that contains a structural mutation**, because the server derives merges from the structural op |
| `sheet.mutation.set-worksheet-col-width` | `ranges`, `colWidth` | `setColWidth{ col, width }` per column (read after apply) |
| `sheet.mutation.set-worksheet-row-height` | `ranges`, `rowHeight` | `setRowHeight{ row, height }` per row |
| `sheet.mutation.set-frozen` | `startRow`, `startColumn`, `xSplit`, `ySplit` | `setFrozen{ rows: ySplit, cols: xSplit }` (top-left freeze only; **VERIFY S1**) |
| `sheet.mutation.insert-sheet` | `index`, `sheet` | `addSheet{ sheetId: sheet.id, name, index, rowCount, colCount }` + `setCells` for any content |
| `sheet.mutation.remove-sheet` | `subUnitId` | `removeSheet` |
| `sheet.mutation.set-worksheet-name` | `subUnitId`, `name` | `renameSheet` |
| `sheet.mutation.set-worksheet-order` | `subUnitId`, `toOrder` | `moveSheet{ sheetId, toIndex }` |
| `sheet.mutation.move-range` (drag or cut-paste) | `from` / `to` ranges | `setCells` for both ranges (read after apply) |
| `sheet.mutation.set-worksheet-row-count` / `…-column-count` | new count | an increase becomes `insertRows` / `insertCols` at the old end; a decrease becomes `deleteRows` / `deleteCols` at the end (**VERIFY S1**) |
| `sheet.mutation.set.numfmt` / `sheet.mutation.remove.numfmt` | ranges | `setCells` (style changed) if number formats are in scope; otherwise blocked (OQ-10) |
| `sheet.mutation.set-worksheet-row-auto-height`, `…-row-is-auto-height` | — | **local only, not mapped** (each client computes auto heights; **VERIFY S1**) |
| anything else, e.g. `set-row-hidden`, `set-col-hidden`, `set-row-data`, `set-col-data` (row/col styles), `move-rows`, `move-columns`, `set-tab-color`, `set-worksheet-hidden`, `toggle-gridlines`, range themes, protection | — | **blocked** (§12.6) |

After a group with a structural op, the bridge calls `SheetSyncClient.onLocalOps(ops)` and then `reconcileDerived(sheetIds)` (§12.4).

### 12.4 `SheetOp` → Univer (remote, `fromCollab`)

Ops are applied **synchronously** with `api.syncExecuteCommand(id, params, { fromCollab: true })`, with `applyingRemote = true` for the duration, so follow-up mutations that Univer controllers run synchronously are not captured.

| `SheetOp` | Univer mutation and params |
|---|---|
| `setCells` | `sheet.mutation.set-range-values { unitId, subUnitId, isOverrideStyle: true, cellValue: { r: { c: cell == null ? null : { v, f: f ?? null, s: s ? styleToUniver(shadow.styles[s]) : null, p: null, si: null } } } }` (explicit nulls clear stale keys; **VERIFY S1**) |
| `defineStyle` | none (styles are inlined by `setCells`); update `styleIndex` |
| `insertRows` / `deleteRows` | `sheet.mutation.insert-row` / `sheet.mutation.remove-rows { range: { startRow: at, endRow: at + count − 1, startColumn: 0, endColumn: colCount − 1 } }` |
| `insertCols` / `deleteCols` | `sheet.mutation.insert-col` / `sheet.mutation.remove-col` (same range shape on columns) |
| `mergeCells` / `unmergeCells` | `sheet.mutation.add-worksheet-merge` / `sheet.mutation.remove-worksheet-merge { ranges: [range] }` |
| `setColWidth` / `setRowHeight` | `sheet.mutation.set-worksheet-col-width { ranges, colWidth }` / `sheet.mutation.set-worksheet-row-height { ranges, rowHeight }` |
| `setFrozen` | `sheet.mutation.set-frozen { startRow: rows, startColumn: cols, ySplit: rows, xSplit: cols }` |
| `addSheet` / `removeSheet` | `sheet.mutation.insert-sheet { index, sheet: emptyWorksheetData(...) }` / `sheet.mutation.remove-sheet { subUnitId, subUnitName }` |
| `renameSheet` / `moveSheet` | `sheet.mutation.set-worksheet-name { name }` / `sheet.mutation.set-worksheet-order { fromOrder, toOrder }` |

**`reconcileDerived(sheetIds)`** runs after every structural op, local or remote:
- Univer does not shift formula references without the sheets-formula plugins.
- So, for **every** sheet (because of cross-sheet references), it compares `f` of each formula cell in `shadow` (already shifted by the shared `SheetOtType.apply` / `shiftFormulaReferences`) with Univer, and writes the differences through `set-range-values` with `fromCollab: true`.
- For the affected sheet it does the same for the merge list: remove stale merges and add missing ones.
- Cost is O(formula cells + merges).
- The derived writes are never sent, because the server derives the same changes (PO-9).

**`reconcileSheets(ids)`** is the slow repair path used after a cancelled mutation or a dropped op. It rewrites the cells in the touched ranges, the merges, the sizes and the freeze from `shadow`.

### 12.5 Selection through remote ops (`src/sheet/selectionMap.ts`)

```ts
export declare function mapRangeThroughOp(r: IRange, sheetId: string, op: SheetOp): IRange | null;
```
- `insertRows{at, count}`: rows ≥ `at` shift by `+count`. A range that spans `at` grows.
- `deleteRows`: deleted rows are removed from the range. A range that is fully deleted collapses to row `min(at, rowCount − 1)`.
- Columns follow the same rules.
- `removeSheet` of the active sheet: no range is restored. Univer activates another sheet (**VERIFY S1**).

Capture and restore use `SheetsSelectionsService.getCurrentSelections()` / `setSelections(...)` (L9 source), reached through the facade's injector. **VERIFY S1** whether Univer already moves the selection on `fromCollab` insert and remove mutations; if it does, `restoreSelection` becomes a no-op.

If the cell editor is open on a cell that a remote op deletes, the bridge closes the editor without committing (**VERIFY S1** for the operation id). A remote `setCells` on the cell being edited leaves the editor open. When the user commits, that later edit wins [§6].

### 12.6 Blocked features and the cached-value display

- **Blocking (`src/sheet/blocked.ts`):**
  1. `hiddenMenus()` hides the Univer menu items for features we cannot represent. **VERIFY S1** for the exact menu ids.
  2. A `BeforeCommandExecute` listener sets `event.cancel = true` for blocked command ids (L7).
  3. Backstop: a `beforeCommandExecuted` listener throws `CanceledError` for any `MUTATION` whose id is not in the §12.3 allowlist and that is not `fromCollab`, `onlyLocal` or `fromChangeset`. While read-only, it throws for every such mutation. If a command was partly applied, the group-close hook runs `reconcileSheets`.
  4. Univer's undo and redo (`univer.command.undo` / `univer.command.redo`) are cancelled the same way, because undo is B2 (V6, OQ-7).
- **Cached values (CL-16):**
  - Cells are created with `{ v, f }`, and with no executing formula engine Univer renders `v` (**VERIFY S1**).
  - A shift in a formula reference changes `f` but not `v`, as on the server.
  - What a cell shows when a user types a **new** formula (`f` without `v`) is **OQ-9**. The mapping keeps `f` and leaves `v` unset.

**Tests (V2):**
- Unit with a **fake facade**: an event emitter that replays recorded `CommandExecuted` sequences captured during S1.
  - every row of §12.3 maps to the expected ops;
  - grouped structural commands skip merge mutations;
  - blocked ids are cancelled;
  - every row of §12.4 produces the expected `syncExecuteCommand(id, params, { fromCollab: true })` calls;
  - `mapRangeThroughOp` table tests;
  - `styleToUniver`/`univerToStyle` round trip.
- **Playwright with a real Univer:**
  - two browsers edit the same cell → the later edit wins;
  - row insert in A while B edits a cell below → B's value lands on the shifted row;
  - formula `=A5` becomes `=A6` after a row insert above, the cached value is unchanged, and `#REF!` appears after the row is deleted;
  - merge, column width, row height and freeze sync;
  - hide-row and undo are unavailable;
  - a view session cannot edit.

---

## 13. `AssetCache` (V1)

**File:** `src/assets/AssetCache.ts`. Covers CL-8 and HLD §14 (blob URLs only).

```ts
export declare class AssetCache {
  constructor(deps: { send(m: AssetPutMsg | AssetGetMsg): boolean; connected(): boolean; maxConcurrentGets?: number /* 4 */ });
  url(assetId: string): string | undefined;                 // sync; blob: URL if cached
  load(assetId: string): Promise<string>;                   // one request per id in flight; resolves blob URL
  put(bytes: Uint8Array, mime: string): Promise<string>;    // resolves assetId after server confirmation (C-7)
  onAsset(m: AssetMsg): void;                               // bytes → blob URL; or put-confirmation
  onAssetError(m: ErrorMsg): void;                          // correlated by m.assetId (C-7)
  onReconnected(): void;                                    // re-send outstanding gets/puts once
  destroy(): void;                                          // revoke all URLs, reject outstanding promises
}
```
```
put(bytes, mime):
  if mime ∉ IMAGE_TYPES: reject(local CLIENT_IMAGE_TYPE_UNSUPPORTED)             // PO-24 list; L-16
  if limits.maxAssetBytes known and bytes.length > it: reject(CLIENT_ASSET_TOO_LARGE) // optional LoadStartMsg.limits (§20); L-16
  id ← await computeAssetId(bytes)                                                // shared, SHA-256 hex (§20)
  if urls.has(id): return id                                                      // already stored and cached
  urls.set(id, URL.createObjectURL(new Blob([bytes], { type: mime })))            // the inserting client sees it at once
  send(AssetPutMsg{ assetId: id, mime, bytes }); await confirmation (timeout 60 s → reject)
load(id):    if urls.has(id) return it; if inflight[id] return it; queue (≤ maxConcurrentGets) → send(AssetGetMsg{ assetId })
onAsset(m):  if m.bytes: mime ← IMAGE_TYPES.has(m.mime) ? m.mime : 'application/octet-stream'   // never text/html
                         urls.set(m.assetId, URL.createObjectURL(new Blob([m.bytes], { type: mime }))); resolve
             else if put pending for m.assetId: resolve put
destroy():   for url in urls: URL.revokeObjectURL(url); urls.clear(); reject all pending
```
- **Revocation (LLD choice):** blob URLs are revoked only on `destroy()`. Assets are content-addressed and stay valid across reloads, and their number is bounded by the document's images.
- **Secure context:** `crypto.subtle` requires HTTPS or localhost. The adopter documentation states this.

**Tests:**
- One `asset-get` per id even with concurrent `load` calls.
- The concurrency cap holds.
- A non-image MIME type becomes `application/octet-stream`.
- `put` resolves only on confirmation and rejects on a correlated error or timeout.
- `destroy` revokes every URL.
- Outstanding requests are re-sent after a reconnect.

---

## 14. React shell components (V1; Upload V4; Annotations V5)

All components read state through `useSession()` and render only text and React elements (no `dangerouslySetInnerHTML`, §15).

| Component | File | Props | Behaviour |
|---|---|---|---|
| `Shell` (V1) | `ui/Shell.tsx` | `{ session }` | Layout: `Toolbar` (unless `ui.toolbar === false`) / `UnsupportedBanner` / `EditorHost` / `StatusBar`, plus a side `AnnotationsPanel` (V5). `ErrorScreen` replaces `EditorHost` in `terminal`. A progress overlay shows while `load === 'loading'`. |
| `Toolbar` (V1) | `ui/Toolbar.tsx` | `{ items, commands, shellItems }` | `role="toolbar"`, roving tabindex, `aria-pressed` for toggles, values for selects. It re-renders on editor `subscribe`. For sheets it shows only shell items, because Univer's own ribbon is used with `hiddenMenus()` (`ui.toolbar.sheet.items` maps to Univer menu visibility). |
| `StatusBar` (V1) | `ui/StatusBar.tsx` | — | `role="status"`, `aria-live="polite"`. Shows: connection state; sync state (`synced` "All changes confirmed", `pending` "N changes unconfirmed", `busy` "Server busy — retrying", `restoring` "Restoring unconfirmed changes"); the storage notice (`local`, `pending`, `conflict`, from `NoticeMsg`); and load progress. |
| `UnsupportedBanner` (V1) | `ui/UnsupportedBanner.tsx` | `{ findings, canEditAnyway }` | `role="alert"`. Lists findings (label = `labels.findings[f.kind] ?? f.message`, where `f` follows Part 1's `UnsupportedFinding`). The warning text says those parts are removed when the document is saved (PO-13). The "Edit anyway" button shows only if `hooks.onEditAnyway`, `access === 'edit'` and `readOnlyReason === 'unsupported'`. Click: disable, await `onEditAnyway(documentId)`, then wait for the server's read-only-off `notice`. A rejected promise shows an inline error. After the switch, the banner collapses to one warning line. |
| `ReadOnlyBadge` (V1) | `ui/ReadOnlyBadge.tsx` | `{ reason }` | Text per reason: `view` "View only", `unsupported`, `server`, `restoring`. |
| `ShareButton` (V1) | `ui/ShareButton.tsx` | — | Rendered only if `hooks.onShare`. Calls `onShare(documentId)`; the adopter builds the link (Add-on 3 §5). |
| `UploadButton` (V4) | `ui/UploadButton.tsx` | — | Rendered only if `hooks.onUpload`. File picker (`.docx,.odt,.xlsx,.ods`) → `UploadClient` streams 256 KiB pieces with the V4 upload messages (§20), throttled while `connection.bufferedAmount > 1 MiB` (LLD choice). Shows progress. On the server's done message → `onUpload({ documentId, fileName })`. Errors map through §16. |
| `AnnotationsPanel` (V5) | `ui/AnnotationsPanel.tsx` | — | Lists bookmarks and side notes. Anchors are the V5 marks or nodes in the document (Part 1), so they sync by OT. Note content travels through the V5 `annotation-*` messages (§20). Actions: add a bookmark at the selection (an ordinary step), add, edit or delete a note, and jump to an anchor (`scrollIntoView`). Text documents only, until OQ-11 is answered. |
| `ErrorScreen` (V1) | `ui/ErrorScreen.tsx` | `{ error }` | Shows `labels.errors[code]` and a "Reload" button → `session.retry()`. |
| `EditorHost` (V1) | `ui/EditorHost.tsx` | — | A `div` ref; `useLayoutEffect` → `session.attachEditor(el)`, cleanup → `detachEditor`. |

- **Dialogs** (`LinkDialog`, `ImageAltDialog`, `PageSetupDialog`, `TablePicker`) are controlled React forms rendered in a portal **inside** `.odx-root`, so the adopter's page DOM is not touched.

**Tests (Vitest + Testing Library + jsdom):**
- Each component renders from a fake session snapshot.
- `ShareButton` and `UploadButton` are hidden without their hook, and `ShareButton` calls `onShare` with `documentId`.
- Edit-anyway flow: the button is disabled while pending, the banner collapses after the notice, and an inline error shows on rejection.
- Labels override the defaults.
- Accessibility roles are present.

---

## 15. Client-side security (V1; HLD §14)

| Item | Rule |
|---|---|
| Link `href` | Only `http:`, `https:` and `mailto:`. The link command validates with `isAllowedHref` (§20), parsed through `new URL(href)`, and the scheme is compared lowercase after trimming. Defence in depth: the shared schema's `toDOM` drops a disallowed `href` (C-2), so a malicious remote step renders as plain text. Links render with `rel="noopener noreferrer nofollow"` and `target="_blank"`. In edit mode, Mod+click opens them through `window.open(href, '_blank', 'noopener,noreferrer')` after re-validating. In view mode, a normal click follows the link. |
| No `innerHTML` | React text nodes only. ESLint rules `react/no-danger` and `no-restricted-properties` (on `innerHTML` / `outerHTML` / `insertAdjacentHTML`) fail CI. ProseMirror DOM comes from `toDOM` and `DOMSerializer` only. ProseMirror parses pasted HTML in a detached document, through the schema allowlist, so external `<img src>` cannot enter the document because `image` requires `assetId`. |
| Images | `src` is only a `blob:` URL that `AssetCache` created. The blob MIME type is forced to the image allowlist, or to `application/octet-stream`. |
| Univer | Content is cell data only (HLD §14). Rich text in a cell (`p`) is flattened to plain text (OQ-10). |
| Tokens | Never logged. They never appear in `ClientError` or in events. `getToken` is called just in time. The documentation warns about query-string tokens (HLD §14). |
| Errors | The client only receives `{ code, retryable, message }` (HLD §11.1). The UI prefers `labels.errors[code]` over `message`. |
| CSP for adopters (documentation) | `connect-src wss:`, `img-src blob:`. ProseMirror style attributes and Univer need `style-src 'unsafe-inline'`. **VERIFY S1** for Univer's exact needs. |

**Tests:**
- A remote step adding `link{href:'javascript:alert(1)'}` renders without an `href`.
- Pasting HTML with `<img src=http…>` and `<script>` produces no image and no script.
- The CI lint rule catches `dangerouslySetInnerHTML`.
- `ImageView` and the header/footer copies never use non-blob `src`.

---

## 16. Error display and policy (V1; `src/errors/policy.ts`)

```ts
export type ClientPolicy = 'notice' | 'retry-submit' | 'reconnect' | 'reload' | 'discard-reload' | 'read-only' | 'asset-failed' | 'terminal';
export declare function policyFor(e: { code: ErrorCode; retryable: boolean; clientSeq?: number; assetId?: string }, phase: SessionPhase): ClientPolicy;
```
Every surfaced error calls `hooks.onError(ClientError)` and emits `error`. The **unknown-code rule** is: `retryable` → `reconnect`, otherwise `terminal`.

| Code (HLD §11.2) | Policy | User-facing behaviour |
|---|---|---|
| `CONFIG_INVALID` | thrown by `mount()`; from the server → terminal | ErrorScreen "Editor is misconfigured" |
| `CONFIG_LIBREOFFICE_NOT_FOUND`, `CONFIG_DATA_DIR_UNWRITABLE` | terminal (not expected at clients) | ErrorScreen, generic |
| `STORAGE_READ_FAILED` | load: `retryable` → reconnect, else terminal | "Document could not be loaded" + Reload |
| `STORAGE_WRITE_FAILED` | notice (warning) | StatusBar warning; editing continues |
| `STORAGE_LOCAL_MODE` | notice; `status.storage = 'local'` | "Saved on the server; storage unavailable" |
| `STORAGE_PENDING` | notice; `storage = 'pending'` | "Saved locally on the server; administrator action needed" |
| `STORAGE_CONFLICT` | notice; `storage = 'conflict'` | warning; editing continues (HLD §10.4) |
| `QUEUE_FULL` | retry-submit | `sync = 'busy'` "Server busy — retrying"; typing continues [A3] |
| `QUEUE_UNAVAILABLE` (V3) | `retryable` → retry-submit, else terminal | as above |
| `ENGINE_RESTARTING` | reconnect (≥ 1 s) | "Reconnecting — server restarting" |
| `ENGINE_UNAVAILABLE`, `ENGINE_FAILED` | terminal | "Service unavailable" + Reload |
| `DOCUMENT_FAULTED` | `retryable` → reload, else terminal | "This document hit an error" (+ Reload) |
| `DOCUMENT_UNSUPPORTED_CONTENT` | read-only (`unsupported`) | banner (§14) |
| `DOCUMENT_READ_ONLY` | read-only (`server`) + discard-reload if pending | badge + notice `restore.discarded` (OQ-13) |
| `DOCUMENT_NOT_FOUND` | terminal | "Document not found" |
| `DOCUMENT_TOO_LARGE` | on load: terminal; with `assetId`: asset-failed | ErrorScreen, or a toast "Image too large" |
| `CONVERSION_FAILED` | terminal | "Document could not be opened" |
| `CONVERSION_TIMEOUT` | `retryable` → reconnect, else terminal | "Opening is taking too long" + Reload |
| `SESSION_SLOW_CONSUMER` | reload (HLD §11.4) | brief "Reloading…" |
| `SESSION_CLOSED` | terminal (the adopter ended the session; never auto-reconnect) | "Session ended" + Reload |
| `SESSION_RESYNC_REQUIRED` | reload (with rescue) | brief "Reloading…" |
| `ACCESS_DENIED` | with `clientSeq`: discard-reload; otherwise terminal | "You don't have permission" |
| `PROTOCOL_INVALID_MESSAGE` | with `clientSeq`: discard-reload; otherwise reload (twice in a row → terminal) | "Reloading…" / ErrorScreen |
| `PROTOCOL_VERSION_UNSUPPORTED` | terminal | "Please refresh the page to update the editor" |
| `PROTOCOL_OP_REJECTED` | discard-reload | notice "A change could not be applied and was discarded" |

`NoticeMsg` handling:
- `storage` updates `status.storage`.
- `read-only` calls `setReadOnly(on/off)`.
- `engine-restarting` sets `connection` to `reconnecting`.

The notice field names come from Part 1.

**Tests:** a table test over every row, including the `retryable` variants and the unknown-code rule.

---

## 17. End-to-end suite (Playwright, V1/V2)

The suite runs against Part 2's test server: main mode, `LocalFsStorage` in a temporary directory, real LibreOffice in the CI image.
1. Two browsers converge on concurrent typing, including the BRD "cat" case, and the carets are preserved.
2. View-only session: the toolbar is disabled, no `submit` frame is sent (frame spy via `page.on('websocket')`), and remote edits still appear.
3. Reconnect after a dropped socket with pending typing → no loss and no duplication.
4. Worker killed → close 4001 → resync → rescue (`N == R`) → typing preserved.
5. `QUEUE_FULL` with `perDocument: 1` → the busy status shows, and everything converges.
6. Slow consumer (tiny high-water mark) → reload and convergence.
7. Unsupported-content fixture → read-only banner → "Edit anyway" through the adopter route → editable.
8. Image insert in A appears in B, with a blob `src`.
9. Pagination: the page count for fixture files; header/footer copies on every page.
10. Link with `javascript:` is not clickable.
11. V2: the sheet scenarios in §12.6.
12. `destroy()` while connected leaves no open sockets (CDP check).

---

## 18. Version tags summary

| Version | Client items |
|---|---|
| V1 | §1–§7, §9–§11, §13–§16, the text parts of §17 |
| V2 | §8, §12, the sheet chunk and `sheet.css`, row-range chunks in §5 |
| V3 | none on the client (`QUEUE_UNAVAILABLE` row in §16 only) |
| V4 | `UploadButton`, the upload client, `onUpload` |
| V5 | `AnnotationsPanel`, the annotation messages |

---

## 19. Cross-part contract assumptions — reconciled in LLD §0.3

| ID | Assumption | Owner |
|---|---|---|
| C-1 | `rebaseSteps(steps, over, doc) → { steps, kept, doc }`, mapping-only and dropping steps that fail (CL-6). If Part 1's signature differs, the client adapts in `TextSyncClient.rebuild` only. | Part 1 |
| C-2 | `PageSettings` = `doc.attrs { size, orientation, margins }` with a documented unit. `TextSnapshot` converts to a PM `Node`. The `link` mark's `toDOM` omits disallowed `href`s. `alignment` values are `left | center | right | justify`. | Part 1 |
| C-3 | On `hello.resume` with a matching epoch, the server replays committed ops after `rev` as `RemoteMsg`s in order, **including the sender's own** (`clientId` = sender), and processes the hello before any later `submit` from that connection. Otherwise it sends `ResyncMsg` or a fresh `LoadStartMsg`. | Part 2 |
| C-4 | A duplicate `(clientId, clientSeq)` is not re-applied, and the server answers `AckMsg { clientSeq, rev: <originally assigned rev> }`. | Part 2 |
| C-5 | Revision numbering continues across epochs when an instance is rebuilt from its journal (HLD §10.5). A `baseRev` the server cannot rebase from is rejected with `SESSION_RESYNC_REQUIRED` or `PROTOCOL_OP_REJECTED` and carries `clientSeq`. A `submit` with a stale `epoch` is rejected and not applied. | Part 2 |
| C-6 | `transformSheetOp(op, over, opIsLater) → SheetOp[]`, and `SheetOtType.rebase(ops, over) ≡ xform(ops, true, over)[0]`. | Part 1 |
| C-7 | An `AssetPutMsg` is confirmed by an `AssetMsg { assetId }` without bytes, sent after the asset is stored. Asset errors are `ErrorMsg` values with an `assetId` field. An `asset-get` reply is `AssetMsg { assetId, mime, bytes }`. | Parts 1/2 |
| C-8 | Before closing with any app close code other than `ENGINE_RESTARTING`, the server sends an `ErrorMsg` with the reason. `ErrorMsg.clientSeq` is set for submit-specific errors. | Part 2 |
| C-9 | `encodeMessage` / `decodeServerMessage` carry binary payloads as `Uint8Array` fields, and the client sets `binaryType = 'arraybuffer'`. | Part 1 |

---

## 20. New contract names — reconciled in LLD §0.3

| Name | Where | Definition | Version |
|---|---|---|---|
| `PingMsg` / `PongMsg` | shared protocol | `{ type: 'ping', id: number }` C→S; `{ type: 'pong', id: number }` S→C. The client heartbeat (HLD §13). The Gateway may answer without forwarding to the Core. | V1 |
| `WS_SUBPROTOCOL` | shared protocol | `'open-docex.v1'`. The first `Sec-WebSocket-Protocol` entry when `auth.type === 'subprotocol'`. The Gateway must select it (the `ws` default does, L14). | V1 |
| `DOC_QUERY_PARAM` | shared protocol | `'doc'`, the connect-URL parameter carrying the document ID (HLD §10.1). | V1 |
| `isAllowedHref(href: string): boolean` | shared text | Allowlist of http, https and mailto. Used by schema `toDOM`/`parseDOM`, by server `validateOps` and by the client link command. | V1 |
| `computeAssetId(bytes: Uint8Array): Promise<string>` | shared ids | Lowercase hex SHA-256 via `globalThis.crypto.subtle`. Isomorphic (browser and Node ≥ 22). | V1 |
| `LoadStartMsg.totalChunks?: number` | shared protocol (optional, additive) | Lets the client show a percentage. | V1 |
| `LoadStartMsg.limits?: { maxAssetBytes?: number }` | shared protocol (optional, additive) | Client-side size check before `asset-put`, which avoids a 1009 close. | V1 |
| `ErrorMsg.assetId?: string` | shared protocol (optional, additive) | Correlates asset errors (C-7). | V1 |
| `UploadStartMsg`, `UploadChunkMsg`, `UploadEndMsg`, `UploadDoneMsg` | shared protocol (proposed names for HLD `upload-*`) | start `{ uploadId, fileName, size, format }`, chunk `{ uploadId, seq, bytes }`, end `{ uploadId }`, done `{ uploadId, documentId }` | V4 |
| `AnnotationGetMsg`, `AnnotationPutMsg`, `AnnotationDeleteMsg`, `AnnotationMsg` | shared protocol (proposed names for HLD `annotation-*`) | note content by `annotationId`; anchors stay in the document model | V5 |

Client-only names (not shared): `DocumentSession`, `syncKey`, `paginationKey`, `xform`, `mapRangeThroughOp`, `policyFor`, `EditorCommand`.

---

## 21. Open questions for the project owner — resolved in LLD §0.1–§0.2

1. **OQ-1 — Connection that never opens.** Browsers report a rejected upgrade (401/403/503) as close code 1006, the same as a network failure (L12). Options:
   - (a) retry forever while showing "Connecting…";
   - (b) after K attempts that never open, show a terminal "Could not connect" and call `onError`.

   If (b), what value for K, and which `ErrorCode`? See OQ-14.
2. **OQ-2 — Blocks taller than one page** (long tables, large images, very long paragraphs) under the HLD's whole-block rule. Should they overflow the page frame, or should tables split by rows?
3. **OQ-3 — Table column drag-resize** (`columnResizing`, which edits `colwidth`) in V1. Yes or no?
4. **OQ-4 — Images.** Which types may users insert (proposed: png, jpeg, gif, webp)? Should paste or drop of image files be allowed? Should there be resize handles?
5. **OQ-5 — Toolbar defaults:** the font-family list, the font-size list, and the page-size presets in Page Setup.
6. **OQ-6 — Unconfirmed changes that cannot be rescued.** This happens after an engine restart when the in-flight batch was committed but not acknowledged and the user kept typing, or when the server can no longer rebase from the client's old base. Is a visible "some changes could not be restored" notice acceptable?
7. **OQ-7 — No undo/redo before V6 (B2)** in either editor. Univer's built-in undo would also be disabled. Please confirm.
8. **OQ-8 — CL-16 wording.** Current Univer makes the formula-engine plugin a hard dependency of the sheets plugin (L8). Proposal: register it with `notExecuteFormula: true` and do not register the sheets-formula plugins. This has the same behaviour as CL-16, but the HLD text needs updating.
9. **OQ-9 — New formulas typed before V6:** what should a cell with `f` but no saved `v` show (blank, the formula text, or a marker)?
10. **OQ-10 — Univer features our V2 model cannot represent:** row/column-level styles, hide rows/columns, drag-moving rows/columns, tab colour, gridlines, rich text inside a cell, number-format editing. Should all of them be hidden or blocked in V2? Is number-format *editing* part of "cell formatting"?
11. **OQ-11 — V5 annotations for spreadsheets**, or text documents only?
12. **OQ-12 — Leaving the page with unconfirmed changes.** Should the package register a `beforeunload` prompt, or leave it to the adopter, who has the `sync` event?
13. **OQ-13 — Read-only switch mid-session** (access revoked, or `DOCUMENT_READ_ONLY`). Discarding the user's unconfirmed changes with a notice is proposed. Acceptable?
14. **OQ-14 — Client-side error codes.** Some failures have no server-side code: a connection that never opens, a UI render crash, a rejected image type. Should a `CLIENT_*` family be added to HLD §11.2, or should they map to existing codes (e.g. `SESSION_CLOSED`)?
15. **OQ-15 — Customisation inside Univer.** Should `ui.theme` and `ui.labels` also cover Univer's own grid, menus and language (Univer has its own theme and locale system), or only our shell?
