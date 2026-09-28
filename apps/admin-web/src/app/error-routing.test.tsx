/**
 * Full-page errors, wired into this panel's routing: the real route table,
 * the 404 inside the shell, the 403 from the permission guard, and the
 * app-wide boundary.
 */
// This app registers no jest-dom matchers globally; this file opts in.
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequirePermission } from '@/auth/guards';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { i18n } from '@/i18n/config';
import { Permission } from '@/lib/permissions';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { ErrorBoundary } from './ErrorBoundary';
import { router } from './router';

const SECRET = 'at /srv/app/node_modules/prisma: password=hunter2';

function Throws(): React.JSX.Element {
  throw new Error(SECRET);
}

function withProviders(ui: React.JSX.Element, canAny = true): React.JSX.Element {
  const session = { canAny: () => canAny } as unknown as SessionState;
  return (
    <I18nextProvider i18n={i18n}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={['/reports/secret-screen']}>{ui}</MemoryRouter>
      </SessionContext.Provider>
    </I18nextProvider>
  );
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the route table', () => {
  type Route = (typeof router.routes)[number];

  function walk(routes: readonly Route[], visit: (route: Route) => void): void {
    for (const route of routes) {
      visit(route);
      if (route.children !== undefined) walk(route.children, visit);
    }
  }

  it('gives every lazily-loaded screen an error element of its own', () => {
    const missing: string[] = [];
    walk(router.routes, (route) => {
      if (route.lazy !== undefined && route.errorElement === undefined) missing.push(route.path ?? '(index)');
    });
    expect(missing).toEqual([]);
  });

  it('gives the shell and the signed-out screens a full-screen error element', () => {
    const topLevel = router.routes.filter((route) => route.errorElement === undefined);
    expect(topLevel.map((route) => route.path)).toEqual([]);
  });

  it('ends the shell in a 404 page, not a redirect', () => {
    const shell = router.routes.find((route) => route.path === '/');
    const catchAll = shell?.children?.find((child) => child.path === '*');
    expect((catchAll?.element as React.JSX.Element | undefined)?.type).toBe(NotFoundPage);
  });
});

describe('an unknown screen', () => {
  it('says so, and offers the dashboard rather than a search', () => {
    render(withProviders(<NotFoundPage />));

    expect(screen.getByRole('heading', { name: 'This page has gone missing' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('search')).toBeNull();
  });
});

describe('a screen the account may not open', () => {
  it('shows the 403 without naming the screen or the permission', () => {
    render(
      withProviders(
        <RequirePermission anyOf={[Permission.PRODUCT_READ]}>
          <p>the protected report</p>
        </RequirePermission>,
        false,
      ),
    );

    expect(screen.getByRole('heading', { name: 'Access restricted' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute('href', '/');
    expect(document.body.textContent).not.toContain('the protected report');
    expect(document.body.textContent).not.toContain('secret-screen');
    expect(document.body.textContent).not.toMatch(/product/i);
  });

  it('renders the screen when the account may open it', () => {
    render(
      withProviders(
        <RequirePermission anyOf={[Permission.PRODUCT_READ]}>
          <p>the protected report</p>
        </RequirePermission>,
      ),
    );
    expect(screen.getByText('the protected report')).toBeInTheDocument();
  });
});

describe('the app-wide boundary', () => {
  it('fills the screen with the same page, and none of the crash', () => {
    render(
      <ErrorBoundary>
        <Throws />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('hunter2');
  });
});
