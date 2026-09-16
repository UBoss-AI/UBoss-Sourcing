/**
 * Which carrier the portal thinks you are, from the outside.
 *
 * `logistics-tenant-isolation.test.ts` proves that the SERVICES filter on a
 * membership. This file proves the thing above it: that the membership a
 * request is filtered by is the one the SESSION resolves to, and that nothing
 * a browser can say - a company id in a query string, an id in a body, a name
 * anybody typed - moves it.
 *
 * It exists because of a report that reads, on its face, like a tenant bug.
 * An operator created a new carrier, opened the logistics portal, and was
 * shown a different carrier entirely - the one that browser had last signed in
 * as. Everything the server did was correct: the portal was holding a live
 * session for that other company and answered for it. What was wrong was that
 * nothing said so, and a redirect that says nothing is indistinguishable from
 * the portal choosing a tenant by itself.
 *
 * So the assertions here are deliberately the ones somebody would have to read
 * to believe that: two carriers created the way an operator creates them, an
 * owner invited and activated the way an owner is, and then every path a
 * caller might hope widens the scope - a query parameter, a body field, a
 * foreign id in a URL, a refresh, a reseed - shown not to.
 *
 * All of it through `app.inject` with real cookies, because a test that called
 * the services directly could not tell the difference between "the session
 * decides" and "the argument decides".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { seedLogistics } from '../../src/seed/logistics.js';
import { inviteAsOperator } from '../../src/modules/logistics/admin.service.js';
import { acceptAssignment, offerAssignment } from '../../src/modules/logistics/assignment.service.js';
import { createShipment } from '../../src/modules/logistics/shipment-create.service.js';
import {
  resolveLogisticsMembership,
  type LogisticsMembership,
} from '../../src/modules/logistics/partner.service.js';
import { signInAdmin } from '../support/admin-session.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const OPERATOR_EMAIL = 'portal-tenant-operator@test.local';
const OPERATOR_PASSWORD = 'PortalTenantOps!2026';

/** Carrier A, standing in for the seeded company the report named. */
const A_NAME = 'Tenant Probe Sahyadri Express';
const A_OWNER_EMAIL = 'founder@sahyadri-tenant.test';
const A_DISPATCH_EMAIL = 'dispatch@sahyadri-tenant.test';

/** Carrier B, the one the operator has just created. */
const B_NAME = 'Tenant Probe XYZ Logistics';
const B_FOUNDER_EMAIL = 'founder@xyz-tenant.test';
const B_OWNER_EMAIL = 'owner@xyz-tenant.test';
const B_DISPATCH_EMAIL = 'dispatch@xyz-tenant.test';

/** A LOGISTICS account with no membership anywhere. */
const ORPHAN_EMAIL = 'orphan@nowhere-tenant.test';
const ORPHAN_PASSWORD = 'OrphanCarrier!2026';

const CARRIER_PASSWORD = 'CarrierPortal!2026';

/** The two accounts the concurrent-invitation test mints. */
const RACE_A_EMAIL = 'race-a@sahyadri-tenant.test';
const RACE_B_EMAIL = 'race-b@xyz-tenant.test';

const CARRIER_EMAILS = [
  A_OWNER_EMAIL,
  A_DISPATCH_EMAIL,
  B_FOUNDER_EMAIL,
  B_OWNER_EMAIL,
  B_DISPATCH_EMAIL,
  ORPHAN_EMAIL,
  RACE_A_EMAIL,
  RACE_B_EMAIL,
];

/** The seed's own keys, so the reseed test can put the database back. */
const SEED_PARTNER_CODE = 'LP-DEV-MERIDIAN';
const SEED_EMAILS = [
  'carrier.owner@uboss.local',
  'carrier.dispatch@uboss.local',
  'carrier.driver@uboss.local',
];

const ADDRESS = {
  line1: '3 Harbour Lane',
  city: 'Cork',
  postalCode: 'T12',
  countryCode: 'IE',
};

interface PortalSession {
  /** Ready for the `cookie` header. */
  cookies: string;
  csrfToken: string;
}

let operator = { cookies: '', csrfToken: '' };
let operatorUserId = '';

let carrierAId = '';
let carrierBId = '';

let carrierAShipmentId = '';
let carrierBShipmentId = '';

let aDispatch: PortalSession;
let bDispatch: PortalSession;
let bOwner: PortalSession;

// ---------------------------------------------------------------------------
// Tidying up
// ---------------------------------------------------------------------------

/**
 * Everything belonging to one carrier, children first.
 *
 * Shared by this file's own carriers and by the reseed test, which has to put
 * the development seed's carrier back the way it found it. Orders are
 * ON DELETE RESTRICT elsewhere in this schema and leftovers break the NEXT
 * run's first file rather than this one - see the note in the repository
 * guide.
 */
async function deletePartners(partnerIds: string[]): Promise<void> {
  if (partnerIds.length === 0) return;

  const shipmentIds = [
    ...new Set([
      ...(
        await prisma.logisticsShipmentAssignment.findMany({
          where: { logisticsPartnerId: { in: partnerIds } },
          select: { shipmentId: true },
        })
      ).map((row) => row.shipmentId),
      ...(
        await prisma.logisticsShipment.findMany({
          where: { assignedPartnerId: { in: partnerIds } },
          select: { id: true },
        })
      ).map((row) => row.id),
    ]),
  ];

  await prisma.logisticsProofOfDelivery.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentDocument.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentEvent.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentPackage.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentException.deleteMany({
    where: { shipmentId: { in: shipmentIds } },
  });
  await prisma.logisticsDriverAssignment.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentAssignment.deleteMany({
    where: { shipmentId: { in: shipmentIds } },
  });
  await prisma.logisticsDispatchManifestEntry.deleteMany({
    where: { shipmentId: { in: shipmentIds } },
  });
  await prisma.logisticsPickupRequest.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipment.deleteMany({ where: { id: { in: shipmentIds } } });

  await prisma.logisticsDispatchManifest.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });

  // Trips hang off the driver rather than the carrier, so they are found
  // through the driver profiles rather than by a partner column.
  const driverProfileIds = (
    await prisma.logisticsDriverProfile.findMany({
      where: { logisticsPartnerId: { in: partnerIds } },
      select: { id: true },
    })
  ).map((row) => row.id);

  await prisma.logisticsLocationPing.deleteMany({
    where: { driverProfileId: { in: driverProfileIds } },
  });
  await prisma.logisticsActiveTrip.deleteMany({
    where: { driverProfileId: { in: driverProfileIds } },
  });
  await prisma.logisticsNotification.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsAuditLog.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsDriverProfile.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsVehicle.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsCapability.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsServiceRegion.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsSlaPolicy.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsPartnerInvitation.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsPartnerUser.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsPartner.deleteMany({ where: { id: { in: partnerIds } } });
}

async function deleteCarrierUsers(emails: string[]): Promise<void> {
  const userIds = (
    await prisma.user.findMany({
      where: { emailNormalized: { in: emails } },
      select: { id: true },
    })
  ).map((row) => row.id);

  if (userIds.length === 0) return;

  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.authToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function cleanUp(): Promise<void> {
  const partnerIds = (
    await prisma.logisticsPartner.findMany({
      where: { displayName: { in: [A_NAME, B_NAME] } },
      select: { id: true },
    })
  ).map((row) => row.id);

  await deletePartners(partnerIds);
  await deleteCarrierUsers(CARRIER_EMAILS);

  await prisma.userRole.deleteMany({
    where: { user: { emailNormalized: OPERATOR_EMAIL } },
  });
  await prisma.user.deleteMany({ where: { emailNormalized: OPERATOR_EMAIL } });
}

/** The development seed, removed again. Only the reseed test creates it. */
async function cleanUpSeed(): Promise<void> {
  const seeded = await prisma.logisticsPartner.findUnique({
    where: { partnerCode: SEED_PARTNER_CODE },
    select: { id: true },
  });

  if (seeded !== null) await deletePartners([seeded.id]);
  await deleteCarrierUsers(SEED_EMAILS);
}

// ---------------------------------------------------------------------------
// Building the two carriers the way an operator does
// ---------------------------------------------------------------------------

async function makeOperator(): Promise<void> {
  const role = await prisma.role.findUniqueOrThrow({
    where: { key: Role.BUSINESS_OWNER },
    select: { id: true },
  });

  const user = await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email: OPERATOR_EMAIL,
      emailNormalized: OPERATOR_EMAIL,
      passwordHash: await hashPassword(OPERATOR_PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
    select: { id: true },
  });

  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });

  operatorUserId = user.id;
}

/** The actor shape the admin services take, for the calls made directly. */
function operatorActor(): { userId: string; email: string; permissions: readonly string[] } {
  return { userId: operatorUserId, email: OPERATOR_EMAIL, permissions: [] };
}

/** `POST /admin/logistics/partners` - the only way a carrier is ever created. */
async function createCarrier(displayName: string, ownerEmail: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/logistics/partners',
    headers: { cookie: operator.cookies, 'x-csrf-token': operator.csrfToken },
    payload: {
      legalName: `${displayName} Ltd`,
      displayName,
      registrationCountry: 'IE',
      contactEmail: `ops@${displayName.replace(/[^a-z]/gi, '').toLowerCase()}.test`,
      ownerEmail,
      ownerFullName: 'Founding Owner',
    },
  });

  expect(response.statusCode, response.body).toBe(201);

  return (JSON.parse(response.body) as { id: string }).id;
}

/**
 * Invite somebody, redeem the link, and sign them in - all three over HTTP.
 *
 * The invitation is minted through the service rather than through the admin
 * route because the route deliberately does not put the token in its response:
 * it goes into one email and nowhere else. The route's own behaviour is
 * covered by `logistics-admin-oversight.test.ts`; what this needs is the link
 * itself, which is exactly what `logistics-invitation.test.ts` does too.
 */
async function inviteActivateAndSignIn(
  partnerId: string,
  email: string,
  role: 'LOGISTICS_PARTNER_OWNER' | 'DISPATCHER',
  ip: string,
): Promise<PortalSession> {
  const invitation = await inviteAsOperator(operatorActor(), partnerId, {
    email,
    fullName: 'Invited Person',
    role,
  });

  const activated = await app.inject({
    method: 'POST',
    url: '/api/v1/logistics/auth/invitations/accept',
    headers: { 'x-forwarded-for': ip },
    payload: {
      token: invitation.token,
      password: CARRIER_PASSWORD,
      acceptedTerms: true,
      consentVersion: 'test',
    },
  });

  expect(activated.statusCode, activated.body).toBe(200);

  return signInToPortal(email, CARRIER_PASSWORD, ip);
}

async function signInToPortal(
  email: string,
  password: string,
  ip: string,
): Promise<PortalSession> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/logistics/auth/login',
    headers: { 'x-forwarded-for': ip },
    payload: { email, password },
  });

  expect(login.statusCode, login.body).toBe(200);

  const jar = login.cookies as { name: string; value: string }[];

  return {
    cookies: jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    csrfToken: jar.find((cookie) => cookie.name === 'uboss_logi_csrf')?.value ?? '',
  };
}

/**
 * Run something again once if MariaDB refused it for a write conflict.
 *
 * Two invitations issued in the same instant contend on `auth_tokens` - the
 * invalidate-then-insert inside `issueToken` takes a gap lock, and MariaDB
 * resolves the overlap by rolling one of them back. That is a real property of
 * the database rather than of the code under test, and the thing this file is
 * asking is what the two invitations are BOUND to, not whether the engine
 * serialises them. So the contention is retried rather than asserted on.
 */
async function retryOnWriteConflict<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!/write conflict|deadlock/i.test(String(error))) throw error;
    return run();
  }
}

/** A source file, read as text. Used by the two assertions about shape. */
async function readSource(relative: string): Promise<string> {
  const fs = await import('node:fs/promises');
  return fs.readFile(new URL(relative, import.meta.url), 'utf8');
}

function boot(session: PortalSession, url = '/api/v1/logistics/auth/me') {
  return app.inject({ method: 'GET', url, headers: { cookie: session.cookies } });
}

/** A consignment offered to one carrier and accepted by it. */
async function assignShipmentTo(
  partnerId: string,
  membership: LogisticsMembership,
  receiver: string,
): Promise<string> {
  const created = await createShipment({
    sellerCompanyName: 'Northwind Medical',
    receivingCompanyName: receiver,
    pickupAddress: ADDRESS,
    deliveryAddress: { ...ADDRESS, city: 'Limerick', postalCode: 'V94' },
    deliveryContactName: 'Niamh Walsh',
    deliveryContactPhone: '+353 86 123 4567',
    packageCount: 1,
    totalWeightGrams: 2100,
  });

  await prisma.logisticsShipment.update({
    where: { id: created.id },
    data: { status: 'AWAITING_ASSIGNMENT' },
  });

  await offerAssignment({
    shipmentId: created.id,
    logisticsPartnerId: partnerId,
    offeredByUserId: null,
    automatic: false,
  });

  await acceptAssignment(membership, created.id);

  return created.id;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  await cleanUp();
  await makeOperator();

  operator = await signInAdmin(app, {
    email: OPERATOR_EMAIL,
    password: OPERATOR_PASSWORD,
    ip: '203.0.113.71',
  });

  // 1 and 2. Two carriers, created exactly as the console creates them, each
  //          with its first owner invited in the same request.
  carrierAId = await createCarrier(A_NAME, A_OWNER_EMAIL);
  carrierBId = await createCarrier(B_NAME, B_FOUNDER_EMAIL);

  // Both start PENDING_ACTIVATION - accepting an invitation proves somebody
  // read an email, not that the marketplace finished its checks. The portal is
  // shut until the operator says otherwise, so say so.
  for (const id of [carrierAId, carrierBId]) {
    const activated = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/logistics/partners/${id}/status`,
      headers: { cookie: operator.cookies, 'x-csrf-token': operator.csrfToken },
      payload: { status: 'ACTIVE' },
    });

    expect(activated.statusCode, activated.body).toBe(200);
  }

  // 3 and 4. An owner at B, invited and activated, signing in with their own
  //          chosen password.
  bOwner = await inviteActivateAndSignIn(
    carrierBId,
    B_OWNER_EMAIL,
    'LOGISTICS_PARTNER_OWNER',
    '203.0.113.72',
  );

  // A dispatcher at each. Dispatchers rather than owners for everything that
  // reads data, because an owner's role requires a second factor and would be
  // refused by the MFA gate long before any tenant rule was reached.
  aDispatch = await inviteActivateAndSignIn(
    carrierAId,
    A_DISPATCH_EMAIL,
    'DISPATCHER',
    '203.0.113.73',
  );
  bDispatch = await inviteActivateAndSignIn(
    carrierBId,
    B_DISPATCH_EMAIL,
    'DISPATCHER',
    '203.0.113.74',
  );

  const aMembership = await resolveLogisticsMembership(
    (
      await prisma.user.findUniqueOrThrow({
        where: { emailNormalized: A_DISPATCH_EMAIL },
        select: { id: true },
      })
    ).id,
  );
  const bMembership = await resolveLogisticsMembership(
    (
      await prisma.user.findUniqueOrThrow({
        where: { emailNormalized: B_DISPATCH_EMAIL },
        select: { id: true },
      })
    ).id,
  );

  carrierAShipmentId = await assignShipmentTo(carrierAId, aMembership, 'Sahyadri Probe Clinic');
  carrierBShipmentId = await assignShipmentTo(carrierBId, bMembership, 'XYZ Probe Hospital');

  // Somebody with a logistics credential and no company at all.
  await prisma.user.create({
    data: {
      id: newId(),
      type: 'LOGISTICS',
      email: ORPHAN_EMAIL,
      emailNormalized: ORPHAN_EMAIL,
      passwordHash: await hashPassword(ORPHAN_PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
});

afterAll(async () => {
  await cleanUp();
  await cleanUpSeed();
  await app.close();
});

// ---------------------------------------------------------------------------

describe('the company the portal boots with', () => {
  it('is the one the authenticated membership names, not the first in the table', async () => {
    const response = await boot(bOwner);

    expect(response.statusCode, response.body).toBe(200);

    const body = JSON.parse(response.body) as {
      user: { email: string; role: string };
      partner: { id: string; code: string; displayName: string };
    };

    expect(body.partner.id).toBe(carrierBId);
    expect(body.partner.displayName).toBe(B_NAME);
    expect(body.partner.code).toMatch(/^LP-\d+$/);
    expect(body.user.email).toBe(B_OWNER_EMAIL);
    expect(body.user.role).toBe('LOGISTICS_PARTNER_OWNER');

    // The carrier created FIRST is the one a `findFirst()` would have picked.
    expect(body.partner.id).not.toBe(carrierAId);
    expect(body.partner.displayName).not.toBe(A_NAME);
  });

  it('ignores a company id supplied by the caller', async () => {
    const tampered = await boot(
      bOwner,
      `/api/v1/logistics/auth/me?logisticsPartnerId=${carrierAId}&partnerId=${carrierAId}&companyId=${carrierAId}`,
    );

    expect(tampered.statusCode, tampered.body).toBe(200);

    const body = JSON.parse(tampered.body) as { partner: { id: string } };
    expect(body.partner.id).toBe(carrierBId);
  });

  it('survives a refresh without changing company', async () => {
    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v1/logistics/auth/refresh',
      headers: {
        cookie: bDispatch.cookies,
        'x-csrf-token': bDispatch.csrfToken,
        'x-forwarded-for': '203.0.113.74',
      },
    });

    expect(refreshed.statusCode, refreshed.body).toBe(200);

    const jar = refreshed.cookies as { name: string; value: string }[];
    const rotated = {
      cookies: jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
      csrfToken: jar.find((cookie) => cookie.name === 'uboss_logi_csrf')?.value ?? '',
    };

    const after = JSON.parse((await boot(rotated)).body) as { partner: { id: string } };
    expect(after.partner.id).toBe(carrierBId);

    // The rotated cookies replace the old ones for the rest of the file.
    bDispatch = rotated;
  });
});

describe('an invitation binds to the company that issued it', () => {
  it('never produces a membership at another carrier', async () => {
    const owner = await prisma.user.findUniqueOrThrow({
      where: { emailNormalized: B_OWNER_EMAIL },
      select: { id: true },
    });

    const membership = await prisma.logisticsPartnerUser.findUniqueOrThrow({
      where: { userId: owner.id },
      select: { logisticsPartnerId: true, role: true, status: true },
    });

    expect(membership.logisticsPartnerId).toBe(carrierBId);
    expect(membership.role).toBe('LOGISTICS_PARTNER_OWNER');
    expect(membership.status).toBe('ACTIVE');

    const invitation = await prisma.logisticsPartnerInvitation.findFirstOrThrow({
      where: { emailNormalized: B_OWNER_EMAIL },
      select: { logisticsPartnerId: true, acceptedAt: true },
    });

    expect(invitation.logisticsPartnerId).toBe(carrierBId);
    expect(invitation.acceptedAt).not.toBeNull();
  });

  it('keeps two carriers created in the same breath apart', async () => {
    /*
     * Two invitations issued concurrently, one per carrier.
     *
     * The failure this guards against is a shared or reused partner id - the
     * kind of thing a module-level variable or a `findFirst()` between the two
     * writes would produce, and which only shows up when the two overlap.
     */
    const [first, second] = await Promise.all([
      retryOnWriteConflict(() =>
        inviteAsOperator(operatorActor(), carrierAId, {
          email: RACE_A_EMAIL,
          fullName: 'Race A',
          role: 'DISPATCHER',
        }),
      ),
      retryOnWriteConflict(() =>
        inviteAsOperator(operatorActor(), carrierBId, {
          email: RACE_B_EMAIL,
          fullName: 'Race B',
          role: 'DISPATCHER',
        }),
      ),
    ]);

    const rows = await prisma.logisticsPartnerInvitation.findMany({
      where: { emailNormalized: { in: [first.email, second.email] } },
      select: { emailNormalized: true, logisticsPartnerId: true },
    });

    const byEmail = new Map(rows.map((row) => [row.emailNormalized, row.logisticsPartnerId]));

    expect(byEmail.get(RACE_A_EMAIL)).toBe(carrierAId);
    expect(byEmail.get(RACE_B_EMAIL)).toBe(carrierBId);

    // Tidy the two accounts the invitations created alongside them. Both
    // addresses are in CARRIER_EMAILS as well, so a run that dies here still
    // leaves the next one a clean database.
    await prisma.logisticsPartnerInvitation.deleteMany({
      where: { emailNormalized: { in: [first.email, second.email] } },
    });
    await prisma.logisticsPartnerUser.deleteMany({
      where: { user: { emailNormalized: { in: [first.email, second.email] } } },
    });
    await deleteCarrierUsers([RACE_A_EMAIL, RACE_B_EMAIL]);
  });
});

describe('neither carrier can reach the other', () => {
  it('lists only its own consignments', async () => {
    const bList = JSON.parse((await boot(bDispatch, '/api/v1/logistics/shipments')).body) as {
      rows: { id: string }[];
    };
    const aList = JSON.parse((await boot(aDispatch, '/api/v1/logistics/shipments')).body) as {
      rows: { id: string }[];
    };

    expect(bList.rows.map((row) => row.id)).toEqual([carrierBShipmentId]);
    expect(aList.rows.map((row) => row.id)).toEqual([carrierAShipmentId]);
  });

  it(`answers NOT FOUND for the other carrier's consignment, in both directions`, async () => {
    const bReadsA = await boot(bDispatch, `/api/v1/logistics/shipments/${carrierAShipmentId}`);
    const aReadsB = await boot(aDispatch, `/api/v1/logistics/shipments/${carrierBShipmentId}`);

    expect(bReadsA.statusCode).toBe(404);
    expect(aReadsB.statusCode).toBe(404);
  });

  it(`refuses the other carrier's documents and timeline`, async () => {
    const documents = await boot(
      bDispatch,
      `/api/v1/logistics/shipments/${carrierAShipmentId}/documents`,
    );
    const timeline = await boot(
      bDispatch,
      `/api/v1/logistics/shipments/${carrierAShipmentId}/timeline`,
    );

    expect(documents.statusCode).toBe(404);
    expect(timeline.statusCode).toBe(404);
  });

  it('sees only its own drivers and its own receiving companies', async () => {
    const drivers = JSON.parse((await boot(bDispatch, '/api/v1/logistics/drivers')).body) as {
      drivers: { partnerUserId: string }[];
    };

    // B has invited no driver, so the honest answer is none - never A's.
    expect(drivers.drivers).toHaveLength(0);

    const companies = JSON.parse((await boot(bDispatch, '/api/v1/logistics/companies')).body) as {
      companies: { name: string }[];
    };

    const names = companies.companies.map((row) => row.name);
    expect(names).toContain('XYZ Probe Hospital');
    expect(names).not.toContain('Sahyadri Probe Clinic');
  });

  it('cannot widen its own list by naming the other carrier', async () => {
    const response = await boot(
      bDispatch,
      '/api/v1/logistics/shipments?receivingCompany=Sahyadri%20Probe%20Clinic',
    );

    const body = JSON.parse(response.body) as { rows: unknown[]; total: number };

    expect(body.rows).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it('cannot reach the other carrier by putting its id in a write', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/logistics/shipments/${carrierAShipmentId}/status-events`,
      headers: { cookie: bDispatch.cookies, 'x-csrf-token': bDispatch.csrfToken },
      payload: {
        status: 'PICKED_UP',
        logisticsPartnerId: carrierAId,
      },
    });

    // Not found rather than forbidden: a carrier is not told that a
    // consignment it may not see exists.
    expect(response.statusCode).toBe(404);
  });
});

describe('a session that should not work', () => {
  it('tells a logistics account with no company so, plainly', async () => {
    const orphan = await signInToPortal(ORPHAN_EMAIL, ORPHAN_PASSWORD, '203.0.113.75');
    const response = await boot(orphan);

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({
      error: { code: 'LOGISTICS_PARTNER_REQUIRED' },
    });

    // And no company is offered in its place.
    expect(response.body).not.toContain(A_NAME);
    expect(response.body).not.toContain(B_NAME);
  });

  it('refuses a revoked membership and names the reason', async () => {
    const member = await prisma.logisticsPartnerUser.findFirstOrThrow({
      where: { user: { emailNormalized: B_DISPATCH_EMAIL } },
      select: { id: true },
    });

    await prisma.logisticsPartnerUser.update({
      where: { id: member.id },
      data: { status: 'DISABLED', disabledAt: new Date() },
    });

    const response = await boot(bDispatch);

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({
      error: { code: 'LOGISTICS_MEMBER_DISABLED' },
    });
    expect(response.body).not.toContain(A_NAME);

    await prisma.logisticsPartnerUser.update({
      where: { id: member.id },
      data: { status: 'ACTIVE', disabledAt: null },
    });
  });

  it('refuses a carrier the marketplace has closed', async () => {
    const closed = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/logistics/partners/${carrierBId}/status`,
      headers: { cookie: operator.cookies, 'x-csrf-token': operator.csrfToken },
      payload: { status: 'DEACTIVATED', reason: 'Contract ended for the tenant probe.' },
    });

    expect(closed.statusCode, closed.body).toBe(200);

    // Closing a carrier revokes its people's sessions, so the one already open
    // stops working rather than merely being refused at the company check.
    const live = await boot(bDispatch);
    expect(live.statusCode).toBe(401);
    expect(live.body).not.toContain(A_NAME);

    /*
     * And a fresh sign-in gets no further.
     *
     * The password is still correct - the account was not what was closed - so
     * the login succeeds and the boot response is where the door shuts. That
     * is the state the portal turns into its "we could not let you in, and
     * here is why" message, and the reason it says something specific rather
     * than dropping the person on an empty form.
     */
    const readmitted = await signInToPortal(B_DISPATCH_EMAIL, CARRIER_PASSWORD, '203.0.113.78');
    const refused = await boot(readmitted);

    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body)).toMatchObject({
      error: { code: 'LOGISTICS_PARTNER_NOT_ACTIVE' },
    });
    expect(refused.body).not.toContain(A_NAME);

    const reopened = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/logistics/partners/${carrierBId}/status`,
      headers: { cookie: operator.cookies, 'x-csrf-token': operator.csrfToken },
      payload: { status: 'ACTIVE' },
    });

    expect(reopened.statusCode, reopened.body).toBe(200);

    // The session opened a moment ago works again, and still says B.
    const after = JSON.parse((await boot(readmitted)).body) as { partner: { id: string } };
    expect(after.partner.id).toBe(carrierBId);

    bDispatch = readmitted;
  });
});

describe('an existing session in the same browser', () => {
  it('stays its own company, and signing out lets the other one in', async () => {
    /*
     * The reported scenario, end to end.
     *
     * A browser holding carrier A's cookies opens the portal. It must answer
     * for A - and a sign-in as B afterwards must answer for B, in a session
     * that has nothing of A's left in it.
     */
    const before = JSON.parse((await boot(aDispatch)).body) as { partner: { id: string } };
    expect(before.partner.id).toBe(carrierAId);

    const loggedOut = await app.inject({
      method: 'POST',
      url: '/api/v1/logistics/auth/logout',
      headers: { cookie: aDispatch.cookies, 'x-csrf-token': aDispatch.csrfToken },
    });

    expect(loggedOut.statusCode, loggedOut.body).toBe(204);

    const cleared = (loggedOut.cookies as { name: string; value: string }[])
      .filter((cookie) => cookie.name.startsWith('uboss_logi_'))
      .map((cookie) => cookie.name);

    expect(cleared).toEqual(
      expect.arrayContaining(['uboss_logi_at', 'uboss_logi_rt', 'uboss_logi_csrf']),
    );

    const dead = await boot(aDispatch);
    expect(dead.statusCode).toBe(401);

    const asB = await signInToPortal(B_DISPATCH_EMAIL, CARRIER_PASSWORD, '203.0.113.76');
    const after = JSON.parse((await boot(asB)).body) as { partner: { id: string; displayName: string } };

    expect(after.partner.id).toBe(carrierBId);
    expect(after.partner.displayName).toBe(B_NAME);

    // A is signed in again for whatever runs after this.
    aDispatch = await signInToPortal(A_DISPATCH_EMAIL, CARRIER_PASSWORD, '203.0.113.77');
  });
});

describe('the development seed', () => {
  it('does not move a live session onto the carrier it creates', async () => {
    const before = JSON.parse((await boot(bDispatch)).body) as { partner: { id: string } };
    expect(before.partner.id).toBe(carrierBId);

    const result = await seedLogistics();

    // NODE_ENV is `test` and the portal feature is on, so it really ran.
    expect(result.skipped).toBe(false);
    expect(result.partnerCode).toBe(SEED_PARTNER_CODE);

    const seeded = await prisma.logisticsPartner.findUniqueOrThrow({
      where: { partnerCode: SEED_PARTNER_CODE },
      select: { id: true },
    });

    const after = JSON.parse((await boot(bDispatch)).body) as {
      partner: { id: string; displayName: string };
    };

    expect(after.partner.id).toBe(carrierBId);
    expect(after.partner.displayName).toBe(B_NAME);
    expect(after.partner.id).not.toBe(seeded.id);

    // And the seed did not quietly become anybody else's company either.
    const seededMembers = await prisma.logisticsPartnerUser.findMany({
      where: { logisticsPartnerId: seeded.id },
      select: { user: { select: { emailNormalized: true } } },
    });

    expect(seededMembers.map((row) => row.user.emailNormalized).sort()).toEqual(
      [...SEED_EMAILS].sort(),
    );
  });

  it('refuses to run in production, where its passwords are known', async () => {
    /*
     * The guard is read rather than executed, and deliberately.
     *
     * `env` is parsed once when the process boots, so flipping NODE_ENV inside
     * a running suite cannot reach the branch - and a run that genuinely
     * booted as production would sign every other file in the suite up to a
     * different configuration. What can be checked here is that the branch is
     * present, that it comes before anything is written, and that nothing in
     * the portal signs anybody in without a password.
     */
    const seedSource = await readSource('../../src/seed/logistics.ts');

    expect(seedSource).toContain("env.NODE_ENV === 'production'");
    expect(seedSource).toContain('refused in production');

    const guardIndex = seedSource.indexOf("env.NODE_ENV === 'production'");
    expect(guardIndex).toBeLessThan(seedSource.indexOf('upsertPartner()'));
  });

  it('is not reachable as an automatic sign-in from anywhere', async () => {
    // No cookies at all. The portal's boot response is the one place a
    // development bypass would have to surface, and it answers 401.
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/logistics/auth/me' });

    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.body).not.toContain('Meridian');

    for (const file of [
      '../../src/http/routes/logistics.portal.ts',
      '../../src/http/plugins/logistics.ts',
      '../../src/modules/logistics/partner.service.ts',
    ]) {
      const text = await readSource(file);

      expect(text).not.toMatch(/auto[-_]?login/i);

      /*
       * And no unfiltered "first carrier" anywhere on the path a session
       * takes. Every `findFirst` on the partner table in these three files
       * must state a `where`, because one without it is exactly the query
       * that hands somebody the oldest row in the table as their company.
       */
      for (const call of text.split('logisticsPartner.findFirst(').slice(1)) {
        expect(call.slice(0, 200)).toContain('where:');
      }
    }
  });
});
