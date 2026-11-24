import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { locateLibreOffice } from '../../../src/codec/libreoffice-locate.js';
import { registryModifications, resetProfile, slotDir } from '../../../src/codec/lo-profile.js';
import { existsSync, readFileSync } from 'node:fs';

const dir = mkdtempSync(join(tmpdir(), 'docex-loc-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('locateLibreOffice', () => {
  it('a configured existing path wins', async () => {
    const p = join(dir, 'soffice');
    writeFileSync(p, '');
    expect(await locateLibreOffice(p, { platform: 'linux', env: {} })).toBe(p);
  });
  it('a configured path that does not exist is CONFIG_LIBREOFFICE_NOT_FOUND', async () => {
    await expect(locateLibreOffice(join(dir, 'nope'))).rejects.toMatchObject({ code: 'CONFIG_LIBREOFFICE_NOT_FOUND' });
  });
  it('finds soffice on PATH', async () => {
    const name = process.platform === 'win32' ? 'soffice.exe' : 'soffice';
    const p = join(dir, name);
    writeFileSync(p, '');
    const got = await locateLibreOffice(undefined, {
      platform: process.platform,
      env: { PATH: dir, ProgramFiles: join(dir, 'none') },
    });
    expect(got.toLowerCase()).toContain('soffice');
  });
  it('nothing found is CONFIG_LIBREOFFICE_NOT_FOUND', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'docex-empty-'));
    await expect(
      locateLibreOffice(undefined, { platform: 'win32', env: { PATH: empty, ProgramFiles: empty, 'ProgramFiles(x86)': empty } }),
    ).rejects.toMatchObject({ code: 'CONFIG_LIBREOFFICE_NOT_FOUND' });
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('lo-profile', () => {
  it('seeds macro and link blocking and resets a slot', async () => {
    const slot = slotDir(dir, 3);
    expect(slot.endsWith(join('lo', 'slot-3'))).toBe(true);
    await resetProfile(slot);
    const xcu = join(slot, 'user', 'registrymodifications.xcu');
    const text = readFileSync(xcu, 'utf8');
    expect(text).toBe(registryModifications());
    for (const k of ['DisableMacrosExecution', 'MacroSecurityLevel', 'BlockUntrustedRefererLinks', 'OOXMLRecalcMode', 'ODFRecalcMode']) {
      expect(text).toContain(k);
    }
    writeFileSync(join(slot, 'user', 'junk'), 'x');
    await resetProfile(slot);
    expect(existsSync(join(slot, 'user', 'junk'))).toBe(false);
    expect(existsSync(xcu)).toBe(true);
  });
});
