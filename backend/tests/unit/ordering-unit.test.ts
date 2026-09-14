/**
 * Ordering by the carton.
 *
 * The whole feature is one conversion and one rounding, and both of them are
 * worth pinning.
 *
 * The conversion: two cartons is a thousand pieces, and that multiplication is
 * done on the server from the deployment's own setting. A client that could
 * post its own conversion could post "1 piece per carton" and buy a carton at
 * the price of a syringe.
 *
 * The rounding: a caller that still speaks in pieces gets whole cartons, taken
 * upwards. Part of a carton is not something this shop can ship, and quietly
 * delivering less than was asked for is the worse of the two answers.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PIECES_PER_CARTON,
  SELLING_UNIT,
  cartonsForPieces,
  describeOrderingQuantity,
  resolveOrderingQuantity,
} from '../../src/domain/ordering-unit.js';
import { assertPurchasable, isPurchasable } from '../../src/modules/catalog/purchasability.js';
import { validateForPublish } from '../../src/modules/catalog/catalog.visibility.js';

/** This deployment's carton, and the one every case below counts in. */
const PER_CARTON = 500;

describe('ordering by the carton', () => {
  it('ships a carton of five hundred unless a deployment says otherwise', () => {
    // One number, in one place: `env.PIECES_PER_CARTON` takes its default
    // from this constant rather than repeating it, so the two cannot drift
    // and price a basket differently depending on which reached it first.
    // (`env` itself is 1 in this suite - see tests/setup.ts.)
    expect(DEFAULT_PIECES_PER_CARTON).toBe(PER_CARTON);
  });

  it('converts cartons to pieces on the server side', () => {
    const resolved = resolveOrderingQuantity({
      unit: SELLING_UNIT,
      unitQuantity: 2,
      // Deliberately a lie: a client sending a flattering piece count must not
      // be able to influence the answer.
      pieces: 1,
      piecesPerCarton: PER_CARTON,
      field: 'unitQuantity',
    });

    expect(resolved).toEqual({
      quantity: 1000,
      orderingUnit: 'OUTER_CARTON',
      unitQuantity: 2,
      piecesPerUnitSnapshot: PER_CARTON,
    });
  });

  it('takes a caller that still speaks in pieces up to whole cartons', () => {
    // 600 pieces is two cartons. Rounding down would ship 500 to somebody who
    // asked for 600, and say nothing about it.
    const resolved = resolveOrderingQuantity({
      unit: undefined,
      unitQuantity: undefined,
      pieces: 600,
      piecesPerCarton: PER_CARTON,
      field: 'quantity',
    });

    expect(resolved).toEqual({
      quantity: 1000,
      orderingUnit: 'OUTER_CARTON',
      unitQuantity: 2,
      piecesPerUnitSnapshot: PER_CARTON,
    });
  });

  it('never rounds a piece count down to nothing', () => {
    expect(cartonsForPieces(1, PER_CARTON)).toBe(1);
    expect(cartonsForPieces(PER_CARTON, PER_CARTON)).toBe(1);
    expect(cartonsForPieces(PER_CARTON + 1, PER_CARTON)).toBe(2);
  });

  it('honours a deployment that packs its cartons differently', () => {
    const resolved = resolveOrderingQuantity({
      unit: SELLING_UNIT,
      unitQuantity: 3,
      pieces: 0,
      piecesPerCarton: 250,
      field: 'unitQuantity',
    });

    expect(resolved.quantity).toBe(750);
    expect(resolved.piecesPerUnitSnapshot).toBe(250);
  });

  it('rejects a carton count that is not a whole positive number', () => {
    for (const unitQuantity of [0, -1, 1.5]) {
      expect(() =>
        resolveOrderingQuantity({
          unit: SELLING_UNIT,
          unitQuantity,
          pieces: 1,
          piecesPerCarton: PER_CARTON,
          field: 'unitQuantity',
        }),
      ).toThrowError();
    }
  });

  it('refuses a basket nothing downstream could hold', () => {
    expect(() =>
      resolveOrderingQuantity({
        unit: SELLING_UNIT,
        unitQuantity: 100_000,
        pieces: 1,
        piecesPerCarton: PER_CARTON,
        field: 'unitQuantity',
      }),
    ).toThrowError();
  });

  it('describes a line from its own snapshot, not from today’s setting', () => {
    // The line was agreed at 500 to a carton. The deployment now says 250.
    // What the customer is shown is still what they agreed to.
    expect(
      describeOrderingQuantity({
        quantity: 1000,
        orderingUnit: 'OUTER_CARTON',
        unitQuantity: 2,
        piecesPerUnitSnapshot: 500,
      }),
    ).toEqual({ unit: 'OUTER_CARTON', unitQuantity: 2, pieces: 1000, piecesPerUnit: 500 });
  });

  it('still describes a line placed before the shop sold cartons', () => {
    // Rows written when pieces were orderable keep saying so. An old invoice
    // that reworded itself would be an invoice that no longer matches what
    // was signed.
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
