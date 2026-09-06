/**
 * Ties the account's saved language to the i18next instance.
 *
 * i18next itself now handles the parts that used to live here: reading and
 * writing localStorage, negotiating against `navigator.languages`, loading a
 * catalogue, and falling back to English for a missing key. What is left is
 * the one thing it cannot know about - the language saved against the
 * signed-in account.
 *
 * So the resolution order is unchanged, just split across two owners:
 *
 *   1. The signed-in account's saved `preferredLanguage`  (this file)
 *   2. A choice made in this browser, in localStorage      (the detector)
 *   3. What the browser asks for in `navigator.languages`  (the detector)
 *   4. English                                             (fallbackLng)
 *
 * Step 3 is the one that earns its keep in Europe: a Polish buyer who has
 * never touched the picker still lands on a Polish storefront, and a Belgian
 * one gets Dutch or French depending on which tag their browser sends. It is a
 * suggestion, not a decision - the moment somebody uses the picker their
 * choice is written to localStorage and outranks it.
 *
 * Signing in adopts whatever was chosen while signed out, so a customer who
 * switched to Greek on the login screen is not thrown back to English the
 * instant they authenticate. That is the whole reason the picker is on the
 * login page rather than only in the account settings.
 *
 * Nothing is invalidated on a language change. Prices and product data are the
 * same whatever language they are read in, and refetching the catalogue on a
 * switch would be a slow no-op. A currency change is the one that reprices.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { useSession } from '@/auth/session-context';
import { api } from '@/lib/api';
import { i18n, isLanguageCode } from './config';

interface AccountLanguageResponse {
  language: string | null;
}

export function I18nProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const session = useSession();
  const userId = session.user?.id ?? null;

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
  // error state on top of a storefront that is working.
  //
  // Guarded by a ref because this must fire once per sign-in, not on every
  // language change.
  const reconciledFor = useRef<string | null>(null);

  useEffect(() => {
    if (userId === null) {
      reconciledFor.current = null;
      return;
    }

    if (reconciledFor.current === userId) return;
    reconciledFor.current = userId;

    let current = true;

    void api
      .get<AccountLanguageResponse>('/auth/language')
      .then((response) => {
        if (!current) return;

        if (isLanguageCode(response.language)) {
          // The account has an answer and it outranks the browser's guess.
          // The detector caches it to localStorage on the way through.
          void i18n.changeLanguage(response.language);
          return;
        }

        // The account has never chosen. Adopt whatever this browser resolved,
        // so a choice made on the login screen survives signing in and the
        // next device inherits it.
        void api
          .put('/auth/language', {
            language: i18n.resolvedLanguage ?? i18n.language,
          })
          .catch(() => {
            // Preference not saved. The browser still remembers it.
          });
      })
      .catch(() => {
        // Signed in but the preference could not be read. Carry on in whatever
        // language the detector resolved.
      });

    return () => {
      current = false;
    };
  }, [userId]);

  // --- mirror later switches back to the account ---------------------------
  // Only while signed in, and only after the reconcile above has run, so the
  // adopt-on-sign-in path is not raced by its own `changeLanguage`.
  useEffect(() => {
    if (userId === null) return;

    const save = (next: string): void => {
      if (!isLanguageCode(next)) return;

      void api.put('/auth/language', { language: next }).catch(() => {
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
