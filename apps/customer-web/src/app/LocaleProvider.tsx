/**
 * Resolves the shopper's market and keeps it in one place.
 *
 * Where the answer comes from, most specific first:
 *
 *   1. The signed-in shopper's saved `preferredCurrency` / `preferredCountry`.
 *   2. A choice a signed-out visitor made in this browser (localStorage).
 *   3. The base currency from the public config.
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
import { api } from '@/lib/api';
import { detectCountry } from '@/lib/geo';
import type { Locale } from '@/lib/types';
import { LocaleContext, type LocaleState } from './locale-context';

/** Remembers a signed-out visitor's answer. Cleared by the browser, not by us. */
const STORAGE_KEY = 'uboss.locale';

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

interface SavePayload {
  country: string;
  currency: string;
  detectedCountry?: string;
}

export function LocaleProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const config = useStorefront();
  const session = useSession();
  const queryClient = useQueryClient();

  const [stored, setStored] = useState<StoredChoice | null>(() => readStored());
  const [dismissed, setDismissed] = useState(false);
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

  const currency = serverLocale?.currency ?? stored?.currency ?? baseCurrency;
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

  const value = useMemo<LocaleState>(
    () => ({
      currency,
      country: country === '' ? null : country,
      currencies: offerable,
      countries: config.localisation.countries,
      // Only a signed-in shopper is asked, and only once: there is nowhere to
      // remember "no thanks" for a visitor who never signs in.
      needsChoice:
        profileId !== null && localeQuery.isSuccess && serverLocale === null && !dismissed,
      detectedCountry: serverLocale?.detectedCountry ?? detected,
      detectedMismatch:
        serverLocale?.detectedMismatch ??
        (detected !== null && country !== null && country !== '' && detected !== country),
      choose,
      dismissChoice: () => {
        setDismissed(true);
      },
      setCurrency,
    }),
    [
      choose,
      config.localisation.countries,
      country,
      currency,
      detected,
      dismissed,
      localeQuery.isSuccess,
      offerable,
      profileId,
      serverLocale,
      setCurrency,
    ],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}
