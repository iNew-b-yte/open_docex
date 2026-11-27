# @open-docex/client

The open_docex browser client. Call `mount()` to put a collaborative document editor into any page. It talks to an [`@open-docex/server`](https://github.com/iNew-b-yte/open_docex/blob/main/backend/README.md) engine over a WebSocket. Both packages must be the same release.

Part of [open_docex](https://github.com/iNew-b-yte/open_docex/blob/main/README.md), which explains the purpose, who it is for and the requirements of the whole project.

The editor is built with React and ProseMirror internally. React is a peer dependency, and the package exports `mount` and its types only: no React component or type.

## Install

```sh
npm install @open-docex/client react react-dom
```

Requires React 18.2+ or 19, and a bundler that handles ESM and CSS (Vite, webpack, esbuild and so on). Import the stylesheet once:

```js
import '@open-docex/client/style.css';
```

## Server requirement

The server needs LibreOffice installed to convert files, and an `authorize` callback that decides who may open which document. See the server README. The client does not need LibreOffice.

## Browsers

- **Tested:** recent desktop **Chromium, Firefox and WebKit**, by automated end-to-end tests (WebKit through Playwright, which is not Safari itself).
- **Not tested:** Safari itself, mobile browsers and touch input, input methods (IME) for languages such as Chinese or Japanese, right-to-left text, and screen readers or other accessibility tools.

## What the editor can do

- **Edit together in real time.** Your own typing shows at once, and other users' edits appear live while you type.
- **Characters:** bold, italic, underline, strikethrough, font family and size, text colour, and links (`http`, `https` and `mailto` only).
- **Paragraphs:** headings, alignment (left, centre, right, justify), indent and outdent, and a Paragraph dialog for spacing before and after, line height and left, right and first-line indents.
- **Lists:** bulleted and numbered.
- **Tables:** insert, add and delete rows and columns, merge and split cells, header rows, delete the table, and resize columns.
- **Images:** PNG, JPEG and GIF by toolbar, paste or drag and drop, with resizing and alt text.
- **Page layout:** page breaks, headers and footers with page-number and page-count fields, page setup (size presets, orientation and margins), and pages drawn on screen.
- **Access and failures:** view-only mode, a read-only banner with an optional "edit anyway", reconnect and resume after a dropped connection, a notice when changes could not be restored, and a warning before leaving a page with unconfirmed changes.
- **Customise:** theme variables, every label (for translation) and the list of toolbar items.

## Quick start

```js
import { mount } from '@open-docex/client';
import '@open-docex/client/style.css';

const editor = mount(document.getElementById('editor'), {
  url: 'wss://app.example.com/open-docex',
  documentId: 'demo',
  kind: 'text',
});

editor.on('ready', ({ access, readOnly }) => console.log('ready', access, readOnly));
// later: editor.destroy();
```

`mount(element, options)` returns a handle with two methods:

- `on(event, fn)` subscribes and returns a function that unsubscribes.
- `destroy()` closes the socket and removes the editor. Unconfirmed changes are lost. Calling it twice does nothing.

`mount` throws `OpenDocexError` with `CONFIG_INVALID` if `element` is not an HTML element, if it already holds an editor, or if an option is invalid. Error messages name the option but never echo its value.

## Options

```js
const editor = mount(element, {
  url,
  documentId: 'demo',
  kind: 'text',
  connect: {
    auth: { type: 'cookie' },
    heartbeat: { intervalMs: 25_000, timeoutMs: 10_000 },
    reconnect: { baseDelayMs: 500, maxDelayMs: 30_000 },
  },
  hooks: {
    onShare: (documentId) => console.log('share', documentId),
    onEditAnyway: async (documentId) => { /* call your backend, which calls engine.documents.allowUnsupportedEdit */ },
    onError: (error) => console.warn(error.code, error.retryable, error.terminal, error.message),
  },
  ui: {
    toolbar: {
      text: { items: ['bold', 'italic', 'bulletList', 'insertTable'], fontFamilies: ['Arial'], fontSizes: [10, 12, 14] },
      shell: { items: ['share'] },
    },
    theme: { '--odx-color-accent': '#0b6bcb', '--odx-radius': '6px' },
    labels: { toolbar: { bold: 'Fett' }, status: { synced: 'Alles gespeichert' } },
    confirmUnload: true,
  },
});
```

| Option | Default | Meaning |
|---|---|---|
| `url` | required | `ws:` or `wss:` endpoint: your server's host plus `http.path` (default `/open-docex`) |
| `documentId` | required | 1 to 1024 characters, no control characters. Sent as `?doc=`, and your server's `authorize` receives it |
| `kind` | required | `'text'` in V1. Must match the document's kind on the server |
| `connect.auth` | `{ type: 'cookie' }` | How the upgrade authenticates, see below |
| `connect.heartbeat.intervalMs` / `timeoutMs` | `25000` / `10000` | Client heartbeat |
| `connect.reconnect.baseDelayMs` / `maxDelayMs` | `500` / `30000` | Reconnect back-off |
| `hooks.onShare` | none | Called when the Share button is clicked. The button is hidden without it |
| `hooks.onEditAnyway` | none | Called when the user chooses "Edit anyway" on an unsupported-content banner. The button is hidden without it |
| `hooks.onError` | none | Called for every error the editor surfaces |
| `ui.toolbar` | all items | `false` hides the toolbar. `text.items`, `text.fontFamilies`, `text.fontSizes` and `shell.items` narrow it |
| `ui.theme` | `{}` | CSS variables, see Theme |
| `ui.labels` | English | Overrides any user-visible string, see Labels |
| `ui.confirmUnload` | `true` | Ask before the page is left while changes are unconfirmed |

Default `fontFamilies`: Arial, Times New Roman, Courier New, Georgia, Verdana. Default `fontSizes` (pt): 8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72.

Text toolbar item ids: `paragraphStyle`, `paragraph`, `bold`, `italic`, `underline`, `strike`, `fontFamily`, `fontSize`, `textColor`, `link`, `alignLeft`, `alignCenter`, `alignRight`, `alignJustify`, `bulletList`, `orderedList`, `indent`, `outdent`, `insertTable`, `tableAddRowBefore`, `tableAddRowAfter`, `tableAddColBefore`, `tableAddColAfter`, `tableDeleteRow`, `tableDeleteCol`, `tableMerge`, `tableSplit`, `tableToggleHeaderRow`, `tableDelete`, `insertImage`, `imageAlt`, `pageBreak`, `header`, `footer`, `pageSetup`. The only shell item is `share`.

### Authentication

The WebSocket upgrade carries your credentials. Your server's `authorize` callback reads them.

| `connect.auth` | What is sent |
|---|---|
| `{ type: 'cookie' }` | The browser sends your site's cookies. Easiest and safest |
| `{ type: 'query', param: 'token', getToken }` | `?token=<value>` in the URL. `getToken` may be async and is called on every connect. **Query strings can appear in proxy and server logs**: use short-lived tokens |
| `{ type: 'subprotocol', getToken }` | The token is offered as a second `Sec-WebSocket-Protocol` value after `open-docex.v1`. Read it in `authorize` from `request.headers['sec-websocket-protocol']` |

Use `wss:` in production.

## Events

```js
editor.on('status', (s) => console.log(s.connection, s.load, s.access, s.readOnlyReason, s.sync, s.storage));
editor.on('load-progress', (p) => console.log('progress', p.chunksReceived, p.bytesReceived));
editor.on('sync', (s) => console.log('sync', s.pendingCount, s.confirmedRev));
editor.on('notice', (n) => console.log('notice', JSON.stringify(n)));
const off = editor.on('ready', ({ kind, access, readOnly, unsupported }) => {
  console.log('ready', kind, access, readOnly, unsupported.length);
  off();
});
editor.on('destroyed', () => console.log('destroyed'));
```

| Event | Payload |
|---|---|
| `status` | `connection` (`connecting`, `open`, `reconnecting`, `failed`, `closed`), `load` (`idle`, `loading`, `ready`), `access` (`edit`, `view`, `null`), `readOnlyReason` (`null`, `view`, `unsupported`, `server`, `restoring`), `sync` (`synced`, `pending`, `busy`, `restoring`), `storage` (`normal`, `local`, `pending`, `conflict`) |
| `load-progress` | `chunksReceived`, `bytesReceived`, `totalChunks?` |
| `ready` | `kind`, `access`, `readOnly`, `unsupported` (the findings that made it read-only) |
| `sync` | `pendingCount` (above 0 means unconfirmed changes), `confirmedRev` |
| `notice` | A server notice, for example that the server is restarting |
| `error` | `ClientError`, see below |
| `destroyed` | none |

A listener that throws does not stop the others; its error is re-thrown asynchronously so it reaches your error reporting.

## Error handling

Every error the editor surfaces is a `ClientError` with `code`, `retryable`, `message` and `terminal`:

- `message` is the sanitized text from the catalogue. It never contains tokens, URLs or server detail.
- `retryable: true` errors are retried by the editor, which reconnects or reloads on its own.
- `terminal: true` means the session stopped and the editor shows an error screen with a Reload or Retry action.

Receive errors either with `hooks.onError` (given to `mount`) or `editor.on('error', fn)`. Use them for monitoring, or to show your own UI. The editor already shows messages in its own status bar, using `labels.errors[code]`.

When the connection drops, the editor reconnects with back-off (`connect.reconnect`) and re-sends unconfirmed changes. If the server cannot resume the session, it reloads the latest version.

## Theme

Set any of these CSS variables with `ui.theme`. Other keys are ignored.

`--odx-font-family`, `--odx-color-bg`, `--odx-color-fg`, `--odx-color-muted`, `--odx-color-accent`, `--odx-color-border`, `--odx-color-canvas`, `--odx-color-page`, `--odx-color-warning`, `--odx-color-error`, `--odx-radius`, `--odx-toolbar-height`.

Values are applied inline on the editor's `.odx-root` container and nothing else of your page is touched.

## Labels

Every user-visible string has an English default and can be overridden with `ui.labels`, which is a partial of this shape: `toolbar` (one label per toolbar item plus `share`), `status`, `banner`, `styles`, `badge`, `dialogs`, `errors` (one label per error code), `findings`, `notices` and `restore`. Placeholders such as `{n}` and `{done}` are replaced with numbers. For example, `labels: { toolbar: { bold: 'Fett' }, status: { synced: 'Alles gespeichert' } }`. An error without a label shows its sanitized catalogue message.

## Security notes

- The editor never uses `innerHTML`. Link targets are restricted to `http`, `https` and `mailto`. Images are shown from blob URLs created from data the server sent.
- Only PNG, JPEG and GIF images can be added.
- Client errors are sanitized: no server detail reaches the page.
- Prefer cookie auth. A query-string token can appear in logs. Always use `wss:`.
- The editor only edits what your server's `authorize` allowed: view sessions cannot change a document.

## Error codes

Generated from `ERROR_CATALOGUE` in `@open-docex/shared`. `ClientError.code` is one of these. `CLIENT_*` codes are raised in the browser only.

| Code | Category | Retryable | Severity | What to do |
|---|---|---|---|---|
| `CONFIG_INVALID` | config | no | fatal | Fix the option named in `message` (see the configuration reference) and restart. |
| `CONFIG_LIBREOFFICE_NOT_FOUND` | config | no | fatal | Install LibreOffice on the server, or set `libreoffice.path` to the `soffice` executable. |
| `CONFIG_DATA_DIR_UNWRITABLE` | config | no | fatal | Create `dataDir` and make it writable by the Node.js process user, or point `dataDir` elsewhere. |
| `STORAGE_READ_FAILED` | storage | yes | error | Check that the storage adapter can reach its backend and that `ref` exists; see `cause`. |
| `STORAGE_WRITE_FAILED` | storage | yes | warning | The engine kept a local copy and retries after 1, 5 and 15 min. Check storage availability and credentials. |
| `STORAGE_LOCAL_MODE` | storage | no | warning | No action needed while retries run. Watch the `storage` events. |
| `STORAGE_PENDING` | recovery | no | error | Retries are exhausted. Fix storage, then call the recovery `retry()` for this document, or `resolve()` it. |
| `STORAGE_CONFLICT` | recovery | no | error | The storage file changed while a newer local copy existed. Compare both and call `resolve()` with your choice. The engine never overwrites it on its own. |
| `QUEUE_FULL` | queue | yes | warning | Clients retry automatically. If this is frequent, raise `queue.perDocument`/`queue.global` or reduce load. |
| `QUEUE_UNAVAILABLE` | queue | yes | error | Raised when the queue is closed, for example during shutdown. Clients retry. |
| `ENGINE_RESTARTING` | engine | yes | warning | Clients reconnect automatically. Inspect the preceding `error` event for the crash cause. |
| `ENGINE_UNAVAILABLE` | engine | no | error | The engine is FAILED. Fix the cause in the `fatal` event and restart the application. |
| `ENGINE_FAILED` | engine | no | fatal | The restart limit was exceeded. Inspect the preceding `error` events and logs, fix, and restart. |
| `DOCUMENT_FAULTED` | document | no | error | Inspect the `error` event's `cause`. Other documents keep running. Reopening reloads from the journal. |
| `DOCUMENT_UNSUPPORTED_CONTENT` | document | no | warning | See `unsupported`. Call `documents.allowUnsupportedEdit(documentId)` to allow editing; those parts are removed on save. |
| `DOCUMENT_READ_ONLY` | document | no | warning | The session is view-only or the document is read-only. The change was discarded. |
| `DOCUMENT_NOT_FOUND` | document | no | error | The storage adapter reports no file for the `ref` returned by `authorize`. Check the mapping. |
| `DOCUMENT_TOO_LARGE` | document | no | error | The file exceeds `limits.maxFileBytes`. Raise the limit or reduce the file. |
| `CONVERSION_FAILED` | conversion | no | error | LibreOffice could not convert it. Check that the file is a valid .docx/.odt/.xlsx/.ods and that `soffice --headless --version` works for the server user. |
| `CONVERSION_TIMEOUT` | conversion | yes | error | Raise `libreoffice.timeoutMs`, or add capacity (`maxConcurrent`, `codecThreads`). |
| `SESSION_SLOW_CONSUMER` | session | yes | warning | The client fell behind its send buffer. Raise `send.highWaterMarkBytes` if this happens on healthy networks. |
| `SESSION_CLOSED` | session | no | info | Closed by the server or the adopter. No action is needed unless unexpected. |
| `SESSION_RESYNC_REQUIRED` | session | yes | info | The client reloads automatically. |
| `ACCESS_DENIED` | access | no | error | Your `authorize` or `canSubmit` hook rejected the request. |
| `PROTOCOL_INVALID_MESSAGE` | protocol | no | error | Make sure `@open-docex/client` and `@open-docex/server` are the same release. Otherwise a client sent a malformed frame. |
| `PROTOCOL_VERSION_UNSUPPORTED` | protocol | no | error | Deploy the same release of client and server. |
| `PROTOCOL_OP_REJECTED` | protocol | no | error | The change failed validation and was discarded. If this is frequent, report a bug with the `error` event. |
| `CLIENT_CONNECT_FAILED` | client | yes | error | Check the server is running and that proxies allow WebSocket upgrades on the engine path. |
| `CLIENT_ASSET_TOO_LARGE` | client | no | warning | Use a smaller image. |
| `CLIENT_IMAGE_TYPE_UNSUPPORTED` | client | no | warning | Only PNG, JPEG and GIF are supported (PO-24). |

## Not supported in V1

- **No undo or redo.** Ctrl+Z and Ctrl+Y are disabled on purpose.
- **Text documents only.** `kind: 'sheet'` is accepted by the option check but spreadsheets are not part of V1.
- **No other users' cursors or names.** You see their edits live, but there is no presence indicator or list of who is online.
- **No comments, tracked changes, footnotes, text boxes, equations or charts.** A file with such parts opens read-only, and they are removed on save if you allow editing anyway.
- A file with content the editor cannot represent opens **read-only** (badge "Read-only: unsupported content") unless `hooks.onEditAnyway` is provided and the user chooses to edit anyway. The unsupported parts are removed when the document is saved.
- Images can be added as PNG, JPEG or GIF only.

## Licence

MIT.
