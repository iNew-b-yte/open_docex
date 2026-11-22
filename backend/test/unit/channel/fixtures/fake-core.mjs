// A stand-in Core for channel and Supervisor tests. It speaks the LLD Part 2 §6.2 IPC messages
// over `process.send` and is forked with `serialization: 'advanced'`.
//
// FAKE_CORE_MODE selects the behaviour:
// - `ok` (default): answers init, ping, call and shutdown
// - `boot-error`: answers init with a CONFIG_INVALID result
// - `exit-on-init`: exits with code 3 on init
// - `no-pong`: like `ok`, but never answers ping
// Calls: `documents.info` echoes `args`; with `{ crash: true }` the process exits with code 3;
// with `{ busy: true }` it busy-loops forever; with `{ fail: true }` it answers with a WireError.
const mode = process.env.FAKE_CORE_MODE ?? 'ok';

const send = (msg) => process.send(msg);

process.on('message', (m) => {
  switch (m.type) {
    case 'init':
      if (mode === 'boot-error') {
        send({ type: 'result', id: m.id, ok: false, error: { code: 'CONFIG_INVALID', message: 'storage: must be an object' } });
      } else if (mode === 'exit-on-init') {
        process.exit(3);
      } else {
        send({ type: 'ready', id: m.id, pid: process.pid, boot: { documents: 0, recovering: 0, dirty: 0, queueBacklog: 0 } });
      }
      return;
    case 'ping':
      if (mode !== 'no-pong') send({ type: 'pong', seq: m.seq });
      return;
    case 'frame':
      send({ type: 'send', frames: [{ sessionIds: [m.sessionId], data: m.data, binary: m.binary }] });
      return;
    case 'call': {
      const args = m.args ?? {};
      if (args.crash) process.exit(3);
      if (args.busy) for (;;);
      if (args.fail) {
        send({
          type: 'result', id: m.id, ok: false,
          error: { code: 'DOCUMENT_NOT_FOUND', message: 'no such doc', documentId: 'd1', causeMessage: 'ENOENT' },
        });
        return;
      }
      send({ type: 'result', id: m.id, ok: true, value: args });
      return;
    }
    case 'shutdown':
      process.send({ type: 'result', id: m.id, ok: true, value: undefined }, () => process.exit(0));
      return;
  }
});

process.on('disconnect', () => process.exit(0));
