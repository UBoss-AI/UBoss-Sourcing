/**
 * Packs, unit pricing and purchasing rules.
 *
 * The pumpkin-seed case is the one this file exists for: 500 g per packet,
 * Pack of 10, cart quantity 2. The right answers are 5 kg per pack, 10 kg on
 * the line, and a cart quantity that lives on the cart and nowhere near the
 * variant.
 */
import { describe, expect, it } from 'vitest';
import {
  clampQuantity,
  convertMeasure,
  defaultBaseMeasure,
  formatMeasure,
  isConvertible,
  lineContent,
  parseMeasure,
  summarisePack,
  unitPrice,
  validateQuantity,
} from '../../src/domain/variants/commerce.js';

describe('measurement arithmetic', () => {
  it('parses and prints a decimal without going through a float', () => {
    expect(formatMeasure(parseMeasure('0.1', 'x') + parseMeasure('0.2', 'x'))).toBe('0.3');
  });

  it('drops trailing zeros when printing', () => {
    expect(formatMeasure(parseMeasure('2.500', 'x'))).toBe('2.5');
    expect(formatMeasure(parseMeasure('25', 'x'))).toBe('25');
  });

  it('refuses anything that is not a positive decimal', () => {
    expect(() => parseMeasure('-1', 'x')).toThrow();
    expect(() => parseMeasure('1.2345678', 'x')).toThrow();
    expect(() => parseMeasure('abc', 'x')).toThrow();
    expect(() => parseMeasure('', 'x')).toThrow();
  });

  it('converts within a family and refuses across families', () => {
    expect(isConvertible('g', 'kg')).toBe(true);
    expect(isConvertible('g', 'ml')).toBe(false);
    expect(formatMeasure(convertMeasure(parseMeasure('5000', 'x'), 'g', 'kg') ?? 0n)).toBe('5');
    expect(convertMeasure(parseMeasure('5', 'x'), 'kg', 'm')).toBeNull();
  });

  it('has no opinion about a unit nobody standardised', () => {
    expect(isConvertible('reel', 'm')).toBe(false);
    expect(defaultBaseMeasure('reel')).toBeNull();
  });
});

describe('summarisePack', () => {
  it('multiplies net content by the multipack count', () => {
    const summary = summarisePack({
      multipackCount: 10,
      netContent: { value: '500', unit: 'g' },
    });

    expect(summary.totalContent).toEqual({ value: '5000', unit: 'g' });
    expect(summary.multipackCount).toBe(10);
  });

  it('keeps the seller unit rather than tidying grams into kilograms', () => {
    const summary = summarisePack({ multipackCount: 2, netContent: { value: '1.5', unit: 'kg' } });
    expect(summary.totalContent).toEqual({ value: '3', unit: 'kg' });
  });

  it('treats an absent multipack count as a single', () => {
    const summary = summarisePack({ netContent: { value: '250', unit: 'ml' } });
    expect(summary.multipackCount).toBe(1);
    expect(summary.totalContent).toEqual({ value: '250', unit: 'ml' });
  });

  it('reports no total where the seller stated no content', () => {
    expect(summarisePack({ multipackCount: 5 }).totalContent).toBeNull();
  });

  it('carries a manufacturer pack label through without interpreting it', () => {
    expect(summarisePack({ manufacturerPackLabel: 'Box of 100' }).manufacturerPackLabel).toBe(
      'Box of 100',
    );
  });
});

describe('lineContent: pack count is not cart quantity', () => {
  const summary = summarisePack({ multipackCount: 10, netContent: { value: '500', unit: 'g' } });

  it('one pack is 5 kg of seeds, expressed in the seller unit', () => {
    expect(lineContent(summary, 1)).toEqual({ value: '5000', unit: 'g' });
  });

  it('two packs are twenty packets and 10 kg, not a Pack of 20', () => {
    expect(lineContent(summary, 2)).toEqual({ value: '10000', unit: 'g' });
    // The variant is untouched by the buyer's quantity, which is the point.
    expect(summary.multipackCount).toBe(10);
  });

  it('says nothing for a quantity that is not a whole number of packs', () => {
    expect(lineContent(summary, 0)).toBeNull();
    expect(lineContent(summary, 1.5)).toBeNull();
  });
});

describe('unitPrice', () => {
  const seeds = summarisePack({ multipackCount: 10, netContent: { value: '500', unit: 'g' } });

  it('prices per kilogram off the TOTAL content, not off one packet', () => {
    // 620.00 for 5 kg is 124.00 per kg.
    const priced = unitPrice(62000n, seeds, { value: '1', unit: 'kg' });
    expect(priced?.amountMinor).toBe(12400n);
  });

  it('prices per 100 g from the same figures', () => {
    const priced = unitPrice(62000n, seeds, { value: '100', unit: 'g' });
    expect(priced?.amountMinor).toBe(1240n);
  });

  it('rounds half-up rather than truncating', () => {
    // 1000 minor for 3 kg is 333.33 per kg, which rounds to 333.
    expect(unitPrice(1000n, summarisePack({ netContent: { value: '3', unit: 'kg' } }), {
      value: '1',
      unit: 'kg',
    })?.amountMinor).toBe(333n);

    // 1000 minor for 2 kg is exactly 500.
    expect(unitPrice(1000n, summarisePack({ netContent: { value: '2', unit: 'kg' } }), {
      value: '1',
      unit: 'kg',
    })?.amountMinor).toBe(500n);
  });

  it('says nothing rather than inventing a figure', () => {
    expect(unitPrice(62000n, summarisePack({}), { value: '1', unit: 'kg' })).toBeNull();
    // Per kilogram of something sold in metres is a question with no answer.
    expect(
      unitPrice(62000n, summarisePack({ netContent: { value: '100', unit: 'm' } }), {
        value: '1',
        unit: 'kg',
      }),
    ).toBeNull();
  });

  it('offers a sensible base for each family, and none for an unknown unit', () => {
    expect(defaultBaseMeasure('g')).toEqual({ value: '1', unit: 'kg' });
    expect(defaultBaseMeasure('ml')).toEqual({ value: '1', unit: 'L' });
    expect(defaultBaseMeasure('mm')).toEqual({ value: '1', unit: 'm' });
    expect(defaultBaseMeasure('bags')).toBeNull();
  });

  it('prices a cable reel per metre', () => {
    const reel = summarisePack({ netContent: { value: '100', unit: 'm' } });
    // 450000 minor for a 100 m reel is 4500 per metre.
    expect(unitPrice(450000n, reel, { value: '1', unit: 'm' })?.amountMinor).toBe(4500n);
  });
});

describe('validateQuantity', () => {
  const rules = { minOrderQty: 10, qtyIncrement: 5, maxOrderQty: 100 };

  it('accepts the minimum and every step above it', () => {
    expect(validateQuantity(10, rules, null).isValid).toBe(true);
    expect(validateQuantity(15, rules, null).isValid).toBe(true);
    expect(validateQuantity(100, rules, null).isValid).toBe(true);
  });

  it('counts steps from the minimum, not from zero', () => {
    const odd = { minOrderQty: 10, qtyIncrement: 3, maxOrderQty: null };
    expect(validateQuantity(13, odd, null).isValid).toBe(true);
    // 12 is a multiple of 3 and is still not on offer.
    expect(validateQuantity(12, odd, null).problem).toBe('NOT_A_MULTIPLE');
    expect(validateQuantity(12, odd, null).suggested).toBe(13);
  });

  it('rejects below the minimum and suggests the minimum', () => {
    expect(validateQuantity(4, rules, null)).toEqual({
      isValid: false,
      problem: 'BELOW_MINIMUM',
      suggested: 10,
    });
  });

  it('rejects above the maximum and suggests the highest permitted step', () => {
    // 38 is 10 + four steps of 7, so it passes the step check and fails on
    // the ceiling. 24 is the highest step at or below the maximum of 30.
    const awkward = { minOrderQty: 10, qtyIncrement: 7, maxOrderQty: 30 };
    expect(validateQuantity(38, awkward, null)).toEqual({
      isValid: false,
      problem: 'ABOVE_MAXIMUM',
      suggested: 24,
    });
  });

  it('rejects more than is available and suggests what can be had', () => {
    expect(validateQuantity(40, rules, 27)).toEqual({
      isValid: false,
      problem: 'ABOVE_AVAILABLE',
      suggested: 25,
    });
  });

  it('has nothing to say when stock is not published', () => {
    expect(validateQuantity(40, rules, null).isValid).toBe(true);
  });

  it('rejects a fractional quantity', () => {
    expect(validateQuantity(10.5, rules, null).problem).toBe('NOT_A_WHOLE_NUMBER');
  });
});

describe('clampQuantity', () => {
  const rules = { minOrderQty: 10, qtyIncrement: 5, maxOrderQty: 100 };

  it('never goes below the minimum', () => {
    expect(clampQuantity(1, rules)).toBe(10);
    expect(clampQuantity(-5, rules)).toBe(10);
  });

  it('snaps to the nearest permitted step', () => {
    expect(clampQuantity(17, rules)).toBe(15);
    expect(clampQuantity(18, rules)).toBe(20);
  });

  it('never goes above the maximum', () => {
    expect(clampQuantity(500, rules)).toBe(100);
  });
});
