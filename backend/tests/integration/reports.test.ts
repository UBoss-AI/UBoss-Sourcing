/**
 * Reports, exports and the connector - integration, against a real MariaDB.
 *
 * Reports are where a quiet arithmetic error becomes a wrong number in a board
 * pack, so the tests check actual figures against hand-computed ones rather
 * than merely asserting a shape.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { createConnector, runSync } from '../../src/modules/integrations/connector.service.js';
import {
  ExportType,
  downloadExport,
  generateExport,
  getExportStatus,
  purgeExpiredExports,
  requestExport,
} from '../../src/modules/reports/export.service.js';
import {
  customerReport,
  dashboard,
  fulfilmentAgeing,
  inventoryValuation,
  ordersByStatus,
  paymentsReport,
  resolveWindow,
  salesByPeriod,
  salesSummary,
  topProducts,
} from '../../src/modules/reports/report.service.js';

let adminId: string;
let customerProfileId: string;
let productId: string;

const WINDOW = () => resolveWindow();

async function resetAll(): Promise<void> {
  await prisma.auditLog.deleteMany({});
  await prisma.jobQueue.deleteMany({});
  await prisma.syncError.deleteMany({});
  await prisma.syncRun.deleteMany({});
  await prisma.integrationConnection.deleteMany({});
  await prisma.exportJob.deleteMany({});
  await prisma.notificationOutbox.deleteMany({});
  await prisma.paymentEvent.deleteMany({});
  await prisma.refund.deleteMany({});
  await prisma.paymentTransaction.deleteMany({});
  await prisma.paymentProviderConnection.deleteMany({});
  await prisma.stockReservation.deleteMany({});
  await prisma.inventoryMovement.deleteMany({});
  await prisma.inventoryBalance.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.recurringScheduleItem.deleteMany({});
  await prisma.recurringSchedule.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
  await prisma.inventoryLocation.deleteMany({});
  await prisma.address.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.businessProfile.deleteMany({});
}

/** An order with one line, at a chosen status and total. */
async function makeOrder(params: {
  status: 'DRAFT' | 'PENDING_PAYMENT' | 'CONFIRMED' | 'CANCELLED' | 'DELIVERED';
  grandTotalMinor: bigint;
  paidMinor?: bigint;
  refundedMinor?: bigint;
  quantity?: number;
  createdAt?: Date;
}): Promise<string> {
  const id = newId();
  const quantity = params.quantity ?? 10;

  await prisma.order.create({
    data: {
      id,
      orderNumber: `UB-${id.slice(-10)}`,
      customerProfileId,
      status: params.status,
      currency: 'INR',
      subtotalMinor: params.grandTotalMinor,
      taxMinor: 0n,
      grandTotalMinor: params.grandTotalMinor,
      paidMinor: params.paidMinor ?? 0n,
      refundedMinor: params.refundedMinor ?? 0n,
      billingAddressJson: {},
      shippingAddressJson: {},
      confirmedAt: params.status === 'CONFIRMED' ? new Date() : null,
      ...(params.createdAt !== undefined ? { createdAt: params.createdAt } : {}),
    },
  });

  await prisma.orderItem.create({
    data: {
      id: newId(),
      orderId: id,
      productId,
      nameSnapshot: 'Hex Bolt M12',
      skuSnapshot: 'HEX-M12',
      taxClassCodeSnapshot: 'GST18',
      unitPriceMinor: params.grandTotalMinor / BigInt(quantity),
      quantity,
      lineSubtotalMinor: params.grandTotalMinor,
      taxRatePercent: '18.000000',
      taxAmountMinor: 0n,
      lineTotalMinor: params.grandTotalMinor,
    },
  });

  return id;
}

beforeEach(async () => {
  await resetAll();

  await prisma.businessProfile.create({
    data: {
      id: newId(),
      legalName: 'UBOSS Test',
      displayName: 'UBOSS',
      supportEmail: 'support@test.local',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      orderPrefix: 'UB',
    },
  });

  adminId = newId();
  await prisma.user.create({
    data: {
      id: adminId,
      type: 'ADMIN',
      email: 'admin@rep.test',
      emailNormalized: 'admin@rep.test',
      status: 'ACTIVE',
    },
  });

  const customerUserId = newId();
  await prisma.user.create({
    data: {
      id: customerUserId,
      type: 'CUSTOMER',
      email: 'buyer@rep.test',
      emailNormalized: 'buyer@rep.test',
      status: 'ACTIVE',
    },
  });
  const profile = await prisma.customerProfile.create({
    data: {
      id: newId(),
      userId: customerUserId,
      fullName: 'Report Buyer',
      organization: 'Acme',
      activatedAt: new Date(),
    },
  });
  customerProfileId = profile.id;

  await prisma.inventoryLocation.create({
    data: { id: newId(), code: 'MAIN', name: 'Main', isDefault: true, isActive: true },
  });

  const taxClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'GST18',
      name: 'GST 18%',
      ratePercent: '18.000000',
      isDefault: true,
      isActive: true,
    },
  });
  const category = await prisma.category.create({
    data: { id: newId(), name: 'Fasteners', slug: 'fasteners', isActive: true },
  });

  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Hex Bolt M12',
      slug: 'hex-bolt-m12',
      sku: 'HEX-M12',
      basePriceMinor: 4550n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      isStockTracked: true,
      reorderThreshold: 20,
    },
  });
  productId = product.id;

  await prisma.inventoryBalance.create({
    data: {
      id: newId(),
      productId,
      variantKey: '',
      locationId: (await prisma.inventoryLocation.findFirstOrThrow()).id,
      onHandQty: 100,
      reservedQty: 10,
    },
  });
});

afterAll(async () => {
  await resetAll();
  await prisma.$disconnect();
});

describe('sales summary', () => {
  /**
   * DRAFT is an abandoned cart and CANCELLED never happened. Counting either
   * would overstate revenue.
   */
  it('counts committed orders and excludes drafts and cancellations', async () => {
    await makeOrder({ status: 'CONFIRMED', grandTotalMinor: 100_000n, paidMinor: 100_000n });
    await makeOrder({ status: 'PENDING_PAYMENT', grandTotalMinor: 50_000n });
    await makeOrder({ status: 'DRAFT', grandTotalMinor: 999_999n });
    await makeOrder({ status: 'CANCELLED', grandTotalMinor: 999_999n });

    const summary = await salesSummary(WINDOW());

    expect(summary.orderCount).toBe(2);
    expect(summary.grossSales.minor).toBe('150000');
    expect(summary.collected.minor).toBe('100000');
  });

  it('reports net revenue as collected minus refunded', async () => {
    await makeOrder({
      status: 'DELIVERED',
      grandTotalMinor: 100_000n,
      paidMinor: 100_000n,
      refundedMinor: 30_000n,
    });

    const summary = await salesSummary(WINDOW());
    expect(summary.netRevenue.minor).toBe('70000');
  });

  it('averages in integer arithmetic, never a float', async () => {
    await makeOrder({ status: 'CONFIRMED', grandTotalMinor: 10_000n });
    await makeOrder({ status: 'CONFIRMED', grandTotalMinor: 10_001n });
    await makeOrder({ status: 'CONFIRMED', grandTotalMinor: 10_002n });

    const summary = await salesSummary(WINDOW());
    // 30003 / 3 = 10001 exactly.
    expect(summary.averageOrderValue.minor).toBe('10001');
  });

  it('returns zeroes for an empty window rather than NaN', async () => {
    const summary = await salesSummary(WINDOW());
    expect(summary.orderCount).toBe(0);
    expect(summary.grossSales.minor).toBe('0');
    expect(summary.averageOrderValue.minor).toBe('0');
  });

  /** A financial report is exactly where a lossy JS number matters. */
  it('keeps money as strings, beyond Number.MAX_SAFE_INTEGER', async () => {
    await makeOrder({ status: 'CONFIRMED', grandTotalMinor: 9_007_199_254_740_993n });

    const summary = await salesSummary(WINDOW());
    expect(summary.grossSales.minor).toBe('9007199254740993');
    expect(typeof summary.grossSales.minor).toBe('string');
  });

  /** Half-open windows, so adjacent periods never double-count a boundary row. */
  it('excludes an order created outside the window', async () => {
    await makeOrder({
      status: 'CONFIRMED',
      grandTotalMinor: 100_000n,
      createdAt: new Date(Date.now() - 60 * 86_400_000),
    });

    expect((await salesSummary(WINDOW())).orderCount).toBe(0);
  });
});

describe('sales by period', () => {
  it('buckets by day', async () => {
    await makeOrder({ status: 'CONFIRMED', grandTotalMinor: 10_000n });
    await makeOrder({ status: 'CONFIRMED', grandTotalMinor: 20_000n });

    const buckets = await salesByPeriod(WINDOW(), 'day');
    const today = buckets.find((bucket) => bucket.orderCount > 0);

    expect(today?.orderCount).toBe(2);
    expect(today?.grossSales).toBe('30000');
  });

  it('buckets by month', async () => {
    await makeOrder({ status: 'CONFIRMED', grandTotalMinor: 10_000n });
    const buckets = await salesByPeriod(WINDOW(), 'month');
    expect(buckets[0]?.period).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe('top products', () => {
  /** Reads the snapshot, so a renamed product still reports what was sold. */
  it('reports the name as sold, not the current catalog name', async () => {
    await makeOrder({ status: 'CONFIRMED', grandTotalMinor: 100_000n, quantity: 10 });

    await prisma.product.update({
      where: { id: productId },
      data: { name: 'Renamed Since', sku: 'NEW-SKU' },
    });

    const rows = await topProducts(WINDOW());
    expect(rows[0]?.name).toBe('Hex Bolt M12');
    expect(rows[0]?.sku).toBe('HEX-M12');
    expect(rows[0]?.quantitySold).toBe(10);
    expect(rows[0]?.revenue).toBe('100000');
  });
});

describe('orders and fulfilment', () => {
  it('groups by status with values', async () => {
    await makeOrder({ status: 'CONFIRMED', grandTotalMinor: 10_000n });
    await makeOrder({ status: 'CONFIRMED', grandTotalMinor: 20_000n });
    await makeOrder({ status: 'CANCELLED', grandTotalMinor: 5_000n });

    const rows = await ordersByStatus(WINDOW());
    const confirmed = rows.find((row) => row.status === 'CONFIRMED');

    expect(confirmed?.count).toBe(2);
    expect(confirmed?.value).toBe('30000');
  });

  it('buckets waiting orders by age', async () => {
    await makeOrder({ status: 'CONFIRMED', grandTotalMinor: 10_000n });

    const buckets = await fulfilmentAgeing();
    const fresh = buckets.find((bucket) => bucket.bucket === '0-1 days');

    expect(fresh?.count).toBe(1);
    expect(fresh?.oldestOrderNumber).not.toBeNull();
  });
});

describe('payments report', () => {
  it('separates captured from failed', async () => {
    const orderId = await makeOrder({ status: 'CONFIRMED', grandTotalMinor: 100_000n });
    const connectionId = newId();

    await prisma.paymentProviderConnection.create({
      data: {
        id: connectionId,
        provider: 'RAZORPAY',
        mode: 'TEST',
        label: 'Test',
        credentialsEnc: 'v1:x:y:z',
        isActive: true,
      },
    });

    await prisma.paymentTransaction.createMany({
      data: [
        {
          id: newId(),
          orderId,
          connectionId,
          provider: 'RAZORPAY',
          mode: 'TEST',
          status: 'CAPTURED',
          amountMinor: 100_000n,
          capturedMinor: 100_000n,
          currency: 'INR',
          idempotencyKey: newId(),
        },
        {
          id: newId(),
          orderId,
          connectionId,
          provider: 'RAZORPAY',
          mode: 'TEST',
          status: 'FAILED',
          amountMinor: 40_000n,
          currency: 'INR',
          idempotencyKey: newId(),
        },
      ],
    });

    const report = await paymentsReport(WINDOW());
    expect(report.captured).toBe('100000');
    expect(report.failed).toBe('40000');
  });

  /** A verified event we refused is a finance and security signal. */
  it('surfaces rejected webhooks', async () => {
    await prisma.paymentEvent.create({
      data: {
        id: newId(),
        provider: 'RAZORPAY',
        providerEventId: `evt_${newId()}`,
        eventType: 'payment.captured',
        signatureVerified: true,
        rawPayload: '{}',
        processingStatus: 'REJECTED',
        processingError: 'amount mismatch',
      },
    });

    expect((await paymentsReport(WINDOW())).rejectedWebhooks).toBe(1);
  });
});

describe('inventory valuation', () => {
  it('values on-hand stock at the current price', async () => {
    const valuation = await inventoryValuation();

    // 100 x 45.50 = 4550.00.
    expect(valuation.totalValuation).toBe('455000');
    expect(valuation.rows[0]?.availableQty).toBe(90);
  });

  it('flags low stock against the reorder threshold', async () => {
    await prisma.inventoryBalance.updateMany({
      where: { productId },
      data: { onHandQty: 25, reservedQty: 10 },
    });

    const valuation = await inventoryValuation({ lowStockOnly: true });
    // available = 15, threshold = 20.
    expect(valuation.rows).toHaveLength(1);
    expect(valuation.rows[0]?.isLowStock).toBe(true);
  });

  it('excludes archived products from the valuation', async () => {
    await prisma.product.update({ where: { id: productId }, data: { archivedAt: new Date() } });
    expect((await inventoryValuation()).totalValuation).toBe('0');
  });
});

describe('customer report', () => {
  it('counts customers by status and activity', async () => {
    await makeOrder({ status: 'CONFIRMED', grandTotalMinor: 10_000n });

    const report = await customerReport(WINDOW());
    expect(report.total).toBe(1);
    expect(report.orderingInWindow).toBe(1);
  });
});

describe('dashboard', () => {
  it('returns every panel in one round trip', async () => {
    await makeOrder({ status: 'CONFIRMED', grandTotalMinor: 100_000n, paidMinor: 100_000n });

    const panel = await dashboard(WINDOW());

    expect(panel).toHaveProperty('sales');
    expect(panel).toHaveProperty('ordersByStatus');
    expect(panel).toHaveProperty('payments');
    expect(panel).toHaveProperty('lowStock');
    expect(panel).toHaveProperty('recurring');
    // Operational health, so a stuck queue is visible without a complaint.
    expect(panel).toHaveProperty('alerts');
  });
});

describe('exports', () => {
  const requestOrdersExport = () =>
    requestExport({
      type: ExportType.ORDERS,
      actorUserId: adminId,
      actorEmail: 'admin@rep.test',
    });

  it('queues a job and reports it pending', async () => {
    const { exportJobId, status } = await requestOrdersExport();

    expect(status).toBe('PENDING');
    expect(await prisma.jobQueue.count({ where: { jobType: 'export.generate' } })).toBe(1);

    const state = await getExportStatus(exportJobId, adminId);
    expect(state.status).toBe('PENDING');
    expect(state.downloadToken).toBeNull();
  });

  it('generates a CSV with a header and one row per record', async () => {
    await makeOrder({ status: 'CONFIRMED', grandTotalMinor: 100_000n });
    await makeOrder({ status: 'CONFIRMED', grandTotalMinor: 50_000n });

    const { exportJobId } = await requestOrdersExport();
    const result = await generateExport(exportJobId);

    expect(result.rowCount).toBe(2);

    const state = await getExportStatus(exportJobId, adminId);
    expect(state.status).toBe('SUCCEEDED');
    expect(state.downloadToken).not.toBeNull();

    const file = await downloadExport(state.downloadToken ?? '');
    const lines = file.content.toString('utf8').trim().split('\r\n');

    expect(lines[0]).toContain('orderNumber');
    expect(lines).toHaveLength(3);
    // Money stays in minor units, unformatted, for a spreadsheet.
    expect(file.content.toString('utf8')).toContain('100000');
  });

  /**
   * A cell starting with = is executed as a formula by spreadsheet software.
   * Neutralising it is the difference between an export and an attack vector.
   */
  it('neutralises a formula injection in a text field', async () => {
    await prisma.customerProfile.update({
      where: { id: customerProfileId },
      data: { fullName: '=1+1+cmd|calc' },
    });

    const { exportJobId } = await requestExport({
      type: ExportType.CUSTOMERS,
      actorUserId: adminId,
      actorEmail: 'admin@rep.test',
    });
    await generateExport(exportJobId);

    const state = await getExportStatus(exportJobId, adminId);
    const csv = (await downloadExport(state.downloadToken ?? '')).content.toString('utf8');

    expect(csv).toContain("'=1+1+cmd|calc");
    expect(csv).not.toMatch(/(^|,)=1\+1/m);
  });

  it('escapes commas and quotes so columns do not shift', async () => {
    await prisma.customerProfile.update({
      where: { id: customerProfileId },
      data: { fullName: 'Sharma, Deepak "DK"', organization: 'Acme, Inc.' },
    });

    const { exportJobId } = await requestExport({
      type: ExportType.CUSTOMERS,
      actorUserId: adminId,
      actorEmail: 'admin@rep.test',
    });
    await generateExport(exportJobId);

    const state = await getExportStatus(exportJobId, adminId);
    const csv = (await downloadExport(state.downloadToken ?? '')).content.toString('utf8');

    expect(csv).toContain('"Sharma, Deepak ""DK"""');
  });

  it('never exports internal notes about a customer', async () => {
    await prisma.customerProfile.update({
      where: { id: customerProfileId },
      data: { internalNotes: 'SENSITIVE STAFF COMMENTARY' },
    });

    const { exportJobId } = await requestExport({
      type: ExportType.CUSTOMERS,
      actorUserId: adminId,
      actorEmail: 'admin@rep.test',
    });
    await generateExport(exportJobId);

    const state = await getExportStatus(exportJobId, adminId);
    const csv = (await downloadExport(state.downloadToken ?? '')).content.toString('utf8');

    expect(csv).not.toContain('SENSITIVE STAFF COMMENTARY');
  });

  it('stores only the hash of the download token', async () => {
    const { exportJobId } = await requestOrdersExport();
    await generateExport(exportJobId);

    const state = await getExportStatus(exportJobId, adminId);
    const job = await prisma.exportJob.findUniqueOrThrow({ where: { id: exportJobId } });

    expect(job.downloadTokenHash).not.toBe(state.downloadToken);
    expect(job.downloadTokenHash).toHaveLength(64);
  });

  /** One admin's export of customer data is not another's to collect. */
  it('scopes an export to the admin who requested it', async () => {
    const { exportJobId } = await requestOrdersExport();
    const otherAdminId = newId();

    await expect(getExportStatus(exportJobId, otherAdminId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects an unknown or expired download token', async () => {
    await expect(downloadExport('not-a-real-token')).rejects.toMatchObject({
      code: 'EXPORT_NOT_READY',
    });

    const { exportJobId } = await requestOrdersExport();
    await generateExport(exportJobId);
    const state = await getExportStatus(exportJobId, adminId);

    await prisma.exportJob.update({
      where: { id: exportJobId },
      data: { downloadExpiresAt: new Date(Date.now() - 1000) },
    });

    await expect(downloadExport(state.downloadToken ?? '')).rejects.toMatchObject({
      code: 'EXPORT_NOT_READY',
    });
  });

  it('is idempotent - a redelivered job does not rebuild the file', async () => {
    await makeOrder({ status: 'CONFIRMED', grandTotalMinor: 100_000n });

    const { exportJobId } = await requestOrdersExport();
    await generateExport(exportJobId);
    const first = await getExportStatus(exportJobId, adminId);

    await generateExport(exportJobId);
    const second = await getExportStatus(exportJobId, adminId);

    // The link somebody may already be using stays valid.
    expect(second.downloadToken).toBe(first.downloadToken);
  });

  /** Export files hold personal data and must not outlive their window. */
  it('purges the file once the download window closes', async () => {
    const { exportJobId } = await requestOrdersExport();
    await generateExport(exportJobId);

    await prisma.exportJob.update({
      where: { id: exportJobId },
      data: { downloadExpiresAt: new Date(Date.now() - 1000) },
    });

    expect(await purgeExpiredExports()).toBe(1);

    const job = await prisma.exportJob.findUniqueOrThrow({ where: { id: exportJobId } });
    expect(job.fileKey).toBeNull();
    expect(job.downloadTokenHash).toBeNull();
    // The job row survives as an audit record.
    expect(job.status).toBe('SUCCEEDED');
  });

  it('audits the request, because exporting customer data is privileged', async () => {
    await requestExport({
      type: ExportType.CUSTOMERS,
      actorUserId: adminId,
      actorEmail: 'admin@rep.test',
    });

    const entry = await prisma.auditLog.findFirst({ where: { action: 'data.exported' } });
    expect(entry).not.toBeNull();
  });
});

describe('connector', () => {
  const actor = () => ({ userId: adminId, email: 'admin@rep.test' });

  /** Credentials travel on every call; plain HTTP would put them on the wire. */
  it('refuses a non-HTTPS endpoint', async () => {
    await expect(
      createConnector(
        {
          name: 'Insecure feed',
          baseUrl: 'http://supplier.example.com/products',
          authType: 'NONE',
          fieldMapping: { sku: 'sku' },
        },
        actor(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('allows a local endpoint for development', async () => {
    const result = await createConnector(
      {
        name: 'Local feed',
        baseUrl: 'http://localhost:9999/products',
        authType: 'NONE',
        fieldMapping: { sku: 'sku' },
      },
      actor(),
    );
    expect(result.connectionId).toBeTruthy();
  });

  it('requires a SKU mapping, since it is the match key', async () => {
    await expect(
      createConnector(
        {
          name: 'Feed',
          baseUrl: 'https://supplier.example.com/products',
          authType: 'NONE',
          fieldMapping: { sku: '   ' },
        },
        actor(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('encrypts credentials and never stores them in plaintext', async () => {
    const { connectionId } = await createConnector(
      {
        name: 'Authed feed',
        baseUrl: 'https://supplier.example.com/products',
        authType: 'BEARER_TOKEN',
        credentials: { token: 'super-secret-token-value' },
        fieldMapping: { sku: 'sku' },
      },
      actor(),
    );

    const row = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });

    expect(row.credentialsEnc).not.toContain('super-secret-token-value');
    expect(row.credentialsEnc?.startsWith('v1:')).toBe(true);
    // Only a mask reaches the admin UI.
    expect(row.credentialsMask).not.toBe('super-secret-token-value');
  });

  it('starts inactive until a test has passed', async () => {
    const { connectionId } = await createConnector(
      {
        name: 'Feed',
        baseUrl: 'https://supplier.example.com/products',
        authType: 'NONE',
        fieldMapping: { sku: 'sku' },
      },
      actor(),
    );

    const row = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    expect(row.isActive).toBe(false);
  });

  /** An unreachable remote must fail the run, not hang or half-apply it. */
  it('records a failed run when the remote is unreachable', async () => {
    const { connectionId } = await createConnector(
      {
        name: 'Dead feed',
        baseUrl: 'http://localhost:9/products',
        authType: 'NONE',
        fieldMapping: { sku: 'sku' },
        timeoutMs: 1000,
      },
      actor(),
    );

    await expect(
      runSync({ connectionId, dryRun: true, triggeredBy: 'test' }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_TEST_FAILED' });

    const run = await prisma.syncRun.findFirstOrThrow();
    expect(run.status).toBe('FAILED');
    expect(run.errorMessage).toBeTruthy();

    // And the failure counted toward the circuit breaker.
    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    expect(connection.consecutiveFailures).toBe(1);
  });

  it('opens the circuit after repeated failures', async () => {
    const { connectionId } = await createConnector(
      {
        name: 'Dead feed',
        baseUrl: 'http://localhost:9/products',
        authType: 'NONE',
        fieldMapping: { sku: 'sku' },
        timeoutMs: 500,
      },
      actor(),
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await runSync({ connectionId, dryRun: true, triggeredBy: 'test' }).catch(() => undefined);
    }

    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    expect(connection.circuitState).toBe('OPEN');

    // Further calls are refused outright rather than timing out again.
    await expect(
      runSync({ connectionId, dryRun: true, triggeredBy: 'test' }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_CIRCUIT_OPEN' });
  });
});
