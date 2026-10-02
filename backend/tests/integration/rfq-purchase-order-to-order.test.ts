/**
 * An approved RFQ purchase order becomes a fulfilable order (LIVE-004,
 * JOURNEY-019), end to end over HTTP:
 *
 *   RFQ -> quote -> reference sample approved -> quote accepted -> purchase
 *   order raised and approved by the company's approver and finance -> turned
 *   into an order (once, however often it is pressed) -> paid by a
 *   signature-verified webhook -> split to the supplier -> accepted -> a
 *   MANDATORY inspection with the reference sample linked -> inspected PASS ->
 *   dispatched on the contract's Incoterm -> delivered.
 *
 * And the refusals: a purchase order not yet approved, a fractional quantity,
 * a buyer who cannot see it, the supplier itself, and a missing
 * Idempotency-Key.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { env } from '../../src/config/env.js';
import { encryptSecret } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { processWebhook } from '../../src/modules/payments/payment.service.js';
import { buildCustomerBundle } from '../../src/modules/privacy/export-bundle.service.js';
import {
  as,
  buildRfqWorld,
  cleanRfqWorld,
  errorCode,
  errorDetails,
  key,
  submitted,
  type Person,
  type RfqWorld,
} from '../support/rfq-fixture.js';
import {
  asCustomer,
  asStaff,
  cleanUpOrderDesk,
  customer,
  emailFor,
  staff,
  type Session,
  type StaffSession,
} from '../support/order-desk-fixture.js';

const PREFIX = 'rfqpo-';
const TAG = 'rfqpo9';
let world: RfqWorld;

const orderIds: string[] = [];
const eventIds: string[] = [];
const agencyIds: string[] = [];
let createdConnectionId: string | null = null;
let createdTaxClassId: string | null = null;
let locationId = '';
let packingListRuleBefore = true;

/** The company's approver and finance members (set up in beforeAll). */
let approver: Person;
let finance: Person;

beforeAll(async () => {
  const app = await buildApp();
  await app.ready();
  await cleanUpOrderDesk(TAG);
  world = await buildRfqWorld(app, PREFIX);
  // The order is taxed with the deployment's default tax class, an admin setting.
  if ((await prisma.taxClass.count({ where: { isDefault: true, isActive: true } })) === 0) {
    createdTaxClassId = newId();
    await prisma.taxClass.create({
      data: { id: createdTaxClassId, code: 'RFQPO-DEFAULT', name: 'PO test default', ratePercent: '18', isDefault: true },
    });
  }
  // The company needs an approver and a finance signer, and a policy that asks for both.
  approver = world.viewer;
  finance = world.rival;
  await prisma.buyerCompanyMember.updateMany({
    where: { companyId: world.companyId, userId: approver.userId },
    data: { role: 'ORDER_APPROVER' },
  });
  await prisma.buyerCompanyMember.create({
    data: { id: newId(), companyId: world.companyId, userId: finance.userId, role: 'FINANCE' },
  });
  await prisma.session.updateMany({
    where: { userId: finance.userId },
    data: { buyerContextKind: 'COMPANY', buyerCompanyId: world.companyId },
  });
  await prisma.buyerCompanyApprovalPolicy.create({
    data: {
      id: newId(),
      companyId: world.companyId,
      enabled: true,
      currency: 'INR',
      approverThresholdMinor: 0n,
      financeThresholdMinor: 0n,
    },
  });
  const location = await prisma.sellerLocation.create({
    data: {
      id: newId(),
      sellerAccountId: world.sellers.alpha.id,
      code: 'RFQPO-WH',
      name: 'Pune factory',
      addressLine1: '1 Mill Road',
      city: 'Pune',
      postcode: '411019',
      countryCode: 'IN',
      timezone: 'Asia/Kolkata',
      dispatchCutoff: '16:00',
      workingDaysMask: 31,
      handlingTimeDays: 1,
      isOperational: true,
    },
  });
  locationId = location.id;
  const policy = await prisma.inspectionPolicy.findFirst({ select: { requirePackingListForReadiness: true } });
  packingListRuleBefore = policy?.requirePackingListForReadiness ?? true;
}, 240_000);

afterAll(async () => {
  await prisma.inspectionPolicy.updateMany({ data: { requirePackingListForReadiness: packingListRuleBefore } });
  await cleanOrders().catch((error: unknown) => {
    console.error('RFQ purchase-order order cleanup failed', error);
  });
  await prisma.inspectionAgencyMember.deleteMany({ where: { agencyId: { in: agencyIds } } });
  await prisma.inspectionAgency.deleteMany({ where: { id: { in: agencyIds } } });
  await prisma.sellerLocation.deleteMany({ where: { id: locationId } });
  if (createdConnectionId !== null) await prisma.paymentProviderConnection.deleteMany({ where: { id: createdConnectionId } });
  await cleanUpOrderDesk(TAG);
  await cleanRfqWorld(PREFIX);
  if (createdTaxClassId !== null) await prisma.taxClass.deleteMany({ where: { id: createdTaxClassId } });
  await world.app.close();
});

/** Everything the orders made here left behind, children first. */
async function cleanOrders(): Promise<void> {
  const groups = (await prisma.sellerOrderGroup.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.inspectionRequirement.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.logisticsShipment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.sellerShipment.deleteMany({ where: { orderGroupId: { in: groups } } });
  await prisma.sellerOrderSettlement.deleteMany({ where: { sellerOrderGroupId: { in: groups } } });
  await prisma.sellerOrderLine.deleteMany({ where: { orderGroupId: { in: groups } } });
  await prisma.sellerOrderGroup.deleteMany({ where: { id: { in: groups } } });
  await prisma.paymentEvent.deleteMany({ where: { providerEventId: { in: eventIds } } });
  await prisma.paymentReceipt.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.paymentTransaction.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderApproval.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.rfqPurchaseOrder.updateMany({ where: { orderId: { in: orderIds } }, data: { orderId: null } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  // The private product and offer each purchase order was given.
  await prisma.sellerOffer.deleteMany({ where: { product: { slug: { startsWith: 'rfq-po-' }, categoryId: world.categoryId } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: 'rfq-po-' }, categoryId: world.categoryId } });
}

interface QuoteBody {
  id: string;
  current: { id: string; termsHash: string } | null;
}

async function quote(rfqId: string, overrides: Record<string, unknown> = {}): Promise<QuoteBody> {
  const response = await as(world, world.sellers.alpha.owner, 'POST', `/seller/rfqs/${rfqId}/quotes`, {
    currency: 'INR',
    unitPriceMinor: '9000',
    quantity: '1200',
    moq: '500',
    leadTimeDays: 30,
    incoterm: 'CIF',
    incotermPlace: 'Nhava Sheva',
    paymentTerms: '30% advance, balance before dispatch',
    inspectionTerms: 'SGS pre-shipment, AQL 2.5',
    toolingMinor: '250000',
    shippingEstimateMinor: '125000',
    expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    ...overrides,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ quote: QuoteBody }>().quote;
}

async function accept(person: Person, rfqId: string, quoted: QuoteBody): Promise<string> {
  const termsHash = quoted.current?.termsHash ?? '';
  const accepted = await as(world, person, 'POST', `/rfqs/${rfqId}/quotes/${quoted.id}/accept`, {
    versionId: quoted.current?.id,
    termsHash,
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  return termsHash;
}

async function raisePurchaseOrder(person: Person, rfqId: string, termsHash: string): Promise<{ status: string; version: number }> {
  const raised = await as(world, person, 'POST', `/rfqs/${rfqId}/purchase-order`, {
    acceptedTermsHash: termsHash,
    eAccepted: true,
    signatureName: 'Company Owner',
    signatureTitle: 'Director',
    buyerSku: 'GLOVE-100',
  });
  expect(raised.statusCode, raised.body).toBe(201);
  return raised.json<{ purchaseOrder: { status: string; version: number } }>().purchaseOrder;
}

function convert(person: Person, rfqId: string, idempotencyKey: string | null = key()): Promise<LightMyRequestResponse> {
  return as(world, person, 'POST', `/rfqs/${rfqId}/purchase-order/order`, {}, idempotencyKey === null ? {} : { 'idempotency-key': idempotencyKey });
}

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

/** A 1x1 PNG, the smallest real image the evidence store will accept. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function uploadEvidence(session: Session, url: string, fields: Record<string, string>) {
  const boundary = 'rfqpoboundary';
  const crlf = String.fromCharCode(13, 10);
  const head = Object.entries(fields)
    .map(([name, value]) => `--${boundary}${crlf}Content-Disposition: form-data; name="${name}"${crlf}${crlf}${value}${crlf}`)
    .join('');
  return world.app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
      'x-forwarded-for': session.ip,
      'idempotency-key': newId(),
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(`${head}--${boundary}${crlf}Content-Disposition: form-data; name="file"; filename="lot.png"${crlf}Content-Type: image/png${crlf}${crlf}`),
      PNG,
      Buffer.from(`${crlf}--${boundary}--${crlf}`),
    ]),
  });
}

describe('an approved RFQ purchase order, from conversion to delivery', () => {
  it('becomes one order, is paid, split, inspected against the reference sample, shipped and delivered', async () => {
    // --- The request, the quote and an approved reference sample -----------
    const sent = await submitted(world, world.owner, { quantity: '1200' });
    const quoted = await quote(sent.id);

    const sample = await as(world, world.owner, 'POST', `/rfqs/${sent.id}/samples`, {
      sellerAccountId: world.sellers.alpha.id,
      quoteId: quoted.id,
      quantity: '10',
      deliveryAddress: 'Lab 2, MIDC, Pune 411019',
      approvalCriteria: 'Tensile strength at least 14 MPa; no pinholes in 10 of 10.',
    }, { 'idempotency-key': key() });
    expect(sample.statusCode, sample.body).toBe(201);
    const sampleId = sample.json<{ sample: { id: string } }>().sample.id;
    const sampleBase = `/seller/rfqs/${sent.id}/samples/${sampleId}`;
    const step = async (person: Person, path: string, body: Record<string, unknown>): Promise<number> => {
      const response = await as(world, person, 'POST', path, body);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ sample: { version: number } }>().sample.version;
    };
    let version = await step(world.sellers.alpha.owner, `${sampleBase}/accept`, { expectedVersion: 0 });
    version = await step(world.sellers.alpha.owner, `${sampleBase}/ship`, { expectedVersion: version, courier: 'DHL', trackingNumber: 'JD0146' });
    version = await step(world.owner, `/rfqs/${sent.id}/samples/${sampleId}/receive`, { expectedVersion: version, reason: null });
    await step(world.owner, `/rfqs/${sent.id}/samples/${sampleId}/approve`, { expectedVersion: version, reason: 'Meets every criterion' });

    // --- Accepted, raised, and waiting for the company's sign-offs ---------
    const termsHash = await accept(world.owner, sent.id, quoted);
    const pending = await raisePurchaseOrder(world.owner, sent.id, termsHash);
    expect(pending.status).toBe('PENDING_APPROVAL');

    const early = await convert(world.owner, sent.id);
    expect(errorCode(early), early.body).toBe('RFQ_PURCHASE_ORDER_NOT_CONVERTIBLE');
    expect(errorDetails(early)[0]?.code).toBe('NOT_APPROVED');

    const first = await as(world, approver, 'POST', `/rfqs/${sent.id}/purchase-order/decision`, { expectedVersion: 0, approved: true, reason: 'Commercial terms approved' });
    expect(first.statusCode, first.body).toBe(200);
    const second = await as(world, finance, 'POST', `/rfqs/${sent.id}/purchase-order/decision`, { expectedVersion: 1, approved: true, reason: 'Budget approved' });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json<{ purchaseOrder: { status: string } }>().purchaseOrder.status).toBe('APPROVED');

    // --- Who may not convert it ---------------------------------------------
    // A buyer outside the company, and the supplier itself: not found.
    expect((await convert(world.buyer, sent.id)).statusCode).toBe(404);
    expect((await convert(world.sellers.alpha.owner, sent.id)).statusCode).toBe(404);
    const noKey = await convert(world.owner, sent.id, null);
    expect(errorCode(noKey)).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const review = await as(world, world.owner, 'GET', `/rfqs/${sent.id}/purchase-order`);
    expect(review.json<{ purchaseOrder: { canConvert: boolean; order: unknown } }>().purchaseOrder).toMatchObject({ canConvert: true, order: null });

    // --- Converted once, however often, and however concurrently ------------
    const converted = await convert(world.owner, sent.id);
    expect(converted.statusCode, converted.body).toBe(201);
    const order = converted.json<{ order: { id: string; orderNumber: string; status: string } }>().order;
    orderIds.push(order.id);
    expect(order.status).toBe('PENDING_PAYMENT');

    const again = await convert(world.owner, sent.id);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json<{ order: { id: string } }>().order.id).toBe(order.id);
    const racing = await Promise.allSettled([convert(world.owner, sent.id), convert(world.owner, sent.id)]);
    for (const outcome of racing) {
      expect(outcome.status).toBe('fulfilled');
      if (outcome.status === 'fulfilled') expect(outcome.value.json<{ order: { id: string } }>().order.id).toBe(order.id);
    }
    expect(await prisma.order.count({ where: { source: 'RFQ_PURCHASE_ORDER', items: { some: { skuSnapshot: { startsWith: 'PO-' } } }, customerProfileId: world.owner.profileId } })).toBe(1);

    const purchaseOrder = await prisma.rfqPurchaseOrder.findUniqueOrThrow({ where: { rfqId: sent.id } });
    expect(purchaseOrder).toMatchObject({ orderId: order.id, convertedByUserId: world.owner.userId });
    expect(
      await prisma.auditLog.count({ where: { resourceType: 'rfq_purchase_order', resourceId: purchaseOrder.id, action: 'rfq.purchase_order_converted' } }),
    ).toBe(1);

    // The order carries exactly what was signed for: the goods, the tooling
    // as its own line, the supplier's shipping estimate, tax on top.
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: { orderBy: { lineSubtotalMinor: 'desc' } } } });
    expect(row).toMatchObject({ source: 'RFQ_PURCHASE_ORDER', currency: 'INR', buyerCompanyId: world.companyId, shippingMinor: 125000n });
    expect(row.subtotalMinor).toBe(purchaseOrder.goodsTotalMinor + purchaseOrder.toolingMinor);
    expect(row.grandTotalMinor).toBe(row.subtotalMinor + row.taxMinor + row.shippingMinor);
    expect(row.items.map((item) => [item.quantity, item.lineSubtotalMinor])).toEqual([
      [1200, 10_800_000n],
      [1, 250_000n],
    ]);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: row.items[0]?.productId ?? '' } });
    expect(product).toMatchObject({ categoryId: world.categoryId, isPublished: false, isOrderable: false, sku: purchaseOrder.reference });
    expect(row.customerNote).toContain(purchaseOrder.reference);

    const shown = await as(world, world.owner, 'GET', `/rfqs/${sent.id}/purchase-order`);
    expect(shown.json<{ purchaseOrder: { canConvert: boolean; order: { id: string } | null } }>().purchaseOrder).toMatchObject({
      canConvert: false,
      order: { id: order.id },
    });
    const buyerOrder = await as(world, world.owner, 'GET', `/orders/${order.id}`);
    expect(buyerOrder.statusCode, buyerOrder.body).toBe(200);
    expect(buyerOrder.json<{ order: { purchaseOrder: { reference: string; incoterm: string } } }>().order.purchaseOrder).toMatchObject({
      reference: purchaseOrder.reference,
      incoterm: 'CIF',
    });

    // --- Paid only by the verified webhook ---------------------------------
    const providerOrderId = await openAttempt(order.id);
    const forged = captured(providerOrderId, row.grandTotalMinor, 'not-the-secret');
    await processWebhook(forged.rawBody, forged.headers, undefined, 'RAZORPAY').catch(() => undefined);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PENDING_PAYMENT');
    const real = captured(providerOrderId, row.grandTotalMinor, env.RAZORPAY_WEBHOOK_SECRET);
    expect((await processWebhook(real.rawBody, real.headers, undefined, 'RAZORPAY')).accepted).toBe(true);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CONFIRMED');
    expect(await prisma.rfqEvent.count({ where: { rfqId: sent.id, kind: 'PURCHASE_ORDER_PAID' } })).toBe(1);

    // --- Split to the supplier, with their own shipping as their delivery --
    const group = await prisma.sellerOrderGroup.findFirstOrThrow({ where: { orderId: order.id } });
    expect(group).toMatchObject({ sellerAccountId: world.sellers.alpha.id, status: 'NEW', shippingTotalMinor: 125000n });
    const list = await as(world, world.sellers.alpha.owner, 'GET', '/seller/orders');
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json<{ rows: { id: string; purchaseOrderReference: string | null }[] }>().rows).toContainEqual(
      expect.objectContaining({ id: group.id, purchaseOrderReference: purchaseOrder.reference }),
    );

    // --- Accepted: made to order, so no stock is held; inspection mandatory -
    const accepted = await as(world, world.sellers.alpha.owner, 'PATCH', `/seller/orders/${group.id}/status`, { status: 'ACCEPTED', locationId });
    expect(accepted.statusCode, accepted.body).toBe(204);
    const requirement = await prisma.inspectionRequirement.findUniqueOrThrow({ where: { sellerOrderGroupId: group.id } });
    const approvedSample = await prisma.rfqSample.findUniqueOrThrow({ where: { id: sampleId } });
    expect(requirement).toMatchObject({ level: 'MANDATORY', referenceSampleId: sampleId });
    expect(requirement.reason).toContain(purchaseOrder.reference);
    expect(requirement.reason).toContain('SGS');

    const sellerOrder = await as(world, world.sellers.alpha.owner, 'GET', `/seller/orders/${group.id}`);
    expect(sellerOrder.json<{ purchaseOrder: { reference: string; incoterm: string; paymentTerms: string } }>().purchaseOrder).toMatchObject({
      reference: purchaseOrder.reference,
      incoterm: 'CIF',
    });

    const processing = await as(world, world.sellers.alpha.owner, 'PATCH', `/seller/orders/${group.id}/status`, { status: 'PROCESSING' });
    expect(processing.statusCode, processing.body).toBe(204);
    // Shut until the goods are inspected.
    const tooSoon = await as(world, world.sellers.alpha.owner, 'PATCH', `/seller/orders/${group.id}/status`, { status: 'READY_FOR_DISPATCH' });
    expect(tooSoon.statusCode, tooSoon.body).toBe(409);

    // The buyer sees the inspection, measured against their reference sample.
    const buyerView = await as(world, world.owner, 'GET', `/inspection/buyer/orders/${order.id}`);
    expect(buyerView.statusCode, buyerView.body).toBe(200);
    const buyerRequirement = buyerView.json<{
      inspections: { requirement: { purchaseOrder: { reference: string } | null; referenceSample: { referenceCode: string; approvalCriteria: string } | null } }[];
    }>().inspections[0]?.requirement;
    expect(buyerRequirement?.purchaseOrder?.reference).toBe(purchaseOrder.reference);
    expect(buyerRequirement?.referenceSample).toMatchObject({
      referenceCode: approvedSample.referenceCode,
      approvalCriteria: expect.stringContaining('Tensile strength'),
    });

    // --- The inspection, booked, carried out and signed PASS ----------------
    const admin: StaffSession = await staff(world.app, TAG, 'inspadmin', Role.BUSINESS_OWNER, '10.91.0.20');
    const coordinator = await customer(world.app, TAG, 'agcoord', '10.91.0.21');
    const inspector = await customer(world.app, TAG, 'aginsp', '10.91.0.22');
    const qa = await customer(world.app, TAG, 'agqa', '10.91.0.23');
    const created = await asStaff(world.app, admin, 'POST', '/inspection/agencies', {
      idempotencyKey: newId(),
      payload: { name: `${TAG} Independent QA`, legalName: `${TAG} Independent QA Ltd`, country: 'IN', contactEmail: 'qa@rfqpo9.test.local', dailyCapacity: 5 },
    });
    expect(created.statusCode, created.body).toBe(201);
    const agencyId = created.json<{ id: string }>().id;
    agencyIds.push(agencyId);
    for (const [who, role] of [['agcoord', 'COORDINATOR'], ['aginsp', 'INSPECTOR'], ['agqa', 'QA_REVIEWER']] as const) {
      const added = await asStaff(world.app, admin, 'POST', `/inspection/agencies/${agencyId}/members`, {
        idempotencyKey: newId(),
        payload: { email: emailFor(TAG, who), fullName: who, role, idDocumentType: 'PASSPORT', idDocumentNumber: `${who}-1`, competenceCategoryIds: [world.categoryId] },
      });
      expect(added.statusCode, added.body).toBe(201);
      const verified = await world.app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/inspection/members/${added.json<{ id: string }>().id}`,
        headers: { cookie: admin.cookies, 'x-csrf-token': admin.csrfToken, 'x-forwarded-for': admin.ip },
        payload: { verifyIdentity: true },
      });
      expect(verified.statusCode, verified.body).toBe(200);
    }

    const booked = await asStaff(world.app, admin, 'POST', '/inspection/jobs', {
      idempotencyKey: newId(),
      payload: {
        sellerOrderGroupId: group.id,
        agencyId,
        scheduledFor: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        inspectionPointType: 'SELLER_PREMISES',
        inspectionPoint: { label: 'Factory', addressLine: '1 Mill Road', city: 'Pune', country: 'IN' },
        payer: 'BUYER',
      },
    });
    expect(booked.statusCode, booked.body).toBe(201);
    const jobId = booked.json<{ jobId: string }>().jobId;
    const agencyCall = (session: Session, path: string, payload: Record<string, unknown> = {}) =>
      asCustomer(world.app, session, 'POST', `/inspection/agency/jobs/${jobId}/${path}`, { idempotencyKey: newId(), payload });

    const taken = await agencyCall(coordinator, 'accept', { conflictStatement: 'No financial or family link to the seller or buyer.', confirmNoConflict: true });
    expect(taken.statusCode, taken.body).toBe(200);
    const detail = await asCustomer(world.app, coordinator, 'GET', `/inspection/agency/jobs/${jobId}`);
    expect(detail.statusCode, detail.body).toBe(200);
    // The inspector's own screen names the reference sample to measure against.
    expect(detail.json<{ job: { requirement: { referenceSample: { referenceCode: string } | null } } }>().job.requirement.referenceSample?.referenceCode).toBe(
      approvedSample.referenceCode,
    );
    const inspectorMember = detail.json<{ job: { eligibleInspectors: { id: string; fullName: string }[] } }>().job.eligibleInspectors.find((member) => member.fullName === 'aginsp');
    expect(inspectorMember, detail.body).toBeDefined();
    expect((await agencyCall(coordinator, 'assign', { inspectorMemberId: inspectorMember?.id })).statusCode).toBe(200);

    await prisma.inspectionPolicy.updateMany({ data: { requirePackingListForReadiness: false } });
    const ready = await as(world, world.sellers.alpha.owner, 'POST', `/seller/inspection/jobs/${jobId}/readiness`, {
      lotReference: 'LOT-PO-1',
      readyDate: new Date().toISOString().slice(0, 10),
      locationLabel: 'Factory bay 2',
      contactName: 'Ravi',
      contactPhone: '+911234567890',
      packedStatus: 'PACKED',
      declaration: true,
    });
    expect(ready.statusCode, ready.body).toBe(200);

    for (const [action, payload] of [
      ['conflict', { hasConflict: false }],
      ['start', {}],
      // A lot of 1,200 units needs the AQL sample of 125.
      ['sampling', { lotReference: 'LOT-PO-1', sampledQuantity: 125, acceptedQuantity: 125, rejectedQuantity: 0 }],
    ] as const) {
      const response = await agencyCall(inspector, action, payload);
      expect(response.statusCode, `${action}: ${response.body}`).toBe(200);
    }
    const view = await asCustomer(world.app, inspector, 'GET', `/inspection/agency/jobs/${jobId}`);
    for (const item of view.json<{ job: { checklist: { code?: string; itemCode?: string }[] } }>().job.checklist) {
      const code = item.code ?? item.itemCode ?? '';
      const check = await agencyCall(inspector, 'checks', { itemCode: code, outcome: 'CONFORM' });
      expect(check.statusCode, `check ${code}: ${check.body}`).toBe(200);
    }
    expect((await uploadEvidence(inspector, `/inspection/agency/jobs/${jobId}/evidence`, { purpose: 'GENERAL' })).statusCode).toBe(201);
    const submittedReport = await agencyCall(inspector, 'report/submit', { summary: `Matches reference sample ${approvedSample.referenceCode ?? ''}; all checks conform.` });
    expect(submittedReport.statusCode, submittedReport.body).toBe(200);
    const signed = await asCustomer(world.app, qa, 'POST', `/inspection/agency/jobs/${jobId}/report/sign`, { idempotencyKey: newId() });
    expect(signed.statusCode, signed.body).toBe(200);
    expect(signed.json<{ result: string }>().result).toBe('PASS');

    // --- Dispatch allowed, shipped, delivered --------------------------------
    const readyToGo = await as(world, world.sellers.alpha.owner, 'PATCH', `/seller/orders/${group.id}/status`, { status: 'READY_FOR_DISPATCH' });
    expect(readyToGo.statusCode, readyToGo.body).toBe(204);
    const shipped = await as(world, world.sellers.alpha.owner, 'POST', `/seller/orders/${group.id}/shipments`, { carrierName: 'Maersk', trackingNumber: 'MSKU1234567' }, { 'idempotency-key': key() });
    expect(shipped.statusCode, shipped.body).toBe(201);
    expect((await prisma.sellerOrderGroup.findUniqueOrThrow({ where: { id: group.id } })).status).toBe('SHIPPED');
    const delivered = await as(world, world.sellers.alpha.owner, 'PATCH', `/seller/orders/${group.id}/status`, { status: 'DELIVERED' });
    expect(delivered.statusCode, delivered.body).toBe(204);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('DELIVERED');

    // The privacy export links the purchase order to the order it became.
    const bundle = await buildCustomerBundle({ userId: world.owner.userId, email: world.owner.email });
    expect(JSON.stringify(bundle)).toContain(order.orderNumber);
  }, 240_000);
});

describe('refusals', () => {
  it('refuses a purchase order whose quantity is not a whole number of units', async () => {
    const sent = await submitted(world, world.buyer, { quantity: '1200.5' });
    const quoted = await quote(sent.id, { quantity: '1200.5', toolingMinor: null, shippingEstimateMinor: null });
    const termsHash = await accept(world.buyer, sent.id, quoted);
    const raised = await raisePurchaseOrder(world.buyer, sent.id, termsHash);
    expect(raised.status).toBe('APPROVED');
    const refused = await convert(world.buyer, sent.id);
    expect(errorCode(refused), refused.body).toBe('RFQ_PURCHASE_ORDER_NOT_CONVERTIBLE');
    expect(errorDetails(refused)[0]?.code).toBe('FRACTIONAL_QUANTITY');
    expect(await prisma.rfqPurchaseOrder.findUniqueOrThrow({ where: { rfqId: sent.id }, select: { orderId: true } })).toEqual({ orderId: null });
  });

  it('answers 404 for a request with no purchase order, and for another buyer', async () => {
    const sent = await submitted(world, world.buyer);
    expect((await convert(world.buyer, sent.id)).statusCode).toBe(404);
    expect((await convert(world.owner, sent.id)).statusCode).toBe(404);
  });
});
