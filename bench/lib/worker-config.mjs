// Worker config module of the benchmark (worker mode forks the Core with `ODX_BENCH`; main mode
// passes the same object in directly).
import { LocalFsStorage } from '../../backend/dist/storage/local-fs-storage.js';

const s = JSON.parse(process.env.ODX_BENCH ?? '{}');
export default { dataDir: s.dataDir, storage: new LocalFsStorage({ root: s.storageRoot }), ...s.config };
