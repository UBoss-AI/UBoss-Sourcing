/**
 * The brand block: the product, and its tagline.
 *
 * Two lines, both from `lib/brand.ts`, which is the one place either string is
 * written in any of the three applications. Both are set in `font-brand`
 * (Dancing Script Bold), the wordmark's own face, used for the name and its
 * tagline and nothing else,
 * a step larger than an Inter label because a script reads a size smaller. One component for both places the
 * console shows it — the rail once somebody is through, and the sign-in screen
 * before they are — because a sign-in screen whose mark and wording differ
 * from the application behind it is the first thing a person sees and the
 * first thing that makes them wonder whether they are on the right site.
 *
 * IT IS NOT THE AGENCY.
 *
 * The agency a person works for comes from the session and is further down
 * the rail - see `organisationName` in `AppShell`. A console that put its own
 * name where the agency's belongs would leave an inspector unable to tell
 * whose jobs they were looking at.
 *
 * The mark is the storefront's earth at 28px, with the letter underneath it
 * for a browser with no WebGL and for anybody who asked for no motion. See
 * `components/EarthMark.tsx`.
 *
 * The lockup is one `img` to assistive technology, named with both lines, and
 * the two visible lines are `aria-hidden` so that name is not then read twice.
 * On the rail at sixty pixels the lines are gone and the mark is the whole of
 * it; the name is not, which is what stops a collapsed rail being unlabelled.
 */
import { SidebarLabel } from '@/components/ui/sidebar';
import { EarthMark } from '@/components/EarthMark';
import { PRODUCT_BRAND, PRODUCT_INITIAL, PRODUCT_SHORT_NAME, PRODUCT_TAGLINE } from '@/lib/brand';

/**
 * "Gloviaa" in the script, "mart" in light lowercase Inter a step smaller on the same
 * baseline — a parent brand naming one of its services. The same treatment as
 * the storefront's `components/BrandName.tsx`.
 */
function BrandName(): React.JSX.Element {
  return (
    <>
      {PRODUCT_SHORT_NAME}{' '}
      <span className="brand-name-service font-sans text-[0.62em] font-light lowercase tracking-tight">
        {PRODUCT_BRAND.slice(PRODUCT_SHORT_NAME.length).trim()}
      </span>
    </>
  );
}

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
        <BrandName />
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
      className="flex h-10 min-w-0 max-w-full items-center gap-3 px-2"
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
