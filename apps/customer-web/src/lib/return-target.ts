/**
 * Where somebody goes after signing in. Shared by the sign-in page and the
 * company selector, which both finish a sign-in.
 */
interface LocationState {
  from?: string;
}

/**
 * Where to go once they are in.
 *
 * Two spellings reach this page and both are in use:
 *
 *   - router state (`state.from`), set by `RequireCustomer`, the service
 *     banner, the product page and AI Mode's sign-in panel;
 *   - `?next=`, in the Seller Hub's plain links, which are `<a href>`s with
 *     nowhere to hang router state.
 *
 * The second was being ignored, so pressing "Sign in" on the Sell page landed
 * somebody on the home page having forgotten what they came for.
 *
 * **Same-origin paths only.** An open redirect is a phishing primitive: a link
 * to our own sign-in page that hands the visitor to somebody else's site
 * afterwards borrows this shop's credibility for it. Anything that is not a
 * single leading slash - `//evil.example`, `https://…`, a backslash Windows
 * clients normalise into a slash - is discarded rather than corrected.
 */
export function returnTarget(state: unknown, search: string): string {
  const candidate =
    (state as LocationState | null)?.from ?? new URLSearchParams(search).get('next') ?? null;

  // Both kinds of buyer land on the one home page, `/`. `/home` is only a
  // redirect to it now, and is never a destination.
  if (candidate === null) return HOME;

  // One leading slash, and the next character must not be another slash or a
  // backslash: `//evil.example` is a protocol-relative URL, and `/\evil.example`
  // is the same thing after a browser normalises the backslash.
  if (!/^\/(?![/\\])/.test(candidate)) return HOME;

  return candidate;
}

export const HOME = '/';
