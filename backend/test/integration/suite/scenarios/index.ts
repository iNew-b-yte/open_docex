// The one scenario list of the integration suite (V1-20). `suite-main.test.ts` and
// `suite-worker.test.ts` register it for each mode; `suite-lo.lo.test.ts` has its own list for
// real LibreOffice.
import type { Scenario } from '../register.js';
import { auditScenarios } from './audit.js';
import { crashScenarios } from './crash.js';
import { editScenarios } from './edit.js';
import { openScenarios } from './open.js';
import { storageScenarios } from './storage.js';

export const SCENARIOS: readonly Scenario[] = [
  ...openScenarios,
  ...editScenarios,
  ...storageScenarios,
  ...crashScenarios,
  ...auditScenarios,
];
