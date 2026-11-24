import { describe, expect, it } from 'vitest';
import { MAX_ZIP_ENTRIES, zipGuard } from '../../../src/codec/zip-guard.js';
import { buildZip } from './zip-builder.js';

const MAX = 1_000_000;
const odtMime = 'application/vnd.oasis.opendocument.text';
const docx = () => buildZip([{ name: 'word/document.xml', data: '<w:document/>' }]);
const odt = (mime = odtMime, extra: Array<{ name: string; data: string }> = []) =>
  buildZip([
    { name: 'mimetype', data: mime, store: true },
    { name: 'content.xml', data: '<office:document-content/>' },
    ...extra,
  ]);
const code = (c: string): unknown => expect.objectContaining({ code: c }) as unknown;

describe('zipGuard', () => {
  it('accepts docx, odt and xlsx without macros', async () => {
    expect(await zipGuard(docx(), 'docx', MAX)).toEqual({ macros: false });
    expect(await zipGuard(odt(), 'odt', MAX)).toEqual({ macros: false });
    const x = buildZip([{ name: 'xl/workbook.xml', data: '<workbook/>' }]);
    expect(await zipGuard(x, 'xlsx', MAX)).toEqual({ macros: false });
  });
  it('rejects a file over maxFileBytes', async () => {
    await expect(zipGuard(docx(), 'docx', 10)).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
  });
  it('rejects a non-zip (such as an encrypted CFB file)', async () => {
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array<number>(600).fill(0)]);
    await expect(zipGuard(cfb, 'docx', MAX)).rejects.toThrow(code('CONVERSION_FAILED'));
  });
  it('rejects a missing required part or a wrong mimetype', async () => {
    await expect(zipGuard(docx(), 'xlsx', MAX)).rejects.toThrow(code('CONVERSION_FAILED'));
    await expect(zipGuard(odt('text/plain'), 'odt', MAX)).rejects.toThrow(code('CONVERSION_FAILED'));
    await expect(zipGuard(odt(), 'ods', MAX)).rejects.toThrow(code('CONVERSION_FAILED'));
    const noContent = buildZip([{ name: 'mimetype', data: odtMime, store: true }]);
    await expect(zipGuard(noContent, 'odt', MAX)).rejects.toThrow(code('CONVERSION_FAILED'));
  });
  it('reports macros (vbaProject.bin, Basic/)', async () => {
    const a = buildZip([
      { name: 'word/document.xml', data: '<d/>' },
      { name: 'word/vbaProject.bin', data: 'x' },
    ]);
    expect((await zipGuard(a, 'docx', MAX)).macros).toBe(true);
    const b = odt(odtMime, [{ name: 'Basic/Standard/Module1.xml', data: '<m/>' }]);
    expect((await zipGuard(b, 'odt', MAX)).macros).toBe(true);
  });
  it('rejects a zip bomb (entry compression ratio over 200)', async () => {
    const bomb = buildZip([
      { name: 'word/document.xml', data: '<d/>' },
      { name: 'word/bomb.xml', data: new Uint8Array(10_000_000) },
    ]);
    expect(bomb.length).toBeLessThan(100_000);
    await expect(zipGuard(bomb, 'docx', MAX)).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
  });
  it('rejects too large a total declared size', async () => {
    const noise = Buffer.alloc(300_000);
    for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 2654435761) >>> 24;
    const entries = Array.from({ length: 8 }, (_, i) => ({ name: `word/p${String(i)}.bin`, data: noise, store: true }));
    entries.push({ name: 'word/document.xml', data: Buffer.from('<d/>'), store: true });
    // 8 x 300 kB stored = 2.4 MB, over 20 x 100 kB
    await expect(zipGuard(buildZip(entries), 'docx', 100_000)).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
  });
  it('rejects too many entries', async () => {
    const entries = Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: `f${String(i)}`, data: '', store: true }));
    entries.push({ name: 'word/document.xml', data: '<d/>', store: true });
    await expect(zipGuard(buildZip(entries), 'docx', 10_000_000)).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
  });
});
