/**
 * Exact decimal checks for the quantity form, in thousandths held as BigInt.
 *
 * Only what the form needs to warn early: is it a decimal the server accepts,
 * is it whole for a countable unit, and do conforming + non-conforming add up
 * to the number tested. The server checks all of this again; nothing here is
 * ever turned into a float.
 */
import { COUNTABLE_UNITS } from '@/lib/console-types';

export const DECIMAL_PATTERN = /^\d{1,15}(\.\d{1,3})?$/;

/** A decimal string as thousandths, or null when it is not one. */
export function toMilli(value: string): bigint | null {
  const text = value.trim();
  if (!DECIMAL_PATTERN.test(text)) return null;
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * 1000n + BigInt(`${fraction}000`.slice(0, 3));
}

export function isCountable(unit: string): boolean {
  return (COUNTABLE_UNITS as readonly string[]).includes(unit);
}

export type QuantityProblem = 'NOT_A_QUANTITY' | 'NOT_WHOLE';

/** Why one field's value is refused, or null when it is fine or empty. */
export function quantityProblem(value: string, unit: string): QuantityProblem | null {
  if (value.trim() === '') return null;
  const milli = toMilli(value);
  if (milli === null) return 'NOT_A_QUANTITY';
  if (isCountable(unit) && milli % 1000n !== 0n) return 'NOT_WHOLE';
  return null;
}

/** True when both results are given (or one is) and they do not add up to the tested count. */
export function resultsDoNotAddUp(tested: string, conforming: string, nonconforming: string): boolean {
  if (conforming.trim() === '' && nonconforming.trim() === '') return false;
  const t = toMilli(tested);
  const c = conforming.trim() === '' ? 0n : toMilli(conforming);
  const n = nonconforming.trim() === '' ? 0n : toMilli(nonconforming);
  if (t === null || c === null || n === null) return tested.trim() === '';
  return c + n !== t;
}
