/**
 * Reading a buyer's ERP on a schedule, for the ones with no webhooks.
 *
 * Which is most of them. An on-premise SAP behind a Cloud Connector, an
 * in-house API written in 2014, a monday board nobody has attached an
 * automation to - none of these will call us, so we ask.
 *
 * INCREMENTAL, WITH A CURSOR
 *
 * `pollCursor` on the connection is where the last complete pass got to, and it
 * is opaque: a page number, an offset, an OData delta link, whatever the
 * connector's paging style means by it. The important property is that it is
 * written back ONLY when a pass finishes cleanly. A cursor advanced by a run
 * that failed halfway is how records get skipped for ever, and nobody notices
 * until a stock figure has been wrong for a month.
 *
 * WHAT A POLL MAY AND MAY NOT DO
 *
 * It reads. It records what the ERP believes in
 * `customer_erp_inventory_links`, and it records a divergence where the two
 * systems disagree. It does not write `inventory_balances` - that is the
 * operator's own stock ledger, moved only by a person through the Inventory
 * screens with a reason and an actor against it - and it never moves on-hand
 * except through a goods receipt, which is `pipeline.service.ts`'s rule and not
 * something this file can go around.
 *
 * RATE LIMITS
 *
 * A 429 stops the pass where it is, keeps what was already applied, and defers
 * the next one by exactly as long as the ERP asked for. Not a failure: what was
 * processed is applied and the rest is taken next time. An ERP that says "wait
 * 300 seconds" and gets another request in five has been told by our behaviour
 * that its rate limiting does not work.
 */
import { env } from '../../config/env.js';
import { newId } from '../../infra/ids.js';
import { loggerFor } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { carriesTraffic } from '../../domain/customer-erp-state.js';
import { recordOrgAudit, SYSTEM_ACTOR, type OrgActor } from './audit.service.js';
import { loadConnectorContext } from './connectors/index.js';
import { ErpCallError, safeErrorMessage } from './http.js';
import { applyInboundEvent } from './pipeline.service.js';
import { assertCapability, type Membership } from './organization.service.js';

/** Pages read in one pass, however many records the ERP puts in each. */
const MAX_PAGES = 25;

export interface SyncOutcome {
  jobId: string;
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'RATE_LIMITED';
  processed: number;
  applied: number;
  skipped: number;
  failed: number;
  message: string;
}

/**
 * One pass over a connection's inventory feed.
 *
 * Shared by the scheduled poll and the buyer's own "Sync now", because they are
 * the same operation started for different reasons - and two implementations of
 * "read their stock" is how the manual one and the automatic one come to
 * disagree about what a cursor means.
 */
export async function runInventorySync(input: {
  connectionId: string;
  organizationId: string;
  trigger: 'MANUAL' | 'SCHEDULED' | 'RETRY';
  correlationId: string;
  startedByProfileId?: string | null;
}): Promise<SyncOutcome> {
  const log = loggerFor(input.correlationId, { connectionId: input.connectionId });

  const connection = await prisma.customerErpConnection.findFirst({
    where: {
      id: input.connectionId,
      organizationId: input.organizationId,
      deletedAt: null,
    },
  });

  if (connection === null) {
    return {
      jobId: '',
      status: 'FAILED',
      processed: 0,
      applied: 0,
      skipped: 0,
      failed: 0,
      message: 'That connection no longer exists.',
    };
  }

  if (!carriesTraffic(connection.state)) {
    return {
      jobId: '',
      status: 'FAILED',
      processed: 0,
      applied: 0,
      skipped: 0,
      failed: 0,
      message: 'This connection is not switched on, so nothing was read.',
    };
  }

  /*
   * Nothing may be read from a connection that only sends.
   *
   * `savePolicy` refuses the contradiction at the door, so this is the second
   * line rather than the first - but it is the line that matters, because it is
   * the one standing between a policy that got into this state by any route and
   * a real call to a buyer's ERP whose answer would then be discarded. Told
   * plainly, as a failure with the reason, rather than reported as a successful
   * sync that recorded nothing.
   */
  const policy = await prisma.customerErpSyncPolicy.findUnique({
    where: { connectionId: connection.id },
    select: { mode: true, syncInventory: true },
  });

  if (policy === null || policy.mode === 'OUTBOUND' || !policy.syncInventory) {
    return {
      jobId: '',
      status: 'FAILED',
      processed: 0,
      applied: 0,
      skipped: 0,
      failed: 0,
      message:
        policy !== null && policy.mode === 'OUTBOUND'
          ? 'This connection is set to send only, so nothing can be read back from it.'
          : 'Stock syncing is switched off on this connection.',
    };
  }

  const jobId = newId();

  await prisma.customerErpSyncJob.create({
    data: {
      id: jobId,
      connectionId: connection.id,
      organizationId: connection.organizationId,
      trigger: input.trigger,
      status: 'RUNNING',
      correlationId: input.correlationId,
      startedByProfileId: input.startedByProfileId ?? null,
    },
  });

  let processed = 0;
  let applied = 0;
  let skipped = 0;
  let failed = 0;
  let cursor = connection.pollCursor;
  let rateLimitedUntil: Date | null = null;
  let errorMessage: string | null = null;
  let errorCode: string | null = null;

  try {
    const { connector, context } = await loadConnectorContext({
      connectionId: connection.id,
      organizationId: connection.organizationId,
    });

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await connector.readInventory(context, cursor);

      processed += result.records.length;

      if (result.records.length > 0) {
        const outcome = await applyInboundEvent({
          connectionId: connection.id,
          organizationId: connection.organizationId,
          correlationId: input.correlationId,
          event: { kind: 'INVENTORY', records: result.records },
        });

        /*
         * The records that were RECORDED, not the page that contained them.
         *
         * A page is applied when anything in it matched, so counting the whole
         * page as applied reported a sync that recorded one product as having
         * recorded a hundred. `count` is the real figure where the handler
         * knows it; a single-subject event has no count and is worth its own
         * records.
         */
        const recorded = outcome.applied ? (outcome.count ?? result.records.length) : 0;

        applied += recorded;
        skipped += result.records.length - recorded;
      }

      cursor = result.nextCursor;

      if (cursor === null) break;

      // A ceiling on how long one worker slot is held, not a business rule. A
      // feed longer than this is picked up where it left off next pass, which
      // the cursor makes free.
      if (processed >= env.CUSTOMER_ERP_MAX_SYNC_RECORDS) break;
    }
  } catch (error) {
    const callError = error instanceof ErpCallError ? error : null;

    if (callError?.kind === 'RATE_LIMIT') {
      // Not a failure. What was processed is applied, the cursor stays where
      // the last complete page left it, and the next pass waits exactly as long
      // as we were told to.
      rateLimitedUntil = new Date(
        Date.now() + (callError.retryAfterSeconds ?? 300) * 1000,
      );
    } else {
      failed = Math.max(1, processed - applied - skipped);
      errorCode = callError?.kind ?? 'UNKNOWN';
      errorMessage = safeErrorMessage(error);

      log.warn({ err: error }, 'a buyer ERP inventory sync failed');
    }
  }

  const status: SyncOutcome['status'] =
    rateLimitedUntil !== null
      ? 'RATE_LIMITED'
      : errorMessage !== null
        ? processed > 0
          ? 'PARTIAL'
          : 'FAILED'
        : 'SUCCEEDED';

  await prisma.customerErpSyncJob.update({
    where: { id: jobId },
    data: {
      status,
      finishedAt: new Date(),
      processedCount: processed,
      succeededCount: applied,
      skippedCount: skipped,
      failedCount: failed,
      rateLimitedUntil,
      cursorAfter: cursor,
      errorCode,
      errorMessage: errorMessage?.slice(0, 1024) ?? null,
    },
  });

  await prisma.customerErpConnection.update({
    where: { id: connection.id },
    data: {
      lastPolledAt: new Date(),
      // **Only on a clean pass.** See this file's header: a cursor advanced by
      // a run that failed halfway skips records for ever.
      ...(status === 'SUCCEEDED' ? { pollCursor: cursor } : {}),
      ...(connection.pollingEnabled
        ? {
            nextPollAt:
              rateLimitedUntil ??
              new Date(Date.now() + connection.pollingIntervalMinutes * 60 * 1000),
          }
        : {}),
      ...(status === 'SUCCEEDED'
        ? { lastSuccessAt: new Date(), consecutiveFailures: 0 }
        : status === 'FAILED'
          ? { lastFailureAt: new Date(), consecutiveFailures: { increment: 1 } }
          : {}),
    },
  });

  await recordOrgAudit({
    organizationId: connection.organizationId,
    connectionId: connection.id,
    action: 'sync.finished',
    resourceType: 'sync_job',
    resourceId: jobId,
    actor: { ...SYSTEM_ACTOR, correlationId: input.correlationId },
    after: { status, processed, applied, skipped, failed, trigger: input.trigger },
  });

  return {
    jobId,
    status,
    processed,
    applied,
    skipped,
    failed,
    message:
      status === 'SUCCEEDED'
        ? `Read ${processed} records from your system and recorded ${applied}.`
        : status === 'RATE_LIMITED'
          ? `Your system asked us to slow down. ${applied} records were recorded and the ` +
            'rest will be taken on the next pass.'
          : status === 'PARTIAL'
            ? `Recorded ${applied} records, then stopped: ${errorMessage ?? 'unknown'}`
            : (errorMessage ?? 'The sync did not complete.'),
  };
}

/**
 * The scheduled sweep.
 *
 * One indexed query finds what is due - ACTIVE, polling on, `nextPollAt` in the
 * past - so a pass with nothing to do costs almost nothing. `nextPollAt` is
 * claimed before the work starts, so two workers running the sweep together do
 * not poll the same buyer's ERP twice.
 */
export async function pollDueConnections(limit = 10): Promise<{ polled: number }> {
  if (!env.FEATURE_CUSTOMER_ERP) return { polled: 0 };

  const now = new Date();

  const due = await prisma.customerErpConnection.findMany({
    where: {
      state: 'ACTIVE',
      pollingEnabled: true,
      deletedAt: null,
      nextPollAt: { lte: now },
    },
    orderBy: { nextPollAt: 'asc' },
    take: limit,
    select: { id: true, organizationId: true, nextPollAt: true, pollingIntervalMinutes: true },
  });

  let polled = 0;

  for (const connection of due) {
    // Claim it. A conditional update on the `nextPollAt` we read, so the loser
    // of a race moves on rather than polling the same ERP a second time -
    // MariaDB 10.4 has no `SKIP LOCKED`, so this is the shape available.
    const claimed = await prisma.customerErpConnection.updateMany({
      where: { id: connection.id, nextPollAt: connection.nextPollAt },
      data: {
        nextPollAt: new Date(now.getTime() + connection.pollingIntervalMinutes * 60 * 1000),
      },
    });

    if (claimed.count === 0) continue;

    await runInventorySync({
      connectionId: connection.id,
      organizationId: connection.organizationId,
      trigger: 'SCHEDULED',
      correlationId: newId(),
    });

    polled += 1;
  }

  return { polled };
}

/** "Sync now", from the dashboard. */
export async function syncNow(
  membership: Membership,
  actor: OrgActor,
  connectionId: string,
): Promise<SyncOutcome> {
  assertCapability(membership, 'OPERATE');

  // One at a time per connection. A buyer pressing the button twice should not
  // produce two passes reading the same cursor and applying the same records.
  const running = await prisma.customerErpSyncJob.count({
    where: { connectionId, status: 'RUNNING', startedAt: { gt: new Date(Date.now() - 600_000) } },
  });

  if (running > 0) {
    return {
      jobId: '',
      status: 'FAILED',
      processed: 0,
      applied: 0,
      skipped: 0,
      failed: 0,
      message: 'A sync is already running on this connection.',
    };
  }

  return runInventorySync({
    connectionId,
    organizationId: membership.organizationId,
    trigger: 'MANUAL',
    correlationId: actor.correlationId ?? newId(),
    startedByProfileId: membership.customerProfileId,
  });
}

// ---------------------------------------------------------------------------
// Reading jobs back
// ---------------------------------------------------------------------------

export interface SyncJobView {
  id: string;
  connectionId: string;
  trigger: string;
  status: string;
  isDryRun: boolean;
  startedAt: string;
  finishedAt: string | null;
  processedCount: number;
  succeededCount: number;
  skippedCount: number;
  failedCount: number;
  errorMessage: string | null;
  correlationId: string;
}

export async function listSyncJobs(
  organizationId: string,
  connectionId: string | null,
  limit: number,
): Promise<SyncJobView[]> {
  const rows = await prisma.customerErpSyncJob.findMany({
    where: { organizationId, ...(connectionId === null ? {} : { connectionId }) },
    orderBy: { startedAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 50),
  });

  return rows.map((row) => ({
    id: row.id,
    connectionId: row.connectionId,
    trigger: row.trigger,
    status: row.status,
    isDryRun: row.isDryRun,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    processedCount: row.processedCount,
    succeededCount: row.succeededCount,
    skippedCount: row.skippedCount,
    failedCount: row.failedCount,
    errorMessage: row.errorMessage,
    correlationId: row.correlationId,
  }));
}
