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
import { MarketMenu } from '@/components/market/MarketMenu';
import { ThemeToggle } from '@/components/ThemeToggle';
import { CartIcon } from '@/components/icons';
import type { Cart } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

/**
 * The brand lockup.
 *
 * A plate and a two-line lockup rather than a mark and a word: the second line
 * says what kind of site this is, which for a storefront a buyer may have
 * reached from a purchase-order email is the difference between "some shop"
 * and "our supplier's ordering system". It is `aria-hidden` because the link's
 * accessible name should be the business, not the business plus a tagline.
 */
function BrandMark(): React.JSX.Element {
  const { business } = useStorefront();
  const { t } = useI18n();

  return (
    <Link
      to="/"
      // `min-w-0 shrink` rather than `shrink-0`: the display name is a
      // per-deployment setting and can be long, and a lockup that refuses to
      // shrink pushes the cart off a phone instead of letting the name
      // truncate. The logo plate keeps its own `shrink-0`, so what gives way
      // is the wording and never the mark.
      className="-mx-2 flex min-w-0 shrink items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-hover sm:gap-3"
    >
      {business.logo === null ? (
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-brand-fill text-base font-bold text-white shadow-card"
        >
          {business.displayName.slice(0, 1).toUpperCase()}
        </span>
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
        <span className="truncate text-base font-semibold tracking-tight text-ink">
          {business.displayName}
        </span>
        <span
          aria-hidden="true"
          className="hidden text-xxs font-medium uppercase tracking-[0.14em] text-ink-subtle sm:block"
        >
          {t('header.brandTagline')}
        </span>
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
      <div className="mx-auto flex max-w-content items-center gap-2 px-4 py-3 [@media(max-height:480px)]:py-1.5 sm:gap-6">
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
          <AccountMenu />
          <CartLink />
        </div>
      </div>
    </header>
  );
}
