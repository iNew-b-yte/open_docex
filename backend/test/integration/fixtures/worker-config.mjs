// The worker config module of the worker-mode smoke tests: `export default` a plain config with
// the real `LocalFsStorage` from the compiled build. The folders come from the environment so
// each test run has its own (the forked Core inherits the environment).
import { LocalFsStorage } from '../../../dist/storage/local-fs-storage.js';

export default {
  dataDir: process.env.ODX_SMOKE_DATA_DIR,
  storage: new LocalFsStorage({ root: process.env.ODX_SMOKE_STORAGE_ROOT }),
  flush: { quietMs: 1000, maxIntervalMs: 300000 },
};
