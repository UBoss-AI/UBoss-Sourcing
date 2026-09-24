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
import {
  SELLER_SELLING_UNIT,
  SELLING_UNIT,
  cartonsForPieces,
  operatorSellUnit,
  resolveSellUnitQuantity,
  sellerSellUnit,
  type SellUnitSpec,
  type OrderingUnit,
} from '../../domain/ordering-unit.js';
import {
  describePackaging,
  packagingSellUnit,
  pricePackage,
  wholePackagesAvailable,
  type PackageType,
} from '../../domain/packaging.js';
import { loadTypeForPackage, needsManualFreight } from '../../domain/freight-load.js';
import { loadBuyableOption, type BuyablePackagingOption } from '../seller/packaging.service.js';
import { newId, variantKeyOf } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { publicProductWhere } from '../catalog/catalog.visibility.js';
import { assertPurchasable } from '../catalog/purchasability.js';
import { isScheduleEligible } from '../catalog/recurring-eligibility.js';
import { loadPricesForCurrency, priceKey } from '../catalog/price.service.js';
import {
  explainRefusal,
  isTransientRefusal,
  resolveDerivation,
  type ConversionContext,
} from '../catalog/derived-price.service.js';
import type { FxPurpose } from '../../domain/fx.js';
import { getBaseCurrency } from '../settings/currency.service.js';
import { cheapestOfferFor, OFFER_SELL_TERMS, type OfferSellTerms } from '../catalog/marketplace-price.service.js';
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
import { applyLineTax, loadTaxContext, type TaxSetup } from '../tax/vat.service.js';
import {
  nextSaving,
  priceForQuantity,
  savingBasisPoints,
  storeDiscountTiers,
  type TierBuyer,
} from '../../domain/quantity-tier.js';
import { loadStoreDiscounts } from '../catalog/store-discount.service.js';
import {
  TIER_SELECT,
  isBusinessBuyer,
  snapshotTier,
  toQuantityTier,
  type QuantityTierSnapshot,
} from '../catalog/quantity-tier.service.js';
import {
  packageClassFor,
  quoteDelivery,
  serialiseDeliveryQuote,
  showLevelBreakdown,
  type DeliveryQuote,
  type SerialisedDeliveryQuote,
} from '../logistics/level-pricing.service.js';

/** Abandoned carts are swept after this long. */
const CART_TTL_DAYS = 30;

export interface CartLineIssue {
  code: string;
  message: string;
  meta?: Record<string, string | number | boolean | null>;
  /**
   * Whether this issue stops the basket going to checkout.
   *
   * ABSENT MEANS TRUE, and that default is the whole point: every issue that
   * existed before this field did is a genuine blocker - an unavailable
   * product, a price that cannot be resolved, a purchasing limit - and adding
   * the field must not quietly let any of them through.
   *
   * It exists because bulk ordering introduced the first line notice that is
   * NOT a failure. "Delivery for this container is quoted rather than priced
   * instantly" is the correct and expected state of a container order; a
   * basket that refused to go to checkout over it would make container
   * ordering impossible while telling the buyer nothing was wrong.
   */
  isBlocking?: boolean;
}

export interface CartLine {
  itemId: string;
  productId: string;
  variantId: string | null;
  /**
   * Whose offer this line is. Null means the operator's own stock.
   *
   * Checkout freezes it onto the order item, and it is the only thing that
   * later tells the split which seller's work and whose money this line is.
   */
  sellerOfferId: string | null;
  /**
   * The seller's trading name, for the basket to show beside the line.
   *
   * A basket holding the same product from two sellers is otherwise two
   * identical rows at two prices, which reads as a bug rather than a choice.
   */
  sellerName: string | null;
  name: string;
  /**
   * The chosen option's own name - "3 ml", "Box of 100" - or null where the
   * product has no options.
   *
   * Not decoration. A customer who buys two options of one product gets two
   * lines whose `name` is the same word, and without it the only thing
   * telling them apart is the SKU, in mono at the size of a footnote.
   */
  variantName: string | null;
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
  /**
   * The seller's quantity band that priced this line, or null at list price.
   *
   * `listUnitPrice` is what one piece costs without it, so the basket can show
   * the saving; `snapshot` is what checkout freezes onto the order item.
   */
  quantityTier: {
    minQuantity: number;
    maxQuantity: number | null;
    listUnitPrice: ReturnType<typeof serialiseMoney>;
    savingBasisPoints: number;
    snapshot: QuantityTierSnapshot;
  } | null;
  /** The nearest band above this quantity that lowers the price per piece. */
  nextQuantityTier: {
    minQuantity: number;
    addQuantity: number;
    unitPrice: ReturnType<typeof serialiseMoney>;
    savingPerPiece: ReturnType<typeof serialiseMoney>;
  } | null;
  /**
   * What the buyer chose to count in, and the conversion they were shown.
   *
   * Read off the line's own snapshot rather than the catalogue: a basket agreed
   * at 100 to a box keeps reading "2 boxes (200 pieces)" even after the box has
   * been re-specified at 50, because that is what they put in it.
   */
  ordering: {
    unit: OrderingUnit;
    /** Cartons on the operator's line; pieces on a seller's. */
    unitQuantity: number;
    piecesPerUnit: number;
    /**
     * How this line's quantity may be moved, in its own unit.
     *
     * Sent so the basket's stepper can be right rather than approximately
     * right. Without it the UI steps by one and the server silently rounds the
     * result up to the seller's minimum, which reads to the buyer as a control
     * that does not do what it says - they press minus and the number does not
     * move, or moves by five.
     *
     * The operator's line carries 1 and 1: its per-product minimum is written
     * in pieces and is applied to the piece count, not to the carton count.
     */
    minimumOrderQuantity: number;
    orderIncrement: number;
    maximumOrderQuantity: number | null;
  };
  /**
   * The buyer's special instruction for this line, or null.
   *
   * Shown in the basket and at the checkout review so nobody agrees to an
   * order carrying an instruction they cannot see, and editable from the
   * basket - which is the only place a buyer can change their mind about one
   * before the order is placed.
   */
  note: string | null;
  /**
   * The bulk breakdown this line was bought at, or null for an ordinary line.
   *
   * Read straight off the frozen snapshot. The basket shows "2 UK pallets x 50
   * cartons x 24 units = 2,400 units" from these figures and from nothing
   * else, so the sentence keeps saying what the shopper agreed to even after
   * the seller re-specifies the pallet.
   */
  packaging: CartLinePackaging | null;
  /** Non-empty when this line cannot go to checkout as it stands. */
  issues: CartLineIssue[];
}

/** The frozen breakdown, as the API returns it. Money as strings, as always. */
export interface CartLinePackaging {
  packageType: PackageType;
  palletStandard: string | null;
  containerType: string | null;
  containerLoadMode: string | null;
  containerLoadingMethod: string | null;
  packageQuantity: number;
  unitsPerPackage: number;
  totalBaseUnits: number;
  unitsPerCarton: number | null;
  cartonsPerPallet: number | null;
  palletsPerContainer: number | null;
  cartonsPerContainer: number | null;
  totalCartons: number | null;
  totalPallets: number | null;
  totalContainers: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  /** The WHOLE line's gross weight and volume, not one package's. */
  grossWeightGrams: string | null;
  volumeCm3: string | null;
  packagePriceMinor: string;
  unitPriceMinor: string;
  currency: string;
  appliedTierMinPackages: number | null;
  profileVersion: number;
  requiresFreightQuote: boolean;
  loadType: string;
  /** The seller's terms for this package, so the stepper steps correctly. */
  minimumPackages: number;
  packageIncrement: number;
  maximumPackages: number | null;
}

/**
 * The word for a package type in a sentence the server writes.
 *
 * Deliberately minimal and deliberately English. Every sentence a BUYER reads
 * is composed in the frontend from structured figures in their own language;
 * this is only for the handful of server-side messages where a code alone
 * would be unreadable in a log or an API consumer's fallback.
 */
/**
 * The frozen breakdown, expanded into the whole line's figures.
 *
 * The per-line totals - cartons, pallets, weight, volume - are computed by
 * `describePackaging`, the same function the seller's preview and the freight
 * request use, so the figure on the basket, the figure on the quote request
 * and the figure on the packing list are one calculation rather than three.
 *
 * The seller's LIVE terms come in separately and are used only for the
 * stepper's bounds. Nothing about what the package IS is read from them.
 */
function toCartLinePackaging(
  snapshot: {
    packageType: string;
    palletStandard: string | null;
    containerType: string | null;
    containerLoadMode: string | null;
    containerLoadingMethod: string | null;
    packageQuantity: number;
    unitsPerPackage: number;
    totalBaseUnits: number;
    unitsPerCarton: number | null;
    cartonsPerPallet: number | null;
    palletsPerContainer: number | null;
    cartonsPerContainer: number | null;
    lengthMm: number | null;
    widthMm: number | null;
    heightMm: number | null;
    grossWeightGrams: bigint | null;
    cargoVolumeCm3: bigint | null;
    packagePriceMinor: bigint;
    unitPriceMinor: bigint;
    currency: string;
    appliedTierMinPackages: number | null;
    profileVersion: number;
    requiresFreightQuote: boolean;
  } | null,
  liveTerms: {
    minimumPackages: number;
    packageIncrement: number;
    maximumPackages: number | null;
  } | null,
): CartLinePackaging | null {
  if (snapshot === null) return null;

  const packageType = snapshot.packageType as PackageType;

  const breakdown = describePackaging({
    packageType,
    packageQuantity: snapshot.packageQuantity,
    unitsPerPackage: snapshot.unitsPerPackage,
    unitsPerCarton: snapshot.unitsPerCarton,
    cartonsPerPallet: snapshot.cartonsPerPallet,
    palletsPerContainer: snapshot.palletsPerContainer,
    cartonsPerContainer: snapshot.cartonsPerContainer,
    grossWeightGrams: snapshot.grossWeightGrams,
    cargoVolumeCm3: snapshot.cargoVolumeCm3,
  });

  return {
    packageType,
    palletStandard: snapshot.palletStandard,
    containerType: snapshot.containerType,
    containerLoadMode: snapshot.containerLoadMode,
    containerLoadingMethod: snapshot.containerLoadingMethod,
    packageQuantity: snapshot.packageQuantity,
    unitsPerPackage: snapshot.unitsPerPackage,
    totalBaseUnits: snapshot.totalBaseUnits,
    unitsPerCarton: snapshot.unitsPerCarton,
    cartonsPerPallet: snapshot.cartonsPerPallet,
    palletsPerContainer: snapshot.palletsPerContainer,
    cartonsPerContainer: snapshot.cartonsPerContainer,
    totalCartons: breakdown.totalCartons,
    totalPallets: breakdown.totalPallets,
    totalContainers: breakdown.totalContainers,
    lengthMm: snapshot.lengthMm,
    widthMm: snapshot.widthMm,
    heightMm: snapshot.heightMm,
    grossWeightGrams: breakdown.grossWeightGrams?.toString() ?? null,
    volumeCm3: breakdown.volumeCm3?.toString() ?? null,
    packagePriceMinor: snapshot.packagePriceMinor.toString(),
    unitPriceMinor: snapshot.unitPriceMinor.toString(),
    currency: snapshot.currency,
    appliedTierMinPackages: snapshot.appliedTierMinPackages,
    profileVersion: snapshot.profileVersion,
    requiresFreightQuote: snapshot.requiresFreightQuote,
    loadType: loadTypeForPackage(
      packageType,
      snapshot.containerLoadMode as 'FCL' | 'LCL' | null,
    ),
    minimumPackages: liveTerms?.minimumPackages ?? 1,
    packageIncrement: liveTerms?.packageIncrement ?? 1,
    maximumPackages: liveTerms?.maximumPackages ?? null,
  };
}

function describePackageWord(packageType: string): string {
  switch (packageType) {
    case 'CARTON':
      return 'carton order';
    case 'UK_PALLET':
    case 'US_PALLET':
      return 'pallet order';
    case 'CONTAINER':
      return 'container order';
    default:
      return 'bulk order';
  }
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
  /**
   * True when something in this basket has to be quoted for delivery rather
   * than priced instantly - a container, or a pallet no carrier on the
   * seller's account can take.
   *
   * NOT a blocker. The goods are priced; the FREIGHT is not, and the checkout
   * says so and offers to raise the request. A basket that refused to proceed
   * over it would make container ordering impossible.
   */
  requiresFreightQuote: boolean;
  /**
   * The sellers' four-level delivery charges, or null when no seller in the
   * basket has a published logistics policy. Included in `totals.shipping`.
   * `token` is what checkout must send back unchanged.
   */
  delivery: SerialisedDeliveryQuote | null;
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
/**
 * The frozen breakdown as the database holds it.
 *
 * Deliberately the storage shape and not the display one: `bigint` money,
 * per-PACKAGE weight and volume, no derived totals. Checkout copies it onto
 * `OrderItemPackaging` column for column, which is what makes an order's
 * snapshot provably the basket's rather than a recomputation that agreed with
 * it on the day.
 */
export interface CartPackagingSnapshot {
  packageType: string;
  palletStandard: string | null;
  containerType: string | null;
  containerLoadMode: string | null;
  containerLoadingMethod: string | null;
  packageQuantity: number;
  unitsPerPackage: number;
  totalBaseUnits: number;
  unitsPerCarton: number | null;
  cartonsPerPallet: number | null;
  palletsPerContainer: number | null;
  cartonsPerContainer: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  grossWeightGrams: bigint | null;
  cargoVolumeCm3: bigint | null;
  packagePriceMinor: bigint;
  unitPriceMinor: bigint;
  currency: string;
  appliedTierMinPackages: number | null;
  profileVersion: number;
  snapshotAt: Date;
  requiresFreightQuote: boolean;
}

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
    /**
     * The seller's offer this line was bought from, or null for the operator's
     * own stock. Checkout needs it to know whose shelf the units come off:
     * reserving a seller's line against the operator's balances would hold
     * units nobody has, and refuse an order the seller can fill perfectly
     * well.
     */
    sellerOfferId: string | null;
    /**
     * The bulk breakdown EXACTLY as it is stored on the basket line, or null.
     *
     * The raw row rather than `CartLine.packaging`, which has been expanded
     * for display - its weight is the whole line's, not one package's.
     * Checkout copies these columns across verbatim, so the order's snapshot
     * is byte-for-byte the basket's and nothing is recomputed on the way.
     */
    packaging: CartPackagingSnapshot | null;
  }[];
  blockingIssues: CartLineIssue[];
  /** Category of each priced line, positionally aligned with `pricing.lines`. */
  lineCategoryIds: string[];
  /** The coupon actually priced into `pricing`, for checkout to record. */
  appliedCoupon: CouponEvaluation | null;
  couponRejection: CouponRejection | null;
  availableCoupons: OfferedCouponView[];
  /**
   * The VAT treatment these lines were priced under.
   *
   * Carried out of here so checkout freezes onto the order the same reasoning
   * that produced the numbers, rather than working it out a second time and
   * risking a different answer - a VIES check that expires between the two
   * calls would otherwise let an order be priced zero-rated and recorded as
   * taxable.
   */
  taxSetup: TaxSetup;

  /**
   * The conversion these prices came from, or null when they did not come
   * from one.
   *
   * Null is the ordinary case and means every line was priced from a figure a
   * person entered in this currency. Non-null means at least one line was
   * derived from the base currency, and carries the rate, its provider and its
   * date - which checkout freezes onto the order and the basket screen uses to
   * caption the total as approximate.
   *
   * Carried out of `resolveCart` for exactly the reason `taxSetup` is: the
   * caller must record the terms that produced these numbers, not work them
   * out again. Resolving the rate a second time could straddle a refresh and
   * charge against a rate the customer was never shown.
   */
  fxContext: ConversionContext | null;

  /**
   * L1-L4 for each marketplace seller with a published logistics policy, or
   * null when there is none. Its total is already inside
   * `pricing.totals.shippingMinor`; this is the breakdown checkout freezes
   * onto the order, level by level, and signs.
   */
  delivery: DeliveryQuote | null;
  /** Whether the buyer is shown each level or one delivery line. */
  deliveryShowLevels: boolean;
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
  options: {
    shippingMethodCode?: string | null;
    destinationCountry?: string | null;
    /**
     * The delivery address's postcode, where one is known.
     *
     * Only the four-level delivery prices read it - an L4 price may be for
     * one postcode area of a country and not the rest. Checkout passes the
     * chosen address's; a basket being browsed has none, and an L4 price
     * narrower than a whole country then does not match, which is honest.
     */
    destinationPostcode?: string | null;
    /**
     * Delivery priced by a warehouse lane rather than by a shipping method.
     *
     * Wins over `shippingMethodCode` when both are given, and it is the whole
     * reason fulfilment options can quote a total at all: the fee comes from
     * `WarehouseDeliveryZone`, which the `shipping_methods` table knows
     * nothing about.
     *
     * It is an *input to the same pricing run*, not a number added afterwards.
     * That distinction is the point - `priceLines` decides free-above,
     * assembles the grand total from its own line totals, and
     * `assertTotalsConsistent` then checks the result. A caller that added a
     * delivery fee to a finished total would be a second pricing engine, and
     * the one thing this codebase will not have is two answers to "what does
     * this basket cost".
     */
    shippingOverride?: { priceMinor: Minor; freeAboveMinor: Minor | null } | null;
    /**
     * What this quote is for.
     *
     * The only thing it changes is how old an exchange rate set may be before
     * a derived price is refused, and the two answers are deliberately
     * different. A basket being looked at may be priced from a rate that is
     * days old, captioned as approximate. A basket being paid for may not: a
     * charge taken against a stale indicative rate is a figure nobody can
     * reconcile afterwards.
     *
     * So checkout passes `checkout` and gets, in the worst case, a line that
     * has become unpriceable and a refusal - which is the safe failure. A
     * basket priced entirely from figures a person typed is unaffected either
     * way, because no rate is involved in it at all.
     */
    fxPurpose?: FxPurpose;
  } = {},
): Promise<ResolvedCart> {
  const cartId = await getOrCreateCart(customerProfileId);
  const currency = await resolveCurrency(customerProfileId);

  // What VAT treatment this basket falls under, and at whose rates.
  //
  // The destination is the delivery address when there is one - checkout
  // passes it - and the country the shopper said they are in otherwise. Only
  // the first is what Art. 33 actually turns on, which is why checkout
  // reprices through this same function against the real address before any
  // money moves.
  //
  // In a deployment with no EU VAT configured this resolves to FLAT_RATE in
  // two indexed queries and nothing below behaves differently.
  const taxProfile = await prisma.customerProfile.findUnique({
    where: { id: customerProfileId },
    select: {
      preferredCountry: true,
      vatNumber: true,
      vatNumberValid: true,
      // Whether a band "for business accounts" applies. See `isBusinessBuyer`.
      organization: true,
      user: { select: { status: true } },
    },
  });

  // Who a seller's quantity band is judged against. The same destination the
  // tax treatment uses, so a band for one country and the VAT for it agree.
  const tierBuyer: TierBuyer = {
    now: new Date(),
    isBusinessBuyer: isBusinessBuyer(taxProfile),
    country: options.destinationCountry ?? taxProfile?.preferredCountry ?? null,
    channel: 'BASKET',
  };

  // The store-wide quantity discounts, read once for the whole basket.
  const storeDiscounts = await loadStoreDiscounts();

  const taxSetup = await loadTaxContext({
    destinationCountry: options.destinationCountry ?? taxProfile?.preferredCountry ?? null,
    vatNumber: taxProfile?.vatNumber ?? null,
    vatNumberValid: taxProfile?.vatNumberValid ?? null,
  });

  const items = await prisma.cartItem.findMany({
    where: { cartId },
    orderBy: { createdAt: 'asc' },
    include: {
      product: {
        include: {
          taxClass: {
            select: { code: true, ratePercent: true, isInclusive: true, vatCategory: true },
          },
          category: { select: { isActive: true, archivedAt: true } },
          media: {
            orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
            take: 1,
            select: { media: { select: { url: true } } },
          },
        },
      },
      variant: true,
      /*
       * The seller's offer, where the line names one.
       *
       * Loaded with the line rather than looked up later because it decides the
       * PRICE: a marketplace line is bought at the seller's price, not the
       * operator's catalogue price, and pricing it from the catalogue would
       * charge the buyer one figure and settle the seller against another.
       */
      sellerOffer: {
        select: {
          id: true,
          status: true,
          priceMinor: true,
          currency: true,
          availableQuantity: true,
          // Quantity bands: a loose line of 5,000 pieces is priced at the
          // band it reaches, through `priceForQuantity` and nothing else.
          priceTiers: { select: TIER_SELECT },
          // The terms the buyer is stepped by. Read from the offer rather than
          // from the line, so a seller who has raised their minimum since the
          // line was added is telling the buyer so in the basket rather than
          // at checkout.
          orderingUnit: true,
          minimumOrderQuantity: true,
          orderIncrement: true,
          maximumOrderQuantity: true,
          sellerAccount: { select: { displayName: true, status: true } },
          /*
           * The seller's CURRENT packaging, loaded beside the line's frozen
           * one so the two can be compared.
           *
           * Compared, never applied. The line keeps what it was added at -
           * that is the whole purpose of the snapshot - and a difference
           * becomes a message on the line rather than a silent change to what
           * is in somebody's basket.
           */
          packagingProfile: {
            select: {
              version: true,
              options: {
                select: {
                  packageType: true,
                  state: true,
                  isEnabled: true,
                  unitsPerPackage: true,
                  minimumPackages: true,
                  packageIncrement: true,
                  maximumPackages: true,
                },
              },
            },
          },
        },
      },
      /*
       * What this line was bought as, frozen.
       *
       * Null on every ordinary line, which is most of them, and its absence is
       * what makes the basket render exactly as it did before bulk ordering
       * existed.
       */
      packaging: true,
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
    { purpose: options.fxPurpose ?? 'display' },
  );

  // Every line in a basket shares one currency, so at most one conversion
  // applies to the whole quote. Taking it from the first converted line rather
  // than resolving the rate again is not an optimisation: resolving twice
  // could straddle a refresh and leave the basket priced at one rate and
  // described as another.
  const fxContext =
    [...prices.values()].find((price) => price.conversion !== null)?.conversion ?? null;

  // Why derivation could not price anything, when it could not.
  //
  // Resolved only when something is actually missing a price, so the ordinary
  // basket - every line priced from a figure somebody typed - pays nothing for
  // it. `null` means either everything priced fine or the currency is the base
  // one, and in both cases there is nothing to explain.
  const unpriced = items.some(
    (item) =>
      item.sellerOfferId === null &&
      !prices.has(priceKey(item.productId, item.variantId)),
  );

  const fxRefusal =
    unpriced && fxContext === null
      ? await (async () => {
          const base = await getBaseCurrency();
          const result = await resolveDerivation(
            currency,
            base,
            options.fxPurpose ?? 'display',
          );
          return result.ok ? null : result.refusal;
        })()
      : null;

  const pricingInputs: PricingLineInput[] = [];
  const lineMeta: {
    itemId: string;
    productId: string;
    variantId: string | null;
    sellerOfferId: string | null;
    sellerName: string | null;
    quantity: number;
    isStockTracked: boolean;
    slug: string;
    imageUrl: string | null;
    availableQty: number | null;
    issues: CartLineIssue[];
    ordering: CartLine['ordering'];
    note: string | null;
    packaging: CartLinePackaging | null;
    /** The storage shape, for checkout to copy across. See `sourceItems`. */
    rawPackaging: CartPackagingSnapshot | null;
    /** The whole line's shipping weight, or null where nobody recorded one. */
    weightGrams: number | null;
    quantityTier: CartLine['quantityTier'];
    nextQuantityTier: CartLine['nextQuantityTier'];
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

    /*
     * Whose shelf this line comes off.
     *
     * A seller's stock is theirs, in their own warehouse, on their own offer -
     * the operator holds none of it and never will. Reading the operator's
     * availability for a seller's line answers "how many do WE have", which is
     * always zero, and every marketplace line would be permanently out of
     * stock: buyable in the catalogue, refused in the basket, for a reason the
     * shopper cannot act on and the seller cannot see.
     */
    const availableQty = item.sellerOffer !== null
      ? item.sellerOffer.availableQuantity
      : product.isStockTracked
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

    // Only when the operator is the one selling it. A seller's line is priced
    // by their offer below, and a product the operator has no price for in this
    // currency is still perfectly sellable by somebody else.
    if (price === undefined && item.sellerOfferId === null) {
      // WHICH kind of unpriceable. `fxRefusal` is resolved once for the whole
      // basket below, and is non-null only when this deployment would
      // ordinarily convert into this currency but cannot at this moment - a
      // rate feed that has been down since Tuesday, most often. Telling a
      // shopper their product "is not sold in zloty" in that situation is
      // simply untrue, and it sends whoever investigates into the catalogue
      // looking for a price row that was never missing.
      const transient = fxRefusal !== null && isTransientRefusal(fxRefusal);

      issues.push({
        code: transient
          ? ErrorCode.PRICE_RATE_UNAVAILABLE
          : ErrorCode.PRICE_UNAVAILABLE_IN_CURRENCY,
        message: transient
          ? explainRefusal(fxRefusal, currency)
          : `${product.name} is not sold in ${currency}.`,
        meta: { productId: product.id, currency },
      });
    }

    /*
     * A marketplace line is priced by its SELLER, not by the catalogue.
     *
     * The catalogue price is the operator's own, and on a line the buyer chose
     * a seller for it is the wrong number: it would show them one figure,
     * charge them that, and then settle the seller against theirs. So the
     * offer's price wins where there is one — and where the offer has stopped
     * being sellable, the line is blocked rather than quietly falling back to
     * the operator's price, which would substitute a different seller's deal
     * for the one the buyer agreed to.
     */
    const offer = item.sellerOffer;

    if (offer !== null && offer.status !== 'ACTIVE') {
      issues.push({
        code: ErrorCode.CART_ITEM_UNAVAILABLE,
        message: `${offer.sellerAccount.displayName} is no longer selling ${product.name}.`,
        meta: { productId: product.id, sellerOfferId: offer.id },
      });
    }

    if (offer !== null && offer.currency !== currency) {
      issues.push({
        code: ErrorCode.PRICE_UNAVAILABLE_IN_CURRENCY,
        message: `${offer.sellerAccount.displayName} does not sell ${product.name} in ${currency}.`,
        meta: { productId: product.id, currency, sellerOfferId: offer.id },
      });
    }

    /*
     * A BULK line is priced from its own snapshot, not from the offer.
     *
     * The seller's `priceMinor` is the price of one loose unit. A package is
     * priced by the seller as a package - at a band, or outright - and the
     * two are deliberately not the same number: that is what a bulk discount
     * IS. Pricing a pallet line off the loose unit price would silently throw
     * away the discount the buyer was shown and charge them list.
     *
     * `unitPriceMinor` on the snapshot is exact rather than truncated: the
     * package price is required to divide by what is in the package, so
     * `unitPrice x quantity` is the package price times the package count, to
     * the paise. See `validatePackagingOption`.
     */
    /*
     * A LOOSE seller line is priced at the seller's quantity band, where one
     * applies. Not a bulk (packaged) line: a package already has its own
     * price, and applying a piece band on top would discount it twice.
     */
    /*
     * The operator's own line is banded by the store-wide quantity discounts
     * instead, on the price quoted in this currency. They are percentages, so
     * one rule makes the right band in every currency.
     */
    const bandListMinor: Minor | null =
      item.packaging !== null
        ? null
        : offer !== null
          ? offer.currency === currency
            ? offer.priceMinor
            : null
          : (price?.basePriceMinor ?? null);
    const tiers =
      bandListMinor === null
        ? []
        : offer !== null
          ? offer.priceTiers.map(toQuantityTier)
          : storeDiscountTiers(bandListMinor, storeDiscounts);
    const tierPrice =
      bandListMinor !== null && tiers.length > 0
        ? priceForQuantity(bandListMinor, tiers, item.quantity, tierBuyer)
        : null;
    const upcoming =
      bandListMinor !== null && tiers.length > 0
        ? nextSaving(bandListMinor, tiers, item.quantity, tierBuyer)
        : null;

    const listedPriceMinor: Minor =
      item.packaging !== null && item.packaging.currency === currency
        ? item.packaging.unitPriceMinor
        : offer !== null && offer.currency === currency
          ? (tierPrice?.unitPriceMinor ?? offer.priceMinor)
          : offer === null
            ? (tierPrice?.unitPriceMinor ?? price?.basePriceMinor ?? 0n)
            : (price?.basePriceMinor ?? 0n);

    if (item.packaging !== null) {
      const live = offer?.packagingProfile?.options.find(
        (option) => option.packageType === item.packaging?.packageType,
      );

      if (live === undefined || !live.isEnabled || live.state !== 'ACTIVE') {
        issues.push({
          code: ErrorCode.PACKAGING_OPTION_NOT_AVAILABLE,
          message: `${offer?.sellerAccount.displayName ?? 'The seller'} no longer offers ${product.name} in this packaging.`,
          meta: { productId: product.id, packageType: item.packaging.packageType },
        });
      } else if (live.unitsPerPackage !== item.packaging.unitsPerPackage) {
        /*
         * Told, not applied.
         *
         * The line still holds the pallet the shopper agreed to, and it will
         * be ordered and invoiced at that size. What has changed is what the
         * seller would pack TODAY, and a buyer about to commit to a five
         * figure order is entitled to know the two are no longer the same.
         */
        issues.push({
          code: ErrorCode.PACKAGING_SNAPSHOT_STALE,
          message: `${offer?.sellerAccount.displayName ?? 'The seller'} has changed what goes in one of these packages since you added it.`,
          meta: {
            productId: product.id,
            packageType: item.packaging.packageType,
            snapshotUnitsPerPackage: item.packaging.unitsPerPackage,
            currentUnitsPerPackage: live.unitsPerPackage,
          },
        });
      }

      if (item.packaging.requiresFreightQuote) {
        /*
         * Not an error, and deliberately worded so nothing renders it as one.
         *
         * A container is genuinely not a thing with an instant delivery price,
         * and saying so is the honest answer rather than a failure. The
         * checkout offers to raise the quotation; `assertCheckoutReady` is
         * what decides whether the order may go through without one.
         */
        issues.push({
          code: ErrorCode.FREIGHT_QUOTE_REQUIRED,
          message: `Delivery for this ${describePackageWord(item.packaging.packageType)} is quoted rather than priced instantly.`,
          isBlocking: false,
          meta: {
            productId: product.id,
            packageType: item.packaging.packageType,
            loadType: loadTypeForPackage(
              item.packaging.packageType,
              item.packaging.containerLoadMode,
            ),
          },
        });
      }
    }

    // Under FLAT_RATE this returns the catalogue's own figures untouched.
    // Under an EU treatment it resolves the destination's rate for this
    // product's band, and converts a tax-inclusive listing back to net first -
    // see `applyLineTax` for why that conversion is not optional.
    const lineTax = applyLineTax(
      taxSetup,
      {
        vatCategory: product.taxClass.vatCategory,
        flatRatePercent: product.taxClass.ratePercent.toString(),
        taxInclusive: product.taxClass.isInclusive,
        productName: product.name,
      },
      listedPriceMinor,
    );

    if (lineTax.problem !== null) {
      // A misconfiguration, not a shopper's mistake - but it blocks the line,
      // because the alternative is charging a rate nobody chose.
      issues.push({
        code: ErrorCode.PRICE_UNAVAILABLE_IN_CURRENCY,
        message: lineTax.problem,
        meta: { productId: product.id },
      });
    }

    pricingInputs.push({
      product: {
        productId: product.id,
        variantId: item.variantId,
        name: product.name,
        sku: item.variant?.sku ?? product.sku,
        variantName: item.variant?.name ?? null,
        unitPriceMinor: lineTax.unitPriceMinor,
        taxClassCode: product.taxClass.code,
        taxRatePercent: lineTax.taxRatePercent,
        taxInclusive: lineTax.taxInclusive,
        isRecurringEligible: isScheduleEligible(product),
        imageUrl: product.media[0]?.media.url ?? null,
      },
      quantity: item.quantity,
    });

    lineMeta.push({
      quantityTier:
        tierPrice?.tier === undefined || tierPrice.tier === null || bandListMinor === null
          ? null
          : {
              minQuantity: tierPrice.tier.minQuantity,
              maxQuantity: tierPrice.tier.maxQuantity,
              listUnitPrice: serialiseMoney(bandListMinor, currency),
              savingBasisPoints: savingBasisPoints(bandListMinor, tierPrice.unitPriceMinor),
              snapshot: snapshotTier(
                tierPrice.tier,
                bandListMinor,
                offer === null ? 'STORE' : 'SELLER',
              ),
            },
      nextQuantityTier:
        upcoming === null
          ? null
          : {
              minQuantity: upcoming.tier.minQuantity,
              addQuantity: upcoming.addQuantity,
              unitPrice: serialiseMoney(upcoming.unitPriceMinor, currency),
              savingPerPiece: serialiseMoney(upcoming.savingPerPieceMinor, currency),
            },
      itemId: item.id,
      productId: product.id,
      variantId: item.variantId,
      sellerOfferId: item.sellerOfferId,
      // Shown beside the line so a basket holding the same product from two
      // sellers is two lines the buyer can tell apart. Without it they are two
      // identical rows at two prices, which reads as a bug.
      sellerName: offer?.sellerAccount.displayName ?? null,
      quantity: item.quantity,
      isStockTracked: product.isStockTracked,
      slug: product.slug,
      imageUrl: product.media[0]?.media.url ?? null,
      availableQty,
      issues,
      /*
       * The unit is not the supplier's word for their own outer pack. On the
       * operator's line it is the carton this shop sells, which the storefront
       * names in the reader's own language - a sheet that called its outer
       * pack a "box" would otherwise print "box" beside a carton count. On a
       * seller's line it is a piece, because that is what a seller sells.
       *
       * Taken from the line's own snapshot, not from the offer: a basket
       * agreed at 500 to a carton keeps reading "2 cartons (1,000 pieces)"
       * even after the deployment re-specifies a carton at 250.
       */
      ordering: (() => {
        // A bulk line steps by PACKAGES, at the seller's own package terms.
        // Handing the stepper the offer's piece minimum would let a buyer
        // press minus on a four-pallet minimum and watch nothing move.
        const livePackage =
          item.packaging === null
            ? undefined
            : offer?.packagingProfile?.options.find(
                (option) => option.packageType === item.packaging?.packageType,
              );

        return {
          unit: item.orderingUnit,
          unitQuantity: item.unitQuantity,
          piecesPerUnit: item.piecesPerUnitSnapshot,
          minimumOrderQuantity: livePackage?.minimumPackages ?? offer?.minimumOrderQuantity ?? 1,
          orderIncrement: livePackage?.packageIncrement ?? offer?.orderIncrement ?? 1,
          maximumOrderQuantity:
            item.packaging === null
              ? (offer?.maximumOrderQuantity ?? null)
              : (livePackage?.maximumPackages ?? null),
        };
      })(),
      // The buyer's own words about this product. Carried through the basket
      // so it can be shown back and edited before the order is placed, and
      // frozen onto the order line at checkout.
      note: item.note,
      packaging: toCartLinePackaging(
        item.packaging,
        offer?.packagingProfile?.options.find(
          (option) => option.packageType === item.packaging?.packageType,
        ) ?? null,
      ),
      rawPackaging: item.packaging,
      // What the delivery levels are weighed on. A bulk line's packages carry
      // their own gross weight; otherwise the variant's shipping weight, then
      // the product's. Null - never zero - when none is recorded, so a weight
      // band cannot be matched on a guess.
      weightGrams: (() => {
        if (item.packaging !== null && item.packaging.grossWeightGrams !== null) {
          return Number(item.packaging.grossWeightGrams) * item.packaging.packageQuantity;
        }
        const each = item.variant?.shippingWeightGrams ?? product.weightGrams ?? null;
        return each === null ? null : each * item.quantity;
      })(),
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

  // The lane wins over the method. A caller that passes both is checkout
  // re-pricing a chosen warehouse option while the cart still carries the
  // method it was browsing with, and the option is what the customer agreed
  // to.
  const shipping =
    options.shippingOverride ?? (await resolveShipping(options.shippingMethodCode));

  /*
   * The marketplace sellers' own delivery: L1 + L2 + L3 + L4 for each seller
   * who has published a logistics policy. Null for every other basket, and
   * then nothing below changes.
   *
   * It goes INTO the same pricing run, as its own input next to the
   * shipping method, rather than being added to a finished total - there is
   * one answer to "what does this basket cost", and `assertTotalsConsistent`
   * checks it. It is not subject to the shipping method's free-above
   * threshold: that is the operator's offer on the operator's own carriage,
   * and it must not quietly make a seller's international freight free.
   */
  const delivery = await quoteDelivery({
    lines: lineMeta
      .filter((meta) => meta.sellerOfferId !== null)
      .map((meta) => ({
        sellerOfferId: meta.sellerOfferId ?? '',
        quantity: meta.quantity,
        weightGrams: meta.weightGrams,
        packageClass: packageClassFor(meta.rawPackaging?.packageType),
      })),
    currency,
    destinationCountry: options.destinationCountry ?? taxProfile?.preferredCountry ?? null,
    destinationPostcode: options.destinationPostcode ?? null,
    fxPurpose: options.fxPurpose ?? 'display',
  });
  const deliveryShowLevels = delivery === null ? true : await showLevelBreakdown();

  const pricing = priceLines(pricingInputs, {
    ...(shipping === null ? {} : { shipping }),
    ...(delivery === null ? {} : { sellerDeliveryMinor: delivery.totalMinor }),
  });

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
      sellerOfferId: meta.sellerOfferId,
      sellerName: meta.sellerName,
      name: priced?.nameSnapshot ?? '',
      variantName: priced?.variantNameSnapshot ?? null,
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
      isRecurringEligible: source === undefined ? false : isScheduleEligible(source.product),
      purchaseRules: {
        minOrderQty: items[index]?.product.minOrderQty ?? 1,
        maxOrderQty: items[index]?.product.maxOrderQty ?? null,
        qtyIncrement: items[index]?.product.qtyIncrement ?? 1,
      },
      ordering: meta.ordering,
      note: meta.note,
      packaging: meta.packaging,
      issues: meta.issues,
      quantityTier: meta.quantityTier,
      nextQuantityTier: meta.nextQuantityTier,
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

  // A seller's delivery with a level nobody has priced for this route. The
  // basket cannot be bought until it is - never at zero, never at another
  // route's price - and the buyer is told whose delivery it is.
  for (const seller of delivery?.sellers ?? []) {
    if (seller.status !== 'QUOTE_REQUIRED') continue;
    blockingIssues.push({
      code: ErrorCode.LOGISTICS_QUOTE_REQUIRED,
      message: `Delivery from ${seller.sellerName} needs a quote for this address before it can be ordered.`,
      meta: {
        sellerAccountId: seller.sellerAccountId,
        sellerName: seller.sellerName,
        levels: seller.levels
          .filter((level) => level.leg === null)
          .map((level) => level.level)
          .join(','),
      },
    });
  }

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
      sellerOfferId: meta.sellerOfferId,
      packaging: meta.rawPackaging,
    })),
    blockingIssues,
    lineCategoryIds: couponLines.map((line) => line.categoryId),
    appliedCoupon,
    couponRejection,
    availableCoupons,
    taxSetup,
    fxContext,
    delivery,
    deliveryShowLevels,
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

  // `isBlocking !== false` rather than `=== true`: the field is optional and
  // its absence has always meant "this stops checkout". See `CartLineIssue`.
  const hasLineIssue = resolved.lines.some((line) =>
    line.issues.some((issue) => issue.isBlocking !== false),
  );
  const isEmpty = resolved.lines.length === 0;

  // Whether anything in this basket has to be quoted rather than priced. The
  // checkout draws the freight panel from this rather than re-deriving it from
  // the lines, so one answer reaches the buyer.
  const requiresFreightQuote = resolved.lines.some(
    (line) => line.packaging?.requiresFreightQuote === true,
  );

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
    requiresFreightQuote,
    delivery:
      resolved.delivery === null
        ? null
        : serialiseDeliveryQuote(resolved.delivery, { showLevels: resolved.deliveryShowLevels }),
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
  /**
   * Pieces. Still the whole request when no pack unit is named, which is every
   * caller that existed before pack ordering did.
   */
  quantity: number;
  /**
   * What the buyer chose to count in, and how many of them.
   *
   * When these are present the piece count is worked out here, from the
   * catalogue's own packaging row - `quantity` above is ignored. The
   * conversion is deliberately never taken from the request: a client that
   * could post its own "pieces per carton" could post 1 and buy a carton at
   * the price of a syringe.
   */
  orderingUnit?: OrderingUnit | null;
  unitQuantity?: number | null;
  /**
   * Whose offer to buy, on a marketplace deployment.
   *
   * Absent means the operator's own stock, which is what every caller that
   * existed before the Seller Hub did means and what most lines still are. When
   * it IS given it is checked against the product on the same line: an offer id
   * belonging to some other product is the same class of mistake as a variant
   * id belonging to some other product, and is refused the same way.
   */
  sellerOfferId?: string | null;
  /**
   * What the buyer needs done to this product, in their own words.
   *
   * Absent means "say nothing", which is every caller that existed before this
   * field did and most lines afterwards. An empty or blank string is the same
   * as absent - the field is normalised here so a cleared box and an untouched
   * one cannot be two different states in the database.
   *
   * Re-adding a SKU that already carries an instruction does NOT wipe it: see
   * `noteFor` below, which is where the rule is stated and why.
   */
  note?: string | null;
  /**
   * The seller's PACKAGE the buyer chose, and how many of them.
   *
   * Absent on every line that is not a bulk order, which is most of them.
   * When present, `quantity`, `orderingUnit` and `unitQuantity` above are all
   * ignored: the base-unit count is worked out here, from the seller's own
   * stored `SellerPackagingOption`, and never from anything in this body. A
   * client that could post its own "units per pallet" could post 1 and take a
   * pallet out of a warehouse for the price of a bottle.
   *
   * Only meaningful on a SELLER's line. Bulk packaging is a seller's
   * description of their own goods; the operator's own catalogue has its
   * carton and is untouched by any of this.
   */
  packageType?: PackageType | null;
  packageQuantity?: number | null;
}

/** As long as `CartItem.note`. Kept here so the refusal names the same figure. */
export const MAX_LINE_NOTE_CHARS = 500;

/**
 * An instruction as it should be stored, or null.
 *
 * Trimmed, because a box somebody tabbed through is not an instruction; capped,
 * because the column is; and null rather than '' for an empty one, so "no
 * instruction" has exactly one representation in the database.
 *
 * The cap TRUNCATES here rather than throwing. The route's schema refuses
 * anything over the limit with a message naming the field, which is where a
 * person finds out; this is the belt for the callers that do not go through
 * that schema - the ERP import and the schedule worker - where losing the tail
 * of an over-long note is better than failing an order over it.
 */
function normaliseNote(note: string | null | undefined): string | null {
  if (note === null || note === undefined) return null;
  const trimmed = note.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, MAX_LINE_NOTE_CHARS);
}

export interface AddedLine {
  itemId: string;
  productId: string;
  variantId: string | null;
  /** Pieces, as always. */
  quantity: number;
  orderingUnit: OrderingUnit;
  unitQuantity: number;
  piecesPerUnitSnapshot: number;
  /** The instruction the line now carries, after the merge rules above. */
  note: string | null;
}

/**
 * How a per-line field is named when an add is refused.
 *
 * `POST /cart/items` carries one item at the top level of its body, so
 * `variantId` is the name of the field the caller actually sent. The batch
 * route carries an array, where "which one was wrong?" is half the answer -
 * so it says `items.1.variantId`, the same shape the purchasing-limit
 * violations already use.
 */
type FieldNamer = (index: number, field: string) => string;

const PLAIN_FIELD: FieldNamer = (_index, field) => field;
const INDEXED_FIELD: FieldNamer = (index, field) => `items.${String(index)}.${field}`;

/**
 * The most options one request may add.
 *
 * A customer picking sizes off a product page reaches a handful. A request
 * claiming fifty-one is a script, and it would hold a write transaction open
 * for as many round trips.
 */
const MAX_LINES_PER_ADD = 50;

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
  const [line] = await addLines(customerProfileId, [input], PLAIN_FIELD);

  // `addLines` returns one line per distinct SKU it was given, and it was
  // given exactly one. The check is here so the caller gets a defined line
  // rather than TypeScript's `undefined` for an index it cannot prove.
  if (line === undefined) throw new Error('addLines returned nothing for a single add');

  return { itemId: line.itemId, quantity: line.quantity };
}

/**
 * Add several options of one product - or several products - in one go.
 *
 * This exists because of one thing a customer does constantly and could not do
 * until now: buy 3 ml *and* 5 ml of the same syringe. Each option is its own
 * cart line, which the unique `(cartId, productId, variantKey)` index already
 * allowed; what was missing was a way to ask for all of them at once.
 *
 * Doing it in one request rather than one per option is not an optimisation:
 *
 *   - **It is all or nothing.** A customer who chose two options, saw "added
 *     to your cart", and finds one of them there has been told a half-truth.
 *     Every line is written inside one transaction.
 *   - **It cannot split a cart in two.** `getOrCreateCart` reads for an
 *     ACTIVE cart and creates one when there is none, so two adds racing for
 *     a customer's first cart can each create one and land their line in a
 *     different basket. One request cannot race itself.
 *   - **The cart is repriced once.** Every cart read reprices from the
 *     catalogue, resolves VAT, evaluates the coupon and checks purchasing
 *     limits. Four options added one at a time is four of those.
 *
 * The same SKU twice in one request is added up rather than refused: that is
 * what a client retrying half a batch looks like, and "six" is what a customer
 * who asked for three and three meant.
 */
export async function addItems(
  customerProfileId: string,
  inputs: AddItemInput[],
): Promise<AddedLine[]> {
  return addLines(customerProfileId, inputs, INDEXED_FIELD);
}

/** One SKU's worth of a request, after validation and after de-duplication. */
interface WantedLine {
  productId: string;
  variantId: string | null;
  variantKey: string;
  sellerOfferId: string | null;
  /** `sellerOfferId`, or '' for the operator. Never null — see the schema. */
  sellerOfferKey: string;
  quantity: number;
  minOrderQty: number;
  orderingUnit: OrderingUnit;
  unitQuantity: number;
  piecesPerUnitSnapshot: number;
  /** Normalised, or null where none was given. */
  note: string | null;
  /** The bulk breakdown to freeze onto the line, or null for an ordinary one. */
  packaging: PackagingSnapshotDraft | null;
}

/**
 * Everything that gets frozen onto `CartItemPackaging`, built on the server.
 *
 * Assembled ONCE, from the seller's stored option, at the moment the buyer
 * chooses. Not re-derived on read, and not re-derived at checkout: the whole
 * value of the snapshot is that it stops meaning something different when the
 * seller edits the option tomorrow.
 */
interface PackagingSnapshotDraft {
  packageType: PackageType;
  palletStandard: string | null;
  containerType: string | null;
  containerLoadMode: string | null;
  containerLoadingMethod: string | null;
  packageQuantity: number;
  unitsPerPackage: number;
  totalBaseUnits: number;
  unitsPerCarton: number | null;
  cartonsPerPallet: number | null;
  palletsPerContainer: number | null;
  cartonsPerContainer: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  grossWeightGrams: bigint | null;
  cargoVolumeCm3: bigint | null;
  packagePriceMinor: bigint;
  unitPriceMinor: bigint;
  currency: string;
  appliedTierMinPackages: number | null;
  profileVersion: number;
  requiresFreightQuote: boolean;
}

/**
 * Turn "2 UK pallets" into a piece count and a frozen breakdown.
 *
 * The quantity goes through `resolveSellUnitQuantity` exactly as a carton or a
 * piece does - same minimum, same step, same overflow ceiling, same
 * snapshotting - because a pallet is a sell unit and this system has one
 * quantity engine.
 */
function resolveBulkLine(input: {
  option: BuyablePackagingOption;
  packageQuantity: number;
  field: string;
}): { resolved: ReturnType<typeof resolveSellUnitQuantity>; packaging: PackagingSnapshotDraft } {
  const { option } = input;

  const spec = packagingSellUnit({
    packageType: option.packageType,
    unitsPerPackage: option.unitsPerPackage,
    minimumPackages: option.minimumPackages,
    packageIncrement: option.packageIncrement,
    maximumPackages: option.maximumPackages,
  });

  const resolved = resolveSellUnitQuantity({
    spec,
    unit: spec.unit,
    unitQuantity: input.packageQuantity,
    pieces: 0,
    field: input.field,
  });

  const price = pricePackage({
    priceMode: option.priceMode,
    pricePerPackageMinor: option.pricePerPackageMinor,
    unitPriceMinor: option.offerPriceMinor,
    unitsPerPackage: option.unitsPerPackage,
    tiers: option.tiers,
    packageQuantity: resolved.unitQuantity,
  });

  /*
   * A package price that does not divide by what is in the package cannot be
   * charged correctly, and is refused rather than rounded.
   *
   * `validatePackagingOption` will not let an option reach ACTIVE in that
   * state, so this is unreachable for anything configured since the rule
   * existed. It is here for a row saved before it, and it fails CLOSED: the
   * alternative is a line whose unit price times its quantity is not the
   * package price the buyer was shown, which is a total that does not add up.
   */
  if (price.isIndivisible) {
    throw badRequest(
      ErrorCode.PACKAGING_OPTION_INCOMPLETE,
      'This packaging is priced in a way we cannot charge exactly. The seller has been asked to restate it.',
      [{ field: input.field, code: 'PRICE_NOT_DIVISIBLE' }],
    );
  }

  const breakdown = describePackaging({
    packageType: option.packageType,
    packageQuantity: resolved.unitQuantity,
    unitsPerPackage: option.unitsPerPackage,
    unitsPerCarton: option.unitsPerCarton,
    cartonsPerPallet: option.cartonsPerPallet,
    palletsPerContainer: option.palletsPerContainer,
    cartonsPerContainer: option.cartonsPerContainer,
    grossWeightGrams: option.grossWeightGrams,
    cargoVolumeCm3: option.cargoVolumeCm3,
  });

  const loadType = loadTypeForPackage(option.packageType, option.containerLoadMode);

  return {
    resolved,
    packaging: {
      packageType: option.packageType,
      palletStandard: option.palletStandard,
      containerType: option.containerType,
      containerLoadMode: option.containerLoadMode,
      containerLoadingMethod: option.containerLoadingMethod,
      packageQuantity: resolved.unitQuantity,
      unitsPerPackage: option.unitsPerPackage,
      totalBaseUnits: breakdown.totalBaseUnits,
      unitsPerCarton: option.unitsPerCarton,
      cartonsPerPallet: option.cartonsPerPallet,
      palletsPerContainer: option.palletsPerContainer,
      cartonsPerContainer: option.cartonsPerContainer,
      lengthMm: option.lengthMm,
      widthMm: option.widthMm,
      heightMm: option.heightMm,
      grossWeightGrams: option.grossWeightGrams,
      cargoVolumeCm3: option.cargoVolumeCm3,
      packagePriceMinor: price.packagePriceMinor,
      unitPriceMinor: price.effectiveUnitPriceMinor,
      currency: option.currency,
      appliedTierMinPackages: price.appliedTierMinPackages,
      profileVersion: option.profileVersion,
      requiresFreightQuote: price.requiresQuote || needsManualFreight(loadType),
    },
  };
}

async function addLines(
  customerProfileId: string,
  inputs: AddItemInput[],
  nameField: FieldNamer,
): Promise<AddedLine[]> {
  if (inputs.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Choose something to add to the cart.', [
      { field: 'items', code: 'REQUIRED' },
    ]);
  }

  if (inputs.length > MAX_LINES_PER_ADD) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      `Add at most ${String(MAX_LINES_PER_ADD)} options at a time.`,
      [{ field: 'items', code: 'TOO_MANY' }],
    );
  }

  for (const [index, input] of inputs.entries()) {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Quantity must be a positive whole number.', [
        { field: nameField(index, 'quantity'), code: 'INVALID' },
      ]);
    }
  }

  // Two queries for the whole request rather than two per line. The products
  // are looked up through `publicProductWhere()`, so an unpublished one is
  // simply absent from the result and refused below.
  const products = await prisma.product.findMany({
    where: {
      ...publicProductWhere(),
      id: { in: [...new Set(inputs.map((input) => input.productId))] },
    },
    select: {
      id: true,
      hasVariants: true,
      minOrderQty: true,
      // Visible is not the same as sellable. See purchasability.ts.
      isPriceOnRequest: true,
      isOrderable: true,
      unavailabilityReason: true,
      /*
       * Whose product this is, which decides whether a line needs an offer.
       *
       * A product a SELLER described has no price of the operator's own - what
       * the shopper was shown in the grid is a projection of the cheapest live
       * offer. So a line for one has to carry that offer, or it would be
       * charged against a price row nobody is selling at, settle against
       * nobody, and never reach the seller who has to pack it.
       */
      isMarketplaceProduct: true,

      /**
       * How many pieces one unit of this line holds, or null for a piece.
       *
       * Selected here so the basket reads the same column the storefront put
       * on the page. Working it out from a deployment setting instead is how a
       * shopper is quoted one figure and charged another - which is precisely
       * what happened while the carton was a property of the shop rather than
       * of the product.
       */
      piecesPerCarton: true,
    },
  });
  const productById = new Map(products.map((product) => [product.id, product]));

  const variantIds = [
    ...new Set(
      inputs
        .map((input) => input.variantId)
        .filter((variantId): variantId is string => variantId !== null && variantId !== undefined),
    ),
  ];

  const variants =
    variantIds.length === 0
      ? []
      : await prisma.productVariant.findMany({
          where: { id: { in: variantIds }, isActive: true, archivedAt: null },
          select: { id: true, productId: true },
        });
  const variantById = new Map(variants.map((variant) => [variant.id, variant]));

  /*
   * The currency this basket will be priced in.
   *
   * Read once for the whole request, and it is the same function `resolveCart`
   * uses - so the offer bound to a marketplace line below is one priced in the
   * currency the line is about to be shown and charged in. Choosing the
   * cheapest offer across currencies would compare 40000 with 500 and pick the
   * euro over the rupee, which is the conversion this system does not do.
   */
  const cartCurrency = await resolveCurrency(customerProfileId);

  // Keyed by SKU, so the same option twice in one request is one line.
  const wanted = new Map<string, WantedLine>();

  for (const [index, input] of inputs.entries()) {
    const product = productById.get(input.productId);

    // Covers both "no such product" and "not published". The customer must not
    // be able to tell those apart.
    if (product === undefined) throw notFound('Product');

    // Published, and still not for sale - a price quoted per account, or a
    // product the operator is holding. Refused here rather than at checkout, so
    // nobody discovers it three screens later with a full basket.
    assertPurchasable(product, nameField(index, 'productId'));

    const variantId = input.variantId ?? null;

    if (variantId !== null) {
      const variant = variantById.get(variantId);

      // The variant has to belong to the product named on the same line - an
      // active variant id of some other product is still the wrong option.
      if (variant === undefined || variant.productId !== product.id) {
        throw badRequest(
          ErrorCode.VARIANT_MISMATCH,
          'That option is not available for this product.',
          [{ field: nameField(index, 'variantId'), code: 'NOT_FOUND' }],
        );
      }
    } else if (product.hasVariants) {
      throw badRequest(
        ErrorCode.VARIANT_MISMATCH,
        'Choose an option before adding this to the cart.',
        [{ field: nameField(index, 'variantId'), code: 'REQUIRED' }],
      );
    }

    const variantKey = variantKeyOf(variantId);

    /*
     * Whose offer, where one was named.
     *
     * Checked against the product and the variant on the same line, not just
     * fetched: an offer id belonging to somebody else's product would otherwise
     * put that seller's name — and that seller's commission — on a line for a
     * product they do not sell. It must also be on sale, for the same reason a
     * paused listing does not appear in search.
     */
    const namedOfferId = input.sellerOfferId ?? null;
    let offerTerms: OfferSellTerms | null = null;

    if (namedOfferId !== null) {
      const offer = await prisma.sellerOffer.findUnique({
        where: { id: namedOfferId },
        select: { ...OFFER_SELL_TERMS, productId: true, variantKey: true, status: true },
      });

      if (offer === null || offer.productId !== product.id || offer.variantKey !== variantKey) {
        throw badRequest(
          ErrorCode.VALIDATION_FAILED,
          'That seller does not offer this product.',
          [{ field: nameField(index, 'sellerOfferId'), code: 'NOT_FOUND' }],
        );
      }

      if (offer.status !== 'ACTIVE') {
        throw badRequest(
          ErrorCode.VALIDATION_FAILED,
          'That seller is not selling this at the moment.',
          [{ field: nameField(index, 'sellerOfferId'), code: 'NOT_ON_SALE' }],
        );
      }

      offerTerms = offer;
    } else if (product.isMarketplaceProduct) {
      /*
       * Nobody named one, and the product is a seller's: pick it here.
       *
       * Resolved on the SERVER rather than sent by the browser, which is the
       * decision worth keeping. Every existing way into a basket - a product
       * card, a reorder, AI Mode, a scheduled basket - then works on a
       * marketplace product without any of them learning that marketplaces
       * exist, and there is no request shape in which a client can nominate an
       * offer it was never shown.
       *
       * The cheapest live one, because that is the figure the grid and the
       * product page both showed them: the price row they were quoted from is a
       * projection of exactly this offer. Picking any other would charge them
       * something other than what they read.
       */
      offerTerms = await cheapestOfferFor(prisma, product.id, variantKey, cartCurrency);
    }

    const sellerOfferId = offerTerms?.id ?? null;

    /*
     * A marketplace product with no live offer is not for sale by anybody.
     *
     * Refused here rather than allowed through to be priced off a stale row.
     * It is reachable at all only in the seconds between a seller pausing their
     * last offer and the shelf being rebuilt, or by a direct link to a page
     * somebody had open.
     */
    if (product.isMarketplaceProduct && sellerOfferId === null) {
      throw badRequest(
        ErrorCode.CART_ITEM_UNAVAILABLE,
        'Nobody is selling this at the moment.',
        [{ field: nameField(index, 'productId'), code: 'NO_LIVE_OFFER' }],
      );
    }

    /*
     * What this line is counted in, decided by WHO IS SELLING IT.
     *
     * The offer had to be resolved first, and that ordering is the fix rather
     * than an incidental tidy-up: deciding "how many pieces is this" before
     * knowing whose line it is can only ever produce the operator's answer,
     * and the operator's answer on a seller's line multiplies their price by
     * the carton.
     *
     * A seller's offer is counted in pieces at their own minimum and step. The
     * operator's line is counted in cartons at this deployment's carton size,
     * exactly as before - the sheet's own packing still describes the product
     * on the page; it does not decide what a carton is.
     */
    /*
     * A BULK line takes the whole of the rest of this block over.
     *
     * A buyer who chose a package has chosen a seller's own configured unit,
     * and everything below - the named-unit check, the minimum, the step -
     * belongs to that option rather than to the offer's piece terms. So it is
     * resolved here and the loop moves on, rather than falling through code
     * that would price a pallet as a piece.
     *
     * Refused where there is no seller, because bulk packaging is a SELLER's
     * description of their own goods. The operator's catalogue has its carton,
     * which is a different thing configured in a different place, and letting
     * a `packageType` through onto an operator line would ask the seller's
     * option table a question about a product no seller sells.
     */
    const chosenPackage = input.packageType ?? null;

    if (chosenPackage !== null) {
      if (sellerOfferId === null) {
        throw badRequest(
          ErrorCode.PACKAGING_OPTION_NOT_AVAILABLE,
          'Bulk packaging is offered by sellers, and this is not a seller listing.',
          [{ field: nameField(index, 'packageType'), code: 'NOT_A_SELLER_LINE' }],
        );
      }

      const option = await loadBuyableOption(sellerOfferId, chosenPackage);

      const bulk = resolveBulkLine({
        option,
        packageQuantity: input.packageQuantity ?? 1,
        field: nameField(index, 'packageQuantity'),
      });

      // Whole packages only, and checked against the offer's own stock rather
      // than the operator's - a seller's goods are in a seller's warehouse.
      // Part of a pallet is not something anybody can pick, so the refusal
      // names how many COMPLETE ones there are.
      const whole = wholePackagesAvailable(option.availableQuantity, option.unitsPerPackage);
      if (whole < bulk.resolved.unitQuantity) {
        throw badRequest(
          ErrorCode.PACKAGING_INSUFFICIENT_FOR_PACKAGE,
          whole === 0
            ? 'There is not enough stock for a complete package of this size.'
            : `Only ${String(whole)} complete packages of this size are available.`,
          [
            {
              field: nameField(index, 'packageQuantity'),
              code: 'INSUFFICIENT_WHOLE_PACKAGES',
              meta: { wholePackagesAvailable: whole, requested: bulk.resolved.unitQuantity },
            },
          ],
        );
      }

      const bulkKey = `${product.id}:${variantKey}:${sellerOfferId}`;
      const already = wanted.get(bulkKey);

      // The same package twice in one request adds the package counts up, on
      // the same reasoning as every other line: a client retrying half a batch
      // resends what it already sent, and "four pallets" is what somebody who
      // asked for two and two meant.
      if (already?.packaging !== undefined && already.packaging !== null && already.packaging.packageType !== chosenPackage) {
        throw badRequest(
          ErrorCode.PACKAGING_UNIT_MISMATCH,
          'Two different packages of the same listing cannot be added as one line.',
          [
            {
              field: nameField(index, 'packageType'),
              code: 'UNIT_MISMATCH',
              meta: { expected: already.packaging.packageType, received: chosenPackage },
            },
          ],
        );
      }

      const packageQuantity =
        (already?.packaging?.packageQuantity ?? 0) + bulk.packaging.packageQuantity;

      wanted.set(bulkKey, {
        productId: product.id,
        variantId,
        variantKey,
        sellerOfferId,
        sellerOfferKey: sellerOfferId,
        quantity: (already?.quantity ?? 0) + bulk.resolved.quantity,
        minOrderQty: product.minOrderQty,
        orderingUnit: bulk.resolved.orderingUnit,
        unitQuantity: packageQuantity,
        piecesPerUnitSnapshot: bulk.resolved.piecesPerUnitSnapshot,
        note: already?.note ?? normaliseNote(input.note),
        packaging: {
          ...bulk.packaging,
          packageQuantity,
          totalBaseUnits: packageQuantity * bulk.packaging.unitsPerPackage,
        },
      });

      continue;
    }

    const spec =
      offerTerms === null
        ? // The PRODUCT's carton, which is the same figure the storefront put
          // on the page - one column, read by both, so the quote and the
          // charge cannot drift apart. Null there means a piece, which is what
          // most of a general catalogue is.
          operatorSellUnit(product)
        : sellerSellUnit(offerTerms);

    /*
     * A shopper may NAME the unit, and on a basket add it has to be the unit
     * the line is actually sold in.
     *
     * Checked here rather than in the route, because the route cannot know:
     * whose offer is selling this line is decided a few lines above, from the
     * product and the shop front, and the unit follows from that. A schema
     * that allowed only the carton refused every marketplace add outright -
     * the storefront correctly names `PIECE` on a seller's line - and one
     * that allowed both would let a carton request through onto a piece
     * offer.
     *
     * Refused rather than reinterpreted, in both directions:
     *
     *   - A seller's piece offer asked for by the carton would hand the
     *     shopper five hundred pieces at the price of one. `resolveSellUnitQuantity`
     *     refuses that too, for every caller and not only this one; it is
     *     named here so one place describes the whole rule.
     *   - The operator's carton asked for by the piece is a request to buy
     *     something this shop does not sell, and is told so rather than handed
     *     a carton it did not ask for.
     *
     * Naming NOTHING is untouched, and is still the documented route for an
     * ERP or API client that counts in pieces: say the number, say nothing
     * about the unit, and the server takes it up to whole sell units.
     */
    const namedUnit = input.orderingUnit ?? null;

    if (namedUnit !== null && namedUnit !== spec.unit) {
      const detail = [
        {
          field: nameField(index, 'orderingUnit'),
          code: 'UNIT_MISMATCH',
          meta: { expected: spec.unit, received: namedUnit },
        },
      ];

      throw spec.unit === SELLER_SELLING_UNIT
        ? badRequest(
            ErrorCode.SELLER_OFFER_UNIT_MISMATCH,
            'This seller sells this by the piece. Choose a number of pieces.',
            detail,
          )
        : badRequest(
            ErrorCode.VALIDATION_FAILED,
            'This shop sells this by the carton. Choose a number of cartons.',
            detail,
          );
    }

    const resolved = resolveSellUnitQuantity({
      spec,
      unit: input.orderingUnit,
      unitQuantity: input.unitQuantity,
      pieces: input.quantity,
      field: nameField(index, 'unitQuantity'),
    });

    // The offer is part of the key: the same product from two sellers is two
    // basket lines, because they are two things to buy at two prices out of two
    // warehouses. Same rule the unique index enforces.
    const key = `${product.id}:${variantKey}:${sellerOfferId ?? ''}`;
    const already = wanted.get(key);

    // A bulk line and a loose one for the same SKU are one row in the basket,
    // and they cannot both be true of it. Refused rather than merged: adding
    // 40 pieces onto a two-pallet line and calling the result "2 pallets" is a
    // line that says one thing and holds another.
    if (already?.packaging !== undefined && already.packaging !== null) {
      throw badRequest(
        ErrorCode.PACKAGING_UNIT_MISMATCH,
        'This listing is already in your basket by the package. Change that line instead.',
        [
          {
            field: nameField(index, 'quantity'),
            code: 'UNIT_MISMATCH',
            meta: { expected: already.packaging.packageType, received: 'LOOSE' },
          },
        ],
      );
    }

    wanted.set(key, {
      productId: product.id,
      variantId,
      variantKey,
      sellerOfferId,
      sellerOfferKey: sellerOfferId ?? '',
      quantity: (already?.quantity ?? 0) + resolved.quantity,
      minOrderQty: product.minOrderQty,
      // The same SKU twice in one request adds the cartons up into one line.
      orderingUnit: already?.orderingUnit ?? resolved.orderingUnit,
      unitQuantity: (already?.unitQuantity ?? 0) + resolved.unitQuantity,
      piecesPerUnitSnapshot: already?.piecesPerUnitSnapshot ?? resolved.piecesPerUnitSnapshot,
      /*
       * The same SKU twice in one request keeps the FIRST instruction that
       * said anything.
       *
       * Not concatenated: two instructions joined end to end make a sentence
       * neither person wrote, and this is read by somebody picking an order.
       * Not last-one-wins either: a client retrying half a batch resends the
       * lines it already sent, and the retry commonly carries no note, so
       * last-one-wins would silently erase the instruction the first attempt
       * recorded. First non-empty is the only one of the three that cannot
       * lose something the buyer typed.
       */
      note: already?.note ?? normaliseNote(input.note),
      // An ordinary line, counted loose. Bulk lines take the branch above and
      // never reach here.
      packaging: null,
    });
  }

  const cartId = await getOrCreateCart(customerProfileId);

  return prisma.$transaction(async (tx) => {
    const added: AddedLine[] = [];

    for (const line of wanted.values()) {
      // Re-adding an option already in the cart increases its quantity rather
      // than creating a second line, which is what the unique
      // (cartId, productId, variantKey, sellerOfferKey) index enforces anyway.
      // The same product from a different seller is a different line.
      const existing = await tx.cartItem.findUnique({
        where: {
          cartId_productId_variantKey_sellerOfferKey: {
            cartId,
            productId: line.productId,
            variantKey: line.variantKey,
            sellerOfferKey: line.sellerOfferKey,
          },
        },
        include: { packaging: true },
      });

      /*
       * A basket line is EITHER loose or a package, and never becomes the
       * other.
       *
       * The three refusals below all guard one thing: the line's
       * `piecesPerUnitSnapshot` is what the whole basket reads to say how much
       * is in it, and merging a pallet add onto a piece line - or the reverse -
       * would leave that number describing one of the two adds and not the
       * line. The existing code already refuses to let a line change unit
       * silently, for the same reason and in the same words: "a basket line
       * silently changing from cartons to pieces because the second add was
       * typed differently is a line the buyer stops trusting".
       *
       * The way out for the buyer is always the same and always available:
       * change or remove the line that is there. Nothing is lost.
       */
      if (existing !== null) {
        const existingPackaging = existing.packaging;

        if (line.packaging !== null && existingPackaging === null) {
          throw badRequest(
            ErrorCode.PACKAGING_UNIT_MISMATCH,
            'This listing is already in your basket as loose units. Remove that line to order it by the package.',
            [{ field: 'packageType', code: 'LINE_IS_LOOSE' }],
          );
        }

        if (line.packaging === null && existingPackaging !== null) {
          throw badRequest(
            ErrorCode.PACKAGING_UNIT_MISMATCH,
            'This listing is already in your basket by the package. Change that line instead.',
            [
              {
                field: 'quantity',
                code: 'LINE_IS_PACKAGED',
                meta: { packageType: existingPackaging.packageType },
              },
            ],
          );
        }

        if (
          line.packaging !== null &&
          existingPackaging !== null &&
          existingPackaging.packageType !== line.packaging.packageType
        ) {
          throw badRequest(
            ErrorCode.PACKAGING_UNIT_MISMATCH,
            'That is a different package from the one already in your basket for this listing.',
            [
              {
                field: 'packageType',
                code: 'UNIT_MISMATCH',
                meta: {
                  expected: existingPackaging.packageType,
                  received: line.packaging.packageType,
                },
              },
            ],
          );
        }

        /*
         * The seller re-specified the package while it sat in the basket.
         *
         * SAID rather than applied. The snapshot has not moved, so the line
         * still holds what the shopper agreed to - and quietly adding two more
         * pallets at the NEW size onto a line holding two at the OLD one would
         * give a single line two different pallets in it, with one
         * `unitsPerPackage` describing both.
         *
         * The meta carries both figures so the basket can show the difference
         * and offer to start again at the new one.
         */
        if (
          line.packaging !== null &&
          existingPackaging !== null &&
          existingPackaging.unitsPerPackage !== line.packaging.unitsPerPackage
        ) {
          throw conflict(
            ErrorCode.PACKAGING_SNAPSHOT_STALE,
            'The seller has changed what is in one of these packages since you added it. Remove the line and add it again to order at the new size.',
            [
              {
                field: 'packageQuantity',
                code: 'SNAPSHOT_STALE',
                meta: {
                  snapshotUnitsPerPackage: existingPackaging.unitsPerPackage,
                  currentUnitsPerPackage: line.packaging.unitsPerPackage,
                },
              },
            ],
          );
        }
      }

      if (existing !== null) {
        const quantity = existing.quantity + line.quantity;
        // The line keeps the unit it already had; only the counts move. A
        // basket line silently changing from cartons to pieces because the
        // second add was typed differently is a line the buyer stops trusting.
        const unitQuantity =
          existing.orderingUnit === line.orderingUnit
            ? existing.unitQuantity + line.unitQuantity
            : Math.round(quantity / Math.max(existing.piecesPerUnitSnapshot, 1));

        /*
         * A NEW instruction replaces the one on the line; no instruction
         * leaves it alone.
         *
         * Adding the same product a second time from the product page, having
         * typed something in the box, has to reach the line - otherwise the
         * buyer types an instruction, presses Add, and nothing they can see
         * says it was ignored. Adding it again from somewhere with no box at
         * all - a saved list, a reorder, the AI assistant - must not wipe what
         * they typed a minute ago, which is what writing `line.note` through
         * unconditionally would do.
         */
        const note = line.note ?? existing.note;

        await tx.cartItem.update({
          where: { id: existing.id },
          data: { quantity, unitQuantity, note },
        });

        /*
         * The breakdown moves with the counts.
         *
         * Only the COUNTS. Everything describing what one package is -
         * `unitsPerPackage`, the dimensions, the price, the profile version -
         * stays exactly as it was frozen, because the guards above have
         * already established that this add is the same package at the same
         * size. A snapshot rewritten here would be a snapshot of the add
         * rather than of the agreement, which is the one thing it must not be.
         */
        if (line.packaging !== null && existing.packaging !== null) {
          await tx.cartItemPackaging.update({
            where: { cartItemId: existing.id },
            data: {
              packageQuantity: unitQuantity,
              totalBaseUnits: unitQuantity * existing.packaging.unitsPerPackage,
            },
          });
        }

        added.push({
          itemId: existing.id,
          productId: line.productId,
          variantId: line.variantId,
          quantity,
          orderingUnit: existing.orderingUnit,
          unitQuantity,
          piecesPerUnitSnapshot: existing.piecesPerUnitSnapshot,
          note,
        });
        continue;
      }

      /*
       * A brand-new line starts at the product minimum when the request asks
       * for less - a B2B product with a minimum of 10 should not sit in the
       * cart at 1 and fail only at checkout.
       *
       * The minimum is written in pieces and the shop ships whole cartons, so
       * a minimum that lands mid-carton takes the whole carton above it.
       *
       * ONLY on the operator's line. A seller's line has already been raised
       * to the SELLER's own minimum and step, in pieces, by
       * `resolveSellUnitQuantity` - and `product.minOrderQty` is the operator's
       * figure for a product the operator is not the one selling. Applying it
       * here would let the operator's "minimum 1,000" silently overrule a
       * seller who accepts five.
       */
      const perCarton = Math.max(1, line.piecesPerUnitSnapshot);
      const quantity =
        line.sellerOfferId !== null
          ? line.quantity
          : line.orderingUnit === SELLING_UNIT
            ? cartonsForPieces(Math.max(line.quantity, line.minOrderQty), perCarton) * perCarton
            : Math.max(line.quantity, line.minOrderQty);
      const itemId = newId();

      // If the minimum raised the piece count, the carton count has to follow
      // it or the line would read "1 carton" beside a quantity of a thousand.
      //
      // A bulk line never takes that branch: it is a seller's line, so the
      // operator's minimum is not applied to it above, and `quantity` is
      // therefore exactly what the package arithmetic produced. Its package
      // count must NOT be re-derived by `cartonsForPieces`, which knows
      // nothing about pallets.
      const unitQuantity =
        line.packaging !== null
          ? line.packaging.packageQuantity
          : quantity === line.quantity
            ? line.unitQuantity
            : cartonsForPieces(quantity, perCarton);

      await tx.cartItem.create({
        data: {
          id: itemId,
          cartId,
          productId: line.productId,
          variantId: line.variantId,
          variantKey: line.variantKey,
          sellerOfferId: line.sellerOfferId,
          // Never null, and always the same value as the column above. See the
          // schema: MariaDB's UNIQUE index treats NULLs as distinct, so the
          // nullable column alone cannot be part of the key that makes
          // re-adding a SKU bump its quantity.
          sellerOfferKey: line.sellerOfferKey,
          quantity,
          orderingUnit: line.orderingUnit,
          unitQuantity,
          piecesPerUnitSnapshot: line.piecesPerUnitSnapshot,
          note: line.note,
        },
      });

      // The frozen breakdown, written in the same transaction as the line it
      // describes. A line without its snapshot would be a pallet count nothing
      // could explain; a snapshot without its line would be an orphan the
      // basket never shows.
      if (line.packaging !== null) {
        await tx.cartItemPackaging.create({
          data: {
            id: newId(),
            cartItemId: itemId,
            packageType: line.packaging.packageType,
            palletStandard: line.packaging.palletStandard as never,
            containerType: line.packaging.containerType as never,
            containerLoadMode: line.packaging.containerLoadMode as never,
            containerLoadingMethod: line.packaging.containerLoadingMethod as never,
            packageQuantity: line.packaging.packageQuantity,
            unitsPerPackage: line.packaging.unitsPerPackage,
            totalBaseUnits: line.packaging.totalBaseUnits,
            unitsPerCarton: line.packaging.unitsPerCarton,
            cartonsPerPallet: line.packaging.cartonsPerPallet,
            palletsPerContainer: line.packaging.palletsPerContainer,
            cartonsPerContainer: line.packaging.cartonsPerContainer,
            lengthMm: line.packaging.lengthMm,
            widthMm: line.packaging.widthMm,
            heightMm: line.packaging.heightMm,
            grossWeightGrams: line.packaging.grossWeightGrams,
            cargoVolumeCm3: line.packaging.cargoVolumeCm3,
            packagePriceMinor: line.packaging.packagePriceMinor,
            unitPriceMinor: line.packaging.unitPriceMinor,
            currency: line.packaging.currency,
            appliedTierMinPackages: line.packaging.appliedTierMinPackages,
            profileVersion: line.packaging.profileVersion,
            requiresFreightQuote: line.packaging.requiresFreightQuote,
          },
        });
      }

      added.push({
        itemId,
        productId: line.productId,
        variantId: line.variantId,
        quantity,
        orderingUnit: line.orderingUnit,
        unitQuantity,
        piecesPerUnitSnapshot: line.piecesPerUnitSnapshot,
        note: line.note,
      });
    }

    return added;
  });
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

  /*
   * A seller's line is stepped by the SELLER's terms.
   *
   * Re-read rather than taken from the line, because the seller may have
   * raised their minimum since it was added, and the basket is where the
   * buyer finds that out rather than at checkout. Their offer decides the
   * minimum and the step; the operator's carton has nothing to do with it.
   */
  const spec = await sellUnitSpecForItem(item);

  const resolved = resolveSellUnitQuantity({
    spec,
    // Pieces, named as such. On a seller's line that IS the sell unit; on the
    // operator's it is rounded up to whole cartons exactly as before.
    unit: null,
    unitQuantity: null,
    pieces: quantity,
    field: 'quantity',
  });

  await prisma.cartItem.update({
    where: { id: itemId },
    data: { quantity: resolved.quantity, unitQuantity: resolved.unitQuantity },
  });

  await syncPackagingCounts(itemId, resolved.unitQuantity);
}

/**
 * Keep a bulk line's frozen breakdown in step with its counts.
 *
 * Only the COUNTS move. `unitsPerPackage`, the dimensions, the weights, the
 * price and the profile version are what the buyer agreed to and stay exactly
 * as frozen - changing a quantity is not agreeing to a different pallet.
 *
 * `totalBaseUnits` is rewritten because the database CHECK requires it to
 * equal `packageQuantity x unitsPerPackage`, and that constraint is the last
 * line of defence against a line whose breakdown does not add up to its own
 * quantity. A no-op on an ordinary line, which is most of them.
 */
async function syncPackagingCounts(cartItemId: string, packageQuantity: number): Promise<void> {
  const snapshot = await prisma.cartItemPackaging.findUnique({
    where: { cartItemId },
    select: { unitsPerPackage: true },
  });

  if (snapshot === null) return;

  await prisma.cartItemPackaging.update({
    where: { cartItemId },
    data: {
      packageQuantity,
      totalBaseUnits: packageQuantity * snapshot.unitsPerPackage,
    },
  });
}

/**
 * What an existing basket line is counted in.
 *
 * Read from the OFFER where there is one, and from the line's own snapshot
 * where there is not. The two disagree only for a seller who has changed their
 * terms since the line was added, and in that case the seller's current terms
 * are the ones that can actually be fulfilled.
 *
 * A line whose offer has vanished falls back to its snapshot rather than
 * throwing: the basket still has to render, and `resolveCart` is what tells
 * the buyer the line can no longer be bought.
 */
async function sellUnitSpecForItem(item: {
  id?: string;
  sellerOfferId: string | null;
  orderingUnit: OrderingUnit;
  piecesPerUnitSnapshot: number;
}): Promise<SellUnitSpec> {
  /*
   * A BULK line is stepped by PACKAGES, and never by the offer's piece terms.
   *
   * This is checked first, and the ordering is the fix rather than a tidy-up.
   * `sellerSellUnit` below reads the OFFER's `orderingUnit`, which for a
   * seller is always PIECE - packaging lives in its own table and does not
   * touch that column. So without this branch a pallet line would be stepped
   * as though one pallet were one piece, and the buyer pressing "+" would add
   * a single unit to a line measured in thousands.
   *
   * The snapshot is the authority for the SIZE, because that is what the
   * buyer agreed to. The seller's live option supplies only the minimum, the
   * step and the ceiling - the terms they can actually pick and pack today.
   */
  if (item.id !== undefined) {
    const snapshot = await prisma.cartItemPackaging.findUnique({
      where: { cartItemId: item.id },
      select: { packageType: true, unitsPerPackage: true },
    });

    if (snapshot !== null) {
      const live =
        item.sellerOfferId === null
          ? null
          : await prisma.sellerPackagingOption.findFirst({
              where: {
                packageType: snapshot.packageType,
                profile: { offerId: item.sellerOfferId },
              },
              select: { minimumPackages: true, packageIncrement: true, maximumPackages: true },
            });

      return packagingSellUnit({
        packageType: snapshot.packageType,
        unitsPerPackage: snapshot.unitsPerPackage,
        minimumPackages: live?.minimumPackages ?? 1,
        packageIncrement: live?.packageIncrement ?? 1,
        maximumPackages: live?.maximumPackages ?? null,
      });
    }
  }

  if (item.sellerOfferId !== null) {
    const offer = await prisma.sellerOffer.findUnique({
      where: { id: item.sellerOfferId },
      select: OFFER_SELL_TERMS,
    });

    if (offer !== null) return sellerSellUnit(offer);
  }

  return {
    unit: item.orderingUnit,
    piecesPerUnit: Math.max(1, item.piecesPerUnitSnapshot),
    minimumOrderQuantity: 1,
    orderIncrement: 1,
    maximumOrderQuantity: null,
  };
}

/**
 * Change a line by the pack, rather than by the piece.
 *
 * Separate from `updateItemQuantity` on purpose: this one is authoritative
 * about packs and derives the pieces, and that one is authoritative about
 * pieces and derives the packs. A single function taking both would have to
 * decide which to believe when they disagree, and whichever it chose would be
 * wrong for one of the two screens that calls it.
 *
 * On a seller's piece line the two are the same number, and the screen that
 * calls this is the quantity stepper - so the seller's minimum and step apply
 * here just as they do there.
 */
export async function updateItemPackQuantity(
  customerProfileId: string,
  itemId: string,
  unitQuantity: number,
): Promise<void> {
  if (!Number.isInteger(unitQuantity) || unitQuantity < 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Choose a whole number of packs.', [
      { field: 'unitQuantity', code: 'INVALID' },
    ]);
  }

  const cartId = await getOrCreateCart(customerProfileId);
  const item = await prisma.cartItem.findFirst({ where: { id: itemId, cartId } });
  if (item === null) throw notFound('Cart item');

  if (unitQuantity === 0) {
    await prisma.cartItem.delete({ where: { id: itemId } });
    return;
  }

  const spec = await sellUnitSpecForItem(item);

  const resolved = resolveSellUnitQuantity({
    spec,
    unit: spec.unit,
    unitQuantity,
    pieces: 0,
    field: 'unitQuantity',
  });

  await prisma.cartItem.update({
    where: { id: itemId },
    data: { unitQuantity: resolved.unitQuantity, quantity: resolved.quantity },
  });

  await syncPackagingCounts(itemId, resolved.unitQuantity);
}

/**
 * Change - or clear - the special instruction on one basket line.
 *
 * Its own endpoint rather than a field on the quantity update, and the reason
 * is the same one that keeps `updateItemQuantity` and `updateItemPackQuantity`
 * apart: a function taking both has to decide what an absent field means, and
 * there is no answer that is right for both callers. "Absent means leave it
 * alone" loses the buyer's ability to clear the box; "absent means clear it"
 * wipes the instruction every time somebody presses the quantity stepper.
 *
 * Here the field is the whole request, so `null` unambiguously means "I have
 * cleared this" and nothing else can be said by accident.
 *
 * Scoped by `cartId` like every other line operation, so an item id from
 * somebody else's basket is a 404 rather than something to edit. That is the
 * authorisation, and it is the only one needed: the cart id comes from the
 * session, never from the request.
 */
export async function updateItemNote(
  customerProfileId: string,
  itemId: string,
  note: string | null,
): Promise<{ note: string | null }> {
  const cartId = await getOrCreateCart(customerProfileId);

  const item = await prisma.cartItem.findFirst({
    where: { id: itemId, cartId },
    select: { id: true },
  });
  if (item === null) throw notFound('Cart item');

  const stored = normaliseNote(note);

  await prisma.cartItem.update({ where: { id: itemId }, data: { note: stored } });

  // Returned rather than assumed, so the box on screen shows what was actually
  // kept - trimmed, and null where it was only whitespace.
  return { note: stored };
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

  // Blocking issues only. A line notice that is explicitly non-blocking - a
  // container order whose delivery is quoted rather than priced - is something
  // the buyer is TOLD, not something that stops them. See `CartLineIssue`.
  const lineIssues = resolved.lines.flatMap((line, index) =>
    line.issues
      .filter((issue) => issue.isBlocking !== false)
      .map((issue) => ({
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
