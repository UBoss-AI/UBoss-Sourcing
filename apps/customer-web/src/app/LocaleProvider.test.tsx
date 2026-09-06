/**
 * What the interface language is allowed to do to a price.
 *
 * These are the rules the whole feature turns on, and both directions are
 * dangerous in their own way:
 *
 *   - Never repricing on a language change leaves a Polish reader on a euro
 *     price list nobody chose for them.
 *   - *Silently* repricing a shopper who already said where they are changes
 *     the number a purchase decision is being made on, without them asking.
 *
 * So an unanswered visitor starts in the language's market, an answered one is
 * only ever offered it, and a deployment that does not sell in that market is
 * offered nothing at all.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { StorefrontContext } from '@/app/storefront-context';
import { i18n } from '@/i18n/config';
import type { StorefrontConfig } from '@/lib/types';
import { LocaleProvider } from './LocaleProvider';
import { useLocale } from './locale-context';

/** A store selling in its home market and in Poland. */
const CONFIG: StorefrontConfig = {
  assistant: { available: false, isAi: true, model: null, vendor: null },
  business: {
    displayName: 'Test Supplies',
    supportEmail: null,
    supportPhone: null,
    logo: null,
    currency: 'EUR',
    timezone: 'Europe/Amsterdam',
    policyLinks: null,
  },
  localisation: {
    baseCurrency: 'EUR',
    currencies: [
      { code: 'EUR', name: 'Euro', symbol: '€', exponent: 2, isBase: true, hasProducts: true },
      {
        code: 'PLN',
        name: 'Polish Złoty',
        symbol: 'zł',
        exponent: 2,
        isBase: false,
        hasProducts: true,
      },
    ],
    countries: [
      { code: 'NL', name: 'Netherlands', currencyCode: 'EUR', phonePrefix: '+31' },
      { code: 'PL', name: 'Poland', currencyCode: 'PLN', phonePrefix: '+48' },
    ],
  },
  features: { selfRegistration: false, recurringOrders: false, assistant: false },
};

/** Signed out, so nothing is read from or written to a profile. */
const VISITOR: SessionState = {
  user: null,
  isLoading: false,
  isCustomer: false,
  login: () => Promise.resolve(),
  logout: () => Promise.resolve(),
  refreshUser: () => Promise.resolve(),
};

function Probe(): React.JSX.Element {
  const locale = useLocale();

  return (
    <>
      <span data-testid="currency">{locale.currency}</span>
      <span data-testid="suggestion">{locale.marketSuggestion?.currency ?? 'none'}</span>
    </>
  );
}

function renderProvider(config: StorefrontConfig = CONFIG): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <StorefrontContext.Provider value={config}>
          <SessionContext.Provider value={VISITOR}>
            <LocaleProvider>
              <Probe />
            </LocaleProvider>
          </SessionContext.Provider>
        </StorefrontContext.Provider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(async () => {
  window.localStorage.clear();
  await i18n.changeLanguage('pl');
});

afterEach(async () => {
  window.localStorage.clear();
  await i18n.changeLanguage('en');
});

describe('the language as a pricing signal', () => {
  it('quotes a visitor who has never answered in the language’s currency', async () => {
    renderProvider();

    await waitFor(() => {
      expect(screen.getByTestId('currency')).toHaveTextContent('PLN');
    });

    // Nothing to offer: they are already in the market the language points at.
    expect(screen.getByTestId('suggestion')).toHaveTextContent('none');
  });

  it('leaves an answered visitor on their own currency and only offers the switch', async () => {
    window.localStorage.setItem(
      'uboss.locale',
      JSON.stringify({ country: 'NL', currency: 'EUR' }),
    );

    renderProvider();

    await waitFor(() => {
      expect(screen.getByTestId('suggestion')).toHaveTextContent('PLN');
    });

    // The price on screen has not moved. That is the whole point.
    expect(screen.getByTestId('currency')).toHaveTextContent('EUR');
  });

  it('does not offer a market the store has turned down before', async () => {
    window.localStorage.setItem(
      'uboss.locale',
      JSON.stringify({ country: 'NL', currency: 'EUR' }),
    );
    window.localStorage.setItem('uboss.locale.declined', JSON.stringify(['PLN']));

    renderProvider();

    await waitFor(() => {
      expect(screen.getByTestId('currency')).toHaveTextContent('EUR');
    });

    expect(screen.getByTestId('suggestion')).toHaveTextContent('none');
  });

  it('ignores the language when the catalogue is not priced in that market', async () => {
    // Staff activated the currency but have not priced anything in it. Sending
    // a Polish reader there would hand them an empty shop.
    renderProvider({
      ...CONFIG,
      localisation: {
        ...CONFIG.localisation,
        currencies: CONFIG.localisation.currencies.map((entry) =>
          entry.code === 'PLN' ? { ...entry, hasProducts: false } : entry,
        ),
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('currency')).toHaveTextContent('EUR');
    });

    expect(screen.getByTestId('suggestion')).toHaveTextContent('none');
  });

  it('reads no location out of English', async () => {
    await i18n.changeLanguage('en');

    renderProvider();

    await waitFor(() => {
      expect(screen.getByTestId('currency')).toHaveTextContent('EUR');
    });

    expect(screen.getByTestId('suggestion')).toHaveTextContent('none');
  });
});
