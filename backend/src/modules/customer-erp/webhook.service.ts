/**
 * Inbound deliveries from a buyer's own ERP.
 *
 * The buyer's system calls US: a goods receipt was posted, a purchase order
 * changed status, stock moved. This is the door, and it is the only
 * unauthenticated route in the feature - so everything about it is about
 * proving the delivery is genuine before a single field of it is believed.
 *
 * FOUR CHECKS, IN THIS ORDER, BEFORE THE PAYLOAD IS PARSED AS ANYTHING
 *
 *   1. The slug names a connection that exists and is accepting deliveries.
 *   2. A signing secret is configured. **There is no unsigned mode.** An
 *      unauthenticated endpoint that moves somebody's stock is not a feature,
 *      and a connection with no secret accepts nothing.
 *   3. The signature over the RAW BYTES verifies, compared in constant time.
 *      Raw bytes, not the parsed object: `JSON.parse` followed by
 *      `JSON.stringify` reorders keys and drops whitespace, and the signature
 *      was computed over what was sent.
 *   4. The timestamp is inside the replay window. Without it a signature is
 *      valid for ever, so a captured request is a replay for ever too.
 *
 * THE ANSWER IS THE SAME FOR ALL FOUR FAILURES
 *
 * `CUSTOMER_ERP_WEBHOOK_REJECTED`, with no indication of which check failed.
 * An endpoint that distinguishes "wrong signature" from "no secret configured"
 * from "no such connection" is an oracle: it tells somebody probing it which
 * slugs are real and whether they have guessed the secret's shape. The row
 * written to `customer_erp_webhook_events` DOES record which, because that row
 * is only ever read by the buyer who owns the connection.
 *
 * DUPLICATES
 *
 * The receipt row is written BEFORE the payload is acted on, and the unique
 * index on (connectionId, externalEventId) is what makes a redelivery a no-op.
 * Every ERP retries, and a goods receipt applied twice is stock that does not
 * exist. Where the ERP sends no event id, the body's SHA-256 is used instead:
 * two genuinely identical bodies inside the window are indistinguishable from a
 * redelivery, and for a stock movement treating them as one is the safe
 * direction to be wrong in.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest } from '../../domain/errors.js';
import { acceptsWebhooks } from '../../domain/customer-erp-state.js';
import { sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { loggerFor } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { recordOrgAudit, SYSTEM_ACTOR } from './audit.service.js';
import { loadConnectorContext } from './connectors/index.js';
import { openCredential, type WebhookSigningCredential } from './credential.service.js';
import { applyInboundEvent } from './pipeline.service.js';
import { redactForLedger } from './http.js';

/** The one answer every failure gets. See this file's header. */
function reject(): never {
  throw badRequest(
    ErrorCode.CUSTOMER_ERP_WEBHOOK_REJECTED,
    'This delivery could not be accepted.',
  );
}

export interface InboundDelivery {
  slug: string;
  /** The bytes as they arrived. Never a re-serialised object. */
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  ipAddress: string | null;
  correlationId: string;
}

export interface InboundResult {
  accepted: boolean;
  duplicate: boolean;
  /** What was done, for the buyer's log. Never returned to the caller. */
  note: string;
}

/**
 * Accept, verify and apply one delivery.
 *
 * Returns 200 for a duplicate as well as for a fresh delivery, deliberately.
 * An ERP that gets a 4xx for a redelivery will keep redelivering, and the
 * redelivery is the thing we have already handled.
 */
export async function receiveWebhook(delivery: InboundDelivery): Promise<InboundResult> {
  const log = loggerFor(delivery.correlationId, { slug: delivery.slug.slice(0, 8) });

  if (!env.FEATURE_CUSTOMER_ERP) reject();

  // --- 1. The connection -------------------------------------------------
  const connection = await prisma.customerErpConnection.findUnique({
    where: { webhookSlug: delivery.slug },
  });

  if (connection === null || connection.deletedAt !== null || !connection.webhookEnabled) {
    reject();
  }

  const state = connection.state;

  // PAUSED refuses and ACTION_REQUIRED accepts, which looks inconsistent and is
  // not: a connection somebody deliberately stopped must not have its stock
  // rewritten, and one waiting on an approval is still a connection whose ERP
  // is entitled to tell us things. See `acceptsWebhooks`.
  if (!acceptsWebhooks(state)) {
    await recordRejection(connection, delivery, 'The connection is not accepting deliveries.');
    reject();
  }

  // --- 2 and 3. The secret and the signature -----------------------------
  const secret = await openCredential<WebhookSigningCredential>(
    connection.id,
    'WEBHOOK_SIGNING',
  );

  if (secret === null) {
    await recordRejection(connection, delivery, 'No signing secret is configured.');
    reject();
  }

  const provided = headerValue(delivery.headers, connection.webhookSignatureHeader);

  if (provided === null) {
    await recordRejection(connection, delivery, 'The delivery carried no signature.');
    reject();
  }

  // --- 4. The replay window ----------------------------------------------
  //
  // Read before the signature is checked so the SIGNED payload can include it,
  // which is what stops somebody replaying a valid body with a fresh timestamp.
  const timestampHeader =
    connection.webhookTimestampHeader === null
      ? null
      : headerValue(delivery.headers, connection.webhookTimestampHeader);

  const signedAt = parseTimestamp(timestampHeader);

  if (timestampHeader !== null) {
    if (signedAt === null) {
      await recordRejection(connection, delivery, 'The delivery timestamp could not be read.');
      reject();
    }

    const skewSeconds = Math.abs(Date.now() - signedAt.getTime()) / 1000;

    if (skewSeconds > connection.webhookToleranceSeconds) {
      await recordRejection(
        connection,
        delivery,
        `The delivery timestamp is ${Math.round(skewSeconds)} seconds out of step, ` +
          `beyond the ${connection.webhookToleranceSeconds}-second window.`,
      );
      reject();
    }
  }

  // The signed payload is `<timestamp>.<body>` where a timestamp header is
  // configured, and the raw body alone where it is not - the two conventions
  // that between them cover the ERPs anybody has asked for.
  const signedPayload =
    timestampHeader === null ? delivery.rawBody : `${timestampHeader}.${delivery.rawBody}`;

  if (!verifySignature(signedPayload, provided, secret.signingSecret)) {
    await recordRejection(connection, delivery, 'The signature did not verify.');
    reject();
  }

  // --- Past the door. Now it may be parsed. -------------------------------
  let payload: unknown;
  try {
    payload = JSON.parse(delivery.rawBody);
  } catch {
    await recordRejection(connection, delivery, 'The body was not JSON.');
    reject();
  }

  const externalEventId = externalIdOf(payload, delivery.rawBody);
  const receiptId = newId();

  // Written BEFORE the payload is acted on. The unique index is the duplicate
  // guard, and a guard applied after the work has happened is not a guard.
  const inserted = await prisma.customerErpWebhookEvent.createMany({
    data: [
      {
        id: receiptId,
        connectionId: connection.id,
        organizationId: connection.organizationId,
        externalEventId,
        externalEventType: externalTypeOf(payload),
        verified: true,
        signedAt,
        payloadJson: redactForLedger(payload) as never,
        correlationId: delivery.correlationId,
      },
    ],
    skipDuplicates: true,
  });

  if (inserted.count === 0) {
    log.info({ externalEventId }, 'a buyer ERP redelivered a webhook we already have');
    return { accepted: true, duplicate: true, note: 'Already received.' };
  }

  // --- Interpret and apply ------------------------------------------------
  try {
    const { connector, context } = await loadConnectorContext({
      connectionId: connection.id,
      organizationId: connection.organizationId,
      // No outbound call is made here, so no token is needed - and fetching one
      // would make an inbound delivery depend on the buyer's ERP being
      // reachable outbound, which is exactly the case webhooks exist for.
      withToken: false,
    });

    const events = connector.interpretWebhook(context, payload);

    if (events.length === 0) {
      await prisma.customerErpWebhookEvent.update({
        where: { id: receiptId },
        data: { processedAt: new Date(), rejectionReason: null },
      });

      // Not an error. An ERP subscribed to a whole topic sends plenty we do not
      // act on, and refusing those would turn the buyer's delivery log red for
      // no reason.
      return { accepted: true, duplicate: false, note: 'Nothing here needed acting on.' };
    }

    const notes: string[] = [];

    for (const event of events) {
      const outcome = await applyInboundEvent({
        connectionId: connection.id,
        organizationId: connection.organizationId,
        correlationId: delivery.correlationId,
        event,
      });

      notes.push(outcome.note);
    }

    await prisma.customerErpWebhookEvent.update({
      where: { id: receiptId },
      data: { processedAt: new Date() },
    });

    await prisma.customerErpConnection.update({
      where: { id: connection.id },
      data: { lastSuccessAt: new Date(), consecutiveFailures: 0 },
    });

    await recordOrgAudit({
      organizationId: connection.organizationId,
      connectionId: connection.id,
      action: 'webhook.received',
      resourceType: 'webhook_event',
      resourceId: receiptId,
      actor: { ...SYSTEM_ACTOR, correlationId: delivery.correlationId },
      after: { externalEventId, kinds: events.map((entry) => entry.kind), notes },
    });

    return { accepted: true, duplicate: false, note: notes.join(' ') };
  } catch (error) {
    // The delivery was genuine and we could not apply it. The receipt stays,
    // recording that, so a buyer asking "did you get it" gets yes - and so a
    // redelivery is still recognised as one rather than applied twice.
    log.error({ err: error, externalEventId }, 'could not apply a verified buyer ERP webhook');

    await prisma.customerErpWebhookEvent.update({
      where: { id: receiptId },
      data: {
        processedAt: new Date(),
        rejectionReason: 'Received and verified, but could not be applied.',
      },
    });

    return { accepted: true, duplicate: false, note: 'Received; could not be applied.' };
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * HMAC-SHA256 over the raw bytes, compared in constant time.
 *
 * Accepts the three spellings that turn up in the wild - bare hex, bare base64,
 * and a `sha256=` prefix - because an ERP that sends one and a check that
 * expects another produces a rejection whose cause nobody can find.
 *
 * `timingSafeEqual` throws on a length mismatch, so the lengths are compared
 * first and the result folded in. A plain `===` here would leak the digest's
 * common prefix length one request at a time.
 */
function verifySignature(payload: string, provided: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(payload, 'utf8').digest();

  const candidates = [provided.trim(), provided.trim().replace(/^sha256=/i, '')];

  for (const candidate of candidates) {
    for (const encoding of ['hex', 'base64'] as const) {
      let supplied: Buffer;
      try {
        supplied = Buffer.from(candidate, encoding);
      } catch {
        continue;
      }

      if (supplied.length !== expected.length) continue;
      if (timingSafeEqual(supplied, expected)) return true;
    }
  }

  return false;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const value = headers[name.toLowerCase()];

  if (typeof value === 'string') return value.length === 0 ? null : value;
  if (Array.isArray(value)) return value[0] ?? null;

  return null;
}

/** Seconds, milliseconds, or an ISO date. All three turn up. */
function parseTimestamp(value: string | null): Date | null {
  if (value === null) return null;

  const trimmed = value.trim();

  if (/^\d{10}$/.test(trimmed)) return new Date(Number.parseInt(trimmed, 10) * 1000);
  if (/^\d{13}$/.test(trimmed)) return new Date(Number.parseInt(trimmed, 10));

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/**
 * The ERP's id for this delivery, or a hash of the body.
 *
 * Checked in the six places an event id actually appears across the systems
 * this connects to, then falls back to `sha256:<hex>`. See this file's header
 * for why hashing the body is the safe direction to be wrong in.
 */
function externalIdOf(payload: unknown, rawBody: string): string {
  const candidates = ['id', 'eventId', 'event_id', 'messageId', 'data.id', 'event.id'];

  for (const path of candidates) {
    const value = path
      .split('.')
      .reduce<unknown>(
        (cursor, segment) =>
          cursor !== null && typeof cursor === 'object'
            ? (cursor as Record<string, unknown>)[segment]
            : undefined,
        payload,
      );

    if (typeof value === 'string' && value.length > 0) return value.slice(0, 191);
    if (typeof value === 'number') return String(value);
  }

  return `sha256:${sha256Hex(rawBody)}`;
}

function externalTypeOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;

  const record = payload as Record<string, unknown>;

  for (const key of ['type', 'eventType', 'event_type', 'event']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value.slice(0, 128);
  }

  return null;
}

/**
 * Record a refusal, then refuse.
 *
 * A rejected delivery is exactly the thing an operator and a buyer need to see:
 * dropping it silently is how somebody spends a week wondering why their ERP's
 * webhooks never arrive. The ROW says which check failed; the RESPONSE does not.
 */
async function recordRejection(
  connection: { id: string; organizationId: string },
  delivery: InboundDelivery,
  reason: string,
): Promise<void> {
  await prisma.customerErpWebhookEvent
    .createMany({
      data: [
        {
          id: newId(),
          connectionId: connection.id,
          organizationId: connection.organizationId,
          // Hashed, so repeated identical probes collapse into one row rather
          // than filling the table.
          externalEventId: `rejected:${sha256Hex(delivery.rawBody).slice(0, 32)}`,
          verified: false,
          rejectionReason: reason.slice(0, 255),
          correlationId: delivery.correlationId,
        },
      ],
      skipDuplicates: true,
    })
    .catch(() => undefined);

  await recordOrgAudit({
    organizationId: connection.organizationId,
    connectionId: connection.id,
    action: 'webhook.rejected',
    resourceType: 'webhook_event',
    actor: {
      ...SYSTEM_ACTOR,
      ipAddress: delivery.ipAddress,
      correlationId: delivery.correlationId,
    },
    after: { reason },
  });

  // The operator's trail too. A run of these against one connection is either a
  // misconfigured ERP or somebody probing the endpoint, and the operator is the
  // only one positioned to notice the second pattern across tenants.
  await recordAudit({
    action: AuditAction.CUSTOMER_ERP_WEBHOOK_REJECTED,
    resourceType: 'customer_erp_connection',
    resourceId: connection.id,
    actorType: 'SYSTEM',
    after: { organizationId: connection.organizationId, reason },
    ipAddress: delivery.ipAddress,
    correlationId: delivery.correlationId,
  });
}

// ---------------------------------------------------------------------------
// Reading deliveries back
// ---------------------------------------------------------------------------

export interface WebhookEventView {
  id: string;
  externalEventId: string;
  externalEventType: string | null;
  verified: boolean;
  rejectionReason: string | null;
  receivedAt: string;
  processedAt: string | null;
  correlationId: string;
}

export async function listWebhookEvents(
  organizationId: string,
  connectionId: string | null,
  limit: number,
): Promise<WebhookEventView[]> {
  const rows = await prisma.customerErpWebhookEvent.findMany({
    where: {
      organizationId,
      ...(connectionId === null ? {} : { connectionId }),
    },
    orderBy: { receivedAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
  });

  return rows.map((row) => ({
    id: row.id,
    externalEventId: row.externalEventId,
    externalEventType: row.externalEventType,
    verified: row.verified,
    rejectionReason: row.rejectionReason,
    receivedAt: row.receivedAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
    correlationId: row.correlationId,
  }));
}
