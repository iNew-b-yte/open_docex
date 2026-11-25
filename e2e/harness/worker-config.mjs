// The worker config module of the harness: the settings arrive as JSON in `ODX_E2E` (worker mode
// forks the Core with that variable; main mode passes the same object in directly).
import { LocalFsStorage } from '../../backend/dist/storage/local-fs-storage.js';

const s = JSON.parse(process.env.ODX_E2E ?? '{}');
export default { dataDir: s.dataDir, storage: new LocalFsStorage({ root: s.storageRoot }), ...s.config };
