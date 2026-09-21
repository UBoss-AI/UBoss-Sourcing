/**
 * Vitest global setup — runs ONCE, before the first test file.
 *
 * Its whole job is to put the reference data in the test database: the
 * currencies, the countries and the starting VAT rates.
 *
 * WHY THIS FILE EXISTS
 *
 * `prisma migrate deploy` creates the tables and nothing else. `countries` and
 * `currencies` are reference data, installed separately by `npm run db:reference`
 * — so a database that has only been migrated has **zero countries**, and the
 * first `inventoryLocation.create()` fails with:
 *
 *   Foreign key constraint violated on the fields: (`countryCode`)
 *
 * On a developer's machine that never happens, because `SETUP.md` runs the
 * reference seed once and the rows have been there ever since. On a build
 * machine the database is new every time, so the suite failed on its first CI
 * run and every one after it — 38 failures across two files, from a
 * precondition nobody had ever had to state.
 *
 * Seeding it here rather than in the workflow means a clean clone works for
 * anybody: a new developer, a build machine, a bisect on an old commit. A test
 * suite that needs a hand-run command first is a suite that will eventually be
 * run without it.
 *
 * ONCE, not per file. `setupFiles` runs before every one of the 120 files;
 * `globalSetup` runs before the first. `seedReferenceData` upserts, so running
 * it repeatedly would be correct but slow, and it is not free.
 *
 * Nothing here deletes anything. The suite's own `reset()` helpers clear the
 * business tables between files and leave reference data alone — no test
 * deletes a country or a currency, which is what makes seeding once safe.
 */
import { config as loadDotenv } from 'dotenv';

export async function setup(): Promise<void> {
  loadDotenv();

  const testUrl = process.env.TEST_DATABASE_URL;

  /*
   * The same two guards as `tests/setup.ts`, and they matter more here: this
   * file WRITES. Reaching the development database with a seed would be a
   * smaller disaster than reaching it with a truncate, but it would still be
   * this process writing to a database it was told not to touch.
   */
  if (testUrl === undefined || testUrl.length === 0) {
    throw new Error(
      'TEST_DATABASE_URL is not set. The reference-data seed refuses to run against DATABASE_URL.',
    );
  }

  if (testUrl === process.env.DATABASE_URL) {
    throw new Error(
      'TEST_DATABASE_URL and DATABASE_URL point at the same database. The suite truncates tables; ' +
        'they must target a separate one.',
    );
  }

  /*
   * Pointed at the test database only for the length of the seed, then put
   * back — and the "put back" is not tidiness.
   *
   * Vitest hands this process's environment to the worker that runs the test
   * files, and `tests/setup.ts` refuses to start when `TEST_DATABASE_URL` and
   * `DATABASE_URL` are the same string. Leaving the override in place makes
   * every file fail on that guard, which is the guard doing its job against a
   * problem this file created.
   */
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = testUrl;

  /*
   * Imported dynamically, and that is load-bearing: `infra/prisma.ts` reads
   * `DATABASE_URL` when it is first imported, and a static import is evaluated
   * before any statement in this file — including the line above.
   */
  const { seedReferenceData } = await import('../src/seed/reference-data.js');
  const { ROLE_DEFINITIONS } = await import('../src/domain/permissions.js');
  const { newId } = await import('../src/infra/ids.js');
  const { prisma } = await import('../src/infra/prisma.js');

  try {
    await seedReferenceData();

    /*
     * The roles, for the same reason and with a sharper edge.
     *
     * Six of the seventy-five integration files seed roles themselves. The
     * other sixty-nine just expect them to be there — and they were, because
     * whichever of the six ran first left them behind, and because nothing in
     * the suite ever deletes a role.
     *
     * That is an ordering dependency, and ordering is not the same everywhere:
     * on this machine `inventory-warehouses.test.ts` happened to run after a
     * file that seeds them, and on the Linux runner it did not, so it died on
     * `role.findUniqueOrThrow` before a single test in it ran.
     *
     * Seeded here, once, so no file has to care what ran before it. The six
     * that seed their own keep working — the upsert is idempotent.
     */
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

    /*
     * And then take the starter departments back out.
     *
     * `seedReferenceData` plants a starting category tree along with the
     * currencies and countries. That tree is catalogue *content* — something a
     * new installation is given so the shop is not empty on day one — not
     * reference data the suite needs, and it actively breaks the suite:
     * `Category.parentId` points at `Category`, and almost every `reset()`
     * helper in these tests clears categories with a single
     * `prisma.category.deleteMany({})`. A bulk delete on a self-referencing
     * table removes parents while children still point at them, so every one of
     * those resets fails with a foreign key violation on `parentId`.
     *
     * Two statements, children first, which is the thing a single bulk delete
     * cannot express. Done here so the database the tests meet is the one they
     * have always assumed: currencies and countries present, no categories.
     */
    await prisma.category.deleteMany({ where: { parentId: { not: null } } });
    await prisma.category.deleteMany({});
    await prisma.rateLimitBucket.deleteMany({});
  } finally {
    // The test files open their own client. Leaving this one connected holds a
    // pool open for the length of the run for no reason.
    await prisma.$disconnect();

    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
}
