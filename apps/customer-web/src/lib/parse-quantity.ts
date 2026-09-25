/**
 * Reading a quantity somebody typed or pasted, safely.
 *
 * A quantity of pieces is a whole, positive number, and nothing else. This is
 * where "1,000", "1.000" and "1 000" become one thousand - in whichever
 * convention the buyer's own language writes numbers - and where everything
 * that is not a quantity is refused with a reason the field can show:
 *
 *   - empty            a box being retyped; not an error, not a zero
 *   - negative         "-5"
 *   - zero             "0", where the product's minimum is at least 1
 *   - fraction         "1.5" of something sold by the piece
 *   - notANumber       "abc", "1e3", "Infinity", "0x10", "1-2"
 *   - tooLarge         past MAX_QUANTITY, before it can stop being exact
 *
 * Exponents are refused outright even though JavaScript reads "1e3" as 1000:
 * nobody means a thousand syringes by typing an e, and a field that accepts it
 * turns a slip of the finger into an order a thousand times the size.
 *
 * The browser checks nothing here that the server trusts: the basket, the
 * preorder and checkout validate every quantity again.
 */

/** The largest quantity a box accepts. Matches the bulk-pricing endpoint's own ceiling. */
export const MAX_QUANTITY = 100_000_000;

export type QuantityProblem = 'negative' | 'zero' | 'fraction' | 'notANumber' | 'tooLarge';

export type ParsedQuantity =
  | { kind: 'empty' }
  | { kind: 'ok'; value: number }
  | { kind: 'invalid'; problem: QuantityProblem };

/** This language's group and decimal separators, as Intl writes them. */
export function separatorsFor(locale: string): { group: string; decimal: string } {
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(1_234_567.8);
    return {
      group: parts.find((part) => part.type === 'group')?.value ?? ',',
      decimal: parts.find((part) => part.type === 'decimal')?.value ?? '.',
    };
  } catch {
    return { group: ',', decimal: '.' };
  }
}

const SEPARATOR = /[.,'’]/;

/**
 * Whole part and fractional part, reading separators the way a person would.
 *
 *   - No separator: all digits.
 *   - Two different separators ("1,234.5", "1.234,5"): the last one is the
 *     decimal point and the other groups thousands.
 *   - One kind, once, and it is this language's decimal ("1.5" in English,
 *     "1,5" in German): a decimal point. "1.000" in English is therefore one.
 *   - One kind otherwise ("1,000" in English, "1.000" in German, "1,000,000"):
 *     grouping, and only if every group after the first is three digits.
 *
 * Null for anything that is not one of those shapes.
 */
function splitNumber(
  text: string,
  locale: { group: string; decimal: string },
): { digits: string; fraction: string } | null {
  if (!/^[\d.,'’]+$/.test(text)) return null;
  const kinds = [...new Set(text.replace(/\d/g, ''))];
  if (kinds.length === 0) return { digits: text, fraction: '' };

  const grouping = (part: string, group: string): string | null => {
    const groups = part.split(group);
    const [head, ...rest] = groups;
    if (head === undefined || head.length < 1 || head.length > 3) return null;
    if (rest.some((piece) => piece.length !== 3 || SEPARATOR.test(piece))) return null;
    return groups.join('');
  };

  if (kinds.length === 2) {
    const decimal = text[Math.max(text.lastIndexOf(kinds[0] ?? ''), text.lastIndexOf(kinds[1] ?? ''))] ?? '';
    const group = kinds.find((kind) => kind !== decimal) ?? '';
    const at = text.lastIndexOf(decimal);
    if (text.indexOf(decimal) !== at) return null;
    const whole = grouping(text.slice(0, at), group);
    return whole === null ? null : { digits: whole, fraction: text.slice(at + 1) };
  }
  if (kinds.length > 2) return null;

  const only = kinds[0] ?? '';
  const count = text.split(only).length - 1;
  // Only a comma or a full stop can be a decimal point; an apostrophe groups.
  const decimalLike = only === '.' || only === ',';
  if (count === 1 && only === locale.decimal) {
    const [whole = '', fraction = ''] = text.split(only);
    return { digits: whole, fraction };
  }
  const grouped = grouping(text, only);
  if (grouped !== null) return { digits: grouped, fraction: '' };
  // "1,5" in English: one separator that cannot be grouping is a decimal point.
  if (count === 1 && decimalLike) {
    const [whole = '', fraction = ''] = text.split(only);
    return { digits: whole, fraction };
  }
  return null;
}

/** Every character Intl uses for "space" in a number, which is not only U+0020. */
const SPACES = /[\s\u00a0\u202f\u2009]/g;

export function parseQuantity(raw: string, locale: string): ParsedQuantity {
  const text = raw.replace(SPACES, '');
  if (text === '') return { kind: 'empty' };

  if (/^[-−‐–]/.test(text)) return { kind: 'invalid', problem: 'negative' };
  if (/[eE]/.test(text) || /infinity/i.test(text) || /^0[xob]/i.test(text)) {
    return { kind: 'invalid', problem: 'notANumber' };
  }

  const split = splitNumber(text, separatorsFor(locale));
  if (split === null) return { kind: 'invalid', problem: 'notANumber' };
  const { digits, fraction } = split;

  if (digits === '' && fraction === '') return { kind: 'invalid', problem: 'notANumber' };
  if (/[1-9]/.test(fraction)) return { kind: 'invalid', problem: 'fraction' };

  const trimmed = digits.replace(/^0+(?=\d)/, '');
  if (trimmed.length > String(MAX_QUANTITY).length) return { kind: 'invalid', problem: 'tooLarge' };
  const value = Number(trimmed === '' ? '0' : trimmed);
  if (!Number.isSafeInteger(value)) return { kind: 'invalid', problem: 'notANumber' };
  if (value > MAX_QUANTITY) return { kind: 'invalid', problem: 'tooLarge' };
  if (value === 0) return { kind: 'invalid', problem: 'zero' };
  return { kind: 'ok', value };
}
