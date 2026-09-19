/**
 * The greeting page's search module.
 *
 * Three things are worth holding down here, and they are the three that would
 * break silently:
 *
 *   1. **Where a submit goes.** The bar hands off to the catalogue with the
 *      term in the URL, so the filters and pagination that already exist are
 *      the ones the results arrive in; an empty box is the whole catalogue
 *      rather than a no-op. AI Mode goes to a route, never to a panel. And
 *      **which item in the row is underlined comes from the URL**, so the row
 *      cannot go back to telling somebody on the greeting page that they are
 *      in the catalogue.
 *   2. **That a guest's question survives the sign-in.** This is the one thing
 *      about the AI hand-off a customer would notice and nobody would test:
 *      the question is parked before the redirect and collected on arrival.
 *   3. **That a capability the operator has not configured is absent**, not
 *      disabled — no AI item and no camera button on a deployment with no AI
 *      provider. Home and Products stay, because every deployment has both.
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
  it('marks Home as where you are, and offers the other two as links', () => {
    renderWithProviders(<HeroSearch />, { config: config(), route: '/' });

    // Not tabs. Every item leaves the page, and a `role="tab"` on a control
    // that navigates tells a screen reader that a panel is about to change
    // when a whole page is.
    expect(screen.queryAllByRole('tab')).toHaveLength(0);

    const row = screen.getByRole('navigation', {
      name: 'Home, the AI Assistant, or the catalogue',
    });

    // On the greeting page it is Home that is current — this is the assertion
    // that Products stopped claiming it. And Home is still a link, so it is
    // never a dead word in the middle of a row of live ones.
    const home = within(row).getByRole('link', { name: 'Home' });
    expect(home).toHaveAttribute('href', '/');
    expect(home).toHaveAttribute('aria-current', 'page');

    const products = within(row).getByRole('link', { name: 'Products' });
    expect(products).toHaveAttribute('href', '/products');
    expect(products).not.toHaveAttribute('aria-current');

    expect(within(row).getByRole('link', { name: /ai assistant/i })).toHaveAttribute('href', '/ai');

    // The placeholder is also the input's accessible name, so this asserts
    // both. There is only one now: the bar cannot be switched into anything.
    expect(
      screen.getByRole('textbox', { name: 'Search the catalogue' }),
    ).toBeInTheDocument();
  });

  it('marks Products as where you are once the catalogue is the page', () => {
    renderWithProviders(<HeroSearch />, { config: config(), route: '/products?q=gauze' });

    const row = screen.getByRole('navigation');
    expect(within(row).getByRole('link', { name: 'Products' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(row).getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  it('keeps Home and Products on a deployment with no AI provider', () => {
    renderWithProviders(<HeroSearch />, { config: config({ assistant: false }) });

    // Only the AI item comes and goes with what the operator configured. The
    // other two are pages every deployment has — and the row's name stops
    // offering an assistant that is not in it.
    const row = screen.getByRole('navigation', { name: 'Home, or the catalogue' });
    expect(within(row).getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Products' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /ai assistant/i })).not.toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: 'Search the catalogue' }),
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

    const link = screen.getByRole('link', { name: /ai assistant/i });

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
    await user.click(screen.getByRole('link', { name: /ai assistant/i }));

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

    await user.click(screen.getByRole('link', { name: /ai assistant/i }));

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
    expect(screen.getByRole('link', { name: /ai assistant/i })).toHaveAttribute('href', '/ai');
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
