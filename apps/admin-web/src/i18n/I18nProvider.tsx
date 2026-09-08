/**
 * Ties the account's saved language to the i18next instance.
 *
 * i18next itself now handles the parts that used to live here: reading and
 * writing localStorage, negotiating against `navigator.languages`, loading a
 * catalogue, and falling back to English for a missing key. What is left is
 * the one thing it cannot know about - the language saved against the
 * signed-in account.
 *
 * So the resolution order is split across two owners:
 *
 *   1. The country this sign-in came from, once per country  (this file)
 *   2. The signed-in account's saved `preferredLanguage`     (this file)
 *   3. A choice made in this browser, in localStorage        (the detector)
 *   4. What the browser asks for in `navigator.languages`    (the detector)
 *   5. English                                               (fallbackLng)
 *
 * Step 4 matters for a panel deployed to a European team: a warehouse user
 * whose browser is set to Polish lands on a Polish panel without touching
 * anything, and a Belgian one gets Dutch or French depending on which tag
 * their browser sends. It is a suggestion, not a decision - the moment
 * somebody uses the picker their choice is written to localStorage and
 * outranks it.
 *
 * Signing in adopts whatever was chosen while signed out, so a member of staff
 * who switched to Greek on the login screen is not thrown back to English the
 * instant they authenticate.
 *
 * Step 1 is the one that outranks a saved preference, and it is the only thing
 * here that does, so it is worth being precise about what it is:
 *
 *   - It fires **once per sign-in country**, not once per sign-in. Somebody
 *     signing in from Berlin gets a German panel; if they then switch it to
 *     English by hand, they keep English on every later sign-in from Germany,
 *     because the country that was adopted is remembered in this browser.
 *     Travel to France and the panel becomes French, because that is a country
 *     it has not adopted before.
 *   - The country comes from the geocoder behind the sign-in location gate,
 *     and the language from `countries.languageCode` - a row the deployment
 *     edits, not a table shipped in a release. A Brussels office reads French
 *     where an Antwerp one reads Dutch, and only the operator knows which.
 *   - A null language changes nothing. It is what the API answers for a
 *     country the panel ships no catalogue for, and leaving a Czech colleague
 *     on the Polish panel they chose is a better answer than throwing them
 *     into English for having crossed a border.
 *
 * What it is *not* is a lock. The picker is on every screen, the switch it
 * makes is saved to the account like any other, and nothing re-applies the
 * country's language until the country itself changes.
 *
 * Nothing is invalidated on a language change. The data behind every panel is
 * the same whatever language it is read in, and refetching a report because
 * somebody changed language would be a slow no-op.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { useSession } from '@/auth/session-context';
import { api } from '@/lib/api';
import { i18n, isLanguageCode } from './config';

interface AccountLanguageResponse {
  language: string | null;
}

/**
 * Which sign-in country's language this browser has already adopted.
 *
 * Deliberately separate from the language itself - and from the storefront's
 * keys, like every other key this app writes. What it remembers is not "the
 * panel is in German", it is "we have already had our say about Germany", and
 * that is what stops a member of staff who prefers the English panel being put
 * back into German every morning.
 *
 * localStorage rather than the session: the question it answers spans
 * sign-ins. In a browser where storage is blocked every read fails, the panel
 * adopts the sign-in country's language once per sign-in instead of once per
 * country, and nothing worse than that happens.
 */
const ADOPTED_COUNTRY_KEY = 'uboss.admin.language-country';

function adoptedCountry(): string | null {
  try {
    return window.localStorage.getItem(ADOPTED_COUNTRY_KEY);
  } catch {
    // Storage blocked. Treated as "nothing adopted yet".
    return null;
  }
}

function rememberAdoptedCountry(country: string): void {
  try {
    window.localStorage.setItem(ADOPTED_COUNTRY_KEY, country);
  } catch {
    // Storage blocked. The language still switched; it will switch again on
    // the next sign-in, which is the same answer one page reload gives.
  }
}

export function I18nProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const session = useSession();
  const userId = session.user?.id ?? null;

  // Where this sign-in came from, and what the deployment says an office there
  // reads. Both null until the location gate has posted a position, and both
  // null for good in a deployment that has the gate switched off.
  const signInCountry = session.user?.locationCountry ?? null;
  const signInLanguage = session.user?.locationLanguage ?? null;

  // --- tell the browser what language this page is in ----------------------
  // Not cosmetic: `lang` is what a screen reader picks a voice from, what the
  // browser offers to translate against, and what CSS hyphenation and quote
  // marks key off. A Greek page still claiming `lang="en"` is read aloud by an
  // English synthesiser, which is unintelligible.
  useEffect(() => {
    const apply = (): void => {
      document.documentElement.lang = i18n.resolvedLanguage ?? i18n.language;
    };

    apply();
    i18n.on('languageChanged', apply);

    return () => {
      i18n.off('languageChanged', apply);
    };
  }, []);

  // --- reconcile with the account ------------------------------------------
  // Read straight through `api` rather than react-query: it is one small
  // request per sign-in, not something worth caching and invalidating, and a
  // failure is ignored entirely - a language preference is never worth an
  // error state on top of a panel that is working.
  //
  // Guarded by a ref because this must fire once per sign-in, not on every
  // language change.
  //
  // Keyed on the account *and* the sign-in country, because both arrive in
  // stages: the first /me of a sign-in has no country yet - the location gate
  // has not run - and the reload after it grants one. Keying on the user alone
  // would mean the country never got a say on the sign-in it belongs to.
  const reconciledFor = useRef<string | null>(null);

  useEffect(() => {
    if (userId === null) {
      reconciledFor.current = null;
      return;
    }

    const key = `${userId}:${signInCountry ?? ''}`;
    if (reconciledFor.current === key) return;
    reconciledFor.current = key;

    let current = true;

    /**
     * Read the flag through a call, not directly.
     *
     * The cleanup below clears it while the awaits are in flight, which is
     * exactly what these checks are for - but the closure runs immediately, so
     * TypeScript still sees the `true` it was initialised with and calls every
     * check dead code. Same reason, and the same shape, as `isMounted` in
     * LocationGate.
     */
    const isCurrent = (): boolean => current;

    void (async () => {
      // --- 1. what the account has chosen ---------------------------------
      try {
        const response = await api.get<AccountLanguageResponse>('/admin/auth/language');
        if (!isCurrent()) return;

        if (isLanguageCode(response.language)) {
          // The account has an answer and it outranks the browser's guess.
          // The detector caches it to localStorage on the way through.
          await i18n.changeLanguage(response.language);
        } else {
          // The account has never chosen. Adopt whatever this browser
          // resolved, so a choice made on the login screen survives signing in
          // and the next device inherits it.
          void api
            .put('/admin/auth/language', { language: i18n.resolvedLanguage ?? i18n.language })
            .catch(() => {
              // Preference not saved. The browser still remembers it.
            });
        }
      } catch {
        // Signed in but the preference could not be read. Carry on in whatever
        // language the detector resolved - and still let the country below
        // have its say, since that is the one thing this sign-in does know.
      }

      if (!isCurrent()) return;

      // --- 2. the country this sign-in came from --------------------------
      // Last, so it outranks the account preference, and guarded so it does so
      // exactly once per country. See the note at the top of this file.
      if (signInCountry === null || !isLanguageCode(signInLanguage)) return;
      if (adoptedCountry() === signInCountry) return;

      rememberAdoptedCountry(signInCountry);

      // The listener below mirrors this to the account like any other switch,
      // so the next sign-in from anywhere starts where this one ended up.
      await i18n.changeLanguage(signInLanguage);
    })();

    return () => {
      current = false;
    };
  }, [userId, signInCountry, signInLanguage]);

  // --- mirror later switches back to the account ---------------------------
  useEffect(() => {
    if (userId === null) return;

    const save = (next: string): void => {
      if (!isLanguageCode(next)) return;

      void api.put('/admin/auth/language', { language: next }).catch(() => {
        // Saved locally but not to the profile. Nothing the reader can act on:
        // the interface has already switched.
      });
    };

    i18n.on('languageChanged', save);

    return () => {
      i18n.off('languageChanged', save);
    };
  }, [userId]);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
