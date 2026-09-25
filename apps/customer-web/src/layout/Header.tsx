/**
 * Storefront header: brand, appearance, market, account and cart.
 *
 * One band, five controls. Two things that used to be here are gone, and both
 * removals are the point of the current shape:
 *
 *   - **The global search box.** The greeting page now opens on a large tabbed
 *     search module — AI Mode or Products, over one bar — and a second, smaller
 *     search field in the chrome directly above it was two front doors to the
 *     same room. Worse, they behaved differently: the header field always went
 *     to `/search`, the hero bar goes to the catalogue with the filters and
 *     facets applied. Searching from anywhere is still one press away: the
 *     brand goes home, and the catalogue page carries its own search field
 *     with the filters it belongs to.
 *   - **The category bar.** A second sticky row spending 44px of every
 *     viewport on the top-level departments, which are also the first thing on
 *     the greeting page and the whole left rail of the catalogue page. On a
 *     phone it scrolled sideways, which meant the department you were in was
 *     frequently half off screen — a navigation aid you have to navigate.
 *
 * What is left is deliberately not padded out to fill the space they left.
 * Identity on the left, the five controls on the right, and nothing in the
 * middle: a header with a 600px hole in it is what a removed search box looks
 * like, and a header that owns its width is what this is.
 *
 * The other decisions worth keeping:
 *
 *   - **The cart badge is announced.** `aria-label` carries the count, so a
 *     screen reader hears "Cart, 3 items" rather than "Cart" and a bare number
 *     floating beside it.
 *   - **Nothing on the buy path is dropped on a phone.** Below `sm` the cart
 *     label and the account name collapse to their icons, but the controls
 *     themselves stay — appearance, market, account and cart are all still
 *     one tap away. There is no longer a second row to reflow into, because
 *     with search and the category bar gone the five fit at 345px.
 *   - **The chrome is a plain surface over a tinted page.** It used to be a
 *     navy band. The separation now comes from the page ground being cooler
 *     and darker than the header, with a shadow under it — see
 *     `--surface-sunken` in index.css, which is the one value the whole scheme
 *     hangs off, and which holds in both themes. Every control up here is
 *     therefore an ordinary on-surface control in either palette, and the app
 *     needs no second set of them drawn for a dark band.
 *   - **On a short viewport the band trims its padding.** A phone held
 *     sideways is ~400px tall, where a 64px sticky header is a sixth of the
 *     screen.
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { api } from '@/lib/api';
import { AccountMenu } from '@/components/account/AccountMenu';
import { BecomeSellerButton } from '@/layout/BecomeSellerButton';
import { MarketMenu } from '@/components/market/MarketMenu';
import { EarthMark } from '@/components/EarthMark';
import { PRODUCT_BRAND, PRODUCT_TAGLINE } from '@/lib/brand';
import { ThemeToggle } from '@/components/ThemeToggle';
import { CartIcon } from '@/components/icons';
import type { Cart } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';

/**
 * The brand lockup.
 *
 * A plate and a two-line lockup rather than a mark and a word. The first line
 * is the shop — read from the operator's own configuration, because every
 * buyer runs their own deployment and the header of their storefront is their
 * name and not ours.
 *
 * When that name IS the product's — the marketplace itself, and every fresh
 * deployment until its business profile is filled in — the first line is the
 * Glovia wordmark, set in `font-brand` (Dancing Script Bold, the wordmark's
 * own face), and the second is the tagline, `The Way to the World`. Both come from
 * `lib/brand.ts` and read the same in every language.
 *
 * When it is somebody else's name, neither applies. Glovia's face and Glovia's
 * slogan under Northwind's name would be the software putting its own brand
 * over another company's shop, so Northwind's name is set like any other
 * heading and stands alone. `Powered by UBOSS` used to be the second line;
 * it is the small print in the footer now, on every deployment.
 *
 * On a seller's own shop front the second line stays "Seller storefront"
 * instead. A buyer who followed a link to northwind.example needs to know they
 * are on Northwind's storefront and not on the marketplace's, because it
 * decides who they are buying from and who they chase about it — and that is
 * worth more to them there than the attribution is.
 *
 * Both are `aria-hidden` because the link's accessible name should be the
 * business, not the business plus a second line.
 */
function BrandMark(): React.JSX.Element {
  const { business, seller } = useStorefront();
  const { t } = useI18n();
  const isProductBrand = business.displayName === PRODUCT_BRAND;
  const secondLine =
    seller !== undefined ? t('header.sellerTagline') : isProductBrand ? PRODUCT_TAGLINE : null;

  return (
    <Link
      to="/"
      // `min-w-0 shrink` rather than `shrink-0`: the display name is a
      // per-deployment setting and can be long, and a lockup that refuses to
      // shrink pushes the cart off a phone instead of letting the name
      // truncate. The logo plate keeps its own `shrink-0`, so what gives way
      // is the wording and never the mark.
      // On a phone the hover box stops 6px short on the right, not 8, so it
      // never reaches under the first control across the 6px row gap.
      className="-mx-2 flex min-w-0 shrink items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-hover max-sm:-mr-1.5 max-sm:pr-1.5 sm:gap-3.5"
    >
      {business.logo === null ? (
        // No logo uploaded, so the mark is the earth - the same object the
        // landing page opens with, 40px across. It falls back to the letter
        // plate this used to be, and starts there on every visit; see
        // `components/EarthMark.tsx`.
        <EarthMark initial={business.displayName.slice(0, 1).toUpperCase()} />
      ) : (
        // A white plate with a hairline, not a bare image: a logo drawn for a
        // white page and one drawn for a dark one both have to survive here,
        // and only a plate makes that true of both. `surface-media` rather
        // than `surface`, so it stays white in the dark theme as well: a logo
        // is somebody else's artwork and is frequently a dark PNG with no
        // transparency, which on a dark plate is a black square.
        <img
          src={business.logo.url}
          alt=""
          width={40}
          height={40}
          className="h-10 w-10 shrink-0 rounded-md border border-border bg-surface-media object-contain p-1"
        />
      )}

      <span className="flex min-w-0 flex-col leading-tight">
        <span
          className={cx(
            'truncate',
            // The script wordmark in its real Bold and its own colour token
            // (`brand-wordmark`: near-white with a soft glow on the dark
            // header). 17px on a phone - the most a 375px row leaves beside five
            // controls - and 23px from `sm`; its short x-height
            // reads a size smaller than Inter at the same number. The line box
            // grows by 2px and the tagline's shrinks by 2px, so the header is
            // exactly as tall as it was.
            isProductBrand
              ? 'brand-wordmark font-brand text-[1.0625rem] font-bold leading-6 sm:text-[1.4375rem] sm:leading-[1.625rem]'
              : 'text-base font-semibold tracking-tight text-ink',
          )}
        >
          {business.displayName}
        </span>
        {secondLine !== null && (
          <span
            aria-hidden="true"
            // The tagline from `lg`, the seller line from `sm` as before. Between
            // the two the header controls leave the lockup about 110px, which
            // is not enough for the whole tagline, and half a slogan is worse
            // than none. `truncate` stays as the net for a long locale.
            // The tagline is in the wordmark's own script, the same face as
            // "Glovia" above it. The seller line in its place stays in the
            // ordinary face: it is translated, Greek included, and the script
            // is bundled as Latin only.
            className={cx(
              'hidden truncate',
              seller === undefined
                ? // `brand-tagline`: a very light blue on the dark header, where
                  // ink-subtle read as faint grey. 15px, a step under the
                  // wordmark so it never competes with it.
                  'brand-tagline font-brand text-[0.9375rem] font-bold leading-[1.125rem] lg:block'
                : 'text-xxs font-medium uppercase tracking-[0.14em] text-ink-subtle sm:block',
            )}
          >
            {/*
              Not a translation key when it is the tagline: a slogan is a
              brand asset, and the reasoning is in `lib/brand.ts`. The seller
              line in its place is ordinary prose and stays translated.
            */}
            {secondLine}
          </span>
        )}
      </span>
    </Link>
  );
}

function CartLink(): React.JSX.Element {
  const { isCustomer } = useSession();
  const { t } = useI18n();

  // Only asked for when there is a session to ask with. A guest has no cart on
  // the server, and firing a 401 on every page load is noise in the logs and a
  // wasted round trip.
  const cart = useQuery({
    queryKey: ['cart'],
    queryFn: () => api.get<{ cart: Cart }>('/cart'),
    enabled: isCustomer,
    staleTime: 10_000,
  });

  const count = cart.data?.cart.itemCount ?? 0;

  return (
    <Link
      to="/cart"
      // Given its own tinted treatment rather than the plain hover the other
      // header controls use: the cart is the one thing up here that is part of
      // buying, and on a phone — where the word "Cart" collapses to the icon —
      // a bare glyph among glyphs would not read as the buy path.
      //
      // Orange, and the only orange in the chrome, because orange is what this
      // app spends on the buy path and nothing else. `action-strong` on
      // `action-soft` is 4.88:1.
      className="relative flex h-10 items-center gap-2 rounded-md bg-action-soft px-3 text-sm font-medium text-action-strong ring-1 ring-inset ring-action/30 transition-colors hover:bg-action-soft-hover hover:ring-action/50"
      // Counted, not an appended "s": the plural of "item" is a different word
      // shape in most of the catalogue, and Polish needs three of them.
      // i18next reads `count` and picks the form.
      aria-label={count === 0 ? t('header.cartEmpty') : t('header.cartCount', { count })}
    >
      <CartIcon className="h-5 w-5" />
      <span className="hidden sm:inline">{t('header.cart')}</span>
      {count > 0 && (
        <span
          aria-hidden="true"
          // `action-fill` (#C2410C) with white on it: 4.95:1, and the same
          // value in both themes. It used to be #EA580C carrying ink, which
          // was 5.02:1 on white and 1.64:1 the moment `--ink` went light for
          // the dark theme — a legible badge becoming an orange smudge. The
          // count is also in this link's aria-label, so nothing *depends* on
          // reading it, which is exactly why the regression would have shipped.
          //
          // The ring is the chrome behind it, so the badge is cut out of the
          // header rather than sitting on the tinted control it overlaps —
          // without it the two orange edges merge at this size.
          className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-action-fill px-1 text-xxs font-bold text-white ring-2 ring-surface"
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  );
}

export function Header(): React.JSX.Element {
  return (
    /*
     * `shadow-card` on the header: it is one white block resting on a sky
     * page, and the shadow is what says so. Opaque, not translucent — a sticky
     * header that lets the page show through is where catalogue text and
     * header text overlap while you scroll.
     */
    <header className="sticky top-0 z-30 border-b border-border-subtle bg-surface shadow-card">
      {/*
       * `gap-2` at the smallest width, not `gap-3`.
       *
       * Measured, not guessed: with the appearance control added the five
       * controls plus a truncated brand came to 330px, and the storefront
       * commits to working from 320px. Six pixels of gap is what stood
       * between that and the page scrolling sideways, and the page not
       * scrolling sideways is a rule rather than a preference — see *How the
       * product reflows*. The brand is already truncating at this width, so
       * widening the gap only moves where the ellipsis falls.
       */}
      <div className="mx-auto flex max-w-content items-center gap-1.5 px-4 py-3 [@media(max-height:480px)]:py-1.5 sm:gap-6">
        <BrandMark />

        {/*
         * `ml-auto` rather than a flexible spacer in the middle.
         *
         * The brand shrinks and the controls do not, so the gap between them
         * is whatever is left over — which is the behaviour that was wanted
         * when the search box was there and is still the behaviour that is
         * wanted now. A `flex-1` element in the middle would be a named,
         * measurable hole where a control used to be.
         */}
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          {/* First, and the quietest of the four: it is the only one that
              changes nothing about the order somebody is placing. An
              unlabelled icon button beside the market chip rather than a
              fourth panel — see ThemeToggle for why it cycles. */}
          <ThemeToggle />

          {/* Market before account: what language this page is in and what
              its numbers mean is the question a buyer answers on arrival, and
              the account is what they do afterwards. */}
          <MarketMenu />

          {/* Before the account, after the market. It is a way INTO a
              different part of the product rather than a setting on this
              account, so it belongs in the bar rather than inside the profile
              menu - somebody who has never sold here has no reason to open a
              menu with their own name on it. */}
          <BecomeSellerButton />

          <AccountMenu />
          <CartLink />
        </div>
      </div>
    </header>
  );
}
