/**
 * A page-level action bar pinned to the bottom of a narrow screen.
 *
 * The cart's Checkout button is the case this exists for. On a phone the cart
 * is a screen and a half long, so the call to action is pinned to the bottom
 * rather than left at the end of the list.
 *
 * The bar publishes its own height as `--page-bottom-bar` on the root element,
 * so anything else pinned to the bottom edge can offset itself by it instead
 * of being taught about the cart. The variable defaults to `0px` in index.css,
 * so a page with no bar needs to say nothing.
 *
 * That mechanism was written for a collision that no longer happens: the chat
 * launcher used to be pinned bottom-right on every page, 56px across, and it
 * sat exactly over the Checkout button — the one control the page existed to
 * offer was the one you could not press. The widget is gone (AI Mode is a page
 * now) and nothing currently reads the variable. It is kept because the next
 * bottom-pinned element will need it and because publishing a height costs a
 * `ResizeObserver` on one screen; delete it if that stops being true.
 *
 * The height is measured rather than declared: it depends on how the contents
 * wrap, which depends on the translation, and a hard-coded 4rem is a number
 * that is wrong in Greek.
 */
import { useEffect, useRef } from 'react';
import { cx } from '@/lib/cx';

/** The custom property every bottom-pinned element in the app reads. */
export const BOTTOM_BAR_VAR = '--page-bottom-bar';

export function StickyBottomBar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bar = barRef.current;
    if (bar === null) return undefined;

    const root = document.documentElement;

    const publish = (): void => {
      // `offsetHeight` is 0 while the bar is hidden by `lg:hidden`, which is
      // exactly right: on a desktop there is no bar to clear.
      root.style.setProperty(BOTTOM_BAR_VAR, `${bar.offsetHeight}px`);
    };

    publish();

    // The height changes when the viewport does — a phone turned sideways
    // crosses the `lg` breakpoint on a tablet, and a long label rewraps.
    const observer = new ResizeObserver(publish);
    observer.observe(bar);

    return () => {
      observer.disconnect();
      root.style.removeProperty(BOTTOM_BAR_VAR);
    };
  }, []);

  return (
    <div
      ref={barRef}
      className={cx(
        'fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 px-4 py-3',
        'shadow-overlay backdrop-blur lg:hidden',
        className,
      )}
      // The home indicator on a notched phone sits in the bottom few pixels.
      // Without `viewport-fit=cover` this resolves to 0 and costs nothing; it
      // is here so the bar stays correct if that ever changes.
      style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}
    >
      <div className="mx-auto flex max-w-content items-center gap-3">{children}</div>
    </div>
  );
}
