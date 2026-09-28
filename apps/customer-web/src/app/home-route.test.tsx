/**
 * `/` is the one home page, and `/home` is only ever a way to it.
 *
 * The web server answers `/home` with a 301 before the bundle loads; these pin
 * the half that lives in the bundle - the route table, the in-app redirect,
 * where a sign-in lands - and that no link inside the storefront still points
 * at the old address.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, RouterProvider, Routes, createMemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { HomeRedirect } from './HomeRedirect';
import { router } from './router';
import { HOME } from '@/lib/return-target';
import { LoginPage } from '@/pages/LoginPage';
import { makeSession, renderWithProviders } from '@/test/harness';

/** Where the router ended up, printed so a test can read it. */
function Where(): React.JSX.Element {
  const { pathname, search, hash } = useLocation();
  return <p data-testid="where">{`${pathname}${search}${hash}`}</p>;
}

/** The real `/home` rule, next to a stand-in home page that says where it is. */
function miniRouter(entry: string): ReturnType<typeof createMemoryRouter> {
  return createMemoryRouter(
    [
      { path: '/', element: <Where /> },
      { path: '/home', element: <HomeRedirect /> },
    ],
    { initialEntries: [entry] },
  );
}

describe('the route table', () => {
  const store = router.routes[0];
  const children = store?.children ?? [];

  it('renders the home page at /, as a public page', () => {
    const index = children.find((route) => route.index === true);
    expect(index?.lazy).toBeTypeOf('function');
  });

  it('holds no second copy of the home page at /home - only the redirect', () => {
    const home = children.find((route) => route.path === 'home');
    expect(home?.lazy).toBeUndefined();
    expect((home?.element as React.ReactElement | undefined)?.type).toBe(HomeRedirect);
  });

  it('sends every sign-in home to /', () => {
    expect(HOME).toBe('/');
  });
});

describe('/home', () => {
  it('redirects to /', async () => {
    const memory = miniRouter('/home');
    render(<RouterProvider router={memory} />);

    expect(await screen.findByTestId('where')).toHaveTextContent(/^\/$/);
  });

  it('keeps the query string and the fragment', async () => {
    const memory = miniRouter('/home?ref=newsletter&lang=de#offers');
    render(<RouterProvider router={memory} />);

    expect(await screen.findByTestId('where')).toHaveTextContent('/?ref=newsletter&lang=de#offers');
  });

  it('matches /Home and /home/ as well', async () => {
    for (const entry of ['/Home', '/HOME?x=1', '/home/']) {
      const memory = miniRouter(entry);
      const { unmount } = render(<RouterProvider router={memory} />);
      await waitFor(() => {
        expect(memory.state.location.pathname).toBe('/');
      });
      unmount();
    }
  });

  it('replaces the history entry, so Back does not bounce through it', async () => {
    const memory = miniRouter('/home');
    render(<RouterProvider router={memory} />);

    await screen.findByTestId('where');
    expect(memory.state.historyAction).toBe('REPLACE');
  });

  it('leaves / alone - no redirect, no loop, on a first visit or a reload', async () => {
    for (let visit = 0; visit < 2; visit += 1) {
      const memory = miniRouter('/?q=gloves');
      const { unmount } = render(<RouterProvider router={memory} />);

      expect(await screen.findByTestId('where')).toHaveTextContent('/?q=gloves');
      expect(memory.state.historyAction).toBe('POP');
      unmount();
    }
  });

  it('redirects the same way signed in or signed out', async () => {
    for (const session of [makeSession({ user: null, isCustomer: false }), makeSession()]) {
      const { unmount } = renderWithProviders(
        <Routes>
          <Route path="/" element={<Where />} />
          <Route path="/home" element={<HomeRedirect />} />
        </Routes>,
        { session, route: '/home?from=mail' },
      );
      expect(await screen.findByTestId('where')).toHaveTextContent('/?from=mail');
      unmount();
    }
  });
});

describe('signing in', () => {
  async function signIn(route: string): Promise<void> {
    const user = userEvent.setup();
    const login = vi.fn().mockResolvedValue({ next: 'HOME' });
    renderWithProviders(
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Where />} />
      </Routes>,
      { session: makeSession({ user: null, isCustomer: false, login }), route },
    );

    await user.type(screen.getByLabelText(/email address/i), 'asha@example.test');
    await user.type(screen.getByLabelText(/password/i), 'CorrectHorseBattery1');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /sign in/i }));
  }

  it('lands on / when nothing asked for anywhere else', async () => {
    await signIn('/login');

    expect(await screen.findByTestId('where')).toHaveTextContent(/^\/$/);
  });

  it('still honours a deep link it was sent from', async () => {
    await signIn('/login?next=%2Fcart');

    expect(await screen.findByTestId('where')).toHaveTextContent('/cart');
  });
});

describe('the storefront source', () => {
  /** Every non-test source file under src/. */
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(tsx?|json)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it('links to /home nowhere - every internal link goes to /', () => {
    const root = join(__dirname, '..');
    // A link, a navigate(), an href or a Navigate target naming the old
    // address. Prose in a comment that explains the redirect is not a link.
    const pattern = /(?:to=|href=|navigate\(|to:\s*|pathname:\s*)\{?\s*['"`]\/home(?:[/?#'"`])/i;

    const offenders = sources(root).filter((file) => pattern.test(readFileSync(file, 'utf8')));

    expect(offenders).toEqual([]);
  });
});
