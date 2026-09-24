/**
 * The operations desk working a carrier's fleet, over HTTP.
 *
 * WHAT THIS FILE IS DEFENDING
 *
 * The marketplace can now do, on a carrier's behalf, what the carrier does in
 * its own portal: add a driver, add a van, put one on a consignment, take it
 * off, and move the consignment along. That is a real widening of what an
 * admin grant reaches, and it is only safe because of three things this file
 * proves rather than assumes:
 *
 *   1. **It is one fleet, not a marketplace-side copy.** A driver added here
 *      appears in the carrier's own register, from the carrier's own reader.
 *      Two registers that had to be reconciled would be the bug.
 *   2. **The fleet is derived, never named by the caller.** A consignment's
 *      driver comes from the carrier the consignment is ALREADY with. Naming
 *      it in the body would let the desk put DHL's driver on a DPD parcel,
 *      which is not an authority question but a nonsense.
 *   3. **It is written down as the marketplace.** Every action lands in the
 *      carrier's own audit trail labelled as the operator, so a carrier
 *      reading their trail after a bad delivery can see what was done in their
 *      name and by whom.
 *
 * Also here: the difference between MOVING a consignment and CORRECTING it.
 * They are different endpoints on purpose - a correction is flagged for ever
 * and demands eight characters of explanation - and a timeline where the two
 * were the same is a timeline nobody can audit.
 *
 * The permissions are checked at both ends, with a session on each side of the
 * line the product already draws: `logistics.write` is the fleet register - who
 * drives, what they drive - and `logistics.assign` is putting somebody on a
 * parcel and moving it. An Order Manager holds the second and not the first,
 * which is why they can dispatch a consignment and cannot add a driver.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { Permission, Role } from '../../src/domain/permissions.js';
import { permissionsForLogisticsRole } from '../../src/domain/logistics-permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { LogisticsMembership } from '../../src/modules/logistics/partner.service.js';
import { acceptAssignment, offerAssignment } from '../../src/modules/logistics/assignment.service.js';
import { asPartner, listDrivers } from '../../src/modules/logistics/driver.service.js';
import { createShipment } from '../../src/modules/logistics/shipment-create.service.js';
import { recordShipmentEvent } from '../../src/modules/logistics/shipment-event.service.js';
import { signInAdmin } from '../support/admin-session.js';

let app: Awaited<ReturnType<typeof buildApp>>;

/**
 * A Business Owner: holds `logistics.write` as well as `logistics.assign`, so
 * this session can work the fleet register.
 */
let desk = { cookies: '', csrfToken: '' };
/**
 * An Order Manager: `logistics.read` and `logistics.assign`, deliberately NOT
 * `logistics.write`.
 *
 * That split is the product's, not this file's: getting a parcel to a customer
 * is an order clerk's job, and contracting with a haulier - which is what the
 * fleet register belongs to - is not. Holding a session on each side of it is
 * how the split stays true rather than becoming a comment in a role table.
 */
let clerk = { cookies: '', csrfToken: '' };

const DESK_EMAIL = 'fleet-desk@test.local';
const CLERK_EMAIL = 'fleet-clerk@test.local';
const PASSWORD = 'OperatorFleet!2026';

const NORTH_CODE = 'LP-TEST-OPF-N';
const SOUTH_CODE = 'LP-TEST-OPF-S';
const RECEIVER = 'Operator Fleet Test Hospital';
const EMAIL_DOMAIN = '@opftest.local';

interface Carrier {
  id: string;
  membership: LogisticsMembership;
}

let north: Carrier;
let south: Carrier;
/** With North, accepted, moving. The one most cases act on. */
let shipmentId = '';
/** Raised but never offered to anybody. Proves the fleet cannot be derived. */
let unassignedShipmentId = '';

const ADDRESS = { line1: '11 Dock Road', city: 'Antwerp', postalCode: '2000', countryCode: 'BE' };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function cleanUp(): Promise<void> {
  const partnerIds = (
    await prisma.logisticsPartner.findMany({
      where: { partnerCode: { in: [NORTH_CODE, SOUTH_CODE] } },
      select: { id: true },
    })
  ).map((row) => row.id);

  const shipmentIds = (
    await prisma.logisticsShipment.findMany({
      where: { receivingCompanyName: RECEIVER },
      select: { id: true },
    })
  ).map((row) => row.id);

  // Children first, and every delete scoped to this file's own rows: the suite
  // shares one database, and leftovers break the NEXT file rather than this
  // one.
  await prisma.logisticsDriverAssignment.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
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
  await prisma.logisticsShipment.deleteMany({ where: { id: { in: shipmentIds } } });
  await prisma.logisticsAuditLog.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsDriverProfile.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsVehicle.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsPartnerUser.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsPartner.deleteMany({ where: { id: { in: partnerIds } } });

  await prisma.adminNotificationRead.deleteMany({
    where: { notification: { relatedType: 'logistics_shipment' } },
  });
  await prisma.adminNotification.deleteMany({ where: { relatedType: 'logistics_shipment' } });

  for (const email of [DESK_EMAIL, CLERK_EMAIL]) {
    await prisma.userRole.deleteMany({ where: { user: { emailNormalized: email } } });
    await prisma.session.deleteMany({ where: { user: { emailNormalized: email } } });
    await prisma.auditLog.deleteMany({ where: { actorEmail: email } });
  }

  await prisma.user.deleteMany({
    where: {
      OR: [
        { emailNormalized: { in: [DESK_EMAIL, CLERK_EMAIL] } },
        { emailNormalized: { contains: EMAIL_DOMAIN } },
      ],
    },
  });

  await prisma.numberSequence.deleteMany({ where: { key: { startsWith: 'logistics-' } } });
}

async function makeAdmin(email: string, roleKey: string): Promise<void> {
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
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: role.id } },
    },
  });
}

async function makeCarrier(partnerCode: string, name: string): Promise<Carrier> {
  const id = newId();
  const ownerUserId = newId();
  const partnerUserId = newId();
  const email = `${partnerCode.toLowerCase()}${EMAIL_DOMAIN}`;

  await prisma.logisticsPartner.create({
    data: {
      id,
      partnerCode,
      legalName: `${name} Freight NV`,
      displayName: name,
      displayNameNormalized: name.toLowerCase().replace(/[^a-z0-9]/g, ''),
      registrationCountry: 'BE',
      contactEmail: email,
      status: 'ACTIVE',
      contractStatus: 'ACTIVE',
    },
  });

  await prisma.user.create({
    data: { id: ownerUserId, type: 'LOGISTICS', email, emailNormalized: email, status: 'ACTIVE' },
  });

  await prisma.logisticsPartnerUser.create({
    data: {
      id: partnerUserId,
      logisticsPartnerId: id,
      userId: ownerUserId,
      role: 'LOGISTICS_PARTNER_OWNER',
      status: 'ACTIVE',
      fullName: `${name} Owner`,
    },
  });

  return {
    id,
    membership: {
      logisticsPartnerId: id,
      partnerCode,
      displayName: name,
      legalName: `${name} Freight NV`,
      partnerStatus: 'ACTIVE',
      registrationCountry: 'BE',
      partnerUserId,
      userId: ownerUserId,
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

/**
 * A consignment, offered to and accepted by a carrier, exactly as the product
 * does it.
 *
 * The offer and the acceptance are not decoration: the carrier's own screens
 * filter on a LIVE assignment, so a consignment with `assignedPartnerId` set
 * by hand is one the carrier cannot see and the desk cannot derive a fleet
 * from.
 */
async function makeShipment(carrier: Carrier | null): Promise<string> {
  const created = await createShipment({
    sellerCompanyName: 'Operator Fleet Test Seller',
    receivingCompanyName: RECEIVER,
    pickupAddress: ADDRESS,
    deliveryAddress: { ...ADDRESS, city: 'Ghent', postalCode: '9000' },
    packageCount: 1,
    totalWeightGrams: 2000,
  });

  await prisma.logisticsShipment.update({
    where: { id: created.id },
    data: { status: 'AWAITING_ASSIGNMENT' },
  });

  if (carrier === null) return created.id;

  await offerAssignment({
    shipmentId: created.id,
    logisticsPartnerId: carrier.id,
    offeredByUserId: null,
    automatic: false,
  });

  await acceptAssignment(carrier.membership, created.id);

  return created.id;
}

/** As the carrier, holding the carrier's own permissions. */
async function advance(
  id: string,
  statuses: readonly ('PICKUP_SCHEDULED' | 'PICKED_UP' | 'IN_TRANSIT' | 'OUT_FOR_DELIVERY')[],
): Promise<void> {
  for (const status of statuses) {
    await recordShipmentEvent({
      shipmentId: id,
      status,
      actor: 'PARTNER',
      source: 'LOGISTICS_PORTAL',
      actorLogisticsPartnerId: north.id,
      permissions: [...north.membership.permissions],
    });
  }
}

// ---------------------------------------------------------------------------
// Talking to the routes
// ---------------------------------------------------------------------------

/**
 * One admin request, with a session and a CSRF token on it.
 *
 * `session` defaults to the Business Owner, so a case that does not care which
 * side of the permission line it is on does not have to say. The cases that DO
 * care pass `clerk` and read as a sentence about the split.
 */
function asDesk(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: Record<string, unknown>,
  session = desk,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method,
    url: `/api/v1/admin${url}`,
    headers: { cookie: session.cookies, 'x-csrf-token': session.csrfToken, ...headers },
    ...(payload === undefined ? {} : { payload }),
  });
}

interface DriverBody {
  id: string;
  fullName: string;
  phone: string | null;
  partnerUserId: string | null;
  hasPortalAccess: boolean;
  state: string;
  canCarryColdChain: boolean;
  licenceNumber: string | null;
  employeeReference: string | null;
  openTasks: number;
}

beforeAll(async () => {
  app = await buildApp();
  await cleanUp();

  await makeAdmin(DESK_EMAIL, Role.BUSINESS_OWNER);
  await makeAdmin(CLERK_EMAIL, Role.ORDER_MANAGER);

  // Separate source addresses: the login route is rate limited by IP, and two
  // sign-ins from one address spend each other's budget.
  desk = await signInAdmin(app, {
    email: DESK_EMAIL,
    password: PASSWORD,
    ip: '203.0.113.190',
  });
  clerk = await signInAdmin(app, {
    email: CLERK_EMAIL,
    password: PASSWORD,
    ip: '203.0.113.191',
  });

  north = await makeCarrier(NORTH_CODE, 'Operator North');
  south = await makeCarrier(SOUTH_CODE, 'Operator South');

  shipmentId = await makeShipment(north);
  unassignedShipmentId = await makeShipment(null);

  // Moving. The ordinary state for a driver assignment - the acceptance leaves
  // it ACCEPTED, and a parcel gets a driver once it is on the road.
  await advance(shipmentId, ['PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT']);
});

afterAll(async () => {
  await app.close();
  await cleanUp();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

describe('the desk adding somebody to a fleet', () => {
  it('takes a typed name and nothing else', async () => {
    const response = await asDesk('POST', `/logistics/partners/${north.id}/drivers`, {
      fullName: 'Marek Nowak',
      phone: '+32 470 11 22 33',
      employeeReference: 'ON-101',
      canCarryColdChain: true,
    });

    expect(response.statusCode, response.body).toBe(201);

    const driver = response.json<DriverBody>();
    expect(driver.fullName).toBe('Marek Nowak');
    expect(driver.phone).toBe('+32 470 11 22 33');
    expect(driver.canCarryColdChain).toBe(true);
    // No account, and no invitation was sent. That is the whole point: the
    // desk takes these over the phone.
    expect(driver.partnerUserId).toBeNull();
    expect(driver.hasPortalAccess).toBe(false);
  });

  it('puts them on the carrier own register, not a copy of it', async () => {
    const response = await asDesk('POST', `/logistics/partners/${north.id}/drivers`, {
      fullName: 'Ilse Cools',
    });
    expect(response.statusCode, response.body).toBe(201);

    // Read back through the CARRIER's own reader, with the carrier's own
    // membership. One register, two doors into it.
    const theirs = await listDrivers(asPartner(north.membership));
    expect(theirs.some((row) => row.fullName === 'Ilse Cools')).toBe(true);
  });

  it('refuses a record with no name on it', async () => {
    const response = await asDesk('POST', `/logistics/partners/${north.id}/drivers`, {
      fullName: ' ',
    });

    // Rejected by the schema before it reaches the service: a driver record is
    // a name, so a nameless one is not a partial record but a meaningless one.
    expect(response.statusCode).toBe(400);
  });

  it('writes it into the carrier own audit trail, named as the marketplace', async () => {
    await asDesk('POST', `/logistics/partners/${north.id}/drivers`, {
      fullName: 'Rik Delvaux',
    });

    const entry = await prisma.logisticsAuditLog.findFirst({
      where: { logisticsPartnerId: north.id, action: 'logistics.driver.added' },
      orderBy: { createdAt: 'desc' },
      select: { actorLabel: true, actorUserId: true, summary: true },
    });

    // The label names the MARKETPLACE, not the individual: a carrier reading
    // their own trail should see that the operator did this, not the name of
    // somebody on another company's staff. The individual is recorded in the
    // marketplace's own `audit_log`, which the carrier cannot read.
    expect(entry?.actorLabel).toBe('Marketplace operations');
    expect(entry?.actorUserId).not.toBeNull();
    expect(entry?.summary).toContain('by the marketplace');
  });

  it('edits only the fields it was given', async () => {
    const created = await asDesk('POST', `/logistics/partners/${north.id}/drivers`, {
      fullName: 'Sven Maes',
      canCarryColdChain: true,
      employeeReference: 'ON-202',
    });
    const driver = created.json<DriverBody>();

    const patched = await asDesk(
      'PATCH',
      `/logistics/partners/${north.id}/drivers/${driver.id}`,
      { licenceNumber: 'B-11112222' },
    );

    expect(patched.statusCode, patched.body).toBe(200);

    const after = patched.json<DriverBody>();
    expect(after.licenceNumber).toBe('B-11112222');
    // The bug the old whole-record upsert made easy: correcting one field
    // silently clearing the ones beside it.
    expect(after.canCarryColdChain).toBe(true);
    expect(after.employeeReference).toBe('ON-202');
  });

  it("will not reach a driver on another carrier's fleet", async () => {
    const created = await asDesk('POST', `/logistics/partners/${north.id}/drivers`, {
      fullName: 'Nele Wouters',
    });
    const driver = created.json<DriverBody>();

    const wrongFleet = await asDesk(
      'PATCH',
      `/logistics/partners/${south.id}/drivers/${driver.id}`,
      { licenceNumber: 'B-99999999' },
    );

    // 404: an admin grant is authority over the marketplace, not permission to
    // move a driver between two businesses that have never met.
    expect(wrongFleet.statusCode).toBe(404);
  });

  it('refuses an order clerk, who may assign work but not contract with hauliers', async () => {
    const response = await asDesk(
      'POST',
      `/logistics/partners/${north.id}/drivers`,
      { fullName: 'Should Not Exist' },
      clerk,
    );

    expect(response.statusCode).toBe(403);
  });
});

describe('the desk adding a vehicle', () => {
  it('records the van and its cold-chain range', async () => {
    const response = await asDesk('POST', `/logistics/partners/${north.id}/vehicles`, {
      registration: '1-OPF-001',
      kind: 'REFRIGERATED_VAN',
      hasRefrigeration: true,
      temperatureMinC: 2,
      temperatureMaxC: 8,
      maxWeightGrams: 1_200_000,
    });

    expect(response.statusCode, response.body).toBe(201);

    const listed = await asDesk('GET', `/logistics/partners/${north.id}/vehicles`);
    const { vehicles } = listed.json<{ vehicles: { registration: string }[] }>();
    expect(vehicles.some((row) => row.registration === '1-OPF-001')).toBe(true);
  });

  it('refuses an order clerk, for the same reason', async () => {
    const response = await asDesk(
      'POST',
      `/logistics/partners/${north.id}/vehicles`,
      { registration: '1-OPF-999', kind: 'VAN' },
      clerk,
    );

    expect(response.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Putting somebody on a parcel
// ---------------------------------------------------------------------------

describe('the desk putting a driver on a consignment', () => {
  it('derives the fleet from the carrier the consignment is already with', async () => {
    const created = await asDesk('POST', `/logistics/partners/${north.id}/drivers`, {
      fullName: 'Anja Vermeulen',
    });
    const driver = created.json<DriverBody>();

    const assigned = await asDesk('POST', `/logistics/shipments/${shipmentId}/assign-driver`, {
      driverProfileId: driver.id,
    });

    expect(assigned.statusCode, assigned.body).toBe(201);
    expect(assigned.json<{ replacedAssignmentId: string | null }>().replacedAssignmentId).toBeNull();

    // And the carrier's own screen agrees, because it is one chain.
    const live = await prisma.logisticsDriverAssignment.findFirst({
      where: { shipmentId, unassignedAt: null },
      select: { driverProfileId: true, assignedByLabel: true, assignedByPartnerUserId: true },
    });

    expect(live?.driverProfileId).toBe(driver.id);
    // The label carries who acted. `assignedByPartnerUserId` stays null
    // because an operator has no row in the carrier's own team, and the chain
    // would otherwise lose who moved it.
    expect(live?.assignedByLabel).toBe('Marketplace operations');
    expect(live?.assignedByPartnerUserId).toBeNull();
  });

  it("refuses a driver from a different carrier's fleet", async () => {
    const stranger = await asDesk('POST', `/logistics/partners/${south.id}/drivers`, {
      fullName: 'Dirk Peeters',
    });
    const driver = stranger.json<DriverBody>();

    const response = await asDesk('POST', `/logistics/shipments/${shipmentId}/assign-driver`, {
      driverProfileId: driver.id,
    });

    // Not an authority question - a nonsense. South's driver has no business
    // on North's parcel, and the fleet check is what makes that impossible
    // rather than merely discouraged.
    expect(response.statusCode).toBe(409);
    // The same answer a stood-down driver of North's own would get, and
    // deliberately: distinguishing the two would confirm to the desk - and to
    // anything replaying its requests - that a particular driver of South's
    // exists.
    expect(response.body).toContain('not on this carrier');
  });

  it('refuses a consignment that is not with anybody yet', async () => {
    const created = await asDesk('POST', `/logistics/partners/${north.id}/drivers`, {
      fullName: 'Bram de Wit',
    });
    const driver = created.json<DriverBody>();

    const response = await asDesk(
      'POST',
      `/logistics/shipments/${unassignedShipmentId}/assign-driver`,
      { driverProfileId: driver.id },
    );

    // There is no fleet to take a driver from. Said as a conflict with a
    // sentence rather than a 500 from a null id.
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('not with a carrier yet');
  });

  it('moves it to another driver, with a reason, and keeps the chain', async () => {
    const replacement = await asDesk('POST', `/logistics/partners/${north.id}/drivers`, {
      fullName: 'Cato Jansen',
    });
    const driver = replacement.json<DriverBody>();

    const moved = await asDesk('POST', `/logistics/shipments/${shipmentId}/assign-driver`, {
      driverProfileId: driver.id,
      reason: 'The first driver went home sick at four.',
    });

    expect(moved.statusCode, moved.body).toBe(201);
    expect(moved.json<{ replacedAssignmentId: string | null }>().replacedAssignmentId).not.toBeNull();

    const history = await prisma.logisticsDriverAssignment.findMany({
      where: { shipmentId },
      orderBy: { assignedAt: 'asc' },
      select: { unassignedReason: true, unassignedAt: true },
    });

    // The reason is kept on the assignment that ENDED, which is what makes the
    // chain readable months later: "Anja, then Cato because Anja was sick".
    expect(history[0]?.unassignedReason).toContain('went home sick');
    expect(history.at(-1)?.unassignedAt).toBeNull();
  });

  it('takes the driver off, and says so twice without complaining', async () => {
    const first = await asDesk('POST', `/logistics/shipments/${shipmentId}/unassign-driver`, {
      reason: 'Round cancelled; nobody to cover it tonight.',
    });

    expect(first.statusCode, first.body).toBe(200);
    expect(first.json<{ unassignedAssignmentId: string | null }>().unassignedAssignmentId).not.toBeNull();

    const again = await asDesk('POST', `/logistics/shipments/${shipmentId}/unassign-driver`, {
      reason: 'Round cancelled; nobody to cover it tonight.',
    });

    // Nobody on it is the desired end state, so saying so twice is not an
    // error. A dispatcher told "that failed" will try again.
    expect(again.statusCode).toBe(200);
    expect(again.json<{ unassignedAssignmentId: string | null }>().unassignedAssignmentId).toBeNull();
  });

  it('lets an order clerk do it, because putting a parcel on a driver is order work', async () => {
    const created = await asDesk('POST', `/logistics/partners/${north.id}/drivers`, {
      fullName: 'Lotte Claes',
    });
    const driver = created.json<DriverBody>();

    const response = await asDesk(
      'POST',
      `/logistics/shipments/${shipmentId}/assign-driver`,
      { driverProfileId: driver.id },
      clerk,
    );

    // The other side of the split. A clerk cannot add Lotte to the fleet, but
    // once she is on it they can put her on a parcel - which is exactly the
    // line `logistics.assign` and `logistics.write` are meant to draw.
    expect(response.statusCode, response.body).toBe(201);

    await asDesk('POST', `/logistics/shipments/${shipmentId}/unassign-driver`, {
      reason: 'Tidying up after the clerk case.',
    });
  });
});

// ---------------------------------------------------------------------------
// Moving it along
// ---------------------------------------------------------------------------

describe('the desk moving a consignment along', () => {
  let ownShipmentId = '';

  beforeAll(async () => {
    ownShipmentId = await makeShipment(north);
    await recordShipmentEvent({
      shipmentId: ownShipmentId,
      status: 'PICKUP_SCHEDULED',
      actor: 'PARTNER',
      source: 'LOGISTICS_PORTAL',
      actorLogisticsPartnerId: north.id,
      permissions: [...north.membership.permissions],
    });
  });

  it('records an ordinary forward move, not flagged as a correction', async () => {
    const response = await asDesk('POST', `/logistics/shipments/${ownShipmentId}/status-events`, {
      status: 'PICKED_UP',
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<{ status: string }>().status).toBe('PICKED_UP');

    const event = await prisma.logisticsShipmentEvent.findFirst({
      where: { shipmentId: ownShipmentId, status: 'PICKED_UP' },
      orderBy: { occurredAt: 'desc' },
      select: { isCorrection: true, source: true, actorUserId: true, reason: true },
    });

    // The distinction the whole endpoint exists for. A correction is flagged
    // for ever and reads as "the marketplace overruled this"; a move reads as
    // what it is, a parcel that moved.
    expect(event?.isCorrection).toBe(false);
    expect(event?.source).toBe('UBOSS_ADMIN');
    // The individual is on the event, and named in the marketplace's own audit
    // trail; the carrier's trail gets the label instead. Two audiences, two
    // answers, and neither can read the other's.
    expect(event?.actorUserId).not.toBeNull();
    // And no reason was demanded, because the matrix does not demand one here.
    expect(event?.reason).toBeNull();
  });

  it('writes one event when the button is pressed twice on a bad line', async () => {
    const key = `opf-${newId()}`;

    const first = await asDesk(
      'POST',
      `/logistics/shipments/${ownShipmentId}/status-events`,
      { status: 'IN_TRANSIT' },
      desk,
      { 'idempotency-key': key },
    );
    const second = await asDesk(
      'POST',
      `/logistics/shipments/${ownShipmentId}/status-events`,
      { status: 'IN_TRANSIT' },
      desk,
      { 'idempotency-key': key },
    );

    expect(first.statusCode, first.body).toBe(201);
    // 200 with `duplicate`, not an error: a phone or a desk told "that failed"
    // will try again, and the second attempt must not write a second event.
    expect(second.statusCode).toBe(200);
    expect(second.json<{ duplicate: boolean }>().duplicate).toBe(true);

    const count = await prisma.logisticsShipmentEvent.count({
      where: { shipmentId: ownShipmentId, status: 'IN_TRANSIT' },
    });
    expect(count).toBe(1);
  });

  it('refuses a move the state machine does not allow', async () => {
    const response = await asDesk('POST', `/logistics/shipments/${ownShipmentId}/status-events`, {
      status: 'ACCEPTED',
    });

    // Backwards. The way out of a status the carrier got wrong is
    // `correct-status`, which demands a written reason and marks the timeline.
    expect(response.statusCode).toBe(409);
  });

  it('records it in the marketplace own trail, naming the person', async () => {
    const entry = await prisma.auditLog.findFirst({
      where: { resourceType: 'logistics_shipment', resourceId: ownShipmentId },
      orderBy: { createdAt: 'desc' },
      select: { actorEmail: true, actorType: true },
    });

    // The other half of the split: the carrier's trail names the marketplace,
    // and the marketplace's names the individual. Neither can read the other.
    expect(entry?.actorType).toBe('ADMIN');
    expect(entry?.actorEmail).toBe(DESK_EMAIL);
  });

  it('lets an order clerk move it, because that is what the desk is for', async () => {
    const response = await asDesk(
      'POST',
      `/logistics/shipments/${ownShipmentId}/status-events`,
      { status: 'OUT_FOR_DELIVERY' },
      clerk,
    );

    expect(response.statusCode, response.body).toBe(201);
  });
});

describe('the permissions behind all of it', () => {
  it('names the two that matter, so a role change is a deliberate one', () => {
    // Stated rather than implied. `logistics.write` is the fleet register -
    // who drives, what they drive - and `logistics.assign` is putting them on
    // a parcel and moving it. A deployment that hands one out without meaning
    // to should be able to read what it just granted.
    expect(Permission.LOGISTICS_WRITE).toBe('logistics.write');
    expect(Permission.LOGISTICS_ASSIGN).toBe('logistics.assign');
  });
});
