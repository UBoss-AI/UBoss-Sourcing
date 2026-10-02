/**
 * Every document about an order's money says the same thing (LIVE-005).
 *
 * One order's money appears in up to six places: the order's own totals, the
 * buyer's invoice, the transaction ledger, the seller's settlement record, the
 * seller's statement and the marketplace's commission invoice to the seller -
 * plus, for an order charged in another currency, the exchange-rate snapshot
 * it was priced from. This file ties them together, figure by figure, for:
 *
 *   1. an Indian GST order from a marketplace seller, with a coupon:
 *      order = invoice; tax = ORDER_TAX_COLLECTED; coupon discount =
 *      redemption = invoice discount = PLATFORM_DISCOUNTS_FUNDED; seller share
 *      in the ledger = settlement = statement; commission invoice taxable and
 *      tax = the settlement's platform fee and the tax on it;
 *   2. an EU reverse-charge supply (no VAT charged, the exemption stated):
 *      invoice = order, no tax anywhere in the ledger, the operator's own goods
 *      booked as PLATFORM_DIRECT_SALES;
 *   3. an order charged in a second currency through checkout: the order's
 *      rate columns are the snapshot's rate with the configured margin, its
 *      base-currency total is the charged total converted back at that rate,
 *      and the invoice and ledger are entirely in the charged currency.
 *
 * WHAT IS NOT REAL. Cases 1 and 2 are written as the checkout would have left
 * them (the arithmetic of GST, EU VAT and coupons is proved where it is
 * computed: `eu-vat.test.ts`, `coupons-currency.test.ts`, `checkout.test.ts`);
 * everything DOWNSTREAM of the order - the split, the invoice, the ledger, the
 * settlement, the statement and the commission invoice - is produced by the
 * real services. Case 3 goes through the real cart and checkout. No payment
 * provider is called: the captured payment row is written as the webhook
 * would have left it.
 *
 * Global reference data this file changes is put back exactly: the FX
 * settings row, active rate snapshots, currency and country active flags,
 * commission invoice settings, and the business profile if it had to create one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { QUOTE_DP, applyAdjustment, formatRate, invertRate, parseRate } from '../../src/domain/fx.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { storage } from '../../src/infra/storage/index.js';
import { addItem } from '../../src/modules/cart/cart.service.js';
import { conversionFor, convert } from '../../src/modules/catalog/bulk-price.service.js';
import * as commission from '../../src/modules/commission-invoicing/commission-invoice.service.js';
import { saveSettings } from '../../src/modules/commission-invoicing/commission-settings.service.js';
import { allocateOrder } from '../../src/modules/finance/escrow.service.js';
import { issueInvoice } from '../../src/modules/invoicing/invoice.service.js';
import { submitCheckout, transitionOrder } from '../../src/modules/orders/order.service.js';
import { splitOrder } from '../../src/modules/seller/order-split.service.js';
import { closeSettlementPeriod } from '../../src/modules/seller/settlement-statement.service.js';
import { setCustomerLocale } from '../../src/modules/settings/currency.service.js';
import { FX_SETTINGS_ID } from '../../src/modules/settings/fx-snapshot.service.js';

const TAG = 'mrc5';
const UPPER = TAG.toUpperCase();
const ENTITY = 'MRC5';
const ADMIN_EMAIL = `${TAG}-finance@test.local`;
const BUYER_EMAIL = `${TAG}-buyer@test.local`;

type Flags = {
  FEATURE_ESCROW_LEDGER: boolean;
  FEATURE_SELLER_SETTLEMENT_STATEMENTS: boolean;
  SELLER_SETTLEMENT_PERIOD: 'WEEKLY' | 'MONTHLY';
  SELLER_SETTLEMENT_PAYABLE_AFTER_DAYS: number | undefined;
};
const mutable = env as unknown as Flags;
const savedFlags: Flags = {
  FEATURE_ESCROW_LEDGER: mutable.FEATURE_ESCROW_LEDGER,
  FEATURE_SELLER_SETTLEMENT_STATEMENTS: mutable.FEATURE_SELLER_SETTLEMENT_STATEMENTS,
  SELLER_SETTLEMENT_PERIOD: mutable.SELLER_SETTLEMENT_PERIOD,
  SELLER_SETTLEMENT_PAYABLE_AFTER_DAYS: mutable.SELLER_SETTLEMENT_PAYABLE_AFTER_DAYS,
};

let actor: commission.FinanceActor;
let buyerProfileId = '';
let connectionId = '';
let createdConnection = false;
let createdBusinessProfileId: string | null = null;
let sellerId = '';
let categoryId = '';
let taxClassId = '';
let fxSnapshotId = '';
let savedFxSettings: Record<string, unknown> | null = null;
let savedActiveSnapshots: { id: string; activeProvider: string | null; retiredAt: Date | null }[] = [];
let savedCommissionSettings: Awaited<ReturnType<typeof prisma.commissionInvoiceSettings.findMany>> = [];
const savedFlagsRows: { kind: 'currency' | 'country'; code: string; isActive: boolean }[] = [];
let counter = 0;

const address = { line1: '4 Hospital Road', city: 'Pune', state: 'Maharashtra', postalCode: '411001', country: 'IN' };
const serial = (): string => {
  counter += 1;
  return String(counter).padStart(6, '0');
};

// ---------------------------------------------------------------------------

async function ledgerOf(orderId: string) {
  const entries = await prisma.ledgerEntry.findMany({ where: { orderId }, include: { lines: { include: { account: true } } } });
  const sums = new Map<string, bigint>();
  const currencies = new Set<string>();
  for (const entry of entries) {
    expect(entry.lines.reduce((sum, line) => sum + line.amountMinor, 0n), entry.kind).toBe(0n);
    for (const line of entry.lines) {
      expect(line.currency).toBe(entry.currency);
      currencies.add(line.currency);
      sums.set(line.account.code, (sums.get(line.account.code) ?? 0n) + line.amountMinor);
    }
  }
  return { entries, currencies, sum: (code: string) => sums.get(code) ?? 0n };
}

async function capture(orderId: string, amountMinor: bigint, currency: string): Promise<void> {
  await prisma.paymentTransaction.create({
    data: {
      id: newId(),
      orderId,
      connectionId,
      provider: 'STRIPE',
      mode: 'TEST',
      status: 'CAPTURED',
      amountMinor,
      capturedMinor: amountMinor,
      currency,
      method: 'card',
      providerPaymentId: `ch_${TAG}${newId().slice(-12)}`,
      idempotencyKey: newId(),
      capturedAt: new Date(),
    },
  });
}

async function cleanUp(): Promise<void> {
  const buyer = await prisma.customerProfile.findFirst({ where: { user: { emailNormalized: BUYER_EMAIL } }, select: { id: true } });
  const orderIds = buyer === null ? [] : (await prisma.order.findMany({ where: { customerProfileId: buyer.id }, select: { id: true } })).map((row) => row.id);
  const sellers = (await prisma.sellerAccount.findMany({ where: { slug: { startsWith: `${TAG}-` } }, select: { id: true } })).map((row) => row.id);
  const invoices = (await prisma.commissionInvoice.findMany({ where: { sellerAccountId: { in: sellers } }, select: { id: true } })).map((row) => row.id);
  const documents = await prisma.commissionDocument.findMany({ where: { invoiceId: { in: invoices } }, select: { id: true, storageKey: true } });
  for (const document of documents) await storage.delete(document.storageKey).catch(() => undefined);
  await prisma.commissionDocument.deleteMany({ where: { id: { in: documents.map((row) => row.id) } } });
  await prisma.commissionCreditNote.deleteMany({ where: { invoiceId: { in: invoices } } });
  await prisma.commissionInvoice.deleteMany({ where: { id: { in: invoices } } });
  const entries = (await prisma.ledgerEntry.findMany({ where: { OR: [{ orderId: { in: orderIds } }, { sellerAccountId: { in: sellers } }] }, select: { id: true } })).map((row) => row.id);
  await prisma.ledgerLine.deleteMany({ where: { entryId: { in: entries } } });
  await prisma.ledgerEntry.deleteMany({ where: { id: { in: entries } } });
  await prisma.ledgerAccount.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerFundHold.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.sellerSettlementLine.deleteMany({ where: { settlement: { sellerAccountId: { in: sellers } } } });
  await prisma.sellerSettlement.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.couponRedemption.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.coupon.deleteMany({ where: { code: { startsWith: UPPER } } });
  await prisma.invoice.updateMany({ where: { orderId: { in: orderIds } }, data: { creditsInvoiceId: null } });
  await prisma.invoice.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.paymentTransaction.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorEmail: ADMIN_EMAIL }, { resourceId: { in: orderIds } }] } });
  await prisma.stockReservation.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.logisticsShipment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.notificationOutbox.deleteMany({ where: { relatedId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.sellerBusinessProfile.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellers } } });
  await prisma.productPrice.deleteMany({ where: { product: { slug: { startsWith: `${TAG}-` } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: `${TAG}-` } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: `${TAG}-` } } });
  await prisma.taxClass.deleteMany({ where: { code: UPPER } });
  await prisma.exchangeRate.deleteMany({ where: { snapshot: { sourceReference: `test://${TAG}` } } });
  await prisma.exchangeRateSnapshot.deleteMany({ where: { sourceReference: `test://${TAG}` } });
  if (buyer !== null) {
    await prisma.cartItem.deleteMany({ where: { cart: { customerProfileId: buyer.id } } });
    await prisma.cart.deleteMany({ where: { customerProfileId: buyer.id } });
    await prisma.address.deleteMany({ where: { customerProfileId: buyer.id } });
  }
  await prisma.commissionInvoiceSettings.deleteMany({ where: { legalEntityCode: ENTITY } });
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: BUYER_EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { in: [ADMIN_EMAIL, BUYER_EMAIL] } } });
}

beforeAll(async () => {
  Object.assign(mutable, {
    FEATURE_ESCROW_LEDGER: true,
    FEATURE_SELLER_SETTLEMENT_STATEMENTS: true,
    SELLER_SETTLEMENT_PERIOD: 'MONTHLY',
    SELLER_SETTLEMENT_PAYABLE_AFTER_DAYS: 14,
  });
  await cleanUp();

  const admin = await prisma.user.create({
    data: { id: newId(), type: 'ADMIN', email: ADMIN_EMAIL, emailNormalized: ADMIN_EMAIL, status: 'ACTIVE', emailVerifiedAt: new Date() },
  });
  actor = { userId: admin.id, email: ADMIN_EMAIL };
  const buyer = await prisma.user.create({
    data: { id: newId(), type: 'CUSTOMER', email: BUYER_EMAIL, emailNormalized: BUYER_EMAIL, status: 'ACTIVE', emailVerifiedAt: new Date() },
  });
  buyerProfileId = (
    await prisma.customerProfile.create({ data: { id: newId(), userId: buyer.id, fullName: 'MRC Buyer', organization: 'MRC Hospital', activatedAt: new Date() } })
  ).id;

  if ((await prisma.businessProfile.findFirst({ select: { id: true } })) === null) {
    createdBusinessProfileId = newId();
    await prisma.businessProfile.create({
      data: { id: createdBusinessProfileId, legalName: 'MRC Operator', displayName: 'MRC', supportEmail: 'support@test.local', currency: 'INR', timezone: 'Asia/Kolkata' },
    });
  }

  const existing = await prisma.paymentProviderConnection.findUnique({ where: { provider_mode: { provider: 'STRIPE', mode: 'TEST' } }, select: { id: true } });
  if (existing === null) {
    connectionId = newId();
    createdConnection = true;
    await prisma.paymentProviderConnection.create({
      data: { id: connectionId, provider: 'STRIPE', mode: 'TEST', label: `${TAG}-test`, credentialsEnc: 'v1:x:y:z', isActive: false },
    });
  } else {
    connectionId = existing.id;
  }

  // The commission invoice issuer: this file's own, the others put back after.
  savedCommissionSettings = await prisma.commissionInvoiceSettings.findMany();
  await prisma.commissionInvoiceSettings.deleteMany({});
  await saveSettings(actor, {
    legalEntityCode: ENTITY,
    legalName: 'MRC Marketplace Operations Private Limited (TEST)',
    tradeName: 'MRC Marketplace',
    addressLine1: '4th Floor, Test Tower',
    addressLine2: 'Sample Road',
    city: 'Pune',
    region: 'Maharashtra',
    postcode: '411001',
    country: 'IN',
    stateCode: '27',
    taxRegime: 'IN_GST',
    taxRegistrationLabel: 'GSTIN',
    taxRegistrationNumber: '27AAPFU0939F1ZV',
    businessIdentifierLabel: 'PAN',
    businessIdentifier: 'AAPFU0939F',
    businessEmail: 'billing@example.test',
    supportContact: '+91 00000 00000',
    jurisdictionNote: null,
    serviceCode: '998599',
    serviceCodeLabel: 'SAC',
    serviceDescription: 'Marketplace platform commission for Order {orderNumber}',
    invoicePrefix: 'MR/COM',
    creditNotePrefix: 'MR/CCN',
    sequencePadding: 6,
    financialYearStartMonth: 4,
    eligibleStage: 'DELIVERED',
    paymentTermsDays: 15,
    roundGrandTotal: false,
    requireSellerTaxId: true,
    exportLutReference: null,
    zeroTaxDocumentType: 'INVOICE',
    allowVoidAfterIssue: false,
    footerNote: null,
    expectedVersion: 0,
  });

  if ((await prisma.inventoryLocation.findFirst({ select: { id: true } })) === null) {
    await prisma.inventoryLocation.create({ data: { id: newId(), code: `${UPPER}-MAIN`, name: 'Main', isDefault: true, isActive: true } });
  }
  taxClassId = (await prisma.taxClass.create({ data: { id: newId(), code: UPPER, name: 'GST 18%', ratePercent: '18.000000', isActive: true } })).id;
  categoryId = (await prisma.category.create({ data: { id: newId(), name: `${UPPER} Supplies`, slug: `${TAG}-category`, isActive: true } })).id;

  // A seller registered for GST in Maharashtra, like the operator: intra-state.
  sellerId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerId,
      slug: `${TAG}-seller`,
      legalName: `${UPPER} Healthcare Private Limited`,
      displayName: `${UPPER} Healthcare`,
      displayNameNormalized: `${TAG}healthcare`,
      kind: 'MANUFACTURER',
      registrationCountry: 'IN',
      status: 'APPROVED',
      // A negotiated 10% fee, so the split charges one without a published policy.
      commissionBasisPoints: 1_000,
    },
  });
  await prisma.sellerBusinessProfile.create({
    data: {
      id: newId(),
      sellerAccountId: sellerId,
      taxRegistrationNumber: '27AAPFU0939F1ZV',
      registeredAddressLine1: '12 MIDC Industrial Area',
      registeredCity: 'Pune',
      registeredRegion: 'Maharashtra',
      registeredPostcode: '411019',
      registeredCountry: 'IN',
      supportEmail: 'accounts@seller.test',
    },
  });
}, 120_000);

afterAll(async () => {
  Object.assign(mutable, savedFlags);
  await cleanUp();
  if (savedCommissionSettings.length > 0) {
    await prisma.commissionInvoiceSettings.createMany({ data: savedCommissionSettings as never[] });
  }
  if (savedFxSettings === null) await prisma.currencyRateSync.deleteMany({ where: { id: FX_SETTINGS_ID } });
  else await prisma.currencyRateSync.update({ where: { id: FX_SETTINGS_ID }, data: savedFxSettings as never });
  for (const row of savedActiveSnapshots) {
    await prisma.exchangeRateSnapshot.update({ where: { id: row.id }, data: { isActive: true, activeProvider: row.activeProvider, retiredAt: row.retiredAt } });
  }
  for (const row of savedFlagsRows) {
    if (row.kind === 'currency') await prisma.currency.update({ where: { code: row.code }, data: { isActive: row.isActive } });
    else await prisma.country.update({ where: { code: row.code }, data: { isActive: row.isActive } });
  }
  if (createdConnection) await prisma.paymentProviderConnection.deleteMany({ where: { id: connectionId } });
  if (createdBusinessProfileId !== null) await prisma.businessProfile.deleteMany({ where: { id: createdBusinessProfileId } });
});

// ---------------------------------------------------------------------------

describe('1. an Indian GST order from a marketplace seller, with a coupon', () => {
  it('reads the same in the order, the invoice, the ledger, the settlement, the statement and the commission invoice', async () => {
    // --- The order, as checkout leaves it ----------------------------------
    const product = await prisma.product.create({
      data: {
        id: newId(), categoryId, taxClassId, name: `${UPPER} examination gloves`, slug: `${TAG}-gloves`, sku: `${UPPER}-GLV`,
        basePriceMinor: 0n, currency: 'INR', status: 'ACTIVE', isPublished: true, publishedAt: new Date(),
        isMarketplaceProduct: true, isStockTracked: false, minOrderQty: 1, qtyIncrement: 1,
      },
    });
    const offerId = newId();
    await prisma.sellerOffer.create({
      data: { id: offerId, sellerAccountId: sellerId, productId: product.id, variantKey: '', sellerSku: `${UPPER}-GLV-1`, status: 'ACTIVE', priceMinor: 20_000n, currency: 'INR' },
    });
    const coupon = await prisma.coupon.create({
      data: { id: newId(), code: `${UPPER}SAVE10`, name: 'Ten per cent off', discountPercent: '10.00', status: 'ACTIVE' },
    });

    // 5 x 200.00 = 1,000.00; 10% coupon = 100.00; GST 18% on the 900.00 = 162.00.
    const subtotal = 100_000n;
    const discount = 10_000n;
    const tax = 16_200n;
    const grand = subtotal - discount + tax;
    const orderId = newId();
    await prisma.order.create({
      data: {
        id: orderId, orderNumber: `UB-${UPPER}-${serial()}`, customerProfileId: buyerProfileId, status: 'CONFIRMED', currency: 'INR',
        subtotalMinor: subtotal, discountMinor: discount, taxMinor: tax, shippingMinor: 0n, grandTotalMinor: grand, paidMinor: grand,
        taxTreatment: 'FLAT_RATE', billingAddressJson: address, shippingAddressJson: address, placedAt: new Date(), confirmedAt: new Date(),
      },
    });
    await prisma.orderItem.create({
      data: {
        id: newId(), orderId, productId: product.id, sellerOfferId: offerId, nameSnapshot: product.name, skuSnapshot: product.sku,
        taxClassCodeSnapshot: UPPER, unitPriceMinor: 20_000n, quantity: 5, lineSubtotalMinor: subtotal, discountMinor: discount,
        taxRatePercent: '18.000000', taxInclusive: false, taxAmountMinor: tax, lineTotalMinor: grand,
      },
    });
    await prisma.couponRedemption.create({
      data: { id: newId(), couponId: coupon.id, orderId, customerProfileId: buyerProfileId, codeSnapshot: coupon.code, discountPercentSnapshot: '10.00', currencyCode: 'INR', discountMinor: discount },
    });
    await capture(orderId, grand, 'INR');

    // --- The seller's part, the delivery -------------------------------------
    await splitOrder(orderId);
    const group = await prisma.sellerOrderGroup.findFirstOrThrow({ where: { orderId } });
    await prisma.sellerOrderGroup.update({ where: { id: group.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
    const split = await prisma.sellerOrderSettlement.findUniqueOrThrow({ where: { sellerOrderGroupId: group.id } });
    expect(split.platformFeeMinor).toBe(10_000n);
    // GST on the fee, as finance records and verifies it where no published
    // fee policy carries the tax wording.
    const settlement = await prisma.sellerOrderSettlement.update({
      where: { id: split.id },
      data: {
        platformFeeTaxMinor: 1_800n,
        feeTaxRatePercent: '18.000000',
        feeTaxLabel: 'GST',
        feeTaxVerified: true,
        estimatedSettlementMinor: split.grossProceedsMinor + split.sellerDeliveryProceedsMinor - split.platformFeeMinor - 1_800n,
      },
    });
    const share = settlement.grossProceedsMinor + settlement.sellerDeliveryProceedsMinor - settlement.platformFeeMinor - settlement.platformFeeTaxMinor;
    // The seller's share is worked out on the undiscounted price.
    expect(settlement.grossProceedsMinor).toBe(subtotal);
    expect(group.goodsTotalMinor).toBe(subtotal);
    expect(group.commissionMinor).toBe(settlement.platformFeeMinor);

    // --- The buyer's invoice ------------------------------------------------
    const issued = await issueInvoice({ orderId, actorUserId: actor.userId, actorEmail: actor.email });
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: issued.id } });
    expect(invoice).toMatchObject({ currency: 'INR', subtotalMinor: subtotal, discountMinor: discount, taxMinor: tax, shippingMinor: 0n, grandTotalMinor: grand });
    const lines = invoice.linesJson as { netMinor: string; vatAmountMinor: string; grossMinor: string; discountMinor: string }[];
    expect(lines.reduce((sum, line) => sum + BigInt(line.netMinor), 0n)).toBe(subtotal - discount);
    expect(lines.reduce((sum, line) => sum + BigInt(line.vatAmountMinor), 0n)).toBe(tax);
    expect(lines.reduce((sum, line) => sum + BigInt(line.discountMinor), 0n)).toBe(discount);
    const breakdown = invoice.vatBreakdownJson as { taxableMinor: string; vatMinor: string }[];
    expect(breakdown.reduce((sum, row) => sum + BigInt(row.vatMinor), 0n)).toBe(tax);

    // --- The ledger ---------------------------------------------------------
    await allocateOrder(orderId);
    const ledger = await ledgerOf(orderId);
    expect([...ledger.currencies]).toEqual(['INR']);
    expect(ledger.sum('PROVIDER_BALANCE')).toBe(grand);
    expect(ledger.sum('BUYER_FUNDS_CLEARING')).toBe(0n);
    expect(ledger.sum('ORDER_TAX_COLLECTED')).toBe(-tax);
    // The coupon is the platform's cost, not the seller's.
    expect(ledger.sum('PLATFORM_DISCOUNTS_FUNDED')).toBe(discount);
    expect(ledger.sum('PLATFORM_COMMISSION')).toBe(-settlement.platformFeeMinor);
    expect(ledger.sum('PLATFORM_FEE_TAX')).toBe(-settlement.platformFeeTaxMinor);
    expect(-(ledger.sum('SELLER_HELD') + ledger.sum('SELLER_AVAILABLE') + ledger.sum('SELLER_RESERVE'))).toBe(share);
    // Every rupee the buyer paid is somewhere.
    expect(share + settlement.platformFeeMinor + settlement.platformFeeTaxMinor + tax - discount).toBe(grand);

    // --- The commission invoice to the seller -------------------------------
    const draft = await commission.generateDraft(actor, group.id, `${TAG}-draft-${newId()}`);
    const issuedCommission = await commission.issueInvoice(actor, draft.invoice.id, draft.invoice.snapshotHash);
    expect(issuedCommission.invoice.status).toBe('ISSUED');
    const commissionRow = await prisma.commissionInvoice.findUniqueOrThrow({ where: { id: draft.invoice.id } });
    expect(commissionRow.settlementId).toBe(settlement.id);
    expect(commissionRow.taxableMinor).toBe(settlement.platformFeeMinor);
    expect(commissionRow.totalTaxMinor).toBe(settlement.platformFeeTaxMinor);
    expect(commissionRow.cgstMinor + commissionRow.sgstMinor + commissionRow.igstMinor + commissionRow.otherTaxMinor).toBe(commissionRow.totalTaxMinor);
    // Seller and operator in one state: CGST + SGST, no IGST.
    expect(commissionRow.igstMinor).toBe(0n);
    expect(commissionRow.grandTotalMinor).toBe(settlement.platformFeeMinor + settlement.platformFeeTaxMinor + commissionRow.roundingMinor);

    // --- The seller's statement --------------------------------------------
    await closeSettlementPeriod(new Date(Date.now() + 62 * 86_400_000));
    const statementLines = await prisma.sellerSettlementLine.findMany({ where: { orderGroupId: group.id } });
    expect(statementLines.find((line) => line.kind === 'SALE')?.amountMinor).toBe(settlement.grossProceedsMinor);
    expect(statementLines.filter((line) => line.kind === 'COMMISSION').reduce((sum, line) => sum + line.amountMinor, 0n)).toBe(
      -(settlement.platformFeeMinor + settlement.platformFeeTaxMinor),
    );
    expect(statementLines.reduce((sum, line) => sum + line.amountMinor, 0n)).toBe(share);
  });
});

describe('2. an EU reverse-charge supply', () => {
  it('charges no VAT, states why, and books no tax anywhere', async () => {
    const product = await prisma.product.create({
      data: {
        id: newId(), categoryId, taxClassId, name: `${UPPER} sterile dressing`, slug: `${TAG}-dressing`, sku: `${UPPER}-DRS`,
        basePriceMinor: 5_000n, currency: 'EUR', status: 'ACTIVE', isPublished: true, publishedAt: new Date(), isStockTracked: false,
      },
    });
    const subtotal = 25_000n;
    const orderId = newId();
    await prisma.order.create({
      data: {
        id: orderId, orderNumber: `UB-${UPPER}-${serial()}`, customerProfileId: buyerProfileId, status: 'CONFIRMED', currency: 'EUR',
        subtotalMinor: subtotal, taxMinor: 0n, grandTotalMinor: subtotal, paidMinor: subtotal,
        taxTreatment: 'INTRA_EU_REVERSE_CHARGE', taxCountry: 'DE', sellerVatNumberSnapshot: 'NL123456789B01', buyerVatNumberSnapshot: 'DE811569869',
        billingAddressJson: { line1: 'Unter den Linden 1', city: 'Berlin', postalCode: '10117', country: 'DE' },
        shippingAddressJson: { line1: 'Unter den Linden 1', city: 'Berlin', postalCode: '10117', country: 'DE' },
        placedAt: new Date(), confirmedAt: new Date(),
      },
    });
    await prisma.orderItem.create({
      data: {
        id: newId(), orderId, productId: product.id, nameSnapshot: product.name, skuSnapshot: product.sku, taxClassCodeSnapshot: UPPER,
        unitPriceMinor: 5_000n, quantity: 5, lineSubtotalMinor: subtotal, discountMinor: 0n, taxRatePercent: '0.000000', taxInclusive: false,
        taxAmountMinor: 0n, lineTotalMinor: subtotal,
      },
    });
    await capture(orderId, subtotal, 'EUR');

    const issued = await issueInvoice({ orderId });
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: issued.id } });
    expect(invoice).toMatchObject({ currency: 'EUR', taxMinor: 0n, grandTotalMinor: subtotal, taxTreatment: 'INTRA_EU_REVERSE_CHARGE', buyerVatNumber: 'DE811569869' });
    // A zero tax line is not an explanation: the provisions are named.
    expect(invoice.exemptionNote).toContain('Article 196');

    await allocateOrder(orderId);
    const ledger = await ledgerOf(orderId);
    expect([...ledger.currencies]).toEqual(['EUR']);
    expect(ledger.sum('PROVIDER_BALANCE')).toBe(subtotal);
    expect(ledger.sum('BUYER_FUNDS_CLEARING')).toBe(0n);
    expect(ledger.sum('ORDER_TAX_COLLECTED')).toBe(0n);
    // The operator's own goods, not a seller's.
    expect(ledger.sum('PLATFORM_DIRECT_SALES')).toBe(-subtotal);
    expect(ledger.sum('SELLER_HELD')).toBe(0n);
  });
});

describe('3. an order charged in a second currency', () => {
  it('converts at the snapshot rate plus margin, converts back exactly, and stays in one currency downstream', async () => {
    // --- Global FX state, saved for afterAll -------------------------------
    const fx = await prisma.currencyRateSync.findUnique({ where: { id: FX_SETTINGS_ID } });
    savedFxSettings = fx === null ? null : (({ id: _id, createdAt: _c, updatedAt: _u, ...rest }) => rest)(fx);
    await prisma.currencyRateSync.upsert({
      where: { id: FX_SETTINGS_ID },
      create: { id: FX_SETTINGS_ID, deriveMissingPrices: true, marginPercent: '2.00', rounding: 'exact' },
      update: { deriveMissingPrices: true, marginPercent: '2.00', rounding: 'exact' },
    });
    savedActiveSnapshots = await prisma.exchangeRateSnapshot.findMany({
      where: { isActive: true },
      select: { id: true, activeProvider: true, retiredAt: true },
    });
    await prisma.exchangeRateSnapshot.updateMany({ where: { isActive: true }, data: { isActive: false, activeProvider: null } });

    const base = await prisma.currency.findFirstOrThrow({ where: { isBase: true }, select: { code: true } });
    const charged = base.code === 'PLN' ? 'EUR' : 'PLN';
    const countryCode = charged === 'PLN' ? 'PL' : 'DE';
    for (const code of [charged, base.code]) {
      const row = await prisma.currency.findUnique({ where: { code }, select: { isActive: true } });
      if (row === null) throw new Error(`currency ${code} missing from reference data`);
      savedFlagsRows.push({ kind: 'currency', code, isActive: row.isActive });
      await prisma.currency.update({ where: { code }, data: { isActive: true } });
    }
    const country = await prisma.country.findUnique({ where: { code: countryCode }, select: { isActive: true } });
    if (country === null) throw new Error(`country ${countryCode} missing from reference data`);
    savedFlagsRows.push({ kind: 'country', code: countryCode, isActive: country.isActive });
    await prisma.country.update({ where: { code: countryCode }, data: { isActive: true } });

    // A euro-pivoted rate set quoting both currencies.
    fxSnapshotId = newId();
    const rates: Record<string, string> = { EUR: '1.000000000000', INR: '90.000000000000', PLN: '4.400000000000' };
    if (rates[base.code] === undefined) rates[base.code] = '1.500000000000';
    await prisma.exchangeRateSnapshot.create({
      data: {
        id: fxSnapshotId, provider: 'ecb', pivotCurrency: 'EUR', asOf: new Date(Date.now() - 2 * 3_600_000), sourceReference: `test://${TAG}`,
        retrievalStatus: 'FETCHED', validationStatus: 'VALID', isActive: true, activeProvider: 'ecb', activatedAt: new Date(), rateCount: Object.keys(rates).length,
      },
    });
    await prisma.exchangeRate.createMany({
      data: Object.entries(rates)
        .filter(([quote]) => quote !== 'EUR')
        .map(([quoteCurrency, rate]) => ({ id: newId(), snapshotId: fxSnapshotId, baseCurrency: 'EUR', quoteCurrency, rate })),
    });

    // --- A product priced only in the base currency, bought in the other -----
    const product = await prisma.product.create({
      data: {
        id: newId(), categoryId, taxClassId, name: `${UPPER} pulse oximeter`, slug: `${TAG}-oximeter`, sku: `${UPPER}-OXI`,
        basePriceMinor: 450_000n, currency: base.code, status: 'ACTIVE', isPublished: true, publishedAt: new Date(), isStockTracked: false,
        minOrderQty: 1, qtyIncrement: 1,
      },
    });
    await prisma.productPrice.create({ data: { id: newId(), productId: product.id, variantKey: '', currencyCode: base.code, basePriceMinor: 450_000n } });
    const shipTo = await prisma.address.create({
      data: {
        id: newId(), customerProfileId: buyerProfileId, contactName: 'Ward store', contactPhone: '+48 22 000 00 00',
        line1: 'ul. Szpitalna 4', state: charged === 'PLN' ? 'Mazowieckie' : 'Berlin', city: charged === 'PLN' ? 'Warszawa' : 'Berlin', postalCode: charged === 'PLN' ? '00-001' : '10117', country: countryCode,
      },
    });
    await setCustomerLocale(buyerProfileId, { country: countryCode, currency: charged });
    await addItem(buyerProfileId, { productId: product.id, quantity: 1 });
    const placed = await submitCheckout({
      customerProfileId: buyerProfileId,
      shippingAddressId: shipTo.id,
      paymentMode: 'ONLINE',
      actor: { userId: null, email: BUYER_EMAIL, type: 'CUSTOMER' },
    });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });

    // --- The order's rate columns are the snapshot's -------------------------
    expect(order.currency).toBe(charged);
    expect(order.fxPriceSource).toBe('CONVERTED');
    expect(order.fxSnapshotId).toBe(fxSnapshotId);
    expect(order.fxBaseCurrency).toBe(base.code);
    const snapshot = await prisma.exchangeRateSnapshot.findUniqueOrThrow({ where: { id: fxSnapshotId } });
    expect(snapshot.provider).toBe(order.fxProvider);
    const mid = order.fxMidRate?.toString() ?? '';
    const used = order.fxRateUsed?.toString() ?? '';
    expect(order.fxAdjustmentPercent?.toFixed(2)).toBe('2.00');
    // The rate used is the market's mid rate with the configured margin on it.
    // The service adjusts the full-precision mid and rounds to the quote scale.
    expect(parseRate(used)).toBe(parseRate(formatRate(parseRate(applyAdjustment(mid, '2.00')), QUOTE_DP)));
    // The base-currency total is the CHARGED total converted back at that rate.
    const back = convert(
      order.grandTotalMinor,
      conversionFor({ sourceCurrency: charged, targetCurrency: base.code, rate: invertRate(used, QUOTE_DP), rounding: 'exact' }),
    );
    expect(order.fxBaseGrandTotalMinor).toBe(back);

    // --- Invoice and ledger in the charged currency only ------------------
    // Paid, as the verified webhook would record it, then confirmed through
    // the state machine like every other order.
    await capture(order.id, order.grandTotalMinor, charged);
    await prisma.order.update({ where: { id: order.id }, data: { paidMinor: order.grandTotalMinor } });
    await transitionOrder({ orderId: order.id, to: 'CONFIRMED', actor: { userId: null, email: null, type: 'SYSTEM' }, reason: 'Payment captured' });
    const issued = await issueInvoice({ orderId: order.id });
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: issued.id } });
    expect(invoice).toMatchObject({ currency: charged, subtotalMinor: order.subtotalMinor, taxMinor: order.taxMinor, grandTotalMinor: order.grandTotalMinor });

    await allocateOrder(order.id);
    const ledger = await ledgerOf(order.id);
    expect([...ledger.currencies]).toEqual([charged]);
    expect(ledger.sum('PROVIDER_BALANCE')).toBe(order.grandTotalMinor);
    expect(ledger.sum('BUYER_FUNDS_CLEARING')).toBe(0n);
    expect(ledger.sum('ORDER_TAX_COLLECTED')).toBe(-order.taxMinor);
    expect(ledger.sum('PLATFORM_DIRECT_SALES')).toBe(-(order.subtotalMinor - order.discountMinor));
    expect(ledger.sum('PLATFORM_LOGISTICS_REVENUE')).toBe(-order.shippingMinor);
  });
});
