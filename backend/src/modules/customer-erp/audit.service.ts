/**
 * The buyer's own audit trail over their own integration.
 *
 * Deliberately a second trail rather than a filter over `audit_logs`. That one
 * is the OPERATOR's: it is readable only by staff holding `audit.read`, it
 * records what the business running this installation did, and its rows are
 * scoped by nothing a buyer could safely be given. A buyer needs to answer "who
 * changed our SAP credentials last Tuesday" without asking their supplier, and
 * must not be able to read anybody else's answer to the same question. Two
 * tables is the honest way to have both, and it costs one insert.
 *
 * The operator's trail still records these actions too, at a coarser grain -
 * see `recordAudit` calls in `connection.service.ts`. The buyer's trail says
 * which field changed; the operator's says that a tenant changed a connection.
 *
 * REDACTION
 *
 * The same rule as the operator trail: a secret's KEY is recorded so "the
 * client secret was rotated" stays visible, and its VALUE never is. That rule
 * is applied here rather than trusted to callers, because the one call site
 * that forgets is the one that writes an API key into a table a screen renders.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';

/** Who did it, as far as this trail is concerned. */
export interface OrgActor {
  customerProfileId: string | null;
  email: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

/**
 * The actor for something nobody chose: a token refresh, a circuit opening, a
 * retry sweep. Named rather than passing nulls at forty call sites, so the
 * reason a row has no actor is visible in the code that wrote it.
 */
export const SYSTEM_ACTOR: OrgActor = Object.freeze({
  customerProfileId: null,
  email: null,
});

export interface OrgAuditEntry {
  organizationId: string;
  connectionId?: string | null;
  /** A closed vocabulary. See `ORG_AUDIT_ACTIONS`. */
  action: OrgAuditAction;
  resourceType: string;
  resourceId?: string | null;
  actor: OrgActor;
  before?: unknown;
  after?: unknown;
}

/**
 * Every action this trail records.
 *
 * A closed union rather than free text, for the same reason the operator's
 * `AuditAction` is one: the log is searched and filtered by this value, and a
 * typo in a string literal produces a row nobody's filter will ever match.
 */
export const ORG_AUDIT_ACTIONS = [
  'organization.renamed',
  'member.invited',
  'member.invite_revoked',
  'member.joined',
  'member.role_changed',
  'member.removed',
  'connection.created',
  'connection.updated',
  'connection.deleted',
  'connection.tested',
  'connection.activated',
  'connection.paused',
  'connection.resumed',
  'connection.reconnected',
  'connection.disconnected',
  'connection.suspended',
  'connection.attention_required',
  'credential.saved',
  'credential.rotated',
  'credential.revoked',
  'oauth.authorized',
  'oauth.refreshed',
  'oauth.failed',
  'endpoint.saved',
  'endpoint.deleted',
  'mapping.saved',
  'mapping.verified',
  'warehouse_map.saved',
  'policy.updated',
  'sync.started',
  'sync.finished',
  'event.queued',
  'event.retried',
  'event.skipped',
  'event.failed',
  'approval.requested',
  'approval.decided',
  'webhook.received',
  'webhook.rejected',
] as const;

export type OrgAuditAction = (typeof ORG_AUDIT_ACTIONS)[number];

/**
 * Field names whose VALUES never reach this trail.
 *
 * Deliberately wider than the operator trail's list, because the shapes that
 * pass through here are a buyer's own credential payloads and the cost of
 * being wrong is a customer's SAP password rendered in their own audit UI.
 */
const REDACTED_KEYS = new Set([
  'password',
  'secret',
  'clientsecret',
  'client_secret',
  'apikey',
  'api_key',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'codeverifier',
  'code_verifier',
  'privatekey',
  'private_key',
  'certificate',
  'passphrase',
  'signingsecret',
  'webhooksecret',
  'authorization',
  'payloadenc',
  'credentialsenc',
]);

/** Rows are small on purpose - a log nobody can scroll is a log nobody reads. */
const MAX_JSON_BYTES = 8 * 1024;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || value === undefined) return value ?? null;

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => redact(entry, depth + 1));
  }

  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = REDACTED_KEYS.has(key.toLowerCase().replace(/[^a-z_]/g, ''))
      ? '[redacted]'
      : redact(entry, depth + 1);
  }

  return result;
}

function bounded(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;

  const serialised = JSON.stringify(value);
  if (serialised === undefined) return undefined;

  if (serialised.length > MAX_JSON_BYTES) {
    return { truncated: true, bytes: serialised.length };
  }

  return JSON.parse(serialised) as Prisma.InputJsonValue;
}

type AuditClient = Pick<typeof prisma, 'customerErpAuditLog'>;

/**
 * Write one row.
 *
 * Inside a caller's transaction a failure aborts the whole operation - an
 * action that cannot be audited must not be allowed to commit. Standalone, a
 * failure is logged and swallowed, because losing the log row is better than
 * losing the operation that had already succeeded when the log write failed.
 */
export async function recordOrgAudit(entry: OrgAuditEntry, tx?: unknown): Promise<void> {
  const client = (tx as AuditClient | undefined) ?? prisma;

  const data = {
    id: newId(),
    organizationId: entry.organizationId,
    connectionId: entry.connectionId ?? null,
    action: entry.action,
    actorProfileId: entry.actor.customerProfileId,
    actorEmail: entry.actor.email,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? null,
    beforeJson: bounded(redact(entry.before)) ?? undefined,
    afterJson: bounded(redact(entry.after)) ?? undefined,
    ipAddress: entry.actor.ipAddress ?? null,
    userAgent: entry.actor.userAgent?.slice(0, 512) ?? null,
    correlationId: entry.actor.correlationId ?? null,
  };

  if (tx !== undefined) {
    await client.customerErpAuditLog.create({ data });
    return;
  }

  await client.customerErpAuditLog.create({ data }).catch((error: unknown) => {
    logger.error(
      { err: error, action: entry.action, organizationId: entry.organizationId },
      'could not write a buyer integration audit row',
    );
  });
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

export interface OrgAuditRow {
  id: string;
  action: string;
  actorEmail: string | null;
  resourceType: string;
  resourceId: string | null;
  connectionId: string | null;
  before: unknown;
  after: unknown;
  correlationId: string | null;
  createdAt: string;
}

export interface OrgAuditQuery {
  connectionId?: string | null;
  action?: string | null;
  /** Matched against the correlation id and the actor's email. */
  search?: string | null;
  before?: Date | null;
  limit: number;
}

/**
 * The audit log for one organisation.
 *
 * `organizationId` comes from a `Membership`, never from a request. Every query
 * in this module is scoped by it in the WHERE clause rather than filtered
 * afterwards, so a bug produces no rows instead of somebody else's.
 *
 * Keyset pagination on `createdAt`, not offset. The log grows without bound and
 * `OFFSET 40000` reads forty thousand rows to throw them away.
 */
export async function listOrgAudit(
  organizationId: string,
  query: OrgAuditQuery,
): Promise<{ rows: OrgAuditRow[]; nextBefore: string | null }> {
  const where: Prisma.CustomerErpAuditLogWhereInput = { organizationId };

  if (query.connectionId !== null && query.connectionId !== undefined) {
    where.connectionId = query.connectionId;
  }

  if (query.action !== null && query.action !== undefined && query.action.length > 0) {
    where.action = query.action;
  }

  if (query.before !== null && query.before !== undefined) {
    where.createdAt = { lt: query.before };
  }

  const search = (query.search ?? '').trim();
  if (search.length > 0) {
    where.OR = [
      { correlationId: { contains: search } },
      { actorEmail: { contains: search } },
      { resourceId: { contains: search } },
    ];
  }

  const limit = Math.min(Math.max(query.limit, 1), 100);

  const rows = await prisma.customerErpAuditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
  });

  const page = rows.slice(0, limit);
  const last = page.at(-1);

  return {
    rows: page.map((row) => ({
      id: row.id,
      action: row.action,
      actorEmail: row.actorEmail,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      connectionId: row.connectionId,
      before: row.beforeJson ?? null,
      after: row.afterJson ?? null,
      correlationId: row.correlationId,
      createdAt: row.createdAt.toISOString(),
    })),
    nextBefore: rows.length > limit && last !== undefined ? last.createdAt.toISOString() : null,
  };
}
