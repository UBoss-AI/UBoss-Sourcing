/**
 * Every way a quantity can be typed or pasted, and what each one means.
 */
import { describe, expect, it } from 'vitest';
import { MAX_QUANTITY, parseQuantity } from './parse-quantity';

const ok = (value: number) => ({ kind: 'ok', value });
const bad = (problem: string) => ({ kind: 'invalid', problem });

describe('parseQuantity', () => {
  it.each([
    ['1000', 'en-IN', ok(1_000)],
    ['500', 'en-GB', ok(500)],
    ['0007', 'en-GB', ok(7)],
    ['1,000', 'en-GB', ok(1_000)],
    ['1,00,000', 'en-IN', bad('notANumber')], // Indian lakh grouping is two digits: not a thousands shape
    ['1.000', 'de-DE', ok(1_000)],
    ['1 000', 'fr-FR', ok(1_000)],
    ['1 000', 'fr-FR', ok(1_000)],
    ["1'000", 'de-CH', ok(1_000)],
    ['1,234,567', 'en-GB', ok(1_234_567)],
    ['1.234.567', 'nl-NL', ok(1_234_567)],
    ['1,000.00', 'en-GB', ok(1_000)],
    ['1.000,00', 'de-DE', ok(1_000)],
    ['2.0', 'en-GB', ok(2)],
  ])('%s in %s', (raw, locale, expected) => {
    expect(parseQuantity(raw, locale)).toEqual(expected);
  });

  it('reads a single decimal point the way the page language writes it', () => {
    // In English "1.000" is one; in German it is a thousand.
    expect(parseQuantity('1.000', 'en-GB')).toEqual(ok(1));
    expect(parseQuantity('1.000', 'de-DE')).toEqual(ok(1_000));
  });

  it('treats an empty box as being retyped, not as zero', () => {
    expect(parseQuantity('', 'en-GB')).toEqual({ kind: 'empty' });
    expect(parseQuantity('   ', 'en-GB')).toEqual({ kind: 'empty' });
  });

  it.each([
    ['-5', 'negative'],
    ['−5', 'negative'],
    ['0', 'zero'],
    ['000', 'zero'],
    ['1.5', 'fraction'],
    ['1,5', 'fraction'],
    ['1e3', 'notANumber'],
    ['1E3', 'notANumber'],
    ['Infinity', 'notANumber'],
    ['NaN', 'notANumber'],
    ['0x10', 'notANumber'],
    ['abc', 'notANumber'],
    ['12abc', 'notANumber'],
    ['1-2', 'notANumber'],
    ['1,,000', 'notANumber'],
    ['.', 'notANumber'],
    [String(MAX_QUANTITY + 1), 'tooLarge'],
    ['99999999999999999999', 'tooLarge'],
  ])('refuses %s as %s', (raw, problem) => {
    expect(parseQuantity(raw, 'en-GB')).toEqual(bad(problem));
  });

  it('accepts the largest allowed quantity exactly', () => {
    expect(parseQuantity(String(MAX_QUANTITY), 'en-GB')).toEqual(ok(MAX_QUANTITY));
  });
});
