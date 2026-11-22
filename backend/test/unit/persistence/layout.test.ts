import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OpenDocexError } from '@open-docex/shared/errors';
import { asDocumentId } from '@open-docex/shared/ids';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assetsDir,
  docDir,
  docKeyOf,
  emptyTmp,
  ensureLayout,
  isDocKey,
  journalDir,
  layoutPath,
  metaPath,
  snapshotPath,
  tmpRoot,
} from '../../../src/persistence/layout.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'odx-layout-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('docKey and paths', () => {
  it('is the SHA-256 hex of the UTF-8 document ID', () => {
    const id = asDocumentId('Résumé 2026.docx');
    expect(docKeyOf(id)).toBe(createHash('sha256').update(Buffer.from('Résumé 2026.docx', 'utf8')).digest('hex'));
    expect(isDocKey(docKeyOf(id))).toBe(true);
  });

  it('never puts a raw document ID in a path', () => {
    for (const raw of ['../../etc/passwd', 'C:\\Windows\\x', 'a/b', 'CON', 'doc:1', 'ok-id']) {
      const key = docKeyOf(asDocumentId(raw));
      const paths = [docDir(dir, key), metaPath(dir, key), snapshotPath(dir, key), journalDir(dir, key), assetsDir(dir, key)];
      for (const p of paths) {
        const rel = path.relative(dir, p);
        expect(rel.startsWith('..')).toBe(false);
        expect(rel).not.toContain(raw);
        expect(rel.split(path.sep)).toEqual(expect.arrayContaining(['docs', key.slice(0, 2), key]));
      }
    }
  });

  it('rejects anything that is not a docKey', () => {
    for (const bad of ['', '..', 'a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(63)}/`, '../' + 'a'.repeat(61)]) {
      expect(() => docDir(dir, bad)).toThrow(TypeError);
    }
  });
});

describe('ensureLayout', () => {
  it('creates the folders and LAYOUT, and leaves no probe behind', async () => {
    const root = path.join(dir, 'data');
    await ensureLayout(root);
    expect((await readdir(root)).sort()).toEqual(['LAYOUT', 'docs', 'local-storage', 'tmp']);
    expect(await readFile(layoutPath(root), 'utf8')).toBe('1');
    expect(await readdir(tmpRoot(root))).toEqual([]);
    await ensureLayout(root); // idempotent
  });

  it('refuses a newer LAYOUT with CONFIG_DATA_DIR_UNWRITABLE', async () => {
    await writeFile(layoutPath(dir), '2\n');
    const err = await ensureLayout(dir).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OpenDocexError);
    expect((err as OpenDocexError).code).toBe('CONFIG_DATA_DIR_UNWRITABLE');
    expect((err as OpenDocexError).message).toMatch(/newer version/);
  });

  it('fails with CONFIG_DATA_DIR_UNWRITABLE when the data folder is a file', async () => {
    const file = path.join(dir, 'file');
    await writeFile(file, 'x');
    await expect(ensureLayout(file)).rejects.toMatchObject({ code: 'CONFIG_DATA_DIR_UNWRITABLE' });
  });
});

describe('emptyTmp', () => {
  it('removes everything inside tmp/ and keeps the folder', async () => {
    await ensureLayout(dir);
    const t = tmpRoot(dir);
    await writeFile(path.join(t, 'a'), 'x');
    await mkdir(path.join(t, 'slot-0', 'deep'), { recursive: true });
    await writeFile(path.join(t, 'slot-0', 'deep', 'b'), 'y');
    await emptyTmp(dir);
    expect(await readdir(t)).toEqual([]);
  });
});
