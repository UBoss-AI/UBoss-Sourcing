/**
 * The assistant against a provider that answers, fails, or is not there.
 *
 * `@google/genai` is replaced with a fake whose two methods each test scripts,
 * so every path below runs through the real route, the real guards, the real
 * provider adapter and the real error classification - only the network call
 * to Google is gone. `tests/setup.ts` pins both keys empty, and each test that
 * wants a configured provider sets one on `env` and `beforeEach` takes it away
 * again.
 *
 * What is being proved, in the order a request meets it:
 *
 *   - Nobody reaches the provider without an account (guests off).
 *   - An empty or oversized question never leaves the building.
 *   - No key means no assistant, said honestly: a 404 on the chat route and
 *     MISSING_CREDENTIALS on the status route.
 *   - A conversation's earlier turns go to the provider in order, with the
 *     assistant's turns under Gemini's `model` role.
 *   - Each failure reaches the page as its own code, with `retryable` set to
 *     whether a second attempt could possibly work - and never as an invented
 *     answer.
 *   - The key is in no response body, on any path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import type * as GenAI from '@google/genai';

const generateContentStream = vi.hoisted(() => vi.fn());
const generateContent = vi.hoisted(() => vi.fn());

vi.mock('@google/genai', async (importOriginal) => {
  const real = await importOriginal<typeof GenAI>();
  class FakeGoogleGenAI {
    models = { generateContentStream, generateContent };
  }
  return { ...real, GoogleGenAI: FakeGoogleGenAI };
});

import { ApiError } from '@google/genai';
import { signInAdmin } from '../support/admin-session.js';
import { env } from '../../src/config/env.js';
import { ROLE_DEFINITIONS, Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';

/** Recognisable, so a leak of it is obvious in any assertion message. */
const FAKE_KEY = 'AIzaTEST-assistant-provider-key-do-not-leak';
const PASSWORD = 'ProviderTestPass!2026';
const DOMAIN = 'assistant-provider.test';
/** This file's own source address, so its rate-limit buckets are its own. */
const IP = '198.51.100.61';

let app: Awaited<ReturnType<typeof buildApp>>;

// `env` is a plain object at run time; tests set its fields directly and put
// them back in afterAll.
const mutableEnv = env;
const original = {
  GEMINI_API_KEY: env.GEMINI_API_KEY,
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
  ASSISTANT_PROVIDER: env.ASSISTANT_PROVIDER,
  ASSISTANT_ALLOW_GUESTS: env.ASSISTANT_ALLOW_GUESTS,
  ASSISTANT_RATE_LIMIT_PER_5MIN: env.ASSISTANT_RATE_LIMIT_PER_5MIN,
};

function configure(key: string): void {
  mutableEnv.GEMINI_API_KEY = key;
  mutableEnv.ANTHROPIC_API_KEY = '';
  mutableEnv.ASSISTANT_PROVIDER = '';
}

// ---------------------------------------------------------------------------
// The fake provider
// ---------------------------------------------------------------------------

/** A stream that yields these chunks of text, then finishes for `reason`. */
function answers(chunks: string[], reason = 'STOP'): () => Promise<AsyncGenerator<unknown>> {
  return () =>
    Promise.resolve(
      (async function* stream() {
        for (const [index, text] of chunks.entries()) {
          yield {
            text,
            candidates: index === chunks.length - 1 ? [{ finishReason: reason }] : [{}],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: index + 1 },
          };
        }
        await Promise.resolve();
      })(),
    );
}

function fails(error: unknown): () => Promise<never> {
  return () => Promise.reject(error instanceof Error ? error : new Error(String(error)));
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

interface Session {
  cookies: string;
  csrfToken: string;
}

async function createCustomer(email: string): Promise<Session> {
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
  await prisma.customerProfile.create({
    data: { id: newId(), userId: user.id, fullName: 'Provider Test Buyer', activatedAt: new Date() },
  });

  const signIn = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': IP },
    payload: { email, password: PASSWORD },
  });
  expect(signIn.statusCode, signIn.body).toBe(200);

  const jar = signIn.cookies as { name: string; value: string }[];
  return {
    cookies: jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    csrfToken: jar.find((cookie) => cookie.name === 'uboss_shop_csrf')?.value ?? '',
  };
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

async function cleanUp(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: `@${DOMAIN}` } },
    select: { id: true, customerProfile: { select: { id: true } } },
  });
  const userIds = users.map((user) => user.id);
  const profileIds = users.flatMap((user) =>
    user.customerProfile === null ? [] : [user.customerProfile.id],
  );

  const conversations = await prisma.assistantConversation.findMany({
    where: { customerProfileId: { in: profileIds } },
    select: { id: true },
  });
  const conversationIds = conversations.map((conversation) => conversation.id);

  await prisma.assistantMessage.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.assistantConversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.customerProfile.deleteMany({ where: { id: { in: profileIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

// ---------------------------------------------------------------------------
// Talking to the route
// ---------------------------------------------------------------------------

async function start(session: Session): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/assistant/start',
    headers: { cookie: session.cookies, 'x-csrf-token': session.csrfToken, 'x-forwarded-for': IP },
    payload: {},
  });
  expect(response.statusCode, response.body).toBe(201);
  return (JSON.parse(response.body) as { conversationId: string }).conversationId;
}

function chat(
  session: Session | null,
  conversationId: string,
  message: string,
  ip = IP,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/assistant/chat',
    headers: {
      'x-forwarded-for': ip,
      ...(session === null ? {} : { cookie: session.cookies, 'x-csrf-token': session.csrfToken }),
    },
    payload: { conversationId, message },
  });
}

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

function framesOf(response: LightMyRequestResponse): Frame[] {
  return response.body
    .split('\n\n')
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const event = /^event: (.+)$/m.exec(frame)?.[1] ?? 'message';
      const data = /^data: (.+)$/m.exec(frame)?.[1] ?? '{}';
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

function errorFrame(response: LightMyRequestResponse): Record<string, unknown> | undefined {
  return framesOf(response).find((frame) => frame.event === 'error')?.data;
}

// ---------------------------------------------------------------------------

let customer: Session;

beforeAll(async () => {
  app = await buildApp();
  await cleanUp();

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

  customer = await createCustomer(`buyer@${DOMAIN}`);
  await createAdmin(`settings-admin@${DOMAIN}`, Role.BUSINESS_OWNER);
});

beforeEach(() => {
  generateContentStream.mockReset();
  generateContent.mockReset();
  configure(FAKE_KEY);
  mutableEnv.ASSISTANT_ALLOW_GUESTS = false;
  mutableEnv.ASSISTANT_RATE_LIMIT_PER_5MIN = 1000;
});

afterAll(async () => {
  Object.assign(mutableEnv, original);
  await cleanUp();
  await app.close();
});

describe('a working provider', () => {
  it('streams an answer to a signed-in customer, and records it', async () => {
    generateContentStream.mockImplementation(answers(['Hello, ', 'how can I help?']));
    const conversationId = await start(customer);

    const response = await chat(customer, conversationId, 'Do you sell gloves?');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const frames = framesOf(response);
    expect(frames.filter((frame) => frame.event === 'delta').map((frame) => frame.data.text)).toEqual([
      'Hello, ',
      'how can I help?',
    ]);
    expect(frames.at(-1)?.event).toBe('done');
    expect(errorFrame(response)).toBeUndefined();

    // The answer is written after the stream closes, so it is waited for
    // rather than read straight away.
    await vi.waitFor(async () => {
      const stored = await prisma.assistantMessage.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
      });
      expect(stored.map((message) => message.role)).toEqual(['VISITOR', 'ASSISTANT']);
      expect(stored[1]?.content).toBe('Hello, how can I help?');
    });
  });

  it('sends the earlier turns in order, the assistant as Gemini`s "model"', async () => {
    generateContentStream.mockImplementation(answers(['First answer.']));
    const conversationId = await start(customer);
    await chat(customer, conversationId, 'First question');
    await vi.waitFor(async () => {
      expect(await prisma.assistantMessage.count({ where: { conversationId } })).toBe(2);
    });

    generateContentStream.mockImplementation(answers(['Second answer.']));
    await chat(customer, conversationId, 'Second question');

    const request = generateContentStream.mock.calls.at(-1)?.[0] as {
      model: string;
      contents: { role: string; parts: { text: string }[] }[];
      config: { systemInstruction: { parts: { text: string }[] }; maxOutputTokens: number };
    };
    expect(request.model).toBe(env.GEMINI_MODEL);
    expect(request.contents.map((turn) => [turn.role, turn.parts[0]?.text])).toEqual([
      ['user', 'First question'],
      ['model', 'First answer.'],
      ['user', 'Second question'],
    ]);
    expect(request.config.maxOutputTokens).toBe(env.ASSISTANT_MAX_TOKENS);

    // Nothing that identifies a session or a credential goes to the provider.
    const sent = JSON.stringify(request);
    expect(sent).not.toContain(FAKE_KEY);
    expect(sent).not.toContain(customer.csrfToken);
    expect(sent).not.toContain(PASSWORD);
  });
});

describe('a provider that fails', () => {
  const cases: {
    name: string;
    error: unknown;
    code: string;
    retryable: boolean;
  }[] = [
    {
      name: 'a refused key',
      error: new ApiError({
        status: 400,
        message: `{"error":{"status":"INVALID_ARGUMENT","message":"API key not valid.","details":[{"reason":"API_KEY_INVALID"}]}}`,
      }),
      code: 'UNAVAILABLE',
      retryable: false,
    },
    {
      name: 'a spent quota',
      error: new ApiError({ status: 429, message: 'RESOURCE_EXHAUSTED quota free_tier' }),
      code: 'QUOTA',
      retryable: true,
    },
    {
      name: 'an overloaded model',
      error: new ApiError({ status: 503, message: 'UNAVAILABLE high demand' }),
      code: 'BUSY',
      retryable: true,
    },
    {
      name: 'a withdrawn model',
      error: new ApiError({ status: 404, message: 'NOT_FOUND models/gemini-0 is not found' }),
      code: 'UNAVAILABLE',
      retryable: false,
    },
    {
      name: 'a deadline',
      error: Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      }),
      code: 'TIMEOUT',
      retryable: true,
    },
    {
      name: 'an unreachable provider',
      error: new TypeError('fetch failed'),
      code: 'UNAVAILABLE',
      retryable: true,
    },
  ];

  for (const testCase of cases) {
    it(`reports ${testCase.name} as ${testCase.code}, and invents no answer`, async () => {
      generateContentStream.mockImplementation(fails(testCase.error));
      const conversationId = await start(customer);

      const response = await chat(customer, conversationId, 'Anything in stock?');

      expect(response.statusCode).toBe(200);
      expect(framesOf(response).some((frame) => frame.event === 'delta')).toBe(false);
      expect(errorFrame(response)).toMatchObject({
        code: testCase.code,
        retryable: testCase.retryable,
      });

      // The provider's own words are for the log, never for the visitor.
      const message = testCase.error instanceof Error ? testCase.error.message : '';
      expect(response.body).not.toContain(message);
      expect(response.body).not.toContain(FAKE_KEY);

      // The question is kept; no answer was made up to go with it.
      const stored = await prisma.assistantMessage.findMany({ where: { conversationId } });
      expect(stored.map((row) => row.role)).toEqual(['VISITOR']);
    });
  }

  it('reports a safety block as REFUSED, with no Retry', async () => {
    generateContentStream.mockImplementation(answers([''], 'SAFETY'));
    const conversationId = await start(customer);

    const response = await chat(customer, conversationId, 'Something the model declines');

    expect(errorFrame(response)).toMatchObject({ code: 'REFUSED', retryable: false });
  });
});

describe('the gate in front of the provider', () => {
  it('answers 404 when no key is configured, and never calls anybody', async () => {
    const conversationId = await start(customer);
    configure('');

    const response = await chat(customer, conversationId, 'Hello?');

    expect(response.statusCode).toBe(404);
    expect(generateContentStream).not.toHaveBeenCalled();
  });

  it('refuses a caller with no account', async () => {
    const response = await chat(null, '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'Hello?');

    expect(response.statusCode).toBe(401);
    expect(generateContentStream).not.toHaveBeenCalled();
  });

  it('refuses an empty question and an oversized one before the provider', async () => {
    const conversationId = await start(customer);

    const empty = await chat(customer, conversationId, '   ');
    const oversized = await chat(customer, conversationId, 'x'.repeat(8_001));

    expect(empty.statusCode).toBe(400);
    expect(oversized.statusCode).toBe(400);
    expect(generateContentStream).not.toHaveBeenCalled();
  });

  it('stops a caller who asks faster than the allowance', async () => {
    generateContentStream.mockImplementation(answers(['ok']));
    mutableEnv.ASSISTANT_RATE_LIMIT_PER_5MIN = 2;
    const conversationId = await start(customer);
    // Its own address, so the bucket starts empty and belongs to this test.
    const ip = '198.51.100.62';

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push((await chat(customer, conversationId, `Question ${String(attempt)}`, ip)).statusCode);
    }

    expect(statuses).toEqual([200, 200, 429]);
    expect(generateContentStream).toHaveBeenCalledTimes(2);
  });
});

describe('the configuration check', () => {
  async function status(query = ''): Promise<LightMyRequestResponse> {
    const session = await signInAdmin(app, {
      email: `settings-admin@${DOMAIN}`,
      password: PASSWORD,
      ip: '198.51.100.63',
    });
    return app.inject({
      method: 'GET',
      url: `/api/v1/admin/assistant/status${query}`,
      headers: { cookie: session.cookies, 'x-forwarded-for': '198.51.100.63' },
    });
  }

  it('says CONFIGURED, names the provider and model, and never the key', async () => {
    const response = await status();

    expect(response.statusCode, response.body).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      status: 'CONFIGURED',
      provider: 'gemini',
      model: env.GEMINI_MODEL,
    });
    expect(response.body).not.toContain(FAKE_KEY);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(generateContentStream).not.toHaveBeenCalled();
  });

  it('says MISSING_CREDENTIALS when there is no key', async () => {
    configure('');

    const response = await status();

    expect(JSON.parse(response.body)).toMatchObject({ status: 'MISSING_CREDENTIALS', provider: null });
  });

  it('probes only when asked, and reports a refused key as a reason, not as text', async () => {
    generateContentStream.mockImplementation(
      fails(new ApiError({ status: 400, message: 'API_KEY_INVALID API key not valid' })),
    );

    const response = await status('?probe=true');
    const body = JSON.parse(response.body) as { probe: { ok: boolean; reason: string } };

    expect(generateContentStream).toHaveBeenCalledTimes(1);
    expect(body.probe).toMatchObject({ ok: false, reason: 'credentials' });
    expect(response.body).not.toContain('API key not valid');
    expect(response.body).not.toContain(FAKE_KEY);
  });

  it('reports a probe that answered', async () => {
    generateContentStream.mockImplementation(answers(['OK']));

    const body = JSON.parse((await status('?probe=true')).body) as { probe: { ok: boolean } };

    expect(body.probe.ok).toBe(true);
  });

  it('is not readable without a staff session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/assistant/status' });

    expect(response.statusCode).toBe(401);
  });
});
