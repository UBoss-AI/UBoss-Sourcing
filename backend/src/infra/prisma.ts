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

function createAdapter(): PrismaMariaDb {
  return new PrismaMariaDb({
    // mariadb's own pool. `connectionLimit` is the ceiling per process, so the
    // API and the worker together must stay under the server's max_connections
    // (151 on this XAMPP install).
    connectionLimit: env.DB_POOL_SIZE,
    connectTimeout: env.DB_CONNECT_TIMEOUT_MS,
    acquireTimeout: env.DB_CONNECT_TIMEOUT_MS,
    // MariaDB returns BIGINT as JS BigInt with this on, which is exactly what
    // the money columns need. Without it money would silently become a Number.
    bigIntAsNumber: false,
    // The schema stores UTC instants in DATETIME(3); the server's own zone is
    // Asia/Calcutta, so pinning the session zone stops the driver applying a
    // local-time offset on the way in or out.
    timezone: 'Z',
    ...parseConnectionUrl(connectionUrl()),
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

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

export type PrismaClientType = typeof prisma;

/**
 * Transaction handle type. Services that must run inside a caller's transaction
 * accept this rather than the full client, so they cannot accidentally start a
 * nested transaction or commit early.
 */
export type PrismaTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
