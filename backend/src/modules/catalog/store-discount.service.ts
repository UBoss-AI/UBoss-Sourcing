/**
 * Store-wide quantity discounts: read, replaced as a set, and turned into the
 * bands that price the operator's own products.
 *
 * Replaced as a set for the same reason a seller's bands are: "from 50, 5%"
 * only means something beside "from 10, 3%", and checking one rule at a time
 * would let two saves each pass and leave a ladder that dips.
 */
import { z } from 'zod';

import { ErrorCode, badRequest, type ErrorDetail } from '../../domain/errors.js';
import {
  MAX_STORE_DISCOUNT_BASIS_POINTS,
  storeDiscountTiers,
  validateStoreDiscounts,
  type QuantityTier,
  type StoreQuantityDiscount,
} from '../../domain/quantity-tier.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { getBaseCurrency } from '../settings/currency.service.js';

export const storeDiscountsInputSchema = z
  .object({
    discounts: z
      .array(
        z
          .object({
            minQuantity: z.number().int().min(1).max(100_000_000),
            discountBasisPoints: z.number().int().min(0).max(10_000),
            isActive: z.boolean(),
          })
          .strict(),
      )
      .max(40),
  })
  .strict();

export interface StoreDiscountActor {
  userId: string;
  email: string;
  ipAddress: string | null;
  correlationId: string | null;
}

/** Every rule, in quantity order. The storefront reads only the active ones. */
export async function loadStoreDiscounts(): Promise<StoreQuantityDiscount[]> {
  return prisma.storeQuantityDiscount.findMany({
    orderBy: { minQuantity: 'asc' },
    select: { id: true, minQuantity: true, discountBasisPoints: true, isActive: true },
  });
}

/** The bands the store-wide discounts make on one of the operator's list prices. */
export async function storeTiersFor(listPriceMinor: bigint): Promise<QuantityTier[]> {
  return storeDiscountTiers(listPriceMinor, await loadStoreDiscounts());
}

export async function readStoreDiscounts() {
  return {
    maxDiscountBasisPoints: MAX_STORE_DISCOUNT_BASIS_POINTS,
    // For the editor's worked example only. The rules themselves have no
    // currency: they are percentages, applied in whatever currency is quoted.
    baseCurrency: await getBaseCurrency(),
    discounts: await loadStoreDiscounts(),
  };
}

export async function saveStoreDiscounts(
  actor: StoreDiscountActor,
  input: z.infer<typeof storeDiscountsInputSchema>,
) {
  const proposed: StoreQuantityDiscount[] = input.discounts.map((discount) => ({
    id: newId(),
    minQuantity: discount.minQuantity,
    discountBasisPoints: discount.discountBasisPoints,
    isActive: discount.isActive,
  }));

  const problems = validateStoreDiscounts(proposed);
  if (problems.length > 0) {
    const details: ErrorDetail[] = problems.map((problem) => ({
      field: problem.index < 0 ? 'discounts' : `discounts.${String(problem.index)}`,
      code: problem.code,
      message: `Rule ${String(problem.index + 1)}: ${problem.code}`,
      meta: { index: problem.index, otherIndex: problem.otherIndex ?? null },
    }));
    throw badRequest(
      ErrorCode.STORE_QUANTITY_DISCOUNTS_INVALID,
      'These quantity discounts contradict each other.',
      details,
    );
  }

  await prisma.$transaction(async (tx) => {
    const before = await tx.storeQuantityDiscount.findMany({ orderBy: { minQuantity: 'asc' } });
    await tx.storeQuantityDiscount.deleteMany({});
    if (proposed.length > 0) await tx.storeQuantityDiscount.createMany({ data: proposed });
    await recordAudit(
      {
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        ipAddress: actor.ipAddress,
        correlationId: actor.correlationId,
        action: AuditAction.STORE_QUANTITY_DISCOUNTS_SAVED,
        resourceType: 'store_quantity_discounts',
        before: before.map(({ minQuantity, discountBasisPoints, isActive }) => ({
          minQuantity,
          discountBasisPoints,
          isActive,
        })),
        after: proposed.map(({ minQuantity, discountBasisPoints, isActive }) => ({
          minQuantity,
          discountBasisPoints,
          isActive,
        })),
      },
      tx,
    );
  });

  return readStoreDiscounts();
}
