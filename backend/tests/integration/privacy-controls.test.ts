/**
 * The retention schedule and processing register the console shows (DOD-031).
 *
 * Three things are proven:
 *
 *   1. Every retention window in `config/env.ts` is on the schedule. A new
 *      `RETENTION_*` setting that nobody added to `retentionSchedule()` fails
 *      here, because a window the operator cannot see is one they cannot
 *      answer for.
 *   2. What the screen says is what the sweeps will do: the value comes from
 *      `env` at request time, and 0 reads as "kept for ever", not as "0 days".
 *   3. Only staff holding `data_request.read` can read either list, and
 *      neither ever carries a credential or a full URL.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  hostOf,
  processingRegister,
  retentionSchedule,
} from '../../src/modules/privacy/privacy-controls.service.js';
import { signInAdmin, type AdminSession } from '../support/admin-session.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const PASSWORD = 'PrivacyControls!2026';
const OWNER_EMAIL = 'privacy-controls-owner@test.local';
const CATALOG_EMAIL = 'privacy-controls-catalog@test.local';
const EMAILS = [OWNER_EMAIL, CATALOG_EMAIL];
const IP = '203.0.113.93';

async function makeStaff(email: string, role: string): Promise<void> {
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { key: role }, select: { id: true } });
  const id = newId();
  await prisma.user.create({
    data: {
      id,
      type: 'ADMIN',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.userRole.create({ data: { userId: id, roleId: roleRow.id } });
}

async function cleanUp(): Promise<void> {
  await prisma.session.deleteMany({ where: { user: { emailNormalized: { in: EMAILS } } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: { in: EMAILS } } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { in: EMAILS } } });
}

let owner: AdminSession;
let catalog: AdminSession;

beforeAll(async () => {
  app = await buildApp();
  await cleanUp();
  await makeStaff(OWNER_EMAIL, Role.BUSINESS_OWNER);
  await makeStaff(CATALOG_EMAIL, Role.CATALOG_MANAGER);
  owner = await signInAdmin(app, { email: OWNER_EMAIL, password: PASSWORD, ip: IP });
  catalog = await signInAdmin(app, { email: CATALOG_EMAIL, password: PASSWORD, ip: IP });
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

const get = (url: string, session: AdminSession | null) =>
  app.inject({
    method: 'GET',
    url,
    headers:
      session === null
        ? { 'x-forwarded-for': IP }
        : { cookie: session.cookies, 'x-csrf-token': session.csrfToken, 'x-forwarded-for': IP },
  });

describe('the retention schedule', () => {
  it('lists every retention window the configuration defines', () => {
    const source = readFileSync(new URL('../../src/config/env.ts', import.meta.url), 'utf8');
    const declared = new Set(
      [...source.matchAll(/^\s+([A-Z0-9_]*RETENTION[A-Z0-9_]*|DATA_REQUEST_DOWNLOAD_TTL_HOURS):/gm)].map(
        (match) => match[1] as string,
      ),
    );
    const listed = new Set(retentionSchedule().map((rule) => rule.setting));

    expect(declared.size).toBeGreaterThan(5);
    for (const setting of declared) {
      expect(listed, `${setting} is not on the retention schedule`).toContain(setting);
    }
  });

  it('reports the live value, and a zero window as kept rather than deleted at once', () => {
    const mutable = env as { RETENTION_ABANDONED_CART_DAYS: number };
    const original = mutable.RETENTION_ABANDONED_CART_DAYS;
    try {
      mutable.RETENTION_ABANDONED_CART_DAYS = 0;
      const off = retentionSchedule().find((rule) => rule.setting === 'RETENTION_ABANDONED_CART_DAYS');
      expect(off).toMatchObject({ value: 0, enforced: false, zeroDisables: true });

      mutable.RETENTION_ABANDONED_CART_DAYS = 45;
      const on = retentionSchedule().find((rule) => rule.setting === 'RETENTION_ABANDONED_CART_DAYS');
      expect(on).toMatchObject({ value: 45, enforced: true });
    } finally {
      mutable.RETENTION_ABANDONED_CART_DAYS = original;
    }
  });

  it('is readable by staff holding data_request.read', async () => {
    const response = await get('/api/v1/admin/privacy/retention-schedule', owner);

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ rules: { setting: string; value: number }[] }>();
    expect(body.rules.find((rule) => rule.setting === 'RETENTION_AUDIT_LOG_DAYS')?.value).toBe(
      env.RETENTION_AUDIT_LOG_DAYS,
    );
  });

  it('is refused to staff without the grant, and to nobody signed in', async () => {
    expect((await get('/api/v1/admin/privacy/retention-schedule', catalog)).statusCode).toBe(403);
    expect((await get('/api/v1/admin/privacy/retention-schedule', null)).statusCode).toBe(401);
  });
});

describe('the processing register', () => {
  it('names a host and never a credential, path or query string', () => {
    expect(hostOf('https://user:secret@smtp.example.com:587/path?key=abc')).toBe('smtp.example.com');
    expect(hostOf('https://nominatim.openstreetmap.org/reverse?lat={lat}&lon={lon}')).toBe(
      'nominatim.openstreetmap.org',
    );
    expect(hostOf('mail.example.org')).toBe('mail.example.org');
    expect(hostOf('')).toBeNull();
    expect(hostOf('not a host at all')).toBeNull();
  });

  it('says a switched-off processor is off, with no host', async () => {
    const mutable = env as { EMAIL_DRIVER: 'log' | 'smtp' };
    const original = mutable.EMAIL_DRIVER;
    try {
      mutable.EMAIL_DRIVER = 'log';
      const email = (await processingRegister()).find((entry) => entry.id === 'EMAIL_SMTP');
      expect(email).toMatchObject({ active: false, host: null });
    } finally {
      mutable.EMAIL_DRIVER = original;
    }
  });

  it('is readable by staff holding data_request.read, and carries nothing secret', async () => {
    const response = await get('/api/v1/admin/privacy/processors', owner);

    expect(response.statusCode, response.body).toBe(200);
    const ids = response.json<{ processors: { id: string }[] }>().processors.map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining(['STRIPE', 'EMAIL_SMTP', 'OBJECT_STORAGE', 'AI_ASSISTANT']));

    for (const secret of [env.SMTP_PASSWORD, env.GEMINI_API_KEY, env.ANTHROPIC_API_KEY]) {
      if (secret.length > 0) expect(response.body).not.toContain(secret);
    }
    expect(response.body).not.toMatch(/https?:\/\//);
  });

  it('is refused to staff without the grant, and to nobody signed in', async () => {
    expect((await get('/api/v1/admin/privacy/processors', catalog)).statusCode).toBe(403);
    expect((await get('/api/v1/admin/privacy/processors', null)).statusCode).toBe(401);
  });
});
