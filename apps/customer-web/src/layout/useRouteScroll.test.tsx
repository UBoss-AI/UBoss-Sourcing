/**
 * Where a page starts, and where focus lands, when it is navigated to.
 *
 * jsdom has no layout, so these tests stand in for the browser in the two
 * places that matter: `window.scrollTo` is recorded, and `scrollTop` on a
 * nested scroller is a plain property that the hook either resets or does
 * not. What the browser DOES with them was checked by hand in Chrome at
 * phone, tablet and desktop widths.
 */
import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { Link, Outlet, RouterProvider, createMemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetScrollPositions, useRouteScroll } from './useRouteScroll';

let scrollCalls: { top: number; behavior: string | undefined }[] = [];
let scrollY = 0;

beforeEach(() => {
  scrollCalls = [];
  scrollY = 0;
  forgetScrollPositions();
  vi.spyOn(window, 'scrollTo').mockImplementation(((options: ScrollToOptions) => {
    scrollCalls.push({ top: options.top ?? 0, behavior: options.behavior });
    scrollY = options.top ?? 0;
  }) as typeof window.scrollTo);
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A layout like StoreLayout: a `<main>` the hook is given, and the page in it. */
function Layout(): React.JSX.Element {
  const mainRef = useRef<HTMLElement>(null);
  useRouteScroll(mainRef);
  return (
    <main ref={mainRef} tabIndex={-1} data-testid="main">
      <Outlet />
    </main>
  );
}

function FormPage(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <div>
      {/* A nested scroller a layout keeps across pages, like the sign-up column. */}
      <div data-route-scroll data-testid="column" />
      <h1>Create account</h1>
      <button
        type="button"
        onClick={() => {
          void navigate('/check-email');
        }}
      >
        Create account
      </button>
      <Link to="/form?step=2">Same page, other query</Link>
    </div>
  );
}

function CheckEmail(): React.JSX.Element {
  return (
    <div>
      <div data-route-scroll data-testid="column" />
      <h1 data-route-focus tabIndex={-1}>
        Check your email
      </h1>
    </div>
  );
}

function renderApp(initial = '/form') {
  const router = createMemoryRouter(
    [
      {
        element: <Layout />,
        children: [
          { path: '/form', element: <FormPage /> },
          { path: '/check-email', element: <CheckEmail /> },
          { path: '/plain', element: <p>No heading of its own</p> },
        ],
      },
    ],
    { initialEntries: [initial] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe('useRouteScroll', () => {
  it('leaves a first page load alone - the browser already put it at its top', () => {
    renderApp();
    expect(scrollCalls).toEqual([]);
  });

  it('opens the next page at its top, instantly, and resets the nested scroller too', async () => {
    const router = renderApp();
    scrollY = 1200;
    (screen.getByTestId('column')).scrollTop = 880;

    await act(async () => {
      await router.navigate('/check-email');
    });

    expect(scrollCalls.at(-1)).toEqual({ top: 0, behavior: 'instant' });
    expect((screen.getByTestId('column')).scrollTop).toBe(0);
  });

  it('moves focus to the page\'s own primary heading', async () => {
    const router = renderApp();
    await act(async () => {
      await router.navigate('/check-email');
    });
    expect(screen.getByRole('heading', { name: /check your email/i })).toHaveFocus();
  });

  it('falls back to the main region on a page with no marked heading', async () => {
    const router = renderApp();
    await act(async () => {
      await router.navigate('/plain');
    });
    expect(screen.getByTestId('main')).toHaveFocus();
  });

  it('does not move the page when only the query changes - a filter, a step, a refetch', async () => {
    const router = renderApp();
    scrollY = 640;
    await act(async () => {
      await router.navigate('/form?step=2');
    });
    expect(scrollCalls).toEqual([]);
  });

  it('does not move the page when it merely re-renders', async () => {
    const router = renderApp();
    scrollY = 400;
    await act(async () => {
      await router.navigate('/form', { replace: true, state: { typed: 'a' } });
    });
    expect(scrollCalls).toEqual([]);
  });

  it('returns Back to where the previous page was left', async () => {
    const router = renderApp();
    // Scrolled down the form; the hook remembers it once the scroll rests.
    scrollY = 750;
    await act(async () => {
      window.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await act(async () => {
      await router.navigate('/check-email');
    });
    expect(scrollY).toBe(0);

    await act(async () => {
      await router.navigate(-1);
    });
    expect(scrollCalls.at(-1)).toEqual({ top: 750, behavior: 'instant' });
  });

  it('remembers the position at the press that navigates, before the scroll has rested', async () => {
    const router = renderApp();
    scrollY = 640;
    // No time to rest: the link is pressed straight after the scroll.
    await act(async () => {
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('pointerdown'));
      await router.navigate('/check-email');
    });
    await act(async () => {
      await router.navigate(-1);
    });
    expect(scrollCalls.at(-1)).toEqual({ top: 640, behavior: 'instant' });
  });

  it('opens a page reached by Back at its top when it had never been scrolled', async () => {
    const router = renderApp();
    await act(async () => {
      await router.navigate('/check-email');
    });
    await act(async () => {
      await router.navigate(-1);
    });
    expect(scrollCalls.at(-1)).toEqual({ top: 0, behavior: 'instant' });
  });

  it('takes over scroll restoration while mounted and hands it back after', () => {
    window.history.scrollRestoration = 'auto';
    const { unmount } = render(
      <RouterProvider router={createMemoryRouter([{ path: '/', element: <Layout /> }])} />,
    );
    expect(window.history.scrollRestoration).toBe('manual');
    unmount();
    expect(window.history.scrollRestoration).toBe('auto');
  });
});
