// The Core entry of worker mode: the compiled Core with the fake text codec of the e2e harness
// (LibreOffice is not involved in the network benchmarks). Every 500 ms it writes its own
// CPU time and memory to `<ctlDir>/core-stats.json`, which the server process reads.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { textSchema } from '@open-docex/shared/text';
import { resolveWorkerConfig } from '../../backend/dist/api/validate-options.js';
import { main } from '../../backend/dist/core/core-entry.js';
import { createFakeCodec } from '../../e2e/harness/fake-codec.mjs';

const { ctlDir } = JSON.parse(process.env.ODX_BENCH);
const codec = createFakeCodec({ textSchema, page: resolveWorkerConfig({}).blankDocument.page });
main({ codec: () => codec });

const file = path.join(ctlDir, 'core-stats.json');
setInterval(() => {
  const c = process.cpuUsage();
  const m = process.memoryUsage();
  try {
    writeFileSync(file, JSON.stringify({ cpuUs: c.user + c.system, rss: m.rss, heapUsed: m.heapUsed, at: Date.now() }));
  } catch {
    // The folder may be gone at shutdown.
  }
}, 100).unref();
