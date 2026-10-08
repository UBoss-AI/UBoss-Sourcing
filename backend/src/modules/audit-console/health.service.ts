/**
 * Seller health and quality insights for the Audit Console (audit staff only).
 *
 *   - `sellerHealthMap` gathers, in a fixed number of grouped queries, the
 *     counts each seller's health rating is made of and rates them with the
 *     pure rule in `domain/seller-health.ts` (Amazon's Account Health model).
 *   - `qualityInsights` is the analytics screen (QIMA's "quality insights"):
 *     pass/fail by month, defects by severity, the most frequent findings,
 *     the best and worst suppliers, and how each agency performs.
 *
 * Every figure is a count of rows the console can already open one by one.
 */
import {
  EMPTY_SIGNALS,
  EXPIRY_WARNING_DAYS,
  HEALTH_BANDS,
  INSPECTION_WINDOW_DAYS,
  rateSellerHealth,
  type HealthBand,
  type HealthSignals,
  type SellerHealth,
} from '../../domain/seller-health.js';
import { prisma } from '../../infra/prisma.js';

const DAY = 86_400_000;

/** Statuses of an inspection requirement whose goods are held. */
const HELD_REQUIREMENT_STATUSES = ['FAILED', 'BLOCKED_BY_NCR'] as const;

/**
 * Health for the given sellers, or for every active seller when `ids` is null.
 * A seller with nothing against them is rated from empty signals, so every
 * requested id is in the map.
 */
export async function sellerHealthMap(ids: readonly string[] | null, now: Date = new Date()): Promise<Map<string, SellerHealth>> {
  const sellerIds =
    ids === null ? (await prisma.sellerAccount.findMany({ where: { archivedAt: null }, select: { id: true } })).map((row) => row.id) : [...ids];
  const result = new Map<string, SellerHealth>();
  if (sellerIds.length === 0) return result;

  const inSellers = { in: sellerIds };
  const windowStart = new Date(now.getTime() - INSPECTION_WINDOW_DAYS * DAY);
  const expiryHorizon = new Date(now.getTime() + EXPIRY_WARNING_DAYS * DAY);
  const liveDocument = { sellerAccountId: inSellers, archivedAt: null, supersededAt: null };

  const [defects, held, cases, documents, expiredByDate, expiring, lapsedChecks, reports] = await Promise.all([
    prisma.inspectionDefect.findMany({
      where: { status: 'OPEN', job: { status: 'COMPLETED', requirement: { sellerAccountId: inSellers } } },
      select: { severity: true, job: { select: { requirement: { select: { sellerAccountId: true } } } } },
    }),
    prisma.inspectionRequirement.groupBy({
      by: ['sellerAccountId'],
      where: { sellerAccountId: inSellers, status: { in: [...HELD_REQUIREMENT_STATUSES] } },
      _count: true,
    }),
    prisma.complianceCase.groupBy({
      by: ['sellerAccountId', 'status'],
      where: { sellerAccountId: inSellers, status: { in: ['SUSPENDED', 'EXPIRED', 'REREVIEW_REQUIRED', 'CHANGES_REQUESTED'] } },
      _count: true,
    }),
    prisma.sellerCertification.groupBy({
      by: ['sellerAccountId', 'reviewStatus'],
      where: { ...liveDocument, reviewStatus: { in: ['SUSPENDED', 'EXPIRED', 'REJECTED', 'CHANGES_REQUESTED'] } },
      _count: true,
    }),
    // Approved but already past its date: expired in fact, even before the
    // nightly sweep moves its status.
    prisma.sellerCertification.groupBy({
      by: ['sellerAccountId'],
      where: { ...liveDocument, reviewStatus: 'APPROVED', expiresOn: { lt: now } },
      _count: true,
    }),
    prisma.sellerCertification.groupBy({
      by: ['sellerAccountId'],
      where: { ...liveDocument, reviewStatus: 'APPROVED', expiresOn: { gte: now, lte: expiryHorizon } },
      _count: true,
    }),
    prisma.sellerTrustCheck.groupBy({
      by: ['sellerAccountId'],
      where: { sellerAccountId: inSellers, isCurrent: true, state: { in: ['EXPIRED', 'REJECTED'] } },
      _count: true,
    }),
    prisma.inspectionReport.findMany({
      where: { status: 'SIGNED', supersededAt: null, signedAt: { gte: windowStart }, job: { requirement: { sellerAccountId: inSellers } } },
      select: { result: true, job: { select: { requirement: { select: { sellerAccountId: true } } } } },
    }),
  ]);

  const signals = new Map<string, HealthSignals>(sellerIds.map((id) => [id, { ...EMPTY_SIGNALS }]));
  const add = (sellerId: string, key: keyof HealthSignals, count: number): void => {
    const row = signals.get(sellerId);
    if (row !== undefined) row[key] += count;
  };

  for (const defect of defects) {
    const key = defect.severity === 'CRITICAL' ? 'criticalNcrsOpen' : defect.severity === 'MAJOR' ? 'majorNcrsOpen' : 'minorNcrsOpen';
    add(defect.job.requirement.sellerAccountId, key, 1);
  }
  for (const row of held) add(row.sellerAccountId, 'lotsHeld', row._count);
  const caseKey = { SUSPENDED: 'casesSuspended', EXPIRED: 'casesExpired', REREVIEW_REQUIRED: 'casesRereview', CHANGES_REQUESTED: 'casesChangesRequested' } as const;
  for (const row of cases) {
    const key = caseKey[row.status as keyof typeof caseKey];
    if (key !== undefined) add(row.sellerAccountId, key, row._count);
  }
  const documentKey = {
    SUSPENDED: 'documentsSuspended',
    EXPIRED: 'documentsExpired',
    REJECTED: 'documentsRejected',
    CHANGES_REQUESTED: 'documentsChangesRequested',
  } as const;
  for (const row of documents) {
    const key = documentKey[row.reviewStatus as keyof typeof documentKey];
    if (key !== undefined) add(row.sellerAccountId, key, row._count);
  }
  for (const row of expiredByDate) add(row.sellerAccountId, 'documentsExpired', row._count);
  for (const row of expiring) add(row.sellerAccountId, 'documentsExpiring', row._count);
  for (const row of lapsedChecks) add(row.sellerAccountId, 'identityChecksLapsed', row._count);
  for (const report of reports) {
    const key = report.result === 'PASS' ? 'reportsPassed' : report.result === 'FAIL' ? 'reportsFailed' : 'reportsInconclusive';
    add(report.job.requirement.sellerAccountId, key, 1);
  }

  for (const [id, row] of signals) result.set(id, rateSellerHealth(row));
  return result;
}

export async function sellerHealth(sellerAccountId: string, now: Date = new Date()): Promise<SellerHealth> {
  const map = await sellerHealthMap([sellerAccountId], now);
  return map.get(sellerAccountId) ?? rateSellerHealth({ ...EMPTY_SIGNALS });
}

// ---------------------------------------------------------------------------
// Quality insights
// ---------------------------------------------------------------------------

const MONTHS = 12;
const TOP_FINDINGS = 10;
const RANKED_SUPPLIERS = 5;

/** "2026-10" for the month a date falls in, in UTC. */
const monthKey = (date: Date): string => date.toISOString().slice(0, 7);

const percent = (part: number, whole: number): number | null => (whole === 0 ? null : Math.round((part * 100) / whole));

export async function qualityInsights(options: { includeHealth: boolean }, now: Date = new Date()) {
  const firstMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS - 1), 1));

  const [reports, defects, findings, jobs] = await Promise.all([
    prisma.inspectionReport.findMany({
      where: { status: 'SIGNED', supersededAt: null, signedAt: { gte: firstMonth } },
      select: {
        result: true,
        signedAt: true,
        job: {
          select: {
            agencyId: true,
            requirement: { select: { sellerAccountId: true, sellerOrderGroup: { select: { sellerAccount: { select: { displayName: true } } } } } },
          },
        },
      },
    }),
    prisma.inspectionDefect.groupBy({
      by: ['severity', 'status'],
      where: { recordedAt: { gte: firstMonth }, job: { status: 'COMPLETED' } },
      _count: true,
    }),
    prisma.inspectionDefect.groupBy({
      by: ['requirementRef'],
      where: { recordedAt: { gte: firstMonth }, job: { status: 'COMPLETED' } },
      _count: { _all: true },
      orderBy: { _count: { requirementRef: 'desc' } },
      take: TOP_FINDINGS,
    }),
    prisma.inspectionJob.findMany({
      where: { status: 'COMPLETED', updatedAt: { gte: firstMonth } },
      select: { agencyId: true, reportDueAt: true, agency: { select: { name: true, kind: true } }, reports: { where: { status: 'SIGNED' }, select: { signedAt: true }, orderBy: { revision: 'asc' }, take: 1 } },
    }),
  ]);

  // Month by month, oldest first, every month present even when empty.
  const months = Array.from({ length: MONTHS }, (_, index) => {
    const date = new Date(Date.UTC(firstMonth.getUTCFullYear(), firstMonth.getUTCMonth() + index, 1));
    return { month: monthKey(date), pass: 0, fail: 0, inconclusive: 0 };
  });
  const monthIndex = new Map(months.map((row, index) => [row.month, index]));
  const suppliers = new Map<string, { sellerAccountId: string; name: string; pass: number; reports: number }>();
  const agencyResults = new Map<string, { pass: number; reports: number }>();

  for (const report of reports) {
    if (report.signedAt === null) continue;
    const row = months[monthIndex.get(monthKey(report.signedAt)) ?? -1];
    const passed = report.result === 'PASS';
    if (row !== undefined) {
      if (passed) row.pass += 1;
      else if (report.result === 'FAIL') row.fail += 1;
      else row.inconclusive += 1;
    }
    const sellerId = report.job.requirement.sellerAccountId;
    const supplier = suppliers.get(sellerId) ?? {
      sellerAccountId: sellerId,
      name: report.job.requirement.sellerOrderGroup.sellerAccount.displayName,
      pass: 0,
      reports: 0,
    };
    supplier.reports += 1;
    if (passed) supplier.pass += 1;
    suppliers.set(sellerId, supplier);
    const agency = agencyResults.get(report.job.agencyId) ?? { pass: 0, reports: 0 };
    agency.reports += 1;
    if (passed) agency.pass += 1;
    agencyResults.set(report.job.agencyId, agency);
  }

  const totals = months.reduce((sum, row) => ({ pass: sum.pass + row.pass, fail: sum.fail + row.fail, inconclusive: sum.inconclusive + row.inconclusive }), {
    pass: 0,
    fail: 0,
    inconclusive: 0,
  });
  const reportCount = totals.pass + totals.fail + totals.inconclusive;

  const severity = { CRITICAL: 0, MAJOR: 0, MINOR: 0 };
  const ncrStatus = { OPEN: 0, CAPA_SUBMITTED: 0, VERIFIED_CLOSED: 0 };
  for (const row of defects) {
    severity[row.severity] += row._count;
    ncrStatus[row.status] += row._count;
  }

  const supplierRows = [...suppliers.values()].map((row) => ({ ...row, passRatePercent: percent(row.pass, row.reports) ?? 0 }));
  const best = [...supplierRows].sort((a, b) => b.passRatePercent - a.passRatePercent || b.reports - a.reports).slice(0, RANKED_SUPPLIERS);
  const worst = [...supplierRows]
    .filter((row) => row.passRatePercent < 100)
    .sort((a, b) => a.passRatePercent - b.passRatePercent || b.reports - a.reports)
    .slice(0, RANKED_SUPPLIERS);

  const agencies = new Map<string, { agencyId: string; name: string; kind: string; completed: number; onTime: number }>();
  for (const job of jobs) {
    const row = agencies.get(job.agencyId) ?? { agencyId: job.agencyId, name: job.agency.name, kind: job.agency.kind, completed: 0, onTime: 0 };
    row.completed += 1;
    const signedAt = job.reports[0]?.signedAt ?? null;
    if (signedAt !== null && signedAt.getTime() <= job.reportDueAt.getTime()) row.onTime += 1;
    agencies.set(job.agencyId, row);
  }

  let health: { bands: Record<HealthBand, number>; sellers: number } | null = null;
  if (options.includeHealth) {
    const map = await sellerHealthMap(null, now);
    const bands = Object.fromEntries(HEALTH_BANDS.map((band) => [band, 0])) as Record<HealthBand, number>;
    for (const rating of map.values()) bands[rating.band] += 1;
    health = { bands, sellers: map.size };
  }

  return {
    from: firstMonth.toISOString().slice(0, 10),
    reports: { ...totals, total: reportCount, passRatePercent: percent(totals.pass, reportCount) },
    months,
    defects: { bySeverity: severity, byStatus: ncrStatus, total: severity.CRITICAL + severity.MAJOR + severity.MINOR },
    topFindings: findings.map((row) => ({ requirementRef: row.requirementRef, count: row._count._all })),
    suppliers: { best, worst, ranked: supplierRows.length },
    agencies: [...agencies.values()]
      .map((row) => {
        const results = agencyResults.get(row.agencyId) ?? { pass: 0, reports: 0 };
        return {
          ...row,
          onTimePercent: percent(row.onTime, row.completed),
          reports: results.reports,
          passRatePercent: percent(results.pass, results.reports),
        };
      })
      .sort((a, b) => b.completed - a.completed),
    health,
  };
}
