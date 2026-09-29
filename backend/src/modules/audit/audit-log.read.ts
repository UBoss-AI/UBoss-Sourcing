/**
 * Reading the audit trail back: the admin screen's page of entries, and the
 * CSV copy of the same filter.
 *
 * One mapping, `toAuditEntryView`, feeds both, so the file somebody hands an
 * auditor holds exactly the fields the screen showed them - no more (nothing
 * the screen redacts reappears in the file) and no less (nothing on the screen
 * is missing from the evidence).
 *
 * Nothing here writes to `audit_logs` except the one row that records an
 * export happened. The table is append-only by database grant; see
 * deploy/mariadb/post-migrate-grants.sql.
 */
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../infra/prisma.js';
import { csvRow } from '../reports/export.service.js';
import { AuditAction, recordAudit } from './audit.service.js';

/** The most entries one CSV download will hold. Narrow the filter for more. */
export const AUDIT_EXPORT_MAX_ROWS = 10_000;

/** Rows per database read while the file streams out. */
const EXPORT_PAGE_SIZE = 500;

export const AUDIT_EXPORT_ROWS_HEADER = 'X-Audit-Export-Rows';
export const AUDIT_EXPORT_TOTAL_HEADER = 'X-Audit-Export-Total';
export const AUDIT_EXPORT_HEADERS = [AUDIT_EXPORT_ROWS_HEADER, AUDIT_EXPORT_TOTAL_HEADER] as const;

/** The filter the screen offers, shared by the list and the export. */
export const auditFilterSchema = z.object({
  action: z.string().trim().min(1).max(96).optional(),
  resourceType: z.string().trim().min(1).max(48).optional(),
  resourceId: z.string().length(26).optional(),
  actorUserId: z.string().length(26).optional(),
  actorEmail: z.string().trim().min(1).max(320).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export type AuditFilter = z.infer<typeof auditFilterSchema>;

export function auditWhere(filter: AuditFilter): Prisma.AuditLogWhereInput {
  return {
    ...(filter.action !== undefined ? { action: filter.action } : {}),
    ...(filter.resourceType !== undefined ? { resourceType: filter.resourceType } : {}),
    ...(filter.resourceId !== undefined ? { resourceId: filter.resourceId } : {}),
    ...(filter.actorUserId !== undefined ? { actorUserId: filter.actorUserId } : {}),
    ...(filter.actorEmail !== undefined ? { actorEmail: filter.actorEmail } : {}),
    ...(filter.from !== undefined || filter.to !== undefined
      ? {
          createdAt: {
            ...(filter.from !== undefined ? { gte: new Date(filter.from) } : {}),
            ...(filter.to !== undefined ? { lt: new Date(filter.to) } : {}),
          },
        }
      : {}),
  };
}

const ORDER: Prisma.AuditLogOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'desc' }];

/** A browser and an operating system, named from a User-Agent header. */
export interface DeviceSummary {
  browser: string | null;
  os: string | null;
}

const BROWSERS: readonly [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
  [/^curl\//i, 'curl'],
  [/^PostmanRuntime\//, 'Postman'],
  [/^(?:node-fetch|undici|axios)\b/i, 'Script'],
  [/^lightMyRequest\b/, 'Test client'],
];

const SYSTEMS: readonly [RegExp, string][] = [
  [/\bWindows NT\b/, 'Windows'],
  [/\bAndroid\b/, 'Android'],
  [/\biPad\b/, 'iPadOS'],
  [/\b(?:iPhone|iPod)\b/, 'iOS'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

/**
 * "Chrome on Windows", as two parts, from the header the entry recorded.
 *
 * A summary for a person scanning a table - the full header is returned
 * beside it and written to the CSV unchanged, because the summary is an
 * interpretation and the header is the evidence. Null when nothing was
 * recorded; both parts null when the header names nothing recognisable.
 */
export function summariseUserAgent(userAgent: string | null): DeviceSummary | null {
  if (userAgent === null || userAgent.trim() === '') return null;
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
  const os = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
  return { browser, os };
}

/** Keys under which an entry's `after` carries why the act was done. */
const REASON_KEYS = ['reason', 'reasonCode', 'declineReason', 'rejectionReason'] as const;

/**
 * Why, if the entry says.
 *
 * There is no reason column: services that take a reason record it in
 * `after`, under one of a handful of names. This reads the first of those
 * that holds text. It never interprets - an entry with no stated reason says
 * none, rather than a guess from its action.
 */
export function reasonOf(after: unknown): string | null {
  if (typeof after !== 'object' || after === null || Array.isArray(after)) return null;
  const record = after as Record<string, unknown>;
  for (const key of REASON_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 500);
  }
  return null;
}

type AuditRow = Awaited<ReturnType<typeof prisma.auditLog.findMany>>[number];

export interface AuditEntryView {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorType: string;
  actorUserId: string | null;
  actorEmail: string | null;
  /** Role keys held when the entry was written. Null: none was recorded. */
  actorRoles: string[] | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  device: DeviceSummary | null;
  correlationId: string | null;
  createdAt: string;
}

export function toAuditEntryView(row: AuditRow): AuditEntryView {
  return {
    id: row.id,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    actorType: row.actorType,
    actorUserId: row.actorUserId,
    actorEmail: row.actorEmail,
    actorRoles:
      row.actorRoles === null || row.actorRoles === ''
        ? null
        : row.actorRoles.split(',').filter((key) => key !== ''),
    reason: reasonOf(row.afterJson),
    // Values were redacted on write; secrets are already [REDACTED].
    before: row.beforeJson,
    after: row.afterJson,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    device: summariseUserAgent(row.userAgent),
    correlationId: row.correlationId,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listAuditEntries(
  filter: AuditFilter,
  page: number,
  limit: number,
): Promise<{
  entries: AuditEntryView[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const where = auditWhere(filter);
  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: ORDER, skip: (page - 1) * limit, take: limit }),
    prisma.auditLog.count({ where }),
  ]);

  return {
    entries: rows.map(toAuditEntryView),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export const AUDIT_CSV_HEADER = [
  'createdAt',
  'action',
  'resourceType',
  'resourceId',
  'actorType',
  'actorEmail',
  'actorUserId',
  'actorRoles',
  'reason',
  'ipAddress',
  'device',
  'userAgent',
  'correlationId',
  'before',
  'after',
  'entryId',
] as const;

function deviceText(device: DeviceSummary | null): string {
  if (device === null) return '';
  if (device.browser !== null && device.os !== null) return `${device.browser} on ${device.os}`;
  return device.browser ?? device.os ?? '';
}

function csvLine(entry: AuditEntryView): string {
  return csvRow([
    entry.createdAt,
    entry.action,
    entry.resourceType,
    entry.resourceId,
    entry.actorType,
    entry.actorEmail,
    entry.actorUserId,
    entry.actorRoles?.join(' ') ?? '',
    entry.reason,
    entry.ipAddress,
    deviceText(entry.device),
    entry.userAgent,
    entry.correlationId,
    // JSON exactly as stored, so a cell can be compared with the screen.
    entry.before === null ? '' : JSON.stringify(entry.before),
    entry.after === null ? '' : JSON.stringify(entry.after),
    entry.id,
  ]);
}

export interface AuditExportActor {
  userId: string;
  email: string;
  ipAddress: string | null;
  userAgent: string | null;
  correlationId: string | null;
}

export interface AuditExport {
  fileName: string;
  /** How many entries the file holds: the matches, up to the cap. */
  rowCount: number;
  /** How many entries matched the filter. More than rowCount: the cap cut it. */
  total: number;
  stream: Readable;
}

/**
 * A CSV of the entries matching `filter`, newest first, at most
 * AUDIT_EXPORT_MAX_ROWS of them.
 *
 * The export is recorded BEFORE the file is produced, inside a transaction,
 * so an export that cannot be audited is never handed out - the one place
 * this module does not accept `recordAudit`'s best-effort mode. The row is
 * written with the count the file will hold; the entries are then read in
 * pages of 500, so memory stays bounded however large each entry is.
 *
 * The file is pinned to the moment of the request: entries written after it
 * - including this export's own entry - are not in it, and the next export
 * of the same filter shows that this one was taken.
 */
export async function exportAuditEntries(
  filter: AuditFilter,
  actor: AuditExportActor,
  /** Tests only: a smaller cap, so proving it does not take 10,001 rows. */
  options: { maxRows?: number } = {},
): Promise<AuditExport> {
  const maxRows = Math.min(options.maxRows ?? AUDIT_EXPORT_MAX_ROWS, AUDIT_EXPORT_MAX_ROWS);
  // Pinned before anything is counted or written, so the file holds what was
  // counted rather than a moving target, and never its own entry.
  const asOf = new Date();
  const bounded: Prisma.AuditLogWhereInput = {
    AND: [auditWhere(filter), { createdAt: { lte: asOf } }],
  };
  const total = await prisma.auditLog.count({ where: bounded });
  const rowCount = Math.min(total, maxRows);

  await prisma.$transaction(async (tx) => {
    await recordAudit(
      {
        action: AuditAction.AUDIT_EXPORTED,
        resourceType: 'audit_log',
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: {
          filter,
          rowCount,
          matched: total,
          truncated: total > rowCount,
          maxRows,
          asOf: asOf.toISOString(),
        },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        correlationId: actor.correlationId,
      },
      tx,
    );
  });

  async function* lines(): AsyncGenerator<string> {
    yield csvRow(AUDIT_CSV_HEADER);
    let written = 0;
    while (written < rowCount) {
      const rows = await prisma.auditLog.findMany({
        where: bounded,
        orderBy: ORDER,
        skip: written,
        take: Math.min(EXPORT_PAGE_SIZE, rowCount - written),
      });
      if (rows.length === 0) return;
      yield rows.map((row) => csvLine(toAuditEntryView(row))).join('');
      written += rows.length;
    }
  }

  return {
    fileName: `audit-log-${asOf.toISOString().slice(0, 10)}.csv`,
    rowCount,
    total,
    stream: Readable.from(lines()),
  };
}
