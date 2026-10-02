/**
 * The pure rules for turning an approved RFQ purchase order into an order
 * (LIVE-004), kept apart from the database so they can be tested on their own.
 *
 * Two questions, each with one answer used everywhere:
 *
 *   - How many units go on the order line? An RFQ quantity has up to three
 *     decimal places ("12.5 tonnes"); an order line counts whole units. A
 *     purchase order whose quantity is not a whole number is REFUSED, never
 *     rounded: rounding would bill the buyer for an amount they did not sign
 *     for, and scaling to thousandths would make the seller pack "12500" of
 *     something sold by the tonne.
 *   - Must the goods be inspected before they leave? Yes whenever the buyer's
 *     requirement asked for any check, or the accepted offer named inspection
 *     terms. The purchase order is the contract; the marketplace's own rules
 *     can only add to it.
 */
import { quantityThousandths } from './rfq.js';

/** The largest quantity an order line holds (a signed 32-bit INT column). */
export const MAX_ORDER_LINE_QUANTITY = 2_147_483_647;

export type WholeQuantity =
  | { ok: true; units: number }
  | { ok: false; code: 'FRACTIONAL_QUANTITY' | 'QUANTITY_TOO_LARGE' };

/** The whole number of units a purchase-order quantity is, or why it is not one. */
export function wholeOrderQuantity(quantity: string): WholeQuantity {
  if (!/^\d{1,15}(\.\d{1,3})?$/.test(quantity)) return { ok: false, code: 'FRACTIONAL_QUANTITY' };
  const thousandths = quantityThousandths(quantity);
  if (thousandths <= 0n || thousandths % 1000n !== 0n) return { ok: false, code: 'FRACTIONAL_QUANTITY' };
  const units = thousandths / 1000n;
  if (units > BigInt(MAX_ORDER_LINE_QUANTITY)) return { ok: false, code: 'QUANTITY_TOO_LARGE' };
  return { ok: true, units: Number(units) };
}

export interface PurchaseOrderQuality {
  inspectionRequirement: string;
  inspectionTerms: string | null;
}

/**
 * Whether the purchase order itself demands a pre-shipment inspection, and
 * the sentence that says why. Null when it asks for none.
 */
export function purchaseOrderInspectionReason(reference: string, quality: PurchaseOrderQuality): string | null {
  const terms = quality.inspectionTerms?.trim() ?? '';
  const asked = quality.inspectionRequirement !== 'NONE' && quality.inspectionRequirement.trim() !== '';
  if (!asked && terms === '') return null;
  const reason = `Purchase order ${reference} requires a pre-shipment inspection${terms === '' ? '.' : `: ${terms}`}`;
  // The requirement's reason column holds 512 characters.
  return reason.length <= 512 ? reason : `${reason.slice(0, 509)}...`;
}
