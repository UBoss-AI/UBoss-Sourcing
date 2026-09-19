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
 * **The sidebar is `components/ui/sidebar.tsx`** — a rail of icons that widens
 * to labelled rows while a pointer or the keyboard is inside it, and the same
 * component the admin console and the logistics portal are framed by. It is a
 * `<nav>` with real headings: this is somebody's map of their own account, and
 * a flat column of eleven links is not a map. The group titles are `<h2>`s
 * here — unlike in the header dropdown, where they are plain paragraphs —
 * because this genuinely is a document region and a screen reader's heading
 * list is a useful way to move around it.
 *
 * **Below `md` it is a drawer rather than nothing.** A two-column layout at
 * 390px is a 140px sidebar squeezing the content that was the point of the
 * page, and hiding the navigation entirely strands somebody who arrived on a
 * deep link with no way to the rest of their account. So on a phone the
 * current page's name is a button that opens the list over the page.
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
import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { Modal } from '@/components/Modal';
import { Button } from '@/components/ui';
import {
  Sidebar,
  SidebarBody,
  SidebarLabel,
  SidebarLink,
  SidebarSection,
} from '@/components/ui/sidebar';
import { MenuIcon, SignOutIcon, UserIcon } from '@/components/icons';
import { useI18n } from '@/i18n/i18n-context';
import { ACCOUNT_NAV, accountNavGroups } from './account-nav';
import type { AccountNavGroup } from './account-nav';
import { useAccountIdentity } from './useAccountIdentity';
import type { AccountIdentity } from './useAccountIdentity';

/**
 * Who this is, at the head of the rail.
 *
 * It was a card of its own above the navigation and it still reads as one at
 * full width; at sixty pixels it is the avatar alone. Never initials taken
 * from an address: a purchasing account is routinely `ops.procurement@`, and
 * "OP" identifies nobody.
 */
function Identity({ identity }: { identity: AccountIdentity }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 px-2">
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand ring-1 ring-inset ring-brand/20"
      >
        <UserIcon className="h-[1.15rem] w-[1.15rem]" />
      </span>

      <SidebarLabel display="block" className="min-w-0 leading-tight">
        <span className="block text-xxs text-ink-muted">{t('account.hello')}</span>
        <span className="block truncate text-sm font-semibold text-ink">
          {identity.fullName ?? identity.email}
        </span>
        {identity.organization !== null && (
          <span className="block truncate text-xxs text-ink-subtle">{identity.organization}</span>
        )}
      </SidebarLabel>
    </div>
  );
}

function NavGroup({
  group,
  onNavigate,
}: {
  group: AccountNavGroup;
  onNavigate: () => void;
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <SidebarSection label={t(group.titleKey)}>
      {group.items.map((item) => (
        <SidebarLink
          key={item.id}
          onNavigate={onNavigate}
          link={{
            to: item.to,
            label: t(item.labelKey),
            icon: item.icon,
            // A detail page belongs to the section its list is in, so
            // /account/orders/ORD-1 keeps "My orders" lit.
            matchPrefix: true,
          }}
        />
      ))}
    </SidebarSection>
  );
}

export function AccountLayout(): React.JSX.Element {
  const { t } = useI18n();
  const { features } = useStorefront();
  const { isCustomer, isLoading, logout } = useSession();
  const location = useLocation();

  const identity = useAccountIdentity(isCustomer);
  const groups = accountNavGroups({ recurringOrders: features.recurringOrders });

  // The drawer, below `md`, and nothing else: the rail widens on hover and
  // keeps that to itself. See `components/ui/sidebar.tsx`.
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isConfirmingSignOut, setIsConfirmingSignOut] = useState(false);

  // Following a row navigates but does not unmount this, so the drawer would
  // stay open over the page it just opened.
  useEffect(() => {
    setIsDrawerOpen(false);
  }, [location.pathname]);

  /**
   * The name of the page we are on, for the control that opens the drawer.
   *
   * Longest match wins, so `/account/orders/ORD-1` is labelled "My orders"
   * rather than falling through to nothing. A detail page is still inside the
   * section its list belongs to, and saying so is more use than saying
   * "Account".
   */
  const current = Object.values(ACCOUNT_NAV)
    .filter((item) => location.pathname.startsWith(item.to))
    .sort((a, b) => b.to.length - a.to.length)[0];

  const closeDrawer = (): void => {
    setIsDrawerOpen(false);
  };

  return (
    <div className="md:flex md:items-start md:gap-6">
      {/* ---------------------------------------------------------------- */}
      {/* The left column                                                  */}
      {/* ---------------------------------------------------------------- */}
      {/* The control that opens the drawer, phones and small tablets only.
          It names the page rather than saying "Menu", because on a phone this
          is also the only thing on screen that says where you are. */}
      <button
        type="button"
        onClick={() => {
          setIsDrawerOpen(true);
        }}
        aria-expanded={isDrawerOpen}
        className="mb-4 flex w-full items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm font-medium text-ink shadow-card transition-colors hover:bg-surface-hover md:hidden"
      >
        <MenuIcon aria-hidden="true" className="h-[1.15rem] w-[1.15rem] shrink-0 text-ink-subtle" />
        <span className="min-w-0 truncate">
          {current === undefined ? t('account.accountMenu') : t(current.labelKey)}
        </span>
      </button>

      <Sidebar open={isDrawerOpen} setOpen={setIsDrawerOpen}>
        <SidebarBody
          label={t('account.accountMenu')}
          closeLabel={t('common.close')}
          // A card rather than a full-height rail: this sits inside the
          // storefront's page, under a header that is already there, so it
          // stops where the page's own content stops.
          className="md:sticky md:top-24 md:max-h-[calc(100vh-8rem)] md:rounded-lg md:border md:shadow-card"
        >
          <div className="flex flex-1 flex-col">
            <Identity identity={identity} />

            <div className="mt-6 space-y-4">
              {groups.map((group) => (
                <NavGroup key={group.titleKey} group={group} onNavigate={closeDrawer} />
              ))}
            </div>
          </div>

          <div className="mt-4 shrink-0 border-t border-border pt-3">
            <button
              type="button"
              onClick={() => {
                setIsConfirmingSignOut(true);
              }}
              // Named on the button, not only in the label: at sixty pixels the
              // label is `display: none`, and a button with no name is a button
              // a screen reader reads out as nothing at all.
              aria-label={t('header.signOut')}
              className="flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium text-ink-muted transition-colors hover:bg-danger-soft hover:text-danger focus-visible:bg-danger-soft focus-visible:text-danger"
            >
              <SignOutIcon aria-hidden="true" className="h-[1.15rem] w-[1.15rem] shrink-0" />
              <SidebarLabel className="truncate">{t('header.signOut')}</SidebarLabel>
            </button>
          </div>
        </SidebarBody>
      </Sidebar>

      {/* ---------------------------------------------------------------- */}
      {/* The right column                                                 */}
      {/* ---------------------------------------------------------------- */}
      {/*
       * `min-w-0`, and it is load bearing.
       *
       * A flex item's default minimum is `auto`, which is its content's
       * min-content — and this column holds order tables and product grids
       * whose min-content is wider than a laptop. Without this the column
       * refuses to shrink and the whole page scrolls sideways, taking the
       * sidebar with it.
       */}
      <div className="min-w-0 md:flex-1">
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
