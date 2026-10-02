/**
 * The message centre (checklist JOURNEY-055).
 *
 *   - An order thread is between the buyer and ONE seller: the seller of that
 *     part of the order. Another buyer and another seller get "not found".
 *   - A resend with the same clientMessageId is one message, not two.
 *   - The seller is told in Seller Hub; the buyer by an ORDER_MESSAGE email.
 *   - "Report message" writes one report per person per message, refuses a
 *     report of your own words, rings the staff bell, is audited, and staff
 *     decide it - which closes the bell.
 *   - Translation is off by default and says so with its own code.
 *   - An RFQ message may point at a file of its own thread, and only that.
 *
 * Built on the RFQ fixture (buyers and approved sellers with live Seller Hub
 * sessions). Everything written is removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { signInAdmin, type AdminSession } from '../support/admin-session.js';
import { as, buildRfqWorld, cleanRfqWorld, errorCode, submitted, type RfqWorld } from '../support/rfq-fixture.js';

const PREFIX = `mc${newId().slice(-6).toLowerCase()}`;
const STAFF_EMAIL = `${PREFIX}-staff@message-centre.test.local`;
const STAFF_PASSWORD = 'MessageCentre!2026x';

let world: RfqWorld;
let staff: AdminSession;
let staffUserId = '';
let orderId = '';
let groupId = '';
let otherGroupId = '';

async function makeOrder(): Promise<void> {
  orderId = newId();
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `MC-${PREFIX}`,
      customerProfileId: world.buyer.profileId,
      status: 'CONFIRMED',
      currency: 'INR',
      grandTotalMinor: 20_000n,
      paidMinor: 20_000n,
      placedAt: new Date(),
      billingAddressJson: { contactName: 'Test' },
      shippingAddressJson: { contactName: 'Test' },
    },
  });
  groupId = newId();
  otherGroupId = newId();
  await prisma.sellerOrderGroup.create({
    data: {
      id: groupId,
      sellerAccountId: world.sellers.alpha.id,
      orderId,
      sellerOrderNumber: `MCA-${PREFIX}`,
      goodsTotalMinor: 10_000n,
      currency: 'INR',
    },
  });
  await prisma.sellerOrderGroup.create({
    data: {
      id: otherGroupId,
      sellerAccountId: world.sellers.beta.id,
      orderId,
      sellerOrderNumber: `MCB-${PREFIX}`,
      goodsTotalMinor: 10_000n,
      currency: 'INR',
    },
  });
}

beforeAll(async () => {
  const app = await buildApp();
  await app.ready();
  world = await buildRfqWorld(app, PREFIX);
  await makeOrder();

  const role = await prisma.role.findUniqueOrThrow({ where: { key: Role.BUSINESS_OWNER } });
  staffUserId = newId();
  await prisma.user.create({
    data: {
      id: staffUserId,
      type: 'ADMIN',
      email: STAFF_EMAIL,
      emailNormalized: STAFF_EMAIL,
      passwordHash: await hashPassword(STAFF_PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: role.id } },
    },
  });
  staff = await signInAdmin(app, { email: STAFF_EMAIL, password: STAFF_PASSWORD, ip: '10.94.55.10' });
});

afterAll(async () => {
  const people = [world.buyer.userId, world.rival.userId, world.sellers.alpha.owner.userId, world.sellers.beta.owner.userId, staffUserId];
  const reports = await prisma.messageReport.findMany({ where: { reporterUserId: { in: people } }, select: { id: true } });
  await prisma.adminNotification.deleteMany({ where: { relatedType: 'message_report', relatedId: { in: reports.map((row) => row.id) } } });
  await prisma.messageReport.deleteMany({ where: { reporterUserId: { in: people } } });
  await prisma.auditLog.deleteMany({ where: { actorUserId: staffUserId } });
  await prisma.orderMessage.deleteMany({ where: { sellerOrderGroupId: { in: [groupId, otherGroupId] } } });
  await prisma.sellerOrderGroup.deleteMany({ where: { orderId } });
  await prisma.order.deleteMany({ where: { id: orderId } });
  await cleanRfqWorld(PREFIX);
  await prisma.session.deleteMany({ where: { userId: staffUserId } });
  await prisma.userRole.deleteMany({ where: { userId: staffUserId } });
  await prisma.user.deleteMany({ where: { id: staffUserId } });
  await world.app.close();
});

describe('order threads', () => {
  it('lets the buyer write to one seller and that seller only read it', async () => {
    const sent = await as(world, world.buyer, 'POST', `/orders/${orderId}/messages/${groupId}`, {
      body: 'Can you confirm the lot numbers before dispatch?',
      clientMessageId: `${PREFIX}-first`,
    });
    expect(sent.statusCode, sent.body).toBe(201);

    // A resend is the same message.
    const again = await as(world, world.buyer, 'POST', `/orders/${orderId}/messages/${groupId}`, {
      body: 'Can you confirm the lot numbers before dispatch?',
      clientMessageId: `${PREFIX}-first`,
    });
    expect(again.json<{ message: { id: string } }>().message.id).toBe(sent.json<{ message: { id: string } }>().message.id);

    const alpha = await as(world, world.sellers.alpha.owner, 'GET', `/seller/orders/${groupId}/messages`);
    expect(alpha.statusCode, alpha.body).toBe(200);
    expect(alpha.json<{ thread: { messages: { body: string; from: string }[] } }>().thread.messages).toHaveLength(1);

    // Beta sells another part of the same order and sees nothing of alpha's thread.
    const beta = await as(world, world.sellers.beta.owner, 'GET', `/seller/orders/${groupId}/messages`);
    expect(beta.statusCode).toBe(404);

    const notice = await prisma.sellerNotification.findFirst({
      where: { sellerAccountId: world.sellers.alpha.id, kind: 'ORDER_MESSAGE' },
    });
    expect(notice?.linkPath).toBe(`/seller/orders/${groupId}`);
  });

  it('refuses another buyer and lists the threads for the buyer', async () => {
    const rival = await as(world, world.rival, 'POST', `/orders/${orderId}/messages/${groupId}`, { body: 'Hello' });
    expect(rival.statusCode).toBe(404);
    const rivalRead = await as(world, world.rival, 'GET', `/orders/${orderId}/messages`);
    expect(rivalRead.statusCode).toBe(404);

    const threads = await as(world, world.buyer, 'GET', `/orders/${orderId}/messages`);
    expect(threads.statusCode, threads.body).toBe(200);
    const body = threads.json<{ threads: { sellerOrderGroupId: string; messages: unknown[] }[] }>();
    expect(body.threads.map((thread) => thread.sellerOrderGroupId).sort()).toEqual([groupId, otherGroupId].sort());

    const recent = await as(world, world.buyer, 'GET', '/account/order-messages');
    expect(recent.json<{ threads: { sellerOrderGroupId: string }[] }>().threads.map((row) => row.sellerOrderGroupId)).toEqual([groupId]);
  });

  it('emails the buyer when the seller answers', async () => {
    const reply = await as(world, world.sellers.alpha.owner, 'POST', `/seller/orders/${groupId}/messages`, {
      body: 'Lot numbers are on the packing list.',
    });
    expect(reply.statusCode, reply.body).toBe(201);
    const mail = await prisma.notificationOutbox.findFirst({
      where: { recipientEmail: world.buyer.email, eventKey: 'order.message' },
    });
    expect(mail?.relatedId).toBe(orderId);
  });
});

describe('reporting a message', () => {
  it('refuses your own message, records one report, rings the bell and is decided by staff', async () => {
    const thread = await prisma.orderMessage.findMany({ where: { sellerOrderGroupId: groupId }, orderBy: { id: 'asc' } });
    const own = thread.find((row) => row.authorParty === 'BUYER');
    const theirs = thread.find((row) => row.authorParty === 'SELLER');
    expect(own).toBeDefined();
    expect(theirs).toBeDefined();

    const refused = await as(world, world.buyer, 'POST', '/account/messages/reports', {
      threadKind: 'ORDER',
      messageId: own?.id,
      reason: 'ABUSE',
    });
    expect(refused.statusCode).toBe(409);
    expect(errorCode(refused)).toBe('MESSAGE_REPORT_OWN_MESSAGE');

    const first = await as(world, world.buyer, 'POST', '/account/messages/reports', {
      threadKind: 'ORDER',
      messageId: theirs?.id,
      reason: 'OFF_PLATFORM',
      note: 'Asked me to pay by bank transfer.',
    });
    expect(first.statusCode, first.body).toBe(201);
    const second = await as(world, world.buyer, 'POST', '/account/messages/reports', {
      threadKind: 'ORDER',
      messageId: theirs?.id,
      reason: 'OFF_PLATFORM',
    });
    const reportId = first.json<{ report: { id: string } }>().report.id;
    expect(second.json<{ report: { id: string } }>().report.id).toBe(reportId);

    // A stranger cannot report a message they cannot see.
    const stranger = await as(world, world.rival, 'POST', '/account/messages/reports', {
      threadKind: 'ORDER',
      messageId: theirs?.id,
      reason: 'SPAM',
    });
    expect(stranger.statusCode).toBe(404);

    const bell = await prisma.adminNotification.findFirst({ where: { relatedType: 'message_report', relatedId: reportId } });
    expect(bell?.status).toBe('ACTIVE');
    const audit = await prisma.auditLog.findFirst({ where: { action: 'message.reported', resourceId: reportId } });
    expect(audit?.actorUserId).toBe(world.buyer.userId);

    const queue = await world.app.inject({
      method: 'GET',
      url: '/api/v1/admin/message-reports?status=OPEN',
      headers: { cookie: staff.cookies },
    });
    expect(queue.statusCode, queue.body).toBe(200);
    const listed = queue.json<{ reports: { id: string; messageBody: string }[] }>().reports.find((row) => row.id === reportId);
    expect(listed?.messageBody).toBe('Lot numbers are on the packing list.');

    const decided = await world.app.inject({
      method: 'POST',
      url: `/api/v1/admin/message-reports/${reportId}/decision`,
      headers: { cookie: staff.cookies, 'x-csrf-token': staff.csrfToken },
      payload: { decision: 'DISMISSED', note: 'Packing list is on the platform; nothing off-platform.' },
    });
    expect(decided.statusCode, decided.body).toBe(204);
    const closed = await prisma.adminNotification.findFirst({ where: { relatedType: 'message_report', relatedId: reportId } });
    expect(closed?.status).toBe('RESOLVED');
    const report = await prisma.messageReport.findUniqueOrThrow({ where: { id: reportId } });
    expect(report.status).toBe('DISMISSED');
    expect(report.reviewedByUserId).toBe(staffUserId);
  });

  it('lets a seller report a buyer message in its own thread', async () => {
    const buyerMessage = await prisma.orderMessage.findFirstOrThrow({ where: { sellerOrderGroupId: groupId, authorParty: 'BUYER' } });
    const report = await as(world, world.sellers.alpha.owner, 'POST', '/seller/messages/reports', {
      threadKind: 'ORDER',
      messageId: buyerMessage.id,
      reason: 'SPAM',
    });
    expect(report.statusCode, report.body).toBe(201);
    const beta = await as(world, world.sellers.beta.owner, 'POST', '/seller/messages/reports', {
      threadKind: 'ORDER',
      messageId: buyerMessage.id,
      reason: 'SPAM',
    });
    expect(beta.statusCode).toBe(404);
  });
});

describe('translation', () => {
  it('is off by default and says so with its own code', async () => {
    const message = await prisma.orderMessage.findFirstOrThrow({ where: { sellerOrderGroupId: groupId, authorParty: 'SELLER' } });
    const response = await as(world, world.buyer, 'POST', '/account/messages/translate', {
      threadKind: 'ORDER',
      messageId: message.id,
      language: 'de',
    });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('MESSAGE_TRANSLATION_UNAVAILABLE');
  });
});

describe('RFQ message attachments', () => {
  it("refuses a file from another seller's thread", async () => {
    const rfq = await submitted(world);
    const alphaInvitation = rfq.invitations.find((row) => row.supplier.sellerAccountId === world.sellers.alpha.id);
    expect(alphaInvitation).toBeDefined();
    const foreign = await prisma.rfqAttachment.create({
      data: {
        id: newId(),
        rfqId: rfq.id,
        purpose: 'NEGOTIATION',
        sellerAccountId: world.sellers.beta.id,
        uploadedByParty: 'BUYER',
        uploadedByUserId: world.buyer.userId,
        storageKey: `test/${PREFIX}/foreign.pdf`,
        fileName: 'foreign.pdf',
        contentType: 'application/pdf',
        byteSize: 10,
        contentHash: '0'.repeat(64),
        scanState: 'CLEAN',
      },
    });
    const response = await as(world, world.buyer, 'POST', `/rfqs/${rfq.id}/invitations/${alphaInvitation?.id ?? ''}/messages`, {
      body: 'See the attached drawing.',
      attachmentId: foreign.id,
    });
    expect(response.statusCode).toBe(404);
  });
});
