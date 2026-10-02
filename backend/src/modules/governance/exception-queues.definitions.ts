/**
 * Every admin exception queue, with the default SLA and owner (LIVE-011).
 *
 * A queue is "a list of things somebody on the operator's team must deal
 * with, where waiting too long costs money, trust or a legal deadline". Each
 * one here says who works it by default (a role, never a named person - that
 * stays the operator's decision), who it escalates to, how many hours an item
 * may wait, and how to measure it: how many are waiting, when the oldest
 * arrived, and how many have waited longer than the SLA.
 *
 * The defaults are a starting point. The operator changes any of them on the
 * Exception queues screen, which writes `exception_queue_settings`.
 */
import { Permission, Role, type PermissionKey, type RoleKey } from '../../domain/permissions.js';
import { prisma } from '../../infra/prisma.js';

export interface QueueMeasure {
  count: number;
  oldest: Date | null;
  breached: number;
}

export interface ExceptionQueueDefinition {
  key: string;
  /** The grant that lets somebody see and work this queue. */
  permission: PermissionKey;
  defaultSlaHours: number;
  defaultOwnerRole: RoleKey;
  defaultEscalationRole: RoleKey;
  /** Where the queue is worked, relative to the Admin Panel. */
  href: string;
  measure: (cutoff: Date) => Promise<QueueMeasure>;
}

/** The three numbers for one table, given its waiting filter and its age column. */
async function measured(
  count: () => Promise<number>,
  oldest: () => Promise<Date | null>,
  breached: () => Promise<number>,
): Promise<QueueMeasure> {
  const [c, o, b] = await Promise.all([count(), oldest(), breached()]);
  return { count: c, oldest: o, breached: b };
}

function earliest(...dates: (Date | null)[]): Date | null {
  const present = dates.filter((date): date is Date => date !== null);
  if (present.length === 0) return null;
  return new Date(Math.min(...present.map((date) => date.getTime())));
}

function sum(...measures: QueueMeasure[]): QueueMeasure {
  return {
    count: measures.reduce((total, m) => total + m.count, 0),
    oldest: earliest(...measures.map((m) => m.oldest)),
    breached: measures.reduce((total, m) => total + m.breached, 0),
  };
}

const OPEN_DISPUTES = [
  'AWAITING_SELLER',
  'UNDER_REVIEW',
  'PENDING_APPROVAL',
  'APPEALED',
  'CHARGEBACK_OPEN',
  'NEEDS_RESPONSE',
  'CHARGEBACK_UNDER_REVIEW',
] as const;

const OPEN_INSPECTIONS = ['REQUESTED', 'ACCEPTED', 'INSPECTOR_ASSIGNED', 'IN_PROGRESS', 'REPORT_SUBMITTED'] as const;

const LEDGER_DIFFERENCES = [
  'AMOUNT_MISMATCH',
  'MISSING_IN_LEDGER',
  'MISSING_AT_PROVIDER',
  'UNBALANCED_ENTRY',
  'STATEMENT_MISMATCH',
] as const;

/** A payment younger than this is a customer still on the provider's page. */
const PAYMENT_GRACE_MS = 3_600_000;

export const EXCEPTION_QUEUES: readonly ExceptionQueueDefinition[] = Object.freeze([
  {
    key: 'disputes',
    permission: Permission.DISPUTE_VIEW,
    defaultSlaHours: 48,
    defaultOwnerRole: Role.SUPPORT_AGENT,
    defaultEscalationRole: Role.FINANCE_APPROVER,
    href: '/disputes',
    measure: (cutoff) => {
      const where = { status: { in: [...OPEN_DISPUTES] } };
      return measured(
        () => prisma.dispute.count({ where }),
        async () => (await prisma.dispute.findFirst({ where, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt ?? null,
        () => prisma.dispute.count({ where: { ...where, createdAt: { lt: cutoff } } }),
      );
    },
  },
  {
    key: 'returns',
    permission: Permission.ORDER_READ,
    defaultSlaHours: 48,
    defaultOwnerRole: Role.ORDER_MANAGER,
    defaultEscalationRole: Role.BUSINESS_OWNER,
    href: '/orders',
    measure: (cutoff) => {
      const where = { status: { in: ['REQUESTED', 'APPROVED', 'RECEIVED', 'INSPECTED'] as ('REQUESTED' | 'APPROVED' | 'RECEIVED' | 'INSPECTED')[] } };
      return measured(
        () => prisma.returnRequest.count({ where }),
        async () => (await prisma.returnRequest.findFirst({ where, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt ?? null,
        () => prisma.returnRequest.count({ where: { ...where, createdAt: { lt: cutoff } } }),
      );
    },
  },
  {
    key: 'inspections',
    permission: Permission.INSPECTION_READ,
    defaultSlaHours: 72,
    defaultOwnerRole: Role.COMPLIANCE_OFFICER,
    defaultEscalationRole: Role.BUSINESS_OWNER,
    href: '/inspection',
    measure: (cutoff) => {
      const where = { status: { in: [...OPEN_INSPECTIONS] } };
      return measured(
        () => prisma.inspectionJob.count({ where }),
        async () => (await prisma.inspectionJob.findFirst({ where, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt ?? null,
        () => prisma.inspectionJob.count({ where: { ...where, createdAt: { lt: cutoff } } }),
      );
    },
  },
  {
    key: 'conditionalReleases',
    permission: Permission.INSPECTION_RELEASE,
    defaultSlaHours: 24,
    defaultOwnerRole: Role.FINANCE_APPROVER,
    defaultEscalationRole: Role.BUSINESS_OWNER,
    href: '/inspection',
    measure: (cutoff) => {
      const where = { state: 'PENDING_APPROVAL' as const };
      return measured(
        () => prisma.inspectionRelease.count({ where }),
        async () => (await prisma.inspectionRelease.findFirst({ where, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt ?? null,
        () => prisma.inspectionRelease.count({ where: { ...where, createdAt: { lt: cutoff } } }),
      );
    },
  },
  {
    key: 'earlyFundReleases',
    permission: Permission.FINANCE_POLICY_READ,
    defaultSlaHours: 24,
    defaultOwnerRole: Role.FINANCE_APPROVER,
    defaultEscalationRole: Role.BUSINESS_OWNER,
    href: '/finance/ledger',
    measure: (cutoff) => {
      const where = { status: 'PENDING' as const };
      return measured(
        () => prisma.sellerFundReleaseRequest.count({ where }),
        async () => (await prisma.sellerFundReleaseRequest.findFirst({ where, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt ?? null,
        () => prisma.sellerFundReleaseRequest.count({ where: { ...where, createdAt: { lt: cutoff } } }),
      );
    },
  },
  {
    key: 'feeApprovals',
    permission: Permission.FINANCE_POLICY_READ,
    defaultSlaHours: 48,
    defaultOwnerRole: Role.FINANCE_APPROVER,
    defaultEscalationRole: Role.BUSINESS_OWNER,
    href: '/finance/fee-rules',
    measure: async (cutoff) => {
      const where = { status: 'PENDING_APPROVAL' as const };
      const [policies, rules] = await Promise.all([
        measured(
          () => prisma.platformFeePolicy.count({ where }),
          async () => (await prisma.platformFeePolicy.findFirst({ where, orderBy: { updatedAt: 'asc' }, select: { updatedAt: true } }))?.updatedAt ?? null,
          () => prisma.platformFeePolicy.count({ where: { ...where, updatedAt: { lt: cutoff } } }),
        ),
        measured(
          () => prisma.platformFeeRule.count({ where }),
          async () => (await prisma.platformFeeRule.findFirst({ where, orderBy: { updatedAt: 'asc' }, select: { updatedAt: true } }))?.updatedAt ?? null,
          () => prisma.platformFeeRule.count({ where: { ...where, updatedAt: { lt: cutoff } } }),
        ),
      ]);
      return sum(policies, rules);
    },
  },
  {
    key: 'ledgerDifferences',
    permission: Permission.PAYMENT_READ,
    defaultSlaHours: 72,
    defaultOwnerRole: Role.FINANCE_APPROVER,
    defaultEscalationRole: Role.BUSINESS_OWNER,
    href: '/finance/ledger',
    measure: async (cutoff) => {
      // Only the newest completed run per provider: an older run's difference
      // that a later run no longer reports has been dealt with.
      const runs = await prisma.ledgerReconciliationRun.findMany({
        where: { status: 'COMPLETED' },
        orderBy: { completedAt: 'desc' },
        select: { id: true, provider: true },
        take: 50,
      });
      const latest = new Map<string, string>();
      for (const run of runs) if (!latest.has(run.provider)) latest.set(run.provider, run.id);
      const where = { runId: { in: [...latest.values()] }, kind: { in: [...LEDGER_DIFFERENCES] } };
      return measured(
        () => prisma.ledgerReconciliationItem.count({ where }),
        async () => (await prisma.ledgerReconciliationItem.findFirst({ where, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt ?? null,
        () => prisma.ledgerReconciliationItem.count({ where: { ...where, createdAt: { lt: cutoff } } }),
      );
    },
  },
  {
    key: 'paymentMismatches',
    permission: Permission.PAYMENT_READ,
    defaultSlaHours: 4,
    defaultOwnerRole: Role.FINANCE_APPROVER,
    defaultEscalationRole: Role.BUSINESS_OWNER,
    href: '/payments?state=unreconciled',
    measure: async (cutoff) => {
      const stuck = {
        status: { in: ['CREATED', 'PENDING', 'AUTHORIZED'] as ('CREATED' | 'PENDING' | 'AUTHORIZED')[] },
        createdAt: { lt: new Date(Date.now() - PAYMENT_GRACE_MS) },
      };
      const refused = { processingStatus: { in: ['REJECTED', 'FAILED'] as ('REJECTED' | 'FAILED')[] } };
      const [payments, webhooks] = await Promise.all([
        measured(
          () => prisma.paymentTransaction.count({ where: stuck }),
          async () => (await prisma.paymentTransaction.findFirst({ where: stuck, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt ?? null,
          () => prisma.paymentTransaction.count({ where: { ...stuck, createdAt: { lt: cutoff } } }),
        ),
        measured(
          () => prisma.paymentEvent.count({ where: refused }),
          async () => (await prisma.paymentEvent.findFirst({ where: refused, orderBy: { receivedAt: 'asc' }, select: { receivedAt: true } }))?.receivedAt ?? null,
          () => prisma.paymentEvent.count({ where: { ...refused, receivedAt: { lt: cutoff } } }),
        ),
      ]);
      return sum(payments, webhooks);
    },
  },
  {
    key: 'deadLetters',
    permission: Permission.SETTINGS_READ,
    defaultSlaHours: 24,
    defaultOwnerRole: Role.BUSINESS_OWNER,
    defaultEscalationRole: Role.BUSINESS_OWNER,
    href: '/operations/dead-jobs',
    measure: async (cutoff) => {
      const dead = { status: 'DEAD' as const };
      const outbox = { status: { in: ['FAILED', 'DEAD'] as ('FAILED' | 'DEAD')[] } };
      const carrier = { state: 'DEAD_LETTER' as const };
      const [jobs, notifications, webhooks] = await Promise.all([
        measured(
          () => prisma.jobQueue.count({ where: dead }),
          async () => (await prisma.jobQueue.findFirst({ where: dead, orderBy: { updatedAt: 'asc' }, select: { updatedAt: true } }))?.updatedAt ?? null,
          () => prisma.jobQueue.count({ where: { ...dead, updatedAt: { lt: cutoff } } }),
        ),
        measured(
          () => prisma.notificationOutbox.count({ where: outbox }),
          async () => (await prisma.notificationOutbox.findFirst({ where: outbox, orderBy: { updatedAt: 'asc' }, select: { updatedAt: true } }))?.updatedAt ?? null,
          () => prisma.notificationOutbox.count({ where: { ...outbox, updatedAt: { lt: cutoff } } }),
        ),
        measured(
          () => prisma.carrierWebhookEvent.count({ where: carrier }),
          async () => (await prisma.carrierWebhookEvent.findFirst({ where: carrier, orderBy: { updatedAt: 'asc' }, select: { updatedAt: true } }))?.updatedAt ?? null,
          () => prisma.carrierWebhookEvent.count({ where: { ...carrier, updatedAt: { lt: cutoff } } }),
        ),
      ]);
      return sum(jobs, notifications, webhooks);
    },
  },
  {
    key: 'riskSignals',
    permission: Permission.RISK_READ,
    defaultSlaHours: 24,
    defaultOwnerRole: Role.COMPLIANCE_OFFICER,
    defaultEscalationRole: Role.BUSINESS_OWNER,
    href: '/risk',
    measure: (cutoff) => {
      const where = { status: 'OPEN' as const };
      return measured(
        () => prisma.riskSignal.count({ where }),
        async () => (await prisma.riskSignal.findFirst({ where, orderBy: { detectedAt: 'asc' }, select: { detectedAt: true } }))?.detectedAt ?? null,
        () => prisma.riskSignal.count({ where: { ...where, detectedAt: { lt: cutoff } } }),
      );
    },
  },
  {
    key: 'orderApprovals',
    permission: Permission.ORDER_APPROVE,
    defaultSlaHours: 24,
    defaultOwnerRole: Role.FINANCE_APPROVER,
    defaultEscalationRole: Role.BUSINESS_OWNER,
    href: '/orders?approval=PENDING',
    measure: (cutoff) => {
      const where = { status: 'PENDING' as const };
      return measured(
        () => prisma.orderApproval.count({ where }),
        async () => (await prisma.orderApproval.findFirst({ where, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt ?? null,
        () => prisma.orderApproval.count({ where: { ...where, createdAt: { lt: cutoff } } }),
      );
    },
  },
  {
    key: 'purchaseOrderApprovals',
    permission: Permission.ORDER_READ,
    defaultSlaHours: 48,
    defaultOwnerRole: Role.ORDER_MANAGER,
    defaultEscalationRole: Role.BUSINESS_OWNER,
    href: '/orders',
    measure: (cutoff) => {
      const where = { status: 'PENDING_APPROVAL' as const };
      return measured(
        () => prisma.rfqPurchaseOrder.count({ where }),
        async () => (await prisma.rfqPurchaseOrder.findFirst({ where, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt ?? null,
        () => prisma.rfqPurchaseOrder.count({ where: { ...where, createdAt: { lt: cutoff } } }),
      );
    },
  },
  {
    key: 'criticalActionApprovals',
    permission: Permission.CUSTOMER_STATUS_WRITE,
    defaultSlaHours: 24,
    defaultOwnerRole: Role.BUSINESS_OWNER,
    defaultEscalationRole: Role.BUSINESS_OWNER,
    href: '/operations/exception-queues#approvals',
    measure: (cutoff) => {
      const where = { status: 'PENDING' as const };
      return measured(
        () => prisma.adminPendingAction.count({ where }),
        async () => (await prisma.adminPendingAction.findFirst({ where, orderBy: { requestedAt: 'asc' }, select: { requestedAt: true } }))?.requestedAt ?? null,
        () => prisma.adminPendingAction.count({ where: { ...where, requestedAt: { lt: cutoff } } }),
      );
    },
  },
  {
    key: 'listingReview',
    permission: Permission.PRODUCT_READ,
    defaultSlaHours: 48,
    defaultOwnerRole: Role.CATALOG_MANAGER,
    defaultEscalationRole: Role.BUSINESS_OWNER,
    href: '/listing-review',
    measure: (cutoff) => {
      const where = { status: 'PENDING_REVIEW' as const };
      return measured(
        () => prisma.sellerListingDraft.count({ where }),
        async () => (await prisma.sellerListingDraft.findFirst({ where, orderBy: { submittedAt: 'asc' }, select: { submittedAt: true } }))?.submittedAt ?? null,
        () => prisma.sellerListingDraft.count({ where: { ...where, submittedAt: { lt: cutoff } } }),
      );
    },
  },
  {
    key: 'listingAppeals',
    permission: Permission.PRODUCT_READ,
    defaultSlaHours: 72,
    defaultOwnerRole: Role.CATALOG_MANAGER,
    defaultEscalationRole: Role.BUSINESS_OWNER,
    href: '/listing-review?status=APPEALED',
    measure: (cutoff) => {
      const where = { status: 'APPEALED' as const };
      return measured(
        () => prisma.sellerListingDraft.count({ where }),
        async () => (await prisma.sellerListingDraft.findFirst({ where, orderBy: { appealedAt: 'asc' }, select: { appealedAt: true } }))?.appealedAt ?? null,
        () => prisma.sellerListingDraft.count({ where: { ...where, appealedAt: { lt: cutoff } } }),
      );
    },
  },
  {
    key: 'sellerApplications',
    permission: Permission.CUSTOMER_READ,
    defaultSlaHours: 72,
    defaultOwnerRole: Role.COMPLIANCE_OFFICER,
    defaultEscalationRole: Role.BUSINESS_OWNER,
    href: '/sellers?status=SUBMITTED',
    measure: (cutoff) => {
      const where = { status: { in: ['SUBMITTED', 'UNDER_REVIEW'] as ('SUBMITTED' | 'UNDER_REVIEW')[] } };
      return measured(
        () => prisma.sellerAccount.count({ where }),
        async () => (await prisma.sellerAccount.findFirst({ where, orderBy: { submittedAt: 'asc' }, select: { submittedAt: true } }))?.submittedAt ?? null,
        () => prisma.sellerAccount.count({ where: { ...where, submittedAt: { lt: cutoff } } }),
      );
    },
  },
  {
    key: 'supportTickets',
    permission: Permission.SUPPORT_TICKET_VIEW,
    defaultSlaHours: 24,
    defaultOwnerRole: Role.SUPPORT_AGENT,
    defaultEscalationRole: Role.BUSINESS_OWNER,
    href: '/support',
    measure: (cutoff) => {
      const where = { status: { in: ['OPEN', 'IN_PROGRESS'] as ('OPEN' | 'IN_PROGRESS')[] } };
      return measured(
        () => prisma.supportTicket.count({ where }),
        async () => (await prisma.supportTicket.findFirst({ where, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt ?? null,
        () => prisma.supportTicket.count({ where: { ...where, createdAt: { lt: cutoff } } }),
      );
    },
  },
  {
    key: 'logisticsExceptions',
    permission: Permission.LOGISTICS_READ,
    defaultSlaHours: 12,
    defaultOwnerRole: Role.ORDER_MANAGER,
    defaultEscalationRole: Role.BUSINESS_OWNER,
    href: '/logistics/shipments?exception=open',
    measure: (cutoff) => {
      const where = { state: { in: ['OPEN', 'ESCALATED'] as ('OPEN' | 'ESCALATED')[] } };
      return measured(
        () => prisma.logisticsShipmentException.count({ where }),
        async () => (await prisma.logisticsShipmentException.findFirst({ where, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt ?? null,
        () => prisma.logisticsShipmentException.count({ where: { ...where, createdAt: { lt: cutoff } } }),
      );
    },
  },
  {
    key: 'contentApprovals',
    permission: Permission.SETTINGS_READ,
    defaultSlaHours: 24,
    defaultOwnerRole: Role.CATALOG_MANAGER,
    defaultEscalationRole: Role.BUSINESS_OWNER,
    href: '/settings/content',
    measure: (cutoff) => {
      const where = { status: 'PENDING_APPROVAL' as const };
      return measured(
        () => prisma.contentBlock.count({ where }),
        async () => (await prisma.contentBlock.findFirst({ where, orderBy: { submittedAt: 'asc' }, select: { submittedAt: true } }))?.submittedAt ?? null,
        () => prisma.contentBlock.count({ where: { ...where, submittedAt: { lt: cutoff } } }),
      );
    },
  },
  {
    key: 'dataRequests',
    permission: Permission.DATA_REQUEST_READ,
    // A month is the statutory limit; a week leaves room to act inside it.
    defaultSlaHours: 168,
    defaultOwnerRole: Role.COMPLIANCE_OFFICER,
    defaultEscalationRole: Role.BUSINESS_OWNER,
    href: '/data-requests',
    measure: (cutoff) => {
      const where = { status: 'PENDING' as const };
      return measured(
        () => prisma.dataRequest.count({ where }),
        async () => (await prisma.dataRequest.findFirst({ where, orderBy: { requestedAt: 'asc' }, select: { requestedAt: true } }))?.requestedAt ?? null,
        () => prisma.dataRequest.count({ where: { ...where, requestedAt: { lt: cutoff } } }),
      );
    },
  },
]);

export const EXCEPTION_QUEUE_KEYS: readonly string[] = Object.freeze(EXCEPTION_QUEUES.map((queue) => queue.key));
