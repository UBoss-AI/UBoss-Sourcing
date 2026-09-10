/**
 * The greeting page's search module.
 *
 * Three things are worth holding down here, and they are the three that would
 * break silently:
 *
 *   1. **Where a submit goes.** Products hands off to the catalogue with the
 *      term in the URL, so the filters and pagination that already exist are
 *      the ones the results arrive in; an empty box is the whole catalogue
 *      rather than a no-op. AI Mode goes to a route, never to a panel.
 *   2. **That a guest's question survives the sign-in.** This is the one thing
 *      about the AI hand-off a customer would notice and nobody would test:
 *      the question is parked before the redirect and collected on arrival.
 *   3. **That a capability the operator has not configured is absent**, not
 *      disabled — no AI tab and no camera button on a deployment with no AI
 *      provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, makeSession } from '@/test/harness';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { HeroSearch } from './HeroSearch';
import { takePendingQuestion } from '@/lib/ai-mode';
import type { StorefrontConfig } from '@/lib/types';

/*
 * The route the module navigated to.
 *
 * `useNavigate` is mocked rather than asserting on a rendered destination:
 * this component's whole job is to hand off, and what it hands off *to* is the
 * assertion. Rendering the real routes would test the router instead.
 */
const navigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

function config(overrides: Partial<StorefrontConfig['features']> = {}): StorefrontConfig {
  return {
    ...FALLBACK_CONFIG,
    features: { ...FALLBACK_CONFIG.features, assistant: true, imageSearch: true, ...overrides },
  };
}

beforeEach(() => {
  navigate.mockReset();
  sessionStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
});

describe('the row above the bar', () => {
  it('marks Products as where you are, and offers AI Mode as a link', () => {
    renderWithProviders(<HeroSearch />, { config: config() });

    // Not tabs. One of the two items leaves the page, and a `role="tab"` on a
    // control that navigates tells a screen reader that a panel is about to
    // change when a whole page is.
    expect(screen.queryAllByRole('tab')).toHaveLength(0);

    const row = screen.getByRole('navigation', {
      name: 'Search the catalogue, or ask AI Mode',
    });
    expect(within(row).getByText('Products')).toHaveAttribute('aria-current', 'true');
    expect(within(row).getByRole('link', { name: /ai mode/i })).toHaveAttribute('href', '/ai');

    // The placeholder is also the input's accessible name, so this asserts
    // both. There is only one now: the bar cannot be switched into anything.
    expect(
      screen.getByRole('textbox', { name: 'Search medical equipment and supplies' }),
    ).toBeInTheDocument();
  });

  it('shows no row at all on a deployment with no AI provider', () => {
    renderWithProviders(<HeroSearch />, { config: config({ assistant: false }) });

    // One item is not a row — it is a label pretending to be a choice.
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /ai mode/i })).not.toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: 'Search medical equipment and supplies' }),
    ).toBeInTheDocument();
  });
});

describe('searching products', () => {
  it('hands the term to the catalogue page, where the filters live', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HeroSearch />, { config: config() });

    await user.type(screen.getByRole('textbox'), 'suction catheter');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(navigate).toHaveBeenCalledWith('/products?q=suction%20catheter');
  });

  it('submits on Enter as well as on the button', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HeroSearch />, { config: config() });

    await user.type(screen.getByRole('textbox'), 'cannula{Enter}');

    expect(navigate).toHaveBeenCalledWith('/products?q=cannula');
  });

  it('opens the whole catalogue on an empty box', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HeroSearch />, { config: config() });

    await user.click(screen.getByRole('button', { name: 'Search' }));

    // An empty term is not an error and not a no-op: it is "show me
    // everything", which is the browse-all page with no `q`.
    expect(navigate).toHaveBeenCalledWith('/products');
  });

  it('clears the box without submitting anything', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HeroSearch />, { config: config() });

    const input = screen.getByRole('textbox');
    await user.type(input, 'gauze');
    await user.click(screen.getByRole('button', { name: /clear/i }));

    expect(input).toHaveValue('');
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('leaving for AI Mode', () => {
  it('is one press, and it goes to the page rather than switching the bar', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HeroSearch />, { config: config() });

    const link = screen.getByRole('link', { name: /ai mode/i });

    // The whole point of the change: pressing AI Mode opens AI Mode. It used
    // to select a tab, and reaching the page then took a second press on
    // Search — on a page with a composer, a transcript and a conversation
    // list, which is better at asking questions than a one-line bar.
    expect(link).toHaveAttribute('href', '/ai');

    await user.click(link);

    // Nothing is asked on the way out; the page is what asks.
    expect(navigate).not.toHaveBeenCalled();
  });

  it('carries whatever is already typed, to be finished in the composer', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HeroSearch />, { config: config() });

    await user.type(screen.getByRole('textbox'), 'Which suction catheters fit 10 Fr?');
    await user.click(screen.getByRole('link', { name: /ai mode/i }));

    // `compose`, not `send`: they pressed a link, not Search, so the words
    // land in the composer for them to finish rather than being asked on
    // their behalf. And they travel in `sessionStorage` rather than the URL,
    // because a question can be a paragraph and has no business in a link, in
    // browser history, or in a proxy's log.
    expect(takePendingQuestion()).toEqual({
      text: 'Which suction catheters fit 10 Fr?',
      intent: 'compose',
    });
  });

  it('parks nothing when the box is empty', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HeroSearch />, { config: config() });

    await user.click(screen.getByRole('link', { name: /ai mode/i }));

    // Otherwise the AI page opens with an empty draft in its composer, which
    // is a worse start than a clean one.
    expect(takePendingQuestion()).toBeNull();
  });

  it('is offered to a guest, and does not wait on the session to say so', () => {
    renderWithProviders(<HeroSearch />, {
      config: config(),
      session: makeSession({ user: null, isCustomer: false, isLoading: true }),
    });

    // Somebody deciding whether this catalogue has what they need can ask
    // before opening an account: signing in adds a history, it does not buy an
    // answer. There is no sign-in detour and nothing waits on `/auth/me`,
    // whose answer would change nothing.
    expect(screen.getByRole('link', { name: /ai mode/i })).toHaveAttribute('href', '/ai');
  });
});

describe('image search', () => {
  it('offers the camera only where the deployment configured one', () => {
    const { unmount } = renderWithProviders(<HeroSearch />, { config: config() });
    expect(screen.getByRole('button', { name: /image search/i })).toBeInTheDocument();
    unmount();

    renderWithProviders(<HeroSearch />, { config: config({ imageSearch: false }) });
    // Absent, not disabled: a button that can only fail is worse than no button.
    expect(screen.queryByRole('button', { name: /image search/i })).not.toBeInTheDocument();
  });

  it('opens the dialog, and offers a guest a way in rather than a file picker', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HeroSearch />, {
      config: config(),
      session: makeSession({ user: null, isCustomer: false }),
    });

    await user.click(screen.getByRole('button', { name: /image search/i }));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // The endpoint spends the operator's provider budget, so it is behind the
    // session. A file picker that ends in a 401 wastes the upload as well as
    // the customer's time.
    expect(screen.getByRole('link', { name: /sign in to search by image/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /take a photo/i })).not.toBeInTheDocument();
  });
});
