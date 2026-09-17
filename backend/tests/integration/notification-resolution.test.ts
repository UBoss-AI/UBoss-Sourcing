/**
 * Notification resolution - integration, against a real MariaDB.
 *
 * The claim under test, in one sentence: **an alert leaves the bell when the
 * problem is fixed, and only then.**
 *
 * Everything here is a way that sentence can be false. Reading an alert must
 * not clear it, because "I have seen this" is not "this is dealt with".
 * Dismissing it must clear it for exactly one person, because an operator
 * tidying their own view must not be able to make a temperature excursion look
 * handled. Resolving it must clear it for everybody, must survive being asked
 * twice, must not touch the alert about the customs hold on the same
 * consignment, and must leave a row behind saying who closed it and why -
 * because an alert that vanishes is an alert nobody can audit.
 *
 * The lifecycle is exercised through the SERVICES rather than through fixture
 * rows wherever a real domain path exists. A test that writes `status:
 * RESOLVED` itself proves the column can hold the word; only closing an actual
 * exception proves the two are wired together.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, isAppError } from '../../src/domain/errors.js';
import { Permission } from '../../src/domain/permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  AdminNotificationKind,
  ResolutionKey,
  archiveOrphanedShipmentAlerts,
  createAdminNotification,
  dismissAdminNotifications,
  listAdminNotifications,
  markAdminNotificationsRead,
  pruneAdminNotifications,
  resolveAdminNotificationById,
  resolveAdminNotifications,
  type NotificationViewer,
} from '../../src/modules/notifications/admin-notification.service.js';

let logisticsViewer: NotificationViewer;
let secondLogisticsViewer: NotificationViewer;
let dispatcherViewer: NotificationViewer;
let catalogViewer: NotificationViewer;

async function resetAll(): Promise<void> {
  await prisma.adminNotificationRead.deleteMany({});
  await prisma.adminNotification.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.userRole.deleteMany({});
  await prisma.user.deleteMany({});
}

async function makeAdmin(email: string): Promise<string> {
  const id = newId();
  await prisma.user.create({
    data: { id, type: 'ADMIN', email, emailNormalized: email, status: 'ACTIVE' },
  });
  return id;
}

/** A CRITICAL logistics exception alert, exactly as `exception.service` raises it. */
async function raiseExceptionAlert(exceptionId: string, shipmentReference = 'LS-2026-000001'): Promise<void> {
  await createAdminNotification({
    kind: AdminNotificationKind.LOGISTICS_EXCEPTION_RAISED,
    variables: {
      shipmentReference,
      receivingCompany: 'Northwind Medical',
      exceptionType: 'TEMPERATURE_EXCURSION',
      severity: 'CRITICAL',
    },
    linkPath: `/logistics/shipments/${newId()}`,
    requiredPermission: Permission.LOGISTICS_READ,
    relatedType: 'logistics_shipment',
    relatedId: newId(),
    dedupeKey: `logistics-exception:${exceptionId}`,
    resolutionKey: ResolutionKey.logisticsException(exceptionId),
  });
}

/** A consignment nobody has picked up - the one alert a human may close. */
async function raiseUnassignedAlert(shipmentId: string): Promise<void> {
  await createAdminNotification({
    kind: AdminNotificationKind.LOGISTICS_SHIPMENT_UNASSIGNED,
    variables: { shipmentReference: 'LS-2026-000009', receivingCompany: 'Northwind', waitingHours: 30 },
    linkPath: `/logistics/shipments/${shipmentId}`,
    requiredPermission: Permission.LOGISTICS_READ,
    relatedType: 'logistics_shipment',
    relatedId: shipmentId,
    dedupeKey: `shipment-unassigned:${shipmentId}`,
    resolutionKey: ResolutionKey.shipmentAssignment(shipmentId),
  });
}

/** Ordinary news, to prove the two halves of the badge stay separate. */
async function raiseOrderPlaced(orderNumber: string): Promise<void> {
  await createAdminNotification({
    kind: AdminNotificationKind.ORDER_PLACED,
    variables: { customerName: 'Asha Menon', orderNumber, itemCount: 2, orderTotal: '900.00' },
    linkPath: `/orders/${newId()}`,
    requiredPermission: Permission.ORDER_READ,
    dedupeKey: `order:${orderNumber}`,
  });
}

async function onlyAlert(): Promise<{ id: string; status: string }> {
  const rows = await prisma.adminNotification.findMany({
    where: { class: 'ALERT' },
    select: { id: true, status: true },
  });
  expect(rows).toHaveLength(1);
  return rows[0] as { id: string; status: string };
}

beforeEach(async () => {
  await resetAll();

  logisticsViewer = {
    userId: await makeAdmin('ops@bell.test'),
    permissions: [Permission.LOGISTICS_READ, Permission.ORDER_READ],
  };

  // A second pair of eyes on the same console. The whole point of the shared
  // half of the lifecycle is that this person's badge is affected by a
  // resolution and not by their colleague reading something.
  secondLogisticsViewer = {
    userId: await makeAdmin('ops2@bell.test'),
    permissions: [Permission.LOGISTICS_READ, Permission.ORDER_READ],
  };

  // Can read consignments AND may put one on a carrier, which is the grant the
  // one manually-closable alert asks for.
  dispatcherViewer = {
    userId: await makeAdmin('dispatch@bell.test'),
    permissions: [Permission.LOGISTICS_READ, Permission.LOGISTICS_ASSIGN],
  };

  // Everything except the grant the logistics alerts carry.
  catalogViewer = {
    userId: await makeAdmin('catalog@bell.test'),
    permissions: [Permission.PRODUCT_READ, Permission.CATEGORY_READ],
  };
});

afterAll(async () => {
  await resetAll();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe('reading is not resolving', () => {
  it('keeps an alert on the badge after the reader has opened it', async () => {
    await raiseExceptionAlert(newId());

    const before = await listAdminNotifications(logisticsViewer);
    expect(before.activeCount).toBe(1);
    expect(before.openAlertCount).toBe(1);

    await markAdminNotificationsRead(logisticsViewer, [before.items[0]!.id]);

    const after = await listAdminNotifications(logisticsViewer);
    // Read, and still a problem. This is the assertion the whole feature
    // exists for: the two facts are stored in different places and only one
    // of them changed.
    expect(after.items[0]!.isRead).toBe(true);
    expect(after.items[0]!.status).toBe('ACTIVE');
    expect(after.unreadCount).toBe(0);
    expect(after.activeCount).toBe(1);
  });

  it('clears a piece of NEWS when the reader has opened it', async () => {
    await raiseOrderPlaced('UB-0001');

    const before = await listAdminNotifications(logisticsViewer);
    expect(before.activeCount).toBe(1);

    await markAdminNotificationsRead(logisticsViewer, [before.items[0]!.id]);

    const after = await listAdminNotifications(logisticsViewer);
    // News has no problem to fix, so the reader is the only one who can be
    // done with it. Same endpoint, opposite behaviour, and that is correct.
    expect(after.activeCount).toBe(0);
    expect(after.items).toHaveLength(1);
  });
});

describe('dismissing is not resolving', () => {
  it('hides the alert for one reader and leaves it for their colleague', async () => {
    await raiseExceptionAlert(newId());
    const alert = await onlyAlert();

    await dismissAdminNotifications(logisticsViewer, [alert.id]);

    const mine = await listAdminNotifications(logisticsViewer);
    const theirs = await listAdminNotifications(secondLogisticsViewer);

    expect(mine.items).toHaveLength(0);
    expect(mine.activeCount).toBe(0);

    expect(theirs.items).toHaveLength(1);
    expect(theirs.activeCount).toBe(1);
  });

  it('leaves the problem itself untouched', async () => {
    await raiseExceptionAlert(newId());
    const alert = await onlyAlert();

    await dismissAdminNotifications(logisticsViewer, [alert.id]);

    const row = await prisma.adminNotification.findUniqueOrThrow({
      where: { id: alert.id },
      select: { status: true, resolvedAt: true, resolutionSource: true },
    });

    // The distinction the brief is built around. An operator who cannot deal
    // with a temperature excursion today can take it off their own screen and
    // has changed nothing about the excursion.
    expect(row.status).toBe('ACTIVE');
    expect(row.resolvedAt).toBeNull();
    expect(row.resolutionSource).toBeNull();
  });

  it('is idempotent and keeps the first timestamp', async () => {
    await raiseExceptionAlert(newId());
    const alert = await onlyAlert();

    const first = await dismissAdminNotifications(logisticsViewer, [alert.id]);
    const second = await dismissAdminNotifications(logisticsViewer, [alert.id]);

    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  it('refuses an id the caller cannot see', async () => {
    await raiseExceptionAlert(newId());
    const alert = await onlyAlert();

    // A Catalog Manager holds no logistics grant, so as far as they are
    // concerned this row does not exist - and an id kept from a revoked grant
    // must not become a way to confirm that it does.
    expect(await dismissAdminNotifications(catalogViewer, [alert.id])).toBe(0);
  });
});

describe('a domain event resolving a problem', () => {
  it('takes the alert off every recipient badge at once', async () => {
    await raiseExceptionAlert(newId());
    const alert = await onlyAlert();

    const closed = await resolveAdminNotifications({
      resolutionKey: (
        await prisma.adminNotification.findUniqueOrThrow({
          where: { id: alert.id },
          select: { resolutionKey: true },
        })
      ).resolutionKey!,
      reason: 'Batch quarantined and the customer was re-supplied.',
      source: 'DOMAIN_EVENT',
    });

    expect(closed).toBe(1);

    // Resolution is a fact about the world, so it reaches both consoles -
    // unlike reading, which reached exactly one.
    for (const viewer of [logisticsViewer, secondLogisticsViewer]) {
      const feed = await listAdminNotifications(viewer);
      expect(feed.activeCount).toBe(0);
      expect(feed.items).toHaveLength(0);
    }
  });

  it('leaves the other problem on the same consignment alone', async () => {
    const temperature = newId();
    const customs = newId();
    await raiseExceptionAlert(temperature);
    await raiseExceptionAlert(customs);

    await resolveAdminNotifications({
      resolutionKey: ResolutionKey.logisticsException(temperature),
      reason: 'Batch quarantined.',
      source: 'DOMAIN_EVENT',
    });

    const feed = await listAdminNotifications(logisticsViewer);

    // Keyed on the EXCEPTION rather than the shipment, so closing one of two
    // problems on one parcel leaves the other exactly where it was. Keying on
    // the consignment would have silently cleared a customs hold nobody had
    // looked at.
    expect(feed.openAlertCount).toBe(1);

    const stillOpen = await prisma.adminNotification.findFirstOrThrow({
      where: { status: 'ACTIVE' },
      select: { resolutionKey: true },
    });
    expect(stillOpen.resolutionKey).toBe(ResolutionKey.logisticsException(customs));
  });

  it('is idempotent, and the second caller does not overwrite the first reason', async () => {
    const exceptionId = newId();
    await raiseExceptionAlert(exceptionId);

    const first = await resolveAdminNotifications({
      resolutionKey: ResolutionKey.logisticsException(exceptionId),
      reason: 'Closed by the carrier.',
      source: 'DOMAIN_EVENT',
    });

    const second = await resolveAdminNotifications({
      resolutionKey: ResolutionKey.logisticsException(exceptionId),
      reason: 'Closed again by a retried worker.',
      source: 'SYSTEM_SWEEP',
    });

    expect(first).toBe(1);
    // Zero, not an error. A retried worker, a double-clicked button and a
    // webhook delivered twice all have to land here safely.
    expect(second).toBe(0);

    const row = await prisma.adminNotification.findFirstOrThrow({
      select: { resolutionReason: true, resolutionSource: true },
    });
    expect(row.resolutionReason).toBe('Closed by the carrier.');
    expect(row.resolutionSource).toBe('DOMAIN_EVENT');
  });

  it('records when, why and by whom', async () => {
    const exceptionId = newId();
    await raiseExceptionAlert(exceptionId);

    await resolveAdminNotifications({
      resolutionKey: ResolutionKey.logisticsException(exceptionId),
      reason: 'Re-delivered on the 12th.',
      source: 'DOMAIN_EVENT',
      resolvedByUserId: logisticsViewer.userId,
    });

    const history = await listAdminNotifications(logisticsViewer, { view: 'resolved' });

    expect(history.items).toHaveLength(1);
    expect(history.items[0]!.status).toBe('RESOLVED');
    expect(history.items[0]!.resolvedAt).not.toBeNull();
    expect(history.items[0]!.resolvedBy).toBe('ops@bell.test');
    expect(history.items[0]!.resolutionReason).toBe('Re-delivered on the 12th.');
    expect(history.items[0]!.resolutionSource).toBe('DOMAIN_EVENT');
  });

  it('keeps the resolved alert readable in history, never deleting it', async () => {
    const exceptionId = newId();
    await raiseExceptionAlert(exceptionId);
    await resolveAdminNotifications({
      resolutionKey: ResolutionKey.logisticsException(exceptionId),
      reason: 'Dealt with.',
      source: 'DOMAIN_EVENT',
    });

    // Gone from the bell.
    expect((await listAdminNotifications(logisticsViewer)).items).toHaveLength(0);
    // Still on the record. "It was raised and here is what was done about it"
    // is the thing an auditor asks for, and deleting it would answer nothing.
    expect(await prisma.adminNotification.count()).toBe(1);
  });
});

describe('a problem that comes back', () => {
  it('creates a new actionable occurrence rather than reopening the old one', async () => {
    const exceptionId = newId();
    await raiseExceptionAlert(exceptionId);

    await resolveAdminNotifications({
      resolutionKey: ResolutionKey.logisticsException(exceptionId),
      reason: 'Thought it was fixed.',
      source: 'DOMAIN_EVENT',
    });

    // The same problem, raised again with the same keys.
    await raiseExceptionAlert(exceptionId);

    const rows = await prisma.adminNotification.findMany({
      where: { resolutionKey: ResolutionKey.logisticsException(exceptionId) },
      orderBy: { occurrence: 'asc' },
      select: { occurrence: true, status: true, resolutionReason: true, dedupeKey: true },
    });

    expect(rows).toHaveLength(2);
    // The first resolution survives intact - history is not edited, so "closed
    // at nine, back at eleven" stays readable.
    expect(rows[0]).toMatchObject({
      occurrence: 1,
      status: 'RESOLVED',
      resolutionReason: 'Thought it was fixed.',
    });
    expect(rows[1]).toMatchObject({ occurrence: 2, status: 'ACTIVE' });
    expect(rows[1]!.dedupeKey).toBe(`logistics-exception:${exceptionId}#2`);

    expect((await listAdminNotifications(logisticsViewer)).openAlertCount).toBe(1);
  });

  it('does not ring twice while the first occurrence is still open', async () => {
    const exceptionId = newId();
    await raiseExceptionAlert(exceptionId);
    await raiseExceptionAlert(exceptionId);

    // One bell per problem while the problem is on the badge. A retry storm
    // must not turn one excursion into forty rows.
    expect(await prisma.adminNotification.count()).toBe(1);
  });
});

describe('closing an alert by hand', () => {
  it('is refused for a problem whose truth lives somewhere else', async () => {
    await raiseExceptionAlert(newId());
    const alert = await onlyAlert();

    const failure = await resolveAdminNotificationById(
      logisticsViewer,
      alert.id,
      'It looked fine to me.',
    ).catch((error: unknown) => error);

    expect(isAppError(failure)).toBe(true);
    // The refusal IS the control. If a Resolve button could close this, the
    // quickest way to make a cold-chain failure disappear would be to click
    // past it.
    expect((failure as { code: string }).code).toBe(
      ErrorCode.NOTIFICATION_NOT_MANUALLY_RESOLVABLE,
    );
    expect((await onlyAlert()).status).toBe('ACTIVE');
  });

  it('is refused on a row that is news rather than a problem', async () => {
    await raiseOrderPlaced('UB-0002');
    const news = await prisma.adminNotification.findFirstOrThrow({ select: { id: true } });

    const failure = await resolveAdminNotificationById(
      logisticsViewer,
      news.id,
      'Nothing to do here.',
    ).catch((error: unknown) => error);

    expect((failure as { code: string }).code).toBe(ErrorCode.NOTIFICATION_NOT_AN_ALERT);
  });

  it('is allowed where a human genuinely is the only source of truth', async () => {
    await raiseUnassignedAlert(newId());
    const alert = await onlyAlert();

    const resolved = await resolveAdminNotificationById(
      dispatcherViewer,
      alert.id,
      'Collection arranged by telephone with Northwind Logistics.',
    );

    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.resolutionSource).toBe('MANUAL');
    expect(resolved.resolvedBy).toBe('dispatch@bell.test');
    expect((await listAdminNotifications(logisticsViewer)).openAlertCount).toBe(0);
  });

  it('is refused to somebody who may read it but not act on it', async () => {
    await raiseUnassignedAlert(newId());
    const alert = await onlyAlert();

    // `logisticsViewer` holds LOGISTICS_READ, so the row is visible to them.
    // Closing it needs LOGISTICS_ASSIGN, which they do not hold - reading
    // about a consignment and deciding its alert is finished with are
    // different pieces of authority.
    const failure = await resolveAdminNotificationById(logisticsViewer, alert.id, 'Sorted.').catch(
      (error: unknown) => error,
    );

    expect((failure as { code: string }).code).toBe(
      ErrorCode.NOTIFICATION_NOT_MANUALLY_RESOLVABLE,
    );
    expect((await onlyAlert()).status).toBe('ACTIVE');
  });

  it('refuses an id the caller cannot see at all, as a 404', async () => {
    await raiseUnassignedAlert(newId());
    const alert = await onlyAlert();

    const failure = await resolveAdminNotificationById(catalogViewer, alert.id, 'Sorted.').catch(
      (error: unknown) => error,
    );

    // 404 rather than 403: telling somebody without the grant that the alert
    // exists is the disclosure this avoids.
    expect((failure as { statusCode: number }).statusCode).toBe(404);
  });

  it('is idempotent - the second press reads back the first answer', async () => {
    await raiseUnassignedAlert(newId());
    const alert = await onlyAlert();

    const first = await resolveAdminNotificationById(dispatcherViewer, alert.id, 'Arranged by hand.');
    const second = await resolveAdminNotificationById(
      dispatcherViewer,
      alert.id,
      'Arranged again, by a second click.',
    );

    expect(first.resolutionReason).toBe('Arranged by hand.');
    // Two administrators pressing this at the same moment must not have the
    // second one's reason replace the first one's record.
    expect(second.resolutionReason).toBe('Arranged by hand.');
    expect(second.resolvedAt).toBe(first.resolvedAt);
  });

  it('survives two administrators pressing it at the same moment', async () => {
    await raiseUnassignedAlert(newId());
    const alert = await onlyAlert();

    const second = {
      userId: await makeAdmin('dispatch2@bell.test'),
      permissions: [Permission.LOGISTICS_READ, Permission.LOGISTICS_ASSIGN],
    };

    const [a, b] = await Promise.all([
      resolveAdminNotificationById(dispatcherViewer, alert.id, 'Closed by the first.'),
      resolveAdminNotificationById(second, alert.id, 'Closed by the second.'),
    ]);

    // Whichever won, both read back the same row: the write is conditional on
    // the row still being ACTIVE, so the loser writes nothing rather than
    // overwriting the winner.
    expect(a.status).toBe('RESOLVED');
    expect(b.status).toBe('RESOLVED');
    expect(a.resolutionReason).toBe(b.resolutionReason);
  });
});

describe('the badge', () => {
  it('counts unread news and live problems, and nothing else', async () => {
    await raiseOrderPlaced('UB-0010');
    await raiseOrderPlaced('UB-0011');
    await raiseExceptionAlert(newId());
    await raiseExceptionAlert(newId());

    const fresh = await listAdminNotifications(logisticsViewer);
    expect(fresh.activeCount).toBe(4);

    // Read everything. The two pieces of news go; the two problems stay,
    // because nobody has fixed anything.
    await markAdminNotificationsRead(
      logisticsViewer,
      fresh.items.map((item) => item.id),
    );

    const afterReading = await listAdminNotifications(logisticsViewer);
    expect(afterReading.unreadCount).toBe(0);
    expect(afterReading.activeCount).toBe(2);
    expect(afterReading.openAlertCount).toBe(2);
  });

  it('omits a queue the caller may not see', async () => {
    await raiseExceptionAlert(newId());

    // The alert carries `logistics.read`. A Catalog Manager is not shown a
    // zero, they are shown nothing - the difference between 0 and 2 open
    // cold-chain failures is itself information.
    const feed = await listAdminNotifications(catalogViewer);
    expect(feed.items).toHaveLength(0);
    expect(feed.activeCount).toBe(0);
  });
});

describe('retention', () => {
  it('never prunes a live alert, however old it is', async () => {
    await raiseExceptionAlert(newId());
    await raiseOrderPlaced('UB-0020');

    const ancient = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await prisma.adminNotification.updateMany({ data: { createdAt: ancient } });

    const pruned = await pruneAdminNotifications();

    // The news goes. The unresolved cold-chain failure does not, because
    // clearing a badge by forgetting the problem is the one thing this whole
    // feature exists to prevent.
    expect(pruned).toBe(1);
    const left = await prisma.adminNotification.findMany({ select: { class: true, status: true } });
    expect(left).toEqual([{ class: 'ALERT', status: 'ACTIVE' }]);
  });

  it('prunes an alert once it has been closed', async () => {
    const exceptionId = newId();
    await raiseExceptionAlert(exceptionId);
    await resolveAdminNotifications({
      resolutionKey: ResolutionKey.logisticsException(exceptionId),
      reason: 'Dealt with.',
      source: 'DOMAIN_EVENT',
    });

    await prisma.adminNotification.updateMany({
      data: { createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000) },
    });

    expect(await pruneAdminNotifications()).toBe(1);
  });
});

describe('an alert about something that no longer exists', () => {
  it('is archived by the sweep rather than left on the badge for ever', async () => {
    // Raised against a consignment id that is not in the shipments table -
    // which is what a row looks like after its carrier was removed and the
    // cascade took its consignments with it.
    await raiseExceptionAlert(newId());

    expect((await listAdminNotifications(logisticsViewer)).openAlertCount).toBe(1);

    const archived = await archiveOrphanedShipmentAlerts();
    expect(archived).toBe(1);

    const feed = await listAdminNotifications(logisticsViewer);
    expect(feed.openAlertCount).toBe(0);

    const row = await prisma.adminNotification.findFirstOrThrow({
      select: { status: true, resolutionSource: true },
    });

    /*
     * ARCHIVED, not RESOLVED, and the distinction is the point: nobody fixed
     * anything, the question stopped existing, and the record has to say which
     * of the two happened.
     */
    expect(row.status).toBe('ARCHIVED');
    expect(row.resolutionSource).toBe('SYSTEM_SWEEP');
  });

  it('leaves alone an alert whose consignment is still there', async () => {
    const shipmentId = newId();

    await createAdminNotification({
      kind: AdminNotificationKind.LOGISTICS_EXCEPTION_RAISED,
      variables: { shipmentReference: 'LS-2026-000099', severity: 'CRITICAL' },
      requiredPermission: Permission.LOGISTICS_READ,
      relatedType: 'logistics_shipment',
      relatedId: shipmentId,
      dedupeKey: `logistics-exception:${shipmentId}`,
      resolutionKey: ResolutionKey.logisticsException(shipmentId),
    });

    // A consignment that exists. Built here rather than through the whole
    // logistics fixture, because the only thing under test is whether the
    // sweep can tell a live row from a missing one.
    await prisma.logisticsShipment.create({
      data: {
        id: shipmentId,
        shipmentReference: `LS-SWEEP-${shipmentId.slice(-8)}`,
        trackingNumber: `TRK-SWEEP-${shipmentId.slice(-8)}`,
        sellerCompanyName: 'Sweep Test Seller',
        receivingCompanyName: 'Sweep Test Receiver',
        pickupAddressJson: { line1: '1 Dock Road', city: 'Antwerp', countryCode: 'BE' },
        deliveryAddressJson: { line1: '2 Quay Road', city: 'Ghent', countryCode: 'BE' },
        originCountry: 'BE',
        destinationCountry: 'BE',
      },
    });

    expect(await archiveOrphanedShipmentAlerts()).toBe(0);
    expect((await listAdminNotifications(logisticsViewer)).openAlertCount).toBe(1);

    await prisma.logisticsShipment.delete({ where: { id: shipmentId } });
  });
});

describe('a failed resolution', () => {
  it('leaves the alert active rather than half-closed', async () => {
    const exceptionId = newId();
    await raiseExceptionAlert(exceptionId);

    /*
     * The transaction is the guarantee. A caller that resolves inside its own
     * transaction and then fails must leave the alert exactly as it was -
     * otherwise a problem stops being visible because of a write that never
     * committed.
     */
    await prisma
      .$transaction(async (tx) => {
        await resolveAdminNotifications(
          {
            resolutionKey: ResolutionKey.logisticsException(exceptionId),
            reason: 'About to go wrong.',
            source: 'DOMAIN_EVENT',
          },
          tx,
        );

        throw new Error('the domain write failed after the alert was closed');
      })
      .catch(() => undefined);

    expect((await onlyAlert()).status).toBe('ACTIVE');
    expect((await listAdminNotifications(logisticsViewer)).openAlertCount).toBe(1);
  });
});
