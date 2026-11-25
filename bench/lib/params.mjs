// Parameters of every stage, in full and quick mode. Quick mode is a CI smoke: tiny sizes, the
// numbers mean nothing.
export const STAGES = ['latency', 'capacity', 'fanout', 'lo', 'typing'];
/** Stages that run once per engine mode. */
export const PER_MODE = new Set(['latency', 'capacity', 'fanout']);

export function params(quick) {
  return quick
    ? {
        rate: 2, warmMs: 1500, measureMs: 3000,
        oneDocClients: [1, 10], manyDocs: [10],
        stages: [100, 200], capMeasureMs: 3000, limitMs: 100,
        fanout: [0, 10], opsPerSec: 20,
        pages: [10], loConcurrency: [1, 2], loRepeats: 1,
        keystrokes: 60, typingPages: 20,
      }
    : {
        rate: 2, warmMs: 5000, measureMs: 20_000,
        oneDocClients: [1, 10, 50, 100], manyDocs: [10, 100, 500],
        // The ramp stops at the first saturation point (see `capacityBench`) or after the last step.
        stages: [250, 500, 1000, 2000, 3000, 4000, 6000, 8000], capMeasureMs: 10_000, limitMs: 100,
        fanout: [0, 10, 100, 500, 1000, 2000], opsPerSec: 20,
        pages: [10, 100, 300], loConcurrency: [1, 2], loRepeats: 2,
        keystrokes: 400, typingPages: 300,
      };
}
