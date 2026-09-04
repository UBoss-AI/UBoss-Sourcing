/**
 * Storefront header: brand, search, category navigation, account and cart.
 *
 * Decisions worth keeping:
 *
 *   - **Search is a real `<form>` with a submit.** Typing and pressing Enter
 *     must work; a search box that only responds to a click on a magnifying
 *     glass excludes every keyboard user and most mobile keyboards. The
 *     magnifying glass inside the field is decoration on top of that, not the
 *     mechanism.
 *   - **The cart badge is announced.** `aria-label` carries the count, so a
 *     screen reader hears "Cart, 3 items" rather than "Cart" and a bare number
 *     floating beside it.
 *   - **Nothing on the buy path is dropped on a phone.** Below `sm` the cart
 *     and account labels collapse to their icons, but the controls themselves
 *     stay — currency, account and cart are all still one tap away, and search
 *     gets its own row rather than being hidden behind a toggle.
 *   - **Two bands, two jobs.** The navy band is identity and account state;
 *     the white bar below it is where you are in the catalogue. Keeping them
 *     visually separate is what stops "who am I" and "what am I browsing"
 *     competing for the same strip of screen.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { api } from '@/lib/api';
import { cx } from '@/lib/cx';
import { CartIcon, ChevronDownIcon, SearchIcon } from '@/components/icons';
import type { CategoryNode, Cart } from '@/lib/types';
import { useLocale } from '@/app/locale-context';

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

  return (
    <Link
      to="/"
      className="-mx-2 flex shrink-0 items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-white/10"
    >
      {business.logo === null ? (
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-white text-base font-bold text-surface-inverse ring-1 ring-inset ring-white/50"
        >
          {business.displayName.slice(0, 1).toUpperCase()}
        </span>
      ) : (
        // On the navy band a transparent logo would sit on navy. A white
        // plate keeps a supplied logo readable whatever it was drawn for.
        <img
          src={business.logo.url}
          alt=""
          width={40}
          height={40}
          className="h-10 w-10 shrink-0 rounded-md bg-white object-contain p-1 ring-1 ring-inset ring-white/50"
        />
      )}

      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-base font-semibold tracking-tight text-white">
          {business.displayName}
        </span>
        <span
          aria-hidden="true"
          className="hidden text-xxs font-medium uppercase tracking-[0.14em] text-white/60 sm:block"
        >
          Business purchasing
        </span>
      </span>
    </Link>
  );
}

function SearchBox(): React.JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const [term, setTerm] = useState(searchParams.get('q') ?? '');

  // Keep the box in step with the URL, so a browser Back out of a search
  // clears the box rather than leaving a term that no longer applies.
  useEffect(() => {
    setTerm(location.pathname === '/search' ? (searchParams.get('q') ?? '') : '');
  }, [location.pathname, searchParams]);

  return (
    <form
      role="search"
      // The blue submit button's outer edge is only 1.6:1 against the navy
      // band. One ring around the whole group gives the composite control a
      // 3.6:1 boundary, so it reads as a control and not as a shape that
      // happens to be there (WCAG 1.4.11).
      className="relative flex flex-1 items-stretch rounded-md ring-1 ring-white/40 transition-shadow hover:ring-white/60"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = term.trim();
        if (trimmed.length === 0) return;
        void navigate(`/search?q=${encodeURIComponent(trimmed)}`);
      }}
    >
      <label htmlFor="storefront-search" className="sr-only">
        Search products
      </label>

      {/* Decoration only, and `pointer-events-none` so it cannot swallow the
          click that should land in the field behind it. */}
      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" />

      <input
        id="storefront-search"
        type="search"
        value={term}
        placeholder="Search products by name or code"
        onChange={(event) => {
          setTerm(event.target.value);
        }}
        className="h-10 min-w-0 flex-1 rounded-l-md border border-r-0 border-border-strong bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-ink-subtle"
      />

      <button
        type="submit"
        className="h-10 shrink-0 rounded-r-md bg-brand px-4 text-sm font-medium text-white transition-colors hover:bg-brand-hover"
      >
        Search
      </button>
    </form>
  );
}

/**
 * Currency switcher.
 *
 * Every price on the site is quoted in this, and switching reprices the whole
 * catalogue from the server - it is not a client-side conversion. Hidden when
 * the store sells in only one currency, where a control with one option is
 * just noise.
 *
 * Kept on the navy band at every width. A buyer comparing a quote in the wrong
 * currency is the single most expensive misreading this storefront can cause,
 * so it does not get folded away on a phone.
 */
function CurrencySwitcher(): React.JSX.Element | null {
  const locale = useLocale();

  if (locale.currencies.length < 2) return null;

  return (
    <label className="flex items-center">
      <span className="sr-only">Currency</span>
      <select
        value={locale.currency}
        onChange={(event) => {
          void locale.setCurrency(event.target.value);
        }}
        // A white control on the navy band, not a transparent one with white
        // text: the option list is drawn by the OS and inherits the page's
        // colours, so white-on-transparent gives an unreadable dropdown.
        //
        // `select-chevron` replaces the platform arrow (index.css), so this
        // sits at the same weight as the app's other selects instead of being
        // whatever shape the operating system felt like drawing.
        className="select-chevron h-10 rounded-md border border-border-strong bg-surface pl-2.5 pr-7 text-xs font-medium text-ink"
      >
        {locale.currencies.map((entry) => (
          <option key={entry.code} value={entry.code}>
            {entry.symbol.trim()} {entry.code}
          </option>
        ))}
      </select>
    </label>
  );
}

function CartLink(): React.JSX.Element {
  const { isCustomer } = useSession();

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
      // Given its own filled-and-ringed treatment rather than the plain hover
      // the other header controls use: the cart is the one thing up here that
      // is part of buying, and on a phone — where the word "Cart" collapses to
      // the icon — a bare glyph among glyphs would not read as the buy path.
      className="relative flex h-10 items-center gap-2 rounded-md bg-white/10 px-3 text-sm font-medium text-white ring-1 ring-inset ring-white/25 transition-colors hover:bg-white/20 hover:ring-white/40"
      aria-label={count === 0 ? 'Cart, empty' : `Cart, ${String(count)} item${count === 1 ? '' : 's'}`}
    >
      <CartIcon className="h-5 w-5" />
      <span className="hidden sm:inline">Cart</span>
      {count > 0 && (
        <span
          aria-hidden="true"
          // #EA580C carrying ink rather than white: 5.02:1, where white on it
          // would be 3.56:1. The count is also in this link's aria-label, so
          // nothing depends on reading the badge.
          //
          // The navy ring separates the badge from the control it overlaps —
          // without it the two orange-on-white edges merge at small sizes.
          className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-action px-1 text-xxs font-bold text-ink ring-2 ring-surface-inverse"
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  );
}

function AccountMenu(): React.JSX.Element {
  const { user, isCustomer, logout } = useSession();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape. Without the Escape handler a keyboard
  // user who opens the menu has no way back out.
  useEffect(() => {
    if (!isOpen) return undefined;

    const onPointerDown = (event: MouseEvent): void => {
      if (containerRef.current?.contains(event.target as Node) !== true) setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  if (!isCustomer) {
    return (
      <Link
        to="/login"
        className="inline-flex h-10 shrink-0 items-center rounded-md border border-white/40 px-3 text-sm font-medium text-white transition-colors hover:border-white/60 hover:bg-white/10 sm:px-4"
      >
        Sign in
      </Link>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setIsOpen((open) => !open);
        }}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        // Named explicitly, because the visible word is dropped below `lg` and
        // a `display:none` label leaves nothing in the accessibility tree —
        // which made this an unnamed button on every phone.
        aria-label="Account"
        className="flex h-10 items-center gap-2 rounded-md px-2 text-sm font-medium text-white/85 transition-colors hover:bg-white/10 hover:text-white sm:px-3"
      >
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/15 text-xxs font-semibold text-white ring-1 ring-inset ring-white/25"
        >
          {(user?.email ?? '?').slice(0, 2).toUpperCase()}
        </span>
        <span className="hidden max-w-32 truncate lg:inline">Account</span>
        <ChevronDownIcon
          className={cx(
            'hidden h-4 w-4 text-white/60 transition-transform lg:block',
            isOpen && 'rotate-180',
          )}
        />
      </button>

      {isOpen && (
        <div
          role="menu"
          // `on-light` puts the focus ring back to brand-on-white: this panel
          // is a white surface that happens to hang off the navy band, and the
          // band's white ring would be invisible inside it.
          className="on-light absolute right-0 z-40 mt-2 w-60 rounded-lg border border-border bg-surface p-1.5 shadow-popover"
        >
          <p className="border-b border-border px-3 pb-2.5 pt-2">
            <span className="block text-xxs font-medium uppercase tracking-wider text-ink-subtle">
              Signed in as
            </span>
            <span className="mt-0.5 block truncate text-sm font-medium text-ink">{user?.email}</span>
          </p>

          <div className="pt-1.5">
            {(
              [
                ['/account/orders', 'My orders'],
                ['/account/schedules', 'Repeat purchases'],
                ['/account/addresses', 'Addresses'],
                ['/account/profile', 'Profile'],
              ] satisfies [string, string][]
            ).map(([to, label]) => (
              <Link
                key={to}
                to={to}
                role="menuitem"
                onClick={() => {
                  setIsOpen(false);
                }}
                className="block rounded px-3 py-2 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
              >
                {label}
              </Link>
            ))}
          </div>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setIsOpen(false);
              void logout();
            }}
            className="mt-1.5 block w-full rounded border-t border-border px-3 py-2 text-left text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The category bar.
 *
 * The active entry is a filled pill, not just a colour change on the word.
 * "Where am I in the catalogue" is the question this bar exists to answer, and
 * a recoloured word in a row of words answers it faintly — especially once the
 * row scrolls sideways on a phone and the entry you are on may be half off
 * screen. `NavLink` also sets `aria-current="page"`, so the state is carried
 * for a screen reader and not only in the fill.
 */
function CategoryBar(): React.JSX.Element | null {
  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<{ categories: CategoryNode[] }>('/catalog/categories'),
    staleTime: 5 * 60_000,
  });

  const roots = (categories.data?.categories ?? []).filter((node) => node.productCount > 0);

  if (roots.length === 0) return null;

  const entryClass = ({ isActive }: { isActive: boolean }): string =>
    cx(
      'block whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors',
      isActive
        ? 'bg-brand-soft font-semibold text-brand ring-1 ring-inset ring-brand/25'
        : 'font-medium text-ink-muted hover:bg-surface-hover hover:text-ink',
    );

  return (
    <nav aria-label="Product categories" className="border-b border-border bg-surface shadow-card">
      <div className="mx-auto max-w-content overflow-x-auto px-4">
        <ul className="flex items-center gap-1 py-2">
          <li className="shrink-0">
            <NavLink to="/products" end className={entryClass}>
              All products
            </NavLink>
          </li>

          {/* Separates "everything" from the individual departments, so the
              first category does not read as a sibling of All products. */}
          <li aria-hidden="true" className="mx-1.5 h-5 w-px shrink-0 bg-border" />

          {roots.map((category) => (
            <li key={category.id} className="shrink-0">
              <NavLink to={`/category/${category.slug}`} className={entryClass}>
                {category.name}
              </NavLink>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

export function Header(): React.JSX.Element {
  return (
    <header className="sticky top-0 z-30">
      {/*
       * The navy band.
       *
       * Opaque, not the translucent white this replaced: a sticky header that
       * lets the page show through is where catalogue text and header text
       * overlap while you scroll. Navy also separates the chrome from the
       * white catalogue below it, so "where am I" and "what am I buying" stop
       * competing for the same surface.
       *
       * `on-navy` swaps the focus ring to white — see index.css. Without it a
       * keyboard user loses the ring on every control up here.
       */}
      <div className="on-navy bg-surface-inverse">
        <div className="mx-auto flex max-w-content items-center gap-4 px-4 py-3 sm:gap-6">
          <BrandMark />

          {/* The search field takes the middle of the band from `md` up, and
              is capped so it does not stretch to a 1600px line on a wide
              monitor — a search box the width of a desk reads as a text area. */}
          <div className="hidden flex-1 justify-center md:flex">
            <div className="flex w-full max-w-xl">
              <SearchBox />
            </div>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
            <CurrencySwitcher />
            <AccountMenu />
            <CartLink />
          </div>
        </div>

        {/* On a narrow screen the search box gets its own row rather than being
            squeezed out of the header entirely. */}
        <div className="mx-auto max-w-content px-4 pb-3 md:hidden">
          <SearchBox />
        </div>
      </div>

      <CategoryBar />
    </header>
  );
}
