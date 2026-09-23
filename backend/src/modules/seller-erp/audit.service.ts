/**
 * The trail of what happened to a seller's accounting connection.
 *
 * Its own table rather than rows in `SellerAuditLog`, because the questions
 * asked of it are different and so is who asks them. A pairing, a token
 * rotation, a revocation and a change to a tax ledger mapping are what
 * somebody follows after a dispute about what posted into whose books, and
 * they need to be findable without wading through four thousand listing edits.
 *
 * WHAT NEVER REACHES IT
 *
 * A bridge token, a pairing code, a Tally response body, a buyer's name or
 * address. `redact` below is the guarantee, and it works by ALLOWING keys
 * rather than by stripping known-bad ones: a new field added to a caller's
 * meta object is absent from the audit row until somebody adds it to the list,
 * which is the failure direction that loses a diagnostic rather than leaks a
 * credential.
 */
import type { ActorType } from '../../generated/prisma/enums.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';

/**
 * Meta keys an audit row may carry.
 *
 * An allowlist, for the reason in the header. Everything here is either a
 * non-secret identifier, a count, a state name or a figure - nothing that
 * identifies a buyer and nothing that authenticates anything.
 */
const ALLOWED_META_KEYS: ReadonlySet<string> = new Set([
  'connectionId',
  'deviceId',
  'deviceLabel',
  'tokenPrefix',
  'codePrefix',
  'agentVersion',
  'osLabel',
  'companyName',
  'companyGuid',
  'entity',
  'localKey',
  'tallyName',
  'previousTallyName',
  'networkMode',
  'state',
  'previousState',
  'reason',
  'jobId',
  'eventType',
  'attemptCount',
  'mappingCount',
  'unmappedCount',
  'inventoryAuthority',
  'autoCreateMasters',
  'policyField',
  'previousValue',
  'newValue',
  'masterKind',
  'createdCount',
  'voucherNumber',
]);

/**
 * Keep only the allowed keys, and only as scalars.
 *
 * Nested objects are dropped whole rather than walked. A walk would have to
 * decide what to do with an unexpected shape, and the honest answer for an
 * audit table is not to store a shape nobody designed.
 */
function redact(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (meta === undefined) return undefined;

  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(meta)) {
    if (!ALLOWED_META_KEYS.has(key)) continue;
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (typeof value === 'string') {
      out[key] = value.slice(0, 255);
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }

  return Object.keys(out).length === 0 ? undefined : out;
}

export interface SellerErpAuditInput {
  sellerAccountId: string;
  connectionId?: string | null;
  /** `seller_erp.paired`, `seller_erp.mapping_changed`, … */
  action: string;
  actor: { type: ActorType; userId?: string | null; label?: string | null };
  /** A sentence, written deliberately. Shown to the seller. */
  summary?: string | null;
  meta?: Record<string, unknown>;
  /** SHA-256 of the caller's address. Never the address. */
  ipHash?: string | null;
  correlationId?: string | null;
  tx?: PrismaTransaction;
}

/**
 * Record one thing.
 *
 * Swallows its own failure and logs it, exactly as `recordSellerAudit` does.
 * That direction is deliberate and it is the same trade the seller audit trail
 * already makes: an audit write that could fail a pairing would mean a seller
 * cannot connect their books because a log table is full. The write is
 * attempted first and the business operation is never held hostage to it.
 */
export async function recordErpAudit(input: SellerErpAuditInput): Promise<void> {
  const client = input.tx ?? prisma;

  try {
    await client.sellerErpAuditEvent.create({
      data: {
        id: newId(),
        sellerAccountId: input.sellerAccountId,
        connectionId: input.connectionId ?? null,
        action: input.action,
        actorType: input.actor.type,
        actorUserId: input.actor.userId ?? null,
        actorLabel: input.actor.label ?? null,
        summary: input.summary ?? null,
        metaJson: redact(input.meta) as never,
        ipHash: input.ipHash ?? null,
        correlationId: input.correlationId ?? null,
      },
    });
  } catch (error) {
    logger.error(
      { err: error, sellerAccountId: input.sellerAccountId, action: input.action },
      'Failed to write seller ERP audit row',
    );
  }
}
