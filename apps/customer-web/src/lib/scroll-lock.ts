/**
 * Hold the page still while a modal is open.
 *
 * `overflow: hidden` on the root is not enough: a wheel that starts on a modal
 * dialog's backdrop still scrolls the page in Chromium, and iOS Safari ignores
 * it for touch scrolling. Pinning the body where it stands - `position:
 * fixed` at minus the current scroll offset - leaves nothing to scroll, looks
 * identical, and on release the page is put back exactly where the reader
 * left it.
 *
 * Counted, so a dialog opened over another dialog does not release the page
 * when the inner one closes.
 */
let holders = 0;
let saved: { y: number; style: string | null } = { y: 0, style: null };

export function lockPageScroll(): () => void {
  if (holders === 0) {
    const y = window.scrollY;
    saved = { y, style: document.body.getAttribute('style') };
    Object.assign(document.body.style, {
      position: 'fixed',
      top: `-${String(y)}px`,
      left: '0',
      right: '0',
      width: '100%',
    });
  }
  holders += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders > 0) return;
    if (saved.style === null) document.body.removeAttribute('style');
    else document.body.setAttribute('style', saved.style);
    window.scrollTo({ top: saved.y, behavior: 'instant' });
  };
}
