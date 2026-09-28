/**
 * What the applicant side and the reviewer side of buyer companies share:
 * loading a company for a member, the one writer of status, the timeline,
 * and the two views.
 *
 * `transitionCompany` is the ONLY function in the codebase that writes
 * `buyer_companies.status`. It asserts the transition, bumps the version,
 * stamps the timestamps, and writes the status-history row, the timeline
 * entry and the platform audit row - all in the caller's transaction, so a
 * status can never change without its trail.
 */
import { randomBytes } from 'node:crypto';
import {
  allowedBuyerCompanyTransitions,
  assertBuyerCompanyTransition,
  isEditableStatus,
  roleHasCapability,
  type BuyerCompanyActor,
  type BuyerCompanyRoleName,
  type BuyerCompanyStatusName,
} from '../../domain/buyer-company-state.js';
import {
  identifierRequirementsFor,
  registrationRegisterFor,
  type BuyerCompanyEntityTypeName,
} from '../../domain/buyer-company-identifiers.js';
import {
  completenessProblems,
  documentRequirementsFor,
  incorporationDateRequired,
  isApplicantRelationship,
  type ApplicationSnapshot,
} from '../../domain/buyer-company-requirements.js';
import { env } from '../../config/env.js';
import { ErrorCode, conflict, forbidden, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';

export type Tx = PrismaTransaction;

/** Crockford base32 without I, L, O, U - readable over the telephone. */
const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newApplicationReference(): string {
  const bytes = randomBytes(8);
  let out = 'BC-';
  for (const byte of bytes) out += REFERENCE_ALPHABET.charAt(byte % 32);
  return out;
}

export function assertCompaniesEnabled(): void {
  if (!env.FEATURE_BUYER_COMPANIES) {
    throw forbidden(ErrorCode.BUYER_COMPANIES_DISABLED, 'Company accounts are not offered here.');
  }
}

/** Everything the two views read, in one query. */
export const COMPANY_INCLUDE = {
  addresses: true,
  identifiers: { orderBy: { scheme: 'asc' } },
  documents: { orderBy: { createdAt: 'desc' } },
  infoRequests: { orderBy: { createdAt: 'desc' } },
  reviewEvents: { orderBy: { createdAt: 'asc' } },
  statusHistory: { orderBy: { createdAt: 'asc' } },
  checks: { orderBy: { checkedAt: 'desc' } },
  cases: {
    orderBy: { round: 'desc' },
    include: { assignedReviewer: { select: { id: true, email: true } } },
  },
  members: {
    orderBy: { createdAt: 'asc' },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          emailVerifiedAt: true,
          customerProfile: { select: { fullName: true, phone: true } },
        },
      },
    },
  },
  consents: { orderBy: { acceptedAt: 'asc' } },
  // Only what a reviewer needs to recognise the other half of the same legal
  // entity. Its approval is never read from here to decide anything.
  linkedSellerAccount: {
    select: { id: true, legalName: true, displayName: true, status: true, registrationCountry: true },
  },
} satisfies Prisma.BuyerCompanyInclude;

export type CompanyRecord = Prisma.BuyerCompanyGetPayload<{ include: typeof COMPANY_INCLUDE }>;

export interface Membership {
  companyId: string;
  userId: string;
  role: BuyerCompanyRoleName;
}

/**
 * The caller's ACTIVE membership in a company, or a 404.
 *
 * 404 for "no such company", "not a member" and "removed" alike: confirming
 * that a company id exists to somebody who is not in it is the first half of
 * an IDOR.
 */
export async function loadMembership(
  userId: string,
  companyId: string,
  client: Tx | typeof prisma = prisma,
): Promise<Membership> {
  const membership = await client.buyerCompanyMember.findFirst({
    where: { companyId, userId, status: 'ACTIVE', company: { archivedAt: null } },
    select: { companyId: true, userId: true, role: true },
  });
  if (membership === null) throw notFound('Company');
  return membership;
}

export function assertCanManage(membership: Membership): void {
  if (!roleHasCapability(membership.role, 'MANAGE_APPLICATION')) {
    throw forbidden(
      ErrorCode.BUYER_COMPANY_ROLE_FORBIDDEN,
      'Only the company owner or an administrator can change the application.',
    );
  }
}

export function assertEditable(status: BuyerCompanyStatusName): void {
  if (!isEditableStatus(status)) {
    throw conflict(
      ErrorCode.BUYER_COMPANY_NOT_EDITABLE,
      'This application cannot be changed while it is in its current state.',
      [{ code: status, meta: { status } }],
    );
  }
}

// ---------------------------------------------------------------------------
// The timeline and the trail
// ---------------------------------------------------------------------------

export interface Actor {
  type: 'CUSTOMER' | 'ADMIN' | 'SYSTEM';
  userId: string | null;
  email?: string | null;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export const SYSTEM_ACTOR: Actor = Object.freeze({ type: 'SYSTEM', userId: null });

/**
 * One timeline entry. Append-only: nothing in this module updates or deletes
 * a review event, and `buyer-company-immutability.test.ts` checks that stays
 * true for the whole codebase.
 */
export async function writeEvent(
  tx: Tx,
  input: {
    companyId: string;
    caseId?: string | null;
    kind: string;
    visibility: 'INTERNAL' | 'APPLICANT';
    actor: Actor;
    message?: string | null;
    data?: Record<string, unknown> | null;
  },
): Promise<void> {
  await tx.buyerCompanyReviewEvent.create({
    data: {
      id: newId(),
      companyId: input.companyId,
      caseId: input.caseId ?? null,
      kind: input.kind,
      visibility: input.visibility,
      actorType: input.actor.type,
      actorUserId: input.actor.userId,
      message: input.message ?? null,
      ...(input.data !== undefined && input.data !== null
        ? { dataJson: input.data as Prisma.InputJsonValue }
        : {}),
    },
  });
}

export interface TransitionInput {
  companyId: string;
  to: BuyerCompanyStatusName;
  actor: Actor;
  /** Who the state machine treats the actor as. */
  as: BuyerCompanyActor;
  /** Shown to the applicant. */
  reason?: string | null;
  reasonCode?: string | null;
  /** When given, refuses unless the row is still at this version. */
  expectedVersion?: number;
  /** Extra columns written in the same UPDATE. */
  extra?: Prisma.BuyerCompanyUncheckedUpdateManyInput;
}

/**
 * Change a company's status. The only writer of `buyer_companies.status`.
 *
 * The UPDATE is conditional on the status (and version) it was read at, so
 * two reviewers acting at once cannot both succeed: the second matches no
 * row and is told BUYER_COMPANY_VERSION_CONFLICT rather than overwriting the
 * first decision.
 */
export async function transitionCompany(
  tx: Tx,
  input: TransitionInput,
): Promise<{ from: BuyerCompanyStatusName; version: number }> {
  const company = await tx.buyerCompany.findUnique({
    where: { id: input.companyId },
    select: { status: true, version: true },
  });
  if (company === null) throw notFound('Company');

  if (input.expectedVersion !== undefined && input.expectedVersion !== company.version) {
    throw conflict(
      ErrorCode.BUYER_COMPANY_VERSION_CONFLICT,
      'Somebody else changed this application since you opened it. Reload it and decide again.',
    );
  }

  assertBuyerCompanyTransition({
    from: company.status,
    to: input.to,
    actor: input.as,
    reason: input.reason ?? null,
  });

  const now = new Date();
  const stamps: Prisma.BuyerCompanyUncheckedUpdateManyInput = {};
  if (input.to === 'SUBMITTED' || input.to === 'RESUBMITTED') stamps.submittedAt = now;
  if (input.to === 'APPROVED') stamps.approvedAt = now;
  if (input.to === 'REJECTED') stamps.rejectedAt = now;
  if (input.to === 'SUSPENDED') stamps.suspendedAt = now;
  if (input.to === 'REVERIFICATION_REQUIRED') stamps.reverificationRequestedAt = now;

  // A reason belongs to the decision that gave it. Moving on without one (a
  // resubmission, a review starting) clears the last one, so the applicant is
  // never shown an old refusal under a new status.
  const reason = input.reason?.trim() ?? '';

  const updated = await tx.buyerCompany.updateMany({
    where: { id: input.companyId, status: company.status, version: company.version },
    data: {
      ...stamps,
      ...(input.extra ?? {}),
      status: input.to,
      version: { increment: 1 },
      lastStatusChangedAt: now,
      statusReason: reason.length > 0 ? reason.slice(0, 1000) : null,
      statusReasonCode: input.reasonCode ?? null,
    },
  });

  if (updated.count !== 1) {
    throw conflict(
      ErrorCode.BUYER_COMPANY_VERSION_CONFLICT,
      'Somebody else changed this application since you opened it. Reload it and decide again.',
    );
  }

  await tx.buyerCompanyStatusHistory.create({
    data: {
      id: newId(),
      companyId: input.companyId,
      fromStatus: company.status,
      toStatus: input.to,
      reason: reason.length > 0 ? reason.slice(0, 1000) : null,
      reasonCode: input.reasonCode ?? null,
      actorType: input.actor.type,
      actorUserId: input.actor.userId,
    },
  });

  await writeEvent(tx, {
    companyId: input.companyId,
    kind: 'STATUS_CHANGED',
    visibility: 'APPLICANT',
    actor: input.actor,
    message: reason.length > 0 ? reason : null,
    data: { from: company.status, to: input.to, reasonCode: input.reasonCode ?? null },
  });

  await recordAudit(
    {
      action: AuditAction.BUYER_COMPANY_STATUS_CHANGED,
      resourceType: 'buyer_company',
      resourceId: input.companyId,
      actorType: input.actor.type,
      actorUserId: input.actor.userId,
      actorEmail: input.actor.email ?? null,
      before: { status: company.status },
      after: { status: input.to, reasonCode: input.reasonCode ?? null },
      ipAddress: input.actor.ipAddress ?? null,
      correlationId: input.actor.correlationId ?? null,
    },
    tx,
  );

  return { from: company.status, version: company.version + 1 };
}

// ---------------------------------------------------------------------------
// Reading an application
// ---------------------------------------------------------------------------

export function snapshotOf(company: CompanyRecord): ApplicationSnapshot {
  return {
    legalName: company.legalName,
    entityType: company.entityType,
    registrationCountry: company.registrationCountry,
    registrationNumber: company.registrationNumber,
    incorporationDate: company.incorporationDate,
    industry: company.industry,
    businessEmail: company.businessEmail,
    businessPhone: company.businessPhone,
    applicantJobTitle: company.applicantJobTitle,
    applicantRelationship: company.applicantRelationship,
    applicantAuthorityConfirmed: company.applicantAuthorityConfirmedAt !== null,
    addressKinds: new Set(company.addresses.map((address) => address.kind)),
    identifiers: company.identifiers.map((row) => ({
      scheme: row.scheme,
      value: row.value,
      notApplicable: row.notApplicable,
      notApplicableReason: row.notApplicableReason,
    })),
    documentKinds: new Set(
      company.documents
        .filter(
          (document) => document.status === 'PENDING_REVIEW' || document.status === 'ACCEPTED',
        )
        .map((document) => document.kind),
    ),
  };
}

/** Schemes with a value, for requirements that depend on what was given. */
function providedSchemes(company: CompanyRecord): Set<string> {
  return new Set(
    company.identifiers
      .filter((row) => !row.notApplicable && row.value !== null)
      .map((row) => row.scheme),
  );
}

export function requirementsView(company: {
  registrationCountry: string | null;
  entityType: BuyerCompanyEntityTypeName | null;
  applicantRelationship: string | null;
  identifiers: CompanyRecord['identifiers'];
}): Record<string, unknown> {
  const provided = new Set(
    company.identifiers
      .filter((row) => !row.notApplicable && row.value !== null)
      .map((row) => row.scheme),
  );
  return {
    register: registrationRegisterFor(company.registrationCountry, company.entityType),
    incorporationDateRequired: incorporationDateRequired(company.entityType),
    identifiers: identifierRequirementsFor(company.registrationCountry, company.entityType),
    documents: documentRequirementsFor({
      registrationCountry: company.registrationCountry,
      entityType: company.entityType,
      providedSchemes: provided,
      applicantRelationship: isApplicantRelationship(company.applicantRelationship)
        ? company.applicantRelationship
        : null,
    }),
  };
}

function addressView(address: CompanyRecord['addresses'][number]): Record<string, unknown> {
  return {
    kind: address.kind,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    region: address.region,
    postalCode: address.postalCode,
    countryCode: address.countryCode,
  };
}

function isoDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** The name and phone of the member who started the application. */
function applicantContact(company: CompanyRecord): {
  fullName: string | null;
  phone: string | null;
} {
  const creator = company.members.find((member) => member.userId === company.createdByUserId);
  return {
    fullName: creator?.user.customerProfile?.fullName ?? null,
    phone: creator?.user.customerProfile?.phone ?? null,
  };
}

/** The parts both views show identically. */
function commonView(company: CompanyRecord): Record<string, unknown> {
  return {
    id: company.id,
    reference: company.applicationReference,
    status: company.status,
    version: company.version,
    statusReason: company.statusReason,
    statusReasonCode: company.statusReasonCode,
    resubmissionAllowed: company.resubmissionAllowed,
    business: {
      legalName: company.legalName,
      tradingName: company.tradingName,
      entityType: company.entityType,
      registrationCountry: company.registrationCountry,
      registrationNumber: company.registrationNumber,
      incorporationDate: isoDate(company.incorporationDate),
      industry: company.industry,
      website: company.website,
      businessEmail: company.businessEmail,
      businessEmailVerified: company.businessEmailVerifiedAt !== null,
      businessDomainStatus: company.businessDomainStatus,
      businessPhone: company.businessPhone,
    },
    applicant: {
      // The person's own name and number, from their profile - shown on the
      // representative step so they see what the reviewer sees. Changed on
      // the profile, not here.
      ...applicantContact(company),
      jobTitle: company.applicantJobTitle,
      relationship: company.applicantRelationship,
      authorityConfirmed: company.applicantAuthorityConfirmedAt !== null,
    },
    prefilledFromSeller: company.linkedSellerAccountId !== null,
    addresses: company.addresses.map(addressView),
    identifiers: company.identifiers.map((row) => ({
      scheme: row.scheme,
      value: row.value,
      notApplicable: row.notApplicable,
      notApplicableReason: row.notApplicableReason,
    })),
    procurement: company.procurementProfileJson ?? null,
    requirements: requirementsView(company),
    problems: completenessProblems(snapshotOf(company)),
    documents: company.documents.map((document) => ({
      id: document.id,
      kind: document.kind,
      status: document.status,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes,
      pageCount: document.pageCount,
      reviewReason: document.reviewReason,
      infoRequestId: document.infoRequestId,
      createdAt: document.createdAt.toISOString(),
    })),
    infoRequests: company.infoRequests.map((request) => ({
      id: request.id,
      status: request.status,
      message: request.message,
      requestedDocumentKinds: Array.isArray(request.requestedDocumentKindsJson)
        ? request.requestedDocumentKindsJson
        : [],
      createdAt: request.createdAt.toISOString(),
      responseMessage: request.responseMessage,
      respondedAt: iso(request.respondedAt),
    })),
    createdAt: company.createdAt.toISOString(),
    submittedAt: iso(company.submittedAt),
    firstSubmittedAt: iso(company.firstSubmittedAt),
    approvedAt: iso(company.approvedAt),
    rejectedAt: iso(company.rejectedAt),
    suspendedAt: iso(company.suspendedAt),
    lastStatusChangedAt: iso(company.lastStatusChangedAt),
  };
}

/**
 * What an applicant sees. No internal note, no registry evidence, no
 * duplicate signal, no reviewer identity - the view is built from an
 * allowlist rather than by deleting fields from the reviewer's, so a field
 * added to the reviewer view later does not leak here by default.
 */
export function applicantView(
  company: CompanyRecord,
  membership: Membership,
): Record<string, unknown> {
  const canManage = roleHasCapability(membership.role, 'MANAGE_APPLICATION');
  const editable = isEditableStatus(company.status);
  const hasOpenRequest = company.infoRequests.some((request) => request.status === 'OPEN');

  return {
    ...commonView(company),
    role: membership.role,
    canManage,
    timeline: company.reviewEvents
      .filter((event) => event.visibility === 'APPLICANT')
      .map((event) => ({
        kind: event.kind,
        message: event.message,
        data: event.dataJson ?? null,
        createdAt: event.createdAt.toISOString(),
      })),
    actions: {
      edit: canManage && editable,
      submit:
        canManage &&
        (company.status === 'DRAFT' || company.status === 'EMAIL_VERIFICATION_PENDING'),
      resubmit:
        canManage &&
        (company.status === 'MORE_INFORMATION_REQUIRED' ||
          company.status === 'REVERIFICATION_REQUIRED'),
      reopen: canManage && company.status === 'REJECTED' && company.resubmissionAllowed,
      respond: canManage && hasOpenRequest,
      verifyEmail:
        canManage && company.businessEmailVerifiedAt === null && company.businessEmail !== null,
    },
  };
}

/** Everything, for a member of staff holding buyer_company.read. */
export function reviewerView(
  company: CompanyRecord,
  permissions: { canReview: boolean; canSuspend: boolean },
): Record<string, unknown> {
  const currentCase = company.cases[0] ?? null;
  const transitions = allowedBuyerCompanyTransitions(company.status, 'REVIEWER').filter(
    (transition) => {
      // Suspending, and lifting a suspension, are their own grant.
      const suspendish =
        transition.to === 'SUSPENDED' ||
        (company.status === 'SUSPENDED' && transition.to === 'APPROVED');
      return suspendish ? permissions.canSuspend : permissions.canReview;
    },
  );

  return {
    ...commonView(company),
    riskLevel: company.riskLevel,
    registrationClaimed: company.registrationClaimKey !== null,
    // The seller account for the same legal entity, with its OWN status. Shown
    // so a reviewer can compare the two; neither status decides the other.
    linkedSeller:
      company.linkedSellerAccount === null
        ? null
        : {
            id: company.linkedSellerAccount.id,
            legalName: company.linkedSellerAccount.legalName,
            displayName: company.linkedSellerAccount.displayName,
            status: company.linkedSellerAccount.status,
            registrationCountry: company.linkedSellerAccount.registrationCountry,
          },
    members: company.members.map((member) => ({
      userId: member.userId,
      role: member.role,
      status: member.status,
      email: member.user.email,
      emailVerified: member.user.emailVerifiedAt !== null,
      fullName: member.user.customerProfile?.fullName ?? null,
      phone: member.user.customerProfile?.phone ?? null,
      joinedAt: member.createdAt.toISOString(),
    })),
    currentCase:
      currentCase === null
        ? null
        : {
            id: currentCase.id,
            round: currentCase.round,
            trigger: currentCase.trigger,
            state: currentCase.state,
            assignedReviewer: currentCase.assignedReviewer,
            assignedAt: iso(currentCase.assignedAt),
            requiresSecondReview: currentCase.requiresSecondReview,
            firstApprovalById: currentCase.firstApprovalById,
            firstApprovalAt: iso(currentCase.firstApprovalAt),
            openedAt: currentCase.openedAt.toISOString(),
          },
    checks: company.checks.map((check) => ({
      id: check.id,
      provider: check.provider,
      subject: check.subject,
      outcome: check.outcome,
      summary: check.summary,
      request: check.requestJson,
      result: check.resultJson,
      sourceReference: check.sourceReference,
      sourceUrl: check.sourceUrl,
      checkedAt: check.checkedAt.toISOString(),
    })),
    timeline: company.reviewEvents.map((event) => ({
      id: event.id,
      kind: event.kind,
      visibility: event.visibility,
      actorType: event.actorType,
      actorUserId: event.actorUserId,
      message: event.message,
      data: event.dataJson ?? null,
      createdAt: event.createdAt.toISOString(),
    })),
    statusHistory: company.statusHistory.map((row) => ({
      from: row.fromStatus,
      to: row.toStatus,
      reason: row.reason,
      reasonCode: row.reasonCode,
      actorType: row.actorType,
      actorUserId: row.actorUserId,
      createdAt: row.createdAt.toISOString(),
    })),
    consents: company.consents.map((consent) => ({
      purpose: consent.purpose,
      textVersion: consent.textVersion,
      acceptedAt: consent.acceptedAt.toISOString(),
      userId: consent.userId,
    })),
    allowedTransitions: transitions,
    providedSchemes: [...providedSchemes(company)],
  };
}

export async function loadCompanyRecord(
  companyId: string,
  client: Tx | typeof prisma = prisma,
): Promise<CompanyRecord> {
  const company = await client.buyerCompany.findUnique({
    where: { id: companyId },
    include: COMPANY_INCLUDE,
  });
  if (company === null || company.archivedAt !== null) throw notFound('Company');
  return company;
}
