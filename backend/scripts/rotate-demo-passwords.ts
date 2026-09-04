/**
 * One-off: rotate the seeded development passwords.
 *
 * The seed credentials are published in the README, so they stop being safe the
 * moment the app is reachable from anywhere but localhost - an ngrok tunnel
 * shown to someone, say. This replaces them with freshly generated ones and
 * prints them once. Nothing is written to disk.
 *
 * Run from `backend/`:  npx tsx scripts/rotate-demo-passwords.ts
 */
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../src/infra/crypto.js';
import { prisma } from '../src/infra/prisma.js';

const ACCOUNTS = [
  'owner@uboss.local',
  'catalog@uboss.local',
  'inventory@uboss.local',
  'orders@uboss.local',
  'finance@uboss.local',
  'buyer@acme.local',
];

/**
 * The password policy wants 12 characters and mixed classes. base64url gives
 * upper, lower and digits but no symbol and no guaranteed digit, so one of
 * each is bolted on rather than generated and hoped for.
 */
function generate(): string {
  return `Ub!${randomBytes(15).toString('base64url')}7`;
}

async function main(): Promise<void> {
  const issued: Array<{ email: string; password: string }> = [];

  for (const email of ACCOUNTS) {
    // Uniqueness lives on emailNormalized, not email.
    const emailNormalized = email.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { emailNormalized } });

    if (user === null) {
      console.log(`skipped   ${email}  (no such user - seeded yet?)`);
      continue;
    }

    const password = generate();
    await prisma.user.update({
      where: { emailNormalized },
      data: { passwordHash: await hashPassword(password) },
    });
    issued.push({ email, password });
  }

  if (issued.length === 0) {
    console.log('\nNothing rotated.\n');
    return;
  }

  console.log('\n  Rotated. These are shown once - copy them now:\n');
  for (const { email, password } of issued) {
    console.log(`  ${email.padEnd(24)}  ${password}`);
  }
  console.log('\n  The credentials in README.md no longer work.\n');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
