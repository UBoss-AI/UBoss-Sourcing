/**
 * Which market this panel is quoting prices for — in the top bar, on every page.
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
 * It renders in two cases only:
 *
 *   - The sign-in resolved a country. Without one the panel quotes the
 *     seller's own market, which is what it always did, and there is nothing
 *     to announce.
 *   - Location changes a price at all. With no EU VAT configured every buyer
 *     is quoted the listed figure, and a chip naming a country would suggest a
 *     difference that does not exist.
 */
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { api } from '@/lib/api';
import { useI18n } from '@/i18n/i18n-context';

interface ConfigResponse {
  localisation: {
    countries: { code: string; name: string }[];
    /** False in a deployment with no EU VAT: no price depends on a location. */
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

  // `!== false` rather than a truthy test: a config response cached from
  // before this flag existed must not read as "location changes nothing" and
  // take the label away from a panel that had been showing it.
  if (config.data?.localisation.locationPricing === false) return null;

  // The configured name, never a hard-coded list: the deployment decides what
  // its countries are called, and this is the same list the storefront shows.
  // Falling back to the code keeps the label truthful while config loads, and
  // for a country the geocoder named that this shop does not sell in.
  const name = config.data?.localisation.countries.find((entry) => entry.code === country)?.name;

  return (
    <span className="hidden items-center rounded-md border border-border bg-surface-sunken px-2.5 py-1.5 text-xs font-medium text-ink-muted sm:inline-flex">
      {t('market.customerIn', { country: name ?? country })}
    </span>
  );
}
