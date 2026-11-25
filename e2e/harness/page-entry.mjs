// The page the harness serves: the built client behind a tiny adopter shim. Bundled by
// `global-setup.mjs`. The tests drive it through `window.odx`.
import { mount } from '@open-docex/client';
import '@open-docex/client/style.css';

const log = { events: [], errors: [], notices: [], statuses: [] };

// Counts the sockets that are open, for the `destroy()` check.
const NativeWebSocket = window.WebSocket;
window.WebSocket = class extends NativeWebSocket {
  constructor(...args) {
    super(...args);
    window.odx.openSockets += 1;
    this.addEventListener('close', () => {
      window.odx.openSockets -= 1;
    });
  }
};

/**
 * `start({ documentId, token, editAnyway })` mounts an editor in `#root`. The token goes in the
 * query string (`connect.auth`), which the harness's `authorize` reads.
 */
function start({ documentId, token, editAnyway = true, reconnect }) {
  const hooks = { onError: (e) => log.errors.push(e.code) };
  if (editAnyway) {
    // The adopter route: the page asks its own backend, which calls `documents.allowUnsupportedEdit`.
    hooks.onEditAnyway = async (id) => {
      const r = await fetch(`/edit-anyway?doc=${encodeURIComponent(id)}`, { method: 'POST' });
      if (!r.ok) throw new Error('edit anyway failed');
    };
  }
  const handle = mount(document.getElementById('root'), {
    url: `ws://${location.host}/open-docex`,
    documentId,
    kind: 'text',
    connect: {
      auth: { type: 'query', param: 'token', getToken: () => token },
      reconnect: reconnect ?? { baseDelayMs: 200, maxDelayMs: 1000 },
    },
    hooks,
    ui: { confirmUnload: false },
  });
  handle.on('status', (s) => log.statuses.push(s));
  handle.on('notice', (n) => log.notices.push(n));
  handle.on('ready', (r) => log.events.push({ ready: r }));
  window.odx.handle = handle;
}

window.odx = { start, log, handle: null, openSockets: 0 };
