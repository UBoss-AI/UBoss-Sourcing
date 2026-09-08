/**
 * The sentences that are split rather than interpolated.
 *
 * Three lines on the storefront draw one word inside their own element - an
 * order number in monospace, a spend figure in medium, a support address as a
 * link - so they call `t` with no values and split the result on the
 * placeholder. That works on two conditions, and neither is obvious from the
 * call site: i18next has to leave an unfilled `{{slot}}` alone, and every
 * translation has to still contain it. A translation that drops the
 * placeholder does not throw; it silently loses the order number.
 */
import { describe, expect, it } from 'vitest';
import { i18n, NAMESPACE } from './config';
import { LANGUAGES } from './languages';

const SPLIT_SENTENCES = [
  { key: 'payment.orderIsPaid', slot: '{{order}}' },
  { key: 'profile.leftToSpendThisMonth', slot: '{{amount}}' },
  { key: 'chat.lengthLimitReached', slot: '{{email}}' },
] as const;

describe('sentences that are split on a placeholder', () => {
  it.each(SPLIT_SENTENCES)('$key survives being asked for with no values', async ({ key, slot }) => {
    await i18n.changeLanguage('en');

    const sentence = i18n.t(key, { ns: NAMESPACE });

    expect(sentence).toContain(slot);
    // Both halves are real: a placeholder at either end would leave one side
    // empty and the sentence reading as though a word had been dropped.
    const [before, after] = sentence.split(slot);
    expect(before?.trim().length).toBeGreaterThan(0);
    expect(after?.trim().length).toBeGreaterThan(0);
  });

  it.each(LANGUAGES)('$english keeps every split placeholder', async ({ code }) => {
    await i18n.loadLanguages(code);
    const catalogue = (i18n.getResourceBundle(code, NAMESPACE) ?? {}) as Record<string, string>;

    for (const { key, slot } of SPLIT_SENTENCES) {
      const translated = catalogue[key];
      if (translated === undefined) continue;

      expect(translated, `${code}: ${key}`).toContain(slot);
    }
  });
});
