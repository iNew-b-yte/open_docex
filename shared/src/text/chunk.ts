/**
 * Chunking and assembly of text documents (LLD Part 1 §8.7, §0 S-18).
 *
 * Chunk 0 carries the document attributes and which regions exist. The remaining chunks
 * carry the top-level blocks of `header`, `body` and `footer`, in that order, split by
 * block count and by size.
 */
import { Node as PMNode } from 'prosemirror-model';
import { OpenDocexError } from '../errors/index.js';
import type { Chunk, ChunkLimits } from '../ot/index.js';
import { utf8Length } from '../util/index.js';
import { getPageSettings, pageSettingsFit } from './page.js';
import type { PageSettings } from './page.js';
import { textSchema } from './schema.js';
import type { TextDefaults, TextSnapshot } from './schema.js';

/** A document region that holds blocks. */
export type TextRegion = 'header' | 'body' | 'footer';

/** The data of one text chunk. `blocks` holds the node JSON of top-level blocks. */
export type TextChunkData =
  | { kind: 'text'; part: 'doc'; page: PageSettings; textDefaults: TextDefaults; header: boolean; footer: boolean }
  | { kind: 'text'; part: 'blocks'; region: TextRegion; blocks: unknown[] };

const REGION_RANK: Readonly<Record<TextRegion, number>> = { header: 0, body: 1, footer: 2 };

/**
 * Splits a text document into chunks. A chunk holds at most `limits.textBlocks` blocks
 * and at most `limits.maxBytes` bytes of data (`utf8Length(JSON.stringify(data))`),
 * except a chunk holding one block that is larger by itself.
 */
export function chunkText(doc: TextSnapshot, limits: ChunkLimits): Chunk<TextChunkData>[] {
  const regions = new Map<string, PMNode>();
  doc.forEach((child) => regions.set(child.type.name, child));
  const header = regions.get('header');
  const body = regions.get('body');
  const footer = regions.get('footer');

  const out: Chunk<TextChunkData>[] = [
    {
      seq: 0,
      data: {
        kind: 'text',
        part: 'doc',
        page: getPageSettings(doc),
        textDefaults: doc.attrs.textDefaults as TextDefaults,
        header: header !== undefined,
        footer: footer !== undefined,
      },
    },
  ];
  const emit = (region: TextRegion, blocks: unknown[]): void => {
    out.push({ seq: out.length, data: { kind: 'text', part: 'blocks', region, blocks } });
  };

  const parts: [TextRegion, PMNode | undefined][] = [
    ['header', header],
    ['body', body],
    ['footer', footer],
  ];
  for (const [region, node] of parts) {
    if (node === undefined) continue;
    // Bytes of the chunk data with an empty `blocks` array; each block adds its JSON
    // plus a comma after the first.
    const envelope = utf8Length(JSON.stringify({ kind: 'text', part: 'blocks', region, blocks: [] }));
    let cur: unknown[] = [];
    let bytes = envelope;
    node.forEach((block) => {
      const j: unknown = block.toJSON();
      const b = utf8Length(JSON.stringify(j));
      const add = cur.length > 0 ? b + 1 : b;
      if (cur.length > 0 && (cur.length === limits.textBlocks || bytes + add > limits.maxBytes)) {
        emit(region, cur);
        cur = [];
        bytes = envelope;
      }
      bytes += cur.length > 0 ? b + 1 : b;
      cur.push(j);
    });
    emit(region, cur); // regions are non-empty by schema
  }
  return out;
}

function invalid(detail: string): never {
  throw new OpenDocexError('PROTOCOL_INVALID_MESSAGE', `Invalid text chunks: ${detail}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Rebuilds a text document from its chunks, which come from the network and are
 * untrusted. Checks the sequence, the region order and the document's content and
 * attributes. Throws `PROTOCOL_INVALID_MESSAGE` on any failure.
 */
export function assembleText(chunks: readonly Chunk<TextChunkData>[]): TextSnapshot {
  if (!Array.isArray(chunks) || chunks.length === 0) invalid('no chunks');
  const raw: unknown[] = chunks;
  raw.forEach((c, i) => {
    if (!isRecord(c) || c.seq !== i || !isRecord(c.data) || c.data.kind !== 'text') invalid(`chunk ${String(i)}`);
  });
  const head = (raw[0] as { data: Record<string, unknown> }).data;
  if (head.part !== 'doc' || typeof head.header !== 'boolean' || typeof head.footer !== 'boolean') {
    invalid('missing doc part');
  }
  const page = head.page;
  if (!isRecord(page)) invalid('page');

  const content: Record<TextRegion, unknown[]> = { header: [], body: [], footer: [] };
  const seen: Record<TextRegion, boolean> = { header: false, body: false, footer: false };
  let rank = 0;
  for (let i = 1; i < raw.length; i++) {
    const d = (raw[i] as { data: Record<string, unknown> }).data;
    const region = d.region;
    if (d.part !== 'blocks' || (region !== 'header' && region !== 'body' && region !== 'footer')) {
      invalid(`chunk ${String(i)}`);
    }
    if (!Array.isArray(d.blocks)) invalid(`chunk ${String(i)} blocks`);
    if (REGION_RANK[region] < rank) invalid('region order');
    rank = REGION_RANK[region];
    seen[region] = true;
    for (const b of d.blocks as unknown[]) content[region].push(b);
  }
  if (!seen.body || seen.header !== head.header || seen.footer !== head.footer) invalid('regions');

  const docContent: unknown[] = [];
  if (seen.header) docContent.push({ type: 'header', content: content.header });
  docContent.push({ type: 'body', content: content.body });
  if (seen.footer) docContent.push({ type: 'footer', content: content.footer });
  const json = {
    type: 'doc',
    attrs: { size: page.size, orientation: page.orientation, margins: page.margins, textDefaults: head.textDefaults },
    content: docContent,
  };

  let doc: PMNode;
  try {
    doc = PMNode.fromJSON(textSchema, json);
    doc.check();
  } catch {
    invalid('document');
  }
  if (!pageSettingsFit(getPageSettings(doc))) invalid('margins');
  return doc;
}
