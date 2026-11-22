import { describe, expect, it } from 'vitest';
import { OpenDocexError } from '../../src/errors/index.js';
import { DEFAULT_CHUNK_LIMITS } from '../../src/ot/index.js';
import type { Chunk, ChunkLimits } from '../../src/ot/index.js';
import { assembleText, chunkText } from '../../src/text/chunk.js';
import type { TextChunkData } from '../../src/text/chunk.js';
import { textSchema } from '../../src/text/schema.js';
import { utf8Length } from '../../src/util/index.js';
import { A4, docWithParagraphs, everythingJson, para } from './fixtures.js';

function expectInvalid(chunks: unknown): void {
  try {
    assembleText(chunks as Chunk<TextChunkData>[]);
  } catch (e) {
    expect(OpenDocexError.is(e, 'PROTOCOL_INVALID_MESSAGE')).toBe(true);
    return;
  }
  throw new Error('expected PROTOCOL_INVALID_MESSAGE');
}

function checkL6(chunks: Chunk<TextChunkData>[], l: ChunkLimits): void {
  chunks.forEach((c, i) => {
    expect(c.seq).toBe(i);
    if (c.data.part === 'blocks') {
      expect(c.data.blocks.length).toBeGreaterThan(0);
      expect(c.data.blocks.length).toBeLessThanOrEqual(l.textBlocks);
      if (c.data.blocks.length > 1) expect(utf8Length(JSON.stringify(c.data))).toBeLessThanOrEqual(l.maxBytes);
    }
  });
}

describe('chunkText / assembleText', () => {
  it('has default limits from HLD §12', () => {
    expect(DEFAULT_CHUNK_LIMITS).toEqual({ textBlocks: 200, sheetRows: 500, maxBytes: 262_144 });
  });

  it.each([1, 200, 201])('round-trips %i body blocks with and without header/footer', (n) => {
    for (const opts of [{}, { header: true, footer: true }, { header: true }, { footer: true }]) {
      const doc = docWithParagraphs(n, opts);
      const chunks = chunkText(doc, DEFAULT_CHUNK_LIMITS);
      checkL6(chunks, DEFAULT_CHUNK_LIMITS);
      const back = assembleText(JSON.parse(JSON.stringify(chunks)) as Chunk<TextChunkData>[]);
      expect(back.eq(doc)).toBe(true);
    }
  });

  it('splits 201 body blocks into 200 + 1', () => {
    const chunks = chunkText(docWithParagraphs(201), DEFAULT_CHUNK_LIMITS);
    expect(chunks.map((c) => (c.data.part === 'blocks' ? c.data.blocks.length : 'doc'))).toEqual(['doc', 200, 1]);
  });

  it('keeps textDefaults and page settings in the doc chunk', () => {
    const doc = textSchema.nodeFromJSON(everythingJson());
    const chunks = chunkText(doc, DEFAULT_CHUNK_LIMITS);
    expect(chunks[0]?.data).toEqual({
      kind: 'text',
      part: 'doc',
      page: A4,
      textDefaults: { fontFamily: 'Arial', fontSize: 11, color: '#112233' },
      header: true,
      footer: true,
    });
    expect(assembleText(chunks).eq(doc)).toBe(true);
  });

  it('round-trips the full fixture at every block limit (L5)', () => {
    const doc = textSchema.nodeFromJSON(everythingJson());
    for (const textBlocks of [1, 2, 3, 200]) {
      for (const maxBytes of [1, 300, 262_144]) {
        const l = { textBlocks, sheetRows: 500, maxBytes };
        const chunks = chunkText(doc, l);
        checkL6(chunks, l);
        expect(assembleText(chunks).eq(doc)).toBe(true);
      }
    }
  });

  it('gives a block larger than 256 KiB its own chunk', () => {
    const big = 'x'.repeat(300_000);
    const doc = textSchema.nodeFromJSON({
      type: 'doc',
      attrs: A4,
      content: [{ type: 'body', content: [para('a'), para(big), para('b')] }],
    });
    const chunks = chunkText(doc, DEFAULT_CHUNK_LIMITS);
    expect(chunks.map((c) => (c.data.part === 'blocks' ? c.data.blocks.length : 'doc'))).toEqual(['doc', 1, 1, 1]);
    expect(assembleText(chunks).eq(doc)).toBe(true);
  });

  it('measures the chunk data including its envelope', () => {
    const doc = docWithParagraphs(50);
    const l = { textBlocks: 200, sheetRows: 500, maxBytes: 1000 };
    const chunks = chunkText(doc, l);
    checkL6(chunks, l);
    expect(chunks.length).toBeGreaterThan(2);
  });

  it('does not mutate its input', () => {
    const doc = docWithParagraphs(3, { header: true });
    const before = JSON.stringify(doc.toJSON());
    assembleText(chunkText(doc, DEFAULT_CHUNK_LIMITS));
    expect(JSON.stringify(doc.toJSON())).toBe(before);
  });

  describe('rejects invalid chunks with PROTOCOL_INVALID_MESSAGE', () => {
    const good = (): Chunk<TextChunkData>[] =>
      JSON.parse(JSON.stringify(chunkText(docWithParagraphs(3, { header: true, footer: true }), { ...DEFAULT_CHUNK_LIMITS, textBlocks: 1 }))) as Chunk<TextChunkData>[];

    it('an empty list or a non-array', () => {
      expectInvalid([]);
      expectInvalid(null);
      expectInvalid({});
    });

    it('a seq gap', () => {
      const c = good();
      c.splice(2, 1);
      expectInvalid(c);
    });

    it('a missing doc part', () => {
      expectInvalid(good().slice(1).map((c, i) => ({ ...c, seq: i })));
    });

    it('regions out of order', () => {
      const c = good();
      const [a, b] = [c[1], c[2]];
      if (!a || !b) throw new Error('fixture');
      c[1] = { ...b, seq: 1 };
      c[2] = { ...a, seq: 2 };
      expectInvalid(c);
    });

    it('header or footer presence that does not match chunk 0', () => {
      const c = good();
      const head = c[0]?.data;
      if (head?.part !== 'doc') throw new Error('fixture');
      head.footer = false;
      expectInvalid(c);
      expectInvalid(good().filter((x) => x.data.part === 'doc' || x.data.region !== 'header').map((x, i) => ({ ...x, seq: i })));
    });

    it('no body chunk', () => {
      const c = good().filter((x) => x.data.part === 'doc' || x.data.region !== 'body').map((x, i) => ({ ...x, seq: i }));
      expectInvalid(c);
    });

    it('invalid block content or attributes', () => {
      const c = good();
      const d = c[2]?.data;
      if (d?.part !== 'blocks') throw new Error('fixture');
      d.blocks = [{ type: 'page_break' }, { type: 'nope' }];
      expectInvalid(c);
      d.blocks = [{ type: 'paragraph', attrs: { align: 'x' } }];
      expectInvalid(c);
    });

    it('invalid page settings, including margins that do not fit the page', () => {
      const c = good();
      const head = c[0]?.data;
      if (head?.part !== 'doc') throw new Error('fixture');
      head.page = { ...A4, margins: { top: 0, bottom: 0, left: 300, right: 300 } };
      expectInvalid(c);
      head.page = { ...A4, orientation: 'x' } as unknown as typeof head.page;
      expectInvalid(c);
    });

    it('an unknown part or region', () => {
      const c = good();
      (c[1] as unknown as { data: { region: string } }).data.region = 'aside';
      expectInvalid(c);
    });
  });
});
