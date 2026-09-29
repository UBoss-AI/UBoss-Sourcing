/**
 * The "Ownership, registrations and exports" section of the seller
 * application: the legal form, India's Udyam and IEC numbers, whether and
 * where the business already exports, the categories it means to sell in, and
 * the people who own or control it.
 *
 * Written by the seller while the application is editable, read back by the
 * seller and - through `application-review.service.ts` - by the reviewer.
 * What it still needs is judged by `domain/seller-kyb.ts`, and the checklist
 * step it belongs to (`kyb_kyc`) is marked by `markRequirementSteps`, never
 * here: one function marks a step.
 *
 * The audit entry names what changed, never a value. A Udyam number in an
 * audit summary is a Udyam number in every export of the audit log.
 */
import { ErrorCode, badRequest, type ErrorDetail } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import {
  FULL_OWNERSHIP_BASIS_POINTS,
  MAX_BENEFICIAL_OWNERS,
  MAX_EXPORT_MARKETS,
  MAX_INTENDED_CATEGORIES,
  canonicalIec,
  canonicalUdyam,
  sellerRegistrationRegister,
  totalOwnership,
  type KybGap,
  type SellerLegalFormName,
} from '../../domain/seller-kyb.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import {
  assertApplicationEditable,
  assertSellerPermission,
  type SellerMembership,
} from './account.service.js';
import { recordSellerAudit } from './audit.service.js';
import { kybGapsFor, kybPolicy, stringList } from './kyb-facts.service.js';
import { markRequirementSteps } from './onboarding.service.js';

export interface KybOwnerInput {
  /** An owner already on the application, to change in place. */
  id?: string | null;
  fullName: string;
  nationality: string | null;
  /** 2500 = 25.00%. */
  ownershipBasisPoints: number;
  role: string | null;
  isControllingPerson: boolean;
  isPoliticallyExposed: boolean;
}

export interface KybInput {
  legalForm: SellerLegalFormName | null;
  udyamNumber: string | null;
  iecNumber: string | null;
  exportCapable: boolean;
  exportMarkets: string[];
  yearsExporting: number | null;
  intendedCategoryIds: string[];
  beneficialOwners: KybOwnerInput[];
}

export interface KybOwnerView {
  id: string;
  fullName: string;
  nationality: string | null;
  ownershipBasisPoints: number;
  role: string | null;
  isControllingPerson: boolean;
  isPoliticallyExposed: boolean;
}

export interface KybView {
  isEditable: boolean;
  /** India's identifiers (Udyam, IEC) are asked for only here. */
  isIndia: boolean;
  policy: { beneficialOwnersRequired: boolean };
  /** The registration number the legal form calls for, where one is named. */
  registrationNumberName: 'CIN' | 'LLPIN' | null;
  legalForm: SellerLegalFormName | null;
  udyamNumber: string | null;
  iecNumber: string | null;
  exportCapable: boolean;
  exportMarkets: string[];
  yearsExporting: number | null;
  intendedCategories: { id: string; name: string }[];
  beneficialOwners: KybOwnerView[];
  ownershipTotalBasisPoints: number;
  /** What the section still needs, in the words the checklist uses. */
  outstanding: KybGap[];
}

const OWNER_SELECT = {
  id: true,
  fullName: true,
  nationality: true,
  ownershipBasisPoints: true,
  role: true,
  isControllingPerson: true,
  isPoliticallyExposed: true,
} as const;

/** The section's rows, as the seller and the reviewer both see them. */
export async function loadKybView(
  sellerAccountId: string,
  registrationCountry: string,
): Promise<Omit<KybView, 'isEditable'>> {
  const [profile, trust, owners, outstanding] = await Promise.all([
    prisma.sellerBusinessProfile.findUnique({
      where: { sellerAccountId },
      select: { legalForm: true },
    }),
    prisma.sellerTrustProfile.findUnique({
      where: { sellerAccountId },
      select: {
        udyamNumber: true,
        iecNumber: true,
        exportCapable: true,
        exportMarketsJson: true,
        yearsExporting: true,
        intendedCategoryIdsJson: true,
      },
    }),
    prisma.sellerBeneficialOwner.findMany({
      where: { sellerAccountId, archivedAt: null },
      orderBy: [{ ownershipBasisPoints: 'desc' }, { createdAt: 'asc' }],
      select: OWNER_SELECT,
    }),
    kybGapsFor(sellerAccountId, registrationCountry),
  ]);

  const categoryIds = stringList(trust?.intendedCategoryIdsJson);
  const categories =
    categoryIds.length === 0
      ? []
      : await prisma.category.findMany({
          where: { id: { in: categoryIds } },
          select: { id: true, name: true },
        });
  const nameById = new Map(categories.map((category) => [category.id, category.name]));

  const legalForm = (profile?.legalForm ?? null);
  const register = sellerRegistrationRegister(registrationCountry, legalForm);

  return {
    isIndia: registrationCountry.toUpperCase() === 'IN',
    policy: kybPolicy(),
    registrationNumberName: register === 'IN_CIN' ? 'CIN' : register === 'IN_LLPIN' ? 'LLPIN' : null,
    legalForm,
    udyamNumber: trust?.udyamNumber ?? null,
    iecNumber: trust?.iecNumber ?? null,
    exportCapable: trust?.exportCapable ?? false,
    exportMarkets: stringList(trust?.exportMarketsJson),
    yearsExporting: trust?.yearsExporting ?? null,
    // In the order the seller chose them. A category archived since keeps its
    // place with the id as its name, so it does not silently disappear.
    intendedCategories: categoryIds.map((id) => ({ id, name: nameById.get(id) ?? id })),
    beneficialOwners: owners,
    ownershipTotalBasisPoints: totalOwnership(owners),
    outstanding,
  };
}

/**
 * The section, for the seller.
 *
 * ACCOUNT_WRITE rather than ACCOUNT_READ to READ it: the owners listed here
 * are people outside the organisation, with their nationality and whether
 * they hold public office, and every role in the building holds
 * ACCOUNT_READ. Owners and administrators fill it in; nobody else needs it.
 */
export async function readKyb(membership: SellerMembership): Promise<KybView> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_WRITE);

  const view = await loadKybView(membership.sellerAccountId, membership.registrationCountry);
  return { ...view, isEditable: membership.isApplicationEditable };
}

/** Every refusal at once, each on its field, so the form can mark them all. */
async function validate(
  membership: SellerMembership,
  input: KybInput,
): Promise<{ udyam: string | null; iec: string | null; details: ErrorDetail[] }> {
  const details: ErrorDetail[] = [];
  const isIndia = membership.registrationCountry.toUpperCase() === 'IN';

  let udyam: string | null = null;
  let iec: string | null = null;

  const udyamText = (input.udyamNumber ?? '').trim();
  if (udyamText.length > 0) {
    if (!isIndia) details.push({ field: 'udyamNumber', code: 'NOT_APPLICABLE' });
    else {
      udyam = canonicalUdyam(udyamText);
      if (udyam === null) details.push({ field: 'udyamNumber', code: 'UDYAM_FORMAT' });
    }
  }

  const iecText = (input.iecNumber ?? '').trim();
  if (iecText.length > 0) {
    if (!isIndia) details.push({ field: 'iecNumber', code: 'NOT_APPLICABLE' });
    else {
      iec = canonicalIec(iecText);
      if (iec === null) details.push({ field: 'iecNumber', code: 'IEC_FORMAT' });
    }
  }

  // --- Countries: the export markets and every owner's nationality ---------

  const markets = input.exportCapable ? [...new Set(input.exportMarkets.map((code) => code.toUpperCase()))] : [];
  if (markets.length > MAX_EXPORT_MARKETS) details.push({ field: 'exportMarkets', code: 'TOO_MANY' });

  const nationalities = input.beneficialOwners
    .map((owner) => owner.nationality?.toUpperCase() ?? null)
    .filter((code): code is string => code !== null && code.length > 0);
  const wanted = [...new Set([...markets, ...nationalities])];
  const known = new Set(
    wanted.length === 0
      ? []
      : (await prisma.country.findMany({ where: { code: { in: wanted } }, select: { code: true } })).map(
          (row) => row.code,
        ),
  );
  for (const code of markets) {
    if (!known.has(code)) details.push({ field: 'exportMarkets', code: 'UNKNOWN_COUNTRY', meta: { country: code } });
  }

  // --- Categories -----------------------------------------------------------

  const categoryIds = [...new Set(input.intendedCategoryIds)];
  if (categoryIds.length > MAX_INTENDED_CATEGORIES) {
    details.push({ field: 'intendedCategoryIds', code: 'TOO_MANY' });
  } else if (categoryIds.length > 0) {
    const found = new Set(
      (
        await prisma.category.findMany({
          where: { id: { in: categoryIds }, archivedAt: null },
          select: { id: true },
        })
      ).map((row) => row.id),
    );
    for (const id of categoryIds) {
      if (!found.has(id)) details.push({ field: 'intendedCategoryIds', code: 'UNKNOWN_CATEGORY', meta: { categoryId: id } });
    }
  }

  // --- Owners ---------------------------------------------------------------

  if (input.beneficialOwners.length > MAX_BENEFICIAL_OWNERS) {
    details.push({ field: 'beneficialOwners', code: 'TOO_MANY' });
  }

  input.beneficialOwners.forEach((owner, index) => {
    const at = `beneficialOwners.${String(index)}`;
    if (owner.fullName.trim().length < 2) details.push({ field: `${at}.fullName`, code: 'TOO_SHORT' });
    if (
      !Number.isInteger(owner.ownershipBasisPoints) ||
      owner.ownershipBasisPoints < 0 ||
      owner.ownershipBasisPoints > FULL_OWNERSHIP_BASIS_POINTS
    ) {
      details.push({ field: `${at}.ownershipBasisPoints`, code: 'OUT_OF_RANGE' });
    }
    const nationality = owner.nationality?.toUpperCase() ?? '';
    if (nationality.length > 0 && !known.has(nationality)) {
      details.push({ field: `${at}.nationality`, code: 'UNKNOWN_COUNTRY' });
    }
  });

  if (totalOwnership(input.beneficialOwners) > FULL_OWNERSHIP_BASIS_POINTS) {
    details.push({ field: 'beneficialOwners', code: 'OWNERSHIP_OVER_100' });
  }

  return { udyam, iec, details };
}

/**
 * Save the whole section and answer with it, re-judged.
 *
 * One PUT for the section rather than a route per owner: the ownership total
 * is a rule about the set, and checking it against half a set is how an
 * application ends up at 140%.
 */
export async function saveKyb(
  membership: SellerMembership,
  input: KybInput,
  correlationId?: string | null,
): Promise<KybView> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_WRITE);
  assertApplicationEditable(membership);

  const { udyam, iec, details } = await validate(membership, input);
  if (details.length > 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Some of these answers need correcting.', details);
  }

  const sellerAccountId = membership.sellerAccountId;
  const markets = input.exportCapable ? [...new Set(input.exportMarkets.map((code) => code.toUpperCase()))] : [];
  const categoryIds = [...new Set(input.intendedCategoryIds)];

  const changed = await prisma.$transaction(async (tx) => {
    const [profile, trust, current] = await Promise.all([
      tx.sellerBusinessProfile.findUnique({ where: { sellerAccountId }, select: { legalForm: true } }),
      tx.sellerTrustProfile.findUnique({ where: { sellerAccountId } }),
      tx.sellerBeneficialOwner.findMany({ where: { sellerAccountId, archivedAt: null }, select: OWNER_SELECT }),
    ]);

    const sections: string[] = [];
    if ((profile?.legalForm ?? null) !== input.legalForm) sections.push('legal form');
    if ((trust?.udyamNumber ?? null) !== udyam || (trust?.iecNumber ?? null) !== iec) {
      sections.push('registrations');
    }
    if (
      (trust?.exportCapable ?? false) !== input.exportCapable ||
      JSON.stringify(stringList(trust?.exportMarketsJson)) !== JSON.stringify(markets) ||
      (trust?.yearsExporting ?? null) !== (input.exportCapable ? input.yearsExporting : null)
    ) {
      sections.push('exports');
    }
    if (JSON.stringify(stringList(trust?.intendedCategoryIdsJson)) !== JSON.stringify(categoryIds)) {
      sections.push('categories');
    }

    await tx.sellerBusinessProfile.upsert({
      where: { sellerAccountId },
      create: { id: newId(), sellerAccountId, legalForm: input.legalForm },
      update: { legalForm: input.legalForm },
    });

    const trustData = {
      udyamNumber: udyam,
      iecNumber: iec,
      exportCapable: input.exportCapable,
      exportMarketsJson: markets,
      yearsExporting: input.exportCapable ? input.yearsExporting : null,
      intendedCategoryIdsJson: categoryIds,
    };
    await tx.sellerTrustProfile.upsert({
      where: { sellerAccountId },
      create: { id: newId(), sellerAccountId, ...trustData },
      update: { ...trustData, version: { increment: 1 } },
    });

    /*
     * Owners are changed in place where the form sent an id, so a screening
     * recorded against a person stays attached to that person. Anybody no
     * longer listed is archived, not deleted: a reviewer who screened them
     * can still see who it was.
     */
    const byId = new Map(current.map((owner) => [owner.id, owner]));
    const kept = new Set<string>();
    let ownersChanged = false;

    for (const owner of input.beneficialOwners) {
      const data = {
        fullName: owner.fullName.trim(),
        nationality: owner.nationality === null || owner.nationality.length === 0 ? null : owner.nationality.toUpperCase(),
        ownershipBasisPoints: owner.ownershipBasisPoints,
        role: owner.role === null || owner.role.trim().length === 0 ? null : owner.role.trim(),
        isControllingPerson: owner.isControllingPerson,
        isPoliticallyExposed: owner.isPoliticallyExposed,
      };
      const existing = owner.id === null || owner.id === undefined ? undefined : byId.get(owner.id);

      if (existing !== undefined && !kept.has(existing.id)) {
        kept.add(existing.id);
        const same = (Object.keys(data) as (keyof typeof data)[]).every((key) => existing[key] === data[key]);
        if (!same) {
          ownersChanged = true;
          await tx.sellerBeneficialOwner.update({ where: { id: existing.id }, data });
        }
        continue;
      }

      ownersChanged = true;
      await tx.sellerBeneficialOwner.create({ data: { id: newId(), sellerAccountId, ...data } });
    }

    const dropped = current.filter((owner) => !kept.has(owner.id)).map((owner) => owner.id);
    if (dropped.length > 0) {
      ownersChanged = true;
      await tx.sellerBeneficialOwner.updateMany({
        where: { id: { in: dropped } },
        data: { archivedAt: new Date() },
      });
    }
    if (ownersChanged) sections.push('owners');

    return sections;
  });

  await markRequirementSteps(
    { sellerAccountId, registrationCountry: membership.registrationCountry },
    correlationId,
  );

  await recordSellerAudit({
    sellerAccountId,
    action: 'seller.kyb.saved',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_trust_profile',
    resourceId: sellerAccountId,
    // Which parts, never what was typed into them.
    after: { sections: changed },
    summary:
      changed.length === 0
        ? 'Ownership, registrations and exports were saved with no changes.'
        : `Ownership, registrations and exports were saved (${changed.join(', ')}).`,
    correlationId: correlationId ?? null,
  });

  return readKyb(membership);
}
