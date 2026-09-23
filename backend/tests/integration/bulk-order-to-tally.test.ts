/**
 * The whole journey, in one file: a pallet ordered, paid for, split to the
 * seller, and posted into their TallyPrime as 2,400 units.
 *
 * WHY THIS FILE EXISTS WHEN `bulk-packaging` AND `seller-erp-tally` BOTH PASS
 *
 * Because the number can be right at every step and still be wrong at the end.
 * The basket can hold 2,400, the voucher builder can be correct in isolation,
 * and the order can still post "2" because the thing joining them read the
 * package count instead of the base count. This is the test that reads the
 * figure that actually reaches the accounting system.
 *
 * THE ASSERTION TO READ FIRST if it ever goes red:
 *
 *     expect(line.baseQuantity).toBe(2400);
 *
 * It is the one the whole feature is specified against.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.FEATURE_SELLER_ERP = 'true';

import type { buildApp as BuildApp } from '../../src/http/app.js';
import type { prisma as PrismaClient } from '../../src/infra/prisma.js';
import type { newId as NewId } from '../../src/infra/ids.js';

let app: Awaited<ReturnType<typeof BuildApp>>;
let prisma: typeof PrismaClient;
let newId: typeof NewId;

const EMAIL = 'e2e-pallet@test.local';
const PASSWORD = 'E2EPallet!2026';
const CATEGORY_SLUG = 'e2e-pallet-test';
const SELLER_SLUG = 'ept-acme';

const UNIT_PRICE = 500n;
const UNITS_PER_CARTON = 24;
const CARTONS_PER_PALLET = 50;
const UNITS_PER_PALLET = UNITS_PER_CARTON * CARTONS_PER_PALLET; // 1,200

let productId = '';
let sellerAccountId = '';
let offerId = '';
let connectionId = '';
let orderId = '';
let orderGroupId = '';
let cookieHeader = '';
let csrfToken = '';

async function cleanUp(): Promise<void> {
  const sellers = await prisma.sellerAccount.findMany({
    where: { slug: { startsWith: 'ept-' } },
    select: { id: true },
  });
  const sellerIds = sellers.map((seller) => seller.id);

  if (sellerIds.length > 0) {
    await prisma.sellerErpSyncAttempt.deleteMany({
      where: { job: { sellerAccountId: { in: sellerIds } } },
    });
    await prisma.sellerErpSyncJob.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
    await prisma.sellerErpExternalReference.deleteMany({
      where: { connection: { sellerAccountId: { in: sellerIds } } },
    });
    await prisma.sellerErpAuditEvent.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
    await prisma.sellerErpMapping.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
    await prisma.sellerErpSyncPolicy.deleteMany({
      where: { connection: { sellerAccountId: { in: sellerIds } } },
    });
    await prisma.sellerErpBridgeDevice.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
    await prisma.sellerErpPairingCode.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
    await prisma.sellerErpConnection.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  }

  await prisma.sellerOrderLine.deleteMany({
    where: { orderGroup: { sellerAccount: { slug: { startsWith: 'ept-' } } } },
  });
  await prisma.sellerOrderGroup.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'ept-' } } },
  });

  await prisma.orderItemPackaging.deleteMany({
    where: { orderItem: { order: { customerProfile: { user: { emailNormalized: EMAIL } } } } },
  });
  await prisma.orderStatusHistory.deleteMany({
    where: { order: { customerProfile: { user: { emailNormalized: EMAIL } } } },
  });
  await prisma.orderItem.deleteMany({
    where: { order: { customerProfile: { user: { emailNormalized: EMAIL } } } },
  });
  await prisma.order.deleteMany({
    where: { customerProfile: { user: { emailNormalized: EMAIL } } },
  });

  await prisma.cartItemPackaging.deleteMany({
    where: { cartItem: { cart: { customerProfile: { user: { emailNormalized: EMAIL } } } } },
  });
  await prisma.cartItem.deleteMany({
    where: { cart: { customerProfile: { user: { emailNormalized: EMAIL } } } },
  });
  await prisma.cart.deleteMany({
    where: { customerProfile: { user: { emailNormalized: EMAIL } } },
  });

  if (sellerIds.length > 0) {
    await prisma.sellerPackagingTier.deleteMany({
      where: { option: { sellerAccountId: { in: sellerIds } } },
    });
    await prisma.sellerPackagingOption.deleteMany({
      where: { sellerAccountId: { in: sellerIds } },
    });
    await prisma.sellerPackagingProfile.deleteMany({
      where: { sellerAccountId: { in: sellerIds } },
    });
    await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
    await prisma.sellerOffer.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
    await prisma.sellerAccount.deleteMany({ where: { id: { in: sellerIds } } });
  }

  await prisma.address.deleteMany({
    where: { customerProfile: { user: { emailNormalized: EMAIL } } },
  });
  await prisma.productPrice.deleteMany({
    where: { product: { category: { slug: CATEGORY_SLUG } } },
  });
  await prisma.product.deleteMany({ where: { category: { slug: CATEGORY_SLUG } } });
  await prisma.category.deleteMany({ where: { slug: CATEGORY_SLUG } });
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
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

  const anyLocation = await prisma.inventoryLocation.findFirst({ select: { id: true } });
  if (anyLocation === null) {
    await prisma.inventoryLocation.create({
      data: { id: newId(), code: 'EPT-MAIN', name: 'Main', isDefault: true, isActive: true },
    });
  }

  const taxClass = await prisma.taxClass.findFirst({ select: { id: true } });
  const taxClassId =
    taxClass?.id ??
    (
      await prisma.taxClass.create({
        data: {
          id: newId(),
          code: 'EPT18',
          name: 'GST 18%',
          ratePercent: '18.000000',
          isActive: true,
        },
      })
    ).id;

  const category = await prisma.category.create({
    data: { id: newId(), name: 'E2E pallets', slug: CATEGORY_SLUG, isActive: true },
  });

  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId,
      name: 'Examination gloves',
      slug: 'ept-exam-gloves',
      sku: 'EPT-GLOVE-1',
      basePriceMinor: 0n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isMarketplaceProduct: true,
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
      legalName: 'EPT Acme Ltd',
      displayName: 'EPT Acme',
      displayNameNormalized: 'ept acme',
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
      sellerSku: 'EPT-ACME-GLOVE',
      status: 'ACTIVE',
      orderingUnit: 'PIECE',
      priceMinor: UNIT_PRICE,
      currency: 'INR',
      minimumOrderQuantity: 1,
      orderIncrement: 1,
      availableQuantity: 10_000,
    },
  });

  const profileId = newId();
  await prisma.sellerPackagingProfile.create({
    data: { id: profileId, sellerAccountId, offerId, version: 3 },
  });

  await prisma.sellerPackagingOption.create({
    data: {
      id: newId(),
      profileId,
      sellerAccountId,
      packageType: 'UK_PALLET',
      isEnabled: true,
      state: 'ACTIVE',
      palletStandard: 'UK_1200_1000',
      packageSku: 'PLT-GLOVE-UK',
      incoterm: 'DAP',
      unitsPerCarton: UNITS_PER_CARTON,
      cartonsPerLayer: 10,
      layerCount: 5,
      cartonsPerPallet: CARTONS_PER_PALLET,
      unitsPerPackage: UNITS_PER_PALLET,
      unitsPerPackageDerived: UNITS_PER_PALLET,
      minimumPackages: 1,
      packageIncrement: 1,
      priceMode: 'DERIVED_FROM_UNIT',
      currency: 'INR',
      grossWeightGrams: 18_000n,
    },
  });

  const { syncMarketplacePrice } = await import(
    '../../src/modules/catalog/marketplace-price.service.js'
  );
  await syncMarketplacePrice(prisma, productId);

  // --- The seller's Tally connection, complete and mapped -------------------

  connectionId = newId();
  await prisma.sellerErpConnection.create({
    data: {
      id: connectionId,
      sellerAccountId,
      name: 'Books',
      networkMode: 'BRIDGE',
      state: 'CONNECTED',
      companyName: 'Acme Medical',
      lastTestOk: true,
      lastTestAt: new Date(),
      mappingCompleteAt: new Date(),
    },
  });

  await prisma.sellerErpSyncPolicy.create({
    data: {
      id: newId(),
      connectionId,
      postSalesOrder: true,
      postSalesInvoice: true,
      includePackagingNarration: true,
    },
  });

  const mapping = (entity: string, localKey: string, tallyName: string) => ({
    id: newId(),
    sellerAccountId,
    connectionId,
    entity: entity as never,
    localKey,
    tallyName,
    isConfirmed: true,
  });

  await prisma.sellerErpMapping.createMany({
    data: [
      mapping('SALES_ORDER_VOUCHER_TYPE', '', 'Sales Order'),
      mapping('SALES_INVOICE_VOUCHER_TYPE', '', 'Sales'),
      mapping('SALES_LEDGER', '', 'Sales - Marketplace'),
      mapping('STOCK_ITEM', offerId, 'Examination Gloves L'),
      mapping('UNIT', offerId, 'Nos'),
    ],
  });

  // --- The buyer ------------------------------------------------------------

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

  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId: user.id, fullName: 'Pallet Buyer', activatedAt: new Date() },
  });

  /*
   * The buyer's party ledger, keyed on their profile id.
   *
   * Created here rather than with the other mappings above because it needs
   * the profile to exist first - and it is the mapping a seller genuinely has
   * to make per buyer, which is why the voucher builder refuses without it
   * rather than inventing a ledger name from the buyer's own name.
   */
  await prisma.sellerErpMapping.create({
    data: {
      id: newId(),
      sellerAccountId,
      connectionId,
      entity: 'PARTY_LEDGER',
      localKey: profile.id,
      localLabel: 'Pallet Buyer',
      tallyName: 'Acme Hospitals',
      isConfirmed: true,
    },
  });

  await prisma.address.create({
    data: {
      id: newId(),
      customerProfileId: profile.id,
      kind: 'BOTH',
      contactName: 'Pallet Buyer',
      contactPhone: '+91 90000 00001',
      line1: '1 Dock Road',
      city: 'Mumbai',
      state: 'MH',
      postalCode: '400001',
      country: 'IN',
      isDefaultBilling: true,
      isDefaultShipping: true,
    },
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

describe('a pallet ordered, paid for, and posted', () => {
  it('puts 2,400 units in the basket from a choice of 2 pallets', async () => {
    const added = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { productId, quantity: 1, packageType: 'UK_PALLET', packageQuantity: 2 },
    });

    expect(added.statusCode, added.body).toBe(201);

    const cart = await app.inject({
      method: 'GET',
      url: '/api/v1/cart',
      headers: { cookie: cookieHeader },
    });

    const line = (
      JSON.parse(cart.body) as { cart: { lines: { quantity: number }[] } }
    ).cart.lines[0];

    expect(line?.quantity).toBe(2400);
  });

  it('freezes the breakdown onto the order line at checkout', async () => {
    const { submitCheckout } = await import('../../src/modules/orders/order.service.js');

    const address = await prisma.address.findFirstOrThrow({
      where: { customerProfile: { user: { emailNormalized: EMAIL } } },
    });

    const profile = await prisma.customerProfile.findFirstOrThrow({
      where: { user: { emailNormalized: EMAIL } },
    });

    /*
     * Through the service rather than the HTTP route.
     *
     * The route is exercised by `checkout.test.ts`; what this file is about is
     * the line the checkout WRITES, and going straight to the service keeps
     * the test about that rather than about session cookies and payment modes.
     */
    const placed = await submitCheckout({
      customerProfileId: profile.id,
      shippingAddressId: address.id,
      paymentMode: 'ONLINE',
      actor: { type: 'CUSTOMER', userId: null, email: EMAIL },
    });

    orderId = placed.orderId;

    const item = await prisma.orderItem.findFirstOrThrow({
      where: { orderId },
      include: { packaging: true },
    });

    // Base units on the line, as always.
    expect(item.quantity).toBe(2400);
    expect(item.orderingUnit).toBe('UK_PALLET');
    expect(item.unitQuantity).toBe(2);
    expect(item.piecesPerUnitSnapshot).toBe(1200);

    // And the immutable breakdown beside it.
    expect(item.packaging?.packageType).toBe('UK_PALLET');
    expect(item.packaging?.packageQuantity).toBe(2);
    expect(item.packaging?.unitsPerPackage).toBe(1200);
    expect(item.packaging?.totalBaseUnits).toBe(2400);
    expect(item.packaging?.cartonsPerPallet).toBe(50);
    // The profile version it was bought under, so "which configuration was
    // this?" has an answer months later.
    expect(item.packaging?.profileVersion).toBe(3);

    // Three fields the basket never carried, frozen here because a picking
    // list, a commercial invoice and a customs declaration all need them.
    expect(item.packaging?.packageSkuSnapshot).toBe('PLT-GLOVE-UK');
    expect(item.packaging?.incotermSnapshot).toBe('DAP');
  });

  it('survives the seller re-specifying the pallet afterwards', async () => {
    // The seller changes their pallet entirely.
    await prisma.sellerPackagingOption.updateMany({
      where: { sellerAccountId, packageType: 'UK_PALLET' },
      data: { layerCount: 4, cartonsPerPallet: 40, unitsPerPackage: 960 },
    });

    const item = await prisma.orderItem.findFirstOrThrow({
      where: { orderId },
      include: { packaging: true },
    });

    // The ORDER is unchanged. An invoice from last month still describes the
    // pallet that was actually bought.
    expect(item.quantity).toBe(2400);
    expect(item.packaging?.unitsPerPackage).toBe(1200);
    expect(item.packaging?.cartonsPerPallet).toBe(50);
  });

  it('splits to the seller and queues an accounting event', async () => {
    const { transitionOrder } = await import('../../src/modules/orders/order.service.js');

    // Confirmation is what splits the order to its sellers and what queues the
    // Sales Order - both inside one transaction, so a confirmed order cannot
    // leave its seller unaware of it.
    await transitionOrder({
      orderId,
      to: 'CONFIRMED',
      actor: { type: 'SYSTEM', userId: null, email: null },
      reason: 'test',
    });

    const group = await prisma.sellerOrderGroup.findFirstOrThrow({
      where: { orderId, sellerAccountId },
    });
    orderGroupId = group.id;

    const job = await prisma.sellerErpSyncJob.findFirstOrThrow({
      where: { connectionId, sellerOrderGroupId: orderGroupId, eventType: 'SALES_ORDER' },
    });

    expect(job.status).toBe('PENDING');
    // Everything about one buyer order stays in order behind one key.
    expect(job.sequenceKey).toBe(orderId);
  });

  /*
   * THE ONE THIS FILE IS FOR.
   *
   * The voucher that actually reaches the seller's accounting system carries
   * 2,400 - the units that leave the warehouse - and not 2.
   */
  it('builds a voucher carrying 2,400 base units, not 2 pallets', async () => {
    const { buildOrderVoucher } = await import(
      '../../src/modules/seller-erp/payload.service.js'
    );

    const payload = await buildOrderVoucher({
      connectionId,
      sellerOrderGroupId: orderGroupId,
      voucherKind: 'SALES_ORDER',
    });

    const line = payload.lines[0];

    // THE ASSERTION.
    expect(line?.baseQuantity).toBe(2400);
    expect(line?.baseUnitName).toBe('Nos');
    // No alternate unit, because the seller has not mapped one - which is the
    // default and the safe one.
    expect(line?.alternateUnit).toBeNull();

    // The packaging is not discarded to get there. It is on the line, so an
    // accountant can check the 2,400 rather than having to trust it.
    expect(line?.packagingDescription).toContain('2 UK pallets');
    expect(line?.packagingDescription).toContain('50 cartons');
    expect(line?.packagingDescription).toContain('24 units');
    expect(line?.packagingDescription).toContain('2,400 units');

    // And structurally, so a reconciliation can compare figures rather than
    // parse a sentence.
    expect(line?.packaging?.totalBaseUnits).toBe(2400);
    expect(line?.packaging?.totalCartons).toBe(100);
    expect(line?.packaging?.totalPallets).toBe(2);

    // The whole consignment, for the narration and for freight.
    expect(payload.packagingSummary?.totalPallets).toBe(2);
    expect(payload.packagingSummary?.totalBaseUnits).toBe(2400);
    expect(payload.narration).toContain('2 UK pallets');

    // A Sales Order is not an invoice. Posting it as one would recognise
    // revenue on the day somebody pressed "buy".
    expect(payload.isInvoice).toBe(false);
    expect(payload.ledgerEntries).toHaveLength(0);
  });

  it('renders that voucher as XML carrying the same figure', async () => {
    const { buildOrderVoucher } = await import(
      '../../src/modules/seller-erp/payload.service.js'
    );
    const { voucher, importRequest } = await import(
      '../../src/modules/seller-erp/tally/requests.js'
    );
    const { parseXml, textOf } = await import('../../src/modules/seller-erp/tally/xml.js');

    const payload = await buildOrderVoucher({
      connectionId,
      sellerOrderGroupId: orderGroupId,
      voucherKind: 'SALES_ORDER',
    });

    const xml = importRequest({
      companyName: payload.companyName,
      reportName: 'Vouchers',
      messages: voucher({
        voucherTypeName: payload.voucherTypeName,
        remoteId: payload.remoteId,
        voucherNumber: payload.voucherNumber,
        date: new Date(payload.date),
        partyLedgerName: payload.partyLedgerName,
        reference: payload.reference,
        narration: payload.narration,
        isInvoice: payload.isInvoice,
        ledgerEntries: [],
        lines: payload.lines.map((line) => ({
          stockItemName: line.stockItemName,
          baseQuantity: line.baseQuantity,
          baseUnitName: line.baseUnitName,
          alternateUnit: line.alternateUnit,
          amountMinor: BigInt(line.amountMinor),
          rateMinor: BigInt(line.rateMinor),
          currencyExponent: payload.currencyExponent,
          godownName: line.godownName,
          batchName: line.batchName,
          salesLedgerName: line.salesLedgerName,
          packagingDescription: line.packagingDescription,
        })),
      }),
    });

    // The figure Tally actually receives.
    expect(xml).toContain('<ACTUALQTY>2400 Nos</ACTUALQTY>');
    expect(xml).not.toContain('>2 Nos<');

    // And it is well-formed, which the parser proves by reading it back.
    expect(textOf(parseXml(xml), 'SVCURRENTCOMPANY')).toBe('Acme Medical');
  });

  it('refuses to build a voucher when a mapping it needs is missing', async () => {
    const { buildOrderVoucher } = await import(
      '../../src/modules/seller-erp/payload.service.js'
    );

    await prisma.sellerErpMapping.deleteMany({
      where: { connectionId, entity: 'STOCK_ITEM' },
    });

    // Refused, and it names what is missing - never substituted with a guess.
    // Posting a quarter of somebody's revenue against a ledger called "Sales"
    // because it happened to exist is the failure this prevents.
    await expect(
      buildOrderVoucher({
        connectionId,
        sellerOrderGroupId: orderGroupId,
        voucherKind: 'SALES_ORDER',
      }),
    ).rejects.toThrow();

    // Put it back for anything that runs after this.
    await prisma.sellerErpMapping.create({
      data: {
        id: newId(),
        sellerAccountId,
        connectionId,
        entity: 'STOCK_ITEM',
        localKey: offerId,
        tallyName: 'Examination Gloves L',
        isConfirmed: true,
      },
    });
  });

  it('refuses a compound unit whose factor disagrees with the packaging', async () => {
    const { buildOrderVoucher } = await import(
      '../../src/modules/seller-erp/payload.service.js'
    );

    // The seller maps "PLT of 1000 PCS" against packaging that says 1,200.
    await prisma.sellerErpMapping.create({
      data: {
        id: newId(),
        sellerAccountId,
        connectionId,
        entity: 'ALTERNATE_UNIT',
        localKey: offerId,
        tallyName: 'PLT',
        alternateUnitName: 'PLT',
        conversionFactor: '1000',
        isConfirmed: true,
      },
    });

    // Refused rather than resolved: posting 1,000 to a pallet when the order
    // holds 1,200 makes the seller's stock wrong by 200 a pallet, and picking
    // either figure silently is worse than saying so.
    await expect(
      buildOrderVoucher({
        connectionId,
        sellerOrderGroupId: orderGroupId,
        voucherKind: 'SALES_ORDER',
      }),
    ).rejects.toThrow(/1000|1200/);

    await prisma.sellerErpMapping.deleteMany({
      where: { connectionId, entity: 'ALTERNATE_UNIT' },
    });
  });

  it('posts in the compound unit when the factor DOES agree, still stating the base', async () => {
    const { buildOrderVoucher } = await import(
      '../../src/modules/seller-erp/payload.service.js'
    );

    await prisma.sellerErpMapping.create({
      data: {
        id: newId(),
        sellerAccountId,
        connectionId,
        entity: 'ALTERNATE_UNIT',
        localKey: offerId,
        tallyName: 'PLT',
        alternateUnitName: 'PLT',
        conversionFactor: '1200',
        isConfirmed: true,
      },
    });

    const payload = await buildOrderVoucher({
      connectionId,
      sellerOrderGroupId: orderGroupId,
      voucherKind: 'SALES_ORDER',
    });

    const line = payload.lines[0];

    // The opt-in route, and the base figure NEVER disappears.
    expect(line?.alternateUnit?.name).toBe('PLT');
    expect(line?.alternateUnit?.quantity).toBe(2);
    expect(line?.baseQuantity).toBe(2400);

    await prisma.sellerErpMapping.deleteMany({
      where: { connectionId, entity: 'ALTERNATE_UNIT' },
    });
  });
});
