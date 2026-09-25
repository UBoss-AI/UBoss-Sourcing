/**
 * Container loading: the one formula, and the refusals that keep a seller's
 * figure physically possible and safe.
 */
import { describe, expect, it } from 'vitest';

import {
  cartonFits,
  containerEquivalent,
  containerLimits,
  estimateCartonsPerContainer,
  resolveSource,
  validateContainerLoading,
  type CartonSpec,
  type ContainerSize,
  type LoadingInput,
} from '../../src/domain/container-loading.js';

const limitsFor = (size: ContainerSize) =>
  containerLimits(size, size === 'CONTAINER_20_FT' ? 28_200 : 26_700);

const carton: CartonSpec = {
  piecesPerCarton: 100,
  lengthMm: 400,
  widthMm: 300,
  heightMm: 250,
  grossWeightGrams: 10_000n,
  maxStackLayers: null,
};

function loading(overrides: Partial<LoadingInput> = {}): LoadingInput {
  return {
    carton,
    loadingMethod: 'CARTON_LOADED',
    cartonsPerPallet: null,
    sizes: {
      CONTAINER_20_FT: { cartonsPerContainer: 120, palletsPerContainer: null, verified: true },
      CONTAINER_40_FT: { cartonsPerContainer: 250, palletsPerContainer: null, verified: true },
    },
    ...overrides,
  };
}

describe('pieces per container', () => {
  it('is pieces per carton times cartons per container, for each size', () => {
    const result = validateContainerLoading(loading(), limitsFor);
    expect(result.issues).toEqual([]);
    expect(result.sizes.CONTAINER_20_FT?.piecesPerContainer).toBe(12_000);
    expect(result.sizes.CONTAINER_40_FT?.piecesPerContainer).toBe(25_000);
  });

  it('comes from pallets x cartons per pallet when the container is palletised', () => {
    const result = validateContainerLoading(
      loading({
        loadingMethod: 'PALLET_LOADED',
        cartonsPerPallet: 40,
        sizes: {
          CONTAINER_20_FT: { cartonsPerContainer: null, palletsPerContainer: 10, verified: true },
          CONTAINER_40_FT: null,
        },
      }),
      limitsFor,
    );
    expect(result.issues).toEqual([]);
    expect(result.sizes.CONTAINER_20_FT?.cartonsPerContainer).toBe(400);
    expect(result.sizes.CONTAINER_20_FT?.piecesPerContainer).toBe(40_000);
    expect(result.sizes.CONTAINER_40_FT).toBeNull();
  });

  it('leaves a size the seller did not configure empty rather than zero', () => {
    const result = validateContainerLoading(
      loading({ sizes: { CONTAINER_20_FT: null, CONTAINER_40_FT: null } }),
      limitsFor,
    );
    expect(result.sizes.CONTAINER_20_FT).toBeNull();
    expect(result.sizes.CONTAINER_40_FT).toBeNull();
  });
});

describe('an impossible or unsafe loading is refused', () => {
  it('when the cargo is heavier than the configured payload', () => {
    // 3,000 cartons of 10 kg is 30 t, above a 28.2 t 20-ft limit.
    const result = validateContainerLoading(
      loading({
        sizes: {
          CONTAINER_20_FT: { cartonsPerContainer: 3000, palletsPerContainer: null, verified: true },
          CONTAINER_40_FT: null,
        },
      }),
      limitsFor,
    );
    expect(result.issues.map((issue) => issue.code)).toContain('PAYLOAD_EXCEEDED');
    expect(result.sizes.CONTAINER_20_FT).toBeNull();
  });

  it('respects a lower payload limit the deployment configured', () => {
    const strict = (size: ContainerSize) => containerLimits(size, 1000);
    const result = validateContainerLoading(loading(), strict);
    expect(result.issues.map((issue) => issue.code)).toContain('PAYLOAD_EXCEEDED');
  });

  it('when the cartons take more room than the container, whatever they weigh', () => {
    const light: CartonSpec = { ...carton, grossWeightGrams: 1n };
    const result = validateContainerLoading(
      loading({
        carton: light,
        sizes: {
          CONTAINER_20_FT: { cartonsPerContainer: 2000, palletsPerContainer: null, verified: true },
          CONTAINER_40_FT: null,
        },
      }),
      limitsFor,
    );
    expect(result.issues.map((issue) => issue.code)).toContain('VOLUME_EXCEEDED');
  });

  it('when one carton does not fit through the container at all', () => {
    const huge: CartonSpec = { ...carton, lengthMm: 7000, widthMm: 2600, heightMm: 2600 };
    expect(cartonFits(huge, limitsFor('CONTAINER_20_FT'))).toBe(false);
    const result = validateContainerLoading(loading({ carton: huge }), limitsFor);
    expect(result.issues.map((issue) => issue.code)).toContain('CARTON_DOES_NOT_FIT');
  });

  it('when a figure is missing or not a whole number', () => {
    const result = validateContainerLoading(
      loading({ carton: { ...carton, piecesPerCarton: 0 } }),
      limitsFor,
    );
    expect(result.issues.map((issue) => issue.code)).toContain('PIECES_PER_CARTON_REQUIRED');

    const fractional = validateContainerLoading(
      loading({
        sizes: {
          CONTAINER_20_FT: { cartonsPerContainer: 12.5, palletsPerContainer: null, verified: true },
          CONTAINER_40_FT: null,
        },
      }),
      limitsFor,
    );
    expect(fractional.issues.map((issue) => issue.code)).toContain('CARTONS_PER_CONTAINER_REQUIRED');
  });
});

describe('the estimate', () => {
  it('is limited by space, stacking and weight - never by volume alone', () => {
    const limits = limitsFor('CONTAINER_20_FT');
    const bySpace = estimateCartonsPerContainer(carton, limits);
    expect(bySpace?.limitedBy).toBe('SPACE');
    expect(bySpace?.cartons).toBeGreaterThan(0);

    const stacked = estimateCartonsPerContainer({ ...carton, maxStackLayers: 2 }, limits);
    expect(stacked?.limitedBy).toBe('STACKING');
    expect(stacked?.cartons ?? 0).toBeLessThan(bySpace?.cartons ?? 0);

    // 1 t cartons: 28 of them reach the payload long before the space runs out.
    const heavy = estimateCartonsPerContainer({ ...carton, grossWeightGrams: 1_000_000n }, limits);
    expect(heavy).toEqual({ cartons: 28, limitedBy: 'WEIGHT' });
  });

  it('is not offered when a carton does not fit', () => {
    const huge: CartonSpec = { ...carton, lengthMm: 7000, widthMm: 2600, heightMm: 2600 };
    expect(estimateCartonsPerContainer(huge, limitsFor('CONTAINER_20_FT'))).toBeNull();
  });
});

describe('verification', () => {
  const now = new Date('2026-09-24T10:00:00Z');
  const before = new Date('2026-09-01T10:00:00Z');

  it('is recorded when the seller verifies on this save', () => {
    expect(
      resolveSource({
        verifiedNow: true,
        previousSource: null,
        previousVerifiedAt: null,
        figuresChanged: true,
        now,
      }),
    ).toEqual({ source: 'SELLER_VERIFIED', verifiedAt: now });
  });

  it('is kept, with its date, when nothing it depends on changed', () => {
    expect(
      resolveSource({
        verifiedNow: false,
        previousSource: 'SELLER_VERIFIED',
        previousVerifiedAt: before,
        figuresChanged: false,
        now,
      }),
    ).toEqual({ source: 'SELLER_VERIFIED', verifiedAt: before });
  });

  it('is lost when the figures change and the seller does not verify again', () => {
    expect(
      resolveSource({
        verifiedNow: false,
        previousSource: 'SELLER_VERIFIED',
        previousVerifiedAt: before,
        figuresChanged: true,
        now,
      }),
    ).toEqual({ source: 'CALCULATED_ESTIMATE', verifiedAt: null });
  });
});

describe('container equivalents never round the quantity', () => {
  it('splits pieces into whole containers and a partial balance', () => {
    expect(containerEquivalent(24_000, 12_000)).toEqual({
      fullContainers: 2,
      remainderPieces: 0,
      isWholeContainers: true,
    });
    expect(containerEquivalent(9_000, 12_000)).toEqual({
      fullContainers: 0,
      remainderPieces: 9_000,
      isWholeContainers: false,
    });
    expect(containerEquivalent(15_000, 12_000)).toEqual({
      fullContainers: 1,
      remainderPieces: 3_000,
      isWholeContainers: false,
    });
  });
});
