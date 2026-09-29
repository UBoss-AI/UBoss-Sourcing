/**
 * Prisma client.
 *
 * Prisma 7 connects through a driver adapter rather than a bundled engine, so
 * the pool is a real MariaDB pool configured here. One client per process; the
 * worker gets its own.
 */
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client.js';
import { env, isProduction, isTest } from '../config/env.js';
import { logger } from './logger.js';

function connectionUrl(): string {
  if (isTest && env.TEST_DATABASE_URL !== undefined) return env.TEST_DATABASE_URL;
  return env.DATABASE_URL;
}

function createAdapter(url = connectionUrl(), poolSize = env.DB_POOL_SIZE): PrismaMariaDb {
  return new PrismaMariaDb({
    // mariadb's own pool. `connectionLimit` is the ceiling per process, so the
    // API and the worker together must stay under the server's max_connections
    // (151 on this XAMPP install).
    connectionLimit: poolSize,
    connectTimeout: env.DB_CONNECT_TIMEOUT_MS,
    acquireTimeout: env.DB_CONNECT_TIMEOUT_MS,
    // MariaDB returns BIGINT as JS BigInt with this on, which is exactly what
    // the money columns need. Without it money would silently become a Number.
    bigIntAsNumber: false,
    // The schema stores UTC instants in DATETIME(3); the server's own zone is
    // Asia/Calcutta, so pinning the session zone stops the driver applying a
    // local-time offset on the way in or out.
    timezone: 'Z',
    ...parseConnectionUrl(url),
  });
}

/**
 * The driver takes host/port/user/database separately. Parsing the URL here
 * keeps a single DATABASE_URL in the environment, matching the Prisma CLI.
 */
function parseConnectionUrl(url: string): {
  host: string;
  port: number;
  user: string;
  password: string | undefined;
  database: string;
} {
  const parsed = new URL(url);
  const database = parsed.pathname.replace(/^\//, '');

  if (database.length === 0) {
    throw new Error(`DATABASE_URL is missing a database name: ${parsed.pathname}`);
  }

  return {
    host: parsed.hostname,
    port: parsed.port.length > 0 ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: parsed.password.length > 0 ? decodeURIComponent(parsed.password) : undefined,
    database,
  };
}

export const prisma = new PrismaClient({
  adapter: createAdapter(),
  log: isProduction
    ? [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }]
    : [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
});

// Slow-query visibility without dumping parameters (they contain personal data
// and money). 200ms is the threshold worth a second look on this schema.
const SLOW_QUERY_MS = 200;

prisma.$on('query', (event) => {
  if (event.duration >= SLOW_QUERY_MS) {
    logger.warn({ durationMs: event.duration, query: event.query }, 'slow query');
  }
});

prisma.$on('warn', (event) => {
  logger.warn({ prisma: event.message }, 'prisma warning');
});

prisma.$on('error', (event) => {
  logger.error({ prisma: event.message }, 'prisma error');
});

/** Cheap liveness probe used by /health/ready. */
export async function checkDatabase(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const startedAt = process.hrtime.bigint();
  try {
    await prisma.$queryRaw`SELECT 1`;
    const latencyMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    return { ok: true, latencyMs };
  } catch (error) {
    const latencyMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    return {
      ok: false,
      latencyMs,
      error: error instanceof Error ? error.message : 'unknown database error',
    };
  }
}

let maintenanceClient: PrismaClient | null = null;

/**
 * The client for the only two changes ever made to audit rows after they are
 * written: pseudonymising the actor on a GDPR erasure, and deleting rows past
 * their retention period.
 *
 * In production the application's account cannot UPDATE or DELETE
 * `audit_logs` at all - that is what makes the trail worth trusting - so these
 * go through a second account whose grant is limited to exactly them (UPDATE
 * of actorEmail, ipAddress, userAgent and the updatedAt Prisma stamps, and
 * DELETE). Nothing else may use
 * this client. Created on first use with a pool of two: it runs a handful of
 * statements a day.
 *
 * Without DATABASE_MAINTENANCE_URL (development and tests, where one account
 * holds every grant) and in tests it is the ordinary client. Production refuses to start
 * without it (config/env.ts).
 */
export function auditMaintenancePrisma(): PrismaClient {
  // Never in tests: the suite runs against TEST_DATABASE_URL, and a maintenance
  // URL left in a developer's .env points at the development database.
  if (isTest || env.DATABASE_MAINTENANCE_URL === undefined) return prisma;

  maintenanceClient ??= new PrismaClient({
    adapter: createAdapter(env.DATABASE_MAINTENANCE_URL, 2),
    log: [{ emit: 'event', level: 'error' }],
  });

  return maintenanceClient;
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
  if (maintenanceClient !== null) await maintenanceClient.$disconnect();
}

export type PrismaClientType = typeof prisma;

/**
 * Transaction handle type. Services that must run inside a caller's transaction
 * accept this rather than the full client, so they cannot accidentally start a
 * nested transaction or commit early.
 */
export type PrismaTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
