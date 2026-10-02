/**
 * Privileged-access review of the marketplace's own staff (LIVE-015).
 *
 * A periodic review asks, for every staff account: what can it do, is it
 * protected by a second factor, and is it still being used? This module lists
 * exactly that - roles, two-factor, last sign-in, and a dormant flag once an
 * account has gone `STAFF_DORMANT_AFTER_DAYS` without signing in - and lets
 * the reviewer record a decision per account: KEEP, REDUCE or REVOKE, with a
 * note.
 *
 * THREE RULES
 *
 *   - Only a Business Owner reviews. The review is about privileged access,
 *     and the people holding it are the ones it must not be left to.
 *   - Nobody reviews their own account. "I have looked at my own access and
 *     it is fine" is not a review.
 *   - A decision changes nothing by itself. REDUCE and REVOKE are carried out
 *     with the ordinary role and status actions on the same screen, which
 *     keep their own guards (the last owner, your own authority) and their
 *     own audit entries. The review records what was decided and why.
 *
 * Every decision is one `staff_access_reviews` row and one audit entry,
 * written in one transaction, with a snapshot of what was reviewed.
 */
import { ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import { Role } from '../../domain/permissions.js';
import { env } from '../../config/env.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';

export type StaffAccessDecisionValue = 'KEEP' | 'REDUCE' | 'REVOKE';

export interface StaffReviewActor {
  userId: string;
  email: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export interface StaffAccessDecisionView {
  decision: StaffAccessDecisionValue;
  note: string | null;
  reviewedAt: string;
  reviewerEmail: string | null;
}

export interface StaffAccessRow {
  id: string;
  email: string;
  status: string;
  deactivated: boolean;
  roles: { key: string; name: string }[];
  mfaEnabled: boolean;
  lastSignInAt: string | null;
  createdAt: string;
  /** No sign-in for the dormancy threshold (counted from creation if never). */
  dormant: boolean;
  /** The viewer's own account: shown, but it cannot be reviewed by them. */
  isSelf: boolean;
  latestDecision: StaffAccessDecisionView | null;
}

export interface StaffAccessReviewView {
  dormantAfterDays: number;
  generatedAt: string;
  accounts: StaffAccessRow[];
  summary: {
    accounts: number;
    withoutMfa: number;
    dormant: number;
    neverReviewed: number;
  };
}

const DAY_MS = 86_400_000;

/** Is this account dormant at `now`? Exported for the unit test. */
export function isDormant(
  account: { lastLoginAt: Date | null; createdAt: Date; deactivated: boolean },
  dormantAfterDays: number,
  now: Date,
): boolean {
  if (dormantAfterDays === 0 || account.deactivated) return false;
  const since = account.lastLoginAt ?? account.createdAt;
  return now.getTime() - since.getTime() >= dormantAfterDays * DAY_MS;
}

async function assertBusinessOwner(actor: StaffReviewActor): Promise<void> {
  const holds = await prisma.userRole.count({
    where: {
      userId: actor.userId,
      role: { key: Role.BUSINESS_OWNER },
      user: { type: 'ADMIN', status: 'ACTIVE', archivedAt: null },
    },
  });
  if (holds === 0) {
    throw forbidden(
      ErrorCode.PERMISSION_DENIED,
      'Only a Business Owner can review staff access.',
    );
  }
}

export async function staffAccessReview(
  actor: StaffReviewActor,
  now: Date = new Date(),
): Promise<StaffAccessReviewView> {
  await assertBusinessOwner(actor);
  const dormantAfterDays = env.STAFF_DORMANT_AFTER_DAYS;

  const users = await prisma.user.findMany({
    where: { type: 'ADMIN', erasedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      email: true,
      status: true,
      archivedAt: true,
      mfaEnabledAt: true,
      lastLoginAt: true,
      createdAt: true,
      roles: { select: { role: { select: { key: true, name: true } } } },
    },
  });

  const latest = await prisma.staffAccessReview.findMany({
    where: { reviewedUserId: { in: users.map((user) => user.id) } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      reviewedUserId: true,
      decision: true,
      note: true,
      createdAt: true,
      reviewer: { select: { email: true } },
    },
  });
  const latestBy = new Map<string, (typeof latest)[number]>();
  for (const row of latest) {
    if (!latestBy.has(row.reviewedUserId)) latestBy.set(row.reviewedUserId, row);
  }

  const accounts: StaffAccessRow[] = users.map((user) => {
    const deactivated = user.archivedAt !== null || user.status === 'DEACTIVATED';
    const decision = latestBy.get(user.id);
    return {
      id: user.id,
      email: user.email,
      status: user.status,
      deactivated,
      roles: user.roles.map((assignment) => ({ key: assignment.role.key, name: assignment.role.name })),
      mfaEnabled: user.mfaEnabledAt !== null,
      lastSignInAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
      dormant: isDormant(
        { lastLoginAt: user.lastLoginAt, createdAt: user.createdAt, deactivated },
        dormantAfterDays,
        now,
      ),
      isSelf: user.id === actor.userId,
      latestDecision:
        decision === undefined
          ? null
          : {
              decision: decision.decision,
              note: decision.note,
              reviewedAt: decision.createdAt.toISOString(),
              reviewerEmail: decision.reviewer.email,
            },
    };
  });

  const live = accounts.filter((account) => !account.deactivated);
  return {
    dormantAfterDays,
    generatedAt: now.toISOString(),
    accounts,
    summary: {
      accounts: live.length,
      withoutMfa: live.filter((account) => !account.mfaEnabled).length,
      dormant: live.filter((account) => account.dormant).length,
      neverReviewed: live.filter((account) => account.latestDecision === null).length,
    },
  };
}

export interface RecordStaffAccessDecisionInput {
  decision: StaffAccessDecisionValue;
  note?: string | null;
}

export async function recordStaffAccessDecision(
  reviewedUserId: string,
  input: RecordStaffAccessDecisionInput,
  actor: StaffReviewActor,
  now: Date = new Date(),
): Promise<{ id: string; reviewedAt: string }> {
  await assertBusinessOwner(actor);

  if (reviewedUserId === actor.userId) {
    throw conflict(ErrorCode.CONFLICT, 'You cannot review your own access. Ask another Business Owner.', [
      { field: 'userId', code: 'SELF_REVIEW' },
    ]);
  }

  const note = input.note?.trim() ?? '';
  // Keeping access needs no explanation; taking it away does, so the person
  // who carries it out knows what was meant.
  if (input.decision !== 'KEEP' && note === '') {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say what should change and why.', [
      { field: 'note', code: 'REQUIRED' },
    ]);
  }

  const target = await prisma.user.findUnique({
    where: { id: reviewedUserId },
    select: {
      id: true,
      type: true,
      status: true,
      archivedAt: true,
      erasedAt: true,
      mfaEnabledAt: true,
      lastLoginAt: true,
      createdAt: true,
      roles: { select: { role: { select: { key: true } } } },
    },
  });
  if (target === null || target.type !== 'ADMIN' || target.erasedAt !== null) {
    throw notFound('Staff account');
  }

  const roleKeys = target.roles.map((assignment) => assignment.role.key).sort();
  const deactivated = target.archivedAt !== null || target.status === 'DEACTIVATED';
  const dormant = isDormant(
    { lastLoginAt: target.lastLoginAt, createdAt: target.createdAt, deactivated },
    env.STAFF_DORMANT_AFTER_DAYS,
    now,
  );
  const id = newId();
  const snapshot = {
    decision: input.decision,
    note: note === '' ? null : note,
    roles: roleKeys,
    mfaEnabled: target.mfaEnabledAt !== null,
    lastSignInAt: target.lastLoginAt?.toISOString() ?? null,
    dormant,
    status: target.status,
  };

  await prisma.$transaction(async (tx) => {
    await tx.staffAccessReview.create({
      data: {
        id,
        reviewedUserId,
        reviewerUserId: actor.userId,
        decision: input.decision,
        note: snapshot.note,
        rolesJson: roleKeys,
        mfaEnabled: snapshot.mfaEnabled,
        lastSignInAt: target.lastLoginAt,
        dormant,
        createdAt: now,
      },
    });
    await recordAudit(
      {
        action: AuditAction.STAFF_ACCESS_REVIEWED,
        resourceType: 'user',
        resourceId: reviewedUserId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { reviewId: id, ...snapshot },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return { id, reviewedAt: now.toISOString() };
}
