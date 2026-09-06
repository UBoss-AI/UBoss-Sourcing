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
