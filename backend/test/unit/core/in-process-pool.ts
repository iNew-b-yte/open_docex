// A codec pool that runs jobs in the calling thread with the real FodtMapper and the real
// LibreOffice runner, for tests that need the real `CodecService` without a worker thread or a
// compiled build (the thread entry does the same inside a worker).
import type { CodecJob, CodecPoolLike } from '../../../src/codec/codec-pool.js';
import { CodecService } from '../../../src/codec/codec-service.js';
import { handleJob } from '../../../src/codec/codec-thread.js';
import { FodtMapper } from '../../../src/codec/fodt-mapper.js';
import { createRunner } from '../../../src/codec/libreoffice-runner.js';
import type { WiredCodec } from '../../../src/core/core-entry.js';
import type { CoreServiceContext } from '../../../src/core/core-runtime.js';
import { tmpRoot } from '../../../src/persistence/layout.js';

/** Runs codec jobs in this thread. */
export class InProcessPool implements CodecPoolLike {
  readonly #runner = createRunner();
  readonly #mapper = new FodtMapper();
  run<R>(job: CodecJob): Promise<R> {
    return handleJob(job, { mapper: this.#mapper, runner: this.#runner }) as Promise<R>;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** The real `CodecService` over an {@link InProcessPool}, configured like `createCoreWiring` does. */
export function realCodec(c: CoreServiceContext): WiredCodec {
  return new CodecService({
    pool: new InProcessPool(),
    tmpDir: tmpRoot(c.config.dataDir),
    libreoffice: c.config.libreoffice,
    maxFileBytes: c.config.limits.maxFileBytes,
    logger: c.logger,
  });
}
