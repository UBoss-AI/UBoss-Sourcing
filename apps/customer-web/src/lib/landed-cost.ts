/** Landed cost arithmetic (checklist Master row 89). BigInt minor units only. */
import { majorToMinor } from '@/lib/format';

/** "12.5" -> 1250 basis points; null when not a plain non-negative number. */
export function percentToBasisPoints(text: string): bigint | null {
  const minor = majorToMinor(text === '' ? '0' : text, 2);
  return minor === null ? null : BigInt(minor);
}

/** amount x bp / 10000, rounded half up. */
export function applyBasisPoints(amount: bigint, basisPoints: bigint): bigint {
  return (amount * basisPoints + 5_000n) / 10_000n;
}

export interface LandedCostInput {
  unitPriceMinor: bigint;
  quantity: bigint;
  freightMinor: bigint;
  inspectionMinor: bigint;
  dutyBp: bigint;
  taxBp: bigint;
  platformFeeBp: bigint;
}

/**
 * Duty on goods plus freight (the customs value most destinations use); tax on
 * that value plus duty; the platform fee on the goods.
 */
export function landedCost(input: LandedCostInput): Record<'goods' | 'freight' | 'duty' | 'tax' | 'inspection' | 'platform' | 'total' | 'perUnit', bigint> {
  const goods = input.unitPriceMinor * input.quantity;
  const customsValue = goods + input.freightMinor;
  const duty = applyBasisPoints(customsValue, input.dutyBp);
  const tax = applyBasisPoints(customsValue + duty, input.taxBp);
  const platform = applyBasisPoints(goods, input.platformFeeBp);
  const total = goods + input.freightMinor + duty + tax + input.inspectionMinor + platform;
  const perUnit = input.quantity === 0n ? 0n : (total + input.quantity / 2n) / input.quantity;
  return { goods, freight: input.freightMinor, duty, tax, inspection: input.inspectionMinor, platform, total, perUnit };
}
