/**
 * The size-change hook for node views (LLD §0 S-7).
 *
 * Image node views watch their own box with a `ResizeObserver` (an image that loads late
 * changes height), and report it here. The pagination plugin (V1-34) subscribes and
 * invalidates the cached height of the top-level block that contains `pos`.
 *
 * @module
 */
import type { Node as PMNode } from 'prosemirror-model';

/** One size change reported by a node view. */
export interface BlockResizeEvent {
  /** The node whose view changed size. */
  readonly node: PMNode;
  /** The node's document position, or undefined when the view is no longer in the document. */
  readonly pos: number | undefined;
  /** The node view's outer DOM element. */
  readonly dom: HTMLElement;
}

/** A tiny synchronous emitter of {@link BlockResizeEvent}s. One per editor. */
export class BlockResizeSignal {
  readonly #listeners = new Set<(e: BlockResizeEvent) => void>();

  /** Adds a listener. Returns the function that removes it. */
  subscribe(fn: (e: BlockResizeEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  /** Calls every listener with `e`. A throwing listener does not stop the others. */
  emit(e: BlockResizeEvent): void {
    for (const fn of [...this.#listeners]) {
      try {
        fn(e);
      } catch {
        // A listener's fault must not break the node view that reported the change.
      }
    }
  }
}
