# open_docex — Version Plan

**Status: PROPOSED.** Claude wrote this plan. It is not final until the project owner approves it.

**Scope source:** the BRD (`draft_description_of_the_product_package.docx`). That means the original draft, Addendum §1–§6, Add-on (A/B), Add-on 2 and Add-on 3. This plan includes nothing outside the BRD. Section references in brackets point to the BRD.

**Not covered here:**
- **Version numbers:** V1–V7 are plan labels. npm version numbers are chosen at publish time.
- **Editor choice and file-format support:** the BRD leaves these to design (Addendum intro), so this plan doesn't assign them to a version.

## How the versions are cut (proposal)

- Each version works on its own and builds on the previous one.
- V1 includes data safety and failure handling, because the BRD's "MAIN" question and §4–§5 are core.
- V1–V5 complete the main (own-OT) scope. V6 and V7 are the two separate versions recorded in Add-on 2 and Add-on 3.

## Before V1 is published

- Choose the licence: MIT or Apache-2.0. [Add-on 3 §4]

## V1 — Collaborative text documents

**Backend**
- A factory creates one collaboration instance per document. [Draft; §1]
- The engine's own server-sequenced OT merges text edits. [A1; Add-on 3 §3]
- Changes are processed in FIFO order per document, using a bounded in-memory queue with backpressure. When the queue is full, changes are rejected with `QUEUE_FULL`. [Draft CONFIGURABLE; §2; A3]
- A queue interface lets the V3 Redis/Kafka adapters plug in without changing the core. [Draft CONFIGURABLE]
- Each change is broadcast to the other users. The sender gets an acknowledgement with the assigned revision. [Draft; A6]
- The engine runs in one shared worker process by default, or in the main process if configured. [§2]
- The main process supervises the worker and restarts it with backoff. Past the limit, the engine is marked FAILED. A failure in one instance doesn't affect the others. [A2]
- Errors use the A2 error shape and code families. [A2]
- Storage:
  - a storage interface that exposes a version, ETag or last-modified value
  - the local fallback folder
  - a local change journal, with periodic snapshots to storage

  [Draft; §4; A5]
- Storage failure: the engine switches to a local copy and makes 3 delayed retries (1, 5 and 15 minutes, configurable). After that the copy is marked pending, and the engine checks for conflicts before writing back. [§4; §5; A4]
- Document sources: a file or URL from the adopter, the local fallback, or a new blank document. [§1; Add-on 3 §5]
- The first load streams in chunks from a snapshot at revision N. The client buffers later changes until loading finishes. [Draft; A7]
- The adopter's access check runs before a session opens and before changes are accepted. The WebSocket transport attaches to the adopter's HTTP server, and the check runs at upgrade. [§1; A9]
- The connection stays open for the whole session; data is sent only when there are changes. [Add-on 3 §5]
- View-only sessions are supported. [Draft; Add-on 3 §5]
- The engine exposes a document ID and a share hook. [Draft; Add-on 3 §5]
- Change events stream out as audit data. [§3]

**Frontend**
- A customizable text-document editor UI. [Draft; §1]
- The user's own typing appears immediately. Incoming patches are applied without disturbing unconfirmed typing, the cursor or the selection. [§3]
- After a reconnect, the UI resends changes the server hasn't confirmed. On `QUEUE_FULL` it retries with backoff. [A2; A3]
- Chunked first load, view-only mode and the share hook in the UI. [A7; Add-on 3 §5]

## V2 — Collaborative spreadsheets

- A spreadsheet OT type for cell edits and row/column insert and delete. [A1; Add-on 3 §5]
- When two changes hit the same cell, the later one in FIFO order wins. The superseded value still streams as an audit event. [§6]
- Formulas keep their last saved value, with no live recalculation. Recalculation comes in V6 (B3). [Add-on 3 §5]
- Spreadsheets load in chunks by row range. [A7]
- A spreadsheet editor UI with the same responsiveness rules as V1. [§3]

## V3 — External queues

- Redis and Kafka queue adapters, with backpressure. [Draft CONFIGURABLE; §2]
- After an engine restart, processing resumes from the last committed offset. [A2]

## V4 — End-user upload

- Users upload a document or spreadsheet from their device through the UI, streamed into the backend. [Draft; §1]

## V5 — Bookmarks and side notes/reviews

- Bookmarks and side notes/reviews, stored through an adopter-supplied storage interface. [Draft; A8; Add-on 3 §2]

**After V5, the main (own-OT) BRD scope is complete.**

## V6 — Section B features (separate version)

- B1–B6 and B8–B10. [Add-on 2 §2]
- B7 (licence) is not here; it is chosen before V1. [Add-on 3 §4]
- Proposed: V6 builds on the main own-OT version.

**Known gaps until V6** [Add-on B]:
- no automated convergence testing (B10)
- no unloading of idle instances (B4)
- no limits on the size or rate of changes (B9)
- no formula recalculation (B3)

## V7 — ShareDB-based version (separate version)

- A ShareDB-based engine with its own database adapter, which saves to the local journal and the adopter's storage interface. [Add-on 2 §1]
- The per-document FIFO queue feeds ShareDB's submit step. ShareDB's pub/sub (memory or Redis) does the broadcast, and Kafka needs a custom pub/sub adapter. [Add-on 3 §3]
- Verify whether ShareDB sends the whole document on first load. If it does, add a separate chunked loading path. [Add-on 3 §3]
- Proposed:
  - V7 covers the V1–V5 scope, with ShareDB in place of the own-OT engine.
  - It is published alongside the own-OT version, not as a replacement.
  - Section B features are not included unless the project owner decides otherwise.

## Points that need the project owner's approval

1. The V1–V7 order and contents above.
2. The licence: MIT or Apache-2.0.
3. That V6 builds on the own-OT version.
4. That V7 covers the V1–V5 scope, ships alongside the own-OT version, and leaves out Section B unless decided otherwise.
