/**
 * Sample requests (checklist Master row 20): idempotent creation, who may be
 * asked, every step by the right side only, nothing marked shipped, delivered
 * or paid without the event, a charged sample paid through an ordinary order
 * and marked PAID only by a signature-verified webhook, a free one skipping
 * payment, evidence seen by the two parties only, the
 * reference sample, the timeline, notifications and the audit trail.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { env } from '../../src/config/env.js';
import { prisma } from '../../src/infra/prisma.js';
import { newId } from '../../src/infra/ids.js';
import { encryptSecret } from '../../src/infra/crypto.js';
import { processWebhook } from '../../src/modules/payments/payment.service.js';
import { as, buildRfqWorld, cleanRfqWorld, errorCode, errorDetails, key, submitted, type RfqWorld } from '../support/rfq-fixture.js';

const PREFIX = 'rfqs-';
let world: RfqWorld;
const mutableEnv = env as unknown as Record<string, unknown>;

interface SampleBody {
  id: string;
  reference: string;
  status: string;
  version: number;
  paymentStatus: string;
  cost: { minor: string } | null;
  shipping: { minor: string } | null;
  orderId: string | null;
  referenceCode: string | null;
  actions: string[];
  evidence: { id: string }[];
}
const sampleOf = (response: LightMyRequestResponse): SampleBody => response.json<{ sample: SampleBody }>().sample;

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sellerAccountId: world.sellers.alpha.id,
    quantity: '10',
    deliveryAddress: 'Lab 2, MIDC, Pune 411019',
    requestedByDate: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10),
    approvalCriteria: 'Tensile strength at least 14 MPa; no pinholes in 10 of 10.',
    ...overrides,
  };
}

function uploadTo(person: RfqWorld['buyer'], url: string): Promise<LightMyRequestResponse> {
  const boundary = '----rfqsample';
  return world.app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers: { cookie: person.cookie, 'x-csrf-token': person.csrf, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from('%PDF-1.4\n%%EOF\n'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}

beforeAll(async () => {
  const app = await buildApp();
  await app.ready();
  world = await buildRfqWorld(app, PREFIX);
  // A sample is taxed with the deployment's default tax class, an admin setting.
  if ((await prisma.taxClass.count({ where: { isDefault: true, isActive: true } })) === 0) {
    createdTaxClassId = newId();
    await prisma.taxClass.create({
      data: { id: createdTaxClassId, code: 'RFQS-DEFAULT', name: 'Sample test default', ratePercent: '18', isDefault: true },
    });
  }
});

const sampleOrders: string[] = [];
const eventIds: string[] = [];
let createdConnectionId: string | null = null;
let createdTaxClassId: string | null = null;

afterAll(async () => {
  await cleanPayments().catch((error: unknown) => {
    console.error('sample payment cleanup failed', error);
  });
  if (createdTaxClassId !== null) await prisma.taxClass.deleteMany({ where: { id: createdTaxClassId } });
  await cleanRfqWorld(PREFIX);
  await world.app.close();
});

async function cleanPayments(): Promise<void> {
  await prisma.paymentEvent.deleteMany({ where: { providerEventId: { in: eventIds } } });
  await prisma.paymentTransaction.deleteMany({ where: { orderId: { in: sampleOrders } } });
  if (createdConnectionId !== null) await prisma.paymentProviderConnection.deleteMany({ where: { id: createdConnectionId } });
  await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: sampleOrders } } });
  await prisma.orderApproval.deleteMany({ where: { orderId: { in: sampleOrders } } });
  await prisma.rfqSample.updateMany({ where: { orderId: { in: sampleOrders } }, data: { orderId: null } });
  await prisma.order.deleteMany({ where: { id: { in: sampleOrders } } });
}

describe('asking for a sample', () => {
  it('creates one request however often the same press is sent, and only to a supplier taking part', async () => {
    const sent = await submitted(world);
    const idempotency = key();
    const first = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples`, request(), { 'idempotency-key': idempotency });
    expect(first.statusCode, first.body).toBe(201);
    const again = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples`, request(), { 'idempotency-key': idempotency });
    expect(again.statusCode).toBe(201);
    expect(await prisma.rfqSample.count({ where: { rfqId: sent.id } })).toBe(1);
    expect(sampleOf(first)).toMatchObject({ status: 'REQUESTED', paymentStatus: 'NOT_REQUIRED' });
    expect(sampleOf(first).reference).toMatch(/^SMP-\d{4}-\d{6}$/);

    const gamma = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples`, request({ sellerAccountId: world.sellers.gamma.id }), { 'idempotency-key': key() });
    expect(errorCode(gamma)).toBe('RFQ_SUPPLIER_NOT_ELIGIBLE');
    const missingKey = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples`, request());
    expect(errorCode(missingKey)).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await as(world, world.rival, 'GET', `/rfqs/${sent.id}/samples`)).statusCode).toBe(404);

    const notice = await prisma.sellerNotification.count({ where: { sellerAccountId: world.sellers.alpha.id, subjectId: sent.id, title: { contains: 'requested' } } });
    expect(notice).toBe(1);
  });
});

describe('the life of a sample', () => {
  it('moves only by the right side, never ships without tracking, and ends as a reference sample', async () => {
    const sent = await submitted(world);
    const created = sampleOf(await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples`, request(), { 'idempotency-key': key() }));
    const base = `/seller/rfqs/${sent.id}/samples/${created.id}`;

    // The buyer cannot approve what never arrived.
    const early = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples/${created.id}/approve`, { expectedVersion: 0, reason: null });
    expect(errorCode(early)).toBe('RFQ_SAMPLE_TRANSITION_NOT_ALLOWED');
    // Another seller cannot touch it.
    expect((await as(world, world.sellers.beta.owner, 'POST', `/seller/rfqs/${sent.id}/samples/${created.id}/accept`, { expectedVersion: 0 })).statusCode).toBe(404);

    const accepted = sampleOf(await as(world, world.sellers.alpha.owner, 'POST', `${base}/accept`, { expectedVersion: 0, note: 'Courier by DHL' }));
    expect(accepted).toMatchObject({ status: 'ACCEPTED', paymentStatus: 'NOT_REQUIRED', cost: null });

    const noTracking = await as(world, world.sellers.alpha.owner, 'POST', `${base}/ship`, { expectedVersion: accepted.version, courier: 'DHL' });
    expect(noTracking.statusCode).toBe(400);
    const stale = await as(world, world.sellers.alpha.owner, 'POST', `${base}/ship`, { expectedVersion: 0, courier: 'DHL', trackingNumber: 'JD014600003' });
    expect(errorDetails(stale)[0]?.code).toBe('STALE');
    const shipped = sampleOf(await as(world, world.sellers.alpha.owner, 'POST', `${base}/ship`, { expectedVersion: accepted.version, courier: 'DHL', trackingNumber: 'JD014600003' }));
    expect(shipped.status).toBe('SHIPPED');
    // Delivery is the buyer's to confirm, not the seller's.
    expect(shipped.actions).toEqual([]);

    const received = sampleOf(await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples/${created.id}/receive`, { expectedVersion: shipped.version, reason: null }));
    expect(received.status).toBe('DELIVERED');
    const noReason = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples/${created.id}/reject`, { expectedVersion: received.version, reason: null });
    expect(errorDetails(noReason)).toContainEqual(expect.objectContaining({ field: 'reason', code: 'REQUIRED' }));
    const approved = sampleOf(await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples/${created.id}/approve`, { expectedVersion: received.version, reason: 'Meets every criterion' }));
    expect(approved).toMatchObject({ status: 'APPROVED', referenceCode: `REF-${created.reference}`, paymentStatus: 'NOT_REQUIRED' });

    const events = await prisma.rfqEvent.findMany({ where: { rfqId: sent.id, kind: { startsWith: 'SAMPLE_' } }, select: { kind: true } });
    expect(events.map((event) => event.kind)).toEqual(['SAMPLE_REQUESTED', 'SAMPLE_ACCEPTED', 'SAMPLE_SHIPPED', 'SAMPLE_DELIVERED', 'SAMPLE_APPROVED']);
    expect(await prisma.auditLog.count({ where: { resourceId: sent.id, action: { in: ['rfq.sample_requested', 'rfq.sample_updated'] } } })).toBe(5);
    const buyerMail = await prisma.notificationOutbox.count({ where: { recipientEmail: world.buyer.email, relatedId: sent.id, subject: { contains: 'sample' } } });
    expect(buyerMail).toBeGreaterThanOrEqual(2);
  });

  it('lets a supplier decline with a reason, and the buyer cancel only before shipping', async () => {
    const sent = await submitted(world);
    const one = sampleOf(await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples`, request(), { 'idempotency-key': key() }));
    const declined = await as(world, world.sellers.alpha.owner, 'POST', `/seller/rfqs/${sent.id}/samples/${one.id}/decline`, { expectedVersion: 0, reason: 'No stock for samples' });
    expect(sampleOf(declined).status).toBe('DECLINED');

    const two = sampleOf(await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples`, request(), { 'idempotency-key': key() }));
    const cancelled = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples/${two.id}/cancel`, { expectedVersion: 0, reason: null });
    expect(sampleOf(cancelled).status).toBe('CANCELLED');
    const lateAccept = await as(world, world.sellers.alpha.owner, 'POST', `/seller/rfqs/${sent.id}/samples/${two.id}/accept`, { expectedVersion: 1 });
    expect(errorCode(lateAccept)).toBe('RFQ_SAMPLE_TRANSITION_NOT_ALLOWED');
  });
});

describe('evidence', () => {
  it('is seen by the buyer and that supplier only', async () => {
    mutableEnv['RFQ_ALLOW_UNSCANNED_ATTACHMENTS'] = true;
    try {
      const sent = await submitted(world);
      const sample = sampleOf(await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples`, request(), { 'idempotency-key': key() }));
      const stored = await uploadTo(world.sellers.alpha.owner, `/seller/rfqs/${sent.id}/samples/${sample.id}/attachments`);
      expect(stored.statusCode, stored.body).toBe(201);
      const attachmentId = stored.json<{ attachment: { id: string } }>().attachment.id;

      const listed = await as(world, world.buyer, 'GET', `/rfqs/${sent.id}/samples`);
      expect(listed.json<{ samples: SampleBody[] }>().samples[0]?.evidence.map((file) => file.id)).toEqual([attachmentId]);
      expect((await as(world, world.buyer, 'GET', `/rfqs/${sent.id}/attachments/${attachmentId}/download`)).statusCode).toBe(200);
      expect((await as(world, world.sellers.alpha.owner, 'GET', `/seller/rfqs/${sent.id}/attachments/${attachmentId}/download`)).statusCode).toBe(200);
      expect((await as(world, world.sellers.beta.owner, 'GET', `/seller/rfqs/${sent.id}/attachments/${attachmentId}/download`)).statusCode).toBe(404);
    } finally {
      mutableEnv['RFQ_ALLOW_UNSCANNED_ATTACHMENTS'] = false;
    }
  });
});

describe('paying for a sample', () => {
  /** The test Razorpay connection and an open attempt on the order, as the payment screen would make. */
  async function openAttempt(orderId: string): Promise<string> {
    const existing = await prisma.paymentProviderConnection.findUnique({
      where: { provider_mode: { provider: 'RAZORPAY', mode: 'TEST' } },
      select: { id: true },
    });
    let connectionId = existing?.id ?? null;
    if (connectionId === null) {
      connectionId = newId();
      createdConnectionId = connectionId;
      await prisma.paymentProviderConnection.create({
        data: {
          id: connectionId,
          provider: 'RAZORPAY',
          mode: 'TEST',
          label: 'Test connection',
          credentialsEnc: encryptSecret(
            JSON.stringify({ keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET }),
            `payment_connection:${connectionId}`,
          ),
          webhookSecretEnc: encryptSecret(env.RAZORPAY_WEBHOOK_SECRET, `payment_connection:${connectionId}`),
          isActive: true,
        },
      });
    }
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const providerOrderId = `order_${newId().slice(0, 14)}`;
    await prisma.paymentTransaction.create({
      data: {
        id: newId(),
        orderId,
        connectionId,
        provider: 'RAZORPAY',
        mode: 'TEST',
        providerOrderId,
        status: 'CREATED',
        amountMinor: order.grandTotalMinor,
        currency: order.currency,
        idempotencyKey: newId(),
      },
    });
    return providerOrderId;
  }

  function captured(providerOrderId: string, amountMinor: bigint, secret: string) {
    const rawBody = Buffer.from(
      JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: `pay_${newId().slice(0, 14)}`,
              order_id: providerOrderId,
              amount: Number(amountMinor),
              currency: 'INR',
              status: 'captured',
              method: 'upi',
            },
          },
        },
      }),
      'utf8',
    );
    const eventId = `evt_${newId()}`;
    eventIds.push(eventId);
    return {
      rawBody,
      headers: { 'x-razorpay-signature': createHmac('sha256', secret).update(rawBody).digest('hex'), 'x-razorpay-event-id': eventId },
    };
  }

  it('collects the fee, tax and shipping through an order, is PAID only by the verified webhook, then ships and is decided', async () => {
    const sent = await submitted(world);
    const created = sampleOf(await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples`, request(), { 'idempotency-key': key() }));
    const base = `/seller/rfqs/${sent.id}/samples/${created.id}`;
    const accepted = sampleOf(
      await as(world, world.sellers.alpha.owner, 'POST', `${base}/accept`, { expectedVersion: 0, costMinor: '150000', shippingMinor: '25000', currency: 'INR' }),
    );
    expect(accepted).toMatchObject({ paymentStatus: 'PAYMENT_PENDING', cost: { minor: '150000' }, shipping: { minor: '25000' } });
    expect(accepted.actions).not.toContain('SHIPPED');
    const unpaidShip = await as(world, world.sellers.alpha.owner, 'POST', `${base}/ship`, { expectedVersion: accepted.version, courier: 'DHL', trackingNumber: 'JD014600009' });
    expect(errorDetails(unpaidShip)[0]?.code).toBe('PAYMENT_PENDING');

    const checkout = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples/${created.id}/checkout`, {});
    expect(checkout.statusCode, checkout.body).toBe(200);
    const { orderId } = checkout.json<{ orderId: string }>();
    sampleOrders.push(orderId);
    // Pressed again: the same order, not a second one.
    const again = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples/${created.id}/checkout`, {});
    expect(again.json<{ orderId: string }>().orderId).toBe(orderId);
    expect((await as(world, world.rival, 'POST', `/rfqs/${sent.id}/samples/${created.id}/checkout`, {})).statusCode).toBe(404);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order).toMatchObject({ source: 'RFQ_SAMPLE', status: 'PENDING_PAYMENT', currency: 'INR', subtotalMinor: 150000n, shippingMinor: 25000n });
    // Tax is worked out on the fee like any order's, and the total is fee + tax + shipping (exclusive) or fee + shipping (inclusive).
    expect([175000n + order.taxMinor, 175000n]).toContain(order.grandTotalMinor);
    expect(sampleOf(again).orderId).toBe(orderId);

    const providerOrderId = await openAttempt(orderId);
    // A forged event changes nothing.
    const forged = captured(providerOrderId, order.grandTotalMinor, 'not-the-secret');
    await processWebhook(forged.rawBody, forged.headers, undefined, 'RAZORPAY').catch(() => undefined);
    expect((await prisma.rfqSample.findUniqueOrThrow({ where: { id: created.id } })).paymentStatus).toBe('PAYMENT_PENDING');

    const real = captured(providerOrderId, order.grandTotalMinor, env.RAZORPAY_WEBHOOK_SECRET);
    const result = await processWebhook(real.rawBody, real.headers, undefined, 'RAZORPAY');
    expect(result.accepted).toBe(true);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CONFIRMED');

    const listed = await as(world, world.sellers.alpha.owner, 'GET', `/seller/rfqs/${sent.id}/samples`);
    const paid = listed.json<{ samples: SampleBody[] }>().samples.find((one) => one.id === created.id);
    if (paid === undefined) throw new Error('the paid sample is not listed');
    expect(paid).toMatchObject({ paymentStatus: 'PAID' });
    expect(paid.actions).toContain('SHIPPED');
    expect(await prisma.sellerNotification.count({ where: { sellerAccountId: world.sellers.alpha.id, subjectId: sent.id, title: { contains: 'is paid' } } })).toBe(1);
    // Paid: not cancelled from here.
    const lateCancel = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples/${created.id}/cancel`, { expectedVersion: paid.version, reason: null });
    expect(errorDetails(lateCancel)[0]?.code).toBe('PAID');

    const shipped = sampleOf(await as(world, world.sellers.alpha.owner, 'POST', `${base}/ship`, { expectedVersion: paid.version, courier: 'DHL', trackingNumber: 'JD014600009' }));
    expect(shipped.status).toBe('SHIPPED');
    const received = sampleOf(await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples/${created.id}/receive`, { expectedVersion: shipped.version, reason: null }));
    const rejected = sampleOf(await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples/${created.id}/reject`, { expectedVersion: received.version, reason: 'Pinholes in 2 of 10' }));
    expect(rejected).toMatchObject({ status: 'REJECTED', paymentStatus: 'PAID', referenceCode: null });
    const kinds = (await prisma.rfqEvent.findMany({ where: { rfqId: sent.id, kind: { startsWith: 'SAMPLE_' } }, orderBy: { createdAt: 'asc' }, select: { kind: true } })).map((event) => event.kind);
    expect(kinds).toContain('SAMPLE_PAID');
  });

  it('cancels the unpaid order with the sample, and lets a free sample skip payment', async () => {
    const sent = await submitted(world);
    const charged = sampleOf(await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples`, request(), { 'idempotency-key': key() }));
    const accepted = sampleOf(
      await as(world, world.sellers.alpha.owner, 'POST', `/seller/rfqs/${sent.id}/samples/${charged.id}/accept`, { expectedVersion: 0, costMinor: '5000', currency: 'INR' }),
    );
    const paying = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples/${charged.id}/checkout`, {});
    expect(paying.statusCode, paying.body).toBe(200);
    const { orderId } = paying.json<{ orderId: string }>();
    sampleOrders.push(orderId);
    const cancelled = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples/${charged.id}/cancel`, { expectedVersion: accepted.version, reason: null });
    expect(sampleOf(cancelled).status).toBe('CANCELLED');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED');

    const free = sampleOf(await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples`, request(), { 'idempotency-key': key() }));
    const freeAccepted = sampleOf(
      await as(world, world.sellers.alpha.owner, 'POST', `/seller/rfqs/${sent.id}/samples/${free.id}/accept`, { expectedVersion: 0, costMinor: '0', shippingMinor: '0' }),
    );
    expect(freeAccepted).toMatchObject({ paymentStatus: 'NOT_REQUIRED', cost: null, shipping: null, orderId: null });
    const nothingToPay = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples/${free.id}/checkout`, {});
    expect(errorDetails(nothingToPay)[0]?.code).toBe('NOT_REQUIRED');
    const shipped = sampleOf(
      await as(world, world.sellers.alpha.owner, 'POST', `/seller/rfqs/${sent.id}/samples/${free.id}/ship`, { expectedVersion: freeAccepted.version, courier: 'BlueDart', trackingNumber: 'BD7781' }),
    );
    expect(shipped).toMatchObject({ status: 'SHIPPED', orderId: null });
  });
});
