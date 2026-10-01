/**
 * Seller performance (Seller Hub): RFQ conversion, OTIF delivery, quality,
 * cancellations and claims. See `backend/src/modules/seller/performance.service.ts`
 * for exactly what each figure counts.
 */
import { api } from './api';

/** A rate as the two counts it is made of. Zero over zero is "no data", not 0%. */
export interface Ratio {
  numerator: number;
  denominator: number;
}

export interface SellerPerformance {
  days: number;
  periodFrom: string;
  periodTo: string;
  rfq: { invited: number; quoted: number; won: number; conversion: Ratio; quoteRate: Ratio };
  orders: {
    placed: number;
    cancelled: number;
    delivered: number;
    fulfilmentRate: Ratio;
    cancellationRate: Ratio;
  };
  delivery: {
    deliveredInPeriod: number;
    withoutPromisedDate: number;
    onTime: Ratio;
    inFull: Ratio;
    otif: Ratio;
    dispatchOnTime: Ratio;
  };
  quality: {
    returns: number;
    returnRate: Ratio;
    inspectionsSigned: number;
    inspectionsFailed: number;
    inspectionFailRate: Ratio;
    openNcrs: number;
  };
  claims: { opened: number; open: number; chargebacks: number; claimRate: Ratio };
}

export const PERFORMANCE_WINDOWS = [30, 90, 365] as const;

export function fetchPerformance(days: number): Promise<SellerPerformance> {
  return api.get<SellerPerformance>(`/seller/performance?days=${String(days)}`);
}

/** "62%" to whole percent, or null when there is nothing to measure. */
export function percentOf(ratio: Ratio): number | null {
  if (ratio.denominator <= 0) return null;
  return Math.round((ratio.numerator / ratio.denominator) * 100);
}
