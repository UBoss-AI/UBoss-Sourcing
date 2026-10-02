/**
 * Fraud and risk signals (checklist SEC-008).
 *
 * WHAT IT DOES
 *
 * The worker calls `runRiskScan` on every maintenance pass. Each enabled rule
 * reads records the system already keeps - sign-in attempts, the audit log,
 * seller identifiers, inspection evidence, refunds, coupon redemptions and
 * orders - and raises one `RiskSignal` per pattern it finds, with the facts
 * that made it fire. A person then reviews each signal: confirmed, or a false
 * positive, always with a reason, always audited.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 *   - **No automatic adverse decision.** A signal never suspends an account,
 *     cancels an order or holds a payout. Fraud scores are wrong often enough
 *     that acting on one without a person is how an honest buyer is locked out
 *     on a busy day. Anything a reviewer decides to do is done through the
 *     existing, audited controls (suspend, hold, refund refusal).
 *   - **No invented thresholds.** Every number lives in `risk_rules` and starts
 *     as a placeholder marked `approvedForProduction = false`. The business's
 *     risk owner sets the real values and approves them in the console.
 *   - **No duplicate signals.** Each pattern has a `dedupeKey` (rule, subject
 *     and time bucket, or a fingerprint for standing patterns such as a shared
 *     tax number), so rescanning the same window writes nothing new.
 *
 * Sensitive identifiers are never copied into a signal in full: a tax number
 * is stored as a fingerprint and its last four characters.
 */
import { createHash } from 'node:crypto';
import { ErrorCode, AppError, badRequest, conflict, notFound } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import type { RiskRule, RiskSeverity } from '../../generated/prisma/client.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  AdminNotificationKind,
  ResolutionKey,
  createAdminNotification,
  resolveAdminNotifications,
} from '../notifications/admin-notification.service.js';

export const RiskRuleCode = {
  /** Failed sign-ins for one address within the window. */
  LOGIN_FAILURES: 'LOGIN_FAILURES',
  /** A password change or MFA switch-off after repeated failures: a takeover pattern. */
  SENSITIVE_CHANGE_AFTER_FAILURES: 'SENSITIVE_CHANGE_AFTER_FAILURES',
  /** Two or more seller accounts giving the same tax or company number. */
  DUPLICATE_SELLER_IDENTIFIER: 'DUPLICATE_SELLER_IDENTIFIER',
  /** The same evidence file (by hash) on two or more inspection jobs. */
  EVIDENCE_REUSED: 'EVIDENCE_REUSED',
  /** Evidence uploaded more than `windowMinutes` after it says it was captured. */
  EVIDENCE_LATE_UPLOAD: 'EVIDENCE_LATE_UPLOAD',
  /** Refunds on one buyer's orders within the window. */
  REFUND_FREQUENCY: 'REFUND_FREQUENCY',
  /** Refund value on one buyer's orders within the window, in the rule's currency. */
  REFUND_VALUE: 'REFUND_VALUE',
  /** Coupon redemptions by one buyer within the window. */
  PROMO_REDEMPTIONS: 'PROMO_REDEMPTIONS',
  /** Orders placed by one buyer within the window. */
  ORDER_VELOCITY: 'ORDER_VELOCITY',
  /** Several high-severity signals on the same subject within the window. */
  MULTIPLE_HIGH_RISK: 'MULTIPLE_HIGH_RISK',
  /** Product reviews written by one buyer within the window (JOURNEY-059). */
  REVIEW_VELOCITY: 'REVIEW_VELOCITY',
  /**
   * A seller's own member tried to review that seller's sale (JOURNEY-059).
   * Raised at the moment it is refused, by `raiseRiskSignal`; the scan has
   * nothing to find because the review was never written.
   */
  REVIEW_SELF_DEALING: 'REVIEW_SELF_DEALING',
} as const;

export type RiskRuleCodeValue = (typeof RiskRuleCode)[keyof typeof RiskRuleCode];

interface Candidate {
  subjectType: string;
  subjectId: string;
  observed: number;
  /** The part of the dedupe key after rule and subject. */
  bucket: string;
  facts: Record<string, unknown>;
}

const SCAN_HORIZON_DAYS = 30;

function fingerprint(value: string): string {
  return createHash('sha256').update(value.trim().toUpperCase().replace(/[\s-]/g, '')).digest('hex').slice(0, 40);
}

function mask(value: string): string {
  const clean = value.trim();
  return clean.length <= 4 ? '****' : `****${clean.slice(-4)}`;
}

function windowStart(rule: RiskRule, now: Date): Date {
  return new Date(now.getTime() - rule.windowMinutes * 60_000);
}

/** The window the event falls in, so a pattern is raised once per window. */
function bucketOf(rule: RiskRule, now: Date): string {
  return String(Math.floor(now.getTime() / (rule.windowMinutes * 60_000)));
}

type Evaluator = (rule: RiskRule, now: Date) => Promise<Candidate[]>;

const EVALUATORS: Record<RiskRuleCodeValue, Evaluator> = {
  async LOGIN_FAILURES(rule, now) {
    const rows = await prisma.loginAttempt.groupBy({
      by: ['emailNormalized'],
      where: { success: false, createdAt: { gte: windowStart(rule, now) } },
      _count: { _all: true },
    });
    return rows
      .filter((row) => row._count._all >= rule.threshold)
      .map((row) => ({
        subjectType: 'EMAIL',
        subjectId: fingerprint(row.emailNormalized),
        observed: row._count._all,
        bucket: bucketOf(rule, now),
        facts: { email: row.emailNormalized },
      }));
  },

  async SENSITIVE_CHANGE_AFTER_FAILURES(rule, now) {
    const since = windowStart(rule, now);
    const changes = await prisma.auditLog.findMany({
      where: {
        action: { in: [AuditAction.USER_PASSWORD_CHANGED, AuditAction.USER_MFA_DISABLED] },
        createdAt: { gte: since },
        resourceId: { not: null },
      },
      select: { resourceId: true, action: true, createdAt: true },
    });
    const userIds = [...new Set(changes.map((row) => row.resourceId as string))];
    if (userIds.length === 0) return [];
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, emailNormalized: true } });
    const out: Candidate[] = [];
    for (const user of users) {
      const failures = await prisma.loginAttempt.count({
        where: { emailNormalized: user.emailNormalized, success: false, createdAt: { gte: since } },
      });
      if (failures < rule.threshold) continue;
      out.push({
        subjectType: 'USER',
        subjectId: user.id,
        observed: failures,
        bucket: bucketOf(rule, now),
        facts: {
          failedSignIns: failures,
          changes: changes.filter((row) => row.resourceId === user.id).map((row) => ({ action: row.action, at: row.createdAt.toISOString() })),
        },
      });
    }
    return out;
  },

  async DUPLICATE_SELLER_IDENTIFIER(rule) {
    const profiles = await prisma.sellerBusinessProfile.findMany({
      where: { OR: [{ taxRegistrationNumber: { not: null } }, { companyRegistrationNumber: { not: null } }] },
      select: { sellerAccountId: true, taxRegistrationNumber: true, companyRegistrationNumber: true },
    });
    const groups = new Map<string, { kind: string; masked: string; sellers: Set<string> }>();
    for (const profile of profiles) {
      for (const [kind, value] of [
        ['TAX_REGISTRATION', profile.taxRegistrationNumber],
        ['COMPANY_REGISTRATION', profile.companyRegistrationNumber],
      ] as const) {
        if (value === null || value.trim().length < 4) continue;
        const key = `${kind}:${fingerprint(value)}`;
        const group = groups.get(key) ?? { kind, masked: mask(value), sellers: new Set<string>() };
        group.sellers.add(profile.sellerAccountId);
        groups.set(key, group);
      }
    }
    return [...groups.entries()]
      .filter(([, group]) => group.sellers.size >= rule.threshold)
      .map(([key, group]) => {
        const sellers = [...group.sellers].sort();
        return {
          subjectType: 'SELLER_IDENTIFIER',
          subjectId: key.split(':')[1] ?? key,
          observed: sellers.length,
          // A new seller joining the group is a new pattern; the same group is not.
          bucket: fingerprint(sellers.join(',')),
          facts: { identifier: group.kind, value: group.masked, sellerAccountIds: sellers },
        };
      });
  },

  async EVIDENCE_REUSED(rule) {
    const repeated = await prisma.inspectionEvidence.groupBy({
      by: ['contentHash'],
      where: { jobId: { not: null } },
      _count: { _all: true },
      having: { contentHash: { _count: { gte: 2 } } },
    });
    const out: Candidate[] = [];
    for (const row of repeated) {
      const uses = await prisma.inspectionEvidence.findMany({
        where: { contentHash: row.contentHash, jobId: { not: null } },
        select: { id: true, jobId: true, uploadedByLabel: true, uploadedByParty: true },
      });
      const jobs = [...new Set(uses.map((use) => use.jobId as string))].sort();
      if (jobs.length < rule.threshold) continue;
      out.push({
        subjectType: 'INSPECTION_EVIDENCE_HASH',
        subjectId: row.contentHash.slice(0, 64),
        observed: jobs.length,
        bucket: fingerprint(jobs.join(',')),
        facts: { jobIds: jobs, evidence: uses.map((use) => ({ id: use.id, jobId: use.jobId, party: use.uploadedByParty, by: use.uploadedByLabel })) },
      });
    }
    return out;
  },

  async EVIDENCE_LATE_UPLOAD(rule, now) {
    const since = new Date(now.getTime() - SCAN_HORIZON_DAYS * 86_400_000);
    const recent = await prisma.inspectionEvidence.findMany({
      where: { receivedAt: { gte: since } },
      select: { id: true, jobId: true, capturedAt: true, receivedAt: true, uploadedByLabel: true },
    });
    return recent
      .filter((row) => row.receivedAt.getTime() - row.capturedAt.getTime() > rule.windowMinutes * 60_000)
      .map((row) => ({
        subjectType: 'INSPECTION_EVIDENCE',
        subjectId: row.id,
        observed: Math.floor((row.receivedAt.getTime() - row.capturedAt.getTime()) / 60_000),
        bucket: 'once',
        facts: { jobId: row.jobId, capturedAt: row.capturedAt.toISOString(), receivedAt: row.receivedAt.toISOString(), by: row.uploadedByLabel },
      }));
  },

  async REFUND_FREQUENCY(rule, now) {
    const refunds = await refundsSince(windowStart(rule, now));
    const byBuyer = new Map<string, string[]>();
    for (const refund of refunds) byBuyer.set(refund.buyer, [...(byBuyer.get(refund.buyer) ?? []), refund.id]);
    return [...byBuyer.entries()]
      .filter(([, ids]) => ids.length >= rule.threshold)
      .map(([buyer, ids]) => ({ subjectType: 'CUSTOMER_PROFILE', subjectId: buyer, observed: ids.length, bucket: bucketOf(rule, now), facts: { refundIds: ids } }));
  },

  async REFUND_VALUE(rule, now) {
    if (rule.thresholdMinor === null || rule.currency === null) return [];
    const refunds = (await refundsSince(windowStart(rule, now))).filter((refund) => refund.currency === rule.currency);
    const byBuyer = new Map<string, { total: bigint; ids: string[] }>();
    for (const refund of refunds) {
      const entry = byBuyer.get(refund.buyer) ?? { total: 0n, ids: [] };
      entry.total += refund.amountMinor;
      entry.ids.push(refund.id);
      byBuyer.set(refund.buyer, entry);
    }
    const limit = rule.thresholdMinor;
    return [...byBuyer.entries()]
      .filter(([, entry]) => entry.total >= limit)
      .map(([buyer, entry]) => ({
        subjectType: 'CUSTOMER_PROFILE',
        subjectId: buyer,
        observed: entry.ids.length,
        bucket: bucketOf(rule, now),
        facts: { refundIds: entry.ids, totalMinor: entry.total.toString(), currency: rule.currency, thresholdMinor: limit.toString() },
      }));
  },

  async PROMO_REDEMPTIONS(rule, now) {
    const rows = await prisma.couponRedemption.groupBy({
      by: ['customerProfileId'],
      where: { redeemedAt: { gte: windowStart(rule, now) }, customerProfileId: { not: null } },
      _count: { _all: true },
    });
    return rows
      .filter((row) => row.customerProfileId !== null && row._count._all >= rule.threshold)
      .map((row) => ({ subjectType: 'CUSTOMER_PROFILE', subjectId: row.customerProfileId as string, observed: row._count._all, bucket: bucketOf(rule, now), facts: { redemptions: row._count._all } }));
  },

  async ORDER_VELOCITY(rule, now) {
    const rows = await prisma.order.groupBy({
      by: ['customerProfileId'],
      where: { createdAt: { gte: windowStart(rule, now) } },
      _count: { _all: true },
    });
    return rows
      .filter((row) => row._count._all >= rule.threshold)
      .map((row) => ({ subjectType: 'CUSTOMER_PROFILE', subjectId: row.customerProfileId, observed: row._count._all, bucket: bucketOf(rule, now), facts: { orders: row._count._all } }));
  },

  async REVIEW_VELOCITY(rule, now) {
    const rows = await prisma.productReview.groupBy({
      by: ['customerProfileId'],
      where: { createdAt: { gte: windowStart(rule, now) } },
      _count: { _all: true },
    });
    return rows
      .filter((row) => row._count._all >= rule.threshold)
      .map((row) => ({ subjectType: 'CUSTOMER_PROFILE', subjectId: row.customerProfileId, observed: row._count._all, bucket: bucketOf(rule, now), facts: { reviews: row._count._all } }));
  },

  // Raised when it happens (see `raiseRiskSignal`); nothing to scan for.
  REVIEW_SELF_DEALING() {
    return Promise.resolve([]);
  },

  async MULTIPLE_HIGH_RISK(rule, now) {
    const rows = await prisma.riskSignal.groupBy({
      by: ['subjectType', 'subjectId'],
      where: {
        ruleCode: { not: RiskRuleCode.MULTIPLE_HIGH_RISK },
        severity: { in: ['HIGH', 'CRITICAL'] },
        status: { not: 'FALSE_POSITIVE' },
        detectedAt: { gte: windowStart(rule, now) },
      },
      _count: { _all: true },
    });
    return rows
      .filter((row) => row._count._all >= rule.threshold)
      .map((row) => ({ subjectType: row.subjectType, subjectId: row.subjectId, observed: row._count._all, bucket: bucketOf(rule, now), facts: { highSeveritySignals: row._count._all } }));
  },
};

async function refundsSince(since: Date): Promise<{ id: string; buyer: string; amountMinor: bigint; currency: string }[]> {
  const rows = await prisma.refund.findMany({
    where: { createdAt: { gte: since }, status: { not: 'FAILED' } },
    select: { id: true, amountMinor: true, currency: true, order: { select: { customerProfileId: true } } },
  });
  return rows.map((row) => ({ id: row.id, buyer: row.order.customerProfileId, amountMinor: row.amountMinor, currency: row.currency }));
}

/**
 * Evaluate every enabled rule once. Returns how many new signals were raised.
 * Safe to run concurrently and repeatedly: the dedupe key makes a second
 * insert of the same pattern a no-op.
 */
export async function runRiskScan(now: Date = new Date()): Promise<number> {
  const rules = await prisma.riskRule.findMany({ where: { enabled: true } });
  let raised = 0;
  // Composite rule last, so it sees the signals this pass raised.
  rules.sort((a, b) => Number(a.code === RiskRuleCode.MULTIPLE_HIGH_RISK) - Number(b.code === RiskRuleCode.MULTIPLE_HIGH_RISK));
  for (const rule of rules) {
    const evaluate = EVALUATORS[rule.code as RiskRuleCodeValue] as Evaluator | undefined;
    if (evaluate === undefined) continue;
    for (const candidate of await evaluate(rule, now)) {
      if (await insertSignal(rule, candidate, now)) raised += 1;
    }
  }
  return raised;
}

/** Write one signal; false when its dedupe key was already raised. HIGH and CRITICAL ring the bell. */
async function insertSignal(rule: RiskRule, candidate: Candidate, now: Date): Promise<boolean> {
  const dedupeKey = `${rule.code}:${candidate.subjectType}:${candidate.subjectId}:${candidate.bucket}`.slice(0, 191);
  const id = newId();
  const created = await prisma.riskSignal.createMany({
    data: [{
      id,
      ruleCode: rule.code,
      severity: rule.severity,
      subjectType: candidate.subjectType,
      subjectId: candidate.subjectId,
      observed: candidate.observed,
      threshold: rule.threshold,
      facts: { ...candidate.facts, ruleVersion: rule.version, approvedForProduction: rule.approvedForProduction },
      dedupeKey,
      detectedAt: now,
    }],
    skipDuplicates: true,
  });
  if (created.count === 0) return false;
  if (rule.severity === 'HIGH' || rule.severity === 'CRITICAL') {
    await createAdminNotification({
      kind: AdminNotificationKind.RISK_SIGNAL_RAISED,
      variables: { rule: rule.code, severity: rule.severity, subjectType: candidate.subjectType },
      requiredPermission: Permission.RISK_READ,
      relatedType: 'risk_signal',
      relatedId: id,
      linkPath: '/risk',
      dedupeKey: `risk_signal:${id}`,
      resolutionKey: ResolutionKey.riskSignal(id),
    });
  }
  return true;
}

/**
 * Raise a signal at the moment something happens, for a rule whose pattern
 * leaves no record for the scan to find - a review that was refused was never
 * written. Same rules table, same dedupe (one per subject per window), same
 * bell. Does nothing while the rule is disabled or missing. Never throws: a
 * signal that could not be written must not turn the refusal into a 500.
 */
export async function raiseRiskSignal(input: {
  ruleCode: RiskRuleCodeValue;
  subjectType: string;
  subjectId: string;
  observed?: number;
  facts: Record<string, unknown>;
  now?: Date;
}): Promise<boolean> {
  try {
    const rule = await prisma.riskRule.findUnique({ where: { code: input.ruleCode } });
    if (rule === null || !rule.enabled) return false;
    const now = input.now ?? new Date();
    return await insertSignal(
      rule,
      {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        observed: input.observed ?? 1,
        bucket: bucketOf(rule, now),
        facts: input.facts,
      },
      now,
    );
  } catch {
    return false;
  }
}

export interface RiskActor {
  userId: string;
  email: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export async function listRiskSignals(filters: { status?: 'OPEN' | 'CONFIRMED' | 'FALSE_POSITIVE'; ruleCode?: string; limit: number }) {
  const rows = await prisma.riskSignal.findMany({
    where: {
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.ruleCode === undefined ? {} : { ruleCode: filters.ruleCode }),
    },
    orderBy: [{ detectedAt: 'desc' }],
    take: filters.limit,
  });
  return rows.map((row) => ({ ...row, detectedAt: row.detectedAt.toISOString(), reviewedAt: row.reviewedAt?.toISOString() ?? null }));
}

export async function listRiskRules() {
  const rows = await prisma.riskRule.findMany({ orderBy: { code: 'asc' } });
  return rows.map((row) => ({ ...row, thresholdMinor: row.thresholdMinor?.toString() ?? null }));
}

/**
 * A reviewer's decision. A reason is always required, a reviewer can never
 * decide a signal about themselves, and changing an earlier decision (an
 * override) is allowed but recorded with both the old and the new decision.
 */
export async function reviewRiskSignal(
  id: string,
  input: { decision: 'CONFIRMED' | 'FALSE_POSITIVE'; reason: string },
  actor: RiskActor,
): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length < 5) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Give the reason for the decision.', [{ field: 'reason', code: 'REQUIRED' }]);
  }
  const signal = await prisma.riskSignal.findUnique({ where: { id } });
  if (signal === null) throw notFound('Risk signal');
  if (signal.subjectId === actor.userId) {
    throw new AppError({ statusCode: 403, code: ErrorCode.PERMISSION_DENIED, message: 'You cannot review a signal about yourself.', details: [{ code: 'SELF_REVIEW' }] });
  }
  if (signal.status === input.decision) {
    throw conflict(ErrorCode.CONFLICT, 'The signal already has that decision.', [{ field: 'decision', code: 'UNCHANGED' }]);
  }
  await prisma.$transaction(async (tx) => {
    const updated = await tx.riskSignal.updateMany({
      where: { id, status: signal.status },
      data: { status: input.decision, reviewedById: actor.userId, reviewedAt: new Date(), reviewReason: reason.slice(0, 1024) },
    });
    if (updated.count === 0) throw conflict(ErrorCode.CONFLICT, 'Somebody else decided this signal first.');
    await recordAudit(
      {
        action: AuditAction.RISK_SIGNAL_REVIEWED,
        resourceType: 'risk_signal',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { status: signal.status, reviewReason: signal.reviewReason },
        after: { status: input.decision, reviewReason: reason.slice(0, 1024), override: signal.status !== 'OPEN' },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
    await resolveAdminNotifications(
      { resolutionKey: ResolutionKey.riskSignal(id), reason: `Reviewed: ${input.decision}`, source: 'DOMAIN_EVENT', resolvedByUserId: actor.userId },
      tx,
    );
  });
}

const SEVERITIES: readonly RiskSeverity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/** Change a rule, or approve its values for production. Versioned and audited. */
export async function updateRiskRule(
  code: string,
  patch: { enabled?: boolean; severity?: RiskSeverity; threshold?: number; windowMinutes?: number; thresholdMinor?: bigint | null; currency?: string | null; approvedForProduction?: boolean; expectedVersion: number },
  actor: RiskActor,
) {
  const rule = await prisma.riskRule.findUnique({ where: { code } });
  if (rule === null) throw notFound('Risk rule');
  if (patch.severity !== undefined && !SEVERITIES.includes(patch.severity)) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Unknown severity.');
  const { expectedVersion, ...changes } = patch;
  const updated = await prisma.riskRule.updateMany({
    where: { code, version: expectedVersion },
    data: { ...changes, updatedById: actor.userId, version: { increment: 1 } },
  });
  if (updated.count === 0) throw conflict(ErrorCode.CONFLICT, 'The rule was changed by somebody else. Reload and try again.', [{ field: 'expectedVersion', code: 'STALE' }]);
  const after = await prisma.riskRule.findUniqueOrThrow({ where: { code } });
  const plain = (row: RiskRule) => ({ ...row, thresholdMinor: row.thresholdMinor?.toString() ?? null, createdAt: undefined, updatedAt: undefined });
  await recordAudit({
    action: AuditAction.RISK_RULE_CHANGED,
    resourceType: 'risk_rule',
    resourceId: null,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: plain(rule),
    after: plain(after),
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });
  return { ...after, thresholdMinor: after.thresholdMinor?.toString() ?? null };
}
