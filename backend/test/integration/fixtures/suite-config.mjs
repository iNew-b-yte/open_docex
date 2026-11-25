// The worker config module of the integration suite (worker mode). The forked Core imports it;
// `ODX_SUITE` carries the folders and overrides as JSON (see `suite-env.mjs`).
import { LocalFsStorage } from '../../../dist/storage/local-fs-storage.js';
import { buildWorkerConfig } from './suite-env.mjs';

export default buildWorkerConfig({ LocalFsStorage, settings: JSON.parse(process.env.ODX_SUITE) });
