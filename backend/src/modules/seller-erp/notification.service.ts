/**
 * Telling a seller their books have stopped being updated.
 *
 * WHY THESE ARE ALERTS AND NOT NEWS
 *
 * An offline bridge and an unmatched ledger are both STILL TRUE however many
 * people have read about them. Every order confirmed since is sitting in a
 * queue, and the seller's accounts are quietly falling behind. A notice that
 * could be dismissed by glancing at it would let somebody clear the bell and
 * leave the problem, which is how a month of sales goes missing from a set of
 * books nobody was watching.
 *
 * So they carry `class: 'ALERT'` and a `resolutionKey` naming the PROBLEM
 * rather than the event: one key per connection, so a bridge that has gone
 * offline three times has one open alert, and the machine coming back closes
 * all of them.
 *
 * WHY THE FAILURE NOTICE IS GROUPED
 *
 * A laptop going to sleep fails every queued job at once. Forty notifications
 * is a bell somebody switches off; one notification saying forty is a thing
 * they act on. The grouping happens in the maintenance pass and the count
 * arrives here already made.
 */
import { prisma } from '../../infra/prisma.js';
import { notifySeller, notifySellerOnce } from '../seller/notification.service.js';

/**
 * The key that identifies one connection's health PROBLEM.
 *
 * Shared by every alert about that connection, so the recovery closes all of
 * them at once. Keyed on the connection and not on the device, because a
 * seller who replaces the PC has the same problem with a different machine
 * until the new one pairs.
 */
export function erpConnectionAlertKey(connectionId: string): string {
  return `seller-erp-connection:${connectionId}`;
}

/** The Tally bridge has stopped checking in. */
export async function notifyBridgeOffline(input: {
  sellerAccountId: string;
  connectionId: string;
  connectionName: string;
}): Promise<void> {
  await notifySellerOnce({
    sellerAccountId: input.sellerAccountId,
    kind: 'ERP_BRIDGE_OFFLINE',
    title: 'TallyPrime has stopped answering',
    body:
      `The Glovia Tally Bridge for "${input.connectionName}" has not checked in. ` +
      'Orders are still being recorded and will post when the machine is back on and TallyPrime is open.',
    linkPath: '/seller/integrations',
    severity: 'WARNING',
    class: 'ALERT',
    resolutionKey: erpConnectionAlertKey(input.connectionId),
    subjectType: 'seller_erp_connection',
    subjectId: input.connectionId,
    /*
     * Six hours rather than the default day.
     *
     * Long enough that a machine switched off overnight produces one notice
     * and not two; short enough that a seller who has been offline for three
     * days and missed the first one is reminded. The body says nothing is
     * lost, because nothing is - the queue is what makes that true.
     */
    withinMs: 6 * 60 * 60 * 1000,
  });
}

/** Something a sync needs has not been matched to Tally. */
export async function notifyMappingIncomplete(input: {
  sellerAccountId: string;
  connectionId: string;
  missingCount: number;
}): Promise<void> {
  await notifySellerOnce({
    sellerAccountId: input.sellerAccountId,
    kind: 'ERP_MAPPING_INCOMPLETE',
    title: 'Some things still need matching to Tally',
    body:
      `${String(input.missingCount)} ${input.missingCount === 1 ? 'item has' : 'items have'} not been matched to anything in TallyPrime. ` +
      'Nothing will post until they are.',
    linkPath: '/seller/integrations',
    severity: 'WARNING',
    class: 'ALERT',
    resolutionKey: erpConnectionAlertKey(input.connectionId),
    subjectType: 'seller_erp_connection',
    subjectId: input.connectionId,
  });
}

/**
 * Events that have run out of retries.
 *
 * The one thing in this feature a seller must be TOLD about rather than left
 * to find: a dead-lettered accounting event is a sale missing from their
 * books, and the ERP screen is not somewhere anybody looks weekly.
 */
export async function notifySyncFailed(input: {
  sellerAccountId: string;
  connectionId: string;
  failedCount: number;
}): Promise<void> {
  await notifySellerOnce({
    sellerAccountId: input.sellerAccountId,
    kind: 'ERP_SYNC_FAILURE',
    title:
      input.failedCount === 1
        ? 'An accounting entry could not be sent to Tally'
        : `${String(input.failedCount)} accounting entries could not be sent to Tally`,
    body:
      'They have been kept and can be sent again once the cause is fixed. ' +
      'Open the integration screen to see what TallyPrime said about each one.',
    linkPath: '/seller/integrations',
    severity: 'CRITICAL',
    class: 'ALERT',
    resolutionKey: erpConnectionAlertKey(input.connectionId),
    subjectType: 'seller_erp_connection',
    subjectId: input.connectionId,
    // An hour: a seller in the middle of fixing a mapping does not need this
    // repeated every minute, and one that has walked away should be reminded
    // within the working day.
    withinMs: 60 * 60 * 1000,
  });
}

/**
 * It is working again.
 *
 * Worth sending, and it is the half people forget. Somebody who was told their
 * books had stopped updating is entitled to be told they have started again -
 * without it, the only way to find out is to go and look, which is exactly
 * what the alert existed to save them from.
 *
 * Sent ONLY where there was an open alert to close. A connection that has
 * never failed does not get a "recovered" notice every time it syncs.
 */
export async function notifySyncRecovered(input: {
  sellerAccountId: string;
  connectionId: string;
  connectionName: string;
}): Promise<void> {
  const open = await prisma.sellerNotification.count({
    where: {
      sellerAccountId: input.sellerAccountId,
      resolutionKey: erpConnectionAlertKey(input.connectionId),
      resolvedAt: null,
    },
  });

  if (open === 0) return;

  await notifySeller({
    sellerAccountId: input.sellerAccountId,
    kind: 'ERP_SYNC_RECOVERED',
    title: 'TallyPrime is answering again',
    body: `"${input.connectionName}" is connected, and anything that was waiting is being sent.`,
    linkPath: '/seller/integrations',
    severity: 'SUCCESS',
    subjectType: 'seller_erp_connection',
    subjectId: input.connectionId,
  });
}

/** The one-off first run has finished. */
export async function notifyInitialSyncComplete(input: {
  sellerAccountId: string;
  connectionId: string;
  postedCount: number;
}): Promise<void> {
  await notifySeller({
    sellerAccountId: input.sellerAccountId,
    kind: 'ERP_INITIAL_SYNC_COMPLETE',
    title: 'The first sync to Tally has finished',
    body: `${String(input.postedCount)} entries were sent. New orders will now post as they happen.`,
    linkPath: '/seller/integrations',
    severity: 'SUCCESS',
    subjectType: 'seller_erp_connection',
    subjectId: input.connectionId,
    // The identity of the EVENT, so a maintenance pass that runs twice does
    // not announce the same completion twice.
    dedupeKey: `erp-initial-sync:${input.connectionId}`,
  });
}
