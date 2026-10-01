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

/**
 * Expected delivery range (ENH-006): the earliest and latest arrival dates,
 * counted in calendar days from `from` in the viewer's own calendar. Null when the days are not
 * whole non-negative numbers or the minimum is above the maximum.
 */
export function deliveryRange(from: Date, minDaysText: string, maxDaysText: string): { earliest: string; latest: string } | null {
  if (!/^\d{1,3}$/.test(minDaysText) || !/^\d{1,3}$/.test(maxDaysText)) return null;
  const minDays = Number(minDaysText);
  const maxDays = Number(maxDaysText);
  if (minDays > maxDays) return null;
  const day = (offset: number): string => {
    const date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);
    return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  return { earliest: day(minDays), latest: day(maxDays) };
}
