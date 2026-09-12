/**
 * Pricing and revalidating a scheduled basket.
 *
 * One function, two callers, and that is the whole point of the file. The
 * review screen the customer confirms and the worker that charges them weeks
 * later both go through `quoteSchedule`, so the number they agreed to and the
 * number they are charged are produced by the same code. Two separate
 * implementations of "what does this basket cost" is how a customer ends up
 * disputing a total that neither screen can explain.
 *
 * It reprices from scratch every time, deliberately. Nothing about a
 * fortnight-old plan may be assumed still true: prices move, products get
 * withdrawn, tax rates change on the first of the month, a coupon expires, the
 * customer's country changes their VAT treatment, stock runs out. The stored
 * snapshot on the plan is evidence of what was agreed - it is never an input
 * to what is charged.
 *
 * It is also priced through exactly the path a cart is priced through:
 * `loadPricesForCurrency` for the customer's own currency, `loadTaxContext`
 * against the delivery address's country, `applyLineTax` per line,
 * `priceLines` for the totals. That matters more than it sounds. The previous
 * engine priced from `Product.basePriceMinor` and the deployment's default
 * currency, which meant a Belgian customer on a monthly plan was charged the
 * base-currency figure with the wrong VAT - correct for the deployment this
 * software was first written for, and wrong for every customer it was then
 * sold into Europe to serve.
 *
 * Nothing here writes to the database and nothing here charges anybody. It
 * answers a question.
 */
import { env } from '../../config/env.js';
import { ErrorCode } from '../../domain/errors.js';
import { serialiseMoney, type Minor } from '../../domain/money.js';
import {
  assertTotalsConsistent,
  priceLines,
  type PricingLineInput,
  type PricingResult,
} from '../../domain/pricing.js';
import { variantKeyOf } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { publicProductWhere } from '../catalog/catalog.visibility.js';
import { isScheduleEligible } from '../catalog/recurring-eligibility.js';
import { loadPricesForCurrency } from '../catalog/price.service.js';
import { checkPurchasingLimits } from '../customers/limits.service.js';
import { verifyErpStock, isErpConfigured } from '../integrations/erp-order.service.js';
import { getAvailabilityMap } from '../inventory/inventory.service.js';
import { resolveCurrencyFor } from '../settings/currency.service.js';
import { applyLineTax, loadTaxContext } from '../tax/vat.service.js';

/**
 * How seriously a problem should be taken.
 *
 * The distinction drives real behaviour, so it is a type rather than a
 * convention:
 *
 *   BLOCK - permanent as far as this plan is concerned. A person has to change
 *           something. On the review screen it is a refusal; at run time it
 *           pauses the plan.
 *   HOLD  - the plan is fine but THIS occurrence cannot run. The engine holds
 *           it, tells the customer, and tries again next cycle. Nothing is
 *           charged and the subscription is not cancelled.
 *   WARN  - worth showing the customer, but nothing stops.
 *
 * The line between the first two is the one that matters most at run time. A
 * product **withdrawn from sale** - unpublished, archived, or opted out of
 * recurring by an administrator - is permanent: holding the occurrence and
 * trying again next week means emailing the customer about it every week for
 * ever, so the plan pauses and somebody is asked to look. A product **out of
 * stock** is transient: this delivery cannot go, next month it probably can,
 * and the subscription keeps running.
 *
 * Getting those two the wrong way round fails in both directions - pausing a
 * subscription over one short week loses a customer, and holding for ever on a
 * discontinued product means nobody ever finds out.
 */
export type QuoteSeverity = 'BLOCK' | 'HOLD' | 'WARN';

export interface QuoteProblem {
  severity: QuoteSeverity;
  code: string;
  message: string;
  productId?: string;
  meta?: Record<string, string | number | boolean | null>;
}

export interface QuoteLine {
  productId: string;
  variantId: string | null;
  name: string;
  sku: string;
  variantName: string | null;
  imageUrl: string | null;
  quantity: number;
  unitPrice: ReturnType<typeof serialiseMoney>;
  lineSubtotal: ReturnType<typeof serialiseMoney>;
  discount: ReturnType<typeof serialiseMoney>;
  taxAmount: ReturnType<typeof serialiseMoney>;
  lineTotal: ReturnType<typeof serialiseMoney>;
  taxRatePercent: string;
  taxInclusive: boolean;
  availableQty: number | null;
  /**
   * How the customer counts this line, off the plan's own snapshot.
   *
   * A substituted line keeps the ordering of the line it stands in for: what
   * was agreed was a number of pieces, and the stand-in delivers that number
   * however its own boxes happen to be sized.
   */
  ordering: { unit: 'PIECE' | 'INNER_PACK' | 'OUTER_CARTON'; unitQuantity: number; piecesPerUnit: number };
  /** Set when this line is being filled by the customer's saved substitute. */
  substitutedFor: { productId: string; name: string } | null;
}

export interface ScheduleQuote {
  currency: string;
  lines: QuoteLine[];
  totals: {
    subtotal: ReturnType<typeof serialiseMoney>;
    discount: ReturnType<typeof serialiseMoney>;
    tax: ReturnType<typeof serialiseMoney>;
    shipping: ReturnType<typeof serialiseMoney>;
    grandTotal: ReturnType<typeof serialiseMoney>;
  };
  shippingMethod: { code: string; name: string } | null;
  problems: QuoteProblem[];
  /** True when nothing at BLOCK or HOLD severity stands in the way. */
  ok: boolean;
  /** The raw result, for callers that go on to write an order. */
  pricing: PricingResult;
  /** Positionally aligned with `pricing.lines`, for stock reservation. */
  sourceItems: {
    productId: string;
    variantId: string | null;
    quantity: number;
    isStockTracked: boolean;
  }[];
}

export interface QuoteItemInput {
  productId: string;
  variantId?: string | null;
  /** Pieces. The only figure this module prices. */
  quantity: number;
  /**
   * The unit the plan was agreed in, carried through so the quote can show it
   * back.
   *
   * Priced on `quantity` regardless - these three change nothing about the
   * arithmetic. They exist so a plan the customer set up as "3 cartons a month"
   * reads as three cartons on every screen and in the consent snapshot, rather
   * than as the six thousand pieces it works out to.
   */
  orderingUnit?: 'PIECE' | 'INNER_PACK' | 'OUTER_CARTON' | null;
  unitQuantity?: number | null;
  piecesPerUnitSnapshot?: number | null;
  /** The customer's saved stand-in for this line, when they named one. */
  substituteProductId?: string | null;
  substituteVariantId?: string | null;
}

export interface QuoteScheduleInput {
  customerProfileId: string;
  items: QuoteItemInput[];
  shippingAddressId: string;
  shippingMethodCode?: string | null;
  /** NEVER means an unavailable line holds the occurrence. See the enum. */
  substitutionPolicy?: 'NEVER' | 'SAVED_PREFERENCE';
  /** Fixed warehouse, when the plan names one. */
  inventoryLocationId?: string | null;
  /**
   * Ask the ERP to confirm supply as well as the platform's own stock.
   *
   * On at every occurrence, off on the review screen: a customer configuring a
   * plan should not wait on a third-party round trip, and the answer would be
   * stale by the time it mattered anyway.
   */
  checkErpStock?: boolean;
}

/**
 * Price and revalidate a scheduled basket.
 *
 * Returns problems rather than throwing. The engine has to distinguish "cannot
 * run this cycle" from "this plan is broken" and act differently on each, and
 * an exception collapses that distinction into one outcome.
 */
export async function quoteSchedule(input: QuoteScheduleInput): Promise<ScheduleQuote> {
  const problems: QuoteProblem[] = [];

  const currency = await resolveCurrencyFor(input.customerProfileId);

  // --- The delivery address, which is what tax turns on ------------------
  const address = await prisma.address.findFirst({
    where: {
      id: input.shippingAddressId,
      customerProfileId: input.customerProfileId,
    },
    select: { id: true, country: true, archivedAt: true },
  });

  if (address === null) {
    problems.push({
      severity: 'BLOCK',
      code: ErrorCode.ADDRESS_REQUIRED,
      message: 'The delivery address for this schedule no longer exists.',
    });
  } else if (address.archivedAt !== null) {
    // HOLD rather than BLOCK: the plan is repairable by picking another
    // address, and the customer is told so rather than having it cancelled.
    problems.push({
      severity: 'HOLD',
      code: ErrorCode.ADDRESS_REQUIRED,
      message: 'The delivery address for this schedule has been removed. Please choose another.',
    });
  }

  const taxProfile = await prisma.customerProfile.findUnique({
    where: { id: input.customerProfileId },
    select: { preferredCountry: true, vatNumber: true, vatNumberValid: true },
  });

  // The destination decides the rate. Falls back to the stated country only
  // when there is no usable address, which is already a problem above.
  const taxSetup = await loadTaxContext({
    destinationCountry: address?.country ?? taxProfile?.preferredCountry ?? null,
    vatNumber: taxProfile?.vatNumber ?? null,
    vatNumberValid: taxProfile?.vatNumberValid ?? null,
  });

  // --- Resolve each line, substituting only where authorised -------------
  const resolved = await resolveLines(input, problems);

  if (resolved.length === 0) {
    return emptyQuote(currency, problems, [
      {
        severity: 'HOLD',
        code: ErrorCode.CART_EMPTY,
        message: 'This schedule has no items that can currently be supplied.',
      },
    ]);
  }

  const prices = await loadPricesForCurrency(
    resolved.map((line) => ({ productId: line.productId, variantId: line.variantId })),
    currency,
  );

  const availability = await getAvailabilityMap(
    resolved.map((line) => ({ productId: line.productId, variantId: line.variantId })),
    input.inventoryLocationId ?? undefined,
  );

  const pricingInputs: PricingLineInput[] = [];
  const lineMeta: {
    availableQty: number | null;
    substitutedFor: { productId: string; name: string } | null;
  }[] = [];
  const sourceItems: ScheduleQuote['sourceItems'] = [];

  for (const line of resolved) {
    const price = prices.get(`${line.productId}:${line.variantId ?? ''}`);

    if (price === undefined) {
      // No price row in this customer's currency. Never substituted from
      // another currency's number - that would charge a wildly wrong amount.
      problems.push({
        severity: 'HOLD',
        code: ErrorCode.PRICE_UNAVAILABLE_IN_CURRENCY,
        message: `${line.name} is not currently sold in ${currency}.`,
        productId: line.productId,
      });
      continue;
    }

    const lineTax = applyLineTax(
      taxSetup,
      {
        vatCategory: line.vatCategory,
        flatRatePercent: line.flatRatePercent,
        taxInclusive: line.taxInclusive,
        productName: line.name,
      },
      price.basePriceMinor,
    );

    if (lineTax.problem !== null) {
      // A misconfiguration rather than the customer's fault, but it still
      // holds the line: the alternative is charging a rate nobody chose.
      problems.push({
        severity: 'HOLD',
        code: ErrorCode.PRICE_UNAVAILABLE_IN_CURRENCY,
        message: lineTax.problem,
        productId: line.productId,
      });
    }

    const availableQty = line.isStockTracked
      ? (availability.get(`${line.productId}:${variantKeyOf(line.variantId)}`) ?? 0)
      : null;

    if (availableQty !== null && availableQty < line.quantity) {
      problems.push({
        severity: 'HOLD',
        code: ErrorCode.INSUFFICIENT_STOCK,
        message: `${line.name}: only ${String(availableQty)} of ${String(line.quantity)} in stock.`,
        productId: line.productId,
        meta: { requested: line.quantity, available: availableQty },
      });
    }

    pricingInputs.push({
      product: {
        productId: line.productId,
        variantId: line.variantId,
        name: line.name,
        sku: line.sku,
        variantName: line.variantName,
        unitPriceMinor: lineTax.unitPriceMinor,
        taxClassCode: line.taxClassCode,
        taxRatePercent: lineTax.taxRatePercent,
        taxInclusive: lineTax.taxInclusive,
        isRecurringEligible: line.isRecurringEligible,
        imageUrl: line.imageUrl,
      },
      quantity: line.quantity,
    });

    lineMeta.push({ availableQty, substitutedFor: line.substitutedFor });

    sourceItems.push({
      productId: line.productId,
      variantId: line.variantId,
      quantity: line.quantity,
      isStockTracked: line.isStockTracked,
    });
  }

  if (pricingInputs.length === 0) {
    return emptyQuote(currency, problems, []);
  }

  // --- Delivery ----------------------------------------------------------
  const shipping =
    input.shippingMethodCode === null || input.shippingMethodCode === undefined
      ? null
      : await prisma.shippingMethod.findFirst({
          where: { code: input.shippingMethodCode, isActive: true },
          select: { code: true, name: true, priceMinor: true, freeAboveMinor: true },
        });

  if (
    input.shippingMethodCode !== null &&
    input.shippingMethodCode !== undefined &&
    input.shippingMethodCode.length > 0 &&
    shipping === null
  ) {
    problems.push({
      severity: 'HOLD',
      code: ErrorCode.SHIPPING_METHOD_UNAVAILABLE,
      message: 'The delivery method saved on this schedule is no longer offered.',
    });
  }

  // Coupons are deliberately not applied to a scheduled basket.
  //
  // A coupon is a one-off inducement with a usage limit and an expiry, and
  // silently reapplying one to every delivery for a year is not what either
  // party agreed to. Nor is quietly dropping it at the third occurrence, which
  // is what a usage limit would do - the customer would see the price rise for
  // no stated reason. So the review screen quotes the undiscounted price, and
  // the discount line exists for per-line catalogue discounts only.
  const pricing = priceLines(
    pricingInputs,
    shipping === null
      ? {}
      : { shipping: { priceMinor: shipping.priceMinor, freeAboveMinor: shipping.freeAboveMinor } },
  );

  assertTotalsConsistent(pricing.lines, pricing.totals);

  // --- Purchasing limits -------------------------------------------------
  const limits = await checkPurchasingLimits({
    customerProfileId: input.customerProfileId,
    lines: resolved.map((line) => ({
      productId: line.productId,
      variantId: line.variantId,
      productName: line.name,
      quantity: line.quantity,
      rules: {
        minOrderQty: line.minOrderQty,
        maxOrderQty: line.maxOrderQty,
        qtyIncrement: line.qtyIncrement,
      },
    })),
    grandTotalMinor: pricing.totals.grandTotalMinor,
    currency,
  });

  if (!limits.ok) {
    for (const violation of limits.violations) {
      // `ErrorDetail` leaves both optional, and a violation with neither is
      // still a refusal - so it gets a generic sentence rather than being
      // dropped, which would let an occurrence through on a limit breach.
      problems.push({
        severity: 'HOLD',
        code: violation.code ?? ErrorCode.VALIDATION_FAILED,
        message: violation.message ?? 'This order does not meet your account purchasing rules.',
      });
    }
  }

  // --- The ERP's own view of supply --------------------------------------
  if (input.checkErpStock === true && isErpConfigured()) {
    const erp = await verifyErpStock(
      resolved.map((line) => ({ sku: line.sku, quantity: line.quantity })),
    );

    if (!erp.ok) {
      // Unreachable is reported as its own thing. Telling a customer their
      // product is out of stock when the truth is that our ERP is down is a
      // lie that they will act on.
      problems.push(
        erp.unavailable
          ? {
              severity: 'HOLD',
              code: ErrorCode.ERP_ORDER_PUSH_FAILED,
              message:
                'Stock could not be confirmed with the warehouse system, so this order is on hold.',
            }
          : {
              severity: 'HOLD',
              code: ErrorCode.INSUFFICIENT_STOCK,
              message: erp.message ?? 'The warehouse cannot supply every item on this order.',
              meta: { shortages: erp.shortages.length },
            },
      );
    }
  }

  // Keyed on the SKU the customer put on the plan, so a substituted line finds
  // the ordering of the line it replaced rather than falling back to pieces.
  const orderingByKey = new Map(
    input.items.map((item) => [
      `${item.productId}:${item.variantId ?? ''}`,
      {
        unit: item.orderingUnit ?? ('PIECE' as const),
        unitQuantity: item.unitQuantity ?? item.quantity,
        piecesPerUnit: item.piecesPerUnitSnapshot ?? 1,
      },
    ]),
  );

  const lines: QuoteLine[] = pricing.lines.map((priced, index) => ({
    productId: priced.productId,
    variantId: priced.variantId,
    name: priced.nameSnapshot,
    sku: priced.skuSnapshot,
    variantName: priced.variantNameSnapshot,
    imageUrl: priced.imageUrlSnapshot,
    quantity: priced.quantity,
    unitPrice: serialiseMoney(priced.unitPriceMinor, currency),
    lineSubtotal: serialiseMoney(priced.lineSubtotalMinor, currency),
    discount: serialiseMoney(priced.discountMinor, currency),
    taxAmount: serialiseMoney(priced.taxAmountMinor, currency),
    lineTotal: serialiseMoney(priced.lineTotalMinor, currency),
    taxRatePercent: priced.taxRatePercent,
    taxInclusive: priced.taxInclusive,
    availableQty: lineMeta[index]?.availableQty ?? null,
    ordering:
      orderingByKey.get(
        `${lineMeta[index]?.substitutedFor?.productId ?? priced.productId}:${priced.variantId ?? ''}`,
      ) ??
      orderingByKey.get(`${priced.productId}:${priced.variantId ?? ''}`) ?? {
        unit: 'PIECE' as const,
        unitQuantity: priced.quantity,
        piecesPerUnit: 1,
      },
    substitutedFor: lineMeta[index]?.substitutedFor ?? null,
  }));

  return {
    currency,
    lines,
    totals: {
      subtotal: serialiseMoney(pricing.totals.subtotalMinor, currency),
      discount: serialiseMoney(pricing.totals.discountMinor, currency),
      tax: serialiseMoney(pricing.totals.taxMinor, currency),
      shipping: serialiseMoney(pricing.totals.shippingMinor, currency),
      grandTotal: serialiseMoney(pricing.totals.grandTotalMinor, currency),
    },
    shippingMethod: shipping === null ? null : { code: shipping.code, name: shipping.name },
    problems,
    ok: !problems.some((problem) => problem.severity !== 'WARN'),
    pricing,
    sourceItems,
  };
}

// ---------------------------------------------------------------------------
// Line resolution and substitution
// ---------------------------------------------------------------------------

interface ResolvedLine {
  productId: string;
  variantId: string | null;
  name: string;
  sku: string;
  variantName: string | null;
  imageUrl: string | null;
  quantity: number;
  taxClassCode: string;
  flatRatePercent: string;
  taxInclusive: boolean;
  vatCategory: Parameters<typeof applyLineTax>[1]['vatCategory'];
  isRecurringEligible: boolean;
  isStockTracked: boolean;
  minOrderQty: number;
  maxOrderQty: number | null;
  qtyIncrement: number;
  substitutedFor: { productId: string; name: string } | null;
}

/**
 * Turn requested items into supplyable ones.
 *
 * The substitution rules are the interesting part, and they are narrow on
 * purpose. When a product cannot be supplied:
 *
 *   - Policy NEVER (the default): nothing is swapped. The line drops out and a
 *     HOLD problem is recorded, so the occurrence stops and the customer is
 *     told. This is the right default for a medical-supply catalogue, where a
 *     near neighbour is not an equivalent.
 *   - Policy SAVED_PREFERENCE: the single substitute the customer named for
 *     that exact line is used, and only if it is itself available. There is no
 *     second choice and no category fallback. A substitution the customer did
 *     not name is one they did not authorise.
 */
async function resolveLines(
  input: QuoteScheduleInput,
  problems: QuoteProblem[],
): Promise<ResolvedLine[]> {
  const wanted = input.items;

  const productIds = [
    ...new Set([
      ...wanted.map((item) => item.productId),
      ...wanted
        .map((item) => item.substituteProductId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ]),
  ];

  const products = await prisma.product.findMany({
    where: { ...publicProductWhere(), id: { in: productIds } },
    include: {
      taxClass: {
        select: { code: true, ratePercent: true, isInclusive: true, vatCategory: true },
      },
      media: {
        orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
        take: 1,
        select: { media: { select: { url: true } } },
      },
    },
  });

  const productById = new Map(products.map((product) => [product.id, product]));

  // Variants are loaded in one query rather than per line: a plan with twenty
  // lines should not be twenty round trips.
  const variantIds = [
    ...new Set(
      [
        ...wanted.map((item) => item.variantId),
        ...wanted.map((item) => item.substituteVariantId),
      ].filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];

  const variants =
    variantIds.length === 0
      ? []
      : await prisma.productVariant.findMany({
          where: { id: { in: variantIds }, isActive: true, archivedAt: null },
          select: { id: true, productId: true, sku: true, name: true },
        });

  const variantById = new Map(variants.map((variant) => [variant.id, variant]));

  const allowSubstitution = input.substitutionPolicy === 'SAVED_PREFERENCE';
  const resolved: ResolvedLine[] = [];

  for (const item of wanted) {
    const primary = buildLine(item.productId, item.variantId ?? null, item.quantity, null);

    if (primary !== null) {
      resolved.push(primary);
      continue;
    }

    // The requested product cannot be supplied. What happens next is entirely
    // decided by what the customer authorised.
    const requestedName = productById.get(item.productId)?.name ?? 'An item on this schedule';

    // Withdrawn from sale, rather than merely out of stock: `buildLine`
    // returned null, which happens only when the catalogue no longer offers
    // this SKU on a schedule at all. Permanent, so the plan stops.
    const severity: QuoteSeverity = 'BLOCK';

    if (!allowSubstitution) {
      problems.push({
        severity,
        code: ErrorCode.SCHEDULE_PRODUCT_NOT_ELIGIBLE,
        message: `${requestedName} is no longer available for scheduled orders.`,
        productId: item.productId,
      });
      continue;
    }

    const substituteId = item.substituteProductId ?? null;

    if (substituteId === null || substituteId.length === 0) {
      problems.push({
        severity,
        code: ErrorCode.SUBSTITUTION_NOT_PERMITTED,
        message: `${requestedName} is not available and no replacement has been saved for it.`,
        productId: item.productId,
      });
      continue;
    }

    const substitute = buildLine(
      substituteId,
      item.substituteVariantId ?? null,
      item.quantity,
      { productId: item.productId, name: requestedName },
    );

    if (substitute === null) {
      // Both gone. Held rather than reaching for a third option nobody chose.
      problems.push({
        severity,
        code: ErrorCode.SUBSTITUTION_NOT_PERMITTED,
        message: `Neither ${requestedName} nor its saved replacement is available.`,
        productId: item.productId,
      });
      continue;
    }

    resolved.push(substitute);
  }

  return resolved;

  function buildLine(
    productId: string,
    variantId: string | null,
    quantity: number,
    substitutedFor: { productId: string; name: string } | null,
  ): ResolvedLine | null {
    const product = productById.get(productId);
    if (product === undefined) return null;

    // The admin's opt-in. A customer cannot put anything they like on a
    // standing order.
    if (!isScheduleEligible(product)) return null;

    if (variantId !== null) {
      const variant = variantById.get(variantId);
      // A variant that has gone, or one that belongs to another product -
      // which would be a mix-up worth refusing rather than reconciling.
      if (variant === undefined || variant.productId !== productId) return null;

      return {
        productId,
        variantId,
        name: product.name,
        sku: variant.sku,
        variantName: variant.name,
        imageUrl: product.media[0]?.media.url ?? null,
        quantity,
        taxClassCode: product.taxClass.code,
        flatRatePercent: product.taxClass.ratePercent.toString(),
        taxInclusive: product.taxClass.isInclusive,
        vatCategory: product.taxClass.vatCategory,
        isRecurringEligible: isScheduleEligible(product),
        isStockTracked: product.isStockTracked,
        minOrderQty: product.minOrderQty,
        maxOrderQty: product.maxOrderQty,
        qtyIncrement: product.qtyIncrement,
        substitutedFor,
      };
    }

    // A product with variants and none chosen cannot be ordered.
    if (product.hasVariants) return null;

    return {
      productId,
      variantId: null,
      name: product.name,
      sku: product.sku,
      variantName: null,
      imageUrl: product.media[0]?.media.url ?? null,
      quantity,
      taxClassCode: product.taxClass.code,
      flatRatePercent: product.taxClass.ratePercent.toString(),
      taxInclusive: product.taxClass.isInclusive,
      vatCategory: product.taxClass.vatCategory,
      isRecurringEligible: isScheduleEligible(product),
      isStockTracked: product.isStockTracked,
      minOrderQty: product.minOrderQty,
      maxOrderQty: product.maxOrderQty,
      qtyIncrement: product.qtyIncrement,
      substitutedFor,
    };
  }
}

function emptyQuote(
  currency: string,
  problems: QuoteProblem[],
  extra: QuoteProblem[],
): ScheduleQuote {
  const zero = serialiseMoney(0n, currency);
  const all = [...problems, ...extra];

  return {
    currency,
    lines: [],
    totals: { subtotal: zero, discount: zero, tax: zero, shipping: zero, grandTotal: zero },
    shippingMethod: null,
    problems: all,
    ok: false,
    pricing: {
      lines: [],
      totals: {
        subtotalMinor: 0n,
        discountMinor: 0n,
        taxMinor: 0n,
        shippingMinor: 0n,
        grandTotalMinor: 0n,
      },
    },
    sourceItems: [],
  };
}

// ---------------------------------------------------------------------------
// The price-tolerance test
// ---------------------------------------------------------------------------

export interface ToleranceDecision {
  /** True when the change is small enough to charge without asking again. */
  withinTolerance: boolean;
  deltaMinor: bigint;
  /** Signed percentage, to two places, as a string. */
  deltaPercent: string;
  allowedPercent: string;
  allowedMinor: bigint;
}

/**
 * Has the amount moved too far from what the customer was quoted?
 *
 * Two allowances, and the more generous wins. A percentage alone would hold an
 * occurrence over a one-unit rounding difference on a small basket, which
 * teaches customers to ignore the notification; an absolute floor alone would
 * wave through a large rise on a large basket.
 *
 * A price that has gone DOWN is always within tolerance. The customer agreed to
 * pay up to a figure, and charging them less than they expected needs no
 * permission - stopping the delivery to ask whether they mind paying less
 * would be absurd.
 *
 * `quotedMinor` of null means the customer has not been quoted anything yet -
 * the first occurrence of a plan whose reminder has not gone out. There is
 * nothing to compare against, so the plan's own approval ceiling is the only
 * control, and it is applied by the caller.
 */
export function evaluatePriceTolerance(input: {
  quotedMinor: bigint | null;
  actualMinor: bigint;
  tolerancePercent: string | null;
  toleranceMinor: bigint | null;
}): ToleranceDecision {
  const allowedPercent =
    input.tolerancePercent ?? String(env.SCHEDULE_PRICE_TOLERANCE_PERCENT);
  const allowedMinor = input.toleranceMinor ?? BigInt(env.SCHEDULE_PRICE_TOLERANCE_MINOR);

  if (input.quotedMinor === null) {
    return {
      withinTolerance: true,
      deltaMinor: 0n,
      deltaPercent: '0.00',
      allowedPercent,
      allowedMinor,
    };
  }

  const delta = input.actualMinor - input.quotedMinor;

  // Cheaper is always fine. See the header.
  if (delta <= 0n) {
    return {
      withinTolerance: true,
      deltaMinor: delta,
      deltaPercent: percentString(delta, input.quotedMinor),
      allowedPercent,
      allowedMinor,
    };
  }

  // Integer arithmetic throughout - the comparison is about money, and a
  // float would make the boundary case depend on binary rounding.
  //
  // `delta * 10000 <= quoted * allowedBasisPoints` is the percentage test
  // without division. Basis points give two decimal places of tolerance,
  // which is what the column stores.
  const allowedBasisPoints = BigInt(Math.round(Number(allowedPercent) * 100));
  const withinPercent = delta * 10_000n <= input.quotedMinor * allowedBasisPoints;
  const withinAbsolute = delta <= allowedMinor;

  return {
    withinTolerance: withinPercent || withinAbsolute,
    deltaMinor: delta,
    deltaPercent: percentString(delta, input.quotedMinor),
    allowedPercent,
    allowedMinor,
  };
}

function percentString(delta: bigint, base: bigint): string {
  if (base === 0n) return '0.00';
  // Scaled to basis points before converting, so the Number() only ever sees
  // a small integer rather than a ratio of two large ones.
  const basisPoints = (delta * 10_000n) / base;
  return (Number(basisPoints) / 100).toFixed(2);
}

/** The plan's own absolute ceiling, if it set one. */
export function exceedsApprovalThreshold(
  actualMinor: Minor,
  thresholdMinor: Minor | null,
): boolean {
  if (thresholdMinor === null) return false;
  return actualMinor > thresholdMinor;
}
