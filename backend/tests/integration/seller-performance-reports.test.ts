/**
 * Seller Hub home actions, seller performance and the admin marketplace
 * reports (checklist Master rows 33, 44, 74, 92).
 *
 * One seller is given a small, known history - three orders (one on time and
 * kept, one late and returned with a claim, one cancelled), an inspection
 * waiting for the lot, a failed inspection with an open NCR, a lapsed
 * certificate and a settlement on hold - and every figure is checked against
 * it. A second seller with none of it must see none of it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { resolveWindow } from '../../src/modules/reports/report.service.js';
import {
  disputeReport,
  gmvReport,
  inspectionSummary,
  settlementReport,
  supplierQualityReport,
} from '../../src/modules/reports/marketplace-report.service.js';
import { buildApp } from '../../src/http/app.js';
import { as, buildRfqWorld, cleanRfqWorld, submitted, type RfqWorld } from '../support/rfq-fixture.js';

const PREFIX = 'sperf-';
const DAY = 86_400_000;
let world: RfqWorld;
let agencyId = '';
const orderIds: string[] = [];
const groupIds: Record<'kept' | 'late' | 'cancelled', string> = { kept: '', late: '', cancelled: '' };
let alphaInvited = 0;

const ADDRESS = { line1: '1 Test Road', city: 'Pune', postalCode: '411001', countryCode: 'IN' };

async function orderFor(
  sellerAccountId: string,
  key: keyof typeof groupIds,
  status: 'DELIVERED' | 'CANCELLED',
  promisedDeliveryTo: Date,
  deliveredAt: Date | null,
): Promise<string> {
  const orderId = newId();
  orderIds.push(orderId);
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `SP${String(Date.now()).slice(-8)}${String(orderIds.length)}`,
      customerProfileId: world.buyer.profileId,
      status: status === 'CANCELLED' ? 'CANCELLED' : 'DELIVERED',
      currency: 'INR',
      subtotalMinor: 10_000n,
      discountMinor: 0n,
      taxMinor: 0n,
      shippingMinor: 0n,
      grandTotalMinor: 10_000n,
      shippingAddressJson: ADDRESS,
      billingAddressJson: ADDRESS,
      // The promise is all three dates or none (chk_order_fulfilment_dates).
      fulfilmentDispatchDate: new Date(promisedDeliveryTo.getTime() - 3 * DAY),
      fulfilmentDeliveryFrom: new Date(promisedDeliveryTo.getTime() - DAY),
      fulfilmentDeliveryTo: promisedDeliveryTo,
    },
  });
  const groupId = newId();
  await prisma.sellerOrderGroup.create({
    data: {
      id: groupId,
      sellerAccountId,
      orderId,
      sellerOrderNumber: `${PREFIX}${key}`,
      status,
      goodsTotalMinor: 10_000n,
      commissionMinor: 1_000n,
      sellerNetMinor: 9_000n,
      currency: 'INR',
      dispatchDueAt: new Date(Date.now() - 4 * DAY),
      dispatchedAt: deliveredAt === null ? null : new Date(Date.now() - 5 * DAY),
      deliveredAt,
      cancelledAt: status === 'CANCELLED' ? new Date() : null,
    },
  });
  groupIds[key] = groupId;
  return groupId;
}

function jobData(requirementId: string, status: 'ACCEPTED' | 'COMPLETED') {
  return {
    id: newId(),
    jobNumber: `${PREFIX}${newId().slice(-10)}`,
    requirementId,
    agencyId,
    status,
    bookedByParty: 'BUYER' as const,
    bookedByLabel: 'Buyer',
    payer: 'BUYER' as const,
    inspectionPointType: 'SELLER_PREMISES' as const,
    inspectionPointJson: { address: 'Plant 1' },
    scheduledFor: new Date(Date.now() + 3 * DAY),
    language: 'en',
    standard: 'ISO 2859-1',
    scopeJson: {},
    planSnapshotJson: {},
    lotSize: 100,
    samplingJson: {},
    acceptDueAt: new Date(Date.now() + DAY),
    reportDueAt: new Date(Date.now() + 5 * DAY),
  };
}

async function requirementFor(groupId: string, orderId: string, sellerAccountId: string): Promise<string> {
  const id = newId();
  await prisma.inspectionRequirement.create({
    data: {
      id,
      sellerOrderGroupId: groupId,
      orderId,
      sellerAccountId,
      level: 'BUYER_REQUESTED',
      status: 'BOOKED',
      reason: 'Buyer asked',
      inputsJson: {},
      evaluatedAt: new Date(),
    },
  });
  return id;
}

beforeAll(async () => {
  const app = await buildApp();
  await app.ready();
  world = await buildRfqWorld(app, PREFIX);
  const alpha = world.sellers.alpha.id;

  const rfq = await submitted(world);
  alphaInvited = rfq.invitations.filter((entry) => entry.supplier.sellerAccountId === alpha).length;

  const kept = await orderFor(alpha, 'kept', 'DELIVERED', new Date(Date.now() + 2 * DAY), new Date(Date.now() - DAY));
  const late = await orderFor(alpha, 'late', 'DELIVERED', new Date(Date.now() - 5 * DAY), new Date(Date.now() - DAY));
  await orderFor(alpha, 'cancelled', 'CANCELLED', new Date(Date.now() + 2 * DAY), null);
  const keptOrder = orderIds[0] as string;
  const lateOrder = orderIds[1] as string;

  await prisma.returnRequest.create({
    data: {
      id: newId(),
      orderId: lateOrder,
      sellerOrderGroupId: late,
      reason: 'Damaged',
      itemsJson: [],
      requestedById: world.buyer.userId,
    },
  });
  await prisma.dispute.create({
    data: {
      id: newId(),
      reference: `SPD${String(Date.now()).slice(-9)}`,
      kind: 'CLAIM',
      status: 'AWAITING_SELLER',
      orderId: lateOrder,
      sellerOrderGroupId: late,
      sellerAccountId: alpha,
      customerProfileId: world.buyer.profileId,
      reasonCode: 'DAMAGED',
      currency: 'INR',
    },
  });

  agencyId = newId();
  await prisma.inspectionAgency.create({
    data: {
      id: agencyId,
      name: `${PREFIX}agency`,
      legalName: `${PREFIX}agency Ltd`,
      country: 'IN',
      contactEmail: `${PREFIX}agency@test.local`,
    },
  });

  // Booked, lot not yet declared ready.
  const keptRequirement = await requirementFor(kept, keptOrder, alpha);
  await prisma.inspectionJob.create({ data: jobData(keptRequirement, 'ACCEPTED') });

  // Inspected and failed, with an NCR still open.
  const lateRequirement = await requirementFor(late, lateOrder, alpha);
  const failedJob = jobData(lateRequirement, 'COMPLETED');
  await prisma.inspectionJob.create({ data: failedJob });
  await prisma.inspectionReport.create({
    data: {
      id: newId(),
      jobId: failedJob.id,
      revision: 1,
      status: 'SIGNED',
      result: 'FAIL',
      computationJson: {},
      contentJson: {},
      contentHash: 'a'.repeat(64),
      submittedAt: new Date(),
      submittedByMemberId: newId(),
      signedAt: new Date(),
    },
  });
  await prisma.inspectionDefect.create({
    data: {
      id: newId(),
      jobId: failedJob.id,
      requirementId: lateRequirement,
      ncrNumber: `${PREFIX}${newId().slice(-12)}`,
      severity: 'MAJOR',
      originalSeverity: 'MAJOR',
      requirementRef: 'Packaging',
      description: 'Cartons crushed',
      recordedByMemberId: newId(),
    },
  });

  await prisma.sellerCertification.create({
    data: {
      id: newId(),
      sellerAccountId: alpha,
      standard: 'ISO 13485',
      issuer: 'Test body',
      state: 'EXPIRED',
      expiresOn: new Date(Date.now() - 10 * DAY),
    },
  });

  await prisma.sellerSettlement.create({
    data: {
      id: newId(),
      sellerAccountId: alpha,
      reference: `SPS${String(Date.now()).slice(-9)}`,
      status: 'ON_HOLD',
      periodStart: new Date(Date.now() - 7 * DAY),
      periodEnd: new Date(Date.now() - DAY),
      currency: 'INR',
      grossMinor: 20_000n,
      commissionMinor: 2_000n,
      netPayableMinor: 18_000n,
    },
  });
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  if (agencyId !== '') await prisma.inspectionAgency.deleteMany({ where: { id: agencyId } });
  await cleanRfqWorld(PREFIX);
  await world.app.close();
});

interface Dashboard {
  rfqs: { awaitingResponse: number; closingSoon: number };
  inspection: {
    readinessDue: number;
    capaDue: number;
    items: { kind: string; sellerOrderGroupId: string }[];
  };
  compliance: { certificatesLapsed: number; certificatesExpiringSoon: number; listingsOnHold: number };
  unavailable: { tile: string }[];
}

describe('the Seller Hub home', () => {
  it('lists RFQs, inspection and compliance work waiting on this seller', async () => {
    const response = await as(world, world.sellers.alpha.owner, 'GET', '/seller/dashboard?range=month');
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<Dashboard>();

    expect(body.unavailable).toEqual([]);
    expect(alphaInvited).toBeGreaterThan(0);
    expect(body.rfqs.awaitingResponse).toBe(alphaInvited);
    expect(body.inspection.readinessDue).toBe(1);
    expect(body.inspection.capaDue).toBe(1);
    expect(body.inspection.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'READINESS', sellerOrderGroupId: groupIds.kept }),
        expect.objectContaining({ kind: 'CAPA', sellerOrderGroupId: groupIds.late }),
      ]),
    );
    expect(body.compliance.certificatesLapsed).toBe(1);
  });

  it('shows another seller none of it', async () => {
    const response = await as(world, world.sellers.gamma.owner, 'GET', '/seller/dashboard');
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<Dashboard>();
    expect(body.inspection).toEqual({ readinessDue: 0, capaDue: 0, items: [] });
    expect(body.compliance.certificatesLapsed).toBe(0);
  });
});

describe('seller performance', () => {
  it('computes conversion, OTIF, quality, cancellations and claims from the seller history', async () => {
    const response = await as(world, world.sellers.alpha.owner, 'GET', '/seller/performance?days=30');
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{
      days: number;
      rfq: { invited: number; quoted: number; won: number; conversion: { numerator: number; denominator: number } };
      orders: { placed: number; cancelled: number; cancellationRate: { numerator: number; denominator: number } };
      delivery: Record<string, unknown>;
      quality: Record<string, unknown>;
      claims: { opened: number; open: number; chargebacks: number };
    }>();

    expect(body.days).toBe(30);
    expect(body.rfq).toMatchObject({ invited: alphaInvited, quoted: 0, won: 0 });
    // Nothing quoted: a rate over nothing, never a zero percent.
    expect(body.rfq.conversion).toEqual({ numerator: 0, denominator: 0 });
    expect(body.orders).toMatchObject({ placed: 3, cancelled: 1 });
    expect(body.orders.cancellationRate).toEqual({ numerator: 1, denominator: 3 });
    expect(body.delivery).toMatchObject({
      deliveredInPeriod: 2,
      withoutPromisedDate: 0,
      onTime: { numerator: 1, denominator: 2 },
      inFull: { numerator: 1, denominator: 2 },
      otif: { numerator: 1, denominator: 2 },
      dispatchOnTime: { numerator: 2, denominator: 2 },
    });
    expect(body.quality).toMatchObject({
      returns: 1,
      returnRate: { numerator: 1, denominator: 2 },
      inspectionsSigned: 1,
      inspectionsFailed: 1,
      openNcrs: 1,
    });
    expect(body.claims).toEqual({
      opened: 1,
      open: 1,
      chargebacks: 0,
      claimRate: { numerator: 1, denominator: 3 },
    });
  });

  it('refuses a window it does not offer', async () => {
    const response = await as(world, world.sellers.alpha.owner, 'GET', '/seller/performance?days=45');
    expect(response.statusCode).toBe(400);
  });

  it('keeps one seller out of another seller figures', async () => {
    const response = await as(world, world.sellers.gamma.owner, 'GET', '/seller/performance');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ orders: { placed: number } }>().orders.placed).toBe(0);
  });
});

describe('admin marketplace reports', () => {
  const window = (): ReturnType<typeof resolveWindow> =>
    resolveWindow(new Date(Date.now() - 30 * DAY).toISOString(), new Date(Date.now() + DAY).toISOString());

  it('reports GMV per currency, with the seller share', async () => {
    const report = await gmvReport(window());
    const inr = report.byCurrency.find((row) => row.currency === 'INR');
    const sellers = report.sellerGmv.find((row) => row.currency === 'INR');
    expect(inr).toBeDefined();
    expect(BigInt(inr?.gmv.minor ?? '0')).toBeGreaterThanOrEqual(20_000n);
    expect(sellers?.sellerOrders).toBeGreaterThanOrEqual(2);
    expect(BigInt(sellers?.commission.minor ?? '0')).toBeGreaterThanOrEqual(2_000n);
  });

  it('ranks supplier quality with returns, claims and failed inspections per seller', async () => {
    const rows = await supplierQualityReport(window(), 200);
    const alpha = rows.find((row) => row.sellerAccountId === world.sellers.alpha.id);
    expect(alpha).toEqual({
      sellerAccountId: world.sellers.alpha.id,
      displayName: world.sellers.alpha.displayName,
      orders: 3,
      cancelled: 1,
      returns: 1,
      claims: 1,
      inspections: 1,
      inspectionFails: 1,
    });
  });

  it('summarises inspection and disputes', async () => {
    const inspection = await inspectionSummary(window());
    expect(inspection.failed).toBeGreaterThanOrEqual(1);
    expect(inspection.signed).toBeGreaterThanOrEqual(inspection.failed);
    expect(inspection.openNcrsBySeverity.find((row) => row.severity === 'MAJOR')?.count).toBeGreaterThanOrEqual(1);

    const disputes = await disputeReport(window());
    const awaiting = disputes.byStatus.find((row) => row.kind === 'CLAIM' && row.status === 'AWAITING_SELLER');
    expect(awaiting?.count).toBeGreaterThanOrEqual(1);
  });

  it('reports settlements by status and currency, and counts holds', async () => {
    const report = await settlementReport(window());
    const held = report.settlements.find((row) => row.status === 'ON_HOLD' && row.currency === 'INR');
    expect(held?.count).toBeGreaterThanOrEqual(1);
    expect(BigInt(held?.netPayable.minor ?? '0')).toBeGreaterThanOrEqual(18_000n);
    expect(report.settlementsOnHold).toBeGreaterThanOrEqual(1);
  });
});
