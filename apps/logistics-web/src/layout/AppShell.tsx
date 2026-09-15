/**
 * The frame every screen sits in.
 *
 * A sidebar on a desktop, a drawer on a phone, and one `<main>` that every
 * route renders into. Three things it does that are easy to leave out and
 * expensive to add later:
 *
 *   - **A skip link.** The first focusable thing on the page, visible only
 *     when focused. Without it a keyboard user tabs through the whole sidebar
 *     on every navigation.
 *   - **A live region for route changes.** A single-page application changes
 *     the whole screen without the page-load announcement a screen reader
 *     relies on; this says where they have arrived.
 *   - **A suspension banner that cannot be dismissed.** A suspended carrier
 *     can still finish what it holds and will be offered nothing new, and a
 *     dispatcher who does not know that spends the afternoon wondering why the
 *     work stopped.
 */
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CloseIcon, MenuIcon, SignOutIcon } from '@/components/icons';
import { Badge, Button } from '@/components/ui';
import { ThemeToggle } from '@/components/ThemeToggle';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';
import { useI18n } from '@/i18n/i18n-context';
import { useSession } from '@/auth/session-context';
import { cx } from '@/lib/cx';
import { exceptionsKey, fetchExceptions } from '@/lib/logistics';
import { Permission } from '@/lib/permissions';
import { locateRoute, visibleNavigation } from './navigation';
import { NotificationBell } from './NotificationBell';

export function AppShell(): React.JSX.Element {
  const { t } = useI18n();
  const { session, signOut, canAny } = useSession();
  const location = useLocation();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  // Close the drawer on navigation. Leaving it open over the new screen is the
  // single most common mobile-navigation bug.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const sections = visibleNavigation(canAny);
  const active = locateRoute(location.pathname);

  /*
   * The exception count beside the sidebar entry.
   *
   * Polled rather than pushed, on a slow beat. This is a number that changes
   * when something goes wrong somewhere else, and a dispatcher who has the tab
   * open should see it appear without reloading - but it is not worth a socket
   * and it is certainly not worth a request a second.
   */
  const exceptionCount = useQuery({
    queryKey: exceptionsKey({ openOnly: true, badge: true }),
    queryFn: () => fetchExceptions({ openOnly: true, page: 1 }),
    enabled: canAny(Permission.SHIPMENT_READ),
    refetchInterval: 120_000,
    select: (page) => page.total,
  });

  const suspended = session?.partner.status === 'SUSPENDED';

  return (
    <div className="min-h-screen bg-surface-sunken text-ink">
      {/*
        The first focusable element on the page, and invisible until it has
        focus. `sr-only focus:not-sr-only` is the whole implementation.
      */}
      <a
        href="#main"
        className="sr-only rounded-md bg-brand px-4 py-2 text-sm font-medium text-white focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50"
      >
        {t('shell.skipToContent')}
      </a>

      <div className="flex min-h-screen">
        {/* --- Sidebar, from `lg` up ------------------------------------- */}
        <aside className="hidden w-64 shrink-0 border-r border-border bg-surface lg:block">
          <Brand />
          <NavList sections={sections} active={active} exceptions={exceptionCount.data ?? 0} />
        </aside>

        {/* --- Drawer, below `lg` ---------------------------------------- */}
        {drawerOpen ? (
          <div className="fixed inset-0 z-40 lg:hidden">
            <button
              type="button"
              aria-label={t('shell.closeMenu')}
              className="absolute inset-0 bg-navy/50"
              onClick={() => {
                setDrawerOpen(false);
              }}
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-label={t('shell.menu')}
              className="relative flex h-full w-72 max-w-[85vw] flex-col border-r border-border bg-surface shadow-xl"
            >
              <div className="flex items-center justify-between">
                <Brand />
                <button
                  type="button"
                  className="mr-3 rounded-md p-2 text-ink-muted hover:bg-surface-hover"
                  aria-label={t('shell.closeMenu')}
                  onClick={() => {
                    setDrawerOpen(false);
                  }}
                >
                  <CloseIcon className="h-5 w-5" />
                </button>
              </div>
              <NavList sections={sections} active={active} exceptions={exceptionCount.data ?? 0} />
            </div>
          </div>
        ) : null}

        {/* --- The page -------------------------------------------------- */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-surface/95 px-4 py-3 backdrop-blur lg:px-8">
            <button
              type="button"
              className="rounded-md p-2 text-ink-muted hover:bg-surface-hover lg:hidden"
              aria-label={t('shell.menu')}
              aria-expanded={drawerOpen}
              onClick={() => {
                setDrawerOpen(true);
              }}
            >
              <MenuIcon className="h-5 w-5" />
            </button>

            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-ink">
                {session?.partner.displayName ?? ''}
              </p>
              <p className="truncate text-xs text-ink-subtle">
                {t('shell.signedInAs')} {session?.user.fullName ?? ''}
              </p>
            </div>

            <div className="flex items-center gap-1">
              <NotificationBell />
              <LanguageSwitcher />
              <ThemeToggle />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void signOut();
                }}
              >
                <SignOutIcon className="h-4 w-4" aria-hidden="true" />
                <span className="ml-2 hidden sm:inline">{t('auth.signOut')}</span>
              </Button>
            </div>
          </header>

          {suspended ? (
            <div
              role="status"
              className="border-b border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning lg:px-8"
            >
              {t('shell.suspendedBanner')}
            </div>
          ) : null}

          {/*
            The live region that announces a route change.
            `aria-live="polite"` so it waits for the reader to finish, and the
            key forces it to re-announce on every navigation.
          */}
          <span key={location.pathname} className="sr-only" aria-live="polite">
            {activeLabel(sections, active, t)}
          </span>

          <main id="main" ref={mainRef} tabIndex={-1} className="flex-1 px-4 py-6 lg:px-8 lg:py-8">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}

function Brand(): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="flex items-center gap-3 px-5 py-5">
      {/*
        The mark. A simple parcel-and-route glyph rather than an imported
        image, so it renders before any network request and inherits the theme
        - which matters on a depot's tablet on a bad connection.
      */}
      <span
        aria-hidden="true"
        className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-white shadow-sm"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <path d="M3 8.5 12 4l9 4.5v7L12 20l-9-4.5v-7Z" strokeLinejoin="round" />
          <path d="M3 8.5 12 13l9-4.5M12 13v7" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="text-sm font-semibold tracking-tight text-ink">{t('app.name')}</span>
    </div>
  );
}

function NavList({
  sections,
  active,
  exceptions,
}: {
  sections: ReturnType<typeof visibleNavigation>;
  active: string | null;
  exceptions: number;
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <nav className="flex-1 overflow-y-auto px-3 pb-6" aria-label={t('shell.menu')}>
      {sections.map((section, index) => (
        <div key={section.labelKey ?? `section-${String(index)}`} className="mb-5">
          {section.labelKey === null ? null : (
            <p className="px-3 pb-2 text-[0.7rem] font-semibold uppercase tracking-wider text-ink-subtle">
              {t(section.labelKey)}
            </p>
          )}

          <ul className="space-y-0.5">
            {section.entries.map((entry) => {
              const Icon = entry.icon;
              const isActive = active === entry.to;

              return (
                <li key={entry.to}>
                  <NavLink
                    to={entry.to}
                    // `aria-current` is what a screen reader uses to say "you
                    // are here"; the colour alone says it only to people who
                    // can see it.
                    aria-current={isActive ? 'page' : undefined}
                    className={cx(
                      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                      isActive
                        ? 'bg-brand-soft font-medium text-brand'
                        : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="flex-1 truncate">{t(entry.labelKey)}</span>
                    {entry.badge === 'exceptions' && exceptions > 0 ? (
                      <Badge tone="warning">{exceptions}</Badge>
                    ) : null}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** The label of the screen just navigated to, for the live region. */
function activeLabel(
  sections: ReturnType<typeof visibleNavigation>,
  active: string | null,
  t: (key: never) => string,
): string {
  if (active === null) return '';

  for (const section of sections) {
    for (const entry of section.entries) {
      if (entry.to === active) return t(entry.labelKey as never);
    }
  }

  return '';
}
