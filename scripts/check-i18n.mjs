/**
 * Are the translation catalogues actually complete?
 *
 * Eight languages across three applications is about 67,000 strings, and every
 * failure mode below is invisible in review and obvious to a customer:
 *
 *   - a key missing from Greek renders the raw key, so somebody in Athens
 *     reads `cart.checkout.confirmButton` where a button should be;
 *   - a placeholder dropped in translation renders "You have items" where the
 *     number was meant to go, or worse, renders `{{count}}` verbatim;
 *   - an extra key nobody references is dead weight that hides real gaps in
 *     the diff;
 *   - an English string left in the French file is the one that survives
 *     review longest, because it reads perfectly well to whoever is checking.
 *
 * WHY THIS IS NOT i18next-parser
 *
 * The parser answers a different question - which keys does the SOURCE use -
 * and it cannot answer this one, because a key referenced indirectly
 * (`labelKey: 'nav.orders'` in a table definition) is invisible to a static
 * scan. This compares the catalogues against each other, where English is the
 * reference, and every key in it is by definition a key the product uses.
 *
 * Exit code 1 on any error, so CI can gate on it. Warnings do not fail.
 *
 *     node scripts/check-i18n.mjs
 *     node scripts/check-i18n.mjs --app customer-web
 */
import { readFileSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const APPS = ['customer-web', 'admin-web', 'logistics-web'];

/** English is the reference and the fallback. Everything is compared to it. */
const REFERENCE = 'en';

/**
 * Strings that are legitimately identical in English and another language.
 *
 * This is the allowlist the "English left in a translation" check needs to be
 * usable at all. Brand names, product identifiers, units, protocol words and
 * one-word borrowings are the same in several of these languages, and flagging
 * them would bury the real findings under hundreds of false ones.
 *
 * Matched case-insensitively against the WHOLE string, so it excuses a value
 * that IS one of these, never a sentence that merely contains one.
 */
const SAME_IN_ANY_LANGUAGE = new Set(
  [
    'Glovia',
    'UBOSS',
    'ERP',
    'API',
    'SKU',
    'EAN',
    'GTIN',
    'PDF',
    'CSV',
    'XML',
    'JSON',
    'URL',
    'ID',
    'VAT',
    'GST',
    'IBAN',
    'BIC',
    'SWIFT',
    'GPSR',
    'CE',
    'UDI',
    'MDR',
    'IVDR',
    'GDPR',
    'OK',
    'Email',
    'E-mail',
    'Online',
    'Offline',
    'Status',
    'Import',
    'Export',
    'Total',
    'Info',
    'Portal',
    'Partner',
    'Standard',
    'Express',
    'Premium',
    'Start',
    'Stop',
    'Reset',
    'Test',
    'Demo',
    'Filter',
    'Menu',
    'Logo',
    'Fax',
    'Mobile',
    'Router',
    'Server',
    'Token',
    'Kanban',
    'Dashboard',
    'Marketplace',
    'Stripe',
    'Razorpay',
    'PayPal',
    'Google',
    'Microsoft',
    'Excel',
    'Gemini',
    'kg',
    'g',
    'mm',
    'cm',
    'm',
    'km',
    'ml',
    'l',
    '%',
    '-',
    '—',
    '/',
    ':',
  ].map((entry) => entry.toLowerCase()),
);

/**
 * Keys whose value is deliberately the same in every language.
 *
 * A KEY list rather than a value list, because the reason is a property of
 * what the key is FOR, not of how its English happens to read. These are
 * brand names, worked examples and identifiers: translating "monday.com" or
 * "finance@yourcompany.com" would be a bug, and a placeholder e-mail address
 * rendered in Greek would be a worse one.
 *
 * Anything added here is a claim that the string must never be translated.
 * That claim is cheap to make and expensive to be wrong about, so the list
 * stays short and every entry is one of the four categories above.
 */
const NEVER_TRANSLATED_KEYS = new Set([
  // Brand and product names.
  //
  // The product itself — "Glovia" — and the attribution under it — "Powered by
  // UBOSS" — are not in here, because they are not in the catalogues at all.
  // They are constants, one module per application: see
  // `apps/customer-web/src/lib/brand.ts` for why a name is not a string to
  // translate. What IS here is a feature whose name happens to contain the
  // brand.
  'aiInsights.title',
  'erp.system.monday',
  'erp.wizard.presetSearchPlaceholder',
  // Worked examples shown in placeholders and help text. A reader copies the
  // shape, not the words, and a localised example address is a support call.
  'scheduleBuilder.financeYourcompanyCom',
  'audit.staffExampleCom',
  'integrations.rzpTest',
]);

/**
 * Plural suffixes i18next understands.
 *
 * A key with `_other` must have `_one` in a language that distinguishes them,
 * and Polish additionally has `_few` and `_many`. Rather than encode the CLDR
 * rules here - which would be a second, worse copy of something `Intl` already
 * knows - the required set is asked of `Intl.PluralRules` per language.
 */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function requiredPluralCategories(language) {
  try {
    return new Set(new Intl.PluralRules(language).resolvedOptions().pluralCategories);
  } catch {
    return new Set(['one', 'other']);
  }
}

/** Every leaf in a nested catalogue, as `a.b.c` -> string. */
function flatten(value, prefix = '', into = new Map()) {
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;

    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      flatten(entry, path, into);
    } else {
      into.set(path, entry);
    }
  }

  return into;
}

/**
 * The interpolations in a string: `{{count}}`, `{{name, number}}`.
 *
 * Compared as a SET rather than a sequence, because word order legitimately
 * changes between languages - German routinely moves the verb, and a French
 * sentence may put the count last where English puts it first. What must not
 * change is WHICH values appear.
 */
function placeholders(text) {
  if (typeof text !== 'string') return new Set();

  const found = new Set();
  const pattern = /\{\{\s*([^},\s]+)/g;

  let match = pattern.exec(text);
  while (match !== null) {
    found.add(match[1]);
    match = pattern.exec(text);
  }

  return found;
}

/** i18next's own tag syntax: `<0>text</0>` in a Trans component. */
function tagIndices(text) {
  if (typeof text !== 'string') return new Set();

  const found = new Set();
  const pattern = /<(\d+)>/g;

  let match = pattern.exec(text);
  while (match !== null) {
    found.add(match[1]);
    match = pattern.exec(text);
  }

  return found;
}

/**
 * Is this string plausibly English somebody forgot to translate?
 *
 * Conservative on purpose. A false positive here is worse than a false
 * negative, because a check that cries wolf on "Minimum {{quantity}}" - which
 * is already correct French - is a check people stop reading.
 */
function looksUntranslated(value) {
  const text = value.trim();

  if (SAME_IN_ANY_LANGUAGE.has(text.toLowerCase())) return false;

  // Strip the placeholders and the tags: whatever is left is the only part
  // that could have been translated.
  const prose = text
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/<\/?\d+>/g, ' ')
    .replace(/[^\p{L}\s]+/gu, ' ')
    .trim();

  if (prose === '') return false;

  const words = prose.split(/\s+/).filter((word) => word.length > 2);

  // One word is not evidence. Half the interface's nouns - "Status", "Import",
  // "Portal", "Code", "Open", "Product" - are spelled the same in several of
  // these languages, and a single shared word is far more likely to be a
  // correct translation than a missed one.
  return words.length >= 2;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const entry of a) if (!b.has(entry)) return false;
  return true;
}

function sorted(set) {
  return [...set].sort().join(', ');
}

// ---------------------------------------------------------------------------

const errors = [];
const warnings = [];

function error(app, language, message) {
  errors.push(`${app}/${language}.json: ${message}`);
}

function warn(app, language, message) {
  warnings.push(`${app}/${language}.json: ${message}`);
}

async function checkApp(app) {
  const dir = join(ROOT, 'apps', app, 'src', 'i18n', 'locales');

  if (!existsSync(dir)) {
    errors.push(`${app}: no locales directory at ${dir}`);
    return;
  }

  const files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  const languages = files.map((name) => name.replace(/\.json$/, ''));

  if (!languages.includes(REFERENCE)) {
    errors.push(`${app}: no ${REFERENCE}.json to compare against`);
    return;
  }

  const catalogues = new Map();

  for (const language of languages) {
    const path = join(dir, `${language}.json`);

    try {
      catalogues.set(language, flatten(JSON.parse(readFileSync(path, 'utf8'))));
    } catch (cause) {
      error(app, language, `is not valid JSON - ${cause.message}`);
    }
  }

  const reference = catalogues.get(REFERENCE);
  if (reference === undefined) return;

  // --- The reference itself ----------------------------------------------
  for (const [key, value] of reference) {
    if (typeof value !== 'string') {
      error(app, REFERENCE, `"${key}" is ${value === null ? 'null' : typeof value}, not a string`);
    } else if (value.trim() === '') {
      error(app, REFERENCE, `"${key}" is empty`);
    }
  }

  // --- Plural completeness, per language ---------------------------------
  for (const [language, catalogue] of catalogues) {
    const categories = requiredPluralCategories(language);
    const bases = new Set();

    for (const key of catalogue.keys()) {
      if (PLURAL_SUFFIX.test(key)) bases.add(key.replace(PLURAL_SUFFIX, ''));
    }

    for (const base of bases) {
      for (const category of categories) {
        if (!catalogue.has(`${base}_${category}`)) {
          error(app, language, `"${base}" is missing its _${category} plural form`);
        }
      }
    }
  }

  // --- Every other language against the reference ------------------------
  for (const [language, catalogue] of catalogues) {
    if (language === REFERENCE) continue;

    const missing = [];
    const extra = [];

    for (const key of reference.keys()) {
      if (!catalogue.has(key)) missing.push(key);
    }

    for (const key of catalogue.keys()) {
      // A plural form the reference does not need is not an orphan: English
      // has two categories and Polish has four, so `_few` and `_many` are
      // legitimately absent from en.json.
      if (!reference.has(key) && !PLURAL_SUFFIX.test(key)) extra.push(key);
    }

    if (missing.length > 0) {
      error(
        app,
        language,
        `${missing.length} key(s) missing, so they render as raw keys: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''}`,
      );
    }

    if (extra.length > 0) {
      warn(
        app,
        language,
        `${extra.length} key(s) not in ${REFERENCE}.json: ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ', …' : ''}`,
      );
    }

    let englishLeft = 0;
    const englishExamples = [];

    for (const [key, value] of catalogue) {
      const source = reference.get(key);

      if (typeof value !== 'string') {
        error(app, language, `"${key}" is ${value === null ? 'null' : typeof value}, not a string`);
        continue;
      }

      if (value.trim() === '') {
        error(app, language, `"${key}" is empty`);
        continue;
      }

      if (typeof source !== 'string') continue;

      // Interpolation must survive translation exactly.
      const sourcePlaceholders = placeholders(source);
      const targetPlaceholders = placeholders(value);

      if (!setsEqual(sourcePlaceholders, targetPlaceholders)) {
        error(
          app,
          language,
          `"${key}" placeholders differ - ${REFERENCE} has {${sorted(sourcePlaceholders)}}, this has {${sorted(targetPlaceholders)}}`,
        );
      }

      const sourceTags = tagIndices(source);
      const targetTags = tagIndices(value);

      if (!setsEqual(sourceTags, targetTags)) {
        error(
          app,
          language,
          `"${key}" <n> tags differ - ${REFERENCE} has {${sorted(sourceTags)}}, this has {${sorted(targetTags)}}`,
        );
      }

      // Untranslated English.
      //
      // The hard part of this check is not finding matches, it is not drowning
      // the real ones. Three filters, each removing a class of string that is
      // CORRECTLY identical across languages:
      //
      //   - strings with nothing translatable in them at all. "{{latitude}},
      //     {{longitude}}" and "+ {{rate}}% {{code}}" are punctuation and
      //     placeholders; there is no English in them to leave behind.
      //   - the allowlist above - brands, units, protocol words.
      //   - anything under two real words. "Minimum {{quantity}}" is already
      //     correct French, "{{count}} product" is already correct Dutch, and
      //     flagging them teaches people to ignore this check.
      if (value === source && !NEVER_TRANSLATED_KEYS.has(key) && looksUntranslated(value)) {
        englishLeft += 1;
        if (englishExamples.length < 5) englishExamples.push(key);
      }
    }

    if (englishLeft > 0) {
      warn(
        app,
        language,
        `${englishLeft} value(s) identical to ${REFERENCE} and long enough to be untranslated: ${englishExamples.join(', ')}`,
      );
    }
  }

  const total = reference.size;
  const complete = [...catalogues.keys()].filter(
    (language) => language === REFERENCE || catalogues.get(language).size >= total,
  ).length;

  console.log(
    `  ${app}: ${String(total)} keys, ${String(languages.length)} languages, ${String(complete)} at full coverage`,
  );
}

// ---------------------------------------------------------------------------

const requested = process.argv.includes('--app')
  ? [process.argv[process.argv.indexOf('--app') + 1]]
  : APPS;

console.log('\nUBOSS translation completeness\n');

for (const app of requested) {
  await checkApp(app);
}

if (warnings.length > 0) {
  console.log(`\n  ${String(warnings.length)} warning(s):\n`);
  for (const line of warnings) console.log(`    ! ${line}`);
}

if (errors.length > 0) {
  console.log(`\n  ${String(errors.length)} error(s):\n`);
  for (const line of errors) console.log(`    x ${line}`);
  console.log('\n  Translations are NOT complete. Fix the errors above.\n');
  process.exit(1);
}

console.log('\n  Every catalogue is complete, and every placeholder survives translation.\n');
