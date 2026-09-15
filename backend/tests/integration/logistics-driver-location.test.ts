/**
 * Where a driver is, and who is allowed to know.
 *
 * Phase 1 ships the architecture and not a simulation, so what is tested here
 * is every gate in front of a position and the absence of anything that
 * invents one:
 *
 *   - no consent, no collection;
 *   - no active trip, no collection;
 *   - the trip's own device token, and nobody else's;
 *   - impossible coordinates, stale timestamps, impossible speeds and repeated
 *     sequence numbers all refused;
 *   - an offline queue flushed twice stores each position once;
 *   - reading a courier's position needs a supervisory permission, and answers
 *     null rather than a guess when nothing has been reported.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsForLogisticsRole } from '../../src/domain/logistics-permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { LogisticsMembership } from '../../src/modules/logistics/partner.service.js';
import {
  endTrip,
  readLiveLocation,
  recordLocationPing,
  setLocationConsent,
  startTrip,
} from '../../src/modules/logistics/trip.service.js';
import { createShipment } from '../../src/modules/logistics/shipment-create.service.js';

const PARTNER_CODE = 'LP-TEST-GPS';

let partnerId = '';
let driverProfileId = '';
let shipmentId = '';
let driver: LogisticsMembership;
let dispatcher: LogisticsMembership;
let viewer: LogisticsMembership;

/** Antwerp docks, and a point four kilometres away. */
const HERE = { latitude: 51.2194, longitude: 4.4025 };
const NEARBY = { latitude: 51.2494, longitude: 4.4325 };

async function cleanUp(): Promise<void> {
  const partner = await prisma.logisticsPartner.findFirst({
    where: { partnerCode: PARTNER_CODE },
    select: { id: true },
  });

  if (partner !== null) {
    const trips = await prisma.logisticsActiveTrip.findMany({
      where: { driver: { logisticsPartnerId: partner.id } },
      select: { id: true },
    });

    await prisma.logisticsLocationPing.deleteMany({
      where: { tripId: { in: trips.map((trip) => trip.id) } },
    });
    await prisma.logisticsActiveTrip.deleteMany({
      where: { driver: { logisticsPartnerId: partner.id } },
    });
    await prisma.logisticsDriverAssignment.deleteMany({
      where: { driver: { logisticsPartnerId: partner.id } },
    });
    await prisma.logisticsDriverProfile.deleteMany({
      where: { logisticsPartnerId: partner.id },
    });
    await prisma.logisticsShipmentAssignment.deleteMany({
      where: { logisticsPartnerId: partner.id },
    });
    await prisma.logisticsAuditLog.deleteMany({ where: { logisticsPartnerId: partner.id } });
    await prisma.logisticsNotification.deleteMany({ where: { logisticsPartnerId: partner.id } });
    await prisma.logisticsPartnerUser.deleteMany({ where: { logisticsPartnerId: partner.id } });
  }

  /*
   * The consignments go BEFORE the carrier.
   *
   * `LogisticsShipment.assignedPartnerId` is ON DELETE RESTRICT, deliberately:
   * deleting a carrier must never orphan the record of who carried something.
   * That makes the order here load-bearing rather than cosmetic, and getting
   * it wrong leaves rows behind that break the NEXT run's first file.
   */
  const shipments = await prisma.logisticsShipment.findMany({
    where: { receivingCompanyName: 'GPS Test Clinic' },
    select: { id: true },
  });

  const ids = shipments.map((row) => row.id);
  await prisma.logisticsShipmentEvent.deleteMany({ where: { shipmentId: { in: ids } } });
  await prisma.logisticsShipmentPackage.deleteMany({ where: { shipmentId: { in: ids } } });
  await prisma.logisticsShipmentAssignment.deleteMany({ where: { shipmentId: { in: ids } } });
  await prisma.logisticsShipment.deleteMany({ where: { id: { in: ids } } });

  if (partner !== null) {
    await prisma.logisticsPartner.deleteMany({ where: { id: partner.id } });
  }

  await prisma.user.deleteMany({
    where: { emailNormalized: { endsWith: '@gps-carrier.test' } },
  });
  await prisma.numberSequence.deleteMany({ where: { key: { startsWith: 'logistics-' } } });
}

async function makeMember(
  role: 'DRIVER' | 'DISPATCHER' | 'READ_ONLY_TRACKING_USER',
  email: string,
): Promise<LogisticsMembership> {
  const userId = newId();
  const partnerUserId = newId();

  await prisma.user.create({
    data: { id: userId, type: 'LOGISTICS', email, emailNormalized: email, status: 'ACTIVE' },
  });

  await prisma.logisticsPartnerUser.create({
    data: {
      id: partnerUserId,
      logisticsPartnerId: partnerId,
      userId,
      role,
      status: 'ACTIVE',
      fullName: `${role} person`,
    },
  });

  return {
    logisticsPartnerId: partnerId,
    partnerCode: PARTNER_CODE,
    displayName: 'GPS Carrier',
    legalName: 'GPS Carrier NV',
    partnerStatus: 'ACTIVE',
    registrationCountry: 'BE',
    partnerUserId,
    userId,
    fullName: `${role} person`,
    role,
    permissions: permissionsForLogisticsRole(role),
    canAcceptNewWork: true,
    requiresMfa: false,
    regionScope: null,
    driverProfileId: null,
  };
}

beforeAll(async () => {
  await cleanUp();

  partnerId = newId();

  await prisma.logisticsPartner.create({
    data: {
      id: partnerId,
      partnerCode: PARTNER_CODE,
      legalName: 'GPS Carrier NV',
      displayName: 'GPS Carrier',
      displayNameNormalized: 'gpscarrier',
      registrationCountry: 'BE',
      contactEmail: 'ops@gps-carrier.test',
      status: 'ACTIVE',
      contractStatus: 'ACTIVE',
    },
  });

  driver = await makeMember('DRIVER', 'driver@gps-carrier.test');
  dispatcher = await makeMember('DISPATCHER', 'dispatch@gps-carrier.test');
  viewer = await makeMember('READ_ONLY_TRACKING_USER', 'viewer@gps-carrier.test');

  driverProfileId = newId();

  await prisma.logisticsDriverProfile.create({
    data: {
      id: driverProfileId,
      logisticsPartnerId: partnerId,
      partnerUserId: driver.partnerUserId,
      state: 'ACTIVE',
    },
  });

  driver = { ...driver, driverProfileId };

  const created = await createShipment({
    sellerCompanyName: 'Northwind Medical',
    receivingCompanyName: 'GPS Test Clinic',
    pickupAddress: { line1: '1 Dock Road', city: 'Antwerp', postalCode: '2000', countryCode: 'BE' },
    deliveryAddress: { line1: '9 Clinic Way', city: 'Ghent', postalCode: '9000', countryCode: 'BE' },
    packageCount: 1,
  });

  shipmentId = created.id;

  await prisma.logisticsShipmentAssignment.create({
    data: {
      id: newId(),
      shipmentId,
      logisticsPartnerId: partnerId,
      state: 'ACCEPTED',
    },
  });

  await prisma.logisticsShipment.update({
    where: { id: shipmentId },
    data: { assignedPartnerId: partnerId, status: 'OUT_FOR_DELIVERY' },
  });

  await prisma.logisticsDriverAssignment.create({
    data: { id: newId(), shipmentId, driverProfileId },
  });
});

afterAll(async () => {
  await cleanUp();
});

describe('consent', () => {
  it('refuses to start a trip before the driver has agreed', async () => {
    /*
     * "The employer switched it on" is not consent, which is why this is a
     * column on the driver rather than a setting on the carrier.
     */
    await expect(startTrip(driver, { shipmentId })).rejects.toMatchObject({
      code: 'LOGISTICS_LOCATION_NOT_AVAILABLE',
    });
  });

  it('lets the driver agree, and then start', async () => {
    await setLocationConsent(driver, true);

    const trip = await startTrip(driver, { shipmentId });

    expect(trip.tripId).toHaveLength(26);
    expect(trip.deviceToken.length).toBeGreaterThan(20);
    expect(trip.pingIntervalSeconds).toBeGreaterThan(0);
  });
});

describe('the device token', () => {
  it('is the only thing that authorises a position', async () => {
    const trip = await currentTrip();

    await expect(
      recordLocationPing({
        tripId: trip.id,
        deviceToken: 'a-token-somebody-made-up-0000000',
        ...HERE,
        deviceTimestamp: new Date(),
        sequence: 1,
      }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_LOCATION_PING_REJECTED' });
  });

  it('accepts the real one', async () => {
    const started = await restartTrip();

    const result = await recordLocationPing({
      tripId: started.tripId,
      deviceToken: started.deviceToken,
      ...HERE,
      accuracyM: 12,
      deviceTimestamp: new Date(),
      sequence: 1,
    });

    expect(result.accepted).toBe(true);
  });
});

describe('a position that cannot be true', () => {
  it('refuses coordinates outside the world', async () => {
    const started = await restartTrip();

    await expect(
      recordLocationPing({
        tripId: started.tripId,
        deviceToken: started.deviceToken,
        latitude: 200,
        longitude: 4.4,
        deviceTimestamp: new Date(),
        sequence: 1,
      }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_LOCATION_PING_REJECTED' });
  });

  it('refuses null island, which is what a failed fix reports', async () => {
    const started = await restartTrip();

    await expect(
      recordLocationPing({
        tripId: started.tripId,
        deviceToken: started.deviceToken,
        latitude: 0,
        longitude: 0,
        deviceTimestamp: new Date(),
        sequence: 1,
      }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_LOCATION_PING_REJECTED' });
  });

  it('refuses a timestamp from yesterday', async () => {
    const started = await restartTrip();

    await expect(
      recordLocationPing({
        tripId: started.tripId,
        deviceToken: started.deviceToken,
        ...HERE,
        deviceTimestamp: new Date(Date.now() - 86_400_000),
        sequence: 1,
      }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_LOCATION_PING_REJECTED' });
  });

  it('refuses a timestamp from the future', async () => {
    const started = await restartTrip();

    await expect(
      recordLocationPing({
        tripId: started.tripId,
        deviceToken: started.deviceToken,
        ...HERE,
        deviceTimestamp: new Date(Date.now() + 600_000),
        sequence: 1,
      }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_LOCATION_PING_REJECTED' });
  });

  it('refuses a speed no van achieves', async () => {
    /*
     * Four kilometres in ten seconds is 1,440 km/h. A phone whose GPS glitches
     * reports exactly this, and drawing it would send a dispatcher's map
     * across the North Sea.
     */
    const started = await restartTrip();
    const now = Date.now();

    await recordLocationPing({
      tripId: started.tripId,
      deviceToken: started.deviceToken,
      ...HERE,
      deviceTimestamp: new Date(now - 10_000),
      sequence: 1,
    });

    await expect(
      recordLocationPing({
        tripId: started.tripId,
        deviceToken: started.deviceToken,
        ...NEARBY,
        deviceTimestamp: new Date(now),
        sequence: 2,
      }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_LOCATION_PING_REJECTED' });
  });

  it('accepts the same movement over a plausible interval', async () => {
    const started = await restartTrip();
    const now = Date.now();

    await recordLocationPing({
      tripId: started.tripId,
      deviceToken: started.deviceToken,
      ...HERE,
      deviceTimestamp: new Date(now - 600_000),
      sequence: 1,
    });

    const result = await recordLocationPing({
      tripId: started.tripId,
      deviceToken: started.deviceToken,
      ...NEARBY,
      deviceTimestamp: new Date(now),
      sequence: 2,
    });

    expect(result.accepted).toBe(true);
  });
});

describe('an offline queue flushed twice', () => {
  it('stores each position once', async () => {
    const started = await restartTrip();
    const now = Date.now();

    const ping = {
      tripId: started.tripId,
      deviceToken: started.deviceToken,
      ...HERE,
      deviceTimestamp: new Date(now - 60_000),
      sequence: 7,
      idempotencyKey: 'queued-ping-7',
    };

    const first = await recordLocationPing(ping);
    const second = await recordLocationPing(ping);

    expect(first.accepted).toBe(true);
    // Not accepted, not an error: it is already stored.
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe('DUPLICATE_SEQUENCE');

    const stored = await prisma.logisticsLocationPing.count({
      where: { tripId: started.tripId, sequence: 7 },
    });

    expect(stored).toBe(1);
  });

  it('refuses a sequence number that has gone backwards', async () => {
    const started = await restartTrip();

    await recordLocationPing({
      tripId: started.tripId,
      deviceToken: started.deviceToken,
      ...HERE,
      deviceTimestamp: new Date(),
      sequence: 5,
    });

    const replayed = await recordLocationPing({
      tripId: started.tripId,
      deviceToken: started.deviceToken,
      ...HERE,
      deviceTimestamp: new Date(),
      sequence: 3,
    });

    expect(replayed.accepted).toBe(false);
    expect(replayed.reason).toBe('DUPLICATE_SEQUENCE');
  });
});

describe('who may look', () => {
  it('shows a dispatcher where the van is', async () => {
    const started = await restartTrip();

    await recordLocationPing({
      tripId: started.tripId,
      deviceToken: started.deviceToken,
      ...HERE,
      accuracyM: 8,
      deviceTimestamp: new Date(),
      sequence: 1,
    });

    const location = await readLiveLocation(dispatcher, shipmentId);

    expect(location).not.toBeNull();
    expect(Number(location?.latitude)).toBeCloseTo(HERE.latitude, 4);
    expect(location?.accuracyM).toBe(8);
    expect(location?.ageSeconds).toBeGreaterThanOrEqual(0);
  });

  it('refuses a read-only tracking viewer', async () => {
    /*
     * A courier's whereabouts while they work is personal data about that
     * person, and reading it is a supervisory act rather than a side effect of
     * opening a page. "Where is my order" is answered by a milestone.
     */
    await expect(readLiveLocation(viewer, shipmentId)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('answers null rather than a guess once the trip has ended', async () => {
    const trip = await currentTrip();
    await endTrip(driver, trip.id, 'COMPLETED');

    const location = await readLiveLocation(dispatcher, shipmentId);

    // NULL is a real answer and the portal renders it as "Live location
    // unavailable". Nothing interpolates and nothing animates.
    expect(location).toBeNull();
  });
});

describe('withdrawing consent', () => {
  it('ends the live trip and stops collection immediately', async () => {
    const started = await restartTrip();

    await setLocationConsent(driver, false);

    await expect(
      recordLocationPing({
        tripId: started.tripId,
        deviceToken: started.deviceToken,
        ...HERE,
        deviceTimestamp: new Date(),
        sequence: 99,
      }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_LOCATION_PING_REJECTED' });

    const trip = await prisma.logisticsActiveTrip.findUniqueOrThrow({
      where: { id: started.tripId },
      select: { state: true },
    });

    expect(trip.state).toBe('COMPLETED');
  });
});

/** The driver's current ACTIVE trip. */
async function currentTrip(): Promise<{ id: string }> {
  return prisma.logisticsActiveTrip.findFirstOrThrow({
    where: { driverProfileId, state: 'ACTIVE' },
    orderBy: { startedAt: 'desc' },
    select: { id: true },
  });
}

/**
 * A fresh trip, so each case starts from a known position history.
 *
 * Starting a second trip abandons the first, which is the product's own
 * behaviour for a handset that crashed mid-round.
 */
async function restartTrip(): Promise<{ tripId: string; deviceToken: string }> {
  await setLocationConsent(driver, true);
  return startTrip(driver, { shipmentId });
}
