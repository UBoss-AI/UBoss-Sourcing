/**
 * The full-page error: what it says for each kind, which ways onward it
 * offers, and what it refuses to show.
 */
// Registered here as well as in the storefront's setup, because this folder's
// tests also run in the admin and logistics apps, which register no matchers.
import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n/config';
import type { Translate } from '@/i18n/i18n-context';
import { ErrorPage, type ErrorPageProps } from './ErrorPage';
import { errorActions } from './error-actions';
import { RETRYABLE, type ErrorKind } from './error-kind';

// The i18next instance's own function, typed as the app's. Bound, not wrapped,
// so no app's lint sees a conversion its types make unnecessary.
const t = i18n.t.bind(i18n) as unknown as Translate;

function renderPage(props: Omit<ErrorPageProps, 't'>): void {
  render(
    <MemoryRouter>
      <ErrorPage t={t} {...props} />
    </MemoryRouter>,
  );
}

function scene(): HTMLElement {
  return screen.getByTestId('error-ghost').closest('[aria-hidden="true"]') as HTMLElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what the page says', () => {
  it.each<[ErrorKind, string, string]>([
    ['notFound', '404', 'This page has gone missing'],
    ['unauthorized', '401', 'Sign in to continue'],
    ['forbidden', '403', 'Access restricted'],
    ['timeout', '408', 'The request timed out'],
    ['rateLimited', '429', 'Too many requests'],
    ['server', '500', 'Something went wrong'],
    ['badGateway', '502', 'Service connection problem'],
    ['unavailable', '503', 'Service temporarily unavailable'],
  ])('%s draws %s and says "%s"', (kind, code, title) => {
    renderPage({ kind });

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(title);
    // The numeral is decoration; the code is stated in words for a screen reader.
    expect(scene()).toHaveTextContent(code.replace('0', ''));
    expect(screen.getByText(`Error code: ${code}`)).toHaveClass('sr-only');
  });

  it('draws the ghost alone when there is no status to show', () => {
    renderPage({ kind: 'offline' });

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('You are offline');
    expect(scene().textContent).toBe('');
    expect(screen.queryByText(/Error code/)).toBeNull();
  });

  it('draws the real status, not the kind default, when one is given', () => {
    renderPage({ kind: 'timeout', statusCode: 504 });
    expect(screen.getByText('Error code: 504')).toBeInTheDocument();
  });

  it('takes a title and message of its own', () => {
    renderPage({ kind: 'server', title: 'Custom title', message: 'Custom message' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Custom title');
    expect(screen.getByText('Custom message')).toBeInTheDocument();
  });

  it('announces the heading and message through an alert region', () => {
    renderPage({ kind: 'server' });
    const alert = screen.getByRole('alert');
    expect(within(alert).getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(alert).toHaveTextContent('An unexpected problem stopped this page from loading');
  });

  it('hides the decoration from assistive technology', () => {
    renderPage({ kind: 'notFound' });
    expect(scene()).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows a reference only when given one', () => {
    renderPage({ kind: 'server', reference: '01J9ZK4M7Q2R8T5V3W6X9Y0ABC' });
    expect(screen.getByText('01J9ZK4M7Q2R8T5V3W6X9Y0ABC')).toBeInTheDocument();
  });

  it('shows no reference line without one', () => {
    renderPage({ kind: 'server' });
    expect(screen.queryByText(/Reference for support/)).toBeNull();
  });
});

describe('the inline search', () => {
  it('is absent unless the page is given somewhere to send it', () => {
    renderPage({ kind: 'notFound' });
    expect(screen.queryByRole('search')).toBeNull();
  });

  it('submits the trimmed query, and a query with symbols intact for the caller to encode', async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    renderPage({ kind: 'notFound', onSearch });

    await user.type(screen.getByRole('searchbox', { name: 'Search the catalogue' }), '  gloves & masks  ');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(onSearch).toHaveBeenCalledWith('gloves & masks');
  });

  it('submits with Enter from the field', async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    renderPage({ kind: 'notFound', onSearch });

    await user.type(screen.getByRole('searchbox'), 'syringe{Enter}');
    expect(onSearch).toHaveBeenCalledWith('syringe');
  });
});

describe('reduced motion', () => {
  it('floats the ghost normally', () => {
    renderPage({ kind: 'notFound' });
    expect(screen.getByTestId('error-ghost')).toHaveAttribute('data-motion', 'floating');
  });

  it('stills it when the visitor has asked for less movement', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    renderPage({ kind: 'notFound' });
    expect(screen.getByTestId('error-ghost')).toHaveAttribute('data-motion', 'still');
  });
});

describe('the ways onward', () => {
  const retry = vi.fn();

  function actionsFor(kind: ErrorKind): string[] {
    return errorActions(kind, {
      t,
      home: { to: '/' },
      signIn: { to: '/login', from: '/account/orders' },
      supportTo: '/support',
      retry,
      goBack: vi.fn(),
    }).map((action) => action.label);
  }

  it('offers home and back on a 404', () => {
    expect(actionsFor('notFound')).toEqual(['Back to home', 'Go back']);
  });

  it('offers sign-in first on a 401, carrying where to come back to', () => {
    const [signIn] = errorActions('unauthorized', {
      t,
      home: { to: '/' },
      signIn: { to: '/login', from: '/account/orders?page=2' },
    });
    expect(signIn).toMatchObject({ label: 'Sign in', to: '/login', state: { from: '/account/orders?page=2' } });
  });

  it('drops a return path that would leave the site', () => {
    const [signIn] = errorActions('unauthorized', {
      t,
      home: { to: '/' },
      signIn: { to: '/login', from: '//evil.example/phish' },
    });
    expect(signIn?.state).toBeUndefined();
  });

  it('offers only home on a 403', () => {
    expect(actionsFor('forbidden')).toEqual(['Back to home']);
  });

  it('offers "Try again" only for the kinds where retrying is safe', () => {
    for (const kind of ['notFound', 'unauthorized', 'forbidden', 'chunk'] as const) {
      expect(actionsFor(kind)).not.toContain('Try again');
    }
    for (const kind of RETRYABLE) {
      expect(actionsFor(kind)[0]).toBe('Try again');
    }
  });

  it('offers no "Try again" when the caller gave no way to retry', () => {
    const labels = errorActions('server', { t, home: { to: '/' } }).map((action) => action.label);
    expect(labels).toEqual(['Back to home']);
  });

  it('offers support alongside a server failure, but not for being offline', () => {
    expect(actionsFor('server')).toContain('Contact support');
    expect(actionsFor('offline')).not.toContain('Contact support');
  });

  it('offers one refresh for a failed chunk, and never retries it by itself', () => {
    expect(actionsFor('chunk')).toEqual(['Refresh the page', 'Back to home']);
    expect(retry).not.toHaveBeenCalled();
  });

  it('says "dashboard" in the panels', () => {
    const labels = errorActions('forbidden', { t, home: { to: '/' }, homeIsDashboard: true }).map(
      (action) => action.label,
    );
    expect(labels).toEqual(['Back to dashboard']);
  });

  it('renders a retry as a button that calls it', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderPage({ kind: 'unavailable', actions: errorActions('unavailable', { t, home: { to: '/' }, retry: onRetry }) });

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
  });
});
