// Registers one scenario list for one mode: each scenario gets a fresh `Rig`, runs, and the rig
// is disposed (clients, engine, server, folders) even when the scenario fails.
import { afterEach, describe, it } from 'vitest';
import { haveDist, Rig, type Mode, type RigOptions } from './rig.js';

/** One end-to-end scenario, written once and run in both modes. */
export interface Scenario {
  name: string;
  /** Runs in this mode only (a Supervisor-only behaviour, for example). */
  only?: Mode;
  /** Rig settings for this scenario. */
  rig?: RigOptions;
  /** Test timeout in ms. Default 120 000 (fake codec) or 360 000 (real LibreOffice). */
  timeoutMs?: number;
  run(rig: Rig): Promise<void>;
}

/**
 * Defines the scenarios of `mode` inside a `describe`. Worker mode needs the compiled Core
 * (`npm run build`) and is skipped without it.
 */
export function registerScenarios(mode: Mode, scenarios: readonly Scenario[], o: { title: string; codec: 'fake' | 'lo' }): void {
  describe.skipIf(mode === 'worker' && !haveDist)(`${o.title} (${mode} mode)`, () => {
    let rig: Rig | undefined;
    afterEach(async () => {
      const r = rig;
      rig = undefined;
      await r?.dispose();
    }, 180_000);
    for (const s of scenarios) {
      if (s.only !== undefined && s.only !== mode) continue;
      it(
        s.name,
        async () => {
          rig = await Rig.create(mode, { codec: o.codec, ...s.rig });
          await s.run(rig);
        },
        s.timeoutMs ?? (o.codec === 'lo' ? 360_000 : 120_000),
      );
    }
  });
}
