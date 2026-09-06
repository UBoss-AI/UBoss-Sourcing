/**
 * "Which market am I looking at?" — in the top bar, on every page.
 *
 * A price list holds one figure per currency, and a currency is not a market:
 * Germany, the Netherlands and Ireland are all euro and charge 19%, 21% and
 * 23% on the same box. Staff pricing those markets need to see what a customer
 * there is actually charged, and they need it beside the figure they typed
 * rather than by opening the storefront in another tab and hoping the two
 * agree.
 *
 * It sits next to the language picker because it is the same kind of setting —
 * how this panel is being read, rather than anything about the catalogue — and
 * because the answer belongs on every screen that shows a price, not on one
 * panel inside one product. It was that once: a select on the per-currency
 * price card, which meant the product list beside it still quoted a market
 * nobody had chosen.
 *
 * It renders in two cases only, and the reasons differ:
 *
 *   - There have to be at least two countries to choose between. A
 *     single-market deployment has no question to ask.
 *   - Location has to change a price at all. With no EU VAT configured every
 *     buyer is quoted the listed figure, and a control that moves no number on
 *     any screen is worse than no control: it invites somebody to believe they
 *     have changed something.
 */
import { useId } from 'react';
import { useMarket } from '@/app/market-context';
import { useI18n } from '@/i18n/i18n-context';

export function MarketSwitcher(): React.JSX.Element | null {
  const { country, countries, locationPricing, choose } = useMarket();
  const { t } = useI18n();
  const selectId = useId();

  if (!locationPricing) return null;
  if (countries.length < 2) return null;

  return (
    <label htmlFor={selectId} className="flex items-center">
      <span className="sr-only">{t('market.label')}</span>
      <select
        id={selectId}
        // Empty while unanswered, so the placeholder shows rather than the
        // control silently claiming a market nobody picked.
        value={country ?? ''}
        onChange={(event) => {
          choose(event.target.value === '' ? null : event.target.value);
        }}
        // The same skin and height as the language picker beside it: the two
        // read as one pair of "how am I reading this panel" settings, which is
        // what they are. Narrow, because the bar also carries a breadcrumb.
        className="select-chevron h-10 max-w-[11rem] truncate rounded-md border border-border bg-surface pl-2.5 pr-7 text-xs font-medium text-ink"
      >
        <option value="">{t('market.nowhereStated')}</option>
        {countries.map((entry) => (
          <option key={entry.code} value={entry.code}>
            {t('market.customerIn', { country: entry.name })}
          </option>
        ))}
      </select>
    </label>
  );
}
