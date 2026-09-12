/**
 * Give an unpriced catalogue something to sell at, until the real figures come.
 *
 *   cd backend
 *   npm run catalog:prices                      # dry run, the default
 *   npm run catalog:prices -- --apply
 *   npm run catalog:prices -- --apply --fallback 250
 *   npm run catalog:prices -- --list            # what is still provisional
 *
 * A catalogue imported from a supplier sheet has no prices, and a product
 * priced on request cannot be added to a basket - which means the shop cannot
 * be demonstrated, reviewed, or tested through checkout at all. This sets a
 * placeholder so every one of those paths works, and marks each one it sets so
 * the placeholders can be found again in one command.
 *
 * WHERE THE NUMBER COMES FROM
 *
 * Column M of the supplier sheet, where the sheet filled it in. That is the
 * operator's own figure rather than one invented here, and 147 of the source
 * workbook's 736 rows carry one.
 *
 * The importer itself still does not read column M, and the note in
 * `sheet-mapping.ts` saying so is still true. An MRP is a consumer retail price
 * from another market under another regulation, and importing it AS the selling
 * price - silently, as part of loading a catalogue - would put a figure in
 * front of a buyer that nobody in the business agreed to charge. Reading it
 * here is a different act: a person runs this, on purpose, knowing the result
 * is a placeholder, and every row it touches is flagged as one.
 *
 * The remaining rows get `--fallback`, one flat figure, which is deliberately
 * obvious rather than plausible.
 *
 * WHAT IT WILL NOT DO
 *
 * It never touches a product that is not flagged provisional and already has a
 * price: a figure an administrator has typed outranks anything here, and
 * re-running must not overwrite the real prices as they arrive one by one.
 */
import { formatMinorToMajor, parseMajorToMinor } from '../../../domain/money.js';
import { prisma } from '../../../infra/prisma.js';
import { mrpFromSourceRow, priceFromCell } from './price-source.js';

interface Arguments {
  apply: boolean;
  list: boolean;
  /** Minor units, for products whose sheet row carries no figure. */
  fallbackMinor: bigint;
}

function parseArguments(argv: string[], currency: string): Arguments {
  let apply = false;
  let list = false;
  // 100 of the base currency, parsed rather than written as minor units so a
  // zero-decimal currency gets 100 rather than 10,000.
  let fallbackMinor = parseMajorToMinor('100', currency);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      apply = true;
    } else if (argument === '--list') {
      list = true;
    } else if (argument === '--fallback') {
      index += 1;
      const raw = argv[index] ?? '';
      const parsed = priceFromCell(raw, currency);
      if (parsed === null) {
        throw new Error(`--fallback wants an amount like 100 or 99.50, not "${raw}".`);
      }
      fallbackMinor = parsed;
    } else {
      throw new Error(`Unknown option "${String(argument)}".`);
    }
  }

  return { apply, list, fallbackMinor };
}

async function listProvisional(): Promise<void> {
  const rows = await prisma.product.findMany({
    where: { hasProvisionalPrice: true, archivedAt: null },
    select: {
      sku: true,
      name: true,
      basePriceMinor: true,
      currency: true,
      category: { select: { name: true } },
    },
    orderBy: [{ category: { name: 'asc' } }, { name: 'asc' }],
  });

  if (rows.length === 0) {
    console.log('No product is on a provisional price.');
    return;
  }

  console.log(`${String(rows.length)} products are still on a placeholder price.`);
  console.log('');

  let currentCategory = '';
  for (const row of rows) {
    if (row.category.name !== currentCategory) {
      currentCategory = row.category.name;
      console.log(`  ${currentCategory}`);
    }
    // Formatted by the money module, which knows a yen amount has no minor
    // units. Dividing by 100 here would print every JPY price a hundred times
    // too small.
    const major = formatMinorToMajor(row.basePriceMinor, row.currency);
    console.log(`    ${major.padStart(12)} ${row.currency}  ${row.sku}  ${row.name}`);
  }

  console.log('');
  console.log('Typing a real price on any of these - in the Admin Panel or through');
  console.log('the API - clears its flag, so this list only ever shrinks.');
}

async function main(): Promise<void> {
  // Read first: the fallback amount is parsed against the base currency, and a
  // deployment selling in yen has no minor units to parse into.
  const business = await prisma.businessProfile.findFirst({ select: { currency: true } });
  const baseCurrency = business?.currency ?? 'INR';

  const options = parseArguments(process.argv.slice(2), baseCurrency);

  if (options.list) {
    await listProvisional();
    return;
  }

  /*
   * Candidates: priced on request, or priced at nothing.
   *
   * A product an administrator has already priced is not here, and a product
   * whose price this command set previously is not either - it has a real
   * figure now as far as the database is concerned, and re-running would
   * simply set it again. Only genuinely unpriced products qualify.
   */
  const candidates = await prisma.product.findMany({
    where: {
      archivedAt: null,
      OR: [{ isPriceOnRequest: true }, { basePriceMinor: 0 }],
    },
    select: {
      id: true,
      sku: true,
      name: true,
      currency: true,
      category: { select: { name: true } },
      importRecords: { take: 1, select: { rawJson: true } },
    },
    orderBy: { name: 'asc' },
  });

  const planned = candidates.map((product) => {
    const fromSheet = mrpFromSourceRow(product.importRecords[0]?.rawJson, baseCurrency);
    return {
      id: product.id,
      sku: product.sku,
      name: product.name,
      category: product.category.name,
      currency: product.currency,
      minor: fromSheet ?? options.fallbackMinor,
      source: fromSheet === null ? ('fallback' as const) : ('sheet' as const),
    };
  });

  const fromSheet = planned.filter((row) => row.source === 'sheet').length;

  console.log(options.apply ? 'Setting provisional prices.' : 'DRY RUN — nothing will be written.');
  console.log('');
  console.log(`Products with no price      ${String(candidates.length)}`);
  console.log(`  priced from the sheet     ${String(fromSheet)}`);
  console.log(`  given the fallback        ${String(planned.length - fromSheet)}`);
  console.log('');

  if (planned.length === 0) {
    console.log('Nothing to do — every product already has a price.');
    return;
  }

  if (!options.apply) {
    console.log('Examples of what would be set:');
    for (const row of planned.slice(0, 8)) {
      const major = formatMinorToMajor(row.minor, row.currency);
      console.log(`  ${major.padStart(10)} ${row.currency}  (${row.source.padEnd(8)}) ${row.name}`);
    }
    console.log('');
    console.log('Re-run with --apply to set them.');
    return;
  }

  for (const row of planned) {
    if (row.currency !== baseCurrency) {
      // A product listed in a currency this command has no figure for is left
      // alone rather than priced in the wrong one. Quoting a JPY item at an
      // INR number is the mistake `product_prices` exists to prevent.
      continue;
    }

    await prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: row.id },
        data: {
          basePriceMinor: row.minor,
          // The whole point of the run: the product becomes buyable, so Add to
          // basket, Instant Buy and Schedule all work as they do for anything
          // else in the catalogue.
          isPriceOnRequest: false,
          hasProvisionalPrice: true,
        },
      });

      // The per-currency row the storefront listing is rooted at. Created by
      // the importer at zero; this is the figure that actually reaches a grid.
      await tx.productPrice.updateMany({
        where: { productId: row.id, currencyCode: row.currency },
        data: { basePriceMinor: row.minor },
      });
    });
  }

  console.log(`Priced ${String(planned.length)} products.`);
  console.log('');
  console.log('Every one is flagged provisional. See them any time with:');
  console.log('  npm run catalog:prices -- --list');
  console.log('');
  console.log('Typing a real price on any of them clears its flag.');
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
