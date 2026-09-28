/**
 * The B2C maximum order quantity: the most units of one product that a buyer
 * who is NOT an approved company may put in one order.
 *
 * Not to be confused with any of the other quantity rules in this codebase,
 * because it answers a different question from each of them:
 *
 *   - `minimumOrderQuantity` / `maximumOrderQuantity` (the offer's own terms)
 *     are per basket LINE and bind every buyer, company or not.
 *   - The preorder MOQ (`PreorderPolicy.moqQuantity`) is a FLOOR on a bulk
 *     request, and has nothing to say about a basket.
 *   - This one is a CEILING, it binds only buyers without an approved company,
 *     and it counts the WHOLE product - every variant, every duplicate line -
 *     so it cannot be split round by adding the same thing twice.
 *
 * It is a purchasing limit, not stock. Nothing here reads or writes inventory.
 *
 * Whose limit it is. The catalogue product is shared: several sellers may
 * offer it, and each sets the limit on their own offer. The limit therefore
 * counts one SELLER'S units of one product - a seller cannot decide how much
 * of somebody else's stock a buyer may take. The operator's own stock (a line
 * with no seller offer) is its own group, limited by the product row, which
 * an administrator sets.
 *
 * Null means "not configured", which is what every product and offer that
 * existed before this rule is. Not configured means no B2C ceiling - exactly
 * how those products sold before - and Seller Hub flags the listing so the
 * seller can set one. Inventing a figure for them would be a business
 * decision nobody made.
 *
 * Pure: no database, no clock. The cart, the checkout, the scheduled-order
 * quote and the preorder request all call these functions, so there is one
 * answer to "is this too many" and not four.
 */

/**
 * The largest limit a seller may type.
 *
 * Far above any real retail quantity, and far below the 32-bit column it is
 * stored in. It exists so a mistyped 10,000,000,000 is refused with a message
 * rather than overflowing somewhere further down.
 */
export const B2C_MAX_ORDER_QUANTITY_CEILING = 1_000_000;

export type B2cLimitValidation =
  | { ok: true; value: number }
  | { ok: false; code: 'REQUIRED' | 'NOT_A_WHOLE_NUMBER' | 'NOT_POSITIVE' | 'TOO_LARGE' | 'BELOW_MINIMUM' };

/**
 * Validate a limit exactly as it arrived.
 *
 * Only a JSON number is accepted. A string - even "100" - is refused rather
 * than coerced, because the storefront and Seller Hub both send numbers, and
 * a quietly parsed "1e2" or "100abc" is how a limit nobody typed ends up
 * stored. Zero, negatives, fractions, NaN and Infinity are each refused with
 * their own code so the form can say which.
 *
 * `minimumOrderQuantity`, when given, is the offer's own per-line minimum: a
 * B2C ceiling below it would make the product impossible for an individual
 * to buy at all, which is never what a seller meant.
 */
export function validateB2cMaxOrderQuantity(
  raw: unknown,
  options: { minimumOrderQuantity?: number } = {},
): B2cLimitValidation {
  if (raw === null || raw === undefined || raw === '') return { ok: false, code: 'REQUIRED' };
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    return { ok: false, code: 'NOT_A_WHOLE_NUMBER' };
  }
  if (raw <= 0) return { ok: false, code: 'NOT_POSITIVE' };
  if (raw > B2C_MAX_ORDER_QUANTITY_CEILING) return { ok: false, code: 'TOO_LARGE' };
  if (options.minimumOrderQuantity !== undefined && raw < options.minimumOrderQuantity) {
    return { ok: false, code: 'BELOW_MINIMUM' };
  }
  return { ok: true, value: raw };
}

/**
 * The English sentence for a refused limit, for server-side messages and API
 * consumers. Seller Hub words the same codes in the seller's own language.
 */
export function b2cLimitProblemMessage(
  code: Exclude<B2cLimitValidation, { ok: true }>['code'],
): string {
  switch (code) {
    case 'REQUIRED':
      return 'Enter the B2C maximum order quantity before sending this listing for review.';
    case 'NOT_A_WHOLE_NUMBER':
      return 'The B2C maximum order quantity must be a whole number.';
    case 'NOT_POSITIVE':
      return 'The B2C maximum order quantity must be at least 1.';
    case 'TOO_LARGE':
      return `The B2C maximum order quantity cannot be more than ${B2C_MAX_ORDER_QUANTITY_CEILING.toLocaleString('en')}.`;
    case 'BELOW_MINIMUM':
      return 'The B2C maximum order quantity cannot be below your minimum order quantity, or no individual could buy this product.';
  }
}

/**
 * The buying context the limit is judged against, as the SERVER resolved it.
 *
 * Deliberately narrow: a kind and a status. Nothing a client sends can reach
 * this - the routes build it from the session's confirmed buyer context.
 */
export type B2cBuyer =
  | { kind: 'GUEST' }
  | { kind: 'INDIVIDUAL' }
  | { kind: 'COMPANY'; companyId: string; companyStatus: string };

/**
 * Whether this buyer is held to the B2C limit.
 *
 * Only an APPROVED company is exempt. A company still being verified, sent
 * back for more information, rejected or suspended is held to it exactly as
 * an individual is - otherwise opening an application would be a way round
 * the limit.
 */
export function isB2cLimitApplicable(buyer: B2cBuyer): boolean {
  return !(buyer.kind === 'COMPANY' && buyer.companyStatus === 'APPROVED');
}

/** One basket line, reduced to what the limit needs. */
export interface B2cLine {
  productId: string;
  /** The seller whose offer this line is, or null for the operator's stock. */
  sellerAccountId: string | null;
  /** Pieces - the same unit every other quantity rule counts. */
  quantity: number;
  /** The limit in force for this line's offer (or product), or null. */
  limit: number | null;
}

/** The key the limit counts under: one seller's units of one product. */
export function b2cGroupKey(productId: string, sellerAccountId: string | null): string {
  return `${productId}|${sellerAccountId ?? ''}`;
}

export interface B2cGroupTotal {
  productId: string;
  sellerAccountId: string | null;
  /** Every line's quantity for this product from this seller, added up. */
  totalQuantity: number;
  /**
   * The limit that applies to the group, or null when none is configured.
   *
   * The lowest of the lines' limits. A seller's offers for one product carry
   * the same figure - it is set once per listing - so this is normally just
   * that figure; taking the lowest means a disagreement can only ever make
   * the rule stricter, never open a gap.
   */
  limit: number | null;
}

/** Total each product-from-seller group across all of its lines. */
export function totalB2cGroups(lines: readonly B2cLine[]): Map<string, B2cGroupTotal> {
  const groups = new Map<string, B2cGroupTotal>();
  for (const line of lines) {
    const key = b2cGroupKey(line.productId, line.sellerAccountId);
    const group = groups.get(key) ?? {
      productId: line.productId,
      sellerAccountId: line.sellerAccountId,
      totalQuantity: 0,
      limit: null,
    };
    group.totalQuantity += line.quantity;
    if (line.limit !== null) {
      group.limit = group.limit === null ? line.limit : Math.min(group.limit, line.limit);
    }
    groups.set(key, group);
  }
  return groups;
}

/** Every group over its limit. Empty when the buyer is exempt. */
export function findB2cViolations(
  buyer: B2cBuyer,
  lines: readonly B2cLine[],
): (B2cGroupTotal & { limit: number })[] {
  if (!isB2cLimitApplicable(buyer)) return [];
  const over: (B2cGroupTotal & { limit: number })[] = [];
  for (const group of totalB2cGroups(lines).values()) {
    if (group.limit !== null && group.totalQuantity > group.limit) {
      over.push({ ...group, limit: group.limit });
    }
  }
  return over;
}

export interface B2cChange {
  /** The group's total before this change - every line, including the one changing. */
  currentGroupQuantity: number;
  /** The group's total if the change is applied. */
  proposedGroupQuantity: number;
  limit: number | null;
}

/**
 * Whether a single basket change must be refused.
 *
 * Only a change that ADDS units and ends above the limit is refused. A change
 * that takes units away is always allowed, even while the group is still over
 * - a basket that went over because the seller lowered the limit has to be
 * fixable one line at a time, and refusing every reduction short of the whole
 * way would leave the buyer unable to fix it at all.
 */
export function isB2cChangeRefused(buyer: B2cBuyer, change: B2cChange): boolean {
  if (!isB2cLimitApplicable(buyer) || change.limit === null) return false;
  if (change.proposedGroupQuantity <= change.currentGroupQuantity) return false;
  return change.proposedGroupQuantity > change.limit;
}
