// A Core entry for the worker-mode smoke tests. It runs the real Core and the real wiring from the
// compiled build (`npm run build` first), with one change: the codec is a fake that stores one
// paragraph per line of UTF-8 text, so the tests need no LibreOffice.
//
// A text frame containing "crash-core" makes the Core exit with code 3, so a test can kill the
// Core from a client without knowing its pid.
import { textSchema } from '@open-docex/shared/text';
import { resolveWorkerConfig } from '../../../dist/api/validate-options.js';
import { main } from '../../../dist/core/core-entry.js';

const PAGE = resolveWorkerConfig({}).blankDocument.page;

function docJson(text) {
  const paras = text.split('\n').map((t) => textSchema.node('paragraph', null, t === '' ? [] : [textSchema.text(t)]));
  const { size, orientation, margins } = PAGE;
  return textSchema.node('doc', { size, orientation, margins }, [textSchema.node('body', null, paras)]).toJSON();
}

function textOfNode(n) {
  if (typeof n.text === 'string') return n.text;
  return (n.content ?? []).map(textOfNode).join('');
}

function textOfModel(model) {
  const body = (model.content ?? []).find((c) => c.type === 'body');
  return (body?.content ?? []).map(textOfNode).join('\n');
}

const codec = {
  import: ({ bytes }) =>
    Promise.resolve({ kind: 'text', snapshot: docJson(new TextDecoder().decode(bytes)), findings: [], assetIds: [] }),
  export: ({ model }) => Promise.resolve(new TextEncoder().encode(textOfModel(model))),
  probe: () => Promise.resolve(),
  close: () => Promise.resolve(),
};

process.on('message', (m) => {
  if (m && m.type === 'frame' && !m.binary && Buffer.from(m.data).toString('utf8').includes('crash-core')) process.exit(3);
});

main({ codec: () => codec });
