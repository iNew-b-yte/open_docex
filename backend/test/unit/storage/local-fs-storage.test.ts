import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OpenDocexError } from '@open-docex/shared/errors';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFsStorage, refSyntaxError, sanitizeName } from '../../../src/storage/local-fs-storage.js';
import type { LogFields, Logger } from '../../../src/log/logger.js';
import { runStorageConformance } from '../../../test-kit/storage/storage-conformance.js';

const signal = (): AbortSignal => new AbortController().signal;
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

runStorageConformance({
  name: 'LocalFsStorage',
  async setup() {
    const dir = await mkdtemp(path.join(tmpdir(), 'odx-lfs-conf-'));
    return {
      adapter: new LocalFsStorage({ root: dir }),
      missingRef: 'missing.docx',
      teardown: () => rm(dir, { recursive: true, force: true }),
    };
  },
});

/** Tries to make a symlink; returns false where the OS or account doesn't allow it. */
async function trySymlink(target: string, at: string, type: 'file' | 'junction' | 'dir'): Promise<boolean> {
  try {
    await symlink(target, at, type);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw err;
  }
}

async function expectNotFound(p: Promise<unknown>): Promise<void> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OpenDocexError);
  expect((err as OpenDocexError).code).toBe('DOCUMENT_NOT_FOUND');
}

describe('LocalFsStorage', () => {
  let base: string;
  let root: string;
  let outside: string;
  let warnings: [string, LogFields | undefined][];
  let storage: LocalFsStorage;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'odx-lfs-'));
    root = path.join(base, 'root');
    outside = path.join(base, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    warnings = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (m, f) => void warnings.push([m, f]),
      error() {},
    };
    storage = new LocalFsStorage({ root, logger });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  describe('path confinement', () => {
    it.each([
      ['empty', ''],
      ['too long', 'a'.repeat(1025)],
      ['parent', '../outside/secret.txt'],
      ['parent in the middle', 'a/../../outside/secret.txt'],
      ['bare parent', '..'],
      ['dot (the root itself)', '.'],
      ['NUL', 'a\0b.docx'],
      ['control character', 'a\nb.docx'],
      ['backslash', '..\\outside\\secret.txt'],
      ['backslash in a name', 'a\\b.docx'],
      ['POSIX absolute', '/etc/passwd'],
      ['drive letter', 'C:\\Windows\\win.ini'],
      ['drive letter, forward slashes', 'C:/Windows/win.ini'],
      ['drive-relative', 'c:secret.txt'],
      ['UNC', '\\\\server\\share\\x.docx'],
      ['UNC, forward slashes', '//server/share/x.docx'],
      ['alternate data stream', 'doc.docx:stream'],
      ['reserved name', 'con'],
      ['reserved name with extension', 'NUL.docx'],
      ['reserved name in a folder', 'a/com1.txt'],
      ['reserved name lpt', 'LPT9'],
    ])('rejects %s', async (_label, ref) => {
      await expectNotFound(storage.read(ref, { signal: signal(), maxBytes: 100 }));
      await expectNotFound(storage.stat(ref, { signal: signal() }));
      await expectNotFound(storage.write(ref, bytes('x'), { expectedVersion: null, signal: signal() }));
      expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    });

    it('rejects refs that are not strings', async () => {
      await expectNotFound(storage.read({ path: 'a.docx' }, { signal: signal(), maxBytes: 100 }));
      await expectNotFound(storage.stat({ $local: 'a.docx' }, { signal: signal() }));
    });

    it('treats a literal %2e%2e as a name inside the root', async () => {
      await mkdir(path.join(root, '%2e%2e'));
      expect(await storage.read('%2e%2e/outside/secret.txt', { signal: signal(), maxBytes: 100 })).toBeNull();
      const res = await storage.write('%2e%2e/x.docx', bytes('x'), { expectedVersion: null, signal: signal() });
      expect(res.ok).toBe(true);
      expect(await readFile(path.join(root, '%2e%2e', 'x.docx'), 'utf8')).toBe('x');
    });

    it('allows names that only start with two dots', async () => {
      const res = await storage.write('..x.docx', bytes('x'), { expectedVersion: null, signal: signal() });
      expect(res.ok).toBe(true);
      expect(await readFile(path.join(root, '..x.docx'), 'utf8')).toBe('x');
    });

    it('rejects a folder symlink that escapes the root', async (ctx) => {
      const type = process.platform === 'win32' ? 'junction' : 'dir';
      if (!(await trySymlink(outside, path.join(root, 'link'), type))) ctx.skip();
      await expectNotFound(storage.read('link/secret.txt', { signal: signal(), maxBytes: 100 }));
      await expectNotFound(storage.write('link/new.docx', bytes('x'), { expectedVersion: null, signal: signal() }));
      expect(await readdir(outside)).toEqual(['secret.txt']);
    });

    it('rejects a file symlink that escapes the root', async (ctx) => {
      if (!(await trySymlink(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'), 'file'))) ctx.skip();
      await expectNotFound(storage.read('leak.txt', { signal: signal(), maxBytes: 100 }));
    });

    it('follows a symlink that stays inside the root', async (ctx) => {
      await mkdir(path.join(root, 'real'));
      await writeFile(path.join(root, 'real', 'a.docx'), 'inside');
      const type = process.platform === 'win32' ? 'junction' : 'dir';
      if (!(await trySymlink(path.join(root, 'real'), path.join(root, 'alias'), type))) ctx.skip();
      const read = await storage.read('alias/a.docx', { signal: signal(), maxBytes: 100 });
      expect(new TextDecoder().decode(read!.bytes)).toBe('inside');
    });

    it('logs the reason without the ref and gives a generic error', async () => {
      const err: unknown = await storage.read('../secret-name.txt', { signal: signal(), maxBytes: 100 }).catch((e: unknown) => e);
      expect((err as OpenDocexError).message).not.toContain('secret-name');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]![0]).toContain('parent segment');
      expect(warnings[0]![0]).not.toContain('secret-name');
      expect(warnings[0]![1]).toEqual({ code: 'DOCUMENT_NOT_FOUND' });
    });

    it('accepts nested relative refs inside the root', async () => {
      await mkdir(path.join(root, 'a', 'b'), { recursive: true });
      const res = await storage.write('a/./b/c.docx', bytes('c'), { expectedVersion: null, signal: signal() });
      expect(res.ok).toBe(true);
      expect(await readFile(path.join(root, 'a', 'b', 'c.docx'), 'utf8')).toBe('c');
    });
  });

  describe('refSyntaxError', () => {
    it('passes ordinary refs', () => {
      expect(refSyntaxError('a.docx')).toBeNull();
      expect(refSyntaxError('folder/sub/Report 2026.odt')).toBeNull();
      expect(refSyntaxError('a'.repeat(1024))).toBeNull();
      expect(refSyntaxError('console.docx')).toBeNull();
    });
  });

  describe('versions and conflicts', () => {
    it('uses mtimeNs:size as the version', async () => {
      await writeFile(path.join(root, 'a.docx'), 'abc');
      const st = await storage.stat('a.docx', { signal: signal() });
      expect(st!.version).toMatch(/^\d+:3$/);
      expect(st!.size).toBe(3);
    });

    it('reports the current version on a conflict', async () => {
      await writeFile(path.join(root, 'a.docx'), 'abc');
      const st = await storage.stat('a.docx', { signal: signal() });
      const res = await storage.write('a.docx', bytes('x'), { expectedVersion: '1:1', signal: signal() });
      expect(res).toEqual({ ok: false, reason: 'conflict', currentVersion: st!.version });
    });

    it('leaves no temporary file after a write or a conflict', async () => {
      const made = await storage.create({ kind: 'text', format: 'docx', name: 'A', bytes: bytes('1') }, { signal: signal() });
      await storage.write(made.ref, bytes('2'), { expectedVersion: made.version, signal: signal() });
      await storage.write(made.ref, bytes('3'), { expectedVersion: made.version, signal: signal() });
      expect(await readdir(root)).toEqual([made.ref]);
    });

    it('fails with STORAGE_WRITE_FAILED when the folder is missing', async () => {
      const err: unknown = await storage
        .write('nope/a.docx', bytes('x'), { expectedVersion: null, signal: signal() })
        .catch((e: unknown) => e);
      expect((err as OpenDocexError).code).toBe('STORAGE_WRITE_FAILED');
    });

    it('returns null for a folder', async () => {
      await mkdir(path.join(root, 'dir'));
      expect(await storage.read('dir', { signal: signal(), maxBytes: 100 })).toBeNull();
      expect(await storage.stat('dir', { signal: signal() })).toBeNull();
    });

    it('rejects an oversized read with DOCUMENT_TOO_LARGE', async () => {
      await writeFile(path.join(root, 'a.docx'), '0123456789');
      const err: unknown = await storage.read('a.docx', { signal: signal(), maxBytes: 4 }).catch((e: unknown) => e);
      expect((err as OpenDocexError).code).toBe('DOCUMENT_TOO_LARGE');
    });

    it('fails reads with STORAGE_READ_FAILED when the root is missing', async () => {
      const lost = new LocalFsStorage({ root: path.join(base, 'no-such-root') });
      const err: unknown = await lost.stat('a.docx', { signal: signal() }).catch((e: unknown) => e);
      expect((err as OpenDocexError).code).toBe('STORAGE_READ_FAILED');
    });
  });

  describe('create', () => {
    it('names the file sanitize(name)-<8 hex>.<format> in the root', async () => {
      const made = await storage.create(
        { kind: 'text', format: 'odt', name: '../Q3 <report>/é_1.final', bytes: bytes('x') },
        { signal: signal() },
      );
      expect(made.ref).toMatch(/^\.\.Q3 reporté_1\.final-[0-9a-f]{8}\.odt$/);
      expect(await readFile(path.join(root, made.ref), 'utf8')).toBe('x');
    });

    it('rejects an unknown format', async () => {
      const err: unknown = await storage
        .create({ kind: 'text', format: '../x' as 'docx', name: 'A', bytes: bytes('x') }, { signal: signal() })
        .catch((e: unknown) => e);
      expect((err as OpenDocexError).code).toBe('STORAGE_WRITE_FAILED');
      expect(await readdir(root)).toEqual([]);
    });
  });

  describe('sanitizeName', () => {
    it('keeps letters, digits, space, dot, underscore and hyphen', () => {
      expect(sanitizeName('a/b\\c:d*e?f"g<h>i|j\0k')).toBe('abcdefghijk');
      expect(sanitizeName('Résumé 2026_v1.2-final')).toBe('Résumé 2026_v1.2-final');
    });

    it('caps the result at 100 characters', () => {
      expect(sanitizeName('x'.repeat(300))).toHaveLength(100);
    });
  });

  it('requires a root', () => {
    expect(() => new LocalFsStorage({ root: '' })).toThrow(OpenDocexError);
  });
});
