/**
 * The shopper's market: which country they are in, and what they are quoted in.
 *
 * Split from the provider so that file exports only components — React Fast
 * Refresh cannot preserve state across an edit to a file that mixes the two.
 *
 * The currency here is passed to every catalogue read as `?currency=`, so the
 * grid, the product page and the cart all agree. It is never used to convert a
 * price: the backend holds a real figure per currency and returns that one.
 */
import { createContext, useContext } from 'react';
import type { CountryOption, CurrencyOption } from '@/lib/types';

export interface LocaleState {
  /** The currency every price on screen is quoted in. */
  currency: string;
  /** The shopper's country, or null when they have not been asked yet. */
  country: string | null;
  currencies: CurrencyOption[];
  countries: CountryOption[];

  /**
   * True when a signed-in shopper has never answered the question. The
   * storefront puts the picker up once, not on every visit.
   */
  needsChoice: boolean;

  /** What the browser thinks, for the picker to offer as a suggestion. */
  detectedCountry: string | null;
  /** True when the browser's reading disagrees with the saved answer. */
  detectedMismatch: boolean;

  /** Save a choice. Persists to the profile when signed in. */
  choose: (country: string, currency?: string) => Promise<void>;
  /** Dismiss the first-run picker without answering. */
  dismissChoice: () => void;
  /** Switch currency only, leaving the country alone. */
  setCurrency: (currency: string) => Promise<void>;
}

export const LocaleContext = createContext<LocaleState | null>(null);

export function useLocale(): LocaleState {
  const context = useContext(LocaleContext);

  if (context === null) {
    throw new Error('useLocale must be used inside a LocaleProvider.');
  }

  return context;
}
