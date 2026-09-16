/**
 * Brands: searching them, and asking to be allowed to sell one.
 *
 * Two facts sit side by side here and neither one gives way to the other.
 *
 * **A brand ROW is marketplace-wide.** Three distributors selling the same
 * manufacturer's catheters attach to one `Brand`, or the buyer's brand filter
 * shows "B. Braun" three times and each one finds a third of the products. So a
 * seller never creates a brand; an operator approves the name once, for the
 * catalogue.
 *
 * **Being ALLOWED to sell one is per company.** That is what a `BrandRequest`
 * is: this seller, this brand, what evidence they gave, and what the
 * marketplace said. A distributor authorised for Benelux is not thereby
 * authorised for anybody else's brands, and the request row has always carried
 * a `justification` field asking exactly that question - "why is this seller
 * entitled to sell it".
 *
 * So the picker shows a seller THEIR OWN approved brands and nobody else's.
 * The alternative - every seller seeing every approved name - reads as
 * permission: a reseller who finds "B. Braun" in a dropdown reasonably
 * concludes the marketplace is happy for them to list it, and the first anybody
 * hears otherwise is a trademark complaint. A name that is missing from the
 * list is never a dead end, because requesting it is one button away and the
 * request is what an operator decides.
 *
 * A seller who asks for a brand that already exists gets that same request
 * flow, attached to the existing row - the row is not duplicated and the
 * catalogue does not fragment.
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
 * Which brands one company may put on a listing.
 *
 * Three sources, and they are not the same thing:
 *
 *   - Brands this seller has an APPROVED request for. The authorisation.
 *   - Brands this seller has an UNDECIDED request for. Not yet permission, but
 *     they belong in the picker so the seller can attach one to a draft and
 *     finish the other five sections while an operator decides. The draft's own
 *     evaluation still refuses to publish on an unapproved name.
 *   - Brands already on this seller's live offers. A safety net rather than a
 *     grant: an offer only exists because a listing on that brand was approved,
 *     and a request row tidied away years later must not silently strip a
 *     seller of a brand they are already trading under.
 *
 * Exported because two callers need the same answer and a second implementation
 * of "may this company use this brand" is how the picker and the publish gate
 * end up disagreeing.
 */
export async function entitledBrandIds(sellerAccountId: string): Promise<Set<string>> {
  const [requests, offers] = await Promise.all([
    prisma.brandRequest.findMany({
      where: {
        sellerAccountId,
        status: { in: ['APPROVED', 'PENDING', 'INFORMATION_REQUESTED'] },
        brandId: { not: null },
      },
      select: { brandId: true },
    }),
    prisma.sellerOffer.findMany({
      where: { sellerAccountId, brandId: { not: null } },
      select: { brandId: true },
      distinct: ['brandId'],
      take: 500,
    }),
  ]);

  const ids = new Set<string>();

  for (const row of [...requests, ...offers]) {
    if (row.brandId !== null) ids.add(row.brandId);
  }

  return ids;
}

/**
 * Whether this company may PUBLISH on a brand, as opposed to draft on one.
 *
 * Deliberately narrower than `entitledBrandIds`: an undecided request is enough
 * to attach a brand to a draft and enough to see it in the picker, and it is
 * not enough to put a product on sale under somebody else's name.
 */
export async function isBrandApprovedForSeller(
  sellerAccountId: string,
  brandId: string,
): Promise<boolean> {
  const [request, offer] = await Promise.all([
    prisma.brandRequest.findFirst({
      where: { sellerAccountId, brandId, status: 'APPROVED' },
      select: { id: true },
    }),
    prisma.sellerOffer.findFirst({ where: { sellerAccountId, brandId }, select: { id: true } }),
  ]);

  return request !== null || offer !== null;
}

/**
 * Search the brands THIS COMPANY may use.
 *
 * Scoped to the seller, not to the marketplace - see the header. A seller
 * searching for a brand they have no authorisation for finds nothing here and
 * is offered the request form, which is the honest answer: the name exists, but
 * whether this business may sell it is a question only the marketplace can
 * answer, and it has not been asked yet.
 *
 * A pending brand of the seller's own IS included, so they can attach it to a
 * draft while they wait. Nobody else's pending name ever is.
 */
export async function searchBrands(
  membership: SellerMembership,
  query: string,
  limit = 20,
): Promise<BrandSummary[]> {
  assertSellerPermission(membership, SellerPermission.LISTING_READ);

  const term = query.trim();
  const mine = await entitledBrandIds(membership.sellerAccountId);

  // Nothing to search. Returning early rather than issuing `id: { in: [] }`,
  // which is a query the database still has to plan.
  if (mine.size === 0) return [];

  const rows = await prisma.brand.findMany({
    where: {
      id: { in: [...mine] },
      // A brand this seller was refused, or one an operator retired, is not a
      // brand they may keep listing under.
      status: { in: ['APPROVED', 'PENDING'] },
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

  if (existing !== null) {
    const mine = await prisma.brandRequest.findFirst({
      where: {
        sellerAccountId: membership.sellerAccountId,
        brandId: existing.id,
        status: { in: ['PENDING', 'INFORMATION_REQUESTED', 'APPROVED'] },
      },
      select: { id: true, status: true },
    });

    /*
     * The only two refusals, and both are about THIS seller rather than about
     * the brand.
     *
     * A name that already exists in the catalogue is emphatically NOT a
     * refusal: the marketplace approving "B. Braun" for one distributor says
     * nothing about whether a second may sell it, and that second request is
     * the thing an operator is supposed to decide. It attaches to the existing
     * brand row, so the catalogue keeps one "B. Braun" and the buyer's filter
     * keeps working.
     */
    if (mine !== null && mine.status === 'APPROVED') {
      throw conflict(
        ErrorCode.BRAND_ALREADY_EXISTS,
        `You are already approved for ${existing.name}. Choose it from the list instead.`,
        [{ field: 'requestedName', code: 'ALREADY_APPROVED', meta: { brandId: existing.id } }],
      );
    }

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
