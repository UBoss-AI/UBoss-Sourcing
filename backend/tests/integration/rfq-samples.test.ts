/**
 * Sample requests (checklist Master row 20): idempotent creation, who may be
 * asked, every step by the right side only, nothing marked shipped, delivered
 * or paid without the event, evidence seen by the two parties only, the
 * reference sample, the timeline, notifications and the audit trail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { env } from '../../src/config/env.js';
import { prisma } from '../../src/infra/prisma.js';
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
});

afterAll(async () => {
  await cleanRfqWorld(PREFIX);
  await world.app.close();
});

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
  it('moves only by the right side, never ships without tracking, never marks payment paid, and ends as a reference sample', async () => {
    const sent = await submitted(world);
    const created = sampleOf(await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples`, request(), { 'idempotency-key': key() }));
    const base = `/seller/rfqs/${sent.id}/samples/${created.id}`;

    // The buyer cannot approve what never arrived.
    const early = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/samples/${created.id}/approve`, { expectedVersion: 0, reason: null });
    expect(errorCode(early)).toBe('RFQ_SAMPLE_TRANSITION_NOT_ALLOWED');
    // Another seller cannot touch it.
    expect((await as(world, world.sellers.beta.owner, 'POST', `/seller/rfqs/${sent.id}/samples/${created.id}/accept`, { expectedVersion: 0 })).statusCode).toBe(404);

    const accepted = sampleOf(await as(world, world.sellers.alpha.owner, 'POST', `${base}/accept`, { expectedVersion: 0, costMinor: '150000', currency: 'INR', note: 'Courier by DHL' }));
    expect(accepted).toMatchObject({ status: 'ACCEPTED', paymentStatus: 'PAYMENT_PENDING', cost: { minor: '150000' } });

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
    expect(approved).toMatchObject({ status: 'APPROVED', referenceCode: `REF-${created.reference}`, paymentStatus: 'PAYMENT_PENDING' });

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
