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

// No VIES either. Checking a VAT number reaches a member state's own register
// through the Commission's service, which is slow, offline as often as not,
// and rude to call from a test suite. Empty means "cannot check", which is a
// supported deployment setting - every number is then unverified, and an
// unverified number is charged VAT rather than zero-rated.
process.env.VIES_CHECK_URL = '';
