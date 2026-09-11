/**
 * The outbox.
 *
 * Everything that touches a buyer's ERP goes through a row in
 * `customer_erp_sync_events`, including the things that turn out not to need a
 * call at all. That is what makes "why did my purchase order not appear"
 * answerable: there is always a row, and it always says what happened.
 *
 * THE IDEMPOTENCY KEY IS THE WHOLE DESIGN
 *
 * `organizationId:subject:eventType:v<n>` - derived entirely from the thing that
 * happened, never from the clock and never from a random source. A retry, a
 * redelivered payment webhook, a second worker and a manual "send again" all
 * derive the same key, the unique index admits one of them, and the rest find
 * the row that is already there.
 *
 * This is the single most important property in the feature. An ERP that
 * received a purchase order and then received it again has a duplicate
 * liability on its books, and somebody in accounts payable finds out about it
 * six weeks later when two invoices arrive for one delivery. Everything else
 * here - the leases, the backoff, the dead-letter state - is about noise.
 * The key is about correctness.
 *
 * A genuinely NEW thing to say about the same order is a new `eventVersion`,
 * therefore a new key, therefore a new row. Never this one again: SUCCEEDED has
 * no way out, and `assertEventTransition` is what enforces that.
 *
 * WHY A LEASE RATHER THAN A LOCK
 *
 * MariaDB 10.4 has no `FOR UPDATE SKIP LOCKED`, so claiming is a conditional
 * UPDATE plus an affected-rows check - exactly the pattern `JobQueue` and
 * `RecurringSchedule` use, for exactly the same reason. A worker that dies
 * mid-flight leaves a lease that expires, and the row is picked up again; a
 * worker that is merely slow does not have its work stolen, because the lease
 * is renewed rather than assumed.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import {
  assertEventTransition,
  type CustomerErpEventStateName,
} from '../../domain/customer-erp-state.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { backoffMs, ErpCallError, safeErrorMessage } from './http.js';
import { recordOrgAudit, SYSTEM_ACTOR, type OrgActor } from './audit.service.js';

export type EventTypeName =
  | 'CONNECTION_TEST'
  | 'DRY_RUN'
  | 'PURCHASE_ORDER_CREATE'
  | 'PURCHASE_ORDER_UPDATE'
  | 'SHIPMENT_STATUS'
  | 'GOODS_RECEIPT'
  | 'INVENTORY_UPDATE'
  | 'INVOICE_SYNC'
  | 'PAYMENT_REFERENCE'
  | 'INBOUND_POLL'
  | 'INBOUND_WEBHOOK';

/**
 * Build the key.
 *
 * `subject` is whatever the event is about - an order id, an invoice id, a
 * webhook's external id. It is required and there is no overload without it:
 * an event with no subject has no stable identity, and a key that falls back to
 * a random value is not an idempotency key, it is a unique constraint that
 * never fires.
 */
export function idempotencyKeyFor(input: {
  organizationId: string;
  subject: string;
  eventType: EventTypeName;
  eventVersion?: number;
}): string {
  return `${input.organizationId}:${input.subject}:${input.eventType}:v${
    input.eventVersion ?? 1
  }`.slice(0, 191);
}

export interface EnqueueEventInput {
  connectionId: string;
  organizationId: string;
  eventType: EventTypeName;
  subject: string;
  eventVersion?: number;
  correlationId: string;
  orderId?: string | null;
  occurrenceId?: string | null;
  invoiceId?: string | null;
  productId?: string | null;
  /** Held on the row so a retry days later rebuilds the same call. */
  requestJson?: unknown;
}

export interface EnqueueResult {
  eventId: string;
  idempotencyKey: string;
  /** False when this exact event already existed. The common, healthy case. */
  created: boolean;
  state: CustomerErpEventStateName;
}

/**
 * Put one event in the outbox, or find the one already there.
 *
 * `createMany` with `skipDuplicates` rather than a read-then-write: two workers
 * reacting to the same confirmed order at the same instant would both pass a
 * prior existence check, and the loser would turn a healthy duplicate into a
 * 500. Here the loser simply reads back what the winner wrote.
 */
export async function enqueueEvent(
  input: EnqueueEventInput,
  tx?: unknown,
): Promise<EnqueueResult> {
  const client = (tx as typeof prisma | undefined) ?? prisma;

  const idempotencyKey = idempotencyKeyFor({
    organizationId: input.organizationId,
    subject: input.subject,
    eventType: input.eventType,
    ...(input.eventVersion === undefined ? {} : { eventVersion: input.eventVersion }),
  });

  const created = await client.customerErpSyncEvent.createMany({
    data: [
      {
        id: newId(),
        connectionId: input.connectionId,
        organizationId: input.organizationId,
        eventType: input.eventType,
        state: 'QUEUED',
        idempotencyKey,
        eventVersion: input.eventVersion ?? 1,
        orderId: input.orderId ?? null,
        occurrenceId: input.occurrenceId ?? null,
        invoiceId: input.invoiceId ?? null,
        productId: input.productId ?? null,
        correlationId: input.correlationId,
        requestJson: (input.requestJson ?? undefined),
      },
    ],
    skipDuplicates: true,
  });

  const row = await client.customerErpSyncEvent.findUnique({ where: { idempotencyKey } });

  if (row === null) {
    // Cannot happen - the insert above either created it or found a duplicate
    // that exists. Thrown rather than asserted so it is loud if it ever does.
    throw conflict(
      ErrorCode.CUSTOMER_ERP_EVENT_STATE_INVALID,
      'The event could not be recorded. Try again.',
    );
  }

  return {
    eventId: row.id,
    idempotencyKey,
    created: created.count > 0,
    state: row.state,
  };
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/** How long one worker may hold an event before another may take it. */
const LEASE_MS = 5 * 60 * 1000;

export interface ClaimedEvent {
  id: string;
  connectionId: string;
  organizationId: string;
  eventType: EventTypeName;
  orderId: string | null;
  occurrenceId: string | null;
  invoiceId: string | null;
  productId: string | null;
  correlationId: string;
  idempotencyKey: string;
  eventVersion: number;
  attemptCount: number;
  requestJson: unknown;
  erpReference: string | null;
}

/**
 * Take up to `limit` events that are due, one at a time.
 *
 * Read then conditionally update, checking the affected-row count. The
 * condition includes the state AND the lease, so two workers that read the same
 * candidate list both try and exactly one succeeds - which is the whole point,
 * and is the only shape available without `SKIP LOCKED`.
 *
 * Ordered by `createdAt`. Events about one order have to reach an ERP in the
 * order they happened: a goods receipt that arrives before its purchase order
 * has nothing to attach itself to.
 */
export async function claimDueEvents(limit: number): Promise<ClaimedEvent[]> {
  const now = new Date();
  const owner = `${process.pid}:${newId().slice(-8)}`;

  const candidates = await prisma.customerErpSyncEvent.findMany({
    where: {
      state: { in: ['QUEUED', 'RETRYING'] },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
      AND: [{ OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] }],
    },
    orderBy: { createdAt: 'asc' },
    take: limit * 3,
  });

  const claimed: ClaimedEvent[] = [];

  for (const candidate of candidates) {
    if (claimed.length >= limit) break;

    const won = await prisma.customerErpSyncEvent.updateMany({
      where: {
        id: candidate.id,
        state: candidate.state,
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: {
        state: assertEventTransition(candidate.state, 'CLAIM'),
        leaseOwner: owner,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        attemptCount: { increment: 1 },
        lastAttemptAt: now,
      },
    });

    if (won.count === 0) continue;

    claimed.push({
      id: candidate.id,
      connectionId: candidate.connectionId,
      organizationId: candidate.organizationId,
      eventType: candidate.eventType,
      orderId: candidate.orderId,
      occurrenceId: candidate.occurrenceId,
      invoiceId: candidate.invoiceId,
      productId: candidate.productId,
      correlationId: candidate.correlationId,
      idempotencyKey: candidate.idempotencyKey,
      eventVersion: candidate.eventVersion,
      attemptCount: candidate.attemptCount + 1,
      requestJson: candidate.requestJson,
      erpReference: candidate.erpReference,
    });
  }

  return claimed;
}

// ---------------------------------------------------------------------------
// Settling
// ---------------------------------------------------------------------------

export interface EventSuccess {
  erpReference?: string | null;
  httpStatus?: number | null;
  durationMs?: number;
  requestJson?: unknown;
  responseJson?: unknown;
}

export async function recordSuccess(eventId: string, result: EventSuccess): Promise<void> {
  const current = await prisma.customerErpSyncEvent.findUnique({ where: { id: eventId } });
  if (current === null) return;

  await prisma.customerErpSyncEvent.update({
    where: { id: eventId },
    data: {
      state: assertEventTransition(current.state, 'SUCCEED'),
      erpReference: result.erpReference ?? current.erpReference,
      httpStatus: result.httpStatus ?? null,
      durationMs: result.durationMs ?? null,
      requestJson: (result.requestJson ?? undefined),
      responseJson: (result.responseJson ?? undefined),
      errorCode: null,
      errorMessage: null,
      skipReason: null,
      nextRetryAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: new Date(),
    },
  });
}

/**
 * Something went wrong. Decide whether to try again.
 *
 * Three outcomes and the choice between them is made here rather than by the
 * caller, so every failure in the feature is judged by the same rule:
 *
 *   - Not retryable (a rejection, a refused credential): straight to FAILED.
 *     Six attempts against a system that has said no six times is how a buyer's
 *     ERP starts rate-limiting us for real.
 *   - Retryable, attempts left: RETRYING with a backoff, honouring the ERP's
 *     own `Retry-After` where it gave one.
 *   - Retryable, attempts exhausted: FAILED. The dead letter, retried by hand
 *     under the SAME key once somebody has fixed the cause.
 */
export async function recordFailure(
  eventId: string,
  error: unknown,
  extra: { httpStatus?: number | null; durationMs?: number; responseJson?: unknown } = {},
): Promise<{ willRetry: boolean; state: CustomerErpEventStateName }> {
  const current = await prisma.customerErpSyncEvent.findUnique({ where: { id: eventId } });
  if (current === null) return { willRetry: false, state: 'FAILED' };

  const callError = error instanceof ErpCallError ? error : null;
  const retryable = callError === null ? true : callError.isRetryable;
  const attemptsLeft = current.attemptCount < env.CUSTOMER_ERP_MAX_ATTEMPTS;
  const willRetry = retryable && attemptsLeft;

  const state = assertEventTransition(
    current.state,
    willRetry ? 'SCHEDULE_RETRY' : 'ABANDON',
  );

  await prisma.customerErpSyncEvent.update({
    where: { id: eventId },
    data: {
      state,
      nextRetryAt: willRetry
        ? new Date(
            Date.now() + backoffMs(current.attemptCount, callError?.retryAfterSeconds ?? null),
          )
        : null,
      httpStatus: extra.httpStatus ?? callError?.httpStatus ?? null,
      durationMs: extra.durationMs ?? null,
      responseJson: (extra.responseJson ?? undefined),
      errorCode: callError?.kind ?? 'UNKNOWN',
      errorMessage: safeErrorMessage(error).slice(0, 1024),
      leaseOwner: null,
      leaseExpiresAt: null,
      ...(willRetry ? {} : { completedAt: new Date() }),
    },
  });

  await recordOrgAudit({
    organizationId: current.organizationId,
    connectionId: current.connectionId,
    action: willRetry ? 'event.retried' : 'event.failed',
    resourceType: 'sync_event',
    resourceId: eventId,
    actor: SYSTEM_ACTOR,
    after: {
      state,
      attempt: current.attemptCount,
      reason: safeErrorMessage(error).slice(0, 255),
    },
  });

  return { willRetry, state };
}

/**
 * Not done, on purpose.
 *
 * A different thing from a failure and counted apart from one: the connection
 * is paused, the policy has this event type switched off, the buyer's approval
 * was refused, or the ERP already had it. A buyer looking at their log asks
 * "why did nothing happen" as often as "why did it fail", and one state for
 * both would answer neither.
 */
export async function recordSkip(
  eventId: string,
  reason: string,
  options: { approvalId?: string | null } = {},
): Promise<void> {
  const current = await prisma.customerErpSyncEvent.findUnique({ where: { id: eventId } });
  if (current === null) return;

  await prisma.customerErpSyncEvent.update({
    where: { id: eventId },
    data: {
      state: assertEventTransition(current.state, 'SKIP'),
      skipReason: reason.slice(0, 255),
      approvalId: options.approvalId ?? current.approvalId,
      nextRetryAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: new Date(),
    },
  });
}

/**
 * Put a claimed event back without spending an attempt.
 *
 * For connection-level problems - paused, waiting on somebody, out of service.
 * The event is fine; the connection is not. Burning the event's retry budget on
 * a fortnight of a paused connection would exhaust it before anybody switched
 * the connection back on, and the buyer would find their purchase orders in the
 * dead-letter list for a reason that was never theirs.
 */
export async function deferEvent(
  eventId: string,
  delayMs: number,
  reason: string,
): Promise<void> {
  await prisma.customerErpSyncEvent.updateMany({
    where: { id: eventId, state: 'PROCESSING' },
    data: {
      state: 'QUEUED',
      nextRetryAt: new Date(Date.now() + delayMs),
      // Given back, because the attempt did not happen.
      attemptCount: { decrement: 1 },
      skipReason: reason.slice(0, 255),
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
}

/**
 * Put a failed or skipped event back in the queue, by hand.
 *
 * The SAME row and the SAME idempotency key. That is what makes pressing Retry
 * safe: if the earlier attempt did in fact reach the ERP, either the ERP's own
 * idempotency handling recognises the key, or `erpReference` on this row has
 * already been set and the pipeline sees the work is done.
 *
 * A SUCCEEDED event cannot be requeued and the state machine refuses it. Not a
 * limitation - the alternative is a button that creates duplicate purchase
 * orders.
 */
export async function requeueEvent(
  eventId: string,
  organizationId: string,
  actor: OrgActor,
): Promise<void> {
  const current = await prisma.customerErpSyncEvent.findFirst({
    where: { id: eventId, organizationId },
  });

  if (current === null) throw notFound('Event');

  const state = assertEventTransition(current.state, 'REQUEUE');

  await prisma.customerErpSyncEvent.update({
    where: { id: eventId },
    data: {
      state,
      // Reset so a manual retry gets a full budget rather than one attempt.
      // The cause has presumably been fixed, and starting from five-of-six
      // would make the retry look broken for reasons that predate the fix.
      attemptCount: 0,
      nextRetryAt: null,
      errorCode: null,
      errorMessage: null,
      skipReason: null,
      completedAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });

  await recordOrgAudit({
    organizationId,
    connectionId: current.connectionId,
    action: 'event.retried',
    resourceType: 'sync_event',
    resourceId: eventId,
    actor,
    before: { state: current.state },
    after: { state },
  });
}

/**
 * Release events whose worker died.
 *
 * A lease that expired while the row still says PROCESSING means the process
 * holding it went away. The attempt is given back for the same reason as
 * `deferEvent`: nothing was tried, so nothing should be counted.
 */
export async function releaseExpiredLeases(): Promise<number> {
  const result = await prisma.customerErpSyncEvent.updateMany({
    where: { state: 'PROCESSING', leaseExpiresAt: { lt: new Date() } },
    data: {
      state: 'QUEUED',
      leaseOwner: null,
      leaseExpiresAt: null,
      attemptCount: { decrement: 1 },
    },
  });

  if (result.count > 0) {
    logger.warn(
      { released: result.count },
      'released buyer ERP events whose worker lease had expired',
    );
  }

  return result.count;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface EventView {
  id: string;
  connectionId: string;
  eventType: EventTypeName;
  state: CustomerErpEventStateName;
  orderId: string | null;
  invoiceId: string | null;
  erpReference: string | null;
  correlationId: string;
  idempotencyKey: string;
  attemptCount: number;
  nextRetryAt: string | null;
  httpStatus: number | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  skipReason: string | null;
  approvalId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface EventQuery {
  connectionId?: string | null;
  state?: CustomerErpEventStateName | null;
  eventType?: EventTypeName | null;
  /** Matched against the correlation id, the ERP reference and the order id. */
  search?: string | null;
  before?: Date | null;
  limit: number;
}

/**
 * One organisation's events.
 *
 * `organizationId` comes from a `Membership` and is in the WHERE clause rather
 * than applied afterwards, so a mistake here produces no rows instead of
 * somebody else's. Keyset pagination on `createdAt`, because this table grows
 * without bound and `OFFSET 40000` reads forty thousand rows to discard them.
 */
export async function listEvents(
  organizationId: string,
  query: EventQuery,
): Promise<{ rows: EventView[]; nextBefore: string | null }> {
  const where: Prisma.CustomerErpSyncEventWhereInput = { organizationId };

  if (query.connectionId !== null && query.connectionId !== undefined) {
    where.connectionId = query.connectionId;
  }
  if (query.state !== null && query.state !== undefined) {
    where.state = query.state;
  }
  if (query.eventType !== null && query.eventType !== undefined) {
    where.eventType = query.eventType;
  }
  if (query.before !== null && query.before !== undefined) {
    where.createdAt = { lt: query.before };
  }

  const search = (query.search ?? '').trim();
  if (search.length > 0) {
    where.OR = [
      { correlationId: { contains: search } },
      { erpReference: { contains: search } },
      { orderId: { contains: search } },
      { idempotencyKey: { contains: search } },
    ];
  }

  const limit = Math.min(Math.max(query.limit, 1), 100);

  const rows = await prisma.customerErpSyncEvent.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
  });

  const page = rows.slice(0, limit);
  const last = page.at(-1);

  return {
    rows: page.map(toEventView),
    nextBefore: rows.length > limit && last !== undefined ? last.createdAt.toISOString() : null,
  };
}

export function toEventView(row: {
  id: string;
  connectionId: string;
  eventType: string;
  state: string;
  orderId: string | null;
  invoiceId: string | null;
  erpReference: string | null;
  correlationId: string;
  idempotencyKey: string;
  attemptCount: number;
  nextRetryAt: Date | null;
  httpStatus: number | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  skipReason: string | null;
  approvalId: string | null;
  createdAt: Date;
  completedAt: Date | null;
}): EventView {
  return {
    id: row.id,
    connectionId: row.connectionId,
    eventType: row.eventType as EventTypeName,
    state: row.state as CustomerErpEventStateName,
    orderId: row.orderId,
    invoiceId: row.invoiceId,
    erpReference: row.erpReference,
    correlationId: row.correlationId,
    idempotencyKey: row.idempotencyKey,
    attemptCount: row.attemptCount,
    nextRetryAt: row.nextRetryAt?.toISOString() ?? null,
    httpStatus: row.httpStatus,
    durationMs: row.durationMs,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    skipReason: row.skipReason,
    approvalId: row.approvalId,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/** Counts by state, for the dashboard's chips. One grouped query. */
export async function countEventsByState(
  organizationId: string,
  connectionId?: string | null,
): Promise<Record<CustomerErpEventStateName, number>> {
  const grouped = await prisma.customerErpSyncEvent.groupBy({
    by: ['state'],
    where: {
      organizationId,
      ...(connectionId === null || connectionId === undefined ? {} : { connectionId }),
    },
    _count: { _all: true },
  });

  const counts: Record<CustomerErpEventStateName, number> = {
    QUEUED: 0,
    PROCESSING: 0,
    SUCCEEDED: 0,
    RETRYING: 0,
    FAILED: 0,
    SKIPPED: 0,
  };

  for (const row of grouped) {
    counts[row.state] = row._count._all;
  }

  return counts;
}
