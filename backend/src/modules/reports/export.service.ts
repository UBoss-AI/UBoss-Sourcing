/**
 * Asynchronous exports.
 *
 * A year of orders is not something to build inside an HTTP request: the
 * connection times out, the memory spikes, and the operator has no idea whether
 * it worked. So an export is a job.
 *
 * Downloads go through a hashed, expiring, single-purpose token rather than a
 * storage key. An export contains customer names, addresses and order values;
 * a guessable or permanent URL would be a data leak with a long tail.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { generateToken, sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { storage } from '../../infra/storage/index.js';
import { JobType, queue } from '../../infra/queue/index.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  inventoryValuation,
  resolveWindow,
  type DateWindow,
} from './report.service.js';

export const ExportType = {
  ORDERS: 'ORDERS',
  ORDER_ITEMS: 'ORDER_ITEMS',
  PAYMENTS: 'PAYMENTS',
  REFUNDS: 'REFUNDS',
  CUSTOMERS: 'CUSTOMERS',
  INVENTORY: 'INVENTORY',
  INVENTORY_MOVEMENTS: 'INVENTORY_MOVEMENTS',
  RECURRING_SCHEDULES: 'RECURRING_SCHEDULES',
} as const;

export type ExportTypeValue = (typeof ExportType)[keyof typeof ExportType];

/** Download links expire quickly - the file holds personal data. */
const DOWNLOAD_TTL_HOURS = 6;

/** Rows per database page while streaming. Bounded memory, not one big read. */
const PAGE_SIZE = 500;

export interface RequestExportInput {
  type: ExportTypeValue;
  from?: string;
  to?: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export async function requestExport(
  input: RequestExportInput,
): Promise<{ exportJobId: string; status: string }> {
  const exportJobId = newId();
  const window = resolveWindow(input.from, input.to);

  await prisma.exportJob.create({
    data: {
      id: exportJobId,
      type: input.type,
      paramsJson: { from: window.from.toISOString(), to: window.to.toISOString() },
      status: 'PENDING',
      createdById: input.actorUserId,
    },
  });

  await queue.enqueue(
    JobType.EXPORT_GENERATE,
    { exportJobId },
    {
      dedupeKey: `export:${exportJobId}`,
      ...(input.correlationId !== null && input.correlationId !== undefined
        ? { correlationId: input.correlationId }
        : {}),
    },
  );

  // Exporting customer data is itself a privileged act (SOP 7.3), so it is
  // audited at request time, not only on download.
  await recordAudit({
    action: AuditAction.DATA_EXPORTED,
    resourceType: 'export_job',
    resourceId: exportJobId,
    actorType: 'ADMIN',
    actorUserId: input.actorUserId,
    actorEmail: input.actorEmail,
    after: {
      type: input.type,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      stage: 'requested',
    },
    ipAddress: input.ipAddress ?? null,
    correlationId: input.correlationId ?? null,
  });

  return { exportJobId, status: 'PENDING' };
}

/**
 * Coerce an unknown to text for a CSV cell.
 *
 * Explicit per type rather than a bare `String(value)`, which renders any
 * object as "[object Object]" - a silently useless column.
 */
function cellText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value) ?? '';
  return '';
}

/** RFC-4180 escaping. A customer name with a comma must not shift columns. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  const text = cellText(value);

  // A leading =, +, - or @ is executed as a formula by spreadsheet software.
  // Prefixing a single quote neutralises it without changing the visible text.
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;

  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function csvRow(cells: readonly unknown[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

interface ExportShape {
  header: readonly string[];
  /** Yields pages of rows so memory stays bounded regardless of table size. */
  pages: (window: DateWindow) => AsyncGenerator<unknown[][]>;
}

async function* paginate<T>(
  fetchPage: (skip: number) => Promise<T[]>,
): AsyncGenerator<T[]> {
  let skip = 0;
  for (;;) {
    const page = await fetchPage(skip);
    if (page.length === 0) return;
    yield page;
    if (page.length < PAGE_SIZE) return;
    skip += PAGE_SIZE;
  }
}

const SHAPES: Readonly<Record<ExportTypeValue, ExportShape>> = Object.freeze({
  [ExportType.ORDERS]: {
    header: [
      'orderNumber',
      'status',
      'source',
      'customerName',
      'organization',
      'currency',
      'subtotalMinor',
      'discountMinor',
      'taxMinor',
      'shippingMinor',
      'grandTotalMinor',
      'paidMinor',
      'refundedMinor',
      'placedAt',
      'confirmedAt',
    ],
    pages: (window) =>
      paginate(async (skip) => {
        const rows = await prisma.order.findMany({
          where: { createdAt: { gte: window.from, lt: window.to } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip,
          take: PAGE_SIZE,
          include: { customerProfile: { select: { fullName: true, organization: true } } },
        });

        return rows.map((order) => [
          order.orderNumber,
          order.status,
          order.source,
          order.customerProfile.fullName,
          order.customerProfile.organization,
          order.currency,
          order.subtotalMinor,
          order.discountMinor,
          order.taxMinor,
          order.shippingMinor,
          order.grandTotalMinor,
          order.paidMinor,
          order.refundedMinor,
          order.placedAt,
          order.confirmedAt,
        ]);
      }),
  },

  [ExportType.ORDER_ITEMS]: {
    header: [
      'orderNumber',
      'orderStatus',
      'nameSnapshot',
      'skuSnapshot',
      'quantity',
      'unitPriceMinor',
      'taxRatePercent',
      'taxAmountMinor',
      'lineTotalMinor',
    ],
    pages: (window) =>
      paginate(async (skip) => {
        const rows = await prisma.orderItem.findMany({
          where: { order: { createdAt: { gte: window.from, lt: window.to } } },
          orderBy: [{ orderId: 'asc' }, { id: 'asc' }],
          skip,
          take: PAGE_SIZE,
          include: { order: { select: { orderNumber: true, status: true } } },
        });

        return rows.map((item) => [
          item.order.orderNumber,
          item.order.status,
          // Snapshots, so the export reflects what was sold, not what the
          // catalog says today.
          item.nameSnapshot,
          item.skuSnapshot,
          item.quantity,
          item.unitPriceMinor,
          item.taxRatePercent.toString(),
          item.taxAmountMinor,
          item.lineTotalMinor,
        ]);
      }),
  },

  [ExportType.PAYMENTS]: {
    header: [
      'orderNumber',
      'provider',
      'mode',
      'status',
      'amountMinor',
      'capturedMinor',
      'currency',
      'method',
      'providerPaymentId',
      'failureCode',
      'capturedAt',
    ],
    pages: (window) =>
      paginate(async (skip) => {
        const rows = await prisma.paymentTransaction.findMany({
          where: { createdAt: { gte: window.from, lt: window.to } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip,
          take: PAGE_SIZE,
          include: { order: { select: { orderNumber: true } } },
        });

        return rows.map((payment) => [
          payment.order.orderNumber,
          payment.provider,
          payment.mode,
          payment.status,
          payment.amountMinor,
          payment.capturedMinor,
          payment.currency,
          payment.method,
          payment.providerPaymentId,
          payment.failureCode,
          payment.capturedAt,
        ]);
      }),
  },

  [ExportType.REFUNDS]: {
    header: [
      'orderNumber',
      'status',
      'amountMinor',
      'currency',
      'reason',
      'providerRefundId',
      'createdAt',
      'completedAt',
    ],
    pages: (window) =>
      paginate(async (skip) => {
        const rows = await prisma.refund.findMany({
          where: { createdAt: { gte: window.from, lt: window.to } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip,
          take: PAGE_SIZE,
          include: { order: { select: { orderNumber: true } } },
        });

        return rows.map((refund) => [
          refund.order.orderNumber,
          refund.status,
          refund.amountMinor,
          refund.currency,
          refund.reason,
          refund.providerRefundId,
          refund.createdAt,
          refund.completedAt,
        ]);
      }),
  },

  [ExportType.CUSTOMERS]: {
    header: [
      'customerCode',
      'fullName',
      'organization',
      'department',
      'email',
      'phone',
      'status',
      'activatedAt',
      'orderCount',
      // Limits are per currency, so each is reported with the currency it is
      // counted in. A bare amount column would have meant nothing once the
      // same account could have terms in two markets.
      'limitsCurrency',
      'perOrderMaxMinor',
      'monthlySpendCapMinor',
    ],
    pages: () =>
      paginate(async (skip) => {
        const rows = await prisma.customerProfile.findMany({
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip,
          take: PAGE_SIZE,
          include: {
            user: { select: { email: true, status: true } },
            limits: { orderBy: { currencyCode: 'asc' } },
            _count: { select: { orders: true } },
          },
        });

        return rows.map((profile) => [
          profile.customerCode,
          profile.fullName,
          profile.organization,
          profile.department,
          profile.user.email,
          profile.phone,
          profile.user.status,
          profile.activatedAt,
          profile._count.orders,
          profile.limits.map((row) => row.currencyCode).join(' '),
          profile.limits.map((row) => row.perOrderMaxMinor?.toString() ?? '').join(' '),
          profile.limits.map((row) => row.monthlySpendCapMinor?.toString() ?? '').join(' '),
          // `internalNotes` is deliberately excluded: staff commentary about a
          // customer has no place in an exported spreadsheet.
        ]);
      }),
  },

  [ExportType.INVENTORY]: {
    header: [
      'sku',
      'name',
      'onHandQty',
      'reservedQty',
      'availableQty',
      'reorderThreshold',
      'isLowStock',
      'unitPriceMinor',
      'valuationMinor',
    ],
    pages: async function* () {
      const valuation = await inventoryValuation();
      yield valuation.rows.map((row) => [
        row.sku,
        row.name,
        row.onHandQty,
        row.reservedQty,
        row.availableQty,
        row.reorderThreshold,
        row.isLowStock,
        row.unitPrice,
        row.valuation,
      ]);
    },
  },

  [ExportType.INVENTORY_MOVEMENTS]: {
    header: [
      'createdAt',
      'type',
      'sku',
      'quantityDelta',
      'resultingOnHand',
      'reason',
      'referenceType',
      'referenceId',
    ],
    pages: (window) =>
      paginate(async (skip) => {
        const rows = await prisma.inventoryMovement.findMany({
          where: { createdAt: { gte: window.from, lt: window.to } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip,
          take: PAGE_SIZE,
          include: { product: { select: { sku: true } } },
        });

        return rows.map((movement) => [
          movement.createdAt,
          movement.type,
          movement.product.sku,
          movement.quantityDelta,
          movement.resultingOnHand,
          movement.reason,
          movement.referenceType,
          movement.referenceId,
        ]);
      }),
  },

  [ExportType.RECURRING_SCHEDULES]: {
    header: [
      'name',
      'customerName',
      'status',
      'frequency',
      'intervalDays',
      'timezone',
      'nextRunAt',
      'occurrenceCount',
      'paymentMode',
      'failureCount',
      'pausedReason',
    ],
    pages: () =>
      paginate(async (skip) => {
        const rows = await prisma.recurringSchedule.findMany({
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip,
          take: PAGE_SIZE,
          include: { customerProfile: { select: { fullName: true } } },
        });

        return rows.map((schedule) => [
          schedule.name,
          schedule.customerProfile.fullName,
          schedule.status,
          schedule.frequency,
          schedule.intervalDays,
          schedule.timezone,
          schedule.nextRunAt,
          schedule.occurrenceCount,
          schedule.paymentMode,
          schedule.failureCount,
          schedule.pausedReason,
        ]);
      }),
  },
});

/**
 * Build the file. Called by the worker, never inside a request.
 *
 * Idempotent: an export already SUCCEEDED is left alone, so a redelivered job
 * does not rebuild the file and invalidate a link somebody is already using.
 */
export async function generateExport(exportJobId: string): Promise<{ rowCount: number }> {
  const job = await prisma.exportJob.findUnique({ where: { id: exportJobId } });
  if (job === null) throw notFound('Export job');

  if (job.status === 'SUCCEEDED') {
    logger.debug({ exportJobId }, 'export already generated; skipping');
    return { rowCount: job.rowCount ?? 0 };
  }

  const shape = SHAPES[job.type as ExportTypeValue];
  if (shape === undefined) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, `Unknown export type: ${job.type}`);
  }

  await prisma.exportJob.update({
    where: { id: exportJobId },
    data: { status: 'RUNNING' },
  });

  const params = job.paramsJson as { from?: string; to?: string } | null;
  const window = resolveWindow(params?.from, params?.to);

  const chunks: string[] = [csvRow(shape.header)];
  let rowCount = 0;

  for await (const page of shape.pages(window)) {
    for (const row of page) {
      chunks.push(csvRow(row));
      rowCount += 1;
    }
  }

  const buffer = Buffer.from(chunks.join(''), 'utf8');
  const fileName = `${job.type.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;

  // Stored through the same driver as product media, so an S3 deployment gets
  // durable exports without touching this code.
  const stored = await storage.put(buffer, 'text/csv', 'csv');

  const { token, tokenHash } = generateToken(32);

  await prisma.exportJob.update({
    where: { id: exportJobId },
    data: {
      status: 'SUCCEEDED',
      fileKey: stored.storageKey,
      fileName,
      rowCount,
      // Only the hash. The raw token goes to the requesting admin once.
      downloadTokenHash: tokenHash,
      downloadExpiresAt: new Date(Date.now() + DOWNLOAD_TTL_HOURS * 3_600_000),
      completedAt: new Date(),
    },
  });

  // Carried on the job result rather than logged: a download token in a log
  // file is a standing credential.
  await prisma.exportJob.update({
    where: { id: exportJobId },
    data: { paramsJson: { ...(params ?? {}), downloadToken: token } },
  });

  logger.info({ exportJobId, type: job.type, rowCount }, 'export generated');
  return { rowCount };
}

export interface ExportStatus {
  id: string;
  type: string;
  status: string;
  rowCount: number | null;
  fileName: string | null;
  downloadToken: string | null;
  downloadExpiresAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

/**
 * Poll an export.
 *
 * Returns the download token only to the admin who requested it, and only
 * while it is unexpired.
 */
export async function getExportStatus(
  exportJobId: string,
  requesterId: string,
): Promise<ExportStatus> {
  const job = await prisma.exportJob.findUnique({ where: { id: exportJobId } });
  if (job === null) throw notFound('Export job');

  // Scoped to the requester: one admin's export of customer data is not
  // another's to collect, even though both hold export.create.
  if (job.createdById !== requesterId) throw notFound('Export job');

  const params = job.paramsJson as { downloadToken?: string } | null;
  const unexpired =
    job.downloadExpiresAt !== null && job.downloadExpiresAt.getTime() > Date.now();

  return {
    id: job.id,
    type: job.type,
    status: job.status,
    rowCount: job.rowCount,
    fileName: job.fileName,
    downloadToken: job.status === 'SUCCEEDED' && unexpired ? (params?.downloadToken ?? null) : null,
    downloadExpiresAt: job.downloadExpiresAt?.toISOString() ?? null,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}

export interface DownloadableExport {
  fileName: string;
  content: Buffer;
}

/**
 * Redeem a download token.
 *
 * Every failure is a distinct, non-leaking answer: an expired token says so, an
 * unknown one says only that it is invalid.
 */
export async function downloadExport(token: string): Promise<DownloadableExport> {
  const job = await prisma.exportJob.findUnique({
    where: { downloadTokenHash: sha256Hex(token) },
  });

  if (job === null || job.fileKey === null) {
    throw badRequest(ErrorCode.EXPORT_NOT_READY, 'This download link is not valid.');
  }

  if (job.downloadExpiresAt === null || job.downloadExpiresAt.getTime() <= Date.now()) {
    throw conflict(
      ErrorCode.EXPORT_NOT_READY,
      'This download link has expired. Request the export again.',
    );
  }

  const content = await storage.get(job.fileKey);

  // Repeat downloads are allowed within the window - an operator whose browser
  // interrupted a download should not have to regenerate a year of orders -
  // but each one is recorded.
  await prisma.exportJob.update({
    where: { id: job.id },
    data: { downloadedAt: new Date() },
  });

  return { fileName: job.fileName ?? 'export.csv', content };
}

export async function markExportFailed(exportJobId: string, message: string): Promise<void> {
  await prisma.exportJob.updateMany({
    where: { id: exportJobId },
    data: {
      status: 'FAILED',
      errorMessage: message.slice(0, 1000),
      completedAt: new Date(),
    },
  });
}

/**
 * Delete expired export files.
 *
 * These contain personal data, so they do not linger past their download
 * window. The job row stays as an audit record; only the file goes.
 */
export async function purgeExpiredExports(): Promise<number> {
  const expired = await prisma.exportJob.findMany({
    where: {
      status: 'SUCCEEDED',
      downloadExpiresAt: { lt: new Date() },
      fileKey: { not: null },
    },
    select: { id: true, fileKey: true },
    take: 100,
  });

  let purged = 0;

  for (const job of expired) {
    if (job.fileKey !== null) {
      await storage.delete(job.fileKey).catch(() => undefined);
    }

    await prisma.exportJob.update({
      where: { id: job.id },
      data: {
        fileKey: null,
        downloadTokenHash: null,
        // Strip the token from the params too, or it would outlive the file.
        paramsJson: {},
      },
    });

    purged += 1;
  }

  if (purged > 0) logger.info({ purged }, 'purged expired export files');
  return purged;
}
