/**
 * Job handlers.
 *
 * Each handler is the unit of retry. Two rules shape all of them:
 *
 *   1. Idempotent. A job can run twice - a lease expires mid-flight and the
 *      reaper hands it to another worker - so every handler must tolerate
 *      seeing work it already did.
 *   2. Errors are classified. A permanent failure (an unknown recipient, a
 *      deleted record) must not be retried five times; only transient failures
 *      earn a retry.
 */
import { email } from '../infra/email/index.js';
import { env } from '../config/env.js';
import { logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';
import { JobType, type ClaimedJob } from '../infra/queue/index.js';
import {
  NotificationEvent,
  enqueueNotification,
  loadOutboxRow,
  markNotificationFailed,
  markNotificationSent,
} from '../modules/notifications/notification.service.js';
import { sweepExpiredReservations } from '../modules/inventory/inventory.service.js';
import { expirePaymentLinks } from '../modules/payments/payment-link.service.js';
import { runSync } from '../modules/integrations/connector.service.js';
import { generateExport, markExportFailed } from '../modules/reports/export.service.js';
import {
  fulfilRequest,
  purgeExpiredBundles,
} from '../modules/privacy/data-request.service.js';
import { runRetentionSweeps } from '../modules/privacy/retention.service.js';
import {
  getFxRateSettings,
  refreshConvertedPrices,
} from '../modules/settings/fx-rate.service.js';
import {
  claimDueSchedules,
  expireActionRequiredOccurrences,
  materialiseOccurrences,
  retryFailedOccurrences,
  runOccurrence,
  sendUpcomingReminders,
} from '../modules/recurring/occurrence.service.js';
import { retryDueErpPushes } from '../modules/integrations/erp-order.service.js';
import { retryDueErpConnectionPushes } from '../modules/integrations/erp-push.service.js';
import { pollDueConnections } from '../modules/integrations/erp-inventory-sync.service.js';
import {
  findDueRetries,
  releaseEvent,
} from '../modules/integrations/integration-event.service.js';

/**
 * A failure that retrying cannot fix.
 *
 * Thrown for a missing record or an invalid recipient. The runner marks the job
 * dead immediately instead of burning five attempts on something that will
 * never succeed.
 */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export type JobHandler = (payload: unknown, job: ClaimedJob) => Promise<void>;

/**
 * Coerce a payload field to a display string.
 *
 * Returns the fallback for anything that is not already a primitive: a bare
 * `String(value)` on an object yields "[object Object]", which would then be
 * emailed to the Inventory Manager as the product name.
 */
function displayString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return value.toString();
  return fallback;
}

function displayNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return fallback;
}

function requireString(payload: unknown, key: string): string {
  if (typeof payload !== 'object' || payload === null || !(key in payload)) {
    throw new PermanentJobError(`Job payload is missing "${key}"`);
  }
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PermanentJobError(`Job payload field "${key}" is not a non-empty string`);
  }
  return value;
}

/**
 * Deliver one outbox row.
 *
 * The status guard is what makes this idempotent: a row already SENT is skipped
 * rather than emailed a second time, which matters most for payment links,
 * where a duplicate email is a duplicate invitation to pay.
 */
const sendNotification: JobHandler = async (payload) => {
  const outboxId = requireString(payload, 'outboxId');
  const row = await loadOutboxRow(outboxId);

  if (row === null) {
    throw new PermanentJobError(`Outbox row ${outboxId} no longer exists`);
  }

  if (row.status === 'SENT') {
    logger.debug({ outboxId }, 'notification already sent; skipping');
    return;
  }

  if (row.status === 'DEAD' || row.status === 'SUPPRESSED') {
    logger.debug({ outboxId, status: row.status }, 'notification not eligible for delivery');
    return;
  }

  if (row.recipientEmail === null || row.recipientEmail.length === 0) {
    throw new PermanentJobError(`Outbox row ${outboxId} has no recipient`);
  }

  try {
    const result = await email.send({
      to: row.recipientEmail,
      ...(row.recipientName !== null ? { toName: row.recipientName } : {}),
      subject: row.subject,
      text: row.body,
    });

    await markNotificationSent(outboxId, result);
    logger.info({ outboxId, eventKey: row.eventKey }, 'notification sent');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown email error';
    // Records the attempt and schedules the next one. Re-thrown so the queue
    // also accounts for the failure.
    await markNotificationFailed(outboxId, message, email.name);
    throw error;
  }
};

/**
 * Release reservations whose lease expired.
 *
 * Without this, an abandoned checkout holds stock away from paying customers
 * until somebody notices.
 */
const sweepReservations: JobHandler = async () => {
  const result = await sweepExpiredReservations();
  if (result.released > 0) {
    logger.info({ released: result.released }, 'released expired stock reservations');
  }
};

/** Turn a low-stock event into a notification for the Inventory Manager. */
const lowStockCheck: JobHandler = async (payload) => {
  const productId = requireString(payload, 'productId');
  const data = payload as Record<string, unknown>;

  const setting = await prisma.notificationSetting.findUnique({
    where: { eventKey: NotificationEvent.INVENTORY_LOW_STOCK },
  });

  // Recipients are configured per event; with none set there is nobody to tell,
  // and the alert is dropped rather than guessed at.
  const recipients =
    setting?.internalRecipientsJson !== null && Array.isArray(setting?.internalRecipientsJson)
      ? (setting.internalRecipientsJson as unknown[]).filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [];

  if (recipients.length === 0) {
    logger.warn(
      { productId, sku: data['sku'] },
      'low stock detected but no internal recipients are configured for inventory.low_stock',
    );
    return;
  }

  for (const recipient of recipients) {
    await enqueueNotification({
      eventKey: NotificationEvent.INVENTORY_LOW_STOCK,
      recipientEmail: recipient,
      variables: {
        sku: displayString(data['sku']),
        productName: displayString(data['productName'], 'Unknown product'),
        availableQty: displayNumber(data['availableQty']),
        threshold: displayNumber(data['threshold']),
      },
      dedupeKey: `low_stock_mail:${productId}:${recipient}:${new Date().toISOString().slice(0, 10)}`,
      relatedType: 'product',
      relatedId: productId,
    });
  }
};

/**
 * Run every due recurring schedule.
 *
 * The claim-then-run split matters: claiming leases the schedule so a second
 * worker skips it, and `runOccurrence` then inserts its unique occurrence row
 * before any side effect. Two independent guards, because a duplicate here is
 * a duplicate charge.
 */
const runDueSchedules: JobHandler = async (_payload, job) => {
  const owner = `worker-${job.id}`;
  const claimed = await claimDueSchedules(20, owner);

  if (claimed.length === 0) return;

  logger.info({ count: claimed.length }, 'running due recurring schedules');

  for (const schedule of claimed) {
    // Sequential rather than parallel: each occurrence writes an order and
    // takes inventory row locks, and running them in a burst would just make
    // them queue behind each other at the database.
    const outcome = await runOccurrence(
      schedule.id,
      schedule.plannedRunAt,
      job.correlationId ?? undefined,
    );

    logger.info({ scheduleId: schedule.id, outcome: outcome.result }, 'recurring occurrence handled');
  }
};

/**
 * Warn customers before a recurring order is placed, not after.
 *
 * The lead time is configuration rather than a constant here, and startup
 * refuses a value that is shorter than the edit cutoff - a reminder that
 * arrives after the window has shut invites the customer to change something
 * the API will then refuse.
 */
const scheduleReminders: JobHandler = async () => {
  const sent = await sendUpcomingReminders(env.SCHEDULE_REMINDER_LEAD_HOURS);
  if (sent > 0) logger.info({ sent }, 'queued scheduled order reminders');
};

/**
 * Retry cycles that failed before payment.
 *
 * `retryFailedOccurrences` re-checks that no money moved before it touches
 * anything, so a row that has since been paid is left alone even if its status
 * has not caught up.
 */
const scheduleOccurrenceRetry: JobHandler = async () => {
  const retried = await retryFailedOccurrences();
  if (retried > 0) logger.info({ retried }, 'retried failed scheduled occurrences');
};

/** Close out occurrences the customer never authenticated. */
const scheduleActionExpire: JobHandler = async () => {
  const expired = await expireActionRequiredOccurrences();
  if (expired > 0) {
    logger.info({ expired }, 'expired occurrences awaiting payment authentication');
  }
};

/**
 * Build upcoming occurrence rows for every active plan.
 *
 * The safety net rather than the main path - the engine materialises as it
 * advances each plan. This catches the plans that path does not reach: one
 * resumed after a long pause, one whose horizon moved because a setting
 * changed, or one whose materialisation failed on a bad day.
 */
const scheduleMaterialise: JobHandler = async () => {
  const plans = await prisma.recurringSchedule.findMany({
    where: { status: 'ACTIVE', kind: 'RECURRING' },
    select: { id: true },
    take: 500,
  });

  let created = 0;

  for (const plan of plans) {
    const result = await materialiseOccurrences(plan.id);
    created += result.created;
  }

  if (created > 0) logger.info({ created, plans: plans.length }, 'materialised upcoming deliveries');
};

/**
 * Retry orders the ERP has not taken.
 *
 * Every row here belongs to a customer who has already paid, which is why the
 * retry budget is generous and why it runs on the ordinary maintenance beat
 * rather than daily. A success also completes the occurrence that was waiting
 * on it.
 */
const erpOrderRetry: JobHandler = async () => {
  const result = await retryDueErpPushes();

  if (result.attempted > 0) {
    logger.info(result, 'retried ERP order pushes');
  }
};

/**
 * Poll every customer ERP whose next check is due.
 *
 * The fallback for a buyer's ERP with no outbound webhooks, which is most of
 * them. Each connection carries its own `nextPollAt` and the sweep books the
 * next one BEFORE running, so a connection whose poll throws is not picked up
 * again on the very next pass - which would be a tight loop against somebody
 * else's server.
 *
 * A no-op while FEATURE_ERP_INTEGRATION is off.
 */
const erpInventoryPoll: JobHandler = async () => {
  const result = await pollDueConnections();

  if (result.polled > 0 || result.failed > 0) {
    logger.info(result, 'polled customer ERP connections for stock');
  }
};

/**
 * Retry orders the ERP has not taken.
 *
 * The exit from Paid - ERP Pending. Every row this
 * touches is an order somebody has already paid for and which their warehouse
 * cannot yet see, so it runs on the ordinary maintenance beat; each row carries
 * its own `nextRetryAt`, so a pass with nothing due is one indexed query.
 *
 * Every attempt reuses the idempotency key the first one sent, so this can
 * never produce a second ERP order however many times it runs.
 */
const erpPushRetry: JobHandler = async () => {
  const result = await retryDueErpConnectionPushes();

  if (result.attempted > 0) {
    logger.info(result, 'retried customer ERP order pushes');
  }
};

/**
 * Retry integration operations whose failure looked transient.
 *
 * Reads `integration_events` rather than any one business table, so a new kind
 * of operation is retried without a new job type. Order pushes are deliberately
 * left to `erpPushRetry` above: they have their own ledger row, their
 * own larger attempt budget, and a paid order is not the place for a generic
 * sweep to be the thing that gives up.
 */
const integrationEventRetry: JobHandler = async () => {
  const due = await findDueRetries();
  if (due.length === 0) return;

  let requeued = 0;

  for (const event of due) {
    if (event.eventType === 'ORDER_PUSH') continue;

    // A sync is re-run rather than resumed: the ERP's answer now is the one
    // worth having, and half-applying an hour-old snapshot on top of a fresh
    // one is how two systems end up disagreeing about stock.
    if (event.eventType === 'INVENTORY_SYNC' && event.connectionId !== null) {
      const connection = await prisma.erpConnection.findFirst({
        where: { id: event.connectionId, status: 'ACTIVE', deletedAt: null },
      });

      if (connection === null) {
        // The connection was paused, suspended or deleted while this waited.
        // Nothing to retry against, and leaving the event RETRY_SCHEDULED would
        // have the sweep pick it up for ever.
        await releaseEvent(event.id, 'The connection is no longer switched on.');
        continue;
      }

      await prisma.erpConnection.update({
        where: { id: connection.id },
        data: { nextPollAt: new Date() },
      });

      await releaseEvent(event.id, 'Superseded by a fresh synchronisation.');
      requeued += 1;
      continue;
    }

    // Anything else has no automatic retry path yet. Closed rather than left
    // scheduled for ever, with the reason on the row.
    await releaseEvent(event.id, 'This operation has to be retried by hand.');
  }

  if (requeued > 0) {
    logger.info({ requeued, examined: due.length }, 'requeued customer ERP integration events');
  }
};

/** Mark links that quietly aged out, so an admin can see why they stopped working. */
const expireLinks: JobHandler = async () => {
  const expired = await expirePaymentLinks();
  if (expired > 0) logger.info({ expired }, 'expired payment links');
};

/**
 * Build an export file.
 *
 * Runs here rather than in a request because a year of orders would time the
 * connection out and spike memory. `generateExport` is idempotent, so a
 * redelivered job does not rebuild the file and invalidate a link in use.
 */
const generateExportJob: JobHandler = async (payload) => {
  const exportJobId = requireString(payload, 'exportJobId');

  try {
    const result = await generateExport(exportJobId);
    logger.info({ exportJobId, rowCount: result.rowCount }, 'export ready');
  } catch (error) {
    // Recorded on the job row so the requesting admin sees why, rather than
    // watching a spinner that never resolves.
    const message = error instanceof Error ? error.message : 'unknown export error';
    await markExportFailed(exportJobId, message);
    throw error;
  }
};

/**
 * Answer a data subject request.
 *
 * Both branches - build the Art. 15 bundle, or carry out an approved Art. 17
 * erasure - are too heavy for a request handler and must survive the browser
 * going away. `fulfilRequest` records its own failure on the request row
 * before rethrowing, so a retry that never succeeds still leaves a member of
 * staff something to look at rather than a request stuck at IN_PROGRESS.
 */
const fulfilDataRequest: JobHandler = async (payload) => {
  const dataRequestId = requireString(payload, 'dataRequestId');
  await fulfilRequest(dataRequestId);
  logger.info({ dataRequestId }, 'data subject request answered');
};

/**
 * Delete personal data that has outlived its retention window.
 *
 * Batched: a deployment switching retention on for the first time has years of
 * backlog, and one statement deleting a million rows would lock the tables for
 * everyone. `moreToDo` says a sweep hit its ceiling, and the next maintenance
 * beat picks up where this one stopped.
 */
const retentionSweep: JobHandler = async () => {
  const result = await runRetentionSweeps();

  const purgedBundles = await purgeExpiredBundles();
  if (purgedBundles > 0) {
    logger.info({ purgedBundles }, 'purged expired personal-data bundles');
  }

  if (result.moreToDo) {
    logger.info({ removed: result.removed }, 'retention backlog remains; continuing next beat');
  }
};

/**
 * Run a scheduled connector sync.
 *
 * Always a real import, never a dry run: a scheduled sync exists to apply
 * changes, and an operator confirms the mapping with a manual dry run first.
 */
const integrationSync: JobHandler = async (payload) => {
  const connectionId = requireString(payload, 'connectionId');

  const result = await runSync({
    connectionId,
    dryRun: false,
    triggeredBy: 'schedule',
  });

  logger.info(
    {
      connectionId,
      syncRunId: result.syncRunId,
      updated: result.updatedCount,
      failed: result.failureCount,
    },
    'connector sync finished',
  );
};

/**
 * Keep rate-maintained prices current.
 *
 * Enqueued daily. The whole run is a no-op unless staff turned it on, which is
 * checked here rather than at enqueue time so switching it off takes effect on
 * the next run instead of waiting for a job already in the queue to drain.
 *
 * A failure inside is reported on the settings screen and not rethrown: a rate
 * feed being unreachable is a normal condition, and retrying it five times
 * within the hour would not make it reachable. Tomorrow's run is the retry.
 */
const fxRateRefresh: JobHandler = async () => {
  const settings = await getFxRateSettings();

  if (!settings.isEnabled) {
    logger.debug('exchange rate refresh is switched off; nothing to do');
    return;
  }

  const result = await refreshConvertedPrices('schedule', null);

  logger.info(
    { status: result.status, updated: result.updated, message: result.message },
    'scheduled exchange rate refresh finished',
  );
};

/**
 * The handler registry.
 *
 * A job type with no handler is marked dead rather than retried: retrying a
 * job nothing can process just fills the queue with noise.
 */
export const HANDLERS: Readonly<Record<string, JobHandler>> = Object.freeze({
  [JobType.NOTIFICATION_SEND]: sendNotification,
  [JobType.RESERVATION_SWEEP]: sweepReservations,
  [JobType.LOW_STOCK_CHECK]: lowStockCheck,
  [JobType.SCHEDULE_RUN]: runDueSchedules,
  [JobType.SCHEDULE_REMINDER]: scheduleReminders,
  [JobType.SCHEDULE_OCCURRENCE_RETRY]: scheduleOccurrenceRetry,
  [JobType.SCHEDULE_ACTION_EXPIRE]: scheduleActionExpire,
  [JobType.SCHEDULE_MATERIALISE]: scheduleMaterialise,
  [JobType.ERP_ORDER_RETRY]: erpOrderRetry,
  [JobType.ERP_INVENTORY_POLL]: erpInventoryPoll,
  [JobType.ERP_PUSH_RETRY]: erpPushRetry,
  [JobType.INTEGRATION_EVENT_RETRY]: integrationEventRetry,
  [JobType.PAYMENT_LINK_EXPIRE]: expireLinks,
  [JobType.EXPORT_GENERATE]: generateExportJob,
  [JobType.INTEGRATION_SYNC]: integrationSync,
  [JobType.FX_RATE_REFRESH]: fxRateRefresh,
  [JobType.DATA_REQUEST_FULFIL]: fulfilDataRequest,
  [JobType.RETENTION_SWEEP]: retentionSweep,
});

export function handlerFor(jobType: string): JobHandler | undefined {
  return HANDLERS[jobType];
}
