/**
 * The application shell: sidebar, top bar, and the routed page.
 *
 * Two accessibility decisions worth keeping:
 *   - A skip link is the first focusable element, so a keyboard user reaches
 *     the page without tabbing the whole sidebar every time.
 *   - The sidebar is a real `<nav>` with `aria-current="page"` on the active
 *     link, so the current location is announced and not merely coloured.
 */
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import { Button } from '@/components/ui';
import { cx } from '@/lib/cx';
import { roleLabel } from '@/lib/permissions';
import { visibleNavigation } from './navigation';

function Brand(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5 px-5 py-4">
      <span
        aria-hidden="true"
        className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-xs font-bold text-white"
      >
        U
      </span>
      <span className="text-sm font-semibold tracking-tight text-ink">UBOSS Admin</span>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }): React.JSX.Element {
  const { can } = useSession();
  const groups = visibleNavigation(can);

  return (
    <nav aria-label="Main" className="flex h-full flex-col overflow-y-auto">
      <Brand />

      <div className="flex-1 space-y-6 px-3 pb-6">
        {groups.map((group) => (
          <div key={group.label}>
            <h2 className="px-2 pb-1.5 text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
              {group.label}
            </h2>
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.matchPrefix !== true}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cx(
                        'block rounded-md px-2.5 py-1.5 text-sm transition-colors',
                        isActive
                          ? 'bg-accent-soft font-medium text-accent'
                          : 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
                      )
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

function UserMenu(): React.JSX.Element {
  const { user, logout } = useSession();
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
      toast.error('Sign-out could not reach the server, but you have been signed out here.');
    } finally {
      setIsSigningOut(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => { setIsOpen((open) => !open); }}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink-muted hover:bg-surface-sunken hover:text-ink"
      >
        <span
          aria-hidden="true"
          className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-xxs font-semibold text-accent"
        >
          {user.email.slice(0, 2).toUpperCase()}
        </span>
        <span className="hidden max-w-40 truncate sm:inline">{user.email}</span>
      </button>

      {isOpen && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1.5 w-64 rounded-lg border border-border bg-surface p-1 shadow-popover"
        >
          <div className="border-b border-border px-3 py-2.5">
            <p className="truncate text-sm font-medium text-ink">{user.email}</p>
            <p className="mt-0.5 text-xs text-ink-muted">
              {user.roles.map(roleLabel).join(', ')}
            </p>
          </div>

          <button
            type="button"
            role="menuitem"
            onClick={() => void handleSignOut()}
            disabled={isSigningOut}
            className="mt-1 block w-full rounded px-3 py-2 text-left text-sm text-ink-muted hover:bg-surface-sunken hover:text-ink disabled:opacity-60"
          >
            {isSigningOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}

export function AppShell(): React.JSX.Element {
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  // A single-page app does not reload, so focus stays where it was and a
  // screen reader never learns the page changed. Moving focus to the main
  // region on navigation is what a full page load would have done.
  useEffect(() => {
    setIsMobileNavOpen(false);
    mainRef.current?.focus();
  }, [location.pathname]);

  return (
    <div className="min-h-screen">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <div className="lg:grid lg:grid-cols-[15rem_1fr]">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 hidden h-screen border-r border-border bg-surface lg:block">
          <Sidebar />
        </aside>

        {/* Mobile drawer */}
        {isMobileNavOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div
              className="absolute inset-0 bg-ink/40"
              onClick={() => { setIsMobileNavOpen(false); }}
              aria-hidden="true"
            />
            <aside className="absolute inset-y-0 left-0 w-64 border-r border-border bg-surface">
              <Sidebar onNavigate={() => { setIsMobileNavOpen(false); }} />
            </aside>
          </div>
        )}

        <div className="flex min-h-screen flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur lg:px-6">
            <Button
              variant="ghost"
              size="sm"
              className="lg:hidden"
              onClick={() => { setIsMobileNavOpen(true); }}
              aria-expanded={isMobileNavOpen}
              aria-label="Open navigation"
            >
              Menu
            </Button>

            <div className="flex-1" />
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
