/**
 * Guards on the catalogues themselves.
 *
 * TypeScript checks that a *call site* uses a real key. It cannot check the
 * other direction - that a translator has not invented a key, dropped a
 * `{{placeholder}}`, or supplied only some of the plural forms their language
 * needs. That is what these are for.
 *
 * The coverage figure is reported rather than enforced. A threshold would be
 * met by pasting English into the gaps, which is worse than an honest count:
 * an untranslated key already falls back to English at runtime, so the only
 * thing a hard failure would buy is a temptation to fake it.
 */
import { describe, expect, it } from 'vitest';
import { i18n, NAMESPACE } from './config';
import { LANGUAGES } from './languages';
import en from './locales/en.json';

type Catalogue = Record<string, string>;

const ENGLISH: Catalogue = en;
const ENGLISH_KEYS = Object.keys(ENGLISH);

/** i18next's plural suffixes. No language uses all six. */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** Every `{{placeholder}}` in a string, sorted and de-duplicated. */
function placeholdersIn(value: string): string[] {
  return [...new Set(value.match(/\{\{(\w+)\}\}/g) ?? [])].sort();
}

/**
 * The English key a translated key is answering.
 *
 * A plural form may have no exact English counterpart - Polish `_few` answers
 * English's `_one`/`_other` pair - so the comparison falls back to whichever
 * English form exists.
 */
function englishCounterpart(key: string): string | null {
  if (key in ENGLISH) return key;

  const base = key.replace(PLURAL_SUFFIX, '');
  for (const suffix of ['one', 'other', 'many', 'few', 'two', 'zero']) {
    const candidate = `${base}_${suffix}`;
    if (candidate in ENGLISH) return candidate;
  }

  return null;
}

const translated = LANGUAGES.filter((entry) => entry.code !== 'en');

async function load(code: string): Promise<Catalogue> {
  await i18n.loadLanguages(code);
  return (i18n.getResourceBundle(code, NAMESPACE) ?? {}) as Catalogue;
}

describe('translation catalogues', () => {
  it.each(translated)('$english loads', async ({ code }) => {
    const catalogue = await load(code);

    // A catalogue that failed to load would otherwise look like a 0%
    // translation rather than a broken import path.
    expect(Object.keys(catalogue).length).toBeGreaterThan(0);
  });

  it.each(translated)('$english has no keys English does not have', async ({ code }) => {
    const catalogue = await load(code);

    // A key with no English counterpart is a typo or a leftover from a rename.
    // Nothing looks it up, so it can never be read.
    const orphans = Object.keys(catalogue).filter((key) => englishCounterpart(key) === null);

    expect(orphans).toEqual([]);
  });

  it.each(translated)('$english keeps every placeholder', async ({ code }) => {
    const catalogue = await load(code);

    const broken: string[] = [];

    for (const [key, value] of Object.entries(catalogue)) {
      const counterpart = englishCounterpart(key);
      if (counterpart === null) continue;

      const expected = placeholdersIn(ENGLISH[counterpart] ?? '');
      const actual = placeholdersIn(value);

      // `{{count}}` is supplied by i18next itself, so a counted string may
      // carry it even where the English form is worded without it.
      const missing = expected.filter((slot) => slot !== '{{count}}' && !actual.includes(slot));
      const unknown = actual.filter((slot) => slot !== '{{count}}' && !expected.includes(slot));

      if (missing.length > 0 || unknown.length > 0) {
        broken.push(`${key}: missing [${missing.join(' ')}] unknown [${unknown.join(' ')}]`);
      }
    }

    expect(broken).toEqual([]);
  });

  it.each(translated)(
    '$english supplies every plural form its language needs',
    async ({ code }) => {
      const catalogue = await load(code);

      // The forms CLDR says this language distinguishes - four for Polish, two
      // for Greek. A catalogue that supplies only `_one`/`_other` for Polish
      // reads wrongly at 3 and at 8, and nothing else would catch it.
      const required = new Intl.PluralRules(code).resolvedOptions().pluralCategories;

      const countedBases = new Set(
        ENGLISH_KEYS.filter((key) => PLURAL_SUFFIX.test(key)).map((key) =>
          key.replace(PLURAL_SUFFIX, ''),
        ),
      );

      const gaps: string[] = [];

      for (const base of countedBases) {
        // Only bases this catalogue has started translating; an untranslated
        // counted string falls back to English and is the coverage test's
        // business, not this one's.
        const started = required.some((form) => `${base}_${form}` in catalogue);
        if (!started) continue;

        for (const form of required) {
          if (!(`${base}_${form}` in catalogue)) gaps.push(`${base}_${form}`);
        }
      }

      expect(gaps).toEqual([]);
    },
  );

  it.each(translated)('$english reports its coverage', async ({ code, english }) => {
    const catalogue = await load(code);

    const done = ENGLISH_KEYS.filter((key) => key in catalogue).length;
    const percent = Math.round((done / ENGLISH_KEYS.length) * 100);

    // Printed, not asserted - see the note at the top of the file.
    console.log(
      `${english}: ${String(done)}/${String(ENGLISH_KEYS.length)} keys (${String(percent)}%)`,
    );

    expect(done).toBeGreaterThan(0);
  });
});

describe('the i18next instance', () => {
  it('falls back to English for a key a catalogue is missing', async () => {
    await i18n.changeLanguage('pl');

    // A key deliberately absent from every translation. The reader gets
    // readable English, not a raw key.
    const fixed = i18n.getFixedT('pl');
    expect(fixed('common.save')).not.toBe('common.save');
  });

  it('fills placeholders', async () => {
    await i18n.changeLanguage('en');

    const result = i18n.t('auth.login.deactivatedContact', {
      email: 'sales@example.com',
    });

    expect(result).toContain('sales@example.com');
    expect(result).not.toContain('{{email}}');
  });

  it('picks the Polish few form between 2 and 4, and many above', async () => {
    await i18n.changeLanguage('pl');

    const few = i18n.t('auth.login.rateLimitedFor', { count: 3 });
    const many = i18n.t('auth.login.rateLimitedFor', { count: 8 });

    // The whole reason plural forms are declared per language: Polish needs a
    // different ending at 3 and at 8, and an English-shaped one/other pair
    // gets one of them wrong.
    expect(few).not.toBe(many);
    expect(few).toContain('minuty');
    expect(many).toContain('minut');

    await i18n.changeLanguage('en');
  });

  it('resolves a regional tag to the language we ship', async () => {
    // Belgium is a country, not a language: its visitors arrive as `nl-BE` and
    // `fr-BE`, and both have to land somewhere real.
    await i18n.changeLanguage('nl-BE');
    expect(i18n.resolvedLanguage).toBe('nl');

    await i18n.changeLanguage('fr-BE');
    expect(i18n.resolvedLanguage).toBe('fr');

    await i18n.changeLanguage('en');
  });
});
