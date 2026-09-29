/**
 * Buyer-facing shipment tracking: the carrier timeline, the ETA and the proof
 * of delivery on the buyer's own order page, and the seller's copy of the
 * same facts.
 *
 * The claims, in the order a reviewer would ask them:
 *
 *   1. **Only the owner.** Another buyer asking for the tracking - or for a
 *      proof-of-delivery link - on somebody else's order is told "not found".
 *   2. **Nothing masked or internal ever appears.** The carrier's internal
 *      notes, an exception's own words, the driver's POD note, who captured it,
 *      coordinates, a place name a driver typed, SLA-risk exceptions, and the
 *      pre-collection negotiation with carriers: all absent from the body, not
 *      merely unrendered.
 *   3. **The ETA says what it is**: an estimate, a revised estimate, the
 *      service promise, or plainly none.
 *   4. **The POD image link** works once, for the person who asked, only
 *      until it expires, and not for a file the installation will not serve.
 *   5. **Buyer and seller are told** about trouble on the road, and the
 *      seller's alert closes when the parcel moves again.
 *
 * Over HTTP with real customer sessions, because ownership here is a `where`
 * clause on a route and a service-level test cannot see a route.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { env } from '../../src/config/env.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { storage } from '../../src/infra/storage/index.js';
import { etaOf, readSellerDeliverySummary } from '../../src/modules/logistics/buyer-tracking.service.js';
import { recordShipmentEvent } from '../../src/modules/logistics/shipment-event.service.js';
import { readSellerTracking } from '../../src/modules/seller/consignment-logistics.service.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const DOMAIN = '@buyer-tracking.test';
const PASSWORD = 'BuyerTracking!2026x';
const ORDER_PREFIX = 'UB-BTRACK-';
const SELLER_SLUG = 'BTRACK-SELLER';
const ADDRESS = { line1: '4 Quay Street', city: 'Antwerp', postalCode: '2000', countryCode: 'BE' };

/** Strings planted in every carrier-internal column. None may reach a buyer. */
const SECRETS = [
  'SECRET-INTERNAL-NOTE',
  'SECRET-EXCEPTION-REASON',
  'SECRET-EXCEPTION-DETAIL',
  'SECRET-DRIVER-POD-NOTE',
  'Typed On Drivers Phone',
  'SECRET-POD-PLACE',
];

// A real 1x1 PNG, so the download can be compared byte for byte.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);

interface Session {
  cookie: string;
  csrf: string;
}

const ids = {
  alice: { userId: '', profileId: '' },
  bob: { userId: '', profileId: '' },
  sellerId: '',
  aliceOrder: '',
  bobOrder: '',
  delivered: '',
  held: '',
  moving: '',
  signatureDoc: '',
  photoDoc: '',
};
const storageKeys: string[] = [];

let alice: Session;
let bob: Session;

async function createCustomer(local: string): Promise<{ userId: string; profileId: string }> {
  const userId = newId();
  const profileId = newId();
  const email = `${local}${DOMAIN}`;
  await prisma.user.create({
    data: {
      id: userId,
      type: 'CUSTOMER',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.customerProfile.create({ data: { id: profileId, userId, fullName: `${local} Buyer` } });
  return { userId, profileId };
}

async function signIn(local: string): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: `${local}${DOMAIN}`, password: PASSWORD },
  });
  expect(response.statusCode, response.body).toBe(200);
  const jar = new Map<string, string>();
  for (const cookie of response.cookies as { name: string; value: string }[]) jar.set(cookie.name, cookie.value);
  return {
    cookie: [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
    csrf: jar.get('uboss_shop_csrf') ?? '',
  };
}

function call(session: Session, method: 'GET' | 'POST', url: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
    ...(method === 'POST' ? { payload: {} } : {}),
  });
}

function code(response: LightMyRequestResponse): string | undefined {
  return response.json<{ error?: { code: string } }>().error?.code;
}

async function placeOrder(profileId: string, suffix: string): Promise<string> {
  const id = newId();
  await prisma.order.create({
    data: {
      id,
      orderNumber: `${ORDER_PREFIX}${suffix}`,
      customerProfileId: profileId,
      buyerCompanyId: null,
      status: 'SHIPPED',
      currency: 'EUR',
      subtotalMinor: 10_000n,
      grandTotalMinor: 10_000n,
      billingAddressJson: ADDRESS,
      shippingAddressJson: ADDRESS,
      placedAt: new Date(),
    },
  });
  return id;
}

async function consignment(
  orderId: string,
  suffix: string,
  data: {
    status: 'DELIVERED' | 'CUSTOMS_HOLD' | 'IN_TRANSIT';
    estimatedDeliveryAt?: Date | null;
    deliveryDueAt?: Date | null;
    deliveredAt?: Date | null;
    sellerAccountId?: string | null;
  },
): Promise<string> {
  const id = newId();
  await prisma.logisticsShipment.create({
    data: {
      id,
      shipmentReference: `LS-BTRACK-${suffix}-${id.slice(-6)}`,
      trackingNumber: `BTRACK-${suffix}-${id}`,
      orderId,
      sellerAccountId: data.sellerAccountId ?? null,
      sellerCompanyName: 'Tracking Test Supplies',
      receivingCompanyName: 'Tracking Test Clinic',
      pickupAddressJson: ADDRESS,
      deliveryAddressJson: ADDRESS,
      originCountry: 'BE',
      destinationCountry: 'BE',
      // A contact the buyer must never be shown back through tracking.
      deliveryContactName: 'Receiving Clerk',
      deliveryContactPhone: '+32 470 12 34 56',
      status: data.status,
      estimatedDeliveryAt: data.estimatedDeliveryAt ?? null,
      deliveryDueAt: data.deliveryDueAt ?? null,
      deliveredAt: data.deliveredAt ?? null,
    },
  });
  return id;
}

async function event(
  shipmentId: string,
  status: 'ASSIGNED' | 'PICKED_UP' | 'IN_TRANSIT' | 'CUSTOMS_HOLD' | 'OUT_FOR_DELIVERY' | 'DELIVERED',
  at: Date,
  extra: {
    publicDescription?: string | null;
    source?: 'CARRIER_API' | 'DRIVER_APP' | 'LOGISTICS_PORTAL';
    locationLabel?: string | null;
  } = {},
): Promise<void> {
  const id = newId();
  await prisma.logisticsShipmentEvent.create({
    data: {
      id,
      shipmentId,
      status,
      publicDescription: extra.publicDescription ?? null,
      internalNote: 'SECRET-INTERNAL-NOTE about the receptionist',
      occurredAt: at,
      locationLabel: extra.locationLabel ?? null,
      locationLatitude: 51.2194,
      locationLongitude: 4.4025,
      source: extra.source ?? 'LOGISTICS_PORTAL',
      actorUserId: newId(),
      externalEventKey: `btrack:${id}`,
      idempotencyKey: id,
    },
  });
}

async function document(shipmentId: string, kind: 'DELIVERY_SIGNATURE' | 'DELIVERY_PHOTO'): Promise<string> {
  const stored = await storage.put(PNG, 'image/png', 'png', 'private');
  storageKeys.push(stored.storageKey);
  const id = newId();
  await prisma.logisticsShipmentDocument.create({
    data: {
      id,
      shipmentId,
      kind,
      audience: 'BOTH',
      fileName: kind === 'DELIVERY_SIGNATURE' ? 'signature.png' : 'photo.png',
      contentType: 'image/png',
      sizeBytes: PNG.length,
      storageKey: stored.storageKey,
      scanState: 'CLEAN',
      uploadedBySource: 'DRIVER_APP',
    },
  });
  return id;
}

async function cleanUp(): Promise<void> {
  const orderIds = (
    await prisma.order.findMany({ where: { orderNumber: { startsWith: ORDER_PREFIX } }, select: { id: true } })
  ).map((row) => row.id);
  const shipmentIds = (
    await prisma.logisticsShipment.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } })
  ).map((row) => row.id);
  const userIds = (
    await prisma.user.findMany({ where: { emailNormalized: { endsWith: DOMAIN } }, select: { id: true } })
  ).map((row) => row.id);
  const sellerIds = (
    await prisma.sellerAccount.findMany({ where: { slug: SELLER_SLUG }, select: { id: true } })
  ).map((row) => row.id);

  await prisma.notificationOutbox.deleteMany({
    where: { OR: [{ relatedType: 'logistics_shipment', relatedId: { in: shipmentIds } }, { recipientEmail: { endsWith: DOMAIN } }] },
  });
  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  await prisma.logisticsProofOfDelivery.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentDocument.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentException.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentEvent.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipment.deleteMany({ where: { id: { in: shipmentIds } } });
  await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellerIds } } });
  await prisma.authToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { endsWith: DOMAIN } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  for (const key of storageKeys.splice(0)) {
    await storage.delete(key).catch(() => undefined);
  }
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();

  ids.alice = await createCustomer('alice');
  ids.bob = await createCustomer('bob');

  ids.sellerId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: ids.sellerId,
      slug: SELLER_SLUG,
      legalName: 'Tracking Test Supplies NV',
      displayName: 'Tracking Test Supplies',
      displayNameNormalized: 'trackingtestsupplies',
      registrationCountry: 'BE',
      kind: 'WHOLESALER',
      status: 'APPROVED',
    },
  });

  ids.aliceOrder = await placeOrder(ids.alice.profileId, 'ALICE');
  ids.bobOrder = await placeOrder(ids.bob.profileId, 'BOB');

  const day = (n: number): Date => new Date(Date.UTC(2026, 8, n, 9, 0, 0));

  // 1. Delivered, with a full proof of delivery.
  ids.delivered = await consignment(ids.aliceOrder, 'DLV', {
    status: 'DELIVERED',
    deliveredAt: day(12),
    sellerAccountId: ids.sellerId,
  });
  await event(ids.delivered, 'ASSIGNED', day(9)); // pre-collection, no buyer text: hidden
  await event(ids.delivered, 'PICKED_UP', day(10), { publicDescription: 'Your order has been collected by the carrier.' });
  await event(ids.delivered, 'IN_TRANSIT', day(11), { source: 'CARRIER_API', locationLabel: 'Leipzig hub' });
  await event(ids.delivered, 'OUT_FOR_DELIVERY', day(12), { source: 'DRIVER_APP', locationLabel: 'Typed On Drivers Phone' });
  await event(ids.delivered, 'DELIVERED', day(12), { publicDescription: 'Your order has been delivered.' });
  ids.signatureDoc = await document(ids.delivered, 'DELIVERY_SIGNATURE');
  ids.photoDoc = await document(ids.delivered, 'DELIVERY_PHOTO');
  await prisma.logisticsProofOfDelivery.create({
    data: {
      id: newId(),
      shipmentId: ids.delivered,
      recipientName: 'Maria Kowalska',
      recipientDesignation: 'Store manager',
      deliveredAt: day(12),
      deliveryLatitude: 51.2194,
      deliveryLongitude: 4.4025,
      deliveryLocationLabel: 'SECRET-POD-PLACE',
      hasSignature: true,
      hasPhoto: true,
      otpVerified: true,
      signatureDocumentId: ids.signatureDoc,
      photoDocumentId: ids.photoDoc,
      exceptionNote: 'SECRET-DRIVER-POD-NOTE left with security',
      capturedByPartnerUserId: newId(),
      capturedBySource: 'DRIVER_APP',
    },
  });

  // 2. Held at customs, with a revised estimate and two exceptions.
  const revised = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  ids.held = await consignment(ids.aliceOrder, 'HLD', { status: 'CUSTOMS_HOLD', estimatedDeliveryAt: revised });
  await event(ids.held, 'PICKED_UP', day(10));
  await event(ids.held, 'CUSTOMS_HOLD', day(11), { source: 'CARRIER_API' });
  await prisma.logisticsShipmentException.create({
    data: {
      id: newId(),
      shipmentId: ids.held,
      type: 'CUSTOMS_DELAY',
      severity: 'HIGH',
      state: 'OPEN',
      reason: 'SECRET-EXCEPTION-REASON: broker has not filed',
      detail: 'SECRET-EXCEPTION-DETAIL',
      revisedEtaAt: revised,
    },
  });
  await prisma.logisticsShipmentException.create({
    data: {
      id: newId(),
      shipmentId: ids.held,
      type: 'SLA_BREACH',
      severity: 'MEDIUM',
      state: 'OPEN',
      reason: 'SECRET-EXCEPTION-REASON: contract clock',
    },
  });

  // 3. Moving, with only the service promise to go on.
  ids.moving = await consignment(ids.aliceOrder, 'MOV', {
    status: 'IN_TRANSIT',
    deliveryDueAt: new Date(Date.now() - 60 * 60 * 1000),
    sellerAccountId: ids.sellerId,
  });
  await event(ids.moving, 'IN_TRANSIT', day(11));

  // Bob's own order, so "not found" is proven against an order that exists.
  await consignment(ids.bobOrder, 'BOB', { status: 'IN_TRANSIT' });

  alice = await signIn('alice');
  bob = await signIn('bob');
});

afterAll(async () => {
  vi.restoreAllMocks();
  await cleanUp();
  await app.close();
});

interface Tracking {
  consignments: {
    id: string;
    status: string;
    events: { status: string; kind: string; trouble: string | null; description: string | null; location: string | null }[];
    openTrouble: { category: string }[];
    eta: { source: string; at: string | null; isLate: boolean };
    proofOfDelivery: null | {
      deliveredAt: string;
      receivedBy: string | null;
      receivedByRole: string | null;
      confirmedWithCode: boolean;
      signature: { captured: boolean; available: boolean };
      photo: { captured: boolean; available: boolean };
    };
    deliveredWithoutProof: boolean;
  }[];
}

const tracking = async (session: Session, orderId: string): Promise<LightMyRequestResponse> =>
  call(session, 'GET', `/api/v1/orders/${orderId}/tracking`);

describe('who may see a consignment', () => {
  it('shows the owner every consignment on their order', async () => {
    const response = await tracking(alice, ids.aliceOrder);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<Tracking>();
    expect(body.consignments.map((row) => row.id).sort()).toEqual([ids.delivered, ids.held, ids.moving].sort());
  });

  it('answers another buyer with not found, and shows them only their own', async () => {
    const response = await tracking(bob, ids.aliceOrder);
    expect(response.statusCode).toBe(404);
    expect(code(response)).toBe('NOT_FOUND');
    expect(response.body).not.toContain(ids.delivered);

    const own = (await tracking(bob, ids.bobOrder)).json<Tracking>();
    expect(own.consignments).toHaveLength(1);
  });

  it('refuses a signed-out request', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/v1/orders/${ids.aliceOrder}/tracking` });
    expect(response.statusCode).toBe(401);
  });

  it('hangs each consignment off a line of the order page', async () => {
    const detail = (await call(alice, 'GET', `/api/v1/orders/${ids.aliceOrder}`)).json<{
      order: { shipments: { consignmentIds: string[] }[] };
    }>();
    expect(detail.order.shipments.flatMap((row) => row.consignmentIds).sort()).toEqual(
      [ids.delivered, ids.held, ids.moving].sort(),
    );
  });
});

describe('what a buyer is shown, and what never reaches them', () => {
  it('never puts an internal note, a carrier’s words, a driver’s note or a masked contact in the body', async () => {
    const body = (await tracking(alice, ids.aliceOrder)).body;
    for (const secret of SECRETS) expect(body).not.toContain(secret);
    // Contacts, coordinates, and whoever recorded or captured anything.
    expect(body).not.toContain('Receiving Clerk');
    expect(body).not.toContain('+32 470');
    expect(body).not.toContain('51.2194');
    expect(body).not.toMatch(/actorUserId|capturedBy|internalNote|latitude|exceptionNote/i);
  });

  it('shows the movement in order, hides the carrier negotiation, and keeps only a carrier’s own place names', async () => {
    const delivered = (await tracking(alice, ids.aliceOrder)).json<Tracking>().consignments.find(
      (row) => row.id === ids.delivered,
    );
    expect(delivered?.events.map((row) => row.status)).toEqual(['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED']);
    expect(delivered?.events[0]?.description).toBe('Your order has been collected by the carrier.');
    expect(delivered?.events[1]?.location).toBe('Leipzig hub');
    expect(delivered?.events[2]?.location).toBeNull();
  });

  it('turns a customs hold into a plain category and ignores the SLA bookkeeping', async () => {
    const held = (await tracking(alice, ids.aliceOrder)).json<Tracking>().consignments.find(
      (row) => row.id === ids.held,
    );
    expect(held?.openTrouble).toEqual([{ category: 'CUSTOMS', since: expect.any(String) as string }]);
    expect(held?.events.at(-1)).toMatchObject({ status: 'CUSTOMS_HOLD', kind: 'TROUBLE', trouble: 'CUSTOMS' });
  });
});

describe('the ETA', () => {
  it('says a revised estimate is revised, a promise is a promise, and a delivered parcel needs none', async () => {
    const rows = (await tracking(alice, ids.aliceOrder)).json<Tracking>().consignments;
    const by = (id: string) => rows.find((row) => row.id === id);
    expect(by(ids.held)?.eta).toMatchObject({ source: 'REVISED', isLate: false });
    expect(by(ids.held)?.eta.at).not.toBeNull();
    expect(by(ids.moving)?.eta).toMatchObject({ source: 'PROMISE', isLate: true });
    expect(by(ids.delivered)?.eta).toEqual({ source: 'FINISHED', at: null, isLate: false });
  });

  it('says plainly when there is no date at all', () => {
    const now = new Date();
    expect(etaOf({ status: 'IN_TRANSIT', estimatedDeliveryAt: null, deliveryDueAt: null, exceptions: [] }, now)).toEqual({
      source: 'NONE',
      at: null,
      isLate: false,
    });
    const estimate = new Date(now.getTime() + 86_400_000);
    expect(
      etaOf({ status: 'OUT_FOR_DELIVERY', estimatedDeliveryAt: estimate, deliveryDueAt: null, exceptions: [] }, now),
    ).toEqual({ source: 'ESTIMATE', at: estimate.toISOString(), isLate: false });
  });
});

describe('proof of delivery', () => {
  it('shows the owner who took it, when, and that a code and both images were captured', async () => {
    const delivered = (await tracking(alice, ids.aliceOrder)).json<Tracking>().consignments.find(
      (row) => row.id === ids.delivered,
    );
    expect(delivered?.proofOfDelivery).toEqual({
      deliveredAt: new Date(Date.UTC(2026, 8, 12, 9, 0, 0)).toISOString(),
      receivedBy: 'Maria Kowalska',
      receivedByRole: 'Store manager',
      confirmedWithCode: true,
      businessStamped: false,
      signature: { captured: true, available: true },
      photo: { captured: true, available: true },
    });
    const moving = (await tracking(alice, ids.aliceOrder)).json<Tracking>().consignments.find(
      (row) => row.id === ids.moving,
    );
    expect(moving?.proofOfDelivery).toBeNull();
  });

  const linkUrl = (kind: string, shipmentId = ids.delivered, orderId = ids.aliceOrder): string =>
    `/api/v1/orders/${orderId}/shipments/${shipmentId}/proof-of-delivery/${kind}/link`;

  it('hands the owner the signature once, as an attachment, and records it', async () => {
    const minted = await call(alice, 'POST', linkUrl('signature'));
    expect(minted.statusCode, minted.body).toBe(200);
    const { url, expiresAt } = minted.json<{ url: string; expiresAt: string }>();
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    const first = await call(alice, 'GET', url);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.rawPayload.equals(PNG)).toBe(true);
    expect(first.headers['content-disposition']).toMatch(/^attachment;/);
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    expect(first.headers['cache-control']).toBe('no-store');

    const second = await call(alice, 'GET', url);
    expect(second.statusCode).toBe(403);
    expect(code(second)).toBe('TOKEN_ALREADY_USED');

    const audit = await prisma.auditLog.count({
      where: { action: 'proof_of_delivery.downloaded', resourceId: ids.signatureDoc, actorUserId: ids.alice.userId },
    });
    expect(audit).toBe(1);
  });

  it('gives another buyer neither a link nor the file behind the owner’s link', async () => {
    const refused = await call(bob, 'POST', linkUrl('photo'));
    expect(refused.statusCode).toBe(404);

    const { url } = (await call(alice, 'POST', linkUrl('photo'))).json<{ url: string }>();
    const stolen = await call(bob, 'GET', url);
    expect(stolen.statusCode).toBe(404);

    // Still unspent: the owner can use it.
    expect((await call(alice, 'GET', url)).statusCode).toBe(200);
  });

  it('refuses a link after it expires, and a token that was never issued', async () => {
    const { url } = (await call(alice, 'POST', linkUrl('photo'))).json<{ url: string }>();
    await prisma.authToken.updateMany({
      where: { userId: ids.alice.userId, consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await call(alice, 'GET', url);
    expect(expired.statusCode).toBe(403);
    expect(code(expired)).toBe('TOKEN_INVALID');

    const forged = await call(alice, 'GET', url.replace(/token=.*/, `token=${'a'.repeat(43)}`));
    expect(forged.statusCode).toBe(403);
    expect(code(forged)).toBe('TOKEN_INVALID');
  });

  it('has nothing to hand over for a consignment with no proof', async () => {
    const response = await call(alice, 'POST', linkUrl('signature', ids.moving));
    expect(response.statusCode).toBe(404);
  });

  it('will not hand over an unscanned file unless the operator allows it', async () => {
    await prisma.logisticsShipmentDocument.update({ where: { id: ids.photoDoc }, data: { scanState: 'SKIPPED' } });
    vi.spyOn(env, 'LOGISTICS_ALLOW_UNSCANNED_DOCUMENTS', 'get').mockReturnValue(false);

    const refused = await call(alice, 'POST', linkUrl('photo'));
    expect(refused.statusCode).toBe(409);
    const view = (await tracking(alice, ids.aliceOrder)).json<Tracking>().consignments.find(
      (row) => row.id === ids.delivered,
    );
    expect(view?.proofOfDelivery?.photo).toEqual({ captured: true, available: false });

    vi.restoreAllMocks();
    await prisma.logisticsShipmentDocument.update({ where: { id: ids.photoDoc }, data: { scanState: 'CLEAN' } });
  });
});

describe('the seller’s copy', () => {
  it('shows the seller the same ETA and proof, with the name masked and no images', async () => {
    const summary = await readSellerDeliverySummary(ids.delivered);
    expect(summary.proofOfDelivery).toMatchObject({
      receivedBy: 'Maria K.',
      confirmedWithCode: true,
      signature: { captured: true, available: false },
      photo: { captured: true, available: false },
    });
    expect(JSON.stringify(summary)).not.toContain('Kowalska');

    const view = await readSellerTracking(ids.sellerId, ids.delivered);
    expect(view.delivery.proofOfDelivery?.receivedBy).toBe('Maria K.');
    expect(view.events.some((row) => row.status === 'DELIVERED')).toBe(true);
    expect(JSON.stringify(view)).not.toContain('SECRET-INTERNAL-NOTE');
  });

  it('refuses a seller a consignment that is not theirs', async () => {
    await expect(readSellerTracking(newId(), ids.delivered)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('telling the buyer and the seller', () => {
  it('emails the buyer and alerts the seller when the parcel is held, and closes the alert when it moves', async () => {
    await recordShipmentEvent({
      shipmentId: ids.moving,
      status: 'CUSTOMS_HOLD',
      actor: 'CARRIER',
      source: 'CARRIER_API',
      reason: 'Held for inspection',
      internalNote: 'SECRET-INTERNAL-NOTE broker',
    });

    const emails = await prisma.notificationOutbox.findMany({
      where: { eventKey: 'shipment.exception', relatedId: ids.moving },
    });
    expect(emails).toHaveLength(1);
    expect(emails[0]?.recipientEmail).toBe(`alice${DOMAIN}`);
    expect(JSON.stringify(emails[0])).toContain('customs or at the port');
    expect(JSON.stringify(emails[0])).not.toContain('SECRET');

    const alert = await prisma.sellerNotification.findFirstOrThrow({
      where: { sellerAccountId: ids.sellerId, subjectId: ids.moving, class: 'ALERT' },
    });
    expect(alert.status).toBe('ACTIVE');
    expect(alert.body).not.toContain('SECRET');

    await recordShipmentEvent({ shipmentId: ids.moving, status: 'IN_TRANSIT', actor: 'CARRIER', source: 'CARRIER_API' });

    const after = await prisma.sellerNotification.findUniqueOrThrow({ where: { id: alert.id } });
    expect(after.status).toBe('RESOLVED');
    // Moving on is not itself news to the buyer: still one trouble email.
    expect(
      await prisma.notificationOutbox.count({ where: { eventKey: 'shipment.exception', relatedId: ids.moving } }),
    ).toBe(1);
  });
});
