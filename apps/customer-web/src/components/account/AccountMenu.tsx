/**
 * The account menu under the profile button in the header.
 *
 * A guest gets a Sign in button instead. Not a menu with one item in it and
 * not a disabled avatar: there is exactly one thing a stranger can do here,
 * and a control that offers one action should be that action.
 *
 * Four decisions worth keeping.
 *
 * **It is a disclosure, not an ARIA menu.** `role="menu"` promises a composite
 * widget: Tab enters it once and the arrow keys move between items, per the
 * ARIA authoring practices. This is a list of links inside headed groups, and
 * announcing it as a menu would describe keyboard behaviour it does not have —
 * and would replace "link" in each announcement, so a user who cannot tell
 * that following an item navigates has been told less, not more.
 * `aria-expanded` plus a `<nav>` is the whole contract.
 *
 * **It is grouped, and the groups are headings.** Eleven links in one column
 * is a list nobody scans; they read from the top until something matches. The
 * headings are `<p>` elements referenced by each group's `aria-labelledby`
 * rather than `<h3>`s, because the header is not a document section and a
 * screen reader's heading list should not fill up with "Payments" every time
 * somebody opens this.
 *
 * **The current page is marked.** `NavLink` sets `aria-current="page"`, and the
 * fill is what says it visually. Somebody who opens this from inside the
 * account area is asking "where am I and what else is there", and half that
 * question is answered by showing where they are.
 *
 * **Signing out asks first.** It is a destructive-feeling action sitting one
 * pixel under "Notifications" in a list people scan quickly, and on a shared
 * purchasing machine an accidental sign-out costs somebody their basket. The
 * confirmation is a real dialog rather than a second click on the same button,
 * because a control that changes meaning when you press it is worse than one
 * that asks.
 *
 * Two presentations, one DOM: an anchored dropdown from `sm`, a bottom sheet
 * below it. See `MarketMenu`, which does the same thing for the same reason.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { Modal } from '@/components/Modal';
import { Button } from '@/components/ui';
import { ChevronDownIcon, CloseIcon, SignOutIcon, UserIcon } from '@/components/icons';
import { cx } from '@/lib/cx';
import { useI18n } from '@/i18n/i18n-context';
import { accountMenuGroups } from '@/pages/account/account-nav';
import { useAccountIdentity } from '@/pages/account/useAccountIdentity';

export function AccountMenu(): React.JSX.Element {
  const { isCustomer, isLoading, logout } = useSession();
  const { features } = useStorefront();
  const { t } = useI18n();
  const location = useLocation();

  const [isOpen, setIsOpen] = useState(false);
  const [isConfirmingSignOut, setIsConfirmingSignOut] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Generated rather than a literal: the header renders once, but a literal id
  // is the kind that survives into a second instance and quietly makes
  // `aria-controls` point at whichever one the browser found first.
  const panelId = useId();

  const identity = useAccountIdentity(isCustomer);

  const close = (): void => {
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  // Close on outside click or Escape. Without the Escape handler a keyboard
  // user who opens the menu has no way back out.
  useEffect(() => {
    if (!isOpen) return undefined;

    const onPointerDown = (event: MouseEvent): void => {
      if (containerRef.current?.contains(event.target as Node) !== true) setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setIsOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  // Following a link inside the panel navigates but does not unmount this, so
  // the panel would stay open over the page it just opened. Closing on a route
  // change is one rule instead of an onClick on every item.
  useEffect(() => {
    setIsOpen(false);
  }, [location.pathname]);

  if (!isCustomer) {
    return (
      <Link
        to="/login"
        className="inline-flex h-10 shrink-0 items-center gap-2 rounded-md border border-border-strong bg-surface px-3 text-sm font-medium text-ink shadow-card transition-colors hover:border-border-hover hover:bg-surface-hover sm:px-4"
      >
        <UserIcon className="h-[1.15rem] w-[1.15rem] text-ink-muted" />
        {t('header.signIn')}
      </Link>
    );
  }

  const groups = accountMenuGroups({ recurringOrders: features.recurringOrders });

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (isOpen) close();
          else setIsOpen(true);
        }}
        aria-expanded={isOpen}
        aria-controls={panelId}
        /*
         * Named explicitly, rather than by letting the visible label and an
         * `sr-only` addendum concatenate.
         *
         * Left to the DOM the name came out "Priya Account", which says
         * neither what this is nor whose it is. It has to say what pressing it
         * opens, because below `sm` the visible label collapses to a glyph —
         * and it carries the name where there is one, so somebody on a shared
         * machine can hear whose account they are about to open.
         */
        aria-label={
          identity.shortName === null
            ? t('account.group.yourAccount')
            : t('header.accountFor', { name: identity.shortName })
        }
        className="flex h-10 max-w-[12rem] items-center gap-2 rounded-md px-2 text-sm font-medium text-ink transition-colors hover:bg-surface-hover sm:px-2.5"
      >
        <UserIcon aria-hidden="true" className="h-5 w-5 shrink-0 text-ink-muted" />

        {/*
         * The name, not the email, and not the initials.
         *
         * A purchasing account is routinely `ops.procurement@` — initials
         * taken from that are "OP", which identifies nobody, and the whole
         * address is 30 characters of header. The greeting name is the first
         * word of whatever they typed into their profile, and where there is
         * none the word "Account" is honest and short. It is hidden below `sm`
         * where the header has four controls to fit.
         */}
        <span className="hidden min-w-0 truncate sm:inline">
          {identity.shortName ?? t('header.account')}
        </span>

        <ChevronDownIcon
          aria-hidden="true"
          className={cx('h-4 w-4 shrink-0 text-ink-subtle transition-transform', isOpen && 'rotate-180')}
        />
      </button>

      {/* The scrim, phones only. A `<button>` rather than a div with a click
          handler, so dismissing by tapping outside is reachable without a
          pointer — see MarketMenu, which explains this at length. */}
      {isOpen && (
        <button
          type="button"
          onClick={close}
          className="fixed inset-0 z-40 cursor-default bg-ink/30 backdrop-blur-[2px] sm:hidden"
        >
          <span className="sr-only">{t('common.close')}</span>
        </button>
      )}

      {isOpen && (
        <nav
          id={panelId}
          aria-label={t('account.group.yourAccount')}
          className={cx(
            'z-50 flex flex-col overflow-hidden border border-border bg-surface shadow-popover',
            'fixed inset-x-0 bottom-0 max-h-[85vh] rounded-t-2xl',
            'sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:mt-2 sm:max-h-[34rem] sm:w-64 sm:rounded-lg',
          )}
        >
          {/* --- Who this is ---------------------------------------------- */}
          <div className="flex items-start gap-3 border-b border-border px-4 py-3">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand ring-1 ring-inset ring-brand/20"
            >
              <UserIcon className="h-5 w-5" />
            </span>

            <span className="min-w-0 flex-1">
              {identity.fullName !== null && (
                <span className="block truncate text-sm font-semibold text-ink">
                  {identity.fullName}
                </span>
              )}
              <span className="block truncate text-xs text-ink-muted">{identity.email}</span>
              {identity.organization !== null && (
                <span className="mt-0.5 block truncate text-xs text-ink-subtle">
                  {identity.organization}
                </span>
              )}
            </span>

            {/* Only on the sheet. A dropdown is dismissed by clicking away or
                by Escape; a sheet covering the bottom half of a phone needs a
                visible way out that is not a gesture. */}
            <button
              type="button"
              onClick={close}
              aria-label={t('common.close')}
              className="-m-1 shrink-0 rounded p-1 text-ink-subtle transition-colors hover:text-ink sm:hidden"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>

          {/* --- Where they can go ---------------------------------------- */}
          <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
            {groups.map((group) => (
              <MenuGroup key={group.titleKey} group={group} />
            ))}
          </div>

          {/* --- The way out --------------------------------------------- */}
          <div className="border-t border-border p-1.5">
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                setIsConfirmingSignOut(true);
              }}
              className="flex w-full items-center gap-3 rounded px-3 py-2.5 text-left text-sm font-medium text-ink-muted transition-colors hover:bg-danger-soft hover:text-danger focus-visible:bg-danger-soft focus-visible:text-danger"
            >
              <SignOutIcon aria-hidden="true" className="h-[1.15rem] w-[1.15rem] shrink-0" />
              {t('header.signOut')}
            </button>
          </div>
        </nav>
      )}

      {/* Mounted only while open: a closed `<dialog>` in this design system is
          still `display: flex` — the Modal sets it for its own column layout —
          so it would otherwise sit visible under the header. */}
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

// ---------------------------------------------------------------------------

function MenuGroup({
  group,
}: {
  group: ReturnType<typeof accountMenuGroups>[number];
}): React.JSX.Element {
  const { t } = useI18n();
  const headingId = useId();

  return (
    <div
      // A labelled group rather than a bare `<ul>` with a heading beside it:
      // this is what lets a screen reader say "Payments, list, 3 items" when
      // the cursor enters it, which is the whole benefit of grouping.
      role="group"
      aria-labelledby={headingId}
      className="border-b border-border-subtle py-1 last:border-b-0"
    >
      <p
        id={headingId}
        className="px-4 pb-1 pt-1.5 text-xxs font-semibold uppercase tracking-wider text-ink-subtle"
      >
        {t(group.titleKey)}
      </p>

      <ul>
        {group.items.map((item) => {
          const Mark = item.icon;

          return (
            <li key={item.id}>
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  cx(
                    'mx-1.5 flex items-center gap-3 rounded px-2.5 py-2 text-sm transition-colors',
                    isActive
                      ? 'bg-brand-soft font-semibold text-brand'
                      : 'text-ink-muted hover:bg-surface-hover hover:text-ink focus-visible:bg-surface-hover focus-visible:text-ink',
                  )
                }
              >
                <Mark aria-hidden="true" className="h-[1.15rem] w-[1.15rem] shrink-0" />
                <span className="min-w-0 truncate">{t(item.menuLabelKey)}</span>
              </NavLink>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
