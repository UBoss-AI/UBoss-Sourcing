/**
 * Response fixtures, shaped exactly as the real API replies.
 *
 * Copied from live responses rather than invented, so a test passing here
 * means something about production. Where the shape drifts, the end-to-end
 * scripts catch it — these keep the component behaviour honest in between.
 */
import type { WarehouseOption, WarehouseOptionsResponse } from '@/lib/fulfilment';
import type { Cart, CartLine, Money, Product } from '@/lib/types';

export function money(minor: string, currency = 'INR'): Money {
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).padStart(3, '0');
  const formatted = `${digits.slice(0, -2)}.${digits.slice(-2)}`;

  return { minor, formatted: `${negative ? '-' : ''}${formatted}`, currency };
}

export function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'product-1',
    name: 'Hex Bolt M12 x 60mm',
    slug: 'hex-bolt-m12-x-60mm',
    sku: 'HEX-M12-60',
    shortDescription: 'Grade 8.8 zinc-plated hex bolt.',
    description: null,
    descriptionHtml: null,
    price: money('4550'),
    compareAtPrice: null,
    tax: {
      code: 'GST18',
      name: 'GST 18%',
      ratePercent: '18',
      inclusive: false,
      country: null,
      treatment: 'FLAT_RATE',
    },
    purchaseRules: {
      minOrderQty: 10,
      maxOrderQty: null,
      qtyIncrement: 5,
      isRecurringEligible: true,
    },
    category: { id: 'cat-1', name: 'Industrial Fasteners', slug: 'industrial-fasteners' },
    isStockTracked: true,
    hasVariants: false,
    publishedAt: '2026-09-02T15:15:59.095Z',
    primaryImage: null,
    images: [],
    attributes: [],
    variants: [],
    ...overrides,
  };
}

export function makeCartLine(overrides: Partial<CartLine> = {}): CartLine {
  return {
    itemId: 'line-1',
    productId: 'product-1',
    variantId: null,
    name: 'Hex Bolt M12 x 60mm',
    variantName: null,
    slug: 'hex-bolt-m12-x-60mm',
    sku: 'HEX-M12-60',
    imageUrl: null,
    quantity: 10,
    unitPrice: money('4550'),
    lineSubtotal: money('45500'),
    discount: money('0'),
    taxAmount: money('8190'),
    lineTotal: money('53690'),
    taxRatePercent: '18',
    taxInclusive: false,
    availableQty: 500,
    isRecurringEligible: true,
    purchaseRules: { minOrderQty: 10, maxOrderQty: null, qtyIncrement: 5 },
    issues: [],
    ...overrides,
  };
}

export function makeCart(overrides: Partial<Cart> = {}): Cart {
  const lines = overrides.lines ?? [makeCartLine()];

  return {
    cartId: 'cart-1',
    currency: 'INR',
    lines,
    coupon: null,
    availableCoupons: [],
    totals: {
      subtotal: money('45500'),
      discount: money('0'),
      tax: money('8190'),
      shipping: money('0'),
      grandTotal: money('53690'),
    },
    checkoutReady: true,
    blockingIssues: [],
    requiresApproval: false,
    approvalReason: null,
    itemCount: lines.reduce((total, line) => total + line.quantity, 0),
    ...overrides,
  };
}

/**
 * One warehouse's offer, as `POST /fulfilment/warehouse-options` returns it.
 *
 * The badges and the totals are fields rather than anything derived, which is
 * the same rule the storefront follows: the server decides which option is
 * fastest, cheapest and recommended, so a fixture that computed them would be
 * testing an implementation the application does not have.
 */
export function makeWarehouseOption(overrides: Partial<WarehouseOption> = {}): WarehouseOption {
  return {
    quoteId: 'quote-pune-000000000000000',
    // Far enough out that a test never races the expiry timer.
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    warehouse: {
      id: 'wh-pune',
      code: 'PNQ',
      name: 'Pune Fulfilment Centre',
      countryCode: 'IN',
      countryName: 'India',
      city: 'Pune',
      operationalStatus: 'OPERATIONAL',
    },
    distanceKm: 12,
    lines: [
      {
        productId: 'product-1',
        variantId: null,
        productName: 'Hex Bolt M12 x 60mm',
        sku: 'HEX-M12-60',
        quantity: 10,
        availableQty: 500,
        isStockTracked: true,
        isFulfillable: true,
      },
    ],
    carrier: { name: 'Delhivery', serviceLevel: 'Express' },
    handlingDays: 1,
    usesBusinessDays: true,
    transitDays: { min: 2, max: 4 },
    dispatchDate: '2026-09-14',
    deliveryFromDate: '2026-09-16',
    deliveryToDate: '2026-09-18',
    meetsRequestedDate: null,
    currency: 'INR',
    totals: {
      subtotal: money('45500'),
      discount: money('0'),
      tax: money('8190'),
      shipping: money('12500'),
      grandTotal: money('66190'),
    },
    isFastest: true,
    isCheapest: false,
    isRecommended: true,
    ...overrides,
  };
}

/**
 * A whole answer.
 *
 * Defaults to the empty one — no options, nothing refused, nothing restricted
 * — because that is what a deployment quoting no delivery zones returns, and
 * it is the shape every test that is not about this feature wants.
 */
export function makeWarehouseOptions(
  overrides: Partial<WarehouseOptionsResponse> = {},
): WarehouseOptionsResponse {
  return {
    destination: {
      countryCode: 'IN',
      countryName: 'India',
      postalCode: '411019',
      addressId: 'addr-1',
    },
    isEstimate: false,
    currency: 'INR',
    options: [],
    ineligible: [],
    restrictedLines: [],
    earliestDeliveryDate: null,
    quoteTtlSeconds: 900,
    computedAt: '2026-09-11T09:00:00.000Z',
    ...overrides,
  };
}
