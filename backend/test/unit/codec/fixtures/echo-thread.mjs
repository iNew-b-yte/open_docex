// Test worker for CodecPool: `probe` jobs echo the thread id after workDir-driven behaviour.
import { parentPort, threadId } from 'node:worker_threads';

parentPort.on('message', ({ id, job }) => {
  const mode = job.workDir;
  if (mode === 'crash') {
    throw new Error('boom');
  }
  if (mode === 'fail') {
    parentPort.postMessage({ id, ok: false, code: 'CONVERSION_TIMEOUT', message: 'slow' });
    return;
  }
  if (mode === 'log') parentPort.postMessage({ log: 'warn', message: 'hello' });
  const delay = mode === 'slow' ? 150 : 0;
  setTimeout(() => parentPort.postMessage({ id, ok: true, result: { threadId } }), delay);
});
