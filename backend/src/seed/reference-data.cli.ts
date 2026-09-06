/**
 * Installs currency and country reference data, then backfills base-currency
 * prices for any catalogue that predates multi-currency pricing.
 *
 * Safe in production and safe to re-run: see `reference-data.ts`.
 */
import { prisma } from '../infra/prisma.js';
import { seedReferenceData } from './reference-data.js';

async function main(): Promise<void> {
  const result = await seedReferenceData();

  console.log(`Currencies installed: ${String(result.currencies)}`);
  console.log(`Countries installed:  ${String(result.countries)}`);
  console.log(`VAT rates installed:  ${String(result.vatRates)}`);
  console.log(`Prices backfilled:    ${String(result.backfilledPrices)}`);

  if (result.vatRates > 0) {
    // Loud, and on purpose. A member state changes its VAT rate with a few
    // months' notice and this file cannot know about it; invoicing at a stale
    // rate is the operator's liability, not a display bug.
    console.log('');
    console.log('  VERIFY THE VAT RATES before you invoice anything in the EU.');
    console.log('  They are a starting point, not a live feed. Check them against the');
    console.log("  Commission's published rates and correct them under Settings > VAT.");
  }
}

main()
  .catch((error: unknown) => {
    console.error('Reference data install failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
