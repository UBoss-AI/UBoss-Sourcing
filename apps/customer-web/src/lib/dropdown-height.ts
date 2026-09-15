/**
 * Keeps a header dropdown inside the window it is drawn in.
 *
 * A panel anchored under a header trigger is positioned `top: 100%` of that
 * trigger, so how much room it actually has is the window height minus wherever
 * the trigger ends — a number CSS cannot see. Both menus in this header used to
 * carry a flat cap instead (`max-h-[34rem]`, `max-h-[32rem]`), which is right on
 * a tall window and wrong on a short one: the panel simply ran off the bottom of
 * the screen.
 *
 * That is not a cosmetic overflow. Both panels are a scrolling list with
 * something pinned under it — the account menu pins **Sign out** there — and
 * when the panel is taller than the window, the pinned row is below the fold
 * with no way to reach it. The inner list still scrolls, so the menu looks
 * healthy while scrolling it changes nothing: it is scrolling a box whose own
 * bottom edge is off-screen. On a 529px-tall window there was no way to sign out
 * of the storefront at all.
 *
 * So the space is measured and published as `--dropdown-max-h`, which the panel's
 * class reads at the breakpoint where it becomes a dropdown:
 *
 * ```
 * sm:max-h-[min(34rem,var(--dropdown-max-h,34rem))]
 * ```
 *
 * Two things follow from writing a custom property rather than `style.maxHeight`.
 * The flat cap stays in the class, where it is read with the rest of the panel's
 * shape, and `min()` keeps whichever is smaller. And the phone layout — a sheet
 * pinned to the bottom at `max-h-[85vh]` — is untouched, because nothing outside
 * the `sm:` rule mentions the variable. The fallback in `var()` means a panel
 * rendered before the first measurement is capped, never unbounded.
 *
 * Re-measured on resize and on scroll: the header is sticky in this storefront,
 * but a trigger in a header that scrolls away would otherwise keep a stale
 * number, and the listener costs one `getBoundingClientRect` per frame only
 * while a menu is actually open.
 */
import { useLayoutEffect, useRef } from 'react';

/** Breathing room under the panel, so it never sits flush on the window edge. */
const GAP_PX = 12;

/**
 * The least we will ever cap it to.
 *
 * Below roughly this the panel stops being a menu and becomes a slot, and a
 * window that short has bigger problems than this dropdown. Keeping a floor
 * means a freak measurement can never collapse the panel to nothing, which
 * would hide the very row this hook exists to keep reachable.
 */
const FLOOR_PX = 160;

export function useDropdownMaxHeight<T extends HTMLElement>(
  isOpen: boolean,
): React.RefObject<T | null> {
  const ref = useRef<T | null>(null);

  useLayoutEffect(() => {
    if (!isOpen) return undefined;

    const element = ref.current;
    if (element === null) return undefined;

    const measure = (): void => {
      const { top } = element.getBoundingClientRect();
      const available = window.innerHeight - top - GAP_PX;
      element.style.setProperty('--dropdown-max-h', `${Math.max(available, FLOOR_PX)}px`);
    };

    measure();

    window.addEventListener('resize', measure, { passive: true });
    window.addEventListener('scroll', measure, { passive: true, capture: true });

    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, { capture: true });
      element.style.removeProperty('--dropdown-max-h');
    };
  }, [isOpen]);

  return ref;
}
