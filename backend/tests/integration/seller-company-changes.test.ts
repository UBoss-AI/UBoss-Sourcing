/**
 * Change control for a seller's verified company details (JOURNEY-027).
 *
 * After approval a seller cannot type over their legal name, numbers or
 * registered address. What this holds the code to:
 *
 *   - the seller proposes; nothing changes until staff decide;
 *   - only what differs is kept, and a request that changes nothing is refused;
 *   - a second proposal withdraws the first, and the seller can withdraw too;
 *   - approval applies the change and, for a material one, retires the
 *     current verification case and opens a fresh one for a reviewer;
 *   - rejection needs a reason and changes nothing; a decided request cannot
 *     be decided again; every step is audited;
 *   - a seller whose application is still editable is sent back to it;
 *   - certificate expiry warnings are said once per stage.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { buildApp } from '../../src/http/app.js';
import { decideCompanyChange } from '../../src/modules/seller/company-change.service.js';
import { sendTrustExpiryAlerts } from '../../src/modules/trust/expiry-alerts.service.js';
import { as, buildRfqWorld, cleanRfqWorld, errorCode, type RfqWorld } from '../support/rfq-fixture.js';

const PREFIX = 'cchg-';
const ADMIN_EMAIL = 'cchg-admin@test.local';
const DAY = 86_400_000;
let world: RfqWorld;
let adminUserId = '';
const certificationIds: string[] = [];

interface Change {
  id: string;
  status: string;
  proposed: Record<string, string | null>;
  previous: Record<string, string | null>;
  material: boolean;
  reverifies: string[];
}

beforeAll(async () => {
  const app = await buildApp();
  await app.ready();
  world = await buildRfqWorld(app, PREFIX);
  await prisma.user.deleteMany({ where: { emailNormalized: ADMIN_EMAIL } });
  adminUserId = newId();
  await prisma.user.create({
    data: { id: adminUserId, type: 'ADMIN', email: ADMIN_EMAIL, emailNormalized: ADMIN_EMAIL, status: 'ACTIVE' },
  });
});

afterAll(async () => {
  const sellers = Object.values(world.sellers).map((seller) => seller.id);
  await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerCertification.deleteMany({ where: { id: { in: certificationIds } } });
  await prisma.sellerProfileChangeRequest.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerVerificationCase.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await cleanRfqWorld(PREFIX);
  await prisma.user.deleteMany({ where: { emailNormalized: ADMIN_EMAIL } });
  await world.app.close();
});

describe('a seller proposing a change', () => {
  it('keeps only what differs, changes nothing yet, and refuses a request that changes nothing', async () => {
    const seller = world.sellers.alpha;
    const before = await prisma.sellerAccount.findUniqueOrThrow({ where: { id: seller.id }, select: { legalName: true } });

    const same = await as(world, seller.owner, 'POST', '/seller/company-changes', { legalName: before.legalName });
    expect(same.statusCode, same.body).toBe(400);
    expect(errorCode(same)).toBe('COMPANY_CHANGE_EMPTY');

    const response = await as(world, seller.owner, 'POST', '/seller/company-changes', {
      legalName: `${before.legalName} Renamed`,
      registeredCity: 'Nashik',
      note: 'Name change after merger',
    });
    expect(response.statusCode, response.body).toBe(201);
    const change = response.json<{ change: Change }>().change;
    expect(change.status).toBe('PENDING');
    expect(Object.keys(change.proposed).sort()).toEqual(['legalName', 'registeredCity']);
    expect(change.previous.legalName).toBe(before.legalName);
    expect(change.material).toBe(true);
    expect(change.reverifies).toEqual(['BUSINESS_REGISTRATION']);

    // Nothing applied yet.
    const after = await prisma.sellerAccount.findUniqueOrThrow({ where: { id: seller.id }, select: { legalName: true } });
    expect(after.legalName).toBe(before.legalName);

    const details = await as(world, seller.owner, 'GET', '/seller/company-details');
    expect(details.statusCode).toBe(200);
    expect(details.json<{ changeControlled: boolean; pending: Change | null }>()).toMatchObject({
      changeControlled: true,
      pending: { id: change.id },
    });
  });

  it('withdraws the earlier request when a new one is sent, and lets the seller withdraw it', async () => {
    const seller = world.sellers.beta;
    const first = (
      await as(world, seller.owner, 'POST', '/seller/company-changes', { registeredCity: 'Thane' })
    ).json<{ change: Change }>().change;
    const second = (
      await as(world, seller.owner, 'POST', '/seller/company-changes', { registeredCity: 'Kalyan' })
    ).json<{ change: Change }>().change;

    const rows = await prisma.sellerProfileChangeRequest.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { id: true, status: true },
    });
    expect(new Map(rows.map((row) => [row.id, row.status]))).toEqual(
      new Map([
        [first.id, 'WITHDRAWN'],
        [second.id, 'PENDING'],
      ]),
    );

    const withdrawn = await as(world, seller.owner, 'POST', `/seller/company-changes/${second.id}/withdraw`, {});
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    const again = await as(world, seller.owner, 'POST', `/seller/company-changes/${second.id}/withdraw`, {});
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('COMPANY_CHANGE_NOT_PENDING');
  });

  it('sends a seller whose application is still editable back to the application', async () => {
    const seller = world.sellers.pending;
    const status = await prisma.sellerAccount.findUniqueOrThrow({ where: { id: seller.id }, select: { status: true } });
    await prisma.sellerAccount.update({ where: { id: seller.id }, data: { status: 'ACTION_REQUIRED' } });
    try {
      const response = await as(world, seller.owner, 'POST', '/seller/company-changes', { registeredCity: 'Pune' });
      expect(response.statusCode, response.body).toBe(409);
      expect(errorCode(response)).toBe('COMPANY_CHANGE_NOT_ALLOWED');
    } finally {
      await prisma.sellerAccount.update({ where: { id: seller.id }, data: { status: status.status } });
    }
  });

  it('cannot see or withdraw another seller\'s request', async () => {
    const pending = await prisma.sellerProfileChangeRequest.findFirstOrThrow({
      where: { sellerAccountId: world.sellers.alpha.id, status: 'PENDING' },
      select: { id: true },
    });
    const response = await as(world, world.sellers.gamma.owner, 'POST', `/seller/company-changes/${pending.id}/withdraw`, {});
    expect(response.statusCode).toBe(404);
  });
});

describe('staff deciding', () => {
  it('applies an approved material change and re-opens the business verification', async () => {
    const seller = world.sellers.alpha;
    const pending = await prisma.sellerProfileChangeRequest.findFirstOrThrow({
      where: { sellerAccountId: seller.id, status: 'PENDING' },
    });
    const oldCase = await prisma.sellerVerificationCase.create({
      data: { id: newId(), sellerAccountId: seller.id, kind: 'BUSINESS_REGISTRATION', state: 'VERIFIED', isCurrent: true },
    });

    const decided = await decideCompanyChange({
      changeId: pending.id,
      decision: 'APPROVED',
      reason: null,
      actor: { userId: adminUserId, email: ADMIN_EMAIL },
    });
    expect(decided.status).toBe('APPROVED');

    const account = await prisma.sellerAccount.findUniqueOrThrow({
      where: { id: seller.id },
      select: { legalName: true, businessProfile: { select: { registeredCity: true } } },
    });
    expect(account.legalName).toMatch(/ Renamed$/);
    expect(account.businessProfile?.registeredCity).toBe('Nashik');

    const cases = await prisma.sellerVerificationCase.findMany({
      where: { sellerAccountId: seller.id, kind: 'BUSINESS_REGISTRATION' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, state: true, isCurrent: true },
    });
    expect(cases.find((row) => row.id === oldCase.id)?.isCurrent).toBe(false);
    expect(cases.filter((row) => row.isCurrent)).toEqual([expect.objectContaining({ state: 'IN_PROGRESS' })]);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'seller_company_change.decided', resourceId: pending.id },
      select: { actorUserId: true },
    });
    expect(audit?.actorUserId).toBe(adminUserId);

    // Decided once only.
    await expect(
      decideCompanyChange({ changeId: pending.id, decision: 'REJECTED', reason: 'Late', actor: { userId: adminUserId, email: ADMIN_EMAIL } }),
    ).rejects.toMatchObject({ code: 'COMPANY_CHANGE_NOT_PENDING' });
  });

  it('rejects with a reason and changes nothing', async () => {
    const seller = world.sellers.gamma;
    const before = await prisma.sellerAccount.findUniqueOrThrow({ where: { id: seller.id }, select: { legalName: true } });
    const change = (
      await as(world, seller.owner, 'POST', '/seller/company-changes', { legalName: `${before.legalName} Two` })
    ).json<{ change: Change }>().change;

    await decideCompanyChange({
      changeId: change.id,
      decision: 'REJECTED',
      reason: 'The registry still shows the old name.',
      actor: { userId: adminUserId, email: ADMIN_EMAIL },
    });

    const after = await prisma.sellerAccount.findUniqueOrThrow({ where: { id: seller.id }, select: { legalName: true } });
    expect(after.legalName).toBe(before.legalName);
    const history = (await as(world, seller.owner, 'GET', '/seller/company-details')).json<{
      history: { id: string; status: string; decisionReason: string | null }[];
    }>().history;
    expect(history.find((row) => row.id === change.id)).toMatchObject({
      status: 'REJECTED',
      decisionReason: 'The registry still shows the old name.',
    });
  });
});

describe('certificate expiry warnings', () => {
  it('warns once at thirty days, whatever the number of beats', async () => {
    const seller = world.sellers.delta;
    const id = newId();
    certificationIds.push(id);
    const now = new Date();
    await prisma.sellerCertification.create({
      data: {
        id,
        sellerAccountId: seller.id,
        standard: 'ISO 9001',
        issuer: 'Test body',
        state: 'VERIFIED',
        expiresOn: new Date(now.getTime() + 20 * DAY),
      },
    });

    await sendTrustExpiryAlerts(now);
    await sendTrustExpiryAlerts(now);

    const notices = await prisma.sellerNotification.findMany({
      where: { sellerAccountId: seller.id, subjectId: id, kind: 'DOCUMENT_EXPIRING' },
      select: { dedupeKey: true },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.dedupeKey).toMatch(/:T30$/);

    // Seven days out, the second warning.
    await sendTrustExpiryAlerts(new Date(now.getTime() + 15 * DAY));
    expect(
      await prisma.sellerNotification.count({ where: { sellerAccountId: seller.id, subjectId: id, kind: 'DOCUMENT_EXPIRING' } }),
    ).toBe(2);
  });
});
