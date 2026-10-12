/**
 * `ResizeObserver`, which jsdom does not implement.
 *
 * Every scrolling pane is a Radix ScrollArea (components/ui/scroll-area.tsx),
 * and it measures its viewport to size the drawn bar. Without a stub, mounting
 * anything with a dialog or a table throws `ResizeObserver is not defined`.
 * A no-op on purpose: jsdom has no layout, so there is nothing to observe.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {
      /* jsdom has no layout to report */
    }
    unobserve(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
  };
}

export {};
