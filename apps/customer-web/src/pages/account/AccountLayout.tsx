/**
 * The frame every account screen sits in: who you are on the left, what you
 * asked for on the right.
 *
 * It is a route layout rather than a component each page imports, which is
 * what makes the sidebar survive a navigation instead of unmounting and
 * remounting under it — the scroll position holds, the profile read is not
 * repeated, and the active row moves rather than the whole column redrawing.
 *
 * Four decisions worth keeping.
 *
 * **The sidebar is a `<nav>` with real headings.** It is somebody's map of
 * their own account, and a flat column of eleven links is not a map. The group
 * titles are `<h2>`s here — unlike in the header dropdown, where they are
 * plain paragraphs — because this genuinely is a document region and a screen
 * reader's heading list is a useful way to move around it.
 *
 * **Below `lg` it collapses, and it collapses to a disclosure rather than to
 * nothing.** A two-column layout at 390px is a 140px sidebar squeezing the
 * content that was the point of the page, and hiding the navigation entirely
 * strands somebody who arrived on a deep link with no way to the rest of their
 * account. So on a phone the current page's name is a button that opens the
 * list.
 *
 * **The list comes from `account-nav.ts` and nowhere else.** The header
 * dropdown reads the same table. Two hand-written arrays is how the header
 * ends up offering a screen this sidebar has forgotten.
 *
 * **The whole subtree is behind `RequireCustomer`** — see `app/router.tsx`,
 * where the layout route carries the guard so no child can be reached without
 * it. Every API this section calls checks the session again on the server; the
 * guard is what stops the *page* rendering, not what protects the data.
 */
import { useEffect, useId, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { Modal } from '@/components/Modal';
import { Button } from '@/components/ui';
import { ChevronDownIcon, SignOutIcon, UserIcon } from '@/components/icons';
import { cx } from '@/lib/cx';
import { useI18n } from '@/i18n/i18n-context';
import { ACCOUNT_NAV, accountNavGroups } from './account-nav';
import type { AccountNavGroup } from './account-nav';
import { useAccountIdentity } from './useAccountIdentity';

/** The row treatment, shared by both presentations so they cannot diverge. */
function navRowClass({ isActive }: { isActive: boolean }): string {
  return cx(
    'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
    isActive
      ? // A filled row, not a recoloured word. "Where am I" is the question
        // this column exists to answer, and a colour change on one item in a
        // list of eleven answers it faintly. `NavLink` also sets
        // `aria-current="page"`, so the state is carried for a screen reader
        // and not only in the fill.
        'bg-brand-soft font-semibold text-brand'
      : 'text-ink-muted hover:bg-surface-hover hover:text-ink focus-visible:bg-surface-hover focus-visible:text-ink',
  );
}

function NavGroup({ group }: { group: AccountNavGroup }): React.JSX.Element {
  const { t } = useI18n();
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="border-b border-border-subtle px-2 py-3 last:border-b-0">
      <h2
        id={headingId}
        className="px-3 pb-1.5 text-xxs font-semibold uppercase tracking-wider text-ink-subtle"
      >
        {t(group.titleKey)}
      </h2>

      <ul>
        {group.items.map((item) => {
          const Mark = item.icon;

          return (
            <li key={item.id}>
              <NavLink to={item.to} className={navRowClass}>
                <Mark aria-hidden="true" className="h-[1.15rem] w-[1.15rem] shrink-0" />
                <span className="min-w-0 truncate">{t(item.labelKey)}</span>
              </NavLink>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function AccountLayout(): React.JSX.Element {
  const { t } = useI18n();
  const { features } = useStorefront();
  const { isCustomer, isLoading, logout } = useSession();
  const location = useLocation();

  const identity = useAccountIdentity(isCustomer);
  const groups = accountNavGroups({ recurringOrders: features.recurringOrders });

  const [isNavOpen, setIsNavOpen] = useState(false);
  const [isConfirmingSignOut, setIsConfirmingSignOut] = useState(false);
  const navId = useId();

  // Following a link inside the collapsed list navigates but does not unmount
  // this, so the list would stay open over the page it just opened.
  useEffect(() => {
    setIsNavOpen(false);
  }, [location.pathname]);

  /**
   * The name of the page we are on, for the collapsed control.
   *
   * Longest match wins, so `/account/orders/ORD-1` is labelled "My orders"
   * rather than falling through to nothing. A detail page is still inside the
   * section its list belongs to, and saying so is more use than saying
   * "Account".
   */
  const current = Object.values(ACCOUNT_NAV)
    .filter((item) => location.pathname.startsWith(item.to))
    .sort((a, b) => b.to.length - a.to.length)[0];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[17rem_minmax(0,1fr)] lg:items-start">
      {/* ---------------------------------------------------------------- */}
      {/* The left column                                                  */}
      {/* ---------------------------------------------------------------- */}
      <div className="lg:sticky lg:top-24 lg:space-y-4">
        {/* Who this is. A card of its own above the navigation, matching the
            reference layout, and it is the one part of this column that is
            worth its space on a phone as well. */}
        <div className="flex items-center gap-3 rounded-lg border border-border bg-surface p-4 shadow-card">
          <span
            aria-hidden="true"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand ring-1 ring-inset ring-brand/20"
          >
            <UserIcon className="h-6 w-6" />
          </span>

          <div className="min-w-0">
            <p className="text-xs text-ink-muted">{t('account.hello')}</p>
            {/* The name, and the email underneath when there is no name. Never
                initials taken from an address: a purchasing account is
                routinely `ops.procurement@`, and "OP" identifies nobody. */}
            <p className="truncate text-sm font-semibold text-ink">
              {identity.fullName ?? identity.email}
            </p>
            {identity.organization !== null && (
              <p className="truncate text-xs text-ink-subtle">{identity.organization}</p>
            )}
          </div>
        </div>

        {/* The collapsed control, phones and tablets only. */}
        <button
          type="button"
          onClick={() => {
            setIsNavOpen((open) => !open);
          }}
          aria-expanded={isNavOpen}
          aria-controls={navId}
          className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm font-medium text-ink shadow-card transition-colors hover:bg-surface-hover lg:hidden"
        >
          <span className="min-w-0 truncate">
            {current === undefined ? t('account.accountMenu') : t(current.labelKey)}
          </span>
          <ChevronDownIcon
            aria-hidden="true"
            className={cx('h-4 w-4 shrink-0 text-ink-subtle transition-transform', isNavOpen && 'rotate-180')}
          />
        </button>

        <nav
          id={navId}
          aria-label={t('account.accountMenu')}
          // `hidden` under `lg` unless opened; always visible from `lg`. The
          // attribute is toggled rather than the element unmounted, so
          // `aria-controls` above always points at something that exists.
          className={cx(
            'overflow-hidden rounded-lg border border-border bg-surface shadow-card',
            !isNavOpen && 'hidden lg:block',
            // The card above already provides the top margin at `lg`; on a
            // phone the disclosure button is directly above this.
            'mt-3 lg:mt-0',
          )}
        >
          {groups.map((group) => (
            <NavGroup key={group.titleKey} group={group} />
          ))}

          <div className="border-t border-border p-2">
            <button
              type="button"
              onClick={() => {
                setIsConfirmingSignOut(true);
              }}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-medium text-ink-muted transition-colors hover:bg-danger-soft hover:text-danger focus-visible:bg-danger-soft focus-visible:text-danger"
            >
              <SignOutIcon aria-hidden="true" className="h-[1.15rem] w-[1.15rem] shrink-0" />
              {t('header.signOut')}
            </button>
          </div>
        </nav>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* The right column                                                 */}
      {/* ---------------------------------------------------------------- */}
      {/*
       * `min-w-0`, and it is load bearing.
       *
       * A grid track's default minimum is `auto`, which is its content's
       * min-content — and this column holds order tables and product grids
       * whose min-content is wider than a laptop. Without this the track
       * refuses to shrink and the whole page scrolls sideways, taking the
       * sidebar with it.
       */}
      <div className="min-w-0">
        <Outlet />
      </div>

      {isConfirmingSignOut && (
        <Modal
          isOpen
          onClose={() => {
            setIsConfirmingSignOut(false);
          }}
          title={t('account.signOutConfirmTitle')}
          description={t('account.signOutConfirmBody')}
          footer={
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setIsConfirmingSignOut(false);
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                isLoading={isLoading}
                onClick={() => {
                  setIsConfirmingSignOut(false);
                  void logout();
                }}
              >
                {t('header.signOut')}
              </Button>
            </div>
          }
        >
          <p className="text-sm leading-relaxed text-ink-muted">{t('account.signOutKeepsCart')}</p>
        </Modal>
      )}
    </div>
  );
}
