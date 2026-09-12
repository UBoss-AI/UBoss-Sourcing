/**
 * Ordering by the pack.
 *
 * The whole feature is one conversion and one refusal, and both of them are
 * worth pinning.
 *
 * The conversion: two cartons of a product boxed 100 × 20 is four thousand
 * pieces, and that multiplication is done on the server from the catalogue's
 * own figures. A client that could post its own conversion could post "1 piece
 * per carton" and buy a carton at the price of a syringe.
 *
 * The refusal: a pack unit the catalogue has no figure for is rejected, never
 * silently treated as one piece. A buyer who asked for two cartons and received
 * two syringes has been failed far worse than one who was told the carton
 * quantity is not on file.
 */
import { describe, expect, it } from 'vitest';
import {
  availableUnits,
  describeOrderingQuantity,
  piecesPerUnit,
  resolveOrderingQuantity,
  type PackConversion,
} from '../../src/domain/ordering-unit.js';
import { assertPurchasable, isPurchasable } from '../../src/modules/catalog/purchasability.js';
import { validateForPublish } from '../../src/modules/catalog/catalog.visibility.js';

/** 100 to a box, 20 boxes to a carton, 2,000 to the carton. */
const FULL: PackConversion = {
  piecesPerInnerPack: 100,
  innerPacksPerOuterCarton: 20,
  piecesPerOuterCarton: 2000,
  isReliable: true,
};

/** A carton total and nothing about how it is boxed inside. */
const TOTAL_ONLY: PackConversion = {
  piecesPerInnerPack: null,
  innerPacksPerOuterCarton: null,
  piecesPerOuterCarton: 400,
  isReliable: true,
};

/** Figures that were read, but whose own multiplication disagreed. */
const UNRELIABLE: PackConversion = { ...FULL, isReliable: false };

describe('pack conversion', () => {
  it('converts packs to pieces on the server side', () => {
    const resolved = resolveOrderingQuantity({
      unit: 'OUTER_CARTON',
      unitQuantity: 2,
      // Deliberately a lie: a client sending a flattering piece count must not
      // be able to influence the answer.
      pieces: 1,
      conversion: FULL,
      field: 'unitQuantity',
    });

    expect(resolved.quantity).toBe(4000);
    expect(resolved.orderingUnit).toBe('OUTER_CARTON');
    expect(resolved.unitQuantity).toBe(2);
    expect(resolved.piecesPerUnitSnapshot).toBe(2000);
  });

  it('leaves the piece path exactly as it was', () => {
    const resolved = resolveOrderingQuantity({
      unit: undefined,
      unitQuantity: undefined,
      pieces: 7,
      conversion: FULL,
      field: 'quantity',
    });

    expect(resolved).toEqual({
      quantity: 7,
      orderingUnit: 'PIECE',
      unitQuantity: 7,
      piecesPerUnitSnapshot: 1,
    });
  });

  it('works a carton out from the factors when no total was stated', () => {
    const derived: PackConversion = { ...FULL, piecesPerOuterCarton: null };
    expect(piecesPerUnit('OUTER_CARTON', derived)).toBe(2000);
  });

  it('never works an inner pack out from a carton total', () => {
    // 400 to a carton says nothing about how they are boxed inside, and
    // dividing by an invented box count would be inventing twice.
    expect(piecesPerUnit('INNER_PACK', TOTAL_ONLY)).toBeNull();
    expect(piecesPerUnit('OUTER_CARTON', TOTAL_ONLY)).toBe(400);
  });

  it('refuses a pack unit the catalogue cannot convert', () => {
    expect(() =>
      resolveOrderingQuantity({
        unit: 'INNER_PACK',
        unitQuantity: 3,
        pieces: 3,
        conversion: TOTAL_ONLY,
        field: 'items.0.unitQuantity',
      }),
    ).toThrowError(/box/i);
  });

  it('will not convert from figures that contradicted themselves', () => {
    // The source said 100 × 20 = 1,800. Until somebody says which is right,
    // nothing is sold by the carton off it.
    expect(piecesPerUnit('OUTER_CARTON', UNRELIABLE)).toBeNull();
    expect(availableUnits(UNRELIABLE)).toEqual(['PIECE']);
  });

  it('offers only the units it can actually convert', () => {
    expect(availableUnits(FULL)).toEqual(['PIECE', 'INNER_PACK', 'OUTER_CARTON']);
    expect(availableUnits(TOTAL_ONLY)).toEqual(['PIECE', 'OUTER_CARTON']);
  });

  it('rejects a pack count that is not a whole positive number', () => {
    for (const unitQuantity of [0, -1, 1.5]) {
      expect(() =>
        resolveOrderingQuantity({
          unit: 'OUTER_CARTON',
          unitQuantity,
          pieces: 1,
          conversion: FULL,
          field: 'unitQuantity',
        }),
      ).toThrowError();
    }
  });

  it('describes a line from its own snapshot, not from today’s packing', () => {
    // The line was agreed at 100 to a box. The catalogue now says 50. What the
    // customer is shown is still what they agreed to.
    expect(
      describeOrderingQuantity({
        quantity: 200,
        orderingUnit: 'INNER_PACK',
        unitQuantity: 2,
        piecesPerUnitSnapshot: 100,
      }),
    ).toEqual({ unit: 'INNER_PACK', unitQuantity: 2, pieces: 200, piecesPerUnit: 100 });
  });
});

describe('what may be bought', () => {
  const sellable = { isPriceOnRequest: false, isOrderable: true, unavailabilityReason: null };

  it('allows an ordinary product', () => {
    expect(isPurchasable(sellable)).toBe(true);
    expect(() => {
      assertPurchasable(sellable, 'productId');
    }).not.toThrow();
  });

  it('refuses one priced on request, and says to ask', () => {
    expect(() => {
      assertPurchasable({ ...sellable, isPriceOnRequest: true }, 'productId');
    }).toThrowError(/quotation/i);
  });

  it('refuses one on hold in the operator’s own words', () => {
    expect(() => {
      assertPurchasable(
        { ...sellable, isOrderable: false, unavailabilityReason: 'On hold until the new mould lands.' },
        'productId',
      );
    }).toThrowError('On hold until the new mould lands.');
  });

  it('puts unavailable before unpriced, because that is the more final answer', () => {
    // Both flags set. "Ask us for a price" would be misleading about something
    // that is not being sold at all this month.
    expect(() => {
      assertPurchasable(
        { isPriceOnRequest: true, isOrderable: false, unavailabilityReason: null },
        'productId',
      );
    }).toThrowError(/not available/i);
  });
});

describe('publishing a product with no price', () => {
  const complete = {
    name: 'I.V. Cannula',
    slug: 'iv-cannula',
    sku: 'IV-CANNULA',
    shortDescription: 'A cannula.',
    description: null,
    minOrderQty: 1,
    maxOrderQty: null,
    qtyIncrement: 1,
    hasVariants: false,
    activeVariantCount: 0,
    categoryIsActive: true,
  };

  it('still blocks a zero price on an ordinary product', () => {
    const blockers = validateForPublish({
      ...complete,
      basePriceMinor: 0n,
      isPriceOnRequest: false,
      mediaCount: 1,
    });

    expect(blockers.map((blocker) => blocker.code)).toContain('PRICE_REQUIRED');
  });

  it('accepts one the operator has marked priced on request', () => {
    // The zero never reaches a total: nothing priced on request can be added
    // to a basket at all. See purchasability.ts.
    const blockers = validateForPublish({
      ...complete,
      basePriceMinor: 0n,
      isPriceOnRequest: true,
      mediaCount: 0,
    });

    expect(blockers).toEqual([]);
  });

  it('still wants a photograph of anything it is quoting a price for', () => {
    const blockers = validateForPublish({
      ...complete,
      basePriceMinor: 5000n,
      isPriceOnRequest: false,
      mediaCount: 0,
    });

    expect(blockers.map((blocker) => blocker.code)).toContain('IMAGE_REQUIRED');
  });
});
