/**
 * Plant the demonstration catalogue.
 *
 *     npm run seed:demo-catalog
 *     npm run seed:demo-catalog -- --dry-run
 *     npm run seed:demo-catalog -- --validate
 *     npm run seed:demo-catalog -- --category=computers-it
 *     npm run seed:demo-catalog -- --subcategory=footwear
 *     npm run seed:demo-catalog -- --per-subcategory=3
 *     npm run seed:demo-catalog -- --images-only
 *     npm run seed:demo-catalog -- --no-api
 *
 * Idempotent. A second run converges on the same catalogue rather than
 * duplicating it, and - because every derived figure comes from the blueprint
 * key rather than from a random draw - it converges on the same PRICES and the
 * same STOCK too. A re-run after editing one blueprint changes one product.
 *
 * It cannot touch a product a person created. Every write is addressed through
 * `demo_catalog_entries`, so a product with no row there cannot be named by
 * this command, let alone overwritten. There is deliberately no delete mode:
 * removing the demonstration catalogue is an operator decision taken in the
 * admin panel or in SQL, not a flag on a seed.
 *
 * Refused outside development unless the operator has explicitly asked for a
 * demonstration catalogue in production by setting ENABLE_DEMO_CATALOG=true.
 * Somebody restoring a development database into production and running the
 * seeds should not find four hundred fictional products on their shop front.
 */
import { env, isProduction } from '../../../config/env.js';
import { prisma } from '../../../infra/prisma.js';
import { hasUnsplashKey } from './images.js';
import { demoCatalogCoverage, seedDemoCatalog, type SeedOptions } from './seed.js';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function value(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((argument) => argument.startsWith(prefix));
  return found?.slice(prefix.length);
}

function positiveInteger(name: string): number | undefined {
  const raw = value(name);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a whole number of 1 or more.`);
  }
  return parsed;
}

async function main(): Promise<void> {
  if (isProduction && !env.ENABLE_DEMO_CATALOG) {
    throw new Error(
      'Refusing to plant the demonstration catalogue in production.\n' +
        'If this deployment genuinely wants one, set ENABLE_DEMO_CATALOG=true and run it again.',
    );
  }

  const options: SeedOptions = {
    dryRun: flag('dry-run'),
    validateOnly: flag('validate'),
    imagesOnly: flag('images-only'),
    useApi: !flag('no-api'),
    categorySlug: value('category'),
    subcategorySlug: value('subcategory'),
    perSubcategory: positiveInteger('per-subcategory'),
  };

  const mode = options.validateOnly
    ? 'validating'
    : options.dryRun
      ? 'dry run'
      : options.imagesOnly
        ? 'refreshing photographs'
        : 'planting';

  console.log(`\n  UBOSS demonstration catalogue - ${mode}`);
  console.log(
    `  photographs: ${
      hasUnsplashKey() && options.useApi === true
        ? 'Unsplash API, falling back to the verified library'
        : 'verified library only (no UNSPLASH_ACCESS_KEY configured)'
    }\n`,
  );

  const report = await seedDemoCatalog(options);

  console.log('  products');
  console.log(`    created ............... ${String(report.created)}`);
  console.log(`    updated ............... ${String(report.updated)}`);
  console.log(`    unchanged ............. ${String(report.unchanged)}`);
  console.log(`    skipped ............... ${String(report.skipped)}`);
  console.log(`    variants written ...... ${String(report.variantsWritten)}`);

  console.log('\n  coverage');
  console.log(`    departments ........... ${String(report.categoriesCovered)}`);
  console.log(`    sub-categories ........ ${String(report.subcategoriesCovered)}`);

  console.log('\n  photographs');
  console.log(`    from the Unsplash API . ${String(report.imagesFromApi)}`);
  console.log(`    from the library ...... ${String(report.imagesFromLibrary)}`);
  console.log(`    placeholder ........... ${String(report.imagesPlaceholder)}`);
  console.log(`    needing review ........ ${String(report.imagesNeedingReview.length)}`);

  if (report.missingSubcategories.length > 0) {
    console.log('\n  sub-categories this deployment does not have (nothing was created for them):');
    for (const slug of report.missingSubcategories) console.log(`    - ${slug}`);
  }

  if (report.underCovered.length > 0) {
    console.log('\n  sub-categories below three products:');
    for (const slug of report.underCovered) console.log(`    - ${slug}`);
  }

  if (report.problems.length > 0) {
    console.log('\n  problems:');
    for (const problem of report.problems.slice(0, 25)) console.log(`    - ${problem}`);
    if (report.problems.length > 25) {
      console.log(`    ...and ${String(report.problems.length - 25)} more`);
    }
  }

  if (report.imagesNeedingReview.length > 0) {
    console.log('\n  image review report');
    console.log(
      '    These carry a stand-in photograph rather than a picture of the product.\n' +
        '    Configure UNSPLASH_ACCESS_KEY and run with --images-only to improve them,\n' +
        '    or replace them by hand in the admin panel.',
    );
    for (const key of report.imagesNeedingReview.slice(0, 20)) console.log(`    - ${key}`);
    if (report.imagesNeedingReview.length > 20) {
      console.log(`    ...and ${String(report.imagesNeedingReview.length - 20)} more`);
    }
  }

  if (!options.dryRun && !options.validateOnly) {
    const coverage = await demoCatalogCoverage();
    console.log('\n  on the shelf now');
    console.log(`    demonstration products  ${String(coverage.products)}`);
    console.log(`    active variants ....... ${String(coverage.variants)}`);
    console.log(`    sub-categories ........ ${String(coverage.subcategories)}`);
    console.log(`    departments ........... ${String(coverage.departments)}`);
  }

  console.log(
    `\n  Visible on the storefront: ${env.ENABLE_DEMO_CATALOG ? 'yes' : 'no - ENABLE_DEMO_CATALOG is false'}\n`,
  );
}

await main();
await prisma.$disconnect();
