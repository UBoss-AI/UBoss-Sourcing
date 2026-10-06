/**
 * Qualification cases: may this seller sell in this category, in this supply
 * role, into this market (SELLER_CATEGORY) - or may this product be sold into
 * this market (PRODUCT)?
 *
 *   REQUESTED → UNDER_REVIEW → CHANGES_REQUESTED → (seller answers) → UNDER_REVIEW
 *                            → QUALIFIED → SUSPENDED / EXPIRED / REREVIEW_REQUIRED
 *                            → REJECTED
 *   (the seller may WITHDRAW anything not yet decided)
 *
 * A case is approved only when `evaluateCompliance` finds nothing blocking:
 * every applicable mandatory requirement satisfied by an approved, in-scope,
 * in-date document, and every CONDITIONAL or UNRESOLVED requirement given a
 * per-case determination with a reason. A case in a category no approved rule
 * reaches cannot be approved at all - the console says the category's rules
 * still need review, rather than qualifying the seller by default.
 *
 * Qualification is narrow on purpose: it covers exactly its category (and the
 * categories beneath it), supply role, market and site. Nothing here, and
 * nothing that reads it, treats one category's qualification as another's.
 */
import { z } from 'zod';
import {
  evaluateCompliance,
  type CaseScope,
  type ComplianceDocumentFacts,
  type Determination,
  type Evaluation,
} from '../../domain/compliance-evaluation.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { env } from '../../config/env.js';
import { newId } from '../../infra/ids.js';
import type { PrismaTransaction } from '../../infra/prisma.js';
import { prisma } from '../../infra/prisma.js';
import { withWriteConflictRetry } from '../../infra/write-conflict.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { notifyAuditUsers, staffUserIds } from '../audit-console/notification.service.js';
import { notifySeller } from '../seller/notification.service.js';
import { logger } from '../../infra/logger.js';
import { recordComplianceEvent, type ComplianceActor } from './events.js';
import { approvedRules } from './requirement.service.js';

type Client = PrismaTransaction | typeof prisma;
type CaseStatus =
  | 'REQUESTED'
  | 'UNDER_REVIEW'
  | 'CHANGES_REQUESTED'
  | 'QUALIFIED'
  | 'REJECTED'
  | 'SUSPENDED'
  | 'EXPIRED'
  | 'REREVIEW_REQUIRED'
  | 'WITHDRAWN';

const TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  REQUESTED: ['UNDER_REVIEW', 'WITHDRAWN'],
  UNDER_REVIEW: ['CHANGES_REQUESTED', 'QUALIFIED', 'REJECTED', 'WITHDRAWN'],
  CHANGES_REQUESTED: ['UNDER_REVIEW', 'WITHDRAWN'],
  QUALIFIED: ['SUSPENDED', 'EXPIRED', 'REREVIEW_REQUIRED'],
  REREVIEW_REQUIRED: ['UNDER_REVIEW', 'SUSPENDED'],
  SUSPENDED: ['UNDER_REVIEW'],
  EXPIRED: ['UNDER_REVIEW'],
  REJECTED: ['REQUESTED'],
  WITHDRAWN: ['REQUESTED'],
};

export function assertCaseTransition(from: CaseStatus, to: CaseStatus): void {
  if (!(TRANSITIONS[from] ?? []).includes(to)) {
    throw conflict(ErrorCode.COMPLIANCE_CASE_NOT_READY, `A case cannot move from ${from} to ${to}.`, [{ code: 'TRANSITION', meta: { from, to } }]);
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

const today = (): string => new Date().toISOString().slice(0, 10);

async function nextCaseNumber(tx: PrismaTransaction): Promise<string> {
  const year = new Date().getUTCFullYear();
  const key = `compliance-case:${String(year)}`;
  await tx.numberSequence.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1, prefix: 'CQ', padding: 6 },
  });
  const sequence = await tx.numberSequence.findUniqueOrThrow({ where: { key } });
  return `${sequence.prefix}-${String(year)}-${sequence.value.toString().padStart(sequence.padding, '0')}`;
}

/** The category, then its ancestors up to the department. */
export async function categoryPathOf(client: Client, categoryId: string): Promise<string[]> {
  const category = await client.category.findUnique({ where: { id: categoryId }, select: { id: true, path: true } });
  if (category === null) return [categoryId];
  const ids = category.path.split('/').filter((part) => part.length > 0);
  const ordered = ids.includes(category.id) ? ids : [...ids, category.id];
  return ordered.reverse();
}

type CaseRow = Awaited<ReturnType<typeof prisma.complianceCase.findMany>>[number];

async function scopeOf(client: Client, row: Pick<CaseRow, 'level' | 'categoryId' | 'productId' | 'supplyRole' | 'destinationMarket' | 'factoryId' | 'sellerAccountId'>): Promise<CaseScope> {
  const [path, seller, device] = await Promise.all([
    categoryPathOf(client, row.categoryId),
    client.sellerAccount.findUnique({ where: { id: row.sellerAccountId }, select: { registrationCountry: true } }),
    row.productId === '' ? null : client.productDeviceInfo.findUnique({ where: { productId: row.productId }, select: { deviceClass: true } }),
  ]);
  return {
    level: row.level,
    categoryPath: path,
    productId: row.productId === '' ? null : row.productId,
    supplyRole: row.supplyRole,
    destinationMarket: row.destinationMarket,
    originCountry: seller?.registrationCountry ?? null,
    factoryId: row.factoryId === '' ? null : row.factoryId,
    riskClass: device?.deviceClass ?? null,
  };
}

async function documentFacts(client: Client, sellerAccountId: string): Promise<ComplianceDocumentFacts[]> {
  const rows = await client.sellerCertification.findMany({
    where: { sellerAccountId, archivedAt: null, supersededAt: null },
  });
  return rows.map((row) => ({
    id: row.id,
    reviewStatus: row.reviewStatus,
    requirementCodes: strings(row.requirementCodesJson),
    categoryScopeIds: strings(row.categoryScopeIdsJson),
    productScopeIds: strings(row.productScopeIdsJson),
    factoryId: row.factoryId,
    expiresOn: row.expiresOn?.toISOString().slice(0, 10) ?? null,
    noExpiryReason: row.noExpiryReason,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    verificationMethod: row.verificationMethod,
    verificationOutcome: row.verificationOutcome,
  }));
}

function determinationsOf(value: unknown): Record<string, Determination> {
  return value !== null && typeof value === 'object' ? (value as Record<string, Determination>) : {};
}

/** Evaluate one case against the rules in force now. */
export async function evaluateCase(client: Client, row: CaseRow): Promise<Evaluation> {
  const [rules, scope, documents] = await Promise.all([
    approvedRules(),
    scopeOf(client, row),
    documentFacts(client, row.sellerAccountId),
  ]);
  return evaluateCompliance({ rules, scope, documents, determinations: determinationsOf(row.determinationsJson), today: today() });
}

// ---------------------------------------------------------------------------
// The seller asks
// ---------------------------------------------------------------------------

export const caseRequestInput = z.strictObject({
  level: z.enum(['SELLER_CATEGORY', 'PRODUCT']),
  categoryId: z.string().length(26),
  productId: z.string().length(26).nullable().optional(),
  supplyRole: z.enum(['MANUFACTURER', 'IMPORTER', 'DISTRIBUTOR', 'AUTHORISED_REPRESENTATIVE']),
  destinationMarket: z.string().trim().regex(/^(?:[A-Z]{2}|EU)?$/).default(''),
  factoryId: z.string().length(26).nullable().optional(),
  message: z.string().trim().max(2000).nullable().optional(),
});

export interface CaseRequester {
  party: 'SELLER' | 'AUDIT' | 'ADMIN';
  sellerAccountId: string;
  userId: string;
  label: string;
  correlationId?: string | null;
}

/**
 * Open (or reopen) a case. Idempotent on its scope: asking twice for the same
 * category, role, market and site returns the one case. Also how a reviewer
 * opens a case for an existing seller during the backfill review.
 */
export async function requestCase(requester: CaseRequester, input: z.infer<typeof caseRequestInput>): Promise<{ id: string; caseNumber: string; created: boolean }> {
  const productId = input.level === 'PRODUCT' ? input.productId ?? null : null;
  if (input.level === 'PRODUCT' && productId === null) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Choose the product.', [{ field: 'productId', code: 'REQUIRED' }]);
  }
  const category = await prisma.category.findFirst({ where: { id: input.categoryId, archivedAt: null }, select: { id: true } });
  if (category === null) throw notFound('Category');
  if (productId !== null) {
    const offered = await prisma.sellerOffer.findFirst({
      where: { sellerAccountId: requester.sellerAccountId, productId },
      select: { product: { select: { categoryId: true } } },
    });
    if (offered === null) throw notFound('Product');
    if (offered.product.categoryId !== input.categoryId) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'That product is not in that category.', [{ field: 'categoryId', code: 'MISMATCH' }]);
    }
  }
  if (input.factoryId) {
    const factory = await prisma.sellerFactory.count({ where: { id: input.factoryId, sellerAccountId: requester.sellerAccountId, archivedAt: null } });
    if (factory === 0) throw notFound('Factory');
  }

  const key = {
    level: input.level,
    sellerAccountId: requester.sellerAccountId,
    categoryId: input.categoryId,
    productId: productId ?? '',
    supplyRole: input.supplyRole,
    destinationMarket: input.destinationMarket,
    factoryId: input.factoryId ?? '',
  };
  const actor: ComplianceActor = {
    type: requester.party === 'SELLER' ? 'SELLER' : requester.party,
    userId: requester.userId,
    label: requester.label,
    correlationId: requester.correlationId ?? null,
  };

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.complianceCase.findUnique({ where: { level_sellerAccountId_categoryId_productId_supplyRole_destinationMarket_factoryId: key } });
      if (existing !== null) {
        if (existing.status !== 'REJECTED' && existing.status !== 'WITHDRAWN') {
          return { id: existing.id, caseNumber: existing.caseNumber, created: false };
        }
        await tx.complianceCase.update({
          where: { id: existing.id },
          data: { status: 'REQUESTED', requestedByParty: requester.party, requestedById: requester.userId, sellerMessage: null, lockVersion: { increment: 1 } },
        });
        await recordComplianceEvent(tx, {
          subjectType: 'CASE',
          subjectId: existing.id,
          sellerAccountId: requester.sellerAccountId,
          kind: 'reopened',
          actor,
          summary: `${existing.caseNumber} asked for again.${input.message ? ` ${input.message}` : ''}`,
          sellerVisible: true,
        });
        return { id: existing.id, caseNumber: existing.caseNumber, created: false };
      }

      const id = newId();
      const caseNumber = await nextCaseNumber(tx);
      await tx.complianceCase.create({
        data: { id, caseNumber, ...key, status: 'REQUESTED', requestedByParty: requester.party, requestedById: requester.userId },
      });
      await recordComplianceEvent(tx, {
        subjectType: 'CASE',
        subjectId: id,
        sellerAccountId: requester.sellerAccountId,
        kind: 'requested',
        actor,
        summary: `${caseNumber} opened.${input.message ? ` ${input.message}` : ''}`,
        sellerVisible: true,
      });
      await recordAudit(
        {
          action: AuditAction.COMPLIANCE_CASE_REQUESTED,
          resourceType: 'compliance_case',
          resourceId: id,
          actorType: requester.party === 'SELLER' ? 'CUSTOMER' : requester.party,
          actorUserId: requester.userId,
          after: key,
          correlationId: requester.correlationId ?? null,
        },
        tx,
      );
      const reviewers = await staffUserIds(tx, ['SUPERVISOR', 'COMPLIANCE_REVIEWER']);
      await notifyAuditUsers(tx, reviewers, {
        kind: 'CASE_REQUESTED',
        title: `New ${input.level === 'PRODUCT' ? 'product compliance' : 'category qualification'} case ${caseNumber}`,
        link: `/cases/${id}`,
        subjectType: 'compliance_case',
        subjectId: id,
        dedupeKey: `case-requested:${id}`,
      });
      return { id, caseNumber, created: true };
    });
  } catch (error) {
    // Two simultaneous requests for the same scope: the UNIQUE key lets one
    // in; the other reads the case it created.
    if ((error as { code?: string }).code === 'P2002') {
      const row = await prisma.complianceCase.findUnique({ where: { level_sellerAccountId_categoryId_productId_supplyRole_destinationMarket_factoryId: key } });
      if (row !== null) return { id: row.id, caseNumber: row.caseNumber, created: false };
    }
    throw error;
  }
}

/** The seller answers a request for changes, or withdraws. */
export async function sellerRespond(
  requester: CaseRequester,
  caseId: string,
  input: { action: 'RESUBMIT' | 'WITHDRAW'; message?: string | null },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const row = await tx.complianceCase.findFirst({ where: { id: caseId, sellerAccountId: requester.sellerAccountId } });
    if (row === null) throw notFound('Case');
    const to: CaseStatus = input.action === 'WITHDRAW' ? 'WITHDRAWN' : 'UNDER_REVIEW';
    if (input.action === 'RESUBMIT' && row.status !== 'CHANGES_REQUESTED') {
      throw conflict(ErrorCode.COMPLIANCE_CASE_NOT_READY, 'There is nothing to answer on this case.', [{ code: 'NOT_WAITING' }]);
    }
    assertCaseTransition(row.status, to);
    const moved = await tx.complianceCase.updateMany({
      where: { id: caseId, status: row.status, lockVersion: row.lockVersion },
      data: { status: to, lockVersion: { increment: 1 } },
    });
    if (moved.count !== 1) throw staleCase();
    await recordComplianceEvent(tx, {
      subjectType: 'CASE',
      subjectId: caseId,
      sellerAccountId: requester.sellerAccountId,
      kind: input.action === 'WITHDRAW' ? 'withdrawn' : 'resubmitted',
      actor: { type: 'SELLER', userId: requester.userId, label: requester.label },
      summary: `${row.caseNumber} ${input.action === 'WITHDRAW' ? 'withdrawn' : 'answered'} by the seller.${input.message ? ` ${input.message.trim()}` : ''}`,
      sellerVisible: true,
    });
    if (input.action === 'RESUBMIT' && row.reviewerUserId !== null) {
      await notifyAuditUsers(tx, [row.reviewerUserId], {
        kind: 'CASE_ANSWERED',
        title: `${row.caseNumber}: the seller answered`,
        body: input.message ?? null,
        link: `/cases/${caseId}`,
        subjectType: 'compliance_case',
        subjectId: caseId,
        dedupeKey: `case-answered:${caseId}:${String(row.lockVersion)}`,
      });
    }
  });
}

const staleCase = () =>
  conflict(ErrorCode.COMPLIANCE_CASE_NOT_READY, 'This case changed while you were looking at it. Reload it.', [{ code: 'STALE' }]);

// ---------------------------------------------------------------------------
// The reviewer decides
// ---------------------------------------------------------------------------

export const determinationInput = z.strictObject({
  code: z.string().trim().max(64),
  decision: z.enum(['APPLIES', 'NOT_APPLICABLE', 'UNRESOLVED']),
  reason: z.string().trim().min(10).max(2000),
});

/** Record whether a conditional or unresolved requirement applies to THIS case. */
export async function determineApplicability(actor: ComplianceActor & { userId: string }, caseId: string, input: z.infer<typeof determinationInput>): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const row = await tx.complianceCase.findUnique({ where: { id: caseId } });
    if (row === null) throw notFound('Case');
    if (!['UNDER_REVIEW', 'REREVIEW_REQUIRED'].includes(row.status)) {
      throw conflict(ErrorCode.COMPLIANCE_CASE_NOT_READY, 'Start the review first.', [{ code: 'NOT_UNDER_REVIEW' }]);
    }
    const rules = await approvedRules();
    const rule = rules.find((candidate) => candidate.code === input.code);
    if (rule === undefined) throw notFound('Approved requirement');
    if (rule.applicability === 'APPLIES') {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'This requirement always applies in its scope; there is nothing to decide.', [{ field: 'code', code: 'ALWAYS_APPLIES' }]);
    }
    const next = {
      ...determinationsOf(row.determinationsJson),
      [input.code]: { decision: input.decision, reason: input.reason, by: actor.label, at: new Date().toISOString() },
    };
    const moved = await tx.complianceCase.updateMany({
      where: { id: caseId, lockVersion: row.lockVersion },
      data: { determinationsJson: next as never, lockVersion: { increment: 1 } },
    });
    if (moved.count !== 1) throw staleCase();
    await recordComplianceEvent(tx, {
      subjectType: 'CASE',
      subjectId: caseId,
      sellerAccountId: row.sellerAccountId,
      kind: 'determined',
      actor,
      summary: `${input.code}: ${input.decision.replace('_', ' ').toLowerCase()} for this case - ${input.reason}`,
      sellerVisible: false,
    });
  });
}

export type CaseAction = 'START' | 'REQUEST_CHANGES' | 'APPROVE' | 'REJECT' | 'SUSPEND';

export const caseDecisionInput = z.strictObject({
  expectedLockVersion: z.number().int().min(0),
  sellerMessage: z.string().trim().max(4000).nullable().optional(),
  internalNote: z.string().trim().max(4000).nullable().optional(),
});

const ACTION_TARGET: Record<CaseAction, CaseStatus> = {
  START: 'UNDER_REVIEW',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
  APPROVE: 'QUALIFIED',
  REJECT: 'REJECTED',
  SUSPEND: 'SUSPENDED',
};

export async function decideCase(
  actor: ComplianceActor & { userId: string },
  caseId: string,
  action: CaseAction,
  input: z.infer<typeof caseDecisionInput>,
): Promise<{ status: CaseStatus }> {
  const to = ACTION_TARGET[action];
  const message = input.sellerMessage?.trim() || null;
  if ((action === 'REQUEST_CHANGES' || action === 'REJECT' || action === 'SUSPEND') && (message === null || message.length < 10)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Tell the seller what this means for them, in at least ten characters.', [{ field: 'sellerMessage', code: 'REQUIRED' }]);
  }

  const result = await withWriteConflictRetry(() => prisma.$transaction(async (tx) => {
    const row = await tx.complianceCase.findUnique({ where: { id: caseId } });
    if (row === null) throw notFound('Case');
    if (row.lockVersion !== input.expectedLockVersion) throw staleCase();
    assertCaseTransition(row.status, to);

    let snapshot: Record<string, unknown> | null = null;
    let expiresAt: Date | null = row.expiresAt;
    if (action === 'APPROVE') {
      const evaluation = await evaluateCase(tx, row);
      if (evaluation.noApprovedRules) {
        throw conflict(
          ErrorCode.COMPLIANCE_CASE_NOT_READY,
          'No approved requirement covers this category, role and market yet. Its rules need review before anybody can be qualified in it.',
          [{ code: 'NO_APPROVED_RULES' }],
        );
      }
      const blocking = evaluation.outcomes.filter((outcome) => outcome.blocking);
      if (!evaluation.ready) {
        throw conflict(
          ErrorCode.COMPLIANCE_CASE_NOT_READY,
          'This case cannot be approved yet.',
          blocking.map((outcome) => ({ code: outcome.state, meta: { requirement: outcome.code } })),
        );
      }
      const documents = evaluation.outcomes.map((outcome) => outcome.documentId).filter((id): id is string => id !== null);
      snapshot = {
        decidedAt: new Date().toISOString(),
        rules: evaluation.outcomes.map((outcome) => ({ code: outcome.code, ruleVersion: outcome.ruleVersion, state: outcome.state, documentId: outcome.documentId, validUntil: outcome.validUntil })),
        documents,
      };
      expiresAt = evaluation.expiresAt === null ? null : new Date(`${evaluation.expiresAt}T23:59:59.000Z`);
    }

    const now = new Date();
    const moved = await tx.complianceCase.updateMany({
      where: { id: caseId, lockVersion: row.lockVersion },
      data: {
        status: to,
        reviewerUserId: actor.userId,
        reviewerLabel: actor.label.slice(0, 160),
        ...(action === 'START' ? { reviewStartedAt: now } : { decidedAt: now }),
        ...(message === null ? {} : { sellerMessage: message }),
        ...(input.internalNote === undefined ? {} : { internalNote: input.internalNote?.trim() || null }),
        ...(snapshot === null ? {} : { decisionSnapshotJson: snapshot as never, expiresAt }),
        lockVersion: { increment: 1 },
      },
    });
    if (moved.count !== 1) throw staleCase();

    await recordComplianceEvent(tx, {
      subjectType: 'CASE',
      subjectId: caseId,
      sellerAccountId: row.sellerAccountId,
      kind: to.toLowerCase(),
      actor,
      summary: `${row.caseNumber}: ${to.replace('_', ' ').toLowerCase()}${message ? ` - ${message}` : '.'}`,
      sellerVisible: action !== 'START',
      data: snapshot,
    });
    if (action !== 'START') {
      await recordAudit(
        {
          action: AuditAction.COMPLIANCE_CASE_DECIDED,
          resourceType: 'compliance_case',
          resourceId: caseId,
          actorType: actor.type === 'ADMIN' ? 'ADMIN' : 'AUDIT',
          actorUserId: actor.userId,
          before: { status: row.status },
          after: { status: to, snapshot },
          correlationId: actor.correlationId ?? null,
        },
        tx,
      );
    }
    return { row, to };
  }));

  if (action !== 'START') {
    await notifySeller({
      sellerAccountId: result.row.sellerAccountId,
      kind: 'APPLICATION_STATUS',
      title: `${result.row.caseNumber}: ${to === 'QUALIFIED' ? 'qualified' : to.replace('_', ' ').toLowerCase()}`,
      body: message ?? (to === 'QUALIFIED' ? 'You are qualified for this category, role and market.' : 'See Compliance in the Seller Hub.'),
      linkPath: '/seller/compliance',
      severity: to === 'QUALIFIED' ? 'SUCCESS' : 'WARNING',
      subjectType: 'compliance_case',
      subjectId: caseId,
    }).catch((error: unknown) => {
      logger.warn({ err: error }, 'could not notify the seller of a case decision');
    });
  }
  return { status: result.to };
}

/** QUALIFIED cases past their earliest document expiry become EXPIRED. For the worker. */
export async function expireQualifications(limit = 500): Promise<number> {
  const rows = await prisma.complianceCase.findMany({
    where: { status: 'QUALIFIED', expiresAt: { lt: new Date() } },
    select: { id: true, caseNumber: true, sellerAccountId: true, lockVersion: true },
    take: limit,
  });
  let count = 0;
  for (const row of rows) {
    await prisma.$transaction(async (tx) => {
      const moved = await tx.complianceCase.updateMany({
        where: { id: row.id, status: 'QUALIFIED', lockVersion: row.lockVersion },
        data: { status: 'EXPIRED', lockVersion: { increment: 1 } },
      });
      if (moved.count !== 1) return;
      count += 1;
      await recordComplianceEvent(tx, {
        subjectType: 'CASE',
        subjectId: row.id,
        sellerAccountId: row.sellerAccountId,
        kind: 'expired',
        actor: { type: 'SYSTEM', userId: null, label: 'The system' },
        summary: `${row.caseNumber} expired: a document it relied on passed its date.`,
        sellerVisible: true,
      });
    });
  }
  return count;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function caseView(row: CaseRow, audience: 'seller' | 'staff') {
  return {
    id: row.id,
    caseNumber: row.caseNumber,
    level: row.level,
    sellerAccountId: row.sellerAccountId,
    categoryId: row.categoryId,
    productId: row.productId === '' ? null : row.productId,
    supplyRole: row.supplyRole,
    destinationMarket: row.destinationMarket,
    factoryId: row.factoryId === '' ? null : row.factoryId,
    status: row.status,
    reviewerLabel: audience === 'staff' ? row.reviewerLabel : null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    sellerMessage: row.sellerMessage,
    internalNote: audience === 'staff' ? row.internalNote : undefined,
    determinations: audience === 'staff' ? determinationsOf(row.determinationsJson) : undefined,
    lockVersion: row.lockVersion,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listCases(filters: { level?: string | null; status?: string | null; sellerAccountId?: string | null; categoryId?: string | null; search?: string | null }) {
  const sellerIds = filters.search
    ? (await prisma.sellerAccount.findMany({ where: { displayName: { contains: filters.search } }, select: { id: true }, take: 100 })).map((seller) => seller.id)
    : null;
  const rows = await prisma.complianceCase.findMany({
    where: {
      ...(filters.level ? { level: filters.level as never } : {}),
      ...(filters.status ? { status: filters.status as never } : {}),
      ...(filters.sellerAccountId ? { sellerAccountId: filters.sellerAccountId } : {}),
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      ...(sellerIds === null ? {} : { OR: [{ sellerAccountId: { in: sellerIds } }, { caseNumber: { contains: filters.search ?? '' } }] }),
    },
    orderBy: { updatedAt: 'desc' },
    take: 300,
    include: { sellerAccount: { select: { displayName: true } }, category: { select: { name: true } } },
  });
  const productIds = rows.map((row) => row.productId).filter((id) => id !== '');
  const products = productIds.length === 0 ? [] : await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true } });
  const productNames = new Map(products.map((product) => [product.id, product.name]));
  return rows.map((row) => ({
    ...caseView(row, 'staff'),
    sellerName: row.sellerAccount.displayName,
    categoryName: row.category.name,
    productName: row.productId === '' ? null : productNames.get(row.productId) ?? null,
  }));
}

export async function caseDetail(caseId: string, audience: 'seller' | 'staff', sellerAccountId?: string) {
  const row = await prisma.complianceCase.findFirst({
    where: { id: caseId, ...(sellerAccountId === undefined ? {} : { sellerAccountId }) },
    include: { sellerAccount: { select: { displayName: true, kind: true, registrationCountry: true, status: true } }, category: { select: { name: true } } },
  });
  if (row === null) throw notFound('Case');
  const [evaluation, history, product] = await Promise.all([
    evaluateCase(prisma, row),
    prisma.complianceEvent.findMany({
      where: { subjectType: 'CASE', subjectId: caseId, ...(audience === 'seller' ? { sellerVisible: true } : {}) },
      orderBy: { createdAt: 'asc' },
    }),
    row.productId === '' ? null : prisma.product.findUnique({ where: { id: row.productId }, select: { id: true, name: true } }),
  ]);
  return {
    case: caseView(row, audience),
    seller: { id: row.sellerAccountId, name: row.sellerAccount.displayName, kind: row.sellerAccount.kind, country: row.sellerAccount.registrationCountry, status: row.sellerAccount.status },
    categoryName: row.category.name,
    product,
    evaluation,
    enforcement: env.COMPLIANCE_QUALIFICATION_ENFORCEMENT,
    history: history.map((event) => ({ kind: event.kind, actorLabel: event.actorLabel, summary: event.summary, at: event.createdAt.toISOString() })),
  };
}

// ---------------------------------------------------------------------------
// The listing gate
// ---------------------------------------------------------------------------

/**
 * Whether a seller may put a NEW listing or offer live in this category,
 * under the deployment's enforcement setting.
 *
 *   OFF     - always yes.
 *   WARN    - yes, with the list of what is missing for the seller to see.
 *   ENFORCE - yes only when no approved mandatory seller/category requirement
 *             reaches the category, or the seller holds a QUALIFIED (or
 *             re-review-pending) case for the category or an ancestor.
 *
 * Existing live offers are never switched off here: the backfill list in the
 * console shows them for review instead.
 */
export async function qualificationGate(sellerAccountId: string, categoryId: string): Promise<{ allowed: boolean; missing: boolean; mode: 'OFF' | 'WARN' | 'ENFORCE' }> {
  const mode = env.COMPLIANCE_QUALIFICATION_ENFORCEMENT;
  if (mode === 'OFF') return { allowed: true, missing: false, mode };
  const path = await categoryPathOf(prisma, categoryId);
  const rules = await approvedRules();
  const reaching = rules.filter(
    (rule) =>
      rule.level === 'SELLER_CATEGORY' &&
      rule.obligation !== 'OPTIONAL_QUALIFICATION' &&
      rule.categoryIds.some((id) => id === path[0] || (rule.includeDescendants && path.includes(id))),
  );
  if (reaching.length === 0) return { allowed: true, missing: false, mode };
  const qualified = await prisma.complianceCase.count({
    where: { sellerAccountId, level: 'SELLER_CATEGORY', categoryId: { in: path }, status: { in: ['QUALIFIED', 'REREVIEW_REQUIRED'] } },
  });
  const missing = qualified === 0;
  return { allowed: mode === 'WARN' || !missing, missing, mode };
}

export async function assertQualifiedForCategory(sellerAccountId: string, categoryId: string): Promise<void> {
  const gate = await qualificationGate(sellerAccountId, categoryId);
  if (!gate.allowed) {
    throw conflict(
      ErrorCode.COMPLIANCE_QUALIFICATION_REQUIRED,
      'You need an approved qualification for this category before you can list in it. Request one in Seller Hub, Compliance.',
      [{ code: 'QUALIFICATION_REQUIRED', meta: { categoryId } }],
    );
  }
}

/**
 * The backfill review: sellers with live offers in categories that an
 * approved mandatory rule reaches and that they hold no qualification for.
 * Shown to reviewers to work through; nobody is approved or blocked by it.
 */
export async function backfillList(limit = 200) {
  const rules = (await approvedRules()).filter((rule) => rule.level === 'SELLER_CATEGORY' && rule.obligation !== 'OPTIONAL_QUALIFICATION');
  if (rules.length === 0) return [];
  const offers = await prisma.sellerOffer.findMany({
    where: { status: 'ACTIVE' },
    select: { sellerAccountId: true, product: { select: { categoryId: true, category: { select: { path: true, name: true } } } } },
    take: 5000,
  });
  const qualified = await prisma.complianceCase.findMany({
    where: { level: 'SELLER_CATEGORY', status: { in: ['QUALIFIED', 'REREVIEW_REQUIRED'] } },
    select: { sellerAccountId: true, categoryId: true },
  });
  const held = new Set(qualified.map((row) => `${row.sellerAccountId}:${row.categoryId}`));
  const found = new Map<string, { sellerAccountId: string; categoryId: string; categoryName: string; liveOffers: number }>();
  for (const offer of offers) {
    const category = offer.product.category;
    if (offer.product.categoryId === null || category === null) continue;
    const path = category.path.split('/').filter((part) => part.length > 0);
    const reached = rules.some((rule) => rule.categoryIds.some((id) => id === offer.product.categoryId || (rule.includeDescendants && path.includes(id))));
    if (!reached) continue;
    if (path.some((id) => held.has(`${offer.sellerAccountId}:${id}`)) || held.has(`${offer.sellerAccountId}:${offer.product.categoryId}`)) continue;
    const key = `${offer.sellerAccountId}:${offer.product.categoryId}`;
    const entry = found.get(key) ?? { sellerAccountId: offer.sellerAccountId, categoryId: offer.product.categoryId, categoryName: category.name, liveOffers: 0 };
    entry.liveOffers += 1;
    found.set(key, entry);
  }
  const sellers = await prisma.sellerAccount.findMany({ where: { id: { in: [...found.values()].map((entry) => entry.sellerAccountId) } }, select: { id: true, displayName: true } });
  const names = new Map(sellers.map((seller) => [seller.id, seller.displayName]));
  return [...found.values()].slice(0, limit).map((entry) => ({ ...entry, sellerName: names.get(entry.sellerAccountId) ?? '' }));
}
