/**
 * `{{marketplace}}`: the operator's name, never the software vendor's.
 *
 * Every buyer of this software runs their own marketplace under their own
 * name. The seller's delivery-level screens used to say "UBOSS manages L2" in
 * all eight languages, on every buyer's deployment. The catalogues now say
 * `{{marketplace}}`, and `setMarketplaceName` fills it from `GET /config`.
 *
 * What these hold down:
 *   - no catalogue value names the vendor any more;
 *   - every `{{marketplace}}` is filled, in every language, including strings
 *     reached by a key built at run time (the error mapper), which is why the
 *     name is a default variable rather than an option at each call site;
 *   - a screen already on the page is redrawn when the name arrives.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { i18n, NAMESPACE, setMarketplaceName, setTeamName } from './config';
import { useT, type Translate } from './i18n-context';
import { LANGUAGES } from './languages';
import en from './locales/en.json';

const WITH_NAME = Object.entries(en)
  // `{{team}}` is the operator's own team (OPERATOR_TEAM_NAME), which falls back
  // to the marketplace's name: both name the operator, so both are held here.
  .filter(([, value]) => value.includes('{{marketplace}}') || value.includes('{{team}}'))
  .map(([key]) => key as keyof typeof en);

afterEach(async () => {
  setMarketplaceName(null);
  setTeamName(null);
  await i18n.changeLanguage('en');
});

function Label(): React.JSX.Element {
  const t = useT();
  return <p>{t('sellerLogistics.mode.HYBRID')}</p>;
}

describe('the marketplace name in the catalogue', () => {
  it('is used by the delivery-level strings', () => {
    expect(WITH_NAME).toEqual(
      expect.arrayContaining([
        'sellerLogistics.mode.UBOSS',
        'sellerLogistics.mode.HYBRID',
        'sellerLogistics.modeBody.HYBRID',
        'errors.logistics.LOGISTICS_LEVEL_NOT_SELLER_CONTROLLED',
      ]),
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
      const text = i18n.t(key, { ns: NAMESPACE });
      expect(text, `${code} ${key}`).toContain('Northwind Supply');
      // The NAME slot is filled. A sentence may carry other slots of its own -
      // the preorder chat's welcome names the product too - which its call site
      // fills; those are not this test's business.
      expect(text, `${code} ${key}`).not.toContain('{{marketplace}}');
      expect(text, `${code} ${key}`).not.toContain('{{team}}');
    }
  });

  it('is the product’s own name until the deployment’s arrives', () => {
    expect(i18n.t('sellerLogistics.mode.HYBRID', { ns: NAMESPACE })).toBe('Self + Glovia');

    setMarketplaceName('   ');
    expect(i18n.t('sellerLogistics.mode.HYBRID', { ns: NAMESPACE })).toBe('Self + Glovia');
  });

  it('fills a string reached through an error code', () => {
    setMarketplaceName('Northwind Supply');
    setTeamName(null);
    const error = new ApiError(403, { code: 'LOGISTICS_LEVEL_NOT_SELLER_CONTROLLED', message: 'refused' });

    const message = errorMessage(i18n.t.bind(i18n) as Translate, error);

    expect(message).toContain('Northwind Supply');
    expect(message).not.toContain('UBOSS');
  });

  it('lets a call site that passes its own name win', () => {
    setMarketplaceName('Northwind Supply');
    expect(i18n.t('sellerLogistics.mode.HYBRID', { ns: NAMESPACE, team: 'Acme' })).toBe(
      'Self + Acme',
    );
  });

  it('redraws a screen already on the page when the name arrives', () => {
    render(<Label />);
    expect(screen.getByText('Self + Glovia')).toBeInTheDocument();

    act(() => {
      setMarketplaceName('Northwind Supply');
      setTeamName(null);
    });

    expect(screen.getByText('Self + Northwind Supply')).toBeInTheDocument();
  });
});
