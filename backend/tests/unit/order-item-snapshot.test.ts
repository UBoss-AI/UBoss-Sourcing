/**
 * Reading a stored order-item snapshot: a shape this code does not know is
 * refused, never half-rendered.
 */
import { describe, expect, it } from 'vitest';
import { ORDER_ITEM_SNAPSHOT_VERSION, readOrderItemSnapshot } from '../../src/domain/order-item-snapshot.js';

const VALID = {
  schemaVersion: ORDER_ITEM_SNAPSHOT_VERSION,
  capturedAt: '2026-10-03T09:00:00.000Z',
  productId: '01PRODUCT00000000000000000',
  productName: 'Bottle',
  sku: 'BTL',
  variantId: null,
  variantName: null,
  selectedOptions: [],
  description: { text: null, html: null, sections: [] },
  specificationGroups: [{ group: 'GENERAL', rows: [{ label: 'Model', value: 'X', unit: null, highlight: false }] }],
  packaging: {
    orderingUnit: 'PIECE',
    unitQuantity: 1,
    piecesPerUnit: 1,
    equivalentPieces: 1,
    packageType: null,
    unitsPerCarton: null,
    cartonsPerPallet: null,
    cartonsPerContainer: null,
    dimensionsMm: null,
    grossWeightGrams: null,
  },
  moqPieces: null,
  piecesPerCarton: null,
  containerCapacity: { CONTAINER_20_FT: null, CONTAINER_40_FT: null },
  specialInstructions: null,
};

describe('readOrderItemSnapshot', () => {
  it('reads the current version', () => {
    expect(readOrderItemSnapshot(VALID)?.productName).toBe('Bottle');
  });

  it('refuses a version it does not know, a broken shape, and nothing at all', () => {
    expect(readOrderItemSnapshot({ ...VALID, schemaVersion: 2 })).toBeNull();
    expect(readOrderItemSnapshot({ ...VALID, specificationGroups: [{ group: 'NOT_A_GROUP', rows: [] }] })).toBeNull();
    expect(readOrderItemSnapshot(null)).toBeNull();
    expect(readOrderItemSnapshot('text')).toBeNull();
  });
});
