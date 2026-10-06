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
 *   - **Factories the operator VERIFIED, whose verification is still
 *     current** (Master row 13), by city, region and country, with the facts
 *     about capacity the seller gave. Never the street address, postcode or
 *     coordinates. A factory that was never sent, is waiting, was refused,
 *     or whose verification lapsed is not shown at all - the same rule as a
 *     certificate, for the same reason.
 *
 *   - **The registered name of a registered company** (LLP, private or public
 *     limited) - a public-register fact a buyer needs for contracts. Never for
 *     a sole trader or partnership, whose legal name is a person's name.
 *   - **Machines** the seller listed on a verified factory (name and count).
 *   - **An inspection history summary**: counts of reports independent
 *     agencies SIGNED on this seller's orders in the last twelve months, by
 *     result. Counts only - never a buyer, an order or a report.
 *
 * NEVER PUBLISHED: a sole trader's legal name, registration and tax numbers,
 * contact people, internal notes, verification documents or statuses.
 */
import type { SellerKind } from '../../generated/prisma/client.js';
import { notFound } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import { logoUrlFor } from '../seller/logo.service.js';
import { verifiedFactoryIds } from '../trust/factory.service.js';
import { env } from '../../config/env.js';
import { publicProductWhere } from './catalog.visibility.js';
import { sellerScore } from './product-review.service.js';
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
  /** Only for registered companies; see the header. */
  legalName: string | null;
  inspectionSummary: { months: number; reports: number; passed: number; failed: number } | null;
  /**
   * What buyers said about this seller's delivery and support, from published
   * reviews of goods it sold (JOURNEY-059). Null with no reviews, or with
   * reviews switched off. Never blended with `inspectionSummary`: one is
   * buyers' opinion, the other measured inspections.
   */
  reviewScore: { average: number; count: number } | null;
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
    machines: { name: string; quantity: number | null }[];
    /** When the operator verified it. */
    verifiedAt: string | null;
  }[];
  certifications: {
    standard: string;
    issuer: string;
    certificateNumber: string | null;
    scope: string | null;
    issuedOn: string | null;
    expiresOn: string | null;
    verifiedAt: string | null;
    /**
     * What was actually checked, in words a buyer can rely on: the evidence
     * was reviewed, or it was confirmed with the issuer or an official
     * register. Never "authentic" - an uploaded file proves nothing by itself.
     */
    verificationBadge: 'EVIDENCE_REVIEWED' | 'VERIFIED_WITH_ISSUER_OR_REGISTER';
  }[];
  /**
   * The categories this supplier is qualified to sell in, from the Audit
   * Console - each for one supply role and market, and nothing wider. Only
   * current qualifications; never the documents behind them.
   */
  qualifications: {
    category: string;
    supplyRole: string;
    destinationMarket: string | null;
    qualifiedAt: string | null;
    expiresAt: string | null;
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

/** Legal forms whose registered name is a public-register fact, not a person's name. */
const REGISTERED_COMPANY_FORMS = new Set<string>(['LIMITED_LIABILITY_PARTNERSHIP', 'PRIVATE_LIMITED_COMPANY', 'PUBLIC_LIMITED_COMPANY']);
const INSPECTION_HISTORY_MONTHS = 12;

/**
 * Signed inspection reports on a seller's orders in the last twelve months,
 * by result. Null when there were none, so a new supplier is not shown "0 of 0".
 */
export async function inspectionSummaryFor(
  sellerAccountId: string,
  now: Date = new Date(),
): Promise<{ months: number; reports: number; passed: number; failed: number } | null> {
  const since = new Date(now.getTime() - INSPECTION_HISTORY_MONTHS * 30 * 86_400_000);
  const rows = await prisma.inspectionReport.groupBy({
    by: ['result'],
    where: { status: 'SIGNED', signedAt: { gte: since }, job: { requirement: { sellerAccountId } } },
    _count: { _all: true },
  });
  const passed = rows.find((row) => row.result === 'PASS')?._count._all ?? 0;
  const failed = rows.find((row) => row.result === 'FAIL')?._count._all ?? 0;
  return passed + failed === 0 ? null : { months: INSPECTION_HISTORY_MONTHS, reports: passed + failed, passed, failed };
}

export async function supplierProfile(slug: string, now: Date = new Date()): Promise<SupplierProfile> {
  const account = await prisma.sellerAccount.findFirst({
    where: { ...verifiedSupplierWhere(), slug },
    select: {
      id: true,
      slug: true,
      legalName: true,
      displayName: true,
      kind: true,
      registrationCountry: true,
      approvedAt: true,
      logoStorageKey: true,
      description: true,
      businessProfile: { select: { websiteUrl: true, yearsInBusiness: true, legalForm: true } },
    },
  });
  if (account === null) throw notFound('Supplier');

  const today = new Date(now.toISOString().slice(0, 10));

  const [trust, verifiedFactories, allFactories, certifications, offers, inspectionSummary, qualifications] = await Promise.all([
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
    verifiedFactoryIds(account.id, now),
    prisma.sellerFactory.findMany({
      where: { sellerAccountId: account.id, archivedAt: null },
      orderBy: [{ createdAt: 'asc' }],
      select: {
        id: true,
        name: true,
        city: true,
        region: true,
        countryCode: true,
        establishedYear: true,
        workforceCount: true,
        monthlyCapacity: true,
        capacityUnit: true,
        productsMade: true,
        machines: { orderBy: [{ sortOrder: 'asc' }], select: { name: true, quantity: true } },
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
        verificationOutcome: true,
      },
    }),
    prisma.sellerOffer.findMany({
      where: { sellerAccountId: account.id, status: 'ACTIVE', archivedAt: null, product: publicProductWhere() },
      select: { productId: true, product: { select: { category: { select: { slug: true, name: true } } } } },
      distinct: ['productId'],
    }),
    inspectionSummaryFor(account.id, now),
    prisma.complianceCase.findMany({
      where: {
        sellerAccountId: account.id,
        level: 'SELLER_CATEGORY',
        status: 'QUALIFIED',
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { decidedAt: 'desc' },
      select: { supplyRole: true, destinationMarket: true, decidedAt: true, expiresAt: true, category: { select: { name: true } } },
    }),
  ]);
  const score = env.FEATURE_PRODUCT_REVIEWS ? await sellerScore(account.id) : null;

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
    legalName: REGISTERED_COMPANY_FORMS.has(account.businessProfile?.legalForm ?? '') ? account.legalName : null,
    inspectionSummary,
    reviewScore: score === null ? null : { average: score.average, count: score.count },
    factories: allFactories
      .filter((factory) => verifiedFactories.has(factory.id))
      .map(({ id, ...factory }) => ({ ...factory, verifiedAt: verifiedFactories.get(id)?.toISOString() ?? null })),
    certifications: certifications.map((certificate) => ({
      standard: certificate.standard,
      issuer: certificate.issuer,
      certificateNumber: certificate.certificateNumber,
      scope: certificate.scope,
      issuedOn: dateOnly(certificate.issuedOn),
      expiresOn: dateOnly(certificate.expiresOn),
      verifiedAt: certificate.verifiedAt?.toISOString() ?? null,
      verificationBadge:
        certificate.verificationOutcome === 'VERIFIED' ? ('VERIFIED_WITH_ISSUER_OR_REGISTER' as const) : ('EVIDENCE_REVIEWED' as const),
    })),
    qualifications: qualifications.map((row) => ({
      category: row.category.name,
      supplyRole: row.supplyRole,
      destinationMarket: row.destinationMarket === '' ? null : row.destinationMarket,
      qualifiedAt: row.decidedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
    })),
  };
}
