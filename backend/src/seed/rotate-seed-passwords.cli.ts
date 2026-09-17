/**
 * Give every seeded account a fresh random password.
 *
 *   npm run db:rotate-seed-passwords
 *
 * WHY THIS EXISTS
 *
 * The seed's passwords are in git, and they have to be: SETUP.md prints them,
 * and a development environment nobody can sign into is worse than one with
 * obvious credentials. That trade stops being a trade the moment the
 * installation is reachable by somebody else - a demo behind a tunnel, a
 * static host pointed at this API, a staging box with a public hostname. A
 * credential published in a repository is not a credential, and `owner@` is
 * the business owner.
 *
 * So this is the small step between "seeded and private" and README's going-live
 * step 11, which is to delete these accounts and create real ones from Staff.
 * It is not a substitute for that step. It buys the time to take it.
 *
 * WHAT IT DOES
 *
 * For every seeded account that exists and has a password, it writes a new
 * random one and revokes that account's sessions - a rotated password that
 * leaves a live refresh token behind has not locked anybody out. Accounts that
 * are not in this database are reported and skipped, so running it against an
 * installation that never seeded the carrier portal is not an error.
 *
 * The new passwords are printed ONCE and stored nowhere. Nothing here can show
 * them again: what is written to the database is an Argon2id digest.
 *
 * SAFE TO RUN REPEATEDLY, AND SAFE AFTER A RE-SEED.
 *
 * `npm run db:seed` sets `passwordHash` only when it CREATES a row - every
 * update leaves it alone - so re-seeding an existing database does not put the
 * published passwords back. Re-seeding a database these accounts were deleted
 * from does, because that is a create; rotate again afterwards.
 */
import { randomInt } from 'node:crypto';
import { isProduction } from '../config/env.js';
import { hashPassword } from '../infra/crypto.js';
import { prisma } from '../infra/prisma.js';
import { revokeAllUserSessions } from '../modules/identity/session.service.js';
import { SEED_ACCOUNTS, SEED_CUSTOMERS } from './accounts.js';
import { LOGISTICS_SEED_ACCOUNTS } from './logistics.js';

/**
 * No `l`, `I`, `1`, `O` or `0`.
 *
 * These get read aloud, typed from a screenshot and pasted into a chat
 * message, and the minutes lost to "is that a one or an ell" are worse than
 * the two bits of entropy it costs. 57 characters at length 24 is about 140
 * bits, which is far beyond anything the 12-character policy asks for.
 */
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LENGTH = 24;

/**
 * `randomInt` rather than `randomBytes` and a modulo: the modulo is biased
 * unless the range divides 256, and 57 does not. `randomInt` rejects and
 * redraws internally, so every character is uniform.
 */
function generatePassword(): string {
  let password = '';
  for (let index = 0; index < LENGTH; index += 1) {
    password += ALPHABET[randomInt(ALPHABET.length)];
  }
  return password;
}

interface SeededAccount {
  readonly surface: string;
  readonly email: string;
}

/**
 * Every seeded account that HAS a password. `invited@zenith.local` is left out
 * because its `passwordHash` is null on purpose - it exists to exercise the
 * invitation flow, and giving it a password would quietly delete the only test
 * of that path.
 */
const ACCOUNTS: readonly SeededAccount[] = [
  ...SEED_ACCOUNTS.map((account) => {
    return { surface: 'Admin console', email: account.email };
  }),
  ...SEED_CUSTOMERS.filter((customer) => {
    return customer.password !== null;
  }).map((customer) => {
    return { surface: 'Storefront', email: customer.email };
  }),
  ...LOGISTICS_SEED_ACCOUNTS.map((account) => {
    return { surface: 'Carrier portal', email: account.email };
  }),
];

interface Rotated {
  readonly surface: string;
  readonly email: string;
  readonly password: string;
  readonly sessionsRevoked: number;
}

async function main(): Promise<void> {
  if (isProduction) {
    console.log(
      '\nNODE_ENV is production. These accounts should not exist here at all -\n' +
        'README, "Going live", step 11 is to delete them and create real ones from\n' +
        'Staff. Rotating them is a stopgap, not that step.\n',
    );
  }

  const rotated: Rotated[] = [];
  const missing: string[] = [];

  for (const account of ACCOUNTS) {
    const emailNormalized = account.email.toLowerCase();
    const user = await prisma.user.findUnique({
      where: { emailNormalized },
      select: { id: true },
    });

    if (user === null) {
      missing.push(account.email);
      continue;
    }

    const password = generatePassword();
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(password) },
    });

    // A rotated password with a live refresh token behind it has locked
    // nobody out: the old session keeps refreshing itself for its full thirty
    // days without ever presenting a password again.
    const sessionsRevoked = await revokeAllUserSessions(user.id, 'password_rotated');

    rotated.push({ surface: account.surface, email: account.email, password, sessionsRevoked });
  }

  if (rotated.length === 0) {
    console.log('\nNo seeded accounts found in this database. Nothing to rotate.\n');
    return;
  }

  const emailWidth = Math.max(...rotated.map((row) => row.email.length));

  console.log('\n  NEW PASSWORDS - shown once, stored nowhere. Copy them now.\n');

  let surface = '';
  for (const row of rotated) {
    if (row.surface !== surface) {
      surface = row.surface;
      console.log(`  ${surface}`);
    }
    console.log(`    ${row.email.padEnd(emailWidth)}  ${row.password}`);
  }

  const revoked = rotated.reduce((total, row) => {
    return total + row.sessionsRevoked;
  }, 0);

  console.log(`\n  ${String(rotated.length)} accounts rotated, ${String(revoked)} sessions revoked.`);

  if (missing.length > 0) {
    console.log(`  Not in this database, skipped: ${missing.join(', ')}`);
  }

  console.log(
    '\n  SETUP.md and README still print the seeded passwords. They are now\n' +
      '  wrong for this database and right for a fresh clone, which is the\n' +
      '  intended state - do not edit them to match.\n',
  );
}

main()
  .catch((error: unknown) => {
    console.error('Rotation failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
