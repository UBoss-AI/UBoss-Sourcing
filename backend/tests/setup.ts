/**
 * Vitest global setup.
 *
 * Runs before every test file. Its job is to guarantee that a test can never
 * reach the development database: `DATABASE_URL` is rewritten to
 * `TEST_DATABASE_URL` here, before any module that reads env is imported.
 */
import { config as loadDotenv } from 'dotenv';

loadDotenv();

process.env.NODE_ENV = 'test';
// Silence pino; a failing assertion is the signal, not the log stream.
process.env.LOG_LEVEL = 'silent';

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

// The same for the forward direction, which the warehouse form's "look up this
// address" button calls. Empty means "no geocoder", a supported setting: the
// endpoint answers `{ result: null }` and somebody types the coordinates.
process.env.GEOCODE_FORWARD_URL = '';

// No map background of either kind, and this one is about determinism rather
// than politeness. A developer who has pointed MAP_TILE_URL at a tile server -
// or set a Google key - in their own .env would otherwise see the warehouse
// tests disagree with CI about which provider the panel is configured for.
// All three cleared, because Google wins over the tiles when both are set and
// clearing only one of them would leave the outcome depending on the other.
process.env.MAP_TILE_URL = '';
process.env.MAP_STYLE_URL = '';
process.env.MAP_GOOGLE_API_KEY = '';
process.env.MAP_GOOGLE_MAP_ID = '';

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

// No VIES either. Checking a VAT number reaches a member state's own register
// through the Commission's service, which is slow, offline as often as not,
// and rude to call from a test suite. Empty means "cannot check", which is a
// supported deployment setting - every number is then unverified, and an
// unverified number is charged VAT rather than zero-rated.
process.env.VIES_CHECK_URL = '';
