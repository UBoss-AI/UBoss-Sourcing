/**
 * Resolves the shopper's market and keeps it in one place.
 *
 * Where the answer comes from, most specific first:
 *
 *   1. The signed-in shopper's saved `preferredCurrency` / `preferredCountry`.
 *   2. A choice a signed-out visitor made in this browser (localStorage).
 *   3. The market the interface language points at, when this deployment
 *      sells in it.
 *   4. The base currency from the public config.
 *
 * Step 3 is the language talking, and it is the weakest signal here on
 * purpose. Language is not location - a Polish buyer paying in euro is an
 * ordinary case, which is why the two remain separate settings - but for
 * somebody who has never answered the question it beats the alternative,
 * which is quoting a Polish-reading shopper in the base currency of a business
 * they have never heard of. The moment they answer, steps 1 and 2 outrank it.
 *
 * For somebody who *has* answered, the language never silently reprices
 * anything. It raises `marketSuggestion` instead: an offer they can take or
 * turn down, and a refusal is remembered so the same offer is not made twice.
 *
 * A signed-in shopper who has never answered gets `needsChoice`, which is what
 * raises the picker exactly once. Signing in adopts whatever a visitor chose
 * while signed out, so answering the question before logging in is not wasted.
 *
 * Changing currency invalidates every query, because every price on screen is
 * quoted in it and a half-refreshed page would show two markets at once. The
 * server restamps the open cart to match.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStorefront } from '@/app/storefront-context';
import { useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import { suggestedCountryForLanguage } from '@/i18n/languages';
import { api } from '@/lib/api';
import { detectCountry } from '@/lib/geo';
import type { Locale } from '@/lib/types';
import { LocaleContext, type LocaleState, type MarketSuggestion } from './locale-context';

/** Remembers a signed-out visitor's answer. Cleared by the browser, not by us. */
const STORAGE_KEY = 'uboss.locale';

/**
 * Currencies the language has offered and the shopper has turned down.
 *
 * Kept in the browser rather than on the profile: it is a "stop asking me"
 * flag, not a preference, and it is not worth a column, a migration and a
 * round trip on every deployment to carry a dismissal between somebody's
 * devices. The worst case is being asked once more on a new laptop.
 */
const DECLINED_KEY = 'uboss.locale.declined';

interface StoredChoice {
  country: string;
  currency: string;
}

function readStored(): StoredChoice | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const { country, currency } = parsed as Partial<StoredChoice>;
    if (typeof country !== 'string' || typeof currency !== 'string') return null;

    return { country, currency };
  } catch {
    // A private window, cleared site data, or a browser refusing storage. The
    // storefront still works; the visitor is simply asked again.
    return null;
  }
}

function writeStored(choice: StoredChoice): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Nothing to do. The choice lives for this page view only.
  }
}

function readDeclined(): string[] {
  try {
    const raw = window.localStorage.getItem(DECLINED_KEY);
    if (raw === null) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    // Same as above. The offer is simply made once more.
    return [];
  }
}

function writeDeclined(codes: readonly string[]): void {
  try {
    window.localStorage.setItem(DECLINED_KEY, JSON.stringify(codes));
  } catch {
    // The dismissal holds for this page view only.
  }
}

interface SavePayload {
  country: string;
  currency: string;
  detectedCountry?: string;
}

export function LocaleProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const config = useStorefront();
  const session = useSession();
  const queryClient = useQueryClient();
  const { language } = useI18n();

  const [stored, setStored] = useState<StoredChoice | null>(() => readStored());
  const [dismissed, setDismissed] = useState(false);
  const [declined, setDeclined] = useState<string[]>(() => readDeclined());
  const [detected, setDetected] = useState<string | null>(null);

  const profileId = session.user?.customerProfileId ?? null;

  // --- what the browser thinks --------------------------------------------
  // The time zone alone, on load. The permission prompt is raised by the
  // picker, where the shopper can see why it is being asked.
  const zoneQuery = useQuery({
    queryKey: ['detected-country'],
    queryFn: () => detectCountry(false),
    staleTime: Infinity,
  });

  useEffect(() => {
    const guess = zoneQuery.data?.country ?? null;
    if (guess !== null) setDetected(guess);
  }, [zoneQuery.data]);

  // --- the saved answer ----------------------------------------------------
  const localeQuery = useQuery({
    queryKey: ['account-locale', profileId],
    queryFn: () => api.get<{ locale: Locale | null }>('/account/locale'),
    enabled: profileId !== null,
    // A locale read must never take the storefront down with it.
    retry: false,
    staleTime: 5 * 60_000,
  });

  const save = useMutation({
    mutationFn: (payload: SavePayload) => api.put<{ locale: Locale }>('/account/locale', payload),
    onSuccess: ({ locale }) => {
      queryClient.setQueryData(['account-locale', profileId], { locale });
    },
  });

  // Signing in adopts the choice made while signed out, so the question is not
  // asked twice for the same answer. Guarded by a ref because the query
  // refetches and this must fire once per profile.
  const adoptedFor = useRef<string | null>(null);

  useEffect(() => {
    if (profileId === null) {
      adoptedFor.current = null;
      return;
    }
    if (!localeQuery.isSuccess) return;
    if (localeQuery.data.locale !== null) return;
    if (stored === null) return;
    if (adoptedFor.current === profileId) return;

    adoptedFor.current = profileId;
    save.mutate({
      country: stored.country,
      currency: stored.currency,
      ...(detected === null ? {} : { detectedCountry: detected }),
    });
  }, [detected, localeQuery.data, localeQuery.isSuccess, profileId, save, stored]);

  const serverLocale = localeQuery.data?.locale ?? null;
  const baseCurrency = config.localisation.baseCurrency;

  // --- what the language points at -----------------------------------------
  // Filtered against this deployment's own configuration, twice over: the
  // country has to be one staff activated, and its currency has to be one the
  // catalogue is actually priced in. A store selling only in India must not
  // start quoting a Polish reader in złoty it holds no prices for - that is an
  // empty shop, which is worse than a readable one in an unexpected currency.
  const languageMarket = useMemo<Omit<MarketSuggestion, 'language'> | null>(() => {
    const countryCode = suggestedCountryForLanguage(language);
    if (countryCode === null) return null;

    const match = config.localisation.countries.find((entry) => entry.code === countryCode);
    if (match === undefined) return null;

    const priced = config.localisation.currencies.find(
      // `!== false` rather than a truthy test, as everywhere else here: a
      // config response cached from before that flag existed must not be read
      // as "this currency sells nothing".
      (entry) => entry.code === match.currencyCode && entry.hasProducts !== false,
    );
    if (priced === undefined) return null;

    return { country: match.code, countryName: match.name, currency: priced.code };
  }, [config.localisation.countries, config.localisation.currencies, language]);

  /** True once the shopper has said where they are, in either store. */
  const answered = serverLocale !== null || stored !== null;

  const currency =
    serverLocale?.currency ?? stored?.currency ?? languageMarket?.currency ?? baseCurrency;
  const country = serverLocale?.country ?? stored?.country ?? null;

  const choose = useCallback(
    async (nextCountry: string, nextCurrency?: string) => {
      const resolved =
        nextCurrency ??
        config.localisation.countries.find((entry) => entry.code === nextCountry)?.currencyCode ??
        baseCurrency;

      const choice = { country: nextCountry, currency: resolved };

      // The profile is the authority once somebody is signed in, so it is
      // written first and localStorage only mirrors what it accepted. Writing
      // the mirror first meant a failed save left the browser insisting on a
      // currency the account had never agreed to - the two then disagreed with
      // nothing to reconcile them.
      if (profileId !== null) {
        await save.mutateAsync({
          country: nextCountry,
          currency: resolved,
          ...(detected === null ? {} : { detectedCountry: detected }),
        });
      }

      writeStored(choice);
      setStored(choice);
      setDismissed(true);

      // Everything priced is now wrong, the cart included.
      await queryClient.invalidateQueries();
    },
    [
      baseCurrency,
      config.localisation.countries,
      detected,
      profileId,
      queryClient,
      save,
    ],
  );

  const setCurrency = useCallback(
    async (nextCurrency: string) => {
      if (country === null || country === '') {
        // No country yet - remember the currency alone until they answer.
        // Nothing to save server-side: there is no profile to save it to.
        const choice = { country: '', currency: nextCurrency };
        writeStored(choice);
        setStored(choice);
        await queryClient.invalidateQueries();
        return;
      }

      await choose(country, nextCurrency);
    },
    [choose, country, queryClient],
  );

  // Only markets the catalogue is actually priced in. The shopper's current
  // currency stays in the list even if it has emptied out, so the switcher
  // never renders with no matching option.
  const offerable = useMemo(
    () =>
      config.localisation.currencies.filter(
        // `!== false` rather than a truthy test: a config response that
        // predates this flag must not blank the switcher entirely.
        (entry) => entry.hasProducts !== false || entry.code === currency,
      ),
    [config.localisation.currencies, currency],
  );

  // Only a signed-in shopper is asked, and only once: there is nowhere to
  // remember "no thanks" for a visitor who never signs in.
  const needsChoice =
    profileId !== null && localeQuery.isSuccess && serverLocale === null && !dismissed;

  // --- the offer -----------------------------------------------------------
  // Suppressed in four cases, each for its own reason: nobody has answered yet
  // (the resolution above already applied the language's market, so there is
  // nothing left to offer), the first-run picker is up (it asks the same
  // question and asks it better), the language points where they already are,
  // or they have turned this currency down before.
  const marketSuggestion = useMemo<MarketSuggestion | null>(() => {
    if (languageMarket === null) return null;
    if (!answered || needsChoice) return null;
    if (languageMarket.currency === currency) return null;
    if (declined.includes(languageMarket.currency)) return null;

    return { language, ...languageMarket };
  }, [answered, currency, declined, language, languageMarket, needsChoice]);

  const acceptSuggestion = useCallback(async () => {
    if (marketSuggestion === null) return;

    // Country and currency together: taking the offer is the shopper saying
    // where they are, so it is recorded the same way the picker records it -
    // and `choose` is what reprices the catalogue and restamps the cart.
    await choose(marketSuggestion.country, marketSuggestion.currency);
  }, [choose, marketSuggestion]);

  const dismissSuggestion = useCallback(() => {
    if (marketSuggestion === null) return;

    setDeclined((current) => {
      if (current.includes(marketSuggestion.currency)) return current;

      const next = [...current, marketSuggestion.currency];
      writeDeclined(next);
      return next;
    });
  }, [marketSuggestion]);

  const value = useMemo<LocaleState>(
    () => ({
      currency,
      country: country === '' ? null : country,
      currencies: offerable,
      countries: config.localisation.countries,
      needsChoice,
      detectedCountry: serverLocale?.detectedCountry ?? detected,
      detectedMismatch:
        serverLocale?.detectedMismatch ??
        (detected !== null && country !== null && country !== '' && detected !== country),
      marketSuggestion,
      choose,
      dismissChoice: () => {
        setDismissed(true);
      },
      setCurrency,
      acceptSuggestion,
      dismissSuggestion,
    }),
    [
      acceptSuggestion,
      choose,
      config.localisation.countries,
      country,
      currency,
      detected,
      dismissSuggestion,
      marketSuggestion,
      needsChoice,
      offerable,
      serverLocale,
      setCurrency,
    ],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}
