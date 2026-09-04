/**
 * Storefront chat: lead capture and transcripts - integration.
 *
 * The widget asks a visitor for a name, a mobile number and an email before it
 * answers anything, and staff read the enquiry afterwards. What has to hold:
 *
 *   - The details are validated at the edge. A phone field that accepts
 *     "call me" produces a lead nobody can ring.
 *   - The conversation token is what separates one visitor from another on an
 *     endpoint with no session, and a wrong one is indistinguishable from a
 *     conversation that does not exist.
 *   - The transcript is server-side and complete, so what an administrator
 *     reads is what was actually asked and answered.
 *   - The admin surface is behind its own permission, and a role without it is
 *     refused - reading a stranger's conversation is not implied by any other
 *     grant.
 *
 * Nothing here calls the AI provider. `/chat` streams from a paid API, so the
 * turns are appended through the service the route uses, which is the same
 * write path without the bill.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_DEFINITIONS, Permission, Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  appendMessage,
  authenticateConversation,
} from '../../src/modules/assistant/conversation.service.js';

const PASSWORD = 'OwnerTestPass!2026';

let app: Awaited<ReturnType<typeof buildApp>>;

async function reset(): Promise<void> {
  await prisma.assistantMessage.deleteMany({});
  await prisma.assistantConversation.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.userRole.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.user.deleteMany({});
}

async function seedRoles(): Promise<void> {
  for (const definition of ROLE_DEFINITIONS) {
    await prisma.role.upsert({
      where: { key: definition.key },
      update: {},
      create: {
        id: newId(),
        key: definition.key,
        name: definition.name,
        description: definition.description,
        isSystem: true,
      },
    });
  }
}

async function createAdmin(email: string, roleKey: string): Promise<void> {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });

  await prisma.user.create({
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
}

async function signIn(email: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/login',
    payload: { email, password: PASSWORD },
  });

  expect(response.statusCode).toBe(200);

  const raw = response.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : [raw ?? ''];
  return cookies.map((cookie) => cookie.split(';')[0]).join('; ');
}

/** Start a conversation the way the widget does. */
async function start(
  payload: Record<string, unknown> = {
    name: 'Priya Nair',
    phone: '+91 98765 43210',
    email: 'priya.nair@hospital.test',
  },
): Promise<{ statusCode: number; body: { conversationId: string; token: string } }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/assistant/start',
    payload,
  });

  return {
    statusCode: response.statusCode,
    body:
      response.statusCode === 201
        ? (JSON.parse(response.body) as { conversationId: string; token: string })
        : { conversationId: '', token: '' },
  };
}

beforeEach(async () => {
  app = await buildApp();
  await app.ready();
  await reset();
  await seedRoles();
});

afterAll(async () => {
  await app.close();
});

describe('capturing the visitor', () => {
  it('records the three details and hands back a token', async () => {
    const started = await start();

    expect(started.statusCode).toBe(201);
    expect(started.body.conversationId).toHaveLength(26);
    expect(started.body.token.length).toBeGreaterThan(16);

    const row = await prisma.assistantConversation.findUniqueOrThrow({
      where: { id: started.body.conversationId },
    });

    expect(row.visitorName).toBe('Priya Nair');
    expect(row.visitorPhone).toBe('+91 98765 43210');
    expect(row.visitorEmail).toBe('priya.nair@hospital.test');
    expect(row.visitorEmailNormalized).toBe('priya.nair@hospital.test');
    expect(row.messageCount).toBe(0);
  });

  /*
   * The raw token must not be recoverable from the database. It is the only
   * thing standing between one visitor's conversation and another's, and a
   * dump that contains usable ones is a dump that reads them all.
   */
  it('stores a hash of the token, never the token', async () => {
    const started = await start();

    const row = await prisma.assistantConversation.findUniqueOrThrow({
      where: { id: started.body.conversationId },
    });

    expect(row.sessionTokenHash).toHaveLength(64);
    expect(row.sessionTokenHash).not.toContain(started.body.token);
  });

  it('refuses a message until the details are given', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/assistant/chat',
      payload: { message: 'Do you stock 22G safety cannulae?' },
    });

    expect(response.statusCode).toBe(400);
  });

  it.each([
    ['a name of one character', { name: 'P', phone: '9876543210', email: 'a@b.test' }],
    ['a phone that is not a number', { name: 'Priya', phone: 'call me', email: 'a@b.test' }],
    ['a phone too short to dial', { name: 'Priya', phone: '12345', email: 'a@b.test' }],
    ['a phone longer than E.164', { name: 'Priya', phone: '1234567890123456', email: 'a@b.test' }],
    ['an email with no domain', { name: 'Priya', phone: '9876543210', email: 'priya@' }],
    ['a missing phone', { name: 'Priya', email: 'a@b.test' }],
  ])('rejects %s', async (_case, payload) => {
    const started = await start(payload);
    expect(started.statusCode).toBe(400);
  });

  /* Punctuation varies by country; the digits are what matter. */
  it.each(['+91 98765 43210', '(022) 4567-8900', '09876543210', '+1 415 555 2671'])(
    'accepts %s',
    async (phone) => {
      const started = await start({ name: 'Priya Nair', phone, email: 'priya@hospital.test' });
      expect(started.statusCode).toBe(201);
    },
  );

  it('links the enquiry to a registered customer with that address', async () => {
    const userId = newId();
    const profileId = newId();

    await prisma.user.create({
      data: {
        id: userId,
        type: 'CUSTOMER',
        email: 'Buyer@Hospital.Test',
        emailNormalized: 'buyer@hospital.test',
        status: 'ACTIVE',
        customerProfile: { create: { id: profileId, fullName: 'Existing Buyer' } },
      },
    });

    // Typed with different capitalisation, as somebody would.
    const started = await start({
      name: 'Existing Buyer',
      phone: '9876543210',
      email: 'BUYER@hospital.test',
    });

    const row = await prisma.assistantConversation.findUniqueOrThrow({
      where: { id: started.body.conversationId },
    });

    expect(row.customerProfileId).toBe(profileId);
  });

  /*
   * Somebody who has never bought here is the normal case on a catalogue, and
   * the enquiry is the whole point. It must not create an account either.
   */
  it('keeps an enquiry from a stranger, and creates no account for them', async () => {
    const started = await start({
      name: 'Nobody Known',
      phone: '9812345678',
      email: 'nobody@elsewhere.test',
    });

    const row = await prisma.assistantConversation.findUniqueOrThrow({
      where: { id: started.body.conversationId },
    });

    expect(row.customerProfileId).toBeNull();
    expect(await prisma.user.count({ where: { emailNormalized: 'nobody@elsewhere.test' } })).toBe(0);
  });
});

describe('the conversation token', () => {
  it('admits the browser that started the conversation', async () => {
    const started = await start();

    const conversation = await authenticateConversation(
      started.body.conversationId,
      started.body.token,
    );

    expect(conversation?.visitorName).toBe('Priya Nair');
  });

  it('refuses a wrong token, and a conversation that does not exist', async () => {
    const started = await start();

    expect(await authenticateConversation(started.body.conversationId, 'not-the-token')).toBeNull();
    expect(await authenticateConversation(newId(), started.body.token)).toBeNull();
  });

  /*
   * 404 for both, so probing tells an attacker nothing about which
   * conversations exist. The widget reads it as "start again", which is the
   * only recovery that leads anywhere.
   */
  it('answers a wrong token over HTTP with a 404, not a 401', async () => {
    const started = await start();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/assistant/chat',
      payload: {
        conversationId: started.body.conversationId,
        token: 'aaaaaaaaaaaaaaaaaaaa',
        message: 'Do you stock 22G safety cannulae?',
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects a body carrying anything the endpoint did not ask for', async () => {
    const started = await start();

    // A public endpoint holding a provider key must not accept a model, a
    // system prompt or a token budget from the caller.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/assistant/chat',
      payload: {
        conversationId: started.body.conversationId,
        token: started.body.token,
        message: 'Hello',
        model: 'something-expensive',
        maxTokens: 100_000,
      },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('what staff can read', () => {
  async function seedConversation(): Promise<string> {
    const started = await start();

    await appendMessage(started.body.conversationId, 'VISITOR', 'Do you stock 22G safety cannula?');
    await appendMessage(
      started.body.conversationId,
      'ASSISTANT',
      'Yes. SPM-CAN-22G, INR 24.00 each. See /product/safety-iv-cannula-22g.',
    );

    return started.body.conversationId;
  }

  it('lists the enquiry with the contact details and the opening question', async () => {
    const id = await seedConversation();
    await createAdmin('owner@test.local', Role.BUSINESS_OWNER);
    const cookie = await signIn('owner@test.local');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/assistant/conversations',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as {
      conversations: {
        id: string;
        visitorName: string;
        visitorPhone: string;
        visitorEmail: string;
        messageCount: number;
        firstQuestion: string | null;
      }[];
      pagination: { total: number };
    };

    expect(body.pagination.total).toBe(1);
    expect(body.conversations[0]?.id).toBe(id);
    expect(body.conversations[0]?.visitorName).toBe('Priya Nair');
    expect(body.conversations[0]?.visitorPhone).toBe('+91 98765 43210');
    expect(body.conversations[0]?.visitorEmail).toBe('priya.nair@hospital.test');
    expect(body.conversations[0]?.messageCount).toBe(2);
    expect(body.conversations[0]?.firstQuestion).toBe('Do you stock 22G safety cannula?');
  });

  /*
   * A visitor who filled in the form and left without asking anything is not a
   * conversation. Listing them would bury the enquiries that are.
   */
  it('leaves out a conversation nobody asked a question in', async () => {
    await start();
    await createAdmin('owner@test.local', Role.BUSINESS_OWNER);
    const cookie = await signIn('owner@test.local');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/assistant/conversations',
      headers: { cookie },
    });

    const body = JSON.parse(response.body) as { pagination: { total: number } };
    expect(body.pagination.total).toBe(0);
  });

  it('returns the whole transcript in order', async () => {
    const id = await seedConversation();
    await createAdmin('owner@test.local', Role.BUSINESS_OWNER);
    const cookie = await signIn('owner@test.local');

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/assistant/conversations/${id}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as {
      messages: { role: string; content: string }[];
    };

    expect(body.messages.map((message) => message.role)).toEqual(['VISITOR', 'ASSISTANT']);
    expect(body.messages[0]?.content).toBe('Do you stock 22G safety cannula?');
  });

  it('never returns the conversation token to staff either', async () => {
    const id = await seedConversation();
    await createAdmin('owner@test.local', Role.BUSINESS_OWNER);
    const cookie = await signIn('owner@test.local');

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/assistant/conversations/${id}`,
      headers: { cookie },
    });

    expect(response.body).not.toContain('sessionTokenHash');
    expect(response.body).not.toContain('token');
  });

  it('refuses a role that does not hold assistant_chat.read', async () => {
    await seedConversation();

    // Catalog Manager is the role with no reason to read a lead's chat, and
    // the assertion states that rather than assuming it.
    expect(
      ROLE_DEFINITIONS.find((role) => role.key === Role.CATALOG_MANAGER)?.permissions,
    ).not.toContain(Permission.ASSISTANT_CHAT_READ);

    await createAdmin('catalog@test.local', Role.CATALOG_MANAGER);
    const cookie = await signIn('catalog@test.local');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/assistant/conversations',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses an unauthenticated read outright', async () => {
    await seedConversation();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/assistant/conversations',
    });

    expect(response.statusCode).toBe(401);
  });

  it('searches by name, email and phone', async () => {
    await seedConversation();

    const other = await start({
      name: 'Rohit Desai',
      phone: '9820011223',
      email: 'rohit@clinic.test',
    });
    await appendMessage(other.body.conversationId, 'VISITOR', 'What is in the feeding tube pack?');

    await createAdmin('owner@test.local', Role.BUSINESS_OWNER);
    const cookie = await signIn('owner@test.local');

    const matches = async (q: string): Promise<string[]> => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/assistant/conversations?q=${encodeURIComponent(q)}`,
        headers: { cookie },
      });

      const body = JSON.parse(response.body) as { conversations: { visitorName: string }[] };
      return body.conversations.map((conversation) => conversation.visitorName);
    };

    expect(await matches('Rohit')).toEqual(['Rohit Desai']);
    // Searching an address typed in capitals must still find it: the column
    // being matched is the normalised one.
    expect(await matches('PRIYA.NAIR@hospital.test')).toEqual(['Priya Nair']);
    expect(await matches('9820011223')).toEqual(['Rohit Desai']);
    expect(await matches('nobody-by-this-name')).toEqual([]);
  });
});
