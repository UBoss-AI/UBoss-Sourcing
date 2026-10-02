/**
 * Privileged-access review of the marketplace's own staff (LIVE-015).
 *
 * A Business Owner sees every staff account with its roles, two-factor state,
 * last sign-in and a dormant flag; records KEEP / REDUCE / REVOKE per account
 * with a note; every decision is one row and one audit entry; nobody reviews
 * their own account; and nobody but a Business Owner reviews at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  asStaff,
  cleanUpOrderDesk,
  emailFor,
  errorCode,
  staff,
  type StaffSession,
} from '../support/order-desk-fixture.js';

const TAG = 'sar15';
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: StaffSession;
let secondOwner: StaffSession;
let orderDesk: StaffSession;
let ownerId = '';
let deskId = '';
let supportId = '';

interface ReviewBody {
  dormantAfterDays: number;
  accounts: {
    id: string;
    email: string;
    roles: { key: string }[];
    mfaEnabled: boolean;
    lastSignInAt: string | null;
    dormant: boolean;
    isSelf: boolean;
    latestDecision: { decision: string; note: string | null; reviewerEmail: string | null } | null;
  }[];
  summary: { accounts: number; withoutMfa: number; dormant: number; neverReviewed: number };
}

async function cleanUp(): Promise<void> {
  const ids = (
    await prisma.user.findMany({
      where: { emailNormalized: { endsWith: '@orderdesk.test.local', startsWith: `${TAG}-` } },
      select: { id: true },
    })
  ).map((row) => row.id);
  await prisma.staffAccessReview.deleteMany({
    where: { OR: [{ reviewedUserId: { in: ids } }, { reviewerUserId: { in: ids } }] },
  });
  await prisma.auditLog.deleteMany({
    where: { action: 'staff.access_reviewed', resourceId: { in: ids } },
  });
  await cleanUpOrderDesk(TAG);
}

const idOf = async (who: string): Promise<string> =>
  (
    await prisma.user.findUniqueOrThrow({
      where: { emailNormalized: emailFor(TAG, who) },
      select: { id: true },
    })
  ).id;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();
  owner = await staff(app, TAG, 'finance1', Role.BUSINESS_OWNER, '10.92.15.1');
  secondOwner = await staff(app, TAG, 'finance2', Role.BUSINESS_OWNER, '10.92.15.2');
  orderDesk = await staff(app, TAG, 'desk', Role.ORDER_MANAGER, '10.92.15.3');
  await staff(app, TAG, 'support', Role.SUPPORT_AGENT, '10.92.15.4');
  ownerId = await idOf('finance1');
  deskId = await idOf('desk');
  supportId = await idOf('support');

  // The support agent signed in long ago and never since: dormant. Their
  // created date is moved back too, so "never signed in" cannot mask it.
  const longAgo = new Date(Date.now() - 400 * 86_400_000);
  await prisma.user.update({
    where: { id: supportId },
    data: { lastLoginAt: longAgo, createdAt: longAgo },
  });
}, 120_000);

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('the staff access review', () => {
  it('lists every staff account with roles, two-factor, last sign-in and a dormant flag', async () => {
    const response = await asStaff(app, owner, 'GET', '/staff/access-review');
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<ReviewBody>();

    expect(body.dormantAfterDays).toBe(90);
    const desk = body.accounts.find((row) => row.id === deskId);
    const support = body.accounts.find((row) => row.id === supportId);
    const self = body.accounts.find((row) => row.id === ownerId);

    expect(desk?.roles.map((role) => role.key)).toEqual([Role.ORDER_MANAGER]);
    expect(desk?.mfaEnabled).toBe(false);
    expect(desk?.lastSignInAt).not.toBeNull();
    expect(desk?.dormant).toBe(false);
    expect(desk?.latestDecision).toBeNull();

    expect(support?.dormant).toBe(true);
    expect(self?.isSelf).toBe(true);

    // The summary counts what the rows say, over live accounts only.
    expect(body.summary.dormant).toBeGreaterThanOrEqual(1);
    expect(body.summary.withoutMfa).toBeGreaterThanOrEqual(4);
    expect(body.summary.neverReviewed).toBeGreaterThanOrEqual(4);
  });

  it('records a decision per account, with a snapshot and an audit entry', async () => {
    const kept = await asStaff(app, owner, 'POST', `/staff/${deskId}/access-reviews`, {
      payload: { decision: 'KEEP' },
    });
    expect(kept.statusCode, kept.body).toBe(201);

    const revoked = await asStaff(app, owner, 'POST', `/staff/${supportId}/access-reviews`, {
      payload: { decision: 'REVOKE', note: 'Left the company in spring; deactivate.' },
    });
    expect(revoked.statusCode, revoked.body).toBe(201);
    const reviewId = revoked.json<{ id: string }>().id;

    const row = await prisma.staffAccessReview.findUniqueOrThrow({ where: { id: reviewId } });
    expect(row).toMatchObject({
      reviewedUserId: supportId,
      reviewerUserId: ownerId,
      decision: 'REVOKE',
      note: 'Left the company in spring; deactivate.',
      mfaEnabled: false,
      dormant: true,
    });
    expect(row.rolesJson).toEqual([Role.SUPPORT_AGENT]);

    // One audit entry per decision, by the reviewer, about the account reviewed.
    const audits = await prisma.auditLog.findMany({
      where: { action: 'staff.access_reviewed', resourceId: { in: [deskId, supportId] } },
    });
    expect(audits).toHaveLength(2);
    const revokeAudit = audits.find((entry) => entry.resourceId === supportId);
    expect(revokeAudit?.actorUserId).toBe(ownerId);
    expect(revokeAudit?.afterJson).toMatchObject({ decision: 'REVOKE', roles: [Role.SUPPORT_AGENT], dormant: true });

    // The decision does not itself change the account: that is a separate,
    // separately audited action.
    const support = await prisma.user.findUniqueOrThrow({ where: { id: supportId } });
    expect(support.status).toBe('ACTIVE');

    // The list now shows the latest decision and who made it.
    const list = (await asStaff(app, owner, 'GET', '/staff/access-review')).json<ReviewBody>();
    expect(list.accounts.find((entry) => entry.id === supportId)?.latestDecision).toMatchObject({
      decision: 'REVOKE',
      reviewerEmail: emailFor(TAG, 'finance1'),
    });
  });

  it('asks for a note when access is reduced or revoked', async () => {
    const response = await asStaff(app, owner, 'POST', `/staff/${deskId}/access-reviews`, {
      payload: { decision: 'REDUCE' },
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('VALIDATION_FAILED');
  });

  it('refuses a review of your own account, and does not write one', async () => {
    const response = await asStaff(app, owner, 'POST', `/staff/${ownerId}/access-reviews`, {
      payload: { decision: 'KEEP' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { details?: { code: string }[] } }>().error.details?.[0]?.code).toBe(
      'SELF_REVIEW',
    );
    expect(await prisma.staffAccessReview.count({ where: { reviewedUserId: ownerId } })).toBe(0);

    // Another owner may review the first one.
    const byOther = await asStaff(app, secondOwner, 'POST', `/staff/${ownerId}/access-reviews`, {
      payload: { decision: 'KEEP', note: 'Still the account holder.' },
    });
    expect(byOther.statusCode, byOther.body).toBe(201);
  });

  it('is for Business Owners only', async () => {
    // The order desk holds staff.read? It does not; either way it is refused.
    const read = await asStaff(app, orderDesk, 'GET', '/staff/access-review');
    expect(read.statusCode).toBe(403);
    const write = await asStaff(app, orderDesk, 'POST', `/staff/${supportId}/access-reviews`, {
      payload: { decision: 'KEEP' },
    });
    expect(write.statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/admin/staff/access-review' })).statusCode,
    ).toBe(401);
  });

  it('refuses an account that is not staff', async () => {
    const response = await asStaff(app, owner, 'POST', '/staff/01JZZZZZZZZZZZZZZZZZZZZZZZ/access-reviews', {
      payload: { decision: 'KEEP' },
    });
    expect(response.statusCode).toBe(404);
  });
});
