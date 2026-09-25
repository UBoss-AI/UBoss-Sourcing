/**
 * The brand block: the product, and its tagline.
 *
 * Two lines, both from `lib/brand.ts`, which is the one place either string is
 * written in any of the three applications. Both are set in `font-brand`
 * (Dancing Script Bold), the wordmark's own face, used for the name and its
 * tagline and nothing else,
 * a step larger than an Inter label because a script reads a size smaller. One component for both places the
 * portal shows it — the rail once somebody is through, and the sign-in screen
 * before they are — because a sign-in screen whose mark and wording differ
 * from the application behind it is the first thing a person sees and the
 * first thing that makes them wonder whether they are on the right site.
 *
 * IT IS NOT THE CARRIER.
 *
 * The company a dispatcher is signed in as comes from the session and is
 * further down the rail — see `SignedInAs` in `AppShell`. A portal that put
 * its own name where the carrier's belongs would leave somebody unable to tell
 * whose consignments they were looking at, which on a shared depot machine is
 * the whole question.
 *
 * The mark used to be a parcel-and-route glyph, which meant the product had a
 * different mark in each of its three applications. It is the storefront's
 * earth now, at 28px, with the letter still underneath it for a browser with
 * no WebGL and for a dispatcher who asked for no motion — which on a depot
 * tablet on a bad connection is the case that matters. See
 * `components/EarthMark.tsx`.
 *
 * The lockup is one `img` to assistive technology, named with both lines, and
 * the two visible lines are `aria-hidden` so that name is not then read twice.
 * On the rail at sixty pixels the lines are gone and the mark is the whole of
 * it; the name is not, which is what stops a collapsed rail being unlabelled.
 */
import { SidebarLabel } from '@/components/ui/sidebar';
import { EarthMark } from '@/components/EarthMark';
import { PRODUCT_BRAND, PRODUCT_INITIAL, PRODUCT_TAGLINE } from '@/lib/brand';

export function BrandLockup({
  /**
   * True on the rail, where the wording folds away with the column. False on
   * the sign-in screen, which has no rail to fold into and no sidebar context
   * to read.
   */
  collapsible = false,
}: {
  collapsible?: boolean | undefined;
} = {}): React.JSX.Element {
  const lines = (
    <>
      <span aria-hidden="true" className="brand-wordmark block truncate font-brand text-xl font-bold leading-6">
        {PRODUCT_BRAND}
      </span>
      <span
        aria-hidden="true"
        className="brand-tagline block truncate font-brand text-[0.9375rem] font-bold leading-5"
      >
        {PRODUCT_TAGLINE}
      </span>
    </>
  );

  return (
    <span
      role="img"
      aria-label={`${PRODUCT_BRAND} — ${PRODUCT_TAGLINE}`}
      className="flex h-10 shrink-0 items-center gap-3 px-2"
    >
      <EarthMark initial={PRODUCT_INITIAL} size="sm" />
      {collapsible ? (
        <SidebarLabel display="block" className="min-w-0 leading-tight">
          {lines}
        </SidebarLabel>
      ) : (
        <span className="flex min-w-0 flex-col leading-tight">{lines}</span>
      )}
    </span>
  );
}
