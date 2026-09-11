/**
 * A connection that actually works, proved against a server that answers.
 *
 * The other files in this feature prove pieces. This one proves the claim a
 * buyer makes when they press Switch on: that an order confirmed here becomes a
 * purchase order *there*, under their credential, over a real socket.
 *
 * Everything below runs against `tests/support/mock-erp.ts` - a real HTTP
 * listener, not a stubbed `fetch` - so the whole path is exercised: the address
 * checks, DNS resolution, the socket pin, the credential headers, the mapped
 * body, the ERP's answer, the ledger row, and the link row that records what it
 * all came to.
 *
 * WHY `ALLOW_PRIVATE_ERP_TARGETS` IS SET HERE
 *
 * The mock listens on 127.0.0.1, which is exactly what the SSRF guard exists to
 * refuse. Setting the flag is the same escape hatch a developer uses to point a
 * connection at a mock on their own machine, and `env.ts` refuses to start a
 * production process with it on.
 *
 * That the guard works is proved elsewhere and deliberately not weakened here:
 * `customer-erp-reliability.test.ts` asserts the address rules as pure
 * functions, `outbound-http.test.ts` asserts them against real addresses, and
 * the live check in this feature's own notes covers the metadata endpoint,
 * loopback, plain HTTP, credentials-in-URL and the private ranges. This file
 * asks a different question: given an address we ARE willing to call, does the
 * whole thing work.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Set before anything reads `env`. The mock is on loopback, which the guard
// refuses by default - see this file's header.
process.env.ALLOW_PRIVATE_ERP_TARGETS = 'true';
process.env.FEATURE_CUSTOMER_ERP = 'true';

const { hashPassword } = await import('../../src/infra/crypto.js');
const { newId } = await import('../../src/infra/ids.js');
const { prisma } = await import('../../src/infra/prisma.js');
const { startMockErp } = await import('../support/mock-erp.js');

const {
  activateConnection,
  createConnection,
  saveEndpoints,
  saveMappings,
  savePolicy,
  testConnection,
} =
  await import('../../src/modules/customer-erp/connection.service.js');
const { resolveMembership } = await import(
  '../../src/modules/customer-erp/organization.service.js'
);
const { claimDueEvents, enqueueEvent } = await import(
  '../../src/modules/customer-erp/event.service.js'
);
const { dispatchEvent } = await import('../../src/modules/customer-erp/pipeline.service.js');
const { runInventorySync } = await import('../../src/modules/customer-erp/polling.service.js');

import type { MockErp } from '../support/mock-erp.js';
import type { OrgActor } from '../../src/modules/customer-erp/audit.service.js';
import type { Membership } from '../../src/modules/customer-erp/organization.service.js';

const API_KEY = 'mock-erp-key-9f2a';

const actor: OrgActor = { customerProfileId: null, email: 'buyer@example.test', correlationId: null };

let erp: MockErp;

async function reset(): Promise<void> {
  await prisma.customerErpApproval.deleteMany({});
  await prisma.customerErpWebhookEvent.deleteMany({});
  await prisma.customerErpSyncEvent.deleteMany({});
  await prisma.customerErpSyncJob.deleteMany({});
  await prisma.customerErpOrderLink.deleteMany({});
  await prisma.customerErpInvoiceLink.deleteMany({});
  await prisma.customerErpInventoryLink.deleteMany({});
  await prisma.customerErpCredential.deleteMany({});
  await prisma.customerErpEndpoint.deleteMany({});
  await prisma.customerErpFieldMapping.deleteMany({});
  await prisma.customerErpWarehouseMap.deleteMany({});
  await prisma.customerErpSyncPolicy.deleteMany({});
  await prisma.customerErpConnection.deleteMany({});
  await prisma.customerErpAuditLog.deleteMany({});
  await prisma.buyerOrganizationInvite.deleteMany({});
  await prisma.buyerOrganizationMember.deleteMany({});
  await prisma.buyerOrganization.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.user.deleteMany({});
}

/** A buyer with an organisation, ready to connect something. */
async function makeBuyer(): Promise<{ membership: Membership; profileId: string }> {
  const userId = newId();
  const profileId = newId();
  const email = `live-${userId.slice(-8).toLowerCase()}@example.test`;

  await prisma.user.create({
    data: {
      id: userId,
      type: 'CUSTOMER',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword('Correct-Horse-9'),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });

  await prisma.customerProfile.create({
    data: { id: profileId, userId, fullName: 'Zorggroep Noord', organization: 'Zorggroep Noord' },
  });

  return { membership: await resolveMembership(profileId), profileId };
}

/**
 * A connection pointed at the mock, configured the way the wizard would leave
 * it and switched on.
 *
 * Deliberately goes through the real service functions - create, endpoints,
 * policy, test, activate - rather than writing rows. Activation is refused
 * unless a test has passed and the mapping has been checked, so getting here at
 * all is itself part of what this file proves.
 */
async function connectAndActivate(
  membership: Membership,
  overrides: { receiptOnDelivery?: boolean; thresholdMinor?: string } = {},
): Promise<string> {
  const connection = await createConnection(membership, actor, {
    name: 'Mock ERP',
    system: 'CUSTOM',
    vendorPreset: 'custom',
    environment: 'PRODUCTION',
    baseUrl: erp.url,
    authMethod: 'API_KEY',
    apiKeyLocation: 'HEADER',
    apiKeyName: 'X-API-Key',
    tenantIdentifier: 'VENDOR-1',
    secrets: { apiKey: API_KEY },
  });

  await saveEndpoints(membership, actor, connection.id, [
    { purpose: 'PRODUCTS', path: '/products', method: 'GET', recordsPath: 'items' },
    { purpose: 'INVENTORY', path: '/inventory', method: 'GET', recordsPath: 'items' },
    { purpose: 'PURCHASE_ORDER_CREATE', path: '/purchase-orders', method: 'POST' },
    { purpose: 'PURCHASE_ORDER_UPDATE', path: '/purchase-orders', method: 'PATCH' },
    { purpose: 'SHIPMENT_STATUS', path: '/shipments', method: 'POST' },
    { purpose: 'GOODS_RECEIPT', path: '/goods-receipts', method: 'POST' },
    { purpose: 'INVOICE', path: '/invoices', method: 'POST' },
    { purpose: 'PAYMENT_REFERENCE', path: '/payments', method: 'POST' },
  ] as never);

  await savePolicy(membership, actor, connection.id, {
    // Two-way, because this connection both raises purchase orders and reads
    // stock back. `savePolicy` refuses `syncInventory` on a send-only
    // connection, which is the contradiction it exists to catch: a sync that
    // calls the buyer's ERP and throws the answer away.
    mode: 'BIDIRECTIONAL',
    sendPurchaseOrders: true,
    sendShipmentStatus: true,
    sendGoodsReceipts: true,
    sendInvoices: true,
    sendPaymentReferences: true,
    syncInventory: true,
    receiptOnPlatformDelivery: overrides.receiptOnDelivery ?? true,
    inventoryWriteMode: 'AUTOMATIC',
    ...(overrides.thresholdMinor === undefined
      ? {}
      : { approvalThresholdMinor: overrides.thresholdMinor, approvalCurrency: 'EUR' }),
  });

  // The real gate. A failing test here means nothing below can run.
  const result = await testConnection(membership, actor, connection.id);
  expect(result.ok, `the test call failed: ${result.message}`).toBe(true);

  await activateConnection(membership, actor, connection.id);

  return connection.id;
}

/**
 * The two products the mock ERP knows about, by SKU.
 *
 * Created here rather than leaned on from the seed, for two reasons. The test
 * database is truncated by other suites, so depending on seed rows makes this
 * file pass or fail according to what ran before it. And the SKUs have to match
 * the ones the mock returns - `productIdForSku` is how an inbound stock figure
 * finds its way to one of our products, so a fixture with different SKUs would
 * silently record nothing and the assertions would be measuring a no-op.
 *
 * Idempotent: every test in this file calls it, and `reset` does not remove
 * catalogue rows.
 */
async function makeProducts(): Promise<Record<string, string>> {
  const { categoryId, taxClassId } = await referenceRows();

  const category = { id: categoryId };
  const taxClass = { id: taxClassId };

  const wanted = [
    { sku: 'MOCK-SKU-1', name: 'Nitrile gloves, medium' },
    { sku: 'MOCK-SKU-2', name: 'Surgical mask, type IIR' },
  ];

  const bySku: Record<string, string> = {};

  for (const entry of wanted) {
    const existing = await prisma.product.findUnique({
      where: { sku: entry.sku },
      select: { id: true },
    });

    if (existing !== null) {
      bySku[entry.sku] = existing.id;
      continue;
    }

    const id = newId();

    await prisma.product.create({
      data: {
        id,
        categoryId: category.id,
        taxClassId: taxClass.id,
        name: entry.name,
        slug: `${entry.sku.toLowerCase()}-${id.slice(-6).toLowerCase()}`,
        sku: entry.sku,
        basePriceMinor: 400_00n,
        currency: 'EUR',
        status: 'ACTIVE',
        isPublished: true,
      },
    });

    bySku[entry.sku] = id;
  }

  return bySku;
}

/**
 * A category and a tax class for the fixture products to hang off.
 *
 * Found where the reference seed has run, created where it has not - and what
 * this file created is remembered, so `afterAll` takes it away again.
 *
 * Not an assertion about the seed, deliberately. Other suites in this project
 * truncate the catalogue (`inventory.test.ts` is the documented example), so a
 * fixture that demands seeded reference data passes when it runs first and
 * fails when it runs eleventh - which is a test reporting the order it was run
 * in rather than anything about the code.
 */
let createdCategoryId: string | null = null;
let createdTaxClassId: string | null = null;

async function referenceRows(): Promise<{ categoryId: string; taxClassId: string }> {
  const existingCategory = await prisma.category.findFirst({ select: { id: true } });
  const existingTaxClass = await prisma.taxClass.findFirst({ select: { id: true } });

  if (existingCategory !== null && existingTaxClass !== null) {
    return { categoryId: existingCategory.id, taxClassId: existingTaxClass.id };
  }

  if (existingCategory === null) {
    const id = newId();

    await prisma.category.create({
      data: {
        id,
        name: 'ERP fixture category',
        slug: `erp-fixture-${id.slice(-8).toLowerCase()}`,
        isActive: false,
      },
    });

    createdCategoryId = id;
  }

  if (existingTaxClass === null) {
    const id = newId();

    await prisma.taxClass.create({
      data: {
        id,
        code: `ERPFIX-${id.slice(-6)}`,
        name: 'ERP fixture tax class',
        ratePercent: '19',
        isActive: false,
      },
    });

    createdTaxClassId = id;
  }

  return {
    categoryId: existingCategory?.id ?? (createdCategoryId as string),
    taxClassId: existingTaxClass?.id ?? (createdTaxClassId as string),
  };
}

/** An order, confirmed, with two lines. */
async function makeOrder(profileId: string): Promise<{ orderId: string; orderNumber: string }> {
  const orderId = newId();
  const orderNumber = `UB-TEST-${orderId.slice(-6)}`;

  const products = await makeProducts();

  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber,
      customerProfileId: profileId,
      status: 'CONFIRMED',
      currency: 'EUR',
      subtotalMinor: 1_200_00n,
      taxMinor: 228_00n,
      grandTotalMinor: 1_428_00n,
      billingAddressJson: {},
      shippingAddressJson: {},
      placedAt: new Date(),
      items: {
        create: [
          {
            id: newId(),
            productId: products['MOCK-SKU-1'] ?? '',
            nameSnapshot: 'Nitrile gloves, medium',
            skuSnapshot: 'MOCK-SKU-1',
            taxClassCodeSnapshot: 'STANDARD',
            unitPriceMinor: 400_00n,
            quantity: 2,
            lineSubtotalMinor: 800_00n,
            taxRatePercent: '19',
            taxAmountMinor: 152_00n,
            lineTotalMinor: 952_00n,
          },
          {
            id: newId(),
            productId: products['MOCK-SKU-2'] ?? '',
            nameSnapshot: 'Surgical mask, type IIR',
            skuSnapshot: 'MOCK-SKU-2',
            taxClassCodeSnapshot: 'STANDARD',
            unitPriceMinor: 400_00n,
            quantity: 1,
            lineSubtotalMinor: 400_00n,
            taxRatePercent: '19',
            taxAmountMinor: 76_00n,
            lineTotalMinor: 476_00n,
          },
        ],
      },
    },
  });

  return { orderId, orderNumber };
}

/** Queue one event and run it through the real dispatcher. */
async function sendEvent(
  connectionId: string,
  membership: Membership,
  eventType: 'PURCHASE_ORDER_CREATE' | 'SHIPMENT_STATUS' | 'GOODS_RECEIPT',
  orderId: string,
): Promise<void> {
  await enqueueEvent({
    connectionId,
    organizationId: membership.organizationId,
    eventType,
    subject: orderId,
    correlationId: newId(),
    orderId,
  });

  for (const event of await claimDueEvents(10)) {
    await dispatchEvent(event);
  }
}

beforeAll(async () => {
  erp = await startMockErp({ apiKeyHeader: 'X-API-Key', apiKey: API_KEY });
});

afterAll(async () => {
  await erp.close();
  await reset();

  /*
   * Take the catalogue rows away too.
   *
   * `reset` clears what each test made; this clears what the FILE made. Orders
   * are gone by now, so the products they referenced can go - and with them the
   * category and tax class, but only where this file created them. Deleting a
   * seeded category because a fixture happened to use it is how one suite
   * breaks the next one's first test.
   */
  await prisma.product.deleteMany({ where: { sku: { startsWith: 'MOCK-SKU-' } } });

  if (createdCategoryId !== null) {
    await prisma.category.deleteMany({ where: { id: createdCategoryId } });
    createdCategoryId = null;
  }

  if (createdTaxClassId !== null) {
    await prisma.taxClass.deleteMany({ where: { id: createdTaxClassId } });
    createdTaxClassId = null;
  }
});

beforeEach(async () => {
  await reset();
  erp.reset();
});

afterEach(async () => {
  await reset();
});

describe('connecting to a system that answers', () => {
  it('tests, activates, and reads a real record back', async () => {
    const { membership } = await makeBuyer();
    const connectionId = await connectAndActivate(membership);

    const connection = await prisma.customerErpConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });

    expect(connection.state).toBe('ACTIVE');
    expect(connection.lastTestOk).toBe(true);
    // Activation is refused without this, so reaching ACTIVE proves the mapping
    // was checked against a record the mock actually returned.
    expect(connection.mappingVerifiedAt).not.toBeNull();

    // The credential reached the ERP: the mock answers 401 without it.
    const read = erp.requestsTo('/products')[0];
    expect(read?.headers['x-api-key']).toBe(API_KEY);
  });

  it('refuses to activate when the ERP rejects the credential', async () => {
    const { membership } = await makeBuyer();

    const connection = await createConnection(membership, actor, {
      name: 'Wrong key',
      system: 'CUSTOM',
      environment: 'PRODUCTION',
      baseUrl: erp.url,
      authMethod: 'API_KEY',
      apiKeyLocation: 'HEADER',
      apiKeyName: 'X-API-Key',
      secrets: { apiKey: 'not-the-right-key' },
    });

    await saveEndpoints(membership, actor, connection.id, [
      { purpose: 'PRODUCTS', path: '/products', method: 'GET', recordsPath: 'items' },
    ] as never);

    const result = await testConnection(membership, actor, connection.id);

    expect(result.ok).toBe(false);
    // Reported as an authentication problem specifically, because the remedy is
    // entirely different from a network fault.
    expect(result.message).toMatch(/credential|refused/i);

    await expect(activateConnection(membership, actor, connection.id)).rejects.toThrow();
  });
});

describe('a confirmed order becomes a purchase order', () => {
  /**
   * The line array goes where the buyer's own mapping says it goes.
   *
   * Most of the catalogue maps a line as `items.0.sku` rather than
   * `lines.0.sku` - it is what NetSuite, Zoho, Dynamics and the rest of the
   * REST family call it. The connector used to write its full set of lines to a
   * fixed `lines` key regardless, so a body arrived carrying `lines` with all
   * five and `items` with the first one. A system reading `items` accepted a
   * purchase order for a fifth of the goods and answered 201.
   *
   * Asserted on what the ERP RECEIVED, because that is the only place the two
   * halves of the body are visible at once.
   */
  it('puts every line under the name the buyer maps them to', async () => {
    const { membership, profileId } = await makeBuyer();
    const connectionId = await connectAndActivate(membership);

    await saveMappings(membership, actor, connectionId, [
      { entity: 'ORDER', platformField: 'orderNumber', erpPath: 'externalId', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'currency', erpPath: 'currency', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
      { entity: 'ORDER', platformField: 'lineSku', erpPath: 'items.0.sku', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'lineQuantity', erpPath: 'items.0.quantity', constantValue: null, erpValue: null, transform: null },
      { entity: 'ORDER', platformField: 'grossAmount', erpPath: 'total', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
      { entity: 'INVENTORY', platformField: 'sku', erpPath: 'sku', constantValue: null, erpValue: null, transform: 'TRIM' },
    ] as never);

    const { orderId, orderNumber } = await makeOrder(profileId);

    erp.reset();
    await sendEvent(connectionId, membership, 'PURCHASE_ORDER_CREATE', orderId);

    const body = erp.requestsTo('/purchase-orders')[0]?.body as Record<string, unknown>;

    expect(body['externalId']).toBe(orderNumber);

    const items = body['items'];

    expect(Array.isArray(items), 'the lines did not arrive under "items"').toBe(true);
    expect((items as unknown[]).length, 'only the mapped first line arrived').toBe(2);

    // The mapping still won on the field it addresses - `items.0.sku` is the
    // trimmed value from the mapping, not whatever the connector assembled.
    expect((items as Record<string, unknown>[])[0]?.['sku']).toBe('MOCK-SKU-1');
    expect((items as Record<string, unknown>[])[1]?.['quantity']).toBe(1);

    // And nothing was left behind under the connector's own default name.
    expect(body['lines']).toBeUndefined();
  });

  it('sends the mapped body and records what came back', async () => {
    const { membership, profileId } = await makeBuyer();
    const connectionId = await connectAndActivate(membership);
    const { orderId, orderNumber } = await makeOrder(profileId);

    await sendEvent(connectionId, membership, 'PURCHASE_ORDER_CREATE', orderId);

    // It arrived.
    const posted = erp.requestsTo('/purchase-orders');
    expect(posted).toHaveLength(1);
    expect(posted[0]?.method).toBe('POST');

    const body = posted[0]?.body as Record<string, unknown>;

    // Carrying our order number and the lines, through the buyer's mapping.
    expect(body['reference']).toBe(orderNumber);
    expect(Array.isArray(body['lines'])).toBe(true);
    expect((body['lines'] as unknown[]).length).toBe(2);

    // The event succeeded and remembered the ERP's own identifier.
    const event = await prisma.customerErpSyncEvent.findFirstOrThrow({
      where: { orderId, eventType: 'PURCHASE_ORDER_CREATE' },
    });

    expect(event.state).toBe('SUCCEEDED');
    expect(event.erpReference).not.toBeNull();

    // And the link row, which is what answers "did my purchase order get
    // raised, and what is it called over there".
    const link = await prisma.customerErpOrderLink.findFirstOrThrow({
      where: { connectionId, orderId },
    });

    expect(link.erpPurchaseOrderId).toBe(event.erpReference);
    expect(link.pushedAt).not.toBeNull();
  });

  it('sends money as a decimal string, never as a float', async () => {
    const { membership, profileId } = await makeBuyer();
    const connectionId = await connectAndActivate(membership);
    const { orderId } = await makeOrder(profileId);

    await sendEvent(connectionId, membership, 'PURCHASE_ORDER_CREATE', orderId);

    const body = erp.requestsTo('/purchase-orders')[0]?.body as Record<string, unknown>;

    // 142800 minor units, sent as "1428.00" - by string arithmetic. A float
    // round trip is how a purchase order ends up a unit under the invoice.
    expect(body['total']).toBe('1428.00');
    expect(typeof body['total']).toBe('string');
  });

  it('moves the quantity to ON ORDER and leaves on-hand alone', async () => {
    const { membership, profileId } = await makeBuyer();
    const connectionId = await connectAndActivate(membership);
    const { orderId } = await makeOrder(profileId);

    await sendEvent(connectionId, membership, 'PURCHASE_ORDER_CREATE', orderId);

    const link = await prisma.customerErpOrderLink.findFirstOrThrow({
      where: { connectionId, orderId },
    });

    // Three units across two lines, all of it on order.
    expect(link.onOrderQty).toBe(3);
    expect(link.receivedQty).toBe(0);

    // The claim the whole feature turns on: ordering something does not put it
    // on the shelf. Nothing has been receipted, so nothing is on hand.
    const stock = await prisma.customerErpInventoryLink.findMany({ where: { connectionId } });

    expect(stock.length).toBeGreaterThan(0);
    for (const row of stock) {
      expect(row.onHandQty, 'a confirmed order must not move on-hand stock').toBe(0);
      expect(row.onOrderQty).toBeGreaterThan(0);
    }

    // And no goods receipt was sent, because nothing has arrived.
    expect(erp.goodsReceipts).toHaveLength(0);
  });

  it('moves stock on hand only once the goods are receipted', async () => {
    const { membership, profileId } = await makeBuyer();
    const connectionId = await connectAndActivate(membership, { receiptOnDelivery: true });
    const { orderId } = await makeOrder(profileId);

    await sendEvent(connectionId, membership, 'PURCHASE_ORDER_CREATE', orderId);
    await sendEvent(connectionId, membership, 'GOODS_RECEIPT', orderId);

    // The receipt reached the ERP.
    expect(erp.goodsReceipts).toHaveLength(1);

    const link = await prisma.customerErpOrderLink.findFirstOrThrow({
      where: { connectionId, orderId },
    });

    expect(link.receivedQty).toBe(3);
    // What was on order has arrived, so it is no longer outstanding.
    expect(link.onOrderQty).toBe(0);
    expect(link.erpGoodsReceiptId).not.toBeNull();
    expect(link.goodsReceiptedAt).not.toBeNull();

    // NOW on hand moves, because the policy says apply it automatically.
    const stock = await prisma.customerErpInventoryLink.findMany({ where: { connectionId } });
    const totalOnHand = stock.reduce((sum, row) => sum + row.onHandQty, 0);

    expect(totalOnHand).toBe(3);
  });

  it('holds the stock write when the rules ask for a person', async () => {
    const { membership, profileId } = await makeBuyer();
    const connectionId = await connectAndActivate(membership, { receiptOnDelivery: true });

    // The buyer's answer to "may this change our stock on its own": no.
    await savePolicy(membership, actor, connectionId, {
      inventoryWriteMode: 'APPROVAL_REQUIRED',
    });

    const { orderId } = await makeOrder(profileId);

    await sendEvent(connectionId, membership, 'PURCHASE_ORDER_CREATE', orderId);
    await sendEvent(connectionId, membership, 'GOODS_RECEIPT', orderId);

    // An approval was raised and nothing was sent.
    const approval = await prisma.customerErpApproval.findFirst({
      where: { connectionId, kind: 'INVENTORY_WRITE' },
    });

    expect(approval).not.toBeNull();
    expect(approval?.state).toBe('PENDING');
    expect(erp.goodsReceipts).toHaveLength(0);

    const event = await prisma.customerErpSyncEvent.findFirstOrThrow({
      where: { orderId, eventType: 'GOODS_RECEIPT' },
    });

    expect(event.state).toBe('SKIPPED');
    expect(event.approvalId).toBe(approval?.id);
  });
});

describe('retrying cannot produce a second purchase order', () => {
  it('recovers from a transient failure under the same idempotency key', async () => {
    await erp.close();
    // Two 503s, then behave. The dispatcher should retry and succeed.
    erp = await startMockErp({
      apiKeyHeader: 'X-API-Key',
      apiKey: API_KEY,
      failFirst: { path: '/purchase-orders', times: 2, status: 503 },
    });

    const { membership, profileId } = await makeBuyer();
    const connectionId = await connectAndActivate(membership);
    const { orderId } = await makeOrder(profileId);

    await enqueueEvent({
      connectionId,
      organizationId: membership.organizationId,
      eventType: 'PURCHASE_ORDER_CREATE',
      subject: orderId,
      correlationId: newId(),
      orderId,
    });

    // Three passes. The first two are refused with a 503; the backoff is
    // cleared between them so the test does not sit waiting for it.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await prisma.customerErpSyncEvent.updateMany({
        where: { orderId, state: 'RETRYING' },
        data: { nextRetryAt: new Date(Date.now() - 1000) },
      });

      for (const event of await claimDueEvents(10)) {
        await dispatchEvent(event);
      }
    }

    const event = await prisma.customerErpSyncEvent.findFirstOrThrow({ where: { orderId } });

    expect(event.state).toBe('SUCCEEDED');
    expect(event.attemptCount).toBe(3);

    // Three POSTs were made and exactly ONE purchase order exists, because the
    // first two were refused before creating anything.
    expect(erp.requestsTo('/purchase-orders')).toHaveLength(3);
    expect(erp.purchaseOrders.size).toBe(1);

    // Restored for the rest of the file.
    await erp.close();
    erp = await startMockErp({ apiKeyHeader: 'X-API-Key', apiKey: API_KEY });
  });

  it('treats an ERP that already has the document as success, not as a duplicate', async () => {
    const { membership, profileId } = await makeBuyer();
    const connectionId = await connectAndActivate(membership);
    const { orderId, orderNumber } = await makeOrder(profileId);

    await sendEvent(connectionId, membership, 'PURCHASE_ORDER_CREATE', orderId);
    expect(erp.purchaseOrders.size).toBe(1);

    // Force a second send of the SAME event - the manual-retry path. The ERP
    // answers 409 because it already has that reference.
    await prisma.customerErpSyncEvent.updateMany({
      where: { orderId },
      data: { state: 'QUEUED', nextRetryAt: null, completedAt: null },
    });

    for (const event of await claimDueEvents(10)) {
      await dispatchEvent(event);
    }

    const event = await prisma.customerErpSyncEvent.findFirstOrThrow({ where: { orderId } });

    // A 409 on a document number means the ERP has it. That is the outcome we
    // wanted, so it is a success rather than a failure to escalate.
    expect(event.state).toBe('SUCCEEDED');

    // Still one purchase order over there.
    expect(erp.purchaseOrders.size).toBe(1);
    expect(erp.purchaseOrders.has(orderNumber)).toBe(true);
  });

  it('queues one event however many times the same thing is reported', async () => {
    const { membership, profileId } = await makeBuyer();
    const connectionId = await connectAndActivate(membership);
    const { orderId } = await makeOrder(profileId);

    // A redelivered payment webhook, a second worker, a manual send-again.
    for (let i = 0; i < 3; i += 1) {
      await enqueueEvent({
        connectionId,
        organizationId: membership.organizationId,
        eventType: 'PURCHASE_ORDER_CREATE',
        subject: orderId,
        correlationId: newId(),
        orderId,
      });
    }

    for (const event of await claimDueEvents(10)) {
      await dispatchEvent(event);
    }

    expect(await prisma.customerErpSyncEvent.count({ where: { orderId } })).toBe(1);
    expect(erp.requestsTo('/purchase-orders')).toHaveLength(1);
    expect(erp.purchaseOrders.size).toBe(1);
  });

  it('stops rather than retrying when the ERP says no', async () => {
    await erp.close();
    // 400: the ERP understood perfectly and refused. No amount of retrying
    // improves that, so the event should fail rather than burn its budget.
    erp = await startMockErp({ apiKeyHeader: 'X-API-Key', apiKey: API_KEY, forceStatus: 400 });

    const { membership, profileId } = await makeBuyer();

    // Configure and activate against a server that still answers reads.
    const connection = await createConnection(membership, actor, {
      name: 'Refusing ERP',
      system: 'CUSTOM',
      environment: 'PRODUCTION',
      baseUrl: erp.url,
      authMethod: 'API_KEY',
      apiKeyLocation: 'HEADER',
      apiKeyName: 'X-API-Key',
      secrets: { apiKey: API_KEY },
    });

    await saveEndpoints(membership, actor, connection.id, [
      { purpose: 'PRODUCTS', path: '/products', method: 'GET', recordsPath: 'items' },
      { purpose: 'PURCHASE_ORDER_CREATE', path: '/purchase-orders', method: 'POST' },
    ] as never);

    await testConnection(membership, actor, connection.id);
    await prisma.customerErpConnection.update({
      where: { id: connection.id },
      data: { state: 'ACTIVE' },
    });

    const { orderId } = await makeOrder(profileId);
    await sendEvent(connection.id, membership, 'PURCHASE_ORDER_CREATE', orderId);

    const event = await prisma.customerErpSyncEvent.findFirstOrThrow({ where: { orderId } });

    expect(event.state).toBe('FAILED');
    // One attempt, not six.
    expect(event.attemptCount).toBe(1);
    expect(event.errorCode).toBe('REJECTED');

    await erp.close();
    erp = await startMockErp({ apiKeyHeader: 'X-API-Key', apiKey: API_KEY });
  });
});

describe('reading stock back', () => {
  /**
   * A paged read, with the cursor where paging actually puts it.
   *
   * This is the case every other test in this file walked past. The endpoints
   * they configure page with NONE, so the request URL never carries a query
   * string - and the address guard was refusing any URL that did, on a rule
   * written for the address a customer TYPES. Every paging style this platform
   * speaks puts its cursor in a query parameter, so a buyer whose products
   * endpoint pages could not connect at all, and nothing here noticed.
   *
   * The assertion is deliberately on what the ERP RECEIVED rather than on the
   * sync's own count: "it succeeded" would have been just as true if the
   * parameters had been dropped on the way out.
   */
  it('sends the paging cursor in the query string, and is allowed to', async () => {
    const { membership } = await makeBuyer();
    const connectionId = await connectAndActivate(membership);

    await saveEndpoints(membership, actor, connectionId, [
      {
        purpose: 'INVENTORY',
        path: '/inventory',
        method: 'GET',
        recordsPath: 'items',
        pagination: 'PAGE_NUMBER',
        paginationConfig: { pageParam: 'page', sizeParam: 'pageSize', pageSize: 50 },
      },
    ] as never);

    erp.reset();

    const outcome = await runInventorySync({
      connectionId,
      organizationId: membership.organizationId,
      trigger: 'MANUAL',
      correlationId: newId(),
    });

    expect(outcome.status, outcome.message).toBe('SUCCEEDED');
    expect(outcome.processed).toBe(2);

    const read = erp.requestsTo('/inventory')[0];

    expect(read, 'the paged read never reached the ERP').toBeDefined();
    expect(read?.query).toContain('page=1');
    expect(read?.query).toContain('pageSize=50');
  });

  it('records what the ERP believes, without touching our own ledger', async () => {
    const { membership } = await makeBuyer();
    const connectionId = await connectAndActivate(membership);

    const balancesBefore = await prisma.inventoryBalance.count();

    const outcome = await runInventorySync({
      connectionId,
      organizationId: membership.organizationId,
      trigger: 'MANUAL',
      correlationId: newId(),
    });

    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.processed).toBe(2);

    // What the ERP said is recorded against the connection...
    const stock = await prisma.customerErpInventoryLink.findMany({ where: { connectionId } });
    expect(stock.length).toBeGreaterThan(0);

    // ...and the operator's own stock ledger is untouched. `inventory_balances`
    // is moved by a person through the Inventory screens, with a reason and an
    // actor against it - never by a customer's ERP.
    expect(await prisma.inventoryBalance.count()).toBe(balancesBefore);
  });

  /**
   * The contradiction that used to pass silently.
   *
   * "Send only" and "read their stock" cannot both be true. Accepted quietly,
   * it produced a sync that called the buyer's ERP every fifteen minutes, threw
   * every record away, and reported success - indistinguishable, from the
   * dashboard, from an ERP holding no stock.
   */
  it('refuses to read stock back from a send-only connection', async () => {
    const { membership } = await makeBuyer();
    const connectionId = await connectAndActivate(membership);

    await expect(
      savePolicy(membership, actor, connectionId, { mode: 'OUTBOUND', syncInventory: true }),
    ).rejects.toThrow(/send only/i);

    // And if a policy reaches that state by any other route, the sync says so
    // rather than calling their ERP for an answer it would discard.
    await savePolicy(membership, actor, connectionId, {
      mode: 'OUTBOUND',
      syncInventory: false,
    });

    erp.reset();

    const outcome = await runInventorySync({
      connectionId,
      organizationId: membership.organizationId,
      trigger: 'MANUAL',
      correlationId: newId(),
    });

    expect(outcome.status).toBe('FAILED');
    expect(outcome.processed).toBe(0);
    expect(erp.requestsTo('/inventory')).toHaveLength(0);
  });
});

describe('pausing, against a live connection', () => {
  it('stops sending, and resumes where it left off', async () => {
    const { membership, profileId } = await makeBuyer();
    const connectionId = await connectAndActivate(membership);
    const { orderId } = await makeOrder(profileId);

    const { changeConnectionState } = await import(
      '../../src/modules/customer-erp/connection.service.js'
    );

    await changeConnectionState(membership, actor, connectionId, 'PAUSE');

    await sendEvent(connectionId, membership, 'PURCHASE_ORDER_CREATE', orderId);

    // Nothing reached the ERP.
    expect(erp.requestsTo('/purchase-orders')).toHaveLength(0);

    const held = await prisma.customerErpSyncEvent.findFirstOrThrow({ where: { orderId } });
    expect(held.state).toBe('QUEUED');
    // Held, not dropped - and no attempt was spent on a connection-level cause.
    expect(held.attemptCount).toBe(0);

    // Resume, and it goes.
    await changeConnectionState(membership, actor, connectionId, 'RESUME');

    await prisma.customerErpSyncEvent.updateMany({
      where: { orderId },
      data: { nextRetryAt: new Date(Date.now() - 1000) },
    });

    for (const event of await claimDueEvents(10)) {
      await dispatchEvent(event);
    }

    expect(erp.requestsTo('/purchase-orders')).toHaveLength(1);

    const sent = await prisma.customerErpSyncEvent.findFirstOrThrow({ where: { orderId } });
    expect(sent.state).toBe('SUCCEEDED');
  });
});
