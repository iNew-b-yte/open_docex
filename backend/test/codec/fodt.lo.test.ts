// Real-LibreOffice tests of the FodtMapper (V1-14b). Run with OPEN_DOCEX_LO_TESTS=1 (CI sets it).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sniffAssetMime } from '../../src/persistence/asset-store.js';
import { importFile, root, service } from './lo-setup.js';

interface Block {
  type: string;
  attrs?: { assetId?: string; kind?: string };
  content?: Block[];
}
interface Doc {
  attrs: { margins: { top: number; bottom: number } };
  content: Block[];
}
const region = (r: { snapshot: unknown }, type: string): Block[] => (r.snapshot as Doc).content.find((n) => n.type === type)?.content ?? [];

describe.skipIf(process.env['OPEN_DOCEX_LO_TESTS'] !== '1')('FodtMapper with real LibreOffice', () => {
  for (const [name, format] of [
    ['features.docx', 'docx'],
    ['features.odt', 'odt'],
    ['features-word.docx', 'docx'],
  ] as const) {
    it(`round-trips ${name}: import, export, re-import give the same model`, async () => {
      const assetDir = join(root, `assets-rt-${name}`);
      const first = await importFile(name, format, assetDir);
      const bytes = await service.export({ kind: 'text', format, model: first.snapshot, assetDir });
      const second = await service.import({ bytes, format, assetDir });
      expect(second.snapshot).toEqual(first.snapshot);
      expect(second.findings).toEqual([]);
      expect(first.findings).toEqual([]);
    }, 240_000);
  }

  it('the S2 features file maps every V1 feature', async () => {
    const r = await importFile('features-word.docx', 'docx');
    const types = new Set<string>();
    const walk = (n: Block): void => {
      types.add(n.type);
      n.content?.forEach(walk);
    };
    region(r, 'body').forEach(walk);
    for (const t of ['heading', 'paragraph', 'bullet_list', 'ordered_list', 'list_item', 'table', 'table_header', 'table_cell', 'image', 'page_break', 'hard_break', 'text']) {
      expect(types, t).toContain(t);
    }
    expect(r.assetIds).toHaveLength(3);
  }, 120_000);

  it('S-9: a Word file with a 15/20 mm body margin, a header and a footer keeps those margins', async () => {
    const r = await importFile('features-word.docx', 'docx');
    const margins = (r.snapshot as Doc).attrs.margins;
    expect(margins.top).toBeCloseTo(42.5, 0); // 15 mm
    expect(margins.bottom).toBeCloseTo(56.7, 0); // 20 mm
  }, 120_000);

  it('PO-21: page number and page count fields in the header and footer', async () => {
    for (const [name, format] of [['features.docx', 'docx'], ['features.odt', 'odt'], ['features-word.docx', 'docx']] as const) {
      const r = await importFile(name, format);
      const kinds = (type: string): string[] =>
        region(r, type)
          .flatMap((p) => p.content ?? [])
          .filter((n) => n.type === 'page_field')
          .map((n) => n.attrs?.kind ?? '');
      expect(kinds('header'), name).toEqual(['number', 'count']);
      expect(kinds('footer'), name).toEqual(['number', 'count']);
      expect(r.findings, name).toEqual([]);
    }
  }, 240_000);

  for (const [name, format] of [['legacy-images.docx', 'docx'], ['legacy-images.odt', 'odt']] as const) {
    it(`PO-22: EMF, WMF, TIFF and SVG in ${name} become PNG assets, with a conversion notice`, async () => {
      const assetDir = join(root, `assets-legacy-${name}`);
      const r = await importFile(name, format, assetDir);
      const images = region(r, 'body').filter((b) => b.type === 'image');
      expect(images).toHaveLength(4);
      for (const img of images) {
        const bytes = new Uint8Array(readFileSync(join(assetDir, img.attrs?.assetId ?? '')));
        expect(sniffAssetMime(bytes)).toBe('image/png');
      }
      expect(r.conversions).toHaveLength(1);
      expect(r.conversions?.[0]).toMatchObject({ feature: 'image-to-png', count: 4 });
      expect(r.conversions?.[0]?.where?.join(' ')).toMatch(/EMF.*WMF.*TIFF.*SVG/);
      expect(r.findings).toEqual([]);
    }, 240_000);
  }

  it('PO-22: converted images survive export and re-import as the same PNG assets', async () => {
    const assetDir = join(root, 'assets-legacy-rt');
    const first = await importFile('legacy-images.docx', 'docx', assetDir);
    const bytes = await service.export({ kind: 'text', format: 'docx', model: first.snapshot, assetDir });
    const second = await service.import({ bytes, format: 'docx', assetDir });
    const ids = (r: { snapshot: unknown }): string[] =>
      region(r, 'body')
        .filter((b) => b.type === 'image')
        .map((b) => b.attrs?.assetId ?? '');
    expect(ids(second)).toEqual(ids(first));
    expect(second.conversions).toBeUndefined(); // they are PNG now
  }, 240_000);
});
