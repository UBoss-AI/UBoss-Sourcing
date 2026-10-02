/**
 * Disputes over HTTP, with real signed-in sessions for every party.
 *
 * A claim has three people in it who must each see only their own side: the
 * buyer who raised it, the seller whose goods it is about, and the staff who
 * decide it. This file drives the routes the three of them use and holds down:
 *
 *   - the happy path (raise, answer, decide, appeal, withdraw),
 *   - who may and may not read or act (another buyer, another seller, staff
 *     without the permission),
 *   - the moves the state machine refuses, and the error code each returns,
 *   - and maker-checker (DOD-016): a refund decision above the threshold waits
 *     for a second person, and the person who proposed it can neither approve
 *     nor wave it through.
 *
 * Money is never actually refunded here - the checker sends the proposal back
 * rather than approving it - so no payment provider is involved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  asCustomer,
  asStaff,
  buildOrderDesk,
  cleanUpOrderDesk,
  errorCode,
  type OrderDesk,
} from '../support/order-desk-fixture.js';

const TAG = 'dsp6';
let app: Awaited<ReturnType<typeof buildApp>>;
let desk: OrderDesk;

const DESCRIPTION = 'The box arrived crushed and two of the units inside are broken.';

interface DisputeView {
  reference: string;
  status: string;
}

const claim = (overrides: Record<string, unknown> = {}) => ({
  orderId: desk.orderId,
  orderItemId: desk.itemId,
  reasonCode: 'DAMAGED',
  description: DESCRIPTION,
  desiredOutcome: 'REFUND_PARTIAL',
  requestedAmountMinor: '5000',
  ...overrides,
});

let reference = '';
let disputeId = '';

async function idOf(ref: string): Promise<string> {
  return (
    await prisma.dispute.findFirstOrThrow({ where: { reference: ref }, select: { id: true } })
  ).id;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  desk = await buildOrderDesk(app, TAG, 96);
}, 180_000);

afterAll(async () => {
  await cleanUpOrderDesk(TAG);
  await app.close();
});

describe('signed-out callers', () => {
  it('are refused on the buyer, seller and staff routes alike', async () => {
    for (const url of ['/api/v1/disputes', '/api/v1/seller/disputes', '/api/v1/admin/disputes']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
    }
  });
});

describe('raising a claim', () => {
  it('needs an Idempotency-Key', async () => {
    const response = await asCustomer(app, desk.buyer, 'POST', '/disputes', { payload: claim() });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('refuses an amount above what the line cost', async () => {
    const response = await asCustomer(app, desk.buyer, 'POST', '/disputes', {
      idempotencyKey: 'dsp6-too-much',
      payload: claim({ requestedAmountMinor: '99999999' }),
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('DISPUTE_AMOUNT_INVALID');
  });

  it("does not let another buyer raise a claim on somebody else's order", async () => {
    const response = await asCustomer(app, desk.rivalBuyer, 'POST', '/disputes', {
      idempotencyKey: 'dsp6-rival',
      payload: claim(),
    });
    expect(response.statusCode).toBe(404);
  });

  it('opens the claim with the seller first in line to answer', async () => {
    const response = await asCustomer(app, desk.buyer, 'POST', '/disputes', {
      idempotencyKey: 'dsp6-first',
      payload: claim(),
    });
    expect(response.statusCode, response.body).toBeLessThan(300);
    const { dispute } = response.json<{ dispute: DisputeView }>();
    expect(dispute.status).toBe('AWAITING_SELLER');
    reference = dispute.reference;
    disputeId = await idOf(reference);
  });

  it('gives the same answer when the same key is sent again, and makes no second claim', async () => {
    const again = await asCustomer(app, desk.buyer, 'POST', '/disputes', {
      idempotencyKey: 'dsp6-first',
      payload: claim(),
    });
    expect(again.statusCode).toBeLessThan(300);
    expect(again.json<{ dispute: DisputeView }>().dispute.reference).toBe(reference);
    expect(await prisma.dispute.count({ where: { orderId: desk.orderId } })).toBe(1);
  });

  it('refuses a second open claim on the same line', async () => {
    const response = await asCustomer(app, desk.buyer, 'POST', '/disputes', {
      idempotencyKey: 'dsp6-retry-same-line',
      payload: claim(),
    });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('DISPUTE_ALREADY_OPEN');
  });
});

describe('who can read it', () => {
  it('shows the buyer their own claim and nobody else’s', async () => {
    const mine = await asCustomer(app, desk.buyer, 'GET', `/disputes/${reference}`);
    expect(mine.statusCode).toBe(200);
    const list = await asCustomer(app, desk.buyer, 'GET', '/disputes');
    expect(list.body).toContain(reference);

    const rival = await asCustomer(app, desk.rivalBuyer, 'GET', `/disputes/${reference}`);
    expect(rival.statusCode).toBe(404);
    const rivalList = await asCustomer(app, desk.rivalBuyer, 'GET', '/disputes');
    expect(rivalList.body).not.toContain(reference);
  });

  it('shows the seller whose goods they are, and not a different seller', async () => {
    const sellerA = await asCustomer(app, desk.sellerA, 'GET', `/seller/disputes/${reference}`);
    expect(sellerA.statusCode).toBe(200);
    const sellerB = await asCustomer(app, desk.sellerB, 'GET', `/seller/disputes/${reference}`);
    expect(sellerB.statusCode).toBe(404);
  });

  it('shows staff with dispute permissions, and refuses staff without them', async () => {
    expect((await asStaff(app, desk.orderDesk, 'GET', `/disputes/${disputeId}`)).statusCode).toBe(
      200,
    );
    expect((await asStaff(app, desk.catalog, 'GET', `/disputes/${disputeId}`)).statusCode).toBe(
      403,
    );
    expect((await asStaff(app, desk.catalog, 'GET', '/disputes')).statusCode).toBe(403);
  });

  it('does not let a customer session reach the staff routes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/disputes/${disputeId}`,
      headers: { cookie: desk.buyer.cookie, 'x-forwarded-for': desk.buyer.ip },
    });
    expect([401, 403]).toContain(response.statusCode);
  });
});

describe('the case view (JOURNEY-058)', () => {
  it('gives staff the payment, any chargeback, the seller funds held and the inspection behind the claim', async () => {
    const response = await asStaff(app, desk.orderDesk, 'GET', `/disputes/${disputeId}`);
    expect(response.statusCode, response.body).toBe(200);
    const view = response.json<{
      dispute: {
        openChargeback: unknown;
        fundHolds: { status: string; allocated: { minor: string } }[];
        inspection: { requirementId: string | null; linkPath: string | null; reports: unknown[] }[];
        approval: { thresholdMinor: string };
      };
    }>().dispute;
    expect(view.openChargeback).toBeNull();
    expect(Array.isArray(view.fundHolds)).toBe(true);
    for (const hold of view.fundHolds) expect(typeof hold.allocated.minor).toBe('string');
    expect(Array.isArray(view.inspection)).toBe(true);
    for (const entry of view.inspection) expect(entry.linkPath).toBe(`/inspection/${entry.requirementId ?? ''}`);
    expect(typeof view.approval.thresholdMinor).toBe('string');
  });

  it('shows the parties the inspection without the operator’s requirement id', async () => {
    const seller = await asCustomer(app, desk.sellerA, 'GET', `/seller/disputes/${reference}`);
    const buyer = await asCustomer(app, desk.buyer, 'GET', `/disputes/${reference}`);
    for (const response of [seller, buyer]) {
      expect(response.statusCode, response.body).toBe(200);
      const view = response.json<{ dispute: { inspection: { requirementId: string | null; reports: { status: string }[] }[]; fundHolds?: unknown } }>().dispute;
      expect(Array.isArray(view.inspection)).toBe(true);
      expect(view.fundHolds).toBeUndefined();
      for (const entry of view.inspection) {
        expect(entry.requirementId).toBeNull();
        // Only signed reports ever reach a party.
        for (const report of entry.reports) expect(report.status).toBe('SIGNED');
      }
    }
  });
});

describe('the seller answers', () => {
  it('lets the seller whose goods they are answer, and only them', async () => {
    const body = { body: 'We packed it carefully; please send photos of the box.' };
    const other = await asCustomer(
      app,
      desk.sellerB,
      'POST',
      `/seller/disputes/${reference}/response`,
      { payload: body },
    );
    expect(other.statusCode).toBe(404);

    const own = await asCustomer(
      app,
      desk.sellerA,
      'POST',
      `/seller/disputes/${reference}/response`,
      { payload: body },
    );
    expect(own.statusCode, own.body).toBe(200);
  });
});

describe('a refund needs a second person (maker-checker)', () => {
  it('holds a refund decision for approval instead of applying it', async () => {
    const response = await asStaff(
      app,
      desk.financeOne,
      'POST',
      `/disputes/${disputeId}/decision`,
      {
        payload: {
          resolution: 'REFUND_PARTIAL',
          amountMinor: '5000',
          reason: 'Photos show the damage; refund half.',
        },
      },
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ applied: boolean }>().applied).toBe(false);
    const row = await prisma.dispute.findUniqueOrThrow({ where: { id: disputeId } });
    expect(row.status).toBe('PENDING_APPROVAL');
    expect(row.proposedById).not.toBeNull();
  });

  it('refuses the proposer approving their own decision', async () => {
    const response = await asStaff(
      app,
      desk.financeOne,
      'POST',
      `/disputes/${disputeId}/decision/approve`,
    );
    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe('DISPUTE_SELF_APPROVAL_FORBIDDEN');
    expect((await prisma.dispute.findUniqueOrThrow({ where: { id: disputeId } })).status).toBe(
      'PENDING_APPROVAL',
    );
  });

  it('refuses the proposer sending it back themselves, too', async () => {
    const response = await asStaff(
      app,
      desk.financeOne,
      'POST',
      `/disputes/${disputeId}/decision/refuse`,
      {
        payload: { reason: 'Changed my mind about this.' },
      },
    );
    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe('DISPUTE_SELF_APPROVAL_FORBIDDEN');
  });

  it('refuses staff who cannot approve at all', async () => {
    expect(
      (await asStaff(app, desk.orderDesk, 'POST', `/disputes/${disputeId}/decision/approve`))
        .statusCode,
    ).toBe(403);
    expect(
      (await asStaff(app, desk.catalog, 'POST', `/disputes/${disputeId}/decision/approve`))
        .statusCode,
    ).toBe(403);
  });

  it('lets a different approver send it back, which returns the claim to review', async () => {
    const response = await asStaff(
      app,
      desk.financeTwo,
      'POST',
      `/disputes/${disputeId}/decision/refuse`,
      {
        payload: { reason: 'The amount is too high for what the photos show.' },
      },
    );
    expect(response.statusCode, response.body).toBe(200);
    const row = await prisma.dispute.findUniqueOrThrow({ where: { id: disputeId } });
    expect(row.status).toBe('UNDER_REVIEW');
    expect(row.proposedById).toBeNull();
  });

  it('refuses to approve when nothing is waiting', async () => {
    const response = await asStaff(
      app,
      desk.financeTwo,
      'POST',
      `/disputes/${disputeId}/decision/approve`,
    );
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('DISPUTE_TRANSITION_NOT_ALLOWED');
  });
});

describe('deciding, and what cannot be undone', () => {
  it('applies a rejection straight away, because it moves no money', async () => {
    const response = await asStaff(app, desk.orderDesk, 'POST', `/disputes/${disputeId}/decision`, {
      payload: { resolution: 'REJECT', reason: 'The packaging was intact on delivery.' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ applied: boolean }>().applied).toBe(true);
    expect((await prisma.dispute.findUniqueOrThrow({ where: { id: disputeId } })).status).toBe(
      'REJECTED',
    );
  });

  it('refuses a second decision on a claim that is already decided', async () => {
    const response = await asStaff(app, desk.orderDesk, 'POST', `/disputes/${disputeId}/decision`, {
      payload: { resolution: 'REJECT', reason: 'Deciding it again should not work.' },
    });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('DISPUTE_TRANSITION_NOT_ALLOWED');
  });

  it('refuses a withdrawal after the decision', async () => {
    const response = await asCustomer(app, desk.buyer, 'POST', `/disputes/${reference}/withdraw`);
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('DISPUTE_TRANSITION_NOT_ALLOWED');
  });

  it('lets only the buyer of the claim appeal, and only once', async () => {
    const body = { body: 'The courier photo shows the crushed corner clearly.' };
    const rival = await asCustomer(app, desk.rivalBuyer, 'POST', `/disputes/${reference}/appeal`, {
      payload: body,
    });
    expect(rival.statusCode).toBe(404);

    const appealed = await asCustomer(app, desk.buyer, 'POST', `/disputes/${reference}/appeal`, {
      payload: body,
    });
    expect(appealed.statusCode, appealed.body).toBe(200);
    expect(appealed.json<{ dispute: DisputeView }>().dispute.status).toBe('APPEALED');

    const twice = await asCustomer(app, desk.buyer, 'POST', `/disputes/${reference}/appeal`, {
      payload: body,
    });
    expect(twice.statusCode).toBe(409);
  });
});

describe('withdrawing a claim', () => {
  it('takes it back once, and not again', async () => {
    const created = await asCustomer(app, desk.buyer, 'POST', '/disputes', {
      idempotencyKey: 'dsp6-second-line',
      payload: claim({
        orderItemId: desk.secondItemId,
        desiredOutcome: 'REPLACEMENT',
        requestedAmountMinor: null,
      }),
    });
    expect(created.statusCode, created.body).toBeLessThan(300);
    const other = created.json<{ dispute: DisputeView }>().dispute.reference;

    const withdrawn = await asCustomer(app, desk.buyer, 'POST', `/disputes/${other}/withdraw`);
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(withdrawn.json<{ dispute: DisputeView }>().dispute.status).toBe('WITHDRAWN');

    const again = await asCustomer(app, desk.buyer, 'POST', `/disputes/${other}/withdraw`);
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('DISPUTE_TRANSITION_NOT_ALLOWED');
  });
});
