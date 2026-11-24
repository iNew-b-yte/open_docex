/**
 * Finds the LibreOffice binary (LLD Part 2 §14.2 "Locating the binary").
 *
 * @module
 */
import { readdir, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { engineError } from '../errors/engine-error.js';

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** The first existing file named `name` in a `PATH` directory. */
async function onPath(name: string, pathVar: string | undefined): Promise<string | undefined> {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (dir === '') continue;
    const p = join(dir, name);
    if (await isFile(p)) return p;
  }
  return undefined;
}

/** `/opt/libreoffice*` program folders, newest name first. */
async function optCandidates(): Promise<string[]> {
  try {
    const names = (await readdir('/opt')).filter((n) => n.startsWith('libreoffice')).sort().reverse();
    return names.map((n) => `/opt/${n}/program/soffice`);
  } catch {
    return [];
  }
}

/** Where {@link locateLibreOffice} looks; injectable for tests. */
export interface LocateEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

/**
 * Returns the path of `soffice`. A configured `configured` path wins and must exist; otherwise
 * the first existing platform candidate is used. Throws `CONFIG_LIBREOFFICE_NOT_FOUND`.
 */
export async function locateLibreOffice(configured?: string, e: LocateEnv = process): Promise<string> {
  if (configured !== undefined) {
    if (await isFile(configured)) return configured;
    throw engineError('CONFIG_LIBREOFFICE_NOT_FOUND', { message: 'The configured libreoffice.path does not exist' });
  }
  let candidates: string[];
  let pathName: string;
  if (e.platform === 'win32') {
    candidates = [e.env['ProgramFiles'], e.env['ProgramFiles(x86)']]
      .filter((d): d is string => d !== undefined && d !== '')
      .map((d) => join(d, 'LibreOffice', 'program', 'soffice.exe'));
    pathName = 'soffice.exe';
  } else if (e.platform === 'darwin') {
    candidates = ['/Applications/LibreOffice.app/Contents/MacOS/soffice'];
    pathName = 'soffice';
  } else {
    candidates = [
      '/usr/bin/soffice',
      '/usr/lib/libreoffice/program/soffice',
      ...(await optCandidates()),
      '/snap/bin/libreoffice',
    ];
    pathName = 'soffice';
  }
  for (const c of candidates) if (await isFile(c)) return c;
  const found = await onPath(pathName, e.env['PATH'] ?? e.env['Path']);
  if (found !== undefined) return found;
  throw engineError('CONFIG_LIBREOFFICE_NOT_FOUND', { message: 'LibreOffice (soffice) was not found' });
}
