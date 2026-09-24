import { describe, expect, it } from 'vitest';
import { openingQuantity } from './preorders';

const cartons = {
  unit: 'CARTON' as const,
  quantity: 10,
  incrementQuantity: 5,
  maxQuantity: 40,
  minimumBaseUnits: 1000,
  incrementBaseUnits: 500,
  maximumBaseUnits: 4000,
};

describe('openingQuantity', () => {
  it('opens on the minimum when nothing was typed', () => {
    expect(openingQuantity(cartons, 100, undefined)).toBe(10);
  });

  it('opens on the minimum when the typed pieces are below it', () => {
    expect(openingQuantity(cartons, 100, 250)).toBe(10);
  });

  it('rounds the typed pieces up to whole units and onto the steps', () => {
    // 1,201 pieces is 13 cartons, and the steps above 10 are 15, 20, ...
    expect(openingQuantity(cartons, 100, 1201)).toBe(15);
    expect(openingQuantity(cartons, 100, 2000)).toBe(20);
  });

  it('holds the quantity at the largest step under the maximum', () => {
    expect(openingQuantity(cartons, 100, 9000)).toBe(40);
    expect(openingQuantity({ ...cartons, maxQuantity: 37 }, 100, 9000)).toBe(35);
  });

  it('counts in pieces for a piece minimum', () => {
    const pieces = {
      ...cartons,
      unit: 'PIECE' as const,
      quantity: 500,
      incrementQuantity: 1,
      maxQuantity: null,
      minimumBaseUnits: 500,
    };
    expect(openingQuantity(pieces, 1, 1234)).toBe(1234);
  });
});
