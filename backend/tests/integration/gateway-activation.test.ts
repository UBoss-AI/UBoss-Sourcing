/**
 * A payment gateway cannot go live without a webhook signing secret.
 *
 * The rule this protects: an order is confirmed only by a signature-verified
 * provider event. Without the signing secret there is nothing to verify a
 * signature against, so every delivery is rejected as unverified.
 *
 * That failure is silent in the worst way. The gateway still charges the
 * customer, the storefront still says "payment taken", and every order sits at
 * Pending Payment forever with nobody looking. Activation is the last point
 * where it can be caught before money moves.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signInAdmin } from '../support/admin-session.js';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { encryptSecret, hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let cookies: string;
let csrfToken: string;

const EMAIL = 'gateway-activation@test.local';
const PASSWORD = 'GatewayActivate!2026';

/**
 * One row per (provider, mode) is a unique constraint, so each case replaces
 * the previous connection rather than adding another.
 */
async function makeConnection(withSecret: boolean): Promise<string> {
  const id = newId();

  await prisma.paymentProviderConnection.deleteMany({
    where: { provider: 'RAZORPAY', mode: 'TEST' },
  });

  await prisma.paymentProviderConnection.create({
    data: {
      id,
      provider: 'RAZORPAY',
      mode: 'TEST',
      label: `activation-${id}`,
      credentialsEnc: encryptSecret(
        JSON.stringify({ keyId: 'rzp_test_activation', keySecret: 'secret' }),
        `payment_connection:${id}`,
      ),
      credentialsMask: 'rzp_tes...tion',
      webhookSecretEnc: withSecret
        ? encryptSecret('whsec_activation', `payment_connection:${id}`)
        : null,
      // Activation also demands a passing test; granting it here isolates this
      // file to the one rule it is about.
      lastTestStatus: 'OK',
      lastTestedAt: new Date(),
      isActive: false,
    },
  });

  return id;
}

async function activate(connectionId: string) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/admin/payments/connections/${connectionId}/status`,
    headers: { cookie: cookies, 'x-csrf-token': csrfToken },
    payload: { active: true },
  });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });

  const ownerRole = await prisma.role.findUniqueOrThrow({
    where: { key: Role.BUSINESS_OWNER },
    select: { id: true },
  });

  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email: EMAIL,
      emailNormalized: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: ownerRole.id } },
    },
  });

  ({ cookies, csrfToken } = await signInAdmin(app, { email: EMAIL, password: PASSWORD }));
});

afterAll(async () => {
  await prisma.paymentProviderConnection.deleteMany({
    where: { label: { startsWith: 'activation-' } },
  });
  await prisma.paymentProviderConnection.updateMany({ data: { isActive: false } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
  await app.close();
});

describe('activating a payment gateway', () => {
  it('refuses a connection with no webhook signing secret', async () => {
    const id = await makeConnection(false);

    const response = await activate(id);

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'PAYMENT_PROVIDER_NOT_CONFIGURED',
    );

    const row = await prisma.paymentProviderConnection.findUniqueOrThrow({
      where: { id },
      select: { isActive: true },
    });
    expect(row.isActive).toBe(false);
  });

  it('activates once the signing secret is stored', async () => {
    const id = await makeConnection(true);

    const response = await activate(id);

    expect(response.statusCode, response.body).toBe(200);

    const row = await prisma.paymentProviderConnection.findUniqueOrThrow({
      where: { id },
      select: { isActive: true },
    });
    expect(row.isActive).toBe(true);

    // Leave nothing live behind for the next file.
    await prisma.paymentProviderConnection.update({
      where: { id },
      data: { isActive: false },
    });
  });

  it('still refuses a connection that has never passed a test', async () => {
    const id = await makeConnection(true);
    await prisma.paymentProviderConnection.update({
      where: { id },
      data: { lastTestStatus: null, lastTestedAt: null },
    });

    const response = await activate(id);

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('CONNECTOR_TEST_FAILED');
  });
});
