/**
 * Fee rules: value bands, volume tiers, seller tiers and promotions, on top of
 * the platform-fee policy. Finance only (`finance.policy.write`).
 *
 * The arithmetic is not here. It is `applyFeeRules` in `domain/platform-fee.ts`,
 * called by `calculateSettlement` - the one place a seller order's fee is
 * worked out, once, when the order is confirmed (`order-split.service.ts`).
 * This file keeps the rules themselves honest:
 *
 *   - MAKER-CHECKER. A rule is drafted, submitted, and approved by somebody
 *     who did not create, edit or submit it. Rejection needs a reason and
 *     sends it back to DRAFT.
 *   - NEVER EDITED ONCE LIVE. A published rule is changed by drafting a new
 *     one that supersedes it; approving the new one retires the old one in
 *     the same transaction.
 *   - NO RETROACTIVE SURPRISE. A rule applies only to orders confirmed inside
 *     [effectiveFrom, effectiveTo). Approval moves a past effectiveFrom up to
 *     the approval instant, and a settlement already calculated is never
 *     recalculated, so no rule ever reaches an order it was not live for.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { normaliseTier, scopeKeyFor, trimRate, type FeeRuleKind, type PlatformFeeScope } from '../../domain/platform-fee.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { assertSellableCurrency } from './currency.service.js';
import {
  assertIndependentApprover,
  assertRejectionReason,
  notPendingApproval,
  type FinanceActor,
} from './platform-fee.service.js';

type RuleRow = Prisma.PlatformFeeRuleGetPayload<Record<string, never>>;

export interface FeeRuleInput {
  kind: FeeRuleKind;
  scope: PlatformFeeScope;
  sellerAccountId?: string | null;
  categoryId?: string | null;
  marketCountry?: string | null;
  name: string;
  currency?: string | null;
  minValueMinor?: string | null;
  maxValueMinor?: string | null;
  volumeThresholdMinor?: string | null;
  volumeWindowDays?: number | null;
  sellerTier?: string | null;
  percentRate?: string | null;
  discountPercent?: string | null;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  notes?: string | null;
  supersedesRuleId?: string | null;
}

const RATE = /^\d{1,3}(\.\d{1,6})?$/;
const MINOR = /^\d{1,18}$/;

function invalid(field: string, code: string, message: string) {
  return badRequest(ErrorCode.PLATFORM_FEE_RULE_INVALID, message, [{ field, code }]);
}

function minor(value: string | null | undefined, field: string): bigint | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  if (!MINOR.test(value.trim())) throw invalid(field, 'MINOR_UNITS', 'Enter money as a whole number of the smallest currency unit.');
  return BigInt(value.trim());
}

function rate(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  const trimmed = value.trim();
  if (!RATE.test(trimmed) || Number(trimmed) > 100) {
    throw invalid(field, 'RATE', 'A rate is a percentage between 0 and 100, up to six decimals.');
  }
  return trimmed;
}

async function validated(input: FeeRuleInput) {
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
    throw invalid('scope', 'SUBJECT_REQUIRED', `A ${input.scope.toLowerCase()} rule needs the thing it applies to.`);
  }
  if (input.scope === 'SELLER') {
    const seller = await prisma.sellerAccount.findUnique({ where: { id: subject ?? '' }, select: { id: true } });
    if (seller === null) throw notFound('Seller');
  }
  if (input.scope === 'CATEGORY') {
    const category = await prisma.category.findUnique({ where: { id: subject ?? '' }, select: { id: true } });
    if (category === null) throw notFound('Category');
  }

  const name = input.name.trim();
  if (name.length < 2) throw invalid('name', 'REQUIRED', 'Give the rule a name.');

  const percentRate = rate(input.percentRate, 'percentRate');
  const discountPercent = rate(input.discountPercent, 'discountPercent');
  const minValueMinor = minor(input.minValueMinor, 'minValueMinor');
  const maxValueMinor = minor(input.maxValueMinor, 'maxValueMinor');
  const volumeThresholdMinor = minor(input.volumeThresholdMinor, 'volumeThresholdMinor');
  const volumeWindowDays = input.volumeWindowDays ?? null;
  const sellerTier = normaliseTier(input.sellerTier);
  const effectiveFrom = input.effectiveFrom ?? new Date();
  const effectiveTo = input.effectiveTo ?? null;

  if (effectiveTo !== null && effectiveTo <= effectiveFrom) {
    throw invalid('effectiveTo', 'RANGE', 'A rule must end after it starts.');
  }

  const needsCurrency = input.kind === 'VALUE_BAND' || input.kind === 'VOLUME_TIER';
  const currencyText = (input.currency ?? '').trim().toUpperCase();
  if (needsCurrency && currencyText === '') {
    throw invalid('currency', 'REQUIRED', 'A value or volume rule needs the currency its amounts are in.');
  }
  const currency = currencyText === '' ? null : await assertSellableCurrency(currencyText);

  if (input.kind !== 'PROMOTION' && percentRate === null) {
    throw invalid('percentRate', 'REQUIRED', 'Say what percentage this rule charges.');
  }
  switch (input.kind) {
    case 'VALUE_BAND':
      if (minValueMinor === null) throw invalid('minValueMinor', 'REQUIRED', 'A value band needs its lower bound.');
      if (maxValueMinor !== null && maxValueMinor <= minValueMinor) {
        throw invalid('maxValueMinor', 'RANGE', 'The top of the band must be above its bottom.');
      }
      break;
    case 'VOLUME_TIER':
      if (volumeThresholdMinor === null || volumeThresholdMinor <= 0n) {
        throw invalid('volumeThresholdMinor', 'REQUIRED', 'A volume tier needs the sales a seller must reach.');
      }
      if (volumeWindowDays === null || !Number.isInteger(volumeWindowDays) || volumeWindowDays < 1 || volumeWindowDays > 3660) {
        throw invalid('volumeWindowDays', 'RANGE', 'Count sales over 1 to 3660 days.');
      }
      break;
    case 'SELLER_TIER':
      if (sellerTier === null) throw invalid('sellerTier', 'REQUIRED', 'Name the seller tier this rule is for.');
      break;
    case 'PROMOTION':
      if (discountPercent === null || Number(discountPercent) <= 0) {
        throw invalid('discountPercent', 'REQUIRED', 'Say how much a promotion takes off the fee, above 0%.');
      }
      if (effectiveTo === null) throw invalid('effectiveTo', 'REQUIRED', 'A promotion needs an end date.');
      break;
  }

  return {
    kind: input.kind,
    scope: input.scope,
    scopeKey,
    sellerAccountId: input.scope === 'SELLER' ? subject : null,
    categoryId: input.scope === 'CATEGORY' ? subject : null,
    marketCountry: input.scope === 'MARKET' ? (subject ?? '').toUpperCase() : null,
    name: name.slice(0, 160),
    currency,
    minValueMinor: input.kind === 'VALUE_BAND' ? minValueMinor : null,
    maxValueMinor: input.kind === 'VALUE_BAND' ? maxValueMinor : null,
    volumeThresholdMinor: input.kind === 'VOLUME_TIER' ? volumeThresholdMinor : null,
    volumeWindowDays: input.kind === 'VOLUME_TIER' ? volumeWindowDays : null,
    sellerTier: input.kind === 'SELLER_TIER' ? sellerTier : null,
    percentRate: input.kind === 'PROMOTION' ? null : percentRate,
    discountPercent: input.kind === 'PROMOTION' ? discountPercent : null,
    effectiveFrom,
    effectiveTo,
    notes: (input.notes ?? '').trim() === '' ? null : (input.notes ?? '').trim().slice(0, 1024),
  };
}

export function toFeeRuleView(row: RuleRow) {
  const money = (amount: bigint | null) => (amount === null || row.currency === null ? null : serialiseMoney(amount, row.currency));
  return {
    id: row.id,
    kind: row.kind,
    scope: row.scope,
    scopeKey: row.scopeKey,
    sellerAccountId: row.sellerAccountId,
    categoryId: row.categoryId,
    marketCountry: row.marketCountry,
    status: row.status,
    name: row.name,
    currency: row.currency,
    minValue: money(row.minValueMinor),
    maxValue: money(row.maxValueMinor),
    volumeThreshold: money(row.volumeThresholdMinor),
    volumeWindowDays: row.volumeWindowDays,
    sellerTier: row.sellerTier,
    percentRate: row.percentRate === null ? null : trimRate(row.percentRate.toString()),
    discountPercent: row.discountPercent === null ? null : trimRate(row.discountPercent.toString()),
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
    notes: row.notes,
    supersedesRuleId: row.supersedesRuleId,
    createdByUserId: row.createdByUserId,
    lastEditedByUserId: row.lastEditedByUserId,
    submittedByUserId: row.submittedByUserId,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    publishedByUserId: row.publishedByUserId,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    rejectionReason: row.rejectionReason,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export type FeeRuleView = ReturnType<typeof toFeeRuleView>;

function auditShape(row: RuleRow | null) {
  if (row === null) return null;
  return {
    kind: row.kind,
    scopeKey: row.scopeKey,
    status: row.status,
    currency: row.currency,
    minValueMinor: row.minValueMinor?.toString() ?? null,
    maxValueMinor: row.maxValueMinor?.toString() ?? null,
    volumeThresholdMinor: row.volumeThresholdMinor?.toString() ?? null,
    volumeWindowDays: row.volumeWindowDays,
    sellerTier: row.sellerTier,
    percentRate: row.percentRate?.toString() ?? null,
    discountPercent: row.discountPercent?.toString() ?? null,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
    supersedesRuleId: row.supersedesRuleId,
  };
}

async function audit(
  actor: FinanceActor,
  action: (typeof AuditAction)[keyof typeof AuditAction],
  before: RuleRow | null,
  after: RuleRow,
  extra: Record<string, unknown> = {},
) {
  await recordAudit({
    action,
    resourceType: 'platform_fee_rule',
    resourceId: after.id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: auditShape(before),
    after: { ...auditShape(after), ...extra },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });
}

// --- Reading -----------------------------------------------------------------

export async function listFeeRules(input: { status?: RuleRow['status'] | null } = {}) {
  const rows = await prisma.platformFeeRule.findMany({
    where: input.status === undefined || input.status === null ? {} : { status: input.status },
    orderBy: [{ status: 'asc' }, { kind: 'asc' }, { createdAt: 'desc' }],
    take: 500,
  });
  const counts = await prisma.platformFeeRuleApplication.groupBy({
    by: ['ruleId'],
    where: { ruleId: { in: rows.map((row) => row.id) } },
    _count: { _all: true },
  });
  const countById = new Map(counts.map((row) => [row.ruleId, row._count._all]));
  return rows.map((row) => ({ ...toFeeRuleView(row), settlementCount: countById.get(row.id) ?? 0 }));
}

/** The seller orders whose fee a rule changed, and by how much. */
export async function ordersUsingFeeRule(ruleId: string) {
  const rule = await prisma.platformFeeRule.findUnique({ where: { id: ruleId } });
  if (rule === null) throw notFound('Fee rule');
  const rows = await prisma.platformFeeRuleApplication.findMany({
    where: { ruleId },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: {
      settlement: {
        include: {
          sellerOrderGroup: { select: { sellerOrderNumber: true, order: { select: { orderNumber: true } } } },
          sellerAccount: { select: { displayName: true } },
        },
      },
    },
  });
  return {
    rule: toFeeRuleView(rule),
    orders: rows.map((row) => ({
      sellerOrderGroupId: row.settlement.sellerOrderGroupId,
      sellerOrderNumber: row.settlement.sellerOrderGroup.sellerOrderNumber,
      orderNumber: row.settlement.sellerOrderGroup.order.orderNumber,
      sellerName: row.settlement.sellerAccount.displayName,
      effect: serialiseMoney(row.effectMinor < 0n ? -row.effectMinor : row.effectMinor, row.currency),
      effectIsSaving: row.effectMinor >= 0n,
      platformFee: serialiseMoney(row.settlement.platformFeeMinor, row.settlement.currency),
      computedAt: row.settlement.computedAt.toISOString(),
    })),
  };
}

// --- Writing -----------------------------------------------------------------

export async function createDraftFeeRule(actor: FinanceActor, input: FeeRuleInput) {
  const data = await validated(input);
  let supersedesRuleId: string | null = null;
  if ((input.supersedesRuleId ?? '') !== '') {
    const old = await prisma.platformFeeRule.findUnique({ where: { id: input.supersedesRuleId ?? '' } });
    if (old === null) throw notFound('Fee rule');
    if (old.status !== 'PUBLISHED' || old.kind !== data.kind || old.scopeKey !== data.scopeKey) {
      throw invalid('supersedesRuleId', 'NOT_REPLACEABLE', 'A rule can only replace a published rule of the same kind and scope.');
    }
    supersedesRuleId = old.id;
  }
  const row = await prisma.platformFeeRule.create({
    data: {
      ...data,
      id: newId(),
      status: 'DRAFT',
      supersedesRuleId,
      createdByUserId: actor.userId,
      lastEditedByUserId: actor.userId,
    },
  });
  await audit(actor, AuditAction.PLATFORM_FEE_RULE_SAVED, null, row);
  return toFeeRuleView(row);
}

export async function updateDraftFeeRule(actor: FinanceActor, ruleId: string, input: FeeRuleInput) {
  const before = await prisma.platformFeeRule.findUnique({ where: { id: ruleId } });
  if (before === null) throw notFound('Fee rule');
  if (before.status !== 'DRAFT') {
    throw conflict(
      ErrorCode.PLATFORM_FEE_POLICY_NOT_EDITABLE,
      'Only a draft can be changed. A published rule is replaced by a new one.',
    );
  }
  const data = await validated(input);
  if (data.kind !== before.kind || data.scopeKey !== before.scopeKey) {
    throw invalid('scope', 'IMMUTABLE', 'A draft cannot change its kind or scope.');
  }
  const claimed = await prisma.platformFeeRule.updateMany({
    where: { id: ruleId, status: 'DRAFT' },
    data: { ...data, lastEditedByUserId: actor.userId },
  });
  if (claimed.count === 0) {
    throw conflict(ErrorCode.PLATFORM_FEE_POLICY_NOT_EDITABLE, 'Only a draft can be changed.');
  }
  const row = await prisma.platformFeeRule.findUniqueOrThrow({ where: { id: ruleId } });
  await audit(actor, AuditAction.PLATFORM_FEE_RULE_SAVED, before, row);
  return toFeeRuleView(row);
}

export async function submitFeeRule(actor: FinanceActor, ruleId: string) {
  const before = await prisma.platformFeeRule.findUnique({ where: { id: ruleId } });
  if (before === null) throw notFound('Fee rule');
  if (before.status === 'PENDING_APPROVAL') return toFeeRuleView(before);
  if (before.status !== 'DRAFT') throw notPendingApproval(before.status);
  const claimed = await prisma.platformFeeRule.updateMany({
    where: { id: ruleId, status: 'DRAFT' },
    data: { status: 'PENDING_APPROVAL', submittedByUserId: actor.userId, submittedAt: new Date() },
  });
  if (claimed.count === 0) throw notPendingApproval('UNKNOWN');
  const row = await prisma.platformFeeRule.findUniqueOrThrow({ where: { id: ruleId } });
  await audit(actor, AuditAction.PLATFORM_FEE_RULE_SUBMITTED, before, row);
  return toFeeRuleView(row);
}

/**
 * Approve a submitted rule, which publishes it.
 *
 * Refused for anybody who made it. A rule that supersedes another retires
 * that one in the same transaction, and from the same instant, so there is
 * no moment when both apply and none when neither does.
 */
export async function approveFeeRule(actor: FinanceActor, ruleId: string) {
  const before = await prisma.platformFeeRule.findUnique({ where: { id: ruleId } });
  if (before === null) throw notFound('Fee rule');
  if (before.status === 'PUBLISHED') return toFeeRuleView(before);
  if (before.status !== 'PENDING_APPROVAL') throw notPendingApproval(before.status);
  assertIndependentApprover(actor, before);

  const now = new Date();
  const effectiveFrom = before.effectiveFrom < now ? now : before.effectiveFrom;
  if (before.effectiveTo !== null && before.effectiveTo <= effectiveFrom) {
    throw invalid('effectiveTo', 'EXPIRED', 'This rule would have ended before it could start. Send it back and change its dates.');
  }

  const row = await prisma.$transaction(async (tx) => {
    const claimed = await tx.platformFeeRule.updateMany({
      where: { id: ruleId, status: 'PENDING_APPROVAL' },
      data: { status: 'PUBLISHED', publishedAt: now, publishedByUserId: actor.userId, effectiveFrom },
    });
    if (claimed.count === 0) throw notPendingApproval('PUBLISHED');
    if (before.supersedesRuleId !== null) {
      await tx.platformFeeRule.updateMany({
        where: { id: before.supersedesRuleId, status: 'PUBLISHED' },
        data: { status: 'RETIRED', retiredAt: now, effectiveTo: effectiveFrom },
      });
    }
    return tx.platformFeeRule.findUniqueOrThrow({ where: { id: ruleId } });
  });
  await audit(actor, AuditAction.PLATFORM_FEE_RULE_PUBLISHED, before, row);
  return toFeeRuleView(row);
}

export async function rejectFeeRule(actor: FinanceActor, ruleId: string, input: { reason: string }) {
  const reason = assertRejectionReason(input.reason);
  const before = await prisma.platformFeeRule.findUnique({ where: { id: ruleId } });
  if (before === null) throw notFound('Fee rule');
  if (before.status !== 'PENDING_APPROVAL') throw notPendingApproval(before.status);
  const claimed = await prisma.platformFeeRule.updateMany({
    where: { id: ruleId, status: 'PENDING_APPROVAL' },
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
  const row = await prisma.platformFeeRule.findUniqueOrThrow({ where: { id: ruleId } });
  await audit(actor, AuditAction.PLATFORM_FEE_RULE_REJECTED, before, row, { reason });
  return toFeeRuleView(row);
}

/** Stop a rule applying to new orders from now. Orders already settled keep it. */
export async function retireFeeRule(actor: FinanceActor, ruleId: string) {
  const before = await prisma.platformFeeRule.findUnique({ where: { id: ruleId } });
  if (before === null) throw notFound('Fee rule');
  if (before.status === 'RETIRED') return toFeeRuleView(before);
  const now = new Date();
  const row = await prisma.platformFeeRule.update({
    where: { id: ruleId },
    data: {
      status: 'RETIRED',
      retiredAt: now,
      // A draft never applied; a published rule that had started stops now,
      // unless it was due to stop sooner. (Only PUBLISHED rules are ever read
      // for a settlement, so the status alone already stops it.)
      ...(before.status === 'PUBLISHED' &&
      before.effectiveFrom < now &&
      (before.effectiveTo === null || before.effectiveTo > now)
        ? { effectiveTo: now }
        : {}),
    },
  });
  await audit(actor, AuditAction.PLATFORM_FEE_RULE_RETIRED, before, row);
  return toFeeRuleView(row);
}

/**
 * Put a seller in a fee tier, or take them out of one (`tier: null`).
 *
 * Changes which SELLER_TIER rules match their NEXT orders; every settlement
 * already calculated stays as it is. Audited with the reason.
 */
export async function setSellerFeeTier(
  actor: FinanceActor,
  sellerAccountId: string,
  input: { tier: string | null; reason: string },
) {
  const reason = input.reason.trim();
  if (reason.length < 10) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say why the tier is changing, in at least ten characters.', [
      { field: 'reason', code: 'REQUIRED' },
    ]);
  }
  const tier = normaliseTier(input.tier);
  if (tier !== null && !/^[A-Z0-9_-]{1,32}$/.test(tier)) {
    throw invalid('tier', 'FORMAT', 'A tier is up to 32 letters, digits, dashes or underscores.');
  }
  const before = await prisma.sellerAccount.findUnique({
    where: { id: sellerAccountId },
    select: { id: true, feeTier: true, displayName: true },
  });
  if (before === null) throw notFound('Seller');
  await prisma.sellerAccount.update({ where: { id: sellerAccountId }, data: { feeTier: tier } });
  await recordAudit({
    action: AuditAction.SELLER_FEE_TIER_CHANGED,
    resourceType: 'seller_account',
    resourceId: sellerAccountId,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: { feeTier: before.feeTier },
    after: { feeTier: tier, reason },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });
  return { sellerAccountId, displayName: before.displayName, feeTier: tier };
}

/** The tiers sellers are in now, for the screen's tier list. */
export async function listSellerFeeTiers() {
  const rows = await prisma.sellerAccount.findMany({
    where: { feeTier: { not: null } },
    select: { id: true, displayName: true, feeTier: true },
    orderBy: [{ feeTier: 'asc' }, { displayName: 'asc' }],
    take: 500,
  });
  return rows.map((row) => ({ sellerAccountId: row.id, displayName: row.displayName, feeTier: row.feeTier }));
}
