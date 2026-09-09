/**
 * The integration ledger.
 *
 * One row per thing attempted against a customer's ERP, and the answer to the
 * question a customer actually asks: *why has my order not reached my
 * warehouse?* Without it, that question is answered by reading application logs
 * the customer cannot see, which is the same as not answering it.
 *
 * Two of its columns do real work rather than merely recording:
 *
 *   **`idempotencyKey` is unique.** `claimEvent` inserts before it calls
 *   anything, so a second attempt at the same logical operation collides with
 *   the row already there instead of starting a second ERP order. That is
 *   structural: it holds even if the calling code forgets to check, which is
 *   exactly the circumstance in which duplicate-order bugs happen.
 *
 *   **`correlationId` threads the story.** One customer action - a checkout, a
 *   webhook, a nightly poll - produces log lines, audit rows and ledger events,
 *   and they all carry the same id. An incident then reads back as one sequence
 *   rather than as three that have to be aligned by timestamp.
 *
 * Everything written here is safe to put on a screen. `errorMessage` comes
 * from `safeErrorMessage` and `responseJson` from `redactForLedger`; nothing
 * else may write to either. That rule predates the move to admin-only
 * configuration and survives it: an ERP's error body is written by somebody
 * else's software and routinely echoes back the credential it just rejected,
 * which does not belong in a column any screen renders.
 */
import { Prisma } from '../../generated/prisma/client.js';
import type {
  IntegrationEventStatus,
  IntegrationEventType,
} from '../../generated/prisma/enums.js';
import { env } from '../../config/env.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { ErpCallError, backoffMs, redactForLedger, safeErrorMessage } from './erp-client.js';

export interface ClaimEventInput {
  connectionId: string | null;
  eventType: IntegrationEventType;
  correlationId: string;
  /**
   * Stable across every attempt at one logical operation. Omit for events that
   * are not operations against the ERP's state - a connection test may be run
   * as often as anybody likes, and giving it a key would mean the second press
   * of the button silently did nothing.
   */
  idempotencyKey?: string | null;
  orderId?: string | null;
}

export type ClaimResult =
  /** A new attempt, or a retry of one that failed. Go ahead. */
  | { outcome: 'CLAIMED'; eventId: string; attempt: number }
  /** Already done. The reference is what the first attempt got back. */
  | { outcome: 'ALREADY_SUCCEEDED'; eventId: string; erpOrderReference: string | null }
  /** Another worker holds it. Nothing to do; whoever holds it will finish. */
  | { outcome: 'IN_FLIGHT'; eventId: string }
  /** Out of attempts, or refused for a reason that will not change. */
  | { outcome: 'ABANDONED'; eventId: string; message: string | null };

/**
 * Take ownership of one operation, or find out somebody already has.
 *
 * The insert-then-read shape is deliberate and is the whole duplicate guard.
 * `createMany({ skipDuplicates })` either creates the row or collides with the
 * one that is there; the read that follows tells us which happened and what
 * state the existing row is in. Checking first and inserting second would leave
 * a window between the two in which a redelivered webhook creates a second row.
 *
 * IN_FLIGHT is decided by an age check rather than a lock, because MariaDB 10.4
 * has no `SKIP LOCKED` and holding a transaction open across an HTTP call to
 * somebody else's server is worse than the race it would close. An event that
 * has been IN_PROGRESS longer than the stale window is assumed to belong to a
 * worker that died, and is reclaimed.
 */
export async function claimEvent(input: ClaimEventInput): Promise<ClaimResult> {
  const key = input.idempotencyKey ?? null;
  const eventId = newId();

  await prisma.integrationEvent.createMany({
    data: [
      {
        id: eventId,
        connectionId: input.connectionId,
        eventType: input.eventType,
        status: 'PENDING',
        correlationId: input.correlationId,
        idempotencyKey: key,
        orderId: input.orderId ?? null,
      },
    ],
    skipDuplicates: true,
  });

  // With no key there is nothing to collide with, so the row just created is
  // the one we hold.
  const existing =
    key === null
      ? await prisma.integrationEvent.findUnique({ where: { id: eventId } })
      : await prisma.integrationEvent.findUnique({ where: { idempotencyKey: key } });

  if (existing === null) {
    // Cannot happen: the insert above either created a row or collided with
    // one. Reported rather than assumed away.
    logger.error({ eventId, key }, 'integration event vanished immediately after being written');
    return { outcome: 'CLAIMED', eventId, attempt: 1 };
  }

  if (existing.status === 'SUCCEEDED') {
    return {
      outcome: 'ALREADY_SUCCEEDED',
      eventId: existing.id,
      erpOrderReference: existing.erpOrderReference,
    };
  }

  if (existing.status === 'ABANDONED') {
    return { outcome: 'ABANDONED', eventId: existing.id, message: existing.errorMessage };
  }

  if (existing.status === 'IN_PROGRESS') {
    const startedAt = existing.lastAttemptAt?.getTime() ?? existing.createdAt.getTime();
    if (Date.now() - startedAt < STALE_IN_PROGRESS_MS) {
      return { outcome: 'IN_FLIGHT', eventId: existing.id };
    }
    // Older than the window: the worker that held it is gone.
    logger.warn(
      { eventId: existing.id, eventType: existing.eventType },
      'reclaiming an integration event whose worker did not finish',
    );
  }

  const attempt = existing.attemptCount + 1;

  await prisma.integrationEvent.update({
    where: { id: existing.id },
    data: { status: 'IN_PROGRESS', attemptCount: attempt, lastAttemptAt: new Date() },
  });

  return { outcome: 'CLAIMED', eventId: existing.id, attempt };
}

/**
 * How long an IN_PROGRESS event is believed before it is reclaimed.
 *
 * Comfortably longer than the longest permitted request timeout (60s) plus the
 * database work around it. Too short and two workers run the same push; too
 * long and a crashed worker's order waits ten minutes for no reason.
 */
const STALE_IN_PROGRESS_MS = 5 * 60 * 1000;

export interface EventSuccessInput {
  eventId: string;
  httpStatus?: number | null;
  durationMs?: number | null;
  erpOrderReference?: string | null;
  response?: unknown;
}

export async function recordEventSuccess(input: EventSuccessInput): Promise<void> {
  await prisma.integrationEvent.update({
    where: { id: input.eventId },
    data: {
      status: 'SUCCEEDED',
      httpStatus: input.httpStatus ?? null,
      durationMs: input.durationMs ?? null,
      erpOrderReference: input.erpOrderReference ?? null,
      nextRetryAt: null,
      errorCode: null,
      errorMessage: null,
      responseJson:
        input.response === undefined
          ? Prisma.DbNull
          : (redactForLedger(input.response) as Prisma.InputJsonValue),
    },
  });
}

export interface EventFailureInput {
  eventId: string;
  attempt: number;
  error: unknown;
  durationMs?: number | null;
  /**
   * Override the attempt ceiling. The paid-but-unpushed path passes the
   * operator's larger one, because giving up there means an order somebody has
   * paid for that the warehouse cannot see.
   */
  maxAttempts?: number;
}

export interface EventFailureResult {
  status: 'RETRY_SCHEDULED' | 'FAILED' | 'ABANDONED';
  nextRetryAt: Date | null;
  message: string;
  retryable: boolean;
}

/**
 * Record an attempt that did not work, and decide what happens next.
 *
 * Three outcomes, and the distinction between the last two is the one that
 * matters to a customer:
 *
 *   RETRY_SCHEDULED - worth another go, and one is booked.
 *   FAILED          - the ERP understood us and refused. Nothing retries; the
 *                     customer is shown it and can retry by hand once they have
 *                     fixed the cause. Automatically repeating a 400 is how a
 *                     system spends a week hammering somebody's server over a
 *                     typo in a field name.
 *   ABANDONED       - retryable, but out of attempts. A person has to look.
 */
export async function recordEventFailure(
  input: EventFailureInput,
): Promise<EventFailureResult> {
  const message = safeErrorMessage(input.error);
  // Bound to a const so TypeScript narrows it. A boolean flag would not: the
  // compiler cannot tell that `isErpError` still describes `input.error` by the
  // time the ternaries below read it.
  const erpError = input.error instanceof ErpCallError ? input.error : null;

  // An unclassified throw is treated as retryable. It is almost always
  // transport or a bug on our side, and both are worth another attempt; the
  // ceiling stops it becoming an infinite one.
  const retryable = erpError?.retryable ?? true;
  const httpStatus = erpError?.httpStatus ?? null;
  const errorCode = erpError?.errorCode ?? 'UNKNOWN';
  const snippet = erpError?.responseSnippet ?? null;
  const retryAfter = erpError?.retryAfterSeconds ?? null;

  const ceiling = input.maxAttempts ?? env.ERP_MAX_ATTEMPTS;
  const exhausted = input.attempt >= ceiling;

  const status: IntegrationEventStatus = !retryable
    ? 'FAILED'
    : exhausted
      ? 'ABANDONED'
      : 'RETRY_SCHEDULED';

  const nextRetryAt =
    status === 'RETRY_SCHEDULED' ? new Date(Date.now() + backoffMs(input.attempt, retryAfter)) : null;

  await prisma.integrationEvent.update({
    where: { id: input.eventId },
    data: {
      status,
      attemptCount: input.attempt,
      lastAttemptAt: new Date(),
      nextRetryAt,
      httpStatus,
      durationMs: input.durationMs ?? null,
      errorCode,
      errorMessage: message.slice(0, 1000),
      responseJson:
        snippet === null || snippet === undefined
          ? Prisma.DbNull
          : (snippet as Prisma.InputJsonValue),
    },
  });

  return { status, nextRetryAt, message, retryable };
}

/**
 * Mark a claimed event as never having run.
 *
 * For the case where the claim succeeded and then a precondition failed before
 * anything was sent - a connection that turned out to be paused, a mapping that
 * no longer validates. Leaving it IN_PROGRESS would make it look like a request
 * in flight, and every subsequent attempt would be told IN_FLIGHT until the
 * stale window passed.
 */
export async function releaseEvent(eventId: string, reason: string): Promise<void> {
  await prisma.integrationEvent.update({
    where: { id: eventId },
    data: {
      status: 'FAILED',
      nextRetryAt: null,
      errorCode: 'PRECONDITION',
      errorMessage: reason.slice(0, 1000),
    },
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface IntegrationEventView {
  id: string;
  eventType: string;
  status: string;
  connectionId: string | null;
  orderId: string | null;
  erpOrderReference: string | null;
  correlationId: string;
  /**
   * Returned so a customer talking to support can quote it, and so the same
   * operation can be recognised across retries. It is derived from ids the
   * customer already owns and carries no secret.
   */
  idempotencyKey: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  httpStatus: number | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  /** Whether this row offers the customer a Retry button. */
  retryable: boolean;
}

interface EventRow {
  id: string;
  eventType: string;
  status: string;
  connectionId: string | null;
  orderId: string | null;
  erpOrderReference: string | null;
  correlationId: string;
  idempotencyKey: string | null;
  attemptCount: number;
  lastAttemptAt: Date | null;
  nextRetryAt: Date | null;
  httpStatus: number | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
}

function toView(row: EventRow): IntegrationEventView {
  return {
    id: row.id,
    eventType: row.eventType,
    status: row.status,
    connectionId: row.connectionId,
    orderId: row.orderId,
    erpOrderReference: row.erpOrderReference,
    correlationId: row.correlationId,
    idempotencyKey: row.idempotencyKey,
    attemptCount: row.attemptCount,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    nextRetryAt: row.nextRetryAt?.toISOString() ?? null,
    httpStatus: row.httpStatus,
    durationMs: row.durationMs,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    // A FAILED row is the one worth offering a button for: it stopped because
    // the ERP refused something the customer can go and fix. ABANDONED is
    // offered too - the cause may since have been fixed - while anything still
    // scheduled does not need a button, it needs patience.
    retryable: row.status === 'FAILED' || row.status === 'ABANDONED',
  };
}

/**
 * The integration activity, newest first.
 *
 * Read by an administrator holding `integration.read`. There is no owner
 * filter because there is no owner: one business, one ERP, one ledger. The
 * guard is the route's permission check rather than a WHERE clause.
 */
export async function listIntegrationEvents(
  filters: {
    connectionId?: string;
    eventType?: IntegrationEventType;
    status?: IntegrationEventStatus;
    orderId?: string;
    limit?: number;
    cursor?: string;
  } = {},
): Promise<{ events: IntegrationEventView[]; nextCursor: string | null }> {
  const take = Math.min(Math.max(filters.limit ?? 25, 1), 100);

  const rows = await prisma.integrationEvent.findMany({
    where: {
      ...(filters.connectionId === undefined ? {} : { connectionId: filters.connectionId }),
      ...(filters.eventType === undefined ? {} : { eventType: filters.eventType }),
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.orderId === undefined ? {} : { orderId: filters.orderId }),
    },
    orderBy: { createdAt: 'desc' },
    // One more than asked for, so "is there another page" is a fact rather than
    // a guess that shows an empty page at the end.
    take: take + 1,
    ...(filters.cursor === undefined ? {} : { cursor: { id: filters.cursor }, skip: 1 }),
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;

  return {
    events: page.map(toView),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/** One event, or null. */
export async function loadEvent(eventId: string): Promise<EventRow | null> {
  return prisma.integrationEvent.findUnique({ where: { id: eventId } });
}

/**
 * Events due for another attempt, oldest first.
 *
 * Claimed by the worker sweep. The `take` is a ceiling on one pass rather than
 * on the backlog: a customer whose ERP was down overnight has their events
 * drained over several passes instead of in one burst that the recovering ERP
 * would experience as an attack.
 */
export async function findDueRetries(limit = 25): Promise<
  {
    id: string;
    connectionId: string | null;
    eventType: string;
    orderId: string | null;
    correlationId: string;
    idempotencyKey: string | null;
    attemptCount: number;
  }[]
> {
  return prisma.integrationEvent.findMany({
    where: { status: 'RETRY_SCHEDULED', nextRetryAt: { lte: new Date() } },
    orderBy: { nextRetryAt: 'asc' },
    take: limit,
    select: {
      id: true,
      connectionId: true,
      eventType: true,
      orderId: true,
      correlationId: true,
      idempotencyKey: true,
      attemptCount: true,
    },
  });
}

/**
 * Put a FAILED or ABANDONED event back in the queue at the customer's request.
 *
 * Resets the attempt count, because the customer is asserting that the cause
 * has been fixed and the old count is about a configuration that no longer
 * exists. The idempotency key is deliberately NOT reset: if the earlier attempt
 * did reach the ERP despite reporting failure, the retry has to collide with it
 * rather than create a second order.
 */
export async function requeueEvent(eventId: string): Promise<void> {
  await prisma.integrationEvent.update({
    where: { id: eventId },
    data: {
      status: 'RETRY_SCHEDULED',
      attemptCount: 0,
      nextRetryAt: new Date(),
      errorCode: null,
      errorMessage: null,
    },
  });
}
