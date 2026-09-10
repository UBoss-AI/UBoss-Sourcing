/**
 * Storefront chat: who may use it, and what staff read afterwards.
 *
 * The assistant used to be open to anyone, with a form asking for a name, a
 * mobile number and an email standing in for a sign-in. Both halves of that
 * changed at once, and this file is where the change is held down:
 *
 *   - **Nobody unauthenticated gets an answer.** No session is a 401, an
 *     expired or revoked one is a 401, an admin credential is a 403, and a
 *     customer with no profile is a 403. None of them buys a provider call.
 *   - **Nobody else's conversation, either.** The id in the body is checked
 *     against the caller's own account, and a conversation belonging to
 *     somebody else is indistinguishable from one that does not exist.
 *   - **The three details are gone from the write path.** A conversation is
 *     created with none of them, and a request that still sends them is
 *     refused rather than quietly recorded.
 *   - **But not from the rows that already had them.** A historical guest
 *     enquiry still reads, still searches and still carries what was typed.
 *     Removing a field from a form is not a reason to destroy what people
 *     already gave; the retention sweep is what takes those, on its own
 *     schedule.
 *   - **Staff read one screen for both eras**, and it says which era a row is.
 *
 * Nothing here calls the AI provider. `/chat` streams from a paid API, so every
 * request to it in this file is one that fails before the provider is reached,
 * and the turns are appended through the service the route uses - the same
 * write path without the bill.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { signInAdmin } from '../support/admin-session.js';
import { env } from '../../src/config/env.js';
import { ROLE_DEFINITIONS, Permission, Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { hashPassword, sha256Hex } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  appendMessage,
  authoriseConversation,
} from '../../src/modules/assistant/conversation.service.js';
import type { ConversationOwner } from '../../src/modules/assistant/conversation.service.js';

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

async function signInStaff(email: string): Promise<string> {
  return (await signInAdmin(app, { email, password: PASSWORD })).cookies;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

interface CustomerSession {
  profileId: string | null;
  cookies: string;
  csrfToken: string;
}

/**
 * A customer account, and a browser signed in to it.
 *
 * `withProfile: false` builds the one account shape that can hold a session and
 * still not chat: active, correct surface, no CustomerProfile. It exists here
 * because that is a 403 rather than a 401, and the difference is the whole
 * point of the distinction.
 */
async function createCustomer(
  email: string,
  options: { fullName?: string; organization?: string; phone?: string; withProfile?: boolean } = {},
): Promise<CustomerSession> {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: Role.CUSTOMER } });

  const user = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email,
      emailNormalized: email.toLowerCase(),
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: role.id } },
    },
  });

  let profileId: string | null = null;

  if (options.withProfile !== false) {
    const profile = await prisma.customerProfile.create({
      data: {
        id: newId(),
        userId: user.id,
        fullName: options.fullName ?? 'Test Buyer',
        ...(options.organization === undefined ? {} : { organization: options.organization }),
        ...(options.phone === undefined ? {} : { phone: options.phone }),
        activatedAt: new Date(),
      },
    });
    profileId = profile.id;
  }

  const signIn = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  });

  expect(signIn.statusCode, signIn.body).toBe(200);

  const jar = signIn.cookies as { name: string; value: string }[];

  return {
    profileId,
    cookies: jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    csrfToken: jar.find((cookie) => cookie.name === 'uboss_shop_csrf')?.value ?? '',
  };
}

/**
 * Open a conversation as a guest, returning its id and its token.
 *
 * No cookie, no CSRF header, nothing: this is a browser that has never signed
 * in, which is the whole point of the routes being open.
 */
async function startAsGuest(): Promise<{ conversationId: string; conversationToken: string }> {
  const response = await app.inject({ method: 'POST', url: '/api/v1/assistant/start' });
  expect(response.statusCode, response.body).toBe(201);

  return JSON.parse(response.body) as { conversationId: string; conversationToken: string };
}

/** Just the id, for the cases that do not care about the token. */
async function guestConversation(): Promise<string> {
  return (await startAsGuest()).conversationId;
}

/**
 * Flip `ASSISTANT_ALLOW_GUESTS` for one test.
 *
 * `beforeEach` puts it back, so a test that closes the door cannot leave it
 * closed for the next one.
 */
function withGuests(allowed: boolean): void {
  Object.assign(env as unknown as { ASSISTANT_ALLOW_GUESTS: boolean }, {
    ASSISTANT_ALLOW_GUESTS: allowed,
  });
}

/** A session, as the conversation service understands ownership. */
function asCustomer(session: CustomerSession): ConversationOwner {
  return { kind: 'customer', customerProfileId: session.profileId ?? '' };
}

/** Start a conversation the way AI Mode does: signed in, and with no body. */
async function start(
  session: CustomerSession,
  payload: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/assistant/start',
    headers: { cookie: session.cookies, 'x-csrf-token': session.csrfToken },
    payload,
  });
}

async function startedId(session: CustomerSession): Promise<string> {
  const response = await start(session);
  expect(response.statusCode, response.body).toBe(201);
  return (JSON.parse(response.body) as { conversationId: string }).conversationId;
}

async function chat(
  session: CustomerSession,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/assistant/chat',
    headers: { cookie: session.cookies, 'x-csrf-token': session.csrfToken },
    payload,
  });
}

/**
 * A conversation from before the sign-in gate, written the way the old widget
 * wrote one: typed contact details, a guest session-token hash, and no owner.
 *
 * Inserted directly because there is no longer any code path that produces one
 * - which is the point. These rows exist in every deployment that ran the old
 * widget, and everything staff-facing still has to work on them.
 */
async function seedHistoricalGuestConversation(details: {
  name: string;
  phone: string;
  email: string;
  customerProfileId?: string;
}): Promise<string> {
  const id = newId();

  await prisma.assistantConversation.create({
    data: {
      id,
      visitorName: details.name,
      visitorPhone: details.phone,
      visitorEmail: details.email,
      visitorEmailNormalized: details.email.toLowerCase(),
      sessionTokenHash: 'f'.repeat(64),
      ...(details.customerProfileId === undefined
        ? {}
        : { customerProfileId: details.customerProfileId }),
    },
  });

  return id;
}

beforeEach(async () => {
  app = await buildApp();
  await app.ready();
  await reset();
  await seedRoles();
  // Whatever the deployment's own .env says, these tests describe a store
  // that lets guests in — except the one that deliberately closes the door.
  withGuests(true);
});

afterAll(async () => {
  await app.close();
});

// ---------------------------------------------------------------------------

describe('who may use the assistant', () => {
  it('lets a guest start, and hands them the only proof it will ever give', async () => {
    const started = await app.inject({ method: 'POST', url: '/api/v1/assistant/start' });

    expect(started.statusCode, started.body).toBe(201);

    const body = JSON.parse(started.body) as Record<string, unknown>;
    expect(body.conversationId).toHaveLength(26);
    // A conversation token, because a guest has no account to be recognised
    // by. It is returned exactly once and only its hash is kept.
    expect(body.conversationToken).toMatch(/^[A-Za-z0-9_-]{32,86}$/);

    const row = await prisma.assistantConversation.findUniqueOrThrow({
      where: { id: String(body.conversationId) },
    });
    expect(row.customerProfileId).toBeNull();
    expect(row.sessionTokenHash).not.toBeNull();
    // The secret itself is never stored, so a database read cannot resume the
    // conversation and neither can a leaked backup.
    expect(row.sessionTokenHash).not.toBe(body.conversationToken);
  });

  it('still asks a guest for nothing about themselves', async () => {
    const conversationId = await guestConversation();

    const row = await prisma.assistantConversation.findUniqueOrThrow({
      where: { id: conversationId },
    });

    // The capture form is gone for guests too. Anonymous is the honest word,
    // and it is cheaper than an unchecked claim.
    expect(row.visitorName).toBeNull();
    expect(row.visitorPhone).toBeNull();
    expect(row.visitorEmail).toBeNull();
  });

  it('refuses a guest when the operator has switched guests off', async () => {
    withGuests(false);

    const started = await app.inject({ method: 'POST', url: '/api/v1/assistant/start' });
    expect(started.statusCode).toBe(401);

    const message = await app.inject({
      method: 'POST',
      url: '/api/v1/assistant/chat',
      payload: { conversationId: newId(), message: 'Do you stock 22G safety cannulae?' },
    });
    expect(message.statusCode).toBe(401);
  });

  it('never lets a guest reach the history routes, whatever the flag says', async () => {
    // A history belongs to an account. There is no token that stands in for
    // one, so these stay 401 even while guests may chat.
    for (const [method, url] of [
      ['GET', '/api/v1/assistant/conversations'],
      ['GET', `/api/v1/assistant/conversations/${newId()}`],
      ['DELETE', `/api/v1/assistant/conversations/${newId()}`],
    ] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('lets a signed-in customer start, and asks them for nothing', async () => {
    const buyer = await createCustomer('buyer@hospital.test');

    const response = await start(buyer);
    expect(response.statusCode, response.body).toBe(201);

    const body = JSON.parse(response.body) as Record<string, unknown>;

    expect(body.conversationId).toHaveLength(26);
    // No token in the answer either. Ownership is the authorisation now, and a
    // second bearer secret would only be one more thing to leak.
    expect(Object.keys(body)).toEqual(['conversationId']);
  });

  it('records no name, phone, email or guest token on the new conversation', async () => {
    const buyer = await createCustomer('buyer@hospital.test');
    const id = await startedId(buyer);

    const row = await prisma.assistantConversation.findUniqueOrThrow({ where: { id } });

    expect(row.visitorName).toBeNull();
    expect(row.visitorPhone).toBeNull();
    expect(row.visitorEmail).toBeNull();
    expect(row.visitorEmailNormalized).toBeNull();
    expect(row.sessionTokenHash).toBeNull();

    // What it does record: whose it is.
    expect(row.customerProfileId).toBe(buyer.profileId);
    expect(row.messageCount).toBe(0);
  });

  /*
   * A stale bundle still posting the three fields must fail loudly. Stripping
   * them silently would give a 201 and leave nobody any the wiser that a
   * deployment is running an old frontend against a new API.
   */
  it.each([
    ['a name', { name: 'Priya Nair' }],
    ['a phone number', { phone: '+91 98765 43210' }],
    ['an email address', { email: 'priya.nair@hospital.test' }],
    [
      'all three at once',
      { name: 'Priya Nair', phone: '+91 98765 43210', email: 'priya.nair@hospital.test' },
    ],
  ])('refuses a start that still sends %s', async (_case, payload) => {
    const buyer = await createCustomer('buyer@hospital.test');

    const response = await start(buyer, payload);
    expect(response.statusCode).toBe(400);

    expect(await prisma.assistantConversation.count()).toBe(0);
  });

  it('refuses a staff credential presented to the storefront widget', async () => {
    await createAdmin('owner@test.local', Role.BUSINESS_OWNER);
    const cookies = await signInStaff('owner@test.local');
    const csrfToken = /uboss_admin_csrf=([^;]+)/.exec(cookies)?.[1] ?? '';

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/assistant/start',
      headers: { cookie: cookies, 'x-csrf-token': csrfToken },
      payload: {},
    });

    /*
     * 201, but as a *guest* — and that is the property under test.
     *
     * The admin cookies are named apart from the customer ones, so nothing
     * this browser holds is even offered to the customer surface. Since guests
     * may chat, a member of staff on the storefront is simply an anonymous
     * visitor; what they must never be is a customer. The row proves it: no
     * owner, and a guest token instead.
     */
    expect(response.statusCode, response.body).toBe(201);

    const body = JSON.parse(response.body) as { conversationId: string };
    const row = await prisma.assistantConversation.findUniqueOrThrow({
      where: { id: body.conversationId },
    });
    expect(row.customerProfileId).toBeNull();
    expect(row.sessionTokenHash).not.toBeNull();
  });

  /*
   * Signed in, correct surface, and still refused - an ACTIVE customer with no
   * CustomerProfile cannot own a conversation, so there is nothing for the
   * ownership check downstream to succeed against. 403 rather than 401,
   * because the credential is fine and the account is not.
   */
  it('refuses a customer whose account has no profile', async () => {
    const halfSetUp = await createCustomer('half@hospital.test', { withProfile: false });

    const response = await start(halfSetUp);
    expect(response.statusCode).toBe(403);
  });

  it('refuses a cookie session with no CSRF header', async () => {
    const buyer = await createCustomer('buyer@hospital.test');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/assistant/start',
      headers: { cookie: buyer.cookies },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
  });

  /*
   * The reason the access token is not the whole story. Signing out revokes
   * the session server-side, and the very next assistant request has to notice
   * - not at the next token expiry, which could be minutes away on a shared
   * machine somebody has just walked away from.
   */
  it('refuses a request on a session that has been signed out', async () => {
    const buyer = await createCustomer('buyer@hospital.test');
    const id = await startedId(buyer);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: buyer.cookies, 'x-csrf-token': buyer.csrfToken },
    });
    expect(logout.statusCode, logout.body).toBe(204);

    const response = await chat(buyer, { conversationId: id, message: 'Still there?' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a request once the account is deactivated', async () => {
    const buyer = await createCustomer('buyer@hospital.test');
    const id = await startedId(buyer);

    await prisma.user.update({
      where: { emailNormalized: 'buyer@hospital.test' },
      data: { status: 'DEACTIVATED' },
    });

    const response = await chat(buyer, { conversationId: id, message: 'Still there?' });
    expect(response.statusCode).toBe(401);
  });
});

describe('whose conversation it is', () => {
  it('admits the customer who started it', async () => {
    const buyer = await createCustomer('buyer@hospital.test');
    const id = await startedId(buyer);

    const conversation = await authoriseConversation(id, asCustomer(buyer));

    expect(conversation?.id).toBe(id);
    expect(conversation?.messageCount).toBe(0);
  });

  it('refuses another customer, and a conversation that does not exist', async () => {
    const buyer = await createCustomer('buyer@hospital.test');
    const other = await createCustomer('other@clinic.test');
    const id = await startedId(buyer);

    expect(await authoriseConversation(id, asCustomer(other))).toBeNull();
    expect(await authoriseConversation(newId(), asCustomer(buyer))).toBeNull();
  });

  /*
   * 404 for somebody else's conversation, not 403. A 403 would confirm the id
   * names a real conversation, which is exactly what an id-guesser wants to
   * learn. The widget reads a 404 as "start again", which is the right
   * recovery for a browser holding an id the retention sweep has taken.
   */
  it('answers another customer over HTTP with a 404, not a 403', async () => {
    const buyer = await createCustomer('buyer@hospital.test');
    const other = await createCustomer('other@clinic.test');
    const id = await startedId(buyer);

    const response = await chat(other, { conversationId: id, message: 'What did they ask?' });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a historical guest conversation nobody owns', async () => {
    const buyer = await createCustomer('buyer@hospital.test');
    const id = await seedHistoricalGuestConversation({
      name: 'Priya Nair',
      phone: '+91 98765 43210',
      email: 'priya.nair@hospital.test',
    });

    const response = await chat(buyer, { conversationId: id, message: 'Carry on from here' });
    expect(response.statusCode).toBe(404);
  });

  it('rejects a body carrying anything the endpoint did not ask for', async () => {
    const buyer = await createCustomer('buyer@hospital.test');
    const id = await startedId(buyer);

    // A signed-in caller must not be able to name a model, a system prompt or
    // a token budget either. Authentication says who is spending the
    // deployment's provider budget; it does not say they may choose how.
    const response = await chat(buyer, {
      conversationId: id,
      message: 'Hello',
      model: 'something-expensive',
      maxTokens: 100_000,
    });

    expect(response.statusCode).toBe(400);
  });

  /* The old shape, now that there is no token to send. */
  it('rejects a body that still sends a conversation token', async () => {
    const buyer = await createCustomer('buyer@hospital.test');
    const id = await startedId(buyer);

    const response = await chat(buyer, {
      conversationId: id,
      token: 'aaaaaaaaaaaaaaaaaaaa',
      message: 'Hello',
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('what staff can read', () => {
  interface EnquiryRow {
    id: string;
    name: string | null;
    phone: string | null;
    email: string | null;
    isVerifiedContact: boolean;
    customerProfileId: string | null;
    customerName: string | null;
    messageCount: number;
    firstQuestion: string | null;
  }

  async function seedSignedInConversation(): Promise<{ id: string; buyer: CustomerSession }> {
    const buyer = await createCustomer('priya.nair@hospital.test', {
      fullName: 'Priya Nair',
      organization: 'City General',
      phone: '+91 98765 43210',
    });

    const id = await startedId(buyer);

    await appendMessage(id, 'VISITOR', 'Do you stock 22G safety cannula?');
    await appendMessage(
      id,
      'ASSISTANT',
      'Yes. SPM-CAN-22G, INR 24.00 each. See /product/safety-iv-cannula-22g.',
    );

    return { id, buyer };
  }

  async function listAs(cookie: string, query = ''): Promise<EnquiryRow[]> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/assistant/conversations${query}`,
      headers: { cookie },
    });

    expect(response.statusCode, response.body).toBe(200);
    return (JSON.parse(response.body) as { conversations: EnquiryRow[] }).conversations;
  }

  it('takes the contact details off the account, and says they are verified', async () => {
    const { id, buyer } = await seedSignedInConversation();
    await createAdmin('owner@test.local', Role.BUSINESS_OWNER);
    const cookie = await signInStaff('owner@test.local');

    const [row] = await listAs(cookie);

    expect(row?.id).toBe(id);
    expect(row?.name).toBe('Priya Nair');
    expect(row?.email).toBe('priya.nair@hospital.test');
    expect(row?.phone).toBe('+91 98765 43210');
    expect(row?.isVerifiedContact).toBe(true);
    expect(row?.customerProfileId).toBe(buyer.profileId);
    expect(row?.messageCount).toBe(2);
    expect(row?.firstQuestion).toBe('Do you stock 22G safety cannula?');
  });

  /*
   * The rows that predate the sign-in gate. Making the columns nullable did
   * not blank them and no migration deleted them: they read exactly as they
   * always did, and they are marked as the unverified claims they always were.
   */
  it('still reads a historical guest enquiry, and marks it unverified', async () => {
    const id = await seedHistoricalGuestConversation({
      name: 'Rohit Desai',
      phone: '9820011223',
      email: 'rohit@clinic.test',
    });
    await appendMessage(id, 'VISITOR', 'What is in the feeding tube pack?');

    await createAdmin('owner@test.local', Role.BUSINESS_OWNER);
    const cookie = await signInStaff('owner@test.local');

    const [row] = await listAs(cookie);

    expect(row?.name).toBe('Rohit Desai');
    expect(row?.email).toBe('rohit@clinic.test');
    expect(row?.phone).toBe('9820011223');
    expect(row?.isVerifiedContact).toBe(false);
    expect(row?.customerProfileId).toBeNull();
  });

  /*
   * A customer who need not have given a phone number. The screen has to cope
   * with an empty field rather than with an empty string that looks dialable.
   */
  it('reports a missing phone number as null rather than inventing one', async () => {
    const buyer = await createCustomer('nophone@hospital.test', { fullName: 'No Phone Buyer' });
    const id = await startedId(buyer);
    await appendMessage(id, 'VISITOR', 'Which packs are sterile?');

    await createAdmin('owner@test.local', Role.BUSINESS_OWNER);
    const cookie = await signInStaff('owner@test.local');

    const [row] = await listAs(cookie);

    expect(row?.name).toBe('No Phone Buyer');
    expect(row?.phone).toBeNull();
    expect(row?.isVerifiedContact).toBe(true);
  });

  it('leaves out a conversation nobody asked a question in', async () => {
    const buyer = await createCustomer('buyer@hospital.test');
    await startedId(buyer);

    await createAdmin('owner@test.local', Role.BUSINESS_OWNER);
    const cookie = await signInStaff('owner@test.local');

    expect(await listAs(cookie)).toEqual([]);
  });

  it('returns the whole transcript in order', async () => {
    const { id } = await seedSignedInConversation();
    await createAdmin('owner@test.local', Role.BUSINESS_OWNER);
    const cookie = await signInStaff('owner@test.local');

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/assistant/conversations/${id}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as {
      name: string | null;
      messages: { role: string; content: string }[];
    };

    expect(body.name).toBe('Priya Nair');
    expect(body.messages.map((message) => message.role)).toEqual(['VISITOR', 'ASSISTANT']);
    expect(body.messages[0]?.content).toBe('Do you stock 22G safety cannula?');
  });

  it('never returns a session token hash to staff', async () => {
    const { id } = await seedSignedInConversation();
    await createAdmin('owner@test.local', Role.BUSINESS_OWNER);
    const cookie = await signInStaff('owner@test.local');

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/assistant/conversations/${id}`,
      headers: { cookie },
    });

    expect(response.body).not.toContain('sessionTokenHash');
    expect(response.body).not.toContain('token');
  });

  it('refuses a role that does not hold assistant_chat.read', async () => {
    await seedSignedInConversation();

    // Catalog Manager is the role with no reason to read a customer's chat,
    // and the assertion states that rather than assuming it.
    expect(
      ROLE_DEFINITIONS.find((role) => role.key === Role.CATALOG_MANAGER)?.permissions,
    ).not.toContain(Permission.ASSISTANT_CHAT_READ);

    await createAdmin('catalog@test.local', Role.CATALOG_MANAGER);
    const cookie = await signInStaff('catalog@test.local');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/assistant/conversations',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses an unauthenticated read outright', async () => {
    await seedSignedInConversation();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/assistant/conversations',
    });

    expect(response.statusCode).toBe(401);
  });

  /*
   * One search box, both eras. The signed-in rows carry their name and address
   * on the account and null in the columns the old search matched, so a search
   * that only looked at the columns would silently return nothing for every
   * conversation since the sign-in gate.
   */
  it('searches the account behind a conversation, and the old typed details', async () => {
    await seedSignedInConversation();

    const historical = await seedHistoricalGuestConversation({
      name: 'Rohit Desai',
      phone: '9820011223',
      email: 'rohit@clinic.test',
    });
    await appendMessage(historical, 'VISITOR', 'What is in the feeding tube pack?');

    await createAdmin('owner@test.local', Role.BUSINESS_OWNER);
    const cookie = await signInStaff('owner@test.local');

    const matches = async (q: string): Promise<(string | null)[]> =>
      (await listAs(cookie, `?q=${encodeURIComponent(q)}`)).map((row) => row.name);

    // The signed-in customer, found through their account.
    expect(await matches('Priya')).toEqual(['Priya Nair']);
    // Typed in capitals, matched against the normalised column either way.
    expect(await matches('PRIYA.NAIR@hospital.test')).toEqual(['Priya Nair']);
    expect(await matches('98765')).toEqual(['Priya Nair']);

    // The historical guest, found through the columns nothing writes any more.
    expect(await matches('Rohit')).toEqual(['Rohit Desai']);
    expect(await matches('9820011223')).toEqual(['Rohit Desai']);

    expect(await matches('nobody-by-this-name')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AI Mode: the customer's own conversation history
//
// The corner chat widget kept one conversation id in `sessionStorage` and
// forgot it when the tab closed. AI Mode is a page with a history that belongs
// to the account, which adds four routes and exactly one thing worth holding
// down: none of them may be widened by anything a browser sends. Every read and
// write below is scoped to the caller's own `customerProfileId`, taken from the
// session guard, and somebody else's conversation is indistinguishable from one
// that does not exist.
// ---------------------------------------------------------------------------

/** GET the caller's own history. */
async function listMine(session: CustomerSession): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'GET',
    url: '/api/v1/assistant/conversations',
    headers: { cookie: session.cookies },
  });
}

function summariesOf(
  response: LightMyRequestResponse,
): { id: string; title: string | null; preview: string | null }[] {
  return (
    JSON.parse(response.body) as {
      conversations: { id: string; title: string | null; preview: string | null }[];
    }
  ).conversations;
}

/** A conversation with a question in it, so it is not filtered out as empty. */
async function conversationWithQuestion(
  session: CustomerSession,
  question: string,
): Promise<string> {
  const id = await startedId(session);
  await appendMessage(id, 'VISITOR', question);
  return id;
}

describe("a customer's own conversation history", () => {
  it('refuses a guest on all four routes', async () => {
    const id = newId();

    for (const [method, url] of [
      ['GET', '/api/v1/assistant/conversations'],
      ['GET', `/api/v1/assistant/conversations/${id}`],
      ['PATCH', `/api/v1/assistant/conversations/${id}`],
      ['DELETE', `/api/v1/assistant/conversations/${id}`],
    ] as const) {
      const response = await app.inject({ method, url, payload: { title: 'x' } });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('lists the caller their own threads and nobody else the same', async () => {
    const buyer = await createCustomer('buyer@hospital.test');
    const other = await createCustomer('other@clinic.test');

    const mine = await conversationWithQuestion(buyer, 'Do you stock 22G safety cannulae?');
    await conversationWithQuestion(other, 'What is your lead time on suction units?');

    const listed = summariesOf(await listMine(buyer));

    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(mine);
    // The opening question stands in for a name until somebody renames it.
    expect(listed[0]?.title).toBeNull();
    expect(listed[0]?.preview).toBe('Do you stock 22G safety cannulae?');
  });

  it('leaves out a conversation the customer never asked anything in', async () => {
    const buyer = await createCustomer('buyer@hospital.test');

    // A page somebody opened and closed again. It is not a conversation, and a
    // sidebar that grows a blank row on every visit is a bug people report.
    await startedId(buyer);

    expect(summariesOf(await listMine(buyer))).toEqual([]);
  });

  it('reads one transcript back in order, with the database roles translated', async () => {
    const buyer = await createCustomer('buyer@hospital.test');
    const id = await conversationWithQuestion(buyer, 'Which feeding tubes do you list?');
    await appendMessage(id, 'ASSISTANT', 'Three, in 8 Fr, 10 Fr and 12 Fr.');

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/assistant/conversations/${id}`,
      headers: { cookie: buyer.cookies },
    });

    expect(response.statusCode, response.body).toBe(200);

    const { conversation } = JSON.parse(response.body) as {
      conversation: { messages: { role: string; content: string }[] };
    };

    // `user` / `assistant`, not the column's `VISITOR` / `ASSISTANT`: the page
    // renders a chat transcript and should not have to know that the column was
    // named in the era of the guest widget.
    expect(conversation.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(conversation.messages[0]?.content).toBe('Which feeding tubes do you list?');
  });

  it("answers 404 for another customer's conversation, never 403", async () => {
    const buyer = await createCustomer('buyer@hospital.test');
    const other = await createCustomer('other@clinic.test');

    const theirs = await conversationWithQuestion(other, 'Do you deliver to Pune?');

    for (const [method, payload] of [
      ['GET', undefined],
      ['PATCH', { title: 'Mine now' }],
      ['DELETE', undefined],
    ] as const) {
      const response = await app.inject({
        method,
        url: `/api/v1/assistant/conversations/${theirs}`,
        headers: { cookie: buyer.cookies, 'x-csrf-token': buyer.csrfToken },
        ...(payload === undefined ? {} : { payload }),
      });

      // 404 and not 403. An owner mismatch that answered differently from a
      // missing row would turn an id into a way of asking whether somebody
      // else's conversation exists.
      expect(response.statusCode, `${method} ${response.body}`).toBe(404);
    }

    // And nothing was written by the attempts above.
    const row = await prisma.assistantConversation.findUniqueOrThrow({ where: { id: theirs } });
    expect(row.title).toBeNull();
    expect(row.hiddenAt).toBeNull();
  });

  it('renames a thread, and an empty title restores the question fallback', async () => {
    const buyer = await createCustomer('buyer@hospital.test');
    const id = await conversationWithQuestion(buyer, 'Do you stock 22G safety cannulae?');

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/assistant/conversations/${id}`,
      headers: { cookie: buyer.cookies, 'x-csrf-token': buyer.csrfToken },
      payload: { title: 'Cannula sizes' },
    });

    expect(renamed.statusCode, renamed.body).toBe(204);
    expect(summariesOf(await listMine(buyer))[0]?.title).toBe('Cannula sizes');

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/v1/assistant/conversations/${id}`,
      headers: { cookie: buyer.cookies, 'x-csrf-token': buyer.csrfToken },
      payload: { title: '' },
    });

    expect(cleared.statusCode, cleared.body).toBe(204);

    // Null, not the empty string: clearing the box means "use my question
    // again", and a row titled '' would render as a blank line in the sidebar.
    const listed = summariesOf(await listMine(buyer))[0];
    expect(listed?.title).toBeNull();
    expect(listed?.preview).toBe('Do you stock 22G safety cannulae?');
  });

  it('deletes from the customer side without destroying the record staff read', async () => {
    const buyer = await createCustomer('buyer@hospital.test');
    const id = await conversationWithQuestion(buyer, 'Which nebuliser masks fit a 22 mm port?');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/assistant/conversations/${id}`,
      headers: { cookie: buyer.cookies, 'x-csrf-token': buyer.csrfToken },
    });

    expect(deleted.statusCode, deleted.body).toBe(204);

    // Gone from every customer-facing read...
    expect(summariesOf(await listMine(buyer))).toEqual([]);

    const reread = await app.inject({
      method: 'GET',
      url: `/api/v1/assistant/conversations/${id}`,
      headers: { cookie: buyer.cookies },
    });
    expect(reread.statusCode).toBe(404);

    // ...and it cannot be carried on, which is the half that matters most: a
    // deleted thread must not keep accepting turns.
    expect(await authoriseConversation(id, asCustomer(buyer))).toBeNull();

    // But the transcript itself survives. What this deployment's AI told a
    // buyer about a medical device is a record it has to be able to produce; a
    // sidebar tidy-up is not a decision to destroy it, and erasure under
    // Art. 17 is a different act with its own route.
    const row = await prisma.assistantConversation.findUniqueOrThrow({ where: { id } });
    expect(row.hiddenAt).not.toBeNull();
    expect(await prisma.assistantMessage.count({ where: { conversationId: id } })).toBe(1);
  });

  it('refuses a body carrying anything the rename did not ask for', async () => {
    const buyer = await createCustomer('buyer@hospital.test');
    const id = await conversationWithQuestion(buyer, 'Do you deliver on Saturdays?');

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/assistant/conversations/${id}`,
      headers: { cookie: buyer.cookies, 'x-csrf-token': buyer.csrfToken },
      payload: { title: 'Fine', customerProfileId: newId() },
    });

    // Strict schemas everywhere on this surface: an unexpected field is a 400
    // that leaves a trace, not a silent strip that returns 200.
    expect(response.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The guest boundary
//
// Guests may chat, so the question that matters is what a guest token buys and
// what it does not. One thing: the single conversation it was minted for. It is
// not a key to anybody else's, it is not a substitute for an account, and the
// customer path and the guest path cannot be crossed in either direction.
// ---------------------------------------------------------------------------

describe('what a guest token is, and is not', () => {
  it('opens the conversation it was minted for', async () => {
    const { conversationId, conversationToken } = await startAsGuest();

    const conversation = await authoriseConversation(conversationId, {
      kind: 'guest',
      sessionTokenHash: sha256Hex(conversationToken),
    });

    expect(conversation?.id).toBe(conversationId);
  });

  it('opens nothing else, and no other token opens it', async () => {
    const mine = await startAsGuest();
    const theirs = await startAsGuest();

    // Somebody else's conversation, with my token.
    expect(
      await authoriseConversation(theirs.conversationId, {
        kind: 'guest',
        sessionTokenHash: sha256Hex(mine.conversationToken),
      }),
    ).toBeNull();

    // My conversation, with a token that was never issued.
    expect(
      await authoriseConversation(mine.conversationId, {
        kind: 'guest',
        sessionTokenHash: sha256Hex('f'.repeat(64)),
      }),
    ).toBeNull();
  });

  it("is not a key to a customer's conversation", async () => {
    const buyer = await createCustomer('buyer@hospital.test');
    const owned = await startedId(buyer);
    const guest = await startAsGuest();

    // A row with an account behind it is unreachable by the guest branch even
    // when the hash somehow matched, because that branch demands a row with no
    // owner at all.
    expect(
      await authoriseConversation(owned, {
        kind: 'guest',
        sessionTokenHash: sha256Hex(guest.conversationToken),
      }),
    ).toBeNull();
  });

  it("is not something a customer can use to pick up a guest's thread", async () => {
    const buyer = await createCustomer('buyer@hospital.test');
    const guest = await startAsGuest();

    // The other direction: a signed-in customer naming a guest conversation by
    // its id. It has no owner, so it is not theirs.
    expect(await authoriseConversation(guest.conversationId, asCustomer(buyer))).toBeNull();
  });

  it('answers 404 over HTTP when a guest names a conversation that is not theirs', async () => {
    const mine = await startAsGuest();
    const theirs = await startAsGuest();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/assistant/chat',
      payload: {
        conversationId: theirs.conversationId,
        message: 'Do you stock 22G safety cannulae?',
        conversationToken: mine.conversationToken,
      },
    });

    // 404, never 403: whether that conversation exists is not something an
    // anonymous caller gets to learn.
    expect(response.statusCode, response.body).toBe(404);
  });

  it('answers 404 when a guest sends no token at all', async () => {
    const { conversationId } = await startAsGuest();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/assistant/chat',
      payload: { conversationId, message: 'Do you stock 22G safety cannulae?' },
    });

    expect(response.statusCode, response.body).toBe(404);
  });

  it('rejects a token that is not the shape a token has', async () => {
    const { conversationId } = await startAsGuest();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/assistant/chat',
      payload: {
        conversationId,
        message: 'Do you stock 22G safety cannulae?',
        conversationToken: 'far too short',
      },
    });

    // 400 at the schema, before a SHA-256 and a database read are spent on a
    // value that cannot possibly match.
    expect(response.statusCode).toBe(400);
  });

  it('leaves a guest conversation out of every account history', async () => {
    const buyer = await createCustomer('buyer@hospital.test');
    const guest = await startAsGuest();
    await appendMessage(guest.conversationId, 'VISITOR', 'Do you deliver to Pune?');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/assistant/conversations',
      headers: { cookie: buyer.cookies },
    });

    expect(response.statusCode, response.body).toBe(200);
    // A guest's thread belongs to nobody, so it appears in nobody's sidebar —
    // not even that of a customer who happens to be on the same machine.
    expect((JSON.parse(response.body) as { conversations: unknown[] }).conversations).toEqual([]);
  });

  it('still records a guest transcript for staff', async () => {
    const guest = await startAsGuest();
    await appendMessage(guest.conversationId, 'VISITOR', 'Which feeding tubes do you list?');

    await createAdmin('owner@test.local', Role.BUSINESS_OWNER);
    const cookie = await signInStaff('owner@test.local');

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/assistant/conversations',
      headers: { cookie },
    });
    expect(listed.statusCode, listed.body).toBe(200);

    const rows = (
      JSON.parse(listed.body) as {
        conversations: { firstQuestion: string | null; isVerifiedContact: boolean; name: string | null }[];
      }
    ).conversations;

    // The point of keeping the transcript server-side does not depend on who
    // asked: staff read what this deployment's AI said, whoever it said it to.
    expect(rows.map((row) => row.firstQuestion)).toContain(
      'Which feeding tubes do you list?',
    );
    // And it is marked as what it is — nobody verified anything about them.
    expect(rows.find((row) => row.firstQuestion === 'Which feeding tubes do you list?')).toMatchObject(
      { isVerifiedContact: false, name: null },
    );
  });
});
