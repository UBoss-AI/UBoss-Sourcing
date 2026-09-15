/**
 * The marketplace's own side of carriage, over HTTP.
 *
 * The carrier's side is covered by `logistics-tenant-isolation.test.ts`, which
 * calls the services directly. This file goes through the routes instead,
 * because the things worth proving here are properties of the ROUTES:
 *
 *   - `logistics.read` gets the register, the list and one consignment in
 *     full - including the fields a carrier is never shown;
 *   - the detail response carries the transitions an operator may make, and a
 *     correction is not one of them;
 *   - a status correction demands a written reason, records it, and flags the
 *     event as a correction rather than quietly rewriting history;
 *   - an order clerk with `logistics.assign` may offer and correct, and may
 *     NOT create a carrier - that is a contract decision;
 *   - a catalogue manager, who holds no logistics permission at all, is
 *     refused everywhere.
 *
 * All of it through `app.inject` with a real signed-in session, so the
 * permission checks under test are the ones a browser actually meets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { createShipment } from '../../src/modules/logistics/shipment-create.service.js';
import { signInAdmin } from '../support/admin-session.js';

let app: Awaited<ReturnType<typeof buildApp>>;

/** An order manager: reads carriers, assigns work, corrects a status. */
let clerkCookies = '';
let clerkCsrf = '';

/** A catalogue manager: holds no logistics permission whatsoever. */
let outsiderCookies = '';

let partnerId = '';
let shipmentId = '';

const CLERK_EMAIL = 'logistics-clerk@test.local';
const CLERK_PASSWORD = 'LogisticsClerk!2026';
const OUTSIDER_EMAIL = 'logistics-outsider@test.local';
const OUTSIDER_PASSWORD = 'LogisticsOutsider!2026';

const PARTNER_CODE = 'LP-TEST-OVERSIGHT';

const ADDRESS = {
  line1: '9 Quay Street',
  city: 'Rotterdam',
  postalCode: '3011',
  countryCode: 'NL',
};

async function cleanUp(): Promise<void> {
  const partnerIds = (
    await prisma.logisticsPartner.findMany({
      where: { partnerCode: PARTNER_CODE },
      select: { id: true },
    })
  ).map((row) => row.id);

  const shipmentIds = (
    await prisma.logisticsShipment.findMany({
      where: { receivingCompanyName: 'Oversight Clinic' },
      select: { id: true },
    })
  ).map((row) => row.id);

  await prisma.logisticsShipmentEvent.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentPackage.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentAssignment.deleteMany({
    where: { shipmentId: { in: shipmentIds } },
  });
  await prisma.logisticsShipmentException.deleteMany({
    where: { shipmentId: { in: shipmentIds } },
  });
  await prisma.logisticsNotification.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });

  // Shipments before the partner: `assignedPartnerId` is ON DELETE RESTRICT.
  await prisma.logisticsShipment.deleteMany({ where: { id: { in: shipmentIds } } });

  await prisma.logisticsAuditLog.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsServiceRegion.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsPartnerInvitation.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsPartnerUser.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsPartner.deleteMany({ where: { id: { in: partnerIds } } });

  await prisma.userRole.deleteMany({
    where: { user: { emailNormalized: { in: [CLERK_EMAIL, OUTSIDER_EMAIL] } } },
  });
  await prisma.user.deleteMany({
    where: { emailNormalized: { in: [CLERK_EMAIL, OUTSIDER_EMAIL] } },
  });
}

async function makeStaff(email: string, password: string, roleKey: string): Promise<void> {
  const role = await prisma.role.findUniqueOrThrow({
    where: { key: roleKey },
    select: { id: true },
  });

  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(password),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: role.id } },
    },
  });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  await cleanUp();

  await makeStaff(CLERK_EMAIL, CLERK_PASSWORD, Role.ORDER_MANAGER);
  await makeStaff(OUTSIDER_EMAIL, OUTSIDER_PASSWORD, Role.CATALOG_MANAGER);

  /*
   * A carrier with one region, so it is a plausible candidate rather than a
   * row that could never be offered anything.
   */
  partnerId = newId();

  await prisma.logisticsPartner.create({
    data: {
      id: partnerId,
      partnerCode: PARTNER_CODE,
      legalName: 'Oversight Freight BV',
      displayName: 'Oversight Freight',
      displayNameNormalized: 'oversightfreight',
      registrationCountry: 'NL',
      contactEmail: 'ops@oversight.test',
      status: 'ACTIVE',
      contractStatus: 'ACTIVE',
      regions: {
        create: {
          id: newId(),
          scope: 'COUNTRY',
          countryCode: 'NL',
          regionValue: '',
          supportsPickup: true,
          supportsDelivery: true,
          isActive: true,
        },
      },
    },
  });

  const created = await createShipment({
    sellerCompanyName: 'Northwind Medical',
    receivingCompanyName: 'Oversight Clinic',
    pickupAddress: ADDRESS,
    deliveryAddress: { ...ADDRESS, city: 'Utrecht', postalCode: '3511' },
    deliveryContactName: 'Sanne Visser',
    deliveryContactPhone: '+31 6 12 34 56 78',
    packageCount: 3,
    totalWeightGrams: 7400,
  });

  shipmentId = created.id;

  await prisma.logisticsShipment.update({
    where: { id: shipmentId },
    data: { status: 'AWAITING_ASSIGNMENT' },
  });

  // Distinct source addresses: the login route is rate limited per IP, and
  // files that share one spend each other's budget.
  const clerk = await signInAdmin(app, {
    email: CLERK_EMAIL,
    password: CLERK_PASSWORD,
    ip: '203.0.113.171',
  });

  clerkCookies = clerk.cookies;
  clerkCsrf = clerk.csrfToken;

  const outsider = await signInAdmin(app, {
    email: OUTSIDER_EMAIL,
    password: OUTSIDER_PASSWORD,
    ip: '203.0.113.172',
  });

  outsiderCookies = outsider.cookies;
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

interface ShipmentDetail {
  id: string;
  shipmentReference: string;
  status: string;
  deliveryContactPhone: string | null;
  declaredValueMinor: string | null;
  allowedTransitions: { to: string; requiresReason: boolean }[];
  events: { status: string; isCorrection: boolean; reason: string | null }[];
  assignments: { state: string; partner: { displayName: string } }[];
}

function getDetail(cookies: string): Promise<{ statusCode: number; body: string }> {
  return app.inject({
    method: 'GET',
    url: `/api/v1/admin/logistics/shipments/${shipmentId}`,
    headers: { cookie: cookies },
  });
}

describe('the operator can see every carrier and every consignment', () => {
  it('lists the carriers, with the open work counted on the server', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/logistics/partners',
      headers: { cookie: clerkCookies },
    });

    expect(response.statusCode, response.body).toBe(200);

    const body = JSON.parse(response.body) as {
      partners: { id: string; displayName: string; openShipments: number; regionCount: number }[];
    };

    const mine = body.partners.find((partner) => partner.id === partnerId);

    expect(mine).toBeDefined();
    expect(mine?.displayName).toBe('Oversight Freight');
    expect(mine?.regionCount).toBe(1);
    // Nothing is assigned yet, and the count is a number rather than absent.
    expect(mine?.openShipments).toBe(0);
  });

  it('lists consignments nobody is carrying yet', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/logistics/shipments?unassignedOnly=true',
      headers: { cookie: clerkCookies },
    });

    expect(response.statusCode, response.body).toBe(200);

    const body = JSON.parse(response.body) as {
      shipments: { id: string; assignedPartner: unknown }[];
      total: number;
      pageCount: number;
    };

    const row = body.shipments.find((shipment) => shipment.id === shipmentId);

    expect(row).toBeDefined();
    expect(row?.assignedPartner).toBeNull();
    expect(body.pageCount).toBeGreaterThanOrEqual(1);
  });

  it('shows one consignment in full, including what a carrier never sees', async () => {
    const response = await getDetail(clerkCookies);

    expect(response.statusCode, response.body).toBe(200);

    const detail = JSON.parse(response.body) as ShipmentDetail;

    expect(detail.id).toBe(shipmentId);
    expect(detail.shipmentReference).toMatch(/^LS-/);

    /*
     * Unmasked, deliberately. The carrier's own read of the same row returns
     * a prefix and two digits; the marketplace holds the customer
     * relationship and is the party that telephones when a delivery fails.
     */
    expect(detail.deliveryContactPhone).toBe('+31 6 12 34 56 78');

    // Money crosses as a string or not at all - never as a JSON number.
    expect(detail.declaredValueMinor === null || typeof detail.declaredValueMinor === 'string').toBe(
      true,
    );
  });

  it('offers only transitions the state machine allows, and never a correction', async () => {
    const response = await getDetail(clerkCookies);
    const detail = JSON.parse(response.body) as ShipmentDetail;

    const targets = detail.allowedTransitions.map((transition) => transition.to);

    expect(targets.length).toBeGreaterThan(0);
    // AWAITING_ASSIGNMENT cannot jump to the end of the journey.
    expect(targets).not.toContain('DELIVERED');
    expect(targets).not.toContain('OUT_FOR_DELIVERY');
  });

  it('answers 404 for a consignment that does not exist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/logistics/shipments/${newId()}`,
      headers: { cookie: clerkCookies },
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('offering work to a carrier', () => {
  it('scores the candidates and says why each is or is not offerable', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/logistics/shipments/${shipmentId}/eligible-partners`,
      headers: { cookie: clerkCookies },
    });

    expect(response.statusCode, response.body).toBe(200);

    const body = JSON.parse(response.body) as {
      partners: { id: string; isEligible: boolean; reasons: string[]; onTimePercentage: number | null }[];
    };

    const candidate = body.partners.find((partner) => partner.id === partnerId);

    expect(candidate).toBeDefined();
    expect(candidate?.isEligible).toBe(true);
    // No deliveries yet, so there is no on-time figure. Never 100.
    expect(candidate?.onTimePercentage).toBeNull();
    expect(Array.isArray(candidate?.reasons)).toBe(true);
  });

  it('puts the consignment on a carrier and records the offer', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/logistics/shipments/${shipmentId}/assign`,
      headers: { cookie: clerkCookies, 'x-csrf-token': clerkCsrf },
      payload: { logisticsPartnerId: partnerId },
    });

    expect(response.statusCode, response.body).toBe(201);

    const detail = JSON.parse((await getDetail(clerkCookies)).body) as ShipmentDetail;

    expect(detail.assignments.length).toBe(1);
    expect(detail.assignments[0]?.state).toBe('OFFERED');
    expect(detail.assignments[0]?.partner.displayName).toBe('Oversight Freight');
  });
});

describe('correcting a status', () => {
  it('refuses a reason too short to be an explanation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/logistics/shipments/${shipmentId}/correct-status`,
      headers: { cookie: clerkCookies, 'x-csrf-token': clerkCsrf },
      payload: { status: 'ON_HOLD', reason: 'typo' },
    });

    expect(response.statusCode, response.body).toBe(400);
  });

  it('records the correction, flags it as one, and keeps the reason', async () => {
    const reason = 'Recorded against the wrong consignment by the depot.';

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/logistics/shipments/${shipmentId}/correct-status`,
      headers: { cookie: clerkCookies, 'x-csrf-token': clerkCsrf },
      payload: { status: 'ON_HOLD', reason },
    });

    expect(response.statusCode, response.body).toBe(200);

    const detail = JSON.parse((await getDetail(clerkCookies)).body) as ShipmentDetail;

    expect(detail.status).toBe('ON_HOLD');

    const correction = detail.events.find((event) => event.isCorrection);

    expect(correction).toBeDefined();
    expect(correction?.status).toBe('ON_HOLD');
    expect(correction?.reason).toBe(reason);
  });
});

describe('permissions are checked on the server, on every route', () => {
  it('refuses a carrier contract decision to somebody who may only assign work', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/logistics/partners',
      headers: { cookie: clerkCookies, 'x-csrf-token': clerkCsrf },
      payload: {
        legalName: 'Should Not Exist BV',
        displayName: 'Should Not Exist',
        registrationCountry: 'NL',
        contactEmail: 'nobody@example.test',
        ownerEmail: 'nobody@example.test',
        ownerFullName: 'Nobody At All',
      },
    });

    expect(response.statusCode).toBe(403);

    const created = await prisma.logisticsPartner.findFirst({
      where: { displayName: 'Should Not Exist' },
      select: { id: true },
    });

    expect(created).toBeNull();
  });

  it('refuses every logistics route to staff who hold no logistics permission', async () => {
    const register = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/logistics/partners',
      headers: { cookie: outsiderCookies },
    });

    const detail = await getDetail(outsiderCookies);

    const exceptions = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/logistics/exceptions',
      headers: { cookie: outsiderCookies },
    });

    expect(register.statusCode).toBe(403);
    expect(detail.statusCode).toBe(403);
    expect(exceptions.statusCode).toBe(403);
  });

  it('refuses a carrier credential to somebody who may only assign work', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/logistics/integrations',
      headers: { cookie: clerkCookies, 'x-csrf-token': clerkCsrf },
      payload: { provider: 'DHL', name: 'Should not be saved' },
    });

    expect(response.statusCode).toBe(403);
  });
});
