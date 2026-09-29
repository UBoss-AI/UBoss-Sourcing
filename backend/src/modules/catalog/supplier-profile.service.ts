/**
 * A verified supplier's public page - checklist Master row 5.
 *
 * Everything a buyer may see about a supplier, and nothing they may not.
 *
 * WHO HAS A PAGE
 *
 * Exactly the suppliers the home page lists (`verifiedSupplierWhere`): approved
 * by the operator, not suspended, not archived, with something live to sell.
 * Anyone else is a 404 - the same answer as a slug that never existed, so the
 * page cannot be used to learn that an application is pending or was refused.
 *
 * WHAT IS PUBLISHED
 *
 *   - The public name, kind, registration country, since when verified, logo,
 *     the seller's own description, website and years in business.
 *   - What they sell: product count and the categories it is filed under.
 *   - Export capability and markets, response time and capabilities, as the
 *     seller stated them on their trust profile.
 *   - **Certifications the operator VERIFIED and that have not expired.** A
 *     pending, rejected or expired certificate is not shown at all: listing
 *     it with a caveat would still put the claim on the page.
 *   - Factories by city, region and country, with the facts about capacity
 *     the seller gave. Never the street address, postcode or coordinates.
 *
 * NEVER PUBLISHED: the legal name, registration and tax numbers, contact
 * people, internal notes, verification documents or statuses.
 */
import type { SellerKind } from '../../generated/prisma/client.js';
import { notFound } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import { logoUrlFor } from '../seller/logo.service.js';
import { publicProductWhere } from './catalog.visibility.js';
import { verifiedSupplierWhere } from './supplier-directory.service.js';

export interface SupplierProfile {
  slug: string;
  displayName: string;
  kind: SellerKind;
  registrationCountry: string;
  verifiedAt: string | null;
  logoUrl: string | null;
  description: string | null;
  websiteUrl: string | null;
  yearsInBusiness: number | null;
  productCount: number;
  categories: { slug: string; name: string; productCount: number }[];
  exportCapable: boolean;
  exportMarkets: string[];
  yearsExporting: number | null;
  responseSlaHours: number | null;
  capabilities: string[];
  factories: {
    name: string;
    city: string;
    region: string | null;
    countryCode: string;
    establishedYear: number | null;
    workforceCount: number | null;
    monthlyCapacity: number | null;
    capacityUnit: string | null;
    productsMade: string | null;
  }[];
  certifications: {
    standard: string;
    issuer: string;
    certificateNumber: string | null;
    scope: string | null;
    issuedOn: string | null;
    expiresOn: string | null;
    verifiedAt: string | null;
  }[];
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '') : [];

const dateOnly = (value: Date | null): string | null => (value === null ? null : value.toISOString().slice(0, 10));

/** A website the page may link to: http(s) only, so a stored value can never become a script link. */
function safeWebsite(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function supplierProfile(slug: string, now: Date = new Date()): Promise<SupplierProfile> {
  const account = await prisma.sellerAccount.findFirst({
    where: { ...verifiedSupplierWhere(), slug },
    select: {
      id: true,
      slug: true,
      displayName: true,
      kind: true,
      registrationCountry: true,
      approvedAt: true,
      logoStorageKey: true,
      description: true,
      businessProfile: { select: { websiteUrl: true, yearsInBusiness: true } },
    },
  });
  if (account === null) throw notFound('Supplier');

  const today = new Date(now.toISOString().slice(0, 10));

  const [trust, factories, certifications, offers] = await Promise.all([
    prisma.sellerTrustProfile.findUnique({
      where: { sellerAccountId: account.id },
      select: {
        exportCapable: true,
        exportMarketsJson: true,
        yearsExporting: true,
        responseSlaHours: true,
        capabilitiesJson: true,
      },
    }),
    prisma.sellerFactory.findMany({
      where: { sellerAccountId: account.id, archivedAt: null },
      orderBy: [{ createdAt: 'asc' }],
      select: {
        name: true,
        city: true,
        region: true,
        countryCode: true,
        establishedYear: true,
        workforceCount: true,
        monthlyCapacity: true,
        capacityUnit: true,
        productsMade: true,
      },
    }),
    prisma.sellerCertification.findMany({
      where: {
        sellerAccountId: account.id,
        state: 'VERIFIED',
        archivedAt: null,
        expiredAt: null,
        OR: [{ expiresOn: null }, { expiresOn: { gte: today } }],
      },
      orderBy: [{ standard: 'asc' }],
      select: {
        standard: true,
        issuer: true,
        certificateNumber: true,
        scope: true,
        issuedOn: true,
        expiresOn: true,
        verifiedAt: true,
      },
    }),
    prisma.sellerOffer.findMany({
      where: { sellerAccountId: account.id, status: 'ACTIVE', archivedAt: null, product: publicProductWhere() },
      select: { productId: true, product: { select: { category: { select: { slug: true, name: true } } } } },
      distinct: ['productId'],
    }),
  ]);

  const byCategory = new Map<string, { slug: string; name: string; productCount: number }>();
  for (const offer of offers) {
    const category = offer.product.category;
    const entry = byCategory.get(category.slug) ?? { slug: category.slug, name: category.name, productCount: 0 };
    entry.productCount += 1;
    byCategory.set(category.slug, entry);
  }

  return {
    slug: account.slug,
    displayName: account.displayName,
    kind: account.kind,
    registrationCountry: account.registrationCountry,
    verifiedAt: account.approvedAt?.toISOString() ?? null,
    logoUrl: logoUrlFor(account.logoStorageKey),
    description: account.description,
    websiteUrl: safeWebsite(account.businessProfile?.websiteUrl),
    yearsInBusiness: account.businessProfile?.yearsInBusiness ?? null,
    productCount: offers.length,
    categories: [...byCategory.values()].sort((a, b) => b.productCount - a.productCount || a.name.localeCompare(b.name)),
    exportCapable: trust?.exportCapable ?? false,
    exportMarkets: strings(trust?.exportMarketsJson),
    yearsExporting: trust?.yearsExporting ?? null,
    responseSlaHours: trust?.responseSlaHours ?? null,
    capabilities: strings(trust?.capabilitiesJson),
    factories,
    certifications: certifications.map((certificate) => ({
      standard: certificate.standard,
      issuer: certificate.issuer,
      certificateNumber: certificate.certificateNumber,
      scope: certificate.scope,
      issuedOn: dateOnly(certificate.issuedOn),
      expiresOn: dateOnly(certificate.expiresOn),
      verifiedAt: certificate.verifiedAt?.toISOString() ?? null,
    })),
  };
}
