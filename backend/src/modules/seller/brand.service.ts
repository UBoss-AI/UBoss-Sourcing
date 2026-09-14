/**
 * Brands: searching them, and asking for one that is not there.
 *
 * A brand is MARKETPLACE-WIDE, not seller-owned, and that is the decision the
 * whole file turns on. Three distributors selling the same manufacturer's
 * catheters must attach to one brand row, or the buyer's brand filter shows
 * "B. Braun" three times and each one finds a third of the products.
 *
 * So a seller does not create a brand. They search, and where they find
 * nothing they REQUEST one, which an operator approves once for everybody. A
 * brand approved for one seller's request is immediately available to every
 * seller, which is correct: a brand is not owned by whoever happened to ask
 * first.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { recordSellerAudit } from './audit.service.js';
import {
  assertSellerOwnership,
  assertSellerPermission,
  type SellerMembership,
} from './account.service.js';

/**
 * Lowercased, punctuation-stripped, collapsed.
 *
 * This is what makes the duplicate check work at all. "B.Braun", "B Braun",
 * "b. braun" and "B-BRAUN" are one brand and four strings, and a seller who
 * types the fourth while the first exists must be shown the first rather than
 * being allowed to create a fifth.
 */
export function normaliseBrandName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function brandSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);

  return base.length > 0 ? base : `brand-${newId().toLowerCase().slice(-8)}`;
}

export interface BrandSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  manufacturerLegalName: string | null;
  logoStorageKey: string | null;
}

/**
 * Search approved brands.
 *
 * Pending brands are included when the seller requesting them is the one
 * searching, and only then: a seller waiting on their own request should see it
 * in the picker so they can attach it to a draft while they wait, and a seller
 * who has never heard of it should not see somebody else's unapproved name.
 */
export async function searchBrands(
  membership: SellerMembership,
  query: string,
  limit = 20,
): Promise<BrandSummary[]> {
  assertSellerPermission(membership, SellerPermission.LISTING_READ);

  const term = query.trim();

  const pendingForThisSeller = await prisma.brandRequest.findMany({
    where: { sellerAccountId: membership.sellerAccountId, status: 'PENDING', brandId: { not: null } },
    select: { brandId: true },
  });

  const ownPendingIds = pendingForThisSeller
    .map((row) => row.brandId)
    .filter((id): id is string => id !== null);

  const rows = await prisma.brand.findMany({
    where: {
      OR: [{ status: 'APPROVED' }, { id: { in: ownPendingIds } }],
      ...(term.length === 0 ? {} : { name: { contains: term } }),
    },
    orderBy: [{ status: 'asc' }, { name: 'asc' }],
    take: Math.min(50, Math.max(1, limit)),
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      manufacturerLegalName: true,
      logoStorageKey: true,
    },
  });

  return rows;
}

/**
 * The brands this seller has used lately.
 *
 * The "Recent brands" row on the brand-selection screen. Read from their own
 * live offers rather than from a separate table - a seller's recent brands are
 * exactly the brands on their recent listings, and a second table would drift
 * from that the first time a listing was archived.
 */
export async function recentBrands(
  membership: SellerMembership,
  limit = 8,
): Promise<BrandSummary[]> {
  assertSellerPermission(membership, SellerPermission.LISTING_READ);

  const recent = await prisma.sellerOffer.findMany({
    where: { sellerAccountId: membership.sellerAccountId, brandId: { not: null } },
    orderBy: { updatedAt: 'desc' },
    take: 60,
    select: { brandId: true },
    distinct: ['brandId'],
  });

  const ids = recent.map((row) => row.brandId).filter((id): id is string => id !== null);
  if (ids.length === 0) return [];

  const rows = await prisma.brand.findMany({
    where: { id: { in: ids.slice(0, Math.max(1, limit)) }, status: 'APPROVED' },
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      manufacturerLegalName: true,
      logoStorageKey: true,
    },
  });

  // `findMany` returns them in whatever order it likes; the seller expects
  // most-recent first, which is the order `ids` is already in.
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is NonNullable<typeof row> => row !== undefined);
}

export interface BrandRequestInput {
  membership: SellerMembership;
  requestedName: string;
  manufacturerLegalName?: string | null;
  websiteUrl?: string | null;
  justification?: string | null;
  correlationId?: string | null;
}

/**
 * Ask for a brand that is not in the catalogue.
 *
 * Three refusals, and each one gives the seller somewhere to go rather than
 * just saying no. The brief is explicit that "a validation warning must not
 * silently reject a legitimate business name", so a name this function does not
 * like is still ACCEPTED as a request - it is flagged for the operator, not
 * refused at the door. The only outright refusals are duplicates, and both of
 * those name the thing that already exists.
 */
export async function requestBrand(input: BrandRequestInput): Promise<{ requestId: string; brandId: string }> {
  const { membership } = input;
  assertSellerPermission(membership, SellerPermission.BRAND_REQUEST);

  const name = input.requestedName.trim().replace(/\s+/g, ' ');
  const normalised = normaliseBrandName(name);

  if (normalised.length < 2) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Give the brand name as it appears on the product.', [
      { field: 'requestedName', code: 'TOO_SHORT' },
    ]);
  }

  if (name.length > 160) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'That brand name is too long.', [
      { field: 'requestedName', code: 'TOO_LONG' },
    ]);
  }

  const existing = await prisma.brand.findUnique({
    where: { nameNormalized: normalised },
    select: { id: true, name: true, status: true },
  });

  if (existing !== null && existing.status === 'APPROVED') {
    throw conflict(
      ErrorCode.BRAND_ALREADY_EXISTS,
      `${existing.name} is already in the catalogue. Choose it from the list instead.`,
      [{ field: 'requestedName', code: 'ALREADY_APPROVED', meta: { brandId: existing.id } }],
    );
  }

  if (existing !== null) {
    const mine = await prisma.brandRequest.findFirst({
      where: {
        sellerAccountId: membership.sellerAccountId,
        brandId: existing.id,
        status: { in: ['PENDING', 'INFORMATION_REQUESTED'] },
      },
      select: { id: true },
    });

    if (mine !== null) {
      throw conflict(
        ErrorCode.BRAND_ALREADY_EXISTS,
        `You have already asked for ${existing.name}. We will let you know when it is decided.`,
        [{ field: 'requestedName', code: 'REQUEST_PENDING', meta: { requestId: mine.id } }],
      );
    }
  }

  const requestId = newId();

  // The brand row is created PENDING alongside the request, rather than only on
  // approval. That is what lets the seller attach it to a draft and carry on
  // with the other five sections while an operator decides - and the draft's
  // own evaluation raises `BRAND_NOT_APPROVED` as a blocker, so it still cannot
  // be published on an unapproved name.
  const brandId = existing?.id ?? newId();

  await prisma.$transaction(async (tx) => {
    if (existing === null) {
      await tx.brand.create({
        data: {
          id: brandId,
          name,
          nameNormalized: normalised,
          slug: brandSlug(name),
          status: 'PENDING',
          manufacturerLegalName: input.manufacturerLegalName ?? null,
          websiteUrl: input.websiteUrl ?? null,
        },
      });
    }

    await tx.brandRequest.create({
      data: {
        id: requestId,
        sellerAccountId: membership.sellerAccountId,
        brandId,
        requestedName: name,
        manufacturerLegalName: input.manufacturerLegalName ?? null,
        websiteUrl: input.websiteUrl ?? null,
        justification: input.justification ?? null,
        status: 'PENDING',
        requestedByProfileId: membership.customerProfileId,
      },
    });
  });

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.brand.requested',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'brand_request',
    resourceId: requestId,
    summary: `Asked for the brand "${name}" to be added.`,
    correlationId: input.correlationId ?? null,
  });

  return { requestId, brandId };
}

/**
 * Advice on a name, without refusing it.
 *
 * Returned alongside the picker so a seller typing "Braun Original Best" is
 * warned before they submit, and can still submit. Every one of these is a
 * pattern an operator would otherwise reject by hand a week later, which is a
 * week the seller could not sell.
 */
export interface BrandNameWarning {
  code: string;
  message: string;
}

export function checkBrandName(name: string): BrandNameWarning[] {
  const warnings: BrandNameWarning[] = [];
  const trimmed = name.trim();

  if (/[®™©]/.test(trimmed)) {
    warnings.push({
      code: 'TRADEMARK_SYMBOL',
      message: 'Leave out ®, ™ and © - the brand name alone is what buyers search for.',
    });
  }

  if (/\b(original|genuine|best|premium|authentic|100%|cheap|sale)\b/i.test(trimmed)) {
    warnings.push({
      code: 'MARKETING_WORDS',
      message: 'Marketing words are not part of a brand name and will be removed on review.',
    });
  }

  if (/^[^a-zA-Z]*$/.test(trimmed)) {
    warnings.push({
      code: 'NO_LETTERS',
      message: 'A brand name normally contains letters.',
    });
  }

  if (trimmed !== trimmed.replace(/\s{2,}/g, ' ')) {
    warnings.push({ code: 'EXTRA_SPACES', message: 'There are extra spaces in this name.' });
  }

  if (/(.)\1{3,}/.test(trimmed)) {
    warnings.push({
      code: 'REPEATED_CHARACTERS',
      message: 'That looks like a typing slip - check the repeated characters.',
    });
  }

  return warnings;
}

/** This seller's own brand requests, with what happened to each. */
export async function listBrandRequests(membership: SellerMembership): Promise<
  {
    id: string;
    requestedName: string;
    status: string;
    decisionReason: string | null;
    createdAt: string;
    brandId: string | null;
  }[]
> {
  assertSellerPermission(membership, SellerPermission.LISTING_READ);

  const rows = await prisma.brandRequest.findMany({
    where: { sellerAccountId: membership.sellerAccountId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return rows.map((row) => ({
    id: row.id,
    requestedName: row.requestedName,
    status: row.status,
    decisionReason: row.decisionReason,
    createdAt: row.createdAt.toISOString(),
    brandId: row.brandId,
  }));
}

/** Withdraw a request nobody has decided yet. */
export async function withdrawBrandRequest(
  membership: SellerMembership,
  requestId: string,
): Promise<void> {
  assertSellerPermission(membership, SellerPermission.BRAND_REQUEST);

  const row = await prisma.brandRequest.findUnique({
    where: { id: requestId },
    select: { id: true, sellerAccountId: true, status: true },
  });

  if (row === null) throw notFound('Brand request');
  assertSellerOwnership(membership, row.sellerAccountId, 'Brand request');

  if (row.status !== 'PENDING' && row.status !== 'INFORMATION_REQUESTED') {
    throw conflict(ErrorCode.CONFLICT, 'This request has already been decided.');
  }

  await prisma.brandRequest.update({
    where: { id: requestId },
    data: { status: 'REJECTED', decisionReason: 'Withdrawn by the seller.', decidedAt: new Date() },
  });
}
