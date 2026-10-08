/**
 * Maker-checker for critical account actions (JOURNEY-061).
 *
 * Suspending or refusing a seller, deactivating a customer and suspending a
 * buyer company each stop somebody trading. With `critical_action_approval`
 * on (the default), the admin route does not run the action: it records a
 * request here, with the reason, and a DIFFERENT member of staff holding the
 * same permission approves it. Only the approval runs the action, through the
 * same service the direct route uses, so the rules (state machine, versions,
 * sign-out, notices) are identical either way.
 *
 * Every step is audited: requested, approved (and what running it did),
 * rejected, withdrawn. The person who asked can withdraw; they cannot approve.
 *
 * `pendingKey` is "KIND:resourceId" while a request is PENDING and NULL after,
 * so the unique index allows exactly one open request per action per record.
 */
import type { AdminPendingAction, Prisma } from '../../generated/prisma/client.js';
import { conflict, ErrorCode, forbidden, isAppError, notFound } from '../../domain/errors.js';
import { Permission, type PermissionKey } from '../../domain/permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { suspendCompany } from '../buyer-companies/review.service.js';
import { setCustomerStatus } from '../customers/customer.service.js';
import { decideApplication } from '../seller/moderation.service.js';

/** The feature flag that switches maker-checker on. A missing row counts as on. */
export const CRITICAL_ACTION_FLAG = 'critical_action_approval';

export type PendingActionKind =
  | 'SELLER_SUSPEND'
  | 'SELLER_REJECT'
  | 'CUSTOMER_DEACTIVATE'
  | 'BUYER_COMPANY_SUSPEND';

/** The grant both the asker and the approver must hold, per kind. */
export const PENDING_ACTION_PERMISSION: Readonly<Record<PendingActionKind, PermissionKey>> = Object.freeze({
  SELLER_SUSPEND: Permission.CUSTOMER_STATUS_WRITE,
  SELLER_REJECT: Permission.CUSTOMER_STATUS_WRITE,
  CUSTOMER_DEACTIVATE: Permission.CUSTOMER_STATUS_WRITE,
  BUYER_COMPANY_SUSPEND: Permission.BUYER_COMPANY_SUSPEND,
});

export interface StaffActor {
  userId: string;
  email: string;
  permissions: readonly string[];
  ipAddress?: string | null;
  correlationId?: string | null;
}

export interface PendingActionView {
  id: string;
  kind: PendingActionKind;
  status: string;
  resourceType: string;
  resourceId: string;
  resourceLabel: string;
  payload: Record<string, unknown>;
  reason: string;
  requestedById: string;
  requestedByEmail: string;
  requestedAt: string;
  decidedByEmail: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  failureMessage: string | null;
}

function view(row: AdminPendingAction): PendingActionView {
  const payload =
    row.payloadJson !== null && typeof row.payloadJson === 'object' && !Array.isArray(row.payloadJson)
      ? (row.payloadJson as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    resourceLabel: row.resourceLabel,
    payload,
    reason: row.reason,
    requestedById: row.requestedById,
    requestedByEmail: row.requestedByEmail,
    requestedAt: row.requestedAt.toISOString(),
    decidedByEmail: row.decidedByEmail,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    failureMessage: row.failureMessage,
  };
}

/** Whether critical account actions need a second approver on this deployment. */
export async function criticalActionApprovalRequired(): Promise<boolean> {
  const flag = await prisma.featureFlag.findUnique({ where: { key: CRITICAL_ACTION_FLAG }, select: { enabled: true } });
  return flag?.enabled ?? true;
}

/**
 * Run an approved action, through the same service the direct route uses.
 *
 * The approver is the actor: theirs is the decision that made it happen, and
 * the request (with the person who asked) is on the audit trail beside it.
 */
async function execute(action: PendingActionView, approver: StaffActor): Promise<void> {
  const payload = action.payload;
  const text = (key: string): string | null => {
    const value = payload[key];
    return typeof value === 'string' ? value : null;
  };
  const expectedVersion = typeof payload.expectedVersion === 'number' ? payload.expectedVersion : null;

  switch (action.kind) {
    case 'SELLER_REJECT':
      return refuseSellerReject();
    case 'SELLER_SUSPEND':
      await decideApplication({
        sellerAccountId: action.resourceId,
        to: 'SUSPENDED',
        reason: action.reason,
        internalNote: text('internalNote'),
        adminUserId: approver.userId,
        actorType: 'ADMIN',
        correlationId: approver.correlationId ?? null,
        expectedVersion,
      });
      return;
    case 'CUSTOMER_DEACTIVATE':
      await setCustomerStatus(
        action.resourceId,
        false,
        {
          userId: approver.userId,
          email: approver.email,
          ipAddress: approver.ipAddress ?? null,
          correlationId: approver.correlationId ?? null,
        },
        action.reason,
      );
      return;
    case 'BUYER_COMPANY_SUSPEND':
      await suspendCompany(
        {
          userId: approver.userId,
          email: approver.email,
          permissions: new Set(approver.permissions),
          ipAddress: approver.ipAddress ?? null,
          correlationId: approver.correlationId ?? null,
        },
        {
          companyId: action.resourceId,
          expectedVersion: expectedVersion ?? 0,
          reason: action.reason,
          reasonCode: text('reasonCode'),
        },
      );
      return;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

export interface PendingActionRequest {
  kind: PendingActionKind;
  resourceType: string;
  resourceId: string;
  resourceLabel: string;
  payload: Record<string, unknown>;
  reason: string;
}

/** Record a request for a critical action. Refused while one is already open. */
export async function requestPendingAction(
  request: PendingActionRequest,
  requester: StaffActor,
): Promise<PendingActionView> {
  const pendingKey = `${request.kind}:${request.resourceId}`;
  const existing = await prisma.adminPendingAction.findUnique({ where: { pendingKey }, select: { id: true } });
  if (existing !== null) {
    throw conflict(
      ErrorCode.PENDING_ACTION_ALREADY_OPEN,
      'A request for this action is already waiting for a second approver.',
      [{ code: 'ALREADY_OPEN', meta: { pendingActionId: existing.id } }],
    );
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.adminPendingAction.create({
        data: {
          id: newId(),
          kind: request.kind,
          resourceType: request.resourceType,
          resourceId: request.resourceId,
          resourceLabel: request.resourceLabel.slice(0, 255),
          payloadJson: request.payload as Prisma.InputJsonValue,
          reason: request.reason.slice(0, 1000),
          pendingKey,
          requestedById: requester.userId,
          requestedByEmail: requester.email,
          requestedAt: new Date(),
        },
      });
      await recordAudit(
        {
          action: AuditAction.PENDING_ACTION_REQUESTED,
          resourceType: request.resourceType,
          resourceId: request.resourceId,
          actorType: 'ADMIN',
          actorUserId: requester.userId,
          actorEmail: requester.email,
          before: null,
          after: { pendingActionId: row.id, kind: request.kind, reason: request.reason, payload: request.payload },
          ipAddress: requester.ipAddress ?? null,
          correlationId: requester.correlationId ?? null,
        },
        tx,
      );
      return view(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict(ErrorCode.PENDING_ACTION_ALREADY_OPEN, 'A request for this action is already waiting for a second approver.');
    }
    throw error;
  }
}

export async function listPendingActions(filter: {
  status?: string | undefined;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
}): Promise<PendingActionView[]> {
  const rows = await prisma.adminPendingAction.findMany({
    where: {
      ...(filter.status === undefined ? {} : { status: filter.status as AdminPendingAction['status'] }),
      ...(filter.resourceType === undefined ? {} : { resourceType: filter.resourceType }),
      ...(filter.resourceId === undefined ? {} : { resourceId: filter.resourceId }),
    },
    orderBy: { requestedAt: 'desc' },
    take: 200,
  });
  return rows.map(view);
}

async function loadOpen(id: string): Promise<AdminPendingAction> {
  const row = await prisma.adminPendingAction.findUnique({ where: { id } });
  if (row === null) throw notFound('Pending action');
  if (row.status !== 'PENDING') {
    throw conflict(ErrorCode.PENDING_ACTION_NOT_OPEN, 'This request has already been decided.', [
      { code: 'NOT_OPEN', meta: { status: row.status } },
    ]);
  }
  return row;
}

/**
 * Close a request, conditionally on it still being PENDING.
 *
 * The conditional update is the race guard: two approvers pressing at once
 * both read PENDING, and exactly one of them changes a row.
 */
async function close(
  row: AdminPendingAction,
  data: { status: AdminPendingAction['status']; decidedById: string; decidedByEmail: string; decisionNote: string | null },
): Promise<void> {
  const result = await prisma.adminPendingAction.updateMany({
    where: { id: row.id, status: 'PENDING' },
    data: { ...data, decidedAt: new Date(), pendingKey: null },
  });
  if (result.count !== 1) {
    throw conflict(ErrorCode.PENDING_ACTION_NOT_OPEN, 'Another member of staff decided this request first.');
  }
}

/**
 * Rejecting a seller application is a verification decision, and those belong
 * to the Audit Team. A request queued before that change cannot be approved
 * into a rejection from the Admin Panel; the Audit Team decides the
 * application in the Audit Console. The request can still be declined.
 */
function refuseSellerReject(): never {
  throw forbidden(
    ErrorCode.SELLER_VERIFICATION_AUDIT_ONLY,
    'Rejecting a seller application is decided by the Audit Team in the Audit Console.',
  );
}

/** Approve a request and run the action. The asker may not approve their own. */
export async function approvePendingAction(id: string, approver: StaffActor, note: string | null): Promise<PendingActionView> {
  const row = await loadOpen(id);
  if (row.requestedById === approver.userId) {
    throw forbidden(
      ErrorCode.PENDING_ACTION_SAME_APPROVER,
      'You asked for this action, so a different member of staff has to approve it.',
    );
  }
  if (!approver.permissions.includes(PENDING_ACTION_PERMISSION[row.kind])) {
    throw forbidden();
  }
  // Refused before the request is closed, so it stays open to be declined
  // rather than being marked approved with nothing done.
  if (row.kind === 'SELLER_REJECT') refuseSellerReject();
  await close(row, { status: 'APPROVED', decidedById: approver.userId, decidedByEmail: approver.email, decisionNote: note });

  let failure: unknown = null;
  try {
    await execute(view(row), approver);
  } catch (error) {
    failure = error;
  }

  const failureMessage =
    failure === null ? null : isAppError(failure) ? failure.message : 'The action could not be completed.';
  const after = await prisma.adminPendingAction.update({
    where: { id: row.id },
    data: failure === null ? {} : { status: 'FAILED', failureMessage: failureMessage?.slice(0, 1000) ?? null },
  });

  await recordAudit({
    action: AuditAction.PENDING_ACTION_APPROVED,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    actorType: 'ADMIN',
    actorUserId: approver.userId,
    actorEmail: approver.email,
    before: { pendingActionId: row.id, status: 'PENDING', requestedBy: row.requestedByEmail },
    after: { pendingActionId: row.id, kind: row.kind, status: after.status, note, failureMessage },
    ipAddress: approver.ipAddress ?? null,
    correlationId: approver.correlationId ?? null,
  });

  if (failure !== null) throw failure instanceof Error ? failure : new Error('The action could not be completed.');
  return view(after);
}

/** Reject a request. The asker rejecting their own request withdraws it. */
export async function rejectPendingAction(id: string, actor: StaffActor, note: string | null): Promise<PendingActionView> {
  const row = await loadOpen(id);
  const own = row.requestedById === actor.userId;
  if (!own && !actor.permissions.includes(PENDING_ACTION_PERMISSION[row.kind])) throw forbidden();

  await close(row, {
    status: own ? 'CANCELLED' : 'REJECTED',
    decidedById: actor.userId,
    decidedByEmail: actor.email,
    decisionNote: note,
  });

  await recordAudit({
    action: own ? AuditAction.PENDING_ACTION_CANCELLED : AuditAction.PENDING_ACTION_REJECTED,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: { pendingActionId: row.id, status: 'PENDING' },
    after: { pendingActionId: row.id, kind: row.kind, status: own ? 'CANCELLED' : 'REJECTED', note },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  const fresh = await prisma.adminPendingAction.findUniqueOrThrow({ where: { id: row.id } });
  return view(fresh);
}

/** How many requests are open, and the oldest one's age, for the exception queues. */
export async function openPendingActionStats(): Promise<{ count: number; oldest: Date | null }> {
  const [count, oldest] = await Promise.all([
    prisma.adminPendingAction.count({ where: { status: 'PENDING' } }),
    prisma.adminPendingAction.findFirst({ where: { status: 'PENDING' }, orderBy: { requestedAt: 'asc' }, select: { requestedAt: true } }),
  ]);
  return { count, oldest: oldest?.requestedAt ?? null };
}
