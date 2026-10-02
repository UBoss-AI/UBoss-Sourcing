/**
 * A request's life after it is sent (checklist Master row 17): the seller's
 * inbox and view, declining, questions and answers per seller, requirement
 * versions, the deadline in UTC, and who may see what.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { env } from '../../src/config/env.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  as,
  buildRfqWorld,
  cleanRfqWorld,
  completeDraft,
  errorCode,
  errorDetails,
  key,
  submitted,
  type RfqWorld,
} from '../support/rfq-fixture.js';

const PREFIX = 'rfqr-';
let world: RfqWorld;
const mutableEnv = env as unknown as Record<string, unknown>;

interface SellerView {
  id: string;
  status: string;
  invitation: { status: string };
  versions: { versionNumber: number; changedFields: string[] }[];
  attachments: { id: string }[];
  actions: { canQuote: boolean; canDecline: boolean };
}
const sellerRfq = (response: LightMyRequestResponse): SellerView => response.json<{ rfq: SellerView }>().rfq;

function upload(url: string, bytes: Buffer): Promise<LightMyRequestResponse> {
  const boundary = '----rfqr';
  return world.app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers: {
      cookie: world.buyer.cookie,
      'x-csrf-token': world.buyer.csrf,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="spec.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}

beforeAll(async () => {
  const app = await buildApp();
  await app.ready();
  world = await buildRfqWorld(app, PREFIX);
});

afterAll(async () => {
  await cleanRfqWorld(PREFIX);
  await world.app.close();
});

describe('the seller inbox', () => {
  it('shows a seller only the requests it was invited to', async () => {
    const sent = await submitted(world);
    const { alpha, gamma } = world.sellers;
    const inbox = await as(world, alpha.owner, 'GET', '/seller/rfqs');
    expect(inbox.statusCode, inbox.body).toBe(200);
    expect(inbox.json<{ items: { id: string }[] }>().items.map((item) => item.id)).toContain(sent.id);

    const gammaInbox = await as(world, gamma.owner, 'GET', '/seller/rfqs?filter=all');
    expect(gammaInbox.json<{ items: { id: string }[] }>().items.map((item) => item.id)).not.toContain(sent.id);
    expect((await as(world, gamma.owner, 'GET', `/seller/rfqs/${sent.id}`)).statusCode).toBe(404);
    expect((await world.app.inject({ method: 'GET', url: '/api/v1/seller/rfqs' })).statusCode).toBe(401);
  });

  it('marks the invitation viewed when the seller opens it, and the buyer sees that', async () => {
    const sent = await submitted(world);
    const opened = await as(world, world.sellers.alpha.owner, 'GET', `/seller/rfqs/${sent.id}`);
    expect(sellerRfq(opened).invitation.status).toBe('VIEWED');
    expect(sellerRfq(opened).actions).toMatchObject({ canQuote: true, canDecline: true });
    const buyerView = await as(world, world.buyer, 'GET', `/rfqs/${sent.id}`);
    const invitation = buyerView
      .json<{ rfq: { invitations: { status: string; supplier: { sellerAccountId: string } }[] } }>()
      .rfq.invitations.find((entry) => entry.supplier.sellerAccountId === world.sellers.alpha.id);
    expect(invitation?.status).toBe('VIEWED');
  });

  it('lets a seller decline once, with a reason the buyer reads', async () => {
    const sent = await submitted(world);
    const { beta } = world.sellers;
    const declined = await as(world, beta.owner, 'POST', `/seller/rfqs/${sent.id}/decline`, { reason: 'No capacity in November' });
    expect(declined.statusCode, declined.body).toBe(200);
    expect(sellerRfq(declined).invitation.status).toBe('DECLINED');
    const again = await as(world, beta.owner, 'POST', `/seller/rfqs/${sent.id}/decline`, { reason: 'Still no' });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('RFQ_RESPONSE_CLOSED');

    const buyerView = await as(world, world.buyer, 'GET', `/rfqs/${sent.id}`);
    const row = buyerView
      .json<{ rfq: { invitations: { status: string; declineReason: string | null; supplier: { sellerAccountId: string } }[] } }>()
      .rfq.invitations.find((entry) => entry.supplier.sellerAccountId === beta.id);
    expect(row).toMatchObject({ status: 'DECLINED', declineReason: 'No capacity in November' });
    const audit = await prisma.auditLog.count({ where: { resourceId: sent.id, action: 'rfq.invitation_declined' } });
    expect(audit).toBe(1);
  });

  it('refuses a seller that is not approved to trade', async () => {
    const sent = await submitted(world);
    // An invitation that predates a suspension, say.
    await prisma.rfqInvitation.create({
      data: { id: newId(), rfqId: sent.id, sellerAccountId: world.sellers.pending.id, source: 'BUYER_SELECTED' },
    });
    const refused = await as(world, world.sellers.pending.owner, 'POST', `/seller/rfqs/${sent.id}/decline`, { reason: 'Not now' });
    expect(refused.statusCode).toBe(403);
    expect(errorCode(refused)).toBe('SELLER_NOT_APPROVED');
  });
});

describe('questions and answers', () => {
  it('keeps one thread per seller, without duplicates on resend or re-poll', async () => {
    const sent = await submitted(world);
    const { alpha, beta } = world.sellers;
    const clientMessageId = `m-${String(Date.now())}`;
    const first = await as(world, alpha.owner, 'POST', `/seller/rfqs/${sent.id}/messages`, {
      body: 'Is 5 mil acceptable instead of 4 mil?',
      clientMessageId,
    });
    expect(first.statusCode, first.body).toBe(201);
    const resend = await as(world, alpha.owner, 'POST', `/seller/rfqs/${sent.id}/messages`, {
      body: 'Is 5 mil acceptable instead of 4 mil?',
      clientMessageId,
    });
    expect(resend.json<{ message: { id: string } }>().message.id).toBe(first.json<{ message: { id: string } }>().message.id);

    const invitationId = sent.invitations.find((entry) => entry.supplier.sellerAccountId === alpha.id)?.id ?? '';
    const answer = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/invitations/${invitationId}/messages`, {
      body: 'Yes, 5 mil is fine.',
    });
    expect(answer.statusCode, answer.body).toBe(201);

    const thread = await as(world, alpha.owner, 'GET', `/seller/rfqs/${sent.id}/messages`);
    const messages = thread.json<{ messages: { id: string; from: string; body: string }[] }>().messages;
    expect(messages.map((message) => message.from)).toEqual(['SUPPLIER', 'BUYER']);
    const newer = await as(world, alpha.owner, 'GET', `/seller/rfqs/${sent.id}/messages?after=${messages[0]?.id ?? ''}`);
    expect(newer.json<{ messages: unknown[] }>().messages).toHaveLength(1);

    // BETA sees nothing of ALPHA's thread.
    const betaThread = await as(world, beta.owner, 'GET', `/seller/rfqs/${sent.id}/messages`);
    expect(betaThread.json<{ messages: unknown[] }>().messages).toEqual([]);
    // Another buyer cannot read or write it.
    expect((await as(world, world.rival, 'GET', `/rfqs/${sent.id}/invitations/${invitationId}/messages`)).statusCode).toBe(404);
    const notified = await prisma.sellerNotification.count({
      where: { sellerAccountId: alpha.id, kind: 'RFQ_UPDATE', subjectId: sent.id },
    });
    expect(notified).toBeGreaterThan(0);
  });
});

describe('requirement versions and the deadline', () => {
  it('publishes a change as a new version, tells the sellers, and refuses a change that changes nothing', async () => {
    const sent = await submitted(world);
    const current = await as(world, world.buyer, 'GET', `/rfqs/${sent.id}`);
    const version = current.json<{ rfq: { version: number } }>().rfq.version;
    const same = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/versions`, {
      ...current.json<{ rfq: { requirement: Record<string, unknown> } }>().rfq.requirement,
      expectedVersion: version,
      changeSummary: 'No real change',
    });
    expect(same.statusCode).toBe(409);
    expect(errorCode(same)).toBe('RFQ_NO_CHANGE');

    const amended = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/versions`, {
      ...current.json<{ rfq: { requirement: Record<string, unknown> } }>().rfq.requirement,
      quantity: '15000',
      expectedVersion: version,
      changeSummary: 'We need more boxes.',
    });
    expect(amended.statusCode, amended.body).toBe(200);

    const seller = sellerRfq(await as(world, world.sellers.alpha.owner, 'GET', `/seller/rfqs/${sent.id}`));
    expect(seller.versions.map((entry) => entry.versionNumber)).toEqual([1, 2]);
    expect(seller.versions[1]?.changedFields).toEqual(['quantity']);
    const notice = await prisma.sellerNotification.count({
      where: { sellerAccountId: world.sellers.alpha.id, kind: 'RFQ_UPDATE', title: { contains: 'version 2' } },
    });
    expect(notice).toBe(1);

    const categoryChange = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/versions`, {
      ...current.json<{ rfq: { requirement: Record<string, unknown> } }>().rfq.requirement,
      categoryId: world.otherCategoryId,
      expectedVersion: version + 1,
      changeSummary: 'Different shelf',
    });
    expect(errorDetails(categoryChange)).toContainEqual(expect.objectContaining({ code: 'CATEGORY_LOCKED' }));
    const stale = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/versions`, {
      ...current.json<{ rfq: { requirement: Record<string, unknown> } }>().rfq.requirement,
      quantity: '16000',
      expectedVersion: version,
      changeSummary: 'Old screen',
    });
    expect(errorDetails(stale)[0]?.code).toBe('STALE');
  });

  it('expires unanswered invitations once the UTC deadline passes, and gives them back when it moves later', async () => {
    const sent = await submitted(world);
    await prisma.rfqRequest.update({ where: { id: sent.id }, data: { responseDeadline: new Date(Date.now() - 1_000) } });
    const lapsed = sellerRfq(await as(world, world.sellers.alpha.owner, 'GET', `/seller/rfqs/${sent.id}`));
    expect(lapsed.invitation.status).toBe('EXPIRED');
    expect(lapsed.actions.canQuote).toBe(false);

    const current = await as(world, world.buyer, 'GET', `/rfqs/${sent.id}`);
    const rfq = current.json<{ rfq: { version: number; requirement: Record<string, unknown> } }>().rfq;
    const moved = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/versions`, {
      ...rfq.requirement,
      responseDeadline: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      deliveryTargetDate: new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10),
      expectedVersion: rfq.version,
      changeSummary: 'More time to quote.',
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const back = sellerRfq(await as(world, world.sellers.alpha.owner, 'GET', `/seller/rfqs/${sent.id}`));
    expect(['INVITED', 'VIEWED']).toContain(back.invitation.status);
  });
});

describe('files a seller may see', () => {
  it('serves the requirement files to invited sellers only', async () => {
    mutableEnv['RFQ_ALLOW_UNSCANNED_ATTACHMENTS'] = true;
    try {
      const draft = await as(world, world.buyer, 'POST', '/rfqs', completeDraft(world), { 'idempotency-key': key() });
      const id = draft.json<{ rfq: { id: string } }>().rfq.id;
      const stored = await upload(`/rfqs/${id}/attachments`, Buffer.from('%PDF-1.4\n%%EOF\n'));
      expect(stored.statusCode, stored.body).toBe(201);
      const attachmentId = stored.json<{ attachment: { id: string } }>().attachment.id;
      const sent = await as(world, world.buyer, 'POST', `/rfqs/${id}/submit`, { expectedVersion: 0 }, { 'idempotency-key': key() });
      expect(sent.statusCode).toBe(200);
      const url = `/seller/rfqs/${id}/attachments/${attachmentId}/download`;
      expect((await as(world, world.sellers.alpha.owner, 'GET', url)).statusCode).toBe(200);
      expect((await as(world, world.sellers.gamma.owner, 'GET', url)).statusCode).toBe(404);
    } finally {
      mutableEnv['RFQ_ALLOW_UNSCANNED_ATTACHMENTS'] = false;
    }
  });
});

describe('the seller inbox: fit, buyer, hiding and owners (JOURNEY-030)', () => {
  interface InboxItem {
    id: string;
    qualification: { score: number; reasons: string[]; flags: string[] };
    buyerVerification: string;
    hidden: boolean;
    assignedMember: { id: string; name: string } | null;
  }
  const items = (response: LightMyRequestResponse): InboxItem[] => response.json<{ items: InboxItem[] }>().items;

  it('scores the fit from the matching facts and says who is asking', async () => {
    const sent = await submitted(world);
    const inbox = await as(world, world.sellers.alpha.owner, 'GET', '/seller/rfqs');
    expect(inbox.statusCode, inbox.body).toBe(200);
    const item = items(inbox).find((entry) => entry.id === sent.id);
    expect(item?.qualification.reasons).toContain('LIVE_IN_CATEGORY');
    expect(item?.qualification.score).toBeGreaterThanOrEqual(40);
    expect(item?.qualification.score).toBeLessThanOrEqual(100);
    // The fixture's buyer buys for themselves.
    expect(item?.buyerVerification).toBe('INDIVIDUAL');

    const detail = await as(world, world.sellers.alpha.owner, 'GET', `/seller/rfqs/${sent.id}`);
    expect(detail.json<{ rfq: InboxItem }>().rfq).toMatchObject({
      qualification: item?.qualification,
      buyerVerification: 'INDIVIDUAL',
      hidden: false,
      assignedMember: null,
    });

    // A request from the company: a business, verified or not, never "individual".
    const fromCompany = await submitted(world, world.owner);
    const companyItem = items(await as(world, world.sellers.alpha.owner, 'GET', '/seller/rfqs')).find(
      (entry) => entry.id === fromCompany.id,
    );
    expect(['VERIFIED_BUSINESS', 'BUSINESS_PENDING', 'BUSINESS_NOT_VERIFIED']).toContain(companyItem?.buyerVerification);
  });

  it('hides a request from this seller only, and brings it back', async () => {
    const sent = await submitted(world);
    const { alpha } = world.sellers;
    const hidden = await as(world, alpha.owner, 'POST', `/seller/rfqs/${sent.id}/hide`, {});
    expect(hidden.statusCode, hidden.body).toBe(200);

    const action = await as(world, alpha.owner, 'GET', '/seller/rfqs');
    expect(items(action).map((entry) => entry.id)).not.toContain(sent.id);
    const hiddenView = await as(world, alpha.owner, 'GET', '/seller/rfqs?filter=hidden');
    expect(items(hiddenView).map((entry) => entry.id)).toContain(sent.id);
    expect(hiddenView.json<{ counts: Record<string, number> }>().counts.hidden).toBeGreaterThanOrEqual(1);

    // The buyer's list is unchanged.
    const buyerView = await as(world, world.buyer, 'GET', `/rfqs/${sent.id}`);
    const invitation = buyerView
      .json<{ rfq: { invitations: { status: string; supplier: { sellerAccountId: string } }[] } }>()
      .rfq.invitations.find((entry) => entry.supplier.sellerAccountId === alpha.id);
    expect(invitation).toBeDefined();

    const back = await as(world, alpha.owner, 'POST', `/seller/rfqs/${sent.id}/unhide`, {});
    expect(back.statusCode, back.body).toBe(200);
    expect(items(await as(world, alpha.owner, 'GET', '/seller/rfqs?filter=all')).map((entry) => entry.id)).toContain(sent.id);
    expect(await prisma.sellerAuditLog.count({ where: { sellerAccountId: alpha.id, action: { in: ['seller.rfq.hidden', 'seller.rfq.unhidden'] } } })).toBeGreaterThanOrEqual(2);
  });

  it('gives a request to a member of the team, filters by owner, and refuses somebody from another team', async () => {
    const sent = await submitted(world);
    const { alpha, gamma } = world.sellers;
    const member = await prisma.sellerMember.findFirstOrThrow({
      where: { sellerAccountId: alpha.id, customerProfileId: alpha.owner.profileId },
      select: { id: true },
    });
    const outsider = await prisma.sellerMember.findFirstOrThrow({
      where: { sellerAccountId: gamma.id, customerProfileId: gamma.owner.profileId },
      select: { id: true },
    });

    const assignees = await as(world, alpha.owner, 'GET', '/seller/rfqs/assignees');
    expect(assignees.json<{ members: { id: string }[] }>().members.map((row) => row.id)).toContain(member.id);

    const refused = await as(world, alpha.owner, 'POST', `/seller/rfqs/${sent.id}/assign`, { memberId: outsider.id });
    expect(refused.statusCode).toBe(400);
    expect(errorDetails(refused)).toEqual([expect.objectContaining({ field: 'memberId', code: 'NOT_A_MEMBER' })]);

    const given = await as(world, alpha.owner, 'POST', `/seller/rfqs/${sent.id}/assign`, { memberId: member.id });
    expect(given.statusCode, given.body).toBe(200);
    expect(given.json<{ rfq: InboxItem }>().rfq.assignedMember?.id).toBe(member.id);

    const mine = await as(world, alpha.owner, 'GET', '/seller/rfqs?filter=all&assignee=me');
    expect(items(mine).map((entry) => entry.id)).toContain(sent.id);
    const unassigned = await as(world, alpha.owner, 'GET', '/seller/rfqs?filter=all&assignee=unassigned');
    expect(items(unassigned).map((entry) => entry.id)).not.toContain(sent.id);

    const cleared = await as(world, alpha.owner, 'POST', `/seller/rfqs/${sent.id}/assign`, { memberId: null });
    expect(cleared.json<{ rfq: InboxItem }>().rfq.assignedMember).toBeNull();
  });
});
