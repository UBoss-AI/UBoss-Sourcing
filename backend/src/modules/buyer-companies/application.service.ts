/**
 * A buyer company's application, from the applicant's side.
 *
 * Save-and-resume lives on the server: every step is saved to the company's
 * own rows as it is completed, so an application started on a laptop is
 * finished on a phone, and nothing sits in a browser's storage.
 *
 * Nobody here can approve anything. The furthest an applicant can move their
 * own company is SUBMITTED or RESUBMITTED - the state machine has no rule
 * that lets an APPLICANT reach APPROVED, and the review routes are behind a
 * different guard on a different surface.
 */
import { createHmac, randomInt } from 'node:crypto';
import { env } from '../../config/env.js';
import {
  IDENTIFIER_SCHEMES,
  NOT_APPLICABLE_REASONS,
  identifierProblem,
  identifierRequirementsFor,
  normaliseIdentifier,
  registrationNumberProblem,
  registrationRegisterFor,
  type BuyerCompanyEntityTypeName,
  type IdentifierSchemeName,
} from '../../domain/buyer-company-identifiers.js';
import {
  businessDomainStatus,
  completenessProblems,
  emailDomain,
  isApplicantRelationship,
  normaliseCompanyLegalName,
  postalCodeProblem,
  type ApplicantRelationship,
} from '../../domain/buyer-company-requirements.js';
import { BUYER_COMPANY_EDITABLE_STATUSES } from '../../domain/buyer-company-state.js';
import { ErrorCode, badRequest, conflict, notFound, type ErrorDetail } from '../../domain/errors.js';
import { safeCompare } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { JobType, queue } from '../../infra/queue/index.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { normaliseEmail } from '../identity/auth.service.js';
import {
  AdminNotificationKind,
  createAdminNotification,
} from '../notifications/admin-notification.service.js';
import { dispatchPendingNotifications } from '../notifications/notification.service.js';
import { Permission } from '../../domain/permissions.js';
import {
  CONSENT_PURPOSES,
  consentTextHash,
  consentVersion,
  type ConsentPurposeName,
} from './consents.js';
import { sendCompanyEmail } from './notifications.js';
import {
  applicantView,
  assertCanManage,
  assertCompaniesEnabled,
  assertEditable,
  loadCompanyRecord,
  loadMembership,
  newApplicationReference,
  snapshotOf,
  transitionCompany,
  writeEvent,
  type Actor,
  type Tx,
} from './shared.js';

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

/** Statuses that count against BUYER_COMPANY_MAX_OPEN_APPLICATIONS. */
const OPEN_STATUSES = [
  'DRAFT',
  'EMAIL_VERIFICATION_PENDING',
  'SUBMITTED',
  'AUTOMATED_CHECK_IN_PROGRESS',
  'UNDER_REVIEW',
  'MORE_INFORMATION_REQUIRED',
  'RESUBMITTED',
] as const;

export interface CreateDraftInput {
  userId: string;
  legalName?: string | null;
  registrationCountry?: string | null;
  entityType?: BuyerCompanyEntityTypeName | null;
  /**
   * Start from the details of the seller account the caller runs. Must be
   * the account `sellerSourceFor` returns for them; anything else is a 404.
   */
  fromSellerAccountId?: string | null;
  actor: Actor;
}

/** Seller roles trusted to speak for the business itself. */
const SELLER_ROLES_THAT_MAY_COPY = ['OWNER', 'ADMIN'] as const;

export interface SellerSource {
  id: string;
  legalName: string;
  registrationCountry: string;
}

/**
 * The seller account this person may start a buyer company from, or null.
 *
 * A person belongs to at most one seller account, and only its owner or an
 * administrator may copy its details - the same people who may change them
 * in Seller Hub. What this returns is a SOURCE of text for a draft: the new
 * application is verified from scratch, and the seller account's status is
 * never consulted to decide it.
 */
export async function sellerSourceFor(userId: string): Promise<SellerSource | null> {
  const member = await prisma.sellerMember.findFirst({
    where: {
      customerProfile: { userId },
      removedAt: null,
      role: { in: [...SELLER_ROLES_THAT_MAY_COPY] },
      sellerAccount: { archivedAt: null },
    },
    select: {
      sellerAccount: { select: { id: true, legalName: true, registrationCountry: true } },
    },
  });
  return member?.sellerAccount ?? null;
}

/** The seller's registration details, reduced to what a buyer draft can hold. */
async function sellerPrefill(sellerAccountId: string): Promise<{
  registrationNumber: string | null;
  website: string | null;
  addresses: { kind: 'REGISTERED_OFFICE' | 'BILLING'; values: Record<string, string | null> }[];
}> {
  const profile = await prisma.sellerBusinessProfile.findUnique({
    where: { sellerAccountId },
    select: {
      companyRegistrationNumber: true,
      websiteUrl: true,
      registeredAddressLine1: true,
      registeredAddressLine2: true,
      registeredCity: true,
      registeredRegion: true,
      registeredPostcode: true,
      registeredCountry: true,
      billingAddressLine1: true,
      billingAddressLine2: true,
      billingCity: true,
      billingRegion: true,
      billingPostcode: true,
      billingCountry: true,
    },
  });
  if (profile === null) return { registrationNumber: null, website: null, addresses: [] };

  const addresses: {
    kind: 'REGISTERED_OFFICE' | 'BILLING';
    values: Record<string, string | null>;
  }[] = [];
  const take = (
    kind: 'REGISTERED_OFFICE' | 'BILLING',
    raw: {
      line1: string | null;
      line2: string | null;
      city: string | null;
      region: string | null;
      postcode: string | null;
      country: string | null;
    },
  ): void => {
    const line1 = emptyToNull(raw.line1);
    const city = emptyToNull(raw.city);
    const country = emptyToNull(raw.country)?.toUpperCase() ?? null;
    const postalCode = emptyToNull(raw.postcode)?.toUpperCase() ?? null;
    // Copied only when it would pass the buyer side's own address rules, so
    // a pre-filled step never opens already in error.
    if (line1 === null || city === null || country === null || !/^[A-Z]{2}$/.test(country)) return;
    if (postalCodeProblem(country, postalCode) !== null) return;
    addresses.push({
      kind,
      values: {
        line1: line1.slice(0, 255),
        line2: emptyToNull(raw.line2)?.slice(0, 255) ?? null,
        city: city.slice(0, 128),
        region: emptyToNull(raw.region)?.slice(0, 128) ?? null,
        postalCode,
        countryCode: country,
        fingerprint: addressFingerprint({ line1, postalCode, countryCode: country }),
      },
    });
  };
  take('REGISTERED_OFFICE', {
    line1: profile.registeredAddressLine1,
    line2: profile.registeredAddressLine2,
    city: profile.registeredCity,
    region: profile.registeredRegion,
    postcode: profile.registeredPostcode,
    country: profile.registeredCountry,
  });
  take('BILLING', {
    line1: profile.billingAddressLine1,
    line2: profile.billingAddressLine2,
    city: profile.billingCity,
    region: profile.billingRegion,
    postcode: profile.billingPostcode,
    country: profile.billingCountry,
  });

  const website = emptyToNull(profile.websiteUrl);
  return {
    registrationNumber: emptyToNull(profile.companyRegistrationNumber)?.slice(0, 64) ?? null,
    website:
      website !== null && /^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/[^\s]*)?$/i.test(website)
        ? website.slice(0, 255)
        : null,
    addresses,
  };
}

/**
 * Open a new draft with the caller as its OWNER.
 *
 * The owner cannot buy for it yet - that waits for APPROVED like everything
 * else that represents the business as verified.
 */
export async function createCompanyDraft(input: CreateDraftInput): Promise<{ companyId: string }> {
  assertCompaniesEnabled();

  const open = await prisma.buyerCompanyMember.count({
    where: {
      userId: input.userId,
      role: 'OWNER',
      status: 'ACTIVE',
      company: { archivedAt: null, status: { in: [...OPEN_STATUSES] } },
    },
  });

  if (open >= env.BUYER_COMPANY_MAX_OPEN_APPLICATIONS) {
    throw conflict(
      ErrorCode.BUYER_COMPANY_LIMIT_REACHED,
      'You already have as many company applications in progress as we allow. Finish or withdraw one first.',
      [{ meta: { limit: env.BUYER_COMPANY_MAX_OPEN_APPLICATIONS } }],
    );
  }

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: input.userId },
    select: { email: true, customerProfile: { select: { jobTitle: true } } },
  });

  // Starting from a seller account is only possible from the one this person
  // runs. Any other id - somebody else's, a removed membership, a made-up
  // one - is the same 404, so the endpoint says nothing about which seller
  // accounts exist.
  let source: SellerSource | null = null;
  if (input.fromSellerAccountId !== undefined && input.fromSellerAccountId !== null) {
    source = await sellerSourceFor(input.userId);
    if (source === null || source.id !== input.fromSellerAccountId) {
      throw notFound('Seller account');
    }
  }
  const prefill = source === null ? null : await sellerPrefill(source.id);

  const companyId = newId();
  const legalName = (source?.legalName ?? input.legalName)?.trim() ?? '';
  const country = (source?.registrationCountry ?? input.registrationCountry)?.trim().toUpperCase() ?? '';
  const registrationNumber = prefill?.registrationNumber ?? null;

  await prisma.$transaction(async (tx) => {
    // A random reference can collide; the unique index is the arbiter and a
    // second draw costs nothing.
    let reference = newApplicationReference();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const taken = await tx.buyerCompany.findUnique({
        where: { applicationReference: reference },
        select: { id: true },
      });
      if (taken === null) break;
      reference = newApplicationReference();
    }

    await tx.buyerCompany.create({
      data: {
        id: companyId,
        applicationReference: reference,
        status: 'DRAFT',
        legalName: legalName.length > 0 ? legalName.slice(0, 255) : null,
        legalNameNormalized: legalName.length > 0 ? normaliseCompanyLegalName(legalName) : null,
        registrationCountry: /^[A-Z]{2}$/.test(country) ? country : null,
        entityType: input.entityType ?? null,
        // Most applicants register with the address they sign in with. It is
        // a suggestion they can change, and it is verified either way.
        businessEmail: user.email,
        businessEmailNormalized: normaliseEmail(user.email),
        businessDomain: emailDomain(user.email),
        businessDomainStatus: businessDomainStatus(user.email, null),
        applicantJobTitle: user.customerProfile?.jobTitle ?? null,
        registrationNumber,
        registrationNumberNormalized:
          registrationNumber === null ? null : normaliseIdentifier(registrationNumber),
        website: prefill?.website ?? null,
        // Status is deliberately NOT copied. This draft starts at DRAFT and is
        // verified on its own, however far the seller account has got.
        linkedSellerAccountId: source?.id ?? null,
        createdByUserId: input.userId,
        members: { create: { id: newId(), userId: input.userId, role: 'OWNER', status: 'ACTIVE' } },
        ...(prefill === null || prefill.addresses.length === 0
          ? {}
          : {
              addresses: {
                create: prefill.addresses.map((address) => ({
                  id: newId(),
                  kind: address.kind,
                  ...(address.values as {
                    line1: string;
                    line2: string | null;
                    city: string;
                    region: string | null;
                    postalCode: string | null;
                    countryCode: string;
                    fingerprint: string;
                  }),
                })),
              },
            }),
      },
    });

    await writeEvent(tx, {
      companyId,
      kind: 'CREATED',
      visibility: 'APPLICANT',
      actor: input.actor,
      ...(source === null ? {} : { data: { prefilledFromSeller: true } }),
    });

    await recordAudit(
      {
        action: AuditAction.BUYER_COMPANY_CREATED,
        resourceType: 'buyer_company',
        resourceId: companyId,
        actorType: 'CUSTOMER',
        actorUserId: input.userId,
        after: {
          registrationCountry: country.length === 2 ? country : null,
          linkedSellerAccountId: source?.id ?? null,
        },
        ipAddress: input.actor.ipAddress ?? null,
        correlationId: input.actor.correlationId ?? null,
      },
      tx,
    );
  });

  return { companyId };
}

/** The application as its member sees it. */
export async function readApplication(
  userId: string,
  companyId: string,
): Promise<Record<string, unknown>> {
  assertCompaniesEnabled();
  const membership = await loadMembership(userId, companyId);
  const company = await loadCompanyRecord(companyId);
  return applicantView(company, membership);
}

// ---------------------------------------------------------------------------
// Saving a step
// ---------------------------------------------------------------------------

export const INDUSTRIES = [
  'HEALTHCARE',
  'MANUFACTURING',
  'CONSTRUCTION',
  'HOSPITALITY',
  'RETAIL',
  'WHOLESALE_DISTRIBUTION',
  'EDUCATION',
  'PUBLIC_SECTOR',
  'TECHNOLOGY',
  'LOGISTICS',
  'AGRICULTURE',
  'ENERGY',
  'PROFESSIONAL_SERVICES',
  'OTHER',
] as const;

export interface BusinessPatch {
  legalName?: string | null;
  tradingName?: string | null;
  entityType?: BuyerCompanyEntityTypeName | null;
  registrationCountry?: string | null;
  registrationNumber?: string | null;
  /** YYYY-MM-DD. */
  incorporationDate?: string | null;
  industry?: (typeof INDUSTRIES)[number] | null;
  website?: string | null;
  businessEmail?: string | null;
  businessPhone?: string | null;
}

export interface AddressPatch {
  kind: 'REGISTERED_OFFICE' | 'OPERATING' | 'BILLING' | 'SHIPPING';
  /** Remove this address - the operating address "same as registered". */
  remove?: boolean;
  line1?: string;
  line2?: string | null;
  city?: string;
  region?: string | null;
  postalCode?: string | null;
  countryCode?: string;
}

export interface IdentifierPatch {
  scheme: IdentifierSchemeName;
  value: string | null;
  notApplicable: boolean;
  notApplicableReason: (typeof NOT_APPLICABLE_REASONS)[number] | null;
}

export interface ApplicationPatch {
  business?: BusinessPatch;
  applicant?: {
    jobTitle?: string | null;
    relationship?: ApplicantRelationship | null;
    authorityConfirmed?: boolean;
  };
  addresses?: AddressPatch[];
  identifiers?: IdentifierPatch[];
  procurement?: Record<string, unknown> | null;
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalisePhone(value: string | null): string | null {
  if (value === null) return null;
  const digits = value.replace(/[^0-9]/g, '');
  return value.trim().startsWith('+') ? `+${digits}` : digits;
}

/** A SHA-256 of the parts of an address that identify the building. */
function addressFingerprint(address: {
  line1: string;
  postalCode: string | null;
  countryCode: string;
}): string {
  const text = `${address.line1}|${address.postalCode ?? ''}|${address.countryCode}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return createHmac('sha256', 'buyer-company-address').update(text).digest('hex');
}

/**
 * Save part or all of the application.
 *
 * Validates what it is given - a malformed GSTIN is refused on the step it
 * was typed on, not at submission three screens later - but never requires
 * what it is not given. Completeness is `submit`'s job.
 */
export async function saveApplication(
  userId: string,
  companyId: string,
  patch: ApplicationPatch,
  actor: Actor,
): Promise<Record<string, unknown>> {
  assertCompaniesEnabled();
  const membership = await loadMembership(userId, companyId);
  assertCanManage(membership);

  const problems: ErrorDetail[] = [];

  await prisma.$transaction(async (tx) => {
    const company = await tx.buyerCompany.findUniqueOrThrow({ where: { id: companyId } });
    assertEditable(company.status);

    const data: Prisma.BuyerCompanyUncheckedUpdateInput = {};
    const changed: string[] = [];

    if (patch.business !== undefined) {
      const business = patch.business;
      const country =
        business.registrationCountry !== undefined
          ? (emptyToNull(business.registrationCountry)?.toUpperCase() ?? null)
          : company.registrationCountry;
      const entityType =
        business.entityType !== undefined ? business.entityType : company.entityType;

      if (country !== null && !/^[A-Z]{2}$/.test(country)) {
        problems.push({ field: 'business.registrationCountry', code: 'COUNTRY_FORMAT' });
      }

      if (business.legalName !== undefined) {
        const name = emptyToNull(business.legalName);
        data.legalName = name?.slice(0, 255) ?? null;
        data.legalNameNormalized = name === null ? null : normaliseCompanyLegalName(name);
      }
      if (business.tradingName !== undefined)
        data.tradingName = emptyToNull(business.tradingName)?.slice(0, 255) ?? null;
      if (business.entityType !== undefined) data.entityType = business.entityType;
      if (business.registrationCountry !== undefined) data.registrationCountry = country;

      const numberRaw =
        business.registrationNumber !== undefined
          ? emptyToNull(business.registrationNumber)
          : company.registrationNumber;
      if (
        business.registrationNumber !== undefined ||
        business.registrationCountry !== undefined ||
        business.entityType !== undefined
      ) {
        const normalised = numberRaw === null ? null : normaliseIdentifier(numberRaw);
        if (normalised !== null) {
          const problem = registrationNumberProblem(
            registrationRegisterFor(country, entityType),
            normalised,
          );
          if (problem !== null && business.registrationNumber !== undefined) {
            problems.push({ field: 'business.registrationNumber', code: problem });
          }
        }
        data.registrationNumber = numberRaw?.slice(0, 64) ?? null;
        data.registrationNumberNormalized = normalised;
      }

      if (business.incorporationDate !== undefined) {
        const raw = emptyToNull(business.incorporationDate);
        if (raw === null) data.incorporationDate = null;
        else if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
          problems.push({ field: 'business.incorporationDate', code: 'DATE_FORMAT' });
        } else if (Date.parse(`${raw}T00:00:00Z`) > Date.now()) {
          problems.push({ field: 'business.incorporationDate', code: 'IN_FUTURE' });
        } else data.incorporationDate = new Date(`${raw}T00:00:00Z`);
      }

      if (business.industry !== undefined) data.industry = business.industry;

      const website =
        business.website !== undefined ? emptyToNull(business.website) : company.website;
      if (business.website !== undefined) {
        if (
          website !== null &&
          !/^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/[^\s]*)?$/i.test(website)
        ) {
          problems.push({ field: 'business.website', code: 'WEBSITE_FORMAT' });
        }
        data.website = website?.slice(0, 255) ?? null;
      }

      const email =
        business.businessEmail !== undefined
          ? emptyToNull(business.businessEmail)
          : company.businessEmail;
      if (business.businessEmail !== undefined) {
        if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          problems.push({ field: 'business.businessEmail', code: 'EMAIL_FORMAT' });
        }
        const normalised = email === null ? null : normaliseEmail(email);
        data.businessEmail = email?.slice(0, 320) ?? null;
        data.businessEmailNormalized = normalised;
        data.businessDomain = emailDomain(email);
        // A new address has not been proven. The old proof was for the old one.
        if (normalised !== company.businessEmailNormalized) data.businessEmailVerifiedAt = null;
      }
      if (business.businessEmail !== undefined || business.website !== undefined) {
        data.businessDomainStatus = businessDomainStatus(email, website);
      }

      if (business.businessPhone !== undefined) {
        const phone = normalisePhone(emptyToNull(business.businessPhone));
        const digits = (phone ?? '').replace(/\D/g, '');
        if (phone !== null && (digits.length < 6 || digits.length > 20)) {
          problems.push({ field: 'business.businessPhone', code: 'INVALID_PHONE' });
        }
        data.businessPhone = phone;
      }

      // A change of country or legal form changes which identifiers exist.
      // Ones that no longer apply are removed rather than left to confuse.
      if (country !== company.registrationCountry || entityType !== company.entityType) {
        const allowed = identifierRequirementsFor(country, entityType).map(
          (requirement) => requirement.scheme,
        );
        await tx.buyerCompanyIdentifier.deleteMany({
          where: { companyId, scheme: { notIn: allowed } },
        });
      }

      changed.push('business');
    }

    if (patch.applicant !== undefined) {
      if (patch.applicant.jobTitle !== undefined) {
        data.applicantJobTitle = emptyToNull(patch.applicant.jobTitle)?.slice(0, 128) ?? null;
      }
      if (patch.applicant.relationship !== undefined) {
        // The route's schema already holds this to the list; checked again
        // here because the service is also called from places that are not
        // that route.
        const relationship = patch.applicant.relationship;
        if (relationship !== null && !isApplicantRelationship(relationship)) {
          problems.push({ field: 'applicant.relationship', code: 'REQUIRED' });
        } else {
          data.applicantRelationship = relationship;
        }
      }
      if (patch.applicant.authorityConfirmed !== undefined) {
        data.applicantAuthorityConfirmedAt = patch.applicant.authorityConfirmed ? new Date() : null;
      }
      changed.push('applicant');
    }

    if (patch.procurement !== undefined) {
      data.procurementProfileJson =
        patch.procurement === null ? Prisma.DbNull : (patch.procurement as Prisma.InputJsonValue);
      changed.push('procurement');
    }

    if (patch.addresses !== undefined) {
      for (const [index, address] of patch.addresses.entries()) {
        const field = `addresses.${String(index)}`;
        if (address.remove === true) {
          await tx.buyerCompanyAddress.deleteMany({ where: { companyId, kind: address.kind } });
          continue;
        }

        const line1 = emptyToNull(address.line1);
        const city = emptyToNull(address.city);
        const countryCode = emptyToNull(address.countryCode)?.toUpperCase() ?? null;
        const postalCode = emptyToNull(address.postalCode)?.toUpperCase() ?? null;

        if (line1 === null) problems.push({ field: `${field}.line1`, code: 'REQUIRED' });
        if (city === null) problems.push({ field: `${field}.city`, code: 'REQUIRED' });
        if (countryCode === null || !/^[A-Z]{2}$/.test(countryCode)) {
          problems.push({ field: `${field}.countryCode`, code: 'REQUIRED' });
          continue;
        }
        const postalProblem = postalCodeProblem(countryCode, postalCode);
        if (postalProblem !== null)
          problems.push({ field: `${field}.postalCode`, code: postalProblem });
        if (line1 === null || city === null || postalProblem !== null) continue;

        const values = {
          line1: line1.slice(0, 255),
          line2: emptyToNull(address.line2)?.slice(0, 255) ?? null,
          city: city.slice(0, 128),
          region: emptyToNull(address.region)?.slice(0, 128) ?? null,
          postalCode,
          countryCode,
          fingerprint: addressFingerprint({ line1, postalCode, countryCode }),
        };

        await tx.buyerCompanyAddress.upsert({
          where: { companyId_kind: { companyId, kind: address.kind } },
          create: { id: newId(), companyId, kind: address.kind, ...values },
          update: values,
        });
      }
      changed.push('addresses');
    }

    if (patch.identifiers !== undefined) {
      const country =
        (data.registrationCountry as string | null | undefined) ?? company.registrationCountry;
      const entityType =
        (data.entityType as BuyerCompanyEntityTypeName | null | undefined) ?? company.entityType;
      const requirements = new Map(
        identifierRequirementsFor(country, entityType).map((requirement) => [
          requirement.scheme,
          requirement,
        ]),
      );

      for (const [index, row] of patch.identifiers.entries()) {
        const field = `identifiers.${String(index)}`;
        const requirement = requirements.get(row.scheme);

        if (!IDENTIFIER_SCHEMES.includes(row.scheme) || requirement === undefined) {
          problems.push({ field: `${field}.scheme`, code: 'SCHEME_NOT_APPLICABLE' });
          continue;
        }

        const value = emptyToNull(row.value);

        if (row.notApplicable) {
          if (!requirement.allowNotApplicable) {
            problems.push({ field, code: 'NOT_APPLICABLE_NOT_ALLOWED' });
            continue;
          }
          if (
            row.notApplicableReason === null ||
            !NOT_APPLICABLE_REASONS.includes(row.notApplicableReason)
          ) {
            problems.push({ field: `${field}.notApplicableReason`, code: 'REQUIRED' });
            continue;
          }
          await tx.buyerCompanyIdentifier.upsert({
            where: { companyId_scheme: { companyId, scheme: row.scheme } },
            create: {
              id: newId(),
              companyId,
              scheme: row.scheme,
              notApplicable: true,
              notApplicableReason: row.notApplicableReason,
            },
            update: {
              value: null,
              valueNormalized: null,
              notApplicable: true,
              notApplicableReason: row.notApplicableReason,
            },
          });
          continue;
        }

        if (value === null) {
          // Cleared: an optional identifier the applicant no longer declares.
          await tx.buyerCompanyIdentifier.deleteMany({ where: { companyId, scheme: row.scheme } });
          continue;
        }

        const normalised = normaliseIdentifier(value);
        const problem = identifierProblem(row.scheme, normalised, country);
        if (problem !== null) {
          problems.push({ field: `${field}.value`, code: problem });
          continue;
        }

        await tx.buyerCompanyIdentifier.upsert({
          where: { companyId_scheme: { companyId, scheme: row.scheme } },
          create: {
            id: newId(),
            companyId,
            scheme: row.scheme,
            value: value.slice(0, 64),
            valueNormalized: normalised,
          },
          update: {
            value: value.slice(0, 64),
            valueNormalized: normalised,
            notApplicable: false,
            notApplicableReason: null,
          },
        });
      }
      changed.push('identifiers');
    }

    // Nothing is written if anything was refused: a half-saved step is worse
    // than an unsaved one, because the applicant cannot tell which half.
    if (problems.length > 0) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Some fields need attention.', problems);
    }

    await tx.buyerCompany.update({ where: { id: companyId }, data });

    await recordAudit(
      {
        action: AuditAction.BUYER_COMPANY_UPDATED,
        resourceType: 'buyer_company',
        resourceId: companyId,
        actorType: 'CUSTOMER',
        actorUserId: userId,
        // Which steps, never their contents: the trail must not become a
        // second copy of every tax number.
        after: { sections: changed },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return readApplication(userId, companyId);
}

// ---------------------------------------------------------------------------
// The business email
// ---------------------------------------------------------------------------

const EMAIL_CODE_TTL_MS = 15 * 60_000;
const EMAIL_CODE_MAX_ATTEMPTS = 5;

/**
 * Keyed with a server secret, so a leaked table of six-digit codes cannot be
 * brute-forced offline in the million guesses it would otherwise take.
 */
function hashCode(companyId: string, code: string): string {
  return createHmac('sha256', env.SESSION_COOKIE_SECRET)
    .update(`${companyId}:${code}`)
    .digest('hex');
}

/** Send a fresh six-digit code to the business email. Replaces any earlier one. */
export async function sendBusinessEmailCode(
  userId: string,
  companyId: string,
  actor: Actor,
): Promise<{ sentTo: string } | { alreadyVerified: true }> {
  assertCompaniesEnabled();
  const membership = await loadMembership(userId, companyId);
  assertCanManage(membership);

  const company = await prisma.buyerCompany.findUniqueOrThrow({
    where: { id: companyId },
    select: {
      businessEmail: true,
      businessEmailNormalized: true,
      businessEmailVerifiedAt: true,
      status: true,
    },
  });
  assertEditable(company.status);

  if (company.businessEmail === null || company.businessEmailNormalized === null) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Enter the business email address first.', [
      { field: 'business.businessEmail', code: 'REQUIRED' },
    ]);
  }
  if (company.businessEmailVerifiedAt !== null) return { alreadyVerified: true };

  // The address the person already proved at sign-up needs no second proof.
  if (await isAccountEmail(userId, company.businessEmailNormalized)) {
    await markEmailVerified(companyId, userId, actor);
    return { alreadyVerified: true };
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

  await prisma.$transaction(async (tx) => {
    await tx.buyerCompanyEmailChallenge.updateMany({
      where: { companyId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await tx.buyerCompanyEmailChallenge.create({
      data: {
        id: newId(),
        companyId,
        userId,
        emailNormalized: company.businessEmailNormalized ?? '',
        codeHash: hashCode(companyId, code),
        expiresAt: new Date(Date.now() + EMAIL_CODE_TTL_MS),
      },
    });
    await sendCompanyEmail({
      kind: 'EMAIL_CODE',
      companyId,
      recipientUserId: userId,
      recipientEmail: company.businessEmail ?? '',
      code,
      correlationId: actor.correlationId ?? null,
      tx,
    });
  });

  await dispatchPendingNotifications();
  return { sentTo: company.businessEmail };
}

async function isAccountEmail(userId: string, emailNormalized: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { emailNormalized: true, emailVerifiedAt: true },
  });
  return user !== null && user.emailVerifiedAt !== null && user.emailNormalized === emailNormalized;
}

async function markEmailVerified(
  companyId: string,
  userId: string,
  actor: Actor,
  tx?: Tx,
): Promise<void> {
  const run = async (client: Tx): Promise<void> => {
    await client.buyerCompany.update({
      where: { id: companyId },
      data: { businessEmailVerifiedAt: new Date() },
    });
    await writeEvent(client, { companyId, kind: 'EMAIL_VERIFIED', visibility: 'APPLICANT', actor });
    await recordAudit(
      {
        action: AuditAction.BUYER_COMPANY_EMAIL_VERIFIED,
        resourceType: 'buyer_company',
        resourceId: companyId,
        actorType: 'CUSTOMER',
        actorUserId: userId,
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      client,
    );
  };
  if (tx !== undefined) await run(tx);
  else await prisma.$transaction(run);
}

/**
 * Enter the code. When the application was waiting only on this, entering it
 * completes the submission the applicant already made.
 */
export async function confirmBusinessEmailCode(
  userId: string,
  companyId: string,
  code: string,
  actor: Actor,
): Promise<Record<string, unknown>> {
  assertCompaniesEnabled();
  const membership = await loadMembership(userId, companyId);
  assertCanManage(membership);

  const company = await prisma.buyerCompany.findUniqueOrThrow({
    where: { id: companyId },
    select: { businessEmailNormalized: true, status: true },
  });

  const challenge = await prisma.buyerCompanyEmailChallenge.findFirst({
    where: { companyId, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  const refuse = (): never => {
    throw badRequest(
      ErrorCode.BUYER_COMPANY_EMAIL_CODE_INVALID,
      'That code is not right, or it has expired. Ask for a new one.',
      [{ field: 'code', code: 'INVALID' }],
    );
  };

  if (
    challenge === null ||
    challenge.expiresAt.getTime() <= Date.now() ||
    challenge.attempts >= EMAIL_CODE_MAX_ATTEMPTS ||
    challenge.emailNormalized !== company.businessEmailNormalized
  ) {
    return refuse();
  }

  // Counted before comparing, conditionally, so parallel guesses cannot all
  // slip in under the limit.
  const counted = await prisma.buyerCompanyEmailChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null, attempts: { lt: EMAIL_CODE_MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (counted.count !== 1) return refuse();

  if (!/^\d{6}$/.test(code) || !safeCompare(hashCode(companyId, code), challenge.codeHash)) {
    return refuse();
  }

  await prisma.$transaction(async (tx) => {
    await tx.buyerCompanyEmailChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });
    await markEmailVerified(companyId, userId, actor, tx);
  });

  if (company.status === 'EMAIL_VERIFICATION_PENDING') {
    await finaliseSubmission(userId, companyId, actor);
  }

  return readApplication(userId, companyId);
}

// ---------------------------------------------------------------------------
// Submitting
// ---------------------------------------------------------------------------

export interface SubmitInput {
  userId: string;
  companyId: string;
  consents: Record<ConsentPurposeName, boolean>;
  actor: Actor & { userAgent?: string | null };
}

function assertComplete(company: Awaited<ReturnType<typeof loadCompanyRecord>>): void {
  const problems = completenessProblems(snapshotOf(company));
  if (problems.length > 0) {
    throw badRequest(
      ErrorCode.BUYER_COMPANY_INCOMPLETE,
      'Some parts of the application are missing or need correcting.',
      problems.map((problem) => ({ field: problem.field, code: problem.code })),
    );
  }
}

/**
 * Send the application for review.
 *
 * Four separate consents are required and each becomes its own record. If
 * the business email has not been proven yet, the application waits in
 * EMAIL_VERIFICATION_PENDING and a code goes to it; entering the code
 * finishes this submission without asking for the consents again.
 */
export async function submitApplication(input: SubmitInput): Promise<Record<string, unknown>> {
  assertCompaniesEnabled();
  const membership = await loadMembership(input.userId, input.companyId);
  assertCanManage(membership);

  const company = await loadCompanyRecord(input.companyId);
  if (company.status !== 'DRAFT' && company.status !== 'EMAIL_VERIFICATION_PENDING') {
    throw conflict(
      ErrorCode.BUYER_COMPANY_NOT_EDITABLE,
      'This application has already been sent.',
      [{ code: company.status, meta: { status: company.status } }],
    );
  }

  const missingConsents = CONSENT_PURPOSES.filter((purpose) => input.consents[purpose] !== true);
  if (missingConsents.length > 0) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Confirm each statement to send the application.',
      missingConsents.map((purpose) => ({
        field: `consents.${purpose}`,
        code: 'CONSENT_REQUIRED',
      })),
    );
  }

  assertComplete(company);

  const accountEmailProves =
    company.businessEmailVerifiedAt === null &&
    company.businessEmailNormalized !== null &&
    (await isAccountEmail(input.userId, company.businessEmailNormalized));

  await prisma.$transaction(async (tx) => {
    for (const purpose of CONSENT_PURPOSES) {
      await tx.consentRecord.create({
        data: {
          id: newId(),
          userId: input.userId,
          companyId: input.companyId,
          purpose,
          textVersion: consentVersion(),
          textHash: consentTextHash(purpose),
          ipAddress: input.actor.ipAddress ?? null,
          userAgent: input.actor.userAgent?.slice(0, 512) ?? null,
        },
      });
    }
    await recordAudit(
      {
        action: AuditAction.BUYER_COMPANY_CONSENT_RECORDED,
        resourceType: 'buyer_company',
        resourceId: input.companyId,
        actorType: 'CUSTOMER',
        actorUserId: input.userId,
        after: { purposes: CONSENT_PURPOSES, version: consentVersion() },
        ipAddress: input.actor.ipAddress ?? null,
        correlationId: input.actor.correlationId ?? null,
      },
      tx,
    );
    if (accountEmailProves) await markEmailVerified(input.companyId, input.userId, input.actor, tx);
  });

  const verified = company.businessEmailVerifiedAt !== null || accountEmailProves;

  if (!verified) {
    if (company.status === 'DRAFT') {
      await prisma.$transaction(async (tx) => {
        await transitionCompany(tx, {
          companyId: input.companyId,
          to: 'EMAIL_VERIFICATION_PENDING',
          actor: input.actor,
          as: 'APPLICANT',
        });
      });
    }
    await sendBusinessEmailCode(input.userId, input.companyId, input.actor);
    return readApplication(input.userId, input.companyId);
  }

  await finaliseSubmission(input.userId, input.companyId, input.actor);
  return readApplication(input.userId, input.companyId);
}

/** Open a review case - a new round - for this company. */
async function openCase(
  tx: Tx,
  companyId: string,
  trigger: 'INITIAL' | 'RESUBMISSION' | 'REVERIFICATION',
): Promise<string> {
  await tx.buyerCompanyVerificationCase.updateMany({
    where: { companyId, state: 'OPEN' },
    data: { state: 'CLOSED', closedAt: new Date() },
  });
  const last = await tx.buyerCompanyVerificationCase.findFirst({
    where: { companyId },
    orderBy: { round: 'desc' },
    select: { round: true },
  });
  const id = newId();
  await tx.buyerCompanyVerificationCase.create({
    data: { id, companyId, round: (last?.round ?? 0) + 1, trigger },
  });
  return id;
}

export { openCase as openVerificationCase };

/** The step from "ready" to SUBMITTED: a case, the checks, and the emails. */
async function finaliseSubmission(userId: string, companyId: string, actor: Actor): Promise<void> {
  const company = await loadCompanyRecord(companyId);
  assertComplete(company);

  await prisma.$transaction(async (tx) => {
    await transitionCompany(tx, {
      companyId,
      to: 'SUBMITTED',
      actor,
      as: 'APPLICANT',
      extra: company.firstSubmittedAt === null ? { firstSubmittedAt: new Date() } : {},
    });

    const caseId = await openCase(
      tx,
      companyId,
      company.firstSubmittedAt === null ? 'INITIAL' : 'RESUBMISSION',
    );

    await queue.enqueue(
      JobType.BUYER_COMPANY_CHECKS,
      { companyId, caseId },
      {
        dedupeKey: `buyer-company-checks:${caseId}`,
        correlationId: actor.correlationId ?? undefined,
      },
      tx,
    );

    await createAdminNotification(
      {
        kind: AdminNotificationKind.BUYER_COMPANY_SUBMITTED,
        variables: {
          companyName: company.legalName ?? company.applicationReference,
          reference: company.applicationReference,
          country: company.registrationCountry,
          resubmitted: company.firstSubmittedAt !== null,
        },
        linkPath: `/buyer-companies/${companyId}`,
        requiredPermission: Permission.BUYER_COMPANY_READ,
        relatedType: 'buyer_company',
        relatedId: companyId,
        dedupeKey: `buyer-company-submitted:${caseId}`,
      },
      tx,
    );

    await sendCompanyEmail({
      kind: 'SUBMITTED',
      companyId,
      dedupeKey: `bc-submitted:${caseId}`,
      tx,
    });
  });

  await dispatchPendingNotifications();
  void userId;
}

// ---------------------------------------------------------------------------
// Answering a reviewer
// ---------------------------------------------------------------------------

/** Write an answer to one of the reviewer's requests. Does not resubmit. */
export async function answerInfoRequest(
  userId: string,
  companyId: string,
  requestId: string,
  message: string,
  actor: Actor,
): Promise<Record<string, unknown>> {
  assertCompaniesEnabled();
  const membership = await loadMembership(userId, companyId);
  assertCanManage(membership);

  await prisma.$transaction(async (tx) => {
    const company = await tx.buyerCompany.findUniqueOrThrow({
      where: { id: companyId },
      select: { status: true },
    });
    if (
      company.status !== 'MORE_INFORMATION_REQUIRED' &&
      company.status !== 'REVERIFICATION_REQUIRED'
    ) {
      throw conflict(ErrorCode.BUYER_COMPANY_NOT_EDITABLE, 'There is no open request to answer.');
    }

    const answered = await tx.buyerCompanyInfoRequest.updateMany({
      where: { id: requestId, companyId, status: 'OPEN' },
      data: {
        status: 'ANSWERED',
        responseMessage: message.trim().slice(0, 5000),
        respondedByUserId: userId,
        respondedAt: new Date(),
      },
    });
    if (answered.count !== 1) {
      throw conflict(ErrorCode.CONFLICT, 'That request is no longer open.');
    }

    await writeEvent(tx, {
      companyId,
      kind: 'INFO_ANSWERED',
      visibility: 'APPLICANT',
      actor,
      message: message.trim().slice(0, 5000),
      data: { requestId },
    });

    await recordAudit(
      {
        action: AuditAction.BUYER_COMPANY_INFO_ANSWERED,
        resourceType: 'buyer_company',
        resourceId: companyId,
        actorType: 'CUSTOMER',
        actorUserId: userId,
        after: { requestId },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return readApplication(userId, companyId);
}

/**
 * Send the application back after answering the reviewer, or after
 * correcting what a re-verification asked for.
 */
export async function resubmitApplication(
  userId: string,
  companyId: string,
  actor: Actor,
): Promise<Record<string, unknown>> {
  assertCompaniesEnabled();
  const membership = await loadMembership(userId, companyId);
  assertCanManage(membership);

  const company = await loadCompanyRecord(companyId);
  if (
    company.status !== 'MORE_INFORMATION_REQUIRED' &&
    company.status !== 'REVERIFICATION_REQUIRED'
  ) {
    throw conflict(
      ErrorCode.BUYER_COMPANY_NOT_EDITABLE,
      'This application is not waiting on you.',
      [{ code: company.status, meta: { status: company.status } }],
    );
  }

  const unanswered = company.infoRequests.filter((request) => request.status === 'OPEN');
  if (unanswered.length > 0) {
    throw badRequest(
      ErrorCode.BUYER_COMPANY_INCOMPLETE,
      'Answer each request from the reviewer before sending the application back.',
      unanswered.map((request) => ({ field: `infoRequests.${request.id}`, code: 'UNANSWERED' })),
    );
  }

  assertComplete(company);
  const openCaseRow = company.cases.find((row) => row.state === 'OPEN') ?? null;

  await prisma.$transaction(async (tx) => {
    await transitionCompany(tx, { companyId, to: 'RESUBMITTED', actor, as: 'APPLICANT' });

    const caseId = openCaseRow?.id ?? (await openCase(tx, companyId, 'RESUBMISSION'));

    await queue.enqueue(
      JobType.BUYER_COMPANY_CHECKS,
      { companyId, caseId },
      {
        dedupeKey: `buyer-company-checks:${caseId}:${String(company.version + 1)}`,
        correlationId: actor.correlationId ?? undefined,
      },
      tx,
    );

    await createAdminNotification(
      {
        kind: AdminNotificationKind.BUYER_COMPANY_RESPONDED,
        variables: {
          companyName: company.legalName ?? company.applicationReference,
          reference: company.applicationReference,
          country: company.registrationCountry,
          resubmitted: true,
        },
        linkPath: `/buyer-companies/${companyId}`,
        requiredPermission: Permission.BUYER_COMPANY_READ,
        relatedType: 'buyer_company',
        relatedId: companyId,
        dedupeKey: `buyer-company-responded:${companyId}:${String(company.version + 1)}`,
      },
      tx,
    );
  });

  return readApplication(userId, companyId);
}

/**
 * Take a rejected application back to a draft to correct it. Only where the
 * reviewer left resubmission open; the previous submission, its checks and
 * its whole timeline stay exactly as they were.
 */
export async function reopenRejectedApplication(
  userId: string,
  companyId: string,
  actor: Actor,
): Promise<Record<string, unknown>> {
  assertCompaniesEnabled();
  const membership = await loadMembership(userId, companyId);
  assertCanManage(membership);

  const company = await prisma.buyerCompany.findUniqueOrThrow({
    where: { id: companyId },
    select: { status: true, resubmissionAllowed: true },
  });

  if (company.status !== 'REJECTED' || !company.resubmissionAllowed) {
    throw conflict(
      ErrorCode.BUYER_COMPANY_TRANSITION_NOT_ALLOWED,
      'This application cannot be corrected and sent again.',
      [{ code: 'RESUBMISSION_NOT_ALLOWED' }],
    );
  }

  await prisma.$transaction(async (tx) => {
    await transitionCompany(tx, { companyId, to: 'DRAFT', actor, as: 'APPLICANT' });
  });

  return readApplication(userId, companyId);
}

/** Statuses in which documents may be uploaded or withdrawn. */
export const DOCUMENT_UPLOAD_STATUSES = BUYER_COMPANY_EDITABLE_STATUSES;
