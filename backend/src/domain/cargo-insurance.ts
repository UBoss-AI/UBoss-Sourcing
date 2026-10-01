/**
 * Cargo insurance on a booked consignment (JOURNEY-046).
 *
 * The operator decides whether insurance is offered at all and at what rate
 * (`LogisticsTradeSettings.insuranceBasisPoints`; 0 means not offered), and
 * the most that may be insured as a share of the goods value
 * (`maxInsuredBasisPoints`; 11000 is the usual 110% CIF/CIP convention).
 *
 * Pure, and BigInt minor units throughout: the premium the seller is shown is
 * the premium stored beside the rate that produced it.
 */
import { ErrorCode, badRequest, conflict } from './errors.js';

export interface InsuranceSettings {
  insuranceBasisPoints: number;
  maxInsuredBasisPoints: number;
}

/** The premium on `insuredValueMinor` at `basisPoints`, rounded half up to the minor unit. */
export function insurancePremiumMinor(insuredValueMinor: bigint, basisPoints: number): bigint {
  if (insuredValueMinor <= 0n || basisPoints <= 0) return 0n;
  return (insuredValueMinor * BigInt(basisPoints) + 5000n) / 10_000n;
}

/** The most that may be insured on goods worth `goodsValueMinor`, rounded down. */
export function maxInsuredValueMinor(goodsValueMinor: bigint, maxInsuredBasisPoints: number): bigint {
  if (goodsValueMinor <= 0n) return 0n;
  return (goodsValueMinor * BigInt(Math.max(10_000, maxInsuredBasisPoints))) / 10_000n;
}

export interface InsuranceDecision {
  insured: boolean;
  insuredValueMinor: bigint | null;
  insurancePremiumMinor: bigint | null;
  insuranceBasisPointsApplied: number | null;
  currency: string | null;
}

export const NOT_INSURED: InsuranceDecision = Object.freeze({
  insured: false,
  insuredValueMinor: null,
  insurancePremiumMinor: null,
  insuranceBasisPointsApplied: null,
  currency: null,
});

/**
 * Check a seller's insurance choice against the operator's settings and the
 * goods value, and work out the premium.
 *
 * Refuses with 409 SHIPMENT_INSURANCE_NOT_OFFERED when the installation does
 * not offer insurance, and with 400 BOOKING_TERMS_INVALID when the value is
 * missing, not a positive whole number of minor units, or above the cap.
 */
export function decideInsurance(input: {
  insured: boolean;
  /** Minor units as a string of digits, as it crosses the API. */
  insuredValueMinor: string | null;
  settings: InsuranceSettings;
  goods: { valueMinor: bigint | null; currency: string | null };
}): InsuranceDecision {
  if (!input.insured) return NOT_INSURED;

  if (input.settings.insuranceBasisPoints <= 0) {
    throw conflict(ErrorCode.SHIPMENT_INSURANCE_NOT_OFFERED, 'Cargo insurance is not offered on this marketplace.', [
      { field: 'insured', code: 'NOT_OFFERED' },
    ]);
  }

  const text = input.insuredValueMinor?.trim() ?? '';
  if (text === '') {
    throw badRequest(ErrorCode.BOOKING_TERMS_INVALID, 'Enter the value to insure.', [
      { field: 'insuredValueMinor', code: 'REQUIRED' },
    ]);
  }
  if (!/^[0-9]{1,18}$/.test(text) || BigInt(text) <= 0n) {
    throw badRequest(ErrorCode.BOOKING_TERMS_INVALID, 'The value to insure must be above zero.', [
      { field: 'insuredValueMinor', code: 'NOT_POSITIVE' },
    ]);
  }
  const value = BigInt(text);

  if (input.goods.valueMinor === null || input.goods.valueMinor <= 0n || input.goods.currency === null) {
    throw badRequest(ErrorCode.BOOKING_TERMS_INVALID, 'This consignment has no goods value to insure against.', [
      { field: 'insuredValueMinor', code: 'NO_GOODS_VALUE' },
    ]);
  }

  const cap = maxInsuredValueMinor(input.goods.valueMinor, input.settings.maxInsuredBasisPoints);
  if (value > cap) {
    throw badRequest(ErrorCode.BOOKING_TERMS_INVALID, 'That is more than may be insured on these goods.', [
      {
        field: 'insuredValueMinor',
        code: 'ABOVE_CAP',
        meta: { maxInsuredValueMinor: cap.toString(), currency: input.goods.currency },
      },
    ]);
  }

  return {
    insured: true,
    insuredValueMinor: value,
    insurancePremiumMinor: insurancePremiumMinor(value, input.settings.insuranceBasisPoints),
    insuranceBasisPointsApplied: input.settings.insuranceBasisPoints,
    currency: input.goods.currency,
  };
}
