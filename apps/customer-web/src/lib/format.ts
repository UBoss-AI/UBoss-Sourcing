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
 * `undefined` means "whatever locale this machine happens to be set to", and
 * that is not a property a storefront should have. It makes the same price
 * render differently for two readers who chose the same language, and it makes
 * every test that asserts on a price pass or fail depending on the machine
 * running it - green on a developer's laptop, red on a build runner in another
 * region, for a reason nobody would look for.
 *
 * English is already this application's documented fallback language, so using
 * it as the fallback format too is the consistent answer rather than a new
 * decision. It is replaced the moment the locale provider resolves a real one.
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
/**
 * Formatters are expensive to construct and are built once per pair.
 *
 * `Intl.NumberFormat` costs about a millisecond to create and microseconds to
 * use. A catalogue page showing sixty prices would otherwise build sixty
 * identical formatters.
 */
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
      // The currency's own ISO 4217 minor-unit count decides the decimals, so
      // yen renders as ¥1,600 and never ¥1,600.00. Left to Intl rather than
      // stated, because Intl already knows this for every currency and the
      // local table above only knows the handful it lists.
      currencyDisplay: 'symbol',
    });

    const typed = formatter as unknown as DecimalStringNumberFormat;
    MONEY_FORMATTERS.set(key, typed);
    return typed;
  } catch {
    // An unknown or malformed currency code. Returning null lets the caller
    // fall back to the plain string rather than throwing inside a render.
    return null;
  }
}

/**
 * Display a money object.
 *
 * WHY THIS FORMATS FROM `minor` AND NOT FROM `formatted`
 *
 * `minor` is the contract. It is a plain integer string of minor units, and
 * the entire money design rests on it being exactly that. `formatted` is a
 * convenience the server renders for display, and nothing guarantees its
 * shape - it may already carry grouping separators, and a separator is not
 * valid in a decimal string. Parsing it produced `₹NaN`.
 *
 * So the decimal string is rebuilt here from `minor` by digit shifting, and
 * `formatted` is used only as a last-resort fallback for a currency Intl
 * cannot resolve.
 *
 * WHY THIS PASSES A STRING TO `Intl.NumberFormat` AND NOT A NUMBER
 *
 * Since Intl.NumberFormat v3, `format()` accepts a **decimal string** and
 * parses it exactly, without ever going through a double. So
 * `format('90071992547409911.99')` renders every digit, where
 * `format(Number('90071992547409911.99'))` silently loses the last several -
 * which is precisely the bug the minor-unit string representation exists to
 * prevent. No `Number()` appears anywhere in this path.
 *
 * WHAT IT BUYS OVER THE PREVIOUS PREFIX
 *
 * The prefix table was wrong for every locale that does not put the symbol in
 * front. Polish writes "12 345,67 zł" - symbol last, comma for the decimal, a
 * space for grouping - and the old code produced "zł 12345.67", which a Polish
 * buyer reads as a bank statement rather than a price. German, French,
 * Spanish, Italian, Dutch and Greek all use a decimal comma too, so six of the
 * eight shipped languages were being shown prices in a foreign format. It also
 * grouped nothing at all, so a seven-figure price rendered as `₹2250000.00`.
 */
export function formatMoney(money: Money | null | undefined): string {
  if (money === null || money === undefined) return '—';

  const formatter = moneyFormatter(money.currency, displayLocale);
  if (formatter === null) return `${currencySymbol(money.currency)}${money.formatted}`;

  // Intl knows every currency's real minor-unit count, where the table in this
  // file only knows the handful it lists. Asked rather than assumed, so a
  // currency added to the backend does not need a second edit here.
  const exponent = formatter.resolvedOptions().maximumFractionDigits ?? 2;

  const decimal = /^-?\d+$/.test(money.minor)
    ? minorToMajor(money.minor, exponent)
    : money.formatted;

  try {
    return formatter.format(decimal);
  } catch {
    // Either an engine without Intl.NumberFormat v3 string support, or a
    // `formatted` fallback that is not a plain decimal. The prefix is the
    // honest answer: less idiomatic, still exact, never wrong by a factor.
    return `${currencySymbol(money.currency)}${money.formatted}`;
  }
}

/**
 * Currencies with no minor unit.
 *
 * Kept in step with the backend's `money.ts`, which is the authority. A yen
 * amount shifted by two decimal places reads as one hundredth of the price,
 * which is the single most dangerous formatting bug available here.
 */
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW']);

/**
 * How many decimal places this currency has.
 *
 * Exported so a form converting between major and minor units asks this rather
 * than writing `100`, which is the wrong number for two of the currencies the
 * backend supports. Screens that have the server's own currency list - it
 * carries an `exponent` per row - should prefer that; this is the answer for
 * everywhere else, and it is kept in step with `domain/money.ts` the same way
 * the set above is.
 */
export function currencyExponent(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
}

/**
 * Display a bare minor-unit amount.
 *
 * `formatMoney` above is the one to reach for: the backend's `Money` object
 * carries a `formatted` string it produced itself, and nothing beats reading
 * the answer the server already gave. This exists for the endpoints that send
 * a minor-unit string on its own — a coupon threshold, a redemption, a saved
 * line's price — where there is no `Money` to read.
 *
 * Digit shifting, never arithmetic: `Number(minor) / 100` is exactly the bug
 * the string representation exists to prevent.
 */
export function formatMoneyMinor(
  minor: string | null | undefined,
  currency: string,
): string {
  if (minor === null || minor === undefined) return '—';

  // Shifted to a decimal string first, then handed to the same locale-aware
  // formatter `formatMoney` uses, so a coupon threshold and a cart total are
  // not written two different ways on one screen.
  return formatMoney({
    minor,
    formatted: minorToMajor(minor, currencyExponent(currency)),
    currency,
  });
}

/**
 * A minor-unit amount multiplied by a whole number.
 *
 * The one arithmetic this app does on money, and it exists for one job:
 * restating a per-piece price as the price of a box or a carton. The factor is
 * a count of physical things, so the result is exact — no rate, no rounding,
 * no decision about which way to round.
 *
 * `BigInt`, not `Number`. A price of ₹2,754.00 is 275400 minor units and a
 * carton of 2,000 takes it past 550 million, which `Number` still holds
 * exactly — but the same multiplication in a currency with more minor units, or
 * on a larger carton, does not, and a price that is silently wrong in the last
 * digits is the exact failure the minor-unit string representation exists to
 * prevent.
 */
export function multiplyMinor(minor: string, factor: number): string {
  if (!Number.isInteger(factor) || factor < 0) return minor;
  return (BigInt(minor) * BigInt(factor)).toString();
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
