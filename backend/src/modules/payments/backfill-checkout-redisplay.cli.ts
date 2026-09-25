/**
 * Let Stripe Checkout offer the cards customers saved before it existed here.
 *
 *   cd backend
 *   npm run payments:backfill-redisplay
 *
 * Run once, after switching Stripe payments to hosted Checkout. Customers who
 * ticked "save this card" on the old in-page form were promised it would be
 * offered next time; Stripe offers a card in Checkout only when its
 * `allow_redisplay` is 'always', and cards saved the old way carry
 * 'unspecified'. This sets it for those cards and no others.
 *
 * Only cards saved with the checkout consent. Cards enrolled for auto-pay are
 * left exactly as they are: that consent was to be charged while away, not to
 * be shown at a checkout, and the two are kept apart everywhere in this
 * codebase.
 *
 * Safe to run twice. It reads each card from Stripe first, skips one Stripe no
 * longer has, and setting 'always' again changes nothing.
 */
import { prisma } from '../../infra/prisma.js';
import { backfillCheckoutRedisplay } from './stripe-checkout.service.js';

async function main(): Promise<void> {
  const result = await backfillCheckoutRedisplay();

  console.log(
    `Cards now offered in Stripe Checkout: ${String(result.updated)}. ` +
      `Skipped (no longer at Stripe): ${String(result.skipped)}. ` +
      `Failed: ${String(result.failed)}.`,
  );

  if (result.failed > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
