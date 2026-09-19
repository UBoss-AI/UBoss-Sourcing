import '@testing-library/jest-dom/vitest';

/**
 * `<dialog>` support, which jsdom does not implement.
 *
 * `showModal()` and `close()` are simply absent, so every component built on a
 * native dialog throws on mount and cannot be tested at all — including the
 * accessibility assertions, which is the case that matters: a dialog is one of
 * the few controls where getting the semantics wrong locks a screen-reader
 * user out entirely, and it would be the one thing the suite could not check.
 *
 * Deliberately the smallest thing that works. It toggles `open` and fires
 * `close`, which is what the components observe. It does NOT emulate the top
 * layer, the backdrop, inertness of the rest of the page, or Escape handling —
 * so a test here can assert that a dialog is labelled and that its contents
 * are sound, and cannot assert that focus is trapped. That distinction is
 * recorded in docs/ACCESSIBILITY.md rather than papered over: focus trapping
 * is verified by a person in a real browser.
 */
if (typeof HTMLDialogElement !== 'undefined') {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & {
    showModal?: () => void;
    show?: () => void;
    close?: (returnValue?: string) => void;
  };

  if (typeof proto.showModal !== 'function') {
    proto.showModal = function showModal(this: HTMLDialogElement): void {
      this.open = true;
    };
  }

  if (typeof proto.show !== 'function') {
    proto.show = function show(this: HTMLDialogElement): void {
      this.open = true;
    };
  }

  if (typeof proto.close !== 'function') {
    proto.close = function close(this: HTMLDialogElement, returnValue?: string): void {
      this.open = false;
      if (returnValue !== undefined) this.returnValue = returnValue;
      this.dispatchEvent(new Event('close'));
    };
  }
}

/**
 * `ResizeObserver`, which jsdom does not implement either.
 *
 * `StickyBottomBar` measures itself and publishes its height as a custom
 * property so the chat launcher can sit above it, and it re-measures when the
 * box changes. Without a stub, mounting anything that renders the cart's
 * bottom bar throws `ResizeObserver is not defined` and takes the whole file
 * down with it.
 *
 * A no-op, on purpose, and not a polyfill: jsdom has no layout, so every box
 * it reports is 0x0 and a working observer would have nothing to observe. What
 * a test can assert is that the bar renders and that its contents are sound;
 * that the offset tracks a real height is a browser fact, checked in one.
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

/**
 * A 2D canvas context, which jsdom also does not implement.
 *
 * `getContext` is present but refuses, and it refuses loudly: every call
 * writes a `Not implemented: HTMLCanvasElement.prototype.getContext` page onto
 * the test output. The AI composer paints its message onto a canvas to blow it
 * away on send, so without this every AI Mode test that sends a message prints
 * that page, and a real failure has to be found among them.
 *
 * Returning `null` is the honest answer rather than a silencer: it is exactly
 * what a browser returns for a context type it cannot give, and it is the
 * answer `ui/vanish.ts` is written to handle — no picture, no particles, and
 * the send carries on. `vanish.test.tsx` holds that path down.
 */
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = function getContext(): null {
    return null;
  };
}

/**
 * `scrollIntoView`, which jsdom does not implement either.
 *
 * Not a stub for convenience: the method is simply absent from
 * `Element.prototype`, so calling it is a `TypeError` rather than a no-op, and
 * a component that scrolls something into view takes down whatever test
 * touched it. The department rail closes its panel by scrolling the card that
 * opened it back under the cursor — see `ui/apple-cards-carousel.tsx` — and
 * that ran inside an animation callback, where the throw arrived as an
 * unhandled rejection attributed to whichever test happened to be running.
 *
 * A no-op, like the `ResizeObserver` above and for the same reason: jsdom has
 * no layout, so there is no viewport for anything to be scrolled into. A test
 * that cares whether something scrolled replaces this with its own spy, which
 * is what `pages/home-products.test.tsx` does.
 */
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    // Nothing to scroll.
  };
}
