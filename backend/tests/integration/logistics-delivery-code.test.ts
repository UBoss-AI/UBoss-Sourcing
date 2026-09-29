/**
 * Delivery codes, and a driver completing their own delivery.
 *
 * Two gaps closed together, because the second is how the first gets used:
 *
 *   1. A delivery policy that asks for a code could never be completed -
 *      nothing ever sent one. Now the buyer is emailed a code when the
 *      consignment goes out for delivery, and can be sent a new one from the
 *      door within limits. This file proves the code reaches the BUYER and
 *      nobody else, and that a wrong, expired, killed, superseded or replayed
 *      code is refused.
 *   2. A driver could not open the shipment page at all, so only owners and
 *      administrators ever recorded deliveries. Now a driver can - for the
 *      stops on their own round, and nothing else: not a colleague's stop, not
 *      another company's, and not anything at all without a driver profile.
 *
 * The driver's half goes through `app.inject` with a real session, because the
 * fix is in which guard a route declares and a service-level test cannot see
 * a guard.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { permissionsForLogisticsRole } from '../../src/domain/logistics-permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { LogisticsMembership } from '../../src/modules/logistics/partner.service.js';
import { acceptAssignment, offerAssignment } from '../../src/modules/logistics/assignment.service.js';
import { asPartner, assignDriver } from '../../src/modules/logistics/driver.service.js';
import {
  DELIVERY_CODE_MAX_ATTEMPTS,
  DELIVERY_CODE_MAX_PER_DAY,
  readDeliveryCodeState,
} from '../../src/modules/logistics/delivery-code.service.js';
import { DELIVERY_CODE_EMAIL_LANGUAGES, renderDeliveryCodeEmail } from '../../src/modules/logistics/delivery-code-email.js';
import { captureProofOfDelivery, requestDeliveryCode } from '../../src/modules/logistics/pod.service.js';
import { recordShipmentEvent } from '../../src/modules/logistics/shipment-event.service.js';
import { createShipment } from '../../src/modules/logistics/shipment-create.service.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const NORTH_CODE = 'LP-TEST-DCODE-N';
const SOUTH_CODE = 'LP-TEST-DCODE-S';
const DOMAIN = '@dcode-test.local';
const BUYER_EMAIL = `buyer${DOMAIN}`;
const PASSWORD = 'DeliveryCode!2026';
const RECEIVER = 'Delivery Code Test Clinic';
const ADDRESS = { line1: '9 Quay Street', city: 'Antwerp', postalCode: '2000', countryCode: 'BE' };

interface Carrier {
  id: string;
  owner: LogisticsMembership;
}

interface PortalSession {
  cookies: string;
  csrfToken: string;
}

let north: Carrier;
let south: Carrier;
let buyerProfileId = '';

/** North's two drivers, and South's one: profile ids and signed-in sessions. */
let anjaProfile = '';
let bramProfile = '';
let dirkProfile = '';
let anja: PortalSession;
let bram: PortalSession;
let dirk: PortalSession;
/** A DRIVER-role member of North with no driver profile. */
let noProfile: PortalSession;

let ipCounter = 10;
const nextIp = (): string => `10.77.0.${String((ipCounter += 1))}`;

async function cleanUp(): Promise<void> {
  const partnerIds = (
    await prisma.logisticsPartner.findMany({
      where: { partnerCode: { in: [NORTH_CODE, SOUTH_CODE] } },
      select: { id: true },
    })
  ).map((row) => row.id);

  const shipmentIds = (
    await prisma.logisticsShipment.findMany({
      where: { receivingCompanyName: RECEIVER, orderId: null },
      select: { id: true },
    })
  ).map((row) => row.id);

  await prisma.notificationOutbox.deleteMany({
    where: { relatedType: 'logistics_shipment', relatedId: { in: shipmentIds } },
  });
  await prisma.logisticsDeliveryCode.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsProofOfDelivery.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentDocument.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsDriverAssignment.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentEvent.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentPackage.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentAssignment.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentException.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsNotification.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsShipment.deleteMany({ where: { id: { in: shipmentIds } } });
  await prisma.logisticsAuditLog.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsSlaPolicy.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsDriverProfile.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsPartnerUser.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsPartner.deleteMany({ where: { id: { in: partnerIds } } });
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: BUYER_EMAIL } } });
  await prisma.session.deleteMany({ where: { user: { emailNormalized: { endsWith: DOMAIN } } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { endsWith: DOMAIN } } });
}

async function makeCarrier(partnerCode: string, name: string): Promise<Carrier> {
  const id = newId();
  const userId = newId();
  const partnerUserId = newId();
  const email = `${partnerCode.toLowerCase()}${DOMAIN}`;

  await prisma.logisticsPartner.create({
    data: {
      id,
      partnerCode,
      legalName: `${name} NV`,
      displayName: name,
      displayNameNormalized: name.toLowerCase().replace(/[^a-z0-9]/g, ''),
      registrationCountry: 'BE',
      contactEmail: email,
      status: 'ACTIVE',
      contractStatus: 'ACTIVE',
    },
  });
  await prisma.user.create({ data: { id: userId, type: 'LOGISTICS', email, emailNormalized: email, status: 'ACTIVE' } });
  await prisma.logisticsPartnerUser.create({
    data: { id: partnerUserId, logisticsPartnerId: id, userId, role: 'LOGISTICS_PARTNER_OWNER', status: 'ACTIVE', fullName: `${name} Owner` },
  });

  return {
    id,
    owner: {
      logisticsPartnerId: id,
      partnerCode,
      displayName: name,
      legalName: `${name} NV`,
      partnerStatus: 'ACTIVE',
      registrationCountry: 'BE',
      partnerUserId,
      userId,
      fullName: `${name} Owner`,
      role: 'LOGISTICS_PARTNER_OWNER',
      permissions: permissionsForLogisticsRole('LOGISTICS_PARTNER_OWNER'),
      canAcceptNewWork: true,
      requiresMfa: true,
      regionScope: null,
      driverProfileId: null,
    },
  };
}

/** A DRIVER-role member who can sign in, with or without a driver profile. */
async function makeDriverLogin(carrier: Carrier, name: string, withProfile: boolean): Promise<string | null> {
  const userId = newId();
  const partnerUserId = newId();
  const email = `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}${DOMAIN}`;

  await prisma.user.create({
    data: {
      id: userId,
      type: 'LOGISTICS',
      email,
      emailNormalized: email,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      passwordHash: await hashPassword(PASSWORD),
    },
  });
  await prisma.logisticsPartnerUser.create({
    data: { id: partnerUserId, logisticsPartnerId: carrier.id, userId, role: 'DRIVER', status: 'ACTIVE', fullName: name },
  });

  if (!withProfile) return null;

  const profileId = newId();
  await prisma.logisticsDriverProfile.create({
    data: { id: profileId, logisticsPartnerId: carrier.id, fullName: name, partnerUserId, state: 'ACTIVE' },
  });
  return profileId;
}

async function signIn(name: string): Promise<PortalSession> {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}${DOMAIN}`;
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/logistics/auth/login',
    headers: { 'x-forwarded-for': nextIp() },
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const jar = login.cookies as { name: string; value: string }[];
  return {
    cookies: jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    csrfToken: jar.find((cookie) => cookie.name === 'uboss_logi_csrf')?.value ?? '',
  };
}

function get(session: PortalSession, url: string) {
  return app.inject({ method: 'GET', url: `/api/v1/logistics${url}`, headers: { cookie: session.cookies } });
}

function post(session: PortalSession, url: string, payload: unknown, idempotencyKey?: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/logistics${url}`,
    headers: {
      cookie: session.cookies,
      'x-csrf-token': session.csrfToken,
      ...(idempotencyKey !== undefined ? { 'idempotency-key': idempotencyKey } : {}),
    },
    payload: payload as Record<string, unknown>,
  });
}

/**
 * A consignment North holds, in transit, under a policy that asks for a code
 * (by default), delivered to the buyer, with a driver on it.
 */
async function consignment(
  options: { otp?: boolean; buyer?: boolean; driverProfileId?: string | null; carrier?: Carrier } = {},
): Promise<string> {
  const carrier = options.carrier ?? north;
  const created = await createShipment({
    sellerCompanyName: 'Northwind Medical',
    receivingCompanyName: RECEIVER,
    receivingCustomerProfileId: options.buyer === false ? null : buyerProfileId,
    pickupAddress: ADDRESS,
    deliveryAddress: { ...ADDRESS, city: 'Ghent', postalCode: '9000' },
    deliveryContactName: 'Jan de Boer',
    deliveryContactPhone: '+32 478 12 34 56',
    packageCount: 1,
    totalWeightGrams: 1500,
  });

  await prisma.logisticsShipment.update({ where: { id: created.id }, data: { status: 'AWAITING_ASSIGNMENT' } });
  await offerAssignment({ shipmentId: created.id, logisticsPartnerId: carrier.id, offeredByUserId: null, automatic: false });
  await acceptAssignment(carrier.owner, created.id);

  const slaPolicyId = newId();
  await prisma.logisticsSlaPolicy.create({
    data: {
      id: slaPolicyId,
      logisticsPartnerId: carrier.id,
      name: `Code policy ${slaPolicyId}`,
      podRequiresRecipientName: true,
      podRequiresOtp: options.otp ?? true,
    },
  });
  await prisma.logisticsShipment.update({ where: { id: created.id }, data: { status: 'IN_TRANSIT', slaPolicyId } });

  const driverProfileId = options.driverProfileId === undefined ? anjaProfile : options.driverProfileId;
  if (driverProfileId !== null) {
    await assignDriver(asPartner(carrier.owner), { shipmentId: created.id, driverProfileId });
  }

  return created.id;
}

/** Put it on the van, through the one path every status change takes. */
async function sendOut(shipmentId: string, carrier: Carrier = north): Promise<void> {
  await recordShipmentEvent({
    shipmentId,
    status: 'OUT_FOR_DELIVERY',
    actor: 'PARTNER',
    source: 'LOGISTICS_PORTAL',
    actorUserId: carrier.owner.userId,
    actorLogisticsPartnerId: carrier.id,
    actorLabel: carrier.owner.fullName,
    permissions: [...carrier.owner.permissions],
  });
}

/** Every delivery-code email the buyer has been sent for this consignment, newest first. */
async function emailsFor(shipmentId: string) {
  return prisma.notificationOutbox.findMany({
    where: { eventKey: 'shipment.delivery_code', relatedId: shipmentId },
    orderBy: { createdAt: 'desc' },
  });
}

/** The code, read out of the buyer's newest email - the only place it exists. */
async function codeFromEmail(shipmentId: string): Promise<string> {
  const [newest] = await emailsFor(shipmentId);
  const match = /\n {4}(\d{6})\n/.exec(newest?.body ?? '');
  if (match?.[1] === undefined) throw new Error('no code in the buyer’s email');
  return match[1];
}

const wrong = (code: string): string => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();

  north = await makeCarrier(NORTH_CODE, 'North Code Courier');
  south = await makeCarrier(SOUTH_CODE, 'South Code Courier');

  const buyerId = newId();
  await prisma.user.create({
    data: {
      id: buyerId,
      type: 'CUSTOMER',
      email: BUYER_EMAIL,
      emailNormalized: BUYER_EMAIL,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      preferredLanguage: 'de',
    },
  });
  buyerProfileId = newId();
  await prisma.customerProfile.create({ data: { id: buyerProfileId, userId: buyerId, fullName: 'Greta Klein' } });

  anjaProfile = (await makeDriverLogin(north, 'Anja Code', true)) ?? '';
  bramProfile = (await makeDriverLogin(north, 'Bram Code', true)) ?? '';
  dirkProfile = (await makeDriverLogin(south, 'Dirk Code', true)) ?? '';
  await makeDriverLogin(north, 'Nobody Code', false);

  anja = await signIn('Anja Code');
  bram = await signIn('Bram Code');
  dirk = await signIn('Dirk Code');
  noProfile = await signIn('Nobody Code');
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

// ---------------------------------------------------------------------------

describe('the code is sent to the buyer when the consignment goes out for delivery', () => {
  it('emails the buyer one code, in their own language, and stores only a keyed hash', async () => {
    const id = await consignment();
    expect(await emailsFor(id)).toHaveLength(0);

    await sendOut(id);

    const emails = await emailsFor(id);
    expect(emails).toHaveLength(1);
    expect(emails[0]?.recipientEmail).toBe(BUYER_EMAIL);
    expect(emails[0]?.subject).toMatch(/^Zustellcode/);

    const code = await codeFromEmail(id);
    const rows = await prisma.logisticsDeliveryCode.findMany({ where: { shipmentId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.origin).toBe('OUT_FOR_DELIVERY');
    expect(rows[0]?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.codeHash).not.toContain(code);

    // The carrier's own trail records that a code went out, never the code.
    const audit = await prisma.logisticsAuditLog.findMany({ where: { resourceId: id, action: 'logistics.pod.code_sent' } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(code);
    expect(JSON.stringify(audit)).not.toContain(BUYER_EMAIL);
  });

  it('sends nothing where the delivery’s policy asks for no code', async () => {
    const id = await consignment({ otp: false });
    await sendOut(id);
    expect(await emailsFor(id)).toHaveLength(0);
    expect(await prisma.logisticsDeliveryCode.count({ where: { shipmentId: id } })).toBe(0);
  });

  it('has an email in all eight languages', () => {
    expect([...DELIVERY_CODE_EMAIL_LANGUAGES].sort()).toEqual(['de', 'el', 'en', 'es', 'fr', 'it', 'nl', 'pl']);
    for (const language of DELIVERY_CODE_EMAIL_LANGUAGES) {
      const message = renderDeliveryCodeEmail(language, {
        name: 'Greta', order: 'ORD-1', shipment: 'SHP-1', carrier: 'North', code: '042917', hours: 12,
      });
      expect(message.subject, language).toContain('042917');
      expect(message.body, language).toContain('\n    042917\n');
      expect(message.body, language).toContain('12');
    }
  });
});

describe('a driver completing a stop on their own round', () => {
  it('opens the shipment page, sees the code is live but never the code, and completes it', async () => {
    const id = await consignment();
    await sendOut(id);
    const code = await codeFromEmail(id);

    const page = await get(anja, `/shipments/${id}`);
    expect(page.statusCode, page.body).toBe(200);
    expect(page.body).not.toContain(code);
    expect(page.body).not.toContain(BUYER_EMAIL);
    const detail = JSON.parse(page.body) as {
      podRequirements: { requiresOtp: boolean };
      deliveryCode: { status: string; canBeSent: boolean; attemptsLeft: number };
      contacts: { delivery: { phone: { isMasked: boolean } } };
    };
    expect(detail.podRequirements.requiresOtp).toBe(true);
    expect(detail.deliveryCode).toMatchObject({ status: 'ACTIVE', canBeSent: true, attemptsLeft: DELIVERY_CODE_MAX_ATTEMPTS });
    // The detail page masks the person at the door for a driver as for anybody.
    expect(detail.contacts.delivery.phone.isMasked).toBe(true);

    expect((await get(anja, `/shipments/${id}/timeline`)).statusCode).toBe(200);

    const refused = await post(anja, `/shipments/${id}/proof-of-delivery`, { recipientName: 'Greta Klein', otp: wrong(code) });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(JSON.parse(refused.body)).toMatchObject({
      error: { code: 'SHIPMENT_OTP_INVALID', details: [{ field: 'otp', code: 'INVALID' }] },
    });
    expect((await prisma.logisticsShipment.findUniqueOrThrow({ where: { id } })).status).toBe('OUT_FOR_DELIVERY');

    const key = newId();
    const done = await post(anja, `/shipments/${id}/proof-of-delivery`, { recipientName: 'Greta Klein', otp: code }, key);
    expect(done.statusCode, done.body).toBe(201);
    expect(JSON.parse(done.body)).toMatchObject({ status: 'DELIVERED', duplicate: false });

    const pod = await prisma.logisticsProofOfDelivery.findUniqueOrThrow({ where: { shipmentId: id } });
    expect(pod.otpVerified).toBe(true);
    expect(pod.capturedBySource).toBe('DRIVER_APP');

    // A phone retrying after a lost response is told it worked.
    const retried = await post(anja, `/shipments/${id}/proof-of-delivery`, { recipientName: 'Greta Klein', otp: code }, key);
    expect(retried.statusCode, retried.body).toBe(200);
    expect(JSON.parse(retried.body)).toMatchObject({ podId: pod.id, duplicate: true });

    // And the page they just completed still opens, read-only.
    const after = await get(anja, `/shipments/${id}`);
    expect(after.statusCode, after.body).toBe(200);
    expect(JSON.parse(after.body)).toMatchObject({ status: 'DELIVERED', isReadOnly: true, deliveryCode: { status: 'USED' } });
  });

  it('can have a new code sent from the door, which cancels the old one', async () => {
    const id = await consignment();
    await sendOut(id);
    const first = await codeFromEmail(id);

    // Let the cool-down pass without waiting for it.
    await prisma.logisticsDeliveryCode.updateMany({ where: { shipmentId: id }, data: { createdAt: new Date(Date.now() - 120_000) } });

    const sent = await post(anja, `/shipments/${id}/delivery-code`, {});
    expect(sent.statusCode, sent.body).toBe(201);
    const second = await codeFromEmail(id);
    expect(sent.body).not.toContain(second);
    expect(sent.body).not.toContain(first);
    expect(JSON.parse(sent.body)).toMatchObject({ deliveryCode: { status: 'ACTIVE', sendsLeftToday: DELIVERY_CODE_MAX_PER_DAY - 2 } });
    expect(await emailsFor(id)).toHaveLength(2);

    // A second press straight away sends nothing.
    const tooSoon = await post(anja, `/shipments/${id}/delivery-code`, {});
    expect(tooSoon.statusCode, tooSoon.body).toBe(429);
    expect(JSON.parse(tooSoon.body)).toMatchObject({ error: { code: 'SHIPMENT_OTP_RESEND_LIMITED', details: [{ code: 'TOO_SOON' }] } });
    expect(await emailsFor(id)).toHaveLength(2);

    if (first !== second) {
      const stale = await post(anja, `/shipments/${id}/proof-of-delivery`, { recipientName: 'Greta Klein', otp: first });
      expect(stale.statusCode).toBe(409);
    }

    const done = await post(anja, `/shipments/${id}/proof-of-delivery`, { recipientName: 'Greta Klein', otp: second });
    expect(done.statusCode, done.body).toBe(201);
  });
});

describe('a code that must not work', () => {
  it('refuses an expired code', async () => {
    const id = await consignment();
    await sendOut(id);
    const code = await codeFromEmail(id);
    await prisma.logisticsDeliveryCode.updateMany({ where: { shipmentId: id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    await expect(
      captureProofOfDelivery(north.owner, { shipmentId: id, recipientName: 'Greta Klein', otp: code }),
    ).rejects.toMatchObject({ code: 'SHIPMENT_OTP_INVALID', details: [{ field: 'otp', code: 'EXPIRED' }] });
    expect((await readDeliveryCodeState(id)).status).toBe('EXPIRED');
    expect((await prisma.logisticsShipment.findUniqueOrThrow({ where: { id } })).status).toBe('OUT_FOR_DELIVERY');
  });

  it('kills a code after five wrong guesses, so even the right one then fails', async () => {
    const id = await consignment();
    await sendOut(id);
    const code = await codeFromEmail(id);

    for (let attempt = 1; attempt <= DELIVERY_CODE_MAX_ATTEMPTS; attempt += 1) {
      await expect(
        captureProofOfDelivery(north.owner, { shipmentId: id, recipientName: 'Greta Klein', otp: wrong(code) }),
      ).rejects.toMatchObject({ code: 'SHIPMENT_OTP_INVALID' });
    }

    await expect(
      captureProofOfDelivery(north.owner, { shipmentId: id, recipientName: 'Greta Klein', otp: code }),
    ).rejects.toMatchObject({ details: [{ field: 'otp', code: 'TOO_MANY_ATTEMPTS' }] });
    expect((await readDeliveryCodeState(id)).status).toBe('LOCKED');
  });

  it('refuses a missing code without counting it as a guess', async () => {
    const id = await consignment();
    await sendOut(id);

    await expect(
      captureProofOfDelivery(north.owner, { shipmentId: id, recipientName: 'Greta Klein' }),
    ).rejects.toMatchObject({ details: [{ field: 'otp', code: 'MISSING' }] });
    expect((await prisma.logisticsDeliveryCode.findFirstOrThrow({ where: { shipmentId: id } })).attempts).toBe(0);
  });

  it('does not let a spent code complete a second delivery, even a later one on the same shipment', async () => {
    const id = await consignment();
    await sendOut(id);
    const code = await codeFromEmail(id);

    await captureProofOfDelivery(north.owner, { shipmentId: id, recipientName: 'Greta Klein', otp: code });
    const row = await prisma.logisticsDeliveryCode.findFirstOrThrow({ where: { shipmentId: id } });
    expect(row.consumedAt).not.toBeNull();

    // The second capture is answered as the same delivery - the code is not asked again.
    const again = await captureProofOfDelivery(north.owner, { shipmentId: id, recipientName: 'Greta Klein', otp: code });
    expect(again.duplicate).toBe(true);
    expect(await prisma.logisticsProofOfDelivery.count({ where: { shipmentId: id } })).toBe(1);
  });

  it('stops sending after five codes in a day', async () => {
    const id = await consignment();
    await sendOut(id);

    for (let sent = 1; sent < DELIVERY_CODE_MAX_PER_DAY; sent += 1) {
      await prisma.logisticsDeliveryCode.updateMany({ where: { shipmentId: id }, data: { createdAt: new Date(Date.now() - 120_000) } });
      await requestDeliveryCode(north.owner, id);
    }

    await prisma.logisticsDeliveryCode.updateMany({ where: { shipmentId: id }, data: { createdAt: new Date(Date.now() - 120_000) } });
    await expect(requestDeliveryCode(north.owner, id)).rejects.toMatchObject({
      code: 'SHIPMENT_OTP_RESEND_LIMITED',
      details: [{ code: 'DAILY_LIMIT_REACHED' }],
    });
    expect(await emailsFor(id)).toHaveLength(DELIVERY_CODE_MAX_PER_DAY);
    expect((await readDeliveryCodeState(id)).nextSendAt).toBeNull();
  });
});

describe('when a code cannot be sent at all', () => {
  it('says so where there is no buyer account to send it to', async () => {
    const id = await consignment({ buyer: false });
    await sendOut(id);
    expect(await emailsFor(id)).toHaveLength(0);

    const page = await get(anja, `/shipments/${id}`);
    expect(JSON.parse(page.body)).toMatchObject({ deliveryCode: { status: 'NOT_SENT', canBeSent: false } });

    await expect(requestDeliveryCode(north.owner, id)).rejects.toMatchObject({
      code: 'SHIPMENT_OTP_UNAVAILABLE',
      details: [{ code: 'NO_RECIPIENT' }],
    });
  });

  it('sends none before the consignment is out for delivery', async () => {
    const id = await consignment();
    await expect(requestDeliveryCode(north.owner, id)).rejects.toMatchObject({
      code: 'SHIPMENT_OTP_UNAVAILABLE',
      details: [{ code: 'NOT_OUT_FOR_DELIVERY' }],
    });
    expect(await emailsFor(id)).toHaveLength(0);
  });
});

describe('what a driver can not reach', () => {
  it('refuses a colleague’s stop', async () => {
    const id = await consignment();
    await sendOut(id);
    const code = await codeFromEmail(id);

    expect((await get(bram, `/shipments/${id}`)).statusCode).toBe(404);
    expect((await get(bram, `/shipments/${id}/timeline`)).statusCode).toBe(404);
    expect((await post(bram, `/shipments/${id}/delivery-code`, {})).statusCode).toBe(404);
    const capture = await post(bram, `/shipments/${id}/proof-of-delivery`, { recipientName: 'Greta Klein', otp: code });
    expect(capture.statusCode).toBe(404);
    expect((await prisma.logisticsShipment.findUniqueOrThrow({ where: { id } })).status).toBe('OUT_FOR_DELIVERY');
    // The refusal did not spend a guess on somebody else's code either.
    expect((await prisma.logisticsDeliveryCode.findFirstOrThrow({ where: { shipmentId: id } })).attempts).toBe(0);
    expect(bramProfile).not.toBe(anjaProfile);
  });

  it('refuses another company’s shipment, to its driver and to its owner', async () => {
    const id = await consignment();
    await sendOut(id);
    const code = await codeFromEmail(id);

    expect((await get(dirk, `/shipments/${id}`)).statusCode).toBe(404);
    expect((await post(dirk, `/shipments/${id}/delivery-code`, {})).statusCode).toBe(404);
    expect((await post(dirk, `/shipments/${id}/proof-of-delivery`, { recipientName: 'X', otp: code })).statusCode).toBe(404);

    await expect(requestDeliveryCode(south.owner, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      captureProofOfDelivery(south.owner, { shipmentId: id, recipientName: 'X', otp: code }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await emailsFor(id)).toHaveLength(1);
    expect(dirkProfile.length).toBe(26);
  });

  it('refuses everything to a driver-role member with no driver profile', async () => {
    const id = await consignment();
    expect((await get(noProfile, `/shipments/${id}`)).statusCode).toBe(404);
    expect((await get(noProfile, `/shipments/${id}/timeline`)).statusCode).toBe(404);
  });

  it('still cannot list the company’s shipments', async () => {
    expect((await get(anja, '/shipments')).statusCode).toBe(403);
  });

  it('loses the stop when it is handed to a colleague', async () => {
    const id = await consignment();
    expect((await get(anja, `/shipments/${id}`)).statusCode).toBe(200);

    await assignDriver(asPartner(north.owner), { shipmentId: id, driverProfileId: bramProfile, reason: 'Anja is off sick today' });

    expect((await get(anja, `/shipments/${id}`)).statusCode).toBe(404);
    expect((await get(bram, `/shipments/${id}`)).statusCode).toBe(200);
  });
});
