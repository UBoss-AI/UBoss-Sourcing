/**
 * Cargo insurance on a booking (JOURNEY-046): off unless the operator sets a
 * rate, capped at a share of the goods value, premium in BigInt minor units.
 */
import { describe, expect, it } from 'vitest';
import {
  decideInsurance,
  insurancePremiumMinor,
  maxInsuredValueMinor,
} from '../../src/domain/cargo-insurance.js';

const ON = { insuranceBasisPoints: 35, maxInsuredBasisPoints: 11_000 };
const GOODS = { valueMinor: 100_000n, currency: 'INR' };

describe('cargo insurance', () => {
  it('works out the premium half up, in minor units', () => {
    expect(insurancePremiumMinor(110_000n, 35)).toBe(385n);
    expect(insurancePremiumMinor(1_000n, 15)).toBe(2n); // 1.5 rounds up
    expect(insurancePremiumMinor(0n, 35)).toBe(0n);
  });

  it('caps the insured value at the share of the goods value, never below 100%', () => {
    expect(maxInsuredValueMinor(100_000n, 11_000)).toBe(110_000n);
    expect(maxInsuredValueMinor(100_000n, 5_000)).toBe(100_000n);
  });

  it('clears everything when not insured', () => {
    expect(decideInsurance({ insured: false, insuredValueMinor: '5', settings: ON, goods: GOODS })).toMatchObject({
      insured: false,
      insuredValueMinor: null,
      insurancePremiumMinor: null,
    });
  });

  it('refuses insurance the marketplace does not offer with 409', () => {
    expect(() =>
      decideInsurance({
        insured: true,
        insuredValueMinor: '1000',
        settings: { insuranceBasisPoints: 0, maxInsuredBasisPoints: 11_000 },
        goods: GOODS,
      }),
    ).toThrow(expect.objectContaining({ statusCode: 409, code: 'SHIPMENT_INSURANCE_NOT_OFFERED' }));
  });

  it('refuses a missing, zero or above-cap value with 400', () => {
    for (const value of [null, '', '0', '12.5']) {
      expect(() => decideInsurance({ insured: true, insuredValueMinor: value, settings: ON, goods: GOODS })).toThrow(
        expect.objectContaining({ statusCode: 400, code: 'BOOKING_TERMS_INVALID' }),
      );
    }
    expect(() => decideInsurance({ insured: true, insuredValueMinor: '110001', settings: ON, goods: GOODS })).toThrow(
      expect.objectContaining({ details: [expect.objectContaining({ code: 'ABOVE_CAP' })] }),
    );
  });

  it('stores the rate beside the premium it gave', () => {
    expect(decideInsurance({ insured: true, insuredValueMinor: '110000', settings: ON, goods: GOODS })).toEqual({
      insured: true,
      insuredValueMinor: 110_000n,
      insurancePremiumMinor: 385n,
      insuranceBasisPointsApplied: 35,
      currency: 'INR',
    });
  });
});
