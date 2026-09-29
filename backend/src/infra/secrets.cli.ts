/**
 * Secret rotation, from the command line.
 *
 *   npm run secrets:generate           fresh values for every application secret
 *   npm run secrets:status             how old each secret is, and what is still
 *                                      stored under a previous vault key
 *   npm run secrets:reencrypt          move stored credentials onto the current key
 *   npm run secrets:reencrypt -- --dry-run
 *
 * The procedure these support - which values to move where, and in what order,
 * so nobody is signed out and nothing becomes unreadable - is in
 * docs/DEPLOYMENT.md, "Rotating secrets". This tool never writes an `.env`
 * file: where the secrets live (a file, a secret manager, a KMS) is the
 * operator's, and a tool that edited it would need to know every one of them.
 *
 * Prints fingerprints and counts. Never prints a stored credential.
 */
import { randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { keyringSummary, previousKeyFingerprints, vaultKeyFingerprint } from './crypto.js';
import { disconnectPrisma } from './prisma.js';
import { reencryptAll } from './secret-reencrypt.js';
import { reportSecretAges } from './secret-age.js';

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function generate(): void {
  out('# Fresh values. Put each where your deployment keeps its secrets.');
  out('# Rotating one? Move its CURRENT value to the matching *_PREVIOUS setting first.');
  out(`SESSION_COOKIE_SECRET=${randomBytes(48).toString('base64url')}`);
  out(`ACCESS_TOKEN_SECRET=${randomBytes(48).toString('base64url')}`);
  out(`REFRESH_TOKEN_SECRET=${randomBytes(48).toString('base64url')}`);
  out(`SECRETS_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
}

async function status(): Promise<void> {
  const ages = await reportSecretAges();
  out(`Secret ages (warning after SECRET_MAX_AGE_DAYS=${env.SECRET_MAX_AGE_DAYS}):`);
  for (const age of ages) {
    out(
      `  ${age.secret.padEnd(24)} ${String(age.ageDays).padStart(5)} days  fingerprint ${age.fingerprint}${age.overdue ? '  OVERDUE' : ''}`,
    );
  }
  const keys = keyringSummary();
  out();
  out(`Vault key provider: ${keys.provider}; current key ${vaultKeyFingerprint()}`);
  out(`Previous keys loaded: ${previousKeyFingerprints().join(', ') || 'none'}`);
  await reencrypt(true);
}

async function reencrypt(dryRun: boolean): Promise<void> {
  const reports = await reencryptAll({ dryRun });
  let left = 0;
  let unreadable = 0;
  out();
  out(dryRun ? 'Stored credentials (dry run - nothing written):' : 'Stored credentials:');
  for (const report of reports) {
    if (report.scanned === 0) continue;
    left += dryRun ? report.reencrypted : report.raced;
    unreadable += report.unreadable;
    out(
      `  ${`${report.table}.${report.column}`.padEnd(48)} ${report.scanned} stored, ${report.current} current, ` +
        `${report.reencrypted} ${dryRun ? 'need re-encrypting' : 're-encrypted'}` +
        `${report.raced > 0 ? `, ${report.raced} changed meanwhile` : ''}` +
        `${report.unreadable > 0 ? `, ${report.unreadable} UNREADABLE` : ''}`,
    );
  }
  out();
  if (unreadable > 0) {
    out(`${unreadable} envelope(s) open with no loaded key. Do not remove any previous key.`);
    process.exitCode = 2;
  } else if (left > 0) {
    out(dryRun ? `${left} envelope(s) are still under a previous key.` : 'Run again: some rows changed while this ran.');
  } else {
    out('Everything is under the current key. Previous keys can be removed.');
  }
}

async function main(): Promise<void> {
  const [command, ...flags] = process.argv.slice(2);
  switch (command) {
    case 'generate':
      generate();
      return;
    case 'status':
      await status();
      return;
    case 'reencrypt':
      await reencrypt(flags.includes('--dry-run'));
      return;
    default:
      out('Usage: secrets.cli.ts generate | status | reencrypt [--dry-run]');
      process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectPrisma();
  });
