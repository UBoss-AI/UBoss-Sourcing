/**
 * The seller's own record of what happened to their account.
 *
 * A second audit log beside `AuditLog`, and the duplication is the point. The
 * operator's log carries internal review notes, other sellers' identifiers and
 * the names of staff who made decisions - none of which belongs on a seller's
 * screen. Serving a seller a filtered view of the operator's log would work
 * until the day a filter missed a column, and that failure is silent and
 * one-directional.
 *
 * So sellers get their own table, written deliberately, containing only what
 * they are entitled to read. An operator action appears in it as a ROLE
 * ("Marketplace moderation"), never as a person's name.
 */
import type { ActorType } from '../../generated/prisma/enums.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';

export interface SellerAuditActor {
  type: ActorType;
  /** The signed-in user, when there was one. */
  userId?: string | null;
  /**
   * What the seller sees. For a seller's own member this is their name; for an
   * operator it is a role such as "Marketplace moderation". Never a staff
   * member's name - a seller does not need to know which individual refused
   * their listing, and telling them invites them to go round the process.
   */
  label?: string | null;
}

export interface RecordSellerAuditInput {
  sellerAccountId: string;
  /** Dotted, past tense: `seller.listing.submitted`. */
  action: string;
  actor: SellerAuditActor;
  resourceType: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  /**
   * One sentence, written for the seller. Composed at the call site rather
   * than derived from the JSON, because a diff is not a sentence and "status:
   * PENDING_REVIEW -> ACTION_REQUIRED" is not something anybody wants to read
   * in a list.
   */
  summary?: string | null;
  correlationId?: string | null;
  /** Pass the transaction when the audit row must live or die with the change. */
  tx?: PrismaTransaction;
}

/**
 * Fields that must never reach this table, whatever a caller passes.
 *
 * The `before`/`after` payloads are convenient and that is exactly the risk:
 * somebody will one day pass a whole row, and a whole row eventually grows a
 * column holding a token. Stripped rather than rejected - an audit row that
 * refuses to be written because of one field is an audit row that does not
 * exist.
 */
const REDACTED_KEYS = new Set([
  'password',
  'passwordhash',
  'token',
  'tokenhash',
  'secret',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'signature',
  'internalnotes',
  'accountnumber',
  'iban',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(entry, depth + 1);
  }
  return result;
}

/**
 * Write one seller audit row.
 *
 * Never throws. An audit write that fails must not take the business operation
 * down with it - losing the trail for one action is bad, and refusing to ship
 * an order because the trail could not be written is worse. The failure is
 * logged at error level so it is visible rather than silent.
 */
export async function recordSellerAudit(input: RecordSellerAuditInput): Promise<void> {
  const client = input.tx ?? prisma;

  try {
    await client.sellerAuditLog.create({
      data: {
        id: newId(),
        sellerAccountId: input.sellerAccountId,
        action: input.action,
        actorType: input.actor.type,
        actorUserId: input.actor.userId ?? null,
        actorLabel: input.actor.label ?? null,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        beforeJson: input.before === undefined ? undefined : (redact(input.before) as never),
        afterJson: input.after === undefined ? undefined : (redact(input.after) as never),
        summary: input.summary ?? null,
        correlationId: input.correlationId ?? null,
      },
    });
  } catch (error) {
    logger.error(
      { err: error, sellerAccountId: input.sellerAccountId, action: input.action },
      'Failed to write seller audit row',
    );
  }
}

/** The label a seller sees for an action this marketplace's staff took. */
export const OPERATOR_LABEL = 'Marketplace moderation';
