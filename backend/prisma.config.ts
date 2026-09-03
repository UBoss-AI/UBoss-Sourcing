/**
 * Prisma 7 CLI configuration.
 *
 * Prisma 7 removed `url` from the schema's datasource block: the connection is
 * supplied here for CLI work (migrate, studio, db); the runtime client uses the
 * MariaDB driver adapter in src/infra/prisma.ts. Both read the same
 * DATABASE_URL, so the CLI and the app cannot drift onto different databases.
 *
 * `PRISMA_TARGET_TEST_DB=1` points migrate at TEST_DATABASE_URL, which is how
 * the integration-test harness prepares its own isolated database.
 */
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

function resolveDatabaseUrl(): string {
  const useTestDb = process.env.PRISMA_TARGET_TEST_DB === '1';
  const url = useTestDb ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;

  if (!url || url.length === 0) {
    throw new Error(
      useTestDb
        ? 'TEST_DATABASE_URL is not set (PRISMA_TARGET_TEST_DB=1 was requested)'
        : 'DATABASE_URL is not set. Copy .env.example to .env first.',
    );
  }
  return url;
}

/**
 * `migrate dev` diffs the schema against a throwaway database so it can compute
 * the migration without touching real data. Naming it explicitly beats letting
 * Prisma create and drop one per run, and keeps the required privileges narrow.
 */
function resolveShadowDatabaseUrl(): string {
  const explicit = process.env.SHADOW_DATABASE_URL;
  if (explicit && explicit.length > 0) return explicit;
  return resolveDatabaseUrl().replace(/\/([^/?]+)(\?|$)/, '/$1_shadow$2');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: resolveDatabaseUrl(),
    shadowDatabaseUrl: resolveShadowDatabaseUrl(),
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx src/seed/index.ts',
  },
});
