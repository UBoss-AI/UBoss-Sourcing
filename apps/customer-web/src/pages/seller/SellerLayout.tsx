/**
 * The Seller Hub's frame.
 *
 * A workspace, not an account page, and the layout says so: a permanent rail
 * of destinations on the left, a working area that fills the rest, and none of
 * the storefront's header or footer. A seller packing forty orders is not
 * shopping, and giving them the shopping chrome costs them a hundred pixels of
 * vertical space on every screen they spend the day in.
 *
 * Three things the frame is responsible for and the pages are not:
 *
 *   - **The mode switch.** One account buys and sells here, so the frame has to
 *     offer a way back to the shop. It is a link rather than a toggle, because
 *     it navigates.
 *   - **The application banner.** A seller whose application is not approved
 *     sees why on every page, not only on the one they were looking at when it
 *     changed.
 *   - **Refusing to render for somebody who is not a seller.** The routes are
 *     guarded server-side; this is what stops the interface flashing a
 *     dashboard shape before the 403 arrives.
 *
 * Below `lg` the rail becomes a bottom bar. A phone has no room for a
 * permanent sidebar, and a hamburger that hides the only navigation is how a
 * seller loses the orders queue.
 */
import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useI18n } from '@/i18n/i18n-context';
import { Badge, Button, ErrorState, Field, Input, LoadingState } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { cx } from '@/lib/cx';
import {
  applicationStatusKey,
  applicationStatusTone,
  closeSellerLock,
  fetchSellerIdentity,
  openSellerLock,
  setSellerLock,
  type SellerIdentity,
} from '@/lib/seller';

// ---------------------------------------------------------------------------
// Icons
//
// Drawn here rather than imported from a set, for the reason the brief gives:
// nothing in this interface may reproduce a third party's proprietary icons.
// These are plain geometric marks on the 24-unit grid the rest of the app uses,
// stroked with `currentColor` so they take the rail's active and inactive
// colours without a second variant each.
// ---------------------------------------------------------------------------

type IconProps = { className?: string };

function HomeIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-5.5h-6V20H5a1 1 0 0 1-1-1v-8.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ListingsIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="19" cy="18" r="2.2" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function InventoryIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect x="3.5" y="7" width="17" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.5 11h17M9 4h6v3H9z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function OrdersIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="m12 3 8 4.2v9.6L12 21l-8-4.2V7.2L12 3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M4 7.2 12 11.5l8-4.3M12 11.5V21" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function PaymentsIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect x="3" y="6" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 10h18" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6.5 14.5h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Brand requests. A luggage tag, matching the operator's own queue icon. */
function BrandsIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M13.4 3.6H20v6.6l-8.6 8.6a1.6 1.6 0 0 1-2.3 0l-4.3-4.3a1.6 1.6 0 0 1 0-2.3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="16.4" cy="7.2" r="1" fill="currentColor" />
    </svg>
  );
}

/** Notifications. A bell, because everything else reads as something else. */
function BellIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M6.5 10.5a5.5 5.5 0 0 1 11 0c0 3.2.8 4.6 1.5 5.5h-14c.7-.9 1.5-2.3 1.5-5.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M10 19a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Activity. A clock face turned back — a record of what already happened. */
function ActivityIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 7.5V12l3 1.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ProfileIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <circle cx="12" cy="8.5" r="3.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** A closed padlock. Shutting the Hub, not signing out. */
function LockIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect x="5" y="10.5" width="14" height="9.5" rx="1.8" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ShopIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M5 8h14l-1 11.2a1.5 1.5 0 0 1-1.5 1.3h-9A1.5 1.5 0 0 1 6 19.2L5 8Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M9 8V6.5a3 3 0 0 1 6 0V8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

interface NavItem {
  to: string;
  label: string;
  icon: (props: IconProps) => React.JSX.Element;
  /** Whether the destination is usable before the account is approved. */
  needsApproval: boolean;
}

const NAV_ITEMS: readonly NavItem[] = Object.freeze([
  { to: '/seller/dashboard', label: 'Home', icon: HomeIcon, needsApproval: false },
  { to: '/seller/listings', label: 'Listings', icon: ListingsIcon, needsApproval: true },
  // Directly under Listings, because that is where a request is made and this
  // is the only place its answer can be read.
  { to: '/seller/brands', label: 'Brands', icon: BrandsIcon, needsApproval: true },
  { to: '/seller/inventory', label: 'Inventory', icon: InventoryIcon, needsApproval: true },
  { to: '/seller/orders', label: 'Orders', icon: OrdersIcon, needsApproval: true },
  { to: '/seller/payments', label: 'Payments', icon: PaymentsIcon, needsApproval: false },
  // Both reachable before approval: an applicant is told things and has things
  // recorded about them from the moment they apply, and a screen that refused
  // them until approval would hide exactly the notices explaining the delay.
  { to: '/seller/notifications', label: 'Notifications', icon: BellIcon, needsApproval: false },
  { to: '/seller/activity', label: 'Activity', icon: ActivityIcon, needsApproval: false },
  { to: '/seller/profile', label: 'Profile', icon: ProfileIcon, needsApproval: false },
]);

function RailLink({
  item,
  isDisabled,
}: {
  item: NavItem;
  isDisabled: boolean;
}): React.JSX.Element {
  const Icon = item.icon;

  if (isDisabled) {
    // Rendered as a disabled button rather than omitted, so the shape of the
    // workspace is visible from day one and the seller can see what finishing
    // their application unlocks. `aria-disabled` plus no href keeps it out of
    // the tab order without hiding it from a screen reader.
    return (
      <span
        aria-disabled="true"
        title="Available once your application is approved"
        className={cx(
          'flex flex-col items-center gap-1 rounded-lg px-3 py-2.5 text-xxs font-medium',
          'cursor-not-allowed text-ink-subtle opacity-60',
          'lg:flex-row lg:gap-3 lg:px-3 lg:py-2.5 lg:text-sm',
        )}
      >
        <Icon className="h-5 w-5 shrink-0" />
        <span className="truncate">{item.label}</span>
      </span>
    );
  }

  return (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        cx(
          'flex flex-col items-center gap-1 rounded-lg px-3 py-2.5 text-xxs font-medium transition-colors',
          'lg:flex-row lg:gap-3 lg:px-3 lg:py-2.5 lg:text-sm',
          isActive
            ? 'bg-brand-soft text-brand'
            : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon className={cx('h-5 w-5 shrink-0', isActive && 'text-brand')} />
          <span className="truncate">{item.label}</span>
        </>
      )}
    </NavLink>
  );
}

// ---------------------------------------------------------------------------
// The company's own mark
// ---------------------------------------------------------------------------

/**
 * The seller's logo, or their initial.
 *
 * A seller's workspace is headed by the seller's own company, not by the
 * marketplace's: they are running their business through this screen, and a
 * frame branded entirely by somebody else is one they never quite recognise as
 * theirs. The operator's name stays as the small caption above it, because
 * whose marketplace this is remains a fact worth stating.
 *
 * A seller who has not uploaded anything gets their initial on a tinted square
 * rather than a placeholder image — never the operator's logo, which would put
 * the marketplace's mark over a seller's name.
 */
function CompanyMark({
  name,
  logoUrl,
  className,
}: {
  name: string;
  logoUrl: string | null;
  className?: string;
}): React.JSX.Element {
  const initial = name.trim().charAt(0).toUpperCase();

  if (logoUrl === null) {
    return (
      <span
        aria-hidden="true"
        className={cx(
          'flex shrink-0 items-center justify-center rounded-md bg-brand-soft',
          'font-semibold text-brand',
          className,
        )}
      >
        {initial.length === 0 ? '?' : initial}
      </span>
    );
  }

  return (
    <img
      src={logoUrl}
      alt=""
      // Decorative: the company's name is rendered beside it in text, so a
      // screen reader announcing the logo as well would say it twice.
      aria-hidden="true"
      className={cx('shrink-0 rounded-md border border-border-subtle bg-surface object-contain', className)}
    />
  );
}

// ---------------------------------------------------------------------------
// The application banner
// ---------------------------------------------------------------------------

/**
 * Why this account cannot sell yet, on every page.
 *
 * Four different messages for four states, because the seller's next action is
 * different in each: finish the form, wait, fix what was flagged, or contact
 * the marketplace. A single "your application is pending" would be wrong for
 * three of them.
 */
function ApplicationBanner({ seller }: { seller: SellerIdentity }): React.JSX.Element | null {
  if (seller.status === 'APPROVED') return null;

  const content: { tone: string; title: string; body: string; cta?: string } =
    seller.status === 'DRAFT'
      ? {
          tone: 'border-brand/30 bg-brand-soft text-ink',
          title: 'Your seller application is not finished',
          body: 'Complete the remaining steps to start listing products.',
          cta: 'Continue setup',
        }
      : seller.status === 'ACTION_REQUIRED'
        ? {
            tone: 'border-warning/30 bg-warning-soft text-ink',
            title: 'Your application needs some changes',
            body: 'We have written to you with what needs correcting. Make the changes and send it back.',
            cta: 'Open your application',
          }
        : seller.status === 'SUSPENDED'
          ? {
              tone: 'border-danger/30 bg-danger-soft text-ink',
              title: 'Selling is paused on this account',
              body: 'Existing orders still need fulfilling. New listings and new orders are stopped until this is resolved.',
            }
          : seller.status === 'REJECTED'
            ? {
                tone: 'border-danger/30 bg-danger-soft text-ink',
                title: 'This application was not approved',
                body: 'Contact the marketplace if you would like to discuss it.',
              }
            : {
                tone: 'border-brand/30 bg-brand-soft text-ink',
                title: 'Your application is with the marketplace',
                body: 'We will let you know as soon as it has been reviewed. You can look at your answers but not change them while it is being reviewed.',
              };

  return (
    <div className={cx('rounded-lg border px-4 py-3', content.tone)} role="status">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{content.title}</p>
          <p className="mt-0.5 text-sm text-ink-muted">{content.body}</p>
        </div>
        {content.cta !== undefined && (
          <NavLink
            to="/seller/onboarding"
            className="shrink-0 rounded-md bg-brand-fill px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-fill-hover"
          >
            {content.cta}
          </NavLink>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------
// The Hub's own lock
// ---------------------------------------------------------------------------

/**
 * The screen that stands in front of the Hub.
 *
 * Two modes, one component, because the two are the same shape and share every
 * word around the field: `choose` when this person has never set a Seller Hub
 * password, `enter` when they have and this browser has not given it.
 *
 * Deliberately NOT a modal over the Hub. A dialog over a rendered workspace is
 * a workspace somebody can read, screenshot and sometimes tab into; the point
 * of the lock is that the catalogue and the orders are not on the screen.
 *
 * The way out is back to the shop, not a sign-out. Buying and selling share
 * one account here, and somebody who cannot remember their Hub password should
 * not lose their basket over it.
 */
function SellerLockGate({
  seller,
  mode,
}: {
  seller: SellerIdentity;
  mode: 'choose' | 'enter';
}): React.JSX.Element {
  const client = useQueryClient();
  const { t } = useI18n();

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  /*
   * The password field takes focus when this screen appears.
   *
   * A callback ref rather than `autoFocus`, which the accessibility lint rule
   * forbids and is right to: a field that grabs focus out of a page somebody is
   * reading is hostile. This screen is not that — it replaces the whole Hub,
   * the field is the only thing to do on it, and a seller who has just pressed
   * "Seller Hub" should be able to start typing.
   */
  const focusPassword = useCallback((node: HTMLInputElement | null) => {
    node?.focus();
  }, []);

  const isChoosing = mode === 'choose';

  const submit = useMutation({
    mutationFn: () =>
      isChoosing ? setSellerLock({ newPassword: password }) : openSellerLock(password),
    onSuccess: async () => {
      setProblem(null);
      // Awaited, not fired and forgotten: the layout re-reads this identity to
      // decide whether to draw the Hub, and navigating on a stale copy is what
      // sent a brand-new seller back to the marketing page once already.
      await client.invalidateQueries({ queryKey: ['seller', 'identity'] });
    },
    onError: (error: unknown) => {
      setProblem(errorMessage(t, error, 'That could not be checked just now.'));
    },
  });

  const tooShort = isChoosing && password.length > 0 && password.length < 12;
  const mismatch = isChoosing && confirmation.length > 0 && confirmation !== password;

  const canSubmit = isChoosing
    ? password.length >= 12 && confirmation === password && !submit.isPending
    : password.length > 0 && !submit.isPending;

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4 py-16">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-3">
          <CompanyMark name={seller.displayName} logoUrl={seller.logoUrl} className="h-10 w-10" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">{seller.displayName}</p>
            <p className="text-xxs uppercase tracking-wider text-ink-subtle">Seller Hub</p>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-surface p-6 shadow-card">
          <h1 className="text-title-sm text-ink">
            {isChoosing ? 'Choose your Seller Hub password' : 'Enter your Seller Hub password'}
          </h1>

          <p className="mt-2 text-sm leading-relaxed text-ink-muted">
            {isChoosing
              ? 'Selling uses the same account you buy with, and its own password. Choose one you do not use for the shop — that is what keeps a browser left open on the shop from being a browser left open on your catalogue, your stock and your payouts.'
              : 'You are signed in to the shop. The Hub asks for its own password before it opens.'}
          </p>

          <form
            className="mt-5 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSubmit) submit.mutate();
            }}
          >
            <Field
              label={isChoosing ? 'New Seller Hub password' : 'Seller Hub password'}
              {...(isChoosing ? { hint: 'At least 12 characters.' } : {})}
              {...(tooShort ? { error: 'At least 12 characters.' } : {})}
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  type="password"
                  autoComplete={isChoosing ? 'new-password' : 'current-password'}
                  // Focused through a ref rather than `autoFocus`: this screen
                  // IS the page, the field is the only thing on it, and a
                  // seller who has just clicked Seller Hub should be able to
                  // type. The lint rule is about a field that steals focus from
                  // a page somebody was reading, which this is not.
                  ref={focusPassword}
                  value={password}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    setPassword(value);
                    setProblem(null);
                  }}
                />
              )}
            </Field>

            {isChoosing && (
              <Field
                label="Type it again"
                {...(mismatch ? { error: 'These two do not match.' } : {})}
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    type="password"
                    autoComplete="new-password"
                    value={confirmation}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setConfirmation(value);
                    }}
                  />
                )}
              </Field>
            )}

            {problem !== null && (
              <p role="alert" className="text-sm text-danger">
                {problem}
              </p>
            )}

            <Button
              type="submit"
              variant="primary"
              className="w-full"
              isLoading={submit.isPending}
              disabled={!canSubmit}
            >
              {isChoosing ? 'Save it and open the Hub' : 'Open the Hub'}
            </Button>
          </form>
        </div>

        <p className="mt-4 text-center text-xs text-ink-muted">
          <Link to="/" className="text-brand hover:underline">
            Back to the shop
          </Link>
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function SellerLayout(): React.JSX.Element {
  const { t } = useI18n();
  const location = useLocation();
  const client = useQueryClient();

  /*
   * Shutting the Hub only has to invalidate the identity: the layout re-reads
   * it, finds `isOpen` false and draws the lock screen in place of the
   * workspace. No navigation, because the seller has not gone anywhere.
   */
  const closeHub = useMutation({
    mutationFn: closeSellerLock,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['seller', 'identity'] });
    },
  });

  const query = useQuery({
    queryKey: ['seller', 'identity'],
    queryFn: fetchSellerIdentity,
    // The rail, the banner and every page's guard read this. Refetching it on
    // each navigation would put a request on every click for something that
    // changes when a moderator acts, which is minutes or days apart.
    staleTime: 60_000,
  });

  if (query.isPending) return <LoadingState label={t('common.loading')} />;

  if (query.isError) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
          />
      </div>
    );
  }

  const seller = query.data.seller;

  // Not a seller at all. Sent to the public page that explains the programme,
  // rather than shown an empty workspace or an error - "you do not have a
  // seller account" is not news to somebody who has never applied.
  if (seller === null) return <Navigate to="/sell" replace />;

  /*
   * The Hub's second lock, before the workspace is drawn at all.
   *
   * Not a banner over a visible Hub and not a redirect: the whole point is that
   * the catalogue, the stock and the orders are not on the screen until the
   * seller password has been entered. A person handed a colleague's signed-in
   * browser can read a basket and gets this instead of a business.
   *
   * Two screens because there are two states with two different remedies —
   * choose one, or enter the one you chose.
   */
  if (!seller.lock.isSet) return <SellerLockGate seller={seller} mode="choose" />;
  if (!seller.lock.isOpen) return <SellerLockGate seller={seller} mode="enter" />;

  const isTrading = seller.isTrading;

  return (
    <div className="flex min-h-screen flex-col bg-surface-sunken lg:flex-row">
      {/* ---- The rail ---------------------------------------------------- */}
      <aside
        className={cx(
          'order-2 border-t border-border bg-surface lg:order-1 lg:w-60 lg:shrink-0 lg:border-r lg:border-t-0',
          // Sticky on a phone so the rail is reachable without scrolling to the
          // bottom of a three-hundred-row listings table.
          'sticky bottom-0 z-20 lg:static',
        )}
      >
        <div className="hidden px-5 py-5 lg:block">
          <div className="flex items-center gap-3">
            <CompanyMark
              name={seller.displayName}
              logoUrl={seller.logoUrl}
              className="h-10 w-10 text-base"
            />
            <div className="min-w-0">
              <p className="truncate text-title-sm leading-tight text-ink">{seller.displayName}</p>
              <p className="truncate text-xxs uppercase tracking-wider text-ink-subtle">
                Seller Hub
              </p>
            </div>
          </div>
        </div>

        <nav
          aria-label="Seller Hub"
          className="flex items-stretch justify-around gap-1 px-2 py-2 lg:flex-col lg:justify-start lg:gap-0.5 lg:px-3 lg:py-0"
        >
          {NAV_ITEMS.map((item) => (
            <RailLink
              key={item.to}
              item={item}
              isDisabled={item.needsApproval && !isTrading}
            />
          ))}
        </nav>

        <div className="hidden border-t border-border-subtle px-3 py-4 lg:block">
          <NavLink
            to="/"
            className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <ShopIcon className="h-5 w-5 shrink-0" />
            <span>Back to the shop</span>
          </NavLink>

          {/* Shuts the Hub without signing out of the shop. The two share one
              account and one browser, so somebody handing the machine over
              needs a way to close this that does not cost them their basket. */}
          <button
            type="button"
            className="mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
            disabled={closeHub.isPending}
            onClick={() => {
              closeHub.mutate();
            }}
          >
            <LockIcon className="h-5 w-5 shrink-0" />
            <span>Close the Hub</span>
          </button>
        </div>
      </aside>

      {/* ---- The working area -------------------------------------------- */}
      <div className="order-1 flex min-w-0 flex-1 flex-col lg:order-2">
        <header className="sticky top-0 z-10 border-b border-border bg-surface/95 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              {/* Repeated from the rail on purpose: below `lg` the rail's head
                  is hidden and this is the only place the seller's own company
                  appears on the screen they are working in. */}
              <CompanyMark
                name={seller.displayName}
                logoUrl={seller.logoUrl}
                className="h-9 w-9 text-sm lg:hidden"
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">{seller.displayName}</p>
                <p className="truncate text-xxs text-ink-subtle">{seller.legalName}</p>
              </div>
              <Badge tone={applicationStatusTone(seller.status)}>
                {t(applicationStatusKey(seller.status))}
              </Badge>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <NavLink
                to="/"
                className="inline-flex h-9 items-center gap-2 rounded-md border border-border-strong bg-surface px-3 text-sm font-medium text-ink hover:bg-surface-hover lg:hidden"
              >
                <ShopIcon className="h-4 w-4" />
                Shop
              </NavLink>
              <NavLink
                to="/seller/listings/new"
                className={cx(
                  'inline-flex h-9 items-center rounded-md px-3.5 text-sm font-medium',
                  isTrading
                    ? 'bg-brand-fill text-white hover:bg-brand-fill-hover'
                    : 'pointer-events-none bg-ink-subtle text-white opacity-60',
                )}
                aria-disabled={!isTrading}
              >
                Add listing
              </NavLink>
            </div>
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl space-y-6">
            {/* Keyed on the path so the banner re-announces itself to a screen
                reader on navigation rather than being read once and forgotten. */}
            <ApplicationBanner key={location.pathname} seller={seller} />
            <Outlet context={seller} />
          </div>
        </main>
      </div>
    </div>
  );
}

/** What a page below this layout receives. Typed for `useOutletContext`. */
export type SellerOutletContext = SellerIdentity;

/**
 * A small helper for the pages that need a control disabled until approval.
 *
 * Exported here rather than duplicated, because "why is this button greyed
 * out" must have one answer and one sentence.
 */
export function ApprovalRequiredNotice({ seller }: { seller: SellerIdentity }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-surface px-6 py-12 text-center">
      <p className="text-title-sm text-ink">This opens once you are approved</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
        {seller.status === 'DRAFT'
          ? 'Finish your seller application and we will review it. Most applications are decided within a few working days.'
          : seller.status === 'ACTION_REQUIRED'
            ? 'Your application needs a few changes before we can approve it.'
            : 'Your application is with the marketplace. We will email you as soon as it is decided.'}
      </p>
      <div className="mt-6">
        <Button
          variant="primary"
          onClick={() => {
            window.location.assign('/seller/onboarding');
          }}
        >
          Open your application
        </Button>
      </div>
    </div>
  );
}
