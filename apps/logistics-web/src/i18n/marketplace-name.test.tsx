/**
 * `{{marketplace}}`: the operator's name, never the software vendor's.
 *
 * The carrier portal used to tell every carrier on every buyer's deployment
 * that "Accounts are created by UBOSS operations" and to "Contact UBOSS
 * operations". The catalogues now say `{{marketplace}}`, and
 * `<MarketplaceName />` fills it from `GET /config`. See `setMarketplaceName`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { i18n, NAMESPACE, setMarketplaceName } from './config';
import { LANGUAGES } from './languages';
import { MarketplaceName } from './MarketplaceName';
import en from './locales/en.json';

const WITH_NAME = Object.entries(en)
  .filter(([, value]) => value.includes('{{marketplace}}'))
  .map(([key]) => key as keyof typeof en);

afterEach(async () => {
  vi.restoreAllMocks();
  setMarketplaceName(null);
  await i18n.changeLanguage('en');
});

describe('the marketplace name in the carrier portal', () => {
  it('is used where the portal names who runs the marketplace', () => {
    expect(WITH_NAME).toEqual(
      expect.arrayContaining(['auth.noSelfSignup', 'company.setByUboss', 'source.UBOSS_ADMIN']),
    );
  });

  it.each(LANGUAGES)('$english names nobody but the operator', async ({ code }) => {
    await i18n.loadLanguages(code);
    const catalogue = i18n.getResourceBundle(code, NAMESPACE) as Record<string, string>;
    for (const value of Object.values(catalogue)) {
      expect(value).not.toMatch(/UBOSS/);
    }

    await i18n.changeLanguage(code);
    setMarketplaceName('Northwind Supply');
    for (const key of WITH_NAME) {
      const text = i18n.t(key, { ns: NAMESPACE });
      expect(text, `${code} ${key}`).toContain('Northwind Supply');
      expect(text, `${code} ${key}`).not.toContain('{{');
    }
  });

  it('is the product’s own name until the deployment’s arrives', () => {
    expect(i18n.t('source.UBOSS_ADMIN', { ns: NAMESPACE })).toBe('Glovia operations');
  });

  it('takes the name from GET /config', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ marketplace: { displayName: 'Northwind Supply' } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <MarketplaceName />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(i18n.t('auth.noSelfSignup', { ns: NAMESPACE })).toBe(
        'Accounts are created by Northwind Supply operations. There is no sign-up here.',
      );
    });
    expect(get).toHaveBeenCalledWith('/config');
  });
});
