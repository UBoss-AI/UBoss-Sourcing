/**
 * Tracking events arriving from a carrier.
 *
 * The most security-sensitive path in the feature: an unauthenticated endpoint
 * that changes what a hospital is told about its consignment. Its authority is
 * a signature over the raw bytes and nothing else.
 *
 * Six claims, all asserted here:
 *
 *   - an unsigned or wrongly-signed event is refused;
 *   - a captured event replayed later is refused on its timestamp;
 *   - a redelivered event is processed exactly once;
 *   - an unrecognised code is PRESERVED and FLAGGED, never guessed at and
 *     never discarded;
 *   - a code that deliberately means nothing changes nothing;
 *   - a carrier whose integration has no signing secret is refused outright.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptSecret } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { ingestCarrierWebhook } from '../../src/modules/logistics/carrier/webhook.service.js';
import { createShipment } from '../../src/modules/logistics/shipment-create.service.js';

const SECRET = 'a-test-webhook-signing-secret-32-bytes';
const PATH_TOKEN = 'testwebhookpathtoken0000000000aa';
const UNSIGNED_PATH_TOKEN = 'testwebhooknosecret00000000000bb';

let integrationId = '';
let unsignedIntegrationId = '';
let shipmentId = '';
let trackingNumber = '';

const ADDRESS = {
  line1: '1 Dock Road',
  city: 'Antwerp',
  postalCode: '2000',
  countryCode: 'BE',
};

async function cleanUp(): Promise<void> {
  const integrationIds = (
    await prisma.carrierIntegration.findMany({
      where: { webhookPathToken: { in: [PATH_TOKEN, UNSIGNED_PATH_TOKEN] } },
      select: { id: true },
    })
  ).map((row) => row.id);

  await prisma.carrierWebhookEvent.deleteMany({
    where: { carrierIntegrationId: { in: integrationIds } },
  });
  await prisma.carrierStatusMapping.deleteMany({
    where: { carrierIntegrationId: { in: integrationIds } },
  });

  const shipments = await prisma.logisticsShipment.findMany({
    where: { receivingCompanyName: 'Webhook Test Clinic' },
    select: { id: true },
  });

  const ids = shipments.map((row) => row.id);

  await prisma.logisticsShipmentEvent.deleteMany({ where: { shipmentId: { in: ids } } });
  await prisma.logisticsShipmentPackage.deleteMany({ where: { shipmentId: { in: ids } } });
  await prisma.logisticsShipmentException.deleteMany({ where: { shipmentId: { in: ids } } });
  await prisma.logisticsShipment.deleteMany({ where: { id: { in: ids } } });
  await prisma.carrierIntegration.deleteMany({ where: { id: { in: integrationIds } } });
  await prisma.numberSequence.deleteMany({ where: { key: { startsWith: 'logistics-' } } });
}

/** Sign a payload the way an honest carrier would. */
function sign(body: Buffer, timestamp: string, secret = SECRET): string {
  return createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]))
    .digest('hex');
}

function envelope(payload: object, options: { timestamp?: string; secret?: string } = {}): {
  pathToken: string;
  rawBody: Buffer;
  headers: Record<string, string>;
} {
  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));

  return {
    pathToken: PATH_TOKEN,
    rawBody,
    headers: {
      'x-timestamp': timestamp,
      'x-signature': sign(rawBody, timestamp, options.secret ?? SECRET),
    },
  };
}

beforeAll(async () => {
  await cleanUp();

  integrationId = newId();
  unsignedIntegrationId = newId();

  await prisma.carrierIntegration.create({
    data: {
      id: integrationId,
      provider: 'DHL',
      name: 'Webhook Test Carrier',
      state: 'ACTIVE',
      webhookSecretEnc: encryptSecret(SECRET, `carrier_integration:${integrationId}`),
      webhookPathToken: PATH_TOKEN,
      isActive: true,
    },
  });

  await prisma.carrierIntegration.create({
    data: {
      id: unsignedIntegrationId,
      provider: 'DHL',
      name: 'Webhook Test Carrier Without A Secret',
      state: 'CONFIGURED',
      webhookPathToken: UNSIGNED_PATH_TOKEN,
      isActive: true,
    },
  });

  const created = await createShipment({
    sellerCompanyName: 'Northwind Medical',
    receivingCompanyName: 'Webhook Test Clinic',
    pickupAddress: ADDRESS,
    deliveryAddress: { ...ADDRESS, city: 'Ghent', postalCode: '9000' },
    packageCount: 1,
  });

  shipmentId = created.id;

  const stored = await prisma.logisticsShipment.findUniqueOrThrow({
    where: { id: shipmentId },
    select: { trackingNumber: true },
  });

  trackingNumber = stored.trackingNumber;

  // The consignment has to be somewhere a carrier scan can legally move it.
  await prisma.logisticsShipment.update({
    where: { id: shipmentId },
    data: { status: 'PICKED_UP', carrierIntegrationId: integrationId },
  });
});

afterAll(async () => {
  await cleanUp();
});

describe('signature verification', () => {
  it('refuses an event with no signature at all', async () => {
    const rawBody = Buffer.from(JSON.stringify({ trackingNumber, statusCode: 'df' }), 'utf8');

    await expect(
      ingestCarrierWebhook({ pathToken: PATH_TOKEN, rawBody, headers: {} }),
    ).rejects.toMatchObject({ code: 'CARRIER_WEBHOOK_REJECTED' });
  });

  it('refuses an event signed with the wrong secret', async () => {
    const input = envelope(
      { eventId: newId(), trackingNumber, statusCode: 'df' },
      { secret: 'not-the-right-secret' },
    );

    await expect(ingestCarrierWebhook(input)).rejects.toMatchObject({
      code: 'CARRIER_WEBHOOK_REJECTED',
    });
  });

  it('refuses an event whose body was changed after signing', async () => {
    const input = envelope({ eventId: newId(), trackingNumber, statusCode: 'df' });

    // One byte. The whole point of signing the raw bytes.
    const tampered = {
      ...input,
      rawBody: Buffer.from(input.rawBody.toString('utf8').replace('df', 'ok'), 'utf8'),
    };

    await expect(ingestCarrierWebhook(tampered)).rejects.toMatchObject({
      code: 'CARRIER_WEBHOOK_REJECTED',
    });
  });

  it('refuses an integration that has no signing secret', async () => {
    /*
     * An integration with no secret cannot verify anything, so it accepts
     * nothing. The alternative is an endpoint that takes anybody's word for
     * where a consignment of reagents is.
     */
    const rawBody = Buffer.from(JSON.stringify({ trackingNumber }), 'utf8');
    const timestamp = String(Math.floor(Date.now() / 1000));

    await expect(
      ingestCarrierWebhook({
        pathToken: UNSIGNED_PATH_TOKEN,
        rawBody,
        headers: { 'x-timestamp': timestamp, 'x-signature': sign(rawBody, timestamp) },
      }),
    ).rejects.toMatchObject({ code: 'CARRIER_WEBHOOK_REJECTED' });
  });

  it('refuses an unknown path token without saying why', async () => {
    const input = { ...envelope({ trackingNumber }), pathToken: 'nosuchpathtoken0000000000000000' };

    await expect(ingestCarrierWebhook(input)).rejects.toMatchObject({
      code: 'CARRIER_WEBHOOK_REJECTED',
    });
  });
});

describe('replay protection', () => {
  it('refuses a correctly-signed event from an hour ago', async () => {
    /*
     * A valid signature is valid for ever. What stops a captured request being
     * replayed next month is that its own timestamp - which is PART of what
     * was signed - is outside the tolerance.
     */
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 3600);

    const input = envelope(
      { eventId: newId(), trackingNumber, statusCode: 'df' },
      { timestamp: oldTimestamp },
    );

    await expect(ingestCarrierWebhook(input)).rejects.toMatchObject({
      code: 'CARRIER_WEBHOOK_REJECTED',
    });
  });

  it('refuses one from an hour in the future', async () => {
    const future = String(Math.floor(Date.now() / 1000) + 3600);

    const input = envelope(
      { eventId: newId(), trackingNumber, statusCode: 'df' },
      { timestamp: future },
    );

    await expect(ingestCarrierWebhook(input)).rejects.toMatchObject({
      code: 'CARRIER_WEBHOOK_REJECTED',
    });
  });
});

describe('a good event', () => {
  it('moves the consignment and records the receipt', async () => {
    const eventId = `dhl-${newId()}`;

    const outcome = await ingestCarrierWebhook(
      envelope({
        eventId,
        trackingNumber,
        // DHL's "departed a facility" scan.
        statusCode: 'df',
        description: 'Departed from the facility.',
      }),
    );

    expect(outcome.accepted).toBe(true);
    expect(outcome.duplicate).toBe(false);
    expect(outcome.unmapped).toBe(false);
    expect(outcome.status).toBe('IN_TRANSIT');

    const shipment = await prisma.logisticsShipment.findUniqueOrThrow({
      where: { id: shipmentId },
      select: { status: true, lastCarrierSyncAt: true },
    });

    expect(shipment.status).toBe('IN_TRANSIT');
    expect(shipment.lastCarrierSyncAt).not.toBeNull();

    const receipt = await prisma.carrierWebhookEvent.findFirstOrThrow({
      where: { carrierIntegrationId: integrationId, providerEventId: eventId },
      select: { state: true, signatureVerified: true, payloadJson: true },
    });

    expect(receipt.state).toBe('PROCESSED');
    // Stored rather than inferred: "did we ever accept an unsigned event?" is
    // a question somebody asks after an incident.
    expect(receipt.signatureVerified).toBe(true);
    // And the payload is kept whole, unedited.
    expect(receipt.payloadJson).toMatchObject({ statusCode: 'df' });
  });

  it('processes a redelivered event exactly once', async () => {
    const eventId = `dhl-redelivered-${newId()}`;
    const payload = { eventId, trackingNumber, statusCode: 'ar' };

    const first = await ingestCarrierWebhook(envelope(payload));
    const second = await ingestCarrierWebhook(envelope(payload));

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);

    const receipts = await prisma.carrierWebhookEvent.count({
      where: { carrierIntegrationId: integrationId, providerEventId: eventId },
    });

    expect(receipts).toBe(1);

    // And exactly one shipment event came out of it.
    const events = await prisma.logisticsShipmentEvent.count({
      where: { shipmentId, externalEventId: { not: null }, status: 'AT_DESTINATION_HUB' },
    });

    expect(events).toBe(1);
  });

  it('changes nothing for a code that deliberately means nothing', async () => {
    const before = await prisma.logisticsShipment.findUniqueOrThrow({
      where: { id: shipmentId },
      select: { status: true },
    });

    const outcome = await ingestCarrierWebhook(
      envelope({ eventId: `dhl-label-${newId()}`, trackingNumber, statusCode: 'sd' }),
    );

    expect(outcome.accepted).toBe(true);
    expect(outcome.status).toBeNull();
    expect(outcome.unmapped).toBe(false);

    const after = await prisma.logisticsShipment.findUniqueOrThrow({
      where: { id: shipmentId },
      select: { status: true },
    });

    // A label-created scan must not start the transit clock.
    expect(after.status).toBe(before.status);
  });
});

describe('a code nothing recognises', () => {
  it('is preserved, flagged, and never applied', async () => {
    /*
     * Requirement 16 of the brief, and the single most important behaviour in
     * this file. An unrecognised carrier code must not crash the handler, must
     * not be guessed at, and must not be discarded - it is kept verbatim, an
     * exception carries it to a person, and the consignment is left alone.
     */
    const before = await prisma.logisticsShipment.findUniqueOrThrow({
      where: { id: shipmentId },
      select: { status: true },
    });

    const eventId = `dhl-unknown-${newId()}`;

    const outcome = await ingestCarrierWebhook(
      envelope({
        eventId,
        trackingNumber,
        statusCode: 'ZZ_SOMETHING_NEW_IN_2027',
        description: 'Consignment placed on a barge.',
      }),
    );

    expect(outcome.accepted).toBe(true);
    expect(outcome.unmapped).toBe(true);
    expect(outcome.status).toBeNull();

    // The consignment did not move.
    const after = await prisma.logisticsShipment.findUniqueOrThrow({
      where: { id: shipmentId },
      select: { status: true },
    });
    expect(after.status).toBe(before.status);

    // The carrier's own words were kept.
    const receipt = await prisma.carrierWebhookEvent.findFirstOrThrow({
      where: { carrierIntegrationId: integrationId, providerEventId: eventId },
      select: { payloadJson: true, providerStatusCode: true },
    });

    expect(receipt.providerStatusCode).toBe('ZZ_SOMETHING_NEW_IN_2027');
    expect(receipt.payloadJson).toMatchObject({ description: 'Consignment placed on a barge.' });

    // And a person was asked to look, with the payload attached.
    const exception = await prisma.logisticsShipmentException.findFirstOrThrow({
      where: { shipmentId, type: 'UNMAPPED_EXTERNAL_EVENT' },
      select: { state: true, reason: true, externalPayloadJson: true },
    });

    expect(exception.state).toBe('OPEN');
    expect(exception.reason).toContain('ZZ_SOMETHING_NEW_IN_2027');
    expect(exception.externalPayloadJson).not.toBeNull();
  });

  it('can be taught by an operator mapping, without a release', async () => {
    await prisma.carrierStatusMapping.create({
      data: {
        id: newId(),
        carrierIntegrationId: integrationId,
        providerCode: 'zz_something_new_in_2027',
        canonicalStatus: 'CUSTOMS_HOLD',
        publicDescription: 'Held for customs clearance.',
      },
    });

    const outcome = await ingestCarrierWebhook(
      envelope({
        eventId: `dhl-taught-${newId()}`,
        trackingNumber,
        statusCode: 'ZZ_SOMETHING_NEW_IN_2027',
      }),
    );

    expect(outcome.unmapped).toBe(false);
    expect(outcome.status).toBe('CUSTOMS_HOLD');
  });
});

describe('an event for a consignment we do not have', () => {
  it('is kept for a retry rather than thrown away', async () => {
    const eventId = `dhl-orphan-${newId()}`;

    const outcome = await ingestCarrierWebhook(
      envelope({ eventId, trackingNumber: 'UBNOTOURSATALL', statusCode: 'df' }),
    );

    // 2xx to the carrier, because retrying is right and a 5xx would make them
    // retry for the wrong reason.
    expect(outcome.accepted).toBe(true);
    expect(outcome.shipmentId).toBeNull();

    const receipt = await prisma.carrierWebhookEvent.findFirstOrThrow({
      where: { carrierIntegrationId: integrationId, providerEventId: eventId },
      select: { state: true, nextRetryAt: true, lastError: true },
    });

    expect(receipt.state).toBe('FAILED');
    expect(receipt.nextRetryAt).not.toBeNull();
    expect(receipt.lastError).toContain('tracking number');
  });
});
