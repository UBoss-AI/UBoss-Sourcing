/**
 * Support requests, end to end over HTTP, plus the one surface (the logistics
 * portal) whose sign-in is too heavy to stand up here, exercised through the
 * service with the requester its route would build.
 *
 * The claims, in the order the file makes them:
 *
 *   - the Support page's context is prefilled from the account, not the form;
 *   - sending needs an Idempotency-Key, and a retried or double-clicked send
 *     creates exactly one request;
 *   - malformed, empty and oversized requests are refused, naming the field;
 *   - an order number is accepted only if it is the sender's own order, and a
 *     stranger's order is refused exactly like a typo;
 *   - a sender reads only their own requests - another buyer, a seller
 *     colleague and a changed reference in the URL all get "not found";
 *   - internal notes, priority and assignment never reach the sender;
 *   - staff routes follow the permissions: no grant, no inbox;
 *   - status moves follow the state machine, and a closed request takes no
 *     more writing from anybody;
 *   - the daily cap holds, and the feature switch refuses new requests only;
 *   - the words never reach the audit trail or an email.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { buildApp as BuildApp } from '../../src/http/app.js';
import type { prisma as PrismaClient } from '../../src/infra/prisma.js';
import type { newId as NewId } from '../../src/infra/ids.js';
import type { env as Env } from '../../src/config/env.js';

type App = Awaited<ReturnType<typeof BuildApp>>;

let app: App;
let prisma: typeof PrismaClient;
let newId: typeof NewId;
let env: typeof Env;

const PREFIX = 'sup-';
const PASSWORD = 'SupportDesk!2026';
const HUB_PASSWORD = 'SellerHubLock!2026';
const EMAILS = {
  buyerA: 'sup-buyer-a@test.local',
  buyerB: 'sup-buyer-b@test.local',
  capped: 'sup-capped@test.local',
  seller: 'sup-seller@test.local',
  sellerColleague: 'sup-seller-colleague@test.local',
  logistics: 'sup-logistics@test.local',
  owner: 'sup-owner@test.local',
  orders: 'sup-orders@test.local',
  finance: 'sup-finance@test.local',
  catalog: 'sup-catalog@test.local',
};
const ALL_EMAILS = Object.values(EMAILS);

interface Session {
  cookies: string;
  csrf: string;
}

let buyerA: Session;
let buyerB: Session;
let capped: Session;
let seller: Session;
let sellerColleague: Session;
let owner: Session;
let orders: Session;
let finance: Session;
let catalog: Session;

let buyerAUserId = '';
let buyerAOrderNumber = '';
let buyerBOrderNumber = '';
let ordersUserId = '';
let catalogUserId = '';
let sellerAccountId = '';
let logisticsUserId = '';
let logisticsPartnerId = '';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fresh address per call, so the per-IP route limiter never decides a test. */
function someIp(): string {
  const byte = (): number => Math.floor(Math.random() * 250) + 1;
  return `10.${String(byte())}.${String(byte())}.${String(byte())}`;
}

interface CallOptions {
  idempotencyKey?: string;
}

async function call(
  session: Session | null,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
  options: CallOptions = {},
): Promise<{
  status: number;
  body: Record<string, unknown> & {
    error?: { code: string; details?: { field?: string; code?: string }[] };
  };
}> {
  const response = await app.inject({
    method,
    url,
    headers: {
      'x-forwarded-for': someIp(),
      ...(session === null
        ? {}
        : {
            cookie: session.cookies,
            ...(method === 'GET' ? {} : { 'x-csrf-token': session.csrf }),
          }),
      ...(options.idempotencyKey === undefined
        ? {}
        : { 'idempotency-key': options.idempotencyKey }),
    },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  let body: Record<string, unknown>;
  try {
    body = response.json<Record<string, unknown>>();
  } catch {
    body = { raw: response.body };
  }
  return { status: response.statusCode, body };
}

function send(
  session: Session,
  payload: Record<string, unknown>,
  key = crypto.randomUUID(),
  base = '/api/v1/support',
) {
  return call(session, 'POST', `${base}/tickets`, payload, { idempotencyKey: key });
}

const GOOD_REQUEST = {
  name: 'Asha Rao',
  category: 'ORDERS',
  subject: 'Where is my delivery?',
  message: 'My order was due yesterday and the tracking has not moved since Monday.',
  language: 'en',
};

async function signInCustomer(email: string): Promise<Session> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': someIp() },
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const jar = login.cookies as { name: string; value: string }[];
  return {
    cookies: jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    csrf: jar.find((cookie) => cookie.name === 'uboss_shop_csrf')?.value ?? '',
  };
}

/** Sign in, then choose and open the Seller Hub password so the seller guard passes. */
async function signInSeller(email: string): Promise<Session> {
  const session = await signInCustomer(email);
  const set = await call(session, 'POST', '/api/v1/sellers/lock', { newPassword: HUB_PASSWORD });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  const open = await call(session, 'POST', '/api/v1/sellers/lock/open', { password: HUB_PASSWORD });
  expect(open.status, JSON.stringify(open.body)).toBe(200);
  return session;
}

async function signInStaff(email: string): Promise<Session> {
  const { signInAdmin } = await import('../support/admin-session.js');
  const session = await signInAdmin(app, { email, password: PASSWORD });
  return { cookies: session.cookies, csrf: session.csrfToken };
}

async function createUser(
  email: string,
  type: 'CUSTOMER' | 'LOGISTICS',
): Promise<{ userId: string; profileId: string | null }> {
  const { hashPassword } = await import('../../src/infra/crypto.js');
  const user = await prisma.user.create({
    data: {
      id: newId(),
      type,
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  if (type === 'LOGISTICS') return { userId: user.id, profileId: null };
  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId: user.id, fullName: `Name of ${email}`, activatedAt: new Date() },
  });
  return { userId: user.id, profileId: profile.id };
}

async function createStaff(email: string, roleKey: string): Promise<string> {
  const { hashPassword } = await import('../../src/infra/crypto.js');
  const role = await prisma.role.findUniqueOrThrow({
    where: { key: roleKey },
    select: { id: true },
  });
  const user = await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: role.id } },
    },
  });
  return user.id;
}

async function createOrder(customerProfileId: string): Promise<string> {
  const orderNumber = `SUP-${newId().slice(-10)}`;
  await prisma.order.create({
    data: {
      id: newId(),
      orderNumber,
      customerProfileId,
      status: 'CONFIRMED',
      currency: 'INR',
      grandTotalMinor: 10_000n,
      placedAt: new Date(),
      billingAddressJson: { contactName: 'Test' },
      shippingAddressJson: { contactName: 'Test' },
    },
  });
  return orderNumber;
}

async function cleanUp(): Promise<void> {
  const users = { emailNormalized: { in: ALL_EMAILS } };
  const tickets = await prisma.supportTicket.findMany({
    where: { requester: users },
    select: { id: true },
  });
  const ticketIds = tickets.map((ticket) => ticket.id);
  await prisma.adminNotification.deleteMany({ where: { relatedId: { in: ticketIds } } });
  await prisma.notificationOutbox.deleteMany({ where: { relatedId: { in: ticketIds } } });
  await prisma.auditLog.deleteMany({
    where: { resourceType: 'support_ticket', resourceId: { in: ticketIds } },
  });
  // The stored bytes of any files, then the rows (the cascade takes those).
  const files = await prisma.supportTicketAttachment.findMany({
    where: { ticketId: { in: ticketIds } },
    select: { storageKey: true },
  });
  const { storage } = await import('../../src/infra/storage/index.js');
  for (const file of files) await storage.delete(file.storageKey).catch(() => undefined);
  await prisma.supportTicket.deleteMany({ where: { id: { in: ticketIds } } });
  await prisma.idempotencyRecord.deleteMany({
    where: {
      scope: { startsWith: 'support_ticket.' },
      ownerId: {
        in: (await prisma.user.findMany({ where: users, select: { id: true } })).map((u) => u.id),
      },
    },
  });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: 'SUP-' } } });
  await prisma.sellerMember.deleteMany({
    where: { sellerAccount: { slug: { startsWith: PREFIX } } },
  });
  await prisma.sellerAccount.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.logisticsPartner.deleteMany({ where: { partnerCode: { startsWith: 'SUP' } } });
  await prisma.customerProfile.deleteMany({ where: { user: users } });
  await prisma.session.deleteMany({ where: { user: users } });
  await prisma.authToken.deleteMany({ where: { user: users } });
  await prisma.userRole.deleteMany({ where: { user: users } });
  await prisma.auditLog.deleteMany({ where: { actorEmail: { in: ALL_EMAILS } } });
  await prisma.user.deleteMany({ where: users });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // This file accepts unscanned attachments, deliberately and only here: the
  // test database has no ClamAV, and what is under test is everything around
  // the scan. A small limit, so "too large" is cheap.
  process.env.SUPPORT_ALLOW_UNSCANNED_ATTACHMENTS = 'true';
  process.env.SUPPORT_ATTACHMENT_MAX_BYTES = '4096';

  ({ prisma } = await import('../../src/infra/prisma.js'));
  ({ newId } = await import('../../src/infra/ids.js'));
  ({ env } = await import('../../src/config/env.js'));
  const { buildApp } = await import('../../src/http/app.js');
  const { Role } = await import('../../src/domain/permissions.js');

  await cleanUp();

  const a = await createUser(EMAILS.buyerA, 'CUSTOMER');
  buyerAUserId = a.userId;
  buyerAOrderNumber = await createOrder(a.profileId ?? '');
  const b = await createUser(EMAILS.buyerB, 'CUSTOMER');
  buyerBOrderNumber = await createOrder(b.profileId ?? '');
  await createUser(EMAILS.capped, 'CUSTOMER');

  // A seller with two members: the owner, and a colleague on the same seller.
  const sellerOwner = await createUser(EMAILS.seller, 'CUSTOMER');
  const colleague = await createUser(EMAILS.sellerColleague, 'CUSTOMER');
  sellerAccountId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerAccountId,
      legalName: 'Support Test Supplies Ltd',
      displayName: 'Support Test Supplies',
      displayNameNormalized: 'sup support test supplies',
      slug: `${PREFIX}seller`,
      kind: 'WHOLESALER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });
  await prisma.sellerMember.createMany({
    data: [
      {
        id: newId(),
        sellerAccountId,
        customerProfileId: sellerOwner.profileId ?? '',
        role: 'OWNER',
      },
      { id: newId(), sellerAccountId, customerProfileId: colleague.profileId ?? '', role: 'OWNER' },
    ],
  });

  const logistics = await createUser(EMAILS.logistics, 'LOGISTICS');
  logisticsUserId = logistics.userId;
  logisticsPartnerId = newId();
  await prisma.logisticsPartner.create({
    data: {
      id: logisticsPartnerId,
      partnerCode: `SUP${newId().slice(-8)}`,
      legalName: 'Support Test Freight Ltd',
      displayName: 'Support Test Freight',
      displayNameNormalized: `support test freight ${newId().slice(-6)}`,
      registrationCountry: 'IN',
      contactEmail: EMAILS.logistics,
    },
  });

  await createStaff(EMAILS.owner, Role.BUSINESS_OWNER);
  ordersUserId = await createStaff(EMAILS.orders, Role.ORDER_MANAGER);
  await createStaff(EMAILS.finance, Role.FINANCE_APPROVER);
  catalogUserId = await createStaff(EMAILS.catalog, Role.CATALOG_MANAGER);

  app = await buildApp();
  await app.ready();

  buyerA = await signInCustomer(EMAILS.buyerA);
  buyerB = await signInCustomer(EMAILS.buyerB);
  capped = await signInCustomer(EMAILS.capped);
  seller = await signInSeller(EMAILS.seller);
  sellerColleague = await signInSeller(EMAILS.sellerColleague);
  owner = await signInStaff(EMAILS.owner);
  orders = await signInStaff(EMAILS.orders);
  finance = await signInStaff(EMAILS.finance);
  catalog = await signInStaff(EMAILS.catalog);
}, 120_000);

afterAll(async () => {
  await cleanUp();
  await app.close();
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

describe('the Support page context', () => {
  it('is prefilled from the account, with the published contacts', async () => {
    const response = await call(buyerA, 'GET', '/api/v1/support/context');
    expect(response.status).toBe(200);
    const context = response.body as {
      enabled: boolean;
      requester: {
        name: string;
        email: string;
        role: string;
        companyNameEditable: boolean;
        canReferenceOrder: boolean;
      };
      contacts: { email: string | null; phone: string | null };
    };
    expect(context.enabled).toBe(true);
    expect(context.requester.name).toBe(`Name of ${EMAILS.buyerA}`);
    expect(context.requester.email).toBe(EMAILS.buyerA);
    expect(context.requester.role).toBe('BUYER');
    expect(context.requester.companyNameEditable).toBe(true);
    expect(context.requester.canReferenceOrder).toBe(true);
    expect(context.contacts).toHaveProperty('email');
  });

  it('needs a signed-in customer', async () => {
    expect((await call(null, 'GET', '/api/v1/support/context')).status).toBe(401);
    expect(
      (
        await call(null, 'POST', '/api/v1/support/tickets', GOOD_REQUEST, {
          idempotencyKey: crypto.randomUUID(),
        })
      ).status,
    ).toBe(401);
  });

  it('puts the seller, not a typed company, on a Seller Hub request', async () => {
    const response = await call(seller, 'GET', '/api/v1/seller/support/context');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const requester = (
      response.body as {
        requester: { role: string; companyName: string; companyNameEditable: boolean };
      }
    ).requester;
    expect(requester.role).toBe('SELLER');
    expect(requester.companyName).toBe('Support Test Supplies');
    expect(requester.companyNameEditable).toBe(false);
  });
});

describe('sending a request', () => {
  let reference = '';

  it('refuses a send without an Idempotency-Key', async () => {
    const response = await call(buyerA, 'POST', '/api/v1/support/tickets', GOOD_REQUEST);
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('creates one request with a reference and the account email, whatever the form said', async () => {
    const response = await send(buyerA, {
      ...GOOD_REQUEST,
      orderNumber: buyerAOrderNumber.toLowerCase(),
      // Not a field the API reads. Present to prove it is ignored.
      email: 'someone-else@test.local',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const body = response.body as {
      ticket: { reference: string; status: string; relatedOrderNumber: string };
      acknowledgementQueued: boolean;
    };
    reference = body.ticket.reference;
    expect(reference).toMatch(/^SR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(body.ticket.status).toBe('OPEN');
    expect(body.ticket.relatedOrderNumber).toBe(buyerAOrderNumber);

    const row = await prisma.supportTicket.findUniqueOrThrow({ where: { reference } });
    expect(row.emailSnapshot).toBe(EMAILS.buyerA);
    expect(row.requesterUserId).toBe(buyerAUserId);
    expect(row.requesterRole).toBe('BUYER');
    expect(row.source).toBe('STOREFRONT');

    // Told honestly: the acknowledgement is queued only if it really was.
    const outbox = await prisma.notificationOutbox.findMany({
      where: { relatedId: row.id, eventKey: 'support_ticket.received' },
    });
    expect(body.acknowledgementQueued).toBe(outbox.length === 1);

    const bell = await prisma.adminNotification.findMany({ where: { relatedId: row.id } });
    expect(bell).toHaveLength(1);
    expect(bell[0]?.requiredPermission).toBe('support_ticket.view');
  });

  it('never puts the message in the audit trail, the bell or an email', async () => {
    const row = await prisma.supportTicket.findUniqueOrThrow({ where: { reference } });
    const audit = await prisma.auditLog.findMany({ where: { resourceId: row.id } });
    const bell = await prisma.adminNotification.findMany({ where: { relatedId: row.id } });
    const mail = await prisma.notificationOutbox.findMany({ where: { relatedId: row.id } });
    const everything = JSON.stringify([audit, bell, mail]);
    expect(everything).not.toContain('tracking has not moved');
  });

  it('replays the first answer for a retried key and creates nothing more', async () => {
    const key = crypto.randomUUID();
    const first = await send(buyerA, GOOD_REQUEST, key);
    const second = await send(buyerA, GOOD_REQUEST, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const a = (first.body as { ticket: { reference: string } }).ticket.reference;
    const b = (second.body as { ticket: { reference: string } }).ticket.reference;
    expect(b).toBe(a);
    expect(await prisma.supportTicket.count({ where: { reference: a } })).toBe(1);
  });

  it('creates exactly one request for a double-clicked Submit', async () => {
    const key = crypto.randomUUID();
    const before = await prisma.supportTicket.count({ where: { requesterUserId: buyerAUserId } });
    const results = await Promise.allSettled([
      send(buyerA, GOOD_REQUEST, key),
      send(buyerA, GOOD_REQUEST, key),
    ]);
    const statuses = results.map((result) =>
      result.status === 'fulfilled' ? result.value.status : 0,
    );
    expect(statuses).toContain(201);
    for (const status of statuses) expect([201, 409]).toContain(status);
    expect(await prisma.supportTicket.count({ where: { requesterUserId: buyerAUserId } })).toBe(
      before + 1,
    );
  });

  it('refuses the same key for a different request', async () => {
    const key = crypto.randomUUID();
    expect((await send(buyerA, GOOD_REQUEST, key)).status).toBe(201);
    const reused = await send(buyerA, { ...GOOD_REQUEST, subject: 'Something else entirely' }, key);
    expect(reused.status).toBe(409);
    expect(reused.body.error?.code).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY');
  });

  it.each([
    ['an empty message', { message: '   ' }, 'message'],
    ['a short subject', { subject: 'Hi' }, 'subject'],
    ['an oversized message', { message: 'x'.repeat(5001) }, 'message'],
  ])('refuses %s, naming the field', async (_label, change, field) => {
    const response = await send(buyerA, { ...GOOD_REQUEST, ...change });
    expect(response.status).toBe(400);
    expect(response.body.error?.details?.some((detail) => detail.field === field)).toBe(true);
  });

  it('takes the name from the account when the form sends none', async () => {
    const { name: _unused, ...issueOnly } = GOOD_REQUEST;
    const response = await send(buyerA, issueOnly);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const reference = (response.body as { ticket: { reference: string } }).ticket.reference;
    const row = await prisma.supportTicket.findUniqueOrThrow({ where: { reference } });
    expect(row.nameSnapshot).toBe(`Name of ${EMAILS.buyerA}`);
    expect(row.emailSnapshot).toBe(EMAILS.buyerA);
  });

  it('refuses a malformed body', async () => {
    expect((await send(buyerA, { ...GOOD_REQUEST, category: 'FREE_MONEY' })).status).toBe(400);
    expect((await send(buyerA, { ...GOOD_REQUEST, message: 'x'.repeat(20_001) })).status).toBe(400);
    expect((await send(buyerA, { subject: 'No message at all' })).status).toBe(400);
  });

  it("refuses another buyer's order number exactly like a typo", async () => {
    const stranger = await send(buyerA, { ...GOOD_REQUEST, orderNumber: buyerBOrderNumber });
    const typo = await send(buyerA, { ...GOOD_REQUEST, orderNumber: 'SUP-NOSUCHORDER' });
    expect(stranger.status).toBe(422);
    expect(typo.status).toBe(422);
    expect(stranger.body.error?.code).toBe('SUPPORT_ORDER_NOT_FOUND');
    // Same answer, word for word; only the correlation id differs.
    const { correlationId: _a, ...strangerError } = stranger.body.error as Record<string, unknown>;
    const { correlationId: _b, ...typoError } = typo.body.error as Record<string, unknown>;
    expect(strangerError).toEqual(typoError);
  });

  it('stores text as written, minus the characters that exist to deceive', async () => {
    const response = await send(buyerA, {
      ...GOOD_REQUEST,
      subject: 'Invoice <b>bold</b> ‮fdp.exe',
      message: '<script>alert(1)</script> is what I typed\u0000 and meant.',
    });
    expect(response.status).toBe(201);
    const ticket = (response.body as { ticket: { subject: string; message: string } }).ticket;
    expect(ticket.subject).toBe('Invoice <b>bold</b> fdp.exe');
    expect(ticket.message).toBe('<script>alert(1)</script> is what I typed and meant.');
  });
});

// ---------------------------------------------------------------------------
// Reading your own
// ---------------------------------------------------------------------------

describe('who can read a request', () => {
  let reference = '';
  let ticketId = '';

  beforeAll(async () => {
    const response = await send(buyerA, { ...GOOD_REQUEST, subject: 'Private matter for A' });
    reference = (response.body as { ticket: { reference: string } }).ticket.reference;
    ticketId = (await prisma.supportTicket.findUniqueOrThrow({ where: { reference } })).id;
  });

  it('lets the sender list and read it', async () => {
    const list = await call(buyerA, 'GET', '/api/v1/support/tickets');
    expect(list.status).toBe(200);
    const references = (list.body as { tickets: { reference: string }[] }).tickets.map(
      (t) => t.reference,
    );
    expect(references).toContain(reference);
    const one = await call(buyerA, 'GET', `/api/v1/support/tickets/${reference}`);
    expect(one.status).toBe(200);
  });

  it('answers another buyer "not found", and lists nothing of it', async () => {
    const one = await call(buyerB, 'GET', `/api/v1/support/tickets/${reference}`);
    expect(one.status).toBe(404);
    const list = await call(buyerB, 'GET', '/api/v1/support/tickets');
    const references = (list.body as { tickets: { reference: string }[] }).tickets.map(
      (t) => t.reference,
    );
    expect(references).not.toContain(reference);
    const write = await call(
      buyerB,
      'POST',
      `/api/v1/support/tickets/${reference}/messages`,
      { body: 'Let me in' },
      { idempotencyKey: crypto.randomUUID() },
    );
    expect(write.status).toBe(404);
  });

  it('keeps a Seller Hub request from a colleague at the same seller', async () => {
    const sent = await send(
      seller,
      { ...GOOD_REQUEST, category: 'SELLER_HUB', subject: 'Payout question' },
      crypto.randomUUID(),
      '/api/v1/seller/support',
    );
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const sellerRef = (sent.body as { ticket: { reference: string; companyName: string } }).ticket
      .reference;
    const row = await prisma.supportTicket.findUniqueOrThrow({ where: { reference: sellerRef } });
    expect(row.sellerAccountId).toBe(sellerAccountId);
    expect(row.requesterRole).toBe('SELLER');
    expect(row.companyNameSnapshot).toBe('Support Test Supplies');

    expect(
      (await call(sellerColleague, 'GET', `/api/v1/seller/support/tickets/${sellerRef}`)).status,
    ).toBe(404);
    // Nor does the storefront list show a Seller Hub request, even to its sender.
    expect((await call(seller, 'GET', `/api/v1/support/tickets/${sellerRef}`)).status).toBe(404);
    expect((await call(seller, 'GET', `/api/v1/seller/support/tickets/${sellerRef}`)).status).toBe(
      200,
    );
  });

  it('shows the sender the team, never internal notes, priority or assignment', async () => {
    expect(
      (
        await call(orders, 'POST', `/api/v1/admin/support-tickets/${ticketId}/notes`, {
          body: 'Customer is on the VIP list',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(orders, 'PATCH', `/api/v1/admin/support-tickets/${ticketId}`, {
          priority: 'URGENT',
        })
      ).status,
    ).toBe(200);
    const replied = await call(
      orders,
      'POST',
      `/api/v1/admin/support-tickets/${ticketId}/replies`,
      { body: 'We are checking with the carrier.', nextStatus: 'WAITING_FOR_CUSTOMER' },
    );
    expect(replied.status, JSON.stringify(replied.body)).toBe(200);

    const view = await call(buyerA, 'GET', `/api/v1/support/tickets/${reference}`);
    const text = JSON.stringify(view.body);
    expect(text).not.toContain('VIP list');
    expect(text).not.toContain('URGENT');
    expect(text).not.toContain(EMAILS.orders);
    expect(text).not.toContain(ordersUserId);
    const ticket = (
      view.body as {
        ticket: { status: string; thread: { kind: string; author: string; body: string | null }[] };
      }
    ).ticket;
    expect(ticket.status).toBe('WAITING_FOR_CUSTOMER');
    const reply = ticket.thread.find((entry) => entry.kind === 'STAFF_REPLY');
    expect(reply?.author).toBe('TEAM');
    expect(reply?.body).toBe('We are checking with the carrier.');

    // The reply emailed a link, and not the words.
    const mail = await prisma.notificationOutbox.findMany({
      where: { relatedId: ticketId, eventKey: 'support_ticket.reply' },
    });
    for (const row of mail) expect(row.body).not.toContain('checking with the carrier');
  });

  it('puts a request staff were waiting on back in their queue when the sender answers', async () => {
    const answered = await call(
      buyerA,
      'POST',
      `/api/v1/support/tickets/${reference}/messages`,
      { body: 'Tracking number is 12345.' },
      { idempotencyKey: crypto.randomUUID() },
    );
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect((answered.body as { ticket: { status: string } }).ticket.status).toBe('IN_PROGRESS');
  });

  it('posts one message for a retried key', async () => {
    const key = crypto.randomUUID();
    await call(
      buyerA,
      'POST',
      `/api/v1/support/tickets/${reference}/messages`,
      { body: 'Once only' },
      { idempotencyKey: key },
    );
    await call(
      buyerA,
      'POST',
      `/api/v1/support/tickets/${reference}/messages`,
      { body: 'Once only' },
      { idempotencyKey: key },
    );
    expect(await prisma.supportTicketEvent.count({ where: { ticketId, body: 'Once only' } })).toBe(
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

describe('the console inbox', () => {
  let ticketId = '';

  beforeAll(async () => {
    const response = await send(buyerA, { ...GOOD_REQUEST, subject: 'Staff workflow request' });
    const reference = (response.body as { ticket: { reference: string } }).ticket.reference;
    ticketId = (await prisma.supportTicket.findUniqueOrThrow({ where: { reference } })).id;
  });

  it('is closed to staff without the support permission', async () => {
    expect((await call(catalog, 'GET', '/api/v1/admin/support-tickets')).status).toBe(403);
    expect((await call(catalog, 'GET', `/api/v1/admin/support-tickets/${ticketId}`)).status).toBe(
      403,
    );
    expect((await call(buyerA, 'GET', '/api/v1/admin/support-tickets')).status).toBe(401);
  });

  it('lets finance read but not answer', async () => {
    expect((await call(finance, 'GET', `/api/v1/admin/support-tickets/${ticketId}`)).status).toBe(
      200,
    );
    expect(
      (
        await call(finance, 'POST', `/api/v1/admin/support-tickets/${ticketId}/replies`, {
          body: 'Hello',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(finance, 'PATCH', `/api/v1/admin/support-tickets/${ticketId}`, {
          status: 'CLOSED',
        })
      ).status,
    ).toBe(403);
  });

  it('finds a request by reference and shows the requester context', async () => {
    const one = await call(orders, 'GET', `/api/v1/admin/support-tickets/${ticketId}`);
    const reference = (one.body as { ticket: { reference: string } }).ticket.reference;
    const list = await call(orders, 'GET', `/api/v1/admin/support-tickets?search=${reference}`);
    expect(list.status).toBe(200);
    const rows = (list.body as { tickets: { id: string; requesterEmail: string }[] }).tickets;
    expect(rows.map((row) => row.id)).toEqual([ticketId]);
    expect(rows[0]?.requesterEmail).toBe(EMAILS.buyerA);
  });

  it('links the related order only for somebody who may read orders', async () => {
    const sent = await send(buyerA, { ...GOOD_REQUEST, orderNumber: buyerAOrderNumber });
    const reference = (sent.body as { ticket: { reference: string } }).ticket.reference;
    const id = (await prisma.supportTicket.findUniqueOrThrow({ where: { reference } })).id;

    const asOrders = await call(orders, 'GET', `/api/v1/admin/support-tickets/${id}`);
    const withOrder = (
      asOrders.body as { ticket: { relatedOrder: { id: string | null; orderNumber: string } } }
    ).ticket.relatedOrder;
    expect(withOrder.orderNumber).toBe(buyerAOrderNumber);
    expect(withOrder.id).not.toBeNull();
  });

  it('assigns by the permissions: taking needs reply, giving needs assign', async () => {
    const assignees = await call(orders, 'GET', '/api/v1/admin/support-tickets/assignees');
    const ids = (assignees.body as { assignees: { id: string }[] }).assignees.map((a) => a.id);
    expect(ids).toContain(ordersUserId);
    expect(ids).not.toContain(catalogUserId);

    expect(
      (
        await call(orders, 'POST', `/api/v1/admin/support-tickets/${ticketId}/assignment`, {
          assigneeUserId: ordersUserId,
        })
      ).status,
    ).toBe(200);
    // Handing it to somebody else is the owner's call, not the order desk's.
    const give = await call(
      orders,
      'POST',
      `/api/v1/admin/support-tickets/${ticketId}/assignment`,
      { assigneeUserId: catalogUserId },
    );
    expect(give.status).toBe(403);
    const ineligible = await call(
      owner,
      'POST',
      `/api/v1/admin/support-tickets/${ticketId}/assignment`,
      { assigneeUserId: catalogUserId },
    );
    expect(ineligible.status).toBe(400);
    expect(ineligible.body.error?.code).toBe('SUPPORT_ASSIGNEE_NOT_ELIGIBLE');
  });

  it('moves status only along the state machine, and a closed request takes nothing more', async () => {
    expect(
      (
        await call(orders, 'PATCH', `/api/v1/admin/support-tickets/${ticketId}`, {
          status: 'IN_PROGRESS',
        })
      ).status,
    ).toBe(200);
    // OPEN means "nobody has picked it up" - a fact, not something to set.
    const reopenOpen = await call(orders, 'PATCH', `/api/v1/admin/support-tickets/${ticketId}`, {
      status: 'OPEN',
    });
    expect(reopenOpen.status).toBe(409);
    expect(reopenOpen.body.error?.code).toBe('SUPPORT_TICKET_TRANSITION_NOT_ALLOWED');

    expect(
      (
        await call(orders, 'PATCH', `/api/v1/admin/support-tickets/${ticketId}`, {
          status: 'RESOLVED',
        })
      ).status,
    ).toBe(200);
    const resolved = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(resolved.resolvedAt).not.toBeNull();

    expect(
      (
        await call(orders, 'PATCH', `/api/v1/admin/support-tickets/${ticketId}`, {
          status: 'CLOSED',
        })
      ).status,
    ).toBe(200);
    const reference = resolved.reference;

    const staffReply = await call(
      orders,
      'POST',
      `/api/v1/admin/support-tickets/${ticketId}/replies`,
      { body: 'One more thing' },
    );
    expect(staffReply.status).toBe(409);
    expect(staffReply.body.error?.code).toBe('SUPPORT_TICKET_CLOSED');
    const senderReply = await call(
      buyerA,
      'POST',
      `/api/v1/support/tickets/${reference}/messages`,
      { body: 'Hello?' },
      { idempotencyKey: crypto.randomUUID() },
    );
    expect(senderReply.status).toBe(409);
    expect(senderReply.body.error?.code).toBe('SUPPORT_TICKET_CLOSED');
    expect(
      (
        await call(owner, 'PATCH', `/api/v1/admin/support-tickets/${ticketId}`, {
          status: 'IN_PROGRESS',
        })
      ).status,
    ).toBe(409);
  });

  it('records a complete history staff can read', async () => {
    const one = await call(owner, 'GET', `/api/v1/admin/support-tickets/${ticketId}`);
    const kinds = (one.body as { ticket: { events: { kind: string }[] } }).ticket.events.map(
      (e) => e.kind,
    );
    expect(kinds[0]).toBe('CREATED');
    expect(kinds).toContain('ASSIGNED');
    // IN_PROGRESS, RESOLVED, CLOSED - and nothing for the refused moves.
    expect(kinds.filter((kind) => kind === 'STATUS_CHANGED')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Limits and the switch
// ---------------------------------------------------------------------------

describe('limits', () => {
  it('holds the daily cap per account', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { emailNormalized: EMAILS.capped } });
    const now = new Date();
    await prisma.supportTicket.createMany({
      data: Array.from({ length: env.SUPPORT_TICKETS_PER_DAY }, (_, index) => ({
        id: newId(),
        reference: `SR-CAP${String(index).padStart(1, '0')}-${newId().slice(-4)}`,
        requesterUserId: user.id,
        requesterRole: 'BUYER' as const,
        source: 'STOREFRONT' as const,
        nameSnapshot: 'Capped',
        emailSnapshot: EMAILS.capped,
        category: 'OTHER' as const,
        subject: 'Earlier',
        message: 'An earlier request today.',
        createdAt: now,
        lastActivityAt: now,
      })),
    });

    const refused = await send(capped, GOOD_REQUEST);
    expect(refused.status).toBe(429);
    expect(refused.body.error?.code).toBe('SUPPORT_TICKET_LIMIT_REACHED');
  });

  it('refuses new requests when switched off, and keeps the thread answerable', async () => {
    const sent = await send(buyerB, GOOD_REQUEST);
    const reference = (sent.body as { ticket: { reference: string } }).ticket.reference;

    const mutable = env as { FEATURE_SUPPORT_TICKETS: boolean };
    mutable.FEATURE_SUPPORT_TICKETS = false;
    try {
      const off = await send(buyerB, GOOD_REQUEST);
      expect(off.status).toBe(403);
      expect(off.body.error?.code).toBe('FEATURE_DISABLED');
      const context = await call(buyerB, 'GET', '/api/v1/support/context');
      expect((context.body as { enabled: boolean }).enabled).toBe(false);
      const reply = await call(
        buyerB,
        'POST',
        `/api/v1/support/tickets/${reference}/messages`,
        { body: 'Still here' },
        { idempotencyKey: crypto.randomUUID() },
      );
      expect(reply.status).toBe(200);
    } finally {
      mutable.FEATURE_SUPPORT_TICKETS = true;
    }
  });
});

// ---------------------------------------------------------------------------
// The logistics portal, through the service
// ---------------------------------------------------------------------------

describe('a logistics partner', () => {
  it('sends for its own company, cannot name an order, and is isolated from buyers', async () => {
    const service = await import('../../src/modules/support/support-ticket.service.js');
    const requester = {
      userId: logisticsUserId,
      email: EMAILS.logistics,
      emailVerified: true,
      source: 'LOGISTICS_PORTAL' as const,
      role: 'LOGISTICS_PARTNER' as const,
      accountName: 'Dispatcher',
      customerProfileId: null,
      buyerCompanyId: null,
      sellerAccountId: null,
      logisticsPartnerId,
      fixedCompanyName: 'Support Test Freight',
      orderScope: null,
    };

    const context = await service.readSupportContext(requester);
    expect(context.requester.canReferenceOrder).toBe(false);

    await expect(
      service.createSupportTicket(requester, {
        ...GOOD_REQUEST,
        category: 'LOGISTICS',
        orderNumber: buyerAOrderNumber,
      }),
    ).rejects.toMatchObject({ code: 'SUPPORT_ORDER_NOT_FOUND' });

    const { ticket } = await service.createSupportTicket(requester, {
      ...GOOD_REQUEST,
      category: 'LOGISTICS',
    });
    expect(ticket.companyName).toBe('Support Test Freight');

    // The same person under another company, and a buyer, both see nothing.
    await expect(
      service.readOwnSupportTicket({ ...requester, logisticsPartnerId: newId() }, ticket.reference),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await call(buyerA, 'GET', `/api/v1/support/tickets/${ticket.reference}`)).status).toBe(
      404,
    );
  });
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

describe('files on a ticket', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const MP4 = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftypmp42'),
    Buffer.alloc(16),
  ]);
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  let reference = '';
  let ticketId = '';

  async function upload(
    session: Session,
    ref: string,
    bytes: Buffer,
    name: string,
  ): Promise<{ status: number; body: Record<string, unknown> & { error?: { code: string } } }> {
    const boundary = '----supboundary';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n',
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/support/tickets/${ref}/attachments`,
      headers: {
        'x-forwarded-for': someIp(),
        cookie: session.cookies,
        'x-csrf-token': session.csrf,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    return { status: response.statusCode, body: response.json() };
  }

  beforeAll(async () => {
    const sent = await send(buyerA, { ...GOOD_REQUEST, subject: 'Damaged on arrival' });
    reference = (sent.body as { ticket: { reference: string } }).ticket.reference;
    ticketId = (await prisma.supportTicket.findUniqueOrThrow({ where: { reference } })).id;
  });

  it('tells the page what it may offer', async () => {
    const context = await call(buyerA, 'GET', '/api/v1/support/context');
    const attachments = (
      context.body as { attachments: { available: boolean; maxFiles: number; types: string[] } }
    ).attachments;
    expect(attachments.available).toBe(true);
    expect(attachments.maxFiles).toBe(10);
    expect(attachments.types).toEqual(
      expect.arrayContaining(['image/png', 'video/mp4', 'application/pdf']),
    );
  });

  it('takes an image, a video and a PDF, typed by their bytes', async () => {
    const image = await upload(buyerA, reference, PNG, 'photo.bin');
    const video = await upload(buyerA, reference, MP4, 'clip.mp4');
    const pdf = await upload(buyerA, reference, PDF, 'invoice.pdf');
    expect(
      [image.status, video.status, pdf.status],
      JSON.stringify([image.body, video.body, pdf.body]),
    ).toEqual([201, 201, 201]);
    const kinds = [image, video, pdf].map(
      (result) => (result.body as { attachment: { kind: string } }).attachment.kind,
    );
    expect(kinds).toEqual(['IMAGE', 'VIDEO', 'DOCUMENT']);

    const view = await call(buyerA, 'GET', `/api/v1/support/tickets/${reference}`);
    expect((view.body as { ticket: { attachments: unknown[] } }).ticket.attachments).toHaveLength(
      3,
    );
  });

  it('refuses anything else, whatever it is called, and anything too large', async () => {
    const executable = await upload(
      buyerA,
      reference,
      Buffer.from('MZ not really an image at all'),
      'photo.png',
    );
    expect(executable.status).toBe(400);
    expect(executable.body.error?.code).toBe('MEDIA_TYPE_NOT_ALLOWED');
    const big = await upload(
      buyerA,
      reference,
      Buffer.concat([PDF, Buffer.alloc(5000)]),
      'big.pdf',
    );
    expect([400, 413]).toContain(big.status);
  });

  it('keeps another buyer out of the files as well as the ticket', async () => {
    const attempt = await upload(buyerB, reference, PNG, 'x.png');
    expect(attempt.status).toBe(404);
    const [file] = await prisma.supportTicketAttachment.findMany({ where: { ticketId } });
    const link = await call(
      buyerB,
      'POST',
      `/api/v1/support/tickets/${reference}/attachments/${file?.id ?? ''}/link`,
    );
    expect(link.status).toBe(404);
  });

  it('hands a file out once, through a link bound to the person who asked', async () => {
    const [file] = await prisma.supportTicketAttachment.findMany({
      where: { ticketId, kind: 'DOCUMENT' },
    });
    const link = await call(
      buyerA,
      'POST',
      `/api/v1/support/tickets/${reference}/attachments/${file?.id ?? ''}/link`,
    );
    expect(link.status).toBe(200);
    const url = (link.body as { url: string }).url;

    const stolen = await app.inject({ method: 'GET', url, headers: { cookie: buyerB.cookies } });
    expect([403, 404]).toContain(stolen.statusCode);

    const first = await app.inject({ method: 'GET', url, headers: { cookie: buyerA.cookies } });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-disposition']).toMatch(/^attachment;/);
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    expect(first.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const again = await app.inject({ method: 'GET', url, headers: { cookie: buyerA.cookies } });
    expect(again.statusCode).toBe(403);
  });

  it('lets staff open a file, and never writes its name to the audit trail', async () => {
    const [file] = await prisma.supportTicketAttachment.findMany({
      where: { ticketId, kind: 'IMAGE' },
    });
    const path = `/api/v1/admin/support-tickets/${ticketId}/attachments/${file?.id ?? ''}/link`;
    const link = await call(orders, 'POST', path);
    expect(link.status).toBe(200);
    const download = await app.inject({
      method: 'GET',
      url: (link.body as { url: string }).url,
      headers: { cookie: orders.cookies },
    });
    expect(download.statusCode).toBe(200);
    expect((await call(catalog, 'POST', path)).status).toBe(403);

    const audit = await prisma.auditLog.findMany({ where: { resourceId: ticketId } });
    expect(JSON.stringify(audit)).not.toContain('invoice.pdf');
  });

  it('takes no files on a closed ticket', async () => {
    await prisma.supportTicket.update({ where: { id: ticketId }, data: { status: 'CLOSED' } });
    const closed = await upload(buyerA, reference, PNG, 'late.png');
    expect(closed.status).toBe(409);
    expect(closed.body.error?.code).toBe('SUPPORT_TICKET_CLOSED');
  });
});
