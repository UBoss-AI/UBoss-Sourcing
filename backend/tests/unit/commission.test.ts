/**
 * What the marketplace keeps, to the paisa.
 *
 * Commission is the number a seller checks a settlement against, so the two
 * things that matter here are both about being boring and exact: it must round
 * the same way every time, and it must never be computed in floating point.
 *
 * The rounding case is the one worth having a test for. Integer division
 * truncates, which is a silent, systematic bias in the seller's favour of up to
 * one minor unit per line — invisible on one order and a settlement that fails
 * to reconcile by a few rupees across a month. Half-up is the convention the
 * arithmetic here uses, and this file is what pins it.
 */
import { describe, expect, it } from 'vitest';
import {
  commissionBasisPointsFor,
  commissionOn,
} from '../../src/modules/seller/order-split.service.js';

describe('commissionOn', () => {
  it('takes the stated percentage of a round amount', () => {
    // 2.50% of ₹100.00 is ₹2.50.
    expect(commissionOn(10_000n, 250)).toBe(250n);
  });

  it('rounds half up rather than truncating', () => {
    // 2.50% of 101 paise is 2.525 paise. Truncation gives 2; half-up gives 3.
    expect(commissionOn(101n, 250)).toBe(3n);

    // Exactly a half: 5.00% of 10 is 0.5.
    expect(commissionOn(10n, 500)).toBe(1n);
  });

  it('is zero when there is no rate', () => {
    expect(commissionOn(999_999n, 0)).toBe(0n);
  });

  it('is zero on a zero or negative amount rather than negative', () => {
    expect(commissionOn(0n, 250)).toBe(0n);
    // A negative line should never reach it, but producing a negative
    // commission would pay a seller for a refund twice over.
    expect(commissionOn(-5_000n, 250)).toBe(0n);
  });

  it('stays exact on a figure that would lose precision as a float', () => {
    // 9,007,199,254,740,993 paise is above Number.MAX_SAFE_INTEGER. The whole
    // reason money is BigInt: as a float this amount does not survive being
    // read, let alone multiplied.
    const huge = 9_007_199_254_740_993n;
    expect(commissionOn(huge, 10_000)).toBe(huge);
  });

  it('takes everything at 100% and nothing above it is possible', () => {
    expect(commissionOn(1_000n, 10_000)).toBe(1_000n);
  });
});

describe('commissionBasisPointsFor', () => {
  it("uses the seller's own rate where they have one", () => {
    expect(commissionBasisPointsFor(150, 500)).toBe(150);
  });

  it('falls back to the platform rate where the seller has none', () => {
    expect(commissionBasisPointsFor(null, 500)).toBe(500);
  });

  it('treats a seller rate of zero as a real rate, not as absent', () => {
    // A seller negotiated to zero commission is a real deal, and `?? ` would
    // keep it while `||` would silently charge them the platform rate.
    expect(commissionBasisPointsFor(0, 500)).toBe(0);
  });

  it('clamps a negative rate to zero', () => {
    // A negative rate would pay the seller more than the buyer paid. That is a
    // configuration mistake, not a deal.
    expect(commissionBasisPointsFor(-100, 500)).toBe(0);
  });

  it('clamps above 100% to 100%', () => {
    expect(commissionBasisPointsFor(25_000, 500)).toBe(10_000);
  });

  it('truncates a fractional rate rather than carrying it into the arithmetic', () => {
    expect(commissionBasisPointsFor(250.9, 0)).toBe(250);
  });
});
