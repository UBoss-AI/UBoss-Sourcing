/**
 * The header, and the two controls that replaced five.
 *
 * What these guard is mostly *absence*, which is the hard thing to keep
 * guarded: a global search box and a category bar were removed from the
 * chrome, and both are the kind of thing that gets reinstated by somebody who
 * finds the header looking sparse. A test that says "there is no second search
 * box up here" is the only durable record of a deliberate removal — a comment
 * explains the decision, a test enforces it.
 *
 * The rest is the two controls that took their place: one market menu that
 * states the language, country and currency and applies all three together,
 * and one grouped account menu that a guest never sees.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Header } from './Header';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { jsonResponse, makeLocale, makeSession, renderWithProviders } from '@/test/harness';
import type { StorefrontConfig } from '@/lib/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(features: Partial<StorefrontConfig['features']> = {}): StorefrontConfig {
  return {
    ...FALLBACK_CONFIG,
    features: { ...FALLBACK_CONFIG.features, recurringOrders: true, ...features },
  };
}

/** A deployment selling into three markets in two currencies. */
function makeMarketLocale(overrides = {}) {
  return makeLocale({
    currency: 'INR',
    country: 'IN',
    currencies: [
      { code: 'INR', name: 'Indian Rupee', symbol: '₹', exponent: 2, isBase: true },
      { code: 'EUR', name: 'Euro', symbol: '€', exponent: 2, isBase: false },
    ],
    countries: [
      { code: 'IN', name: 'India', currencyCode: 'INR', phonePrefix: '+91' },
      { code: 'DE', name: 'Germany', currencyCode: 'EUR', phonePrefix: '+49' },
      { code: 'NL', name: 'Netherlands', currencyCode: 'EUR', phonePrefix: '+31' },
    ],
    ...overrides,
  });
}

const GUEST = makeSession({ user: null, isCustomer: false });

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/cart')) {
      return Promise.resolve(jsonResponse({ cart: { itemCount: 0 } }));
    }
    if (url.includes('/account/profile')) {
      return Promise.resolve(
        jsonResponse({
          profile: { email: 'buyer@example.test', fullName: 'Priya Nair', organization: 'Kerala Clinics' },
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// What is deliberately not here
// ---------------------------------------------------------------------------

describe('the header', () => {
  it('carries no global search box', () => {
    // The greeting page opens on a large tabbed search module. A second,
    // smaller search field in the chrome directly above it was two front
    // doors to the same room, and the two behaved differently — the header
    // one always went to /search, the hero one goes to the catalogue with the
    // filters applied. Searching from the catalogue is a field in its own
    // filter panel; see CatalogPage.
    renderWithProviders(<Header />, { config: makeConfig() });

    expect(screen.queryByRole('search')).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Search' })).not.toBeInTheDocument();
  });

  it('carries no category bar', () => {
    // A second sticky row spending 44px of every viewport on the top-level
    // departments, which are also the first section of the greeting page and
    // the whole left rail of the catalogue. On a phone it scrolled sideways,
    // so the department you were in was frequently half off screen.
    renderWithProviders(<Header />, { config: makeConfig() });

    expect(screen.queryByText('All products')).not.toBeInTheDocument();
    // And it does not ask for the categories either: a removed bar that still
    // fetches is a removed bar in name only.
    const asked = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(asked.some((url) => url.includes('/catalog/categories'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The market control
// ---------------------------------------------------------------------------

describe('the market control', () => {
  it('states the language, the market and the currency without being opened', () => {
    renderWithProviders(<Header />, {
      config: makeConfig(),
      locale: makeMarketLocale(),
      session: GUEST,
    });

    const trigger = screen.getByRole('button', {
      name: /Change language, country and currency/i,
    });

    // The flag is `aria-hidden` — the country's name is beside it in text, and
    // a screen reader hearing "flag of India, India" has been told the same
    // thing twice. So the assertion is on the text.
    expect(within(trigger).getByText('EN')).toBeInTheDocument();
    expect(within(trigger).getByText('India')).toBeInTheDocument();
    expect(within(trigger).getByText('₹ INR')).toBeInTheDocument();
  });

  it('is offered to a guest as well as to a customer', () => {
    // What language this page is in and what its numbers mean is the question
    // a visitor answers on arrival, which is before they have an account.
    renderWithProviders(<Header />, { config: makeConfig(), locale: makeMarketLocale(), session: GUEST });

    expect(
      screen.getByRole('button', { name: /Change language, country and currency/i }),
    ).toBeInTheDocument();
  });

  it('searches the country list, and applies all three answers at once', async () => {
    const user = userEvent.setup();
    const choose = vi.fn();

    renderWithProviders(<Header />, {
      config: makeConfig(),
      locale: makeMarketLocale({ choose }),
      session: GUEST,
    });

    await user.click(screen.getByRole('button', { name: /Change language, country and currency/i }));

    // A `<select>` of 43 countries cannot be searched — the platform picker
    // type-ahead matches the first letter only — which is the whole reason
    // this is a panel rather than three native controls.
    await user.type(screen.getByPlaceholderText('Search countries'), 'nether');

    expect(screen.getByRole('button', { name: /Netherlands/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^India/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Netherlands/ }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    // One call, with the country and the currency together. Two separate acts
    // would reprice the whole catalogue twice and restamp the cart twice for
    // one decision — and picking Netherlands means being quoted in euro.
    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose).toHaveBeenCalledWith('NL', 'EUR');
  });

  it('nothing is applied until Apply is pressed', async () => {
    const user = userEvent.setup();
    const choose = vi.fn();

    renderWithProviders(<Header />, {
      config: makeConfig(),
      locale: makeMarketLocale({ choose }),
      session: GUEST,
    });

    await user.click(screen.getByRole('button', { name: /Change language, country and currency/i }));
    await user.click(screen.getByRole('button', { name: /Germany/ }));

    // Every other control in this header acts on change. This one holds three
    // coupled answers, so a country whose currency the deployment does not
    // price in has to be shown to be a problem before it is acted on.
    expect(choose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The account control
// ---------------------------------------------------------------------------

describe('the account control', () => {
  it('offers a guest one action, not a menu with one item in it', () => {
    renderWithProviders(<Header />, { config: makeConfig(), session: GUEST });

    const signIn = screen.getByRole('link', { name: 'Sign in' });
    expect(signIn).toHaveAttribute('href', '/login');

    expect(screen.queryByRole('button', { name: /Your account/i })).not.toBeInTheDocument();
  });

  it('names the customer rather than their email address', async () => {
    renderWithProviders(<Header />, { config: makeConfig() });

    // A purchasing account is routinely `ops.procurement@`, so initials taken
    // from the address identify nobody and the whole address is 30 characters
    // of header. The greeting name is the first word of the profile name.
    expect(await screen.findByText('Priya')).toBeInTheDocument();
  });

  it('groups its destinations under headings and marks none of them a menu item', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Header />, { config: makeConfig() });

    await user.click(screen.getByRole('button', { name: /Your account/i }));

    const panel = screen.getByRole('navigation', { name: /Your account/i });

    expect(within(panel).getByRole('link', { name: 'My profile' })).toHaveAttribute(
      'href',
      '/account/profile',
    );
    expect(within(panel).getByRole('link', { name: 'Scheduled orders' })).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'ERP integrations' })).toBeInTheDocument();

    // Deliberately not `role="menuitem"`: that would replace "link" in the
    // announcement, and a user who cannot tell that following an entry
    // navigates has been told less, not more.
    expect(within(panel).queryAllByRole('menuitem')).toHaveLength(0);
  });

  it('drops a destination the deployment has switched off', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Header />, { config: makeConfig({ recurringOrders: false }) });

    await user.click(screen.getByRole('button', { name: /Your account/i }));

    // Absent, not greyed out with a tooltip. An entry that navigates to a 404
    // teaches the customer that the navigation lies.
    expect(screen.queryByRole('link', { name: 'Scheduled orders' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Orders' })).toBeInTheDocument();
  });

  it('closes on Escape and puts focus back on the trigger', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Header />, { config: makeConfig() });

    const trigger = screen.getByRole('button', { name: /Your account/i });
    await user.click(trigger);
    expect(screen.getByRole('navigation', { name: /Your account/i })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('navigation', { name: /Your account/i })).not.toBeInTheDocument();
    // Returning focus is not a nicety: without it a keyboard user is dropped
    // at the top of the document with no idea where they were.
    expect(trigger).toHaveFocus();
  });

  it('asks before signing out', async () => {
    const user = userEvent.setup();
    const logout = vi.fn();
    renderWithProviders(<Header />, {
      config: makeConfig(),
      session: makeSession({ logout }),
    });

    await user.click(screen.getByRole('button', { name: /Your account/i }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    // Sign out sits one pixel under Notifications in a list people scan
    // quickly, and on a shared purchasing machine an accidental sign-out costs
    // somebody their basket.
    expect(logout).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign out' }),
    );
    expect(logout).toHaveBeenCalledTimes(1);
  });
});
