/**
 * The application shell: sidebar, top bar, and the routed page.
 *
 * Accessibility decisions worth keeping:
 *   - A skip link is the first focusable element, so a keyboard user reaches
 *     the page without tabbing the whole sidebar every time.
 *   - The sidebar is a real `<nav>` with `aria-current="page"` on the active
 *     link, so the current location is announced and not merely coloured.
 *   - The mobile drawer is a real modal: focus moves into it, Tab cycles
 *     inside it, Escape closes it, and focus returns to the button that
 *     opened it. A drawer you can tab behind is a drawer a keyboard user
 *     silently falls out of.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  MenuIcon,
  SignOutIcon,
} from '@/components/icons';
import { cx } from '@/lib/cx';
import { roleLabel } from '@/lib/permissions';
import { translateKey, useI18n } from '@/i18n/i18n-context';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';
import { MarketIndicator } from './MarketIndicator';
import { locateRoute, visibleNavigation } from './navigation';
import { ThemeToggle } from '@/components/ThemeToggle';
import { NotificationBell } from './NotificationBell';
import { SessionLocation } from './SessionLocation';

/**
 * The brand block.
 *
 * Two lines rather than one: the mark and the product name are the thing you
 * look at once, and "Admin console" underneath is what tells someone with two
 * UBOSS tabs open which one they are in. The whole block is a link home, since
 * a logo that is not clickable is the single most reliably-attempted dead
 * control in any admin panel.
 */
function Brand({ onNavigate }: { onNavigate?: (() => void) | undefined }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="flex h-16 shrink-0 items-center border-b border-border px-4">
      <Link
        to="/"
        onClick={onNavigate}
        className="flex items-center gap-3 rounded-md py-1 pr-2 transition-colors hover:opacity-90"
      >
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-fill text-sm font-bold tracking-tight text-white shadow-card"
        >
          U
        </span>
        <span className="min-w-0 leading-tight">
          <span className="block text-sm font-semibold tracking-tight text-ink">UBOSS</span>
          <span className="block text-xxs font-medium uppercase tracking-[0.14em] text-ink-subtle">
            {t('shell.adminConsole')}
          </span>
        </span>
      </Link>
    </div>
  );
}

/**
 * The sidebar.
 *
 * White, over a sky-tinted page. It used to be navy, and the reason for the
 * navy still holds: chrome has to be visually apart from the data surface, or
 * the eye re-finds the edge of the table on every page. What changed is which
 * side is which — the page ground is now the tinted one and the sidebar is
 * pure white, so the separation is the same and the panel stops carrying a
 * dark band no other surface in the product answers to.
 *
 * Three signals separate the current page from the other thirteen, because one
 * is never enough: a tinted ground, a brand-blue label and icon against the
 * muted rest, and a rail down the left edge. The rail is what survives a
 * monochrome screen; `aria-current="page"` from NavLink is what survives no
 * screen at all.
 */
function Sidebar({ onNavigate }: { onNavigate?: (() => void) | undefined }): React.JSX.Element {
  const { can } = useSession();
  const { t } = useI18n();
  const groups = visibleNavigation(can);

  return (
    <nav
      aria-label={t('shell.mainNav')}
      className="scrollbar-none flex h-full flex-col overflow-y-auto border-r border-border bg-surface"
    >
      <Brand onNavigate={onNavigate} />

      <div className="flex-1 space-y-5 px-2.5 py-4">
        {groups.map((group) => (
          <div key={group.labelKey}>
            <h2 className="px-3 pb-1.5 text-xxs font-semibold uppercase tracking-[0.12em] text-ink-subtle">
              {translateKey(t, group.labelKey)}
            </h2>
            <ul className="space-y-px">
              {group.items.map((item) => {
                const ItemIcon = item.icon;

                return (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.matchPrefix !== true}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        cx(
                          'group relative flex h-9 items-center gap-2.5 rounded-md pl-3.5 pr-2.5',
                          'text-sm transition-colors',
                          isActive
                            ? // The rail. `before:` rather than a sibling
                              // element so it cannot drift out of step with
                              // the state that draws it.
                              'bg-brand-soft font-medium text-brand ' +
                                'before:absolute before:left-0 before:top-2 before:h-5 before:w-[3px] ' +
                                "before:rounded-full before:bg-brand before:content-['']"
                            : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <ItemIcon
                            className={cx(
                              'h-[1.15rem] w-[1.15rem] shrink-0 transition-colors',
                              isActive ? 'text-brand' : 'text-ink-subtle group-hover:text-ink-muted',
                            )}
                          />
                          <span className="truncate">{translateKey(t, item.labelKey)}</span>
                        </>
                      )}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
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

/**
 * The mobile drawer.
 *
 * A modal, and treated as one. The three things that separate a drawer from a
 * panel that merely slid in:
 *
 *   - Focus moves in on open and back to the trigger on close.
 *   - Tab cycles inside it. Without the cycle, tabbing past the last link
 *     lands on the page behind the scrim, where nothing is visible and every
 *     subsequent keystroke goes somewhere the user cannot see.
 *   - The page behind it does not scroll, so dismissing the drawer does not
 *     also mean finding your place again.
 */
function MobileDrawer({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    closeRef.current?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (panel === null) return;

      // `select` is in the list because the drawer carries the language
      // picker below `sm`. A trap that does not know about a control inside
      // the panel sends Tab past it to the page behind the scrim, which is
      // the exact failure the trap exists to prevent.
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), select:not([disabled])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <div
        className="absolute inset-0 animate-fade-in bg-ink/50"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('shell.navigation')}
        className="absolute inset-y-0 left-0 flex w-[17rem] max-w-[85%] animate-drawer-in flex-col bg-surface shadow-overlay"
      >
        {/* The close button sits over the brand block rather than in a bar of
            its own — a drawer this size cannot spare 48px to say "close" when
            the scrim and Escape both already do. */}
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="absolute right-2 top-3.5 z-10 flex h-9 w-9 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <CloseIcon className="h-5 w-5" />
          <span className="sr-only">{t('shell.closeNavigation')}</span>
        </button>

        <Sidebar onNavigate={onClose} />

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
         * So on a phone it comes down here. This is the navigation, not a
         * settings screen: it is one tap from every page in the panel, which
         * is the whole of what the header placement was protecting.
         */}
        <div className="shrink-0 border-t border-border p-3 sm:hidden">
          <LanguageSwitcher />
        </div>
      </div>
    </div>
  );
}

export function AppShell(): React.JSX.Element {
  const { t } = useI18n();
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  // A single-page app does not reload, so focus stays where it was and a
  // screen reader never learns the page changed. Moving focus to the main
  // region on navigation is what a full page load would have done.
  useEffect(() => {
    setIsMobileNavOpen(false);
    mainRef.current?.focus();
  }, [location.pathname]);

  // Dismissing the drawer without navigating hands focus back to the control
  // that opened it. Navigating away does not: the effect above has already
  // sent focus to the new page, which is where it belongs.
  //
  // Stable across renders on purpose - the drawer keys its focus and
  // scroll-lock effect on this, and a fresh function every render would tear
  // that effect down and rebuild it mid-interaction, snatching focus back to
  // the close button while somebody was tabbing the links.
  const closeMobileNav = useCallback((): void => {
    setIsMobileNavOpen(false);
    menuButtonRef.current?.focus();
  }, []);

  return (
    <div className="min-h-screen">
      <a href="#main" className="skip-link">
        {t('shell.skipToContent')}
      </a>

      <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 hidden h-screen bg-surface lg:block">
          <Sidebar />
        </aside>

        <MobileDrawer isOpen={isMobileNavOpen} onClose={closeMobileNav} />

        <div className="flex min-h-screen min-w-0 flex-col">
          {/* Opaque, not the translucent white this replaced: a sticky bar
              that lets the page through is a bar with table rows sliding
              behind its own text. */}
          <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-border bg-surface px-2 sm:gap-3 sm:px-3 lg:px-6">
            <button
              ref={menuButtonRef}
              type="button"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink lg:hidden"
              onClick={() => {
                setIsMobileNavOpen(true);
              }}
              aria-expanded={isMobileNavOpen}
            >
              <MenuIcon className="h-5 w-5" />
              <span className="sr-only">{t('shell.openNavigation')}</span>
            </button>

            <PageContext />

            <div className="min-w-0 flex-1" />

            {/* On every page, and that is the whole point of it being here
                rather than on the dashboard: a new order is worth knowing
                about while you are standing in Inventory. */}
            <NotificationBell />

            {/* Beside the bell, and on every page for the same reason: somebody
                who moves from a bright floor to a dark office wants the two
                presses to be here, not four screens away in Settings. */}
            <ThemeToggle />

            {/* Where this sign-in came from, and which market that makes the
                panel quote prices for. Two facts, deliberately two chips: one
                is the place a person recognises and the other is a country a
                price depends on, and in a single-market deployment only the
                first of them has anything to say. Both are labels rather than
                controls - neither is a choice - and both render themselves
                away when they would be saying nothing. */}
            <SessionLocation />
            <MarketIndicator />

            {/* Beside the account menu, on every page the bar can hold it.
                The panel is a tool people work in all day; the language it is
                in belongs where they can see and change it, not behind a
                settings screen. Below `sm` there is no room for it up here
                and it moves to the foot of the navigation drawer — which is
                navigation, not a settings screen. See MobileDrawer. */}
            <LanguageSwitcher placement="header" className="hidden sm:flex" />

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
