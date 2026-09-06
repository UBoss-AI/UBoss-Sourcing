/**
 * Product safety information, and whether a listing carries enough of it.
 *
 * Regulation (EU) 2023/988 has applied since 13 December 2024. Article 19 is
 * the one a catalogue answers to: a product may not be *offered* online unless
 * the listing already carries, before anyone buys, who made it, how to reach
 * them, what it is, and what the warnings are. Not on the packaging. Not in the
 * PDF. On the page.
 *
 * Three decisions here are worth stating, because each one is a place a
 * plausible-looking implementation gets it wrong.
 *
 *   - **Enforcement is a setting, and the checks run either way.** A shop
 *     selling only outside the Union has no Art. 19 obligation, and blocking
 *     its catalogue on one would be this software inventing law. So
 *     `gpsrEnforced` decides whether a gap stops a publication - but
 *     `assessProduct` reports the same gaps regardless, so an operator turning
 *     it on tomorrow can see today what it will cost them.
 *
 *   - **The EU responsible person is required only when the manufacturer is
 *     outside the Union.** Asking a German manufacturer for their own EU
 *     representative is nonsense, and a validator that did would be switched
 *     off within a week. The condition is the manufacturer's country, which is
 *     why `EconomicOperator` carries one.
 *
 *   - **A missing translation of a warning is a real gap, not a cosmetic one.**
 *     Art. 19(d) asks for language "easily understood by consumers". A Polish
 *     hospital shown an English-only warning has not been warned. The base-row
 *     text satisfies the article only for readers of the base language, so
 *     `missingWarningLanguages` names the rest.
 */
import { prisma } from '../../infra/prisma.js';

/** The countries whose operators need no separate EU representative. */
async function euVatCountryCodes(): Promise<Set<string>> {
  const rows = await prisma.country.findMany({
    where: { isEuVat: true },
    select: { code: true },
  });

  return new Set(rows.map((row) => row.code.toUpperCase()));
}

export interface GpsrGap {
  field: string;
  code: string;
  message: string;
}

export interface GpsrAssessment {
  /** True when the listing satisfies Art. 19 as far as this can tell. */
  compliant: boolean;
  /** Whether these gaps currently block publication. */
  enforced: boolean;
  gaps: GpsrGap[];
  /**
   * Languages the storefront serves that have no translated warning.
   *
   * Reported separately from `gaps` because it never blocks publication: a
   * missing translation is a job for the translation screen, and refusing to
   * publish until eight languages are done would stop a catalogue going live
   * at all. It is still the thing an auditor asks about.
   */
  missingWarningLanguages: string[];
}

export interface GpsrProductFacts {
  manufacturer: { legalName: string; email: string; countryCode: string } | null;
  euResponsible: { legalName: string; email: string; countryCode: string } | null;
  gtin: string | null;
  modelIdentifier: string | null;
  safetyWarnings: string | null;
  /** Languages that already have a translated warning. */
  warningLanguages?: readonly string[];
  /** Languages the storefront offers, for the translation gap report. */
  storefrontLanguages?: readonly string[];
}

function filled(value: string | null | undefined): boolean {
  return (value ?? '').trim().length > 0;
}

/**
 * Assess one product against Art. 19.
 *
 * Pure, so the whole rule set is testable without a database. `euCountries` is
 * passed in for the same reason - the caller loads it once for a page of
 * products rather than per row.
 */
export function assessGpsr(
  facts: GpsrProductFacts,
  euCountries: ReadonlySet<string>,
  enforced: boolean,
): GpsrAssessment {
  const gaps: GpsrGap[] = [];

  // Art. 19(a): who made it, and how to reach them directly.
  if (facts.manufacturer === null) {
    gaps.push({
      field: 'manufacturerId',
      code: 'MANUFACTURER_REQUIRED',
      message:
        'GPSR Art. 19(a): the listing must name the manufacturer, with a postal and an ' +
        'electronic address, before the product is offered for sale.',
    });
  } else if (!filled(facts.manufacturer.email)) {
    gaps.push({
      field: 'manufacturerId',
      code: 'MANUFACTURER_EMAIL_REQUIRED',
      message:
        `GPSR Art. 19(a): ${facts.manufacturer.legalName} has no electronic address. A buyer ` +
        'has to be able to reach the manufacturer, not only the shop.',
    });
  }

  // Art. 19(b) / Art. 16 GPSR: a responsible person inside the Union, but only
  // where the manufacturer is outside it.
  const manufacturerCountry = facts.manufacturer?.countryCode.toUpperCase() ?? null;
  const manufacturerInUnion = manufacturerCountry !== null && euCountries.has(manufacturerCountry);

  if (facts.manufacturer !== null && !manufacturerInUnion && facts.euResponsible === null) {
    gaps.push({
      field: 'euResponsibleId',
      code: 'EU_RESPONSIBLE_REQUIRED',
      message:
        `GPSR Art. 16: ${facts.manufacturer.legalName} is established in ` +
        `${manufacturerCountry ?? 'a country outside the Union'}, so a responsible person ` +
        'inside the Union must be named on the listing before it may be offered there.',
    });
  }

  // Art. 19(c): something an authority can identify the product by.
  if (!filled(facts.gtin) && !filled(facts.modelIdentifier)) {
    gaps.push({
      field: 'modelIdentifier',
      code: 'IDENTIFIER_REQUIRED',
      message:
        'GPSR Art. 19(c): give a GTIN or the manufacturer’s model identifier. Our own SKU is ' +
        'not one — it means nothing outside this installation, and a recall notice will not ' +
        'use it.',
    });
  }

  // Art. 19(d): the warnings themselves.
  if (!filled(facts.safetyWarnings)) {
    gaps.push({
      field: 'safetyWarnings',
      code: 'SAFETY_INFORMATION_REQUIRED',
      message:
        'GPSR Art. 19(d): the listing must carry the product’s warnings and safety ' +
        'information. Where a product genuinely carries none, say so explicitly rather than ' +
        'leaving the field empty.',
    });
  }

  const offered = facts.storefrontLanguages ?? [];
  const translated = new Set(facts.warningLanguages ?? []);

  const missingWarningLanguages = filled(facts.safetyWarnings)
    ? offered.filter((language) => !translated.has(language))
    : [];

  return { compliant: gaps.length === 0, enforced, gaps, missingWarningLanguages };
}

/**
 * Load the facts and assess, for one product.
 *
 * Used by the publish path and by the admin product screen, which is the point:
 * the checklist a catalogue manager reads before pressing Publish must be the
 * same one the server applies when they do.
 */
export async function assessProductGpsr(
  productId: string,
  storefrontLanguages: readonly string[],
): Promise<GpsrAssessment> {
  const [product, business, euCountries] = await Promise.all([
    prisma.product.findUnique({
      where: { id: productId },
      select: {
        gtin: true,
        modelIdentifier: true,
        safetyWarnings: true,
        manufacturer: { select: { legalName: true, email: true, countryCode: true } },
        euResponsible: { select: { legalName: true, email: true, countryCode: true } },
        translations: {
          where: { safetyWarnings: { not: null } },
          select: { language: true },
        },
      },
    }),
    prisma.businessProfile.findFirst({ select: { gpsrEnforced: true } }),
    euVatCountryCodes(),
  ]);

  if (product === null) {
    return {
      compliant: false,
      enforced: business?.gpsrEnforced ?? false,
      gaps: [{ field: 'product', code: 'NOT_FOUND', message: 'This product no longer exists.' }],
      missingWarningLanguages: [],
    };
  }

  return assessGpsr(
    {
      manufacturer: product.manufacturer,
      euResponsible: product.euResponsible,
      gtin: product.gtin,
      modelIdentifier: product.modelIdentifier,
      safetyWarnings: product.safetyWarnings,
      warningLanguages: product.translations.map((row) => row.language),
      storefrontLanguages,
    },
    euCountries,
    business?.gpsrEnforced ?? false,
  );
}

/** Whether this deployment blocks publication on the checks above. */
export async function gpsrEnforced(): Promise<boolean> {
  const business = await prisma.businessProfile.findFirst({ select: { gpsrEnforced: true } });
  return business?.gpsrEnforced ?? false;
}

export interface EconomicOperatorView {
  id: string;
  role: string;
  legalName: string;
  tradeName: string | null;
  address: unknown;
  countryCode: string;
  email: string;
  phone: string | null;
  website: string | null;
  /**
   * The manufacturer's Eudamed Single Registration Number, MDR Art. 31.
   *
   * On the company rather than on the product: one manufacturer registers
   * once, and the SRN it is issued covers every device it puts on the market.
   */
  eudamedSrn: string | null;
  isActive: boolean;
  /** How many published listings name this operator. Shown before archiving one. */
  productCount?: number;
}

export async function listEconomicOperators(options: {
  role?: string;
  includeArchived?: boolean;
} = {}): Promise<EconomicOperatorView[]> {
  const rows = await prisma.economicOperator.findMany({
    where: {
      ...(options.role === undefined ? {} : { role: options.role as never }),
      ...(options.includeArchived === true ? {} : { archivedAt: null }),
    },
    orderBy: [{ role: 'asc' }, { legalName: 'asc' }],
    include: {
      _count: { select: { manufacturedProducts: true, representedProducts: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    legalName: row.legalName,
    tradeName: row.tradeName,
    address: row.addressJson,
    countryCode: row.countryCode,
    email: row.email,
    phone: row.phone,
    website: row.website,
    eudamedSrn: row.eudamedSrn,
    isActive: row.isActive,
    // Both relations, summed: an operator can be a product's manufacturer and
    // another product's EU representative, and archiving it breaks either.
    productCount: row._count.manufacturedProducts + row._count.representedProducts,
  }));
}
