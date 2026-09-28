/**
 * Which pages the storefront shell draws full-bleed: the signed-out screens
 * whose `AuthSplit` needs the whole width and, from `lg` up, a frame pinned to
 * the window so its form column - and only its form column - scrolls.
 *
 * Decided here, from the path and the session, because the shell is what draws
 * the frame. It has to be right in both directions:
 *
 *   - **A split page left out** gets a padded, content-height frame. The split
 *     caps itself at one window height, its form column never becomes the
 *     scroller, the form spills out of its box and the footer paints under it
 *     while the whole document scrolls - "the page underneath shows through".
 *     That was `/register/company`.
 *   - **An ordinary page put in** gets a window-height frame with the overflow
 *     clipped, and everything below the fold is cut off. That is why
 *     `/register/company` is only full-bleed while signed out: signed in, it is
 *     an ordinary page.
 */
import { CHECK_EMAIL_PATH } from '@/lib/sign-up';

const ALWAYS_FULL_BLEED: ReadonlySet<string> = new Set(['/login', '/register', CHECK_EMAIL_PATH]);

/** Split while signed out, an ordinary page while signed in. */
export const COMPANY_SIGN_UP_PATH = '/register/company';

export function isFullBleedPath(pathname: string, isCustomer: boolean): boolean {
  return ALWAYS_FULL_BLEED.has(pathname) || (pathname === COMPANY_SIGN_UP_PATH && !isCustomer);
}
