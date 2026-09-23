/**
 * The outbox: one row per thing that must reach a seller's Tally exactly once.
 *
 * WHY AN OUTBOX AND NOT A DIRECT CALL
 *
 * The seller's Tally is a desktop application on a PC that is switched off at
 * six o'clock. An order confirmed at two in the morning cannot be posted at
 * two in the morning, and nothing comes back later to ask whether it ever was.
 * So the EVENT is recorded, transactionally, alongside the business write that
 * caused it - and the posting happens whenever the bridge next appears.
 *
 * Enqueued INSIDE the caller's transaction, always. That is what makes "the
 * order was confirmed" and "Tally will be told" one fact rather than two: a
 * rolled-back order cannot leave a job behind, and a committed one cannot fail
 * to produce one.
 *
 * THE THREE GUARDS AGAINST A DUPLICATE VOUCHER
 *
 * A duplicate Sales Invoice is not a cosmetic bug. It is a tax return that
 * does not reconcile, and it is found weeks later by an accountant. Three
 * separate things prevent it, at three different layers:
 *
 *   1. `idempotencyKey` is UNIQUE. Built deterministically from the
 *      connection, the event type and the source entity - never from a clock
 *      or a random - so a webhook redelivered four times produces one row and
 *      three no-ops, decided by the database rather than by a read-then-write
 *      that can race.
 *   2. `SellerErpExternalReference` records what our row became in Tally.
 *      Before posting, the pipeline looks there; finding a reference, it
 *      verifies rather than re-posts.
 *   3. `REMOTEID` on the voucher itself, so Tally refuses a second copy even
 *      if both of ours somehow failed.
 *
 * ORDERING
 *
 * Accounting events depend on each other: a Receipt must not post before the
 * Invoice it pays, and a Credit Note must not precede the Invoice it reverses.
 * `sequenceKey` groups the jobs that must stay in order - it is the ORDER's id
 * for everything about one order - and the claim hands out at most one job per
 * key at a time. Events with no ordering requirement carry an empty key and
 * are handed out freely, which is most of them.
 */
import { env } from '../../config/env.js';
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import {
  canQueue,
  isTransientFailure,
  retryDelaySeconds,
} from '../../domain/seller-erp-state.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import {
  assertSellerOwnership,
  assertSellerPermission,
  type SellerMembership,
} from '../seller/account.service.js';
import { recordErpAudit } from './audit.service.js';

export type SellerErpEventTypeName =
  | 'SALES_ORDER'
  | 'SALES_INVOICE'
  | 'RECEIPT'
  | 'CREDIT_NOTE'
  | 'CANCELLATION'
  | 'STOCK_ITEM_UPSERT'
  | 'PARTY_LEDGER_UPSERT'
  | 'GODOWN_UPSERT'
  | 'INVENTORY_PULL'
  | 'MASTER_PULL'
  | 'CONNECTION_TEST';

export type SellerErpTriggerName =
  | 'MANUAL'
  | 'INITIAL'
  | 'EVENT'
  | 'SCHEDULED'
  | 'RETRY'
  | 'RECONCILE';

/**
 * The key that makes an event happen once.
 *
 * DETERMINISTIC. Nothing in it moves: no timestamp, no random, no attempt
 * counter. Two independent attempts to record the same fact - a webhook and a
 * reconciliation pass, say - produce the same string and therefore one row.
 *
 * The connection is part of it because a seller with two Tally companies
 * legitimately posts the same order into both, and those are two events.
 */
export function idempotencyKeyFor(input: {
  connectionId: string;
  eventType: SellerErpEventTypeName;
  sourceEntityId: string;
  /**
   * A discriminator for the rare case where one entity produces two events of
   * one type - a part refund, say, where each Credit Note is its own thing.
   * Empty for everything else.
   */
  discriminator?: string;
}): string {
  const parts = [
    input.connectionId,
    input.eventType,
    input.sourceEntityId,
    input.discriminator ?? '',
  ];

  // Joined with a character none of the parts can contain. A separator that
  // could appear inside a part would let two different events collide onto one
  // key, which is the opposite of the failure this guards against.
  return parts.join('|').slice(0, 191);
}

export interface EnqueueErpEventInput {
  connectionId: string;
  sellerAccountId: string;
  eventType: SellerErpEventTypeName;
  sourceEntityType: string;
  sourceEntityId: string;
  orderId?: string | null;
  sellerOrderGroupId?: string | null;
  /** Built NOW, from the data as it is now. See the note below. */
  payload: unknown;
  trigger?: SellerErpTriggerName;
  /** Jobs sharing this are handed out one at a time, in creation order. */
  sequenceKey?: string;
  discriminator?: string;
  maxAttempts?: number;
  correlationId?: string | null;
  /** The caller's transaction. Passed on every business-event enqueue. */
  tx?: PrismaTransaction;
}

/**
 * Queue one event.
 *
 * Returns the job id, or null when an identical event was already queued -
 * which is a success, not a failure, and callers treat it as one. A webhook
 * retried four times SHOULD produce three nulls.
 *
 * THE PAYLOAD IS BUILT NOW, not at send time, and that is deliberate. A job
 * that assembled its payload when the bridge happened to come back online
 * would post whatever the order looks like then - which for an order edited,
 * part-refunded or re-addressed in the meantime is not the event that was
 * recorded. The payload is what happened; the send is when we managed to say
 * so.
 */
export async function enqueueErpEvent(input: EnqueueErpEventInput): Promise<string | null> {
  const client = input.tx ?? prisma;

  const idempotencyKey = idempotencyKeyFor({
    connectionId: input.connectionId,
    eventType: input.eventType,
    sourceEntityId: input.sourceEntityId,
    discriminator: input.discriminator,
  });

  const id = newId();

  try {
    await client.sellerErpSyncJob.create({
      data: {
        id,
        sellerAccountId: input.sellerAccountId,
        connectionId: input.connectionId,
        idempotencyKey,
        eventType: input.eventType,
        sourceEntityType: input.sourceEntityType.slice(0, 48),
        sourceEntityId: input.sourceEntityId,
        orderId: input.orderId ?? null,
        sellerOrderGroupId: input.sellerOrderGroupId ?? null,
        payloadJson: input.payload as never,
        trigger: input.trigger ?? 'EVENT',
        maxAttempts: input.maxAttempts ?? env.SELLER_ERP_MAX_ATTEMPTS,
        sequenceKey: (input.sequenceKey ?? '').slice(0, 96),
        correlationId: input.correlationId ?? null,
      },
    });

    return id;
  } catch (error) {
    /*
     * The unique index did its job.
     *
     * Swallowed, and deliberately: this is the SUCCESS path for a redelivered
     * webhook. Re-throwing would fail the caller's whole transaction - which
     * for an order confirmation means refusing to confirm an order because we
     * had already agreed to tell Tally about it.
     *
     * Narrowed to the duplicate-key case by checking the message, because
     * swallowing every error here would hide a genuinely broken write. Prisma
     * surfaces MariaDB's 1062 as P2002.
     */
    if (isUniqueViolation(error)) {
      logger.debug(
        { connectionId: input.connectionId, eventType: input.eventType, idempotencyKey },
        'Seller ERP event already queued; ignoring the duplicate',
      );
      return null;
    }

    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'P2002';
}

/**
 * Queue an event only if the connection is in a state that should hold work.
 *
 * The convenience every business caller uses. It resolves the seller's live
 * connection, checks the policy allows this event type, and enqueues - or does
 * nothing at all, quietly, which is the right behaviour for a seller who has
 * never connected an ERP and is the overwhelmingly common case.
 *
 * `canQueue` is far more permissive than `canDispatch`, and the gap is the
 * feature: a bridge that is offline still accrues work, because the seller
 * turning their PC on in the morning is what the queue is FOR.
 */
export async function enqueueIfConnected(input: {
  sellerAccountId: string;
  eventType: SellerErpEventTypeName;
  sourceEntityType: string;
  sourceEntityId: string;
  orderId?: string | null;
  sellerOrderGroupId?: string | null;
  payload: unknown;
  sequenceKey?: string;
  discriminator?: string;
  trigger?: SellerErpTriggerName;
  correlationId?: string | null;
  tx?: PrismaTransaction;
}): Promise<string | null> {
  if (!env.FEATURE_SELLER_ERP) return null;

  const client = input.tx ?? prisma;

  const connections = await client.sellerErpConnection.findMany({
    where: { sellerAccountId: input.sellerAccountId, disabledAt: null },
    select: { id: true, state: true, syncPolicy: true },
  });

  const jobIds: string[] = [];

  /*
   * EVERY live connection gets the event, not just the first.
   *
   * A seller with last year's company and this year's open at a financial year
   * boundary wants the sale in whichever one it belongs to, and deciding which
   * is theirs rather than ours. Each is a separate job with its own
   * idempotency key, so one failing does not hold up the other.
   */
  for (const connection of connections) {
    if (!canQueue(connection.state)) continue;
    if (!policyAllows(connection.syncPolicy, input.eventType)) continue;

    const jobId = await enqueueErpEvent({
      connectionId: connection.id,
      sellerAccountId: input.sellerAccountId,
      eventType: input.eventType,
      sourceEntityType: input.sourceEntityType,
      sourceEntityId: input.sourceEntityId,
      orderId: input.orderId ?? null,
      sellerOrderGroupId: input.sellerOrderGroupId ?? null,
      payload: input.payload,
      trigger: input.trigger ?? 'EVENT',
      sequenceKey: input.sequenceKey ?? '',
      discriminator: input.discriminator,
      maxAttempts: connection.syncPolicy?.maxAttempts ?? env.SELLER_ERP_MAX_ATTEMPTS,
      correlationId: input.correlationId ?? null,
      tx: input.tx,
    });

    if (jobId !== null) jobIds.push(jobId);
  }

  return jobIds[0] ?? null;
}

/**
 * Does this seller's policy want this kind of event posted?
 *
 * A connection with no policy row yet posts NOTHING. That is the safe default
 * and it is the opposite of what a convenience would do: a seller halfway
 * through setup must not discover that orders have been posting into their
 * books since the moment they pressed "connect".
 */
function policyAllows(
  policy: { postSalesOrder: boolean; postSalesInvoice: boolean; postReceipt: boolean; postCreditNote: boolean; syncStockItems: boolean; syncPartyLedgers: boolean; syncGodowns: boolean } | null,
  eventType: SellerErpEventTypeName,
): boolean {
  if (policy === null) return false;

  switch (eventType) {
    case 'SALES_ORDER':
      return policy.postSalesOrder;
    case 'SALES_INVOICE':
      return policy.postSalesInvoice;
    case 'RECEIPT':
      return policy.postReceipt;
    case 'CREDIT_NOTE':
    case 'CANCELLATION':
      return policy.postCreditNote;
    case 'STOCK_ITEM_UPSERT':
      return policy.syncStockItems;
    case 'PARTY_LEDGER_UPSERT':
      return policy.syncPartyLedgers;
    case 'GODOWN_UPSERT':
      return policy.syncGodowns;
    // Reads and tests are never policy-gated: they are how a seller finds out
    // whether anything works, and a policy that could switch them off would
    // make a connection undiagnosable.
    case 'INVENTORY_PULL':
    case 'MASTER_PULL':
    case 'CONNECTION_TEST':
      return true;
  }
}

// ---------------------------------------------------------------------------
// Claiming, for the bridge
// ---------------------------------------------------------------------------

export interface ClaimedErpTask {
  jobId: string;
  eventType: string;
  payload: unknown;
  payloadVersion: number;
  attemptNumber: number;
  correlationId: string | null;
  leaseExpiresAt: string;
}

/**
 * Hand a bridge some work.
 *
 * THE LEASE PATTERN, and it is here for the same MariaDB 10.4 reason the job
 * queue uses it: there is no `SELECT ... FOR UPDATE SKIP LOCKED` on this
 * version, so claiming is a conditional UPDATE and the affected-row count
 * decides who got the job. Two bridges polling in the same second - which
 * happens when a seller has briefly had two machines paired - cannot both
 * claim one task.
 *
 * ORDERING IS ENFORCED HERE. At most one in-flight job per `sequenceKey`, so
 * a Receipt waits for the Invoice it pays. Jobs with an empty key are not
 * grouped and are handed out freely.
 */
export async function claimTasks(input: {
  connectionId: string;
  deviceId: string;
  limit: number;
}): Promise<ClaimedErpTask[]> {
  const limit = Math.min(Math.max(1, input.limit), env.SELLER_ERP_TASK_BATCH_SIZE);
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + env.SELLER_ERP_TASK_LEASE_SECONDS * 1000);

  /*
   * Sequence keys already busy.
   *
   * Read first and excluded from the candidate set, rather than checked per
   * candidate: one query instead of N, and the window between this read and
   * the claim below is harmless - the worst case is that a job is left for the
   * next poll, which is a second's delay and never an out-of-order post.
   */
  const inFlight = await prisma.sellerErpSyncJob.findMany({
    where: {
      connectionId: input.connectionId,
      status: 'IN_FLIGHT',
      leaseExpiresAt: { gt: now },
      sequenceKey: { not: '' },
    },
    select: { sequenceKey: true },
    distinct: ['sequenceKey'],
  });

  const busyKeys = new Set(inFlight.map((row) => row.sequenceKey));

  const candidates = await prisma.sellerErpSyncJob.findMany({
    where: {
      connectionId: input.connectionId,
      status: { in: ['PENDING', 'RETRY_SCHEDULED'] },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
    // Creation order, which for ULIDs is chronological. A Receipt created
    // after its Invoice therefore sorts after it, and the sequence-key rule
    // above is what makes that ordering hold across polls.
    orderBy: { createdAt: 'asc' },
    // Over-fetched, because some will be filtered by a busy sequence key.
    take: limit * 4,
    select: {
      id: true,
      eventType: true,
      payloadJson: true,
      payloadVersion: true,
      attemptCount: true,
      correlationId: true,
      sequenceKey: true,
    },
  });

  const claimed: ClaimedErpTask[] = [];

  for (const candidate of candidates) {
    if (claimed.length >= limit) break;

    if (candidate.sequenceKey !== '' && busyKeys.has(candidate.sequenceKey)) continue;

    /*
     * The claim. `status` in the where clause is the whole race guard: a
     * second bridge reaching the same row finds it already IN_FLIGHT and
     * updates nothing.
     */
    const result = await prisma.sellerErpSyncJob.updateMany({
      where: { id: candidate.id, status: { in: ['PENDING', 'RETRY_SCHEDULED'] } },
      data: {
        status: 'IN_FLIGHT',
        leaseOwner: input.deviceId,
        leaseExpiresAt,
        attemptCount: { increment: 1 },
      },
    });

    if (result.count !== 1) continue;

    if (candidate.sequenceKey !== '') busyKeys.add(candidate.sequenceKey);

    await prisma.sellerErpSyncAttempt.create({
      data: {
        id: newId(),
        jobId: candidate.id,
        attemptNumber: candidate.attemptCount + 1,
        startedAt: now,
        outcome: 'IN_FLIGHT',
        correlationId: candidate.correlationId,
      },
    });

    claimed.push({
      jobId: candidate.id,
      eventType: candidate.eventType,
      payload: candidate.payloadJson,
      payloadVersion: candidate.payloadVersion,
      attemptNumber: candidate.attemptCount + 1,
      correlationId: candidate.correlationId,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
    });
  }

  return claimed;
}

export interface TaskResultInput {
  jobId: string;
  connectionId: string;
  deviceId: string;
  ok: boolean;
  /** What Tally said, parsed by the bridge and checked again here. */
  tallyCounters?: {
    created?: number | null;
    altered?: number | null;
    deleted?: number | null;
    ignored?: number | null;
    errors?: number | null;
    exceptions?: number | null;
    lastVoucherId?: string | null;
  } | null;
  voucherNumber?: string | null;
  masterName?: string | null;
  lineErrors?: { message: string; lineNumber: number | null; missingMaster: string | null }[];
  /** A code from `isTransientFailure`'s vocabulary, where it failed. */
  errorCode?: string | null;
  sanitizedError?: string | null;
  httpStatus?: number | null;
  requestHash?: string | null;
  responseHash?: string | null;
  durationMs?: number | null;
}

/**
 * Record what happened to a claimed task.
 *
 * The lease is checked: a bridge acknowledging a task whose lease expired and
 * which somebody else has since taken is refused, because writing its result
 * would overwrite the winner's. That is not theoretical - it is exactly what a
 * laptop coming out of sleep does.
 */
export async function completeTask(input: TaskResultInput): Promise<void> {
  const job = await prisma.sellerErpSyncJob.findUnique({
    where: { id: input.jobId },
    select: {
      id: true,
      sellerAccountId: true,
      connectionId: true,
      status: true,
      leaseOwner: true,
      attemptCount: true,
      maxAttempts: true,
      eventType: true,
      sourceEntityType: true,
      sourceEntityId: true,
      connection: { select: { syncPolicy: { select: { retryBaseSeconds: true } } } },
    },
  });

  if (job === null) throw notFound('ERP task');

  // Tenant isolation, at the row. A bridge for one seller cannot acknowledge
  // another seller's work even given the id.
  if (job.connectionId !== input.connectionId) throw notFound('ERP task');

  if (job.status !== 'IN_FLIGHT' || job.leaseOwner !== input.deviceId) {
    throw conflict(
      ErrorCode.SELLER_ERP_JOB_NOT_ACTIONABLE,
      'That task is no longer assigned to this machine.',
      [{ code: 'LEASE_LOST' }],
    );
  }

  const now = new Date();
  const counters = input.tallyCounters ?? {};

  /*
   * A 200 IS NOT A SUCCESS, and this is the second place that is enforced.
   *
   * The bridge parses Tally's reply and checks the counters; this checks them
   * again from the numbers it reported. Twice, because the bridge runs on the
   * seller's machine and this does not: a bridge with a bug, an old build, or
   * a modified one must not be able to mark an accounting event successful by
   * saying so. The authority on "did this post" is the counters, and they are
   * evaluated on the server.
   */
  const wrote = (counters.created ?? 0) + (counters.altered ?? 0) + (counters.deleted ?? 0);
  const refused =
    (counters.errors ?? 0) > 0 ||
    (counters.exceptions ?? 0) > 0 ||
    (input.lineErrors ?? []).length > 0;

  const expectsWrite = job.eventType !== 'INVENTORY_PULL' && job.eventType !== 'MASTER_PULL' && job.eventType !== 'CONNECTION_TEST';

  const succeeded = input.ok && !refused && (!expectsWrite || wrote > 0);

  await prisma.$transaction(async (tx) => {
    await tx.sellerErpSyncAttempt.updateMany({
      where: { jobId: job.id, attemptNumber: job.attemptCount },
      data: {
        finishedAt: now,
        durationMs: input.durationMs ?? null,
        outcome: succeeded ? 'SUCCEEDED' : 'FAILED',
        httpStatus: input.httpStatus ?? null,
        tallyCreated: counters.created ?? null,
        tallyAltered: counters.altered ?? null,
        tallyDeleted: counters.deleted ?? null,
        tallyIgnored: counters.ignored ?? null,
        tallyErrors: counters.errors ?? null,
        tallyExceptions: counters.exceptions ?? null,
        tallyLastVoucherId: counters.lastVoucherId ?? null,
        lineErrorsJson: (input.lineErrors ?? []).length === 0 ? undefined : (input.lineErrors as never),
        sanitizedError: input.sanitizedError?.slice(0, 1000) ?? null,
        // Hashes, never bodies. See `SellerErpSyncAttempt` in the schema.
        requestHash: input.requestHash ?? null,
        responseHash: input.responseHash ?? null,
      },
    });

    if (succeeded) {
      await tx.sellerErpSyncJob.update({
        where: { id: job.id },
        data: {
          status: 'SUCCEEDED',
          completedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          externalVoucherId: counters.lastVoucherId ?? null,
          externalVoucherNumber: input.voucherNumber ?? null,
          externalMasterName: input.masterName ?? null,
          sanitizedError: null,
          errorCode: null,
        },
      });

      /*
       * What our row became in Tally.
       *
       * The second duplicate guard - see the file header. Written on success
       * so a later manual re-sync of the same entity finds it and verifies
       * instead of posting a second voucher.
       */
      if (job.sourceEntityId !== null) {
        await tx.sellerErpExternalReference.upsert({
          where: {
            connectionId_entityType_localId: {
              connectionId: job.connectionId,
              entityType: job.sourceEntityType,
              localId: job.sourceEntityId,
            },
          },
          create: {
            id: newId(),
            connectionId: job.connectionId,
            entityType: job.sourceEntityType,
            localId: job.sourceEntityId,
            tallyName: input.masterName ?? null,
            voucherNumber: input.voucherNumber ?? null,
            lastSyncedAt: now,
          },
          update: {
            tallyName: input.masterName ?? undefined,
            voucherNumber: input.voucherNumber ?? undefined,
            lastSyncedAt: now,
          },
        });
      }

      await tx.sellerErpConnection.update({
        where: { id: job.connectionId },
        data: {
          lastSuccessfulSyncAt: now,
          consecutiveFailures: 0,
          circuitState: 'CLOSED',
          circuitOpenedAt: null,
        },
      });

      await tx.sellerErpBridgeDevice.update({
        where: { id: input.deviceId },
        data: { tasksCompleted: { increment: 1 } },
      });

      return;
    }

    /*
     * A failure. Retried or not, decided by WHAT kind of failure it was.
     *
     * A failure of the CONNECTION is transient - Tally was closed, the machine
     * slept - and comes back. A failure of the CONTENT is not: Tally saying a
     * ledger does not exist will say it for ever, and eight goes at a refusal
     * is noise that delays the moment somebody is told. See
     * `isTransientFailure`.
     */
    const code = input.errorCode ?? (refused ? 'SELLER_ERP_TALLY_REJECTED' : 'UNKNOWN');
    const transient = isTransientFailure(code);
    const exhausted = job.attemptCount >= job.maxAttempts;

    const status = !transient ? 'FAILED' : exhausted ? 'DEAD_LETTER' : 'RETRY_SCHEDULED';

    const nextRetryAt =
      status === 'RETRY_SCHEDULED'
        ? new Date(
            now.getTime() +
              retryDelaySeconds({
                attemptCount: job.attemptCount,
                baseSeconds:
                  job.connection.syncPolicy?.retryBaseSeconds ?? env.SELLER_ERP_RETRY_BASE_SECONDS,
              }) *
                1000,
          )
        : null;

    await tx.sellerErpSyncJob.update({
      where: { id: job.id },
      data: {
        status,
        nextRetryAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode: code.slice(0, 64),
        sanitizedError:
          input.sanitizedError?.slice(0, 1000) ??
          (input.lineErrors ?? [])
            .map((error) => error.message)
            .join(' ')
            .slice(0, 1000),
        completedAt: status === 'RETRY_SCHEDULED' ? null : now,
      },
    });

    await tx.sellerErpBridgeDevice.update({
      where: { id: input.deviceId },
      data: { tasksFailed: { increment: 1 } },
    });

    /*
     * The circuit.
     *
     * Counted per connection, and it stops the dispatcher handing out work
     * until a test passes. Without it a seller whose Tally has been closed for
     * a fortnight gets every queued job attempted on every poll for a
     * fortnight - which burns the retry budget of jobs that would have
     * succeeded the moment the machine came back.
     */
    const connection = await tx.sellerErpConnection.update({
      where: { id: job.connectionId },
      data: { consecutiveFailures: { increment: 1 } },
      select: { consecutiveFailures: true, circuitState: true },
    });

    if (
      connection.consecutiveFailures >= env.SELLER_ERP_FAILURE_THRESHOLD &&
      connection.circuitState === 'CLOSED'
    ) {
      await tx.sellerErpConnection.update({
        where: { id: job.connectionId },
        data: { circuitState: 'OPEN', circuitOpenedAt: now },
      });
    }
  });
}

/**
 * Return work whose bridge died mid-task.
 *
 * The lease reaper, and the counterpart to `claimTasks`. A machine that
 * crashed, slept or lost its network holds tasks that are neither done nor
 * available; without this they sit IN_FLIGHT for ever and the seller's books
 * silently stop being updated.
 *
 * Released to PENDING rather than failed, and the attempt is NOT rolled back:
 * the attempt row stands as evidence that a go was made, and the count is what
 * eventually dead-letters a task that repeatedly kills the agent that takes it.
 */
export async function reapExpiredLeases(): Promise<number> {
  const now = new Date();

  const { count } = await prisma.sellerErpSyncJob.updateMany({
    where: { status: 'IN_FLIGHT', leaseExpiresAt: { lt: now } },
    data: { status: 'PENDING', leaseOwner: null, leaseExpiresAt: null },
  });

  if (count > 0) {
    logger.warn({ count }, 'Released seller ERP tasks whose bridge lease expired');
  }

  return count;
}

// ---------------------------------------------------------------------------
// What the seller sees, and what they can do about it
// ---------------------------------------------------------------------------

export interface ErpJobView {
  id: string;
  eventType: string;
  status: string;
  trigger: string;
  sourceEntityType: string;
  sourceEntityId: string | null;
  orderId: string | null;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  externalVoucherNumber: string | null;
  errorCode: string | null;
  /** Safe to show. Never a Tally body, never a path from the seller's machine. */
  sanitizedError: string | null;
  createdAt: string;
  completedAt: string | null;
}

export async function listJobs(input: {
  membership: SellerMembership;
  connectionId: string;
  status?: string | null;
  page?: number;
  pageSize?: number;
}): Promise<{ rows: ErpJobView[]; total: number; counts: Record<string, number> }> {
  assertSellerPermission(input.membership, SellerPermission.INTEGRATION_READ);

  const connection = await prisma.sellerErpConnection.findUnique({
    where: { id: input.connectionId },
    select: { sellerAccountId: true },
  });
  assertSellerOwnership(input.membership, connection?.sellerAccountId ?? null, 'ERP connection');

  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 25));

  const where = {
    connectionId: input.connectionId,
    // Belt and braces on top of the ownership check above: even given a
    // connection id from somewhere else, the seller filter makes the query
    // return nothing.
    sellerAccountId: input.membership.sellerAccountId,
    ...(input.status === null || input.status === undefined ? {} : { status: input.status as never }),
  };

  const [rows, total, grouped] = await Promise.all([
    prisma.sellerErpSyncJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.sellerErpSyncJob.count({ where }),
    prisma.sellerErpSyncJob.groupBy({
      by: ['status'],
      where: {
        connectionId: input.connectionId,
        sellerAccountId: input.membership.sellerAccountId,
      },
      _count: { _all: true },
    }),
  ]);

  return {
    rows: rows.map((job) => ({
      id: job.id,
      eventType: job.eventType,
      status: job.status,
      trigger: job.trigger,
      sourceEntityType: job.sourceEntityType,
      sourceEntityId: job.sourceEntityId,
      orderId: job.orderId,
      attemptCount: job.attemptCount,
      maxAttempts: job.maxAttempts,
      nextRetryAt: job.nextRetryAt?.toISOString() ?? null,
      externalVoucherNumber: job.externalVoucherNumber,
      errorCode: job.errorCode,
      sanitizedError: job.sanitizedError,
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt?.toISOString() ?? null,
    })),
    total,
    counts: Object.fromEntries(grouped.map((row) => [row.status, row._count._all])),
  };
}

/**
 * Try a failed job again, by hand.
 *
 * Only from FAILED or DEAD_LETTER. A job that is PENDING will run on its own,
 * one that is IN_FLIGHT is being run right now, and one that SUCCEEDED has
 * already posted - "retrying" that last one is the request that would create
 * the duplicate voucher this whole module is built to prevent, so it is
 * refused rather than made idempotent-and-allowed.
 *
 * The attempt counter is NOT reset. It is the history of how hard this has
 * been tried, and zeroing it would let a permanently broken job be retried
 * without limit by somebody pressing a button.
 */
export async function retryJob(input: {
  membership: SellerMembership;
  jobId: string;
  actorUserId: string | null;
}): Promise<void> {
  assertSellerPermission(input.membership, SellerPermission.INTEGRATION_WRITE);

  const job = await prisma.sellerErpSyncJob.findUnique({
    where: { id: input.jobId },
    select: {
      id: true,
      sellerAccountId: true,
      connectionId: true,
      status: true,
      eventType: true,
      attemptCount: true,
      maxAttempts: true,
    },
  });

  assertSellerOwnership(input.membership, job?.sellerAccountId ?? null, 'ERP task');
  if (job === null) throw notFound('ERP task');

  if (job.status !== 'FAILED' && job.status !== 'DEAD_LETTER') {
    throw conflict(
      ErrorCode.SELLER_ERP_JOB_NOT_ACTIONABLE,
      job.status === 'SUCCEEDED'
        ? 'This has already been posted to Tally. Re-sending it would create a second voucher.'
        : 'This is already queued or running.',
      [{ code: 'NOT_RETRYABLE', meta: { status: job.status } }],
    );
  }

  await prisma.sellerErpSyncJob.update({
    where: { id: job.id },
    data: {
      status: 'PENDING',
      nextRetryAt: null,
      completedAt: null,
      // Room for one more go, and only one. A person who has fixed the mapping
      // gets an attempt; a person pressing the button forty times gets forty
      // attempts against a job that will fail forty times, which is why the
      // ceiling moves by one rather than resetting.
      maxAttempts: Math.max(job.maxAttempts, job.attemptCount + 1),
      errorCode: null,
    },
  });

  await recordErpAudit({
    sellerAccountId: job.sellerAccountId,
    connectionId: job.connectionId,
    action: 'seller_erp.job_retried',
    actor: { type: 'CUSTOMER', userId: input.actorUserId, label: input.membership.displayName },
    summary: 'A failed task was queued to try again.',
    meta: { jobId: job.id, eventType: job.eventType, attemptCount: job.attemptCount },
  });
}

/**
 * Give up on a job deliberately.
 *
 * For the event that should never have been queued - an order cancelled before
 * it posted, a master the seller decided to create by hand. Cancelling is
 * NEVER available for something already posted: the voucher exists in their
 * books and the way to undo it is a Credit Note, not a status change here.
 */
export async function cancelJob(input: {
  membership: SellerMembership;
  jobId: string;
  actorUserId: string | null;
}): Promise<void> {
  assertSellerPermission(input.membership, SellerPermission.INTEGRATION_WRITE);

  const job = await prisma.sellerErpSyncJob.findUnique({
    where: { id: input.jobId },
    select: { id: true, sellerAccountId: true, connectionId: true, status: true, eventType: true },
  });

  assertSellerOwnership(input.membership, job?.sellerAccountId ?? null, 'ERP task');
  if (job === null) throw notFound('ERP task');

  if (job.status === 'SUCCEEDED') {
    throw conflict(
      ErrorCode.SELLER_ERP_JOB_NOT_ACTIONABLE,
      'This has already been posted to Tally. Reverse it there rather than cancelling it here.',
      [{ code: 'ALREADY_POSTED' }],
    );
  }

  if (job.status === 'IN_FLIGHT') {
    throw conflict(
      ErrorCode.SELLER_ERP_JOB_NOT_ACTIONABLE,
      'This is being sent right now. Wait for it to finish.',
      [{ code: 'IN_FLIGHT' }],
    );
  }

  await prisma.sellerErpSyncJob.update({
    where: { id: job.id },
    data: { status: 'CANCELLED', completedAt: new Date(), nextRetryAt: null },
  });

  await recordErpAudit({
    sellerAccountId: job.sellerAccountId,
    connectionId: job.connectionId,
    action: 'seller_erp.job_cancelled',
    actor: { type: 'CUSTOMER', userId: input.actorUserId, label: input.membership.displayName },
    summary: 'A queued task was cancelled and will not be sent.',
    meta: { jobId: job.id, eventType: job.eventType },
  });
}
