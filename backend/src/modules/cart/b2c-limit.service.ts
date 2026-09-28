/**
 * The B2C maximum order quantity, applied to real baskets and orders.
 *
 * The arithmetic is `domain/b2c-order-limit.ts`; this file answers the two
 * questions the arithmetic cannot: WHO is buying, and WHAT the basket holds
 * right now. Both are answered from the database and nothing else.
 *
 * Who is buying. The basket's own `buyerCompanyId` - which the storefront
 * routes set from the session's CONFIRMED buyer context, never from the
 * request - plus that company's live status and the person's live
 * membership. A client-sent account type, company id or approval flag never
 * reaches this file. A company that is not approved, a membership that has
 * been removed or suspended, an archived company: each is held to the limit
 * exactly as an individual is.
 *
 * What the basket holds. Every mutation takes the basket row's lock first
 * (`lockCartForB2c`), totals each product-from-seller group, makes its
 * change, and totals again (`assertB2cChangeAllowed`). Comparing the two
 * totals rather than predicting the change means every way of adding - a new
 * line, a merge onto an existing one, a second variant, a pack change, one
 * bulk request carrying the same thing twice - is judged by what actually
 * landed. The lock is what stops two requests arriving together from each
 * seeing 60 and each adding 50.
 */
import type { B2cBuyer, B2cLine } from '../../domain/b2c-order-limit.js';
import {
  b2cGroupKey,
  findB2cViolations,
  isB2cChangeRefused,
  isB2cLimitApplicable,
  totalB2cGroups,
  type B2cGroupTotal,
} from '../../domain/b2c-order-limit.js';
import { AppError, ErrorCode, type ErrorDetail } from '../../domain/errors.js';
import type { prisma, PrismaTransaction } from '../../infra/prisma.js';

type Db = PrismaTransaction | typeof prisma;

/**
 * The buyer a basket belongs to, judged from the database.
 *
 * `buyerCompanyId` null is the person's own basket: INDIVIDUAL. Otherwise the
 * company counts as a company only while the person is still an ACTIVE
 * member of an un-archived company; its status then decides the exemption.
 * Any other answer falls back to INDIVIDUAL, which is the strict one.
 */
export async function resolveB2cBuyer(
  db: Db,
  owner: { customerProfileId: string; buyerCompanyId: string | null },
): Promise<B2cBuyer> {
  if (owner.buyerCompanyId === null) return { kind: 'INDIVIDUAL' };

  const profile = await db.customerProfile.findUnique({
    where: { id: owner.customerProfileId },
    select: { userId: true },
  });
  if (profile === null) return { kind: 'INDIVIDUAL' };

  const membership = await db.buyerCompanyMember.findFirst({
    where: {
      companyId: owner.buyerCompanyId,
      userId: profile.userId,
      status: 'ACTIVE',
      company: { archivedAt: null },
    },
    select: { company: { select: { id: true, status: true } } },
  });
  if (membership === null) return { kind: 'INDIVIDUAL' };

  return {
    kind: 'COMPANY',
    companyId: membership.company.id,
    companyStatus: membership.company.status,
  };
}

/**
 * Take the basket's row lock for the rest of this transaction.
 *
 * MUST be the first statement in the transaction. InnoDB fixes a
 * transaction's read view at its first plain read; taking the lock first
 * means every read after it sees what the request that held the lock before
 * us committed, rather than the world as it was when we started waiting.
 */
export async function lockCartForB2c(tx: PrismaTransaction, cartId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM carts WHERE id = ${cartId} FOR UPDATE`;
}

/** Every line in the basket, reduced to what the limit needs, with live limits. */
export async function loadCartB2cLines(db: Db, cartId: string): Promise<B2cLine[]> {
  const items = await db.cartItem.findMany({
    where: { cartId },
    select: {
      productId: true,
      quantity: true,
      product: { select: { b2cMaxOrderQuantity: true } },
      sellerOffer: { select: { sellerAccountId: true, b2cMaxOrderQuantity: true } },
    },
  });
  return items.map((item) => b2cLineOf(item));
}

/**
 * One line's limit: the seller's offer when it is a seller's line, the
 * product row when it is the operator's own stock. Never both - a seller's
 * line does not inherit the operator's figure, or an administrator's setting
 * would bind stock the operator does not own.
 */
export function b2cLineOf(item: {
  productId: string;
  quantity: number;
  product: { b2cMaxOrderQuantity: number | null };
  sellerOffer: { sellerAccountId: string; b2cMaxOrderQuantity: number | null } | null;
}): B2cLine {
  return item.sellerOffer === null
    ? {
        productId: item.productId,
        sellerAccountId: null,
        quantity: item.quantity,
        limit: item.product.b2cMaxOrderQuantity,
      }
    : {
        productId: item.productId,
        sellerAccountId: item.sellerOffer.sellerAccountId,
        quantity: item.quantity,
        limit: item.sellerOffer.b2cMaxOrderQuantity,
      };
}

/**
 * The refusal, in the shape every other error has.
 *
 * 409, like the other basket quantity refusals: the request is well formed,
 * it conflicts with a rule. The figures are in `details[0].meta` so the
 * storefront can word it in the buyer's language and offer "Reduce to N".
 * Nothing about the seller or the company is in it.
 */
export function b2cLimitError(input: {
  productId: string;
  allowedQuantity: number;
  requestedQuantity: number;
  currentCartQuantity: number;
  field?: string;
}): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCode.B2C_MAX_ORDER_QUANTITY_EXCEEDED,
    message: `Individual buyers can order up to ${String(input.allowedQuantity)} units of this product.`,
    details: [b2cLimitDetail(input)],
  });
}

export function b2cLimitDetail(input: {
  productId: string;
  allowedQuantity: number;
  requestedQuantity: number;
  currentCartQuantity: number;
  field?: string;
}): ErrorDetail {
  return {
    ...(input.field === undefined ? {} : { field: input.field }),
    code: ErrorCode.B2C_MAX_ORDER_QUANTITY_EXCEEDED,
    message: `Individual buyers can order up to ${String(input.allowedQuantity)} units of this product.`,
    meta: {
      productId: input.productId,
      allowedQuantity: input.allowedQuantity,
      requestedQuantity: input.requestedQuantity,
      currentCartQuantity: input.currentCartQuantity,
      requiresApprovedCompanyAccount: true,
    },
  };
}

/**
 * Refuse a basket change that added units to a group and left it over.
 *
 * `before` is the group totals taken right after `lockCartForB2c`; this
 * re-reads the basket inside the same transaction, so throwing rolls the
 * change back. A group whose total went DOWN is never refused, even if it is
 * still over - that is how a basket put over by a lowered limit gets fixed.
 */
export async function assertB2cChangeAllowed(
  tx: PrismaTransaction,
  input: { cartId: string; buyer: B2cBuyer; before: Map<string, B2cGroupTotal> },
): Promise<void> {
  if (!isB2cLimitApplicable(input.buyer)) return;

  const after = totalB2cGroups(await loadCartB2cLines(tx, input.cartId));
  for (const [key, group] of after) {
    const previous = input.before.get(key)?.totalQuantity ?? 0;
    const refused = isB2cChangeRefused(input.buyer, {
      currentGroupQuantity: previous,
      proposedGroupQuantity: group.totalQuantity,
      limit: group.limit,
    });
    if (refused && group.limit !== null) {
      throw b2cLimitError({
        productId: group.productId,
        allowedQuantity: group.limit,
        requestedQuantity: group.totalQuantity,
        currentCartQuantity: previous,
      });
    }
  }
}

/**
 * Lock the basket and take its "before" totals, for a mutation about to run
 * in `tx`. The buyer is resolved here too, inside the same transaction.
 */
export async function beginB2cGuardedChange(
  tx: PrismaTransaction,
  cartId: string,
): Promise<{ buyer: B2cBuyer; before: Map<string, B2cGroupTotal> }> {
  await lockCartForB2c(tx, cartId);
  const cart = await tx.cart.findUniqueOrThrow({
    where: { id: cartId },
    select: { customerProfileId: true, buyerCompanyId: true },
  });
  const buyer =
    cart.customerProfileId === null
      ? ({ kind: 'GUEST' } as const)
      : await resolveB2cBuyer(tx, {
          customerProfileId: cart.customerProfileId,
          buyerCompanyId: cart.buyerCompanyId,
        });
  const before = totalB2cGroups(await loadCartB2cLines(tx, cartId));
  return { buyer, before };
}

/**
 * What each basket line should be told about the limit, for display.
 *
 * Positionally aligned with `lines`. `productQuantity` is the whole group's
 * total, so the cart can say "110 of 100" on each of the two variant lines
 * that make it up. Null for a line whose product has no limit configured.
 */
export interface B2cLineView {
  maxQuantity: number;
  productQuantity: number;
  /** False for an approved company: shown for information, not enforced. */
  applies: boolean;
  exceeded: boolean;
}

export function b2cLineViews(buyer: B2cBuyer, lines: readonly B2cLine[]): (B2cLineView | null)[] {
  const groups = totalB2cGroups(lines);
  const applies = isB2cLimitApplicable(buyer);
  return lines.map((line) => {
    const group = groups.get(b2cGroupKey(line.productId, line.sellerAccountId));
    if (group === undefined || group.limit === null) return null;
    return {
      maxQuantity: group.limit,
      productQuantity: group.totalQuantity,
      applies,
      exceeded: applies && group.totalQuantity > group.limit,
    };
  });
}

/**
 * Judge the lines an order is about to be created from, with LIVE limits,
 * and return what to freeze on each order item.
 *
 * Called inside the transaction that writes the order, after the basket's
 * lock where there is a basket. Limits are re-read here rather than taken
 * from the priced basket because a seller may have lowered one between the
 * review screen and the button; the buyer is re-resolved for the same reason
 * - a company suspended a minute ago no longer earns the exemption.
 *
 * Positionally aligned with `lines`. Throws the B2C refusal if any product
 * is over.
 */
export async function assertOrderLinesWithinB2c(
  db: Db,
  input: {
    customerProfileId: string;
    buyerCompanyId: string | null;
    lines: readonly { productId: string; sellerOfferId: string | null; quantity: number }[];
  },
): Promise<{ buyer: B2cBuyer; perLine: { limitApplied: number | null; companyExempt: boolean }[] }> {
  const buyer = await resolveB2cBuyer(db, {
    customerProfileId: input.customerProfileId,
    buyerCompanyId: input.buyerCompanyId,
  });

  const productIds = [...new Set(input.lines.map((line) => line.productId))];
  const offerIds = [
    ...new Set(input.lines.flatMap((line) => (line.sellerOfferId === null ? [] : [line.sellerOfferId]))),
  ];
  const [products, offers] = await Promise.all([
    db.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, b2cMaxOrderQuantity: true },
    }),
    offerIds.length === 0
      ? Promise.resolve([])
      : db.sellerOffer.findMany({
          where: { id: { in: offerIds } },
          select: { id: true, sellerAccountId: true, b2cMaxOrderQuantity: true },
        }),
  ]);
  const productById = new Map(products.map((row) => [row.id, row]));
  const offerById = new Map(offers.map((row) => [row.id, row]));

  const b2cLines = input.lines.map((line) =>
    b2cLineOf({
      productId: line.productId,
      quantity: line.quantity,
      product: { b2cMaxOrderQuantity: productById.get(line.productId)?.b2cMaxOrderQuantity ?? null },
      sellerOffer:
        line.sellerOfferId === null ? null : (offerById.get(line.sellerOfferId) ?? null),
    }),
  );

  assertWithinB2cLimits(buyer, b2cLines);

  const groups = totalB2cGroups(b2cLines);
  const companyExempt = !isB2cLimitApplicable(buyer);
  return {
    buyer,
    perLine: b2cLines.map((line) => ({
      limitApplied: groups.get(b2cGroupKey(line.productId, line.sellerAccountId))?.limit ?? null,
      companyExempt,
    })),
  };
}

/**
 * Throw if any group is over, for the points that create an order.
 *
 * Unlike a basket change there is no "reduction" to allow here: an order is
 * either within the limit or it is not placed.
 */
export function assertWithinB2cLimits(buyer: B2cBuyer, lines: readonly B2cLine[]): void {
  const [first] = findB2cViolations(buyer, lines);
  if (first === undefined) return;
  throw b2cLimitError({
    productId: first.productId,
    allowedQuantity: first.limit,
    requestedQuantity: first.totalQuantity,
    currentCartQuantity: first.totalQuantity,
  });
}
