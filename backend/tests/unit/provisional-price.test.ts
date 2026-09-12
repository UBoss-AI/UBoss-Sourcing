/**
 * Where a placeholder price comes from.
 *
 * A catalogue imported from a supplier sheet has no prices, and a product
 * priced on request cannot be added to a basket - so a placeholder is set to
 * make the shop demonstrable while the real figures are gathered. The source
 * for it is the sheet's own MRP column where the sheet filled one in.
 *
 * What is pinned here is the refusing. That column contains "N/A", "-", blanks
 * and, in a few rows, prose - and every one of those has to come back as "no
 * price" rather than as a number. A cell read wrongly does not fail loudly: it
 * becomes a price a customer can order at.
 *
 * The arithmetic itself is `domain/money.ts`'s and is tested there. This file
 * does not re-test it; it tests what this module decides to hand it.
 */
import { describe, expect, it } from 'vitest';
import {
  mrpFromSourceRow,
  priceFromCell,
} from '../../src/modules/catalog/provisional-price/price-source.js';

describe('a sheet cell as a price', () => {
  it('reads the figures the supplier sheet actually carries', () => {
    // Every one of these is a real MRP from the source workbook.
    expect(priceFromCell('2.5', 'INR')).toBe(250n);
    expect(priceFromCell('3.15', 'INR')).toBe(315n);
    expect(priceFromCell('17.34', 'INR')).toBe(1734n);
    expect(priceFromCell('2754', 'INR')).toBe(275_400n);
  });

  it('refuses every way that column says "no price"', () => {
    // All four spellings appear in the workbook. A number read out of any of
    // them would become something a customer can order at.
    for (const empty of ['', '   ', 'N/A', 'n/a', '-']) {
      expect(priceFromCell(empty, 'INR'), JSON.stringify(empty)).toBeNull();
    }
  });

  it('refuses a figure that is punctuated or carries a symbol', () => {
    // "1,299.00" read loosely becomes 1. The whole amount is rejected instead.
    for (const messy of ['1,299.00', 'Rs 45', '45/-', '12 - 15', 'as quoted']) {
      expect(priceFromCell(messy, 'INR'), messy).toBeNull();
    }
  });

  it('refuses zero and below', () => {
    // A zero in a price column is an empty cell somebody filled in. Carried
    // through, it would leave the product unsellable - or free.
    expect(priceFromCell('0', 'INR')).toBeNull();
    expect(priceFromCell('0.00', 'INR')).toBeNull();
    expect(priceFromCell('-5', 'INR')).toBeNull();
  });

  it('refuses anything that is not a string at all', () => {
    for (const wrong of [undefined, null, 250, {}, []]) {
      expect(priceFromCell(wrong, 'INR')).toBeNull();
    }
  });

  it('follows the currency rather than assuming two decimals', () => {
    // Yen has no minor units. Assuming hundredths would price every item a
    // hundred times too high.
    expect(priceFromCell('100', 'JPY')).toBe(100n);
    expect(priceFromCell('100', 'INR')).toBe(10_000n);
  });
});

describe('the MRP out of a stored source row', () => {
  it('reads column M of the row the import kept', () => {
    expect(mrpFromSourceRow({ A: 'FG/1BZ1B1-G', M: '2.5' }, 'INR')).toBe(250n);
  });

  it('answers null for a row that has no M at all', () => {
    // Two thirds of the workbook. The caller uses its fallback for these.
    expect(mrpFromSourceRow({ A: 'FG/1BZ1B1-G' }, 'INR')).toBeNull();
    expect(mrpFromSourceRow({ A: 'X', M: 'N/A' }, 'INR')).toBeNull();
  });

  it('answers null rather than throwing on a row it cannot read', () => {
    // `rawJson` is Json in the schema, so a caller can hand it anything.
    for (const wrong of [null, undefined, 'not an object', 42, []]) {
      expect(mrpFromSourceRow(wrong, 'INR')).toBeNull();
    }
  });
});
