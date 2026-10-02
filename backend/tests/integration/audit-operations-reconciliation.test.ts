/**
 * The audit trail and the console's figures agree with what happened (LIVE-021).
 *
 * A known set of operations is performed through the real routes:
 *
 *   - five order status transitions on three paid orders (cancel x2,
 *     processing x1, and the two "refunded" moves the refunds cause),
 *   - two refunds, sent to a scripted fake payment provider on a real socket,
 *   - two dispute decisions.
 *
 * Then, for each kind:
 *
 *   1. the audit rows equal the operational rows - one audit entry per status
 *      history row (the same statuses, by the staff member who made the move),
 *      one `refund.created` per refund, one `dispute.decided` per decided
 *      dispute - and the audit log screen's search returns the same totals;
 *   2. the dashboard and report panels report what a direct SQL count over the
 *      same window says: orders by status, refund count and amount, disputes
 *      decided by resolution.
 *
 * The window is "since this file started", so the figures cover this file's
 * own rows; the comparison is always the panel against SQL over that same
 * window, never against a number typed here.
 *
 * WHAT IS NOT REAL: the payment provider's API (the fake answers the refund),
 * and the orders are written already paid, as `escrow-ledger.test.ts` does;
 * every change after that goes through the routes staff use.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { encryptSecret } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { redirectingFetch, startFakeProvider, type FakeProvider } from '../support/fake-provider.js';
import {
  asCustomer as customerCall,
  asStaff as staffCall,
  buildOrderDesk,
  cleanUpOrderDesk,
  emailFor,
  staff,
  type CallOptions,
  type OrderDesk,
  type StaffSession,
} from '../support/order-desk-fixture.js';

const TAG = 'aor21';
const UPPER = TAG.toUpperCase();
const KEY_ID = 'rzp_test_aor21key';

let app: Awaited<ReturnType<typeof buildApp>>;
let desk: OrderDesk;
let owner: StaffSession;
let fake: FakeProvider;
const realFetch = globalThis.fetch;
let connectionId = '';
let savedConnection: { id: string; credentialsEnc: string; webhookSecretEnc: string | null; isActive: boolean } | null = null;
const startedAt = new Date(Date.now() - 2_000);
const orderIds: string[] = [];
const disputeIds: string[] = [];

const asCustomer: typeof customerCall = (target, session, method, path, options: CallOptions = {}) =>
  customerCall(target, session, method, path, { idempotencyKey: newId(), ...options });
const asStaff: typeof staffCall = (target, session, method, path, options: CallOptions = {}) =>
  staffCall(target, session, method, path, { idempotencyKey: newId(), ...options });

const userIdOf = async (who: string): Promise<string> =>
  (await prisma.user.findUniqueOrThrow({ where: { emailNormalized: emailFor(TAG, who) }, select: { id: true } })).id;

/** A paid, confirmed order for the desk's buyer, with a captured payment. */
async function paidOrder(serial: number): Promise<string> {
  const id = newId();
  const address = { line1: '9 Audit Lane', city: 'Pune', postalCode: '411001', countryCode: 'IN' };
  const buyerProfile = await prisma.customerProfile.findFirstOrThrow({
    where: { user: { emailNormalized: emailFor(TAG, 'buyer') } },
    select: { id: true },
  });
  await prisma.order.create({
    data: {
      id,
      orderNumber: `UB-${UPPER}-${String(serial).padStart(6, '0')}`,
      customerProfileId: buyerProfile.id,
      status: 'CONFIRMED',
      currency: 'INR',
      subtotalMinor: 20_000n,
      grandTotalMinor: 20_000n,
      paidMinor: 20_000n,
      placedAt: new Date(),
      confirmedAt: new Date(),
      billingAddressJson: address,
      shippingAddressJson: address,
    },
  });
  await prisma.paymentTransaction.create({
    data: {
      id: newId(),
      orderId: id,
      connectionId,
      provider: 'RAZORPAY',
      mode: 'TEST',
      providerOrderId: `order_${TAG}${newId().slice(-10)}`,
      providerPaymentId: `pay_${TAG}${newId().slice(-10)}`,
      status: 'CAPTURED',
      amountMinor: 20_000n,
      capturedMinor: 20_000n,
      currency: 'INR',
      method: 'upi',
      idempotencyKey: newId(),
      capturedAt: new Date(),
    },
  });
  orderIds.push(id);
  return id;
}

async function cleanUp(): Promise<void> {
  const mine = (
    await prisma.order.findMany({ where: { orderNumber: { startsWith: `UB-${UPPER}-` } }, select: { id: true } })
  ).map((row) => row.id);
  const refunds = (await prisma.refund.findMany({ where: { orderId: { in: mine } }, select: { id: true } })).map((row) => row.id);
  const disputes = (await prisma.dispute.findMany({ where: { orderId: { in: mine } }, select: { id: true } })).map((row) => row.id);
  await prisma.auditLog.deleteMany({ where: { resourceId: { in: [...refunds, ...disputes] } } });
  await prisma.dispute.deleteMany({ where: { id: { in: disputes } } });
  await prisma.refund.deleteMany({ where: { id: { in: refunds } } });
  await prisma.paymentEvent.deleteMany({ where: { orderId: { in: mine } } });
  await prisma.paymentTransaction.deleteMany({ where: { orderId: { in: mine } } });
  await cleanUpOrderDesk(TAG);
}

beforeAll(async () => {
  fake = await startFakeProvider();
  vi.stubGlobal('fetch', redirectingFetch({ 'https://api.razorpay.com': fake.origin }, realFetch));
  app = await buildApp();
  await app.ready();
  await cleanUp();

  // The one Razorpay TEST connection: borrowed and put back exactly, or made
  // and removed. Saved last, so it is the gateway a refund is sent through.
  const existing = await prisma.paymentProviderConnection.findUnique({
    where: { provider_mode: { provider: 'RAZORPAY', mode: 'TEST' } },
    select: { id: true, credentialsEnc: true, webhookSecretEnc: true, isActive: true },
  });
  savedConnection = existing;
  connectionId = existing?.id ?? newId();
  const credentialsEnc = encryptSecret(JSON.stringify({ keyId: KEY_ID, keySecret: 'aor21-secret-not-real' }), `payment_connection:${connectionId}`);
  const webhookSecretEnc = encryptSecret('aor21-webhook-not-real', `payment_connection:${connectionId}`);
  if (existing === null) {
    await prisma.paymentProviderConnection.create({
      data: { id: connectionId, provider: 'RAZORPAY', mode: 'TEST', label: `${TAG}-test`, credentialsEnc, webhookSecretEnc, isActive: true },
    });
  } else {
    await prisma.paymentProviderConnection.update({ where: { id: connectionId }, data: { credentialsEnc, webhookSecretEnc, isActive: true } });
  }

  desk = await buildOrderDesk(app, TAG, 92, 21);
  owner = await staff(app, TAG, 'inspadmin', Role.BUSINESS_OWNER, '10.92.21.20');
}, 240_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await fake.close();
  await cleanUp();
  if (savedConnection === null) {
    await prisma.paymentProviderConnection.deleteMany({ where: { id: connectionId } });
  } else {
    await prisma.paymentProviderConnection.update({
      where: { id: savedConnection.id },
      data: {
        credentialsEnc: savedConnection.credentialsEnc,
        webhookSecretEnc: savedConnection.webhookSecretEnc,
        isActive: savedConnection.isActive,
      },
    });
  }
  await app.close();
});

describe('a known set of operations', () => {
  it('moves three orders, refunds two and decides two disputes through the routes', async () => {
    const first = await paidOrder(11);
    const second = await paidOrder(12);
    const third = await paidOrder(13);

    for (const orderId of [first, second]) {
      const cancelled = await asStaff(app, desk.orderDesk, 'POST', `/orders/${orderId}/transition`, {
        payload: { to: 'CANCELLED', reason: 'Buyer asked to cancel' },
      });
      expect(cancelled.statusCode, cancelled.body).toBe(200);
    }
    const processing = await asStaff(app, desk.orderDesk, 'POST', `/orders/${third}/transition`, {
      payload: { to: 'PROCESSING' },
    });
    expect(processing.statusCode, processing.body).toBe(200);

    // Two full refunds: the provider settles each at once, and a fully
    // refunded cancelled order moves to REFUNDED - two more transitions.
    for (const orderId of [first, second]) {
      const payment = await prisma.paymentTransaction.findFirstOrThrow({ where: { orderId }, select: { providerPaymentId: true } });
      fake.script({ status: 200, json: { id: `rfnd_${TAG}${newId().slice(-10)}`, entity: 'refund', amount: 20_000, status: 'processed', payment_id: payment.providerPaymentId } });
      const refunded = await asStaff(app, desk.financeOne, 'POST', `/orders/${orderId}/refunds`, {
        payload: { reason: 'Cancelled before dispatch' },
      });
      expect(refunded.statusCode, refunded.body).toBe(201);
      expect(refunded.json<{ orderTransitioned: boolean }>().orderTransitioned).toBe(true);
    }

    // Two claims on the delivered desk order, each decided.
    for (const orderItemId of [desk.itemId, desk.secondItemId]) {
      const opened = await asCustomer(app, desk.buyer, 'POST', '/disputes', {
        payload: {
          orderId: desk.orderId,
          orderItemId,
          reasonCode: 'DAMAGED',
          description: 'The box arrived crushed and the unit inside is broken.',
          desiredOutcome: 'REFUND_PARTIAL',
          requestedAmountMinor: '2000',
        },
      });
      expect(opened.statusCode, opened.body).toBeLessThan(300);
      const reference = opened.json<{ dispute: { reference: string } }>().dispute.reference;
      const id = (await prisma.dispute.findFirstOrThrow({ where: { reference }, select: { id: true } })).id;
      disputeIds.push(id);
      const decided = await asStaff(app, desk.orderDesk, 'POST', `/disputes/${id}/decision`, {
        payload: { resolution: 'REJECT', reason: 'The packaging was intact on delivery.' },
      });
      expect(decided.statusCode, decided.body).toBe(200);
      expect(decided.json<{ applied: boolean }>().applied).toBe(true);
    }
  });
});

describe('the audit trail matches the operations', () => {
  it('has one order audit entry per status history row, with the same statuses and actors', async () => {
    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId: { in: orderIds } },
      select: { orderId: true, toStatus: true },
    });
    expect(history).toHaveLength(5);

    const audits = await prisma.auditLog.findMany({
      where: { resourceType: 'order', resourceId: { in: orderIds }, action: { in: ['order.status_changed', 'order.cancelled'] } },
      select: { resourceId: true, action: true, afterJson: true, actorUserId: true },
    });
    expect(audits).toHaveLength(history.length);

    const key = (orderId: string | null, status: unknown) => `${String(orderId)}:${String(status)}`;
    expect(audits.map((row) => key(row.resourceId, (row.afterJson as { status?: string } | null)?.status)).sort()).toEqual(
      history.map((row) => key(row.orderId, row.toStatus)).sort(),
    );
    expect(audits.filter((row) => row.action === 'order.cancelled')).toHaveLength(2);

    // Every move was made by a named member of staff, and the right one.
    const deskId = await userIdOf('desk');
    const financeId = await userIdOf('finance1');
    for (const row of audits) {
      const status = (row.afterJson as { status?: string } | null)?.status;
      expect(row.actorUserId, `${String(row.resourceId)} ${String(status)}`).toBe(status === 'REFUNDED' ? financeId : deskId);
    }

    // The audit log screen finds the same entries.
    for (const orderId of orderIds) {
      const listed = await asStaff(app, owner, 'GET', `/audit-logs?resourceType=order&resourceId=${orderId}&limit=100`);
      expect(listed.statusCode, listed.body).toBe(200);
      const sqlRows = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*) AS n FROM audit_logs WHERE resourceType = 'order' AND resourceId = ${orderId}`;
      expect(BigInt(listed.json<{ pagination: { total: number } }>().pagination.total)).toBe(BigInt(sqlRows[0]?.n ?? 0));
    }
  });

  it('has one refund.created entry per refund, and one dispute.decided per decided dispute', async () => {
    const refunds = await prisma.refund.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } });
    expect(refunds).toHaveLength(2);
    const refundAudits = await prisma.auditLog.count({
      where: { action: 'refund.created', resourceType: 'refund', resourceId: { in: refunds.map((row) => row.id) } },
    });
    expect(refundAudits).toBe(refunds.length);

    const decided = await prisma.dispute.count({ where: { id: { in: disputeIds }, decidedAt: { not: null } } });
    expect(decided).toBe(2);
    const disputeAudits = await prisma.auditLog.count({
      where: { action: 'dispute.decided', resourceType: 'dispute', resourceId: { in: disputeIds } },
    });
    expect(disputeAudits).toBe(decided);

    // And the audit log search for the window agrees with the refunds table.
    const from = startedAt.toISOString();
    const to = new Date(Date.now() + 1_000).toISOString();
    const listed = await asStaff(app, owner, 'GET', `/audit-logs?action=refund.created&from=${from}&to=${to}&limit=100`);
    expect(listed.statusCode, listed.body).toBe(200);
    const refundRows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM refunds WHERE createdAt >= ${startedAt} AND createdAt < ${new Date(to)}`;
    expect(BigInt(listed.json<{ pagination: { total: number } }>().pagination.total)).toBe(BigInt(refundRows[0]?.n ?? 0));
  });
});

describe('the dashboard and reports match the tables', () => {
  it('reports orders by status, refunds and dispute decisions exactly as SQL counts them', async () => {
    const to = new Date(Date.now() + 1_000);
    const query = `from=${startedAt.toISOString()}&to=${to.toISOString()}`;

    const dashboard = await asStaff(app, owner, 'GET', `/dashboard?${query}`);
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    const body = dashboard.json<{
      ordersByStatus: { status: string; count: number; value: string }[];
      payments: { refundCount: number; refunded: string };
    }>();

    const byStatus = await prisma.$queryRaw<{ status: string; n: bigint; total: { toString(): string } | null }[]>`
      SELECT status, COUNT(*) AS n, SUM(grandTotalMinor) AS total FROM orders
      WHERE createdAt >= ${startedAt} AND createdAt < ${to} GROUP BY status`;
    const panel = new Map(body.ordersByStatus.map((row) => [row.status, row]));
    expect(body.ordersByStatus).toHaveLength(byStatus.length);
    for (const row of byStatus) {
      expect(panel.get(row.status)?.count, row.status).toBe(Number(row.n));
      expect(BigInt(panel.get(row.status)?.value ?? '-1'), row.status).toBe(BigInt(String(row.total ?? 0)));
    }
    // This file's own orders are among them.
    expect(panel.get('REFUNDED')?.count ?? 0).toBeGreaterThanOrEqual(2);
    expect(panel.get('PROCESSING')?.count ?? 0).toBeGreaterThanOrEqual(1);

    const refundRows = await prisma.$queryRaw<{ n: bigint; total: { toString(): string } | null }[]>`
      SELECT COUNT(*) AS n, SUM(amountMinor) AS total FROM refunds
      WHERE createdAt >= ${startedAt} AND createdAt < ${to} AND status IN ('SUCCEEDED', 'PROCESSING')`;
    expect(body.payments.refundCount).toBe(Number(refundRows[0]?.n ?? 0));
    expect(BigInt(body.payments.refunded)).toBe(BigInt(String(refundRows[0]?.total ?? 0)));
    expect(body.payments.refundCount).toBeGreaterThanOrEqual(2);

    const marketplace = await asStaff(app, owner, 'GET', `/reports/marketplace?${query}`);
    expect(marketplace.statusCode, marketplace.body).toBe(200);
    const disputes = marketplace.json<{ disputes: { byResolution: { resolution: string; count: number }[] } }>().disputes;
    const decidedRows = await prisma.$queryRaw<{ resolution: string; n: bigint }[]>`
      SELECT resolution, COUNT(*) AS n FROM disputes
      WHERE decidedAt >= ${startedAt} AND decidedAt < ${to} AND resolution IS NOT NULL GROUP BY resolution`;
    const reported = new Map(disputes.byResolution.map((row) => [row.resolution, row.count]));
    expect(disputes.byResolution).toHaveLength(decidedRows.length);
    for (const row of decidedRows) expect(reported.get(row.resolution), row.resolution).toBe(Number(row.n));
    expect(reported.get('REJECT') ?? 0).toBeGreaterThanOrEqual(2);
  });
});
