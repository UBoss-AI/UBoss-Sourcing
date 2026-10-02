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
import { listingMarketRules, type ListingMarketRule } from '../catalog/market-eligibility.service.js';

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
  /**
   * Production capacity on THIS listing (JOURNEY-028): units the seller can
   * make per week, and the days before the first of them is ready. Stored on
   * the offer itself, where preorders and RFQ matching already read it.
   * Left out, the stored values are kept; null clears them.
   */
  capacityUnitsPerWeek?: number | null;
  capacityLeadTimeDays?: number | null;
}

export interface ListingSourcingView
  extends Omit<ListingSourcingInput, 'certificationIds' | 'capacityUnitsPerWeek' | 'capacityLeadTimeDays'> {
  certifications: { id: string; standard: string; issuer: string; expiresOn: string | null }[];
}

/** The listing's capacity, read from the offer. */
export interface ListingCapacity {
  capacityUnitsPerWeek: number | null;
  capacityLeadTimeDays: number | null;
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

async function ownOffer(
  membership: SellerMembership,
  offerId: string,
): Promise<{ productId: string; capacity: ListingCapacity }> {
  const offer = await prisma.sellerOffer.findUnique({
    where: { id: offerId },
    select: { sellerAccountId: true, productId: true, capacityUnitsPerWeek: true, capacityLeadTimeDays: true },
  });
  if (offer === null) throw notFound('Listing');
  assertSellerOwnership(membership, offer.sellerAccountId, 'Listing');
  return {
    productId: offer.productId,
    capacity: { capacityUnitsPerWeek: offer.capacityUnitsPerWeek, capacityLeadTimeDays: offer.capacityLeadTimeDays },
  };
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
  const { productId, capacity } = await ownOffer(membership, offerId);
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
    capacity,
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
): Promise<ListingSourcingView & { capacity: ListingCapacity }> {
  assertSellerPermission(membership, SellerPermission.LISTING_WRITE);
  const { productId, capacity: capacityBefore } = await ownOffer(membership, offerId);
  const capacity: ListingCapacity = {
    capacityUnitsPerWeek:
      input.capacityUnitsPerWeek === undefined ? capacityBefore.capacityUnitsPerWeek : input.capacityUnitsPerWeek,
    capacityLeadTimeDays:
      input.capacityLeadTimeDays === undefined ? capacityBefore.capacityLeadTimeDays : input.capacityLeadTimeDays,
  };
  if (capacity.capacityLeadTimeDays !== null && capacity.capacityUnitsPerWeek === null) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Give the weekly capacity the lead time applies to.', [
      { field: 'capacityUnitsPerWeek', code: 'REQUIRED' },
    ]);
  }
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
    await tx.sellerOffer.update({ where: { id: offerId }, data: capacity });
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
      before: before === null ? { ...capacityBefore } : { ...before, ...capacityBefore },
      after: { ...data, certificationIds, ...capacity },
      correlationId: context.correlationId ?? null,
    });
  });
  const saved = await viewFor(membership.sellerAccountId, productId, now);
  if (saved === null) throw notFound('Listing');
  return { ...saved, capacity };
}

/** What a buyer sees on the product page for the seller the page is priced from. */
export async function publicListingSourcing(sellerAccountId: string, productId: string, now: Date = new Date()) {
  const view = await viewFor(sellerAccountId, productId, now);
  if (view === null) return null;
  return { ...view, certifications: view.certifications.map(({ id: _id, ...certificate }) => certificate) };
}

export interface ListingMarketEligibility {
  /** The listing's own status: only an ACTIVE listing is buyable anywhere. */
  status: string;
  /** A lapsed or refused certificate holds the listing everywhere until it is renewed. */
  complianceHolds: { certificationId: string; standard: string; heldAt: string }[];
  /** Every country rule in force that touches this product. Countries not listed are open. */
  rules: ListingMarketRule[];
  /** The countries the product cannot be sold into at all (an unconditional BLOCK). */
  blockedCountries: string[];
  /** The countries that sell it only to a buyer holding named documents, or above an order value. */
  restrictedCountries: string[];
}

/**
 * Where one of the seller's listings may be sold, and why not elsewhere
 * (JOURNEY-028). The rules are the operator's, read through the same
 * function the catalogue and the checkout use; this only gathers them.
 */
export async function readListingMarketEligibility(
  membership: SellerMembership,
  offerId: string,
  now: Date = new Date(),
): Promise<ListingMarketEligibility> {
  assertSellerPermission(membership, SellerPermission.LISTING_READ);
  const offer = await prisma.sellerOffer.findUnique({
    where: { id: offerId },
    select: {
      sellerAccountId: true,
      status: true,
      product: { select: { id: true, categoryId: true } },
      complianceHolds: {
        where: { releasedAt: null },
        select: { certificationId: true, heldAt: true, certification: { select: { standard: true } } },
      },
    },
  });
  if (offer === null) throw notFound('Listing');
  assertSellerOwnership(membership, offer.sellerAccountId, 'Listing');

  const rules = await listingMarketRules(offer.product, now);
  const blocked = new Set(
    rules.filter((rule) => rule.effect === 'BLOCK' && rule.minOrderValueMinor === null).map((rule) => rule.countryCode),
  );
  const restricted = new Set(
    rules.map((rule) => rule.countryCode).filter((country) => !blocked.has(country)),
  );

  return {
    status: String(offer.status),
    complianceHolds: offer.complianceHolds.map((hold) => ({
      certificationId: hold.certificationId,
      standard: hold.certification.standard,
      heldAt: hold.heldAt.toISOString(),
    })),
    rules,
    blockedCountries: [...blocked].sort(),
    restrictedCountries: [...restricted].sort(),
  };
}
