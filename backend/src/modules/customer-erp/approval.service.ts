/**
 * Asking somebody before writing to their ERP.
 *
 * Two reasons a write waits: the purchase order is at or above the
 * organisation's threshold, or the policy requires a person for stock writes.
 * Both are raised by `pipeline.service.ts` at dispatch time, before a single
 * byte goes anywhere, and the event that raised one holds at SKIPPED naming it.
 *
 * APPROVING RE-QUEUES THE SAME EVENT
 *
 * The same row, under the same idempotency key. That is what stops an approval
 * producing a second purchase order: if the write had somehow already reached
 * the ERP, the key is recognised on their side, or `erpReference` on the event
 * has already been set and the pipeline sees the work is done.
 *
 * REJECTING IS FINAL FOR THAT EVENT
 *
 * Not a deferral. The event stays SKIPPED and the approval stays REJECTED, so
 * the next dispatch attempt - if something re-queues it - finds a decided
 * approval and stops rather than asking again. Somebody who changes their mind
 * raises a new purchase order, which is a new decision with a new record of who
 * made it.
 *
 * EXPIRY IS A DECISION TOO
 *
 * An approval nobody decides expires, and the write does not happen. The
 * alternative - waiting for ever - means a purchase order appearing in a
 * buyer's SAP three weeks late, against prices and stock that have moved.
 */
import { env } from '../../config/env.js';
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { recordOrgAudit, SYSTEM_ACTOR, type OrgActor } from './audit.service.js';
import { requeueEvent } from './event.service.js';
import { assertCapability, type Membership } from './organization.service.js';

export interface ApprovalView {
  id: string;
  connectionId: string;
  kind: 'PURCHASE_ORDER' | 'INVENTORY_WRITE';
  state: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  syncEventId: string;
  orderId: string | null;
  /** Minor units, as a string. Never a number - see CLAUDE.md. */
  amountMinor: string | null;
  currency: string | null;
  summary: string;
  requestedAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

export async function listApprovals(
  membership: Membership,
  options: { connectionId?: string | null; pendingOnly?: boolean; limit?: number } = {},
): Promise<ApprovalView[]> {
  assertCapability(membership, 'VIEW');

  const rows = await prisma.customerErpApproval.findMany({
    where: {
      organizationId: membership.organizationId,
      ...(options.connectionId === null || options.connectionId === undefined
        ? {}
        : { connectionId: options.connectionId }),
      ...(options.pendingOnly === true ? { state: 'PENDING' } : {}),
    },
    orderBy: { requestedAt: 'desc' },
    take: Math.min(Math.max(options.limit ?? 50, 1), 100),
  });

  return rows.map(toView);
}

/**
 * Approve or decline.
 *
 * `OPERATE` rather than `CONFIGURE`, deliberately. Deciding whether a purchase
 * order over the threshold may go is a purchasing judgement, not a
 * configuration change, and a buyer may reasonably want somebody who can make
 * that call without also being able to repoint the connection at a different
 * SAP system.
 */
export async function decideApproval(
  membership: Membership,
  actor: OrgActor,
  approvalId: string,
  decision: 'APPROVED' | 'REJECTED',
  note: string | null,
): Promise<ApprovalView> {
  assertCapability(membership, 'OPERATE');

  const approval = await prisma.customerErpApproval.findFirst({
    where: { id: approvalId, organizationId: membership.organizationId },
  });

  if (approval === null) throw notFound('Approval');

  if (approval.state !== 'PENDING') {
    throw conflict(
      ErrorCode.CUSTOMER_ERP_STATE_INVALID,
      approval.state === 'EXPIRED'
        ? 'This expired before anybody decided, so it can no longer be approved.'
        : 'Somebody has already decided this.',
    );
  }

  if (approval.expiresAt.getTime() <= Date.now()) {
    // Expired between the screen rendering and the button being pressed. Marked
    // now rather than treated as still open, because the write it guards is one
    // whose prices and stock have moved on.
    await prisma.customerErpApproval.update({
      where: { id: approvalId },
      data: { state: 'EXPIRED' },
    });

    throw conflict(
      ErrorCode.CUSTOMER_ERP_STATE_INVALID,
      'This expired before it could be decided. Nothing was sent.',
    );
  }

  // A conditional update, so two approvers pressing the button together produce
  // one decision rather than two - and, more to the point, one re-queued event
  // rather than two.
  const claimed = await prisma.customerErpApproval.updateMany({
    where: { id: approvalId, state: 'PENDING' },
    data: {
      state: decision,
      decidedAt: new Date(),
      decidedByProfileId: membership.customerProfileId,
      decisionNote: note?.slice(0, 512) ?? null,
    },
  });

  if (claimed.count === 0) {
    throw conflict(
      ErrorCode.CUSTOMER_ERP_STATE_INVALID,
      'Somebody decided this a moment before you did.',
    );
  }

  if (decision === 'APPROVED') {
    // The SAME event, the SAME idempotency key. See this file's header.
    await requeueEvent(approval.syncEventId, membership.organizationId, actor).catch(
      (error: unknown) => {
        // The decision stands. An event that could not be re-queued is visible
        // in the log as skipped with an approved approval against it, which is
        // a state somebody can act on - and failing the decision here would
        // leave the approval pending with a note saying it was approved.
        logger.error(
          { err: error, approvalId, eventId: approval.syncEventId },
          'approved a buyer ERP write but could not re-queue its event',
        );
      },
    );
  }

  await recordOrgAudit({
    organizationId: membership.organizationId,
    connectionId: approval.connectionId,
    action: 'approval.decided',
    resourceType: 'approval',
    resourceId: approvalId,
    actor,
    before: { state: 'PENDING' },
    after: { state: decision, note: note?.slice(0, 255) ?? null, summary: approval.summary },
  });

  const updated = await prisma.customerErpApproval.findUnique({ where: { id: approvalId } });

  if (updated === null) throw notFound('Approval');

  return toView(updated);
}

/**
 * Close out approvals nobody decided.
 *
 * Runs on the maintenance beat. The event stays SKIPPED, so nothing is sent -
 * which is the conservative outcome and the only honest one: a purchase order
 * released three weeks late, against prices and stock that have moved, is worse
 * than one that never went.
 */
export async function expireStaleApprovals(): Promise<number> {
  if (!env.FEATURE_CUSTOMER_ERP) return 0;

  const stale = await prisma.customerErpApproval.findMany({
    where: { state: 'PENDING', expiresAt: { lt: new Date() } },
    take: 200,
    select: { id: true, organizationId: true, connectionId: true, summary: true },
  });

  if (stale.length === 0) return 0;

  await prisma.customerErpApproval.updateMany({
    where: { id: { in: stale.map((row) => row.id) } },
    data: { state: 'EXPIRED' },
  });

  for (const row of stale) {
    await recordOrgAudit({
      organizationId: row.organizationId,
      connectionId: row.connectionId,
      action: 'approval.decided',
      resourceType: 'approval',
      resourceId: row.id,
      actor: SYSTEM_ACTOR,
      after: { state: 'EXPIRED', summary: row.summary },
    });
  }

  return stale.length;
}

function toView(row: {
  id: string;
  connectionId: string;
  kind: string;
  state: string;
  syncEventId: string;
  orderId: string | null;
  amountMinor: bigint | null;
  currency: string | null;
  summary: string;
  requestedAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
}): ApprovalView {
  return {
    id: row.id,
    connectionId: row.connectionId,
    kind: row.kind as ApprovalView['kind'],
    state: row.state as ApprovalView['state'],
    syncEventId: row.syncEventId,
    orderId: row.orderId,
    // A string, always. `BigInt` does not survive `JSON.stringify`, and a
    // `Number` above 2^53 does not survive being a total.
    amountMinor: row.amountMinor?.toString() ?? null,
    currency: row.currency,
    summary: row.summary,
    requestedAt: row.requestedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
  };
}

/** Used by the wizard when it needs a fresh id for a synthetic approval. */
export function newApprovalId(): string {
  return newId();
}
