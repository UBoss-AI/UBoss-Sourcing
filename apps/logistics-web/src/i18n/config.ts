/**
 * The i18next instance for the logistics partner portal.
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
 * The catalogue is separate from the other two on purpose. The three apps
 * share an engine, not a vocabulary: a "shipment" is a consignment a carrier
 * is holding here, a dispatch note in the console and a parcel on its way in
 * the shop, and words identical in English diverge once translated.
 *
 * English is the source catalogue and the only one written by hand. The other
 * seven are complete translations of it, and every key a translation has not
 * covered still falls back to English rather than rendering raw - see SETUP.md
 * for the script that fills a newly added key in the other seven.
 */
import i18next, { type i18n as I18n } from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import resourcesToBackend from 'i18next-resources-to-backend';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LANGUAGE, LANGUAGE_CODES, type LanguageCode } from './languages';
import en from './locales/en.json';
import { PRODUCT_BRAND } from '../lib/brand';

/** One namespace. A second would buy nothing at this size and cost a prefix on every key. */
export const NAMESPACE = 'app';

/**
 * Where a dispatcher's own choice is remembered.
 *
 * A THIRD key, deliberately. A cookie and a localStorage entry are identified
 * by origin, and all three applications share one whenever they sit on the
 * same hostname - which is every local setup. A shared key would mean
 * switching the portal to Greek also switching the console and the storefront
 * in the same browser.
 */
export const STORAGE_KEY = 'uboss.logistics.language';

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
      // `{{marketplace}}`: the name this deployment trades under. The product's
      // own name until `setMarketplaceName` is handed the operator's.
      defaultVariables: { marketplace: PRODUCT_BRAND },
    },

    react: {
      // Keep the previous language on screen while the next chunk downloads.
      useSuspense: false,
      // Redraw on the marketplace's name as well as on the language. See
      // `MARKETPLACE_CHANGED` below.
      bindI18n: 'languageChanged marketplaceChanged',
    },
  });

/** Narrow a stored or server-sent value before handing it to i18next. */
export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && (LANGUAGE_CODES as readonly string[]).includes(value);
}

/**
 * The event every translated screen re-renders on when the name changes.
 *
 * Bound through `react.bindI18n` above, beside `languageChanged`, so a
 * screen drawn before `GET /config` answered is redrawn with the real name
 * rather than keeping the fallback until something else happens to it.
 */
export const MARKETPLACE_CHANGED = 'marketplaceChanged';

/**
 * Fill `{{marketplace}}` in every string with the name this deployment trades
 * under.
 *
 * Every buyer of this software runs their own marketplace under their own
 * name, so a sentence such as "Northwind manages L2" cannot carry a name of its
 * own. The catalogues say `{{marketplace}}` and the name arrives with
 * `GET /config` as `marketplace.displayName`, from the operator's business
 * profile.
 *
 * It is a default interpolation variable rather than an option passed at each
 * call site, because many of these strings are reached by a key built at run
 * time - an error code, a mode, a pricing state - from helpers with no
 * component around them. A call site that does pass its own `marketplace`
 * still wins. Until the name arrives, and if it never does, the product's own
 * name stands in, as it does in the header: never the software vendor's.
 */
export function setMarketplaceName(name: string | null | undefined): void {
  const trimmed = (name ?? '').trim();
  const next = trimmed.length > 0 ? trimmed : PRODUCT_BRAND;
  const interpolation = (i18n.options.interpolation ??= {});
  const variables = (interpolation.defaultVariables ??= {}) as Record<string, unknown>;
  if (variables['marketplace'] === next) return;
  variables['marketplace'] = next;
  i18n.emit(MARKETPLACE_CHANGED);
}
