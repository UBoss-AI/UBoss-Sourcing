/**
 * Ordering by the pallet, end to end.
 *
 * THE ONE NUMBER THIS FILE IS ABOUT
 *
 * A buyer chooses 2 UK pallets. Each pallet holds 50 cartons. Each carton
 * holds 24 units. The basket must hold **2,400 units** - not 2 - the stock
 * check must be against 2,400, the order line must say 2,400, and the frozen
 * snapshot beside it must still say "2 pallets" so an invoice can be checked
 * against what was agreed.
 *
 * Every other test here is a way that could go wrong:
 *
 *   - the seller re-specifies the pallet while it sits in a basket
 *   - there is stock for one complete pallet and the buyer asks for two
 *   - the buyer asks for a package the seller has switched off
 *   - the buyer asks for one the seller has not finished describing
 *   - somebody else's offer id is posted
 *
 * WHY THE FIGURES ARE THESE FIGURES
 *
 * They are the worked example the feature is specified against, and 2,400 is
 * the number in the specification. If this file goes red, the first assertion
 * to read is `two pallets is 2,400 units`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { buildApp as BuildApp } from '../../src/http/app.js';
import type { prisma as PrismaClient } from '../../src/infra/prisma.js';
import type { newId as NewId } from '../../src/infra/ids.js';

let app: Awaited<ReturnType<typeof BuildApp>>;
let prisma: typeof PrismaClient;
let newId: typeof NewId;

const EMAIL = 'pallet-buyer@test.local';
const PASSWORD = 'PalletBuyer!2026';
const CATEGORY_SLUG = 'bulk-packaging-test';
const SELLER_SLUG = 'bpt-acme';

/** Per PIECE, in minor units. A pallet of 1,200 is 1,200 x this. */
const UNIT_PRICE = 500n;

const UNITS_PER_CARTON = 24;
const CARTONS_PER_LAYER = 10;
const LAYERS = 5;
const CARTONS_PER_PALLET = CARTONS_PER_LAYER * LAYERS; // 50
const UNITS_PER_PALLET = CARTONS_PER_PALLET * UNITS_PER_CARTON; // 1,200

let productId = '';
let sellerAccountId = '';
let offerId = '';
let profileId = '';
let cookieHeader = '';
let csrfToken = '';

interface CartLineBody {
  productId: string;
  quantity: number;
  sellerOfferId: string | null;
  ordering?: { unit: string; unitQuantity: number; piecesPerUnit: number };
  packaging?: {
    packageType: string;
    packageQuantity: number;
    unitsPerPackage: number;
    totalBaseUnits: number;
    totalCartons: number | null;
    totalPallets: number | null;
    unitPriceMinor: string;
    packagePriceMinor: string;
    requiresFreightQuote: boolean;
  } | null;
  issues: { code: string }[];
}

interface CartBody {
  cart?: {
    lines?: CartLineBody[];
    totals?: { subtotal?: { minor: string } };
    requiresFreightQuote?: boolean;
  };
}

function lineOf(body: string): CartLineBody | undefined {
  return (JSON.parse(body) as CartBody).cart?.lines?.[0];
}

async function emptyCart(): Promise<void> {
  await app.inject({
    method: 'DELETE',
    url: '/api/v1/cart',
    headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
  });
}

async function addPackage(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/cart/items',
    headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    payload: { productId, quantity: 1, ...payload },
  });
}

async function readCart() {
  return app.inject({ method: 'GET', url: '/api/v1/cart', headers: { cookie: cookieHeader } });
}

/**
 * Scoped to what this file made.
 *
 * Orders reference offers with ON DELETE RESTRICT, and a neighbouring file's
 * warehouse is not this file's to remove - both are ways a cleanup has broken
 * the next run's first test before.
 */
async function cleanUp(): Promise<void> {
  await prisma.cartItemPackaging.deleteMany({
    where: { cartItem: { cart: { customerProfile: { user: { emailNormalized: EMAIL } } } } },
  });
  await prisma.cartItem.deleteMany({
    where: { cart: { customerProfile: { user: { emailNormalized: EMAIL } } } },
  });
  await prisma.cart.deleteMany({
    where: { customerProfile: { user: { emailNormalized: EMAIL } } },
  });
  await prisma.sellerPackagingTier.deleteMany({
    where: { option: { sellerAccountId: { in: await sellerIds() } } },
  });
  await prisma.sellerPackagingOption.deleteMany({
    where: { sellerAccountId: { in: await sellerIds() } },
  });
  await prisma.sellerPackagingProfile.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'bpt-' } } },
  });
  await prisma.sellerAuditLog.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'bpt-' } } },
  });
  await prisma.sellerOffer.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'bpt-' } } },
  });
  await prisma.sellerAccount.deleteMany({ where: { slug: { startsWith: 'bpt-' } } });
  await prisma.productPrice.deleteMany({
    where: { product: { category: { slug: CATEGORY_SLUG } } },
  });
  await prisma.product.deleteMany({ where: { category: { slug: CATEGORY_SLUG } } });
  await prisma.category.deleteMany({ where: { slug: CATEGORY_SLUG } });
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
}

async function sellerIds(): Promise<string[]> {
  const rows = await prisma.sellerAccount.findMany({
    where: { slug: { startsWith: 'bpt-' } },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** Put the packaging back the way every test expects to find it. */
async function resetPackaging(): Promise<void> {
  await prisma.sellerPackagingOption.updateMany({
    where: { profileId, packageType: 'UK_PALLET' },
    data: {
      isEnabled: true,
      state: 'ACTIVE',
      unitsPerCarton: UNITS_PER_CARTON,
      cartonsPerLayer: CARTONS_PER_LAYER,
      layerCount: LAYERS,
      cartonsPerPallet: CARTONS_PER_PALLET,
      unitsPerPackage: UNITS_PER_PALLET,
      unitsPerPackageDerived: UNITS_PER_PALLET,
      unitsPerPackageIsOverride: false,
      minimumPackages: 1,
      packageIncrement: 1,
      maximumPackages: null,
      priceMode: 'DERIVED_FROM_UNIT',
      pricePerPackageMinor: null,
    },
  });

  await prisma.sellerOffer.update({
    where: { id: offerId },
    data: { availableQuantity: 5000 },
  });

  await emptyCart();
}

beforeAll(async () => {
  const { buildApp } = await import('../../src/http/app.js');
  ({ prisma } = await import('../../src/infra/prisma.js'));
  ({ newId } = await import('../../src/infra/ids.js'));
  const { hashPassword } = await import('../../src/infra/crypto.js');
  const { Role } = await import('../../src/domain/permissions.js');

  app = await buildApp();
  await app.ready();

  await cleanUp();

  // The cart refuses to price anything without a warehouse. Created rather
  // than assumed, because a neighbouring file wipes every location - and NOT
  // removed in cleanup, for the same reason.
  const anyLocation = await prisma.inventoryLocation.findFirst({ select: { id: true } });
  if (anyLocation === null) {
    await prisma.inventoryLocation.create({
      data: { id: newId(), code: 'BPT-MAIN', name: 'Main', isDefault: true, isActive: true },
    });
  }

  const taxClass = await prisma.taxClass.findFirst({ select: { id: true } });
  const taxClassId =
    taxClass?.id ??
    (
      await prisma.taxClass.create({
        data: {
          id: newId(),
          code: 'BPT18',
          name: 'GST 18%',
          ratePercent: '18.000000',
          isActive: true,
        },
      })
    ).id;

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Bulk packaging', slug: CATEGORY_SLUG, isActive: true },
  });

  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId,
      name: 'Nitrile gloves',
      slug: 'bpt-nitrile-gloves',
      sku: 'BPT-GLOVE-1',
      basePriceMinor: 0n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isMarketplaceProduct: true,
      // Not stock-tracked by the OPERATOR: a seller's units sit on the
      // seller's own shelf, counted by `SellerOffer.availableQuantity`.
      isStockTracked: false,
      minOrderQty: 1,
      qtyIncrement: 1,
    },
  });
  productId = product.id;

  sellerAccountId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerAccountId,
      legalName: 'BPT Acme Ltd',
      displayName: 'BPT Acme',
      displayNameNormalized: 'bpt acme',
      slug: SELLER_SLUG,
      kind: 'WHOLESALER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });

  offerId = newId();
  await prisma.sellerOffer.create({
    data: {
      id: offerId,
      sellerAccountId,
      productId,
      variantKey: '',
      sellerSku: 'BPT-ACME-GLOVE',
      status: 'ACTIVE',
      orderingUnit: 'PIECE',
      priceMinor: UNIT_PRICE,
      currency: 'INR',
      minimumOrderQuantity: 1,
      orderIncrement: 1,
      availableQuantity: 5000,
    },
  });

  profileId = newId();
  await prisma.sellerPackagingProfile.create({
    data: { id: profileId, sellerAccountId, offerId, version: 1 },
  });

  // The pallet. 24 to a carton, 10 cartons a layer, 5 layers: 1,200 units.
  await prisma.sellerPackagingOption.create({
    data: {
      id: newId(),
      profileId,
      sellerAccountId,
      packageType: 'UK_PALLET',
      isEnabled: true,
      state: 'ACTIVE',
      palletStandard: 'UK_1200_1000',
      unitsPerCarton: UNITS_PER_CARTON,
      cartonsPerLayer: CARTONS_PER_LAYER,
      layerCount: LAYERS,
      cartonsPerPallet: CARTONS_PER_PALLET,
      unitsPerPackage: UNITS_PER_PALLET,
      unitsPerPackageDerived: UNITS_PER_PALLET,
      minimumPackages: 1,
      packageIncrement: 1,
      priceMode: 'DERIVED_FROM_UNIT',
      currency: 'INR',
      grossWeightGrams: 18_000n,
      lengthMm: 1200,
      widthMm: 1000,
      heightMm: 1450,
    },
  });

  // A carton, so "a package the seller does not offer" can be tested against
  // one they DO offer rather than against nothing at all.
  await prisma.sellerPackagingOption.create({
    data: {
      id: newId(),
      profileId,
      sellerAccountId,
      packageType: 'CARTON',
      isEnabled: true,
      state: 'ACTIVE',
      unitsPerCarton: UNITS_PER_CARTON,
      unitsPerPackage: UNITS_PER_CARTON,
      unitsPerPackageDerived: UNITS_PER_CARTON,
      minimumPackages: 2,
      packageIncrement: 2,
      priceMode: 'DERIVED_FROM_UNIT',
      currency: 'INR',
    },
  });

  // A US pallet the seller has switched ON and not finished describing. The
  // difference between "not offered" and "not finished" is a different thing
  // for the buyer to be told.
  await prisma.sellerPackagingOption.create({
    data: {
      id: newId(),
      profileId,
      sellerAccountId,
      packageType: 'US_PALLET',
      isEnabled: true,
      state: 'INCOMPLETE',
      palletStandard: 'US_1219_1016',
      unitsPerCarton: UNITS_PER_CARTON,
      minimumPackages: 1,
      packageIncrement: 1,
      priceMode: 'DERIVED_FROM_UNIT',
      currency: 'INR',
      validationMessage: 'Say how many cartons sit on a layer.',
    },
  });

  const { syncMarketplacePrice } = await import(
    '../../src/modules/catalog/marketplace-price.service.js'
  );
  await syncMarketplacePrice(prisma, productId);

  const customerRole = await prisma.role.findUniqueOrThrow({
    where: { key: Role.CUSTOMER },
    select: { id: true },
  });

  const user = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email: EMAIL,
      emailNormalized: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: customerRole.id } },
    },
  });

  await prisma.customerProfile.create({
    data: { id: newId(), userId: user.id, fullName: 'Pallet Buyer', activatedAt: new Date() },
  });

  const signIn = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: EMAIL, password: PASSWORD },
  });
  expect(signIn.statusCode, signIn.body).toBe(200);

  const jar = signIn.cookies as { name: string; value: string }[];
  cookieHeader = jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  csrfToken = jar.find((cookie) => cookie.name === 'uboss_shop_csrf')?.value ?? '';
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('the worked example', () => {
  it('makes two UK pallets 2,400 units, and says so both ways', async () => {
    await resetPackaging();

    const added = await addPackage({ packageType: 'UK_PALLET', packageQuantity: 2 });
    expect(added.statusCode, added.body).toBe(201);

    const cart = await readCart();
    const line = lineOf(cart.body);

    // THE NUMBER. Base units, which is what the stock check, the price, the
    // tax line and the picking list all read.
    expect(line?.quantity).toBe(2400);

    // And the choice, recorded beside it rather than instead of it.
    expect(line?.ordering?.unit).toBe('UK_PALLET');
    expect(line?.ordering?.unitQuantity).toBe(2);
    expect(line?.ordering?.piecesPerUnit).toBe(1200);

    // And the whole chain, so an invoice can be checked by hand.
    expect(line?.packaging?.packageType).toBe('UK_PALLET');
    expect(line?.packaging?.packageQuantity).toBe(2);
    expect(line?.packaging?.unitsPerPackage).toBe(1200);
    expect(line?.packaging?.totalBaseUnits).toBe(2400);
    expect(line?.packaging?.totalPallets).toBe(2);
    expect(line?.packaging?.totalCartons).toBe(100);
  });

  it('prices the line from the package, to the paise', async () => {
    await resetPackaging();
    await addPackage({ packageType: 'UK_PALLET', packageQuantity: 2 });

    const cart = await readCart();
    const body = JSON.parse(cart.body) as CartBody;

    // 2,400 units at 500 minor units each.
    expect(body.cart?.totals?.subtotal?.minor).toBe(String(2400n * UNIT_PRICE));

    // And the unit price on the snapshot multiplies back to the package price
    // exactly - which is what the divisibility rule buys.
    const line = lineOf(cart.body);
    expect(BigInt(line?.packaging?.unitPriceMinor ?? '0') * 1200n).toBe(
      BigInt(line?.packaging?.packagePriceMinor ?? '0'),
    );
  });

  it('applies the seller step in PACKAGES, not in units', async () => {
    await resetPackaging();

    // The carton: minimum 2, in multiples of 2. Asking for 3 gets 4.
    const added = await addPackage({ packageType: 'CARTON', packageQuantity: 3 });
    expect(added.statusCode, added.body).toBe(201);

    const line = lineOf((await readCart()).body);

    expect(line?.packaging?.packageQuantity).toBe(4);
    expect(line?.quantity).toBe(4 * UNITS_PER_CARTON);
  });
});

describe('what a buyer is told when they cannot have it', () => {
  it('names the packages that ARE offered when one is not', async () => {
    await resetPackaging();

    // Switched off entirely - there is no CONTAINER row at all.
    const refused = await addPackage({ packageType: 'CONTAINER', packageQuantity: 1 });

    expect(refused.statusCode).toBe(400);

    const error = JSON.parse(refused.body) as {
      error: { code: string; details?: { meta?: Record<string, unknown> }[] };
    };

    expect(error.error.code).toBe('PACKAGING_OPTION_NOT_AVAILABLE');
    // So the storefront can say "container ordering is not configured" AND
    // show what is, rather than a bare failure.
    expect(String(error.error.details?.[0]?.meta?.available)).toContain('UK_PALLET');
  });

  it('tells a half-configured package apart from one that is not offered', async () => {
    await resetPackaging();

    const refused = await addPackage({ packageType: 'US_PALLET', packageQuantity: 1 });

    expect(refused.statusCode).toBe(400);
    // A DIFFERENT code. "This seller does not sell US pallets" is a dead end;
    // "they do and have not finished setting it up" is something they can fix
    // today.
    expect((JSON.parse(refused.body) as { error: { code: string } }).error.code).toBe(
      'PACKAGING_OPTION_INCOMPLETE',
    );
  });

  it('offers only WHOLE packages, and says how many there are', async () => {
    await resetPackaging();

    // Enough for one complete pallet and 300 spare.
    await prisma.sellerOffer.update({
      where: { id: offerId },
      data: { availableQuantity: 1500 },
    });

    const refused = await addPackage({ packageType: 'UK_PALLET', packageQuantity: 2 });

    expect(refused.statusCode).toBe(400);

    const error = JSON.parse(refused.body) as {
      error: { code: string; message: string; details?: { meta?: Record<string, unknown> }[] };
    };

    expect(error.error.code).toBe('PACKAGING_INSUFFICIENT_FOR_PACKAGE');
    // Rounded DOWN. Part of a pallet is not something a warehouse can pick.
    expect(error.error.details?.[0]?.meta?.wholePackagesAvailable).toBe(1);

    // And one IS available, so the buyer has somewhere to go.
    const ok = await addPackage({ packageType: 'UK_PALLET', packageQuantity: 1 });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it('refuses a package on a listing nobody sells in bulk', async () => {
    await resetPackaging();

    // An operator product, with no seller behind it at all.
    const operatorProduct = await prisma.product.create({
      data: {
        id: newId(),
        categoryId: (
          await prisma.category.findFirstOrThrow({ where: { slug: CATEGORY_SLUG } })
        ).id,
        taxClassId: (await prisma.taxClass.findFirstOrThrow()).id,
        name: 'Operator swab',
        slug: 'bpt-operator-swab',
        sku: 'BPT-OP-1',
        basePriceMinor: 100n,
        currency: 'INR',
        status: 'ACTIVE',
        isPublished: true,
        publishedAt: new Date(),
        isStockTracked: false,
        minOrderQty: 1,
        qtyIncrement: 1,
      },
    });

    await prisma.productPrice.create({
      data: {
        id: newId(),
        productId: operatorProduct.id,
        variantKey: '',
        currencyCode: 'INR',
        basePriceMinor: 100n,
      },
    });

    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: {
        productId: operatorProduct.id,
        quantity: 1,
        packageType: 'UK_PALLET',
        packageQuantity: 1,
      },
    });

    // Bulk packaging is a SELLER's description of their own goods. The
    // operator's catalogue has its own carton, configured elsewhere.
    expect(refused.statusCode).toBe(400);
    expect((JSON.parse(refused.body) as { error: { code: string } }).error.code).toBe(
      'PACKAGING_OPTION_NOT_AVAILABLE',
    );
  });
});

describe('the basket keeps what was agreed', () => {
  it('does not let a package and a loose quantity share one line', async () => {
    await resetPackaging();
    await addPackage({ packageType: 'UK_PALLET', packageQuantity: 1 });

    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { productId, quantity: 10 },
    });

    // Merging would leave one `piecesPerUnitSnapshot` describing one of the
    // two adds and not the line.
    expect(refused.statusCode).toBe(400);
    expect((JSON.parse(refused.body) as { error: { code: string } }).error.code).toBe(
      'PACKAGING_UNIT_MISMATCH',
    );
  });

  it('does not let two different packages share one line', async () => {
    await resetPackaging();
    await addPackage({ packageType: 'UK_PALLET', packageQuantity: 1 });

    const refused = await addPackage({ packageType: 'CARTON', packageQuantity: 2 });

    expect(refused.statusCode).toBe(400);
    expect((JSON.parse(refused.body) as { error: { code: string } }).error.code).toBe(
      'PACKAGING_UNIT_MISMATCH',
    );
  });

  it('adds the same package twice into one line', async () => {
    await resetPackaging();
    await addPackage({ packageType: 'UK_PALLET', packageQuantity: 1 });
    await addPackage({ packageType: 'UK_PALLET', packageQuantity: 1 });

    const line = lineOf((await readCart()).body);

    expect(line?.packaging?.packageQuantity).toBe(2);
    expect(line?.quantity).toBe(2400);
    // And the snapshot still adds up, which the database CHECK also enforces.
    expect(line?.packaging?.totalBaseUnits).toBe(2400);
  });

  /*
   * THE SNAPSHOT TEST.
   *
   * A seller re-specifies a pallet while it sits in somebody's basket. The
   * basket must keep what was agreed, and the buyer must be TOLD rather than
   * having the new figure applied under them.
   */
  it('keeps the agreed pallet after the seller re-specifies it, and says so', async () => {
    await resetPackaging();
    await addPackage({ packageType: 'UK_PALLET', packageQuantity: 2 });

    // The seller drops a layer: 40 cartons now, 960 units.
    await prisma.sellerPackagingOption.updateMany({
      where: { profileId, packageType: 'UK_PALLET' },
      data: {
        layerCount: 4,
        cartonsPerPallet: 40,
        unitsPerPackage: 960,
        unitsPerPackageDerived: 960,
      },
    });

    const line = lineOf((await readCart()).body);

    // UNCHANGED. What the shopper agreed to is what the basket holds.
    expect(line?.quantity).toBe(2400);
    expect(line?.packaging?.unitsPerPackage).toBe(1200);

    // And they are told the two have diverged.
    expect(line?.issues.map((issue) => issue.code)).toContain('PACKAGING_SNAPSHOT_STALE');
  });

  it('refuses to ADD more at the new size onto a line holding the old one', async () => {
    await resetPackaging();
    await addPackage({ packageType: 'UK_PALLET', packageQuantity: 1 });

    await prisma.sellerPackagingOption.updateMany({
      where: { profileId, packageType: 'UK_PALLET' },
      data: { layerCount: 4, cartonsPerPallet: 40, unitsPerPackage: 960 },
    });

    const refused = await addPackage({ packageType: 'UK_PALLET', packageQuantity: 1 });

    // One line cannot hold two different pallets with one `unitsPerPackage`
    // describing both.
    expect(refused.statusCode).toBe(409);
    expect((JSON.parse(refused.body) as { error: { code: string } }).error.code).toBe(
      'PACKAGING_SNAPSHOT_STALE',
    );
  });

  it('tells the buyer when the seller stops offering the packaging entirely', async () => {
    await resetPackaging();
    await addPackage({ packageType: 'UK_PALLET', packageQuantity: 1 });

    await prisma.sellerPackagingOption.updateMany({
      where: { profileId, packageType: 'UK_PALLET' },
      data: { isEnabled: false, state: 'DISABLED' },
    });

    const line = lineOf((await readCart()).body);

    expect(line?.issues.map((issue) => issue.code)).toContain('PACKAGING_OPTION_NOT_AVAILABLE');
  });
});

describe('freight', () => {
  it('flags a container-priced package as needing a quotation, without blocking checkout', async () => {
    await resetPackaging();

    // A pallet priced on request rather than instantly.
    await prisma.sellerPackagingOption.updateMany({
      where: { profileId, packageType: 'UK_PALLET' },
      data: { priceMode: 'FREIGHT_QUOTE', pricePerPackageMinor: null },
    });

    const added = await addPackage({ packageType: 'UK_PALLET', packageQuantity: 1 });
    expect(added.statusCode, added.body).toBe(201);

    const cart = await readCart();
    const body = JSON.parse(cart.body) as CartBody;
    const line = lineOf(cart.body);

    expect(line?.packaging?.requiresFreightQuote).toBe(true);
    expect(body.cart?.requiresFreightQuote).toBe(true);

    // The notice is on the line, and it is NOT a blocker: a container's
    // delivery genuinely is quoted rather than priced, and refusing to proceed
    // over it would make container ordering impossible.
    expect(line?.issues.map((issue) => issue.code)).toContain('FREIGHT_QUOTE_REQUIRED');
  });

  it('marks a pallet as freight even when the goods are priced instantly', async () => {
    await resetPackaging();
    await addPackage({ packageType: 'UK_PALLET', packageQuantity: 1 });

    const line = lineOf((await readCart()).body);

    // A pallet cannot go through a parcel API whatever its price mode is.
    expect(line?.packaging?.requiresFreightQuote).toBe(true);
  });

  it('leaves a carton alone, because a courier can take one', async () => {
    await resetPackaging();
    await addPackage({ packageType: 'CARTON', packageQuantity: 2 });

    const line = lineOf((await readCart()).body);

    expect(line?.packaging?.requiresFreightQuote).toBe(false);
  });
});

describe('the product page', () => {
  it('offers only the packages that are complete and switched on', async () => {
    await resetPackaging();

    const page = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/products/bpt-nitrile-gloves?currency=INR',
    });

    expect(page.statusCode, page.body).toBe(200);

    const body = JSON.parse(page.body) as {
      packagingOptions?: { packageType: string; unitsPerPackage: number }[];
    };

    const offered = (body.packagingOptions ?? []).map((option) => option.packageType);

    expect(offered).toContain('UK_PALLET');
    expect(offered).toContain('CARTON');
    // The half-configured one is held back rather than offered at a size
    // nobody has stated.
    expect(offered).not.toContain('US_PALLET');
  });

  it('publishes what a package holds and how many whole ones there are', async () => {
    await resetPackaging();

    const page = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/products/bpt-nitrile-gloves?currency=INR',
    });

    const body = JSON.parse(page.body) as {
      packagingOptions?: {
        packageType: string;
        unitsPerPackage: number;
        cartonsPerPallet: number | null;
        wholePackagesAvailable: number;
        packagePriceMinor: string;
      }[];
    };

    const pallet = (body.packagingOptions ?? []).find(
      (option) => option.packageType === 'UK_PALLET',
    );

    expect(pallet?.unitsPerPackage).toBe(1200);
    expect(pallet?.cartonsPerPallet).toBe(50);
    // 5,000 units, 1,200 to a pallet: four complete pallets.
    expect(pallet?.wholePackagesAvailable).toBe(4);
    expect(pallet?.packagePriceMinor).toBe(String(1200n * UNIT_PRICE));
  });
});
