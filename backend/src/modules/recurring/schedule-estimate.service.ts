/**
 * What a schedule would cost if it ran now.
 *
 * One rule, and it is the reason this file is four functions rather than a
 * line of arithmetic on a screen: **a scheduled basket is priced by
 * `quoteSchedule` and nothing else.** The review screen the customer confirms,
 * the worker that charges them six weeks later, and the figure on the card in
 * their account all come through here, so the number they agreed to and the
 * number they are charged have one implementation. A second answer to "what
 * does this basket cost" is how a customer ends up disputing a total nobody
 * can explain.
 *
 * Everything here is an *estimate* and is labelled as one on the way out,
 * because that is what it is. An occurrence is repriced against the catalogue,
 * the destination's tax, stock and the customer's own limits at the moment it
 * runs; a plan created in April at one price has not locked that price in.
 *
 * Ownership is a `where` clause, never a check after the read: pass the
 * customer's profile id and a plan belonging to somebody else is simply not
 * found. Admin callers pass `null`, which means "no ownership scope" and is
 * only reachable behind a permission check.
 */
import { ErrorCode, notFound } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { prisma } from '../../infra/prisma.js';
import { VISIBLE_TO_CUSTOMER } from './schedule.service.js';
import { quoteSchedule } from './schedule-quote.service.js';
import type { QuoteProblem, ScheduleQuote } from './schedule-quote.service.js';

/** One line of an estimate, as the customer's screens read it. */
export interface ScheduleEstimateLine {
  productId: string;
  variantId: string | null;
  name: string;
  sku: string;
  variantName: string | null;
  imageUrl: string | null;
  quantity: number;
  unitPrice: ReturnType<typeof serialiseMoney>;
  lineTotal: ReturnType<typeof serialiseMoney>;
  availableQty: number | null;
  /** Set when this line would be filled by the customer's saved stand-in. */
  substitutedFor: { productId: string; name: string } | null;
}

export interface ScheduleEstimate {
  scheduleId: string;
  currency: string;
  lines: ScheduleEstimateLine[];
  totals: ScheduleQuote['totals'];
  /**
   * Whether this basket could actually be supplied and charged right now.
   *
   * False is not an error and must not be rendered as one. A plan whose
   * product went out of stock this morning is a plan with something to tell
   * the customer, not a broken plan - and telling them before the delivery
   * date is the entire value of showing an estimate at all.
   */
  ok: boolean;
  problems: QuoteProblem[];
  /** Null when nothing priced, so a caller can render a dash rather than 0.00. */
  estimatedTotal: ReturnType<typeof serialiseMoney> | null;
}

/** The plan fields an estimate needs, and only those. */
const ESTIMATE_SELECT = {
  id: true,
  customerProfileId: true,
  shippingAddressId: true,
  shippingMethodCode: true,
  substitutionPolicy: true,
  inventoryLocationId: true,
  items: {
    select: {
      productId: true,
      variantId: true,
      quantity: true,
      orderingUnit: true,
      unitQuantity: true,
      piecesPerUnitSnapshot: true,
      substituteProductId: true,
      substituteVariantId: true,
    },
  },
} as const;

type EstimatePlan = {
  id: string;
  customerProfileId: string;
  shippingAddressId: string;
  shippingMethodCode: string | null;
  substitutionPolicy: string;
  inventoryLocationId: string | null;
  items: {
    productId: string;
    variantId: string | null;
    quantity: number;
    orderingUnit: 'PIECE' | 'INNER_PACK' | 'OUTER_CARTON';
    unitQuantity: number;
    piecesPerUnitSnapshot: number;
    substituteProductId: string | null;
    substituteVariantId: string | null;
  }[];
};

/**
 * Price one plan.
 *
 * `checkErpStock` is deliberately off: this runs while somebody is looking at
 * a screen, and a third-party round trip they have to wait for would be stale
 * by the delivery date anyway. The worker turns it on, where it matters.
 */
async function quotePlan(plan: EstimatePlan): Promise<ScheduleEstimate> {
  const quote = await quoteSchedule({
    customerProfileId: plan.customerProfileId,
    items: plan.items.map((item) => ({
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      // Carried through so the quote can name the unit the customer agreed in.
      // It changes no arithmetic: pricing reads `quantity` and only that.
      orderingUnit: item.orderingUnit,
      unitQuantity: item.unitQuantity,
      piecesPerUnitSnapshot: item.piecesPerUnitSnapshot,
      substituteProductId: item.substituteProductId,
      substituteVariantId: item.substituteVariantId,
    })),
    shippingAddressId: plan.shippingAddressId,
    shippingMethodCode: plan.shippingMethodCode,
    substitutionPolicy: plan.substitutionPolicy === 'SAVED_PREFERENCE' ? 'SAVED_PREFERENCE' : 'NEVER',
    inventoryLocationId: plan.inventoryLocationId,
  });

  return {
    scheduleId: plan.id,
    currency: quote.currency,
    lines: quote.lines.map((line) => ({
      productId: line.productId,
      variantId: line.variantId,
      name: line.name,
      sku: line.sku,
      variantName: line.variantName,
      imageUrl: line.imageUrl,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      availableQty: line.availableQty,
      substitutedFor: line.substitutedFor,
    })),
    totals: quote.totals,
    ok: quote.ok,
    problems: quote.problems,
    // A quote that priced nothing has no total worth showing. Sending the
    // zero it computed would read as "this delivery is free".
    estimatedTotal: quote.lines.length === 0 ? null : quote.totals.grandTotal,
  };
}

/**
 * The estimate for one schedule, owner-scoped.
 *
 * Throws a 404 for a plan that is not this customer's, so an id says nothing
 * about whose it is.
 */
export async function estimateSchedule(
  scheduleId: string,
  customerProfileId: string | null,
): Promise<ScheduleEstimate> {
  const plan = await prisma.recurringSchedule.findFirst({
    where: {
      id: scheduleId,
      // Ownership and visibility both narrow the read, and only for a
      // customer: an admin caller passes null and sees every plan.
      ...(customerProfileId !== null ? { customerProfileId, ...VISIBLE_TO_CUSTOMER } : {}),
    },
    select: ESTIMATE_SELECT,
  });

  if (plan === null) throw notFound('Schedule');

  return quotePlan(plan);
}

/**
 * How many plans one list request will price.
 *
 * Each estimate is a handful of indexed reads, which is cheap on its own and
 * is not free forty times over. A customer with more standing arrangements
 * than this gets figures on the first few and a dash on the rest, which is
 * honest; the detail screen prices whichever one they open.
 */
export const MAX_LIST_ESTIMATES = 12;

/**
 * Estimates for a page of plans, keyed by schedule id.
 *
 * Returns a map rather than mutating the rows, so the caller's serialiser
 * stays the one place that decides the shape of a schedule on the wire.
 *
 * A plan whose estimate throws is absent from the map rather than taking the
 * whole list down with it: the list of somebody's schedules is the screen they
 * use to fix a broken one, so it has to render when one of them is broken.
 */
export async function estimateSchedules(
  plans: readonly { id: string }[],
  customerProfileId: string | null,
): Promise<Map<string, ScheduleEstimate>> {
  const ids = plans.slice(0, MAX_LIST_ESTIMATES).map((plan) => plan.id);
  if (ids.length === 0) return new Map();

  const rows = await prisma.recurringSchedule.findMany({
    where: {
      id: { in: ids },
      ...(customerProfileId !== null ? { customerProfileId, ...VISIBLE_TO_CUSTOMER } : {}),
    },
    select: ESTIMATE_SELECT,
  });

  const settled = await Promise.allSettled(rows.map((row) => quotePlan(row)));

  const estimates = new Map<string, ScheduleEstimate>();
  settled.forEach((result, index) => {
    const id = rows[index]?.id;
    if (id === undefined) return;

    if (result.status === 'fulfilled') {
      estimates.set(id, result.value);
      return;
    }

    // Priced nothing, and said so in the shape every other row uses rather
    // than by being missing - a card that knows it could not price itself can
    // say "we could not price this right now".
    estimates.set(id, {
      scheduleId: id,
      currency: '',
      lines: [],
      totals: {
        subtotal: serialiseMoney(0n, ''),
        discount: serialiseMoney(0n, ''),
        tax: serialiseMoney(0n, ''),
        shipping: serialiseMoney(0n, ''),
        grandTotal: serialiseMoney(0n, ''),
      },
      ok: false,
      problems: [
        {
          severity: 'WARN',
          code: ErrorCode.INTERNAL_ERROR,
          message: 'This schedule could not be priced right now.',
        },
      ],
      estimatedTotal: null,
    });
  });

  return estimates;
}
