/**
 * A seller's quantity price bands on one listing: read, and replaced as a set.
 *
 * Replaced as a set because the bands only make sense together - "from 500"
 * means something only beside "from 100" and "from 2,000" - and validating
 * one band at a time would let two saves each pass and leave a ladder whose
 * price goes up. The whole set is checked by `validateTiers`, then written in
 * one transaction under a row lock on the offer, so two editors cannot
 * interleave.
 */
import { z } from 'zod';

import { ErrorCode, badRequest, notFound, type ErrorDetail } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { savingBasisPoints, validateTiers, type QuantityTier } from '../../domain/quantity-tier.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { TIER_SELECT, toQuantityTier } from '../catalog/quantity-tier.service.js';
import type { SellerMembership } from './account.service.js';
import { recordSellerAudit } from './audit.service.js';

const minor = z.string().regex(/^\d{1,15}$/, 'An amount in minor units, digits only.');
const instant = z.string().datetime({ offset: true }).nullable();

export const tiersInputSchema = z
  .object({
    tiers: z
      .array(
        z
          .object({
            minQuantity: z.number().int().min(1).max(100_000_000),
            maxQuantity: z.number().int().min(1).max(100_000_000).nullable(),
            priceMinor: minor,
            isActive: z.boolean(),
            startsAt: instant,
            endsAt: instant,
            businessBuyersOnly: z.boolean(),
            countryCodes: z.array(z.string().trim().toUpperCase().length(2)).max(60).nullable(),
            preorderOnly: z.boolean(),
          })
          .strict(),
      )
      .max(40),
  })
  .strict();

async function ownedOffer(membership: SellerMembership, offerId: string) {
  const offer = await prisma.sellerOffer.findUnique({
    where: { id: offerId },
    select: {
      id: true,
      sellerAccountId: true,
      priceMinor: true,
      currency: true,
      priceTiers: { select: TIER_SELECT, orderBy: { minQuantity: 'asc' } },
    },
  });
  if (offer === null || offer.sellerAccountId !== membership.sellerAccountId)
    throw notFound('Listing');
  return offer;
}

function serialise(
  offer: { id: string; priceMinor: bigint; currency: string },
  tiers: QuantityTier[],
) {
  return {
    offerId: offer.id,
    currency: offer.currency,
    listUnitPrice: serialiseMoney(offer.priceMinor, offer.currency),
    tiers: tiers.map((tier) => ({
      id: tier.id,
      minQuantity: tier.minQuantity,
      maxQuantity: tier.maxQuantity,
      priceMinor: tier.priceMinor.toString(),
      unitPrice: serialiseMoney(tier.priceMinor, offer.currency),
      savingBasisPoints: savingBasisPoints(offer.priceMinor, tier.priceMinor),
      isActive: tier.isActive,
      startsAt: tier.startsAt?.toISOString() ?? null,
      endsAt: tier.endsAt?.toISOString() ?? null,
      businessBuyersOnly: tier.businessBuyersOnly,
      countryCodes: tier.countryCodes,
      preorderOnly: tier.preorderOnly,
    })),
  };
}

export async function readQuantityTiers(membership: SellerMembership, offerId: string) {
  const offer = await ownedOffer(membership, offerId);
  return serialise(offer, offer.priceTiers.map(toQuantityTier));
}

export async function saveQuantityTiers(
  membership: SellerMembership,
  offerId: string,
  input: z.infer<typeof tiersInputSchema>,
) {
  const offer = await ownedOffer(membership, offerId);
  const proposed: QuantityTier[] = input.tiers.map((tier) => ({
    id: newId(),
    minQuantity: tier.minQuantity,
    maxQuantity: tier.maxQuantity,
    priceMinor: BigInt(tier.priceMinor),
    isActive: tier.isActive,
    startsAt: tier.startsAt === null ? null : new Date(tier.startsAt),
    endsAt: tier.endsAt === null ? null : new Date(tier.endsAt),
    businessBuyersOnly: tier.businessBuyersOnly,
    countryCodes: tier.countryCodes === null ? null : [...new Set(tier.countryCodes)],
    preorderOnly: tier.preorderOnly,
  }));

  const problems = validateTiers(offer.priceMinor, proposed);
  if (problems.length > 0) {
    const details: ErrorDetail[] = problems.map((problem) => ({
      field: problem.index < 0 ? 'tiers' : `tiers.${String(problem.index)}`,
      code: problem.code,
      message: `Band ${String(problem.index + 1)}: ${problem.code}`,
      meta: { index: problem.index, otherIndex: problem.otherIndex ?? null },
    }));
    throw badRequest(
      ErrorCode.QUANTITY_TIERS_INVALID,
      'These quantity bands contradict each other or the list price.',
      details,
    );
  }

  await prisma.$transaction(async (tx) => {
    // The row lock that serialises two editors of the same listing.
    await tx.$queryRaw`SELECT id FROM seller_offers WHERE id = ${offer.id} FOR UPDATE`;
    await tx.sellerPriceTier.deleteMany({ where: { offerId: offer.id } });
    if (proposed.length > 0) {
      await tx.sellerPriceTier.createMany({
        data: proposed.map((tier) => ({
          id: tier.id,
          offerId: offer.id,
          minQuantity: tier.minQuantity,
          maxQuantity: tier.maxQuantity,
          priceMinor: tier.priceMinor,
          isActive: tier.isActive,
          startsAt: tier.startsAt,
          endsAt: tier.endsAt,
          businessBuyersOnly: tier.businessBuyersOnly,
          countryCodes: tier.countryCodes ?? undefined,
          preorderOnly: tier.preorderOnly,
        })),
      });
    }
    await recordSellerAudit({
      tx,
      sellerAccountId: membership.sellerAccountId,
      action: 'listing.quantity_tiers_saved',
      actor: { type: 'CUSTOMER', label: membership.displayName },
      resourceType: 'seller_offer',
      resourceId: offer.id,
      before: offer.priceTiers.map((tier) => ({
        minQuantity: tier.minQuantity,
        priceMinor: tier.priceMinor.toString(),
      })),
      after: proposed.map((tier) => ({
        minQuantity: tier.minQuantity,
        priceMinor: tier.priceMinor.toString(),
      })),
      summary: `${String(proposed.length)} quantity price bands saved`,
    });
  });

  return serialise(
    offer,
    proposed.sort((a, b) => a.minQuantity - b.minQuantity),
  );
}
