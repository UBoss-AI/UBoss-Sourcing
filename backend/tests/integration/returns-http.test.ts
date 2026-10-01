/**
 * Returns over HTTP, with real signed-in sessions for every party.
 *
 * A return passes through four sets of hands - the buyer who asks, the seller
 * whose goods come back, the staff who approve and the finance team who pay -
 * and each may do only their part. This file drives the routes they use and
 * holds down the happy path (ask, answer, approve, receive, inspect, close),
 * who may see and act, and the moves the state machine refuses, with the error
 * code each one returns.
 *
 * The return is closed with a replacement rather than a refund so that no
 * payment provider is involved; the refund route is checked only for being
 * refused before the goods have been inspected.
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

const TAG = 'ret6';
let app: Awaited<ReturnType<typeof buildApp>>;
let desk: OrderDesk;
let returnId = '';

interface ReturnBody {
  return: { id: string; status: string };
}

const request = (overrides: Record<string, unknown> = {}) => ({
  reasonCode: 'NO_LONGER_NEEDED',
  description: 'Changed my mind.',
  items: [{ orderItemId: desk.itemId, quantity: 1 }],
  ...overrides,
});

const statusOf = async (id: string): Promise<string> =>
  (await prisma.returnRequest.findUniqueOrThrow({ where: { id }, select: { status: true } }))
    .status;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  desk = await buildOrderDesk(app, TAG, 88);
}, 180_000);

afterAll(async () => {
  await cleanUpOrderDesk(TAG);
  await app.close();
});

describe('signed-out callers', () => {
  it('are refused on the buyer, seller and staff routes alike', async () => {
    for (const url of ['/api/v1/returns', '/api/v1/seller/returns', '/api/v1/admin/returns']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
    }
  });
});

describe('asking to return something', () => {
  it('tells the buyer what can be returned, and tells nobody else', async () => {
    const mine = await asCustomer(
      app,
      desk.buyer,
      'GET',
      `/orders/${desk.orderId}/returns/eligibility`,
    );
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json<{ eligible: boolean }>().eligible).toBe(true);

    const rival = await asCustomer(
      app,
      desk.rivalBuyer,
      'GET',
      `/orders/${desk.orderId}/returns/eligibility`,
    );
    expect(rival.statusCode).toBe(404);
  });

  it('needs an Idempotency-Key', async () => {
    const response = await asCustomer(app, desk.buyer, 'POST', `/orders/${desk.orderId}/returns`, {
      payload: request(),
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it("does not take a return on somebody else's order", async () => {
    const response = await asCustomer(
      app,
      desk.rivalBuyer,
      'POST',
      `/orders/${desk.orderId}/returns`,
      {
        idempotencyKey: 'ret6-rival',
        payload: request(),
      },
    );
    expect(response.statusCode).toBe(404);
  });

  it('refuses more units than were bought', async () => {
    const response = await asCustomer(app, desk.buyer, 'POST', `/orders/${desk.orderId}/returns`, {
      idempotencyKey: 'ret6-too-many',
      payload: request({ items: [{ orderItemId: desk.itemId, quantity: 3 }] }),
    });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('RETURN_QUANTITY_EXCEEDED');
  });

  it('records the request, and gives the same answer to the same key', async () => {
    const created = await asCustomer(app, desk.buyer, 'POST', `/orders/${desk.orderId}/returns`, {
      idempotencyKey: 'ret6-first',
      payload: request(),
    });
    expect(created.statusCode, created.body).toBeLessThan(300);
    const body = created.json<ReturnBody>();
    expect(body.return.status).toBe('REQUESTED');
    returnId = body.return.id;

    const again = await asCustomer(app, desk.buyer, 'POST', `/orders/${desk.orderId}/returns`, {
      idempotencyKey: 'ret6-first',
      payload: request(),
    });
    expect(again.json<ReturnBody>().return.id).toBe(returnId);
    expect(await prisma.returnRequest.count({ where: { orderId: desk.orderId } })).toBe(1);
  });
});

describe('who can see it', () => {
  it('shows the buyer, the seller whose goods they are and staff - and no one else', async () => {
    expect((await asCustomer(app, desk.buyer, 'GET', `/returns/${returnId}`)).statusCode).toBe(200);
    expect(
      (await asCustomer(app, desk.sellerA, 'GET', `/seller/returns/${returnId}`)).statusCode,
    ).toBe(200);
    expect((await asStaff(app, desk.orderDesk, 'GET', `/returns/${returnId}`)).statusCode).toBe(
      200,
    );

    expect((await asCustomer(app, desk.rivalBuyer, 'GET', `/returns/${returnId}`)).statusCode).toBe(
      404,
    );
    expect(
      (await asCustomer(app, desk.sellerB, 'GET', `/seller/returns/${returnId}`)).statusCode,
    ).toBe(404);
    expect((await asStaff(app, desk.catalog, 'GET', `/returns/${returnId}`)).statusCode).toBe(403);
  });

  it('keeps the other buyer’s list free of it', async () => {
    const list = await asCustomer(app, desk.rivalBuyer, 'GET', '/returns');
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(returnId);
  });
});

describe('moves the state machine refuses', () => {
  it('does not receive, inspect, replace or refund a return nobody has approved', async () => {
    for (const [url, payload] of [
      [`/returns/${returnId}/receive`, {}],
      [
        `/returns/${returnId}/inspect`,
        { outcome: [{ orderItemId: desk.itemId, sellableQty: 1, damagedQty: 0 }] },
      ],
      [`/returns/${returnId}/replacement`, { note: 'Sent a new one.' }],
    ] as const) {
      const response = await asStaff(app, desk.orderDesk, 'POST', url, { payload });
      expect(response.statusCode, url).toBe(409);
      expect(errorCode(response), url).toBe('RETURN_TRANSITION_NOT_ALLOWED');
    }

    const refund = await asStaff(app, desk.financeOne, 'POST', `/returns/${returnId}/refund`, {
      idempotencyKey: 'ret6-refund-early',
      payload: {},
    });
    expect(refund.statusCode).toBe(409);
    expect(errorCode(refund)).toBe('RETURN_TRANSITION_NOT_ALLOWED');
    expect(await statusOf(returnId)).toBe('REQUESTED');
  });

  it('needs a reason to reject', async () => {
    const response = await asStaff(app, desk.orderDesk, 'POST', `/returns/${returnId}/reject`, {
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('who may act', () => {
  it('refuses staff without return permission, and customers on staff routes', async () => {
    expect(
      (await asStaff(app, desk.catalog, 'POST', `/returns/${returnId}/approve`, { payload: {} }))
        .statusCode,
    ).toBe(403);

    const asBuyer = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/returns/${returnId}/approve`,
      headers: {
        cookie: desk.buyer.cookie,
        'x-csrf-token': desk.buyer.csrf,
        'x-forwarded-for': desk.buyer.ip,
      },
      payload: {},
    });
    expect([401, 403]).toContain(asBuyer.statusCode);
    expect(await statusOf(returnId)).toBe('REQUESTED');
  });

  it('lets only the seller whose goods they are answer, and makes them say why when they contest', async () => {
    const other = await asCustomer(
      app,
      desk.sellerB,
      'POST',
      `/seller/returns/${returnId}/response`,
      {
        payload: { response: 'ACCEPT' },
      },
    );
    expect(other.statusCode).toBe(404);

    const bare = await asCustomer(
      app,
      desk.sellerA,
      'POST',
      `/seller/returns/${returnId}/response`,
      {
        payload: { response: 'CONTEST' },
      },
    );
    expect(bare.statusCode).toBe(400);

    const accepted = await asCustomer(
      app,
      desk.sellerA,
      'POST',
      `/seller/returns/${returnId}/response`,
      {
        payload: { response: 'ACCEPT', note: 'Happy to take it back.' },
      },
    );
    expect(accepted.statusCode, accepted.body).toBe(200);
  });
});

describe('the whole journey', () => {
  it('approves, receives, inspects and closes a return with a replacement', async () => {
    const approved = await asStaff(app, desk.orderDesk, 'POST', `/returns/${returnId}/approve`, {
      payload: { instructions: 'Send it to the seller’s warehouse.' },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(await statusOf(returnId)).toBe('APPROVED');

    // A decision is made once.
    const twice = await asStaff(app, desk.orderDesk, 'POST', `/returns/${returnId}/approve`, {
      payload: {},
    });
    expect(twice.statusCode).toBe(409);
    expect(errorCode(twice)).toBe('RETURN_TRANSITION_NOT_ALLOWED');

    const received = await asCustomer(
      app,
      desk.sellerA,
      'POST',
      `/seller/returns/${returnId}/receive`,
      { payload: {} },
    );
    expect(received.statusCode, received.body).toBe(200);
    expect(await statusOf(returnId)).toBe('RECEIVED');

    // The split cannot add up to more than came back.
    const tooMany = await asCustomer(
      app,
      desk.sellerA,
      'POST',
      `/seller/returns/${returnId}/inspect`,
      {
        payload: { outcome: [{ orderItemId: desk.itemId, sellableQty: 1, damagedQty: 1 }] },
      },
    );
    expect(tooMany.statusCode).toBe(400);

    const inspected = await asCustomer(
      app,
      desk.sellerA,
      'POST',
      `/seller/returns/${returnId}/inspect`,
      {
        payload: { outcome: [{ orderItemId: desk.itemId, sellableQty: 1, damagedQty: 0 }] },
      },
    );
    expect(inspected.statusCode, inspected.body).toBe(200);
    expect(await statusOf(returnId)).toBe('INSPECTED');

    const closed = await asStaff(app, desk.orderDesk, 'POST', `/returns/${returnId}/replacement`, {
      payload: { note: 'A new unit went out on the next van.' },
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(await statusOf(returnId)).toBe('COMPLETED');
  });

  it('cannot be rejected once it is finished', async () => {
    const response = await asStaff(app, desk.orderDesk, 'POST', `/returns/${returnId}/reject`, {
      payload: { reason: 'Too late to say no now.' },
    });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('RETURN_TRANSITION_NOT_ALLOWED');
  });

  it('rejects a request with a reason, once', async () => {
    const created = await asCustomer(app, desk.buyer, 'POST', `/orders/${desk.orderId}/returns`, {
      idempotencyKey: 'ret6-second',
      payload: request({ items: [{ orderItemId: desk.secondItemId, quantity: 1 }] }),
    });
    expect(created.statusCode, created.body).toBeLessThan(300);
    const id = created.json<ReturnBody>().return.id;

    const rejected = await asStaff(app, desk.orderDesk, 'POST', `/returns/${id}/reject`, {
      payload: { reason: 'Outside what the seller accepts back.' },
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(await statusOf(id)).toBe('REJECTED');

    const again = await asStaff(app, desk.orderDesk, 'POST', `/returns/${id}/reject`, {
      payload: { reason: 'Rejecting it a second time.' },
    });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('RETURN_TRANSITION_NOT_ALLOWED');
  });
});
