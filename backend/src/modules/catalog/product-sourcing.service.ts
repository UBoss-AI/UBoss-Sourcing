/**
 * What a product page tells a buyer beyond the price (checklist Master row 4):
 * **who sells it, can it come to me, how soon, and will it be inspected.**
 *
 * Everything here is read from facts the system holds, never assumed:
 *
 *   - **Seller.** The seller whose offer the basket will bind - the same offer
 *     the page is priced from - and only if the operator approved them. A
 *     product with no seller offer is sold by the marketplace itself (null).
 *   - **Delivery to the destination.** In this order: a BLOCK market rule on
 *     the product or any category above it; a seller who has listed the
 *     countries they sell to and this is not one; a DOCUMENTS_REQUIRED rule.
 *     With no destination chosen the answer is "choose a country", never a
 *     guess.
 *   - **Lead time and origin.** The offer's own handling time and declared
 *     country of origin, when the seller stated them.
 *   - **Inspection before dispatch.** The operator's inspection rules, applied
 *     the way the dispatch gate applies them (`domain/inspection-rules.ts`),
 *     for this category, destination and seller. The page cannot know the
 *     order value yet, so a rule with a value threshold is reported as
 *     "from this amount" rather than as a yes or a no. A risk-triggered rule
 *     is judged against this supplier's current risk. Inspection applies to
 *     a seller's goods; the marketplace's own stock is not gated.
 */
import type { MarketRuleEffect, SellerKind } from '../../generated/prisma/client.js';
import { publicListingSourcing } from '../seller/listing-sourcing.service.js';
import { prisma } from '../../infra/prisma.js';
import { ruleMatches, type OrderFacts } from '../../domain/inspection-rules.js';
import { activeRules, supplierRiskOf } from '../inspection/gate.service.js';
import { readPolicy } from '../inspection/context.js';
import { productMarketNotes } from './market-eligibility.service.js';
import { SELLABLE_SELLER } from './marketplace-price.service.js';
import { env } from '../../config/env.js';
import { sellerScore } from './product-review.service.js';
import { inspectionSummaryFor } from './supplier-profile.service.js';

export type DeliveryStatus =
  | 'AVAILABLE'
  | 'DOCUMENTS_REQUIRED'
  | 'BLOCKED'
  | 'SELLER_DOES_NOT_DELIVER'
  | 'CHOOSE_DESTINATION';

export type InspectionOutlook =
  | 'REQUIRED'
  | 'REQUIRED_FROM_VALUE'
  | 'DEPENDS_ON_DESTINATION'
  | 'NOT_REQUIRED'
  | 'NOT_APPLICABLE';

export interface ProductSourcing {
  seller: {
    slug: string;
    displayName: string;
    kind: SellerKind;
    registrationCountry: string;
    verifiedAt: string | null;
    /**
     * Buyers' rating of this seller's delivery and support across everything
     * it sold (JOURNEY-059); null with no reviews or reviews switched off.
     */
    reviewScore: { average: number; count: number } | null;
    /**
     * Signed inspections on this seller's orders in the last twelve months.
     * Shown beside the rating and never averaged into it.
     */
    inspectionSummary: { months: number; reports: number; passed: number; failed: number } | null;
  } | null;
  destination: string | null;
  delivery: {
    status: DeliveryStatus;
    notes: { effect: MarketRuleEffect; reason: string; requiredDocuments: string[]; labelText: string | null }[];
  };
  handlingTimeDays: number | null;
  countryOfOrigin: string | null;
  /** What the seller can make: units a week and the lead time at that rate. */
  capacity: { unitsPerWeek: number | null; leadTimeDays: number | null } | null;
  /** The listed seller's sourcing terms on this product (JOURNEY-004). Null when not stated. */
  terms: Awaited<ReturnType<typeof publicListingSourcing>>;
  inspection: {
    outlook: InspectionOutlook;
    /** For REQUIRED_FROM_VALUE: the lowest threshold, minor units as a string. */
    fromValueMinor: string | null;
    currency: string | null;
  };
}

/** Large enough to meet any threshold; used to ask "could a rule apply at all?". */
const ANY_VALUE = 10n ** 18n;

export async function productSourcingFor(input: {
  productId: string;
  categoryId: string;
  /** The offer the page is priced from, when it has one. */
  offerId: string | null;
  /** A product sold through sellers' offers rather than the marketplace's stock. */
  isMarketplaceProduct: boolean;
  destination: string | null;
  currency: string;
}): Promise<ProductSourcing> {
  /*
   * Which offer the basket would bind. The page names it when it has a
   * base-product offer; a marketplace product sold only in sizes has none, so
   * the cheapest sellable offer of any size in the shopper's currency stands
   * for it - it is the seller the first size added will be bought from. The
   * marketplace's own product binds no offer: it is the marketplace's stock.
   */
  const offerId =
    input.offerId ??
    (input.isMarketplaceProduct
      ? ((
          await prisma.sellerOffer.findFirst({
            where: {
              productId: input.productId,
              status: 'ACTIVE',
              archivedAt: null,
              currency: input.currency,
              sellerAccount: SELLABLE_SELLER,
            },
            orderBy: [{ priceMinor: 'asc' }, { createdAt: 'asc' }],
            select: { id: true },
          })
        )?.id ?? null)
      : null);

  const offer =
    offerId === null
      ? null
      : await prisma.sellerOffer.findUnique({
          where: { id: offerId },
          select: {
            handlingTimeDays: true,
            countryOfOrigin: true,
            sellingRegionsJson: true,
            capacityUnitsPerWeek: true,
            capacityLeadTimeDays: true,
            sellerAccount: {
              select: {
                id: true,
                slug: true,
                displayName: true,
                kind: true,
                registrationCountry: true,
                approvedAt: true,
                status: true,
                suspendedAt: true,
                archivedAt: true,
              },
            },
          },
        });

  const account = offer?.sellerAccount ?? null;
  const listed =
    account !== null && account.status === 'APPROVED' && account.suspendedAt === null && account.archivedAt === null
      ? account
      : null;

  // --- Delivery -------------------------------------------------------------
  const notes = (await productMarketNotes(input.destination, { id: input.productId, categoryId: input.categoryId })).map(
    ({ effect, reason, requiredDocuments, labelText }) => ({ effect, reason, requiredDocuments, labelText }),
  );
  const regions = Array.isArray(offer?.sellingRegionsJson)
    ? (offer.sellingRegionsJson as unknown[]).filter((code): code is string => typeof code === 'string')
    : [];

  let status: DeliveryStatus;
  if (input.destination === null) status = 'CHOOSE_DESTINATION';
  else if (notes.some((note) => note.effect === 'BLOCK')) status = 'BLOCKED';
  else if (regions.length > 0 && !regions.includes(input.destination)) status = 'SELLER_DOES_NOT_DELIVER';
  else if (notes.some((note) => note.effect === 'DOCUMENTS_REQUIRED')) status = 'DOCUMENTS_REQUIRED';
  else status = 'AVAILABLE';

  // --- Inspection -----------------------------------------------------------
  let inspection: ProductSourcing['inspection'] = { outlook: 'NOT_APPLICABLE', fromValueMinor: null, currency: null };
  if (listed !== null) {
    const category = await prisma.category.findUnique({ where: { id: input.categoryId }, select: { path: true } });
    const categoryIds = [...(category?.path ?? '').split('/').filter((part) => part.length > 0), input.categoryId];
    const [rules, policy] = await Promise.all([activeRules(prisma), readPolicy()]);
    const risk = await supplierRiskOf(prisma, listed.id, policy);
    const facts = (valueMinor: bigint): OrderFacts => ({
      categoryIds,
      valueMinor,
      currency: input.currency,
      destinationCountry: input.destination,
      supplierRisk: risk.tier,
      buyerRequested: false,
      now: new Date(),
    });

    // Mandatory and risk-triggered rules alike: a risk rule is evaluated
    // against THIS supplier's current risk, so if it matches, an order from
    // them will be inspected.
    const always = rules.filter((rule) => ruleMatches(rule, facts(0n)).matches);
    const withValue = rules.filter(
      (rule) => rule.minOrderValueMinor !== null && ruleMatches(rule, facts(ANY_VALUE)).matches,
    );

    if (always.length > 0) inspection = { outlook: 'REQUIRED', fromValueMinor: null, currency: null };
    else if (withValue.length > 0) {
      const lowest = withValue.reduce(
        (min, rule) => ((rule.minOrderValueMinor as bigint) < min ? (rule.minOrderValueMinor as bigint) : min),
        withValue[0]?.minOrderValueMinor as bigint,
      );
      inspection = { outlook: 'REQUIRED_FROM_VALUE', fromValueMinor: lowest.toString(), currency: input.currency };
    } else if (
      input.destination === null &&
      rules.some(
        (rule) =>
          rule.destinationCountries !== null &&
          rule.destinationCountries.some(
            (country) => ruleMatches(rule, { ...facts(ANY_VALUE), destinationCountry: country }).matches,
          ),
      )
    ) {
      // No country chosen, and a rule for some country would apply: "not
      // required" would be a claim about a destination nobody has named.
      inspection = { outlook: 'DEPENDS_ON_DESTINATION', fromValueMinor: null, currency: null };
    }
    else inspection = { outlook: 'NOT_REQUIRED', fromValueMinor: null, currency: null };
  }

  const [score, inspections] =
    listed === null
      ? [null, null]
      : await Promise.all([
          env.FEATURE_PRODUCT_REVIEWS ? sellerScore(listed.id) : Promise.resolve(null),
          inspectionSummaryFor(listed.id),
        ]);

  return {
    seller:
      listed === null
        ? null
        : {
            slug: listed.slug,
            displayName: listed.displayName,
            kind: listed.kind,
            registrationCountry: listed.registrationCountry,
            verifiedAt: listed.approvedAt?.toISOString() ?? null,
            reviewScore: score === null ? null : { average: score.average, count: score.count },
            inspectionSummary: inspections,
          },
    destination: input.destination,
    delivery: { status, notes },
    handlingTimeDays: offer?.handlingTimeDays ?? null,
    countryOfOrigin: offer?.countryOfOrigin ?? null,
    capacity:
      listed === null || ((offer?.capacityUnitsPerWeek ?? null) === null && (offer?.capacityLeadTimeDays ?? null) === null)
        ? null
        : { unitsPerWeek: offer?.capacityUnitsPerWeek ?? null, leadTimeDays: offer?.capacityLeadTimeDays ?? null },
    terms: listed === null ? null : await publicListingSourcing(listed.id, input.productId),
    inspection,
  };
}
