/**
 * Storefront header: brand, search, category navigation, account and cart.
 *
 * Two decisions worth keeping:
 *
 *   - **Search is a real `<form>` with a submit.** Typing and pressing Enter
 *     must work; a search box that only responds to a click on a magnifying
 *     glass excludes every keyboard user and most mobile keyboards.
 *   - **The cart badge is announced.** `aria-label` carries the count, so a
 *     screen reader hears "Cart, 3 items" rather than "Cart" and a bare number
 *     floating beside it.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { api } from '@/lib/api';
import { cx } from '@/lib/cx';
import type { CategoryNode, Cart } from '@/lib/types';
import { useLocale } from '@/app/locale-context';

function BrandMark(): React.JSX.Element {
  const { business } = useStorefront();

  return (
    <Link to="/" className="flex shrink-0 items-center gap-2.5">
      {business.logo === null ? (
        <span
          aria-hidden="true"
          className="flex h-8 w-8 items-center justify-center rounded-md bg-brand text-sm font-bold text-white"
        >
          {business.displayName.slice(0, 1).toUpperCase()}
        </span>
      ) : (
        <img
          src={business.logo.url}
          alt=""
          width={32}
          height={32}
          className="h-8 w-8 rounded-md object-contain"
        />
      )}
      <span className="text-base font-semibold tracking-tight text-ink">
        {business.displayName}
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
      className="flex flex-1 items-stretch"
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
      <input
        id="storefront-search"
        type="search"
        value={term}
        placeholder="Search products by name or code"
        onChange={(event) => {
          setTerm(event.target.value);
        }}
        className="min-w-0 flex-1 rounded-l-md border border-r-0 border-border-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle"
      />
      <button
        type="submit"
        className="rounded-r-md bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover"
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
        className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs font-medium text-ink hover:border-border-strong focus:outline-none focus:ring-2 focus:ring-brand"
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
      className="relative flex items-center gap-1.5 rounded-md px-2.5 py-2 text-sm font-medium text-ink-muted hover:bg-surface-sunken hover:text-ink"
      aria-label={count === 0 ? 'Cart, empty' : `Cart, ${String(count)} item${count === 1 ? '' : 's'}`}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M3 3h2l.4 2M7 13h10l3-8H5.4M7 13 5.4 5M7 13l-.6 3h12" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="9" cy="20" r="1.5" />
        <circle cx="17" cy="20" r="1.5" />
      </svg>
      <span className="hidden sm:inline">Cart</span>
      {count > 0 && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-action px-1 text-xxs font-bold text-white"
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
        className="inline-flex h-9 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-sunken"
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
        className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium text-ink-muted hover:bg-surface-sunken hover:text-ink"
      >
        <span
          aria-hidden="true"
          className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-soft text-xxs font-semibold text-brand"
        >
          {(user?.email ?? '?').slice(0, 2).toUpperCase()}
        </span>
        <span className="hidden max-w-32 truncate lg:inline">Account</span>
      </button>

      {isOpen && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1.5 w-56 rounded-lg border border-border bg-surface p-1 shadow-popover"
        >
          <p className="truncate border-b border-border px-3 py-2.5 text-xs text-ink-muted">
            {user?.email}
          </p>

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
              className="block rounded px-3 py-2 text-sm text-ink-muted hover:bg-surface-sunken hover:text-ink"
            >
              {label}
            </Link>
          ))}

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setIsOpen(false);
              void logout();
            }}
            className="mt-1 block w-full rounded border-t border-border px-3 py-2 text-left text-sm text-ink-muted hover:bg-surface-sunken hover:text-ink"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function CategoryBar(): React.JSX.Element | null {
  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<{ categories: CategoryNode[] }>('/catalog/categories'),
    staleTime: 5 * 60_000,
  });

  const roots = (categories.data?.categories ?? []).filter((node) => node.productCount > 0);

  if (roots.length === 0) return null;

  return (
    <nav aria-label="Product categories" className="border-t border-border bg-surface">
      <div className="mx-auto max-w-content overflow-x-auto px-4">
        <ul className="flex items-center gap-1 py-1.5">
          <li>
            <NavLink
              to="/products"
              end
              className={({ isActive }) =>
                cx(
                  'block whitespace-nowrap rounded px-3 py-1.5 text-sm',
                  isActive ? 'font-medium text-brand' : 'text-ink-muted hover:text-ink',
                )
              }
            >
              All products
            </NavLink>
          </li>
          {roots.map((category) => (
            <li key={category.id}>
              <NavLink
                to={`/category/${category.slug}`}
                className={({ isActive }) =>
                  cx(
                    'block whitespace-nowrap rounded px-3 py-1.5 text-sm',
                    isActive ? 'font-medium text-brand' : 'text-ink-muted hover:text-ink',
                  )
                }
              >
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
    <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-content items-center gap-3 px-4 py-3 sm:gap-6">
        <BrandMark />

        <div className="hidden flex-1 md:flex">
          <SearchBox />
        </div>

        <div className="ml-auto flex items-center gap-1 sm:gap-2">
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

      <CategoryBar />
    </header>
  );
}
