/**
 * Which market this panel is quoting prices for, and in what — in the top bar.
 *
 * It is where the person reading the screen signed in from, resolved from the
 * position the browser gave at sign-in, and it is not a choice. A price list
 * holds one figure per currency and a currency is not a market: Germany, the
 * Netherlands and Ireland are all euro and charge 19%, 21% and 23% on the same
 * box. What staff need is the figure a customer in front of them actually
 * pays, and the customer in front of them is in the country they are in.
 *
 * A picker was the obvious first answer and the wrong one. Any member of staff
 * could then read the whole catalogue against a member state nobody in the
 * business sells in, and the one number they could not check was the one they
 * were checking. Somebody who needs to see German prices is somebody signing
 * in from Germany.
 *
 * So this is a label, not a control. It exists because a column headed
 * "Customer pays" is only honest if the reader can see which customer, and
 * because the answer is not obvious from anything else on the screen.
 *
 * It names the currency as well as the country, because those are two separate
 * halves of one answer and the country alone does not give the second. The
 * catalogue holds a real figure per currency and converts nothing, so the
 * market decides *which price list* is being read as much as which VAT rate
 * lands on it — Germany and Ireland read the same euro row at 19% and 23%, and
 * neither of them reads the rupee row at all. A chip saying "Customer in
 * Germany" over a column of rupees was the half-answer this fixes.
 *
 * Where the market has no currency of its own that this deployment sells in,
 * the country is named alone: the panel is then quoting the seller's own
 * currency, and printing it beside a foreign country would read as a claim
 * about that country which is not true.
 *
 * It renders when the sign-in resolved a country - without one the panel
 * quotes the seller's own market, which is what it always did, and there is
 * nothing to announce - and when being in that country changes a price at all.
 * There are two separate ways it can:
 *
 *   - **The rate.** EU VAT configured, so the same row is charged differently
 *     in different member states.
 *   - **The price list.** The market has a currency of its own that is not the
 *     seller's, so the figure comes from a different column of
 *     `product_prices` entirely - and that is true in an Indian deployment
 *     with a dollar price list as much as in a European one.
 *
 * Where neither holds, every buyer is quoted the listed figure in the listed
 * currency, and a chip naming a country would suggest a difference that does
 * not exist.
 */
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { api } from '@/lib/api';
import { useI18n } from '@/i18n/i18n-context';

interface ConfigResponse {
  localisation: {
    countries: { code: string; name: string }[];
    /** What the console quotes when no market says otherwise. */
    baseCurrency?: string;
    /** False in a deployment with no EU VAT: no *rate* depends on a location. */
    locationPricing?: boolean;
  };
}

export function MarketIndicator(): React.JSX.Element | null {
  const { user } = useSession();
  const { t } = useI18n();

  // The same query key the pages that need the currency list use, so the
  // document is fetched once for the whole panel.
  const config = useQuery({
    queryKey: ['storefront-config'],
    queryFn: () => api.get<ConfigResponse>('/config'),
    // It changes about as often as a company name, and it is on screen from
    // the first paint of every page.
    staleTime: 5 * 60_000,
    // A config read must never take the panel down with it. Without it there
    // is no label, which is the state a single-market deployment is in anyway.
    retry: false,
    enabled: user !== null,
  });

  const country = user?.locationCountry ?? null;
  if (country === null) return null;

  // The currency comes from the session rather than from this config document:
  // the backend resolved it for the market at sign-in, and it is the same value
  // every price on the screen was quoted from. Reading the country list for it
  // here would be a second answer to a question already answered.
  const currency = user?.locationCurrency ?? null;
  const base = config.data?.localisation.baseCurrency ?? null;

  // `!== false` rather than a truthy test: a config response cached from
  // before this flag existed must not read as "location changes nothing" and
  // take the label away from a panel that had been showing it.
  const changesRate = config.data?.localisation.locationPricing !== false;
  const changesPriceList = currency !== null && base !== null && currency !== base;

  if (!changesRate && !changesPriceList) return null;

  // The configured name, never a hard-coded list: the deployment decides what
  // its countries are called, and this is the same list the storefront shows.
  // Falling back to the code keeps the label truthful while config loads, and
  // for a country the geocoder named that this shop does not sell in.
  const name = config.data?.localisation.countries.find((entry) => entry.code === country)?.name;

  return (
    <span className="hidden items-center rounded-md border border-border bg-surface-sunken px-2.5 py-1.5 text-xs font-medium text-ink-muted sm:inline-flex">
      {currency === null
        ? t('market.customerIn', { country: name ?? country })
        : t('market.customerInCurrency', { country: name ?? country, currency })}
    </span>
  );
}
