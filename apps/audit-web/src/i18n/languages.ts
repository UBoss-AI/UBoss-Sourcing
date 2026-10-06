/**
 * The languages the interface is available in.
 *
 * This is the registry the picker reads and the list i18next is configured
 * with, so a new language is added here and in one loader line, and nowhere
 * else. Adding a code here without a matching `locales/<code>.json` is not
 * safe: i18next will try to fetch the chunk. Add both.
 *
 * `endonym` is deliberately the name in the language itself - a Greek speaker
 * looking for their language scans for "Ελληνικά", not for "Greek". The
 * English name is kept alongside for staff-facing listings and for anywhere a
 * support agent has to read the value out loud.
 *
 * `intlLocale` is what goes to `Intl` for dates, numbers and currency. It is
 * separate from `code` because the two are not the same thing: the UI language
 * is a choice, while the formatting locale needs a region to behave correctly.
 * i18next handles plural rules itself from the language code.
 */

export interface LanguageOption {
  /** The code stored in the profile and in localStorage. BCP-47 primary subtag. */
  code: LanguageCode;
  /** The language's name in itself, for the picker. */
  endonym: string;
  /** The language's name in English, for staff-facing listings. */
  english: string;
  /** Passed to Intl for dates, numbers and currency. */
  intlLocale: string;
}

/**
 * The order here is the order in the dropdown: English first because it is the
 * default and the fallback, then the rest alphabetically by their English
 * name. Sorting by endonym instead would scatter the Greek entry to the end of
 * the list for every reader who cannot read the alphabet it is written in.
 */
export const LANGUAGES = [
  { code: 'en', endonym: 'English', english: 'English', intlLocale: 'en-GB' },
  { code: 'nl', endonym: 'Nederlands', english: 'Dutch', intlLocale: 'nl-NL' },
  { code: 'fr', endonym: 'Français', english: 'French', intlLocale: 'fr-FR' },
  { code: 'de', endonym: 'Deutsch', english: 'German', intlLocale: 'de-DE' },
  { code: 'el', endonym: 'Ελληνικά', english: 'Greek', intlLocale: 'el-GR' },
  { code: 'it', endonym: 'Italiano', english: 'Italian', intlLocale: 'it-IT' },
  { code: 'pl', endonym: 'Polski', english: 'Polish', intlLocale: 'pl-PL' },
  { code: 'es', endonym: 'Español', english: 'Spanish', intlLocale: 'es-ES' },
] as const satisfies readonly LanguageOption[];

export type LanguageCode = 'en' | 'nl' | 'fr' | 'de' | 'el' | 'it' | 'pl' | 'es';

/** Just the codes, for i18next's `supportedLngs`. */
export const LANGUAGE_CODES: readonly LanguageCode[] = LANGUAGES.map((entry) => entry.code);

/**
 * English is the default and the fallback, and those are two separate jobs.
 * As the default it is what an account that has never chosen sees. As the
 * fallback it fills any key a translated catalogue is missing, which is what
 * lets a catalogue ship partially translated instead of showing raw key names
 * to a customer.
 */
export const DEFAULT_LANGUAGE = 'en' satisfies LanguageCode;

const BY_CODE = new Map<string, LanguageOption>(LANGUAGES.map((entry) => [entry.code, entry]));

export function languageOption(code: string): LanguageOption {
  // i18next reports the resolved language as a plain string, and under
  // `load: 'languageOnly'` that is normally one of ours - but a fallback or a
  // mid-switch read can hand back something else, and rendering the whole UI
  // against a broken locale is worse than falling back to the one catalogue
  // that is always complete.
  return BY_CODE.get(code) ?? LANGUAGES[0];
}
