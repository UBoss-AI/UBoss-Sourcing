/**
 * Holds the market the console reads prices for, and remembers it.
 *
 * The list of countries and the flag that says whether location changes any
 * price both come from the public config — the same document the storefront
 * prices against, so the panel cannot offer staff a market the shop does not
 * serve.
 *
 * The answer lives in this browser, not on the account. It is a viewing
 * position, the same kind of setting as which filter a table was left on:
 * somebody checking German prices this afternoon is not declaring a preference
 * worth carrying to their phone, and a column, a migration and a round trip
 * per deployment is a lot to spend on remembering one.
 *
 * Nothing is invalidated when the choice changes. Every priced read carries
 * the country in its query key, so those refetch on their own the moment it
 * moves, and the screens with no price on them - staff, audit, settings - are
 * left alone rather than being reloaded to no effect.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { MarketContext, type MarketCountry, type MarketState } from './market-context';

/** Remembers the choice for this browser. Cleared by the browser, not by us. */
const STORAGE_KEY = 'uboss.admin.market';

interface ConfigResponse {
  localisation: {
    countries: MarketCountry[];
    /** False in a deployment with no EU VAT: no price depends on a location. */
    locationPricing?: boolean;
  };
}

function readStored(): string | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null || raw === '' ? null : raw;
  } catch {
    // A private window, cleared site data, or a browser refusing storage. The
    // panel still works; the market is simply back to "not stated".
    return null;
  }
}

function writeStored(country: string | null): void {
  try {
    if (country === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, country);
  } catch {
    // Nothing to do. The choice holds for this page view only.
  }
}

export function MarketProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [stored, setStored] = useState<string | null>(() => readStored());

  // The same query key the pages that need the currency list use, so the
  // document is fetched once for the whole panel.
  const config = useQuery({
    queryKey: ['storefront-config'],
    queryFn: () => api.get<ConfigResponse>('/config'),
    // It changes about as often as a company name, and it is on screen from
    // the first paint of every page.
    staleTime: 5 * 60_000,
    // A config read must never take the panel down with it: without a country
    // list there is no picker, which is exactly the state a single-market
    // deployment is in anyway.
    retry: false,
  });

  // Memoised because it is a dependency of the context value below, and a
  // fresh `[]` on every render would hand every consumer a new object to
  // re-render for while nothing had actually changed.
  const countries = useMemo(() => config.data?.localisation.countries ?? [], [config.data]);

  // `!== false` rather than a truthy test: a config response cached from
  // before this flag existed must not read as "location changes nothing", or
  // the preview would vanish from a panel that had been showing it.
  const locationPricing = config.data?.localisation.locationPricing !== false;

  /**
   * The stored answer, checked against what this deployment now serves.
   *
   * A country staff deactivated last month must not go on quoting prices from
   * a browser that remembers it - the picker would show no matching option
   * while every figure on screen was still priced for it, which is the worst
   * of both.
   */
  const country = useMemo(() => {
    if (stored === null) return null;
    if (countries.length === 0) return null;

    return countries.some((entry) => entry.code === stored) ? stored : null;
  }, [countries, stored]);

  const choose = useCallback((next: string | null) => {
    writeStored(next);
    setStored(next);
  }, []);

  const value = useMemo<MarketState>(
    () => ({
      country,
      countries,
      locationPricing,
      countryName: countries.find((entry) => entry.code === country)?.name ?? null,
      choose,
    }),
    [choose, countries, country, locationPricing],
  );

  return <MarketContext.Provider value={value}>{children}</MarketContext.Provider>;
}
