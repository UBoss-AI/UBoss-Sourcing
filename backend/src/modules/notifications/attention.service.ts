/**
 * What is waiting for somebody, counted per queue.
 *
 * The bell next door answers "what happened lately"; this answers "what is
 * still sitting there". They are different questions and a console needs both:
 * a notification is read once and gone, while a seller application nobody has
 * decided is still undecided tomorrow. An operator who opens the panel at nine
 * should be able to see, without opening a single screen, that four listings
 * and one brand are waiting on them.
 *
 * Three decisions worth keeping:
 *
 *   - **A count is gated by the permission that makes it actionable**, not by
 *     the one that makes the page visible. Somebody who may read orders but
 *     not approve them does not need a badge about approvals; the person who
 *     can act on it does. Same model as the bell, where the grant rides on the
 *     row rather than on the endpoint.
 *   - **A key the caller may not see is ABSENT, not zero.** Zero is a fact
 *     about the business ("nothing is waiting"), and handing that fact to
 *     somebody without the grant is a small disclosure that compounds - the
 *     difference between 0 and 12 pending data-subject requests is itself
 *     information.
 *   - **Counts only, never rows.** The badge says how many; the screen behind
 *     it says which. Returning rows here would mean this endpoint had to carry
 *     every one of those screens' redaction rules.
 */
import { Permission, type PermissionKey } from '../../domain/permissions.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';

/**
 * The queues a console badge can be drawn for.
 *
 * The values are what the Admin Panel's navigation map keys itself on, so a
 * queue added here and not wired to a row is harmless, and a row keyed on a
 * queue that does not exist is a TypeScript error in the panel.
 */
export const AttentionKey = {
  /// Seller applications handed in and not yet decided.
  SELLER_APPLICATIONS: 'sellerApplications',
  /// Certificates and evidence a seller uploaded that nobody has accepted or
  /// refused. Counted against the seller queue's own row, because that is the
  /// screen they are decided on.
  SELLER_DOCUMENTS: 'sellerDocuments',
  /// Listings submitted for review.
  LISTING_REVIEW: 'listingReview',
  /// Brands a seller has asked for.
  BRAND_REQUESTS: 'brandRequests',
  /// Orders held for an approver.
  ORDER_APPROVALS: 'orderApprovals',
  /// Sign-ups waiting on the approval gate, where the deployment runs one.
  CUSTOMER_APPROVALS: 'customerApprovals',
  /// Data-subject requests inside their statutory clock.
  DATA_REQUESTS: 'dataRequests',
  /// Consignments in trouble and nobody yet holding them.
  LOGISTICS_EXCEPTIONS: 'logisticsExceptions',
} as const;

export type AttentionKeyName = (typeof AttentionKey)[keyof typeof AttentionKey];

/** Counts, keyed by queue. A key the caller may not see is not in the map. */
export type AttentionCounts = Partial<Record<AttentionKeyName, number>>;

export interface AttentionView {
  counts: AttentionCounts;
  /** Every count the caller can see, added up. For a single "n waiting" line. */
  total: number;
}

export interface AttentionViewer {
  permissions: readonly string[];
}

interface Queue {
  key: AttentionKeyName;
  permission: PermissionKey;
  count: () => Promise<number>;
}

/**
 * The queues, their grants, and how each one is counted.
 *
 * Every `count` is a `count()` and not a `findMany().length`: these run on
 * every page of the panel, on a poll, and a query that loads two hundred rows
 * to measure them is a query that gets slower as the marketplace succeeds.
 */
const QUEUES: readonly Queue[] = Object.freeze([
  {
    key: AttentionKey.SELLER_APPLICATIONS,
    permission: Permission.CUSTOMER_READ,
    count: () =>
      prisma.sellerAccount.count({ where: { status: { in: ['SUBMITTED', 'UNDER_REVIEW'] } } }),
  },
  {
    key: AttentionKey.SELLER_DOCUMENTS,
    permission: Permission.CUSTOMER_READ,
    count: () =>
      prisma.sellerDocument.count({
        // Neither accepted nor refused, and not replaced by a newer upload.
        // A superseded document is history; deciding it would be deciding a
        // file the seller has already withdrawn in favour of another.
        where: { supersededAt: null, approvedAt: null, rejectedReason: null },
      }),
  },
  {
    key: AttentionKey.LISTING_REVIEW,
    permission: Permission.PRODUCT_READ,
    count: () => prisma.sellerListingDraft.count({ where: { status: 'PENDING_REVIEW' } }),
  },
  {
    key: AttentionKey.BRAND_REQUESTS,
    permission: Permission.PRODUCT_READ,
    // PENDING only. An INFORMATION_REQUESTED row is waiting on the SELLER, and
    // a badge that counts it tells an operator to act on something they have
    // already acted on.
    count: () => prisma.brandRequest.count({ where: { status: 'PENDING' } }),
  },
  {
    key: AttentionKey.ORDER_APPROVALS,
    permission: Permission.ORDER_APPROVE,
    count: () => prisma.orderApproval.count({ where: { status: 'PENDING' } }),
  },
  {
    key: AttentionKey.CUSTOMER_APPROVALS,
    permission: Permission.CUSTOMER_READ,
    count: () =>
      prisma.user.count({ where: { type: 'CUSTOMER', status: 'PENDING_APPROVAL' } }),
  },
  {
    key: AttentionKey.DATA_REQUESTS,
    permission: Permission.DATA_REQUEST_READ,
    count: () => prisma.dataRequest.count({ where: { status: 'PENDING' } }),
  },
  {
    key: AttentionKey.LOGISTICS_EXCEPTIONS,
    permission: Permission.LOGISTICS_READ,
    // OPEN and ESCALATED, not everything unresolved. ACKNOWLEDGED and
    // IN_PROGRESS are exceptions somebody is already holding, and counting
    // those would leave a permanent number on the rail that nobody can clear.
    count: () =>
      prisma.logisticsShipmentException.count({
        where: { state: { in: ['OPEN', 'ESCALATED'] } },
      }),
  },
]);

/**
 * How many things are waiting, for this person.
 *
 * Every visible queue is counted in parallel, and a query that fails is logged
 * and omitted rather than failing the whole call. The rail is chrome: a badge
 * that cannot be computed must cost the operator nothing, and a 500 here would
 * put an error on every page of the panel.
 */
export async function readAttention(viewer: AttentionViewer): Promise<AttentionView> {
  const granted = new Set(viewer.permissions);
  const visible = QUEUES.filter((queue) => granted.has(queue.permission));

  const results = await Promise.all(
    visible.map(async (queue) => {
      try {
        return { key: queue.key, count: await queue.count() };
      } catch (error) {
        logger.error({ err: error, queue: queue.key }, 'attention count failed');
        return null;
      }
    }),
  );

  const counts: AttentionCounts = {};
  let total = 0;

  for (const result of results) {
    if (result === null) continue;
    counts[result.key] = result.count;
    total += result.count;
  }

  return { counts, total };
}
