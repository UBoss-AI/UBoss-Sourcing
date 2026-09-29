/**
 * The facts `domain/seller-kyb.ts` judges, read from the database.
 *
 * Its own file so the onboarding checklist (`onboarding.service.ts`) and the
 * section's own service (`kyb.service.ts`) can both ask it without importing
 * each other.
 */
import { env } from '../../config/env.js';
import {
  kybGaps,
  type KybFacts,
  type KybGap,
  type KybPolicy,
} from '../../domain/seller-kyb.js';
import { prisma } from '../../infra/prisma.js';

export function kybPolicy(): KybPolicy {
  return { beneficialOwnersRequired: env.SELLER_REQUIRE_BENEFICIAL_OWNERS };
}

/** A JSON column that should hold a list of strings, read defensively. */
export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export async function loadKybFacts(sellerAccountId: string, registrationCountry: string): Promise<KybFacts> {
  const [profile, trust, owners] = await Promise.all([
    prisma.sellerBusinessProfile.findUnique({
      where: { sellerAccountId },
      select: { legalForm: true, companyRegistrationNumber: true, taxRegistrationNumber: true },
    }),
    prisma.sellerTrustProfile.findUnique({
      where: { sellerAccountId },
      select: { exportCapable: true, exportMarketsJson: true },
    }),
    prisma.sellerBeneficialOwner.findMany({
      where: { sellerAccountId, archivedAt: null },
      select: { ownershipBasisPoints: true },
    }),
  ]);

  return {
    registrationCountry,
    legalForm: profile?.legalForm ?? null,
    companyRegistrationNumber: profile?.companyRegistrationNumber ?? null,
    taxRegistrationNumber: profile?.taxRegistrationNumber ?? null,
    exportCapable: trust?.exportCapable ?? false,
    exportMarkets: stringList(trust?.exportMarketsJson),
    owners,
  };
}

/** What the ownership-and-registrations section still needs, for this seller. */
export async function kybGapsFor(sellerAccountId: string, registrationCountry: string): Promise<KybGap[]> {
  return kybGaps(await loadKybFacts(sellerAccountId, registrationCountry), kybPolicy());
}
