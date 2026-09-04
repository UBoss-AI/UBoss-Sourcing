/**
 * API response shapes for the storefront.
 *
 * Hand-written from the backend's routes rather than generated, because the
 * generated OpenAPI for this API describes paths and methods exactly but types
 * most response bodies as `Record<string, unknown>`.
 *
 * The rule when editing: money is always `Money`, never a number. If a field
 * here is typed `number` and it is an amount, that is a bug — a paisa-precise
 * total can exceed `2^53`, which is why it crosses the wire as a string.
 */
import type { Money } from './format';

export type { Money };

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// Storefront configuration
// ---------------------------------------------------------------------------

export interface StorefrontConfig {
  business: {
    displayName: string;
    supportEmail: string | null;
    supportPhone: string | null;
    logo: { url: string; altText: string | null } | null;
    currency: string;
    timezone: string;
    policyLinks: Record<string, string> | null;
  };
  /**
   * The markets this store quotes in.
   *
   * Public, because a first-time visitor is asked where they are before the
   * storefront can price anything, and that question has to render before
   * anybody signs in.
   */
  localisation: {
    currencies: CurrencyOption[];
    countries: CountryOption[];
    baseCurrency: string;
  };
  features: {
    selfRegistration: boolean;
    recurringOrders: boolean;
    /** Whether this deployment has the chat assistant configured. */
    assistant: boolean;
  };
}

export interface CurrencyOption {
  code: string;
  name: string;
  symbol: string;
  /** Minor units per major unit: 2 for INR/USD, 0 for JPY/KRW. */
  exponent: number;
  isBase: boolean;
  /**
   * Whether the catalogue actually sells anything in it. Staff can activate a
   * currency before pricing anything in it; offering that one here would just
   * hand the shopper an empty shop.
   *
   * Optional because a config response cached from before this field existed
   * legitimately lacks it; absent is treated as "offer it" rather than hiding
   * every currency at once.
   */
  hasProducts?: boolean;
}

export interface CountryOption {
  code: string;
  name: string;
  /** What a shopper from here is quoted in unless they choose otherwise. */
  currencyCode: string;
  phonePrefix: string | null;
}

/** The shopper's saved answer to "where are you?". Null until they answer. */
export interface Locale {
  country: string;
  currency: string;
  /** What the browser's geolocation resolved to, when it was allowed. */
  detectedCountry: string | null;
  /** True when geolocation disagreed with the stated country. */
  detectedMismatch: boolean;
  chosenAt: string | null;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  depth: number;
  sortOrder: number;
  isActive: boolean;
  productCount: number;
  children: CategoryNode[];
}

export interface ProductImage {
  url: string;
  altText: string | null;
  width?: number;
  height?: number;
  isPrimary?: boolean;
}

/**
 * Purchasing rules.
 *
 * Shown before Add to Cart, not after. A customer who discovers a minimum of
 * 10 only when the cart rejects them has been wasted twice — the rules are
 * part of the product, so they belong on the product.
 */
export interface PurchaseRules {
  minOrderQty: number;
  maxOrderQty: number | null;
  qtyIncrement: number;
  isRecurringEligible: boolean;
}

export interface ProductVariant {
  id: string;
  sku: string;
  name: string;
  options: Record<string, string>;
  price: Money | null;
  isActive?: boolean;
  availableQty?: number | null;
}

export interface TaxInfo {
  code: string;
  name: string;
  ratePercent: string;
  inclusive: boolean;
}

export interface Product {
  id: string;
  name: string;
  slug: string;
  sku: string;
  shortDescription: string | null;
  description: string | null;
  /** Sanitised server-side against an allowlist. Never rendered raw here. */
  descriptionHtml: string | null;
  price: Money;
  compareAtPrice: Money | null;
  tax: TaxInfo;
  purchaseRules: PurchaseRules;
  category: { id: string; name: string; slug: string } | null;
  isStockTracked: boolean;
  hasVariants: boolean;
  publishedAt: string | null;
  primaryImage: ProductImage | null;
  images: ProductImage[];
  attributes: { name: string; value: string }[];
  variants: ProductVariant[];
  availability?: {
    inStock: boolean;
    availableQty: number | null;
  } | null;
}

export interface ProductListResponse {
  products: Product[];
  pagination: Pagination;
  /** The currency every price in this response is quoted in. */
  currency: string;
}

export interface ProductDetailResponse {
  product: Product;
  currency: string;
  /**
   * Currencies this product IS sold in, when it is not sold in the requested
   * one. Lets the page offer a switch instead of just saying "unavailable".
   */
  soldInCurrencies: string[];
}

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

/**
 * Something preventing checkout.
 *
 * The backend names each one with a code and a human message. The storefront
 * shows the message and uses the code only to decide *where* to show it — it
 * never rewrites the explanation, because the server knows the rule and this
 * code would only paraphrase it wrongly.
 */
export interface CartIssue {
  code: string;
  message: string;
  meta?: Record<string, unknown>;
  itemId?: string;
}

export interface CartLine {
  itemId: string;
  productId: string;
  variantId: string | null;
  name: string;
  slug: string;
  /** The variant's SKU when one is chosen, otherwise the product's. */
  sku: string;
  imageUrl: string | null;
  quantity: number;
  unitPrice: Money;
  lineSubtotal: Money;
  /** This line's share of any coupon discount. Zero when none applies. */
  discount: Money;
  taxAmount: Money;
  lineTotal: Money;
  taxRatePercent: string;
  taxInclusive: boolean;
  /**
   * What the customer could actually have right now.
   *
   * Published on the *cart* but not on the public catalogue: once someone has
   * committed to an item, they need to know whether it can ship, and the
   * number is scoped to their own cart rather than browsable by anyone.
   */
  availableQty: number | null;
  isRecurringEligible: boolean;
  /** The cart's copy carries no recurring flag — that sits on the line. */
  purchaseRules: Omit<PurchaseRules, 'isRecurringEligible'>;
  /** Per-line problems: out of stock, below minimum, no longer published. */
  issues: CartIssue[];
}

export interface CartTotals {
  subtotal: Money;
  discount: Money;
  tax: Money;
  shipping: Money;
  grandTotal: Money;
}

/** The coupon in force, or the one that stopped qualifying and why. */
export interface AppliedCoupon {
  code: string;
  name: string;
  description: string | null;
  discountPercent: string;
  discount: Money;
  rejection: { code: string; message: string; meta?: Record<string, unknown> } | null;
}

/** An advertised coupon, evaluated against the cart as it stands. */
export interface OfferedCoupon {
  code: string;
  name: string;
  description: string | null;
  discountPercent: string;
  minOrder: Money;
  /** True when the cart already clears the threshold and has eligible lines. */
  eligibleNow: boolean;
}

export interface Cart {
  cartId: string;
  currency: string;
  lines: CartLine[];
  totals: CartTotals;
  coupon: AppliedCoupon | null;
  availableCoupons: OfferedCoupon[];
  /** The server's verdict. The checkout button follows this, not a local sum. */
  checkoutReady: boolean;
  blockingIssues: CartIssue[];
  requiresApproval: boolean;
  approvalReason: string | null;
  itemCount: number;
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export interface Address {
  id: string;
  kind: 'BILLING' | 'SHIPPING' | 'BOTH';
  label: string | null;
  contactName: string;
  contactPhone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  isDefaultBilling: boolean;
  isDefaultShipping: boolean;
  archivedAt: string | null;
}

export interface CustomerProfile {
  id: string;
  email: string;
  fullName: string | null;
  organization: string | null;
  department: string | null;
  phone: string | null;
  gstin: string | null;
  consentAcceptedAt: string | null;
  activatedAt: string | null;
  lastLoginAt: string | null;
  orderCount: number;
  scheduleCount: number;
}

export interface AccountResponse {
  profile: CustomerProfile;
  purchasingLimits: {
    perOrderMinMinor: string | null;
    perOrderMaxMinor: string | null;
    requiresOrderApproval: boolean;
    currency: string;
  };
  spend: {
    monthToDateMinor: string;
    capMinor: string | null;
    remainingMinor: string | null;
    currency: string;
  };
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface OrderTotals {
  subtotal: Money;
  discount: Money;
  tax: Money;
  shipping: Money;
  grandTotal: Money;
  paid: Money;
  refunded: Money;
}

export interface OrderListItem {
  id: string;
  orderNumber: string;
  status: string;
  source: string;
  currency: string;
  totals: OrderTotals;
  paymentMode: string | null;
  placedAt: string | null;
  confirmedAt: string | null;
  itemCount: number;
  createdAt: string;
}

export interface OrderItem {
  /** The order line's own id, not the product's. */
  id: string;
  /** What to add back to a cart on reorder. */
  productId: string;
  variantId: string | null;
  /**
   * A snapshot, taken when the order was placed.
   *
   * Not a live lookup: a product renamed or repriced afterwards must not
   * rewrite what somebody already bought.
   */
  name: string;
  sku: string;
  variantName: string | null;
  imageUrl: string | null;
  quantity: number;
  unitPrice: Money;
  lineSubtotal: Money;
  tax: Money;
  lineTotal: Money;
  taxRatePercent: string;
}

export interface OrderTimelineEntry {
  from: string | null;
  to: string;
  reason: string | null;
  at: string;
}

export interface OrderShipment {
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  status: string;
  dispatchedAt: string | null;
  deliveredAt: string | null;
}

export interface OrderApproval {
  decision?: string;
  comment?: string | null;
  decidedAt?: string | null;
}

export interface OrderAddress {
  contactName: string | null;
  contactPhone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postalCode: string;
  country: string;
}

/**
 * An order as its own customer sees it.
 *
 * Deliberately absent, and not to be added:
 *   - `internalNote` — written by staff about the order, not for the customer.
 *   - payment-link tokens — the link lives in the approver's email and nowhere
 *     else. Exposing it through an account API would make emailing it pointless.
 */
export interface OrderDetail extends OrderListItem {
  items: OrderItem[];
  timeline: OrderTimelineEntry[];
  shippingAddress: OrderAddress | null;
  billingAddress: OrderAddress | null;
  shippingMethodName: string | null;
  customerNote: string | null;
  cancelReason: string | null;
  shipments: OrderShipment[];
  approval: OrderApproval | null;
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/** What `POST /payments/orders/:orderId/session` returns. */
export interface PaymentSession {
  paymentTransactionId: string;
  provider: string;
  /**
   * TEST or LIVE, straight from the gateway connection the admin activated.
   * Shown to the customer in TEST mode so nobody mistakes a sandbox run for a
   * real purchase.
   */
  mode: 'TEST' | 'LIVE';
  providerOrderId: string;
  amount: Money;
  /**
   * Everything the provider's hosted UI needs, and nothing else.
   *
   * Carries the *publishable* key only — the key secret never leaves the
   * server, and nothing in here is worth logging.
   */
  checkoutPayload: Record<string, string | number>;
}

/** What `POST /cart/checkout` returns. */
export interface CheckoutResult {
  orderId: string;
  orderNumber: string;
  status: string;
  currency: string;
  totals: CartTotals;
  requiresApproval: boolean;
  paymentMode: 'ONLINE' | 'PAYMENT_LINK';
  /**
   * True when this exact idempotency key had already been used.
   *
   * Lets the page say "your order was already placed" rather than "your order
   * was placed" — without creating a second one either way.
   */
  replayed?: boolean;
}

/**
 * The order's payment state, as the *backend* understands it.
 *
 * `paid` becomes true only when a signature-verified provider event has been
 * applied. A client redirect saying "success" proves nothing — the browser is
 * not a trusted reporter of whether money moved.
 */
export interface PaymentStatus {
  status: string;
  paid: boolean;
  orderStatus: string;
}

// ---------------------------------------------------------------------------
// Recurring schedules
// ---------------------------------------------------------------------------

export interface ScheduleItem {
  productId: string;
  variantId: string | null;
  quantity: number;
  name?: string;
  sku?: string;
}

/**
 * What `POST /recurring-schedules` returns.
 *
 * An acknowledgement, not the whole schedule — the full record is read back
 * from the detail route, which is where the customer is sent next anyway.
 */
export interface ScheduleCreated {
  scheduleId: string;
  name: string;
  /** The server's own description of the recurrence, for an instant summary. */
  summary: string;
  nextRunAt: string | null;
  paymentMode: string;
}

export interface Schedule {
  id: string;
  name: string;
  status: string;
  /** The server's own description of the recurrence. Never rebuilt here. */
  summary: string;
  frequency: string;
  intervalDays: number | null;
  weekday: number | null;
  monthDay: number | null;
  timezone: string;
  runAtMinute: number;
  startDate: string;
  endDate: string | null;
  maxOccurrences: number | null;
  occurrenceCount: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  paymentMode: string;
  payerEmail: string | null;
  hasMandate: boolean;
  consentAcceptedAt: string | null;
  failureCount: number;
  maxFailures: number;
  pausedReason: string | null;
  cancelReason: string | null;
  itemCount: number;
  items?: ScheduleItem[];
  occurrences?: {
    id: string;
    scheduledFor: string;
    status: string;
    orderId: string | null;
    orderNumber: string | null;
    failureReason: string | null;
  }[];
}
