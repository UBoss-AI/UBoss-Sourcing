/**
 * Full-page errors, wired into the storefront's routing.
 *
 * Two halves. The first reads the real route table and checks the wiring: that
 * every lazily-loaded page carries an `errorElement`, so a page that fails to
 * load or to render is caught inside the store's frame rather than blanking it,
 * and that both the store and the Seller Hub end in a 404. The second mounts
 * small data routers and makes each kind of failure happen.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { RouterProvider, createMemoryRouter, useLocation, type RouteObject } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_CONFIG, StorefrontContext } from '@/app/storefront-context';
import { i18n } from '@/i18n/config';
import { ApiError } from '@/lib/api';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { ErrorBoundary } from './ErrorBoundary';
import { RouteErrorPage } from './RouteErrorPage';
import { router } from './router';

const SECRET = 'at /srv/app/node_modules/prisma: password=hunter2 token=eyJhbGciOi';

function Throws({ error }: { error: unknown }): React.JSX.Element {
  throw error;
}

function Where(): React.JSX.Element {
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '';
  return <p>{`at ${location.pathname}${location.search} from ${from}`}</p>;
}

function mount(routes: RouteObject[], initialEntry: string): ReturnType<typeof createMemoryRouter> {
  const memory = createMemoryRouter(routes, { initialEntries: [initialEntry] });
  render(
    <I18nextProvider i18n={i18n}>
      <StorefrontContext.Provider value={FALLBACK_CONFIG}>
        <RouterProvider router={memory} />
      </StorefrontContext.Provider>
    </I18nextProvider>,
  );
  return memory;
}

/** A page that throws, under a route carrying the real error element. */
function failingAt(path: string, error: unknown): RouteObject[] {
  return [
    { path, element: <Throws error={error} />, errorElement: <RouteErrorPage /> },
    { path: '/login', element: <Where /> },
    { path: '/products', element: <Where /> },
    { path: '*', element: <NotFoundPage /> },
  ];
}

beforeEach(() => {
  // The page logs the real error for whoever debugs it. Silence it here, and
  // check below that it went to the console and not to the screen.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the route table', () => {
  type Route = (typeof router.routes)[number];

  function walk(routes: readonly Route[], visit: (route: Route) => void): void {
    for (const route of routes) {
      visit(route);
      if (route.children !== undefined) walk(route.children, visit);
    }
  }

  it('gives every lazily-loaded page an error element of its own', () => {
    const missing: string[] = [];
    walk(router.routes, (route) => {
      if (route.lazy !== undefined && route.errorElement === undefined) {
        missing.push(route.path ?? '(index)');
      }
    });
    expect(missing).toEqual([]);
  });

  it('gives the store and the Seller Hub a full-screen error element for their own frames', () => {
    for (const path of ['/', '/seller']) {
      const route = router.routes.find((candidate) => candidate.path === path);
      expect(route?.errorElement, path).toBeDefined();
    }
  });

  it('ends both the store and the Seller Hub in a 404', () => {
    for (const path of ['/', '/seller']) {
      const route = router.routes.find((candidate) => candidate.path === path);
      expect(route?.children?.some((child) => child.path === '*'), path).toBe(true);
    }
  });

  it('declares the error preview in development only', () => {
    const store = router.routes.find((candidate) => candidate.path === '/');
    const preview = store?.children?.some((child) => child.path === 'dev/errors/:kind');
    expect(preview).toBe(import.meta.env.DEV);
  });
});

describe('an unknown address', () => {
  it('shows the 404, with the catalogue search', async () => {
    mount(failingAt('/boom', new Error('unused')), '/definitely/not/a/page');

    expect(await screen.findByRole('heading', { name: 'This page has gone missing' })).toBeInTheDocument();
    expect(screen.getByRole('search')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
  });

  it('sends a search to the catalogue, encoded', async () => {
    const user = userEvent.setup();
    mount(failingAt('/boom', new Error('unused')), '/missing');

    await user.type(await screen.findByRole('searchbox'), 'gloves & 50% off?{Enter}');

    expect(await screen.findByText(/^at \/products/)).toHaveTextContent(
      'at /products?q=gloves%20%26%2050%25%20off%3F',
    );
  });

  it('sends an empty search to the whole catalogue', async () => {
    const user = userEvent.setup();
    mount(failingAt('/boom', new Error('unused')), '/missing');

    await user.click(await screen.findByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/^at \/products/)).toHaveTextContent('at /products from');
  });
});

describe('a page that fails', () => {
  it('shows "Something went wrong" for a crash, and none of the crash', async () => {
    mount(failingAt('/boom', new Error(SECRET)), '/boom');

    expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('hunter2');
    expect(document.body.textContent).not.toContain('/srv/app');
    expect(document.body.textContent).not.toContain('eyJhbGciOi');
    // It did go somewhere: the console, for whoever debugs it.
    expect(console.error).toHaveBeenCalled();
  });

  it('shows the server reference, and not the server message', async () => {
    const error = new ApiError(503, {
      code: 'SERVICE_UNAVAILABLE',
      message: SECRET,
      correlationId: '01J9ZK4M7Q2R8T5V3W6X9Y0ABC',
    });
    mount(failingAt('/boom', error), '/boom');

    expect(await screen.findByRole('heading', { name: 'Service temporarily unavailable' })).toBeInTheDocument();
    expect(screen.getByText('01J9ZK4M7Q2R8T5V3W6X9Y0ABC')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('hunter2');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('offers sign-in on a 401, and returns to the page afterwards', async () => {
    const user = userEvent.setup();
    const error = new ApiError(401, { code: 'UNAUTHENTICATED', message: SECRET });
    mount(failingAt('/boom', error), '/boom?tab=orders');

    await user.click(await screen.findByRole('link', { name: 'Sign in' }));
    expect(await screen.findByText(/^at \/login/)).toHaveTextContent('at /login from /boom?tab=orders');
  });

  it('refuses on a 403 without naming what was refused', async () => {
    const error = new ApiError(403, { code: 'FORBIDDEN', message: 'You lack ORDER_REFUND on order 42' });
    mount(failingAt('/admin-only/secret-report', error), '/admin-only/secret-report');

    expect(await screen.findByRole('heading', { name: 'Access restricted' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('ORDER_REFUND');
    expect(document.body.textContent).not.toContain('secret-report');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('catches a page whose file could not be loaded, inside the frame', async () => {
    const routes: RouteObject[] = [
      {
        path: '/',
        element: <p>store frame</p>,
        children: [],
      },
      {
        path: '/cart',
        errorElement: <RouteErrorPage />,
        lazy: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/Cart-1a2b.js')),
      },
    ];
    mount(routes, '/cart');

    expect(await screen.findByRole('heading', { name: 'A newer version is available' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh the page' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Cart-1a2b');
  });

  it('says offline when the browser is, and reloads once it is back', async () => {
    const reload = vi.fn();
    // Only `reload` is called on this path; the memory router never reads location.
    vi.stubGlobal('location', { href: window.location.href, reload });
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    mount(failingAt('/boom', new TypeError('Failed to fetch')), '/boom');
    expect(await screen.findByRole('heading', { name: 'You are offline' })).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();

    onLine.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => {
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });
});

describe('the app-wide boundary', () => {
  it('fills the screen with the same page, and none of the crash', () => {
    render(
      <ErrorBoundary>
        <Throws error={new Error(SECRET)} />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('hunter2');
    expect(document.body.textContent).not.toContain('/srv/app');
  });
});
