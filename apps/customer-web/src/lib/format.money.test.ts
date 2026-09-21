/**
 * Money formatting.
 *
 * Two claims, and the first is the one that would be a catastrophe to get
 * wrong: formatting must never put an amount through a JavaScript number. The
 * second is that the format follows the reader's language, because six of the
 * eight languages this storefront ships use a decimal comma and several write
 * the currency symbol after the amount.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatMoney, formatMoneyMinor, setMoneyLocale } from './format';

afterEach(() => {
  setMoneyLocale(undefined);
});

function money(formatted: string, currency: string) {
  return { minor: formatted.replace('.', ''), formatted, currency };
}

describe('the authoritative field is `minor`, not `formatted`', () => {
  it('ignores grouping separators a server put in `formatted`', () => {
    // A real regression. `formatted` is a display convenience and nothing
    // guarantees its shape; a comma is not valid in a decimal string, and
    // parsing one produced "₹NaN" on every screen that showed a schedule.
    setMoneyLocale('en-US');

    expect(formatMoney({ minor: '120000', formatted: '1,200.00', currency: 'INR' })).toBe(
      '₹1,200.00',
    );
  });

  it('falls back to `formatted` only when `minor` is not a plain integer', () => {
    setMoneyLocale('en-US');

    const rendered = formatMoney({ minor: 'n/a', formatted: '1200.00', currency: 'INR' });
    expect(rendered).toContain('1,200.00');
  });
});

describe('exactness', () => {
  it('renders an amount far past Number.MAX_SAFE_INTEGER digit for digit', () => {
    // THE TEST THIS FILE EXISTS FOR.
    //
    // `Number('90071992547409911.99')` is 90071992547409920 - the last five
    // digits are simply gone, and the decimals with them. Intl.NumberFormat
    // accepts the decimal STRING and parses it exactly, which is what makes
    // using it here safe at all.
    setMoneyLocale('en-IN');
    const rendered = formatMoney(money('90071992547409911.99', 'INR'));

    expect(rendered).toContain('911.99');
    expect(rendered).not.toContain('920');
  });

  it('does not round a fraction away', () => {
    setMoneyLocale('en-US');
    expect(formatMoney(money('0.01', 'USD'))).toBe('$0.01');
    expect(formatMoney(money('1234.56', 'USD'))).toBe('$1,234.56');
  });

  it('keeps a zero-decimal currency whole', () => {
    // A yen amount shown with two decimal places reads as one hundredth of the
    // price. Intl knows JPY has no minor unit; the old prefix table had to be
    // told separately, and could disagree.
    setMoneyLocale('en-US');
    expect(formatMoney(money('1600', 'JPY'))).not.toContain('.00');
  });
});

describe('the reader language decides the format', () => {
  it('writes a Polish price the Polish way', () => {
    // Symbol after, comma for the decimal, space for grouping. The prefix
    // implementation this replaced produced "zl 12345.67", which a Polish
    // buyer reads as a bank statement rather than a price.
    setMoneyLocale('pl-PL');
    const rendered = formatMoney(money('12345.67', 'PLN'));

    expect(rendered).toContain('12');
    expect(rendered).toContain('345,67');
    expect(rendered.trim().endsWith('zł')).toBe(true);
  });

  it('writes a German price with a decimal comma', () => {
    setMoneyLocale('de-DE');
    expect(formatMoney(money('1234.50', 'EUR'))).toContain('1.234,50');
  });

  it('keeps language and currency independent', () => {
    // A French-speaking buyer paying in zloty gets French grouping around a
    // zloty amount. Conflating the two - picking the format from the currency
    // - is the bug this asserts against.
    setMoneyLocale('fr-FR');

    // Normalised, because French groups with a NARROW NO-BREAK SPACE (U+202F)
    // rather than an ordinary one. Asserting on the literal character would
    // make this test a hostage to a CLDR revision that swaps one flavour of
    // space for another, which is not a change anybody needs to be told about.
    const rendered = formatMoney(money('1234.50', 'PLN')).replace(/\s/gu, ' ');

    expect(rendered).toContain('1 234,50');
    expect(rendered).toContain('PLN');
  });

  it('follows a language switch without a reload', () => {
    setMoneyLocale('en-US');
    const english = formatMoney(money('1234.50', 'EUR'));

    setMoneyLocale('de-DE');
    const german = formatMoney(money('1234.50', 'EUR'));

    expect(english).not.toBe(german);
  });
});

describe('robustness', () => {
  it('shows a dash rather than nothing for a missing amount', () => {
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(undefined)).toBe('—');
    expect(formatMoneyMinor(null, 'EUR')).toBe('—');
  });

  it('falls back to a plain prefix for a currency Intl does not know', () => {
    // Never throws inside a render. A made-up code still shows the number.
    setMoneyLocale('en-US');
    expect(formatMoneyMinor('12345', 'ZZZ')).toContain('123.45');
  });

  it('shifts minor units without arithmetic', () => {
    setMoneyLocale('en-US');
    expect(formatMoneyMinor('12345', 'USD')).toBe('$123.45');
    // Zero-decimal: 1600 minor units of yen is 1600 yen, not 16.00.
    expect(formatMoneyMinor('1600', 'JPY')).toContain('1,600');
  });
});
