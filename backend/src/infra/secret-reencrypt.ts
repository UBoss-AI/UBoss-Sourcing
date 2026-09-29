/**
 * Move every stored credential onto the current vault key.
 *
 * The second half of a key rotation (see key-management.ts). While a previous
 * key is loaded, rows written under it still decrypt; this rewrites them under
 * the current key, so the previous one can be removed.
 *
 * WHICH COLUMNS
 *
 * `ENCRYPTED_COLUMNS` lists every column that holds an envelope, with the AAD
 * each row was sealed with - AES-GCM will not open an envelope without the
 * exact AAD it was bound to. `tests/unit/secret-rotation.test.ts` reads
 * schema.prisma and fails when a column ending in `Enc` or `Encrypted` is
 * missing here, so a new credential column cannot quietly be left behind on
 * the old key.
 *
 * A row may list more than one candidate AAD - a user's MFA secret is bound to
 * the surface that enrolled it - and the one that opens it is used again when
 * sealing, so the binding is kept exactly.
 *
 * SAFE TO RUN ON A LIVE SYSTEM
 *
 *   - Batches of `batchSize`, one row per UPDATE, no long transaction.
 *   - Each UPDATE is conditional on the envelope still being the one that was
 *     read, so a row a person re-saved in the meantime is left alone (it was
 *     written under the current key anyway).
 *   - Rows already under the current key are skipped. Running it twice is a
 *     no-op the second time.
 *   - A row no key opens is counted and reported, never modified.
 *
 * Plaintexts exist only in memory, one row at a time, and are never logged.
 */
import { decryptSecret, encryptSecret, isUnderCurrentKey } from './crypto.js';
import { prisma } from './prisma.js';

export interface EncryptedColumn {
  /** The Prisma model, for the completeness test. */
  model: string;
  /** The table, as `@@map` names it. */
  table: string;
  column: string;
  /** Extra columns the AAD is built from. */
  aadColumns: readonly string[];
  /** Candidate AADs for a row, most likely first. `undefined` means none. */
  aad: (row: Record<string, string>) => readonly (string | undefined)[];
}

const byId =
  (prefix: string) =>
  (row: Record<string, string>): readonly (string | undefined)[] => [`${prefix}:${row['id']}`];

export const ENCRYPTED_COLUMNS: readonly EncryptedColumn[] = [
  {
    model: 'User',
    table: 'users',
    column: 'mfaSecretEnc',
    aadColumns: [],
    // identity/mfa-core.ts (admin_mfa, customer_mfa) and logistics/mfa.service.ts.
    // seller_mfa is listed for a seller-only enrolment, should one be added.
    aad: (row) =>
      ['admin_mfa', 'customer_mfa', 'logistics_mfa', 'seller_mfa'].map(
        (scope) => `${scope}:${row['id']}`,
      ),
  },
  {
    model: 'CatalogTranslationSync',
    table: 'catalog_translation_sync',
    column: 'apiKeyEncrypted',
    aadColumns: [],
    aad: () => [undefined],
  },
  {
    model: 'PaymentProviderConnection',
    table: 'payment_provider_connections',
    column: 'credentialsEnc',
    aadColumns: [],
    aad: byId('payment_connection'),
  },
  {
    model: 'PaymentProviderConnection',
    table: 'payment_provider_connections',
    column: 'webhookSecretEnc',
    aadColumns: [],
    aad: byId('payment_connection'),
  },
  {
    model: 'IntegrationConnection',
    table: 'integration_connections',
    column: 'credentialsEnc',
    aadColumns: [],
    aad: byId('integration_connection'),
  },
  ...(['credentialsEnc', 'oauthTokenEnc', 'webhookSecretEnc'] as const).map((column) => ({
    model: 'ErpConnection',
    table: 'erp_connections',
    column,
    aadColumns: [],
    aad: byId('erp_connection'),
  })),
  {
    model: 'CustomerErpCredential',
    table: 'customer_erp_credentials',
    column: 'payloadEnc',
    aadColumns: ['connectionId', 'kind'],
    aad: (row) => [`customer_erp_credential:${row['connectionId']}:${row['kind']}`],
  },
  {
    model: 'CustomerErpOAuthState',
    table: 'customer_erp_oauth_states',
    column: 'codeVerifierEnc',
    aadColumns: [],
    aad: byId('customer_erp_oauth_state'),
  },
  ...(['credentialsEnc', 'webhookSecretEnc'] as const).map((column) => ({
    model: 'SellerCarrierCredential',
    table: 'seller_carrier_credentials',
    column,
    aadColumns: ['sellerCarrierConnectionId'],
    aad: (row: Record<string, string>) => [
      `seller_carrier_credential:${row['sellerCarrierConnectionId']}`,
    ],
  })),
  ...(['credentialsEnc', 'webhookSecretEnc'] as const).map((column) => ({
    model: 'CarrierIntegration',
    table: 'carrier_integrations',
    column,
    aadColumns: [],
    aad: byId('carrier_integration'),
  })),
];

export interface ColumnReport {
  table: string;
  column: string;
  /** Envelopes found. */
  scanned: number;
  /** Already under the current key. */
  current: number;
  /** Rewritten under the current key by this run (or that would be, on a dry run). */
  reencrypted: number;
  /** Changed by somebody else between the read and the write; left alone. */
  raced: number;
  /** No loaded key opens them. Never modified. */
  unreadable: number;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoted(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) throw new Error(`Not an identifier: ${identifier}`);
  return `\`${identifier}\``;
}

/** Re-encrypt one column. `dryRun` counts without writing. */
export async function reencryptColumn(
  spec: EncryptedColumn,
  options: { batchSize?: number; dryRun?: boolean } = {},
): Promise<ColumnReport> {
  const batchSize = options.batchSize ?? 200;
  const report: ColumnReport = {
    table: spec.table,
    column: spec.column,
    scanned: 0,
    current: 0,
    reencrypted: 0,
    raced: 0,
    unreadable: 0,
  };

  const selectColumns = ['id', spec.column, ...spec.aadColumns].map(quoted).join(', ');
  let after = '';

  for (;;) {
    const rows = await prisma.$queryRawUnsafe<Record<string, string>[]>(
      `SELECT ${selectColumns} FROM ${quoted(spec.table)} WHERE ${quoted(spec.column)} IS NOT NULL AND ${quoted('id')} > ? ORDER BY ${quoted('id')} LIMIT ${Number(batchSize)}`,
      after,
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      after = String(row['id']);
      const envelope = String(row[spec.column]);
      report.scanned += 1;

      const candidates = spec.aad(row);
      if (candidates.some((aad) => isUnderCurrentKey(envelope, aad))) {
        report.current += 1;
        continue;
      }

      let opened: { plaintext: string; aad: string | undefined } | null = null;
      for (const aad of candidates) {
        try {
          opened = { plaintext: decryptSecret(envelope, aad), aad };
          break;
        } catch {
          // Try the next candidate.
        }
      }
      if (opened === null) {
        report.unreadable += 1;
        continue;
      }

      if (options.dryRun === true) {
        report.reencrypted += 1;
        continue;
      }

      const sealed = encryptSecret(opened.plaintext, opened.aad);
      const changed = await prisma.$executeRawUnsafe(
        `UPDATE ${quoted(spec.table)} SET ${quoted(spec.column)} = ? WHERE ${quoted('id')} = ? AND ${quoted(spec.column)} = ?`,
        sealed,
        row['id'],
        envelope,
      );
      if (changed === 1) report.reencrypted += 1;
      else report.raced += 1;
    }
  }

  return report;
}

/** Every registered column, in order. */
export async function reencryptAll(
  options: { batchSize?: number; dryRun?: boolean } = {},
): Promise<ColumnReport[]> {
  const reports: ColumnReport[] = [];
  for (const spec of ENCRYPTED_COLUMNS) reports.push(await reencryptColumn(spec, options));
  return reports;
}
