/**
 * Telling a seller what happened to the way they deliver.
 *
 * Two of these four are ALERTS, and the difference is the whole point: news is
 * cleared by being read, an alert is cleared by the problem going away. A
 * seller cannot dismiss "your carrier account stopped answering" by glancing
 * at it, because the account is still broken.
 *
 * THE THREE THINGS WORTH PROVING
 *
 *   - **Deduplication is a constraint, not a query.** A carrier down for an
 *     hour must produce one notification, not forty - and the thing that
 *     guarantees it must survive two workers arriving in the same second.
 *   - **An alert closes itself.** When the connection answers again the alert
 *     stops counting, and the row stays, because "was DHL down last Tuesday?"
 *     is asked a week later.
 *   - **Two different decisions are two notifications.** A refusal in March
 *     and an approval in April are both things a seller has to read.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  notifyConnectionFailed,
  notifyConsignmentNeedsMethod,
  notifyInvitationResult,
  notifyMethodDecision,
  resolveConnectionAlert,
  resolveConsignmentMethodAlert,
} from '../../src/modules/seller/fulfilment-notification.service.js';

const SLUG = 'notify-co';

let sellerId = '';

async function cleanUp(): Promise<void> {
  await prisma.sellerNotification.deleteMany({ where: { sellerAccount: { slug: SLUG } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: SLUG } });
}

beforeAll(async () => {
  await cleanUp();

  const seller = await prisma.sellerAccount.create({
    data: {
      id: newId(),
      legalName: 'Notify Co Ltd',
      displayName: 'Notify Co',
      displayNameNormalized: 'notify co',
      slug: SLUG,
      kind: 'RESELLER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });

  sellerId = seller.id;
});

afterAll(async () => {
  await cleanUp();
});

async function rowsOfKind(kind: string): Promise<
  { id: string; class: string; status: string; title: string; resolutionKey: string | null }[]
> {
  return prisma.sellerNotification.findMany({
    where: { sellerAccountId: sellerId, kind: kind as never },
    select: { id: true, class: true, status: true, title: true, resolutionKey: true },
    orderBy: { createdAt: 'asc' },
  });
}

// ---------------------------------------------------------------------------

describe('a decision about a way of delivering', () => {
  it('is news rather than an alert, because there is nothing to resolve', async () => {
    await notifyMethodDecision({
      sellerAccountId: sellerId,
      fulfilmentMethodId: '01METHODAAAAAAAAAAAAAAAAAA',
      methodName: 'Our own vans',
      status: 'APPROVED',
      reason: null,
    });

    const rows = await rowsOfKind('FULFILMENT_METHOD_DECISION');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.class).toBe('INFORMATION');
    expect(rows[0]?.title).toContain('ready to use');
  });

  it('writes once however many times the same decision is announced', async () => {
    await notifyMethodDecision({
      sellerAccountId: sellerId,
      fulfilmentMethodId: '01METHODAAAAAAAAAAAAAAAAAA',
      methodName: 'Our own vans',
      status: 'APPROVED',
      reason: null,
    });

    expect(await rowsOfKind('FULFILMENT_METHOD_DECISION')).toHaveLength(1);
  });

  it('treats a later, different decision as a second thing to read', async () => {
    // A refusal in March and an approval in April are two things that
    // happened, and a seller has to read both.
    await notifyMethodDecision({
      sellerAccountId: sellerId,
      fulfilmentMethodId: '01METHODAAAAAAAAAAAAAAAAAA',
      methodName: 'Our own vans',
      status: 'REJECTED',
      reason: 'The cold-chain certificate had expired.',
    });

    const rows = await rowsOfKind('FULFILMENT_METHOD_DECISION');

    expect(rows).toHaveLength(2);
    expect(rows[1]?.title).toContain('not approved');
  });
});

describe('a carrier account that stops answering', () => {
  const connectionId = '01CONNECTIONAAAAAAAAAAAAAA';

  it('raises one alert, not one per failure', async () => {
    // A carrier down for an hour produces forty failures. A seller who gets
    // forty notifications learns to ignore the kind.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await notifyConnectionFailed({
        sellerAccountId: sellerId,
        connectionId,
        provider: 'DHL',
        message: 'The carrier did not answer.',
        // Same outage: the connection has not succeeded in between.
        episode: 'never',
      });
    }

    const rows = await rowsOfKind('CARRIER_CONNECTION_FAILED');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.class).toBe('ALERT');
    expect(rows[0]?.status).toBe('ACTIVE');
  });

  it('closes itself when the carrier answers again, and keeps the row', async () => {
    await resolveConnectionAlert(connectionId);

    const rows = await rowsOfKind('CARRIER_CONNECTION_FAILED');

    expect(rows).toHaveLength(1);
    // RESOLVED, not deleted. A notification that vanished when things got
    // better would have no answer to "was DHL down last Tuesday?".
    expect(rows[0]?.status).toBe('RESOLVED');
  });

  it('raises again if it breaks a second time', async () => {
    await notifyConnectionFailed({
      sellerAccountId: sellerId,
      connectionId,
      provider: 'DHL',
      message: 'The carrier did not answer.',
      // A NEW outage: the carrier worked in between, so this is a second
      // problem and the seller has to be told again.
      episode: '2026-09-22T20:00:00.000Z',
    });

    const active = await prisma.sellerNotification.count({
      where: { sellerAccountId: sellerId, kind: 'CARRIER_CONNECTION_FAILED', status: 'ACTIVE' },
    });

    expect(active).toBe(1);
  });
});

describe('a paid order with nothing to carry it', () => {
  const shipmentId = '01SHIPMENTAAAAAAAAAAAAAAAA';

  it('is an alert naming the consignment and why', async () => {
    await notifyConsignmentNeedsMethod({
      sellerAccountId: sellerId,
      shipmentId,
      shipmentReference: 'LS-2026-000123',
      reason: 'Nothing eligible: Our own vans is not approved for the handling this needs.',
    });

    const rows = await rowsOfKind('CONSIGNMENT_AWAITING_METHOD');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.class).toBe('ALERT');
    expect(rows[0]?.title).toContain('LS-2026-000123');
  });

  it('is one alert per consignment, so forty stuck orders are forty parcels', async () => {
    await notifyConsignmentNeedsMethod({
      sellerAccountId: sellerId,
      shipmentId,
      shipmentReference: 'LS-2026-000123',
      reason: 'Still nothing eligible.',
    });

    expect(await rowsOfKind('CONSIGNMENT_AWAITING_METHOD')).toHaveLength(1);
  });

  it('closes when a way of delivering it is chosen', async () => {
    await resolveConsignmentMethodAlert(shipmentId);

    const rows = await rowsOfKind('CONSIGNMENT_AWAITING_METHOD');
    expect(rows[0]?.status).toBe('RESOLVED');
  });
});

describe('a delivery company answering an invitation', () => {
  it('tells the seller, because they have no other way of knowing', async () => {
    await notifyInvitationResult({
      sellerAccountId: sellerId,
      invitationId: '01INVITEAAAAAAAAAAAAAAAAAA',
      companyName: 'MediCourier',
      accepted: true,
    });

    const rows = await rowsOfKind('PARTNER_INVITATION_RESULT');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toContain('MediCourier');
    // News: the seller reads it and waits for the marketplace's review. There
    // is nothing for them to resolve.
    expect(rows[0]?.class).toBe('INFORMATION');
  });
});
