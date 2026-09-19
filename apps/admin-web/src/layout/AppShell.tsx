/**
 * The application shell: sidebar, top bar, and the routed page.
 *
 * The sidebar is `components/ui/sidebar.tsx` — a rail of icons that widens to
 * labelled rows while a pointer or the keyboard is inside it, and a drawer
 * below `md`. The same component frames the storefront's account area and the
 * logistics portal, so the three surfaces navigate the same way.
 *
 * Accessibility decisions worth keeping:
 *   - A skip link is the first focusable element, so a keyboard user reaches
 *     the page without tabbing the whole sidebar every time.
 *   - The sidebar is a real `<nav>` with `aria-current="page"` on the active
 *     link, so the current location is announced and not merely coloured.
 *   - The mobile drawer is a real modal: focus moves into it, Tab cycles
 *     inside it, Escape closes it, and focus returns to the button that
 *     opened it. A drawer you can tab behind is a drawer a keyboard user
 *     silently falls out of. That now lives in the shared component.
 */
import { useEffect, useRef, useState } from 'react';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  MenuIcon,
  RefreshIcon,
  SignOutIcon,
} from '@/components/icons';
import {
  Sidebar,
  SidebarBody,
  SidebarLabel,
  SidebarLink,
  SidebarSection,
} from '@/components/ui/sidebar';
import { cx } from '@/lib/cx';
import { useAttention, type AttentionView } from '@/lib/attention';
import { roleLabel } from '@/lib/permissions';
import { translateKey, useI18n } from '@/i18n/i18n-context';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';
import { locateRoute, visibleNavigation, type NavItem } from './navigation';
import { ThemeToggle } from '@/components/ThemeToggle';
import { LocaleMenu } from './LocaleMenu';
import { NotificationBell } from './NotificationBell';

/**
 * The brand block, at the top of the rail.
 *
 * Two lines rather than one: the mark and the product name are the thing you
 * look at once, and "Admin console" underneath is what tells someone with two
 * UBOSS tabs open which one they are in. The whole block is a link home, since
 * a logo that is not clickable is the single most reliably-attempted dead
 * control in any admin panel.
 *
 * At sixty pixels the two lines are gone and the mark is the whole of it —
 * which is the one part of the rail that still says which product this is.
 */
function Brand({ onNavigate }: { onNavigate?: (() => void) | undefined }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <Link
      to="/"
      onClick={onNavigate}
      className="relative z-20 flex h-10 shrink-0 items-center gap-3 rounded-md px-2 transition-opacity hover:opacity-90"
    >
      <span
        aria-hidden="true"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-fill text-sm font-bold tracking-tight text-white shadow-card"
      >
        U
      </span>
      <SidebarLabel display="block" className="min-w-0 leading-tight">
        <span className="block text-sm font-semibold tracking-tight text-ink">UBOSS</span>
        <span className="block text-xxs font-medium uppercase tracking-[0.14em] text-ink-subtle">
          {t('shell.adminConsole')}
        </span>
      </SidebarLabel>
    </Link>
  );
}

/**
 * Who is signed in, at the foot of the rail.
 *
 * Not a control: signing out, the roles in full and the address live in the
 * account menu in the top bar, three inches away and on every screen. This is
 * the reassurance an operator wants when they have two consoles open for two
 * deployments — and at sixty pixels it is the avatar alone, which is the same
 * thing the top bar shows.
 */
function SignedInAs(): React.JSX.Element | null {
  const { user } = useSession();

  if (user === null) return null;

  return (
    <div className="flex h-10 items-center gap-3 rounded-md px-2">
      <span
        aria-hidden="true"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xxs font-semibold text-accent ring-1 ring-inset ring-accent/20"
      >
        {user.email.slice(0, 2).toUpperCase()}
      </span>
      <SidebarLabel display="block" className="min-w-0 leading-tight">
        <span className="block truncate text-xs font-medium text-ink">{user.email}</span>
        <span className="block truncate text-xxs text-ink-subtle">
          {user.roles.map(roleLabel).join(', ')}
        </span>
      </SidebarLabel>
    </div>
  );
}

/** How many things are waiting behind one row, across every queue it carries. */
function countFor(item: NavItem, attention: AttentionView | undefined): number {
  if (attention === undefined || item.attentionKeys === undefined) return 0;

  return item.attentionKeys.reduce((total, key) => total + (attention.counts[key] ?? 0), 0);
}

/**
 * The rows, in both presentations.
 *
 * Rendered once into the rail and once into the drawer — the shared component
 * mounts this twice — so nothing here may assume which of the two it is in.
 * `useSidebar` answers that where it matters: the brand block above reads it,
 * and so does the count on a row, which becomes a dot at sixty pixels.
 *
 * The queue counts are one React Query subscription regardless, de-duplicated
 * by key across both copies.
 */
function ConsoleNav({ onNavigate }: { onNavigate: () => void }): React.JSX.Element {
  const { can } = useSession();
  const { t } = useI18n();
  const groups = visibleNavigation(can);
  const attention = useAttention().data;

  return (
    <>
      <div className="flex flex-1 flex-col">
        <Brand onNavigate={onNavigate} />

        <div className="mt-6 space-y-4">
          {groups.map((group) => (
            <SidebarSection key={group.labelKey} label={translateKey(t, group.labelKey)}>
              {group.items.map((item) => {
                const waiting = countFor(item, attention);
                const label = translateKey(t, item.labelKey);

                return (
                  <SidebarLink
                    key={item.to}
                    onNavigate={onNavigate}
                    link={{
                      to: item.to,
                      label,
                      icon: item.icon,
                      matchPrefix: item.matchPrefix,
                      badge: waiting,
                      // The count in words, not only in a pill. Without this a
                      // screen-reader user gets the destination and none of the
                      // reason it is worth going there.
                      ariaLabel:
                        waiting > 0
                          ? `${label} — ${t('shell.attention', { waiting })}`
                          : undefined,
                    }}
                  />
                );
              })}
            </SidebarSection>
          ))}
        </div>
      </div>

      <div className="mt-4 shrink-0 border-t border-border pt-3">
        <SignedInAs />

        {/*
         * The language picker, below `sm` only.
         *
         * It lives beside the account menu in the top bar at every width the
         * bar can hold it, and below `sm` the bar cannot: on a 320px screen
         * the five controls up there came to 351px, and what silently lost
         * the argument was the breadcrumb — it collapsed to zero width, so
         * the one signal a phone has for "which section am I in" was gone
         * while a 106px language select stayed.
         *
         * So on a phone it comes down here. `sm:hidden` is also what keeps it
         * out of the rail: the rail only exists from `md`, which is always at
         * or above `sm`, so this renders in the drawer and nowhere else.
         */}
        <div className="px-1 pt-3 sm:hidden">
          <LanguageSwitcher />
        </div>
      </div>
    </>
  );
}

/**
 * Where you are, in the top bar.
 *
 * Deliberately not the page title: every page already sets one as its `<h1>`
 * a few pixels below, and repeating it is noise. What the `<h1>` cannot say is
 * which *section* the page belongs to — visible in the sidebar on a desktop,
 * and nowhere at all on a phone — so that is what this shows.
 *
 * On a child route it grows a second crumb, and that one is a link: from an
 * order the `<h1>` is the order number, and the way back to the list is worth
 * a permanent control rather than the browser's Back button.
 */
function PageContext(): React.JSX.Element | null {
  const location = useLocation();
  const { t } = useI18n();
  const here = locateRoute(location.pathname);

  if (here === null) return null;

  return (
    <nav aria-label={t('shell.breadcrumb')} className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5">
        {/* `truncate` rather than the bare `whitespace-nowrap` this was: a
            section name is a translated string, and "Katalogverwaltung" in a
            uppercased, letter-spaced xxs on a 320px bar is wider than the
            space there is. Ellipsised it still answers the question; allowed
            to overflow it printed itself over the notification bell. */}
        <li className="min-w-0 truncate text-xxs font-semibold uppercase tracking-[0.12em] text-ink-subtle">
          {translateKey(t, here.group.labelKey)}
        </li>
        {here.isChild && (
          <>
            <li aria-hidden="true" className="flex shrink-0 items-center text-ink-subtle">
              <ChevronRightIcon className="h-3.5 w-3.5" />
            </li>
            <li className="min-w-0">
              <Link
                to={here.item.to}
                className="block truncate rounded text-xs font-medium text-ink-muted underline-offset-2 transition-colors hover:text-accent hover:underline"
              >
                {translateKey(t, here.item.labelKey)}
              </Link>
            </li>
          </>
        )}
      </ol>
    </nav>
  );
}

/**
 * Bring the screen up to date.
 *
 * The panel caches: a list read a minute ago is served from memory so that
 * moving between screens is instant. That is right almost always and wrong in
 * exactly one situation, which happens here every day — two people working the
 * same queue. An operator approves a seller, the seller refreshes their Hub and
 * sees it, and the colleague looking at the same list in the next chair still
 * has yesterday's answer on screen until something happens to invalidate it.
 *
 * So this is the browser's reload button, minus the reload: every query in the
 * panel is marked stale and the ones actually on screen refetch. Deliberately
 * NOT `window.location.reload()`, which would also throw away the scroll
 * position, the open dialog and the half-typed reason in it.
 *
 * It lives in the top bar rather than on each page for the same reason the bell
 * does: the screen somebody needs to refresh is whichever one they are standing
 * on, and a control that exists on four of twenty screens is a control nobody
 * learns.
 */
function RefreshButton(): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const isFetching = useIsFetching() > 0;
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refresh = (): void => {
    setIsRefreshing(true);
    // Not awaited into the button's state: `invalidateQueries` resolves when
    // every refetch it triggered has settled, and a request that hangs would
    // leave the icon spinning for as long as the socket does. The spin is
    // driven by `isFetching` instead, which is the honest signal.
    void queryClient.invalidateQueries();
    // Long enough that a refresh with nothing to fetch still acknowledges the
    // press. A control that visibly does nothing gets pressed again.
    window.setTimeout(() => {
      setIsRefreshing(false);
    }, 600);
  };

  return (
    <button
      type="button"
      onClick={refresh}
      aria-label={t('shell.refresh')}
      title={t('shell.refresh')}
      className={cx(
        'flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-transparent',
        'text-ink-muted transition-colors hover:border-border hover:bg-surface-hover hover:text-ink',
      )}
    >
      <RefreshIcon
        className={cx('h-[1.15rem] w-[1.15rem]', (isRefreshing || isFetching) && 'animate-spin')}
      />
    </button>
  );
}

function UserMenu(): React.JSX.Element {
  const { user, logout } = useSession();
  const { t } = useI18n();
  const toast = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape. Without the Escape handler a keyboard
  // user who opens the menu has no way back out of it.
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

  if (user === null) return <></>;

  const handleSignOut = async (): Promise<void> => {
    setIsSigningOut(true);
    try {
      await logout();
    } catch {
      toast.error(t('shell.signOutCouldNotReachServer'));
    } finally {
      setIsSigningOut(false);
    }
  };

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          setIsOpen((open) => !open);
        }}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        // The trigger is the avatar alone, and the avatar is aria-hidden, so
        // without this the button has no accessible name. The address is what
        // identifies the account, so it is the name.
        aria-label={user.email}
        className={cx(
          'flex h-10 items-center gap-2 rounded-md border border-transparent px-2 text-sm',
          'text-ink-muted transition-colors hover:border-border hover:bg-surface-hover hover:text-ink',
          isOpen && 'border-border bg-surface-hover text-ink',
        )}
      >
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xxs font-semibold text-accent ring-1 ring-inset ring-accent/20"
        >
          {user.email.slice(0, 2).toUpperCase()}
        </span>
        <ChevronDownIcon
          className={cx('h-4 w-4 shrink-0 transition-transform', isOpen && 'rotate-180')}
        />
      </button>

      {isOpen && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1.5 w-64 animate-fade-in rounded-lg border border-border bg-surface p-1 shadow-popover"
        >
          <div className="border-b border-border px-3 py-2.5">
            <p className="truncate text-sm font-medium text-ink">{user.email}</p>
            <p className="mt-0.5 text-xs text-ink-muted">{user.roles.map(roleLabel).join(', ')}</p>
          </div>

          <button
            type="button"
            role="menuitem"
            onClick={() => void handleSignOut()}
            disabled={isSigningOut}
            className="mt-1 flex w-full items-center gap-2.5 rounded px-3 py-2 text-left text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-60"
          >
            <SignOutIcon className="h-4 w-4 shrink-0" />
            {isSigningOut ? t('shell.signingOut') : t('shell.signOut')}
          </button>
        </div>
      )}
    </div>
  );
}

export function AppShell(): React.JSX.Element {
  const { t } = useI18n();
  // The drawer, below `md`, and nothing else: the rail widens on hover and
  // keeps that to itself. See `components/ui/sidebar.tsx`.
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  // A single-page app does not reload, so focus stays where it was and a
  // screen reader never learns the page changed. Moving focus to the main
  // region on navigation is what a full page load would have done.
  //
  // Closing the drawer here is also what dismisses it after a row is followed;
  // focus is not handed back to the menu button in that case, because the line
  // below has already sent it to the new page, which is where it belongs.
  useEffect(() => {
    setIsDrawerOpen(false);
    mainRef.current?.focus();
  }, [location.pathname]);

  return (
    <div className="min-h-screen">
      <a href="#main" className="skip-link">
        {t('shell.skipToContent')}
      </a>

      <div className="flex min-h-screen">
        <Sidebar open={isDrawerOpen} setOpen={setIsDrawerOpen}>
          <SidebarBody
            label={t('shell.mainNav')}
            closeLabel={t('shell.closeNavigation')}
            className="md:sticky md:top-0 md:h-screen"
          >
            <ConsoleNav
              onNavigate={() => {
                setIsDrawerOpen(false);
              }}
            />
          </SidebarBody>
        </Sidebar>

        <div className="flex min-h-screen min-w-0 flex-1 flex-col">
          {/* Opaque, not the translucent white this replaced: a sticky bar
              that lets the page through is a bar with table rows sliding
              behind its own text. */}
          <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-border bg-surface px-2 sm:gap-3 sm:px-3 lg:px-6">
            <button
              type="button"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink md:hidden"
              onClick={() => {
                setIsDrawerOpen(true);
              }}
              aria-expanded={isDrawerOpen}
            >
              <MenuIcon className="h-5 w-5" />
              <span className="sr-only">{t('shell.openNavigation')}</span>
            </button>

            <PageContext />

            <div className="min-w-0 flex-1" />

            {/* On every page, and that is the whole point of it being here
                rather than on the dashboard: a new order is worth knowing
                about while you are standing in Inventory. */}
            {/* Before the bell, because it is the control somebody reaches
                for when the screen in front of them looks stale — most often
                because a colleague has just decided something on it. */}
            <RefreshButton />

            <NotificationBell />

            {/* Beside the bell, and on every page for the same reason: somebody
                who moves from a bright floor to a dark office wants the two
                presses to be here, not four screens away in Settings. */}
            <ThemeToggle />

            {/*
              * Language, the market the panel is pricing against, and where
              * this sign-in was made — one control.
              *
              * It was three: a language `<select>`, a location chip and a
              * market chip. They answer one question between them ("where am
              * I and what am I reading?"), and three of them in a bar that
              * also carries a page title, a bell and an account menu is why
              * the account menu was the first thing to get squeezed on a
              * laptop. The storefront had the same problem with three
              * `<select>`s and one control was the answer there too.
              *
              * The market and the location stay *labels* inside it. Neither is
              * a choice, for reasons that predate this control and are argued
              * in `LocaleMenu`'s own note: a picker over either would let
              * somebody read prices for a market nobody sells in, or claim a
              * place they are not in.
              *
              * Below `sm` there is no room for it up here, and the language
              * moves to the foot of the navigation drawer — which is
              * navigation, not a settings screen. See `ConsoleNav`.
              */}
            <LocaleMenu className="hidden sm:block" />

            <UserMenu />
          </header>

          <main
            id="main"
            ref={mainRef}
            tabIndex={-1}
            className="flex-1 px-4 py-6 outline-none lg:px-6 lg:py-8"
          >
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
