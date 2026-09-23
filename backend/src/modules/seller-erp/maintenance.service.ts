/**
 * The beat that keeps every seller's Tally connection honest.
 *
 * WHY ANY OF THIS IS NEEDED
 *
 * Almost everything in this feature happens because something ARRIVED - a
 * heartbeat, a task result, an order. The three failures below happen because
 * something did NOT, and nothing writes a row when something does not happen:
 *
 *   - A bridge dies mid-post. Its task sits IN_FLIGHT for ever and the
 *     seller's books quietly stop being updated.
 *   - A machine is switched off. No heartbeat arrives, and a status column
 *     written the last time one did keeps saying "Connected" over a PC that
 *     has been dark since Friday.
 *   - A pairing code is generated and never used. It is a live credential for
 *     its whole life, and nobody comes back to close it.
 *
 * So these are swept, on a beat, and each pass with nothing to do is a handful
 * of indexed queries that match no rows.
 */
import { env } from '../../config/env.js';
import { HEARTBEAT_FRESH_SECONDS } from '../../domain/seller-erp-state.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { refreshConnectionState } from './connection.service.js';
import { enqueueErpEvent, reapExpiredLeases } from './job.service.js';
import { notifyBridgeOffline, notifySyncFailed } from './notification.service.js';
import { buildOrderVoucher } from './payload.service.js';

export interface MaintenanceOutcome {
  releasedTasks: number;
  offlineBridges: number;
  expiredCodes: number;
  refreshedConnections: number;
}

/**
 * One pass.
 *
 * Returns immediately when the feature is off, so an installation with no
 * sellers using it pays one branch for the whole thing.
 */
export async function runSellerErpMaintenance(): Promise<MaintenanceOutcome> {
  if (!env.FEATURE_SELLER_ERP) {
    return { releasedTasks: 0, offlineBridges: 0, expiredCodes: 0, refreshedConnections: 0 };
  }

  const releasedTasks = await reapExpiredLeases();

  const now = new Date();
  const staleBefore = new Date(now.getTime() - HEARTBEAT_FRESH_SECONDS * 1000);

  /*
   * Devices that have stopped beating.
   *
   * Marked OFFLINE rather than revoked. The machine is almost always simply
   * switched off; its token is still good and it resumes the moment somebody
   * turns it on. Revoking would mean a seller re-pairing every Monday morning.
   */
  const { count: offlineBridges } = await prisma.sellerErpBridgeDevice.updateMany({
    where: {
      state: 'ACTIVE',
      OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { lt: staleBefore } }],
    },
    data: { state: 'OFFLINE' },
  });

  /*
   * Pairing codes nobody redeemed.
   *
   * Their `expiresAt` already makes them unusable - `redeemPairingCode` checks
   * it - so this is housekeeping rather than a security control. It exists so
   * the connection's state moves off AWAITING_PAIRING, which is the thing the
   * seller is looking at while they wonder why nothing is happening.
   */
  const expired = await prisma.sellerErpPairingCode.findMany({
    where: { consumedAt: null, expiresAt: { lt: now } },
    select: { connectionId: true },
    take: 500,
  });

  const connectionsWithExpiredCodes = [...new Set(expired.map((row) => row.connectionId))];

  for (const connectionId of connectionsWithExpiredCodes) {
    const stillPaired = await prisma.sellerErpBridgeDevice.count({
      where: { connectionId, state: { in: ['ACTIVE', 'OFFLINE'] } },
    });

    if (stillPaired > 0) continue;

    await prisma.sellerErpConnection.updateMany({
      where: { id: connectionId, state: 'AWAITING_PAIRING' },
      data: {
        state: 'PAIRING_EXPIRED',
        stateChangedAt: now,
        stateReason: 'The pairing code expired before any machine used it. Generate another.',
      },
    });
  }

  /*
   * Re-decide the state of every connection that is not switched off.
   *
   * Bounded, and the bound is honest: a deployment with more connections than
   * this gets the rest on the next beat, which is a minute away, and nothing
   * depends on all of them being refreshed in one pass. An unbounded loop here
   * is a maintenance job that grows with the business until it stops finishing
   * inside its own interval.
   */
  const connections = await prisma.sellerErpConnection.findMany({
    where: { disabledAt: null },
    orderBy: { updatedAt: 'asc' },
    take: 200,
    select: { id: true, state: true, sellerAccountId: true, name: true },
  });

  let refreshedConnections = 0;

  for (const connection of connections) {
    const state = await refreshConnectionState(connection.id);
    refreshedConnections += 1;

    /*
     * Told once, when it CHANGES.
     *
     * The transition is the news. A connection that has been offline for three
     * days is not three days' worth of notifications - it is one, sent when it
     * went down, and the seller's ERP screen says the rest. Notifying on every
     * pass is how a seller learns to ignore the bell.
     */
    if (state === 'BRIDGE_OFFLINE' && connection.state !== 'BRIDGE_OFFLINE') {
      await notifyBridgeOffline({
        sellerAccountId: connection.sellerAccountId,
        connectionId: connection.id,
        connectionName: connection.name,
      });
    }
  }

  if (releasedTasks > 0 || offlineBridges > 0 || connectionsWithExpiredCodes.length > 0) {
    logger.info(
      {
        releasedTasks,
        offlineBridges,
        expiredCodes: connectionsWithExpiredCodes.length,
        refreshedConnections,
      },
      'seller ERP housekeeping',
    );
  }

  return {
    releasedTasks,
    offlineBridges,
    expiredCodes: connectionsWithExpiredCodes.length,
    refreshedConnections,
  };
}

/**
 * Fill in the payloads a backfill deliberately left out, and raise the alarm
 * on events that have run out of retries.
 *
 * A backfill enqueues five hundred order events carrying only a reference,
 * because assembling five hundred vouchers inside the request that started it
 * would hold a connection open for a minute. This is where each one is
 * actually built - a few at a time, on a beat, so the work is spread rather
 * than dropped on one request.
 */
export async function runSellerErpDispatch(): Promise<{ built: number; alerted: number }> {
  if (!env.FEATURE_SELLER_ERP) return { built: 0, alerted: 0 };

  const pending = await prisma.sellerErpSyncJob.findMany({
    where: {
      status: 'PENDING',
      // The marker a backfill leaves. A job whose payload is already a voucher
      // is skipped by this query entirely.
      payloadJson: { path: '$.kind', equals: 'ORDER_BACKFILL' },
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
    select: { id: true, connectionId: true, eventType: true, sellerOrderGroupId: true },
  });

  let built = 0;

  for (const job of pending) {
    if (job.sellerOrderGroupId === null) continue;

    try {
      const payload = await buildOrderVoucher({
        connectionId: job.connectionId,
        sellerOrderGroupId: job.sellerOrderGroupId,
        voucherKind: job.eventType === 'SALES_INVOICE' ? 'SALES_INVOICE' : 'SALES_ORDER',
      });

      await prisma.sellerErpSyncJob.update({
        where: { id: job.id },
        data: { payloadJson: payload as never },
      });

      built += 1;
    } catch (error) {
      /*
       * A payload that cannot be built is a job that will never post.
       *
       * Almost always a missing mapping, and it is FAILED rather than
       * retried: the mapping will still be missing in thirty seconds, and
       * eight goes at it is noise that delays the moment the seller is told
       * which ledger to match. `isTransientFailure` draws the same line.
       */
      await prisma.sellerErpSyncJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          errorCode: 'PAYLOAD_BUILD_FAILED',
          sanitizedError:
            error instanceof Error ? error.message.slice(0, 1000) : 'The voucher could not be built.',
          completedAt: new Date(),
        },
      });
    }
  }

  /*
   * Events that have run out of road.
   *
   * A dead-lettered accounting event is a sale missing from somebody's books,
   * and it is the one thing in this feature a seller must be TOLD about rather
   * than left to find on a screen they may not open for a week.
   *
   * Grouped per connection and sent once, because forty failures from one
   * machine going to sleep is one problem and forty notifications is a bell
   * somebody switches off.
   */
  const dead = await prisma.sellerErpSyncJob.groupBy({
    by: ['sellerAccountId', 'connectionId'],
    where: {
      status: 'DEAD_LETTER',
      // Only what has newly died. Anything older has already been notified,
      // and re-notifying it every minute is the spam this grouping prevents.
      completedAt: { gte: new Date(Date.now() - 10 * 60 * 1000) },
    },
    _count: { _all: true },
  });

  for (const group of dead) {
    await notifySyncFailed({
      sellerAccountId: group.sellerAccountId,
      connectionId: group.connectionId,
      failedCount: group._count._all,
    });
  }

  return { built, alerted: dead.length };
}

/**
 * Ask Tally what it actually holds, and report where it disagrees with us.
 *
 * READS AND REPORTS. It does not repair anything, and that restraint is the
 * design: a reconciliation that corrected accounts on its own would be a
 * second thing writing to somebody's books without being asked, which is the
 * exact behaviour `autoCreateMasters` defaults to false to prevent.
 *
 * What it finds is the one failure the three duplicate guards cannot: a
 * voucher Tally committed and whose acknowledgement never reached us. Our job
 * says FAILED, Tally holds the voucher, and a retry would post a second copy.
 * The external reference is what makes that detectable.
 */
export async function runSellerErpReconcile(): Promise<{ checked: number; queued: number }> {
  if (!env.FEATURE_SELLER_ERP) return { checked: 0, queued: 0 };

  const connections = await prisma.sellerErpConnection.findMany({
    where: { disabledAt: null, state: { in: ['CONNECTED', 'CONNECTED_WITH_WARNINGS'] } },
    select: { id: true, sellerAccountId: true, companyName: true },
    take: 50,
  });

  let queued = 0;

  for (const connection of connections) {
    /*
     * A master pull is the cheapest thing that can answer the question.
     *
     * It refreshes the mapping cache - which is worth doing anyway, because a
     * ledger renamed in Tally is a mapping about to fail - and its
     * `lastSeenAt` timestamps are what make a stale master visible on the
     * mapping screen. A voucher-level reconciliation would need a report per
     * order and is not worth a seller's machine on a nightly beat.
     */
    const jobId = await enqueueErpEvent({
      connectionId: connection.id,
      sellerAccountId: connection.sellerAccountId,
      eventType: 'MASTER_PULL',
      sourceEntityType: 'seller_erp_connection',
      sourceEntityId: connection.id,
      payload: { kind: 'MASTER_PULL', companyName: connection.companyName },
      trigger: 'RECONCILE',
      // Once a day at most for the same connection, which is what makes this
      // safe to run on a frequent beat: the key changes only when the date
      // does, so every extra pass is a no-op at the unique index.
      discriminator: `reconcile:${new Date().toISOString().slice(0, 10)}`,
      maxAttempts: 1,
    });

    if (jobId !== null) queued += 1;

    await prisma.sellerErpConnection.update({
      where: { id: connection.id },
      data: { lastReconcileAt: new Date() },
    });
  }

  return { checked: connections.length, queued };
}
