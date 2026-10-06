/**
 * The i18next instance, and the one thing it cannot do for itself.
 *
 * i18next handles reading and writing localStorage, negotiating against
 * `navigator.languages`, loading a catalogue and falling back to English for a
 * key a translation has not covered. So the resolution order is:
 *
 *   1. A choice made in this browser, in localStorage  (the detector)
 *   2. What the browser asks for in `navigator.languages` (the detector)
 *   3. English                                          (fallbackLng)
 *
 * The language saved on the audit account (`user.language` in
 * `GET /audit/auth/me`) is shown on the profile but not applied here: the
 * detector caches its first guess in localStorage at start-up, so an account
 * preference arriving after the first paint could never tell a deliberate
 * choice from that guess. The picker is the way to change it, and it is
 * remembered per browser.
 *
 * The one thing this file does that i18next cannot: keep `<html lang>` in
 * step. That is not cosmetic - `lang` is what a screen reader picks a voice
 * from, and a Greek page still claiming `lang="en"` is read aloud by an
 * English synthesiser and is unintelligible.
 */
import { useEffect, type ReactNode } from 'react';
import { setMoneyLocale } from '@/lib/format';
import { I18nextProvider } from 'react-i18next';
import { i18n } from './config';

export function I18nProvider({ children }: { children: ReactNode }): React.JSX.Element {
  useEffect(() => {
    const apply = (): void => {
      const language = i18n.resolvedLanguage ?? i18n.language;
      document.documentElement.lang = language;

      // Language, not currency, decides what a number looks like.
      setMoneyLocale(language);
    };

    apply();
    i18n.on('languageChanged', apply);

    return () => {
      i18n.off('languageChanged', apply);
    };
  }, []);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
