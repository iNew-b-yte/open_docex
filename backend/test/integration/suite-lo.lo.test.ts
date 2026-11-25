// The integration suite (V1-20) with real LibreOffice, in both modes. Run with
// OPEN_DOCEX_LO_TESTS=1 (CI sets it); worker mode also needs `npm run build`. Main mode runs the
// codec in this process (`InProcessPool`); worker mode runs the compiled Core with its own
// codec worker threads.
import { describe } from 'vitest';
import { registerScenarios } from './suite/register.js';
import { loScenarios } from './suite/scenarios/lo.js';

describe.skipIf(process.env['OPEN_DOCEX_LO_TESTS'] !== '1')('engine integration suite with real LibreOffice', () => {
  registerScenarios('main', loScenarios, { title: 'real LibreOffice', codec: 'lo' });
  registerScenarios('worker', loScenarios, { title: 'real LibreOffice', codec: 'lo' });
});
