import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeMessage, PROTOCOL_VERSION } from '@open-docex/shared/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreChannelSide } from '../../../src/channel/engine-channel.js';
import type { CoreEvent, CoreRequest } from '../../../src/channel/messages.js';
import { CoreRuntime, type CoreServices } from '../../../src/core/core-runtime.js';
import { lockPath, tmpRoot } from '../../../src/persistence/layout.js';
import { FakeStorage } from '../../../test-kit/storage/fake-storage.js';
import { cid, FakeCodec, FakeFlush } from './harness.js';

class FakeSide implements CoreChannelSide {
  events: CoreEvent[] = [];
  #handler: (m: CoreRequest) => void = () => {};
  onRequest(handler: (m: CoreRequest) => void): void {
    this.#handler = handler;
  }
  emit(ev: CoreEvent): void {
    this.events.push(ev);
  }
  whenWritable(): Promise<void> {
    return Promise.resolve();
  }
  hook(): Promise<unknown> {
    return Promise.reject(new Error('no hooks'));
  }
  post(m: CoreRequest): void {
    this.#handler(m);
  }
  reply(id: number): CoreEvent | undefined {
    return this.events.find((e) => (e.type === 'ready' || e.type === 'result') && e.id === id);
  }
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setup(o: { mod?: unknown; probeError?: Error } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'odx-rt-'));
  dirs.push(dataDir);
  const storage = new FakeStorage();
  const codec = new FakeCodec();
  codec.probeError = o.probeError ?? null;
  let recoveryScans = 0;
  const services: CoreServices = {
    codec: () => codec,
    flush: () => new FakeFlush(),
    recovery: () => ({ resumeAfterBoot: () => void recoveryScans++ }),
    audit: () => ({ emit: () => {} }),
    importModule: (url) => {
      if (o.mod === 'throw') return Promise.reject(new Error(`cannot import ${url}`));
      return Promise.resolve(o.mod ?? { default: { dataDir, storage } });
    },
  };
  const side = new FakeSide();
  const rt = new CoreRuntime(side, { services });
  return { dataDir, storage, side, rt, recoveryScans: () => recoveryScans };
}

async function init(side: FakeSide, id = 1): Promise<CoreEvent> {
  side.post({ type: 'init', id, workerConfigModule: path.resolve('worker-config.mjs'), logLevel: 'error' });
  return vi.waitFor(() => {
    const r = side.reply(id);
    if (r === undefined) throw new Error('no reply');
    return r;
  });
}

describe('CoreRuntime', () => {
  it('boots, serves sessions and shuts down', async () => {
    const t = await setup();
    await mkdir(tmpRoot(t.dataDir), { recursive: true });
    await writeFile(path.join(tmpRoot(t.dataDir), 'leftover'), 'x');
    const ready = await init(t.side);
    expect(ready).toMatchObject({ type: 'ready', id: 1, boot: { documents: 0, recovering: 0, dirty: 0, queueBacklog: 0 } });
    expect(existsSync(lockPath(t.dataDir))).toBe(true);
    expect(existsSync(path.join(tmpRoot(t.dataDir), 'leftover'))).toBe(false);
    expect(t.recoveryScans()).toBe(1);

    t.storage.setFile('d.docx', new TextEncoder().encode('hi'));
    t.side.post({ type: 'join', sessionId: 's1', documentId: 'd.docx' as never, userId: 'u', access: 'edit', document: { ref: 'd.docx', format: 'docx' } });
    const hello = encodeMessage({ type: 'hello', protocol: PROTOCOL_VERSION, clientId: cid('c1') }) as string;
    t.side.post({ type: 'frame', sessionId: 's1', data: new TextEncoder().encode(hello), binary: false });
    await vi.waitFor(() => {
      const sends = t.side.events.filter((e) => e.type === 'send');
      expect(sends.some((e) => e.type === 'send' && String(e.frames[0]?.data).includes('"load-start"'))).toBe(true);
    });
    expect(t.side.events.some((e) => e.type === 'emit' && e.event === 'document')).toBe(true);

    t.side.post({ type: 'ping', seq: 4 });
    expect(t.side.events.at(-1)).toEqual({ type: 'pong', seq: 4 });

    t.side.post({ type: 'shutdown', id: 2, timeoutMs: 1000 });
    await vi.waitFor(() => expect(t.side.reply(2)).toEqual({ type: 'result', id: 2, ok: true, value: undefined }));
    expect(existsSync(lockPath(t.dataDir))).toBe(false);
  });

  it('fails boot with CONFIG_INVALID when the module cannot be imported or has no default export', async () => {
    const a = await setup({ mod: 'throw' });
    expect(await init(a.side)).toMatchObject({ type: 'result', ok: false, error: { code: 'CONFIG_INVALID' } });
    const b = await setup({ mod: { notDefault: 1 } });
    expect(await init(b.side)).toMatchObject({ type: 'result', ok: false, error: { code: 'CONFIG_INVALID' } });
  });

  it('fails boot with CONFIG_LIBREOFFICE_NOT_FOUND when the probe fails, and releases the LOCK', async () => {
    const t = await setup({ probeError: new Error('ENOENT soffice') });
    expect(await init(t.side)).toMatchObject({ type: 'result', ok: false, error: { code: 'CONFIG_LIBREOFFICE_NOT_FOUND' } });
    expect(existsSync(lockPath(t.dataDir))).toBe(false);
  });

  it('refuses a data folder whose LOCK a live engine holds', async () => {
    const t = await setup();
    await init(t.side);
    const side2 = new FakeSide();
    new CoreRuntime(side2, {
      services: {
        codec: () => new FakeCodec(),
        flush: () => new FakeFlush(),
        recovery: () => ({ resumeAfterBoot: () => {} }),
        audit: () => ({ emit: () => {} }),
        importModule: () => Promise.resolve({ default: { dataDir: t.dataDir } }),
      },
    });
    const r = await init(side2);
    expect(r).toMatchObject({ type: 'result', ok: false, error: { code: 'CONFIG_DATA_DIR_UNWRITABLE' } });
    expect(r.type === 'result' && !r.ok && r.error.message).toContain(`pid ${process.pid}`);
    t.side.post({ type: 'shutdown', id: 9, timeoutMs: 1000 });
    await vi.waitFor(() => expect(t.side.reply(9)).toBeDefined());
  });

  it('answers an API call it does not serve yet with an error result', async () => {
    const t = await setup();
    await init(t.side);
    t.side.post({ type: 'call', id: 5, method: 'documents.info', args: {} });
    expect(t.side.reply(5)).toMatchObject({ type: 'result', id: 5, ok: false, error: { code: 'ENGINE_UNAVAILABLE' } });
    t.side.post({ type: 'shutdown', id: 6, timeoutMs: 1000 });
    await vi.waitFor(() => expect(t.side.reply(6)).toBeDefined());
  });
});
