// The integration suite (V1-20) in `mode: 'main'`: the Core runs in this process, with the fake
// text codec. The scenarios are shared with worker mode (`suite-worker.test.ts`).
import { registerScenarios } from './suite/register.js';
import { SCENARIOS } from './suite/scenarios/index.js';

registerScenarios('main', SCENARIOS, { title: 'engine integration suite', codec: 'fake' });
