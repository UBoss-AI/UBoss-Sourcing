/**
 * The Admin Command Center's exception counts (JOURNEY-060).
 *
 * Each function counts one kind of thing that is wrong and still
 * outstanding. They are kept here, beside the rest of the operator's
 * governance tools, and wired into the operations overview, which gates each
 * by the permission that makes it actionable.
 */
import { prisma } from '../../infra/prisma.js';
import { trustTimings } from '../trust/factory.service.js';

const DAY_MS = 86_400_000;
/** A carrier failing this many times in a row is degraded, even before ERROR. */
const CARRIER_FAILURE_RUN = 3;

/** HIGH and CRITICAL risk signals nobody has reviewed. */
export function highRiskSignalsOpen(): Promise<number> {
  return prisma.riskSignal.count({ where: { status: 'OPEN', severity: { in: ['HIGH', 'CRITICAL'] } } });
}

/**
 * Inspections whose signed result is FAIL and that no re-inspection has since
 * passed. A failure followed by a passing re-inspection is resolved work.
 */
export async function failedInspectionsUnresolved(): Promise<number> {
  const failed = await prisma.inspectionJob.findMany({
    where: { status: 'COMPLETED', reports: { some: { status: 'SIGNED', result: 'FAIL' } } },
    select: { id: true },
    take: 5000,
  });
  if (failed.length === 0) return 0;
  const cleared = await prisma.inspectionJob.findMany({
    where: {
      reinspectionOfJobId: { in: failed.map((job) => job.id) },
      reports: { some: { status: 'SIGNED', result: 'PASS' } },
    },
    select: { reinspectionOfJobId: true },
  });
  const passed = new Set(cleared.map((job) => job.reinspectionOfJobId));
  return failed.filter((job) => !passed.has(job.id)).length;
}

/** Seller settlements and held funds placed on hold. */
export async function settlementsOnHold(): Promise<number> {
  const [settlements, holds] = await Promise.all([
    prisma.sellerSettlement.count({ where: { status: 'ON_HOLD' } }),
    prisma.sellerFundHold.count({ where: { status: 'ON_HOLD' } }),
  ]);
  return settlements + holds;
}

/**
 * Seller compliance documents and certificates that have lapsed or lapse
 * within the operator's warning window (trust settings, default 30 days).
 */
export async function complianceExpiring(now: Date = new Date()): Promise<number> {
  const { expiryWarningDays } = await trustTimings();
  const horizon = new Date(now.getTime() + expiryWarningDays * DAY_MS);
  const [documents, certificates] = await Promise.all([
    prisma.sellerDocument.count({
      where: { supersededAt: null, approvedAt: { not: null }, expiresOn: { not: null, lte: horizon } },
    }),
    prisma.sellerCertification.count({
      where: { archivedAt: null, state: { in: ['VERIFIED', 'EXPIRED'] }, expiresOn: { not: null, lte: horizon } },
    }),
  ]);
  return documents + certificates;
}

/** Carrier integrations in ERROR or failing repeatedly. */
export function carrierIntegrationsDegraded(): Promise<number> {
  return prisma.carrierIntegration.count({
    where: {
      isActive: true,
      state: { notIn: ['DISABLED', 'UNCONFIGURED'] },
      OR: [{ state: 'ERROR' }, { consecutiveFailures: { gte: CARRIER_FAILURE_RUN } }],
    },
  });
}

/** Buyers' ERP events that gave up after their retries, in the last week. */
export function customerErpEventsFailed(now: Date = new Date()): Promise<number> {
  return prisma.customerErpSyncEvent.count({
    where: { state: 'FAILED', updatedAt: { gte: new Date(now.getTime() - 7 * DAY_MS) } },
  });
}

/** Disputes past the seller's response deadline or the decision deadline. */
export function disputesPastSla(now: Date = new Date()): Promise<number> {
  return prisma.dispute.count({
    where: {
      OR: [
        { status: 'AWAITING_SELLER', sellerResponseDueAt: { lt: now } },
        { status: { in: ['UNDER_REVIEW', 'PENDING_APPROVAL', 'APPEALED'] }, decisionDueAt: { lt: now } },
      ],
    },
  });
}

/** Support requests nobody has answered by their first-response deadline. */
export function supportTicketsPastSla(now: Date = new Date()): Promise<number> {
  return prisma.supportTicket.count({
    where: {
      status: { in: ['OPEN', 'IN_PROGRESS'] },
      firstRespondedAt: null,
      firstResponseDueAt: { lt: now },
    },
  });
}

/** Pre-order chats the SLA sweep has already flagged as waiting too long. */
export function preorderChatsPastSla(): Promise<number> {
  return prisma.preorderChatConversation.count({
    where: {
      awaitingReplySince: { not: null },
      slaAlertedAt: { not: null },
      status: { in: ['NEW', 'OPEN', 'WAITING_FOR_INTERNAL'] },
    },
  });
}

/** Inspection jobs nobody accepted in time, or whose report is overdue. */
export function inspectionJobsPastSla(now: Date = new Date()): Promise<number> {
  return prisma.inspectionJob.count({
    where: {
      OR: [
        { status: 'REQUESTED', acceptDueAt: { lt: now } },
        { status: { in: ['ACCEPTED', 'INSPECTOR_ASSIGNED', 'IN_PROGRESS'] }, reportDueAt: { lt: now } },
      ],
    },
  });
}
