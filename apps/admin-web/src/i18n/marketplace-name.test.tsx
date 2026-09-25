/**
 * `{{marketplace}}`: the operator's name, never the software vendor's.
 *
 * The delivery-level screens here used to say "UBOSS price", "Self + UBOSS"
 * and "This level is managed by UBOSS" on every buyer's deployment. The
 * catalogues now say `{{marketplace}}`, and `<MarketplaceName />` fills it from
 * `GET /config`. See `setMarketplaceName` in `./config`.
 *
 * Since then the delivery-level strings say `{{team}}`: the operator's own
 * team (`OPERATOR_TEAM_NAME`), which falls back to the marketplace's name, so a
 * store called Glovia can say "Self + UBoss". Both placeholders name the
 * operator, so both are held to the same rules here.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { i18n, NAMESPACE, setMarketplaceName, setTeamName } from './config';
import type { Translate } from './i18n-context';
import { LANGUAGES } from './languages';
import { MarketplaceName } from './MarketplaceName';
import en from './locales/en.json';

const WITH_NAME = Object.entries(en)
  .filter(([, value]) => value.includes('{{marketplace}}') || value.includes('{{team}}'))
  .map(([key]) => key as keyof typeof en);

afterEach(async () => {
  vi.restoreAllMocks();
  setMarketplaceName(null);
  setTeamName(null);
  await i18n.changeLanguage('en');
});

describe('the marketplace name in the console', () => {
  it('is used by the delivery-level strings', () => {
    expect(WITH_NAME).toEqual(
      expect.arrayContaining(['levels.mode.UBOSS', 'levels.mode.HYBRID', 'levels.intro', 'levels.ubossPriceTitle']),
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
    // No team name of its own: the team goes by the marketplace's name.
    setTeamName(null);
    for (const key of WITH_NAME) {
      const text = i18n.t(key, { ns: NAMESPACE, level: 'L2' });
      expect(text, `${code} ${key}`).toContain('Northwind Supply');
      expect(text, `${code} ${key}`).not.toContain('{{');
    }
  });

  it('is the product’s own name until the deployment’s arrives', () => {
    expect(i18n.t('levels.mode.HYBRID', { ns: NAMESPACE })).toBe('Self + Glovia');
  });

  it('fills a string reached through an error code', () => {
    setMarketplaceName('Northwind Supply');
    setTeamName(null);
    const error = new ApiError(403, { code: 'LOGISTICS_LEVEL_NOT_SELLER_CONTROLLED', message: 'refused' });

    expect(errorMessage(i18n.t.bind(i18n) as Translate, error)).toBe(
      'This level is managed by Northwind Supply.',
    );
  });

  it('names the operator’s team by its own name where one is set', () => {
    setMarketplaceName('Glovia');
    setTeamName('UBoss');
    expect(i18n.t('levels.mode.UBOSS', { ns: NAMESPACE })).toBe('UBoss');
    expect(i18n.t('levels.mode.HYBRID', { ns: NAMESPACE })).toBe('Self + UBoss');
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
      expect(i18n.t('levels.mode.UBOSS', { ns: NAMESPACE })).toBe('Northwind Supply');
    });
    expect(get).toHaveBeenCalledWith('/config');
  });
});
