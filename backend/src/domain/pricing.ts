/**
 * Pricing.
 *
 * The server is the only authority on price. Nothing here trusts a number that
 * arrived from a browser: a line is priced from the catalog row and the tax
 * class as they exist at the moment of calculation, and the client is told the
 * result.
 *
 * Every amount is BigInt minor units. The output of `priceLines` is exactly
 * what gets frozen into `order_items` at checkout - the snapshot that later
 * catalog edits must never disturb.
 */
import {
  apportion,
  assertNonNegative,
  calculateTax,
  sumMinor,
  type Minor,
} from './money.js';

export interface PricingProduct {
  productId: string;
  variantId: string | null;
  name: string;
  sku: string;
  variantName: string | null;
  /** Variant price when set, otherwise the product base price. */
  unitPriceMinor: Minor;
  taxClassCode: string;
  taxRatePercent: string;
  taxInclusive: boolean;
  isRecurringEligible: boolean;
  imageUrl: string | null;
}

export interface PricingLineInput {
  product: PricingProduct;
  quantity: number;
  /** Line-level discount, already validated against any promotion rules. */
  discountMinor?: Minor;
}

export interface PricedLine {
  productId: string;
  variantId: string | null;
  nameSnapshot: string;
  skuSnapshot: string;
  variantNameSnapshot: string | null;
  taxClassCodeSnapshot: string;
  imageUrlSnapshot: string | null;

  unitPriceMinor: Minor;
  quantity: number;
  lineSubtotalMinor: Minor;
  discountMinor: Minor;
  taxRatePercent: string;
  taxInclusive: boolean;
  taxAmountMinor: Minor;
  lineTotalMinor: Minor;

  isRecurringEligibleSnapshot: boolean;
}

export interface OrderTotals {
  subtotalMinor: Minor;
  discountMinor: Minor;
  taxMinor: Minor;
  shippingMinor: Minor;
  grandTotalMinor: Minor;
}

export interface PricingResult {
  lines: PricedLine[];
  totals: OrderTotals;
}

export interface ShippingInput {
  priceMinor: Minor;
  /** Order subtotal at or above which shipping is free. Null = never free. */
  freeAboveMinor: Minor | null;
}

export interface PricingOptions {
  /**
   * Discount applied to the order as a whole. Apportioned across lines by value
   * so per-line tax stays correct - taxing the undiscounted amount would
   * overcharge, and applying the discount only to the total would leave the
   * line figures inconsistent with it.
   */
  orderDiscountMinor?: Minor;
  shipping?: ShippingInput;
}

/**
 * Price one line.
 *
 * Inclusive tax is extracted from the price rather than added to it, so the
 * customer pays the number they saw on the product page. Exclusive tax is added
 * on top. `lineTotalMinor` is what the customer pays for this line either way.
 */
export function priceLine(input: PricingLineInput): PricedLine {
  const { product, quantity } = input;

  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RangeError(`Quantity must be a positive integer (got ${String(quantity)})`);
  }
  assertNonNegative(product.unitPriceMinor, 'Unit price');

  const lineSubtotalMinor = product.unitPriceMinor * BigInt(quantity);
  const discountMinor = input.discountMinor ?? 0n;
  assertNonNegative(discountMinor, 'Discount');

  if (discountMinor > lineSubtotalMinor) {
    throw new RangeError('A line discount cannot exceed the line subtotal');
  }

  // Tax is calculated on the discounted amount. Taxing the pre-discount value
  // would charge the customer tax on money they never paid.
  const taxableBase = lineSubtotalMinor - discountMinor;
  const tax = calculateTax(taxableBase, product.taxRatePercent, product.taxInclusive);

  return {
    productId: product.productId,
    variantId: product.variantId,
    nameSnapshot: product.name,
    skuSnapshot: product.sku,
    variantNameSnapshot: product.variantName,
    taxClassCodeSnapshot: product.taxClassCode,
    imageUrlSnapshot: product.imageUrl,

    unitPriceMinor: product.unitPriceMinor,
    quantity,
    lineSubtotalMinor,
    discountMinor,
    taxRatePercent: product.taxRatePercent,
    taxInclusive: product.taxInclusive,
    taxAmountMinor: tax.taxMinor,
    // Inclusive: the listed price already contains the tax, so the total is the
    // base. Exclusive: tax is added on top.
    lineTotalMinor: product.taxInclusive ? taxableBase : taxableBase + tax.taxMinor,

    isRecurringEligibleSnapshot: product.isRecurringEligible,
  };
}

/**
 * Price a whole cart or order.
 *
 * Order-level discount is apportioned across lines BEFORE tax, weighted by line
 * subtotal, using largest-remainder so the parts sum exactly to the whole. A
 * discount applied only at the total would leave line tax figures that do not
 * add up to the tax charged - which an auditor will find.
 */
export function priceLines(
  inputs: readonly PricingLineInput[],
  options: PricingOptions = {},
): PricingResult {
  if (inputs.length === 0) {
    return {
      lines: [],
      totals: {
        subtotalMinor: 0n,
        discountMinor: 0n,
        taxMinor: 0n,
        shippingMinor: 0n,
        grandTotalMinor: 0n,
      },
    };
  }

  const orderDiscountMinor = options.orderDiscountMinor ?? 0n;
  assertNonNegative(orderDiscountMinor, 'Order discount');

  const lineSubtotals = inputs.map(
    (input) => input.product.unitPriceMinor * BigInt(input.quantity),
  );
  const subtotalMinor = sumMinor(lineSubtotals);

  if (orderDiscountMinor > subtotalMinor) {
    throw new RangeError('An order discount cannot exceed the order subtotal');
  }

  const apportioned =
    orderDiscountMinor > 0n
      ? apportion(orderDiscountMinor, lineSubtotals)
      : inputs.map(() => 0n);

  const lines = inputs.map((input, index) =>
    priceLine({
      ...input,
      discountMinor: (input.discountMinor ?? 0n) + (apportioned[index] ?? 0n),
    }),
  );

  const discountMinor = sumMinor(lines.map((line) => line.discountMinor));
  const taxMinor = sumMinor(lines.map((line) => line.taxAmountMinor));
  const lineTotalsMinor = sumMinor(lines.map((line) => line.lineTotalMinor));

  const shippingMinor = calculateShipping(options.shipping, subtotalMinor - discountMinor);

  return {
    lines,
    totals: {
      subtotalMinor,
      discountMinor,
      taxMinor,
      shippingMinor,
      // Built from the line totals rather than recomputed from subtotal/tax, so
      // the header can never disagree with the sum of its lines.
      grandTotalMinor: lineTotalsMinor + shippingMinor,
    },
  };
}

/** Free above the configured threshold, measured on the discounted subtotal. */
export function calculateShipping(shipping: ShippingInput | undefined, netSubtotal: Minor): Minor {
  if (shipping === undefined) return 0n;
  assertNonNegative(shipping.priceMinor, 'Shipping price');

  if (shipping.freeAboveMinor !== null && netSubtotal >= shipping.freeAboveMinor) {
    return 0n;
  }
  return shipping.priceMinor;
}

/**
 * Verify that a set of totals is internally consistent.
 *
 * Called before an order is written and before a payment intent is created, so
 * an arithmetic regression fails loudly at the boundary rather than becoming a
 * customer charged the wrong amount.
 */
export function assertTotalsConsistent(lines: readonly PricedLine[], totals: OrderTotals): void {
  const expectedSubtotal = sumMinor(lines.map((line) => line.lineSubtotalMinor));
  const expectedDiscount = sumMinor(lines.map((line) => line.discountMinor));
  const expectedTax = sumMinor(lines.map((line) => line.taxAmountMinor));
  const expectedGrand = sumMinor(lines.map((line) => line.lineTotalMinor)) + totals.shippingMinor;

  const mismatches: string[] = [];
  if (totals.subtotalMinor !== expectedSubtotal) mismatches.push('subtotal');
  if (totals.discountMinor !== expectedDiscount) mismatches.push('discount');
  if (totals.taxMinor !== expectedTax) mismatches.push('tax');
  if (totals.grandTotalMinor !== expectedGrand) mismatches.push('grandTotal');

  if (mismatches.length > 0) {
    throw new Error(
      `Order totals are inconsistent with their lines: ${mismatches.join(', ')}. ` +
        'This is an arithmetic bug; the order must not be written.',
    );
  }

  if (totals.grandTotalMinor < 0n) {
    throw new Error('Order total cannot be negative');
  }
}

// --- Purchasing rules ------------------------------------------------------

export interface QuantityRules {
  minOrderQty: number;
  maxOrderQty: number | null;
  qtyIncrement: number;
}

export type QuantityViolation =
  | { code: 'QUANTITY_BELOW_MINIMUM'; minimum: number }
  | { code: 'QUANTITY_ABOVE_MAXIMUM'; maximum: number }
  | { code: 'QUANTITY_INCREMENT_INVALID'; increment: number; minimum: number };

/**
 * Validate a requested quantity against the product's purchasing rules.
 *
 * Returns the violation rather than throwing, so a cart can report every
 * offending line at once instead of failing on the first.
 *
 * The increment is measured FROM the minimum, not from zero: a product with
 * min 10 and increment 5 permits 10, 15, 20 - not 5.
 */
export function checkQuantity(quantity: number, rules: QuantityRules): QuantityViolation | null {
  if (quantity < rules.minOrderQty) {
    return { code: 'QUANTITY_BELOW_MINIMUM', minimum: rules.minOrderQty };
  }

  if (rules.maxOrderQty !== null && quantity > rules.maxOrderQty) {
    return { code: 'QUANTITY_ABOVE_MAXIMUM', maximum: rules.maxOrderQty };
  }

  if (rules.qtyIncrement > 1 && (quantity - rules.minOrderQty) % rules.qtyIncrement !== 0) {
    return {
      code: 'QUANTITY_INCREMENT_INVALID',
      increment: rules.qtyIncrement,
      minimum: rules.minOrderQty,
    };
  }

  return null;
}

export interface OrderValueRules {
  perOrderMinMinor: Minor | null;
  perOrderMaxMinor: Minor | null;
}

export type OrderValueViolation =
  | { code: 'ORDER_BELOW_MINIMUM_VALUE'; minimumMinor: Minor }
  | { code: 'ORDER_ABOVE_MAXIMUM_VALUE'; maximumMinor: Minor };

/** Customer-level order value limits, checked against the grand total. */
export function checkOrderValue(
  grandTotalMinor: Minor,
  rules: OrderValueRules,
): OrderValueViolation | null {
  if (rules.perOrderMinMinor !== null && grandTotalMinor < rules.perOrderMinMinor) {
    return { code: 'ORDER_BELOW_MINIMUM_VALUE', minimumMinor: rules.perOrderMinMinor };
  }

  if (rules.perOrderMaxMinor !== null && grandTotalMinor > rules.perOrderMaxMinor) {
    return { code: 'ORDER_ABOVE_MAXIMUM_VALUE', maximumMinor: rules.perOrderMaxMinor };
  }

  return null;
}
