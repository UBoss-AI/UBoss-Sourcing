/**
 * Closing an account, from the customer's own side.
 *
 * Two different acts, and conflating them is the mistake this module exists to
 * prevent:
 *
 *   - **Deactivate** stops the account being used. Every session is revoked,
 *     nothing can sign in, and nothing is deleted. It is reversible by a member
 *     of staff, and the customer is told so.
 *   - **Delete** means erasure under Art. 17, which is not a DELETE statement
 *     and is not this module's job. It goes through `data-request.service.ts`
 *     like every other data-subject right, because it has to be assessed
 *     against the obligations that survive it — an unpaid order, an open
 *     return, an invoice a tax authority requires be kept for six to ten
 *     years. That path already exists, already refuses with a reason, and
 *     already tells the subject what was kept and why. The account screen
 *     raises a request on it and says plainly that it is a request.
 *
 * What deactivation must not do is leave money moving. A deactivated account
 * with an ACTIVE scheduled order and a live card mandate is a worker charging
 * somebody weeks after they closed their account — which is the single worst
 * outcome available here, and it happens by default unless this stops it. So
 * closing does three things in order, and each one goes through the service
 * that owns it rather than writing a status column:
 *
 *   1. Every active schedule is PAUSED via `pauseSchedule`, which asserts the
 *      transition. Paused rather than cancelled: cancelling is irreversible
 *      and the customer did not ask for it, and a reactivated account should
 *      find its arrangements waiting rather than gone.
 *   2. Auto-pay is disabled via `disableAutoPay`, which withdraws the stored
 *      consent and detaches the mandate at the provider.
 *   3. The user row goes to DEACTIVATED and every session is revoked.
 *
 * The password is required. Deactivation is destructive-feeling, one click
 * from a menu, and on a shared purchasing machine the person at the keyboard
 * is not reliably the account holder — so this asks for the one thing only the
 * holder has. It is the same reason the API refuses to take the customer's
 * word for who they are anywhere else.
 */
import { ErrorCode, badRequest, notFound, unauthorized } from '../../domain/errors.js';
import { verifyPassword } from '../../infra/crypto.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  NotificationEvent,
  dispatchPendingNotifications,
  enqueueNotification,
} from '../notifications/notification.service.js';
import { revokeAllUserSessions } from '../identity/session.service.js';
import { disableAutoPay } from '../payments/autopay.service.js';
import { pauseSchedule } from '../recurring/schedule.service.js';
import type { CustomerActor } from './customer.service.js';

/**
 * What closing this account would do, before it is done.
 *
 * Read by the confirmation dialog, so the warning names the customer's own
 * arrangements rather than describing the feature in general. "This will pause
 * 2 scheduled orders" is a sentence somebody can act on; "scheduled orders may
 * be affected" is one they scroll past.
 */
export interface ClosureImpact {
  /** Scheduled orders that would be paused. */
  activeScheduleCount: number;
  /** True when there is a standing authority to charge that would be withdrawn. */
  hasAutoPay: boolean;
  /** Orders still owing money. They survive closure and are still owed. */
  unpaidOrderCount: number;
}

export async function describeClosure(customerProfileId: string): Promise<ClosureImpact> {
  const [activeScheduleCount, autoPay, openOrders] = await Promise.all([
    prisma.recurringSchedule.count({ where: { customerProfileId, status: 'ACTIVE' } }),
    prisma.customerAutoPaySetting.findUnique({
      where: { customerProfileId },
      select: { status: true },
    }),
    // The same shape `findErasureBlockers` uses, and for the same reason:
    // Prisma cannot compare two columns of one row in a `where`, and this is
    // one customer's open orders rather than the whole book, so the comparison
    // happens here rather than in raw SQL against column names the schema is
    // free to change.
    prisma.order.findMany({
      where: {
        customerProfileId,
        status: { in: ['PENDING_PAYMENT', 'CONFIRMED', 'PROCESSING', 'SHIPPED'] },
      },
      select: { paidMinor: true, grandTotalMinor: true },
    }),
  ]);

  return {
    activeScheduleCount,
    hasAutoPay: autoPay !== null && autoPay.status !== 'DISABLED',
    // What matters for this warning is the orders still owing money, because
    // closing an account does not cancel them and the customer should not be
    // able to think it did.
    unpaidOrderCount: openOrders.filter((order) => order.paidMinor < order.grandTotalMinor).length,
  };
}

export interface DeactivateResult {
  schedulesPaused: number;
  autoPayWithdrawn: boolean;
  sessionsRevoked: number;
}

export async function deactivateOwnAccount(
  input: { userId: string; customerProfileId: string; password: string; reason: string | null },
  actor: CustomerActor,
): Promise<DeactivateResult> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: {
      id: true,
      email: true,
      passwordHash: true,
      status: true,
      customerProfile: { select: { fullName: true } },
    },
  });

  if (user === null) throw notFound('Account');

  if (user.status === 'DEACTIVATED') {
    throw badRequest(ErrorCode.ACCOUNT_DEACTIVATED, 'This account is already closed.');
  }

  /*
   * Re-authentication.
   *
   * An account with no password at all cannot be closed this way — it has
   * never been activated, so there is nothing to re-authenticate against, and
   * an unauthenticated close on such an account would be a way to lock
   * somebody out of an invitation they have not accepted yet.
   */
  if (user.passwordHash === null) {
    throw badRequest(
      ErrorCode.ACCOUNT_NOT_ACTIVATED,
      'This account has not been activated, so there is nothing to close.',
    );
  }

  if (!(await verifyPassword(user.passwordHash, input.password))) {
    throw unauthorized(ErrorCode.INVALID_CREDENTIALS, 'That password is not correct.');
  }

  const reason = input.reason ?? 'closed_by_customer';

  // --- 1. Stop anything that would charge them later ----------------------
  //
  // Read the ids, then pause them one at a time through the service that owns
  // the transition. Not a single `updateMany` on `status`: plan status is only
  // ever changed through the assertions in `domain/schedule-state.ts`, and a
  // bulk write here would be the second implementation of a state machine
  // whose whole purpose is that there is one.
  const activeSchedules = await prisma.recurringSchedule.findMany({
    where: { customerProfileId: input.customerProfileId, status: 'ACTIVE' },
    select: { id: true },
  });

  for (const schedule of activeSchedules) {
    await pauseSchedule(
      schedule.id,
      { userId: actor.userId, email: actor.email, type: 'CUSTOMER', ipAddress: actor.ipAddress ?? null, correlationId: actor.correlationId ?? null },
      input.customerProfileId,
      'account closed by customer',
    );
  }

  // --- 2. Withdraw the standing authority to charge -----------------------
  const autoPayBefore = await prisma.customerAutoPaySetting.findUnique({
    where: { customerProfileId: input.customerProfileId },
    select: { status: true },
  });
  const hadAutoPay = autoPayBefore !== null && autoPayBefore.status !== 'DISABLED';

  if (hadAutoPay) {
    await disableAutoPay({
      customerProfileId: input.customerProfileId,
      userId: actor.userId,
      email: actor.email,
      ipAddress: actor.ipAddress ?? null,
      correlationId: actor.correlationId ?? null,
    });
  }

  // --- 3. Close the account ------------------------------------------------
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { status: 'DEACTIVATED' } });

    await recordAudit(
      {
        action: AuditAction.CUSTOMER_STATUS_CHANGED,
        resourceType: 'customer',
        resourceId: input.customerProfileId,
        // CUSTOMER, not ADMIN. `setCustomerStatus` next door records the same
        // action with ADMIN, and the distinction is the whole value of the
        // entry: "who closed this account" has two very different answers.
        actorType: 'CUSTOMER',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { status: user.status },
        after: {
          status: 'DEACTIVATED',
          reason,
          schedulesPaused: activeSchedules.length,
          autoPayWithdrawn: hadAutoPay,
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  const sessionsRevoked = await revokeAllUserSessions(user.id, reason);

  /*
   * Told, as it happens.
   *
   * The address still works — closing an account does not erase it — and a
   * deactivation somebody did not ask for is something they need to hear about
   * while it can still be reversed. Enqueued after the commit, because a
   * notification for a rolled-back closure is a lie.
   */
  const summary = [
    activeSchedules.length > 0
      ? `${String(activeSchedules.length)} scheduled order(s) paused`
      : 'no scheduled orders were running',
    hadAutoPay ? 'automatic payment withdrawn' : 'automatic payment was not set up',
    `${String(sessionsRevoked)} session(s) signed out`,
  ].join('; ');

  await enqueueNotification({
    eventKey: NotificationEvent.USER_ACCOUNT_DEACTIVATED,
    recipientEmail: user.email,
    recipientName: user.customerProfile?.fullName ?? null,
    variables: { summary },
    relatedType: 'user',
    relatedId: user.id,
    correlationId: actor.correlationId ?? null,
  });

  await dispatchPendingNotifications();

  return {
    schedulesPaused: activeSchedules.length,
    autoPayWithdrawn: hadAutoPay,
    sessionsRevoked,
  };
}
