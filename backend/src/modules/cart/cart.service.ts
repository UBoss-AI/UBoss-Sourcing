/**
 * Cart.
 *
 * The cart stores product ids and quantities. It stores no prices.
 *
 * That is the whole design: every read reprices from the current catalog rows,
 * so a price change is picked up automatically and a client cannot influence
 * what anything costs. The browser is told the result; it never supplies it.
 *
 * `loadCart` revalidates publication, price, stock and purchasing limits on
 * every call, and returns per-line issues rather than failing outright - a
 * customer with one unavailable line out of forty needs to see which one.
 */
import {
  ErrorCode,
  badRequest,
  conflict,
  notFound,
  type ErrorCodeValue,
} from '../../domain/errors.js';
import { serialiseMoney, type Minor } from '../../domain/money.js';
import {
  priceLines,
  type PricingLineInput,
  type PricingResult,
} from '../../domain/pricing.js';
import { newId, variantKeyOf } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { publicProductWhere } from '../catalog/catalog.visibility.js';
import { loadPricesForCurrency, priceKey } from '../catalog/price.service.js';
import {
  evaluateCoupon,
  findCouponByCode,
  findCouponById,
  listPublicCoupons,
  type CouponEvaluation,
  type CouponRejection,
} from '../coupons/coupon.service.js';
import { checkPurchasingLimits, type LimitCheckResult } from '../customers/limits.service.js';
import { getAvailabilityMap } from '../inventory/inventory.service.js';
import { resolveCurrencyFor } from '../settings/currency.service.js';

/** Abandoned carts are swept after this long. */
const CART_TTL_DAYS = 30;

export interface CartLineIssue {
  code: string;
  message: string;
  meta?: Record<string, string | number | boolean | null>;
}

export interface CartLine {
  itemId: string;
  productId: string;
  variantId: string | null;
  name: string;
  sku: string;
  slug: string;
  imageUrl: string | null;
  quantity: number;
  unitPrice: ReturnType<typeof serialiseMoney>;
  lineSubtotal: ReturnType<typeof serialiseMoney>;
  /** This line's share of any coupon discount. Zero when none applies. */
  discount: ReturnType<typeof serialiseMoney>;
  taxAmount: ReturnType<typeof serialiseMoney>;
  lineTotal: ReturnType<typeof serialiseMoney>;
  taxRatePercent: string;
  taxInclusive: boolean;
  availableQty: number | null;
  isRecurringEligible: boolean;
  purchaseRules: { minOrderQty: number; maxOrderQty: number | null; qtyIncrement: number };
  /** Non-empty when this line cannot go to checkout as it stands. */
  issues: CartLineIssue[];
}

export interface CartView {
  cartId: string;
  currency: string;
  lines: CartLine[];
  totals: {
    subtotal: ReturnType<typeof serialiseMoney>;
    discount: ReturnType<typeof serialiseMoney>;
    tax: ReturnType<typeof serialiseMoney>;
    shipping: ReturnType<typeof serialiseMoney>;
    grandTotal: ReturnType<typeof serialiseMoney>;
  };
  /** The coupon in force, or why the one on the cart no longer applies. */
  coupon: AppliedCouponView | null;
  /** Live, publicly listed coupons for this currency - the "view coupons" list. */
  availableCoupons: OfferedCouponView[];
  /** True when nothing blocks checkout. */
  checkoutReady: boolean;
  blockingIssues: CartLineIssue[];
  requiresApproval: boolean;
  approvalReason: string | null;
  itemCount: number;
}

export interface AppliedCouponView {
  code: string;
  name: string;
  description: string | null;
  discountPercent: string;
  discount: ReturnType<typeof serialiseMoney>;
  /** Set when the cart still carries the coupon but it no longer qualifies. */
  rejection: CouponRejection | null;
}

export interface OfferedCouponView {
  code: string;
  name: string;
  description: string | null;
  discountPercent: string;
  /** Qualifying cart value in the currency being quoted. */
  minOrder: ReturnType<typeof serialiseMoney>;
  /** True when the cart already clears the threshold and has eligible lines. */
  eligibleNow: boolean;
}

/** A priced cart plus everything checkout needs, without re-querying. */
export interface ResolvedCart {
  cartId: string;
  currency: string;
  pricing: PricingResult;
  lines: CartLine[];
  limits: LimitCheckResult;
  /** Catalog rows as loaded, so checkout snapshots exactly what was priced. */
  sourceItems: {
    itemId: string;
    productId: string;
    variantId: string | null;
    quantity: number;
    isStockTracked: boolean;
  }[];
  blockingIssues: CartLineIssue[];
  /** Category of each priced line, positionally aligned with `pricing.lines`. */
  lineCategoryIds: string[];
  /** The coupon actually priced into `pricing`, for checkout to record. */
  appliedCoupon: CouponEvaluation | null;
  couponRejection: CouponRejection | null;
  availableCoupons: OfferedCouponView[];
}

/**
 * The currency this shopper is quoted in.
 *
 * Their own preference wins, then their country's default, then the base
 * currency - see `settings/currency.service`. The cart's stored currency
 * follows this rather than the other way round, so changing the preference
 * reprices an open cart instead of stranding it in a currency the shopper is
 * no longer browsing in.
 */
async function resolveCurrency(customerProfileId: string): Promise<string> {
  return resolveCurrencyFor(customerProfileId);
}

/** Fetch or create the customer's active cart. */
export async function getOrCreateCart(customerProfileId: string): Promise<string> {
  const currency = await resolveCurrency(customerProfileId);

  const existing = await prisma.cart.findFirst({
    where: { customerProfileId, status: 'ACTIVE' },
    select: { id: true, currency: true, appliedCouponId: true },
    orderBy: { createdAt: 'desc' },
  });

  if (existing !== null) {
    // The shopper switched currency while this cart was open. Restamp it, and
    // drop the coupon: its qualifying amount is set per currency and may not
    // exist in the new one at all.
    if (existing.currency !== currency) {
      await prisma.cart.update({
        where: { id: existing.id },
        data: { currency, appliedCouponId: null },
      });
    }
    return existing.id;
  }

  const id = newId();
  await prisma.cart.create({
    data: {
      id,
      customerProfileId,
      status: 'ACTIVE',
      currency,
      expiresAt: new Date(Date.now() + CART_TTL_DAYS * 86_400_000),
    },
  });

  return id;
}

/**
 * Load, reprice and revalidate a cart.
 *
 * Everything the customer is shown comes from here, and checkout calls the same
 * function - so the totals at review and the totals charged cannot diverge.
 */
export async function resolveCart(
  customerProfileId: string,
  options: { shippingMethodCode?: string | null } = {},
): Promise<ResolvedCart> {
  const cartId = await getOrCreateCart(customerProfileId);
  const currency = await resolveCurrency(customerProfileId);

  const items = await prisma.cartItem.findMany({
    where: { cartId },
    orderBy: { createdAt: 'asc' },
    include: {
      product: {
        include: {
          taxClass: { select: { code: true, ratePercent: true, isInclusive: true } },
          category: { select: { isActive: true, archivedAt: true } },
          media: {
            orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
            take: 1,
            select: { media: { select: { url: true } } },
          },
        },
      },
      variant: true,
    },
  });

  const availability = await getAvailabilityMap(
    items.map((item) => ({ productId: item.productId, variantId: item.variantId })),
  );

  // Prices come from `product_prices` for the currency being quoted. A SKU with
  // no row for it is not sellable in this market - never substituted from
  // another currency, which would charge a wildly wrong amount.
  const prices = await loadPricesForCurrency(
    items.map((item) => ({ productId: item.productId, variantId: item.variantId })),
    currency,
  );

  const pricingInputs: PricingLineInput[] = [];
  const lineMeta: {
    itemId: string;
    productId: string;
    variantId: string | null;
    quantity: number;
    isStockTracked: boolean;
    slug: string;
    imageUrl: string | null;
    availableQty: number | null;
    issues: CartLineIssue[];
  }[] = [];

  for (const item of items) {
    const product = item.product;
    const issues: CartLineIssue[] = [];

    // Publication is re-checked here, not just at add time: a product can be
    // unpublished while it sits in somebody's cart.
    const isPubliclyVisible =
      product.status === 'ACTIVE' &&
      product.isPublished &&
      product.archivedAt === null &&
      product.category.isActive &&
      product.category.archivedAt === null;

    if (!isPubliclyVisible) {
      issues.push({
        code: ErrorCode.CART_ITEM_UNAVAILABLE,
        message: `${product.name} is no longer available.`,
        meta: { productId: product.id },
      });
    }

    if (item.variantId !== null) {
      const variant = item.variant;
      if (variant === null || !variant.isActive || variant.archivedAt !== null) {
        issues.push({
          code: ErrorCode.CART_ITEM_UNAVAILABLE,
          message: `The selected option for ${product.name} is no longer available.`,
          meta: { productId: product.id, variantId: item.variantId },
        });
      }
    }

    const availableQty = product.isStockTracked
      ? (availability.get(`${item.productId}:${item.variantKey}`) ?? 0)
      : null;

    if (availableQty !== null && availableQty < item.quantity) {
      issues.push({
        code: ErrorCode.INSUFFICIENT_STOCK,
        message:
          availableQty === 0
            ? `${product.name} is out of stock.`
            : `Only ${String(availableQty)} of ${product.name} remain.`,
        meta: { productId: product.id, available: availableQty, requested: item.quantity },
      });
    }

    // Priced from the CURRENT catalogue rows. The cart stores no price of its own.
    const price = prices.get(priceKey(item.productId, item.variantId));

    if (price === undefined) {
      issues.push({
        code: ErrorCode.PRICE_UNAVAILABLE_IN_CURRENCY,
        message: `${product.name} is not sold in ${currency}.`,
        meta: { productId: product.id, currency },
      });
    }

    const unitPriceMinor: Minor = price?.basePriceMinor ?? 0n;

    pricingInputs.push({
      product: {
        productId: product.id,
        variantId: item.variantId,
        name: product.name,
        sku: item.variant?.sku ?? product.sku,
        variantName: item.variant?.name ?? null,
        unitPriceMinor,
        taxClassCode: product.taxClass.code,
        taxRatePercent: product.taxClass.ratePercent.toString(),
        taxInclusive: product.taxClass.isInclusive,
        isRecurringEligible: product.isRecurringEligible,
        imageUrl: product.media[0]?.media.url ?? null,
      },
      quantity: item.quantity,
    });

    lineMeta.push({
      itemId: item.id,
      productId: product.id,
      variantId: item.variantId,
      quantity: item.quantity,
      isStockTracked: product.isStockTracked,
      slug: product.slug,
      imageUrl: product.media[0]?.media.url ?? null,
      availableQty,
      issues,
    });
  }

  // The coupon divides up amounts the catalogue already decided; it never
  // influences a price. Evaluate against line subtotals, then feed the shares
  // back in as per-line discounts so tax is charged on the discounted amount.
  const couponLines = pricingInputs.map((input, index) => ({
    index,
    productId: input.product.productId,
    categoryId: items[index]?.product.categoryId ?? '',
    lineSubtotalMinor: input.product.unitPriceMinor * BigInt(input.quantity),
  }));
  const subtotalMinor = couponLines.reduce((total, line) => total + line.lineSubtotalMinor, 0n);

  const cartRow = await prisma.cart.findUnique({
    where: { id: cartId },
    select: { appliedCouponId: true },
  });

  let appliedCoupon: CouponEvaluation | null = null;
  let couponRejection: CouponRejection | null = null;

  if (cartRow !== null && cartRow.appliedCouponId !== null) {
    const coupon = await findCouponById(cartRow.appliedCouponId);

    if (coupon === null) {
      await prisma.cart.update({ where: { id: cartId }, data: { appliedCouponId: null } });
    } else {
      const outcome = await evaluateCoupon({
        coupon,
        lines: couponLines,
        currency,
        subtotalMinor,
        customerProfileId,
      });

      if (outcome.ok) {
        appliedCoupon = outcome.evaluation;
        for (const [index, share] of outcome.evaluation.perLineMinor) {
          const target = pricingInputs[index];
          if (target !== undefined) target.discountMinor = share;
        }
      } else {
        // Kept on the cart so the shopper is told why it stopped working,
        // rather than it vanishing without explanation.
        couponRejection = { ...outcome.rejection, meta: { ...outcome.rejection.meta, code: coupon.code } };
      }
    }
  }

  const availableCoupons = await buildOfferedCoupons({
    currency,
    lines: couponLines,
    subtotalMinor,
    customerProfileId,
    excludeCouponId: appliedCoupon?.couponId ?? null,
  });

  const shipping = await resolveShipping(options.shippingMethodCode);
  const pricing = priceLines(pricingInputs, shipping === null ? {} : { shipping });

  // Purchasing limits, using the freshly computed total.
  const limits = await checkPurchasingLimits({
    customerProfileId,
    lines: items.map((item, index) => ({
      productId: item.productId,
      variantId: item.variantId,
      productName: item.product.name,
      quantity: item.quantity,
      rules: {
        minOrderQty: item.product.minOrderQty,
        maxOrderQty: item.product.maxOrderQty,
        qtyIncrement: item.product.qtyIncrement,
      },
      _index: index,
    })),
    grandTotalMinor: pricing.totals.grandTotalMinor,
    currency,
  });

  // Attach limit violations to the lines they belong to, so the UI can show
  // them inline instead of as a detached banner.
  for (const violation of limits.violations) {
    const match = /^items\.(\d+)\./.exec(violation.field ?? '');
    const index = match?.[1] === undefined ? null : Number(match[1]);

    if (index !== null && lineMeta[index] !== undefined) {
      lineMeta[index].issues.push({
        code: violation.code ?? ErrorCode.VALIDATION_FAILED,
        message: violation.message ?? 'This line does not meet the purchasing rules.',
        ...(violation.meta !== undefined ? { meta: violation.meta } : {}),
      });
    }
  }

  const lines: CartLine[] = lineMeta.map((meta, index) => {
    const priced = pricing.lines[index];
    const source = pricingInputs[index];

    return {
      itemId: meta.itemId,
      productId: meta.productId,
      variantId: meta.variantId,
      name: priced?.nameSnapshot ?? '',
      sku: priced?.skuSnapshot ?? '',
      slug: meta.slug,
      imageUrl: meta.imageUrl,
      quantity: meta.quantity,
      unitPrice: serialiseMoney(priced?.unitPriceMinor ?? 0n, currency),
      lineSubtotal: serialiseMoney(priced?.lineSubtotalMinor ?? 0n, currency),
      discount: serialiseMoney(priced?.discountMinor ?? 0n, currency),
      taxAmount: serialiseMoney(priced?.taxAmountMinor ?? 0n, currency),
      lineTotal: serialiseMoney(priced?.lineTotalMinor ?? 0n, currency),
      taxRatePercent: priced?.taxRatePercent ?? '0',
      taxInclusive: priced?.taxInclusive ?? false,
      availableQty: meta.availableQty,
      isRecurringEligible: source?.product.isRecurringEligible ?? false,
      purchaseRules: {
        minOrderQty: items[index]?.product.minOrderQty ?? 1,
        maxOrderQty: items[index]?.product.maxOrderQty ?? null,
        qtyIncrement: items[index]?.product.qtyIncrement ?? 1,
      },
      issues: meta.issues,
    };
  });

  // Order-level violations (value limits, spend cap) are not attached to a line.
  const blockingIssues: CartLineIssue[] = limits.violations
    .filter((violation) => !(violation.field ?? '').startsWith('items.'))
    .map((violation) => ({
      code: violation.code ?? ErrorCode.VALIDATION_FAILED,
      message: violation.message ?? 'This order does not meet the purchasing rules.',
      ...(violation.meta !== undefined ? { meta: violation.meta } : {}),
    }));

  return {
    cartId,
    currency,
    pricing,
    lines,
    limits,
    sourceItems: lineMeta.map((meta) => ({
      itemId: meta.itemId,
      productId: meta.productId,
      variantId: meta.variantId,
      quantity: meta.quantity,
      isStockTracked: meta.isStockTracked,
    })),
    blockingIssues,
    lineCategoryIds: couponLines.map((line) => line.categoryId),
    appliedCoupon,
    couponRejection,
    availableCoupons,
  };
}

async function resolveShipping(
  code: string | null | undefined,
): Promise<{ priceMinor: Minor; freeAboveMinor: Minor | null } | null> {
  if (code === null || code === undefined) return null;

  const method = await prisma.shippingMethod.findFirst({
    where: { code, isActive: true },
    select: { priceMinor: true, freeAboveMinor: true },
  });

  if (method === null) {
    throw badRequest(
      ErrorCode.SHIPPING_METHOD_UNAVAILABLE,
      'That delivery method is not available.',
      [{ field: 'shippingMethodCode', code: 'NOT_FOUND' }],
    );
  }

  return { priceMinor: method.priceMinor, freeAboveMinor: method.freeAboveMinor };
}

/** Present a resolved cart for the wire. */
export function toCartView(resolved: ResolvedCart): CartView {
  const { totals } = resolved.pricing;

  const hasLineIssue = resolved.lines.some((line) => line.issues.length > 0);
  const isEmpty = resolved.lines.length === 0;

  return {
    cartId: resolved.cartId,
    currency: resolved.currency,
    lines: resolved.lines,
    totals: {
      subtotal: serialiseMoney(totals.subtotalMinor, resolved.currency),
      discount: serialiseMoney(totals.discountMinor, resolved.currency),
      tax: serialiseMoney(totals.taxMinor, resolved.currency),
      shipping: serialiseMoney(totals.shippingMinor, resolved.currency),
      grandTotal: serialiseMoney(totals.grandTotalMinor, resolved.currency),
    },
    coupon: toAppliedCouponView(resolved),
    availableCoupons: resolved.availableCoupons,
    checkoutReady: !isEmpty && !hasLineIssue && resolved.blockingIssues.length === 0,
    blockingIssues: resolved.blockingIssues,
    requiresApproval: resolved.limits.requiresApproval,
    approvalReason: resolved.limits.approvalReason,
    itemCount: resolved.lines.reduce((total, line) => total + line.quantity, 0),
  };
}

function toAppliedCouponView(resolved: ResolvedCart): AppliedCouponView | null {
  if (resolved.appliedCoupon !== null) {
    const applied = resolved.appliedCoupon;
    return {
      code: applied.code,
      name: applied.name,
      description: applied.description,
      discountPercent: applied.discountPercent,
      discount: serialiseMoney(applied.discountMinor, resolved.currency),
      rejection: null,
    };
  }

  if (resolved.couponRejection !== null) {
    const code = resolved.couponRejection.meta?.code;
    return {
      code: typeof code === 'string' ? code : '',
      name: '',
      description: null,
      discountPercent: '0',
      discount: serialiseMoney(0n, resolved.currency),
      rejection: resolved.couponRejection,
    };
  }

  return null;
}

/**
 * The "we have coupons" list.
 *
 * Each entry is evaluated against the current cart so the storefront can show
 * which ones are already usable and which still need a bigger basket, rather
 * than advertising codes that will be refused on entry.
 */
async function buildOfferedCoupons(input: {
  currency: string;
  lines: readonly { index: number; productId: string; categoryId: string; lineSubtotalMinor: Minor }[];
  subtotalMinor: Minor;
  customerProfileId: string | null;
  excludeCouponId: string | null;
}): Promise<OfferedCouponView[]> {
  const coupons = await listPublicCoupons(input.currency);
  const views: OfferedCouponView[] = [];

  for (const coupon of coupons) {
    if (coupon.id === input.excludeCouponId) continue;

    const minimum = coupon.minimums.find((row) => row.currencyCode === input.currency);
    if (minimum === undefined) continue;

    const outcome = await evaluateCoupon({
      coupon,
      lines: input.lines,
      currency: input.currency,
      subtotalMinor: input.subtotalMinor,
      customerProfileId: input.customerProfileId,
    });

    views.push({
      code: coupon.code,
      name: coupon.name,
      description: coupon.description,
      discountPercent: coupon.discountPercent.toString(),
      minOrder: serialiseMoney(minimum.minOrderMinor, input.currency),
      eligibleNow: outcome.ok,
    });
  }

  return views;
}

/**
 * Put a coupon on the cart.
 *
 * Validated here so a bad code is rejected at the point of entry with a reason,
 * then re-validated on every `resolveCart` - a coupon can expire, be switched
 * off, or stop qualifying while the cart sits open.
 */
export async function applyCoupon(customerProfileId: string, code: string): Promise<void> {
  const cartId = await getOrCreateCart(customerProfileId);
  const currency = await resolveCurrency(customerProfileId);

  const coupon = await findCouponByCode(code);
  if (coupon === null) {
    throw badRequest(ErrorCode.COUPON_NOT_FOUND, 'That coupon code was not recognised.', [
      { field: 'code', code: ErrorCode.COUPON_NOT_FOUND },
    ]);
  }

  // Price the cart as it stands so the code is judged against a real basket.
  const resolved = await resolveCart(customerProfileId);
  const lines = resolved.pricing.lines.map((line, index) => ({
    index,
    productId: line.productId,
    categoryId: resolved.lineCategoryIds[index] ?? '',
    lineSubtotalMinor: line.lineSubtotalMinor,
  }));

  const outcome = await evaluateCoupon({
    coupon,
    lines,
    currency,
    subtotalMinor: resolved.pricing.totals.subtotalMinor,
    customerProfileId,
  });

  if (!outcome.ok) {
    throw badRequest(outcome.rejection.code as ErrorCodeValue, outcome.rejection.message, [
      {
        field: 'code',
        code: outcome.rejection.code,
        ...(outcome.rejection.meta !== undefined ? { meta: outcome.rejection.meta } : {}),
      },
    ]);
  }

  await prisma.cart.update({ where: { id: cartId }, data: { appliedCouponId: coupon.id } });
}

export async function removeCoupon(customerProfileId: string): Promise<void> {
  const cartId = await getOrCreateCart(customerProfileId);
  await prisma.cart.update({ where: { id: cartId }, data: { appliedCouponId: null } });
}

export interface AddItemInput {
  productId: string;
  variantId?: string | null;
  quantity: number;
}

/**
 * Add to cart.
 *
 * The product must be publicly visible right now - checked through
 * `publicProductWhere()` rather than by hand, so an unpublished product cannot
 * be added by posting its id directly.
 */
export async function addItem(
  customerProfileId: string,
  input: AddItemInput,
): Promise<{ itemId: string; quantity: number }> {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Quantity must be a positive whole number.', [
      { field: 'quantity', code: 'INVALID' },
    ]);
  }

  const cartId = await getOrCreateCart(customerProfileId);

  const product = await prisma.product.findFirst({
    where: { ...publicProductWhere(), id: input.productId },
    select: {
      id: true,
      name: true,
      hasVariants: true,
      minOrderQty: true,
      maxOrderQty: true,
      qtyIncrement: true,
    },
  });

  // Covers both "no such product" and "not published". The customer must not be
  // able to tell those apart.
  if (product === null) throw notFound('Product');

  if (input.variantId !== null && input.variantId !== undefined) {
    const variant = await prisma.productVariant.findFirst({
      where: {
        id: input.variantId,
        productId: input.productId,
        isActive: true,
        archivedAt: null,
      },
      select: { id: true },
    });
    if (variant === null) {
      throw badRequest(ErrorCode.VARIANT_MISMATCH, 'That option is not available for this product.', [
        { field: 'variantId', code: 'NOT_FOUND' },
      ]);
    }
  } else if (product.hasVariants) {
    throw badRequest(ErrorCode.VARIANT_MISMATCH, 'Choose an option before adding this to the cart.', [
      { field: 'variantId', code: 'REQUIRED' },
    ]);
  }

  const variantKey = variantKeyOf(input.variantId ?? null);

  // Re-adding the same SKU increases the quantity rather than creating a second
  // line, which is what the unique(cartId, productId, variantKey) index enforces.
  const existing = await prisma.cartItem.findUnique({
    where: { cartId_productId_variantKey: { cartId, productId: input.productId, variantKey } },
  });

  if (existing !== null) {
    const nextQuantity = existing.quantity + input.quantity;
    await prisma.cartItem.update({
      where: { id: existing.id },
      data: { quantity: nextQuantity },
    });
    return { itemId: existing.id, quantity: nextQuantity };
  }

  // A brand-new line starts at the product minimum when the request asks for
  // less - a B2B product with a minimum of 10 should not sit in the cart at 1
  // and fail only at checkout.
  const quantity = Math.max(input.quantity, product.minOrderQty);
  const itemId = newId();

  await prisma.cartItem.create({
    data: {
      id: itemId,
      cartId,
      productId: input.productId,
      variantId: input.variantId ?? null,
      variantKey,
      quantity,
    },
  });

  return { itemId, quantity };
}

export async function updateItemQuantity(
  customerProfileId: string,
  itemId: string,
  quantity: number,
): Promise<void> {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Quantity must be zero or a positive whole number.', [
      { field: 'quantity', code: 'INVALID' },
    ]);
  }

  const cartId = await getOrCreateCart(customerProfileId);

  // Scoped by cartId, so an item id from another customer's cart resolves to
  // "not found" rather than being editable.
  const item = await prisma.cartItem.findFirst({ where: { id: itemId, cartId } });
  if (item === null) throw notFound('Cart item');

  if (quantity === 0) {
    await prisma.cartItem.delete({ where: { id: itemId } });
    return;
  }

  await prisma.cartItem.update({ where: { id: itemId }, data: { quantity } });
}

export async function removeItem(customerProfileId: string, itemId: string): Promise<void> {
  const cartId = await getOrCreateCart(customerProfileId);

  const deleted = await prisma.cartItem.deleteMany({ where: { id: itemId, cartId } });
  if (deleted.count === 0) throw notFound('Cart item');
}

export async function clearCart(customerProfileId: string): Promise<{ removed: number }> {
  const cartId = await getOrCreateCart(customerProfileId);
  const result = await prisma.cartItem.deleteMany({ where: { cartId } });
  return { removed: result.count };
}

/**
 * Mark a cart converted once its order exists.
 *
 * Runs inside the checkout transaction: the cart must not be emptied unless the
 * order actually commits.
 */
export async function markCartConverted(cartId: string, tx: PrismaTransaction): Promise<void> {
  await tx.cart.update({ where: { id: cartId }, data: { status: 'CONVERTED' } });
  await tx.cartItem.deleteMany({ where: { cartId } });
}

/**
 * Assert the cart can proceed to checkout.
 *
 * Called at checkout, where "show the problems and let them continue" is not an
 * option. Cart reads surface the same issues without throwing.
 */
export function assertCheckoutReady(resolved: ResolvedCart): void {
  if (resolved.lines.length === 0) {
    throw badRequest(ErrorCode.CART_EMPTY, 'Your cart is empty.');
  }

  const lineIssues = resolved.lines.flatMap((line, index) =>
    line.issues.map((issue) => ({
      field: `items.${String(index)}`,
      code: issue.code,
      message: issue.message,
      ...(issue.meta !== undefined ? { meta: issue.meta } : {}),
    })),
  );

  const allIssues = [
    ...lineIssues,
    ...resolved.blockingIssues.map((issue) => ({
      field: 'cart',
      code: issue.code,
      message: issue.message,
      ...(issue.meta !== undefined ? { meta: issue.meta } : {}),
    })),
  ];

  if (allIssues.length > 0) {
    throw conflict(
      ErrorCode.CART_ITEM_UNAVAILABLE,
      'Some items need attention before you can check out.',
      allIssues,
    );
  }
}
