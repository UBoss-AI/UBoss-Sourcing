/**
 * The brand block, at the top of the rail.
 *
 * Two lines rather than one: the mark and the product name are the thing you
 * look at once, and `The Way to the World` underneath is the product's
 * tagline. Both come from `lib/brand.ts`, which is the one place either
 * string is written in any of the three applications. Both are set in
 * `font-brand` (Dancing Script Bold) — the wordmark's own face, used for the
 * name and its tagline and nothing else — so they read as one mark rather than
 * as more Inter labels on the rail. A step larger than the label it replaced, because a script's short
 * x-height reads a size smaller than Inter at the same number. `Powered by UBOSS` is not here: it is the small print on the sign-in
 * screens, as it is in the storefront's footer. The whole block
 * is a link home, since a logo that is not clickable is the single most
 * reliably-attempted dead control in any admin panel.
 *
 * The second line used to say "Admin console", which is what told someone with
 * two tabs open which one they were in. The browser tab does that now — it
 * says "Glovia Admin", which is a thing a person reads when they are looking
 * at two tabs, whereas a rail is a thing they read once they have already
 * picked one. See `lib/brand.ts`.
 *
 * The mark is the earth the storefront's own header carries, at 28px. It was a
 * "U" on a blue plate, which meant the product had two marks depending on
 * which of its applications you were in; the letter is still underneath, and
 * is still what a browser with no WebGL and a member of staff who asked for no
 * motion get. See `components/EarthMark.tsx`.
 *
 * At sixty pixels the two lines are gone and the mark is the whole of it —
 * which is the one part of the rail that still says which product this is. The
 * link's accessible name carries both lines whatever the rail's width, so a
 * collapsed rail is not an unnamed link, and the two visible lines are
 * `aria-hidden` so that name is not then read twice.
 *
 * In its own file rather than inside `AppShell`, so that what the console
 * calls itself can be asserted without standing up the whole shell — see
 * `layout/brand.test.tsx`.
 */
import { Link } from 'react-router-dom';
import { SidebarLabel } from '@/components/ui/sidebar';
import { EarthMark } from '@/components/EarthMark';
import { PRODUCT_BRAND, PRODUCT_INITIAL, PRODUCT_TAGLINE } from '@/lib/brand';

export function BrandLockup({
  onNavigate,
}: {
  onNavigate?: (() => void) | undefined;
}): React.JSX.Element {
  return (
    <Link
      to="/"
      onClick={onNavigate}
      aria-label={`${PRODUCT_BRAND} — ${PRODUCT_TAGLINE}`}
      className="relative z-20 flex h-10 shrink-0 items-center gap-3 rounded-md px-2 transition-opacity hover:opacity-90"
    >
      <EarthMark initial={PRODUCT_INITIAL} size="sm" />
      <SidebarLabel display="block" className="min-w-0 leading-tight">
        <span aria-hidden="true" className="block font-brand text-lg font-bold leading-6 text-ink">
          {PRODUCT_BRAND}
        </span>
        <span
          aria-hidden="true"
          className="block truncate font-brand text-sm font-bold leading-5 text-ink-subtle"
        >
          {PRODUCT_TAGLINE}
        </span>
      </SidebarLabel>
    </Link>
  );
}
