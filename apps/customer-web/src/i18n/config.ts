/**
 * The i18next instance for the storefront.
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
 *     so Vite emits one chunk per language and a visitor downloads only the
 *     one they read. English is preloaded because it is also the fallback for
 *     every key a translation has not covered yet.
 *   - **Detection is localStorage then the browser.** The account's saved
 *     preference is *not* a detector: it arrives asynchronously, after the
 *     first paint, and is applied by the provider. Detectors run
 *     synchronously at init and would have to block startup on a network call.
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

/** Where a visitor's own choice is remembered. Read by the detector below. */
export const STORAGE_KEY = 'uboss.language';

export const i18n: I18n = i18next.createInstance();

void i18n
  .use(
    resourcesToBackend(
      async (language: string) =>
        // Written as an explicit dynamic import of a template path so Vite can
        // still see the whole `locales` directory and pre-bundle a chunk for
        // each file in it.
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
    // No `ns:key` syntax either, for the same reason - one namespace, and a
    // colon in a key should be a key, not a lookup instruction.
    nsSeparator: false,

    // English is bundled, not fetched. It is the fallback for every missing
    // key, so it has to be present before anything else has loaded.
    partialBundledLanguages: true,
    resources: { [DEFAULT_LANGUAGE]: { [NAMESPACE]: en } },

    detection: {
      // localStorage first: an explicit choice outranks what the browser
      // happens to be configured for. `navigator` is the suggestion that puts
      // a Polish buyer on a Polish storefront before they touch anything.
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: STORAGE_KEY,
      caches: ['localStorage'],
    },

    interpolation: {
      // React escapes for us. Leaving i18next's own escaping on would
      // double-encode an apostrophe in a business name into `&#39;`.
      escapeValue: false,
      // `{{marketplace}}`: the name this deployment trades under. The product's
      // own name until `setMarketplaceName` is handed the operator's.
      // `{{team}}`: who answers a preorder chat. See `setChatTeamName`.
      defaultVariables: { marketplace: PRODUCT_BRAND, team: PRODUCT_BRAND },
    },

    react: {
      // Keep the previous language on screen while the next chunk downloads.
      // Half a second of the old wording reads better than a flash of raw keys.
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

/**
 * Fill `{{team}}` - the name the preorder chat's team goes by - in every string.
 *
 * Usually the marketplace's own name, and it falls back to that. It is its
 * own setting (`PREORDER_CHAT_TEAM_NAME`, sent as
 * `marketplace.chatTeamName` by `GET /config`) because an operator can
 * trade under one name and answer as a team with another: a storefront
 * called Glovia whose buyers talk to "the UBoss team". Renaming the store to
 * get the team's name right would rename the header, the emails and the
 * payment sheets too.
 *
 * The catalogues say `{{team}}` in every sentence about the people who
 * answer ("the {{team}} team is available", "{{team}} closed this
 * conversation") and `{{marketplace}}` in every sentence about the platform
 * ("Chat with {{marketplace}}").
 */
export function setChatTeamName(name: string | null | undefined): void {
  const trimmed = (name ?? '').trim();
  const interpolation = (i18n.options.interpolation ??= {});
  const variables = (interpolation.defaultVariables ??= {}) as Record<string, unknown>;
  const next = trimmed.length > 0 ? trimmed : (variables['marketplace'] as string | undefined) ?? PRODUCT_BRAND;
  if (variables['team'] === next) return;
  variables['team'] = next;
  i18n.emit(MARKETPLACE_CHANGED);
}
