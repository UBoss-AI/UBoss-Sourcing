/**
 * Put every seeded account back to the password this repository publishes.
 *
 *   npm run db:restore-seed-passwords
 *
 * WHY THIS EXISTS
 *
 * `db:rotate-seed-passwords` is a one-way door, and deliberately so: it prints
 * twenty-four random characters once and stores them nowhere. That is right
 * for an installation somebody else can reach, and it leaves a development
 * machine in a state nothing can recover from - because `db:seed` writes
 * `passwordHash` only when it CREATES a row. Re-seeding an existing database
 * does not put the published passwords back, so a developer who rotated once,
 * months ago, is left with a README that is confidently wrong and no way to
 * make it right short of deleting the users.
 *
 * That gap is what this closes. README and SETUP.md print nine credentials;
 * this is the command that makes them true again.
 *
 * WHAT IT DOES
 *
 * For every seeded account that exists, it writes the published password back
 * and clears everything else that would stop it working: a lockout, a
 * failed-attempt count, an unverified address, a DEACTIVATED status, a
 * must-change-password flag left behind by a temporary password. Then it
 * revokes that account's sessions, because a live refresh token belonging to
 * whoever held the rotated password outlives the password itself.
 *
 * Accounts missing from this database are reported and skipped - `db:seed`
 * creates them, and creating them here would duplicate that logic along with
 * the roles, profiles and carrier membership that go with it.
 *
 * `invited@zenith.local` is left alone on purpose. Its `passwordHash` is null
 * because it exists to exercise the invitation flow, and giving it a password
 * would quietly delete the only test of that path.
 *
 * IT REFUSES TO RUN IN PRODUCTION, which is a harder line than the warning
 * `db:rotate-seed-passwords` prints. Rotating on a live system is a stopgap in
 * the right direction. Restoring on one writes credentials that are a search
 * away for anybody who finds the repository.
 */
import { isProduction } from '../config/env.js';
import { hashPassword, verifyPassword } from '../infra/crypto.js';
import { prisma } from '../infra/prisma.js';
import { revokeAllUserSessions } from '../modules/identity/session.service.js';
import { SEED_ACCOUNTS, SEED_CUSTOMERS } from './accounts.js';
import { LOGISTICS_SEED_ACCOUNTS } from './logistics.js';

interface SeededAccount {
  readonly surface: string;
  readonly email: string;
  readonly password: string;
}

/**
 * Every seeded account that HAS a published password, in the order the three
 * sign-in surfaces appear in README.
 */
const ACCOUNTS: readonly SeededAccount[] = [
  ...SEED_ACCOUNTS.map((account) => {
    return { surface: 'Admin console', email: account.email, password: account.password };
  }),
  ...SEED_CUSTOMERS.flatMap((customer) => {
    return customer.password === null
      ? []
      : [{ surface: 'Storefront', email: customer.email, password: customer.password }];
  }),
  ...LOGISTICS_SEED_ACCOUNTS.map((account) => {
    return { surface: 'Carrier portal', email: account.email, password: account.password };
  }),
];

interface Restored {
  readonly surface: string;
  readonly email: string;
  readonly password: string;
  readonly sessionsRevoked: number;
  readonly wasAlreadyCorrect: boolean;
}

async function main(): Promise<void> {
  if (isProduction) {
    console.error(
      '\nRefused: NODE_ENV is production.\n\n' +
        'These passwords are printed in README. Writing them onto a live system\n' +
        'hands the business owner account to anybody who finds the repository.\n' +
        'If staff are locked out of a real installation, reset those accounts\n' +
        'from Staff, or run db:rotate-seed-passwords - never this.\n',
    );
    process.exitCode = 1;
    return;
  }

  const restored: Restored[] = [];
  const missing: string[] = [];

  for (const account of ACCOUNTS) {
    const emailNormalized = account.email.toLowerCase();
    const user = await prisma.user.findUnique({
      where: { emailNormalized },
      select: { id: true, passwordHash: true, status: true, lockedUntil: true },
    });

    if (user === null) {
      missing.push(account.email);
      continue;
    }

    // Reported, not acted on: it is the difference between "this command had
    // something to fix" and "the documentation was already true", and that is
    // the whole question somebody runs this to answer.
    const wasAlreadyCorrect =
      user.passwordHash !== null &&
      user.status === 'ACTIVE' &&
      user.lockedUntil === null &&
      (await verifyPassword(user.passwordHash, account.password));

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(account.password),
        // Each of these is a separate way for a documented credential to be
        // rejected. A restore that fixed only the password would leave
        // somebody typing the right one into a locked account and reading the
        // same wrong-password message.
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
        mustChangePassword: false,
        temporaryPasswordExpiresAt: null,
      },
    });

    const sessionsRevoked = await revokeAllUserSessions(user.id, 'password_restored');

    restored.push({
      surface: account.surface,
      email: account.email,
      password: account.password,
      sessionsRevoked,
      wasAlreadyCorrect,
    });
  }

  if (restored.length === 0) {
    console.log(
      '\nNo seeded accounts found in this database.\n' +
        'Run `npm run db:seed` first - that is what creates them.\n',
    );
    return;
  }

  const emailWidth = Math.max(
    ...restored.map((row) => {
      return row.email.length;
    }),
  );
  const passwordWidth = Math.max(
    ...restored.map((row) => {
      return row.password.length;
    }),
  );

  console.log('\n  These credentials now work against this database.\n');

  let surface = '';
  for (const row of restored) {
    if (row.surface !== surface) {
      surface = row.surface;
      console.log(`  ${surface}`);
    }
    const note = row.wasAlreadyCorrect ? '' : '  (was wrong, fixed)';
    console.log(`    ${row.email.padEnd(emailWidth)}  ${row.password.padEnd(passwordWidth)}${note}`);
  }

  const changed = restored.filter((row) => {
    return !row.wasAlreadyCorrect;
  }).length;
  const revoked = restored.reduce((total, row) => {
    return total + row.sessionsRevoked;
  }, 0);

  console.log(
    `\n  ${String(restored.length)} accounts restored, ${String(changed)} of them were wrong, ` +
      `${String(revoked)} sessions revoked.`,
  );

  if (missing.length > 0) {
    console.log(`  Not in this database, skipped: ${missing.join(', ')}`);
    console.log('  `npm run db:seed` creates them.');
  }

  console.log(
    '\n  One database serves every surface - localhost, a tunnel and a static\n' +
      '  host all reach the same API - so these are the credentials everywhere.\n' +
      '  Before that public URL goes to anybody else: npm run db:rotate-seed-passwords\n',
  );
}

main()
  .catch((error: unknown) => {
    console.error('Restore failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
