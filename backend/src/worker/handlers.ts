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
  runOccurrence,
  sendUpcomingReminders,
} from '../modules/recurring/occurrence.service.js';

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

/** Warn customers before a recurring order is placed, not after. */
const scheduleReminders: JobHandler = async () => {
  const sent = await sendUpcomingReminders(24);
  if (sent > 0) logger.info({ sent }, 'queued recurring order reminders');
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
