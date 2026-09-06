#!/usr/bin/env node
/**
 * Fills in missing translations from the English catalogue, via DeepL.
 *
 *     node scripts/auto-translate.mjs apps/customer-web --dry-run
 *     node scripts/auto-translate.mjs apps/customer-web
 *     node scripts/auto-translate.mjs apps/admin-web
 *
 * Needs `DEEPL_API_KEY` in the environment. A free key covers this whole
 * codebase: both apps at ~1,800 strings come to roughly 430,000 characters
 * across seven languages, against a 500,000/month free allowance.
 *
 * WHAT IT WILL NOT DO
 *
 * It never overwrites a value that already exists. Only keys present in
 * `en.json` and absent from the target file are sent. That makes it safe to
 * run repeatedly, and it means a human correction is permanent - the script
 * will not undo it on the next run.
 *
 * It is also not a substitute for a native speaker. It gets you a complete,
 * consistent draft; the notice under the language picker stays up until
 * somebody who speaks the language has read it.
 *
 * THE THREE THINGS MACHINE TRANSLATION GETS WRONG HERE
 *
 *   1. **Placeholders.** `{{email}}` is a token, not a word. Left alone, an
 *      engine translates it, reorders it, or drops a brace - and the sentence
 *      renders with a hole in it. Each one is wrapped in an XML tag DeepL is
 *      told to leave untouched.
 *   2. **Register.** A supplier writing to a business customer uses "Sie",
 *      "usted", "vous" - not "du", "tú", "tu". Engines drift between the two
 *      across calls. `formality: prefer_more` pins it, for the six languages
 *      DeepL supports it on. Greek is not one of them, so Greek register has
 *      to be checked by hand.
 *   3. **Plurals.** English distinguishes one from other. Polish needs four
 *      forms and picks between them by grammar an English source does not
 *      carry, so a straight translation gives the same wording for `_few` and
 *      `_many` - which is wrong at 3 and at 8. The script still fills them,
 *      because a wrong ending beats a missing key falling back to English,
 *      but it lists every one at the end as needing a human.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const TARGETS = ['nl', 'fr', 'de', 'el', 'it', 'pl', 'es'];

/** DeepL supports a formality setting on these. Greek is absent on purpose. */
const FORMAL = new Set(['nl', 'fr', 'de', 'it', 'pl', 'es']);

/**
 * Words that must survive untranslated: the product, and role names that are
 * shown verbatim in the panel and referred to by name in support calls.
 * Protected the same way placeholders are.
 */
const KEEP = ['UBOSS', 'Business Owner', 'GSTIN', 'IBAN', 'GDPR'];

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

const [, , appDir, ...flags] = process.argv;
const dryRun = flags.includes('--dry-run');

if (appDir === undefined) {
  console.error('usage: node scripts/auto-translate.mjs <app-dir> [--dry-run]');
  process.exit(1);
}

const localesDir = join(appDir, 'src', 'i18n', 'locales');
if (!existsSync(join(localesDir, 'en.json'))) {
  console.error(`no en.json under ${localesDir}`);
  process.exit(1);
}

const english = JSON.parse(await readFile(join(localesDir, 'en.json'), 'utf8'));

/**
 * Wrap placeholders and do-not-translate terms so DeepL passes them through
 * verbatim. `<x>` is arbitrary; it only has to be a tag we can tell DeepL to
 * ignore and that will not appear in the copy.
 */
function protect(text) {
  let out = text.replace(/\{\{(\w+)\}\}/g, '<x>{{$1}}</x>');

  for (const term of KEEP) {
    out = out.split(term).join(`<x>${term}</x>`);
  }

  return out;
}

function unprotect(text) {
  return text.replace(/<\/?x>/g, '');
}

/**
 * Which keys a target catalogue is missing.
 *
 * Plural keys are expanded to the forms the *target* language actually needs,
 * which is the part a plain key diff would miss: English declaring
 * `foo_one`/`foo_other` means Polish owes four keys, not two.
 */
function missingKeysFor(language, existing) {
  const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
  const wanted = new Map(); // target key -> English source text

  for (const [key, value] of Object.entries(english)) {
    const match = PLURAL_SUFFIX.exec(key);

    if (match === null) {
      wanted.set(key, value);
      continue;
    }

    const base = key.slice(0, match.index);

    for (const form of categories) {
      const targetKey = `${base}_${form}`;
      if (wanted.has(targetKey)) continue;

      // Prefer the matching English form, else the general plural, else
      // whatever English declared.
      const source =
        english[`${base}_${form}`] ?? english[`${base}_other`] ?? english[`${base}_one`] ?? value;

      wanted.set(targetKey, source);
    }
  }

  return [...wanted].filter(([key]) => !(key in existing));
}

async function translateBatch(texts, language, translator) {
  const results = await translator.translateText(texts.map(protect), 'en', deeplCode(language), {
    tagHandling: 'xml',
    ignoreTags: ['x'],
    ...(FORMAL.has(language) ? { formality: 'prefer_more' } : {}),
    // The copy is UI text, not prose. Splitting on newlines it does not have
    // only risks the engine inventing sentence breaks.
    splitSentences: 'nonewlines',
  });

  return results.map((entry) => unprotect(entry.text));
}

/** DeepL wants a region on English targets; ours are plain except none here. */
function deeplCode(language) {
  return language;
}

const report = [];
let totalChars = 0;

let translator = null;
if (!dryRun) {
  const key = process.env.DEEPL_API_KEY;
  if (key === undefined || key === '') {
    console.error('DEEPL_API_KEY is not set. Re-run with --dry-run to see what would be sent.');
    process.exit(1);
  }

  const deepl = await import('deepl-node');
  translator = new deepl.Translator(key);
}

for (const language of TARGETS) {
  const path = join(localesDir, `${language}.json`);
  const existing = existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) : {};

  const missing = missingKeysFor(language, existing);
  const chars = missing.reduce((sum, [, text]) => sum + text.length, 0);
  totalChars += chars;

  const counted = missing.filter(([key]) => PLURAL_SUFFIX.test(key)).map(([key]) => key);

  if (missing.length === 0) {
    console.log(`${language}: up to date`);
    continue;
  }

  console.log(
    `${language}: ${String(missing.length)} missing (${String(chars)} chars)` +
      (dryRun ? ' [dry run, nothing sent]' : ''),
  );

  if (!dryRun) {
    // DeepL takes up to 50 texts per request. Batching keeps the request count
    // - and the rate-limit risk - proportional to the work, not the key count.
    const filled = {};

    for (let i = 0; i < missing.length; i += 50) {
      const slice = missing.slice(i, i + 50);
      const translations = await translateBatch(
        slice.map(([, text]) => text),
        language,
        translator,
      );

      slice.forEach(([key], index) => {
        filled[key] = translations[index];
      });
    }

    // Written in English key order so the file stays diffable against en.json,
    // with anything already present left exactly as it was.
    const merged = {};
    for (const key of Object.keys(english)) {
      const match = PLURAL_SUFFIX.exec(key);
      const base = match === null ? key : key.slice(0, match.index);

      for (const candidate of match === null
        ? [key]
        : ['zero', 'one', 'two', 'few', 'many', 'other'].map((form) => `${base}_${form}`)) {
        const value = existing[candidate] ?? filled[candidate];
        if (value !== undefined && !(candidate in merged)) merged[candidate] = value;
      }
    }

    // Anything the target had that English no longer declares stays put; the
    // guard test is what flags it, not this script.
    for (const [key, value] of Object.entries(existing)) {
      if (!(key in merged)) merged[key] = value;
    }

    await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  }

  if (counted.length > 0) {
    report.push({ language, counted });
  }

  if (language === 'el') {
    report.push({
      language: 'el',
      note: 'DeepL cannot pin formality for Greek - check the register reads as courtesy plural.',
    });
  }
}

console.log(`\ntotal: ${String(totalChars)} characters` + (dryRun ? ' would be sent' : ' sent'));

if (report.length > 0) {
  console.log('\nNEEDS A HUMAN:');
  for (const entry of report) {
    if (entry.note !== undefined) {
      console.log(`  ${entry.language}: ${entry.note}`);
      continue;
    }
    console.log(
      `  ${entry.language}: ${String(entry.counted.length)} plural forms machine-filled from one English source -` +
        ' the endings will not all be right',
    );
    for (const key of entry.counted.slice(0, 6)) console.log(`      ${key}`);
    if (entry.counted.length > 6) console.log(`      ... and ${String(entry.counted.length - 6)} more`);
  }
}

console.log(
  '\nNow run the catalogue guards:  cd apps/customer-web && npm run test -- src/i18n',
);
