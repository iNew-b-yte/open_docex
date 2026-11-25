// Accept-queue probe (V1-41 follow-up): no open_docex code at all. A bare `net` server and K client
// processes that connect N sockets each, all at the same moment, to show how many simultaneous
// connects the OS and Node accept before refusing the rest (ECONNREFUSED).
//
//   node bench/accept-probe.mjs [--procs 8] [--per 50] [--backlog N] [--busyMs M]
//
// --procs    client processes (their connects really are simultaneous)
// --per      connects each process starts at once
// --backlog  `server.listen` backlog (default: Node's 511)
// --busyMs   the server blocks its event loop this long per accepted socket (a busy engine)
import { fork } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};

if (process.argv[2] === '--child') {
  const [port, per] = [Number(process.argv[3]), Number(process.argv[4])];
  const codes = {};
  let ok = 0;
  await Promise.all(
    Array.from({ length: per }, () => new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => {
        ok++;
        resolve();
      });
      s.on('error', (e) => {
        codes[e.code] = (codes[e.code] ?? 0) + 1;
        resolve();
      });
    })),
  );
  process.send({ ok, codes });
  await new Promise((r) => setTimeout(r, 500));
  process.exit(0);
} else {
  const procs = opt('procs', 8);
  const per = opt('per', 50);
  const busyMs = opt('busyMs', 0);
  const backlog = argv.includes('--backlog') ? opt('backlog', 511) : undefined;
  const server = net.createServer((s) => {
    s.on('error', () => undefined);
    if (busyMs > 0) for (const end = performance.now() + busyMs; performance.now() < end; );
  });
  await new Promise((resolve) => (backlog === undefined ? server.listen(0, '127.0.0.1', resolve) : server.listen(0, '127.0.0.1', backlog, resolve)));
  const port = server.address().port;
  const kids = Array.from({ length: procs }, () => fork(fileURLToPath(import.meta.url), ['--child', String(port), String(per)], { execArgv: [] }));
  const results = await Promise.all(kids.map((k) => new Promise((resolve) => k.once('message', resolve))));
  const total = results.reduce((a, r) => ({ ok: a.ok + r.ok, codes: Object.entries(r.codes).reduce((c, [k, v]) => ({ ...c, [k]: (c[k] ?? 0) + v }), a.codes) }), { ok: 0, codes: {} });
  console.log(JSON.stringify({ procs, per, simultaneous: procs * per, backlog: backlog ?? 'default (511)', busyMs, connected: total.ok, refused: total.codes }));
  process.exit(0);
}
