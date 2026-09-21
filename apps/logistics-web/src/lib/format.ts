/**
 * Formatting helpers.
 *
 * Money is the one that matters. The backend sends every amount as
 * `{ minor: string, formatted: string, currency: string }` - a string, because
 * a paisa-precise total larger than 2^53 minor units is not representable as a
 * JavaScript number. Nothing here converts money to a number, and nothing
 * should: `Number(minor) / 100` is exactly the bug the string is there to
 * prevent.
 */

export interface Money {
  minor: string;
  formatted: string;
  currency: string;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
};

export function currencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency] ?? `${currency} `;
}

/**
 * The locale to format money in.
 *
 * A module-level value set once by the locale provider, rather than a
 * parameter on every call site. There are several hundred call sites and the
 * alternative - threading a locale through every component that shows a price
 * - would be a very large change whose only failure mode is somebody
 * forgetting one and leaving a single price in the wrong format.
 *
 * WHY THE DEFAULT IS 'en' AND NOT `undefined`
 *
 * `undefined` means "whatever locale this machine happens to be set to", which
 * makes the same amount render differently for two people who chose the same
 * language, and makes every test that asserts on an amount pass or fail
 * depending on the machine running it. English is already this application's
 * documented fallback language, so it is the fallback format too.
 */
const FALLBACK_LOCALE = 'en';

let displayLocale: string = FALLBACK_LOCALE;

export function setMoneyLocale(locale: string | undefined): void {
  displayLocale = locale ?? FALLBACK_LOCALE;
}

/**
 * The decimal-string signature of `Intl.NumberFormat.format`.
 *
 * Intl.NumberFormat v3 lets `format()` take a decimal STRING and parse it
 * exactly, never through a double. Every engine this ships to has it.
 *
 * TypeScript will not type it for us. The ES2022 lib has no string overload at
 * all, and the ES2023 one accepts only `StringNumericLiteral` - a template
 * literal type matching string *literals*, which a value read from an API
 * response can never satisfy. So the capability is declared here, narrowly,
 * rather than reaching for `any` or widening the whole project lib for a
 * signature that still would not fit.
 */
interface DecimalStringNumberFormat {
  format(value: string): string;
  resolvedOptions(): Intl.ResolvedNumberFormatOptions;
}
/** Built once per locale/currency pair; constructing one is not free. */
const MONEY_FORMATTERS = new Map<string, DecimalStringNumberFormat>();

function moneyFormatter(currency: string, locale: string): DecimalStringNumberFormat | null {
  const key = `${locale}:${currency}`;
  const cached = MONEY_FORMATTERS.get(key);
  if (cached !== undefined) return cached;

  try {
    // Cast, because the lib types describe a narrower function than the
    // runtime provides. See DecimalStringNumberFormat above.
    const formatter = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'symbol',
    });

    const typed = formatter as unknown as DecimalStringNumberFormat;
    MONEY_FORMATTERS.set(key, typed);
    return typed;
  } catch {
    return null;
  }
}

/**
 * Display a money object.
 *
 * Formats from `minor`, which is the contract - a plain integer string of
 * minor units - and not from `formatted`, which is a display convenience whose
 * shape nothing guarantees. A `formatted` value that already carries grouping
 * separators is not a valid decimal string, and feeding one to Intl produced
 * a literal "NaN" on screen.
 *
 * The value handed to `Intl.NumberFormat` is a STRING, never a number. Since
 * Intl.NumberFormat v3, `format()` parses a decimal string exactly, so an
 * amount past 2^53 minor units renders digit for digit - which is the whole
 * reason money crosses the API as a string in the first place.
 *
 * What this buys over the prefix it replaces: correct grouping, the right
 * decimal mark, and the symbol on the correct side. Six of the eight languages
 * this product ships use a decimal comma, and Polish writes the symbol last.
 */
export function formatMoney(money: Money | null | undefined): string {
  if (money === null || money === undefined) return '—';

  const formatter = moneyFormatter(money.currency, displayLocale);
  if (formatter === null) return `${currencySymbol(money.currency)}${money.formatted}`;

  const exponent = formatter.resolvedOptions().maximumFractionDigits ?? 2;

  const decimal = /^-?\d+$/.test(money.minor)
    ? minorToMajor(money.minor, exponent)
    : money.formatted;

  try {
    return formatter.format(decimal);
  } catch {
    return `${currencySymbol(money.currency)}${money.formatted}`;
  }
}

/**
 * Minor units to a major-unit string, by digit shifting.
 *
 * Used for form fields, which must round-trip exactly: a price typed as 45.50
 * has to come back as 45.50, not 45.5 and never 45.499999.
 */
export function minorToMajor(minor: string, exponent = 2): string {
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? '' : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/**
 * A major-unit string to minor units, by digit shifting.
 *
 * Returns null for anything that is not an exact amount, so a caller reports a
 * validation error rather than submitting a silently rounded price.
 */
export function majorToMinor(major: string, exponent = 2): string | null {
  const text = major.trim();

  if (!/^\d+(\.\d+)?$/.test(text)) return null;

  const [whole = '0', fraction = ''] = text.split('.');

  if (fraction.length > exponent) return null;

  const shifted = `${whole}${fraction.padEnd(exponent, '0')}`.replace(/^0+(?=\d)/, '');

  return shifted;
}

const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const DATE_ONLY = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function formatDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : DATE_TIME.format(date);
}

export function formatDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : DATE_ONLY.format(date);
}

/** "3 days ago" / "in 2 hours". Falls back to an absolute date past a month. */
export function formatRelative(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const seconds = (date.getTime() - Date.now()) / 1000;
  const absolute = Math.abs(seconds);

  if (absolute > 2_592_000) return DATE_ONLY.format(date);

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 3600],
    ['hour', 86_400],
    ['day', 2_592_000],
  ];

  let divisor = 1;
  for (const [unit, limit] of units) {
    if (absolute < limit) return formatter.format(Math.round(seconds / divisor), unit);
    divisor = limit;
  }

  return DATE_ONLY.format(date);
}

const NUMBER = new Intl.NumberFormat();

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return NUMBER.format(value);
}

/** SCREAMING_SNAKE to Title Case, for statuses coming straight off the API. */
export function humanise(value: string): string {
  return value
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
