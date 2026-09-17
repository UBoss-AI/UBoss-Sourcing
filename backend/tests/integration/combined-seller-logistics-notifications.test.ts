/**
 * The three features working together, end to end.
 *
 * Each of the three has its own file proving it in isolation. This one exists
 * because the interesting failures are at the joins, and none of those files
 * would catch them:
 *
 *   - an approved seller's warehouse is the ORIGIN of a real consignment;
 *   - that consignment is accepted by a carrier and put on that carrier's own
 *     driver;
 *   - it walks the tracking path, hits a genuine exception, and the exception
 *     raises an operator alert;
 *   - resolving the exception clears the alert **without anybody touching the
 *     bell**, and leaves it in the resolved record;
 *   - and at no point can the second seller, or the second carrier, see any of
 *     it.
 *
 * The last one is the point of the whole file. Every other assertion here is
 * about the happy path; tenant isolation is the thing that has to hold while
 * the happy path is running.
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
import { asPartner, assignDriver } from '../../src/modules/logistics/driver.service.js';
import { readDriverAssignmentHistory } from '../../src/modules/logistics/driver-assignment.service.js';
import { raiseException, updateException } from '../../src/modules/logistics/exception.service.js';
import { createShipment } from '../../src/modules/logistics/shipment-create.service.js';
import { recordShipmentEvent } from '../../src/modules/logistics/shipment-event.service.js';
import { listShipments } from '../../src/modules/logistics/shipment.service.js';
import { listAdminNotifications } from '../../src/modules/notifications/admin-notification.service.js';
import { signInAdmin } from '../support/admin-session.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let cookies = '';

const PREFIX = 'CMBT';
const EMAIL = 'combined-desk@test.local';
const PASSWORD = 'CombinedDesk!2026';
const RECEIVER = 'Combined Test St Aubyn';

/** The approved seller whose depots the order ships from. */
let sellerId = '';
/** A second approved seller, who must never appear in the first one's answers. */
let otherSellerId = '';
let northId = '';
let north: LogisticsMembership;
/**
 * The second carrier.
 *
 * Only their membership is used - their id never needs naming, because every
 * assertion about them is that they can see NOTHING, and a query written
 * against their id would be a query this file supplied the answer to.
 */
let south: LogisticsMembership;
let driverProfileId = '';
let shipmentId = '';
let operatorUserId = '';
/** Raised in step 6, closed in step 8. */
let exceptionId = '';

const ADDRESS = { line1: '12 Dock Road', city: 'Antwerp', postalCode: '2000', countryCode: 'BE' };

interface SellerWarehouseRow {
  id: string;
  code: string;
  owner: { sellerAccountId: string | null; name: string };
  latitude: number | null;
}

async function cleanUp(): Promise<void> {
  const partnerIds = (
    await prisma.logisticsPartner.findMany({
      where: { partnerCode: { startsWith: `LP-${PREFIX}` } },
      select: { id: true },
    })
  ).map((row) => row.id);

  const shipmentIds = (
    await prisma.logisticsShipment.findMany({
      where: { receivingCompanyName: RECEIVER },
      select: { id: true },
    })
  ).map((row) => row.id);

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
  await prisma.logisticsPartnerUser.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsPartner.deleteMany({ where: { id: { in: partnerIds } } });

  await prisma.adminNotificationRead.deleteMany({
    where: { notification: { relatedType: 'logistics_shipment' } },
  });
  await prisma.adminNotification.deleteMany({ where: { relatedType: 'logistics_shipment' } });

  await prisma.sellerLocation.deleteMany({
    where: { sellerAccount: { displayName: { startsWith: PREFIX } } },
  });
  await prisma.sellerAccount.deleteMany({ where: { displayName: { startsWith: PREFIX } } });

  for (const email of [EMAIL]) {
    await prisma.userRole.deleteMany({ where: { user: { emailNormalized: email } } });
    await prisma.session.deleteMany({ where: { user: { emailNormalized: email } } });
  }
  await prisma.user.deleteMany({
    where: { OR: [{ emailNormalized: EMAIL }, { emailNormalized: { contains: '@cmbtest.local' } }] },
  });
  await prisma.numberSequence.deleteMany({ where: { key: { startsWith: 'logistics-' } } });
}

async function makeSeller(suffix: string): Promise<string> {
  const id = newId();
  const displayName = `${PREFIX} ${suffix}`;

  await prisma.sellerAccount.create({
    data: {
      id,
      legalName: `${displayName} Medical BV`,
      displayName,
      displayNameNormalized: `${PREFIX}${suffix}`.toLowerCase(),
      slug: `${PREFIX.toLowerCase()}-${suffix.toLowerCase()}`,
      status: 'APPROVED',
      approvedAt: new Date(),
      registrationCountry: 'BE',
    },
  });

  return id;
}

async function makeSellerLocation(sellerAccountId: string, code: string): Promise<string> {
  const id = newId();

  await prisma.sellerLocation.create({
    data: {
      id,
      sellerAccountId,
      code,
      name: `${code} depot`,
      addressLine1: ADDRESS.line1,
      city: ADDRESS.city,
      postcode: ADDRESS.postalCode,
      countryCode: ADDRESS.countryCode,
      timezone: 'Europe/Brussels',
      latitude: '51.2194000',
      longitude: '4.4025000',
      isOperational: true,
    },
  });

  return id;
}

async function makeCarrier(
  code: string,
  name: string,
): Promise<{ id: string; membership: LogisticsMembership }> {
  const id = newId();
  const userId = newId();
  const partnerUserId = newId();
  const email = `${code.toLowerCase()}@cmbtest.local`;

  await prisma.logisticsPartner.create({
    data: {
      id,
      partnerCode: code,
      legalName: `${name} NV`,
      displayName: name,
      displayNameNormalized: name.toLowerCase().replace(/[^a-z0-9]/g, ''),
      registrationCountry: 'BE',
      contactEmail: email,
      status: 'ACTIVE',
      contractStatus: 'ACTIVE',
    },
  });

  await prisma.user.create({
    data: { id: userId, type: 'LOGISTICS', email, emailNormalized: email, status: 'ACTIVE' },
  });

  await prisma.logisticsPartnerUser.create({
    data: {
      id: partnerUserId,
      logisticsPartnerId: id,
      userId,
      role: 'LOGISTICS_PARTNER_OWNER',
      status: 'ACTIVE',
      fullName: `${name} Owner`,
    },
  });

  return {
    id,
    membership: {
      logisticsPartnerId: id,
      partnerCode: code,
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

beforeAll(async () => {
  app = await buildApp();
  await cleanUp();

  const orderRole = await prisma.role.findUniqueOrThrow({
    where: { key: Role.ORDER_MANAGER },
    select: { id: true },
  });

  operatorUserId = newId();
  await prisma.user.create({
    data: {
      id: operatorUserId,
      type: 'ADMIN',
      email: EMAIL,
      emailNormalized: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: orderRole.id } },
    },
  });

  ({ cookies } = await signInAdmin(app, { email: EMAIL, password: PASSWORD, ip: '203.0.113.190' }));

  // 1-2. An approved seller with several depots, and a second one beside it.
  sellerId = await makeSeller('Northwind');
  otherSellerId = await makeSeller('Southgate');

  await makeSellerLocation(sellerId, `${PREFIX}-NW-A`);
  await makeSellerLocation(sellerId, `${PREFIX}-NW-B`);
  await makeSellerLocation(otherSellerId, `${PREFIX}-SG-A`);

  // Two carriers, for the same reason there are two sellers.
  const northCarrier = await makeCarrier(`LP-${PREFIX}-N`, 'Combined North');
  const southCarrier = await makeCarrier(`LP-${PREFIX}-S`, 'Combined South');

  northId = northCarrier.id;
  north = northCarrier.membership;
  south = southCarrier.membership;

  // North's own driver.
  const driverUserId = newId();
  const driverMemberId = newId();
  driverProfileId = newId();

  await prisma.user.create({
    data: {
      id: driverUserId,
      type: 'LOGISTICS',
      email: 'anja@cmbtest.local',
      emailNormalized: 'anja@cmbtest.local',
      status: 'ACTIVE',
    },
  });

  await prisma.logisticsPartnerUser.create({
    data: {
      id: driverMemberId,
      logisticsPartnerId: northId,
      userId: driverUserId,
      role: 'DRIVER',
      status: 'ACTIVE',
      fullName: 'Anja Vermeulen',
    },
  });

  await prisma.logisticsDriverProfile.create({
    data: {
      id: driverProfileId,
      logisticsPartnerId: northId,
      fullName: 'Anja Vermeulen',
      partnerUserId: driverMemberId,
      state: 'ACTIVE',
      // Cleared for the load this consignment carries. The refusal when they
      // are not has its own test; here the point is the happy path.
      canCarryColdChain: true,
    },
  });
});

afterAll(async () => {
  await cleanUp();
  await app.close();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe('the whole journey', () => {
  it('1. finds the approved seller from the console', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/inventory/seller-search?q=${PREFIX}`,
      headers: { cookie: cookies },
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ sellers: { sellerAccountId: string; status: string }[] }>();

    const ids = body.sellers.map((row) => row.sellerAccountId);
    expect(ids).toContain(sellerId);
    // Both are approved, so both are offerable - which is what makes the
    // isolation assertions below meaningful rather than vacuous.
    expect(ids).toContain(otherSellerId);
  });

  it('2. shows that seller’s depots, and nobody else’s', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/inventory/seller-warehouses?sellerAccountId=${sellerId}`,
      headers: { cookie: cookies },
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ warehouses: SellerWarehouseRow[] }>();
    const own = body.warehouses.filter((row) => row.code.startsWith(PREFIX));

    expect(own.map((row) => row.code).sort()).toEqual([`${PREFIX}-NW-A`, `${PREFIX}-NW-B`]);
    // The map and the table are handed the same rows, so a placed depot has a
    // position here or it is on neither.
    expect(own.every((row) => row.latitude !== null)).toBe(true);
    expect(own.every((row) => row.owner.sellerAccountId === sellerId)).toBe(true);
  });

  it('3. raises a consignment from that seller, and puts it on a carrier', async () => {
    const created = await createShipment({
      sellerAccountId: sellerId,
      sellerCompanyName: `${PREFIX} Northwind`,
      receivingCompanyName: RECEIVER,
      pickupAddress: ADDRESS,
      deliveryAddress: { ...ADDRESS, city: 'Ghent', postalCode: '9000' },
      packageCount: 2,
      totalWeightGrams: 6000,
      requiresColdChain: true,
    });

    shipmentId = created.id;

    await prisma.logisticsShipment.update({
      where: { id: shipmentId },
      data: { status: 'AWAITING_ASSIGNMENT' },
    });

    await offerAssignment({
      shipmentId,
      logisticsPartnerId: northId,
      offeredByUserId: null,
      automatic: false,
    });

    await acceptAssignment(north, shipmentId);

    const row = await prisma.logisticsShipment.findUniqueOrThrow({
      where: { id: shipmentId },
      select: { assignedPartnerId: true, sellerAccountId: true, status: true },
    });

    expect(row.assignedPartnerId).toBe(northId);
    expect(row.sellerAccountId).toBe(sellerId);
  });

  it('4. puts the carrier’s own driver on it', async () => {
    const result = await assignDriver(asPartner(north), { shipmentId, driverProfileId });
    expect(result.replacedAssignmentId).toBeNull();

    const history = await readDriverAssignmentHistory(shipmentId);
    expect(history).toHaveLength(1);
    expect(history[0]?.driverName).toBe('Anja Vermeulen');
    expect(history[0]?.isActive).toBe(true);
  });

  it('5. walks it along the tracking path', async () => {
    for (const status of ['PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT'] as const) {
      await recordShipmentEvent({
        shipmentId,
        status,
        actor: 'PARTNER',
        source: 'LOGISTICS_PORTAL',
        actorLogisticsPartnerId: northId,
        permissions: [...north.permissions],
      });
    }

    const row = await prisma.logisticsShipment.findUniqueOrThrow({
      where: { id: shipmentId },
      select: { status: true },
    });
    expect(row.status).toBe('IN_TRANSIT');
  });

  it('6. an exception raises an alert on the operator’s bell', async () => {
    const raised = await raiseException({
      shipmentId,
      logisticsPartnerId: northId,
      type: 'TEMPERATURE_EXCURSION',
      reason: 'Reefer failed between Antwerp and Ghent.',
    });

    expect(raised.severity).toBe('CRITICAL');

    const viewer = { userId: operatorUserId, permissions: [Permission.LOGISTICS_READ] };
    const feed = await listAdminNotifications(viewer);

    const alert = feed.items.find((item) => item.kind === 'logistics.exception.raised');
    expect(alert).toBeDefined();
    expect(alert?.class).toBe('ALERT');
    // On the badge, which is the whole point of an alert: nobody has to have
    // opened anything for it to be counted.
    expect(feed.openAlertCount).toBeGreaterThanOrEqual(1);

    // Kept for step 8, which is where it is closed.
    exceptionId = raised.id;
  });

  it('7. reading the alert does not clear it', async () => {
    const viewer = { userId: operatorUserId, permissions: [Permission.LOGISTICS_READ] };
    const before = await listAdminNotifications(viewer);
    const alert = before.items.find((item) => item.kind === 'logistics.exception.raised');

    await prisma.adminNotificationRead.create({
      data: { notificationId: alert?.id ?? '', userId: operatorUserId },
    });

    const after = await listAdminNotifications(viewer);
    // Read, and still a problem. This is the distinction the whole first phase
    // exists to draw.
    expect(after.items.find((item) => item.id === alert?.id)?.isRead).toBe(true);
    expect(after.openAlertCount).toBeGreaterThanOrEqual(1);
  });

  it('8. closing the exception clears the alert, without anybody touching the bell', async () => {
    await updateException(north, exceptionId, {
      state: 'RESOLVED',
      resolutionNotes: 'Load quarantined at Ghent; buyer re-supplied from the second depot.',
    });

    const viewer = { userId: operatorUserId, permissions: [Permission.LOGISTICS_READ] };
    const active = await listAdminNotifications(viewer);

    expect(active.items.some((item) => item.kind === 'logistics.exception.raised')).toBe(false);
  });

  it('9. and it is still in the resolved record, with the reason', async () => {
    const viewer = { userId: operatorUserId, permissions: [Permission.LOGISTICS_READ] };
    const history = await listAdminNotifications(viewer, { view: 'resolved' });

    const closed = history.items.find((item) => item.kind === 'logistics.exception.raised');

    expect(closed?.status).toBe('RESOLVED');
    expect(closed?.resolutionSource).toBe('DOMAIN_EVENT');
    expect(closed?.resolutionReason).toContain('quarantined');
  });

  it('10. the operator sees the company, the carrier and the driver on one row', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/logistics/shipments?sellerAccountId=${sellerId}`,
      headers: { cookie: cookies },
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{
      shipments: {
        id: string;
        sellerCompanyName: string;
        assignedPartner: { displayName: string } | null;
        driver: { fullName: string } | null;
      }[];
    }>();

    const row = body.shipments.find((entry) => entry.id === shipmentId);

    expect(row?.sellerCompanyName).toBe(`${PREFIX} Northwind`);
    expect(row?.assignedPartner?.displayName).toBe('Combined North');
    expect(row?.driver?.fullName).toBe('Anja Vermeulen');
  });
});

describe('and nobody else can see any of it', () => {
  it('the second carrier cannot list the consignment', async () => {
    const theirs = await listShipments(south, {}, { pageSize: 100 });
    expect(theirs.rows.map((row) => row.id)).not.toContain(shipmentId);
  });

  it('the second carrier cannot put their driver on it', async () => {
    const failure = await assignDriver(asPartner(south), { shipmentId, driverProfileId }).catch(
      (error: unknown) => error,
    );

    // 404, not 403. South has no business learning that North's consignment
    // exists, let alone which of North's drivers is on it.
    expect((failure as { statusCode: number }).statusCode).toBe(404);
  });

  it("the second seller's depots never answer under the first seller's id", async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/inventory/seller-warehouses?sellerAccountId=${sellerId}`,
      headers: { cookie: cookies },
    });

    const body = response.json<{ warehouses: SellerWarehouseRow[] }>();
    expect(body.warehouses.map((row) => row.code)).not.toContain(`${PREFIX}-SG-A`);
  });

  it('a member of staff without the logistics grant sees no alert about it', async () => {
    // Everything the Order Manager has except `logistics.read`, which is the
    // grant the exception alert carries.
    const feed = await listAdminNotifications({
      userId: operatorUserId,
      permissions: [Permission.ORDER_READ, Permission.PRODUCT_READ],
    });

    expect(feed.items.some((item) => item.kind === 'logistics.exception.raised')).toBe(false);
    expect(feed.items.some((item) => item.kind === 'logistics.delivery_failed')).toBe(false);
  });
});
