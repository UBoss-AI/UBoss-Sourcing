/**
 * Platform-fee policies, the tax on the fee, and what each seller order
 * settles at.
 *
 * WHO MAY CHANGE ANY OF THIS. Only a member of staff holding
 * `finance.policy.write` (and `finance.tax.verify` to verify a tax rule). No
 * seller route reaches a writer in this file; the Seller Hub reads a
 * settlement preview and nothing else.
 *
 * VERSIONED, NEVER EDITED. A draft may be changed; a published policy may
 * not. Publishing a draft retires the version it replaces in the same
 * transaction, and a settlement names the version it was calculated on - so
 * a rate change in March leaves every February settlement exactly as it was.
 *
 * THE 15% IS DATA. The tax this deployment was asked to charge on the platform
 * fee is `taxRatePercent` on a policy row. It is not verified law: until a
 * person with finance authority marks the rule verified, every screen and
 * document calls it "Tax on platform fee - configured 15%", and nothing calls
 * it GST.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import {
  applyFeeRules,
  candidateScopeKeys,
  estimatedSettlement,
  isIndependentApprover,
  feeBasisFor,
  feeTaxWording,
  platformFeeOn,
  scopeKeyFor,
  taxOnPlatformFee,
  trimRate,
  type AppliedFeeRule,
  type FeeAdjustmentRule,
  type FeeRule,
  type PlatformFeeBasis,
  type PlatformFeeScope,
  type PlatformFeeType,
} from '../../domain/platform-fee.js';
import { AppError, ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { apportion, serialiseMoney, sumMinor, type Minor } from '../../domain/money.js';
import { Permission } from '../../domain/permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  AdminNotificationKind,
  ResolutionKey,
  createAdminNotification,
  resolveAdminNotifications,
} from '../notifications/admin-notification.service.js';
import { assertSellableCurrency, getBaseCurrency } from './currency.service.js';

type Tx = Prisma.TransactionClient;

export interface FinanceActor {
  userId: string | null;
  email: string | null;
  ipAddress?: string | null;
  correlationId?: string | null;
}

type PolicyRow = Prisma.PlatformFeePolicyGetPayload<Record<string, never>>;

export interface PolicyInput {
  scope: PlatformFeeScope;
  sellerAccountId?: string | null;
  categoryId?: string | null;
  marketCountry?: string | null;
  name: string;
  feeType: PlatformFeeType;
  feeBasis: PlatformFeeBasis;
  percentRate: string;
  flatFeeMinor?: string | null;
  minFeeMinor?: string | null;
  maxFeeMinor?: string | null;
  currency?: string | null;
  taxRatePercent: string;
  taxLabel?: string | null;
  taxJurisdiction?: string | null;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  notes?: string | null;
}

const RATE = /^\d{1,3}(\.\d{1,6})?$/;
const MINOR = /^\d{1,18}$/;

function parseMinor(value: string | null | undefined, field: string): bigint | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  if (!MINOR.test(value.trim())) {
    throw badRequest(ErrorCode.PLATFORM_FEE_POLICY_INVALID, 'Enter money as a whole number of the smallest currency unit.', [
      { field, code: 'MINOR_UNITS' },
    ]);
  }
  return BigInt(value.trim());
}

function parseRate(value: string, field: string): string {
  const trimmed = value.trim();
  if (!RATE.test(trimmed) || Number(trimmed) > 100) {
    throw badRequest(ErrorCode.PLATFORM_FEE_POLICY_INVALID, 'A rate is a percentage between 0 and 100, up to six decimals.', [
      { field, code: 'RATE' },
    ]);
  }
  return trimmed;
}

async function validated(input: PolicyInput) {
  const subject =
    input.scope === 'SELLER'
      ? (input.sellerAccountId ?? null)
      : input.scope === 'CATEGORY'
        ? (input.categoryId ?? null)
        : input.scope === 'MARKET'
          ? (input.marketCountry ?? null)
          : null;

  let scopeKey: string;
  try {
    scopeKey = scopeKeyFor(input.scope, subject);
  } catch {
    throw badRequest(ErrorCode.PLATFORM_FEE_POLICY_INVALID, `A ${input.scope.toLowerCase()} policy needs the thing it applies to.`, [
      { field: 'scope', code: 'SUBJECT_REQUIRED' },
    ]);
  }

  if (input.scope === 'SELLER') {
    const seller = await prisma.sellerAccount.findUnique({ where: { id: subject ?? '' }, select: { id: true } });
    if (seller === null) throw notFound('Seller');
  }
  if (input.scope === 'CATEGORY') {
    const category = await prisma.category.findUnique({ where: { id: subject ?? '' }, select: { id: true } });
    if (category === null) throw notFound('Category');
  }

  const percentRate = parseRate(input.percentRate, 'percentRate');
  const taxRatePercent = parseRate(input.taxRatePercent, 'taxRatePercent');
  const flatFeeMinor = parseMinor(input.flatFeeMinor, 'flatFeeMinor') ?? 0n;
  const minFeeMinor = parseMinor(input.minFeeMinor, 'minFeeMinor');
  const maxFeeMinor = parseMinor(input.maxFeeMinor, 'maxFeeMinor');

  // Zero percent is a legitimate "we charge nothing" policy and is accepted.
  if (input.feeType !== 'PERCENT' && flatFeeMinor === 0n) {
    throw badRequest(ErrorCode.PLATFORM_FEE_POLICY_INVALID, 'A flat fee needs an amount.', [
      { field: 'flatFeeMinor', code: 'REQUIRED' },
    ]);
  }
  if (minFeeMinor !== null && maxFeeMinor !== null && minFeeMinor > maxFeeMinor) {
    throw badRequest(ErrorCode.PLATFORM_FEE_POLICY_INVALID, 'The minimum fee is above the maximum.', [
      { field: 'minFeeMinor', code: 'RANGE' },
    ]);
  }
  if (input.effectiveTo !== undefined && input.effectiveTo !== null && input.effectiveFrom !== undefined && input.effectiveFrom !== null && input.effectiveTo <= input.effectiveFrom) {
    throw badRequest(ErrorCode.PLATFORM_FEE_POLICY_INVALID, 'A policy must end after it starts.', [
      { field: 'effectiveTo', code: 'RANGE' },
    ]);
  }

  const currency = await assertSellableCurrency(
    (input.currency ?? '').trim() === '' ? await getBaseCurrency() : (input.currency ?? '').trim().toUpperCase(),
  );

  return {
    scope: input.scope,
    scopeKey,
    sellerAccountId: input.scope === 'SELLER' ? subject : null,
    categoryId: input.scope === 'CATEGORY' ? subject : null,
    marketCountry: input.scope === 'MARKET' ? (subject ?? '').toUpperCase() : null,
    name: input.name.trim().slice(0, 160),
    feeType: input.feeType,
    feeBasis: input.feeBasis,
    percentRate: input.feeType === 'FLAT' ? '0' : percentRate,
    flatFeeMinor: input.feeType === 'PERCENT' ? 0n : flatFeeMinor,
    minFeeMinor,
    maxFeeMinor,
    currency,
    taxRatePercent,
    taxLabel: (input.taxLabel ?? '').trim() === '' ? 'Tax on platform fee' : (input.taxLabel ?? '').trim().slice(0, 64),
    taxJurisdiction: (input.taxJurisdiction ?? '').trim() === '' ? null : (input.taxJurisdiction ?? '').trim().toUpperCase(),
    effectiveFrom: input.effectiveFrom ?? new Date(),
    effectiveTo: input.effectiveTo ?? null,
    notes: (input.notes ?? '').trim() === '' ? null : (input.notes ?? '').trim().slice(0, 1024),
  };
}

export function toPolicyView(row: PolicyRow) {
  const wording = feeTaxWording({
    taxLabel: row.taxLabel,
    taxRatePercent: row.taxRatePercent.toString(),
    isTaxRuleVerified: row.isTaxRuleVerified,
  });
  return {
    id: row.id,
    scope: row.scope,
    scopeKey: row.scopeKey,
    sellerAccountId: row.sellerAccountId,
    categoryId: row.categoryId,
    marketCountry: row.marketCountry,
    versionNumber: row.versionNumber,
    status: row.status,
    name: row.name,
    feeType: row.feeType,
    feeBasis: row.feeBasis,
    percentRate: trimRate(row.percentRate.toString()),
    flatFee: serialiseMoney(row.flatFeeMinor, row.currency),
    minFee: row.minFeeMinor === null ? null : serialiseMoney(row.minFeeMinor, row.currency),
    maxFee: row.maxFeeMinor === null ? null : serialiseMoney(row.maxFeeMinor, row.currency),
    currency: row.currency,
    taxRatePercent: trimRate(row.taxRatePercent.toString()),
    taxLabel: row.taxLabel,
    taxDisplayLabel: wording.label,
    taxJurisdiction: row.taxJurisdiction,
    isTaxRuleVerified: row.isTaxRuleVerified,
    taxVerifiedAt: row.taxVerifiedAt?.toISOString() ?? null,
    taxVerificationNote: row.taxVerificationNote,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
    notes: row.notes,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    createdByUserId: row.createdByUserId,
    lastEditedByUserId: row.lastEditedByUserId,
    submittedByUserId: row.submittedByUserId,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    publishedByUserId: row.publishedByUserId,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    rejectionReason: row.rejectionReason,
  };
}

export type PlatformFeePolicyView = ReturnType<typeof toPolicyView>;

function auditShape(row: PolicyRow | null) {
  if (row === null) return null;
  return {
    scopeKey: row.scopeKey,
    versionNumber: row.versionNumber,
    status: row.status,
    feeType: row.feeType,
    feeBasis: row.feeBasis,
    percentRate: row.percentRate.toString(),
    flatFeeMinor: row.flatFeeMinor.toString(),
    minFeeMinor: row.minFeeMinor?.toString() ?? null,
    maxFeeMinor: row.maxFeeMinor?.toString() ?? null,
    currency: row.currency,
    taxRatePercent: row.taxRatePercent.toString(),
    taxLabel: row.taxLabel,
    isTaxRuleVerified: row.isTaxRuleVerified,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
  };
}

// --- Reading -----------------------------------------------------------------

export async function listPolicies(input: { status?: 'DRAFT' | 'PENDING_APPROVAL' | 'PUBLISHED' | 'RETIRED' | null } = {}) {
  const rows = await prisma.platformFeePolicy.findMany({
    where: input.status === undefined || input.status === null ? {} : { status: input.status },
    orderBy: [{ scopeKey: 'asc' }, { versionNumber: 'desc' }],
    take: 500,
  });
  const counts = await prisma.sellerOrderSettlement.groupBy({
    by: ['platformFeePolicyId'],
    where: { platformFeePolicyId: { in: rows.map((row) => row.id) } },
    _count: { _all: true },
  });
  const countById = new Map(counts.map((row) => [row.platformFeePolicyId, row._count._all]));
  return rows.map((row) => ({ ...toPolicyView(row), settlementCount: countById.get(row.id) ?? 0 }));
}

/** Which seller orders were settled on a policy version. */
export async function ordersUsingPolicy(policyId: string) {
  const policy = await prisma.platformFeePolicy.findUnique({ where: { id: policyId } });
  if (policy === null) throw notFound('Platform fee policy');

  const settlements = await prisma.sellerOrderSettlement.findMany({
    where: { platformFeePolicyId: policyId },
    orderBy: { computedAt: 'desc' },
    take: 200,
    include: {
      sellerOrderGroup: { select: { sellerOrderNumber: true, orderId: true, order: { select: { orderNumber: true } } } },
      sellerAccount: { select: { displayName: true } },
    },
  });

  return {
    policy: toPolicyView(policy),
    orders: settlements.map((row) => ({
      sellerOrderGroupId: row.sellerOrderGroupId,
      sellerOrderNumber: row.sellerOrderGroup.sellerOrderNumber,
      orderId: row.sellerOrderGroup.orderId,
      orderNumber: row.sellerOrderGroup.order.orderNumber,
      sellerName: row.sellerAccount.displayName,
      platformFee: serialiseMoney(row.platformFeeMinor, row.currency),
      platformFeeTax: serialiseMoney(row.platformFeeTaxMinor, row.currency),
      computedAt: row.computedAt.toISOString(),
    })),
  };
}

// --- Writing (finance only) --------------------------------------------------

export async function createDraftPolicy(actor: FinanceActor, input: PolicyInput) {
  const data = await validated(input);

  const latest = await prisma.platformFeePolicy.findFirst({
    where: { scopeKey: data.scopeKey },
    orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true },
  });

  const row = await prisma.platformFeePolicy.create({
    data: {
      ...data,
      id: newId(),
      versionNumber: (latest?.versionNumber ?? 0) + 1,
      status: 'DRAFT',
      createdByUserId: actor.userId,
      lastEditedByUserId: actor.userId,
    },
  });

  await recordAudit({
    action: AuditAction.PLATFORM_FEE_POLICY_SAVED,
    resourceType: 'platform_fee_policy',
    resourceId: row.id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: null,
    after: auditShape(row),
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });
  return toPolicyView(row);
}

export async function updateDraftPolicy(actor: FinanceActor, policyId: string, input: PolicyInput) {
  const before = await prisma.platformFeePolicy.findUnique({ where: { id: policyId } });
  if (before === null) throw notFound('Platform fee policy');
  if (before.status !== 'DRAFT') {
    throw conflict(
      ErrorCode.PLATFORM_FEE_POLICY_NOT_EDITABLE,
      'A published or retired policy is never changed. Create a new version instead.',
    );
  }

  const data = await validated(input);
  if (data.scopeKey !== before.scopeKey) {
    throw badRequest(ErrorCode.PLATFORM_FEE_POLICY_INVALID, 'A draft cannot move to a different scope.', [
      { field: 'scope', code: 'IMMUTABLE' },
    ]);
  }

  const row = await prisma.platformFeePolicy.update({
    where: { id: policyId },
    data: { ...data, lastEditedByUserId: actor.userId },
  });
  await recordAudit({
    action: AuditAction.PLATFORM_FEE_POLICY_SAVED,
    resourceType: 'platform_fee_policy',
    resourceId: row.id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: auditShape(before),
    after: auditShape(row),
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });
  return toPolicyView(row);
}

/**
 * Publish a draft as the live policy for its scope.
 *
 * The version it replaces is retired in the same transaction, under the
 * `uq_platform_fee_active` idiom: two finance staff publishing two drafts for
 * the same scope at once collide in the database rather than leaving two live
 * policies.
 */
export async function publishPolicy(actor: FinanceActor, policyId: string) {
  const draft = await prisma.platformFeePolicy.findUnique({ where: { id: policyId } });
  if (draft === null) throw notFound('Platform fee policy');
  if (draft.status === 'PUBLISHED') return toPolicyView(draft);
  if (draft.status === 'RETIRED') {
    throw conflict(ErrorCode.PLATFORM_FEE_POLICY_NOT_EDITABLE, 'A retired policy cannot be published again. Create a new version.');
  }
  // Maker-checker: a draft is submitted by its maker and approved by somebody
  // else. Publishing IS the approval.
  if (draft.status !== 'PENDING_APPROVAL') throw notPendingApproval(draft.status);
  assertIndependentApprover(actor, draft);

  const now = new Date();
  // No retroactive surprise: a policy approved after the date it was drafted
  // to start from starts now. Orders confirmed before this instant were
  // settled on the version in force then, and stay so.
  const effectiveFrom = draft.effectiveFrom < now ? now : draft.effectiveFrom;
  const { published, retired } = await prisma.$transaction(async (tx) => {
    const current = await tx.platformFeePolicy.findFirst({ where: { activeScopeKey: draft.scopeKey } });
    if (current !== null) {
      await tx.platformFeePolicy.update({
        where: { id: current.id },
        data: {
          status: 'RETIRED',
          activeScopeKey: null,
          retiredAt: now,
          effectiveTo: current.effectiveTo ?? now,
        },
      });
    }
    // Conditional on the status read above, so two approvers pressing at once
    // publish it once.
    const claimed = await tx.platformFeePolicy.updateMany({
      where: { id: draft.id, status: 'PENDING_APPROVAL' },
      data: {
        status: 'PUBLISHED',
        activeScopeKey: draft.scopeKey,
        publishedAt: now,
        publishedByUserId: actor.userId,
        effectiveFrom,
      },
    });
    if (claimed.count === 0) throw notPendingApproval('PUBLISHED');
    const row = await tx.platformFeePolicy.findUniqueOrThrow({ where: { id: draft.id } });
    return { published: row, retired: current };
  });

  await recordAudit({
    action: AuditAction.PLATFORM_FEE_POLICY_PUBLISHED,
    resourceType: 'platform_fee_policy',
    resourceId: published.id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: auditShape(retired),
    after: auditShape(published),
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  if (retired !== null) {
    await resolveAdminNotifications({
      resolutionKey: ResolutionKey.feeTaxVerification(retired.id),
      reason: 'The policy was replaced by a new version.',
      source: 'SUPERSEDED',
    });
  }

  if (!published.isTaxRuleVerified && published.taxRatePercent.toString() !== '0') {
    await createAdminNotification({
      kind: AdminNotificationKind.PLATFORM_FEE_TAX_UNVERIFIED,
      variables: { policyName: published.name, taxRate: trimRate(published.taxRatePercent.toString()) },
      linkPath: '/finance/platform-fees',
      requiredPermission: Permission.FINANCE_POLICY_READ,
      relatedType: 'platform_fee_policy',
      relatedId: published.id,
      dedupeKey: `fee-tax-unverified:${published.id}`,
      resolutionKey: ResolutionKey.feeTaxVerification(published.id),
    });
  }

  return toPolicyView(published);
}

/** "It is not waiting for approval": said with where it actually is. */
export function notPendingApproval(status: string): AppError {
  return conflict(
    ErrorCode.PLATFORM_FEE_NOT_PENDING_APPROVAL,
    status === 'DRAFT'
      ? 'Submit this draft for approval first.'
      : 'Only a submitted draft can be approved or rejected.',
    [{ field: 'status', code: 'STATUS', meta: { status } }],
  );
}

/** Refuse the maker approving their own work. */
export function assertIndependentApprover(
  actor: FinanceActor,
  makers: { createdByUserId: string | null; lastEditedByUserId: string | null; submittedByUserId: string | null },
): void {
  if (!isIndependentApprover(actor.userId, makers)) {
    throw new AppError({
      statusCode: 403,
      code: ErrorCode.PLATFORM_FEE_SELF_APPROVAL_FORBIDDEN,
      message: 'A different member of finance staff must approve this. You created, edited or submitted it.',
    });
  }
}

export function assertRejectionReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < 10) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say why it is being sent back, in at least ten characters.', [
      { field: 'reason', code: 'REQUIRED' },
    ]);
  }
  return trimmed.slice(0, 1000);
}

/** Send a draft for a second person's approval. Only the draft's own state changes. */
export async function submitPolicy(actor: FinanceActor, policyId: string) {
  const before = await prisma.platformFeePolicy.findUnique({ where: { id: policyId } });
  if (before === null) throw notFound('Platform fee policy');
  if (before.status === 'PENDING_APPROVAL') return toPolicyView(before);
  if (before.status !== 'DRAFT') throw notPendingApproval(before.status);

  const claimed = await prisma.platformFeePolicy.updateMany({
    where: { id: policyId, status: 'DRAFT' },
    data: { status: 'PENDING_APPROVAL', submittedByUserId: actor.userId, submittedAt: new Date() },
  });
  if (claimed.count === 0) throw notPendingApproval('UNKNOWN');
  const row = await prisma.platformFeePolicy.findUniqueOrThrow({ where: { id: policyId } });
  await recordAudit({
    action: AuditAction.PLATFORM_FEE_POLICY_SUBMITTED,
    resourceType: 'platform_fee_policy',
    resourceId: row.id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: auditShape(before),
    after: auditShape(row),
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });
  return toPolicyView(row);
}

/** Send a submitted draft back to DRAFT with a reason. Anybody with the permission. */
export async function rejectPolicy(actor: FinanceActor, policyId: string, input: { reason: string }) {
  const reason = assertRejectionReason(input.reason);
  const before = await prisma.platformFeePolicy.findUnique({ where: { id: policyId } });
  if (before === null) throw notFound('Platform fee policy');
  if (before.status !== 'PENDING_APPROVAL') throw notPendingApproval(before.status);

  const claimed = await prisma.platformFeePolicy.updateMany({
    where: { id: policyId, status: 'PENDING_APPROVAL' },
    data: {
      status: 'DRAFT',
      rejectedByUserId: actor.userId,
      rejectedAt: new Date(),
      rejectionReason: reason,
      submittedByUserId: null,
      submittedAt: null,
    },
  });
  if (claimed.count === 0) throw notPendingApproval('UNKNOWN');
  const row = await prisma.platformFeePolicy.findUniqueOrThrow({ where: { id: policyId } });
  await recordAudit({
    action: AuditAction.PLATFORM_FEE_POLICY_REJECTED,
    resourceType: 'platform_fee_policy',
    resourceId: row.id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: auditShape(before),
    after: { ...auditShape(row), reason },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });
  return toPolicyView(row);
}

export async function retirePolicy(actor: FinanceActor, policyId: string) {
  const before = await prisma.platformFeePolicy.findUnique({ where: { id: policyId } });
  if (before === null) throw notFound('Platform fee policy');
  if (before.status === 'RETIRED') return toPolicyView(before);

  const row = await prisma.platformFeePolicy.update({
    where: { id: policyId },
    data: { status: 'RETIRED', activeScopeKey: null, retiredAt: new Date(), effectiveTo: before.effectiveTo ?? new Date() },
  });
  await recordAudit({
    action: AuditAction.PLATFORM_FEE_POLICY_RETIRED,
    resourceType: 'platform_fee_policy',
    resourceId: row.id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: auditShape(before),
    after: auditShape(row),
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });
  await resolveAdminNotifications({
    resolutionKey: ResolutionKey.feeTaxVerification(row.id),
    reason: 'The policy was retired.',
    source: 'DOMAIN_EVENT',
    resolvedByUserId: actor.userId,
  });
  return toPolicyView(row);
}

/**
 * Record that the tax rule on a policy is the legally correct one.
 *
 * A legal statement by a named person, with their note, audited. It changes
 * no figure - the rate is what it was - only whether documents may call it
 * by the name the verifier confirmed (e.g. GST). It may be set on a published
 * policy: verifying the rule that is already live is the ordinary case.
 */
export async function verifyTaxRule(actor: FinanceActor, policyId: string, input: { note: string }) {
  const before = await prisma.platformFeePolicy.findUnique({ where: { id: policyId } });
  if (before === null) throw notFound('Platform fee policy');
  if (before.status === 'RETIRED') {
    throw conflict(ErrorCode.PLATFORM_FEE_POLICY_NOT_EDITABLE, 'A retired policy cannot be verified.');
  }
  if (before.isTaxRuleVerified) return toPolicyView(before);

  const row = await prisma.platformFeePolicy.update({
    where: { id: policyId },
    data: {
      isTaxRuleVerified: true,
      taxVerifiedAt: new Date(),
      taxVerifiedByUserId: actor.userId,
      taxVerificationNote: input.note.trim().slice(0, 512),
    },
  });
  await recordAudit({
    action: AuditAction.PLATFORM_FEE_TAX_VERIFIED,
    resourceType: 'platform_fee_policy',
    resourceId: row.id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: auditShape(before),
    after: { ...auditShape(row), note: row.taxVerificationNote },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });
  await resolveAdminNotifications({
    resolutionKey: ResolutionKey.feeTaxVerification(row.id),
    reason: 'The tax rule was verified.',
    source: 'DOMAIN_EVENT',
    resolvedByUserId: actor.userId,
  });
  return toPolicyView(row);
}

// --- Calculating a settlement --------------------------------------------------

export interface SettlementLine {
  orderItemId?: string;
  categoryId: string | null;
  /** The seller's goods on this line, after discount, before tax. */
  goodsMinor: Minor;
}

interface ResolvedRule {
  key: string;
  policy: PolicyRow | null;
  rule: FeeRule;
  /** Where the fee rate came from, for the breakdown. */
  source: 'POLICY' | 'SELLER_NEGOTIATED' | 'LEGACY_PLATFORM_RATE';
}

export interface SettlementCalculation {
  currency: string;
  grossProceedsMinor: Minor;
  sellerDeliveryProceedsMinor: Minor;
  ubossDeliveryMinor: Minor;
  feeBasisMinor: Minor;
  platformFeeMinor: Minor;
  platformFeeTaxMinor: Minor;
  refundsAdjustmentsMinor: Minor;
  estimatedSettlementMinor: Minor;
  primaryPolicy: PolicyRow | null;
  feeTaxRatePercent: string;
  feeTaxLabel: string;
  feeTaxVerified: boolean;
  /** Per-line fee, positionally aligned with the input lines. */
  lineFeesMinor: Minor[];
  basisPointsApplied: number;
  breakdown: {
    key: string;
    source: ResolvedRule['source'];
    policyId: string | null;
    policyVersion: number | null;
    feeType: PlatformFeeType;
    feeBasis: PlatformFeeBasis;
    percentRate: string;
    basisMinor: string;
    feeMinor: string;
    taxRatePercent: string;
    taxMinor: string;
    note: string | null;
    /** What the policy alone would have charged, before any fee rule. */
    baseFeeMinor?: string;
    /** The fee rules that changed this fee, in the order they applied. */
    rulesApplied?: { ruleId: string; kind: AppliedFeeRule['kind']; name: string; percent: string; effectMinor: string }[];
  }[];
  /** One row per fee rule that changed the fee, summed over the groups. */
  ruleApplications: { ruleId: string; kind: AppliedFeeRule['kind']; effectMinor: Minor }[];
}

type FeeRuleRow = Prisma.PlatformFeeRuleGetPayload<Record<string, never>>;

/** The row as the pure rule engine reads it. */
export function feeRuleOf(row: FeeRuleRow): FeeAdjustmentRule {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    scopeKey: row.scopeKey,
    currency: row.currency,
    minValueMinor: row.minValueMinor,
    maxValueMinor: row.maxValueMinor,
    volumeThresholdMinor: row.volumeThresholdMinor,
    volumeWindowDays: row.volumeWindowDays,
    sellerTier: row.sellerTier,
    percentRate: row.percentRate?.toString() ?? null,
    discountPercent: row.discountPercent?.toString() ?? null,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  };
}

/** Published fee rules live at `at` for any of these scope keys. */
async function liveFeeRules(client: Tx | typeof prisma, keys: readonly string[], at: Date): Promise<FeeAdjustmentRule[]> {
  const rows = await client.platformFeeRule.findMany({
    where: {
      status: 'PUBLISHED',
      scopeKey: { in: [...new Set(keys)] },
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
  });
  return rows.map(feeRuleOf);
}

/**
 * The seller's goods sold, in one currency, over each trailing window.
 *
 * Read from the settlements already calculated - the same figure the seller's
 * statements are made of - over [at - window, at). The order being settled is
 * not in it yet, so a seller crosses a threshold on the order AFTER the one
 * that took them over it, never retroactively on earlier ones.
 */
async function trailingVolumes(
  client: Tx | typeof prisma,
  input: { sellerAccountId: string; currency: string; at: Date; windows: readonly number[] },
): Promise<Map<number, Minor>> {
  const result = new Map<number, Minor>();
  for (const days of new Set(input.windows)) {
    const since = new Date(input.at.getTime() - days * 86_400_000);
    const sum = await client.sellerOrderSettlement.aggregate({
      where: {
        sellerAccountId: input.sellerAccountId,
        currency: input.currency,
        computedAt: { gte: since, lt: input.at },
      },
      _sum: { grossProceedsMinor: true },
    });
    result.set(days, sum._sum.grossProceedsMinor ?? 0n);
  }
  return result;
}

async function livePolicies(client: Tx | typeof prisma, keys: readonly string[], at: Date): Promise<Map<string, PolicyRow>> {
  const rows = await client.platformFeePolicy.findMany({
    where: {
      activeScopeKey: { in: [...new Set(keys)] },
      status: 'PUBLISHED',
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
  });
  return new Map(rows.map((row) => [row.scopeKey, row]));
}

function ruleOf(row: PolicyRow): FeeRule {
  return {
    feeType: row.feeType,
    feeBasis: row.feeBasis,
    percentRate: row.percentRate.toString(),
    flatFeeMinor: row.flatFeeMinor,
    minFeeMinor: row.minFeeMinor,
    maxFeeMinor: row.maxFeeMinor,
    taxRatePercent: row.taxRatePercent.toString(),
  };
}

function basisPointsToPercent(bp: number): string {
  const clamped = Math.max(0, Math.min(10_000, Math.trunc(bp)));
  return `${String(Math.trunc(clamped / 100))}.${String(clamped % 100).padStart(2, '0')}`;
}

/**
 * What a seller is owed for their part of an order.
 *
 * Per line, the most specific policy wins: the seller's own, then the line's
 * category, then the buyer's market, then the platform's. A seller with a
 * NEGOTIATED rate (`SellerAccount.commissionBasisPoints`) and no seller-scope
 * policy keeps that rate; the tax on it follows whichever policy applies.
 * Where no policy applies at all the platform's legacy commission rate is used
 * with no tax - exactly what the order split charged before policies existed.
 *
 * A flat fee, minimum and maximum apply once per policy per order, and only
 * when the policy is in the order's currency; in another currency they are
 * left out and the breakdown says so, rather than charging a converted figure
 * nobody configured.
 */
export async function calculateSettlement(
  client: Tx | typeof prisma,
  input: {
    sellerAccountId: string;
    currency: string;
    marketCountry: string | null;
    lines: readonly SettlementLine[];
    sellerDeliveryMinor: Minor;
    ubossDeliveryMinor: Minor;
    refundsAdjustmentsMinor?: Minor;
    at?: Date;
  },
): Promise<SettlementCalculation> {
  const at = input.at ?? new Date();

  const seller = await client.sellerAccount.findUnique({
    where: { id: input.sellerAccountId },
    select: { commissionBasisPoints: true, feeTier: true },
  });
  const platform = await client.businessProfile.findFirst({ select: { sellerCommissionBasisPoints: true } });
  const negotiatedBp = seller?.commissionBasisPoints ?? null;
  const legacyBp = negotiatedBp ?? platform?.sellerCommissionBasisPoints ?? 0;

  const keysPerLine = input.lines.map((line) =>
    candidateScopeKeys({
      sellerAccountId: input.sellerAccountId,
      categoryId: line.categoryId,
      marketCountry: input.marketCountry,
    }),
  );
  const policies = await livePolicies(client, keysPerLine.flat(), at);
  const feeRules = await liveFeeRules(client, keysPerLine.flat(), at);
  const volumes =
    feeRules.some((rule) => rule.kind === 'VOLUME_TIER')
      ? await trailingVolumes(client, {
          sellerAccountId: input.sellerAccountId,
          currency: input.currency,
          at,
          windows: feeRules.flatMap((rule) => (rule.kind === 'VOLUME_TIER' && rule.volumeWindowDays !== null ? [rule.volumeWindowDays] : [])),
        })
      : new Map<number, Minor>();
  const ruleEffects = new Map<string, { kind: AppliedFeeRule['kind']; effectMinor: Minor }>();

  const resolvedPerLine: ResolvedRule[] = keysPerLine.map((keys) => {
    const hit = keys.map((key) => policies.get(key)).find((row) => row !== undefined) ?? null;

    if (hit !== null && (hit.scope === 'SELLER' || negotiatedBp === null)) {
      return { key: `policy:${hit.id}`, policy: hit, rule: ruleOf(hit), source: 'POLICY' };
    }
    if (negotiatedBp !== null) {
      // The seller's negotiated percentage, taxed as the policy in force says.
      return {
        key: `negotiated:${hit?.id ?? 'none'}`,
        policy: hit,
        rule: {
          feeType: 'PERCENT',
          feeBasis: hit?.feeBasis ?? 'PRODUCT_SUBTOTAL',
          percentRate: basisPointsToPercent(negotiatedBp),
          flatFeeMinor: 0n,
          minFeeMinor: null,
          maxFeeMinor: null,
          taxRatePercent: hit?.taxRatePercent.toString() ?? '0',
        },
        source: 'SELLER_NEGOTIATED',
      };
    }
    return {
      key: 'legacy',
      policy: null,
      rule: {
        feeType: 'PERCENT',
        feeBasis: 'PRODUCT_SUBTOTAL',
        percentRate: basisPointsToPercent(legacyBp),
        flatFeeMinor: 0n,
        minFeeMinor: null,
        maxFeeMinor: null,
        taxRatePercent: '0',
      },
      source: 'LEGACY_PLATFORM_RATE',
    };
  });

  // Lines grouped by the rule that applies to them.
  const groups = new Map<string, { resolved: ResolvedRule; indexes: number[]; goodsMinor: Minor }>();
  resolvedPerLine.forEach((resolved, index) => {
    const entry = groups.get(resolved.key) ?? { resolved, indexes: [], goodsMinor: 0n };
    entry.indexes.push(index);
    entry.goodsMinor += input.lines[index]?.goodsMinor ?? 0n;
    groups.set(resolved.key, entry);
  });

  // The seller's own delivery money, where a basis includes it, is added to the
  // group holding most of the goods - once, never to every group.
  const primaryKey = [...groups.entries()].sort((a, b) => (b[1].goodsMinor > a[1].goodsMinor ? 1 : b[1].goodsMinor < a[1].goodsMinor ? -1 : 0))[0]?.[0] ?? null;

  const lineFeesMinor: Minor[] = input.lines.map(() => 0n);
  const breakdown: SettlementCalculation['breakdown'] = [];
  let feeBasisMinor = 0n;
  let platformFeeMinor = 0n;
  let platformFeeTaxMinor = 0n;

  for (const [key, group] of groups) {
    const policyCurrencyMatches = group.resolved.policy === null || group.resolved.policy.currency === input.currency;
    const rule: FeeRule = policyCurrencyMatches
      ? group.resolved.rule
      : { ...group.resolved.rule, flatFeeMinor: 0n, minFeeMinor: null, maxFeeMinor: null, feeType: group.resolved.rule.feeType === 'FLAT' ? 'PERCENT' : group.resolved.rule.feeType };

    const basis = feeBasisFor(rule.feeBasis, {
      goodsMinor: group.goodsMinor,
      sellerDeliveryMinor: key === primaryKey ? input.sellerDeliveryMinor : 0n,
    });
    let fee: Minor;
    let applied: AppliedFeeRule[] = [];
    let baseFee: Minor | null = null;
    if (group.resolved.source === 'POLICY') {
      /*
       * Fee rules adjust a PUBLISHED POLICY's fee. A group matches a rule only
       * on the scope keys ALL its lines share, so a category rule never
       * reaches a line from another category that happens to share the policy.
       * A seller's negotiated rate and the legacy platform rate are contracts
       * and defaults respectively, and are left exactly as they were.
       */
      const sharedKeys = group.indexes
        .map((index) => keysPerLine[index] ?? [])
        .reduce<string[]>((shared, keys, position) => (position === 0 ? [...keys] : shared.filter((key) => keys.includes(key))), []);
      const outcome = applyFeeRules(rule, feeRules, {
        scopeKeys: sharedKeys,
        currency: input.currency,
        basisMinor: basis,
        volumeByWindowDays: volumes,
        sellerTier: seller?.feeTier ?? null,
        at,
      });
      fee = outcome.feeMinor;
      applied = outcome.applied;
      baseFee = outcome.baseFeeMinor;
      for (const entry of applied) {
        const current = ruleEffects.get(entry.ruleId) ?? { kind: entry.kind, effectMinor: 0n };
        current.effectMinor += entry.effectMinor;
        ruleEffects.set(entry.ruleId, current);
      }
      // Spread over the lines by value so each line's share adds up exactly.
      const shares = apportion(fee, group.indexes.map((index) => input.lines[index]?.goodsMinor ?? 0n));
      group.indexes.forEach((lineIndex, position) => {
        lineFeesMinor[lineIndex] = shares[position] ?? 0n;
      });
    } else {
      // A plain commission rate is rounded PER LINE, exactly as the order
      // split always did, so a deployment with no fee policy settles to the
      // paisa what it settled before policies existed.
      fee = 0n;
      for (const lineIndex of group.indexes) {
        const lineFee = platformFeeOn(rule, input.lines[lineIndex]?.goodsMinor ?? 0n);
        lineFeesMinor[lineIndex] = lineFee;
        fee += lineFee;
      }
      /*
       * The delivery part of the basis is charged at the same rate.
       *
       * A negotiated rate keeps the basis of the policy it stands in for, and
       * `basis` above already includes the seller's own delivery when that
       * basis says so. Charging only the goods would store one basis and
       * charge on another - a settlement nobody could recompute from its own
       * figures. The delivery fee is spread over the lines by value, so the
       * line fees still add up to the fee exactly.
       */
      const deliveryInBasis = basis - group.goodsMinor;
      if (deliveryInBasis > 0n) {
        const deliveryFee = platformFeeOn(rule, deliveryInBasis);
        const shares = apportion(deliveryFee, group.indexes.map((index) => input.lines[index]?.goodsMinor ?? 0n));
        group.indexes.forEach((lineIndex, position) => {
          lineFeesMinor[lineIndex] = (lineFeesMinor[lineIndex] ?? 0n) + (shares[position] ?? 0n);
        });
        fee += deliveryFee;
      }
    }
    const tax = taxOnPlatformFee(fee, rule.taxRatePercent);

    feeBasisMinor += basis;
    platformFeeMinor += fee;
    platformFeeTaxMinor += tax;
    breakdown.push({
      key,
      source: group.resolved.source,
      policyId: group.resolved.policy?.id ?? null,
      policyVersion: group.resolved.policy?.versionNumber ?? null,
      feeType: rule.feeType,
      feeBasis: rule.feeBasis,
      percentRate: rule.percentRate,
      basisMinor: basis.toString(),
      feeMinor: fee.toString(),
      taxRatePercent: rule.taxRatePercent,
      taxMinor: tax.toString(),
      note: policyCurrencyMatches ? null : `Flat, minimum and maximum amounts are in ${group.resolved.policy?.currency ?? ''} and were not applied to an order in ${input.currency}.`,
      ...(baseFee !== null ? { baseFeeMinor: baseFee.toString() } : {}),
      ...(applied.length > 0
        ? {
            rulesApplied: applied.map((entry) => ({
              ruleId: entry.ruleId,
              kind: entry.kind,
              name: entry.name,
              percent: trimRate(entry.percent),
              effectMinor: entry.effectMinor.toString(),
            })),
          }
        : {}),
    });
  }

  const primary = primaryKey === null ? null : (groups.get(primaryKey)?.resolved ?? null);
  const primaryPolicy = primary?.policy ?? null;
  const taxRate = primary?.rule.taxRatePercent ?? '0';
  const allVerified = [...groups.values()].every((group) => group.resolved.policy?.isTaxRuleVerified === true);
  const wording = feeTaxWording({
    taxLabel: primaryPolicy?.taxLabel ?? 'Tax on platform fee',
    taxRatePercent: taxRate,
    isTaxRuleVerified: allVerified,
  });

  const grossProceedsMinor = sumMinor(input.lines.map((line) => line.goodsMinor));
  const refunds = input.refundsAdjustmentsMinor ?? 0n;

  return {
    currency: input.currency,
    grossProceedsMinor,
    sellerDeliveryProceedsMinor: input.sellerDeliveryMinor,
    ubossDeliveryMinor: input.ubossDeliveryMinor,
    feeBasisMinor,
    platformFeeMinor,
    platformFeeTaxMinor,
    refundsAdjustmentsMinor: refunds,
    estimatedSettlementMinor: estimatedSettlement({
      goodsMinor: grossProceedsMinor,
      sellerDeliveryMinor: input.sellerDeliveryMinor,
      platformFeeMinor,
      platformFeeTaxMinor,
      refundsAdjustmentsMinor: refunds,
    }),
    primaryPolicy,
    feeTaxRatePercent: taxRate,
    feeTaxLabel: wording.label,
    feeTaxVerified: wording.verified,
    lineFeesMinor,
    basisPointsApplied:
      primary !== null && primary.rule.feeType === 'PERCENT'
        ? Math.round(Number(primary.rule.percentRate) * 100)
        : 0,
    breakdown,
    ruleApplications: [...ruleEffects].map(([ruleId, entry]) => ({ ruleId, ...entry })),
  };
}

/** The settlement for the wire. */
export function serialiseSettlement(calc: {
  currency: string;
  grossProceedsMinor: Minor;
  sellerDeliveryProceedsMinor: Minor;
  ubossDeliveryMinor: Minor;
  feeBasisMinor: Minor;
  platformFeeMinor: Minor;
  platformFeeTaxMinor: Minor;
  refundsAdjustmentsMinor: Minor;
  estimatedSettlementMinor: Minor;
  feeTaxLabel: string;
  feeTaxVerified: boolean;
  feeTaxRatePercent: string;
}) {
  const money = (amount: Minor) => serialiseMoney(amount, calc.currency);
  return {
    currency: calc.currency,
    grossProceeds: money(calc.grossProceedsMinor),
    sellerDeliveryProceeds: money(calc.sellerDeliveryProceedsMinor),
    ubossDelivery: money(calc.ubossDeliveryMinor),
    feeBasis: money(calc.feeBasisMinor),
    platformFee: money(calc.platformFeeMinor),
    platformFeeTax: money(calc.platformFeeTaxMinor),
    refundsAdjustments: money(calc.refundsAdjustmentsMinor),
    estimatedSettlement: money(calc.estimatedSettlementMinor),
    feeTaxLabel: calc.feeTaxLabel,
    feeTaxVerified: calc.feeTaxVerified,
    feeTaxRatePercent: trimRate(calc.feeTaxRatePercent),
  };
}

/**
 * The Seller Hub's read-only settlement preview.
 *
 * "If you sold this much, with this much of your own delivery, this is what
 * you would be paid" - worked out by the same calculation a real order uses,
 * on the policies in force now. Read-only: nothing here can change a fee.
 *
 * The policy is resolved the way a real order resolves it: the buyer's market
 * (`marketCountry`, the country an order ships to) and the category of the
 * goods. The category comes from one of the seller's own listings
 * (`offerId`) - never a listing of somebody else's - or, for staff, directly
 * as `categoryId`. Without them, market- and category-scoped policies cannot
 * match, exactly as they could not match an order with no market or category.
 */
export async function previewSettlement(input: {
  sellerAccountId: string;
  goodsMinor: Minor;
  sellerDeliveryMinor: Minor;
  currency?: string | null;
  marketCountry?: string | null;
  offerId?: string | null;
  categoryId?: string | null;
}) {
  const currency = await assertSellableCurrency(
    (input.currency ?? '').trim() === '' ? await getBaseCurrency() : (input.currency ?? '').trim().toUpperCase(),
  );
  let categoryId = (input.categoryId ?? '').trim() === '' ? null : (input.categoryId ?? '').trim();
  if ((input.offerId ?? '') !== '') {
    const offer = await prisma.sellerOffer.findFirst({
      where: { id: input.offerId ?? '', sellerAccountId: input.sellerAccountId },
      select: { product: { select: { categoryId: true } } },
    });
    if (offer === null) throw notFound('Listing');
    categoryId = offer.product.categoryId;
  }
  const market = (input.marketCountry ?? '').trim() === '' ? null : (input.marketCountry ?? '').trim().toUpperCase();
  const calc = await calculateSettlement(prisma, {
    sellerAccountId: input.sellerAccountId,
    currency,
    marketCountry: market,
    lines: [{ categoryId, goodsMinor: input.goodsMinor }],
    sellerDeliveryMinor: input.sellerDeliveryMinor,
    ubossDeliveryMinor: 0n,
  });
  return {
    ...serialiseSettlement(calc),
    policy: calc.primaryPolicy === null ? null : toPolicyView(calc.primaryPolicy),
    breakdown: calc.breakdown,
  };
}

/** The settlements already calculated for a seller's orders, newest first. */
export async function listSellerSettlements(sellerAccountId: string, limit = 50) {
  const rows = await prisma.sellerOrderSettlement.findMany({
    where: { sellerAccountId },
    orderBy: { computedAt: 'desc' },
    take: Math.min(limit, 200),
    include: { sellerOrderGroup: { select: { sellerOrderNumber: true, status: true } } },
  });
  return rows.map((row) => ({
    sellerOrderGroupId: row.sellerOrderGroupId,
    sellerOrderNumber: row.sellerOrderGroup.sellerOrderNumber,
    status: row.sellerOrderGroup.status,
    policyVersion: row.platformFeePolicyVersion,
    computedAt: row.computedAt.toISOString(),
    ...serialiseSettlement({
      currency: row.currency,
      grossProceedsMinor: row.grossProceedsMinor,
      sellerDeliveryProceedsMinor: row.sellerDeliveryProceedsMinor,
      ubossDeliveryMinor: row.ubossDeliveryMinor,
      feeBasisMinor: row.feeBasisMinor,
      platformFeeMinor: row.platformFeeMinor,
      platformFeeTaxMinor: row.platformFeeTaxMinor,
      refundsAdjustmentsMinor: row.refundsAdjustmentsMinor,
      estimatedSettlementMinor: row.estimatedSettlementMinor,
      feeTaxLabel: row.feeTaxLabel,
      feeTaxVerified: row.feeTaxVerified,
      feeTaxRatePercent: row.feeTaxRatePercent.toString(),
    }),
  }));
}
