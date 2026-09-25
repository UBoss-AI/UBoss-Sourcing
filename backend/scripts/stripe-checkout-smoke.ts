/**
 * One real Stripe TEST-mode Checkout Session, opened and immediately expired.
 *
 *   cd backend
 *   npm run payments:stripe-smoke
 *
 * Proves Stripe's own API accepts exactly the parameters the adapter sends -
 * something the unit tests' fake cannot. Refuses to run with a live key. Prints
 * the session id, its status and the host of its page; never a key.
 */
import { env } from '../src/config/env.js';
import { StripeAdapter } from '../src/modules/payments/stripe.adapter.js';

async function main(): Promise<void> {
  if (!env.STRIPE_SECRET_KEY.startsWith('sk_test_') && !env.STRIPE_SECRET_KEY.startsWith('rk_test_')) {
    throw new Error('Refusing: STRIPE_SECRET_KEY is not a TEST key (or is empty).');
  }

  const adapter = new StripeAdapter({
    keyId: env.STRIPE_PUBLISHABLE_KEY,
    keySecret: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
  });

  const connection = await adapter.testConnection();
  console.log(`connection: ok=${String(connection.ok)} mode=${String(connection.mode)}`);
  if (!connection.ok) return;

  const customerId = await adapter.ensureVaultCustomer({
    providerCustomerId: null,
    customerEmail: 'smoke-test@example.com',
    customerName: 'Checkout Smoke Test',
    customerPhone: null,
    customerProfileId: 'SMOKE-TEST-PROFILE',
    idempotencyKey: `smoke-customer:${String(Date.now())}`,
  });

  const base = env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/$/, '');
  const session = await adapter.createCheckoutSession({
    paymentTransactionId: 'SMOKETEST00000000000000TXN',
    orderId: 'SMOKETEST00000000000000ORD',
    orderNumber: 'SMOKE-0001',
    amountMinor: 180_000n,
    currency: 'INR',
    lineItemName: 'Order SMOKE-0001',
    lineItemDescription: '2 × Test item',
    description: 'Order SMOKE-0001: 2 × Test item',
    providerCustomerId: customerId,
    customerEmail: 'smoke-test@example.com',
    offerToSaveCard: true,
    shipping: {
      name: 'Checkout Smoke Test',
      line1: '12 MG Road',
      line2: null,
      city: 'Bengaluru',
      state: 'KA',
      postalCode: '560001',
      country: 'IN',
      phone: null,
    },
    locale: 'en',
    successUrl: `${base}/checkout/payment/SMOKE/confirmation?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}/checkout/payment/SMOKE?payment=cancelled`,
    expiresAt: new Date(Date.now() + 32 * 60_000),
    idempotencyKey: `smoke-session:${String(Date.now())}`,
  });

  console.log(
    `created: ${session.sessionId} status=${session.status} amount=${String(session.amountTotal)} ` +
      `${String(session.currency)} customerMatches=${String(session.providerCustomerId === customerId)} ` +
      `page=${session.url === null ? 'none' : new URL(session.url).host}`,
  );

  const read = await adapter.retrieveCheckoutSession(session.sessionId);
  console.log(`read back: status=${read.status} paymentStatus=${read.paymentStatus}`);

  const expired = await adapter.expireCheckoutSession(session.sessionId);
  console.log(`expired: status=${expired.status}`);

  await adapter.deleteVaultCustomer(customerId);
  console.log('test customer deleted');
}

main().catch((error: unknown) => {
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
