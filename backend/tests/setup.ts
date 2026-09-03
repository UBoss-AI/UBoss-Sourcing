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
