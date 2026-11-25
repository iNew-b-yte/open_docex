// A fake codec for the V1-19 wiring and smoke tests: it implements both halves of `WiredCodec`
// (import for the Core, export for flush, recovery and `documents.create`) over plain UTF-8 text,
// one paragraph per line. Everything else in those tests is real.
import type { FileFormat } from '@open-docex/shared/protocol';
import type { WiredCodec } from '../../../src/core/core-entry.js';
import type { CodecImportResult } from '../../../src/core/seams.js';
import { docJson } from './harness.js';

interface JsonNode {
  type?: string;
  text?: string;
  content?: JsonNode[];
}

function textOfNode(n: JsonNode): string {
  if (typeof n.text === 'string') return n.text;
  return (n.content ?? []).map(textOfNode).join('');
}

/** The plain text of a serialized model (`doc.toJSON()`): the body's blocks joined by `\n`. */
export function textOfModel(model: unknown): string {
  const doc = model as JsonNode;
  const body = (doc.content ?? []).find((c) => c.type === 'body');
  return (body?.content ?? []).map(textOfNode).join('\n');
}

/** A {@link WiredCodec} over UTF-8 text. `closed` is true after `close()`. */
export class TextFileCodec implements WiredCodec {
  imports = 0;
  exports: string[] = [];
  probes = 0;
  closed = false;
  probeError: Error | null = null;
  /** When set, `export` fails with it. */
  exportError: Error | null = null;

  import(i: { bytes: Uint8Array; format: FileFormat; assetDir: string }): Promise<CodecImportResult> {
    this.imports++;
    const text = new TextDecoder().decode(i.bytes);
    return Promise.resolve({ kind: 'text', snapshot: docJson(text), findings: [], assetIds: [] });
  }

  export(i: { model: unknown }): Promise<Uint8Array> {
    if (this.exportError !== null) return Promise.reject(this.exportError);
    const text = textOfModel(i.model);
    this.exports.push(text);
    return Promise.resolve(new TextEncoder().encode(text));
  }

  probe(): Promise<void> {
    this.probes++;
    return this.probeError === null ? Promise.resolve() : Promise.reject(this.probeError);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
