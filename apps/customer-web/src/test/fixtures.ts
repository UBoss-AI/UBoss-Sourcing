/**
 * Response fixtures, shaped exactly as the real API replies.
 *
 * Copied from live responses rather than invented, so a test passing here
 * means something about production. Where the shape drifts, the end-to-end
 * scripts catch it — these keep the component behaviour honest in between.
 */
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
    tax: { code: 'GST18', name: 'GST 18%', ratePercent: '18', inclusive: false },
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
