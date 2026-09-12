/**
 * Whether a listed product can actually be bought.
 *
 * Publication answers "may a customer see this". This answers "may a customer
 * buy it", which is a different question with different answers, and the gap
 * between them is the whole point: a catalogue that can only show what it can
 * sell cannot list a product whose price is negotiated, or one that is made but
 * held this quarter, and a B2B range is full of both.
 *
 * Every purchase path goes through this one function - basket, instant buy,
 * scheduled plans - for the same reason `publicProductWhere()` is the only
 * public visibility filter. Two copies of this rule is how one of them
 * eventually forgets a case, and the case it forgets is a customer being
 * charged for something nobody priced.
 */
import { ErrorCode, conflict } from '../../domain/errors.js';

export interface PurchasabilityInput {
  isPriceOnRequest: boolean;
  isOrderable: boolean;
  unavailabilityReason: string | null;
}

/**
 * Throw unless this product can be added to a basket.
 *
 * A 409 rather than a 404 in both cases: the product is genuinely there and
 * genuinely visible, and answering "not found" would send somebody chasing a
 * link they can see working in front of them.
 */
export function assertPurchasable(product: PurchasabilityInput, field: string): void {
  if (!product.isOrderable) {
    throw conflict(
      ErrorCode.PRODUCT_NOT_ORDERABLE,
      product.unavailabilityReason ?? 'This product is not available to order at the moment.',
      [{ field, code: 'NOT_ORDERABLE' }],
    );
  }

  if (product.isPriceOnRequest) {
    throw conflict(
      ErrorCode.PRODUCT_PRICE_ON_REQUEST,
      'This product is priced on request. Ask us for a quotation and we will price it for your account.',
      [{ field, code: 'PRICE_ON_REQUEST' }],
    );
  }
}

/** The same decision without the throw, for a read that is only reporting. */
export function isPurchasable(product: PurchasabilityInput): boolean {
  return product.isOrderable && !product.isPriceOnRequest;
}
