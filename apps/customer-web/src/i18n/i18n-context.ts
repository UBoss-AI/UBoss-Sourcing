/**
 * The translation hooks screens call.
 *
 * These are a thin layer over `react-i18next`, not a wrapper around it. `t` is
 * i18next's own `t`, typed against the English catalogue - so `<Trans>`,
 * `useTranslation` and everything else in the ecosystem work alongside these
 * without translation between two worlds. The layer exists only to bundle the
 * three things a screen usually wants together: the translator, the current
 * language, and a way to change it.
 *
 * Note what this is *not*: it is not the currency/country locale in
 * `@/app/locale-context`. That one decides what a shopper is quoted in; this
 * one decides what language they read it in. They are deliberately
 * independent - a Polish buyer paying in euro is an ordinary case, and tying
 * them together would force a choice between a readable interface and a
 * correct price.
 */
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { languageOption, type LanguageCode } from './languages';

/**
 * The shorthand most screens use: `const t = useT()`.
 *
 * Identical to `useTranslation().t`. Kept because `t('key')` at the call site
 * is short enough that translating a screen is not a rewrite of it.
 */
export function useT(): ReturnType<typeof useTranslation>['t'] {
  return useTranslation().t;
}

export interface I18nState {
  /** The language the interface is currently rendered in. */
  language: string;

  /**
   * The Intl locale for the current language - hand this to `Intl.*` rather
   * than the language code, because the two differ (`en` vs `en-GB`).
   */
  intlLocale: string;

  /**
   * True when the active catalogue has not been reviewed by a native speaker.
   * Drives the notice under the picker; false for English, the source text.
   */
  isMachineTranslated: boolean;

  /** Translate a key, filling any `{{placeholder}}` slots. */
  t: ReturnType<typeof useTranslation>['t'];

  /** Switch language. The provider persists it to the account. */
  setLanguage: (next: LanguageCode) => void;
}

export function useI18n(): I18nState {
  const { t, i18n } = useTranslation();

  // `resolvedLanguage` is what is actually being rendered, which is not always
  // what was asked for - a request for an unsupported language resolves to the
  // fallback, and the picker must show the language on screen rather than the
  // one that failed to load.
  const language = i18n.resolvedLanguage ?? i18n.language;
  const option = languageOption(language);

  const setLanguage = useCallback(
    (next: LanguageCode) => {
      // Fire-and-forget. The detector writes the choice to localStorage, and
      // the provider mirrors it to the account. Awaiting the chunk here would
      // make the picker feel stuck on a slow connection for no benefit: the
      // previous language stays legible until the new one lands.
      void i18n.changeLanguage(next);
    },
    [i18n],
  );

  return {
    language,
    intlLocale: option.intlLocale,
    // English is the source text, so it is the one catalogue nobody
    // machine-translated.
    isMachineTranslated: option.code !== 'en',
    t,
    setLanguage,
  };
}
