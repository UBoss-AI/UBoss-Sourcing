/**
 * The frame every screen sits in.
 *
 * A sidebar on a desktop, a drawer on a phone, and one `<main>` that every
 * route renders into. The sidebar is `components/ui/sidebar.tsx` — a rail of
 * icons that widens to labelled rows while a pointer or the keyboard is inside
 * it — and it is the same component the admin console and the storefront's
 * account area use, so the three surfaces navigate the same way.
 *
 * Three things this does that are easy to leave out and expensive to add
 * later:
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
import { Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { MenuIcon, SignOutIcon } from '@/components/icons';
import { Button } from '@/components/ui';
import {
  Sidebar,
  SidebarBody,
  SidebarLabel,
  SidebarLink,
  SidebarSection,
} from '@/components/ui/sidebar';
import { ThemeToggle } from '@/components/ThemeToggle';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';
import { useI18n } from '@/i18n/i18n-context';
import { useSession } from '@/auth/session-context';
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
        {/* --- The rail from `md` up, a drawer below it ------------------- */}
        <Sidebar open={drawerOpen} setOpen={setDrawerOpen}>
          <SidebarBody
            label={t('shell.menu')}
            closeLabel={t('shell.closeMenu')}
            className="md:sticky md:top-0 md:h-screen"
          >
            <PortalNav
              sections={sections}
              exceptions={exceptionCount.data ?? 0}
              onNavigate={() => {
                setDrawerOpen(false);
              }}
            />
          </SidebarBody>
        </Sidebar>

        {/* --- The page -------------------------------------------------- */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-surface/95 px-4 py-3 backdrop-blur lg:px-8">
            <button
              type="button"
              className="rounded-md p-2 text-ink-muted hover:bg-surface-hover md:hidden"
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
              <LanguageSwitcher placement="header" />
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
    <div className="flex h-10 shrink-0 items-center gap-3 px-2">
      {/*
        The mark. A simple parcel-and-route glyph rather than an imported
        image, so it renders before any network request and inherits the theme
        - which matters on a depot's tablet on a bad connection. At sixty
        pixels it is the whole of the brand, which is the one thing on the rail
        that still says which portal this is.
      */}
      <span
        aria-hidden="true"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-brand text-white shadow-sm"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <path d="M3 8.5 12 4l9 4.5v7L12 20l-9-4.5v-7Z" strokeLinejoin="round" />
          <path d="M3 8.5 12 13l9-4.5M12 13v7" strokeLinejoin="round" />
        </svg>
      </span>
      <SidebarLabel className="truncate text-sm font-semibold tracking-tight text-ink">
        {t('app.name')}
      </SidebarLabel>
    </div>
  );
}

/**
 * The rows, in both presentations.
 *
 * Rendered once into the rail and once into the drawer — the shared component
 * mounts this twice — so nothing here may assume which of the two it is in.
 *
 * `aria-current="page"` is what a screen reader uses to say "you are here";
 * the colour alone says it only to people who can see it. `NavLink` sets it,
 * and matching a prefix is what keeps Shipments lit on a shipment.
 */
function PortalNav({
  sections,
  exceptions,
  onNavigate,
}: {
  sections: ReturnType<typeof visibleNavigation>;
  exceptions: number;
  onNavigate: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { session } = useSession();

  return (
    <>
      <div className="flex flex-1 flex-col">
        <Brand />

        <div className="mt-6 space-y-4">
          {sections.map((section, index) => (
            <SidebarSection
              key={section.labelKey ?? `section-${String(index)}`}
              label={section.labelKey === null ? null : t(section.labelKey)}
            >
              {section.entries.map((entry) => {
                const label = t(entry.labelKey);
                const waiting = entry.badge === 'exceptions' ? exceptions : 0;

                return (
                  <SidebarLink
                    key={entry.to}
                    onNavigate={onNavigate}
                    link={{
                      to: entry.to,
                      label,
                      icon: entry.icon,
                      matchPrefix: true,
                      badge: waiting,
                      // The count in words, not only in a pill: a screen reader
                      // otherwise gets the destination and none of the reason
                      // it is worth opening now rather than later.
                      ariaLabel:
                        waiting > 0 ? `${label} — ${t('shell.attention', { waiting })}` : undefined,
                    }}
                  />
                );
              })}
            </SidebarSection>
          ))}
        </div>
      </div>

      {/* Who is signed in, and for which carrier. The top bar says the same
          thing in full; at sixty pixels this is the initials alone, which is
          what a dispatcher with two portals open is checking. */}
      {session === null ? null : (
        <div className="mt-4 shrink-0 border-t border-border pt-3">
          <div className="flex h-10 items-center gap-3 rounded-md px-2">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[0.7rem] font-semibold text-brand ring-1 ring-inset ring-brand/20"
            >
              {session.partner.displayName.slice(0, 2).toUpperCase()}
            </span>
            <SidebarLabel display="block" className="min-w-0 leading-tight">
              <span className="block truncate text-xs font-medium text-ink">
                {session.partner.displayName}
              </span>
              <span className="block truncate text-[0.7rem] text-ink-subtle">
                {session.user.fullName}
              </span>
            </SidebarLabel>
          </div>
        </div>
      )}
    </>
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
