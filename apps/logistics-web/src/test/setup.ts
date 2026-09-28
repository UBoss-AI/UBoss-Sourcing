/**
 * `<dialog>` support, which jsdom does not implement.
 *
 * Needed from the moment a test opened a native dialog: the terms dialog on
 * the activation page (`components/legal/`). `showModal()` and `close()` are
 * simply absent in jsdom, so a component built on a dialog throws on mount.
 *
 * The storefront's shim, and deliberately as small: it toggles `open` and
 * fires `close`. It does not emulate the top layer, inertness of the page or
 * Escape - Escape is tested by firing the dialog's own `cancel` event, and
 * focus trapping is checked in a real browser.
 */
if (typeof HTMLDialogElement !== 'undefined') {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & {
    showModal?: () => void;
    close?: (returnValue?: string) => void;
  };

  if (typeof proto.showModal !== 'function') {
    proto.showModal = function showModal(this: HTMLDialogElement): void {
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
