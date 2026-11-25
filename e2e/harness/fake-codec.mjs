// A fake codec for the e2e suite (LLD Part 3 §17 allows it): the file bytes are UTF-8 text, one
// paragraph per line. A text that starts with `UNSUPPORTED` imports with a `comments` finding, so
// the document opens read-only. Images are not exported (the suite does not read them back).
// Plain JavaScript with no imports from the server, so main mode and the forked Core share it.

function textOfNode(n) {
  if (typeof n.text === 'string') return n.text;
  return (n.content ?? []).map(textOfNode).join('');
}

/** The plain text of a serialized model: the body's blocks joined by a newline. */
export function textOfModel(model) {
  const body = (model.content ?? []).find((c) => c.type === 'body');
  return (body?.content ?? []).map(textOfNode).join('\n');
}

export function createFakeCodec({ textSchema, page }) {
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
    export: ({ model }) => Promise.resolve(new TextEncoder().encode(textOfModel(model))),
    probe: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}
