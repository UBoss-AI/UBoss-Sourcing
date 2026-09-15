/**
 * Tracking events arriving from a carrier.
 *
 * The most security-sensitive path in this feature: an unauthenticated
 * endpoint that changes what a hospital is told about its consignment. Its
 * authority is a signature over the raw bytes and nothing else - there is no
 * session, and the caller is a machine.
 *
 * THE ORDER OF CHECKS, AND WHY IT IS THAT ORDER
 *
 *  1. **Find the integration by its unguessable path token.** Not enumerable,
 *     so an attacker cannot even address a carrier they have not been told
 *     about. This is a speed bump, not the control.
 *  2. **Verify the HMAC over the UNTOUCHED bytes.** `request.rawBody`, not a
 *     re-serialised object: key order and whitespace change on a JSON round
 *     trip and every honest signature would fail, and the usual "fix" for that
 *     is to stop verifying. Same discipline as the payment webhooks.
 *  3. **Check the timestamp window.** A valid signature is valid for ever;
 *     what stops a captured request being replayed next month is that its own
 *     timestamp is outside the tolerance.
 *  4. **Store the event BEFORE understanding it,** keyed on the carrier's own
 *     event id. The UNIQUE index is the deduplication - there is no
 *     check-then-insert to lose a race in, which matters because carriers
 *     redeliver twice in the same second rather than politely spaced out.
 *  5. **Only then map it.** An unrecognised code is preserved verbatim,
 *     flagged as `UNMAPPED_EXTERNAL_EVENT`, and left for a person. It never
 *     crashes the handler and it never guesses at a status.
 *
 * ONE ANSWER FOR EVERY REFUSAL
 *
 * Bad signature, stale timestamp and unknown integration all return
 * `CARRIER_WEBHOOK_REJECTED`. The sender is a machine that will log a 4xx;
 * telling it which of the three failed would help somebody tune the next
 * attempt and helps no honest carrier at all.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '../../../generated/prisma/client.js';
import type { CarrierProviderName } from '../../../domain/carrier-status-map.js';
import { resolveCarrierStatus } from '../../../domain/carrier-status-map.js';
import { ErrorCode, AppError } from '../../../domain/errors.js';
import { decryptSecret } from '../../../infra/crypto.js';
import { newId } from '../../../infra/ids.js';
import { logger } from '../../../infra/logger.js';
import { prisma } from '../../../infra/prisma.js';
import { env } from '../../../config/env.js';
import { raiseException } from '../exception.service.js';
import { recordShipmentEvent } from '../shipment-event.service.js';

/** One refusal, whatever went wrong. See the header. */
function rejected(): AppError {
  return new AppError({
    statusCode: 401,
    code: ErrorCode.CARRIER_WEBHOOK_REJECTED,
    message: 'This event could not be accepted.',
  });
}

export interface InboundWebhook {
  /** The unguessable path segment the endpoint was mounted at. */
  pathToken: string;
  /** The bytes, exactly as received. Never a re-serialised object. */
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export interface WebhookOutcome {
  accepted: boolean;
  /** True when this exact event had already been processed. */
  duplicate: boolean;
  /** Set where the payload named a consignment we could find. */
  shipmentId: string | null;
  /** Set where a code resolved to a status. */
  status: string | null;
  /** True when the code was preserved and flagged rather than applied. */
  unmapped: boolean;
}

function headerValue(
  headers: InboundWebhook['headers'],
  name: string,
): string | null {
  const raw = headers[name.toLowerCase()];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return null;
}

/**
 * Constant-time comparison of two hex digests.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak
 * through the exception path, so the lengths are compared first and a
 * mismatched length simply fails.
 */
function signaturesMatch(expected: string, supplied: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  // Carriers disagree about casing and about whether to prefix `sha256=`.
  // Both spellings are normalised before comparison; neither is a secret.
  const b = Buffer.from(supplied.replace(/^sha256=/i, '').trim().toLowerCase(), 'utf8');

  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Take one inbound event.
 *
 * Returns rather than throws for a duplicate, because the carrier must be
 * answered 2xx or it will retry for ever - and retrying is the correct
 * behaviour for a carrier that got a 5xx, so the endpoint has to be careful to
 * distinguish "we already have this" from "we broke".
 */
export async function ingestCarrierWebhook(input: InboundWebhook): Promise<WebhookOutcome> {
  // --- 1. Which integration --------------------------------------------
  const integration = await prisma.carrierIntegration.findUnique({
    where: { webhookPathToken: input.pathToken },
    select: {
      id: true,
      provider: true,
      isActive: true,
      state: true,
      webhookSecretEnc: true,
      webhookSignatureHeader: true,
      webhookTimestampHeader: true,
      webhookAlgorithm: true,
      webhookToleranceSeconds: true,
      statusMappings: {
        select: {
          providerCode: true,
          canonicalStatus: true,
          raisesExceptionType: true,
          publicDescription: true,
          note: true,
        },
      },
    },
  });

  if (integration === null || !integration.isActive) throw rejected();

  // --- 2. The signature, over the untouched bytes ------------------------
  const secret =
    integration.webhookSecretEnc === null
      ? null
      : safeDecrypt(integration.webhookSecretEnc, `carrier_integration:${integration.id}`);

  if (secret === null) {
    /*
     * An integration with no webhook secret cannot verify anything, so it
     * accepts nothing. Refusing is the only safe answer: the alternative is an
     * endpoint that takes anybody's word for where a consignment of reagents
     * is, and an operator who set up a webhook without a secret needs to find
     * out now rather than after a delivery nobody made was marked delivered.
     */
    logger.warn(
      { carrierIntegrationId: integration.id },
      'carrier webhook refused: no signing secret configured',
    );
    throw rejected();
  }

  const timestampHeader = headerValue(input.headers, integration.webhookTimestampHeader);
  const signatureHeader = headerValue(input.headers, integration.webhookSignatureHeader);

  if (signatureHeader === null) throw rejected();

  /*
   * The timestamp is part of what is SIGNED, not merely sent beside the
   * signature. Otherwise an attacker replaying a captured request could change
   * the header to today's date and the signature would still verify.
   */
  const signedPayload =
    timestampHeader === null
      ? input.rawBody
      : Buffer.concat([Buffer.from(`${timestampHeader}.`, 'utf8'), input.rawBody]);

  const algorithm = integration.webhookAlgorithm === 'sha512' ? 'sha512' : 'sha256';
  const expected = createHmac(algorithm, secret).update(signedPayload).digest('hex');

  if (!signaturesMatch(expected, signatureHeader)) throw rejected();

  // --- 3. The replay window ---------------------------------------------
  if (timestampHeader !== null) {
    const sentAt = parseTimestamp(timestampHeader);

    if (
      sentAt === null ||
      Math.abs(Date.now() - sentAt.getTime()) / 1000 > integration.webhookToleranceSeconds
    ) {
      throw rejected();
    }
  }

  // --- 4. Store it, before understanding it ------------------------------
  const payload = parseJson(input.rawBody);
  if (payload === null) throw rejected();

  const eventId = newId();
  const providerEventId = readString(payload, ['eventId', 'id', 'event_id']) ?? eventId;
  const trackingNumber = readString(payload, [
    'trackingNumber',
    'tracking_number',
    'trackingId',
    'shipmentTrackingNumber',
  ]);
  const providerStatusCode = readString(payload, [
    'statusCode',
    'status',
    'eventCode',
    'scanType',
    'typeCode',
  ]);

  const receipt = await storeReceipt({
    id: eventId,
    carrierIntegrationId: integration.id,
    providerEventId,
    trackingNumber,
    providerStatusCode,
    payload,
  });

  if (receipt.duplicate) {
    return {
      accepted: true,
      duplicate: true,
      shipmentId: receipt.shipmentId,
      status: null,
      unmapped: false,
    };
  }

  // --- 5. Understand it --------------------------------------------------
  return applyReceipt({
    receiptId: eventId,
    integrationId: integration.id,
    provider: integration.provider,
    mappings: integration.statusMappings,
    trackingNumber,
    providerStatusCode,
    payload,
  });
}

function safeDecrypt(envelope: string, aad: string): string | null {
  try {
    return decryptSecret(envelope, aad);
  } catch {
    return null;
  }
}

/** Unix seconds, Unix milliseconds or an ISO instant. Carriers use all three. */
function parseTimestamp(raw: string): Date | null {
  const numeric = Number(raw);

  if (Number.isFinite(numeric) && numeric > 0) {
    // Ten digits is seconds, thirteen is milliseconds. Anything else is not a
    // Unix timestamp this decade.
    return new Date(numeric < 1e11 ? numeric * 1000 : numeric);
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseJson(raw: Buffer): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Pull a value out of a payload whose shape nobody controls.
 *
 * Tries several key spellings and looks one level into a nested object,
 * because every carrier nests differently and a mapping table of JSON paths
 * per provider is a table that goes stale silently. What it will NOT do is
 * guess at a value that is not there - a missing tracking number produces
 * null, and null produces an unmatched receipt a person can look at.
 */
function readString(payload: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }

  for (const nested of Object.values(payload)) {
    if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) continue;

    for (const key of keys) {
      const value = (nested as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
  }

  return null;
}

/**
 * Write the receipt, or discover that it is already written.
 *
 * `(carrierIntegrationId, providerEventId)` is UNIQUE, so the INSERT is the
 * deduplication. A P2002 here means the carrier redelivered, which is a
 * success and not an error.
 */
async function storeReceipt(params: {
  id: string;
  carrierIntegrationId: string;
  providerEventId: string;
  trackingNumber: string | null;
  providerStatusCode: string | null;
  payload: Record<string, unknown>;
}): Promise<{ duplicate: boolean; shipmentId: string | null }> {
  try {
    await prisma.carrierWebhookEvent.create({
      data: {
        id: params.id,
        carrierIntegrationId: params.carrierIntegrationId,
        providerEventId: params.providerEventId.slice(0, 160),
        state: 'RECEIVED',
        trackingNumber: params.trackingNumber,
        providerStatusCode: params.providerStatusCode,
        // Stored whole and unedited. It is the evidence of what the carrier
        // actually said, which is the only thing that settles an argument
        // about a scan weeks later.
        payloadJson: params.payload as Prisma.InputJsonValue,
        // The signature verified before we got here, and that fact is stored
        // rather than inferred: "did we ever accept an unsigned event?" is a
        // question somebody asks after an incident.
        signatureVerified: true,
      },
    });

    return { duplicate: false, shipmentId: null };
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002') {
      const existing = await prisma.carrierWebhookEvent.findFirst({
        where: {
          carrierIntegrationId: params.carrierIntegrationId,
          providerEventId: params.providerEventId.slice(0, 160),
        },
        select: { shipmentId: true },
      });

      return { duplicate: true, shipmentId: existing?.shipmentId ?? null };
    }

    throw error;
  }
}

interface ApplyParams {
  receiptId: string;
  integrationId: string;
  provider: CarrierProviderName;
  mappings: {
    providerCode: string;
    canonicalStatus: string | null;
    raisesExceptionType: string | null;
    publicDescription: string | null;
    note: string | null;
  }[];
  trackingNumber: string | null;
  providerStatusCode: string | null;
  payload: Record<string, unknown>;
}

/**
 * Turn a stored receipt into a shipment event, or explain why not.
 *
 * Three ways this ends, and all three are recorded:
 *
 *   - PROCESSED: the code mapped, the consignment was found, an event was
 *     written (or was already there, which is the same outcome).
 *   - IGNORED:   the code mapped to "deliberately changes nothing" - a label
 *     scan, a carrier's own "no information" state.
 *   - FAILED:    we could not find the consignment, or the code means nothing
 *     to us. An `UNMAPPED_EXTERNAL_EVENT` exception is raised with the
 *     carrier's own payload attached, so a person reads what was actually
 *     said rather than a translation that failed.
 */
async function applyReceipt(params: ApplyParams): Promise<WebhookOutcome> {
  const shipment =
    params.trackingNumber === null
      ? null
      : await prisma.logisticsShipment.findFirst({
          where: {
            OR: [
              { carrierTrackingNumber: params.trackingNumber },
              { trackingNumber: params.trackingNumber },
            ],
          },
          select: { id: true, assignedPartnerId: true, status: true },
        });

  if (shipment === null) {
    await prisma.carrierWebhookEvent.update({
      where: { id: params.receiptId },
      data: {
        state: 'FAILED',
        lastError: 'No shipment matches that tracking number.',
        // Retried on the sweep: a carrier that sends a scan microseconds
        // before we finish creating the consignment is an ordinary race, and
        // a second attempt in a minute usually finds it.
        nextRetryAt: new Date(Date.now() + 60_000),
        attempts: 1,
      },
    });

    return { accepted: true, duplicate: false, shipmentId: null, status: null, unmapped: false };
  }

  const resolution = resolveCarrierStatus(
    params.provider,
    [params.providerStatusCode ?? '', readString(params.payload, ['statusDetail', 'detail']) ?? ''],
    params.mappings.map((mapping) => ({
      providerCode: mapping.providerCode,
      canonicalStatus: mapping.canonicalStatus as never,
      note: mapping.note,
    })),
  );

  if (resolution.kind === 'IGNORED') {
    await prisma.carrierWebhookEvent.update({
      where: { id: params.receiptId },
      data: { state: 'IGNORED', shipmentId: shipment.id, processedAt: new Date() },
    });

    return {
      accepted: true,
      duplicate: false,
      shipmentId: shipment.id,
      status: null,
      unmapped: false,
    };
  }

  if (resolution.kind === 'UNMAPPED') {
    /*
     * The carrier said something we have never seen.
     *
     * The event stays, verbatim. The consignment's status is NOT touched. An
     * exception carries the payload to a person, and the operations desk is
     * told. Discarding it - or guessing - on a consignment of medical goods is
     * not an acceptable failure mode, and neither is a 500 that makes the
     * carrier retry a code we will never understand.
     */
    await prisma.carrierWebhookEvent.update({
      where: { id: params.receiptId },
      data: {
        state: 'FAILED',
        shipmentId: shipment.id,
        lastError: `Unrecognised status code: ${params.providerStatusCode ?? '(none)'}`,
      },
    });

    await raiseException({
      shipmentId: shipment.id,
      logisticsPartnerId: shipment.assignedPartnerId,
      type: 'UNMAPPED_EXTERNAL_EVENT',
      reason: `The carrier sent a status code this system does not recognise: ${
        params.providerStatusCode ?? '(none)'
      }`,
      detail:
        'The event has been kept exactly as it arrived. Add a status mapping for this code ' +
        'under Settings, then re-run the event.',
      externalPayload: params.payload,
    });

    return {
      accepted: true,
      duplicate: false,
      shipmentId: shipment.id,
      status: null,
      unmapped: true,
    };
  }

  const mapping = params.mappings.find(
    (entry) =>
      entry.providerCode.toLowerCase() === (params.providerStatusCode ?? '').toLowerCase(),
  );

  const occurredAt =
    parseTimestamp(readString(params.payload, ['timestamp', 'occurredAt', 'eventTime']) ?? '') ??
    new Date();

  /*
   * The carrier's own words are the reason.
   *
   * Several transitions the matrix permits - a customs hold, a delay, damage,
   * a temperature excursion - demand a written reason, and a machine cannot
   * type one. What it CAN supply is what it actually said, and that is the
   * honest answer to "why is this parcel on hold": because the carrier
   * reported this code, in these words.
   *
   * Without it those statuses were unreachable from a feed at all - the
   * transition was refused, the receipt recorded IGNORED, and a consignment
   * sitting in customs looked to everybody like a consignment in transit.
   * An integration test caught it.
   */
  const carrierWords =
    mapping?.publicDescription ??
    readString(params.payload, ['description', 'message', 'statusDescription']) ??
    `The carrier reported status ${params.providerStatusCode ?? '(none)'}.`;

  try {
    const event = await recordShipmentEvent({
      shipmentId: shipment.id,
      status: resolution.status,
      reason: carrierWords,
      actor: 'CARRIER',
      source: 'INBOUND_WEBHOOK',
      carrierIntegrationId: params.integrationId,
      externalEventId: params.receiptId,
      externalStatusCode: params.providerStatusCode,
      publicDescription:
        mapping?.publicDescription ?? readString(params.payload, ['description', 'message']),
      occurredAt,
      locationLabel: readString(params.payload, ['location', 'locationDescription', 'city']),
      locationCountry: readString(params.payload, ['countryCode', 'country']),
      // A carrier that reports a coordinate is reporting a CHECKPOINT, not a
      // driver. It is stored on the event, which is swept on the audit window,
      // rather than in the location-ping table, which is swept far sooner and
      // is about a named individual.
      idempotencyKey: `carrier:${params.receiptId}`,
    });

    await prisma.$transaction([
      prisma.carrierWebhookEvent.update({
        where: { id: params.receiptId },
        data: {
          state: 'PROCESSED',
          shipmentId: shipment.id,
          resolvedStatus: resolution.status as never,
          processedAt: new Date(),
        },
      }),
      prisma.logisticsShipment.update({
        where: { id: shipment.id },
        data: { lastCarrierSyncAt: new Date() },
      }),
    ]);

    if ((mapping?.raisesExceptionType !== undefined && mapping?.raisesExceptionType !== null)) {
      await raiseException({
        shipmentId: shipment.id,
        logisticsPartnerId: shipment.assignedPartnerId,
        type: mapping.raisesExceptionType as never,
        reason: mapping.publicDescription ?? `Carrier reported ${params.providerStatusCode ?? ''}.`,
        externalPayload: params.payload,
      });
    }

    return {
      accepted: true,
      duplicate: event.duplicate,
      shipmentId: shipment.id,
      status: resolution.status,
      unmapped: false,
    };
  } catch (error) {
    /*
     * The transition was illegal for this consignment.
     *
     * Common and not alarming: a carrier resending yesterday's "in transit"
     * after we have already recorded a delivery. The receipt records why, the
     * shipment is untouched, and the carrier gets a 2xx so it stops retrying
     * something that will never be accepted.
     */
    await prisma.carrierWebhookEvent.update({
      where: { id: params.receiptId },
      data: {
        state: 'IGNORED',
        shipmentId: shipment.id,
        processedAt: new Date(),
        lastError: error instanceof Error ? error.message.slice(0, 512) : 'Transition refused.',
      },
    });

    return {
      accepted: true,
      duplicate: false,
      shipmentId: shipment.id,
      status: null,
      unmapped: false,
    };
  }
}

/**
 * Retry the receipts that could not be applied, and dead-letter the rest.
 *
 * Exponential backoff on `attempts`, capped by
 * `LOGISTICS_WEBHOOK_MAX_ATTEMPTS`. A dead-lettered event is kept for ever and
 * surfaced on the integrations screen, because it is a parcel whose customer
 * is being told something out of date - which is a thing a person has to
 * decide about, not a row to delete.
 */
export async function retryFailedWebhookEvents(now = new Date()): Promise<{
  retried: number;
  deadLettered: number;
}> {
  const due = await prisma.carrierWebhookEvent.findMany({
    where: { state: 'FAILED', nextRetryAt: { not: null, lte: now } },
    orderBy: { receivedAt: 'asc' },
    take: 100,
    select: {
      id: true,
      attempts: true,
      carrierIntegrationId: true,
      trackingNumber: true,
      providerStatusCode: true,
      payloadJson: true,
      integration: {
        select: {
          provider: true,
          statusMappings: {
            select: {
              providerCode: true,
              canonicalStatus: true,
              raisesExceptionType: true,
              publicDescription: true,
              note: true,
            },
          },
        },
      },
    },
  });

  let retried = 0;
  let deadLettered = 0;

  for (const receipt of due) {
    const attempts = receipt.attempts + 1;

    if (attempts > env.LOGISTICS_WEBHOOK_MAX_ATTEMPTS) {
      await prisma.carrierWebhookEvent.update({
        where: { id: receipt.id },
        data: { state: 'DEAD_LETTER', deadLetteredAt: now, nextRetryAt: null, attempts },
      });
      deadLettered += 1;
      continue;
    }

    const payload =
      typeof receipt.payloadJson === 'object' && receipt.payloadJson !== null
        ? (receipt.payloadJson as Record<string, unknown>)
        : {};

    try {
      await applyReceipt({
        receiptId: receipt.id,
        integrationId: receipt.carrierIntegrationId,
        provider: receipt.integration.provider,
        mappings: receipt.integration.statusMappings,
        trackingNumber: receipt.trackingNumber,
        providerStatusCode: receipt.providerStatusCode,
        payload,
      });
      retried += 1;
    } catch (error) {
      // Doubling, from one minute. A carrier's tracking feed is not urgent
      // enough to hammer and is too important to abandon.
      await prisma.carrierWebhookEvent.update({
        where: { id: receipt.id },
        data: {
          attempts,
          nextRetryAt: new Date(now.getTime() + 60_000 * 2 ** (attempts - 1)),
          lastError: error instanceof Error ? error.message.slice(0, 512) : 'Retry failed.',
        },
      });
    }
  }

  return { retried, deadLettered };
}
