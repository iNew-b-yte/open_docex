/**
 * The child-process IPC transport of the EngineChannel (LLD Part 2 §6.1, §6.4). The child is
 * forked with `serialization: 'advanced'`.
 *
 * @module
 */
import type { ChildProcess } from 'node:child_process';
import type { OpenDocexError } from '@open-docex/shared/errors';
import { engineError } from '../errors/engine-error.js';
import { CoreSideBase, MainChannelBase, type ChannelOptions } from './engine-channel.js';
import type { CoreEvent, CoreRequest } from './messages.js';

function isMessage(m: unknown): m is { type: string } {
  return typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The main side over a forked child. {@link IpcEngineChannel.bind} attaches it to a new child
 * after each (re)start; {@link IpcEngineChannel.unbind} detaches it when the child is gone.
 */
export class IpcEngineChannel extends MainChannelBase {
  #child: ChildProcess | undefined;
  readonly #onMessage = (m: unknown): void => {
    if (isMessage(m)) this.receive(m as CoreEvent);
    else this.logger.warn('Dropped a malformed message from the Core.');
  };

  constructor(o: ChannelOptions = {}) {
    super(o);
  }

  /** True while bound to a child. */
  get bound(): boolean {
    return this.#child !== undefined;
  }

  /** Attaches the channel to `child`. A previous child is detached first, without rejecting anything. */
  bind(child: ChildProcess): void {
    this.#detach();
    this.#child = child;
    child.on('message', this.#onMessage);
  }

  /**
   * Detaches from the current child and rejects every pending request and call with `reason`
   * (`ENGINE_RESTARTING` when the child is gone; LLD Part 2 §6.3).
   */
  unbind(reason: OpenDocexError): void {
    this.#detach();
    this.rejectAll(reason);
  }

  protected transmit(msg: CoreRequest): void {
    const child = this.#child;
    if (child === undefined || !child.connected) throw this.unavailable();
    child.send(msg, (err) => {
      if (err) this.logger.warn('Sending to the Core failed: ' + errText(err));
    });
  }

  protected unavailable(): OpenDocexError {
    return engineError('ENGINE_RESTARTING');
  }

  #detach(): void {
    this.#child?.off('message', this.#onMessage);
    this.#child = undefined;
  }
}

/** The Core-side view of the IPC port (`process` in the child), reduced to what the channel uses. */
export interface CorePort {
  /** Sends one message; `callback` runs once it has been handed to the OS (or failed). */
  send(message: CoreEvent, callback: (error: Error | null) => void): boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
}

/** `inFlight` at or above which {@link IpcCoreChannelSide.whenWritable} waits (LLD choice, §6.4). */
export const IPC_HIGH_WATER = 1024;
/** `inFlight` below which a waiting {@link IpcCoreChannelSide.whenWritable} resolves (LLD choice, §6.4). */
export const IPC_LOW_WATER = 512;

/**
 * The Core side over IPC, with the flow control of LLD Part 2 §6.4: `inFlight` counts messages
 * whose send callback has not fired yet. Once it reaches {@link IPC_HIGH_WATER}, `whenWritable()`
 * waits until callbacks bring it back below {@link IPC_LOW_WATER}.
 */
export class IpcCoreChannelSide extends CoreSideBase {
  readonly #port: CorePort;
  readonly #onSendError: (err: Error) => void;
  #inFlight = 0;
  #paused = false;
  #waiters: (() => void)[] = [];

  /**
   * @param port the IPC port; in the Core use {@link IpcCoreChannelSide.fromProcess}.
   * @param onSendError called when a send fails (for example after the parent died).
   */
  constructor(port: CorePort, onSendError: (err: Error) => void = () => {}) {
    super();
    this.#port = port;
    this.#onSendError = onSendError;
    port.on('message', (m) => {
      if (isMessage(m)) this.receive(m as CoreRequest);
    });
  }

  /** The Core side over this process's IPC channel. Throws when the process has none. */
  static fromProcess(onSendError?: (err: Error) => void): IpcCoreChannelSide {
    const send = process.send?.bind(process);
    if (send === undefined) throw engineError('CONFIG_INVALID', { message: 'The Core was started without an IPC channel.' });
    const port: CorePort = {
      send: (message, callback) => send(message, undefined, undefined, callback),
      on: (event, listener) => process.on(event, listener),
    };
    return new IpcCoreChannelSide(port, onSendError);
  }

  /** Messages sent whose callback has not fired yet. */
  get inFlight(): number {
    return this.#inFlight;
  }

  whenWritable(): Promise<void> {
    if (!this.#paused) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  protected transmit(ev: CoreEvent): void {
    this.#inFlight++;
    if (this.#inFlight >= IPC_HIGH_WATER) this.#paused = true;
    let settled = false;
    const done = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      this.#inFlight--;
      if (err) this.#onSendError(err);
      if (this.#paused && this.#inFlight < IPC_LOW_WATER) {
        this.#paused = false;
        const waiters = this.#waiters;
        this.#waiters = [];
        for (const w of waiters) w();
      }
    };
    try {
      this.#port.send(ev, done);
    } catch (err) {
      done(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
