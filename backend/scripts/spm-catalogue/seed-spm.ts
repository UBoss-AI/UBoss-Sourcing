/**
 * Load the SPM Medicare catalogue into the database.
 *
 * Goes through the app's own services rather than raw Prisma wherever one
 * exists — createCategory, createProduct, createVariant, publishProduct — so
 * every invariant the API enforces (slug uniqueness, SKU namespace shared with
 * variants, publication preconditions, audit trail) is enforced here too. A
 * seed that writes rows Prisma will accept but the app would have refused is a
 * seed that produces a catalogue the app cannot edit.
 *
 * Images go through the same sniff-and-store path as the upload route: the
 * declared type is ignored and the real one is read from magic bytes.
 *
 * Run: npx tsx scripts/spm-catalogue/seed-spm.ts [--apply]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '../../src/infra/prisma.js';
import { newId } from '../../src/infra/ids.js';
import { storage, sniffImageType, assertWithinSizeLimit } from '../../src/infra/storage/index.js';
import { createCategory } from '../../src/modules/catalog/category.service.js';
import { createProduct, publishProduct } from '../../src/modules/catalog/product.service.js';
import { createVariant } from '../../src/modules/catalog/variant.service.js';
import { backfillBaseCurrencyPrices } from '../../src/modules/catalog/price.service.js';
import { CATEGORIES, NOTES, PRODUCTS } from './spm-catalogue.js';

const APPLY = process.argv.includes('--apply');
const IMAGE_DIR = join(process.cwd(), '..', 'Images');
const TAX_CLASS = 'GST5';

/** Rupees (major) to paise (minor), as the string the service expects. */
const toMinor = (rupees: number): string => String(Math.round(rupees * 100));

const owner = await prisma.user.findFirst({
  where: { roles: { some: { role: { key: 'business_owner' } } }, archivedAt: null },
  select: { id: true, email: true },
});

if (owner === null) throw new Error('No active business_owner user to attribute this to.');
// Pulled out of the nullable record: `mediaIdFor` below is a hoisted function
// declaration, so TypeScript cannot carry the null check into it.
const ownerId = owner.id;
const ownerEmail = owner.email;
const actor = { userId: ownerId, email: ownerEmail, ipAddress: null, correlationId: null };

const taxClass = await prisma.taxClass.findFirst({ where: { code: TAX_CLASS, isActive: true } });
if (taxClass === null) throw new Error(`Tax class ${TAX_CLASS} is missing or inactive.`);

// --- Pre-flight -------------------------------------------------------------
const variantCount = PRODUCTS.reduce((n, p) => n + p.variants.length, 0);
const imageRefs = PRODUCTS.flatMap((p) => p.images);
const publishable = PRODUCTS.filter((p) => p.images.length > 0);

console.log(APPLY ? '=== APPLYING ===' : '=== DRY RUN (pass --apply to write) ===');
console.log(`  actor              ${ownerEmail}`);
console.log(`  tax class          ${TAX_CLASS} (${taxClass.ratePercent.toString()}%)`);
console.log(`  categories         ${String(CATEGORIES.length)}`);
console.log(`  products           ${String(PRODUCTS.length)}`);
console.log(`  variants           ${String(variantCount)}`);
console.log(`  image attachments  ${String(imageRefs.length)}`);
console.log(`  will publish       ${String(publishable.length)} (${String(PRODUCTS.length - publishable.length)} stay DRAFT — no image)`);

// Every referenced image must exist before anything is written.
const missing = [...new Set(imageRefs)].filter((name) => {
  try {
    readFileSync(join(IMAGE_DIR, `${name}.jpg`));
    return false;
  } catch {
    return true;
  }
});
if (missing.length > 0) throw new Error(`Missing images: ${missing.join(', ')}`);

// SKU collisions inside the definition itself, before the DB sees them.
const allSkus = [...PRODUCTS.map((p) => p.sku), ...PRODUCTS.flatMap((p) => p.variants.map((v) => v.sku))];
const dupes = allSkus.filter((s, i) => allSkus.indexOf(s) !== i);
if (dupes.length > 0) throw new Error(`Duplicate SKUs in the definition: ${[...new Set(dupes)].join(', ')}`);
console.log(`  distinct SKUs      ${String(new Set(allSkus).size)}`);

if (!APPLY) {
  console.log('\n=== NOTES ===');
  for (const note of NOTES) console.log(`  · ${note}`);
  await prisma.$disconnect();
  process.exit(0);
}

// --- Demo categories out of the way ----------------------------------------
// Archived, not deleted: nothing references them, but archiving is reversible
// and deleting is not. They were the old fixture data (Electrical, Apple, …).
const demoCategories = await prisma.category.findMany({
  where: { archivedAt: null },
  select: { id: true, name: true },
});
if (demoCategories.length > 0) {
  await prisma.category.updateMany({
    where: { id: { in: demoCategories.map((c) => c.id) } },
    data: { archivedAt: new Date(), isActive: false },
  });
  console.log(`\narchived ${String(demoCategories.length)} pre-existing categories: ${demoCategories.map((c) => c.name).join(', ')}`);
}

// --- Categories -------------------------------------------------------------
const categoryIds = new Map<string, string>();
for (const [index, category] of CATEGORIES.entries()) {
  const created = await createCategory(
    {
      name: category.name,
      slug: category.slug,
      description: category.description,
      sortOrder: index,
      isActive: true,
    },
    actor,
  );
  categoryIds.set(category.slug, created.id);
  console.log(`category  ${category.slug}`);
}

// --- Images -----------------------------------------------------------------
/** Uploaded once and reused: several products share the same photograph. */
const mediaCache = new Map<string, string>();

async function mediaIdFor(name: string, altText: string): Promise<string> {
  const cached = mediaCache.get(name);
  if (cached !== undefined) return cached;

  const buffer = readFileSync(join(IMAGE_DIR, `${name}.jpg`));
  assertWithinSizeLimit(buffer.byteLength);
  const sniffed = sniffImageType(buffer);
  const stored = await storage.put(buffer, sniffed.mimeType, sniffed.extension);

  const mediaId = newId();
  await prisma.mediaAsset.create({
    data: {
      id: mediaId,
      storageKey: stored.storageKey,
      url: stored.url,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      width: stored.width ?? null,
      height: stored.height ?? null,
      altText: altText.slice(0, 512),
      checksum: stored.checksum,
      uploadedById: ownerId,
    },
  });

  mediaCache.set(name, mediaId);
  return mediaId;
}

// --- Products ---------------------------------------------------------------
let published = 0;
let draft = 0;

for (const def of PRODUCTS) {
  const categoryId = categoryIds.get(def.category);
  if (categoryId === undefined) throw new Error(`Unknown category ${def.category}`);

  const product = await createProduct(
    {
      name: def.name,
      sku: def.sku,
      categoryId,
      shortDescription: def.shortDescription,
      description: def.description,
      taxClassCode: TAX_CLASS,
      basePriceMinor: toMinor(def.priceInr),
      currency: 'INR',
      // Off on purpose: no real opening stock exists, and inventing ledger
      // entries to make the storefront sellable would be fabricating data.
      isStockTracked: false,
      isRecurringEligible: def.isRecurringEligible ?? false,
      attributes: def.attributes,
    },
    actor,
  );

  for (const [index, variant] of def.variants.entries()) {
    await createVariant(
      product.id,
      {
        sku: variant.sku,
        name: variant.name,
        options: variant.options,
        ...(variant.priceInr === undefined ? {} : { priceMinor: toMinor(variant.priceInr) }),
        isActive: true,
        sortOrder: index,
      },
      actor,
    );
  }

  for (const [index, imageName] of def.images.entries()) {
    const mediaId = await mediaIdFor(imageName, def.name);
    await prisma.productMedia.create({
      data: {
        id: newId(),
        productId: product.id,
        mediaId,
        sortOrder: index,
        isPrimary: index === 0,
      },
    });
  }

  if (def.images.length > 0) {
    await publishProduct(product.id, actor);
    published += 1;
  } else {
    draft += 1;
  }

  console.log(
    `product   ${def.sku.padEnd(16)} ${String(def.variants.length).padStart(2)} variants  ${String(def.images.length)} images  ${def.images.length > 0 ? 'PUBLISHED' : 'DRAFT'}`,
  );
}

// --- Storefront prices ------------------------------------------------------
// createProduct writes the base-price mirror on `products` but not the
// per-currency ProductPrice rows the storefront reads. This is the function
// the app itself uses for exactly that.
const priceRows = await backfillBaseCurrencyPrices('INR');
console.log(`\nproduct_prices     ${String(priceRows)} INR rows written`);

// --- Report -----------------------------------------------------------------
console.log('\n=== RESULT ===');
console.log(`  products           ${String(await prisma.product.count())} (${String(published)} published, ${String(draft)} draft)`);
console.log(`  variants           ${String(await prisma.productVariant.count())}`);
console.log(`  attributes         ${String(await prisma.productAttribute.count())}`);
console.log(`  media assets       ${String(mediaCache.size)} uploaded, ${String(await prisma.productMedia.count())} attachments`);
console.log(`  categories         ${String(await prisma.category.count({ where: { archivedAt: null } }))} active`);

console.log('\n=== NOTES ===');
for (const note of NOTES) console.log(`  · ${note}`);

await prisma.$disconnect();
