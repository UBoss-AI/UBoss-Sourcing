/**
 * Preorder chat, end to end over HTTP and WebSocket.
 *
 * The claims, in the order the file makes them:
 *
 *   - opening the drawer creates nothing; the first message creates the
 *     conversation, with a server-built snapshot of the product;
 *   - a retry is not a second message, and a reused id for other text is refused;
 *   - a second question about the same product lands in the same conversation;
 *   - a customer's message reaches a connected member of staff live, and a
 *     reply reaches the right customer live - and no other customer;
 *   - sequence numbers are the server's, contiguous under concurrent sends;
 *   - a page that missed messages catches up by sequence, without duplicates;
 *   - unread counts and receipts come from the server;
 *   - assignment follows the permissions, and the first reply assigns;
 *   - internal notes never reach a customer, over REST or the socket;
 *   - staff without the grant, other customers, sellers and disabled accounts
 *     are refused, and changing an id in the URL exposes nothing;
 *   - rate and size limits hold, and text is stored as written minus the
 *     characters that exist to deceive;
 *   - attachments are checked by content, served once through a private link;
 *   - resolved conversations reopen, closed ones release the product;
 *   - a proposal turns into a real preorder request only through the preorder
 *     workflow, and "yes" in the chat accepts nothing;
 *   - typing is delivered and never stored.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';

import type { buildApp as BuildApp } from '../../src/http/app.js';
import type { prisma as PrismaClient } from '../../src/infra/prisma.js';
import type { newId as NewId } from '../../src/infra/ids.js';
import type { env as Env } from '../../src/config/env.js';

type App = Awaited<ReturnType<typeof BuildApp>>;

let app: App;
let prisma: typeof PrismaClient;
let newId: typeof NewId;
let env: typeof Env;

const PREFIX = 'pch-';
const PASSWORD = 'PreorderChat!2026';
const EMAILS = {
  buyerA: 'pch-buyer-a@test.local',
  buyerB: 'pch-buyer-b@test.local',
  seller: 'pch-seller@test.local',
  rate: 'pch-rate@test.local',
  owner: 'pch-owner@test.local',
  orders: 'pch-orders@test.local',
  finance: 'pch-finance@test.local',
  catalog: 'pch-catalog@test.local',
};
const ALL_EMAILS = Object.values(EMAILS);

interface Session {
  cookies: string;
  csrf: string;
}

let buyerA: Session;
let buyerB: Session;
let seller: Session;
let rate: Session;
let owner: Session;
let orders: Session;
let finance: Session;
let catalog: Session;

let buyerAProfileId = '';
let buyerAUserId = '';
let ordersUserId = '';
let ownerUserId = '';
let catalogUserId = '';
let addressId = '';
let productId = '';
let secondProductId = '';
let conversationId = '';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuid(): string {
  return crypto.randomUUID();
}

async function call(
  session: Session | null,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> & { error?: { code: string } } }> {
  const response = await app.inject({
    method,
    url,
    headers:
      session === null
        ? {}
        : { cookie: session.cookies, ...(method === 'GET' ? {} : { 'x-csrf-token': session.csrf }) },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  let body: Record<string, unknown>;
  try {
    body = response.json<Record<string, unknown>>();
  } catch {
    body = { raw: response.body };
  }
  return { status: response.statusCode, body: body };
}

async function signInCustomer(email: string): Promise<Session> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const jar = login.cookies as { name: string; value: string }[];
  return {
    cookies: jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    csrf: jar.find((cookie) => cookie.name === 'uboss_shop_csrf')?.value ?? '',
  };
}

async function signInStaff(email: string): Promise<Session> {
  const { signInAdmin } = await import('../support/admin-session.js');
  const session = await signInAdmin(app, { email, password: PASSWORD });
  return { cookies: session.cookies, csrf: session.csrfToken };
}

interface LiveSocket {
  ws: WebSocket;
  frames: Record<string, unknown>[];
  waitFor: (
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
  closed: Promise<number>;
}

async function openSocket(path: string, session: Session | null, origin?: string): Promise<LiveSocket> {
  const frames: Record<string, unknown>[] = [];
  const waiters: { predicate: (frame: Record<string, unknown>) => boolean; resolve: (frame: Record<string, unknown>) => void }[] = [];
  let resolveClosed: (code: number) => void = () => undefined;
  const closed = new Promise<number>((resolve) => {
    resolveClosed = resolve;
  });
  const ws = await app.injectWS(path, {
    headers: {
      ...(session === null ? {} : { cookie: session.cookies }),
      ...(origin === undefined ? {} : { origin }),
    },
  }, {
    onInit: (socket) => {
      socket.on('message', (data: Buffer) => {
        const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        frames.push(frame);
        for (const waiter of [...waiters]) {
          if (waiter.predicate(frame)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(frame);
          }
        }
      });
      socket.on('close', (code: number) => {
        resolveClosed(code);
      });
    },
  });
  return {
    ws,
    frames,
    closed,
    waitFor: (predicate, timeoutMs = 4_000) => {
      const already = frames.find(predicate);
      if (already !== undefined) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`no matching frame in ${String(timeoutMs)}ms; saw ${JSON.stringify(frames.map((f) => f['type']))}`));
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
  };
}

async function settle(ms = 150): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function context(product = productId, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { productId: product, variantId: null, orderingUnit: 'PIECE', unitQuantity: 2_000, ...extra };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function cleanUp(): Promise<void> {
  const profiles = { user: { emailNormalized: { in: ALL_EMAILS } } };
  const chats = await prisma.preorderChatConversation.findMany({
    where: { customerProfile: profiles },
    select: { id: true },
  });
  const chatIds = chats.map((chat) => chat.id);
  await prisma.adminNotification.deleteMany({ where: { relatedId: { in: chatIds } } });
  await prisma.notificationOutbox.deleteMany({ where: { relatedId: { in: chatIds } } });
  await prisma.preorderChatConversation.deleteMany({ where: { id: { in: chatIds } } });
  await prisma.preorderChatCustomerBlock.deleteMany({ where: { customerProfile: profiles } });
  const requests = await prisma.preorderRequest.findMany({
    where: { customerProfile: profiles },
    select: { id: true },
  });
  await prisma.adminNotification.deleteMany({ where: { relatedId: { in: requests.map((r) => r.id) } } });
  await prisma.preorderRequest.deleteMany({ where: { customerProfile: profiles } });
  await prisma.sellerMember.deleteMany({ where: { sellerAccount: { slug: { startsWith: PREFIX } } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.category.deleteMany({ where: { slug: `${PREFIX}category` } });
  await prisma.address.deleteMany({ where: { customerProfile: profiles } });
  await prisma.customerAcknowledgement.deleteMany({ where: { user: { emailNormalized: { in: ALL_EMAILS } } } });
  await prisma.customerProfile.deleteMany({ where: profiles });
  await prisma.session.deleteMany({ where: { user: { emailNormalized: { in: ALL_EMAILS } } } });
  await prisma.authToken.deleteMany({ where: { user: { emailNormalized: { in: ALL_EMAILS } } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: { in: ALL_EMAILS } } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { in: ALL_EMAILS } } });
}

async function createCustomer(email: string, organization: string): Promise<{ userId: string; profileId: string }> {
  const { hashPassword } = await import('../../src/infra/crypto.js');
  const user = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId: user.id, fullName: `Buyer ${email}`, organization, activatedAt: new Date() },
  });
  return { userId: user.id, profileId: profile.id };
}

async function createStaff(email: string, roleKey: string): Promise<string> {
  const { hashPassword } = await import('../../src/infra/crypto.js');
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey }, select: { id: true } });
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

async function createProduct(slug: string, name: string, sku: string): Promise<string> {
  const taxClass = await prisma.taxClass.upsert({
    where: { code: 'PCH-ZERO' },
    update: { isActive: true },
    create: { id: newId(), code: 'PCH-ZERO', name: 'Zero', ratePercent: '0.000000', isActive: true },
  });
  const category = await prisma.category.upsert({
    where: { slug: `${PREFIX}category` },
    update: {},
    create: { id: newId(), name: 'Chat test', slug: `${PREFIX}category`, isActive: true },
  });
  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name,
      slug,
      sku,
      basePriceMinor: 5_000n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isMarketplaceProduct: false,
      isStockTracked: false,
      minOrderQty: 1,
      qtyIncrement: 1,
    },
  });
  return product.id;
}

beforeAll(async () => {
  // This file accepts unscanned attachments, deliberately and only here: the
  // test database has no ClamAV, and the checks under test are the ones that
  // run before and after a scan. Small limit, so "too large" is cheap.
  process.env.PREORDER_CHAT_ALLOW_UNSCANNED_ATTACHMENTS = 'true';
  process.env.PREORDER_CHAT_ATTACHMENT_MAX_BYTES = '4096';

  ({ prisma } = await import('../../src/infra/prisma.js'));
  ({ newId } = await import('../../src/infra/ids.js'));
  ({ env } = await import('../../src/config/env.js'));
  const { buildApp } = await import('../../src/http/app.js');
  const { Role } = await import('../../src/domain/permissions.js');

  await cleanUp();

  const a = await createCustomer(EMAILS.buyerA, 'City Hospital Trust');
  buyerAProfileId = a.profileId;
  buyerAUserId = a.userId;
  await createCustomer(EMAILS.buyerB, 'Rival Clinic');
  await createCustomer(EMAILS.rate, 'Chatty Ltd');

  // A seller: a customer account that is a member of a seller business.
  const sellerCustomer = await createCustomer(EMAILS.seller, 'Seller Co');
  const sellerAccountId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerAccountId,
      legalName: 'Seller Co',
      displayName: 'Seller Co',
      displayNameNormalized: 'pch seller co',
      slug: `${PREFIX}seller`,
      kind: 'WHOLESALER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });
  await prisma.sellerMember.create({
    data: { id: newId(), sellerAccountId, customerProfileId: sellerCustomer.profileId, role: 'OWNER' },
  });

  addressId = (
    await prisma.address.create({
      data: {
        id: newId(),
        customerProfileId: buyerAProfileId,
        contactName: 'Stores',
        contactPhone: '+919800000001',
        line1: '1 Hospital Road',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411001',
        country: 'IN',
        timezone: 'Asia/Kolkata',
        isDefaultShipping: true,
      },
    })
  ).id;

  ownerUserId = await createStaff(EMAILS.owner, Role.BUSINESS_OWNER);
  ordersUserId = await createStaff(EMAILS.orders, Role.ORDER_MANAGER);
  await createStaff(EMAILS.finance, Role.FINANCE_APPROVER);
  catalogUserId = await createStaff(EMAILS.catalog, Role.CATALOG_MANAGER);

  productId = await createProduct(`${PREFIX}gauze`, 'Sterile gauze swab', 'PCH-GAUZE');
  secondProductId = await createProduct(`${PREFIX}gloves`, 'Nitrile gloves', 'PCH-GLOVES');

  app = await buildApp();
  await app.ready();

  buyerA = await signInCustomer(EMAILS.buyerA);
  buyerB = await signInCustomer(EMAILS.buyerB);
  seller = await signInCustomer(EMAILS.seller);
  rate = await signInCustomer(EMAILS.rate);
  owner = await signInStaff(EMAILS.owner);
  orders = await signInStaff(EMAILS.orders);
  finance = await signInStaff(EMAILS.finance);
  catalog = await signInStaff(EMAILS.catalog);
});

afterAll(async () => {
  await app.close();
  await cleanUp();
});

// ---------------------------------------------------------------------------
// Starting a conversation
// ---------------------------------------------------------------------------

describe('starting a conversation', () => {
  it('says honestly that nobody is available when no staff are connected', async () => {
    const response = await call(null, 'GET', '/api/v1/preorder-chats/availability');
    expect(response.status).toBe(200);
    expect(response.body['enabled']).toBe(true);
    expect(response.body['teamAvailable']).toBe(false);
  });

  it('shows the product card without creating anything when the drawer opens', async () => {
    const before = await prisma.preorderChatConversation.count({ where: { customerProfileId: buyerAProfileId } });
    const response = await call(buyerA, 'POST', '/api/v1/preorder-chats/context', context());
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const card = response.body['context'] as { product: { name: string; sku: string }; sellerName: string; request: { baseUnits: number } };
    expect(card.product.name).toBe('Sterile gauze swab');
    expect(card.product.sku).toBe('PCH-GAUZE');
    expect(card.request.baseUnits).toBe(2_000);
    expect(response.body['conversation']).toBeNull();
    const after = await prisma.preorderChatConversation.count({ where: { customerProfileId: buyerAProfileId } });
    expect(after).toBe(before);
  });

  it('refuses a guest', async () => {
    const response = await call(null, 'POST', '/api/v1/preorder-chats/messages', {
      clientMessageId: uuid(),
      body: 'Hello',
      context: context(),
    });
    expect(response.status).toBe(401);
  });

  it('creates the conversation with the first message, from a server-built snapshot', async () => {
    const response = await call(buyerA, 'POST', '/api/v1/preorder-chats/messages', {
      clientMessageId: uuid(),
      body: 'What is the lead time for 2,000 pieces?',
      // A client-supplied name or price would be ignored; the schema refuses extras.
      context: context(undefined, { desiredDeliveryDate: '2027-01-15' }),
      locale: 'de',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body['created']).toBe(true);
    const conversation = response.body['conversation'] as { id: string; status: string };
    conversationId = conversation.id;
    expect(conversation.status).toBe('OPEN');

    const row = await prisma.preorderChatConversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(row.status).toBe('NEW');
    expect(row.productId).toBe(productId);
    expect(row.variantKey).toBe('');
    expect(row.customerLocale).toBe('de');
    expect(row.sellerAccountId).toBeNull();
    const snapshot = row.contextSnapshotJson as { request: { desiredDeliveryDate: string; baseUnits: number } };
    expect(snapshot.request.desiredDeliveryDate).toBe('2027-01-15');
    expect(snapshot.request.baseUnits).toBe(2_000);

    const alert = await prisma.adminNotification.findFirst({ where: { relatedId: conversationId } });
    expect(alert?.kind).toBe('preorder_chat.started');
  });

  it('refuses extra fields in the context, so the client cannot supply a name or a price', async () => {
    const response = await call(buyerA, 'POST', '/api/v1/preorder-chats/context', {
      ...context(),
      productName: 'Free gold',
    });
    expect(response.status).toBe(400);
  });

  it('treats a retry as the same message, and refuses a reused id for other text', async () => {
    const id = uuid();
    const first = await call(buyerA, 'POST', `/api/v1/preorder-chats/${conversationId}/messages`, {
      clientMessageId: id,
      body: 'Also: do you ship to Pune?',
    });
    expect(first.status).toBe(201);
    const again = await call(buyerA, 'POST', `/api/v1/preorder-chats/${conversationId}/messages`, {
      clientMessageId: id,
      body: 'Also: do you ship to Pune?',
    });
    expect(again.status).toBe(200);
    expect(again.body['duplicate']).toBe(true);
    expect((again.body['message'] as { id: string }).id).toBe((first.body['message'] as { id: string }).id);
    const stored = await prisma.preorderChatMessage.count({ where: { clientMessageId: id } });
    expect(stored).toBe(1);

    const reused = await call(buyerA, 'POST', `/api/v1/preorder-chats/${conversationId}/messages`, {
      clientMessageId: id,
      body: 'Something else entirely',
    });
    expect(reused.status).toBe(409);
    expect(reused.body.error?.code).toBe('PREORDER_CHAT_MESSAGE_ID_REUSED');
  });

  it('puts a second question about the same product in the same conversation', async () => {
    const response = await call(buyerA, 'POST', '/api/v1/preorder-chats/messages', {
      clientMessageId: uuid(),
      body: 'One more question about the same swabs.',
      context: context(),
    });
    expect(response.status).toBe(201);
    expect(response.body['created']).toBe(false);
    expect((response.body['conversation'] as { id: string }).id).toBe(conversationId);
  });

  it('stores text as written, minus control and bidi characters', async () => {
    const response = await call(buyerA, 'POST', `/api/v1/preorder-chats/${conversationId}/messages`, {
      clientMessageId: uuid(),
      body: '<script>alert(1)</script> spec\u202Efdp.exe\u0007',
    });
    expect(response.status).toBe(201);
    expect((response.body['message'] as { body: string }).body).toBe('<script>alert(1)</script> specfdp.exe');
  });

  it('refuses an over-long message and an empty one', async () => {
    const long = await call(buyerA, 'POST', `/api/v1/preorder-chats/${conversationId}/messages`, {
      clientMessageId: uuid(),
      body: 'x'.repeat(env.PREORDER_CHAT_MAX_MESSAGE_CHARS + 1),
    });
    expect(long.status).toBe(400);
    expect(long.body.error?.code).toBe('PREORDER_CHAT_MESSAGE_TOO_LONG');
    const empty = await call(buyerA, 'POST', `/api/v1/preorder-chats/${conversationId}/messages`, {
      clientMessageId: uuid(),
      body: '   \n  ',
    });
    expect(empty.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Real time
// ---------------------------------------------------------------------------

describe('live delivery', () => {
  it('refuses a socket with no session, and one from a foreign origin', async () => {
    const anonymous = await openSocket('/api/v1/preorder-chats/socket', null);
    const error = await anonymous.waitFor((frame) => frame['type'] === 'error');
    expect(error['code']).toBe('UNAUTHENTICATED');
    expect(await anonymous.closed).toBe(4401);

    await expect(
      openSocket('/api/v1/preorder-chats/socket', buyerA, 'https://evil.example'),
    ).rejects.toThrow();
  });

  it('refuses a customer credential on the staff socket', async () => {
    const socket = await openSocket('/api/v1/admin/preorder-chats/socket', buyerA);
    await socket.waitFor((frame) => frame['type'] === 'error');
    expect(await socket.closed).toBe(4401);
  });

  it('refuses the staff socket to staff without the view permission', async () => {
    const socket = await openSocket('/api/v1/admin/preorder-chats/socket', catalog);
    const error = await socket.waitFor((frame) => frame['type'] === 'error');
    expect(error['code']).toBe('PERMISSION_DENIED');
    expect(await socket.closed).toBe(4403);
  });

  it('delivers a customer message to staff, and a reply to that customer only', async () => {
    const staff = await openSocket('/api/v1/admin/preorder-chats/socket', orders);
    await staff.waitFor((frame) => frame['type'] === 'hello');
    const customer = await openSocket('/api/v1/preorder-chats/socket', buyerA);
    const hello = await customer.waitFor((frame) => frame['type'] === 'hello');
    // The order manager can reply and is connected: the team is here.
    expect(hello['teamAvailable']).toBe(true);
    const other = await openSocket('/api/v1/preorder-chats/socket', buyerB);
    await other.waitFor((frame) => frame['type'] === 'hello');

    const availability = await call(null, 'GET', '/api/v1/preorder-chats/availability');
    expect(availability.body['teamAvailable']).toBe(true);

    const sent = await call(buyerA, 'POST', `/api/v1/preorder-chats/${conversationId}/messages`, {
      clientMessageId: uuid(),
      body: 'Live question',
    });
    expect(sent.status).toBe(201);
    const live = await staff.waitFor(
      (frame) => frame['type'] === 'message.created' && (frame['message'] as { body: string }).body === 'Live question',
    );
    expect(live['conversationId']).toBe(conversationId);

    const reply = await call(orders, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/messages`, {
      clientMessageId: uuid(),
      body: 'Live answer: ten working days.',
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    const received = await customer.waitFor(
      (frame) => frame['type'] === 'message.created' && (frame['message'] as { body: string }).body.startsWith('Live answer'),
    );
    const message = received['message'] as Record<string, unknown>;
    // The customer never learns which member of staff wrote it.
    expect(message['senderType']).toBe('ADMIN');
    expect(message['senderName']).toBeUndefined();
    expect(message['senderUserId']).toBeUndefined();

    await settle(300);
    expect(
      other.frames.filter((frame) => frame['type'] === 'message.created' || frame['type'] === 'conversation.updated'),
    ).toHaveLength(0);

    staff.ws.terminate();
    customer.ws.terminate();
    other.ws.terminate();
  });

  it('assigns the conversation to whoever replied first', async () => {
    const row = await prisma.preorderChatConversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(row.assignedAdminId).toBe(ordersUserId);
    expect(row.status).toBe('OPEN');
    expect(row.awaitingReplySince).toBeNull();
    expect(row.firstResponseAt).not.toBeNull();
  });

  it('delivers typing to the other side, and stores nothing', async () => {
    const messagesBefore = await prisma.preorderChatMessage.count({ where: { conversationId } });
    const busBefore = await prisma.realtimeEvent.count();

    const staff = await openSocket('/api/v1/admin/preorder-chats/socket', orders);
    await staff.waitFor((frame) => frame['type'] === 'hello');
    staff.ws.send(JSON.stringify({ type: 'subscribe', conversationId }));
    await staff.waitFor((frame) => frame['type'] === 'subscribed');

    const customer = await openSocket('/api/v1/preorder-chats/socket', buyerA);
    await customer.waitFor((frame) => frame['type'] === 'hello');
    customer.ws.send(JSON.stringify({ type: 'subscribe', conversationId }));
    await customer.waitFor((frame) => frame['type'] === 'subscribed');
    customer.ws.send(JSON.stringify({ type: 'typing', conversationId, state: 'start' }));

    const typing = await staff.waitFor((frame) => frame['type'] === 'typing');
    expect(typing['side']).toBe('CUSTOMER');

    expect(await prisma.preorderChatMessage.count({ where: { conversationId } })).toBe(messagesBefore);
    // The memory bus writes nothing at all.
    expect(await prisma.realtimeEvent.count()).toBe(busBefore);

    staff.ws.terminate();
    customer.ws.terminate();
  });

  it('refuses to subscribe a customer to somebody else’s conversation', async () => {
    const intruder = await openSocket('/api/v1/preorder-chats/socket', buyerB);
    await intruder.waitFor((frame) => frame['type'] === 'hello');
    intruder.ws.send(JSON.stringify({ type: 'subscribe', conversationId }));
    const refusal = await intruder.waitFor((frame) => frame['type'] === 'error');
    expect(refusal['code']).toBe('NOT_FOUND');
    intruder.ws.terminate();
  });
});

// ---------------------------------------------------------------------------
// Order, recovery, receipts
// ---------------------------------------------------------------------------

describe('ordering and recovery', () => {
  it('hands out contiguous sequence numbers under concurrent sends', async () => {
    const before = await prisma.preorderChatConversation.findUniqueOrThrow({ where: { id: conversationId } });
    const results = await Promise.all(
      [1, 2, 3, 4].map((index) =>
        call(buyerA, 'POST', `/api/v1/preorder-chats/${conversationId}/messages`, {
          clientMessageId: uuid(),
          body: `Burst ${String(index)}`,
        }),
      ),
    );
    for (const result of results) expect(result.status).toBe(201);
    const seqs = results.map((result) => (result.body['message'] as { seq: number }).seq).sort((x, y) => x - y);
    expect(seqs).toEqual([1, 2, 3, 4].map((offset) => before.lastSequence + offset));
  });

  it('lets a page that missed messages catch up after a sequence, in order, without repeats', async () => {
    const all = await call(buyerA, 'GET', `/api/v1/preorder-chats/${conversationId}/messages?limit=200`);
    const messages = all.body['messages'] as { seq: number }[];
    const cursor = messages[messages.length - 3]?.seq ?? 0;
    const after = await call(buyerA, 'GET', `/api/v1/preorder-chats/${conversationId}/messages?after=${String(cursor)}`);
    const seqs = (after.body['messages'] as { seq: number }[]).map((message) => message.seq);
    expect(seqs).toEqual([cursor + 1, cursor + 2]);
    expect(new Set(seqs).size).toBe(seqs.length);

    const earlier = await call(buyerA, 'GET', `/api/v1/preorder-chats/${conversationId}/messages?before=3&limit=5`);
    expect((earlier.body['messages'] as { seq: number }[]).map((message) => message.seq)).toEqual([1, 2]);
  });

  it('counts unread from the server and clears it on read', async () => {
    await call(owner, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/messages`, {
      clientMessageId: uuid(),
      body: 'Second answer from the team.',
    });
    const unread = await call(buyerA, 'GET', '/api/v1/preorder-chats/unread');
    expect(unread.body['unreadCount']).toBeGreaterThanOrEqual(1);

    const detail = await call(buyerA, 'GET', `/api/v1/preorder-chats/${conversationId}`);
    const last = (detail.body['conversation'] as { lastSequence: number }).lastSequence;
    const read = await call(buyerA, 'POST', `/api/v1/preorder-chats/${conversationId}/read`, { seq: last + 1000 });
    expect(read.status).toBe(200);
    // Clamped to what exists: nobody reads a message that has not been sent.
    expect(read.body['readSeq']).toBe(last);
    expect(read.body['unreadCount']).toBe(0);

    // The team replied, so the customer's earlier messages count as read by
    // the team. A new customer message is unread until somebody opens it.
    const nudge = await call(buyerA, 'POST', `/api/v1/preorder-chats/${conversationId}/messages`, {
      clientMessageId: uuid(),
      body: 'Thanks - and the colour options?',
    });
    const nudgeSeq = (nudge.body['message'] as { seq: number }).seq;
    const staffList = await call(owner, 'GET', '/api/v1/admin/preorder-chats?filter=all');
    const row = (staffList.body['conversations'] as { id: string; unreadCount: number }[]).find((c) => c.id === conversationId);
    expect(row?.unreadCount).toBeGreaterThan(0);
    await call(owner, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/read`, { seq: nudgeSeq });
    const afterRead = await call(owner, 'GET', '/api/v1/admin/preorder-chats?filter=unread');
    expect((afterRead.body['conversations'] as { id: string }[]).some((c) => c.id === conversationId)).toBe(false);

    const customerView = await call(buyerA, 'GET', `/api/v1/preorder-chats/${conversationId}`);
    expect((customerView.body['conversation'] as { receipts: { readSeq: number } }).receipts.readSeq).toBe(nudgeSeq);
  });
});

// ---------------------------------------------------------------------------
// Staff: permissions, assignment, notes
// ---------------------------------------------------------------------------

describe('staff permissions and assignment', () => {
  it('hides the inbox from staff without the view permission', async () => {
    const response = await call(catalog, 'GET', '/api/v1/admin/preorder-chats');
    expect(response.status).toBe(403);
    const detail = await call(catalog, 'GET', `/api/v1/admin/preorder-chats/${conversationId}`);
    expect(detail.status).toBe(403);
  });

  it('lets finance read but not reply', async () => {
    expect((await call(finance, 'GET', `/api/v1/admin/preorder-chats/${conversationId}`)).status).toBe(200);
    const reply = await call(finance, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/messages`, {
      clientMessageId: uuid(),
      body: 'I should not be able to say this.',
    });
    expect(reply.status).toBe(403);
  });

  it('lets the order desk take a conversation, but only the owner give one to somebody else', async () => {
    const release = await call(orders, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/assign`, {
      assigneeUserId: null,
    });
    expect(release.status).toBe(200);
    const take = await call(orders, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/assign`, {
      assigneeUserId: ordersUserId,
    });
    expect(take.status).toBe(200);
    const giveAway = await call(orders, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/assign`, {
      assigneeUserId: ownerUserId,
    });
    expect(giveAway.status).toBe(403);

    const transfer = await call(owner, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/assign`, {
      assigneeUserId: ownerUserId,
    });
    expect(transfer.status).toBe(200);
    expect((transfer.body['assignedTo'] as { id: string }).id).toBe(ownerUserId);

    const ineligible = await call(owner, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/assign`, {
      assigneeUserId: catalogUserId,
    });
    expect(ineligible.status).toBe(400);
    expect(ineligible.body.error?.code).toBe('PREORDER_CHAT_ASSIGNEE_NOT_ELIGIBLE');

    const mine = await call(owner, 'GET', '/api/v1/admin/preorder-chats?filter=mine');
    expect((mine.body['conversations'] as { id: string }[]).map((c) => c.id)).toContain(conversationId);

    const activity = await call(owner, 'GET', `/api/v1/admin/preorder-chats/${conversationId}/activity`);
    expect((activity.body['activity'] as { action: string }[]).some((entry) => entry.action === 'preorder_chat.assigned')).toBe(true);
  });

  it('keeps internal notes away from the customer, over REST and the socket', async () => {
    const customer = await openSocket('/api/v1/preorder-chats/socket', buyerA);
    await customer.waitFor((frame) => frame['type'] === 'hello');

    const secret = 'INTERNAL: margin is thin, check with the warehouse';
    const note = await call(owner, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/notes`, { body: secret });
    expect(note.status).toBe(201);
    const notes = await call(owner, 'GET', `/api/v1/admin/preorder-chats/${conversationId}/notes`);
    expect((notes.body['notes'] as { body: string }[]).map((n) => n.body)).toContain(secret);

    await settle(300);
    expect(JSON.stringify(customer.frames)).not.toContain('margin is thin');
    const history = await call(buyerA, 'GET', `/api/v1/preorder-chats/${conversationId}/messages?limit=200`);
    const detail = await call(buyerA, 'GET', `/api/v1/preorder-chats/${conversationId}`);
    for (const response of [history, detail]) {
      const text = JSON.stringify(response.body);
      expect(text).not.toContain('margin is thin');
      expect(text).not.toContain(EMAILS.owner);
      expect(text).not.toContain('assignedTo');
      expect(text).not.toContain('tags');
    }
    // There is no customer route for notes at all.
    expect((await call(buyerA, 'GET', `/api/v1/preorder-chats/${conversationId}/notes`)).status).toBe(404);
    customer.ws.terminate();
  });

  it('searches by product, SKU and message keyword on the server', async () => {
    for (const q of ['gauze', 'PCH-GAUZE', 'Live question']) {
      const response = await call(owner, 'GET', `/api/v1/admin/preorder-chats?q=${encodeURIComponent(q)}`);
      expect((response.body['conversations'] as { id: string }[]).map((c) => c.id), q).toContain(conversationId);
    }
    const miss = await call(owner, 'GET', '/api/v1/admin/preorder-chats?q=nothing-matches-this');
    expect(miss.body['conversations']).toEqual([]);
  });

  it('filters to high and urgent conversations, and counts them', async () => {
    const ids = async (): Promise<string[]> =>
      ((await call(owner, 'GET', '/api/v1/admin/preorder-chats?filter=priority')).body['conversations'] as { id: string }[]).map(
        (c) => c.id,
      );
    const count = async (): Promise<number> =>
      ((await call(owner, 'GET', '/api/v1/admin/preorder-chats/counts')).body['counts'] as Record<string, number>)['priority'] ??
      -1;

    await call(owner, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/priority`, { priority: 'NORMAL' });
    expect(await ids()).not.toContain(conversationId);
    const before = await count();

    await call(owner, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/priority`, { priority: 'URGENT' });
    expect(await ids()).toContain(conversationId);
    expect(await count()).toBe(before + 1);

    await call(owner, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/priority`, { priority: 'NORMAL' });
  });
});

// ---------------------------------------------------------------------------
// Cross-user access
// ---------------------------------------------------------------------------

describe('nobody reaches somebody else’s conversation', () => {
  it('answers another customer exactly as for a conversation that does not exist', async () => {
    for (const [method, url, payload] of [
      ['GET', `/api/v1/preorder-chats/${conversationId}`, undefined],
      ['GET', `/api/v1/preorder-chats/${conversationId}/messages`, undefined],
      ['POST', `/api/v1/preorder-chats/${conversationId}/messages`, { clientMessageId: uuid(), body: 'Intruding' }],
      ['POST', `/api/v1/preorder-chats/${conversationId}/read`, { seq: 1 }],
    ] as const) {
      const response = await call(buyerB, method, url, payload);
      expect(response.status, url).toBe(404);
    }
    const missing = await call(buyerB, 'GET', `/api/v1/preorder-chats/${newId()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error?.code).toBe(
      (await call(buyerB, 'GET', `/api/v1/preorder-chats/${conversationId}`)).body.error?.code,
    );
  });

  it('gives a seller no way in', async () => {
    expect((await call(seller, 'GET', `/api/v1/preorder-chats/${conversationId}`)).status).toBe(404);
    // A seller's customer credential is not a staff credential.
    const staffRoute = await call(seller, 'GET', `/api/v1/admin/preorder-chats/${conversationId}`);
    expect([401, 403]).toContain(staffRoute.status);
    const list = await call(seller, 'GET', '/api/v1/preorder-chats');
    expect(list.body['conversations']).toEqual([]);
  });

  it('shuts a deactivated member of staff out of REST and the socket', async () => {
    const socket = await openSocket('/api/v1/admin/preorder-chats/socket', finance);
    await socket.waitFor((frame) => frame['type'] === 'hello');
    await prisma.user.update({ where: { emailNormalized: EMAILS.finance }, data: { status: 'DEACTIVATED' } });

    expect((await call(finance, 'GET', '/api/v1/admin/preorder-chats')).status).toBe(401);
    await app.preorderChat.gateway.revalidateAll();
    expect(await socket.closed).toBe(4401);

    await prisma.user.update({ where: { emailNormalized: EMAILS.finance }, data: { status: 'ACTIVE' } });
  });
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

describe('limits', () => {
  it('slows down one sender who writes too quickly', async () => {
    const start = await call(rate, 'POST', '/api/v1/preorder-chats/messages', {
      clientMessageId: uuid(),
      body: 'first',
      context: context(secondProductId),
    });
    expect(start.status).toBe(201);
    const id = (start.body['conversation'] as { id: string }).id;
    let limited = false;
    for (let index = 0; index < env.PREORDER_CHAT_MESSAGES_PER_MINUTE + 2 && !limited; index += 1) {
      const response = await call(rate, 'POST', `/api/v1/preorder-chats/${id}/messages`, {
        clientMessageId: uuid(),
        body: `message ${String(index)}`,
      });
      if (response.status === 429) limited = true;
    }
    expect(limited).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

describe('attachments', () => {
  async function upload(session: Session, url: string, bytes: Buffer, name: string, clientMessageId = uuid()) {
    const boundary = '----pchboundary';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="clientMessageId"\r\n\r\n${clientMessageId}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await app.inject({
      method: 'POST',
      url,
      headers: {
        cookie: session.cookies,
        'x-csrf-token': session.csrf,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    return { status: response.statusCode, body: response.json<Record<string, unknown> & { error?: { code: string } }>() };
  }

  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

  it('reports itself unavailable when nothing would scan the file', async () => {
    const mutable = env as { PREORDER_CHAT_ALLOW_UNSCANNED_ATTACHMENTS: boolean };
    mutable.PREORDER_CHAT_ALLOW_UNSCANNED_ATTACHMENTS = false;
    try {
      const response = await upload(buyerA, `/api/v1/preorder-chats/${conversationId}/attachments`, PDF, 'spec.pdf');
      expect(response.status).toBe(409);
      expect(response.body.error?.code).toBe('PREORDER_CHAT_ATTACHMENTS_UNAVAILABLE');
      const availability = await call(null, 'GET', '/api/v1/preorder-chats/availability');
      expect((availability.body['attachments'] as { available: boolean }).available).toBe(false);
    } finally {
      mutable.PREORDER_CHAT_ALLOW_UNSCANNED_ATTACHMENTS = true;
    }
  });

  it('refuses a file whose bytes are not a PDF or an image, whatever it is called', async () => {
    const exe = Buffer.from('MZ\x90\x00\x03\x00\x00\x00 this is a program', 'binary');
    const response = await upload(buyerA, `/api/v1/preorder-chats/${conversationId}/attachments`, exe, 'spec.pdf');
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('MEDIA_TYPE_NOT_ALLOWED');
  });

  it('refuses a file over the size limit', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(8_192, 0x20)]);
    const response = await upload(buyerA, `/api/v1/preorder-chats/${conversationId}/attachments`, big, 'big.pdf');
    expect([400, 413]).toContain(response.status);
  });

  it('stores a PDF privately and serves it once, to its participant only', async () => {
    const sent = await upload(buyerA, `/api/v1/preorder-chats/${conversationId}/attachments`, PDF, '../../etc/spec\u202E.pdf');
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const message = sent.body['message'] as { attachment: { id: string; fileName: string; downloadable: boolean } };
    expect(message.attachment.fileName).not.toContain('/');
    expect(message.attachment.fileName).not.toContain('\u202E');
    const attachmentId = message.attachment.id;

    const row = await prisma.preorderChatAttachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(row.storageKey.startsWith('private/')).toBe(true);

    // Another customer cannot mint a link for it.
    const stolen = await call(buyerB, 'POST', `/api/v1/preorder-chats/${conversationId}/attachments/${attachmentId}/link`);
    expect(stolen.status).toBe(404);

    const link = await call(buyerA, 'POST', `/api/v1/preorder-chats/${conversationId}/attachments/${attachmentId}/link`);
    expect(link.status).toBe(200);
    const url = link.body['url'] as string;

    // The link is for buyer A's session; buyer B holding it gets nothing.
    const wrongSession = await app.inject({ method: 'GET', url, headers: { cookie: buyerB.cookies } });
    expect(wrongSession.statusCode).toBe(403);

    const download = await app.inject({ method: 'GET', url, headers: { cookie: buyerA.cookies } });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment;');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const again = await app.inject({ method: 'GET', url, headers: { cookie: buyerA.cookies } });
    expect(again.statusCode).toBe(403);

    // Staff can read it through their own link.
    const staffLink = await call(owner, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/attachments/${attachmentId}/link`);
    expect(staffLink.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  it('reopens a resolved conversation when the customer writes again, and counts it', async () => {
    const resolved = await call(orders, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/status`, {
      status: 'RESOLVED',
      reason: null,
    });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const customerView = await call(buyerA, 'GET', `/api/v1/preorder-chats/${conversationId}`);
    expect((customerView.body['conversation'] as { status: string }).status).toBe('RESOLVED');

    const again = await call(buyerA, 'POST', `/api/v1/preorder-chats/${conversationId}/messages`, {
      clientMessageId: uuid(),
      body: 'Actually, one more thing.',
    });
    expect(again.status).toBe(201);
    const row = await prisma.preorderChatConversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(row.status).toBe('OPEN');
    expect(row.reopenCount).toBe(1);
    const cards = await prisma.preorderChatMessage.findMany({ where: { conversationId, systemEvent: 'status.resolved' } });
    expect(cards).toHaveLength(1);
  });

  it('refuses spam marking to staff without the moderation permission', async () => {
    const response = await call(orders, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/status`, {
      status: 'SPAM',
      reason: null,
    });
    expect(response.status).toBe(403);
  });

  it('refuses an export to staff without the export permission, and gives the owner everything', async () => {
    expect((await call(orders, 'GET', `/api/v1/admin/preorder-chats/${conversationId}/export`)).status).toBe(403);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/preorder-chats/${conversationId}/export`,
      headers: { cookie: owner.cookies },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('margin is thin');
  });

  it('lets a moderator redact a message, keeping the row and a fingerprint of what went', async () => {
    const target = await prisma.preorderChatMessage.findFirstOrThrow({
      where: { conversationId, body: 'Also: do you ship to Pune?' },
    });
    expect(
      (await call(orders, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/messages/${target.id}/redact`, { reason: 'Contained a card number' })).status,
    ).toBe(403);
    const response = await call(owner, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/messages/${target.id}/redact`, {
      reason: 'Contained a card number',
    });
    expect(response.status).toBe(200);
    const row = await prisma.preorderChatMessage.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.body).toBe('');
    expect(row.redactedAt).not.toBeNull();
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'preorder_chat.message_redacted', resourceId: conversationId },
    });
    expect(JSON.stringify(audit.afterJson)).toContain('removedSha256');
    expect(JSON.stringify(audit.afterJson)).not.toContain('Pune');
  });

  it('blocks a customer everywhere, and unblocks them', async () => {
    const block = await call(owner, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/block`, {
      reason: 'Abusive language',
    });
    expect(block.status).toBe(200);
    const here = await call(buyerA, 'POST', `/api/v1/preorder-chats/${conversationId}/messages`, {
      clientMessageId: uuid(),
      body: 'Let me in',
    });
    expect(here.status).toBe(403);
    expect(here.body.error?.code).toBe('PREORDER_CHAT_BLOCKED');
    const elsewhere = await call(buyerA, 'POST', '/api/v1/preorder-chats/messages', {
      clientMessageId: uuid(),
      body: 'A new thread will not get round it',
      context: context(secondProductId),
    });
    expect(elsewhere.status).toBe(403);

    const unblock = await call(owner, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/unblock`);
    expect(unblock.status).toBe(200);
    const back = await call(buyerA, 'POST', `/api/v1/preorder-chats/${conversationId}/messages`, {
      clientMessageId: uuid(),
      body: 'Thank you',
    });
    expect(back.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Proposals and the preorder workflow
// ---------------------------------------------------------------------------

describe('proposals', () => {
  let proposalId = '';

  function plusDays(days: number): string {
    return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  }

  it('sends a structured proposal the customer sees as a card', async () => {
    const response = await call(orders, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/proposals`, {
      orderingUnit: 'PIECE',
      unitQuantity: 2_000,
      indicativeUnitPriceMinor: '4800',
      availabilityNote: 'Made to order',
      deliveryDate: plusDays(45),
      termsNote: 'The supplier confirms the final price.',
      expiresInHours: 72,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    proposalId = response.body['id'] as string;
    expect(response.body['equivalentBaseUnits']).toBe(2_000);
    expect(response.body['indicativeUnitPriceMinor']).toBe('4800');

    const history = await call(buyerA, 'GET', `/api/v1/preorder-chats/${conversationId}/messages?limit=5`);
    const card = (history.body['messages'] as { messageType: string; proposal: { id: string } | null }[]).find(
      (message) => message.messageType === 'STRUCTURED_OFFER',
    );
    expect(card?.proposal?.id).toBe(proposalId);
  });

  it('accepts nothing because the customer typed yes', async () => {
    await call(buyerA, 'POST', `/api/v1/preorder-chats/${conversationId}/messages`, {
      clientMessageId: uuid(),
      body: 'yes',
    });
    const row = await prisma.preorderChatProposal.findUniqueOrThrow({ where: { id: proposalId } });
    expect(row.state).toBe('PROPOSED');
    expect(await prisma.preorderRequest.count({ where: { customerProfileId: buyerAProfileId } })).toBe(0);
  });

  it('refuses a proposal whose split deliveries do not add up', async () => {
    const response = await call(orders, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/proposals`, {
      orderingUnit: 'PIECE',
      unitQuantity: 2_000,
      deliveryDate: plusDays(45),
      splitDeliveries: [
        { date: plusDays(30), baseUnits: 500 },
        { date: plusDays(45), baseUnits: 500 },
      ],
    });
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('PREORDER_PROPOSAL_INVALID');
  });

  it('becomes a real preorder request only through the preorder workflow, and links it', async () => {
    const prefill = await call(buyerA, 'GET', `/api/v1/preorder-chats/${conversationId}/proposals/${proposalId}`);
    expect(prefill.status).toBe(200);
    const figures = prefill.body['prefill'] as { unitQuantity: number; requestedDeliveryDate: string };

    // The customer submits through the ordinary preorder route, terms and all.
    const { acknowledgePreorderInfo } = await import('../../src/modules/preorders/acknowledgement.service.js');
    await acknowledgePreorderInfo({ userId: buyerAUserId, email: EMAILS.buyerA, policyVersion: env.PREORDER_INFO_VERSION });
    const submit = await app.inject({
      method: 'POST',
      url: '/api/v1/preorders',
      headers: { cookie: buyerA.cookies, 'x-csrf-token': buyerA.csrf, 'idempotency-key': uuid() },
      payload: {
        productId,
        orderingUnit: 'PIECE',
        unitQuantity: figures.unitQuantity,
        requestedDeliveryDate: figures.requestedDeliveryDate,
        shippingAddressId: addressId,
        acceptTerms: true,
      },
    });
    expect(submit.statusCode, submit.body).toBe(201);
    const preorder = submit.json<{ preorder: { id: string; status: string } }>().preorder;
    expect(preorder.status).toBe('SUBMITTED');

    // Buyer B cannot claim buyer A's preorder for a proposal, and A cannot
    // claim somebody else's either.
    const wrong = await call(buyerB, 'POST', `/api/v1/preorder-chats/${conversationId}/proposals/${proposalId}/submitted`, {
      preorderRequestId: preorder.id,
    });
    expect(wrong.status).toBe(404);

    const linked = await call(buyerA, 'POST', `/api/v1/preorder-chats/${conversationId}/proposals/${proposalId}/submitted`, {
      preorderRequestId: preorder.id,
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect((linked.body['proposal'] as { state: string }).state).toBe('SUBMITTED');
    const row = await prisma.preorderChatConversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(row.preorderRequestId).toBe(preorder.id);
    // The preorder itself is untouched: the supplier still has to answer it.
    const request = await prisma.preorderRequest.findUniqueOrThrow({ where: { id: preorder.id } });
    expect(request.status).toBe('SUBMITTED');

    const staff = await call(owner, 'GET', `/api/v1/admin/preorder-chats/${conversationId}`);
    expect((staff.body['conversation'] as { preorder: { id: string } }).preorder.id).toBe(preorder.id);
  });
});

// ---------------------------------------------------------------------------
// Closing, and the maintenance beat
// ---------------------------------------------------------------------------

describe('closing and maintenance', () => {
  it('emails the customer about an unread reply without the reply in it', async () => {
    const { emailUnreadReplies } = await import('../../src/modules/preorder-chat/maintenance.service.js');
    await call(orders, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/messages`, {
      clientMessageId: uuid(),
      body: 'CONFIDENTIAL-PRICE 42 per piece',
    });
    await emailUnreadReplies(new Date(Date.now() + 3_600_000));
    const mail = await prisma.notificationOutbox.findFirst({
      where: { relatedId: conversationId, recipientEmail: EMAILS.buyerA },
      orderBy: { createdAt: 'desc' },
    });
    expect(mail).not.toBeNull();
    expect(mail?.body).toContain(`/account/messages/${conversationId}`);
    expect(mail?.body).not.toContain('CONFIDENTIAL-PRICE');
  });

  it('raises the SLA alert once and closes it when staff reply', async () => {
    const { raiseSlaAlerts } = await import('../../src/modules/preorder-chat/maintenance.service.js');
    await call(buyerA, 'POST', `/api/v1/preorder-chats/${conversationId}/messages`, {
      clientMessageId: uuid(),
      body: 'Still waiting on the date?',
    });
    const later = new Date(Date.now() + (env.PREORDER_CHAT_SLA_MINUTES + 5) * 60_000);
    expect(await raiseSlaAlerts(later)).toBeGreaterThanOrEqual(1);
    expect(await raiseSlaAlerts(later)).toBe(0);
    const alert = await prisma.adminNotification.findFirstOrThrow({
      where: { relatedId: conversationId, kind: 'preorder_chat.sla_breached' },
    });
    expect(alert.status).toBe('ACTIVE');
    await call(orders, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/messages`, {
      clientMessageId: uuid(),
      body: 'The date is confirmed.',
    });
    const closed = await prisma.adminNotification.findUniqueOrThrow({ where: { id: alert.id } });
    expect(closed.status).toBe('RESOLVED');
  });

  it('keeps a closed conversation readable, refuses new messages in it, and lets a new one start', async () => {
    const closed = await call(owner, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/status`, {
      status: 'CLOSED',
      reason: 'Done',
    });
    expect(closed.status).toBe(200);
    const history = await call(buyerA, 'GET', `/api/v1/preorder-chats/${conversationId}/messages`);
    expect(history.status).toBe(200);
    const refused = await call(buyerA, 'POST', `/api/v1/preorder-chats/${conversationId}/messages`, {
      clientMessageId: uuid(),
      body: 'Hello again',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe('PREORDER_CHAT_CLOSED');

    const fresh = await call(buyerA, 'POST', '/api/v1/preorder-chats/messages', {
      clientMessageId: uuid(),
      body: 'A new question about the swabs',
      context: context(),
    });
    expect(fresh.status).toBe(201);
    expect(fresh.body['created']).toBe(true);
    expect((fresh.body['conversation'] as { id: string }).id).not.toBe(conversationId);
  });

  it('reports the desk’s numbers without a word anybody wrote', async () => {
    const response = await call(owner, 'GET', '/api/v1/admin/preorder-chats/operations');
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('swabs');
    expect(typeof (response.body['queue'] as { open: number }).open).toBe('number');
  });

  it('badges the rail with conversations waiting for an answer', async () => {
    const attention = await call(owner, 'GET', '/api/v1/admin/attention');
    expect((attention.body['counts'] as Record<string, number>)['preorderChats']).toBeGreaterThanOrEqual(1);
    const noGrant = await call(catalog, 'GET', '/api/v1/admin/attention');
    expect((noGrant.body['counts'] as Record<string, number>)['preorderChats']).toBeUndefined();
  });
});
