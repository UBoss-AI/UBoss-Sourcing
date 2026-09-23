/**
 * Vitest global setup.
 *
 * Runs before every test file. Its job is to guarantee that a test can never
 * reach the development database: `DATABASE_URL` is rewritten to
 * `TEST_DATABASE_URL` here, before any module that reads env is imported.
 */
import { beforeEach, expect } from 'vitest';
import { config as loadDotenv } from 'dotenv';

loadDotenv();

process.env.NODE_ENV = 'test';
// Silence pino normally; TEST_LOG_LEVEL lets a diagnostic run expose the
// server-side cause of an intentionally generic 500 response.
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';

// Never let a developer's SMTP credentials turn an integration test into a
// real outbound email (or a two-minute network timeout in a sandbox). The log
// driver records the same outbox transition without leaving the process.
process.env.EMAIL_DRIVER = 'log';
process.env.SMTP_HOST = '';
process.env.SMTP_USER = '';
process.env.SMTP_PASSWORD = '';

const testUrl = process.env.TEST_DATABASE_URL;

if (testUrl === undefined || testUrl.length === 0) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Integration tests refuse to run against DATABASE_URL.',
  );
}

if (testUrl === process.env.DATABASE_URL) {
  throw new Error(
    'TEST_DATABASE_URL and DATABASE_URL point at the same database. Tests truncate tables; ' +
      'they must target a separate one.',
  );
}

// The decisive line: every module that later reads DATABASE_URL sees the test
// database, whatever it thinks it is connecting to.
process.env.DATABASE_URL = testUrl;

// No geocoder in tests. Recording a sign-in location would otherwise make a
// live call to OpenStreetMap on every admin login in the suite: slow, flaky
// offline, and rude to a free service. Empty means "skip the lookup", which is
// a supported deployment setting - the notification then carries coordinates.
process.env.GEOCODE_REVERSE_URL = '';

// Production and fresh deployments default this privacy-sensitive feature to
// OFF. The integration suite opts in deliberately so the location gate keeps
// receiving full end-to-end coverage without making employee tracking the
// product default.
process.env.FEATURE_ADMIN_LOGIN_LOCATION = 'true';

// Production refuses to disable admin MFA. Existing integration suites focus
// on their own permission/business rule and would otherwise need to generate a
// different TOTP for every helper login; dedicated MFA tests cover that gate.
process.env.FEATURE_ADMIN_MFA = 'false';

// The same for the forward direction, which the warehouse form's "look up this
// address" button calls. Empty means "no geocoder", a supported setting: the
// endpoint answers `{ result: null }` and somebody types the coordinates.
process.env.GEOCODE_FORWARD_URL = '';

// No map background of either kind, and this one is about determinism rather
// than politeness. A developer who has pointed MAP_TILE_URL at a tile server -
// or set a Google key - in their own .env would otherwise see the warehouse
// tests disagree with CI about which provider the panel is configured for.
// All of them cleared, because Google wins over the tiles when both are set,
// and clearing only one would leave the outcome depending on the others.
// MAP_SATELLITE_URL is in the list for the same reason: it is the ground a
// MapLibre map is drawn on, so it rides along with whichever provider was
// chosen and a developer who switched imagery on would see it in every answer.
process.env.MAP_TILE_URL = '';
process.env.MAP_STYLE_URL = '';
process.env.MAP_GOOGLE_API_KEY = '';
process.env.MAP_GOOGLE_MAP_ID = '';
process.env.MAP_SATELLITE_URL = '';

/**
 * A carton of one piece, unless the test file has said otherwise.
 *
 * The shop sells cartons of 500 and the rest of this suite is about tax,
 * coupons, stock, payments and invoices - none of which care how many pieces
 * a carton holds, and all of which become unreadable if every seeded price,
 * every stock figure and every expected total is multiplied by five hundred.
 * One piece to the carton keeps those numbers the size a person can check by
 * hand, and changes nothing about the code paths they exercise: a basket line
 * still goes through `resolveOrderingQuantity` and still comes out counted in
 * cartons.
 *
 * The conversion itself is pinned where it belongs:
 *   - `tests/unit/ordering-unit.test.ts` for the arithmetic and the rounding,
 *   - `tests/integration/carton-ordering.test.ts` end to end at 500, which
 *     sets this variable itself before it loads the app.
 *
 * Assigned outright, not with `??=`, and that is a fix rather than a style
 * choice. `??=` looks like it protects a test file that wants a different size,
 * but it cannot: `setupFiles` run BEFORE the test file's own body, so
 * `carton-ordering.test.ts` sets 500 after this line and wins either way. What
 * `??=` actually protected was the developer's `.env` — and `.env.example` sets
 * `PIECES_PER_CARTON=500`, so the suite ran at 1 on a machine whose `.env`
 * omitted the key and at 500 on one that copied the example. Two machines, two
 * different answers, from a file that is not in git.
 */
process.env.PIECES_PER_CARTON = '1';

/*
 * The payment gateways, pinned to values that are obviously not real.
 *
 * Same reasoning as the map keys above, and the same bug: `payments.test.ts`
 * and `security.test.ts` sign webhook payloads with `env.RAZORPAY_WEBHOOK_SECRET`
 * and assert that `env.RAZORPAY_KEY_SECRET` never appears in stored data.
 * `.env.example` leaves all six empty, so on a machine that copied it the tests
 * signed with an empty string and asserted `not.toContain('')` - which every
 * string fails, because every string contains the empty string. They passed
 * only where the developer's own `.env` happened to carry gateway credentials.
 *
 * Set here rather than taken from `.env` so the suite tests the same thing
 * everywhere, and so a real test account's keys are never what a run depends
 * on. Nothing here reaches a provider: these sign and compare locally.
 *
 * Test-shaped on purpose. `config/env.ts` refuses an `rzp_live_`, `sk_live_` or
 * `pk_live_` key outside production, and refuses to pair a live key with a test
 * one - so a value that looked live would stop the suite at boot.
 */
process.env.RAZORPAY_KEY_ID = 'rzp_test_suite_not_a_real_key';
process.env.RAZORPAY_KEY_SECRET = 'razorpay-suite-secret-not-real';
process.env.RAZORPAY_WEBHOOK_SECRET = 'razorpay-suite-webhook-not-real';
process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_suite_not_a_real_key';
process.env.STRIPE_SECRET_KEY = 'sk_test_suite_not_a_real_key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_suite_not_a_real_secret';

/*
 * Mock payments, pinned OFF.
 *
 * Same reasoning as the keys above. A developer's `.env` may well have this on
 * - it is the only way to settle an order on a laptop - and a suite that
 * inherited it would run with every payment settleable on request, which is
 * not what the application does anywhere else. The one test file that wants it
 * turns it on for itself and puts it back.
 */
process.env.PAYMENT_MOCK_SUCCESS = 'false';

// No VIES either. Checking a VAT number reaches a member state's own register
// through the Commission's service, which is slow, offline as often as not,
// and rude to call from a test suite. Empty means "cannot check", which is a
// supported deployment setting - every number is then unverified, and an
// unverified number is charged VAT rather than zero-rated.
process.env.VIES_CHECK_URL = '';

/*
 * And no AI provider, for the same reason as the two above - which is a reason
 * this file already gives and had simply never applied here.
 *
 * `activeProvider()` picks a provider from whichever key is present, so a
 * developer with a real GEMINI_API_KEY in their `.env` had the suite calling
 * Google for real: spending quota, and timing out when the answer was slow.
 * It did exactly that - `assistant-conversations.test.ts` "never applies the
 * guest allowance to a signed-in customer" is the one assistant case that
 * reaches the provider rather than being refused before it, and it failed on
 * `Test timed out in 30000ms` while every other machine passed.
 *
 * Empty keys mean no provider, which is a supported deployment state and the
 * one CI has always run in: the routes exist, the guest allowance, the turn
 * cap and the ownership checks are all still exercised, and nothing leaves the
 * machine. Testing the providers themselves belongs in a unit test that fakes
 * the transport, not in an integration suite that reaches the internet.
 */
process.env.GEMINI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

// Test files close the shared Prisma singleton in their teardown. Reconnect it
// before clearing the database-backed limiter so each test starts clean without
// weakening or bypassing production rate limits.
beforeEach(async () => {
  if (expect.getState().testPath?.endsWith('tests/unit/s3-storage.test.ts')) return;

  const { prisma } = await import('../src/infra/prisma.js');
  await prisma.$connect();
  await prisma.rateLimitBucket.deleteMany({});
});
