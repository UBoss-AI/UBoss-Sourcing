/**
 * The operator's tracking desk, over HTTP.
 *
 * `logistics-admin-oversight.test.ts` proves the routes exist and are behind
 * the right permissions. This file proves the thing the desk is actually FOR:
 * that the list can be narrowed on every axis an operations question comes in
 * on, and that the answer above the table describes the list underneath it.
 *
 * The axes matter because they are the ones no carrier's own portal can offer.
 * "What is going wrong for St Luke's", "is Northwind's stock stuck at one
 * depot", "which of this carrier's drivers has our failures" all cross tenants,
 * and an operator who cannot ask on the axis they care about ends up paging
 * through everything.
 *
 * Also here: the failed-delivery alert, because it is where Phase 1 and the
 * tracking machinery meet. It is raised by a status change, it is cleared by
 * the parcel moving again, and reading it does neither.
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
import { createShipment } from '../../src/modules/logistics/shipment-create.service.js';
import { recordShipmentEvent } from '../../src/modules/logistics/shipment-event.service.js';
import { listAdminNotifications } from '../../src/modules/notifications/admin-notification.service.js';
import { signInAdmin } from '../support/admin-session.js';

let app: Awaited<ReturnType<typeof buildApp>>;

/** An Order Manager: logistics.read and logistics.assign. */
let cookies = '';

const EMAIL = 'tracking-desk@test.local';
const PASSWORD = 'TrackingDesk!2026';
const PARTNER_CODE = 'LP-TEST-TRACK';
const RECEIVER_A = 'Tracking Test St Luke';
const RECEIVER_B = 'Tracking Test Riverside';
const SELLER_NAME = 'Tracking Test Northwind';

let carrier: { id: string; membership: LogisticsMembership };
let driverProfileId = '';
let warehouseId = '';
let sellerAccountId = '';
let customerProfileId = '';

/** reference -> id, for the four consignments this file builds. */
const shipments = new Map<string, string>();

const ADDRESS = { line1: '7 Dock Road', city: 'Antwerp', postalCode: '2000', countryCode: 'BE' };

interface TrackingRow {
  id: string;
  shipmentReference: string;
  status: string;
  sellerCompanyName: string;
  receivingCompanyName: string;
  assignedPartner: { id: string; displayName: string } | null;
  originLocation: { id: string; name: string; code: string } | null;
  driver: { driverProfileId: string; fullName: string } | null;
  openException: { id: string; type: string; severity: string } | null;
}

interface TrackingPage {
  shipments: TrackingRow[];
  total: number;
  page: number;
  pageCount: number;
  summary: {
    awaitingAssignment: number;
    accepted: number;
    inTransit: number;
    outForDelivery: number;
    delivered: number;
    failed: number;
    returned: number;
    cancelled: number;
    withOpenException: number;
  };
}

async function track(query = ''): Promise<TrackingPage> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/admin/logistics/shipments${query === '' ? '' : `?${query}`}`,
    headers: { cookie: cookies },
  });

  expect(response.statusCode, response.body).toBe(200);
  return response.json<TrackingPage>();
}

/** Only this file's consignments. The suite shares one database. */
function own(rows: TrackingRow[]): TrackingRow[] {
  return rows.filter((row) => [RECEIVER_A, RECEIVER_B].includes(row.receivingCompanyName));
}

async function cleanUp(): Promise<void> {
  const partnerIds = (
    await prisma.logisticsPartner.findMany({
      where: { partnerCode: PARTNER_CODE },
      select: { id: true },
    })
  ).map((row) => row.id);

  const shipmentIds = (
    await prisma.logisticsShipment.findMany({
      where: { receivingCompanyName: { in: [RECEIVER_A, RECEIVER_B] } },
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

  await prisma.sellerAccount.deleteMany({ where: { displayName: SELLER_NAME } });
  await prisma.inventoryLocation.deleteMany({ where: { code: { startsWith: 'TRKT-' } } });
  await prisma.customerProfile.deleteMany({ where: { organization: RECEIVER_A } });

  await prisma.userRole.deleteMany({
    where: { user: { emailNormalized: { contains: '@trktest.local' } } },
  });
  await prisma.session.deleteMany({
    where: { user: { emailNormalized: { contains: '@trktest.local' } } },
  });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.session.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({
    where: { OR: [{ emailNormalized: EMAIL }, { emailNormalized: { contains: '@trktest.local' } }] },
  });
  await prisma.numberSequence.deleteMany({ where: { key: { startsWith: 'logistics-' } } });
}

async function makeShipment(options: {
  receiver: string;
  withSeller?: boolean;
  withWarehouse?: boolean;
  withCustomer?: boolean;
}): Promise<string> {
  const created = await createShipment({
    sellerCompanyName: SELLER_NAME,
    receivingCompanyName: options.receiver,
    pickupAddress: ADDRESS,
    deliveryAddress: { ...ADDRESS, city: 'Ghent', postalCode: '9000' },
    packageCount: 1,
    totalWeightGrams: 2000,
    ...(options.withSeller === true ? { sellerAccountId } : {}),
    ...(options.withWarehouse === true ? { originLocationId: warehouseId } : {}),
    ...(options.withCustomer === true ? { receivingCustomerProfileId: customerProfileId } : {}),
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
  shipments.set(created.shipmentReference, created.id);

  return created.id;
}

/**
 * Walk a consignment along the forward path.
 *
 * As the carrier, holding the carrier's own permissions, because the state
 * machine checks both - `ACCEPTED -> PICKUP_SCHEDULED` is a CARRIER_STAFF
 * transition needing `pickup.write`, and an operator-shaped shortcut here
 * would be exercising a path the product does not offer.
 */
async function advance(
  shipmentId: string,
  statuses: readonly ('PICKUP_SCHEDULED' | 'PICKED_UP' | 'IN_TRANSIT' | 'OUT_FOR_DELIVERY')[],
): Promise<void> {
  for (const status of statuses) {
    await recordShipmentEvent({
      shipmentId,
      status,
      actor: 'PARTNER',
      source: 'LOGISTICS_PORTAL',
      actorLogisticsPartnerId: carrier.id,
      permissions: [...carrier.membership.permissions],
    });
  }
}

beforeAll(async () => {
  app = await buildApp();
  await cleanUp();

  const orderRole = await prisma.role.findUniqueOrThrow({
    where: { key: Role.ORDER_MANAGER },
    select: { id: true },
  });

  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email: EMAIL,
      emailNormalized: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: orderRole.id } },
    },
  });

  ({ cookies } = await signInAdmin(app, { email: EMAIL, password: PASSWORD, ip: '203.0.113.180' }));

  // --- The businesses and the building the filters narrow by ---------------

  sellerAccountId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerAccountId,
      legalName: `${SELLER_NAME} BV`,
      displayName: SELLER_NAME,
      displayNameNormalized: SELLER_NAME.toLowerCase().replace(/[^a-z0-9]/g, ''),
      slug: 'tracking-test-northwind',
      status: 'APPROVED',
      registrationCountry: 'BE',
    },
  });

  warehouseId = newId();
  await prisma.inventoryLocation.create({
    data: { id: warehouseId, code: 'TRKT-1', name: 'Tracking test depot', isActive: true },
  });

  const buyerUserId = newId();
  await prisma.user.create({
    data: {
      id: buyerUserId,
      type: 'CUSTOMER',
      email: 'buyer@trktest.local',
      emailNormalized: 'buyer@trktest.local',
      status: 'ACTIVE',
    },
  });

  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId: buyerUserId, fullName: 'Tracking Buyer', organization: RECEIVER_A },
  });
  customerProfileId = profile.id;

  // --- The carrier and one driver -----------------------------------------

  const partnerId = newId();
  const carrierUserId = newId();
  const partnerUserId = newId();

  await prisma.logisticsPartner.create({
    data: {
      id: partnerId,
      partnerCode: PARTNER_CODE,
      legalName: 'Tracking Freight NV',
      displayName: 'Tracking Freight',
      displayNameNormalized: 'trackingfreight',
      registrationCountry: 'BE',
      contactEmail: 'owner@trktest.local',
      status: 'ACTIVE',
      contractStatus: 'ACTIVE',
    },
  });

  await prisma.user.create({
    data: {
      id: carrierUserId,
      type: 'LOGISTICS',
      email: 'owner@trktest.local',
      emailNormalized: 'owner@trktest.local',
      status: 'ACTIVE',
    },
  });

  await prisma.logisticsPartnerUser.create({
    data: {
      id: partnerUserId,
      logisticsPartnerId: partnerId,
      userId: carrierUserId,
      role: 'LOGISTICS_PARTNER_OWNER',
      status: 'ACTIVE',
      fullName: 'Tracking Owner',
    },
  });

  carrier = {
    id: partnerId,
    membership: {
      logisticsPartnerId: partnerId,
      partnerCode: PARTNER_CODE,
      displayName: 'Tracking Freight',
      legalName: 'Tracking Freight NV',
      partnerStatus: 'ACTIVE',
      registrationCountry: 'BE',
      partnerUserId,
      userId: carrierUserId,
      fullName: 'Tracking Owner',
      role: 'LOGISTICS_PARTNER_OWNER',
      permissions: permissionsForLogisticsRole('LOGISTICS_PARTNER_OWNER'),
      canAcceptNewWork: true,
      requiresMfa: true,
      regionScope: null,
      driverProfileId: null,
    },
  };

  const driverUserId = newId();
  const driverMemberId = newId();
  driverProfileId = newId();

  await prisma.user.create({
    data: {
      id: driverUserId,
      type: 'LOGISTICS',
      email: 'ilse@trktest.local',
      emailNormalized: 'ilse@trktest.local',
      status: 'ACTIVE',
    },
  });

  await prisma.logisticsPartnerUser.create({
    data: {
      id: driverMemberId,
      logisticsPartnerId: partnerId,
      userId: driverUserId,
      role: 'DRIVER',
      status: 'ACTIVE',
      fullName: 'Ilse Maes',
    },
  });

  await prisma.logisticsDriverProfile.create({
    data: {
      id: driverProfileId,
      logisticsPartnerId: partnerId,
      fullName: 'Ilse Maes',
      partnerUserId: driverMemberId,
      state: 'ACTIVE',
    },
  });

  // --- Four consignments, deliberately different ---------------------------

  // A: everything joined up, on a driver, in transit.
  const a = await makeShipment({
    receiver: RECEIVER_A,
    withSeller: true,
    withWarehouse: true,
    withCustomer: true,
  });
  await advance(a, ['PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT']);
  await assignDriver(asPartner(carrier.membership), { shipmentId: a, driverProfileId });

  // B: a different buyer, no driver, out for delivery.
  const b = await makeShipment({ receiver: RECEIVER_B, withSeller: true });
  await advance(b, ['PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY']);
});

afterAll(async () => {
  await cleanUp();
  await app.close();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe('the tracking list', () => {
  it('names the carrier, the warehouse and the driver on the row', async () => {
    const page = await track(`customerProfileId=${customerProfileId}`);
    const row = own(page.shipments)[0];

    expect(row).toBeDefined();
    expect(row?.assignedPartner?.displayName).toBe('Tracking Freight');
    expect(row?.originLocation?.code).toBe('TRKT-1');
    // The column the carrier's own portal cannot have: who, across every
    // carrier, is holding this parcel.
    expect(row?.driver?.fullName).toBe('Ilse Maes');
    expect(row?.driver?.driverProfileId).toBe(driverProfileId);
  });

  it('narrows by the business receiving it', async () => {
    const page = await track(`customerProfileId=${customerProfileId}`);
    const rows = own(page.shipments);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.receivingCompanyName).toBe(RECEIVER_A);
  });

  it('narrows by the business whose goods they are', async () => {
    const page = await track(`sellerAccountId=${sellerAccountId}`);
    const rows = own(page.shipments);

    // Both were raised for this seller.
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.sellerCompanyName === SELLER_NAME)).toBe(true);
  });

  it('narrows by the building it is collected from', async () => {
    const page = await track(`warehouseId=${warehouseId}`);
    const rows = own(page.shipments);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.originLocation?.id).toBe(warehouseId);
  });

  it('narrows by the driver carrying it', async () => {
    const page = await track(`driverProfileId=${driverProfileId}`);
    const rows = own(page.shipments);

    // Through the live assignment rather than a column on the shipment, so
    // a consignment that has changed hands answers for whoever has it now.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.driver?.driverProfileId).toBe(driverProfileId);
  });

  it('narrows by carrier and by status', async () => {
    const byPartner = own((await track(`partnerId=${carrier.id}`)).shipments);
    expect(byPartner).toHaveLength(2);

    const moving = own((await track('status=IN_TRANSIT')).shipments);
    expect(moving).toHaveLength(1);
    expect(moving[0]?.status).toBe('IN_TRANSIT');
  });

  it('narrows by when it was raised', async () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    expect(own((await track(`from=${encodeURIComponent(tomorrow)}`)).shipments)).toHaveLength(0);
    expect(own((await track(`from=${encodeURIComponent(yesterday)}`)).shipments)).toHaveLength(2);
  });

  it('searches the order number as well as the references', async () => {
    const reference = [...shipments.keys()][0];
    const page = await track(`search=${encodeURIComponent(reference ?? '')}`);

    expect(page.shipments.map((row) => row.shipmentReference)).toContain(reference);
  });
});

describe('the summary above the table', () => {
  it('counts the filtered list, not the whole marketplace', async () => {
    const page = await track(`sellerAccountId=${sellerAccountId}`);

    // One in transit, one out for delivery - exactly the two this filter
    // matched. A desk that had filtered to one seller and still saw the whole
    // marketplace's totals would be reading the wrong number.
    expect(page.summary.inTransit).toBe(1);
    expect(page.summary.outForDelivery).toBe(1);
    expect(page.summary.delivered).toBe(0);
    expect(page.total).toBe(2);
  });
});

describe('what there is to filter by', () => {
  it('offers the companies, buildings, carriers and drivers that actually ship', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/logistics/tracking-filters',
      headers: { cookie: cookies },
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{
      sellers: { id: string; name: string }[];
      customers: { id: string; name: string }[];
      warehouses: { id: string; code: string }[];
      partners: { id: string }[];
      drivers: { id: string; fullName: string; partnerName: string }[];
    }>();

    expect(body.sellers.map((row) => row.id)).toContain(sellerAccountId);
    expect(body.customers.map((row) => row.id)).toContain(customerProfileId);
    expect(body.warehouses.map((row) => row.code)).toContain('TRKT-1');
    expect(body.partners.map((row) => row.id)).toContain(carrier.id);

    const driver = body.drivers.find((row) => row.id === driverProfileId);
    // Named with their carrier, because two carriers can employ an Ilse Maes
    // and a filter list of bare names is a list nobody can choose from.
    expect(driver?.partnerName).toBe('Tracking Freight');
  });
});

describe('a delivery that failed', () => {
  it('raises an alert, and reading it does not clear it', async () => {
    const shipmentId = shipments.get([...shipments.keys()][1] ?? '') ?? '';

    // The real path: a van called, nobody was there, and the carrier gave up
    // on that attempt. DELIVERY_FAILED is not reachable straight from
    // OUT_FOR_DELIVERY, and a test that pretended otherwise would be
    // exercising a transition the state machine refuses.
    for (const step of [
      { status: 'DELIVERY_ATTEMPTED' as const, reason: 'Nobody at the goods-in door.' },
      { status: 'DELIVERY_FAILED' as const, reason: 'Third attempt; goods-in closed all week.' },
    ]) {
      await recordShipmentEvent({
        shipmentId,
        status: step.status,
        actor: 'PARTNER',
        source: 'LOGISTICS_PORTAL',
        actorLogisticsPartnerId: carrier.id,
        permissions: [...carrier.membership.permissions],
        reason: step.reason,
      });
    }

    const viewer = {
      userId: (
        await prisma.user.findUniqueOrThrow({
          where: { emailNormalized: EMAIL },
          select: { id: true },
        })
      ).id,
      permissions: [Permission.LOGISTICS_READ],
    };

    const raised = await listAdminNotifications(viewer);
    const alert = raised.items.find((item) => item.kind === 'logistics.delivery_failed');

    expect(alert).toBeDefined();
    expect(alert?.class).toBe('ALERT');
    expect(raised.openAlertCount).toBeGreaterThan(0);

    // The exception column on the tracking row, so the desk can see it without
    // opening the consignment.
    const page = await track('exceptionsOnly=true');
    expect(page.summary.withOpenException).toBeGreaterThanOrEqual(0);
  });

  it('clears when the parcel moves again, and stays in the record', async () => {
    const shipmentId = shipments.get([...shipments.keys()][1] ?? '') ?? '';

    await recordShipmentEvent({
      shipmentId,
      status: 'OUT_FOR_DELIVERY',
      actor: 'PARTNER',
      source: 'LOGISTICS_PORTAL',
      actorLogisticsPartnerId: carrier.id,
      permissions: [...carrier.membership.permissions],
    });

    const viewer = {
      userId: (
        await prisma.user.findUniqueOrThrow({
          where: { emailNormalized: EMAIL },
          select: { id: true },
        })
      ).id,
      permissions: [Permission.LOGISTICS_READ],
    };

    const active = await listAdminNotifications(viewer);
    expect(active.items.some((item) => item.kind === 'logistics.delivery_failed')).toBe(false);

    // Gone from the bell, kept on the record. Nobody had to tidy it up.
    const history = await listAdminNotifications(viewer, { view: 'resolved' });
    const closed = history.items.find((item) => item.kind === 'logistics.delivery_failed');

    expect(closed?.status).toBe('RESOLVED');
    expect(closed?.resolutionSource).toBe('DOMAIN_EVENT');
  });
});
