/**
 * Rebuild the shelf every marketplace product sits on.
 *
 * A product a seller described is found and sorted in the storefront through a
 * price row projected from its live offers - see
 * `marketplace-price.service.ts`. Every offer change maintains that row inside
 * its own transaction, so it cannot drift. This is for the two cases that are
 * not an offer change:
 *
 *   - **An installation that approved listings before the projection existed.**
 *     Those products are published, offered and on sale, and appear in no
 *     category, because nothing ever wrote them a row. One run fixes them.
 *   - **Proving it.** The rebuild is idempotent, so running it on a healthy
 *     deployment costs the reads and changes nothing. That is a useful thing to
 *     be able to check after a restore or a manual database edit.
 *
 *     npm run marketplace:sync
 *
 * Safe to run while the API is serving: each product is rebuilt in its own
 * transaction, and a product being rebuilt is either on the old figures or the
 * new ones, never half of each.
 */
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { syncAllMarketplacePrices } from './marketplace-price.service.js';

async function main(): Promise<void> {
  const result = await syncAllMarketplacePrices();

  logger.info(
    { products: result.products },
    'rebuilt the catalogue shelf for every marketplace product',
  );

  // Said on stdout as well as through the logger: somebody running this by hand
  // after a restore wants an answer in the terminal, not a JSON line.
  console.log(`Rebuilt ${String(result.products)} marketplace product(s).`);
}

await main();
await prisma.$disconnect();
