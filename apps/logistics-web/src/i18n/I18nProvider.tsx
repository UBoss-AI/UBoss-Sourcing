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
 * Step 2 matters for a European carrier: a dispatcher whose browser is set to
 * Polish lands on a Polish portal without touching anything, and a Belgian one
 * gets Dutch or French depending on which tag their browser sends. It is a
 * suggestion, not a decision - the moment somebody uses the picker their
 * choice is written to localStorage and outranks it.
 *
 * WHY THERE IS NO ACCOUNT PREFERENCE HERE
 *
 * The console reconciles with a language saved against the staff account,
 * because a member of staff signs in from several machines. A carrier's
 * dispatcher signs in from the one in the depot, and a driver from the handset
 * in their pocket; the browser's own memory is the right scope, and an extra
 * request per sign-in to store what localStorage already knows would buy
 * nothing.
 *
 * The one thing this file does that i18next cannot: keep `<html lang>` in
 * step. That is not cosmetic - `lang` is what a screen reader picks a voice
 * from, and a Greek page still claiming `lang="en"` is read aloud by an
 * English synthesiser and is unintelligible.
 */
import { useEffect, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { i18n } from './config';

export function I18nProvider({ children }: { children: ReactNode }): React.JSX.Element {
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

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
