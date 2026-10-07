/**
 * The frame every screen sits in.
 *
 * A sidebar on a desktop, a drawer on a phone, and one `<main>` that every
 * route renders into. The sidebar is `components/ui/sidebar.tsx` — a rail of
 * icons that widens to labelled rows while a pointer or the keyboard is inside
 * it — and it is the same component the admin console and the storefront's
 * account area use, so every surface navigates the same way.
 *
 * Two things this does that are easy to leave out and expensive to add
 * later:
 *
 *   - **A skip link.** The first focusable thing on the page, visible only
 *     when focused. Without it a keyboard user tabs through the whole sidebar
 *     on every navigation.
 *   - **A live region for route changes.** A single-page application changes
 *     the whole screen without the page-load announcement a screen reader
 *     relies on; this says where they have arrived.
 */
import { useEffect, useRef, useState } from 'react';
import { Outlet, NavigationType, useLocation, useNavigationType } from 'react-router-dom';
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
import type { ConsoleSession } from '@/lib/types';
import { roleLabel } from '@/lib/labels';
import type { Translate } from '@/i18n/i18n-context';
import { locateRoute, visibleNavigation } from './navigation';
import { NotificationBell } from './NotificationBell';
import { BrandLockup } from './BrandLockup';

export function AppShell(): React.JSX.Element {
  const { t } = useI18n();
  const { session, signOut, canAny } = useSession();
  const location = useLocation();
  const navigationType = useNavigationType();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  // Close the drawer on navigation. Leaving it open over the new screen is the
  // single most common mobile-navigation bug.
  //
  // And start a new page at the top: a single-page app keeps the old scroll
  // position otherwise, so a consignment opened from far down a list opened
  // halfway down. Back and forward (POP) are left to the browser.
  useEffect(() => {
    setDrawerOpen(false);
    if (navigationType !== NavigationType.Pop) window.scrollTo({ top: 0, behavior: 'instant' });
  }, [location.pathname, navigationType]);

  const sections = visibleNavigation(canAny);
  const active = locateRoute(location.pathname);

  return (
    // No background of its own: the body's tinted ground and wash show through.
    <div className="min-h-screen text-ink">
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
                {session === null ? '' : organisationName(session, t)}
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
  onNavigate,
}: {
  sections: ReturnType<typeof visibleNavigation>;
  onNavigate: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { session } = useSession();

  return (
    <>
      <div className="flex flex-1 flex-col">
        <BrandLockup collapsible />

        <div className="mt-6 space-y-4">
          {sections.map((section, index) => (
            <SidebarSection
              key={section.labelKey ?? `section-${String(index)}`}
              label={section.labelKey === null ? null : t(section.labelKey)}
            >
              {section.entries.map((entry) => {
                const label = t(entry.labelKey);

                return (
                  <SidebarLink
                    key={entry.to}
                    onNavigate={onNavigate}
                    link={{
                      to: entry.to,
                      label,
                      icon: entry.icon,
                      matchPrefix: true,
                    }}
                  />
                );
              })}
            </SidebarSection>
          ))}
        </div>
      </div>

      {/* Who is signed in, and for which agency. The top bar says the same
          thing in full; at sixty pixels this is the initials alone. */}
      {session === null ? null : (
        <div className="mt-4 shrink-0 border-t border-border pt-3">
          <div className="flex h-10 items-center gap-3 rounded-md px-2">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[0.7rem] font-semibold text-brand ring-1 ring-inset ring-brand/20"
            >
              {organisationName(session, t).slice(0, 2).toUpperCase()}
            </span>
            <SidebarLabel display="block" className="min-w-0 leading-tight">
              <span className="block truncate text-xs font-medium text-ink">
                {organisationName(session, t)}
              </span>
              <span className="block truncate text-[0.7rem] text-ink-subtle">
                {session.user.fullName} · {roleLabel(t, session.member.role)}
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

/**
 * Whose work this person is doing: their agency, or - for the marketplace's
 * own compliance staff, who belong to no agency - the marketplace audit team.
 * Never the product's name.
 */
function organisationName(session: ConsoleSession, t: Translate): string {
  return session.member.agency?.name ?? t('auth.existing.staffTeam');
}
