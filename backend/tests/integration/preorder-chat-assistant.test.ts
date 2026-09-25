/**
 * The preorder assistant and "Connect with a human agent", over HTTP.
 *
 * The claims, in the order the file makes them:
 *
 *   - a guest can read the questions and answers; nothing is created;
 *   - every answer comes from the product's own terms, and a figure the seller
 *     never gave is "needs confirmation", never a guess;
 *   - asking for a person needs a signed-in customer;
 *   - an answer the server did not sign, or signed for another product, is
 *     refused - the transcript staff read is the one the customer was shown;
 *   - the handoff creates ONE conversation, carries the transcript in as the
 *     customer's questions and the ASSISTANT's answers (never staff's), is
 *     unread for staff, is in the "human requested" queue and notifies staff;
 *   - a retry is not a second request, and a second request reuses the
 *     conversation;
 *   - the first staff reply after it says a person joined, once, and takes it
 *     out of the queue;
 *   - a customer who writes after reading answers carries them in too.
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

const PREFIX = 'pca-';
const PASSWORD = 'PreorderAssist!2026';
const EMAILS = {
  buyer: 'pca-buyer@test.local',
  other: 'pca-other@test.local',
  owner: 'pca-owner@test.local',
};
const ALL_EMAILS = Object.values(EMAILS);

interface Session {
  cookies: string;
  csrf: string;
}

let buyer: Session;
let other: Session;
let owner: Session;
let productId = '';
let secondProductId = '';
let conversationId = '';

type Body = Record<string, unknown> & { error?: { code: string; details?: { field: string; code: string }[] } };

async function call(
  session: Session | null,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: Body }> {
  const response = await app.inject({
    method,
    url,
    headers:
      session === null
        ? {}
        : { cookie: session.cookies, ...(method === 'GET' ? {} : { 'x-csrf-token': session.csrf }) },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  let body: Body;
  try {
    body = response.json<Body>();
  } catch {
    body = { raw: response.body };
  }
  return { status: response.statusCode, body };
}

async function signInCustomer(email: string): Promise<Session> {
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
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

function context(product = productId): Record<string, unknown> {
  return { productId: product, variantId: null, orderingUnit: 'PIECE', unitQuantity: 2_000 };
}

interface Answer {
  answer: { faqId: string; version: number; outcome: string; lines: { key: string; values: Record<string, unknown> }[] };
  askedAt: string;
  token: string;
}

async function ask(session: Session | null, faqId: string, product = productId): Promise<Answer> {
  const response = await call(session, 'POST', '/api/v1/preorder-chats/assistant/answer', {
    context: context(product),
    faqId,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as unknown as Answer;
}

async function cleanUp(): Promise<void> {
  const profiles = { user: { emailNormalized: { in: ALL_EMAILS } } };
  const chats = await prisma.preorderChatConversation.findMany({ where: { customerProfile: profiles }, select: { id: true } });
  const chatIds = chats.map((chat) => chat.id);
  await prisma.adminNotification.deleteMany({ where: { relatedId: { in: chatIds } } });
  await prisma.notificationOutbox.deleteMany({ where: { relatedId: { in: chatIds } } });
  await prisma.preorderChatConversation.deleteMany({ where: { id: { in: chatIds } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.category.deleteMany({ where: { slug: `${PREFIX}category` } });
  await prisma.customerProfile.deleteMany({ where: profiles });
  await prisma.session.deleteMany({ where: { user: { emailNormalized: { in: ALL_EMAILS } } } });
  await prisma.authToken.deleteMany({ where: { user: { emailNormalized: { in: ALL_EMAILS } } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: { in: ALL_EMAILS } } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { in: ALL_EMAILS } } });
}

async function createCustomer(email: string, fullName: string): Promise<void> {
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
  await prisma.customerProfile.create({
    data: { id: newId(), userId: user.id, fullName, organization: 'Assist Hospital', activatedAt: new Date() },
  });
}

async function createProduct(slug: string, name: string, sku: string): Promise<string> {
  const taxClass = await prisma.taxClass.upsert({
    where: { code: 'PCA-ZERO' },
    update: { isActive: true },
    create: { id: newId(), code: 'PCA-ZERO', name: 'Zero', ratePercent: '0.000000', isActive: true },
  });
  const category = await prisma.category.upsert({
    where: { slug: `${PREFIX}category` },
    update: {},
    create: { id: newId(), name: 'Assistant test', slug: `${PREFIX}category`, isActive: true },
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
  ({ prisma } = await import('../../src/infra/prisma.js'));
  ({ newId } = await import('../../src/infra/ids.js'));
  ({ env } = await import('../../src/config/env.js'));
  const { buildApp } = await import('../../src/http/app.js');
  const { Role } = await import('../../src/domain/permissions.js');
  const { hashPassword } = await import('../../src/infra/crypto.js');

  await cleanUp();
  await createCustomer(EMAILS.buyer, 'Priya Shah');
  await createCustomer(EMAILS.other, 'Other Buyer');

  const role = await prisma.role.findUniqueOrThrow({ where: { key: Role.BUSINESS_OWNER }, select: { id: true } });
  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email: EMAILS.owner,
      emailNormalized: EMAILS.owner,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: role.id } },
    },
  });

  productId = await createProduct(`${PREFIX}masks`, 'Surgical masks', 'PCA-MASKS');
  secondProductId = await createProduct(`${PREFIX}gowns`, 'Isolation gowns', 'PCA-GOWNS');

  app = await buildApp();
  await app.ready();
  buyer = await signInCustomer(EMAILS.buyer);
  other = await signInCustomer(EMAILS.other);
  owner = await signInStaff(EMAILS.owner);
});

afterAll(async () => {
  await app.close();
  await cleanUp();
});

describe('the assistant, before anybody writes', () => {
  it('offers the questions to a guest, in order, and creates nothing', async () => {
    const response = await call(null, 'POST', '/api/v1/preorder-chats/assistant', { context: context() });
    expect(response.status).toBe(200);
    const questions = response.body['questions'] as { id: string; questionKey: string }[];
    expect(questions.map((question) => question.id).slice(0, 4)).toEqual(['moq', 'bulkPricing', 'container20', 'container40']);
    expect(questions.every((question) => question.questionKey.startsWith('preorderChat.assistant.q.'))).toBe(true);
    expect(response.body['greeting']).toMatchObject({ firstName: null, productName: 'Surgical masks' });
    expect(await prisma.preorderChatConversation.count({ where: { productId } })).toBe(0);
  });

  it("greets a signed-in customer by their first name", async () => {
    const response = await call(buyer, 'POST', '/api/v1/preorder-chats/assistant', { context: context() });
    expect(response.body['greeting']).toMatchObject({ firstName: 'Priya', productName: 'Surgical masks' });
  });

  it('answers the minimum from the preorder terms', async () => {
    const { answer } = await ask(null, 'moq');
    expect(answer.outcome).toBe('ANSWERED');
    expect(answer.lines[0]).toEqual({
      key: 'preorderChat.assistant.a.moq',
      values: { minimum: { kind: 'number', value: env.PREORDER_DEFAULT_MOQ } },
    });
  });

  it('answers bulk pricing from the price bands, labelled indicative', async () => {
    const { answer } = await ask(null, 'bulkPricing');
    expect(answer.outcome).toBe('ANSWERED');
    expect(answer.lines[0]?.values['price']).toEqual({ kind: 'money', minor: '5000', currency: 'INR' });
    expect(answer.lines.at(-1)?.key).toBe('preorderChat.assistant.a.indicative');
  });

  it('never guesses a container figure the seller did not verify', async () => {
    const { answer } = await ask(null, 'container40');
    expect(answer.outcome).toBe('NEEDS_CONFIRMATION');
    expect(answer.lines.map((line) => line.key)).toEqual([
      'preorderChat.assistant.a.containerUnverified',
      'preorderChat.assistant.a.needsConfirmation',
    ]);
    expect(JSON.stringify(answer)).not.toContain('"kind":"number"');
  });

  it('says customisation needs the team, because no listing field says so', async () => {
    const { answer } = await ask(null, 'customisation');
    expect(answer.outcome).toBe('NEEDS_CONFIRMATION');
  });

  it('answers a product that is not on sale with 404', async () => {
    await prisma.product.update({ where: { id: secondProductId }, data: { isPublished: false } });
    const response = await call(null, 'POST', '/api/v1/preorder-chats/assistant/answer', {
      context: context(secondProductId),
      faqId: 'moq',
    });
    expect(response.status).toBe(404);
    await prisma.product.update({ where: { id: secondProductId }, data: { isPublished: true } });
  });

  it('refuses a question that does not exist', async () => {
    const response = await call(null, 'POST', '/api/v1/preorder-chats/assistant/answer', {
      context: context(),
      faqId: 'wholesaleSecrets',
    });
    expect(response.status).toBe(400);
  });
});

describe('connecting with a human agent', () => {
  let moq: Answer;
  let stock: Answer;

  beforeAll(async () => {
    moq = await ask(null, 'moq');
    stock = await ask(buyer, 'stock');
  });

  it('needs a signed-in customer', async () => {
    const response = await call(null, 'POST', '/api/v1/preorder-chats/handoff', {
      clientRequestId: crypto.randomUUID(),
      context: context(),
      transcript: [moq],
    });
    expect(response.status).toBe(401);
  });

  it('refuses an answer the server did not give', async () => {
    const forged = structuredClone(moq);
    forged.answer.lines[0] = { key: 'preorderChat.assistant.a.moq', values: { minimum: { kind: 'number', value: 1 } } };
    const response = await call(buyer, 'POST', '/api/v1/preorder-chats/handoff', {
      clientRequestId: crypto.randomUUID(),
      context: context(),
      transcript: [forged],
    });
    expect(response.status).toBe(400);
    expect(response.body.error?.details?.[0]).toEqual({ field: 'transcript.0', code: 'NOT_SIGNED' });
  });

  it('refuses an answer given about another product', async () => {
    const response = await call(buyer, 'POST', '/api/v1/preorder-chats/handoff', {
      clientRequestId: crypto.randomUUID(),
      context: context(secondProductId),
      transcript: [moq],
    });
    expect(response.status).toBe(400);
    expect(await prisma.preorderChatConversation.count({ where: { productId: secondProductId } })).toBe(0);
  });

  const requestId = crypto.randomUUID();

  it('creates the conversation with the transcript, as the assistant and not as staff', async () => {
    const response = await call(buyer, 'POST', '/api/v1/preorder-chats/handoff', {
      clientRequestId: requestId,
      context: context(),
      locale: 'en',
      topic: 'stock',
      transcript: [moq, stock],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body['created']).toBe(true);
    const conversation = response.body['conversation'] as Record<string, unknown>;
    conversationId = String(conversation['id']);
    expect(conversation['humanRequested']).toBe(true);
    // The customer read everything they were shown: nothing unread for them.
    expect(conversation['unreadCount']).toBe(0);

    const messages = response.body['messages'] as Record<string, unknown>[];
    expect(messages.map((message) => [message['senderType'], message['messageType']])).toEqual([
      ['CUSTOMER', 'FAQ_QUESTION'],
      ['AUTOMATION', 'AUTOMATED_REPLY'],
      ['CUSTOMER', 'FAQ_QUESTION'],
      ['AUTOMATION', 'AUTOMATED_REPLY'],
      ['CUSTOMER', 'HANDOFF_REQUEST'],
    ]);
    // Exactly what the customer was shown, lines and values.
    expect((messages[1]?.['automation'] as Record<string, unknown>)['lines']).toEqual(moq.answer.lines);
    expect((messages[3]?.['automation'] as Record<string, unknown>)['lines']).toEqual(stock.answer.lines);
    expect(messages.map((message) => message['seq'])).toEqual([1, 2, 3, 4, 5]);

    const stored = await prisma.preorderChatMessage.findMany({ where: { conversationId }, select: { senderType: true } });
    expect(stored.some((row) => row.senderType === 'ADMIN')).toBe(false);
  });

  it('is a request for a person in the queue: unread, unassigned, notified', async () => {
    const list = await call(owner, 'GET', '/api/v1/admin/preorder-chats?filter=human_requested');
    expect(list.status).toBe(200);
    const rows = list.body['conversations'] as Record<string, unknown>[];
    const row = rows.find((candidate) => candidate['id'] === conversationId);
    expect(row).toBeDefined();
    // Two questions and the request itself are the customer's side.
    expect(row?.['unreadCount']).toBe(3);
    expect(row?.['assignedTo']).toBeNull();
    expect(row?.['handoff']).toMatchObject({ topic: 'stock', waiting: true });

    const notification = await prisma.adminNotification.findFirst({
      where: { relatedId: conversationId, kind: 'preorder_chat.handoff' },
    });
    expect(notification).not.toBeNull();
  });

  it('is the same request when retried', async () => {
    const response = await call(buyer, 'POST', '/api/v1/preorder-chats/handoff', {
      clientRequestId: requestId,
      context: context(),
      topic: 'stock',
      transcript: [moq, stock],
    });
    expect(response.status).toBe(200);
    expect(response.body['duplicate']).toBe(true);
    expect(await prisma.preorderChatMessage.count({ where: { conversationId } })).toBe(5);
  });

  it('reuses the conversation for a second request, never a second conversation', async () => {
    const response = await call(buyer, 'POST', '/api/v1/preorder-chats/handoff', {
      clientRequestId: crypto.randomUUID(),
      context: context(),
      topic: null,
      transcript: [],
    });
    expect(response.status).toBe(201);
    expect((response.body['conversation'] as Record<string, unknown>)['id']).toBe(conversationId);
    expect(await prisma.preorderChatConversation.count({ where: { productId } })).toBe(1);
  });

  it('is not visible to another customer', async () => {
    const response = await call(other, 'GET', `/api/v1/preorder-chats/${conversationId}`);
    expect(response.status).toBe(404);
  });

  it('cannot have the assistant redacted: nobody wrote those words', async () => {
    const answerRow = await prisma.preorderChatMessage.findFirstOrThrow({
      where: { conversationId, senderType: 'AUTOMATION' },
      select: { id: true },
    });
    const response = await call(
      owner,
      'POST',
      `/api/v1/admin/preorder-chats/${conversationId}/messages/${answerRow.id}/redact`,
      { reason: 'testing redaction' },
    );
    expect(response.status).toBe(400);
  });

  it('says a person joined above the first staff reply, once, and leaves the queue', async () => {
    const first = await call(owner, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/messages`, {
      clientMessageId: crypto.randomUUID(),
      body: 'Hello, I can help with the stock question.',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    await call(owner, 'POST', `/api/v1/admin/preorder-chats/${conversationId}/messages`, {
      clientMessageId: crypto.randomUUID(),
      body: 'The seller has confirmed the quantity.',
    });

    const history = await call(buyer, 'GET', `/api/v1/preorder-chats/${conversationId}/messages?limit=50`);
    const messages = history.body['messages'] as Record<string, unknown>[];
    const joined = messages.filter((message) => message['systemEvent'] === 'handoff.joined');
    expect(joined).toHaveLength(1);
    const joinedAt = messages.indexOf(joined[0] as Record<string, unknown>);
    expect(messages[joinedAt + 1]).toMatchObject({ senderType: 'ADMIN', body: 'Hello, I can help with the stock question.' });
    // The whole transcript is still there, ahead of it.
    expect(messages.filter((message) => message['messageType'] === 'AUTOMATED_REPLY')).toHaveLength(2);

    const conversation = await call(buyer, 'GET', `/api/v1/preorder-chats/${conversationId}`);
    expect((conversation.body['conversation'] as Record<string, unknown>)['humanRequested']).toBe(false);
    const queue = await call(owner, 'GET', '/api/v1/admin/preorder-chats?filter=human_requested');
    expect((queue.body['conversations'] as Record<string, unknown>[]).some((row) => row['id'] === conversationId)).toBe(false);
  });
});

describe('writing to the team after reading answers', () => {
  it('carries the answers in ahead of the first message', async () => {
    const answer = await ask(buyer, 'deliveryDate', secondProductId);
    const response = await call(buyer, 'POST', '/api/v1/preorder-chats/messages', {
      clientMessageId: crypto.randomUUID(),
      body: 'Can it arrive sooner?',
      context: context(secondProductId),
      locale: 'en',
      transcript: [answer],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const id = String((response.body['conversation'] as Record<string, unknown>)['id']);
    const rows = await prisma.preorderChatMessage.findMany({
      where: { conversationId: id },
      orderBy: { serverSequence: 'asc' },
      select: { senderType: true, messageType: true },
    });
    expect(rows).toEqual([
      { senderType: 'CUSTOMER', messageType: 'FAQ_QUESTION' },
      { senderType: 'AUTOMATION', messageType: 'AUTOMATED_REPLY' },
      { senderType: 'CUSTOMER', messageType: 'TEXT' },
    ]);
    expect((response.body['conversation'] as Record<string, unknown>)['unreadCount']).toBe(0);
  });
});
