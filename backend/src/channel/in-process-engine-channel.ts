/**
 * The in-process transport of the EngineChannel, used in `mode: 'main'` (LLD Part 2 §6.5).
 *
 * Each direction has one delivery queue. Posting pushes onto it and a single `setImmediate`
 * drains it, so delivery is asynchronous, FIFO and never re-entrant, as with IPC. Messages are
 * not cloned (LLD choice): both sides treat them as read-only, and byte arrays are never reused
 * after posting.
 *
 * @module
 */
import type { OpenDocexError } from '@open-docex/shared/errors';
import { engineError } from '../errors/engine-error.js';
import { CoreSideBase, MainChannelBase, type ChannelOptions, type CoreChannelSide } from './engine-channel.js';
import type { CoreEvent, CoreRequest } from './messages.js';

/** One direction's FIFO queue, drained by a single `setImmediate`. */
class DeliveryQueue<T> {
  readonly #items: T[] = [];
  #scheduled = false;
  #deliver: (item: T) => void = () => {};

  setTarget(deliver: (item: T) => void): void {
    this.#deliver = deliver;
  }

  push(item: T): void {
    this.#items.push(item);
    if (this.#scheduled) return;
    this.#scheduled = true;
    setImmediate(() => this.#drain());
  }

  clear(): void {
    this.#items.length = 0;
  }

  #drain(): void {
    this.#scheduled = false;
    // Items pushed while draining wait for the next turn, as they would over IPC.
    const batch = this.#items.splice(0);
    for (const item of batch) this.#deliver(item);
  }
}

class InProcessCoreSide extends CoreSideBase {
  readonly #out: DeliveryQueue<CoreEvent>;

  constructor(out: DeliveryQueue<CoreEvent>, inbound: DeliveryQueue<CoreRequest>) {
    super();
    this.#out = out;
    inbound.setTarget((m) => this.receive(m));
  }

  whenWritable(): Promise<void> {
    return Promise.resolve();
  }

  protected transmit(ev: CoreEvent): void {
    this.#out.push(ev);
  }
}

/** The main side of an in-process channel. Create both ends with {@link InProcessEngineChannel.pair}. */
export class InProcessEngineChannel extends MainChannelBase {
  readonly #out: DeliveryQueue<CoreRequest>;
  readonly #in: DeliveryQueue<CoreEvent>;
  #closed = false;

  private constructor(out: DeliveryQueue<CoreRequest>, inbound: DeliveryQueue<CoreEvent>, o: ChannelOptions) {
    super(o);
    this.#out = out;
    this.#in = inbound;
    inbound.setTarget((ev) => {
      if (!this.#closed) this.receive(ev);
    });
  }

  /** Returns the main end and the Core end of a new channel. */
  static pair(o: ChannelOptions = {}): [InProcessEngineChannel, CoreChannelSide] {
    const toCore = new DeliveryQueue<CoreRequest>();
    const toMain = new DeliveryQueue<CoreEvent>();
    const main = new InProcessEngineChannel(toCore, toMain, o);
    const core = new InProcessCoreSide(toMain, toCore);
    return [main, core];
  }

  /**
   * Stops delivery in both directions and rejects every pending request and call with `reason`.
   * The in-process counterpart of `IpcEngineChannel.unbind`, for engine shutdown (LLD choice).
   */
  close(reason: OpenDocexError): void {
    this.#closed = true;
    this.#out.clear();
    this.#in.clear();
    this.rejectAll(reason);
  }

  protected transmit(msg: CoreRequest): void {
    if (this.#closed) throw this.unavailable();
    this.#out.push(msg);
  }

  protected unavailable(): OpenDocexError {
    return engineError('ENGINE_UNAVAILABLE');
  }
}
