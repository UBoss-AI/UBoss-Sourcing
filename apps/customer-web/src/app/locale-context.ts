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

/**
 * A market the interface language points at, offered to a shopper who is
 * currently being quoted in a different one.
 *
 * Reading a location out of a language is a guess, so this is only ever an
 * offer. It exists because the alternative guesses worse: somebody who has
 * switched the whole storefront into Polish is more likely than not shopping
 * in Poland, and leaving them on a euro price list they never chose is a
 * quote in the wrong currency — the most expensive thing this storefront can
 * get wrong.
 */
export interface MarketSuggestion {
  /** The language that prompted the offer, e.g. `pl`. */
  language: string;
  /** The country it points at. Always one this deployment serves. */
  country: string;
  /** That country's name, as configured, for the banner text. */
  countryName: string;
  /** The currency being offered. Never the one already on screen. */
  currency: string;
}

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

  /**
   * The market the current language points at, when the shopper has already
   * answered and is being quoted in something else. Null when there is
   * nothing to offer, when they turned this offer down before, or when the
   * first-run picker is up — that asks the same question, better.
   */
  marketSuggestion: MarketSuggestion | null;

  /** Save a choice. Persists to the profile when signed in. */
  choose: (country: string, currency?: string) => Promise<void>;
  /** Dismiss the first-run picker without answering. */
  dismissChoice: () => void;
  /** Switch currency only, leaving the country alone. */
  setCurrency: (currency: string) => Promise<void>;
  /** Take the language's market. Sets country and currency together. */
  acceptSuggestion: () => Promise<void>;
  /** Turn the offer down. Remembered, so it is not made again. */
  dismissSuggestion: () => void;
}

export const LocaleContext = createContext<LocaleState | null>(null);

export function useLocale(): LocaleState {
  const context = useContext(LocaleContext);

  if (context === null) {
    throw new Error('useLocale must be used inside a LocaleProvider.');
  }

  return context;
}
