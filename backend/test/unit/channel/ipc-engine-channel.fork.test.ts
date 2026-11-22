// IpcEngineChannel over a real forked child with `serialization: 'advanced'`.
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { IpcEngineChannel } from '../../../src/channel/ipc-engine-channel.js';
import type { CoreEvent } from '../../../src/channel/messages.js';
import { engineError } from '../../../src/errors/engine-error.js';

const FAKE_CORE = fileURLToPath(new URL('./fixtures/fake-core.mjs', import.meta.url));

const children: ChildProcess[] = [];

function start(mode = 'ok'): { child: ChildProcess; channel: IpcEngineChannel } {
  const child = fork(FAKE_CORE, [], {
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, FAKE_CORE_MODE: mode },
    windowsHide: true,
  });
  children.push(child);
  const channel = new IpcEngineChannel();
  channel.bind(child);
  return { child, channel };
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
});

describe('IpcEngineChannel over a forked child', () => {
  it('runs init, frames with bytes, calls and errors', async () => {
    const { channel } = start();
    const ready = await channel.request('init', { workerConfigModule: '/w.mjs', logLevel: 'info' }, 10_000);
    expect(ready.boot).toEqual({ documents: 0, recovering: 0, dirty: 0, queueBacklog: 0 });
    expect(typeof ready.pid).toBe('number');

    const sent = new Promise<CoreEvent>((resolve) => channel.onEvent(resolve));
    channel.post({ type: 'frame', sessionId: 's1', data: new Uint8Array([1, 2, 3]), binary: true });
    const ev = await sent;
    expect(ev.type).toBe('send');
    if (ev.type === 'send') expect(ev.frames[0]?.data).toEqual(new Uint8Array([1, 2, 3]));

    await expect(channel.call('documents.info', { a: new Map([[1, 2n]]) })).resolves.toEqual({ a: new Map([[1, 2n]]) });
    await expect(channel.call('documents.info', { fail: true })).rejects.toMatchObject({
      code: 'DOCUMENT_NOT_FOUND',
      documentId: 'd1',
      cause: 'ENOENT',
    });
  });

  it('rejects pending calls with ENGINE_RESTARTING when unbound after the child dies', async () => {
    const { child, channel } = start();
    await channel.request('init', { workerConfigModule: '/w.mjs', logLevel: 'info' }, 10_000);
    const pending = channel.call('documents.info', { crash: true });
    child.once('exit', () => channel.unbind(engineError('ENGINE_RESTARTING')));
    await expect(pending).rejects.toMatchObject({ code: 'ENGINE_RESTARTING' });
    expect(await exited(child)).toBe(3);
    await expect(channel.call('documents.info', {})).rejects.toMatchObject({ code: 'ENGINE_RESTARTING' });
  });

  it('answers shutdown before the child exits', async () => {
    const { child, channel } = start();
    await channel.request('init', { workerConfigModule: '/w.mjs', logLevel: 'info' }, 10_000);
    await channel.request('shutdown', { timeoutMs: 1000 }, 5000);
    expect(await exited(child)).toBe(0);
  });
});
