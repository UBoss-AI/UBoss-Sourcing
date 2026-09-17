/**
 * The wiring, not the mechanism.
 *
 * `notification-resolution.test.ts` next door proves the lifecycle behaves:
 * that resolving is idempotent, that dismissing is private, that reading is
 * neither. It proves all of that by calling the notification service directly,
 * which means it would still pass if nothing in the product ever called it.
 *
 * This file closes that gap. It raises a REAL exception on a REAL consignment
 * through `exception.service`, closes it the way a dispatcher does, and asserts
 * that both consoles went quiet as a consequence. The only interesting
 * assertion is the one about causation: the operator never touched the bell,
 * and the bell cleared anyway.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { permissionsForLogisticsRole } from '../../src/domain/logistics-permissions.js';
import { Permission } from '../../src/domain/permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { LogisticsMembership } from '../../src/modules/logistics/partner.service.js';
import { raiseException, updateException } from '../../src/modules/logistics/exception.service.js';
import { createShipment } from '../../src/modules/logistics/shipment-create.service.js';
import {
  listAdminNotifications,
  type NotificationViewer,
} from '../../src/modules/notifications/admin-notification.service.js';

const PARTNER_CODE = 'LP-TEST-RESOLVE';
const CARRIER_EMAIL = 'resolve@carrier.test';
const OPERATOR_EMAIL = 'resolve-ops@bell.test';

let partnerId = '';
let carrier: LogisticsMembership;
let operator: NotificationViewer;
let shipmentId = '';

const ADDRESS = { line1: '1 Dock Road', city: 'Antwerp', postalCode: '2000', countryCode: 'BE' };

async function cleanUp(): Promise<void> {
  const partnerIds = (
    await prisma.logisticsPartner.findMany({
      where: { partnerCode: PARTNER_CODE },
      select: { id: true },
    })
  ).map((row) => row.id);

  const shipmentIds = (
    await prisma.logisticsShipment.findMany({
      where: { receivingCompanyName: 'St Aubyn Hospital', orderId: null },
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
  await prisma.logisticsShipment.deleteMany({ where: { id: { in: shipmentIds } } });
  await prisma.logisticsAuditLog.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsPartnerUser.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsPartner.deleteMany({ where: { id: { in: partnerIds } } });

  await prisma.adminNotificationRead.deleteMany({
    where: { notification: { relatedType: 'logistics_shipment' } },
  });
  await prisma.adminNotification.deleteMany({ where: { relatedType: 'logistics_shipment' } });

  await prisma.user.deleteMany({
    where: { emailNormalized: { in: [CARRIER_EMAIL, OPERATOR_EMAIL] } },
  });
  await prisma.numberSequence.deleteMany({ where: { key: { startsWith: 'logistics-' } } });
}

beforeEach(async () => {
  await cleanUp();

  partnerId = newId();
  const carrierUserId = newId();
  const partnerUserId = newId();

  await prisma.logisticsPartner.create({
    data: {
      id: partnerId,
      partnerCode: PARTNER_CODE,
      legalName: 'Resolve Freight NV',
      displayName: 'Resolve Freight',
      displayNameNormalized: 'resolvefreight',
      registrationCountry: 'BE',
      contactEmail: CARRIER_EMAIL,
      status: 'ACTIVE',
      contractStatus: 'ACTIVE',
    },
  });

  await prisma.user.create({
    data: {
      id: carrierUserId,
      type: 'LOGISTICS',
      email: CARRIER_EMAIL,
      emailNormalized: CARRIER_EMAIL,
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
      fullName: 'Resolve Owner',
    },
  });

  carrier = {
    logisticsPartnerId: partnerId,
    partnerCode: PARTNER_CODE,
    displayName: 'Resolve Freight',
    legalName: 'Resolve Freight NV',
    partnerStatus: 'ACTIVE',
    registrationCountry: 'BE',
    partnerUserId,
    userId: carrierUserId,
    fullName: 'Resolve Owner',
    role: 'LOGISTICS_PARTNER_OWNER',
    permissions: permissionsForLogisticsRole('LOGISTICS_PARTNER_OWNER'),
    canAcceptNewWork: true,
    requiresMfa: true,
    regionScope: null,
    driverProfileId: null,
  };

  const operatorUserId = newId();
  await prisma.user.create({
    data: {
      id: operatorUserId,
      type: 'ADMIN',
      email: OPERATOR_EMAIL,
      emailNormalized: OPERATOR_EMAIL,
      status: 'ACTIVE',
    },
  });
  operator = { userId: operatorUserId, permissions: [Permission.LOGISTICS_READ] };

  const created = await createShipment({
    sellerCompanyName: 'Northwind Medical',
    receivingCompanyName: 'St Aubyn Hospital',
    pickupAddress: ADDRESS,
    deliveryAddress: { ...ADDRESS, city: 'Ghent', postalCode: '9000' },
    packageCount: 1,
    totalWeightGrams: 3000,
    requiresColdChain: true,
  });

  shipmentId = created.id;

  await prisma.logisticsShipment.update({
    where: { id: shipmentId },
    data: { assignedPartnerId: partnerId, status: 'IN_TRANSIT' },
  });
});

afterAll(async () => {
  await cleanUp();
  await prisma.$disconnect();
});

describe('a cold-chain failure, start to finish', () => {
  it('rings both bells when it is raised and clears both when it is closed', async () => {
    const raised = await raiseException({
      shipmentId,
      logisticsPartnerId: partnerId,
      type: 'TEMPERATURE_EXCURSION',
      reason: 'Reefer failed between Antwerp and Ghent; load read 14 degrees.',
    });

    // The floor applies whatever the caller said, which is why this is an
    // operator-visible alert at all.
    expect(raised.severity).toBe('CRITICAL');

    const operatorBefore = await listAdminNotifications(operator);
    expect(operatorBefore.openAlertCount).toBe(1);
    expect(operatorBefore.items[0]!.class).toBe('ALERT');

    const carrierBefore = await prisma.logisticsNotification.findFirstOrThrow({
      where: { logisticsPartnerId: partnerId, class: 'ALERT' },
      select: { status: true, resolutionKey: true },
    });
    expect(carrierBefore.status).toBe('ACTIVE');

    // The dispatcher closes the work item. Nothing in this call mentions a
    // notification, and that is the assertion: the bell is a consequence of
    // the domain, not a second thing somebody has to remember to tidy.
    await updateException(carrier, raised.id, {
      state: 'RESOLVED',
      resolutionNotes: 'Load quarantined at Ghent depot; buyer re-supplied from Antwerp stock.',
    });

    const operatorAfter = await listAdminNotifications(operator);
    expect(operatorAfter.openAlertCount).toBe(0);
    expect(operatorAfter.items).toHaveLength(0);

    const carrierAfter = await prisma.logisticsNotification.findFirstOrThrow({
      where: { logisticsPartnerId: partnerId, class: 'ALERT' },
      select: { status: true, resolutionSource: true, resolutionReason: true },
    });
    expect(carrierAfter.status).toBe('RESOLVED');
    expect(carrierAfter.resolutionSource).toBe('DOMAIN_EVENT');
  });

  it('keeps it in history with who closed it and why', async () => {
    const raised = await raiseException({
      shipmentId,
      logisticsPartnerId: partnerId,
      type: 'TEMPERATURE_EXCURSION',
      reason: 'Reefer failed.',
    });

    await updateException(carrier, raised.id, {
      state: 'CLOSED',
      resolutionNotes: 'Quarantined and re-supplied.',
    });

    const history = await listAdminNotifications(operator, { view: 'resolved' });

    expect(history.items).toHaveLength(1);
    expect(history.items[0]!.status).toBe('RESOLVED');
    expect(history.items[0]!.resolutionReason).toBe('Quarantined and re-supplied.');
    expect(history.items[0]!.resolvedAt).not.toBeNull();
  });

  it('does not clear the bell when the exception is merely picked up', async () => {
    const raised = await raiseException({
      shipmentId,
      logisticsPartnerId: partnerId,
      type: 'TEMPERATURE_EXCURSION',
      reason: 'Reefer failed.',
    });

    await updateException(carrier, raised.id, { state: 'IN_PROGRESS' });

    // Somebody holding a problem is not somebody who has finished with it.
    // An alert that cleared here would be an alert that cleared because a
    // dispatcher opened a form.
    expect((await listAdminNotifications(operator)).openAlertCount).toBe(1);
  });

  it('leaves a second problem on the same consignment alone', async () => {
    const temperature = await raiseException({
      shipmentId,
      logisticsPartnerId: partnerId,
      type: 'TEMPERATURE_EXCURSION',
      reason: 'Reefer failed.',
    });

    const lost = await raiseException({
      shipmentId,
      logisticsPartnerId: partnerId,
      type: 'PACKAGE_LOST',
      reason: 'One of the two cartons is not on the van.',
    });

    expect(lost.severity).toBe('CRITICAL');
    expect((await listAdminNotifications(operator)).openAlertCount).toBe(2);

    await updateException(carrier, temperature.id, {
      state: 'RESOLVED',
      resolutionNotes: 'Quarantined.',
    });

    // One parcel, two problems, one of them fixed. The brief calls this out by
    // name: resolving one alert must not resolve unrelated alerts for the same
    // order.
    const after = await listAdminNotifications(operator);
    expect(after.openAlertCount).toBe(1);
    expect(after.items[0]!.variables['exceptionType']).toBe('PACKAGE_LOST');
  });
});
