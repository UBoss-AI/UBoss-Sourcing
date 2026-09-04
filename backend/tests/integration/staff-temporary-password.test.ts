/**
 * Staff onboarding by emailed temporary password - integration.
 *
 * The password travels in plaintext and then sits in an inbox, which is the
 * whole reason these tests exist. Three properties have to hold or the flow is
 * worse than the activation link it replaces:
 *
 *   - it opens a session and NOTHING else until a real password is set,
 *   - it stops working on its own after 72 hours,
 *   - nobody but the recipient ever sees it - not the administrator who created
 *     the account, not the API response, not the audit log.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppError } from '../../src/domain/errors.js';
import { Permission, ROLE_DEFINITIONS, Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { login } from '../../src/modules/identity/auth.service.js';
import {
  buildTokenUrl,
  completePasswordReset,
  issueToken,
  requestPasswordReset,
} from '../../src/modules/identity/token.service.js';
import { env } from '../../src/config/env.js';
import { changePassword } from '../../src/modules/identity/auth.service.js';
import {
  createStaff,
  listStaff,
  reissueTemporaryPassword,
} from '../../src/modules/identity/staff.service.js';

const OWNER_PASSWORD = 'OwnerTestPass!2026';

let ownerId: string;
let ownerActor: { userId: string; email: string; permissions: readonly string[] };

async function resetDatabase(): Promise<void> {
  await prisma.notificationDelivery.deleteMany({});
  await prisma.notificationOutbox.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.loginAttempt.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.authToken.deleteMany({});
  await prisma.userRole.deleteMany({});
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

/** Read the temporary password out of the email, the way its recipient would. */
function temporaryPasswordFromEmail(body: string): string {
  const match = /Temporary password:\s*([A-Z0-9-]+)/.exec(body);
  if (match?.[1] === undefined) throw new Error(`No temporary password in:\n${body}`);
  return match[1];
}

async function latestStaffEmail(): Promise<{ body: string; to: string }> {
  const row = await prisma.notificationOutbox.findFirst({
    where: { eventKey: 'staff.temporary_password' },
    orderBy: { createdAt: 'desc' },
  });
  if (row === null) throw new Error('No staff.temporary_password notification was queued.');
  return { body: row.body, to: row.recipientEmail ?? '' };
}

async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return (error as AppError).code ?? 'UNKNOWN';
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

beforeAll(async () => {
  await resetDatabase();
  await seedRoles();
});

beforeEach(async () => {
  await resetDatabase();
  await seedRoles();

  const ownerRole = await prisma.role.findUniqueOrThrow({ where: { key: Role.BUSINESS_OWNER } });
  ownerId = newId();

  await prisma.user.create({
    data: {
      id: ownerId,
      type: 'ADMIN',
      email: 'owner@test.local',
      emailNormalized: 'owner@test.local',
      passwordHash: await hashPassword(OWNER_PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: ownerRole.id } },
    },
  });

  ownerActor = {
    userId: ownerId,
    email: 'owner@test.local',
    permissions: ROLE_DEFINITIONS.find((r) => r.key === Role.BUSINESS_OWNER)?.permissions ?? [],
  };
});

async function invite(email = 'newstaff@test.local'): Promise<{ password: string }> {
  await createStaff({ email, roleKeys: [Role.ORDER_MANAGER] }, ownerActor as never);
  const { body } = await latestStaffEmail();
  return { password: temporaryPasswordFromEmail(body) };
}

describe('creating a staff account', () => {
  it('emails a temporary password and marks the account as owing a real one', async () => {
    const created = await createStaff(
      { email: 'newstaff@test.local', roleKeys: [Role.ORDER_MANAGER] },
      ownerActor as never,
    );

    const user = await prisma.user.findUniqueOrThrow({
      where: { emailNormalized: 'newstaff@test.local' },
      include: { roles: { include: { role: true } } },
    });

    // ACTIVE so the temporary password can actually sign in; the block lives on
    // mustChangePassword, not on the status.
    expect(user.status).toBe('ACTIVE');
    expect(user.mustChangePassword).toBe(true);
    expect(user.passwordHash).not.toBeNull();
    expect(user.temporaryPasswordExpiresAt).not.toBeNull();
    expect(user.roles.map((r) => r.role.key)).toEqual([Role.ORDER_MANAGER]);

    const { to, body } = await latestStaffEmail();
    expect(to).toBe('newstaff@test.local');

    const password = temporaryPasswordFromEmail(body);
    // Four groups of four from the unambiguous alphabet.
    expect(password).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
    // The policy floor is 12; this must clear it or the change screen would be
    // the first thing to reject the password we just issued.
    expect(password.length).toBeGreaterThanOrEqual(12);

    // Never handed back to the caller who created the account.
    expect(JSON.stringify(created)).not.toContain(password);
  });

  it('keeps the password out of the audit trail', async () => {
    const { password } = await invite();

    const rows = await prisma.auditLog.findMany({});
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(password);
  });

  it('issues a different password every time', async () => {
    const first = await invite('one@test.local');
    const second = await invite('two@test.local');
    expect(second.password).not.toBe(first.password);
  });

  it('shows the account as still owing a password in the staff list', async () => {
    await invite();
    const rows = await listStaff();
    const row = rows.find((r) => r['email'] === 'newstaff@test.local');

    expect(row?.['mustChangePassword']).toBe(true);
    expect(row?.['temporaryPasswordExpiresAt']).not.toBeNull();
  });
});

describe('the first sign-in', () => {
  it('accepts the temporary password and reports that a real one is owed', async () => {
    const { password } = await invite();

    const result = await login({
      email: 'newstaff@test.local',
      password,
      kind: 'ADMIN',
    });

    expect(result.user.mustChangePassword).toBe(true);
    expect(result.user.roles).toEqual([Role.ORDER_MANAGER]);
  });

  it('refuses a temporary password that has lapsed', async () => {
    const { password } = await invite();

    await prisma.user.update({
      where: { emailNormalized: 'newstaff@test.local' },
      data: { temporaryPasswordExpiresAt: new Date(Date.now() - 60_000) },
    });

    expect(
      await codeOf(() => login({ email: 'newstaff@test.local', password, kind: 'ADMIN' })),
    ).toBe('TEMPORARY_PASSWORD_EXPIRED');
  });

  it('still refuses a wrong password rather than disclosing the expiry', async () => {
    await invite();

    await prisma.user.update({
      where: { emailNormalized: 'newstaff@test.local' },
      data: { temporaryPasswordExpiresAt: new Date(Date.now() - 60_000) },
    });

    // Somebody who does not know the password learns nothing about the account.
    expect(
      await codeOf(() =>
        login({ email: 'newstaff@test.local', password: 'WrongPassword!2026', kind: 'ADMIN' }),
      ),
    ).toBe('INVALID_CREDENTIALS');
  });
});

describe('choosing a real password', () => {
  it('lifts the block and clears the expiry', async () => {
    const { password } = await invite();
    const user = await prisma.user.findUniqueOrThrow({
      where: { emailNormalized: 'newstaff@test.local' },
    });

    await changePassword({
      userId: user.id,
      currentPassword: password,
      newPassword: 'MyOwnRealPassword!2026',
    });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.mustChangePassword).toBe(false);
    expect(after.temporaryPasswordExpiresAt).toBeNull();

    const result = await login({
      email: 'newstaff@test.local',
      password: 'MyOwnRealPassword!2026',
      kind: 'ADMIN',
    });
    expect(result.user.mustChangePassword).toBe(false);

    // And the temporary one is dead.
    expect(
      await codeOf(() => login({ email: 'newstaff@test.local', password, kind: 'ADMIN' })),
    ).toBe('INVALID_CREDENTIALS');
  });

  it('will not let the temporary password be kept as the real one', async () => {
    const { password } = await invite();
    const user = await prisma.user.findUniqueOrThrow({
      where: { emailNormalized: 'newstaff@test.local' },
    });

    expect(
      await codeOf(() =>
        changePassword({ userId: user.id, currentPassword: password, newPassword: password }),
      ),
    ).toBe('VALIDATION_FAILED');
  });
});

describe('re-issuing', () => {
  it('replaces the old temporary password with a new one', async () => {
    const first = await invite();
    const user = await prisma.user.findUniqueOrThrow({
      where: { emailNormalized: 'newstaff@test.local' },
    });

    await reissueTemporaryPassword(user.id, ownerActor as never);
    const second = temporaryPasswordFromEmail((await latestStaffEmail()).body);

    expect(second).not.toBe(first.password);

    // The one that went astray must stop working, or two live credentials exist.
    expect(
      await codeOf(() =>
        login({ email: 'newstaff@test.local', password: first.password, kind: 'ADMIN' }),
      ),
    ).toBe('INVALID_CREDENTIALS');

    const signedIn = await login({
      email: 'newstaff@test.local',
      password: second,
      kind: 'ADMIN',
    });
    expect(signedIn.user.mustChangePassword).toBe(true);
  });

  it('rescues an account invited under the old link flow', async () => {
    // A row exactly as the previous onboarding left it: pending, no password,
    // an unclicked invitation token outstanding.
    const catalogRole = await prisma.role.findUniqueOrThrow({
      where: { key: Role.CATALOG_MANAGER },
    });
    const staleId = newId();

    await prisma.user.create({
      data: {
        id: staleId,
        type: 'ADMIN',
        email: 'invited-long-ago@test.local',
        emailNormalized: 'invited-long-ago@test.local',
        passwordHash: null,
        status: 'PENDING_INVITATION',
        roles: { create: { roleId: catalogRole.id } },
      },
    });
    await issueToken(staleId, 'INVITATION');

    await reissueTemporaryPassword(staleId, ownerActor as never);
    const password = temporaryPasswordFromEmail((await latestStaffEmail()).body);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: staleId } });
    expect(after.status).toBe('ACTIVE');
    expect(after.mustChangePassword).toBe(true);

    // The old invitation link must not survive as a second way into the account.
    const live = await prisma.authToken.count({
      where: { userId: staleId, type: 'INVITATION', consumedAt: null },
    });
    expect(live).toBe(0);

    const signedIn = await login({
      email: 'invited-long-ago@test.local',
      password,
      kind: 'ADMIN',
    });
    expect(signedIn.user.mustChangePassword).toBe(true);
  });

  it('refuses once the holder has a password of their own', async () => {
    const { password } = await invite();
    const user = await prisma.user.findUniqueOrThrow({
      where: { emailNormalized: 'newstaff@test.local' },
    });

    await changePassword({
      userId: user.id,
      currentPassword: password,
      newPassword: 'MyOwnRealPassword!2026',
    });

    expect(await codeOf(() => reissueTemporaryPassword(user.id, ownerActor as never))).toBe(
      'CONFLICT',
    );
  });
});

describe('forgetting the password afterwards', () => {
  it('settles the temporary-password debt as well', async () => {
    // Straight from the emailed temporary password to "Forgot password",
    // without ever visiting the change screen. Setting a password by reset link
    // IS the holder choosing their own, so the wall must come down with it -
    // otherwise they would be locked behind a screen they cannot get past.
    await invite();

    const issued = await requestPasswordReset('newstaff@test.local');
    expect(issued).not.toBeNull();

    await completePasswordReset({
      token: issued?.token ?? '',
      newPassword: 'ResetByLink!2026',
    });

    const after = await prisma.user.findUniqueOrThrow({
      where: { emailNormalized: 'newstaff@test.local' },
    });

    expect(after.mustChangePassword).toBe(false);
    expect(after.temporaryPasswordExpiresAt).toBeNull();

    const signedIn = await login({
      email: 'newstaff@test.local',
      password: 'ResetByLink!2026',
      kind: 'ADMIN',
    });

    expect(signedIn.user.mustChangePassword).toBe(false);
  });

  it('says nothing about an address with no account', async () => {
    // The route answers 202 either way; the service returning null is what the
    // uniform response is built on.
    expect(await requestPasswordReset('nobody@test.local')).toBeNull();
  });

  it('sends a reset link to the ADMIN origin, not the storefront', async () => {
    await invite();
    const issued = await requestPasswordReset('newstaff@test.local');

    const url = buildTokenUrl('PASSWORD_RESET', issued?.token ?? '', 'ADMIN');
    expect(url).toContain('/reset-password?token=');
    expect(url.startsWith(env.ADMIN_WEB_PUBLIC_URL.replace(/\/$/, ''))).toBe(true);
  });
});

// --- The block, over HTTP ---------------------------------------------------

describe('what a temporary-password session may do', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function signIn(password: string): Promise<{ cookie: string; csrf: string }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      payload: { email: 'newstaff@test.local', password },
    });

    expect(response.statusCode).toBe(200);

    const raw = response.headers['set-cookie'];
    const cookies = Array.isArray(raw) ? raw : [raw ?? ''];

    return {
      cookie: cookies.map((c) => c.split(';')[0]).join('; '),
      csrf: (JSON.parse(response.body) as { csrfToken: string }).csrfToken,
    };
  }

  it('signs in, but every admin route refuses it', async () => {
    const { password } = await invite();
    const session = await signIn(password);

    // A route this role genuinely holds the permission for, so a refusal can
    // only be the temporary-password block and not authorization noise.
    expect(ROLE_DEFINITIONS.find((r) => r.key === Role.ORDER_MANAGER)?.permissions).toContain(
      Permission.ORDER_READ,
    );

    const orders = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders',
      headers: { cookie: session.cookie },
    });

    expect(orders.statusCode).toBe(403);
    expect((JSON.parse(orders.body) as { error: { code: string } }).error.code).toBe(
      'PASSWORD_CHANGE_REQUIRED',
    );
  });

  it('can still read itself and set a password', async () => {
    const { password } = await invite();
    const session = await signIn(password);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/auth/me',
      headers: { cookie: session.cookie },
    });

    expect(me.statusCode).toBe(200);
    expect((JSON.parse(me.body) as { mustChangePassword: boolean }).mustChangePassword).toBe(true);

    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/password/change',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: { currentPassword: password, newPassword: 'MyOwnRealPassword!2026' },
    });

    expect(changed.statusCode).toBe(200);

    // Changing a password ends every session, this one included, so the new
    // password is what gets back in.
    const reSignedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      payload: { email: 'newstaff@test.local', password: 'MyOwnRealPassword!2026' },
    });

    expect(reSignedIn.statusCode).toBe(200);

    const raw = reSignedIn.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw : [raw ?? '']).map((c) => c.split(';')[0]).join('; ');

    // The same route that was 403 a moment ago. Orders, not staff: an Order
    // Manager holds order.read and does NOT hold staff.read, so /admin/staff
    // would stay 403 for a permission reason and prove nothing about the block
    // being lifted.
    const orders = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders',
      headers: { cookie },
    });

    expect(orders.statusCode).toBe(200);
  });
});
