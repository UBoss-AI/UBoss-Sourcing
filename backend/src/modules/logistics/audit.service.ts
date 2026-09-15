/**
 * What was done inside one logistics organisation.
 *
 * A separate trail from `AuditLog`, for exactly the reason `SellerAuditLog` is
 * separate: the operator's trail describes the whole marketplace and a tenant
 * must not be able to read it. This one is scoped to a carrier and is readable
 * by that carrier's OWNER and ADMIN.
 *
 * Some actions write BOTH. An operator suspending a carrier, correcting a
 * status or rotating a credential writes here so the carrier can see what was
 * done to it, and writes `AuditLog` so the marketplace's own accountability
 * record is complete. The two are written in the same transaction and neither
 * is derived from the other.
 *
 * NOTHING HERE EVER STORES A SECRET. Values are redacted on the way in by the
 * same key list `audit.service.ts` uses, plus the ones this feature adds:
 * coordinates, delivery OTPs and device tokens. A coordinate in an audit row
 * is an employee's position retained for as long as the audit window, which is
 * two years.
 */
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';

/**
 * Keys whose values never reach an audit row.
 *
 * Three groups, and the third is the one this feature adds. Credentials and
 * tokens are obvious. Coordinates are not: they are not a secret, they are
 * personal data with a much shorter retention window than the audit trail, and
 * writing one here would quietly extend that window to two years. The event
 * timeline is where a position belongs, and it is swept.
 */
const REDACTED_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passwordHash',
  'token',
  'tokenHash',
  'secret',
  'credentialsEnc',
  'webhookSecretEnc',
  'deviceToken',
  'deviceTokenHash',
  'apiKey',
  'otp',
  'deliveryOtp',
  'signature',
  'latitude',
  'longitude',
  'lastLatitude',
  'lastLongitude',
  'deliveryLatitude',
  'deliveryLongitude',
  'locationLatitude',
  'locationLongitude',
]);

const REDACTED = '[redacted]';

/**
 * Deep-redact a value for storage.
 *
 * Recursive because these payloads are nested - a shipment diff carries a
 * package array carrying a batch reference - and a shallow pass would miss
 * every one of them. Depth-limited because a cyclic or pathological object
 * reaching an audit call must not take the request down; past the limit the
 * branch is replaced with a marker rather than dropped, so a reader can see
 * something was there.
 */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => redact(entry, depth + 1));
  }

  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = REDACTED_KEYS.has(key) ? REDACTED : redact(entry, depth + 1);
    }
    return output;
  }

  return value;
}

export interface LogisticsAuditEntry {
  logisticsPartnerId: string;
  /** Null for the system. A marketplace staff action names the staff account. */
  actorUserId?: string | null;
  /**
   * How the actor is shown to the carrier.
   *
   * For an operator action this is a ROLE - "UBOSS operations" - and never a
   * member of staff's name, the same line `SellerAuditLog.actorLabel` draws. A
   * carrier arguing about a suspension does not get an individual to chase.
   */
  actorLabel: string;
  /** Dotted, past tense: `logistics.shipment.accepted`. */
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  /** A sentence a person reads. A diff is not a sentence. */
  summary?: string | null;
  /**
   * True when this row records somebody unmasking a contact detail.
   *
   * Its own field rather than a value of `action`, because it is the one thing
   * a data-protection review looks for and a review should not have to know
   * which action strings mean "a person read a telephone number".
   */
  isContactReveal?: boolean;
  ipAddress?: string | null;
  correlationId?: string | null;
}

/** The label an operator action is shown to a carrier under. */
export const OPERATOR_LABEL = 'UBOSS operations';

/**
 * Write one row.
 *
 * Accepts a transaction, and callers pass one wherever the audited thing and
 * the audit of it must succeed or fail together - which is almost everywhere.
 * An accepted assignment with no record of who accepted it is the shape of
 * every disputed delivery.
 *
 * Never throws into the caller. An audit write that fails must not undo the
 * business action it describes, because the alternative - a carrier unable to
 * mark a parcel delivered because a log table is full - is worse than a gap in
 * the log. The failure is logged by the driver underneath.
 */
export async function recordLogisticsAudit(
  entry: LogisticsAuditEntry,
  tx?: PrismaTransaction,
): Promise<void> {
  const client = tx ?? prisma;

  try {
    await client.logisticsAuditLog.create({
      data: {
        id: newId(),
        logisticsPartnerId: entry.logisticsPartnerId,
        actorUserId: entry.actorUserId ?? null,
        actorLabel: entry.actorLabel.slice(0, 160),
        action: entry.action.slice(0, 64),
        resourceType: entry.resourceType.slice(0, 48),
        resourceId: entry.resourceId ?? null,
        beforeJson: entry.before === undefined ? undefined : (redact(entry.before) as object),
        afterJson: entry.after === undefined ? undefined : (redact(entry.after) as object),
        summary: entry.summary?.slice(0, 512) ?? null,
        isContactReveal: entry.isContactReveal === true,
        ipAddress: entry.ipAddress ?? null,
        correlationId: entry.correlationId ?? null,
      },
    });
  } catch {
    /*
     * Swallowed on purpose, and only when no transaction was supplied.
     *
     * Inside a transaction the caller has asked for all-or-nothing and gets
     * it: the throw propagates and rolls the business change back with it.
     * Outside one, this is a best-effort record beside an action that has
     * already happened, and failing the request would be reporting a failure
     * that did not occur.
     */
    if (tx !== undefined) throw new Error('logistics audit write failed inside a transaction');
  }
}

export interface LogisticsAuditPage {
  entries: {
    id: string;
    actorLabel: string;
    action: string;
    resourceType: string;
    resourceId: string | null;
    summary: string | null;
    isContactReveal: boolean;
    createdAt: Date;
  }[];
  nextCursor: string | null;
}

/**
 * One carrier's trail.
 *
 * Cursor-paged on the primary key rather than offset-paged, because a trail is
 * append-only and an offset page shifts under the reader every time a row
 * lands. `beforeJson`/`afterJson` are deliberately NOT selected: the list is a
 * list, and a diff that nobody asked for is a payload carrying whatever the
 * redaction pass did not think of.
 */
export async function listLogisticsAudit(
  logisticsPartnerId: string,
  options: { limit?: number; cursor?: string | null; action?: string | null } = {},
): Promise<LogisticsAuditPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

  const rows = await prisma.logisticsAuditLog.findMany({
    where: {
      logisticsPartnerId,
      ...(options.action !== undefined && options.action !== null
        ? { action: options.action }
        : {}),
      ...(options.cursor !== undefined && options.cursor !== null
        ? { id: { lt: options.cursor } }
        : {}),
    },
    // Ids are ULIDs, so descending id IS descending time, and it uses the
    // primary key rather than a secondary sort.
    orderBy: { id: 'desc' },
    take: limit + 1,
    select: {
      id: true,
      actorLabel: true,
      action: true,
      resourceType: true,
      resourceId: true,
      summary: true,
      isContactReveal: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(0, limit) : rows;

  return {
    entries,
    nextCursor: hasMore ? (entries[entries.length - 1]?.id ?? null) : null,
  };
}
