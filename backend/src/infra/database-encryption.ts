/**
 * Is the database encrypted at rest? Asked of the server, at start-up.
 *
 * DATABASE_ENCRYPTION_AT_REST says what the operator configured:
 *
 *   innodb            MariaDB's own data-at-rest encryption
 *                     (deploy/mariadb/uboss-encryption.cnf). Checked here: the
 *                     API refuses to start when the server reports tables or
 *                     the redo log unencrypted, because a configuration that
 *                     says "encrypted" and a server that is not is the worst
 *                     combination - everybody believes the files are safe.
 *   provider-managed  a managed database that encrypts its storage (RDS,
 *                     Cloud SQL, Azure). Not visible from SQL, so it is
 *                     recorded as stated.
 *   unchecked         development. Production refuses it (config/env.ts).
 *
 * The answer is also exported as `uboss_database_encryption_at_rest` (1 or 0)
 * so a monitor can alert on it changing.
 */
import { Gauge } from 'prom-client';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import { registry } from './metrics.js';
import { prisma } from './prisma.js';

const encryptedGauge = new Gauge({
  name: 'uboss_database_encryption_at_rest',
  help: '1 when the database server reports InnoDB tables and redo log encrypted at rest (or it is provider-managed), else 0.',
  registers: [registry],
});

export interface DatabaseEncryptionStatus {
  /** innodb_encrypt_tables is ON or FORCE. */
  tables: boolean;
  /** innodb_encrypt_log is ON. */
  redoLog: boolean;
  /** innodb_encrypt_temporary_tables is ON. Reported, not required. */
  temporaryTables: boolean;
  /** encrypt_binlog is ON. Reported, not required - binary logs may be off. */
  binaryLog: boolean;
}

/** Read the four server variables. Needs no privilege beyond a connection. */
export async function readDatabaseEncryptionStatus(): Promise<DatabaseEncryptionStatus> {
  const rows = await prisma.$queryRawUnsafe<{ Variable_name: string; Value: string }[]>(
    "SHOW GLOBAL VARIABLES WHERE Variable_name IN ('innodb_encrypt_tables', 'innodb_encrypt_log', 'innodb_encrypt_temporary_tables', 'encrypt_binlog')",
  );
  const value = (name: string): string =>
    (rows.find((row) => row.Variable_name === name)?.Value ?? '').toUpperCase();

  return {
    tables: ['ON', 'FORCE'].includes(value('innodb_encrypt_tables')),
    redoLog: value('innodb_encrypt_log') === 'ON',
    temporaryTables: value('innodb_encrypt_temporary_tables') === 'ON',
    binaryLog: value('encrypt_binlog') === 'ON',
  };
}

export class DatabaseNotEncryptedError extends Error {
  constructor(status: DatabaseEncryptionStatus) {
    super(
      'DATABASE_ENCRYPTION_AT_REST=innodb, but the database server reports ' +
        `innodb_encrypt_tables ${status.tables ? 'on' : 'OFF'} and innodb_encrypt_log ` +
        `${status.redoLog ? 'on' : 'OFF'}. Install deploy/mariadb/uboss-encryption.cnf ` +
        '(docs/DEPLOYMENT.md, "Encryption at rest") or correct the setting.',
    );
    this.name = 'DatabaseNotEncryptedError';
  }
}

/**
 * The start-up check. Throws DatabaseNotEncryptedError when `innodb` is
 * configured and the server disagrees; otherwise records and logs the state.
 */
export async function assertDatabaseEncryptionAtRest(
  mode: typeof env.DATABASE_ENCRYPTION_AT_REST = env.DATABASE_ENCRYPTION_AT_REST,
  read: () => Promise<DatabaseEncryptionStatus> = readDatabaseEncryptionStatus,
): Promise<DatabaseEncryptionStatus | null> {
  if (mode === 'provider-managed') {
    encryptedGauge.set(1);
    logger.info('database encryption at rest: provider-managed (as configured)');
    return null;
  }

  let status: DatabaseEncryptionStatus;
  try {
    status = await read();
  } catch (error) {
    // Unable to ask is a failure only when the answer was required.
    if (mode === 'innodb') throw error;
    logger.warn({ err: error }, 'could not read the database encryption settings');
    return null;
  }
  const encrypted = status.tables && status.redoLog;
  encryptedGauge.set(encrypted ? 1 : 0);

  if (mode === 'innodb' && !encrypted) throw new DatabaseNotEncryptedError(status);

  logger.info({ databaseEncryption: status, mode }, 'database encryption at rest');
  return status;
}
