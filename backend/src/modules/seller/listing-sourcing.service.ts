/**
 * Sourcing terms on a listing (checklist JOURNEY-002, JOURNEY-004, JOURNEY-029).
 *
 * What a B2B buyer asks before they ask the price: can I get a sample, how long
 * does a bulk order take to make, will you put my brand on it (private label)
 * or make it to my design (OEM), on which Incoterms do you quote, and which of
 * your verified certificates cover it. One row per seller and product
 * (`seller_listing_trust`), written by the seller on their own listing only.
 *
 * Certificates are linked, never typed: a seller can attach only a certificate
 * of their own that the operator VERIFIED and that is still in date, and the
 * buyer sees it only while that stays true. A claim the operator never checked
 * does not reach the product page.
 */
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { INCOTERMS } from '../../domain/packaging.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { assertSellerOwnership, assertSellerPermission, type SellerMembership } from './account.service.js';
import { recordSellerAudit } from './audit.service.js';

/** Incoterms 2020: the one list the packaging and freight screens already use. */
export { INCOTERMS };
export type Incoterm = (typeof INCOTERMS)[number];

export interface ListingSourcingInput {
  sampleAvailable: boolean;
  sampleNote: string | null;
  privateLabelAvailable: boolean;
  oemAvailable: boolean;
  leadTimeDaysMin: number | null;
  leadTimeDaysMax: number | null;
  incoterms: Incoterm[];
  certificationIds: string[];
}

export interface ListingSourcingView extends Omit<ListingSourcingInput, 'certificationIds'> {
  certifications: { id: string; standard: string; issuer: string; expiresOn: string | null }[];
}

function incotermsOf(value: unknown): Incoterm[] {
  return Array.isArray(value) ? value.filter((code): code is Incoterm => INCOTERMS.includes(code as Incoterm)) : [];
}

function today(now: Date): Date {
  return new Date(now.toISOString().slice(0, 10));
}

/** The seller's own certificates that may be linked: verified, current, not archived. */
function linkableCertificateWhere(sellerAccountId: string, now: Date) {
  return {
    sellerAccountId,
    state: 'VERIFIED' as const,
    archivedAt: null,
    expiredAt: null,
    OR: [{ expiresOn: null }, { expiresOn: { gte: today(now) } }],
  };
}

async function ownOffer(membership: SellerMembership, offerId: string): Promise<{ productId: string }> {
  const offer = await prisma.sellerOffer.findUnique({ where: { id: offerId }, select: { sellerAccountId: true, productId: true } });
  if (offer === null) throw notFound('Listing');
  assertSellerOwnership(membership, offer.sellerAccountId, 'Listing');
  return { productId: offer.productId };
}

async function viewFor(sellerAccountId: string, productId: string, now: Date): Promise<ListingSourcingView | null> {
  const row = await prisma.sellerListingTrust.findUnique({
    where: { sellerAccountId_productId: { sellerAccountId, productId } },
    include: {
      certifications: {
        where: { certification: linkableCertificateWhere(sellerAccountId, now) },
        select: { certification: { select: { id: true, standard: true, issuer: true, expiresOn: true } } },
      },
    },
  });
  if (row === null) return null;
  return {
    sampleAvailable: row.sampleAvailable,
    sampleNote: row.sampleNote,
    privateLabelAvailable: row.privateLabelAvailable,
    oemAvailable: row.oemAvailable,
    leadTimeDaysMin: row.leadTimeDaysMin,
    leadTimeDaysMax: row.leadTimeDaysMax,
    incoterms: incotermsOf(row.incotermsJson),
    certifications: row.certifications.map(({ certification }) => ({
      id: certification.id,
      standard: certification.standard,
      issuer: certification.issuer,
      expiresOn: certification.expiresOn?.toISOString().slice(0, 10) ?? null,
    })),
  };
}

/** The seller's terms on one of their listings, and the certificates they may link. */
export async function readListingSourcing(membership: SellerMembership, offerId: string, now: Date = new Date()) {
  assertSellerPermission(membership, SellerPermission.LISTING_READ);
  const { productId } = await ownOffer(membership, offerId);
  const [terms, linkable] = await Promise.all([
    viewFor(membership.sellerAccountId, productId, now),
    prisma.sellerCertification.findMany({
      where: linkableCertificateWhere(membership.sellerAccountId, now),
      orderBy: [{ standard: 'asc' }],
      select: { id: true, standard: true, issuer: true, expiresOn: true },
    }),
  ]);
  return {
    terms,
    incoterms: INCOTERMS,
    linkableCertifications: linkable.map((row) => ({ ...row, expiresOn: row.expiresOn?.toISOString().slice(0, 10) ?? null })),
  };
}

/** Replace the seller's terms on one of their listings. Validated and audited. */
export async function saveListingSourcing(
  membership: SellerMembership,
  offerId: string,
  input: ListingSourcingInput,
  context: { correlationId?: string | null } = {},
  now: Date = new Date(),
): Promise<ListingSourcingView> {
  assertSellerPermission(membership, SellerPermission.LISTING_WRITE);
  const { productId } = await ownOffer(membership, offerId);
  if (input.leadTimeDaysMin !== null && input.leadTimeDaysMax !== null && input.leadTimeDaysMin > input.leadTimeDaysMax) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The shortest lead time cannot be longer than the longest.', [
      { field: 'leadTimeDaysMin', code: 'GREATER_THAN_MAX' },
    ]);
  }
  const certificationIds = [...new Set(input.certificationIds)];
  if (certificationIds.length > 0) {
    const allowed = await prisma.sellerCertification.count({
      where: { id: { in: certificationIds }, ...linkableCertificateWhere(membership.sellerAccountId, now) },
    });
    if (allowed !== certificationIds.length) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Link only your own certificates that the marketplace verified and that are in date.', [
        { field: 'certificationIds', code: 'NOT_LINKABLE' },
      ]);
    }
  }
  const before = await viewFor(membership.sellerAccountId, productId, now);
  const data = {
    sampleAvailable: input.sampleAvailable,
    sampleNote: input.sampleAvailable ? input.sampleNote : null,
    privateLabelAvailable: input.privateLabelAvailable,
    oemAvailable: input.oemAvailable,
    leadTimeDaysMin: input.leadTimeDaysMin,
    leadTimeDaysMax: input.leadTimeDaysMax,
    incotermsJson: [...new Set(input.incoterms)].sort(),
  };
  await prisma.$transaction(async (tx) => {
    const row = await tx.sellerListingTrust.upsert({
      where: { sellerAccountId_productId: { sellerAccountId: membership.sellerAccountId, productId } },
      create: { id: newId(), sellerAccountId: membership.sellerAccountId, productId, ...data },
      update: data,
      select: { id: true },
    });
    await tx.sellerListingCertification.deleteMany({ where: { listingTrustId: row.id } });
    if (certificationIds.length > 0) {
      await tx.sellerListingCertification.createMany({
        data: certificationIds.map((certificationId) => ({ id: newId(), listingTrustId: row.id, certificationId })),
      });
    }
    await recordSellerAudit({
      tx,
      sellerAccountId: membership.sellerAccountId,
      action: 'seller.listing.sourcing_updated',
      actor: { type: 'CUSTOMER', label: membership.displayName },
      resourceType: 'seller_offer',
      resourceId: offerId,
      before,
      after: { ...data, certificationIds },
      correlationId: context.correlationId ?? null,
    });
  });
  const saved = await viewFor(membership.sellerAccountId, productId, now);
  if (saved === null) throw notFound('Listing');
  return saved;
}

/** What a buyer sees on the product page for the seller the page is priced from. */
export async function publicListingSourcing(sellerAccountId: string, productId: string, now: Date = new Date()) {
  const view = await viewFor(sellerAccountId, productId, now);
  if (view === null) return null;
  return { ...view, certifications: view.certifications.map(({ id: _id, ...certificate }) => certificate) };
}
