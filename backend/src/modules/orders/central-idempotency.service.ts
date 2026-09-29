/**
 * The central half of idempotency: replay for routes whose own service has none.
 *
 * `http/idempotency-policy.ts` declares which routes need an Idempotency-Key.
 * Most of the critical ones already run `runIdempotent` in their service (see
 * `idempotency.service.ts`), which is the stronger form: the claim and the
 * operation's result live beside the business write. The rest are declared
 * `handledBy: 'central'`, and for those the route hook calls the three
 * functions here:
 *
 *   claim     before the handler. Inserts IN_PROGRESS on unique(scope, key).
 *             A completed record for the same caller and the same request
 *             replays; a different request under the same key, or another
 *             caller's key, is refused; one still in flight is 409.
 *   complete  after a 2xx. Stores the response so the next attempt replays it.
 *   release   after anything else. A refused attempt must not poison the key.
 *
 * Same table, same contract and same error codes as `runIdempotent`, so a
 * client cannot tell which of the two answered it - which is the point.
 */
import { createHash } from 'node:crypto';
import { ErrorCode, conflict } from '../../domain/errors.js';
import { hashRequestBody } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';

const RECORD_TTL_HOURS = 24;
const STALE_IN_PROGRESS_MINUTES = 5;

/** A scope that fits the 64-character column however long the route path is. */
export function centralScopeFor(method: string, url: string): string {
  const literal = `http:${method.toUpperCase()} ${url}`;
  if (literal.length <= 64) return literal;
  return `http:${createHash('sha256').update(literal).digest('hex').slice(0, 59)}`;
}

export type CentralClaim =
  | { kind: 'claimed' }
  | { kind: 'replay'; response: unknown; httpStatus: number };

export async function claimCentralIdempotency(input: {
  scope: string;
  key: string;
  ownerId: string | null;
  /** Everything that identifies the request: params, query and body. */
  body: unknown;
}): Promise<CentralClaim> {
  const requestHash = hashRequestBody(input.body);
  const now = new Date();

  const claim = await prisma.idempotencyRecord.createMany({
    data: [
      {
        id: newId(),
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
  if (claim.count === 1) return { kind: 'claimed' };

  const existing = await prisma.idempotencyRecord.findUnique({
    where: { scope_key: { scope: input.scope, key: input.key } },
  });

  if (existing === null) {
    throw conflict(ErrorCode.IDEMPOTENT_REQUEST_IN_PROGRESS, 'That request could not be resolved. Please retry.');
  }
  if (existing.ownerId !== input.ownerId) {
    throw conflict(
      ErrorCode.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY,
      'That idempotency key belongs to a different request.',
      [{ field: 'Idempotency-Key', code: 'OWNER_MISMATCH' }],
    );
  }
  if (existing.requestHash !== requestHash) {
    throw conflict(
      ErrorCode.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY,
      'This idempotency key was already used for a different request. Use a new key.',
      [{ field: 'Idempotency-Key', code: 'BODY_MISMATCH' }],
    );
  }
  if (existing.status === 'COMPLETED') {
    const stored = existing.responseJson as { v?: unknown } | null;
    return { kind: 'replay', response: stored?.v ?? null, httpStatus: existing.httpStatus ?? 200 };
  }

  if (existing.createdAt < new Date(Date.now() - STALE_IN_PROGRESS_MINUTES * 60_000)) {
    await prisma.idempotencyRecord.deleteMany({ where: { id: existing.id, status: 'IN_PROGRESS' } });
    return claimCentralIdempotency(input);
  }

  throw conflict(
    ErrorCode.IDEMPOTENT_REQUEST_IN_PROGRESS,
    'This request is already being processed. Please wait a moment before retrying.',
    [{ field: 'Idempotency-Key', code: 'IN_PROGRESS' }],
  );
}

export async function completeCentralIdempotency(input: {
  scope: string;
  key: string;
  response: unknown;
  httpStatus: number;
}): Promise<void> {
  await prisma.idempotencyRecord.updateMany({
    where: { scope: input.scope, key: input.key, status: 'IN_PROGRESS' },
    data: {
      status: 'COMPLETED',
      // Wrapped, so an empty or null body is still a JSON object the column holds.
      responseJson: { v: input.response ?? null } as never,
      httpStatus: input.httpStatus,
      completedAt: new Date(),
    },
  });
}

export async function releaseCentralIdempotency(input: { scope: string; key: string }): Promise<void> {
  await prisma.idempotencyRecord.deleteMany({
    where: { scope: input.scope, key: input.key, status: 'IN_PROGRESS' },
  });
}
