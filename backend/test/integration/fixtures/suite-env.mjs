// The test environment of the integration suite (V1-20), shared by both modes. Plain JavaScript
// with no imports from `src` or `dist`, so the forked Core (worker mode, compiled build) and the
// Vitest process (main mode, TypeScript sources) run the very same code. The caller passes in
// what differs: `LocalFsStorage`, `textSchema` and the blank page.
//
// Everything a test needs to switch at run time is a flag file in the control folder, because a
// forked Core cannot share memory with the test:
//
//   storage-fail-read | storage-fail-write | storage-fail-stat | storage-fail-create
//                     the storage adapter throws for that operation while the file exists
//   export-fail       the fake codec's export rejects (so a flush cannot write)
//   hold-boot         the Core's boot waits in `probe()` while the file exists, which keeps a
//                     restarted worker in the `restarting` state for as long as the test needs
import { existsSync } from 'node:fs';
import path from 'node:path';

/** True while the flag file `name` exists in `ctlDir`. */
export function flagOn(ctlDir, name) {
  return existsSync(path.join(ctlDir, name));
}

/**
 * Wraps a storage adapter so that a flag file makes one operation throw, as an unreachable
 * storage service would.
 */
export function createControlledStorage(inner, ctlDir) {
  const guard = (op) => {
    if (flagOn(ctlDir, `storage-fail-${op}`)) throw new Error(`storage is down (${op})`);
  };
  // `async`, so a failure is always a rejection, as with a real adapter.
  return {
    read: async (ref, o) => (guard('read'), inner.read(ref, o)),
    write: async (ref, bytes, o) => (guard('write'), inner.write(ref, bytes, o)),
    stat: async (ref, o) => (guard('stat'), inner.stat(ref, o)),
    create: async (input, o) => (guard('create'), inner.create(input, o)),
  };
}

function textOfNode(n) {
  if (typeof n.text === 'string') return n.text;
  return (n.content ?? []).map(textOfNode).join('');
}

/** The plain text of a serialized model: the body's blocks joined by a newline. */
export function textOfModel(model) {
  const body = (model.content ?? []).find((c) => c.type === 'body');
  return (body?.content ?? []).map(textOfNode).join('\n');
}

/**
 * A codec for logic flows (the real one needs LibreOffice): the file bytes are UTF-8 text, one
 * paragraph per line. A text that starts with `UNSUPPORTED` imports with a `comments` finding,
 * so the document opens read-only.
 */
export function createSuiteCodec({ textSchema, page, ctlDir }) {
  const docJson = (text) => {
    const paras = text.split('\n').map((t) => textSchema.node('paragraph', null, t === '' ? [] : [textSchema.text(t)]));
    const { size, orientation, margins } = page;
    return textSchema.node('doc', { size, orientation, margins }, [textSchema.node('body', null, paras)]).toJSON();
  };
  return {
    import: ({ bytes }) => {
      const text = new TextDecoder().decode(bytes);
      const findings = text.startsWith('UNSUPPORTED') ? [{ feature: 'comments', count: 1 }] : [];
      return Promise.resolve({ kind: 'text', snapshot: docJson(text), findings, assetIds: [] });
    },
    export: ({ model }) => {
      if (flagOn(ctlDir, 'export-fail')) return Promise.reject(new Error('export is down'));
      return Promise.resolve(new TextEncoder().encode(textOfModel(model)));
    },
    async probe() {
      while (flagOn(ctlDir, 'hold-boot')) await new Promise((resolve) => setTimeout(resolve, 20));
    },
    close: () => Promise.resolve(),
  };
}

/**
 * The worker config of the suite: `LocalFsStorage` in `storageRoot` behind the failure flags.
 * `settings.config` overrides any `WorkerConfig` section (a whole section at a time).
 */
export function buildWorkerConfig({ LocalFsStorage, settings }) {
  return {
    dataDir: settings.dataDir,
    storage: createControlledStorage(new LocalFsStorage({ root: settings.storageRoot }), settings.ctlDir),
    flush: { quietMs: 1000, maxIntervalMs: 300000 },
    ...settings.config,
  };
}
