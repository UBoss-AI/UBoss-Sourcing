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
  AED: 'AED ',
  SGD: 'S$',
  // Polish writes the złoty after the amount ("49,00 zł"). Everything here is
  // a prefix, so it is spaced rather than reordered: "zł 49.00" reads as
  // złoty to a Polish buyer, where the bare "PLN 49.00" fallback reads as a
  // bank statement.
  PLN: 'zł ',
  JPY: '¥',
  KRW: '₩',
};

export function currencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency] ?? `${currency} `;
}

/** Display a money object. `formatted` already has the right decimal places. */
export function formatMoney(money: Money | null | undefined): string {
  if (money === null || money === undefined) return '—';
  return `${currencySymbol(money.currency)}${money.formatted}`;
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
