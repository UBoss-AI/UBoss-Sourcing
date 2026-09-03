/**
 * Idempotency.
 *
 * A customer double-clicks Pay. A mobile network retries a POST it never saw
 * the response to. A payment provider redelivers a webhook. In each case the
 * same operation arrives twice, and charging twice is not recoverable by
 * apology.
 *
 * The contract:
 *   - Same key, same body  -> the first response is replayed. No second effect.
 *   - Same key, DIFFERENT body -> rejected. Never silently answered with the
 *     earlier response, because the caller is asking for something else and
 *     would believe it succeeded.
 *   - Key in flight -> 409. The caller retries once the first attempt settles.
 *
 * The claim is a conditional insert on `unique(scope, key)`, so two concurrent
 * requests race at the database and exactly one proceeds.
 */
import { ErrorCode, badRequest, conflict } from '../../domain/errors.js';
import { hashRequestBody } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';

/** Logical operations that accept an Idempotency-Key. */
export const IdempotencyScope = {
  CHECKOUT_SUBMIT: 'checkout.submit',
  PAYMENT_CREATE: 'payment.create',
  REFUND_CREATE: 'refund.create',
  SCHEDULE_OCCURRENCE: 'schedule.occurrence',
  IMPORT_CONFIRM: 'import.confirm',
} as const;

export type IdempotencyScopeValue = (typeof IdempotencyScope)[keyof typeof IdempotencyScope];

/** Records expire after 24h - long enough for any legitimate client retry. */
const RECORD_TTL_HOURS = 24;

/**
 * How long a record may sit IN_PROGRESS before it is considered abandoned.
 *
 * A process that crashes mid-checkout leaves a claim nobody will ever complete.
 * Without this the key would be permanently poisoned and the customer could
 * never retry.
 */
const STALE_IN_PROGRESS_MINUTES = 5;

export interface IdempotentResult<T> {
  /** True when this is a replay of a completed request. */
  replayed: boolean;
  value: T;
  httpStatus: number;
}

export interface RunIdempotentInput<T> {
  scope: IdempotencyScopeValue;
  key: string;
  /** Scopes the key to its caller, so two customers cannot collide. */
  ownerId: string;
  body: unknown;
  successStatus?: number;
  operation: () => Promise<T>;
}

/**
 * Run an operation at most once per (scope, key).
 *
 * The stored response is JSON, so the operation's return value must survive a
 * round trip - money as strings, dates as ISO. That is already the wire shape,
 * so callers return exactly what the route would send.
 */
export async function runIdempotent<T>(input: RunIdempotentInput<T>): Promise<IdempotentResult<T>> {
  if (input.key.trim().length === 0) {
    throw badRequest(ErrorCode.IDEMPOTENCY_KEY_REQUIRED, 'An Idempotency-Key header is required.', [
      { field: 'Idempotency-Key', code: 'REQUIRED' },
    ]);
  }

  const requestHash = hashRequestBody(input.body);
  const successStatus = input.successStatus ?? 201;
  const id = newId();
  const now = new Date();

  // Claim the key. `createMany` with skipDuplicates rather than a caught
  // unique-violation: it is one statement, and a raised constraint error would
  // be indistinguishable from other failures.
  const claim = await prisma.idempotencyRecord.createMany({
    data: [
      {
        id,
        scope: input.scope,
        key: input.key,
        requestHash,
        status: 'IN_PROGRESS',
        ownerId: input.ownerId,
        expiresAt: new Date(now.getTime() + RECORD_TTL_HOURS * 3_600_000),
      },
    ],
    skipDuplicates: true,
  });

  if (claim.count === 1) {
    // We own this key. Run the operation for real.
    try {
      const value = await input.operation();

      await prisma.idempotencyRecord.update({
        where: { scope_key: { scope: input.scope, key: input.key } },
        data: {
          status: 'COMPLETED',
          responseJson: value as never,
          httpStatus: successStatus,
          completedAt: new Date(),
        },
      });

      return { replayed: false, value, httpStatus: successStatus };
    } catch (error) {
      // Release the claim so the caller can correct the problem and retry with
      // the same key. Holding it would lock them out of their own order.
      await prisma.idempotencyRecord
        .deleteMany({ where: { scope: input.scope, key: input.key, status: 'IN_PROGRESS' } })
        .catch((cleanupError: unknown) => {
          logger.error({ err: cleanupError, scope: input.scope }, 'failed to release idempotency claim');
        });

      throw error;
    }
  }

  // Somebody else owns the key. Work out which case this is.
  const existing = await prisma.idempotencyRecord.findUnique({
    where: { scope_key: { scope: input.scope, key: input.key } },
  });

  if (existing === null) {
    // Expired or cleaned up between the insert and this read. Vanishingly rare;
    // asking the caller to retry is safer than assuming.
    throw conflict(
      ErrorCode.IDEMPOTENT_REQUEST_IN_PROGRESS,
      'That request could not be resolved. Please retry.',
    );
  }

  // A different caller reusing the same key string. Treated as unknown rather
  // than replayed - one customer must never receive another's order.
  if (existing.ownerId !== null && existing.ownerId !== input.ownerId) {
    throw conflict(
      ErrorCode.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY,
      'That idempotency key belongs to a different request.',
      [{ field: 'Idempotency-Key', code: 'OWNER_MISMATCH' }],
    );
  }

  // The dangerous case: same key, different payload. Replaying the old response
  // would tell the caller their NEW order succeeded when it was never placed.
  if (existing.requestHash !== requestHash) {
    throw conflict(
      ErrorCode.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY,
      'This idempotency key was already used for a different request. Use a new key.',
      [{ field: 'Idempotency-Key', code: 'BODY_MISMATCH' }],
    );
  }

  if (existing.status === 'COMPLETED') {
    return {
      replayed: true,
      value: existing.responseJson as T,
      httpStatus: existing.httpStatus ?? successStatus,
    };
  }

  // IN_PROGRESS. If it has been stuck long enough that the owning process must
  // be gone, release it so the customer is not locked out of their own order.
  const staleAt = new Date(Date.now() - STALE_IN_PROGRESS_MINUTES * 60_000);

  if (existing.createdAt < staleAt) {
    logger.warn(
      { scope: input.scope, key: input.key, claimedAt: existing.createdAt },
      'releasing a stale in-progress idempotency claim',
    );

    await prisma.idempotencyRecord.deleteMany({
      where: { id: existing.id, status: 'IN_PROGRESS' },
    });

    return runIdempotent(input);
  }

  throw conflict(
    ErrorCode.IDEMPOTENT_REQUEST_IN_PROGRESS,
    'This request is already being processed. Please wait a moment before retrying.',
    [{ field: 'Idempotency-Key', code: 'IN_PROGRESS' }],
  );
}

/** Housekeeping: drop expired records. Run periodically by the worker. */
export async function purgeExpiredIdempotencyRecords(): Promise<number> {
  const result = await prisma.idempotencyRecord.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}
