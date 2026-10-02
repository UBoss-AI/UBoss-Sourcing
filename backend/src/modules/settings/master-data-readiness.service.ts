/**
 * Master-data readiness (LIVE-019): is the reference data a live marketplace
 * needs actually present, and is anything left over from the demonstration
 * seed?
 *
 * A deployment can boot, sign people in and show an empty storefront with
 * half its reference data missing - no tax class, no published terms, no
 * delivery price - and nothing complains until the first buyer reaches
 * checkout. This is the list somebody goes through before going live, read
 * from the tables themselves, so it cannot drift from what the system uses.
 *
 * Each check is REQUIRED (going live without it breaks a flow) or ADVISED
 * (the marketplace works, but a part of it will be empty). A check reports a
 * status and a count; the console words it.
 *
 * Demonstration rows are found by what the seed itself writes, never by a
 * guess: the demo catalogue table, the development-placeholder terms, the
 * seed's carrier code, and accounts on the reserved `.local` domain (every
 * seeded account uses it, and no real address can).
 *
 * Read-only. Nothing here changes data.
 */
import { prisma } from '../../infra/prisma.js';
import { DEVELOPMENT_TERMS_VERSION } from '../legal/development-terms.js';

export type ReadinessStatus = 'OK' | 'MISSING' | 'WARNING';

export interface ReadinessCheck {
  key: string;
  required: boolean;
  status: ReadinessStatus;
  count: number;
}

export interface DemoFinding {
  key: string;
  count: number;
}

export interface MasterDataReadiness {
  generatedAt: string;
  /** True when no REQUIRED check is missing and no demonstration row is left. */
  ready: boolean;
  missingRequired: number;
  checks: ReadinessCheck[];
  demo: DemoFinding[];
}

/** The carrier the development seed creates. */
export const SEED_CARRIER_CODE = 'LP-DEV-MERIDIAN';
/** How old the newest exchange-rate list may be before it is called stale. */
const FX_STALE_DAYS = 7;

function check(key: string, required: boolean, count: number, ok = count > 0): ReadinessCheck {
  return { key, required, count, status: ok ? 'OK' : required ? 'MISSING' : 'WARNING' };
}

export async function masterDataReadiness(now: Date = new Date()): Promise<MasterDataReadiness> {
  const [
    categories,
    currencies,
    baseCurrencies,
    taxClasses,
    countries,
    marketRules,
    shippingMethods,
    publishedLevelRates,
    inspectionRules,
    inspectionPlans,
    inspectionAgencies,
    platformTerms,
    privacyPolicy,
    units,
    defectCodes,
    incoterms,
    latestSnapshot,
  ] = await Promise.all([
    prisma.category.count({ where: { isActive: true, archivedAt: null } }),
    prisma.currency.count({ where: { isActive: true } }),
    prisma.currency.count({ where: { isActive: true, isBase: true } }),
    prisma.taxClass.count({ where: { isActive: true } }),
    prisma.country.count({ where: { isActive: true } }),
    prisma.marketRule.count({ where: { isActive: true } }),
    prisma.shippingMethod.count({ where: { isActive: true } }),
    prisma.logisticsLevelRate.count({ where: { status: 'PUBLISHED' } }),
    prisma.inspectionRule.count({ where: { isActive: true } }),
    prisma.inspectionPlan.count({ where: { isActive: true } }),
    prisma.inspectionAgency.count({ where: { status: 'ACTIVE' } }),
    prisma.legalDocument.count({
      where: { kind: 'PLATFORM_TERMS', status: 'PUBLISHED', version: { not: DEVELOPMENT_TERMS_VERSION } },
    }),
    prisma.legalDocument.count({ where: { kind: 'PRIVACY_POLICY', status: 'PUBLISHED' } }),
    prisma.masterDataEntry.count({ where: { kind: 'UOM', isActive: true } }),
    prisma.masterDataEntry.count({ where: { kind: 'DEFECT_CODE', isActive: true } }),
    prisma.masterDataEntry.count({ where: { kind: 'INCOTERM', isActive: true } }),
    prisma.exchangeRateSnapshot.findFirst({
      where: { isActive: true },
      orderBy: { fetchedAt: 'desc' },
      select: { fetchedAt: true },
    }),
  ]);

  // Rates matter only once there is more than one currency to convert between.
  const needsRates = currencies > 1;
  const ratesFresh =
    latestSnapshot !== null && now.getTime() - latestSnapshot.fetchedAt.getTime() <= FX_STALE_DAYS * 86_400_000;

  const checks: ReadinessCheck[] = [
    check('categories', true, categories),
    check('currencies', true, currencies),
    // Exactly one: two base currencies make every conversion ambiguous.
    check('baseCurrency', true, baseCurrencies, baseCurrencies === 1),
    check('exchangeRates', needsRates, latestSnapshot === null ? 0 : 1, !needsRates || ratesFresh),
    check('taxClasses', true, taxClasses),
    check('countries', true, countries),
    check('marketRules', false, marketRules),
    check('deliveryRates', true, shippingMethods + publishedLevelRates),
    check('inspectionRules', false, inspectionRules),
    check('inspectionPlans', false, inspectionPlans),
    check('inspectionAgencies', false, inspectionAgencies),
    check('platformTerms', true, platformTerms),
    check('privacyPolicy', true, privacyPolicy),
    check('units', true, units),
    check('defectCodes', inspectionRules > 0, defectCodes),
    check('incoterms', false, incoterms),
  ];

  const [demoProducts, developmentTerms, seedCarrier, localAccounts] = await Promise.all([
    prisma.demoCatalogEntry.count(),
    prisma.legalDocument.count({ where: { version: DEVELOPMENT_TERMS_VERSION, status: 'PUBLISHED' } }),
    prisma.logisticsPartner.count({ where: { partnerCode: SEED_CARRIER_CODE } }),
    prisma.user.count({
      where: { emailNormalized: { endsWith: '.local' }, archivedAt: null, erasedAt: null, status: { not: 'DEACTIVATED' } },
    }),
  ]);

  const demo: DemoFinding[] = [
    { key: 'demoProducts', count: demoProducts },
    { key: 'developmentTerms', count: developmentTerms },
    { key: 'seedCarrier', count: seedCarrier },
    { key: 'localAccounts', count: localAccounts },
  ];

  const missingRequired = checks.filter((entry) => entry.status === 'MISSING').length;
  return {
    generatedAt: now.toISOString(),
    ready: missingRequired === 0 && demo.every((entry) => entry.count === 0),
    missingRequired,
    checks,
    demo,
  };
}
