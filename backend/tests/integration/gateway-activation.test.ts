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
import { availableGateways } from '../../src/modules/payments/payment.service.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let cookies: string;
let csrfToken: string;

const EMAIL = 'gateway-activation@test.local';
const PASSWORD = 'GatewayActivate!2026';

/**
 * One row per (provider, mode) is a unique constraint, so each case replaces
 * the connection for that pair rather than adding another.
 */
async function makeConnectionFor(
  provider: 'RAZORPAY' | 'STRIPE',
  mode: 'TEST' | 'LIVE',
  options: { withSecret?: boolean; isActive?: boolean } = {},
): Promise<string> {
  const { withSecret = true, isActive = false } = options;
  const id = newId();

  await prisma.paymentProviderConnection.deleteMany({ where: { provider, mode } });

  // A live key filed under TEST is refused at the connect route, and the
  // adapters read the mode off the key, so the fixture keys have to agree with
  // the mode they are stored under.
  const keyId =
    provider === 'RAZORPAY'
      ? `rzp_${mode === 'LIVE' ? 'live' : 'test'}_activation`
      : `pk_${mode === 'LIVE' ? 'live' : 'test'}_activation`;

  await prisma.paymentProviderConnection.create({
    data: {
      id,
      provider,
      mode,
      label: `activation-${id}`,
      credentialsEnc: encryptSecret(
        JSON.stringify({ keyId, keySecret: 'secret' }),
        `payment_connection:${id}`,
      ),
      credentialsMask: `${keyId.slice(0, 7)}...tion`,
      webhookSecretEnc: withSecret
        ? encryptSecret('whsec_activation', `payment_connection:${id}`)
        : null,
      // Activation also demands a passing test; granting it here isolates this
      // file to the rules it is about.
      lastTestStatus: 'OK',
      lastTestedAt: new Date(),
      isActive,
    },
  });

  return id;
}

async function makeConnection(withSecret: boolean): Promise<string> {
  return makeConnectionFor('RAZORPAY', 'TEST', { withSecret });
}

async function isActive(connectionId: string): Promise<boolean> {
  const row = await prisma.paymentProviderConnection.findUniqueOrThrow({
    where: { id: connectionId },
    select: { isActive: true },
  });

  return row.isActive;
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

/**
 * What activation is allowed to switch off, and what it must leave alone.
 *
 * Activation used to deactivate every other connection there was. The reason
 * given was that two active connections would make provider selection at
 * checkout arbitrary - true when the server picked the gateway, and no longer
 * true now that the customer does. What the rule actually did was make the
 * customer's choice unreachable: `availableGateways` offers what is active, an
 * operator could never have two gateways active at once, and so the storefront
 * only ever had one gateway to offer and hid the choice entirely. Connecting
 * Razorpay switched Stripe off, and nobody was told.
 */
describe('activating one gateway leaves the other alone', () => {
  it('keeps a different gateway in the same mode active, so checkout can offer both', async () => {
    // `availableGateways` is asserted below, and it reads every active row in
    // the database. Start from a known-quiet state so a connection left live
    // by another file cannot decide this test.
    await prisma.paymentProviderConnection.updateMany({ data: { isActive: false } });

    const stripe = await makeConnectionFor('STRIPE', 'TEST', { isActive: true });
    const razorpay = await makeConnectionFor('RAZORPAY', 'TEST');

    expect((await activate(razorpay)).statusCode).toBe(200);

    expect(await isActive(razorpay)).toBe(true);
    expect(await isActive(stripe)).toBe(true);

    // The symptom, stated where the customer meets it: both gateways are on
    // offer, which is what makes the checkout choice appear at all.
    const { gateways } = await availableGateways();
    expect(gateways.map((entry) => entry.provider).sort()).toStrictEqual(['RAZORPAY', 'STRIPE']);
  });

  it('switches off the same gateway in its other mode', async () => {
    const test = await makeConnectionFor('RAZORPAY', 'TEST', { isActive: true });
    const live = await makeConnectionFor('RAZORPAY', 'LIVE');

    expect((await activate(live)).statusCode).toBe(200);

    // `loadActiveProvider` selects by provider, so two active Razorpay rows
    // would leave it arbitrary which one takes the money.
    expect(await isActive(live)).toBe(true);
    expect(await isActive(test)).toBe(false);
  });

  it('switches off a gateway left in the other mode', async () => {
    const stripeTest = await makeConnectionFor('STRIPE', 'TEST', { isActive: true });
    const razorpayLive = await makeConnectionFor('RAZORPAY', 'LIVE');

    expect((await activate(razorpayLive)).statusCode).toBe(200);

    // Stripe LIVE beside Razorpay TEST would charge one customer real money
    // and let the next pay against a sandbox key, decided by a radio button.
    expect(await isActive(razorpayLive)).toBe(true);
    expect(await isActive(stripeTest)).toBe(false);
  });
});
