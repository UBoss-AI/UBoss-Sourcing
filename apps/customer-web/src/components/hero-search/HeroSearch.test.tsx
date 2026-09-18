/**
 * The greeting page's search module.
 *
 * Four things are worth holding down here, and they are the four that would
 * break silently:
 *
 *   1. **That the bar can be reached at all.** The greeting opens on a pill
 *      now, and everything else in this file is behind one press on it. A
 *      module that will not unfold is a landing page with no search on it.
 *   2. **Where a submit goes.** Products hands off to the catalogue with the
 *      term in the URL, so the filters and pagination that already exist are
 *      the ones the results arrive in; an empty box is the whole catalogue
 *      rather than a no-op. AI Mode goes to a route, never to a panel.
 *   3. **That a guest's question survives the sign-in.** This is the one thing
 *      about the AI hand-off a customer would notice and nobody would test:
 *      the question is parked before the redirect and collected on arrival.
 *   4. **That a capability the operator has not configured is absent**, not
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

/**
 * Unfold the module.
 *
 * The pill carries the same words as the field it becomes, so this is also
 * what asserts that the closed state names itself — a round button with a
 * magnifier and no accessible name would pass every other test in this file.
 */
async function openBar(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Search the catalogue' }));
  await screen.findByRole('textbox', { name: 'Search the catalogue' });
}

beforeEach(() => {
  navigate.mockReset();
  sessionStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
});

describe('the pill it opens as', () => {
  it('is the only thing on offer until it is pressed', () => {
    renderWithProviders(<HeroSearch />, { config: config() });

    // Nothing that belongs to the open bar is in the document yet. This is the
    // cost written down in the component's header, held in place by a test so
    // that it stays a decision rather than becoming a surprise: the AI Mode
    // link and the catalogue field are both one press away.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /ai mode/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /image search/i })).not.toBeInTheDocument();

    const pill = screen.getByRole('button', { name: 'Search the catalogue' });
    expect(pill).toHaveAttribute('aria-expanded', 'false');
  });

  it('unfolds into the bar, and puts the caret in it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HeroSearch />, { config: config() });

    await openBar(user);

    // Somebody who pressed a search control means to type. Landing them in the
    // open bar with the caret somewhere else is a second press they should not
    // have had to make.
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Search the catalogue' })).toHaveFocus();
    });
  });

  it('folds back up on Escape, from anywhere inside it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HeroSearch />, { config: config() });

    await openBar(user);
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    // Focus is returned to the control that opened it. Escape that leaves
    // focus on a node it has just removed drops a keyboard user at the top of
    // the document.
    //
    // Awaited, because the pill does not exist until the render that folds the
    // bar away, so the component restores focus on the frame after it - see
    // `close` in HeroSearch.tsx. Asserting this synchronously passed on a fast
    // machine and failed in CI, which is the worst way for a real behaviour to
    // be held down.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Search the catalogue' })).toHaveFocus();
    });
  });

  it('does not fold up over words somebody has typed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HeroSearch />, { config: config() });

    await openBar(user);
    await user.type(screen.getByRole('textbox'), 'gauze');
    await user.tab();

    // Folding a bar with a term in it throws the term away, and they would
    // have to type it again to find out that is what happened.
    expect(screen.getByRole('textbox')).toHaveValue('gauze');
  });
});

describe('the row above the bar', () => {
  it('marks Products as where you are, and offers AI Mode as a link', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HeroSearch />, { config: config() });
    await openBar(user);

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
    expect(screen.getByRole('textbox', { name: 'Search the catalogue' })).toBeInTheDocument();
  });

  it('shows no row at all on a deployment with no AI provider', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HeroSearch />, { config: config({ assistant: false }) });
    await openBar(user);

    // One item is not a row — it is a label pretending to be a choice.
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /ai mode/i })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search the catalogue' })).toBeInTheDocument();
  });
});

describe('searching products', () => {
  it('hands the term to the catalogue page, where the filters live', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HeroSearch />, { config: config() });
    await openBar(user);

    await user.type(screen.getByRole('textbox'), 'suction catheter');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(navigate).toHaveBeenCalledWith('/products?q=suction%20catheter');
  });

  it('submits on Enter as well as on the button', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HeroSearch />, { config: config() });
    await openBar(user);

    await user.type(screen.getByRole('textbox'), 'cannula{Enter}');

    expect(navigate).toHaveBeenCalledWith('/products?q=cannula');
  });

  it('opens the whole catalogue on an empty box', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HeroSearch />, { config: config() });
    await openBar(user);

    await user.click(screen.getByRole('button', { name: 'Search' }));

    // An empty term is not an error and not a no-op: it is "show me
    // everything", which is the browse-all page with no `q`.
    expect(navigate).toHaveBeenCalledWith('/products');
  });

  it('offers exactly one control called Search', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HeroSearch />, { config: config() });
    await openBar(user);

    // The bubble that pinches off the bar's left end IS the submit, and the
    // filled button that used to sit inside the bar was removed when it
    // arrived. Two controls with the same name doing the same thing is one of
    // them that somebody has to rule out first.
    expect(screen.getAllByRole('button', { name: 'Search' })).toHaveLength(1);
  });

  it('clears the box without submitting anything', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HeroSearch />, { config: config() });
    await openBar(user);

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
    await openBar(user);

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
    await openBar(user);

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
    await openBar(user);

    await user.click(screen.getByRole('link', { name: /ai mode/i }));

    // Otherwise the AI page opens with an empty draft in its composer, which
    // is a worse start than a clean one.
    expect(takePendingQuestion()).toBeNull();
  });

  it('is offered to a guest, and does not wait on the session to say so', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HeroSearch />, {
      config: config(),
      session: makeSession({ user: null, isCustomer: false, isLoading: true }),
    });
    await openBar(user);

    // Somebody deciding whether this catalogue has what they need can ask
    // before opening an account: signing in adds a history, it does not buy an
    // answer. There is no sign-in detour and nothing waits on `/auth/me`,
    // whose answer would change nothing.
    expect(screen.getByRole('link', { name: /ai mode/i })).toHaveAttribute('href', '/ai');
  });
});

describe('image search', () => {
  it('offers the camera only where the deployment configured one', async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<HeroSearch />, { config: config() });
    await openBar(user);
    expect(screen.getByRole('button', { name: /image search/i })).toBeInTheDocument();
    unmount();

    renderWithProviders(<HeroSearch />, { config: config({ imageSearch: false }) });
    await openBar(user);
    // Absent, not disabled: a button that can only fail is worse than no button.
    expect(screen.queryByRole('button', { name: /image search/i })).not.toBeInTheDocument();
  });

  it('opens the dialog, and offers a guest a way in rather than a file picker', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HeroSearch />, {
      config: config(),
      session: makeSession({ user: null, isCustomer: false }),
    });
    await openBar(user);

    await user.click(screen.getByRole('button', { name: /image search/i }));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // The endpoint spends the operator's provider budget, so it is behind the
    // session. A file picker that ends in a 401 wastes the upload as well as
    // the customer's time.
    expect(screen.getByRole('link', { name: /sign in to search by image/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /take a photo/i })).not.toBeInTheDocument();

    // And the bar is still open behind it. Opening the dialog moves focus out
    // of the module, which is exactly the condition that folds it — without
    // the guard, closing the dialog would return the customer to a pill.
    expect(screen.getByRole('textbox', { name: 'Search the catalogue' })).toBeInTheDocument();
  });
});
