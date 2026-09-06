/**
 * Finds translation keys in the source and writes them out for comparison.
 *
 * Deliberately **not** pointed at `src/i18n/locales`. i18next-parser is happy
 * to own those files, and if it did, two things would go wrong the first time
 * somebody ran it:
 *
 *   - `en.json` is hand-written and is the source of truth for wording. The
 *     parser has no idea what the English text should be, so it would replace
 *     every value it could not find with the key itself.
 *   - Keys referenced indirectly - `labelKey: 'nav.orders'` in a data table,
 *     rather than `t('nav.orders')` - are invisible to a static scan, and
 *     would be deleted as unused.
 *
 * So it writes to a scratch directory instead, and the output is something to
 * diff against `locales/`, not something to ship:
 *
 *     npm run i18n:extract
 *     # then compare .extracted/en.json against src/i18n/locales/en.json
 *
 * What that comparison tells you: keys used in code that are missing from the
 * catalogue (a crash waiting to render a raw key), and keys in the catalogue
 * that no longer appear in code (candidates for deletion, to be checked by
 * hand because of the indirect-reference case above).
 */
export default {
  locales: ['en', 'nl', 'fr', 'de', 'el', 'it', 'pl', 'es'],

  // Matches the runtime config. Our keys are flat strings that happen to
  // contain dots; read as paths they would nest into unusable objects.
  keySeparator: false,
  nsSeparator: false,
  defaultNamespace: 'app',

  input: ['src/**/*.{ts,tsx}', '!src/**/*.test.{ts,tsx}', '!src/i18n/**'],
  output: '.extracted/$LOCALE.json',

  // Never silently drop a key. A key the scan cannot see is far more likely to
  // be an indirect reference than a genuinely dead string.
  keepRemoved: true,

  // Leave the value empty rather than inventing one, so a diff against the
  // real catalogue shows presence and absence rather than a wall of changed
  // wording.
  defaultValue: '',

  sort: true,
  createOldCatalogs: false,
  failOnWarnings: false,
};
