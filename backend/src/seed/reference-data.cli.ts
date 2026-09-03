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
  console.log(`Prices backfilled:    ${String(result.backfilledPrices)}`);
}

main()
  .catch((error: unknown) => {
    console.error('Reference data install failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
