/**
 * What a reviewer needs to decide a seller application, and the evidence gate
 * approval has to pass.
 *
 * Three jobs:
 *
 *   1. **The review view** - the ownership-and-registrations section, each
 *      owner with their current screening, the intended categories against
 *      the market rules that block them, and identifier signals (a GSTIN whose
 *      PAN is not the PAN given).
 *   2. **Manual screening** - a member of staff records that they checked the
 *      business, or one owner, against restricted-party and sanctions lists,
 *      which lists, and what they found. Every row says `provider = manual`
 *      and `automated = false`, because that is what happened. No automated
 *      screening provider ships with this product, and nothing here or on any
 *      screen may present a person's check as a machine's.
 *   3. **The approval gate** - `assertApprovalEvidence`, called by
 *      `decideApplication` before any move to APPROVED.
 *
 * Operator-only. Nothing in this file is serialised to a seller route: telling
 * a seller that one of its owners came back as a possible sanctions match is
 * tipping off.
 */
import type { ScreeningState, ScreeningSubjectType } from '../../generated/prisma/enums.js';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, notFound, type ErrorDetail } from '../../domain/errors.js';
import { kybSignals } from '../../domain/seller-kyb.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { loadKybView, type KybOwnerView, type KybView } from './kyb.service.js';
import { STEP_DEFINITIONS, markRequirementSteps, requirementsFor } from './onboarding.service.js';
import { turnoverApprovalGaps } from './turnover-facts.service.js';

/** The only screening provider this product has. */
export const MANUAL_SCREENING_PROVIDER = 'manual';

export interface ScreeningView {
  id: string;
  subjectType: ScreeningSubjectType;
  beneficialOwnerId: string | null;
  /** The name as it was when screened. A later edit does not inherit it. */
  subjectName: string;
  provider: string;
  /** Always false here. Rendered, so the screen can never imply otherwise. */
  automated: boolean;
  state: ScreeningState;
  listsChecked: string | null;
  note: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  isCurrent: boolean;
}

export interface ApprovalReadiness {
  ready: boolean;
  missing: ErrorDetail[];
}

export interface ReviewOwner extends KybOwnerView {
  screening: ScreeningView | null;
}

export interface KybReview extends Omit<KybView, 'isEditable' | 'beneficialOwners' | 'intendedCategories'> {
  beneficialOwners: ReviewOwner[];
  intendedCategories: {
    id: string;
    name: string;
    /** Destinations whose market rules block this category, with the rule's own reason. */
    blockedIn: { countryCode: string; reason: string }[];
  }[];
  /** Identifier contradictions, e.g. `GSTIN_PAN_MISMATCH`. For a person to weigh. */
  signals: string[];
  screening: {
    required: boolean;
    provider: typeof MANUAL_SCREENING_PROVIDER;
    /** There is no automated screening provider. Stated, not implied. */
    automatedProviderConfigured: false;
    entity: ScreeningView | null;
    history: ScreeningView[];
  };
  readiness: ApprovalReadiness;
}

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

type ScreeningRow = Awaited<ReturnType<typeof prisma.sellerScreeningCheck.findMany>>[number];

function toScreeningView(row: ScreeningRow, reviewers: Map<string, string>): ScreeningView {
  return {
    id: row.id,
    subjectType: row.subjectType,
    beneficialOwnerId: row.beneficialOwnerId,
    subjectName: row.subjectName,
    provider: row.provider,
    automated: row.automated,
    state: row.state,
    listsChecked: row.listsChecked,
    note: row.note,
    reviewedAt: row.reviewedAt === null ? null : row.reviewedAt.toISOString(),
    reviewedBy: row.reviewedByUserId === null ? null : (reviewers.get(row.reviewedByUserId) ?? null),
    isCurrent: row.isCurrent,
  };
}

/** Newest first, so the first current row per subject is the one that counts. */
async function screeningsOf(sellerAccountId: string): Promise<ScreeningRow[]> {
  return prisma.sellerScreeningCheck.findMany({
    where: { sellerAccountId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 200,
  });
}

function currentFor(
  rows: readonly ScreeningRow[],
  subjectType: ScreeningSubjectType,
  beneficialOwnerId: string | null,
): ScreeningRow | null {
  return (
    rows.find(
      (row) =>
        row.isCurrent && row.subjectType === subjectType && row.beneficialOwnerId === beneficialOwnerId,
    ) ?? null
  );
}

export interface RecordScreeningInput {
  sellerAccountId: string;
  subjectType: ScreeningSubjectType;
  /** Required for BENEFICIAL_OWNER, refused for ENTITY. */
  beneficialOwnerId?: string | null;
  result: Exclude<ScreeningState, 'PENDING_REVIEW'>;
  /** Which lists were consulted, in the reviewer's own words. Required. */
  listsChecked: string;
  note?: string | null;
  adminUserId: string;
  /** Which console recorded it. Verification screenings come from AUDIT. */
  actorType?: 'ADMIN' | 'AUDIT';
  correlationId?: string | null;
}

/**
 * Record one manual screening. The previous current row for the same subject
 * stops being current; nothing is overwritten, so the history shows a
 * POTENTIAL_MATCH that was later cleared, and who cleared it.
 */
export async function recordScreening(input: RecordScreeningInput): Promise<ScreeningView> {
  const account = await prisma.sellerAccount.findUnique({
    where: { id: input.sellerAccountId },
    select: { id: true, legalName: true },
  });
  if (account === null) throw notFound('Seller');

  const lists = input.listsChecked.trim();
  if (lists.length < 2) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say which lists were checked.', [
      { field: 'listsChecked', code: 'REQUIRED' },
    ]);
  }

  let subjectName = account.legalName;
  let ownerId: string | null = null;

  if (input.subjectType === 'BENEFICIAL_OWNER') {
    const owner =
      input.beneficialOwnerId === null || input.beneficialOwnerId === undefined
        ? null
        : await prisma.sellerBeneficialOwner.findFirst({
            where: { id: input.beneficialOwnerId, sellerAccountId: account.id, archivedAt: null },
            select: { id: true, fullName: true },
          });
    if (owner === null) throw notFound('Owner');
    subjectName = owner.fullName;
    ownerId = owner.id;
  } else if (input.beneficialOwnerId !== null && input.beneficialOwnerId !== undefined) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'A screening of the business names no owner.', [
      { field: 'beneficialOwnerId', code: 'NOT_APPLICABLE' },
    ]);
  }

  const now = new Date();
  const row = await prisma.$transaction(async (tx) => {
    await tx.sellerScreeningCheck.updateMany({
      where: {
        sellerAccountId: account.id,
        subjectType: input.subjectType,
        beneficialOwnerId: ownerId,
        isCurrent: true,
      },
      data: { isCurrent: false },
    });

    return tx.sellerScreeningCheck.create({
      data: {
        id: newId(),
        sellerAccountId: account.id,
        subjectType: input.subjectType,
        beneficialOwnerId: ownerId,
        subjectName,
        provider: MANUAL_SCREENING_PROVIDER,
        automated: false,
        state: input.result,
        listsChecked: lists.slice(0, 512),
        note: input.note === null || input.note === undefined || input.note.trim().length === 0 ? null : input.note.trim(),
        reviewedByUserId: input.adminUserId,
        reviewedAt: now,
        isCurrent: true,
      },
    });
  });

  await recordAudit({
    action: AuditAction.SELLER_SCREENING_RECORDED,
    resourceType: 'seller_screening_check',
    resourceId: row.id,
    actorType: input.actorType ?? 'ADMIN',
    actorUserId: input.adminUserId,
    actorEmail: null,
    after: {
      sellerAccountId: account.id,
      subjectType: input.subjectType,
      beneficialOwnerId: ownerId,
      result: input.result,
      provider: MANUAL_SCREENING_PROVIDER,
      automated: false,
    },
    correlationId: input.correlationId ?? null,
  });

  const reviewer = await prisma.user.findUnique({ where: { id: input.adminUserId }, select: { email: true } });
  return toScreeningView(row, new Map(reviewer === null ? [] : [[input.adminUserId, reviewer.email]]));
}

// ---------------------------------------------------------------------------
// The approval gate
// ---------------------------------------------------------------------------

/**
 * Everything approval is still waiting for. Empty `missing` means ready.
 *
 * The documents are judged again here, against today, rather than trusted
 * from the checklist: a certificate that was fine when the seller submitted
 * may have expired while the application sat in the queue.
 */
export async function approvalReadiness(sellerAccountId: string): Promise<ApprovalReadiness> {
  const account = await prisma.sellerAccount.findUnique({
    where: { id: sellerAccountId },
    select: { kind: true, registrationCountry: true, legalName: true },
  });
  if (account === null) throw notFound('Seller');

  // Brings the stored checklist up to date first - an operator's document
  // decision, or a date passing, moves it without the seller doing anything.
  await markRequirementSteps({ sellerAccountId, registrationCountry: account.registrationCountry });

  const [progress, requirements, documents, owners, screenings] = await Promise.all([
    prisma.sellerOnboardingProgress.findUnique({ where: { sellerAccountId }, select: { stepsJson: true } }),
    requirementsFor(account.registrationCountry, account.kind),
    prisma.sellerDocument.findMany({
      where: { sellerAccountId, supersededAt: null },
      select: { requirementFieldKey: true, approvedAt: true, expiresOn: true },
    }),
    prisma.sellerBeneficialOwner.findMany({
      where: { sellerAccountId, archivedAt: null },
      select: { id: true, fullName: true },
    }),
    screeningsOf(sellerAccountId),
  ]);

  const missing: ErrorDetail[] = [];
  const steps = (progress?.stepsJson ?? {}) as Record<string, { state?: string } | undefined>;

  for (const step of STEP_DEFINITIONS) {
    const required =
      step.isRequiredForSubmission ||
      requirements.some((requirement) => requirement.stepKey === step.key && requirement.isRequired);
    if (!required) continue;
    const state = steps[step.key]?.state ?? 'NOT_STARTED';
    // UNDER_REVIEW means "a document is waiting on you"; the document entries
    // below say which, so the step is not listed twice.
    if (state === 'COMPLETE' || state === 'UNDER_REVIEW') continue;
    missing.push({ code: 'STEP_INCOMPLETE', field: step.key, message: `${step.title} is not complete.` });
  }

  const now = Date.now();
  for (const requirement of requirements) {
    if (!requirement.isDocument || !requirement.isRequired) continue;
    const answers = documents.filter((document) => document.requirementFieldKey === requirement.fieldKey);
    const approved = answers.filter((document) => document.approvedAt !== null);
    const current = approved.some(
      (document) => document.expiresOn === null || document.expiresOn.getTime() >= now,
    );
    if (current) continue;
    missing.push(
      approved.length > 0
        ? { code: 'DOCUMENT_EXPIRED', field: requirement.fieldKey, message: `${requirement.label} has expired.` }
        : { code: 'DOCUMENT_NOT_APPROVED', field: requirement.fieldKey, message: `${requirement.label} has not been accepted.` },
    );
  }

  // The seller turnover policy: declared above the minimum AND verified by a
  // person. Nothing for a seller approved before the policy existed.
  missing.push(...(await turnoverApprovalGaps(sellerAccountId)));

  if (env.SELLER_REQUIRE_SCREENING) {
    const entity = currentFor(screenings, 'ENTITY', null);
    if (entity === null || entity.subjectName !== account.legalName) {
      missing.push({ code: 'SCREENING_REQUIRED', field: 'entity', message: `${account.legalName} has not been screened.` });
    } else if (entity.state !== 'CLEAR') {
      missing.push({ code: 'SCREENING_NOT_CLEAR', field: 'entity', message: `The screening of ${account.legalName} is not clear.` });
    }

    for (const owner of owners) {
      const check = currentFor(screenings, 'BENEFICIAL_OWNER', owner.id);
      // A check made against a different spelling is a check of somebody else.
      if (check === null || check.subjectName !== owner.fullName) {
        missing.push({ code: 'SCREENING_REQUIRED', field: owner.id, message: `${owner.fullName} has not been screened.`, meta: { name: owner.fullName } });
      } else if (check.state !== 'CLEAR') {
        missing.push({ code: 'SCREENING_NOT_CLEAR', field: owner.id, message: `The screening of ${owner.fullName} is not clear.`, meta: { name: owner.fullName } });
      }
    }
  }

  return { ready: missing.length === 0, missing };
}

/** Refuses approval, naming every missing piece of evidence. */
export async function assertApprovalEvidence(sellerAccountId: string): Promise<void> {
  const readiness = await approvalReadiness(sellerAccountId);
  if (readiness.ready) return;

  throw conflict(
    ErrorCode.SELLER_APPROVAL_EVIDENCE_MISSING,
    `This seller cannot be approved yet: ${readiness.missing.map((item) => item.message ?? item.code).join(' ')}`,
    readiness.missing,
  );
}

// ---------------------------------------------------------------------------
// The review view
// ---------------------------------------------------------------------------

/** Destinations whose market rules block each category, directly or through a parent. */
async function blockedDestinations(
  categoryIds: readonly string[],
): Promise<Map<string, { countryCode: string; reason: string }[]>> {
  const result = new Map<string, { countryCode: string; reason: string }[]>();
  if (categoryIds.length === 0) return result;

  const categories = await prisma.category.findMany({
    where: { id: { in: [...categoryIds] } },
    select: { id: true, path: true },
  });
  const lineage = new Map(
    categories.map((category) => [
      category.id,
      [...category.path.split('/').filter((part) => part.length > 0), category.id],
    ]),
  );

  const now = new Date();
  const rules = await prisma.marketRule.findMany({
    where: {
      scope: 'CATEGORY',
      effect: 'BLOCK',
      isActive: true,
      categoryId: { in: [...new Set([...lineage.values()].flat())] },
      effectiveFrom: { lte: now },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }],
    },
    select: { categoryId: true, countryCode: true, reason: true },
    orderBy: { countryCode: 'asc' },
  });

  for (const [categoryId, chain] of lineage) {
    result.set(
      categoryId,
      rules
        .filter((rule) => rule.categoryId !== null && chain.includes(rule.categoryId))
        .map((rule) => ({ countryCode: rule.countryCode, reason: rule.reason })),
    );
  }
  return result;
}

export async function readKybReview(sellerAccountId: string): Promise<KybReview> {
  const account = await prisma.sellerAccount.findUnique({
    where: { id: sellerAccountId },
    select: {
      registrationCountry: true,
      businessProfile: {
        select: {
          legalForm: true,
          companyRegistrationNumber: true,
          taxRegistrationNumber: true,
          extraIdentifiersJson: true,
        },
      },
    },
  });
  if (account === null) throw notFound('Seller');

  const [view, screenings, readiness] = await Promise.all([
    loadKybView(sellerAccountId, account.registrationCountry),
    screeningsOf(sellerAccountId),
    approvalReadiness(sellerAccountId),
  ]);

  const reviewerIds = [
    ...new Set(screenings.map((row) => row.reviewedByUserId).filter((id): id is string => id !== null)),
  ];
  const reviewers = new Map(
    (reviewerIds.length === 0
      ? []
      : await prisma.user.findMany({ where: { id: { in: reviewerIds } }, select: { id: true, email: true } })
    ).map((user) => [user.id, user.email]),
  );

  const blocked = await blockedDestinations(view.intendedCategories.map((category) => category.id));
  const extras = (account.businessProfile?.extraIdentifiersJson ?? {}) as Record<string, unknown>;
  const pan = typeof extras['pan_number'] === 'string' ? extras['pan_number'] : null;
  const entity = currentFor(screenings, 'ENTITY', null);

  return {
    ...view,
    beneficialOwners: view.beneficialOwners.map((owner) => {
      const check = currentFor(screenings, 'BENEFICIAL_OWNER', owner.id);
      return { ...owner, screening: check === null ? null : toScreeningView(check, reviewers) };
    }),
    intendedCategories: view.intendedCategories.map((category) => ({
      ...category,
      blockedIn: blocked.get(category.id) ?? [],
    })),
    signals: kybSignals({
      registrationCountry: account.registrationCountry,
      legalForm: (account.businessProfile?.legalForm ?? null),
      companyRegistrationNumber: account.businessProfile?.companyRegistrationNumber ?? null,
      taxRegistrationNumber: account.businessProfile?.taxRegistrationNumber ?? null,
      panNumber: pan,
    }),
    screening: {
      required: env.SELLER_REQUIRE_SCREENING,
      provider: MANUAL_SCREENING_PROVIDER,
      automatedProviderConfigured: false,
      entity: entity === null ? null : toScreeningView(entity, reviewers),
      history: screenings.map((row) => toScreeningView(row, reviewers)),
    },
    readiness,
  };
}
