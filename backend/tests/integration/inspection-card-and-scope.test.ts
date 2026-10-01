/**
 * ENH-010 and ENH-012 / JOURNEY-045, end to end.
 *
 *  - The buyer's order list carries each order's inspection card status, and
 *    null while nothing was decided.
 *  - A seller who changes the packages, container or seal of goods that were
 *    already released is not silently allowed to: the change lands on the
 *    inspection timeline, the requirement moves to REEVALUATION_REQUIRED and
 *    the seller is told.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { currentScope, ensureRequirement } from '../../src/modules/inspection/gate.service.js';
import { asCustomer, buildOrderDesk, cleanUpOrderDesk, type OrderDesk } from '../support/order-desk-fixture.js';

const TAG = 'icsc10';
const RULE_NAME = 'icsc10 every order';

let app: Awaited<ReturnType<typeof buildApp>>;
let desk: OrderDesk;
let groupId = '';
let ruleId = '';
let shipmentId = '';

async function removeInspectionRows(): Promise<void> {
  const ids = (await prisma.inspectionRequirement.findMany({ where: { orderId: desk.orderId }, select: { id: true } })).map((row) => row.id);
  await prisma.sellerNotification.deleteMany({ where: { subjectType: 'inspection_requirement', subjectId: { in: ids } } });
  await prisma.inspectionRequirement.deleteMany({ where: { orderId: desk.orderId } });
}

async function listedStatus(): Promise<unknown> {
  const response = await asCustomer(app, desk.buyer, 'GET', '/orders?limit=50');
  expect(response.statusCode, response.body).toBe(200);
  const body: { orders: { id: string; inspectionStatus: unknown }[] } = response.json();
  const orders = body.orders;
  return orders.find((order) => order.id === desk.orderId)?.inspectionStatus;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  desk = await buildOrderDesk(app, TAG, 87);
  const group = await prisma.sellerOrderGroup.findFirstOrThrow({ where: { orderId: desk.orderId }, select: { id: true } });
  groupId = group.id;
  // The fixture delivers the order; inspection is decided only before dispatch.
  await prisma.sellerOrderGroup.update({ where: { id: groupId }, data: { status: 'PROCESSING', deliveredAt: null } });
  const order = await prisma.order.findUniqueOrThrow({ where: { id: desk.orderId }, select: { customerProfileId: true } });

  await prisma.inspectionRule.deleteMany({ where: { name: RULE_NAME } });
  ruleId = newId();
  await prisma.inspectionRule.create({
    data: { id: ruleId, name: RULE_NAME, isActive: true, priority: 1, level: 'MANDATORY', effectiveFrom: new Date(Date.now() - 86_400_000) },
  });

  const { createShipment } = await import('../../src/modules/logistics/shipment-create.service.js');
  const address = { line1: '1 Test Road', city: 'Pune', region: 'Maharashtra', postalCode: '411001', countryCode: 'IN' };
  const created = await createShipment({
    orderId: desk.orderId,
    sellerOrderGroupId: groupId,
    sellerAccountId: desk.sellerAId,
    sellerCompanyName: 'icsc10 seller',
    receivingCustomerProfileId: order.customerProfileId,
    receivingCompanyName: 'icsc10 buyer',
    pickupAddress: address,
    deliveryAddress: address,
    currency: 'INR',
  });
  shipmentId = created.id;
}, 180_000);

afterAll(async () => {
  await removeInspectionRows();
  await prisma.inspectionRule.deleteMany({ where: { name: RULE_NAME } });
  await prisma.logisticsShipment.deleteMany({ where: { orderId: desk.orderId } });
  await cleanUpOrderDesk(TAG);
  await app.close();
});

describe('the buyer order list (ENH-010)', () => {
  it('says null before inspection is decided, then the card status', async () => {
    await removeInspectionRows();
    expect(await listedStatus()).toBeNull();

    await prisma.$transaction(async (tx) => ensureRequirement(tx, groupId));
    expect(await listedStatus()).toBe('REQUIRED');
  });
});

describe('a change to inspected goods (ENH-012, JOURNEY-045)', () => {
  it('records the change, moves the requirement to re-evaluation and tells the seller', async () => {
    await removeInspectionRows();
    const requirement = await prisma.$transaction(async (tx) => ensureRequirement(tx, groupId));
    if (requirement === null) throw new Error('no requirement was decided');

    const scope = await currentScope(prisma, groupId);
    await prisma.inspectionRelease.create({
      data: {
        id: newId(),
        requirementId: requirement.id,
        kind: 'PASS',
        state: 'ACTIVE',
        requestedByParty: 'OPERATOR',
        requestedByLabel: 'Test operator',
        requestedAt: new Date(),
        approvedAt: new Date(),
        boundScopeHash: scope.hash,
        boundScopeJson: scope.summary,
      },
    });

    const { resolveSellerMembership } = await import('../../src/modules/seller/account.service.js');
    const { savePackages } = await import('../../src/modules/documents/consignment.service.js');
    const member = await prisma.sellerMember.findFirstOrThrow({ where: { sellerAccountId: desk.sellerAId }, select: { customerProfileId: true } });
    const seller = await resolveSellerMembership(member.customerProfileId);

    await savePackages(seller, shipmentId, {
      packages: [
        {
          packagingType: 'Carton',
          lengthMm: 400,
          widthMm: 300,
          heightMm: 250,
          grossWeightGrams: 6000,
          netWeightGrams: null,
          containerNumber: 'MSCU1234567',
          sealNumber: 'SEAL-9',
          contents: [
            { orderItemId: desk.itemId, quantity: 2, batchNumber: '', expiryDate: null, serialNumbers: null },
            { orderItemId: desk.secondItemId, quantity: 1, batchNumber: '', expiryDate: null, serialNumbers: null },
          ],
        },
      ],
    });

    const events = await prisma.inspectionEvent.findMany({ where: { requirementId: requirement.id, kind: 'scope_changed' } });
    expect(events).toHaveLength(1);
    const after = await prisma.inspectionRequirement.findUniqueOrThrow({ where: { id: requirement.id }, select: { status: true } });
    expect(after.status).toBe('REEVALUATION_REQUIRED');
    expect(
      await prisma.sellerNotification.count({ where: { subjectType: 'inspection_requirement', subjectId: requirement.id } }),
    ).toBeGreaterThan(0);
  });
});
