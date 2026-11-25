// Describes the machine and the tool versions a benchmark ran on.
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { locateLibreOffice } from '../../backend/dist/codec/libreoffice-locate.js';

const run = promisify(execFile);

export async function describeEnvironment({ browser = false } = {}) {
  const cpus = os.cpus();
  const env = {
    date: new Date().toISOString(),
    cpuModel: cpus[0]?.model.trim() ?? 'unknown',
    logicalCores: cpus.length,
    ramGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    os: `${os.type()} ${os.release()} (${os.version()}) ${os.arch()}`,
    node: process.version,
    libreoffice: 'not found',
    chromium: 'not measured',
  };
  try {
    const soffice = await locateLibreOffice();
    env.sofficePath = soffice;
    env.libreoffice = (await run(soffice, ['--version'], { timeout: 60_000 })).stdout.trim();
  } catch (e) {
    env.libreoffice = `not found (${String(e).slice(0, 80)})`;
  }
  if (browser) {
    const { chromium } = await import('@playwright/test');
    const b = await chromium.launch();
    env.chromium = b.version();
    await b.close();
  }
  return env;
}
