/**
 * The i18next instance for the admin panel.
 *
 * Created here rather than through the global singleton so the two apps in
 * this repo cannot end up sharing state through a module that happens to be
 * loaded twice, and so a test can build its own instance without tearing down
 * a global one.
 *
 * Three configuration choices carry weight:
 *
 *   - **`keySeparator: false`.** Our keys are flat strings containing dots
 *     (`auth.login.heading`). Left at the default, i18next would read the dot
 *     as a path separator and look for a nested object. Flat keys keep the
 *     JSON diffable one line per string, which is what makes a translator's
 *     pull request readable.
 *   - **Lazy resources.** Each language is a dynamic `import()` of its JSON,
 *     so Vite emits one chunk per language and a member of staff downloads
 *     only the one they read. English is bundled because it is also the
 *     fallback for every key a translation has not covered yet.
 *   - **Detection is localStorage then the browser.** The account's saved
 *     preference is *not* a detector: it arrives asynchronously, after the
 *     first paint, and is applied by the provider. Detectors run
 *     synchronously at init and would have to block startup on a network call.
 *
 * The catalogue is separate from the storefront's on purpose. The two apps
 * share an engine, not a vocabulary: "Orders" is a staff work queue here and a
 * buyer's own purchase history there, and words identical in English diverge
 * once translated.
 */
import i18next, { type i18n as I18n } from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import resourcesToBackend from 'i18next-resources-to-backend';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LANGUAGE, LANGUAGE_CODES, type LanguageCode } from './languages';
import en from './locales/en.json';

/** One namespace. A second would buy nothing at this size and cost a prefix on every key. */
export const NAMESPACE = 'app';

/**
 * Where a member of staff's own choice is remembered.
 *
 * Deliberately a different key from the storefront's `uboss.language`: under a
 * tunnel the panel is served from the same origin as the shop, and a shared
 * key would mean switching the panel to Greek also switched the storefront in
 * the same browser.
 */
export const STORAGE_KEY = 'uboss.admin.language';

export const i18n: I18n = i18next.createInstance();

void i18n
  .use(
    resourcesToBackend(
      async (language: string) =>
        ((await import(`./locales/${language}.json`)) as { default: unknown }).default,
    ),
  )
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    // Only the languages we ship. Without this, a browser asking for `sv-SE`
    // would send i18next looking for a `sv` chunk that does not exist.
    supportedLngs: LANGUAGE_CODES,
    fallbackLng: DEFAULT_LANGUAGE,

    // `nl-BE` and `fr-BE` should resolve to Dutch and French. Stripping the
    // region is what makes Belgium work without a locale of its own.
    load: 'languageOnly',

    ns: [NAMESPACE],
    defaultNS: NAMESPACE,

    // See the note above: our keys contain dots and are not a path.
    keySeparator: false,
    nsSeparator: false,

    // English is bundled, not fetched. It is the fallback for every missing
    // key, so it has to be present before anything else has loaded.
    partialBundledLanguages: true,
    resources: { [DEFAULT_LANGUAGE]: { [NAMESPACE]: en } },

    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: STORAGE_KEY,
      caches: ['localStorage'],
    },

    interpolation: {
      // React escapes for us. Leaving i18next's own escaping on would
      // double-encode an apostrophe in a name into `&#39;`.
      escapeValue: false,
    },

    react: {
      // Keep the previous language on screen while the next chunk downloads.
      useSuspense: false,
    },
  });

/** Narrow a stored or server-sent value before handing it to i18next. */
export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && (LANGUAGE_CODES as readonly string[]).includes(value);
}
