/**
 * A seller tries to send goods past a mandatory inspection.
 *
 * The unit tests hold the gate's logic down; this proves it is actually wired
 * to the door. A mandatory inspection rule is seeded in the database (no admin
 * route creates one yet), a real seller signs in, and the seller asks the
 * Seller Hub route to mark their order ready for dispatch. It has to be
 * refused, the order has to stay where it was, and it has to be allowed the
 * moment a valid PASS release exists for exactly the goods being sent - or when
 * no rule applies at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { currentScope, ensureRequirement } from '../../src/modules/inspection/gate.service.js';
import {
  asCustomer,
  buildOrderDesk,
  cleanUpOrderDesk,
  errorCode,
  type OrderDesk,
} from '../support/order-desk-fixture.js';

const TAG = 'igt6';
const RULE_NAME = 'igt6 every order';

let app: Awaited<ReturnType<typeof buildApp>>;
let desk: OrderDesk;
let groupId = '';
let ruleId = '';

async function removeInspectionRows(): Promise<void> {
  // Events and releases go with the requirement.
  await prisma.inspectionRequirement.deleteMany({ where: { orderId: desk.orderId } });
}

/** The requirement the gate decided, made in its own transaction: a refused move rolls back its own. */
async function requirementId(): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const requirement = await ensureRequirement(tx, groupId);
    if (requirement === null) throw new Error('no requirement was decided');
    return requirement.id;
  });
}

async function markReady(session = desk.sellerA) {
  return asCustomer(app, session, 'PATCH', `/seller/orders/${groupId}/status`, {
    payload: { status: 'READY_FOR_DISPATCH' },
  });
}

const statusOfGroup = async (): Promise<string> =>
  (
    await prisma.sellerOrderGroup.findUniqueOrThrow({
      where: { id: groupId },
      select: { status: true },
    })
  ).status;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  desk = await buildOrderDesk(app, TAG, 98);
  groupId = (
    await prisma.sellerOrderGroup.findFirstOrThrow({
      where: { orderId: desk.orderId },
      select: { id: true },
    })
  ).id;

  await prisma.inspectionRule.deleteMany({ where: { name: RULE_NAME } });
  ruleId = newId();
  await prisma.inspectionRule.create({
    data: {
      id: ruleId,
      name: RULE_NAME,
      isActive: true,
      priority: 1,
      level: 'MANDATORY',
      effectiveFrom: new Date(Date.now() - 86_400_000),
    },
  });
}, 180_000);

beforeEach(async () => {
  await removeInspectionRows();
  await prisma.inspectionRule.update({ where: { id: ruleId }, data: { isActive: true } });
  // The fixture delivers the order; this test needs one still being prepared.
  await prisma.sellerOrderGroup.update({
    where: { id: groupId },
    data: { status: 'PROCESSING', deliveredAt: null },
  });
});

afterAll(async () => {
  await removeInspectionRows();
  await prisma.inspectionRule.deleteMany({ where: { name: RULE_NAME } });
  await cleanUpOrderDesk(TAG);
  await app.close();
});

describe('a seller ships past a mandatory inspection', () => {
  it('is refused when no inspection has been arranged, and the order does not move', async () => {
    const response = await markReady();

    expect(response.statusCode, response.body).toBe(409);
    expect(errorCode(response)).toBe('INSPECTION_GATE_CLOSED');
    expect(response.json<{ error: { details: { code: string }[] } }>().error.details[0]?.code).toBe(
      'NOT_BOOKED',
    );
    expect(await statusOfGroup()).toBe('PROCESSING');

    // What the rule decides for this order, once somebody asks.
    const requirement = await prisma.inspectionRequirement.findUniqueOrThrow({
      where: { id: await requirementId() },
    });
    expect(requirement).toMatchObject({
      level: 'MANDATORY',
      status: 'AWAITING_BOOKING',
      ruleName: RULE_NAME,
    });
  });

  it('is refused for every attempt, not just the first', async () => {
    expect((await markReady()).statusCode).toBe(409);
    expect((await markReady()).statusCode).toBe(409);
    expect(await statusOfGroup()).toBe('PROCESSING');
  });

  it('is refused while a release is still waiting for its second approver', async () => {
    const scope = await currentScope(prisma, groupId);
    const requirement = { id: await requirementId() };
    await prisma.inspectionRelease.create({
      data: {
        id: newId(),
        requirementId: requirement.id,
        kind: 'CONDITIONAL',
        state: 'PENDING_APPROVAL',
        requestedByParty: 'OPERATOR',
        requestedByLabel: 'Test operator',
        requestedAt: new Date(),
        boundScopeHash: scope.hash,
        boundScopeJson: scope.summary,
      },
    });

    const response = await markReady();
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { details: { code: string }[] } }>().error.details[0]?.code).toBe(
      'RELEASE_PENDING_APPROVAL',
    );
    expect(await statusOfGroup()).toBe('PROCESSING');
  });

  it('is refused when the release describes different goods from those being sent', async () => {
    const requirement = { id: await requirementId() };
    await prisma.inspectionRelease.create({
      data: {
        id: newId(),
        requirementId: requirement.id,
        kind: 'PASS',
        state: 'ACTIVE',
        requestedByParty: 'OPERATOR',
        requestedByLabel: 'Test operator',
        requestedAt: new Date(),
        boundScopeHash: 'f'.repeat(64),
        boundScopeJson: {},
      },
    });

    const response = await markReady();
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { details: { code: string }[] } }>().error.details[0]?.code).toBe(
      'SCOPE_CHANGED',
    );
    expect(await statusOfGroup()).toBe('PROCESSING');
  });

  it('is refused for a different seller’s order too: nobody else can do it for them', async () => {
    const response = await markReady(desk.sellerB);
    expect([403, 404]).toContain(response.statusCode);
    expect(await statusOfGroup()).toBe('PROCESSING');
  });

  it('goes ahead once a valid PASS release exists for exactly these goods', async () => {
    const requirement = { id: await requirementId() };
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

    const response = await markReady();
    expect(response.statusCode, response.body).toBe(204);
    expect(await statusOfGroup()).toBe('READY_FOR_DISPATCH');
  });

  it('goes ahead, with no inspection, when no rule applies to the order', async () => {
    await prisma.inspectionRule.update({ where: { id: ruleId }, data: { isActive: false } });

    const response = await markReady();
    expect(response.statusCode, response.body).toBe(204);
    expect(await statusOfGroup()).toBe('READY_FOR_DISPATCH');
  });
});
