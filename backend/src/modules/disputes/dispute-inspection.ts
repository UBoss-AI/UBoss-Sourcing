/**
 * The inspection behind a dispute, and the seller money a dispute is holding
 * (checklist JOURNEY-058).
 *
 * A claim that the goods were wrong is first of all a question the inspection
 * report may already have answered, so the case view shows the report beside
 * the claim. It shows only what each reader is already allowed to see in the
 * inspection module itself:
 *
 *   - staff see every report revision's status and result, and a link to the
 *     inspection console;
 *   - the seller sees signed reports only - before signing, a report is the
 *     inspector's working;
 *   - the buyer sees a signed report only where the inspection policy releases
 *     it to them: published before release, or once the load was released.
 *     Under the NONE policy, nothing.
 *
 * Status and result only, never the report's content or internal notes. The
 * full report stays on the inspection screens, behind their own rules.
 */
import { serialiseMoney } from '../../domain/money.js';
import { prisma } from '../../infra/prisma.js';
import { readPolicy } from '../inspection/context.js';

export type DisputeInspectionAudience = 'OPERATOR' | 'SELLER' | 'BUYER';

export interface DisputeInspectionSummary {
  requirementId: string | null;
  sellerOrderGroupId: string;
  status: string;
  reports: {
    id: string;
    revision: number;
    status: string;
    result: string;
    signedAt: string | null;
  }[];
  /** Where to open the full inspection, in the reader's own app. */
  linkPath: string | null;
}

/** The inspection of each seller part the dispute is about. */
export async function disputeInspection(
  dispute: { orderId: string; sellerOrderGroupId: string | null; sellerAccountId: string | null },
  audience: DisputeInspectionAudience,
): Promise<DisputeInspectionSummary[]> {
  const requirements = await prisma.inspectionRequirement.findMany({
    where: {
      orderId: dispute.orderId,
      ...(dispute.sellerOrderGroupId === null ? {} : { sellerOrderGroupId: dispute.sellerOrderGroupId }),
      // A seller never sees another seller's inspection on the same order.
      ...(audience === 'SELLER' && dispute.sellerAccountId !== null ? { sellerAccountId: dispute.sellerAccountId } : {}),
      status: { not: 'NOT_REQUIRED' },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      sellerOrderGroupId: true,
      status: true,
      loadReleasedAt: true,
      jobs: {
        orderBy: { createdAt: 'asc' },
        select: {
          reports: {
            orderBy: { revision: 'asc' },
            select: { id: true, revision: true, status: true, result: true, signedAt: true, publishedToBuyerAt: true },
          },
        },
      },
    },
  });
  if (requirements.length === 0) return [];

  const policy = audience === 'BUYER' ? await readPolicy() : null;

  return requirements.map((requirement) => {
    const all = requirement.jobs.flatMap((job) => job.reports);
    const visible = all.filter((report) => {
      if (audience === 'OPERATOR') return true;
      if (report.status !== 'SIGNED') return false;
      if (audience === 'SELLER') return true;
      if (policy?.buyerReportAccess === 'BEFORE_RELEASE') return report.publishedToBuyerAt !== null;
      if (policy?.buyerReportAccess === 'AFTER_RELEASE') return requirement.loadReleasedAt !== null;
      return false;
    });
    return {
      requirementId: audience === 'OPERATOR' ? requirement.id : null,
      sellerOrderGroupId: requirement.sellerOrderGroupId,
      status: requirement.status,
      reports: visible.map((report) => ({
        id: report.id,
        revision: report.revision,
        status: report.status,
        result: report.result,
        signedAt: report.signedAt?.toISOString() ?? null,
      })),
      linkPath:
        audience === 'OPERATOR'
          ? `/inspection/${requirement.id}`
          : audience === 'SELLER'
            ? `/seller/orders/${requirement.sellerOrderGroupId}`
            : `/account/orders/${dispute.orderId}`,
    };
  });
}

/**
 * Whether the seller's money for the disputed order is held, and why. Staff
 * only: it names the hold reason and who placed it.
 */
export async function disputeFundHolds(dispute: { orderId: string; sellerOrderGroupId: string | null }) {
  const holds = await prisma.sellerFundHold.findMany({
    where: {
      orderId: dispute.orderId,
      ...(dispute.sellerOrderGroupId === null ? {} : { sellerOrderGroupId: dispute.sellerOrderGroupId }),
    },
    orderBy: { createdAt: 'asc' },
    select: {
      sellerOrderGroupId: true,
      status: true,
      currency: true,
      allocatedMinor: true,
      releasedMinor: true,
      holdCode: true,
      holdReason: true,
      holdPlacedAt: true,
      releasedAt: true,
      sellerAccountId: true,
    },
  });
  const sellers = await prisma.sellerAccount.findMany({
    where: { id: { in: [...new Set(holds.map((hold) => hold.sellerAccountId))] } },
    select: { id: true, displayName: true },
  });
  const names = new Map(sellers.map((seller) => [seller.id, seller.displayName]));
  return holds.map((hold) => ({
    sellerOrderGroupId: hold.sellerOrderGroupId,
    sellerName: names.get(hold.sellerAccountId) ?? null,
    status: hold.status,
    allocated: serialiseMoney(hold.allocatedMinor, hold.currency),
    released: serialiseMoney(hold.releasedMinor, hold.currency),
    holdCode: hold.holdCode,
    holdReason: hold.holdReason,
    holdPlacedAt: hold.holdPlacedAt?.toISOString() ?? null,
    releasedAt: hold.releasedAt?.toISOString() ?? null,
  }));
}
