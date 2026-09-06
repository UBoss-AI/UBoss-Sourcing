/**
 * The market the console is currently reading prices for.
 *
 * Split from the provider so that file exports only components — React Fast
 * Refresh cannot preserve state across an edit to a file that mixes the two.
 *
 * This is a *viewing* choice, not an editing one. Every price in this panel is
 * stored per currency, exactly as staff typed it; what a country changes is
 * what the panel says a customer standing there is charged for that figure,
 * which in the EU differs by member state on the same euro row. It is passed
 * to priced reads as `?country=` and never sent on a write.
 *
 * Deliberately not the language in `@/i18n/i18n-context`, and deliberately not
 * a currency: a Dutch colleague pricing the German market in euro is the
 * ordinary case, and tying any two of those three together would force a
 * choice between a readable panel and a correct preview.
 */
import { createContext, useContext } from 'react';

export interface MarketCountry {
  /** ISO-3166-1 alpha-2. */
  code: string;
  name: string;
  currencyCode: string;
}

export interface MarketState {
  /**
   * The country prices are previewed for, or null for "not stated".
   *
   * Null is a real answer rather than a missing one: the backend reads it the
   * way it reads a shopper who has not given a delivery address, and quotes
   * the seller's own country. That is the honest default — it is what the
   * storefront shows somebody who has not said where they are — rather than
   * picking a member state on staff's behalf and letting them read its rate
   * as universal.
   */
  country: string | null;

  /** The countries this deployment serves, as configured. */
  countries: MarketCountry[];

  /**
   * Whether a price here depends on where the buyer is at all.
   *
   * False in a deployment with no EU VAT configured, where every buyer is
   * quoted the listed figure. The picker stays out of the header when this is
   * false, because a control that can change no number on any screen is worse
   * than no control: it invites staff to believe they have changed something.
   */
  locationPricing: boolean;

  /** The name of `country`, for a sentence. Null when none is chosen. */
  countryName: string | null;

  /** Choose a market, or pass null for "not stated". Requotes every screen. */
  choose: (country: string | null) => void;
}

export const MarketContext = createContext<MarketState | null>(null);

export function useMarket(): MarketState {
  const context = useContext(MarketContext);

  if (context === null) {
    throw new Error('useMarket must be used inside a MarketProvider.');
  }

  return context;
}
