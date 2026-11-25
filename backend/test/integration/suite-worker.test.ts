// The integration suite (V1-20) in `mode: 'worker'`: the Core is a forked process running the
// compiled build (`npm run build` first; skipped without `backend/dist`), with the fake text codec.
// The scenarios are shared with main mode (`suite-main.test.ts`).
import { registerScenarios } from './suite/register.js';
import { SCENARIOS } from './suite/scenarios/index.js';

registerScenarios('worker', SCENARIOS, { title: 'engine integration suite', codec: 'fake' });
