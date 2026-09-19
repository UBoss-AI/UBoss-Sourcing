/**
 * Two demo products for looking at the variant system in a browser.
 *
 * A safety shoe, to exercise narrowing, the three availability states and the
 * size run; and a bag of seeds, to exercise pack count versus cart quantity.
 *
 * Idempotent: re-running replaces both. `--remove` deletes them and nothing
 * else.
 */
import { signatureOfMap } from '../src/domain/variants/axis.js';
import { newId } from '../src/infra/ids.js';
import { prisma } from '../src/infra/prisma.js';

const SHOE_SLUG = 'demo-mens-industrial-safety-shoe';
const SEED_SLUG = 'demo-premium-pumpkin-seeds';

async function removeDemo(): Promise<void> {
  const products = await prisma.product.findMany({
    where: { slug: { in: [SHOE_SLUG, SEED_SLUG] } },
    select: { id: true },
  });
  const ids = products.map((row) => row.id);
  if (ids.length === 0) {
    console.log('nothing to remove');
    return;
  }

  await prisma.inventoryBalance.deleteMany({ where: { productId: { in: ids } } });
  await prisma.productPrice.deleteMany({ where: { productId: { in: ids } } });
  await prisma.cartItem.deleteMany({ where: { productId: { in: ids } } });
  await prisma.productVariant.deleteMany({ where: { productId: { in: ids } } });
  await prisma.product.deleteMany({ where: { id: { in: ids } } });
  console.log('removed', ids.length, 'demo products');
}

interface VariantSpec {
  sku: string;
  name: string;
  options: Record<string, string>;
  priceMinor: bigint;
  onHand: number;
  multipackCount?: number;
  netContentValue?: string;
  netContentUnit?: string;
  unitPricingBaseValue?: string;
  unitPricingBaseUnit?: string;
}

async function build(
  slug: string,
  categorySlug: string,
  name: string,
  sku: string,
  shortDescription: string,
  basePriceMinor: bigint,
  axisKeys: string[],
  variants: VariantSpec[],
  locationId: string,
  taxClassId: string,
): Promise<void> {
  const category = await prisma.category.findUnique({
    where: { slug: categorySlug },
    select: { id: true, isActive: true },
  });

  if (category === null) throw new Error(`category ${categorySlug} is missing — run npm run db:seed`);
  if (!category.isActive) {
    await prisma.category.update({ where: { id: category.id }, data: { isActive: true } });
  }

  const productId = newId();

  await prisma.product.create({
    data: {
      id: productId,
      categoryId: category.id,
      taxClassId,
      name,
      slug,
      sku,
      shortDescription,
      basePriceMinor,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: true,
      hasVariants: true,
      variantAxesJson: axisKeys,
      minOrderQty: 1,
      qtyIncrement: 1,
    },
  });

  await prisma.productPrice.create({
    data: { id: newId(), productId, variantKey: '', currencyCode: 'INR', basePriceMinor },
  });

  for (const [index, spec] of variants.entries()) {
    const variantId = newId();

    await prisma.productVariant.create({
      data: {
        id: variantId,
        productId,
        sku: spec.sku,
        name: spec.name,
        optionsJson: spec.options,
        optionSignature: signatureOfMap(spec.options),
        priceMinor: spec.priceMinor,
        sortOrder: index,
        isActive: true,
        ...(spec.multipackCount === undefined ? {} : { multipackCount: spec.multipackCount }),
        ...(spec.netContentValue === undefined ? {} : { netContentValue: spec.netContentValue }),
        ...(spec.netContentUnit === undefined ? {} : { netContentUnit: spec.netContentUnit }),
        ...(spec.unitPricingBaseValue === undefined
          ? {}
          : { unitPricingBaseValue: spec.unitPricingBaseValue }),
        ...(spec.unitPricingBaseUnit === undefined
          ? {}
          : { unitPricingBaseUnit: spec.unitPricingBaseUnit }),
      },
    });

    await prisma.productPrice.create({
      data: {
        id: newId(),
        productId,
        variantId,
        variantKey: variantId,
        currencyCode: 'INR',
        basePriceMinor: spec.priceMinor,
      },
    });

    await prisma.inventoryBalance.create({
      data: {
        id: newId(),
        productId,
        variantId,
        variantKey: variantId,
        locationId,
        onHandQty: spec.onHand,
        reservedQty: 0,
      },
    });
  }

  console.log(`  ${name} -> /product/${slug} (${String(variants.length)} variants)`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--remove')) {
    await removeDemo();
    await prisma.$disconnect();
    return;
  }

  await removeDemo();

  const location = await prisma.inventoryLocation.findFirst({
    where: { isDefault: true, isActive: true },
    select: { id: true },
  });
  if (location === null) throw new Error('no default warehouse — set one in Settings first');

  const taxClass = await prisma.taxClass.findFirst({
    where: { isActive: true },
    orderBy: { isDefault: 'desc' },
    select: { id: true },
  });
  if (taxClass === null) throw new Error('no active tax class');

  console.log('Creating demo products:');

  // Black runs 6-7 with 7 empty; brown runs 7-8. There is no black 8 at all,
  // which is what makes "out of stock" and "not offered" visibly different.
  await build(
    SHOE_SLUG,
    'footwear',
    "Demo — Men's Industrial Safety Shoe",
    'DEMO-SHOE',
    'Steel toe cap, oil-resistant sole. Demo product for the variant selector.',
    499_900n,
    ['size_system', 'size', 'colour'],
    [
      { sku: 'DEMO-SHOE-BLK-6', name: 'UK/India / 6 / Black', options: { size_system: 'UK/India', size: '6', colour: 'Black' }, priceMinor: 499_900n, onHand: 12 },
      { sku: 'DEMO-SHOE-BLK-7', name: 'UK/India / 7 / Black', options: { size_system: 'UK/India', size: '7', colour: 'Black' }, priceMinor: 499_900n, onHand: 0 },
      { sku: 'DEMO-SHOE-BRN-7', name: 'UK/India / 7 / Brown', options: { size_system: 'UK/India', size: '7', colour: 'Brown' }, priceMinor: 529_900n, onHand: 5 },
      { sku: 'DEMO-SHOE-BRN-8', name: 'UK/India / 8 / Brown', options: { size_system: 'UK/India', size: '8', colour: 'Brown' }, priceMinor: 549_900n, onHand: 9 },
    ],
    location.id,
    taxClass.id,
  );

  await build(
    SEED_SLUG,
    'seeds-feed-fertiliser',
    'Demo — Premium Pumpkin Seeds',
    'DEMO-SEED',
    'Demo product for pack size versus cart quantity.',
    7_500n,
    ['product_type', 'net_weight', 'pack_count'],
    [
      {
        sku: 'DEMO-SEED-RAW-500-1',
        name: 'Raw / 500 g / 1',
        options: { product_type: 'Raw', net_weight: '500 g', pack_count: '1' },
        priceMinor: 7_500n,
        onHand: 40,
        multipackCount: 1,
        netContentValue: '500',
        netContentUnit: 'g',
        unitPricingBaseValue: '1',
        unitPricingBaseUnit: 'kg',
      },
      {
        sku: 'DEMO-SEED-RAW-500-10',
        name: 'Raw / 500 g / 10',
        options: { product_type: 'Raw', net_weight: '500 g', pack_count: '10' },
        priceMinor: 62_000n,
        onHand: 15,
        multipackCount: 10,
        netContentValue: '500',
        netContentUnit: 'g',
        unitPricingBaseValue: '1',
        unitPricingBaseUnit: 'kg',
      },
      {
        sku: 'DEMO-SEED-ROA-500-10',
        name: 'Roasted / 500 g / 10',
        options: { product_type: 'Roasted', net_weight: '500 g', pack_count: '10' },
        priceMinor: 68_000n,
        onHand: 0,
        multipackCount: 10,
        netContentValue: '500',
        netContentUnit: 'g',
        unitPricingBaseValue: '1',
        unitPricingBaseUnit: 'kg',
      },
    ],
    location.id,
    taxClass.id,
  );

  await prisma.$disconnect();
}

await main();
