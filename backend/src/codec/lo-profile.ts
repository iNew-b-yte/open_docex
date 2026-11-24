/**
 * LibreOffice profile slots (LLD Part 2 §14.3). One folder per concurrency permit, seeded with
 * macro and link blocking; created at boot and re-created after a timeout or kill.
 *
 * @module
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SCRIPTING = '/org.openoffice.Office.Common/Security/Scripting';
const LOAD = '/org.openoffice.Office.Calc/Formula/Load';

/** The seeded settings (§14.3, S-13). */
const ITEMS: ReadonlyArray<readonly [string, string, string]> = [
  [SCRIPTING, 'DisableMacrosExecution', 'true'],
  [SCRIPTING, 'MacroSecurityLevel', '3'],
  [SCRIPTING, 'BlockUntrustedRefererLinks', 'true'],
  [LOAD, 'OOXMLRecalcMode', '1'],
  [LOAD, 'ODFRecalcMode', '1'],
];

/** The content of `user/registrymodifications.xcu`. */
export function registryModifications(): string {
  const items = ITEMS.map(
    ([path, name, value]) =>
      `<item oor:path="${path}"><prop oor:name="${name}" oor:op="fuse"><value>${value}</value></prop></item>`,
  ).join('\n');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n' +
    `${items}\n</oor:items>\n`
  );
}

/** The folder of slot `n`: `<tmpDir>/lo/slot-<n>`. `n` is a number, never document input. */
export function slotDir(tmpDir: string, n: number): string {
  return join(tmpDir, 'lo', `slot-${String(n)}`);
}

/** Deletes and re-creates `profileDir` with the seeded settings. */
export async function resetProfile(profileDir: string): Promise<void> {
  await rm(profileDir, { recursive: true, force: true });
  await mkdir(join(profileDir, 'user'), { recursive: true, mode: 0o700 });
  await writeFile(join(profileDir, 'user', 'registrymodifications.xcu'), registryModifications(), { mode: 0o600 });
}
