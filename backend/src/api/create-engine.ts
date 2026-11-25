/**
 * `createEngine` (LLD Part 2 §2.5): validates the options, boots the Core in a child process
 * (`mode: 'worker'`) or in this process (`mode: 'main'`), then binds the Gateway.
 *
 * Main-process rule (N4): in worker mode nothing from the Core's module graph (ProseMirror, the
 * codec, persistence) is loaded here. Main mode imports the Core on demand.
 *
 * @module
 */
import { InProcessEngineChannel } from '../channel/in-process-engine-channel.js';
import type { EngineChannel } from '../channel/engine-channel.js';
import type { CoreWiringOptions } from '../core/core-entry.js';
import { engineError } from '../errors/engine-error.js';
import { routeCoreEvents } from '../gateway/core-events.js';
import { Gateway } from '../gateway/gateway.js';
import { levelFilter } from '../log/logger.js';
import { realClock, Supervisor, type SupervisorDeps } from '../supervisor/supervisor.js';
import type { EngineEventMap } from './events.js';
import { AuditRelay, EngineFacade, type Engine } from './engine-facade.js';
import type { EngineOptions } from './options.js';
import { TypedEmitter } from './typed-emitter.js';
import { validateEngineOptions } from './validate-options.js';

/**
 * Test seams. Not part of the public API (`index.ts` does not export them): fakes for the codec
 * in main mode, and a fake fork for the Supervisor.
 */
export interface EngineInternals {
  /** Main mode: overrides for the Core wiring, for example a fake codec. */
  core?: CoreWiringOptions;
  /** Worker mode: overrides for the Supervisor (`fork`, `coreEntryPath`). */
  supervisor?: SupervisorDeps;
}

/**
 * Starts an engine.
 *
 * - **Worker mode** forks the Core and rejects with the Core's boot error, rebuilt from its
 *   `WireError`, when boot fails.
 * - **Main mode** runs the Core in this process.
 *
 * No `upgrade` listener is attached before boot succeeds. With `http.server`, the Gateway is
 * attached to it; otherwise call `engine.attach(server)`.
 *
 * @throws {OpenDocexError} `CONFIG_INVALID` for bad options, or the Core's boot error
 *   (`CONFIG_LIBREOFFICE_NOT_FOUND`, `CONFIG_DATA_DIR_UNWRITABLE`, ...).
 */
export function createEngine(options: EngineOptions): Promise<Engine> {
  return createEngineWith(options, {});
}

/** {@link createEngine} with test seams. */
export async function createEngineWith(options: EngineOptions, internals: EngineInternals): Promise<Engine> {
  const opts = validateEngineOptions(options);
  const logger = levelFilter(opts.logger, opts.logLevel);
  const emitter = new TypedEmitter<EngineEventMap>(logger);
  const relay = new AuditRelay(emitter, logger);
  const gateway = new Gateway(opts, emitter, logger, realClock);

  let channel: EngineChannel;
  let supervisor: Supervisor | undefined;
  let inProcess: InProcessEngineChannel | undefined;
  try {
    if (opts.mode === 'worker') {
      supervisor = new Supervisor(opts, gateway, emitter, logger, realClock, internals.supervisor);
      channel = supervisor.channel;
      // Registered before boot: the Core logs, and replays audit events, while it boots.
      routeCoreEvents(channel, emitter, logger, relay.sink);
      await supervisor.start();
    } else {
      const { createCoreWiring } = await import('../core/core-entry.js');
      const { CoreRuntime } = await import('../core/core-runtime.js');
      const [mainSide, coreSide] = InProcessEngineChannel.pair({ logger });
      inProcess = mainSide;
      channel = mainSide;
      routeCoreEvents(channel, emitter, logger, relay.sink);
      const wiring = createCoreWiring(internals.core);
      const runtime = new CoreRuntime(wiring.wrap(coreSide), { services: wiring.services });
      await runtime.boot({ workerConfigModule: opts.workerConfigModule, logLevel: opts.logLevel });
    }
  } catch (err) {
    // `CoreRuntime.boot` released its own resources; the channel and Gateway are ours.
    inProcess?.close(engineError('ENGINE_UNAVAILABLE', { message: 'The engine failed to start.' }));
    gateway.detach();
    throw err;
  }

  const facade = new EngineFacade({
    opts,
    gateway,
    channel,
    emitter,
    logger,
    relay,
    ...(supervisor !== undefined ? { supervisor } : {}),
    ...(inProcess !== undefined ? { inProcess } : {}),
  });
  const sup = supervisor;
  gateway.bind(channel, () => facade.state, () => sup?.nextBackoffMs ?? 0);
  if (opts.http.server !== undefined) gateway.attach(opts.http.server);
  return facade;
}
