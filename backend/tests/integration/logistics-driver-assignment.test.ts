/**
 * Putting a driver on a consignment - integration, against a real MariaDB.
 *
 * The claims under test are the ones a service-level filter cannot make:
 *
 *   - **One live driver per consignment, guaranteed by the database.** Two
 *     dispatchers pressing Assign at the same moment must produce one live
 *     assignment and one honest refusal, not two vans. That is
 *     `uq_logistics_driver_active` doing its job, and it needs a real database
 *     to prove.
 *   - **A reassignment is a link, not an overwrite.** Who had it before, why
 *     they came off, and in what order - all readable afterwards.
 *   - **The refusals hold.** Another carrier's driver, an inactive driver, a
 *     finished consignment, a reassignment with no reason.
 *   - **A delivered parcel leaves its driver's task list**, which is a fact
 *     about a transaction in `recordShipmentEvent` rather than about this
 *     service at all.
 *
 * Two carriers throughout, because the interesting half of tenant isolation is
 * what happens when the second one exists.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/domain/errors.js';
import { permissionsForLogisticsRole } from '../../src/domain/logistics-permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { LogisticsMembership } from '../../src/modules/logistics/partner.service.js';
import {
  asOperator,
  asPartner,
  assignDriver,
  createDriver,
  listDrivers,
  unassignDriver,
  updateDriver,
} from '../../src/modules/logistics/driver.service.js';
import { readDriverAssignmentHistory } from '../../src/modules/logistics/driver-assignment.service.js';
import { recordShipmentEvent } from '../../src/modules/logistics/shipment-event.service.js';
import { createShipment } from '../../src/modules/logistics/shipment-create.service.js';
import {
  acceptAssignment,
  offerAssignment,
} from '../../src/modules/logistics/assignment.service.js';

const NORTH_CODE = 'LP-TEST-DRV-N';
const SOUTH_CODE = 'LP-TEST-DRV-S';
const RECEIVER = 'Driver Assignment Test Hospital';

interface Carrier {
  id: string;
  membership: LogisticsMembership;
  /** driverProfileId, by the name this file gave them. */
  drivers: Map<string, string>;
}

let north: Carrier;
let south: Carrier;
let shipmentId = '';
/** A member of the marketplace staff, for the operator-side cases. */
let operatorUserId = '';

const ADDRESS = { line1: '4 Dock Road', city: 'Antwerp', postalCode: '2000', countryCode: 'BE' };

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
  await prisma.user.deleteMany({ where: { emailNormalized: { contains: '@drvtest.local' } } });

  await prisma.adminNotificationRead.deleteMany({
    where: { notification: { relatedType: 'logistics_shipment' } },
  });
  await prisma.adminNotification.deleteMany({ where: { relatedType: 'logistics_shipment' } });
  await prisma.numberSequence.deleteMany({ where: { key: { startsWith: 'logistics-' } } });
}

async function makeCarrier(partnerCode: string, name: string): Promise<Carrier> {
  const id = newId();
  const ownerUserId = newId();
  const partnerUserId = newId();
  const email = `${partnerCode.toLowerCase()}@drvtest.local`;

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
    drivers: new Map(),
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
 * A member of a carrier, in whatever role.
 *
 * No driver profile. This is the state somebody is in before the portal's
 * driver form touches them - which is the whole point of the cases that use
 * it.
 */
async function makeMember(
  carrier: Carrier,
  name: string,
  role: 'DISPATCHER' | 'DRIVER' | 'OPERATIONS_AGENT',
): Promise<string> {
  const userId = newId();
  const partnerUserId = newId();
  const email = `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}@drvtest.local`;

  await prisma.user.create({
    data: { id: userId, type: 'LOGISTICS', email, emailNormalized: email, status: 'ACTIVE' },
  });

  await prisma.logisticsPartnerUser.create({
    data: {
      id: partnerUserId,
      logisticsPartnerId: carrier.id,
      userId,
      role,
      status: 'ACTIVE',
      fullName: name,
    },
  });

  return partnerUserId;
}

/** A driver on a carrier, created the way the portal creates one. */
async function makeDriver(
  carrier: Carrier,
  name: string,
  options: { state?: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED'; coldChain?: boolean } = {},
): Promise<string> {
  const userId = newId();
  const partnerUserId = newId();
  const profileId = newId();
  const email = `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}@drvtest.local`;

  await prisma.user.create({
    data: { id: userId, type: 'LOGISTICS', email, emailNormalized: email, status: 'ACTIVE' },
  });

  await prisma.logisticsPartnerUser.create({
    data: {
      id: partnerUserId,
      logisticsPartnerId: carrier.id,
      userId,
      role: 'DRIVER',
      status: 'ACTIVE',
      fullName: name,
    },
  });

  await prisma.logisticsDriverProfile.create({
    data: {
      id: profileId,
      logisticsPartnerId: carrier.id,
      fullName: name,
      partnerUserId,
      state: options.state ?? 'ACTIVE',
      canCarryColdChain: options.coldChain ?? false,
    },
  });

  carrier.drivers.set(name, profileId);
  return profileId;
}

/**
 * A consignment, offered to and accepted by a carrier, exactly as the product
 * does it.
 *
 * The offer and the acceptance are not decoration: `assertShipmentAccess`
 * filters on a live `LogisticsShipmentAssignment` rather than on
 * `assignedPartnerId`, so a fixture that set the denormalised column alone
 * would be testing against an access path the product does not have.
 */
async function makeShipment(
  carrier: Carrier,
  options: { coldChain?: boolean } = {},
): Promise<string> {
  const created = await createShipment({
    sellerCompanyName: 'Northwind Medical',
    receivingCompanyName: RECEIVER,
    pickupAddress: ADDRESS,
    deliveryAddress: { ...ADDRESS, city: 'Ghent', postalCode: '9000' },
    packageCount: 1,
    totalWeightGrams: 2500,
    ...(options.coldChain === true ? { requiresColdChain: true } : {}),
  });

  await prisma.logisticsShipment.update({
    where: { id: created.id },
    data: { status: 'AWAITING_ASSIGNMENT' },
  });

  await offerAssignment({
    shipmentId: created.id,
    logisticsPartnerId: carrier.id,
    offeredByUserId: null,
    automatic: false,
  });

  await acceptAssignment(carrier.membership, created.id);

  return created.id;
}

beforeEach(async () => {
  await cleanUp();

  north = await makeCarrier(NORTH_CODE, 'North Courier');
  south = await makeCarrier(SOUTH_CODE, 'South Courier');

  operatorUserId = newId();
  await prisma.user.create({
    data: {
      id: operatorUserId,
      type: 'ADMIN',
      email: 'operator@drvtest.local',
      emailNormalized: 'operator@drvtest.local',
      status: 'ACTIVE',
    },
  });

  await makeDriver(north, 'Anja Vermeulen');
  await makeDriver(north, 'Bram de Wit');
  await makeDriver(north, 'Cato Jansen', { state: 'INACTIVE' });
  await makeDriver(south, 'Dirk Peeters');

  shipmentId = await makeShipment(north);

  // Moving. The ordinary state for a driver assignment - the acceptance above
  // leaves it ACCEPTED, and a parcel gets a driver once it is on the road.
  await prisma.logisticsShipment.update({
    where: { id: shipmentId },
    data: { status: 'IN_TRANSIT' },
  });
});

afterAll(async () => {
  await cleanUp();
  await prisma.$disconnect();
});

const driverOf = (carrier: Carrier, name: string): string => {
  const id = carrier.drivers.get(name);
  if (id === undefined) throw new Error(`no driver ${name}`);
  return id;
};

// ---------------------------------------------------------------------------

describe('adding a driver', () => {
  it('takes a typed name and nothing else', async () => {
    // The whole point of the change. A carrier employs people who will never
    // open this software, and a register that could only hold people with a
    // login is a register that does not describe the fleet.
    const created = await createDriver(asPartner(north.membership), {
      fullName: 'Marek Nowak',
      phone: '+32 470 11 22 33',
      employeeReference: 'NC-201',
      canCarryColdChain: true,
    });

    expect(created.fullName).toBe('Marek Nowak');
    expect(created.phone).toBe('+32 470 11 22 33');
    expect(created.state).toBe('ACTIVE');
    expect(created.canCarryColdChain).toBe(true);
    // No account, and the flag that says so is what the portal reads to
    // explain why this driver cannot use the phone app.
    expect(created.partnerUserId).toBeNull();
    expect(created.hasPortalAccess).toBe(false);
    // A brand-new driver holds nothing, which is what the picker shows
    // beside each name so a dispatcher can tell who is free.
    expect(created.openTasks).toBe(0);
  });

  it('refuses a record with no name on it', async () => {
    const failure = await createDriver(asPartner(north.membership), {
      fullName: ' ',
    }).catch((error: unknown) => error);

    expect((failure as { code: string }).code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('links a colleague account when one is supplied, which is what turns the phone app on', async () => {
    const dispatcher = await makeMember(north, 'Kris Aerts', 'DISPATCHER');

    const created = await createDriver(asPartner(north.membership), {
      fullName: 'Kris Aerts',
      partnerUserId: dispatcher,
    });

    expect(created.partnerUserId).toBe(dispatcher);
    expect(created.hasPortalAccess).toBe(true);
  });

  it('refuses a second driver record on one account', async () => {
    const member = await makeMember(north, 'Dries Peeters', 'DRIVER');

    await createDriver(asPartner(north.membership), {
      fullName: 'Dries Peeters',
      partnerUserId: member,
    });

    const failure = await createDriver(asPartner(north.membership), {
      fullName: 'Dries Peeters again',
      partnerUserId: member,
    }).catch((error: unknown) => error);

    expect((failure as { code: string }).code).toBe(ErrorCode.LOGISTICS_DRIVER_NOT_ELIGIBLE);
  });

  it("refuses another carrier's member outright", async () => {
    const failure = await createDriver(asPartner(north.membership), {
      fullName: 'Somebody Else',
      partnerUserId: south.membership.partnerUserId,
    }).catch((error: unknown) => error);

    // 404: North has no business learning that South has people at all.
    expect((failure as { statusCode: number }).statusCode).toBe(404);
  });

  it('edits an existing record without disturbing what they are carrying', async () => {
    await assignDriver(asPartner(north.membership), {
      shipmentId,
      driverProfileId: driverOf(north, 'Anja Vermeulen'),
    });

    await updateDriver(asPartner(north.membership), driverOf(north, 'Anja Vermeulen'), {
      licenceNumber: 'B-99887766',
    });

    const updated = (await listDrivers(asPartner(north.membership))).find(
      (row) => row.fullName === 'Anja Vermeulen',
    );

    expect(updated?.licenceNumber).toBe('B-99887766');
    // The consignment is still theirs. Editing a licence number is not a
    // reason to take somebody off a round.
    expect(updated?.openTasks).toBe(1);
  });

  it('writes only the fields it was given', async () => {
    const created = await createDriver(asPartner(north.membership), {
      fullName: 'Ilse Cools',
      canCarryColdChain: true,
      canCarrySterile: true,
      employeeReference: 'NC-303',
    });

    // The bug the old whole-record upsert made easy: correcting one field
    // silently clearing the three beside it.
    await updateDriver(asPartner(north.membership), created.id, {
      licenceNumber: 'B-12341234',
    });

    const after = (await listDrivers(asPartner(north.membership))).find(
      (row) => row.id === created.id,
    );

    expect(after?.licenceNumber).toBe('B-12341234');
    expect(after?.canCarryColdChain).toBe(true);
    expect(after?.canCarrySterile).toBe(true);
    expect(after?.employeeReference).toBe('NC-303');
    expect(after?.fullName).toBe('Ilse Cools');
  });

  it("refuses to edit a driver on another carrier's fleet", async () => {
    const failure = await updateDriver(
      asPartner(north.membership),
      driverOf(south, 'Dirk Peeters'),
      { licenceNumber: 'B-00000000' },
    ).catch((error: unknown) => error);

    expect((failure as { statusCode: number }).statusCode).toBe(404);
  });

  it("lets the marketplace add a driver to a carrier's fleet", async () => {
    // The operations desk takes these over the phone from hauliers who do not
    // use the portal. Same service function, different actor - which is the
    // point of `FleetActor` rather than a second implementation.
    const created = await createDriver(
      asOperator({ logisticsPartnerId: north.id, userId: operatorUserId }),
      { fullName: 'Rik Delvaux', phone: '+32 470 99 88 77' },
    );

    expect(created.fullName).toBe('Rik Delvaux');
    expect(created.hasPortalAccess).toBe(false);

    // And the carrier sees them in their own fleet, because there is only one
    // fleet. Two registers that had to be reconciled would be the bug.
    const fleet = await listDrivers(asPartner(north.membership));
    expect(fleet.some((row) => row.fullName === 'Rik Delvaux')).toBe(true);
  });

  it("refuses the marketplace a driver on the wrong carrier", async () => {
    const failure = await updateDriver(
      asOperator({ logisticsPartnerId: south.id, userId: operatorUserId }),
      driverOf(north, 'Anja Vermeulen'),
      { licenceNumber: 'B-55555555' },
    ).catch((error: unknown) => error);

    // An admin grant is authority over the marketplace, not permission to move
    // a driver between two businesses that have never met.
    expect((failure as { statusCode: number }).statusCode).toBe(404);
  });
});

describe('a carrier assigning its own driver', () => {
  it('puts them on it, and the consignment shows one live assignment', async () => {
    const result = await assignDriver(asPartner(north.membership), {
      shipmentId,
      driverProfileId: driverOf(north, 'Anja Vermeulen'),
    });

    expect(result.replacedAssignmentId).toBeNull();

    const live = await prisma.logisticsDriverAssignment.findMany({
      where: { shipmentId, unassignedAt: null },
      select: { id: true, activeShipmentId: true },
    });

    expect(live).toHaveLength(1);
    // The marker the unique index is built on. Set together with the
    // assignment, always.
    expect(live[0]?.activeShipmentId).toBe(shipmentId);
  });

  it('tells the carrier, as a problem-free piece of news', async () => {
    await assignDriver(asPartner(north.membership), {
      shipmentId,
      driverProfileId: driverOf(north, 'Anja Vermeulen'),
    });

    const notification = await prisma.logisticsNotification.findFirstOrThrow({
      where: { logisticsPartnerId: north.id, kind: 'DRIVER_ASSIGNED' },
      select: { class: true, status: true, title: true },
    });

    // News, not an alert: an assignment is over once somebody has read it.
    expect(notification.class).toBe('INFORMATION');
    expect(notification.title).toContain('Anja Vermeulen');
  });

  it('is a no-op when the same driver is assigned twice', async () => {
    const first = await assignDriver(asPartner(north.membership), {
      shipmentId,
      driverProfileId: driverOf(north, 'Anja Vermeulen'),
    });

    const second = await assignDriver(asPartner(north.membership), {
      shipmentId,
      driverProfileId: driverOf(north, 'Anja Vermeulen'),
    });

    // A dispatcher pressing Assign twice on one name has changed nothing, and
    // must not produce a second row or a reassignment history entry.
    expect(second.assignmentId).toBe(first.assignmentId);
    expect(await prisma.logisticsDriverAssignment.count({ where: { shipmentId } })).toBe(1);
  });
});

describe('the refusals', () => {
  it("refuses another carrier's driver", async () => {
    const failure = await assignDriver(asPartner(north.membership), {
      shipmentId,
      driverProfileId: driverOf(south, 'Dirk Peeters'),
    }).catch((error: unknown) => error);

    expect((failure as { code: string }).code).toBe(ErrorCode.LOGISTICS_DRIVER_NOT_ELIGIBLE);
    expect(await prisma.logisticsDriverAssignment.count({ where: { shipmentId } })).toBe(0);
  });

  it('refuses a driver who is not active', async () => {
    const failure = await assignDriver(asPartner(north.membership), {
      shipmentId,
      driverProfileId: driverOf(north, 'Cato Jansen'),
    }).catch((error: unknown) => error);

    // Same code and same message as another carrier's driver, deliberately:
    // distinguishing them would confirm that the other carrier's driver
    // exists.
    expect((failure as { code: string }).code).toBe(ErrorCode.LOGISTICS_DRIVER_NOT_ELIGIBLE);
  });

  it('refuses a consignment that is already finished', async () => {
    await prisma.logisticsShipment.update({
      where: { id: shipmentId },
      data: { status: 'DELIVERED' },
    });

    const failure = await assignDriver(asPartner(north.membership), {
      shipmentId,
      driverProfileId: driverOf(north, 'Anja Vermeulen'),
    }).catch((error: unknown) => error);

    // A stop on somebody's round for a parcel already in a hospital is a
    // driver sent to a door for nothing.
    expect((failure as { code: string }).code).toBe(ErrorCode.SHIPMENT_TRANSITION_NOT_ALLOWED);
  });

  it('refuses a driver not cleared for the load', async () => {
    const coldId = await makeShipment(north, { coldChain: true });
    await prisma.logisticsShipment.update({
      where: { id: coldId },
      data: { status: 'IN_TRANSIT' },
    });

    const failure = await assignDriver(asPartner(north.membership), {
      shipmentId: coldId,
      driverProfileId: driverOf(north, 'Anja Vermeulen'),
    }).catch((error: unknown) => error);

    expect((failure as { code: string }).code).toBe(ErrorCode.LOGISTICS_DRIVER_NOT_ELIGIBLE);
    expect((failure as { message: string }).message).toContain('cold chain');
  });

  it("refuses another carrier's consignment outright", async () => {
    const failure = await assignDriver(asPartner(south.membership), {
      shipmentId,
      driverProfileId: driverOf(south, 'Dirk Peeters'),
    }).catch((error: unknown) => error);

    // 404 rather than 403: South has no business learning that North's
    // consignment exists.
    expect((failure as { statusCode: number }).statusCode).toBe(404);
  });
});

describe('moving a consignment between drivers', () => {
  it('requires a reason for taking the first one off', async () => {
    await assignDriver(asPartner(north.membership), {
      shipmentId,
      driverProfileId: driverOf(north, 'Anja Vermeulen'),
    });

    const failure = await assignDriver(asPartner(north.membership), {
      shipmentId,
      driverProfileId: driverOf(north, 'Bram de Wit'),
    }).catch((error: unknown) => error);

    expect((failure as { code: string }).code).toBe(ErrorCode.VALIDATION_FAILED);
    // Nothing moved. A refused reassignment must not have taken the first
    // driver off on its way to failing.
    const live = await prisma.logisticsDriverAssignment.findMany({
      where: { shipmentId, unassignedAt: null },
      select: { driverProfileId: true },
    });
    expect(live).toHaveLength(1);
    expect(live[0]?.driverProfileId).toBe(driverOf(north, 'Anja Vermeulen'));
  });

  it('keeps the whole chain, in order, with each reason', async () => {
    await assignDriver(asPartner(north.membership), {
      shipmentId,
      driverProfileId: driverOf(north, 'Anja Vermeulen'),
    });

    const second = await assignDriver(asPartner(north.membership), {
      shipmentId,
      driverProfileId: driverOf(north, 'Bram de Wit'),
      reason: 'Anja called in sick.',
    });

    const history = await readDriverAssignmentHistory(shipmentId);

    expect(history).toHaveLength(2);
    // Oldest first: a chain reads forwards.
    expect(history[0]?.driverName).toBe('Anja Vermeulen');
    expect(history[0]?.isActive).toBe(false);
    expect(history[0]?.unassignedReason).toBe('Anja called in sick.');
    expect(history[1]?.driverName).toBe('Bram de Wit');
    expect(history[1]?.isActive).toBe(true);
    // The link, not a guess from timestamps.
    expect(history[1]?.previousAssignmentId).toBe(history[0]?.id);
    expect(second.replacedAssignmentId).toBe(history[0]?.id);
  });

  it('records who made the change', async () => {
    await assignDriver(asPartner(north.membership), {
      shipmentId,
      driverProfileId: driverOf(north, 'Anja Vermeulen'),
    });

    const history = await readDriverAssignmentHistory(shipmentId);
    expect(history[0]?.assignedByName).toBe('North Courier Owner');
  });

  it('announces the move with the reason, as its own kind', async () => {
    await assignDriver(asPartner(north.membership), {
      shipmentId,
      driverProfileId: driverOf(north, 'Anja Vermeulen'),
    });
    await assignDriver(asPartner(north.membership), {
      shipmentId,
      driverProfileId: driverOf(north, 'Bram de Wit'),
      reason: 'Van broke down at the depot.',
    });

    const moved = await prisma.logisticsNotification.findFirstOrThrow({
      where: { logisticsPartnerId: north.id, kind: 'DRIVER_REASSIGNED' },
      select: { body: true, variablesJson: true },
    });

    expect(moved.body).toBe('Van broke down at the depot.');
  });
});

describe('two dispatchers at once', () => {
  it('produces one live assignment and one honest refusal', async () => {
    const [a, b] = await Promise.allSettled([
      assignDriver(asPartner(north.membership), {
        shipmentId,
        driverProfileId: driverOf(north, 'Anja Vermeulen'),
      }),
      assignDriver(asPartner(north.membership), {
        shipmentId,
        driverProfileId: driverOf(north, 'Bram de Wit'),
      }),
    ]);

    const settled = [a, b];
    const won = settled.filter((result) => result.status === 'fulfilled');
    const lost = settled.filter((result) => result.status === 'rejected');

    /*
     * Exactly one of each. This is `uq_logistics_driver_active` doing the work
     * a transaction alone could not: both reads saw "nothing live here", and
     * the database is what stopped them both writing one.
     */
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);

    const live = await prisma.logisticsDriverAssignment.findMany({
      where: { shipmentId, unassignedAt: null },
    });
    expect(live).toHaveLength(1);
  });
});

describe('taking a driver off without replacing them', () => {
  it('leaves the consignment with nobody on it, and says why', async () => {
    await assignDriver(asPartner(north.membership), {
      shipmentId,
      driverProfileId: driverOf(north, 'Anja Vermeulen'),
    });

    await unassignDriver(asPartner(north.membership), shipmentId, 'Round cancelled; nobody to cover it.');

    expect(
      await prisma.logisticsDriverAssignment.count({ where: { shipmentId, unassignedAt: null } }),
    ).toBe(0);

    const history = await readDriverAssignmentHistory(shipmentId);
    expect(history[0]?.unassignedReason).toBe('Round cancelled; nobody to cover it.');
  });

  it('frees the consignment for the next driver', async () => {
    await assignDriver(asPartner(north.membership), {
      shipmentId,
      driverProfileId: driverOf(north, 'Anja Vermeulen'),
    });
    await unassignDriver(asPartner(north.membership), shipmentId, 'Sick.');

    // The unique index must not keep refusing after the row it was guarding is
    // over - which is why `activeShipmentId` is cleared alongside
    // `unassignedAt` rather than being left behind.
    await expect(
      assignDriver(asPartner(north.membership), {
        shipmentId,
        driverProfileId: driverOf(north, 'Bram de Wit'),
      }),
    ).resolves.toMatchObject({ replacedAssignmentId: null });
  });

  it('is idempotent when nobody is on it', async () => {
    const result = await unassignDriver(asPartner(north.membership), shipmentId, 'Nobody there anyway.');
    expect(result.unassignedAssignmentId).toBeNull();
  });
});

describe('when the consignment finishes', () => {
  it("comes off the driver's open work", async () => {
    await assignDriver(asPartner(north.membership), {
      shipmentId,
      driverProfileId: driverOf(north, 'Anja Vermeulen'),
    });

    const before = await listDrivers(asPartner(north.membership));
    expect(before.find((row) => row.fullName === 'Anja Vermeulen')?.openTasks).toBe(1);

    // Through the real tracking path, not by writing the column. DELIVERED
    // carries a proof-of-delivery requirement from the state machine - stated
    // here rather than worked around, because a test that bypassed it would
    // be exercising a transition the product does not allow.
    await recordShipmentEvent({
      shipmentId,
      status: 'OUT_FOR_DELIVERY',
      actor: 'UBOSS_ADMIN',
      source: 'UBOSS_ADMIN',
    });

    await recordShipmentEvent({
      shipmentId,
      status: 'DELIVERED',
      actor: 'UBOSS_ADMIN',
      source: 'UBOSS_ADMIN',
      hasProofOfDelivery: true,
    });

    const after = await listDrivers(asPartner(north.membership));
    // Without this the number on the fleet screen only ever goes up, which is
    // how a dispatcher stops reading it.
    expect(after.find((row) => row.fullName === 'Anja Vermeulen')?.openTasks).toBe(0);

    const history = await readDriverAssignmentHistory(shipmentId);
    expect(history[0]?.completedAt).not.toBeNull();
    expect(history[0]?.isActive).toBe(false);
  });
});
