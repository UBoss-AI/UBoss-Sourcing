/**
 * Disputes: a buyer's claim on an order, the seller's answer, and the
 * operator's decision.
 *
 * THE LIFECYCLE is `domain/dispute-state.ts`; nothing here writes a status
 * that module has not allowed, and every status write is conditional on the
 * status just read, so two people acting at once cannot both win.
 *
 * THE MONEY goes through the ordinary refund path (`createRefund`), never
 * around it. That is what keeps a dispute refund inside every rule a refund
 * already obeys: never more than was paid (checked here, by
 * `chk_order_refund_within_paid` and by the provider), idempotent on its key,
 * carried into each seller's settlement by `syncSettlementRefunds`, visible
 * to finance for a commission credit note, and told to the buyer by the
 * refund's own email.
 *
 * MAKER-CHECKER. A refund decision above the approval threshold (a setting,
 * zero by default) is a PROPOSAL until a second member of staff holding
 * `dispute.approve` approves it. The proposer can never approve their own.
 *
 * WHAT IS NEVER COPIED ANYWHERE: the words. The audit trail records who did
 * what; emails and bells carry the reference and a link.
 */
import { ErrorCode, AppError, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import {
  DisputeReasonValues,
  OPEN_CHARGEBACK_STATUSES,
  OPEN_CLAIM_STATUSES,
  OPEN_STATUSES,
  acceptsMessages,
  addHours,
  assertDisputeTransition,
  isBreached,
  isRefund,
  needsSecondApproval,
  statusForDecision,
  type DisputeReasonName,
  type DisputeRemedyName,
  type DisputeResolutionName,
  type DisputeStatusName,
} from '../../domain/dispute-state.js';
import { serialiseMoney } from '../../domain/money.js';
import { estimatedSettlement } from '../../domain/platform-fee.js';
import { Permission, permissionsForRoles } from '../../domain/permissions.js';
import { attributeRefundsToSellers } from '../../domain/settlement-refunds.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  AdminNotificationKind,
  createAdminNotification,
} from '../notifications/admin-notification.service.js';
import {
  NotificationEvent,
  dispatchPendingNotifications,
  enqueueNotification,
} from '../notifications/notification.service.js';
import { createRefund } from '../payments/refund.service.js';
import { notifySeller } from '../seller/notification.service.js';
import { supportAttachmentPolicy } from '../support/support-attachment.service.js';
import {
  DISPUTE_LIMITS,
  buyerDisputeUrl,
  cleanText,
  consoleDisputePath,
  newDisputeReference,
  ownDisputeId,
  parseMinor,
  partyWhere,
  requirePermission,
  requireSellerCanRespond,
  sellerDisputePath,
  writeEvent,
  type BuyerActor,
  type PartyActor,
  type SellerActor,
  type StaffActor,
} from './dispute-common.js';
import { readDisputeSettings, settingsView } from './dispute-settings.service.js';

type Tx = PrismaTransaction;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const DISPUTE_INCLUDE = {
  order: {
    select: {
      id: true,
      orderNumber: true,
      status: true,
      currency: true,
      paidMinor: true,
      refundedMinor: true,
      grandTotalMinor: true,
      placedAt: true,
      customerProfile: { select: { fullName: true, user: { select: { email: true } } } },
    },
  },
  orderItem: {
    select: {
      id: true,
      nameSnapshot: true,
      skuSnapshot: true,
      variantNameSnapshot: true,
      quantity: true,
      lineTotalMinor: true,
    },
  },
  sellerAccount: { select: { id: true, displayName: true } },
  sellerOrderGroup: { select: { id: true, sellerOrderNumber: true } },
  refund: { select: { id: true, status: true, amountMinor: true, currency: true } },
  assignedAdmin: { select: { id: true, email: true } },
  attachments: {
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    select: {
      id: true,
      party: true,
      fileName: true,
      contentType: true,
      kind: true,
      byteSize: true,
      createdAt: true,
    },
  },
  events: {
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    include: { actor: { select: { id: true, email: true } } },
  },
} satisfies Prisma.DisputeInclude;

type DisputeRow = Prisma.DisputeGetPayload<{ include: typeof DISPUTE_INCLUDE }>;

async function loadDispute(client: Pick<Tx, 'dispute'>, id: string): Promise<DisputeRow> {
  const row = await client.dispute.findUnique({ where: { id }, include: DISPUTE_INCLUDE });
  if (row === null) throw notFound('Dispute');
  return row;
}

function money(amount: bigint | null, currency: string) {
  return amount === null ? null : serialiseMoney(amount, currency);
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

/** What is left to refund on the order: paid, less every refund so far. */
function maxRefundable(order: { paidMinor: bigint; refundedMinor: bigint }): bigint {
  const left = order.paidMinor - order.refundedMinor;
  return left > 0n ? left : 0n;
}

/** The most a claim can be about: its line's value, never more than is refundable. */
function claimCap(row: {
  order: { paidMinor: bigint; refundedMinor: bigint };
  orderItem: { lineTotalMinor: bigint } | null;
}): bigint {
  const left = maxRefundable(row.order);
  if (row.orderItem === null) return left;
  return row.orderItem.lineTotalMinor < left ? row.orderItem.lineTotalMinor : left;
}

function slaFor(row: DisputeRow, now: Date) {
  return {
    sellerResponseDueAt: iso(row.sellerResponseDueAt),
    sellerRespondedAt: iso(row.sellerRespondedAt),
    sellerResponseBreached:
      row.sellerAccountId !== null && isBreached(row.sellerResponseDueAt, row.sellerRespondedAt, now),
    decisionDueAt: iso(row.decisionDueAt),
    decisionBreached:
      row.kind === 'CLAIM' &&
      isBreached(
        row.decisionDueAt,
        OPEN_CLAIM_STATUSES.includes(row.status) ? null : (row.decidedAt ?? row.closedAt),
        now,
      ),
    evidenceDueAt: iso(row.evidenceDueAt),
    evidenceBreached:
      row.kind === 'CHARGEBACK' && row.status === 'NEEDS_RESPONSE' && isBreached(row.evidenceDueAt, null, now),
    appealDueAt: iso(row.appealDueAt),
  };
}

function attachmentsView(row: DisputeRow) {
  return row.attachments.map((file) => ({ ...file, createdAt: file.createdAt.toISOString() }));
}

function decisionView(row: DisputeRow) {
  return row.resolution === null
    ? null
    : {
        resolution: row.resolution,
        amount: money(row.resolutionAmountMinor, row.currency),
        reason: row.decisionReason,
        decidedAt: iso(row.decidedAt),
        refund:
          row.refund === null
            ? null
            : { status: row.refund.status, amount: money(row.refund.amountMinor, row.refund.currency) },
      };
}

// ---------------------------------------------------------------------------
// Party views
// ---------------------------------------------------------------------------

export interface PartyThreadEntry {
  id: string;
  kind: string;
  /** Whose line it is, from the reader's side: YOU, BUYER, SELLER, TEAM or SYSTEM. */
  author: 'YOU' | 'BUYER' | 'SELLER' | 'TEAM' | 'SYSTEM';
  body: string | null;
  toValue: string | null;
  amount: ReturnType<typeof money>;
  createdAt: string;
}

function partyView(row: DisputeRow, actor: PartyActor, now = new Date()) {
  const side = actor.side;
  const visible = row.events.filter((event) =>
    side === 'BUYER' ? event.visibleToBuyer : event.visibleToSeller,
  );
  const open = acceptsMessages(row.status);
  const appealable =
    (row.status === 'RESOLVED' || row.status === 'REJECTED') &&
    row.appealCount === 0 &&
    row.appealDueAt !== null &&
    row.appealDueAt.getTime() >= now.getTime();
  const sellerLate = row.sellerResponseDueAt !== null && row.sellerResponseDueAt.getTime() < now.getTime();

  return {
    reference: row.reference,
    kind: row.kind,
    status: row.status,
    reasonCode: row.reasonCode,
    description: row.description,
    desiredOutcome: row.desiredOutcome,
    requestedAmount: money(row.requestedAmountMinor, row.currency),
    currency: row.currency,
    order: {
      // The buyer opens their own order from here; a seller has its own page.
      id: side === 'BUYER' ? row.order.id : null,
      orderNumber: row.order.orderNumber,
      sellerOrderGroupId: side === 'SELLER' ? row.sellerOrderGroupId : null,
      sellerOrderNumber: row.sellerOrderGroup?.sellerOrderNumber ?? null,
    },
    line:
      row.orderItem === null
        ? null
        : {
            name: row.orderItem.nameSnapshot,
            variant: row.orderItem.variantNameSnapshot,
            sku: row.orderItem.skuSnapshot,
            quantity: row.orderItem.quantity,
            lineTotal: money(row.orderItem.lineTotalMinor, row.currency),
          },
    seller: side === 'BUYER' && row.sellerAccount !== null ? { name: row.sellerAccount.displayName } : null,
    sellerProposal:
      row.sellerProposal === null
        ? null
        : { resolution: row.sellerProposal, amount: money(row.sellerProposalAmountMinor, row.currency) },
    decision: decisionView(row),
    deadlines: slaFor(row, now),
    appealCount: row.appealCount,
    attachments: attachmentsView(row),
    thread: visible.map(
      (event): PartyThreadEntry => ({
        id: event.id,
        kind: event.kind,
        author:
          event.party === (side === 'BUYER' ? 'BUYER' : 'SELLER')
            ? 'YOU'
            : event.party === 'STAFF'
              ? 'TEAM'
              : event.party === 'BUYER' || event.party === 'SELLER'
                ? event.party
                : 'SYSTEM',
        body: event.body,
        toValue: event.toValue,
        amount: money(event.amountMinor, row.currency),
        createdAt: event.createdAt.toISOString(),
      }),
    ),
    can: {
      message: open && (side === 'BUYER' || actor.canRespond),
      addEvidence: open && (side === 'BUYER' || actor.canRespond),
      escalate: side === 'BUYER' && row.status === 'AWAITING_SELLER' && sellerLate,
      withdraw: side === 'BUYER' && (row.status === 'AWAITING_SELLER' || row.status === 'UNDER_REVIEW'),
      respond:
        side === 'SELLER' &&
        actor.canRespond &&
        (row.status === 'AWAITING_SELLER' || row.status === 'UNDER_REVIEW' || row.status === 'APPEALED'),
      appeal: appealable && (side === 'BUYER' || actor.canRespond),
    },
    lastActivityAt: row.lastActivityAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export type PartyDisputeView = ReturnType<typeof partyView>;

function summaryOf(row: {
  reference: string;
  kind: string;
  status: DisputeStatusName;
  reasonCode: string;
  currency: string;
  requestedAmountMinor: bigint | null;
  sellerResponseDueAt: Date | null;
  decisionDueAt: Date | null;
  lastActivityAt: Date;
  createdAt: Date;
  order: { orderNumber: string };
  orderItem: { nameSnapshot: string } | null;
}) {
  return {
    reference: row.reference,
    kind: row.kind,
    status: row.status,
    reasonCode: row.reasonCode,
    orderNumber: row.order.orderNumber,
    lineName: row.orderItem?.nameSnapshot ?? null,
    requestedAmount: money(row.requestedAmountMinor, row.currency),
    sellerResponseDueAt: iso(row.sellerResponseDueAt),
    decisionDueAt: iso(row.decisionDueAt),
    lastActivityAt: row.lastActivityAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

const SUMMARY_SELECT = {
  reference: true,
  kind: true,
  status: true,
  reasonCode: true,
  currency: true,
  requestedAmountMinor: true,
  sellerResponseDueAt: true,
  decisionDueAt: true,
  lastActivityAt: true,
  createdAt: true,
  order: { select: { orderNumber: true } },
  orderItem: { select: { nameSnapshot: true } },
} satisfies Prisma.DisputeSelect;

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

async function tellBuyer(
  tx: Tx,
  row: DisputeRow,
  event: 'UPDATE' | 'DECIDED',
  extra: Record<string, string> = {},
): Promise<void> {
  const recipient = row.order.customerProfile.user.email;
  await enqueueNotification(
    {
      eventKey: event === 'DECIDED' ? NotificationEvent.DISPUTE_DECIDED : NotificationEvent.DISPUTE_UPDATE,
      recipientEmail: recipient,
      recipientName: row.order.customerProfile.fullName,
      variables: {
        reference: row.reference,
        orderNumber: row.order.orderNumber,
        disputeUrl: buyerDisputeUrl(row.reference),
        ...extra,
      },
      relatedType: 'dispute',
      relatedId: row.id,
    },
    tx,
  );
}

async function tellSeller(tx: Tx, row: DisputeRow, title: string, body: string, dedupeKey?: string): Promise<void> {
  if (row.sellerAccountId === null) return;
  await notifySeller({
    sellerAccountId: row.sellerAccountId,
    kind: 'RETURN_OR_DISPUTE',
    title,
    body,
    linkPath: sellerDisputePath(row.reference),
    severity: 'WARNING',
    subjectType: 'dispute',
    subjectId: row.id,
    ...(dedupeKey === undefined ? {} : { dedupeKey }),
    tx,
  });
}

async function bellStaff(
  tx: Tx,
  row: { id: string; reference: string },
  what: string,
  dedupeKey?: string,
): Promise<void> {
  await createAdminNotification(
    {
      kind: AdminNotificationKind.DISPUTE_ACTIVITY,
      variables: { reference: row.reference, what },
      linkPath: consoleDisputePath(row.id),
      requiredPermission: Permission.DISPUTE_VIEW,
      relatedType: 'dispute',
      relatedId: row.id,
      ...(dedupeKey === undefined ? {} : { dedupeKey }),
    },
    tx,
  );
}

/** Move the status, conditionally on it still being what was read. */
async function moveStatus(
  tx: Tx,
  row: { id: string; kind: 'CLAIM' | 'CHARGEBACK'; status: DisputeStatusName },
  to: DisputeStatusName,
  data: Prisma.DisputeUncheckedUpdateManyInput,
  event: { party: 'BUYER' | 'SELLER' | 'STAFF' | 'SYSTEM' | 'PROVIDER'; actorUserId: string | null; at: Date },
): Promise<void> {
  assertDisputeTransition(row.kind, row.status, to);
  const moved = await tx.dispute.updateMany({
    where: { id: row.id, status: row.status },
    data: { ...data, status: to, lastActivityAt: event.at },
  });
  if (moved.count === 0) {
    throw conflict(ErrorCode.CONFLICT, 'Somebody changed this dispute a moment ago. Refresh and try again.');
  }
  await writeEvent(tx, {
    disputeId: row.id,
    kind: 'STATUS_CHANGED',
    party: event.party,
    visibleToBuyer: true,
    visibleToSeller: true,
    actorUserId: event.actorUserId,
    fromValue: row.status,
    toValue: to,
    createdAt: event.at,
  });
}

function auditActor(actor: BuyerActor | SellerActor | StaffActor) {
  return {
    actorType: actor.side === 'STAFF' ? ('ADMIN' as const) : ('CUSTOMER' as const),
    actorUserId: actor.userId,
    actorEmail: actor.email,
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Buyer: raising a claim
// ---------------------------------------------------------------------------

/** What the claim form needs: the reasons offered, the windows, the file rules. */
export async function readClaimContext() {
  const settings = await readDisputeSettings();
  return {
    reasons: settings.enabledReasons,
    remedies: ['REFUND_FULL', 'REFUND_PARTIAL', 'REPLACEMENT'] as const,
    claimWindowDays: settings.claimWindowDays,
    sellerResponseHours: settings.sellerResponseHours,
    decisionHours: settings.decisionHours,
    appealWindowDays: settings.appealWindowDays,
    limits: DISPUTE_LIMITS,
    attachments: supportAttachmentPolicy(),
  };
}

export interface CreateClaimInput {
  orderId: string;
  orderItemId?: string | null | undefined;
  reasonCode: DisputeReasonName;
  description: string;
  desiredOutcome: DisputeRemedyName;
  requestedAmountMinor?: string | null | undefined;
}

export async function createClaim(actor: BuyerActor, input: CreateClaimInput): Promise<{ dispute: PartyDisputeView }> {
  const settings = await readDisputeSettings();
  if (!settings.enabledReasons.includes(input.reasonCode)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'That reason is not offered here.', [
      { field: 'reasonCode', code: 'NOT_OFFERED' },
    ]);
  }
  const description = cleanText(input.description, 'description', {
    min: DISPUTE_LIMITS.descriptionMin,
    max: DISPUTE_LIMITS.descriptionMax,
  });
  const requested = parseMinor(input.requestedAmountMinor, 'requestedAmountMinor');

  // The same orders the Orders page shows this session. Anything else is "not found".
  const order = await prisma.order.findFirst({
    where: { id: input.orderId, ...actor.orderScope },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      currency: true,
      paidMinor: true,
      refundedMinor: true,
      placedAt: true,
      createdAt: true,
      customerProfileId: true,
      items: { select: { id: true, sellerOfferId: true, lineTotalMinor: true, sellerOffer: { select: { sellerAccountId: true } } } },
      sellerOrderGroups: { select: { id: true, sellerAccountId: true } },
    },
  });
  if (order === null) throw notFound('Order');

  if (order.paidMinor <= 0n) {
    throw new AppError({
      statusCode: 422,
      code: ErrorCode.DISPUTE_NOT_ELIGIBLE,
      message: 'A claim can be raised once the order has been paid for.',
      details: [{ code: 'NOT_PAID' }],
    });
  }
  const since = order.placedAt ?? order.createdAt;
  const now = new Date();
  if (now.getTime() > addHours(since, settings.claimWindowDays * 24).getTime()) {
    throw new AppError({
      statusCode: 422,
      code: ErrorCode.DISPUTE_WINDOW_CLOSED,
      message: `Claims can be raised up to ${String(settings.claimWindowDays)} days after an order is placed.`,
      details: [{ code: 'WINDOW_CLOSED', meta: { windowDays: settings.claimWindowDays } }],
    });
  }

  const itemId = input.orderItemId ?? null;
  const item = itemId === null ? null : order.items.find((candidate) => candidate.id === itemId);
  if (itemId !== null && item === undefined) {
    throw new AppError({
      statusCode: 422,
      code: ErrorCode.DISPUTE_NOT_ELIGIBLE,
      message: 'That line is not on this order.',
      details: [{ field: 'orderItemId', code: 'LINE_NOT_ON_ORDER' }],
    });
  }

  // Whose goods: the line's seller, or the order's one seller when it has
  // exactly one and nothing of the operator's. Otherwise the operator's own.
  let sellerAccountId: string | null = null;
  if (item !== null && item !== undefined) {
    sellerAccountId = item.sellerOffer?.sellerAccountId ?? null;
  } else if (order.sellerOrderGroups.length === 1 && order.items.every((line) => line.sellerOfferId !== null)) {
    sellerAccountId = order.sellerOrderGroups[0]?.sellerAccountId ?? null;
  }
  const group = sellerAccountId === null ? null : order.sellerOrderGroups.find((g) => g.sellerAccountId === sellerAccountId) ?? null;

  const left = maxRefundable(order);
  const cap = item === null || item === undefined ? left : item.lineTotalMinor < left ? item.lineTotalMinor : left;
  let requestedAmount: bigint | null = null;
  if (input.desiredOutcome === 'REFUND_PARTIAL') {
    if (requested === null || requested <= 0n || requested > cap) {
      throw badRequest(
        ErrorCode.DISPUTE_AMOUNT_INVALID,
        `Ask for an amount greater than zero and at most ${serialiseMoney(cap, order.currency).formatted} ${order.currency}.`,
        [{ field: 'requestedAmountMinor', code: requested === null ? 'REQUIRED' : 'OUT_OF_RANGE', meta: { maxMinor: cap.toString() } }],
      );
    }
    requestedAmount = requested;
  } else if (input.desiredOutcome === 'REFUND_FULL') {
    requestedAmount = cap;
  }

  const sellerDue = sellerAccountId === null ? null : addHours(now, settings.sellerResponseHours);
  const decisionDue = addHours(now, settings.decisionHours);

  for (let attempt = 0; ; attempt += 1) {
    const id = newId();
    const reference = newDisputeReference();
    try {
      const created = await prisma.$transaction(async (tx) => {
        // One open claim per line (or per whole order): serialise on the order.
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;
        const existing = await tx.dispute.findFirst({
          where: { kind: 'CLAIM', orderId: order.id, orderItemId: itemId, status: { in: [...OPEN_CLAIM_STATUSES] } },
          select: { reference: true },
        });
        if (existing !== null) {
          throw conflict(ErrorCode.DISPUTE_ALREADY_OPEN, 'There is already an open claim on this. Add to that one instead.', [
            { code: 'ALREADY_OPEN', meta: { reference: existing.reference } },
          ]);
        }

        await tx.dispute.create({
          data: {
            id,
            reference,
            kind: 'CLAIM',
            status: sellerAccountId === null ? 'UNDER_REVIEW' : 'AWAITING_SELLER',
            orderId: order.id,
            orderItemId: itemId,
            sellerOrderGroupId: group?.id ?? null,
            sellerAccountId,
            customerProfileId: order.customerProfileId,
            raisedByUserId: actor.userId,
            reasonCode: input.reasonCode,
            description,
            desiredOutcome: input.desiredOutcome,
            requestedAmountMinor: requestedAmount,
            currency: order.currency,
            sellerResponseDueAt: sellerDue,
            decisionDueAt: decisionDue,
            lastActivityAt: now,
          },
        });
        await writeEvent(tx, {
          disputeId: id,
          kind: 'CREATED',
          party: 'BUYER',
          visibleToBuyer: true,
          visibleToSeller: true,
          actorUserId: actor.userId,
          toValue: input.reasonCode,
          amountMinor: requestedAmount,
          createdAt: now,
        });
        await recordAudit(
          {
            action: AuditAction.DISPUTE_CREATED,
            resourceType: 'dispute',
            resourceId: id,
            ...auditActor(actor),
            after: {
              reference,
              orderId: order.id,
              orderItemId: itemId,
              reasonCode: input.reasonCode,
              desiredOutcome: input.desiredOutcome,
              requestedAmountMinor: requestedAmount,
              sellerAccountId,
            },
          },
          tx,
        );
        await createAdminNotification(
          {
            kind: AdminNotificationKind.DISPUTE_OPENED,
            variables: { reference, reason: input.reasonCode, orderNumber: order.orderNumber },
            linkPath: consoleDisputePath(id),
            requiredPermission: Permission.DISPUTE_VIEW,
            relatedType: 'dispute',
            relatedId: id,
            dedupeKey: `dispute-opened:${id}`,
          },
          tx,
        );
        const row = await loadDispute(tx, id);
        await enqueueNotification(
          {
            eventKey: NotificationEvent.DISPUTE_RECEIVED,
            recipientEmail: actor.email,
            recipientName: row.order.customerProfile.fullName,
            variables: {
              reference,
              orderNumber: order.orderNumber,
              decisionDueAt: decisionDue.toISOString().slice(0, 10),
              disputeUrl: buyerDisputeUrl(reference),
            },
            dedupeKey: `dispute-received:${id}`,
            relatedType: 'dispute',
            relatedId: id,
          },
          tx,
        );
        await tellSeller(
          tx,
          row,
          `New claim ${reference} on order ${order.orderNumber}`,
          `A buyer has raised a claim. Answer it by ${sellerDue?.toISOString().slice(0, 16).replace('T', ' ') ?? ''} UTC with your account and any evidence.`,
          `dispute-opened:${id}`,
        );
        return row;
      });
      await dispatchPendingNotifications().catch(() => undefined);
      return { dispute: partyView(created, actor) };
    } catch (error) {
      const candidate = error as { code?: unknown; meta?: { target?: unknown } };
      if (attempt < 3 && candidate.code === 'P2002' && (JSON.stringify(candidate.meta?.target) ?? '').includes('reference')) {
        continue;
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Parties: reading
// ---------------------------------------------------------------------------

export async function listPartyDisputes(
  actor: PartyActor,
  query: { page: number; limit: number; orderId?: string | undefined; status?: 'OPEN' | 'CLOSED' | undefined },
) {
  const where: Prisma.DisputeWhereInput = {
    ...partyWhere(actor),
    ...(query.orderId === undefined ? {} : { orderId: query.orderId }),
    ...(query.status === undefined
      ? {}
      : query.status === 'OPEN'
        ? { status: { in: [...OPEN_CLAIM_STATUSES] } }
        : { status: { notIn: [...OPEN_CLAIM_STATUSES] } }),
  };
  const [rows, total] = await Promise.all([
    prisma.dispute.findMany({
      where,
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      select: SUMMARY_SELECT,
    }),
    prisma.dispute.count({ where }),
  ]);
  return {
    disputes: rows.map(summaryOf),
    pagination: { page: query.page, limit: query.limit, total, totalPages: Math.max(1, Math.ceil(total / query.limit)) },
  };
}

export async function readPartyDispute(actor: PartyActor, reference: string): Promise<PartyDisputeView> {
  return partyView(await loadDispute(prisma, await ownDisputeId(actor, reference)), actor);
}

// ---------------------------------------------------------------------------
// Parties: acting
// ---------------------------------------------------------------------------

/** A buyer or seller writes. The other party and staff see it. */
export async function addPartyMessage(actor: PartyActor, reference: string, rawBody: string): Promise<PartyDisputeView> {
  if (actor.side === 'SELLER') requireSellerCanRespond(actor);
  const body = cleanText(rawBody, 'body', { min: 1, max: DISPUTE_LIMITS.messageMax });
  const id = await ownDisputeId(actor, reference);
  const row = await prisma.$transaction(async (tx) => {
    const current = await loadDispute(tx, id);
    if (!acceptsMessages(current.status)) {
      throw conflict(ErrorCode.DISPUTE_TRANSITION_NOT_ALLOWED, 'This dispute is closed and takes no more messages.', [
        { code: 'CLOSED', meta: { from: current.status } },
      ]);
    }
    const now = new Date();
    await writeEvent(tx, {
      disputeId: id,
      kind: 'MESSAGE',
      party: actor.side,
      visibleToBuyer: true,
      visibleToSeller: true,
      actorUserId: actor.userId,
      body,
      createdAt: now,
    });
    await tx.dispute.update({ where: { id }, data: { lastActivityAt: now } });
    await recordAudit(
      {
        action: AuditAction.DISPUTE_MESSAGE_ADDED,
        resourceType: 'dispute',
        resourceId: id,
        ...auditActor(actor),
        after: { reference: current.reference, side: actor.side, length: body.length },
      },
      tx,
    );
    await bellStaff(tx, current, 'MESSAGE');
    if (actor.side === 'BUYER') {
      await tellSeller(tx, current, `The buyer wrote on claim ${current.reference}`, 'Open the claim to read it.');
    } else {
      await tellBuyer(tx, current, 'UPDATE');
    }
    return loadDispute(tx, id);
  });
  return partyView(row, actor);
}

export interface SellerResponseInput {
  body: string;
  proposal?: DisputeRemedyName | null | undefined;
  proposalAmountMinor?: string | null | undefined;
}

/**
 * The seller's answer: their account, and optionally what they offer. The
 * first answer to a claim waiting on them moves it to the operator's review.
 */
export async function respondAsSeller(
  actor: SellerActor,
  reference: string,
  input: SellerResponseInput,
): Promise<PartyDisputeView> {
  requireSellerCanRespond(actor);
  const body = cleanText(input.body, 'body', { min: DISPUTE_LIMITS.descriptionMin, max: DISPUTE_LIMITS.messageMax });
  const id = await ownDisputeId(actor, reference);
  const row = await prisma.$transaction(async (tx) => {
    const current = await loadDispute(tx, id);
    if (!['AWAITING_SELLER', 'UNDER_REVIEW', 'APPEALED'].includes(current.status)) {
      throw conflict(ErrorCode.DISPUTE_TRANSITION_NOT_ALLOWED, 'This claim is not waiting for an answer.', [
        { code: 'TRANSITION', meta: { from: current.status } },
      ]);
    }
    const proposal = input.proposal ?? null;
    let amount: bigint | null = null;
    if (proposal === 'REFUND_PARTIAL') {
      const cap = claimCap(current);
      amount = parseMinor(input.proposalAmountMinor, 'proposalAmountMinor');
      if (amount === null || amount <= 0n || amount > cap) {
        throw badRequest(ErrorCode.DISPUTE_AMOUNT_INVALID, 'Offer an amount greater than zero and no more than the claim can be about.', [
          { field: 'proposalAmountMinor', code: amount === null ? 'REQUIRED' : 'OUT_OF_RANGE', meta: { maxMinor: cap.toString() } },
        ]);
      }
    } else if (proposal === 'REFUND_FULL') {
      amount = claimCap(current);
    }
    const now = new Date();
    await writeEvent(tx, {
      disputeId: id,
      kind: 'SELLER_RESPONSE',
      party: 'SELLER',
      visibleToBuyer: true,
      visibleToSeller: true,
      actorUserId: actor.userId,
      body,
      toValue: proposal,
      amountMinor: amount,
      createdAt: now,
    });
    await tx.dispute.update({
      where: { id },
      data: {
        lastActivityAt: now,
        sellerRespondedAt: current.sellerRespondedAt ?? now,
        ...(proposal === null ? {} : { sellerProposal: proposal, sellerProposalAmountMinor: amount }),
      },
    });
    if (current.status === 'AWAITING_SELLER') {
      await moveStatus(tx, current, 'UNDER_REVIEW', {}, { party: 'SELLER', actorUserId: actor.userId, at: new Date(now.getTime() + 1) });
    }
    await recordAudit(
      {
        action: AuditAction.DISPUTE_SELLER_RESPONDED,
        resourceType: 'dispute',
        resourceId: id,
        ...auditActor(actor),
        after: { reference: current.reference, proposal, proposalAmountMinor: amount, onTime: !isBreached(current.sellerResponseDueAt, now, now) },
      },
      tx,
    );
    await bellStaff(tx, current, 'SELLER_RESPONSE');
    await tellBuyer(tx, current, 'UPDATE');
    return loadDispute(tx, id);
  });
  return partyView(row, actor);
}

/** The buyer asks the operator to step in, once the seller's time is up. */
export async function escalateClaim(actor: BuyerActor, reference: string): Promise<PartyDisputeView> {
  const id = await ownDisputeId(actor, reference);
  const row = await prisma.$transaction(async (tx) => {
    const current = await loadDispute(tx, id);
    const now = new Date();
    if (current.status === 'AWAITING_SELLER' && current.sellerResponseDueAt !== null && current.sellerResponseDueAt.getTime() >= now.getTime()) {
      throw conflict(ErrorCode.DISPUTE_TRANSITION_NOT_ALLOWED, 'The seller still has time to answer. You can ask us to step in once it has passed.', [
        { code: 'SELLER_STILL_HAS_TIME', meta: { from: current.status, dueAt: current.sellerResponseDueAt.toISOString() } },
      ]);
    }
    await moveStatus(tx, current, 'UNDER_REVIEW', {}, { party: 'BUYER', actorUserId: actor.userId, at: now });
    await writeEvent(tx, { disputeId: id, kind: 'ESCALATED', party: 'BUYER', visibleToBuyer: true, visibleToSeller: true, actorUserId: actor.userId, createdAt: new Date(now.getTime() + 1) });
    await recordAudit({ action: AuditAction.DISPUTE_ESCALATED, resourceType: 'dispute', resourceId: id, ...auditActor(actor), after: { reference: current.reference } }, tx);
    await bellStaff(tx, current, 'ESCALATED');
    await tellSeller(tx, current, `Claim ${current.reference} went to the marketplace`, 'The buyer asked the marketplace to decide, because the time to answer had passed.');
    return loadDispute(tx, id);
  });
  return partyView(row, actor);
}

/** The buyer takes the claim back. Final. */
export async function withdrawClaim(actor: BuyerActor, reference: string): Promise<PartyDisputeView> {
  const id = await ownDisputeId(actor, reference);
  const row = await prisma.$transaction(async (tx) => {
    const current = await loadDispute(tx, id);
    const now = new Date();
    await moveStatus(tx, current, 'WITHDRAWN', { closedAt: now }, { party: 'BUYER', actorUserId: actor.userId, at: now });
    await writeEvent(tx, { disputeId: id, kind: 'WITHDRAWN', party: 'BUYER', visibleToBuyer: true, visibleToSeller: true, actorUserId: actor.userId, createdAt: new Date(now.getTime() + 1) });
    await recordAudit({ action: AuditAction.DISPUTE_WITHDRAWN, resourceType: 'dispute', resourceId: id, ...auditActor(actor), after: { reference: current.reference } }, tx);
    await bellStaff(tx, current, 'WITHDRAWN');
    await tellSeller(tx, current, `Claim ${current.reference} was withdrawn`, 'The buyer withdrew the claim. Nothing more is needed from you.');
    return loadDispute(tx, id);
  });
  return partyView(row, actor);
}

/** Either party asks for a decision to be looked at again. Once, inside the window. */
export async function appealDecision(actor: PartyActor, reference: string, rawBody: string): Promise<PartyDisputeView> {
  if (actor.side === 'SELLER') requireSellerCanRespond(actor);
  const body = cleanText(rawBody, 'body', { min: DISPUTE_LIMITS.descriptionMin, max: DISPUTE_LIMITS.messageMax });
  const id = await ownDisputeId(actor, reference);
  const settings = await readDisputeSettings();
  const row = await prisma.$transaction(async (tx) => {
    const current = await loadDispute(tx, id);
    const now = new Date();
    if (current.status !== 'RESOLVED' && current.status !== 'REJECTED') {
      assertDisputeTransition('CLAIM', current.status, 'APPEALED');
    }
    if (current.appealCount > 0) {
      throw conflict(ErrorCode.DISPUTE_APPEAL_NOT_ALLOWED, 'This decision has already been appealed once.', [{ code: 'ALREADY_APPEALED' }]);
    }
    if (current.appealDueAt === null || current.appealDueAt.getTime() < now.getTime()) {
      throw conflict(ErrorCode.DISPUTE_APPEAL_NOT_ALLOWED, 'The time to appeal this decision has passed.', [{ code: 'WINDOW_CLOSED' }]);
    }
    await moveStatus(
      tx,
      current,
      'APPEALED',
      { appealCount: { increment: 1 }, closedAt: null, appealDueAt: null, decisionDueAt: addHours(now, settings.decisionHours) },
      { party: actor.side, actorUserId: actor.userId, at: now },
    );
    await writeEvent(tx, { disputeId: id, kind: 'APPEALED', party: actor.side, visibleToBuyer: true, visibleToSeller: true, actorUserId: actor.userId, body, createdAt: new Date(now.getTime() + 1) });
    await recordAudit({ action: AuditAction.DISPUTE_APPEALED, resourceType: 'dispute', resourceId: id, ...auditActor(actor), after: { reference: current.reference, side: actor.side, from: current.status } }, tx);
    await bellStaff(tx, current, 'APPEALED');
    if (actor.side === 'BUYER') {
      await tellSeller(tx, current, `The buyer appealed the decision on ${current.reference}`, 'The marketplace will look at the claim again.');
    } else {
      await tellBuyer(tx, current, 'UPDATE');
    }
    return loadDispute(tx, id);
  });
  return partyView(row, actor);
}

// ---------------------------------------------------------------------------
// Staff: the queue
// ---------------------------------------------------------------------------

export interface AdminDisputeQuery {
  page: number;
  limit: number;
  /** A status, or `OPEN` for everything somebody still has to act on. */
  status?: DisputeStatusName | 'OPEN' | undefined;
  kind?: 'CLAIM' | 'CHARGEBACK' | undefined;
  breached?: boolean | undefined;
  assignee?: string | undefined;
  search?: string | undefined;
}

/** Past a deadline and still waiting on it. */
function breachedWhere(now: Date): Prisma.DisputeWhereInput {
  return {
    OR: [
      { status: 'AWAITING_SELLER', sellerResponseDueAt: { lt: now } },
      { status: { in: [...OPEN_CLAIM_STATUSES] }, decisionDueAt: { lt: now } },
      { status: 'NEEDS_RESPONSE', evidenceDueAt: { lt: now } },
    ],
  };
}

export async function listDisputesForAdmin(actor: StaffActor, query: AdminDisputeQuery) {
  requirePermission(actor, Permission.DISPUTE_VIEW);
  const now = new Date();
  const search = query.search?.trim() ?? '';
  const and: Prisma.DisputeWhereInput[] = [];
  if (query.status === 'OPEN') and.push({ status: { in: [...OPEN_STATUSES] } });
  else if (query.status !== undefined) and.push({ status: query.status });
  if (query.kind !== undefined) and.push({ kind: query.kind });
  if (query.breached === true) and.push(breachedWhere(now));
  if (query.assignee !== undefined) {
    and.push(
      query.assignee === 'unassigned'
        ? { assignedAdminId: null }
        : { assignedAdminId: query.assignee === 'me' ? actor.userId : query.assignee },
    );
  }
  if (search.length > 0) {
    and.push({
      OR: [
        { reference: { contains: search.toUpperCase() } },
        { order: { orderNumber: { contains: search.toUpperCase() } } },
        { providerDisputeId: { contains: search } },
        { sellerAccount: { displayName: { contains: search } } },
      ],
    });
  }
  const where: Prisma.DisputeWhereInput = and.length === 0 ? {} : { AND: and };

  const [rows, total, grouped, breachedCount] = await Promise.all([
    prisma.dispute.findMany({
      where,
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: {
        order: { select: { orderNumber: true } },
        orderItem: { select: { nameSnapshot: true } },
        sellerAccount: { select: { displayName: true } },
        assignedAdmin: { select: { id: true, email: true } },
      },
    }),
    prisma.dispute.count({ where }),
    prisma.dispute.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.dispute.count({ where: breachedWhere(now) }),
  ]);

  return {
    disputes: rows.map((row) => ({
      id: row.id,
      ...summaryOf(row),
      sellerName: row.sellerAccount?.displayName ?? null,
      assignee: row.assignedAdmin,
      disputedAmount: money(row.disputedAmountMinor, row.currency),
      evidenceDueAt: iso(row.evidenceDueAt),
      sla: {
        sellerResponseBreached:
          row.status === 'AWAITING_SELLER' && isBreached(row.sellerResponseDueAt, row.sellerRespondedAt, now),
        decisionBreached: OPEN_CLAIM_STATUSES.includes(row.status) && isBreached(row.decisionDueAt, null, now),
        evidenceBreached: row.status === 'NEEDS_RESPONSE' && isBreached(row.evidenceDueAt, null, now),
      },
    })),
    counts: { ...Object.fromEntries(grouped.map((entry) => [entry.status, entry._count._all])), BREACHED: breachedCount },
    pagination: { page: query.page, limit: query.limit, total, totalPages: Math.max(1, Math.ceil(total / query.limit)) },
  };
}

async function emailsFor(ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: wanted } }, select: { id: true, email: true } });
  return new Map(users.map((user) => [user.id, user.email]));
}

export async function readDisputeForAdmin(actor: StaffActor, id: string) {
  requirePermission(actor, Permission.DISPUTE_VIEW);
  const row = await loadDispute(prisma, id);
  const now = new Date();
  const emails = await emailsFor([row.proposedById, row.decidedById, row.approvedById]);
  const payment =
    row.paymentTransactionId === null
      ? await prisma.paymentTransaction.findFirst({
          where: { orderId: row.orderId, status: 'CAPTURED' },
          orderBy: { capturedAt: 'desc' },
          select: { id: true, provider: true, status: true, disputedAt: true, amountMinor: true },
        })
      : await prisma.paymentTransaction.findUnique({
          where: { id: row.paymentTransactionId },
          select: { id: true, provider: true, status: true, disputedAt: true, amountMinor: true },
        });
  const openChargeback =
    row.kind === 'CLAIM'
      ? await prisma.dispute.findFirst({
          where: { orderId: row.orderId, kind: 'CHARGEBACK', status: { in: [...OPEN_CHARGEBACK_STATUSES] } },
          select: { id: true, reference: true, status: true },
        })
      : null;
  const settings = await readDisputeSettings();
  const pending = row.status === 'PENDING_APPROVAL';

  return {
    id: row.id,
    reference: row.reference,
    kind: row.kind,
    status: row.status,
    reasonCode: row.reasonCode,
    description: row.description,
    desiredOutcome: row.desiredOutcome,
    requestedAmount: money(row.requestedAmountMinor, row.currency),
    currency: row.currency,
    order: {
      id: actor.permissions.has(Permission.ORDER_READ) ? row.order.id : null,
      orderNumber: row.order.orderNumber,
      status: row.order.status,
      paid: money(row.order.paidMinor, row.currency),
      refunded: money(row.order.refundedMinor, row.currency),
      maxRefundable: money(maxRefundable(row.order), row.currency),
      claimCap: money(claimCap(row), row.currency),
    },
    payment:
      payment === null
        ? null
        : { provider: payment.provider, status: payment.status, disputedAt: iso(payment.disputedAt), amount: money(payment.amountMinor, row.currency) },
    openChargeback,
    buyer: { name: row.order.customerProfile.fullName, email: row.order.customerProfile.user.email },
    line:
      row.orderItem === null
        ? null
        : {
            name: row.orderItem.nameSnapshot,
            variant: row.orderItem.variantNameSnapshot,
            sku: row.orderItem.skuSnapshot,
            quantity: row.orderItem.quantity,
            lineTotal: money(row.orderItem.lineTotalMinor, row.currency),
          },
    seller: row.sellerAccount,
    sellerOrder: row.sellerOrderGroup,
    sellerProposal:
      row.sellerProposal === null ? null : { resolution: row.sellerProposal, amount: money(row.sellerProposalAmountMinor, row.currency) },
    proposal: !pending
      ? null
      : {
          resolution: row.proposedResolution,
          amount: money(row.proposedAmountMinor, row.currency),
          reason: row.proposedReason,
          proposedBy: row.proposedById === null ? null : { id: row.proposedById, email: emails.get(row.proposedById) ?? null },
          proposedAt: iso(row.proposedAt),
        },
    decision:
      row.resolution === null
        ? null
        : {
            ...decisionView(row),
            decidedBy: row.decidedById === null ? null : { id: row.decidedById, email: emails.get(row.decidedById) ?? null },
            approvedBy: row.approvedById === null ? null : { id: row.approvedById, email: emails.get(row.approvedById) ?? null },
            refundId: row.refundId,
          },
    chargeback:
      row.kind === 'CHARGEBACK'
        ? {
            providerDisputeId: row.providerDisputeId,
            providerStatus: row.providerStatus,
            disputedAmount: money(row.disputedAmountMinor, row.currency),
            evidenceDueAt: iso(row.evidenceDueAt),
          }
        : null,
    assignee: row.assignedAdmin,
    sla: slaFor(row, now),
    appealCount: row.appealCount,
    approval: {
      thresholdMinor: settings.approvalThresholdMinor.toString(),
      currency: settings.approvalCurrency,
    },
    attachments: attachmentsView(row),
    events: row.events.map((event) => ({
      id: event.id,
      kind: event.kind,
      party: event.party,
      visibleToBuyer: event.visibleToBuyer,
      visibleToSeller: event.visibleToSeller,
      actor: event.actor,
      body: event.body,
      fromValue: event.fromValue,
      toValue: event.toValue,
      amount: money(event.amountMinor, row.currency),
      createdAt: event.createdAt.toISOString(),
    })),
    can: {
      manage: actor.permissions.has(Permission.DISPUTE_MANAGE) && row.kind === 'CLAIM' && acceptsMessages(row.status),
      note: actor.permissions.has(Permission.DISPUTE_MANAGE),
      decide:
        actor.permissions.has(Permission.DISPUTE_MANAGE) &&
        row.kind === 'CLAIM' &&
        ['AWAITING_SELLER', 'UNDER_REVIEW', 'APPEALED'].includes(row.status),
      refundDirectly: actor.permissions.has(Permission.REFUND_CREATE),
      approve:
        pending &&
        actor.permissions.has(Permission.DISPUTE_APPROVE) &&
        row.proposedById !== actor.userId,
      assign: actor.permissions.has(Permission.DISPUTE_ASSIGN),
    },
    closedAt: iso(row.closedAt),
    lastActivityAt: row.lastActivityAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Staff: talking, notes, assignment
// ---------------------------------------------------------------------------

export async function addStaffMessage(
  actor: StaffActor,
  id: string,
  input: { body: string; audience: 'BUYER' | 'SELLER' | 'BOTH' },
): Promise<void> {
  requirePermission(actor, Permission.DISPUTE_MANAGE);
  const body = cleanText(input.body, 'body', { min: 1, max: DISPUTE_LIMITS.messageMax });
  await prisma.$transaction(async (tx) => {
    const current = await loadDispute(tx, id);
    if (current.kind !== 'CLAIM' || !acceptsMessages(current.status)) {
      throw conflict(ErrorCode.DISPUTE_TRANSITION_NOT_ALLOWED, 'This dispute takes no messages to the parties.', [
        { code: 'CLOSED', meta: { from: current.status } },
      ]);
    }
    if (input.audience !== 'BUYER' && current.sellerAccountId === null) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'There is no seller on this claim to write to.', [{ field: 'audience', code: 'NO_SELLER' }]);
    }
    const toBuyer = input.audience !== 'SELLER';
    const toSeller = input.audience !== 'BUYER';
    const now = new Date();
    await writeEvent(tx, { disputeId: id, kind: 'MESSAGE', party: 'STAFF', visibleToBuyer: toBuyer, visibleToSeller: toSeller, actorUserId: actor.userId, body, createdAt: now });
    await tx.dispute.update({ where: { id }, data: { lastActivityAt: now, ...(current.assignedAdminId === null ? { assignedAdminId: actor.userId } : {}) } });
    await recordAudit({ action: AuditAction.DISPUTE_MESSAGE_ADDED, resourceType: 'dispute', resourceId: id, ...auditActor(actor), after: { reference: current.reference, audience: input.audience, length: body.length } }, tx);
    if (toBuyer) await tellBuyer(tx, current, 'UPDATE');
    if (toSeller) await tellSeller(tx, current, `The marketplace wrote on claim ${current.reference}`, 'Open the claim to read it.');
  });
  await dispatchPendingNotifications().catch(() => undefined);
}

/** A note for colleagues, or an evidence note on a chargeback. Never shown to a party. */
export async function addStaffNote(
  actor: StaffActor,
  id: string,
  input: { body: string; kind: 'INTERNAL_NOTE' | 'EVIDENCE_NOTE' },
): Promise<void> {
  requirePermission(actor, Permission.DISPUTE_MANAGE);
  const body = cleanText(input.body, 'body', { min: 1, max: DISPUTE_LIMITS.messageMax });
  await prisma.$transaction(async (tx) => {
    const current = await loadDispute(tx, id);
    await writeEvent(tx, { disputeId: id, kind: input.kind, party: 'STAFF', visibleToBuyer: false, visibleToSeller: false, actorUserId: actor.userId, body });
    await tx.dispute.update({ where: { id }, data: { lastActivityAt: new Date() } });
    await recordAudit({ action: AuditAction.DISPUTE_NOTE_ADDED, resourceType: 'dispute', resourceId: id, ...auditActor(actor), after: { reference: current.reference, kind: input.kind, length: body.length } }, tx);
  });
}

/** Staff take a claim into review before the seller's time is up. */
export async function startReview(actor: StaffActor, id: string): Promise<void> {
  requirePermission(actor, Permission.DISPUTE_MANAGE);
  await prisma.$transaction(async (tx) => {
    const current = await loadDispute(tx, id);
    await moveStatus(tx, current, 'UNDER_REVIEW', current.assignedAdminId === null ? { assignedAdminId: actor.userId } : {}, {
      party: 'STAFF',
      actorUserId: actor.userId,
      at: new Date(),
    });
    await recordAudit({ action: AuditAction.DISPUTE_ESCALATED, resourceType: 'dispute', resourceId: id, ...auditActor(actor), after: { reference: current.reference, by: 'STAFF' } }, tx);
  });
}

/** Active staff who may work disputes - the only valid assignees. */
export async function listDisputeAssignees(): Promise<{ id: string; email: string }[]> {
  const users = await prisma.user.findMany({
    where: { type: 'ADMIN', status: 'ACTIVE', archivedAt: null },
    select: { id: true, email: true, roles: { select: { role: { select: { key: true } } } } },
    orderBy: { email: 'asc' },
    take: 500,
  });
  return users
    .filter((user) => permissionsForRoles(user.roles.map((grant) => grant.role.key)).has(Permission.DISPUTE_MANAGE))
    .map((user) => ({ id: user.id, email: user.email }));
}

export async function assignDispute(actor: StaffActor, id: string, assigneeUserId: string | null): Promise<void> {
  const current = await prisma.dispute.findUnique({ where: { id }, select: { id: true, reference: true, assignedAdminId: true } });
  if (current === null) throw notFound('Dispute');
  const selfTake = assigneeUserId === actor.userId;
  const selfRelease = assigneeUserId === null && current.assignedAdminId === actor.userId;
  requirePermission(actor, selfTake || selfRelease ? Permission.DISPUTE_MANAGE : Permission.DISPUTE_ASSIGN);
  if (assigneeUserId !== null && !(await listDisputeAssignees()).some((user) => user.id === assigneeUserId)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'That member of staff cannot work disputes.', [{ field: 'assigneeUserId', code: 'NOT_ELIGIBLE' }]);
  }
  if (current.assignedAdminId === assigneeUserId) return;
  await prisma.$transaction(async (tx) => {
    await tx.dispute.update({ where: { id }, data: { assignedAdminId: assigneeUserId } });
    await writeEvent(tx, { disputeId: id, kind: 'ASSIGNED', party: 'STAFF', visibleToBuyer: false, visibleToSeller: false, actorUserId: actor.userId, fromValue: current.assignedAdminId, toValue: assigneeUserId });
    await recordAudit({ action: AuditAction.DISPUTE_ASSIGNED, resourceType: 'dispute', resourceId: id, ...auditActor(actor), before: { assignedAdminId: current.assignedAdminId }, after: { assignedAdminId: assigneeUserId } }, tx);
  });
}

// ---------------------------------------------------------------------------
// Staff: deciding
// ---------------------------------------------------------------------------

export interface DecisionInput {
  resolution: DisputeResolutionName;
  /** Minor units as a string. Required for a partial refund; ignored otherwise. */
  amountMinor?: string | null | undefined;
  reason: string;
}

/** The amount a decision moves, worked out and checked against what can move. */
function decisionAmount(row: DisputeRow, resolution: DisputeResolutionName, raw: string | null | undefined): bigint | null {
  if (!isRefund(resolution)) return null;
  const cap = claimCap(row);
  if (cap <= 0n) {
    throw conflict(ErrorCode.REFUND_EXCEEDS_CAPTURED, 'This order has already been refunded in full.', [
      { field: 'amountMinor', code: 'EXCEEDS_MAX', meta: { maxRefundableMinor: '0' } },
    ]);
  }
  if (resolution === 'REFUND_FULL') return cap;
  const amount = parseMinor(raw, 'amountMinor');
  if (amount === null || amount <= 0n) {
    throw badRequest(ErrorCode.DISPUTE_AMOUNT_INVALID, 'Enter the amount to refund.', [
      { field: 'amountMinor', code: amount === null ? 'REQUIRED' : 'INVALID', meta: { maxMinor: cap.toString() } },
    ]);
  }
  // Never more than was paid less what has already gone back - the refund rule.
  const left = maxRefundable(row.order);
  if (amount > left) {
    throw conflict(
      ErrorCode.REFUND_EXCEEDS_CAPTURED,
      `The maximum refundable amount is ${serialiseMoney(left, row.currency).formatted} ${row.currency}.`,
      [{ field: 'amountMinor', code: 'EXCEEDS_MAX', meta: { maxRefundableMinor: left.toString(), requestedMinor: amount.toString() } }],
    );
  }
  return amount;
}

async function assertNoOpenChargeback(orderId: string): Promise<void> {
  const open = await prisma.dispute.findFirst({
    where: { orderId, kind: 'CHARGEBACK', status: { in: [...OPEN_CHARGEBACK_STATUSES] } },
    select: { reference: true },
  });
  if (open !== null) {
    throw conflict(
      ErrorCode.DISPUTE_CHARGEBACK_OPEN,
      "This order's payment is under a chargeback. Refunding it as well could pay the buyer twice; the chargeback decides the money.",
      [{ code: 'CHARGEBACK_OPEN', meta: { reference: open.reference } }],
    );
  }
}

/**
 * Decide a claim. A refund above the approval threshold becomes a proposal
 * for a second member of staff; everything else is applied now.
 */
export async function decideDispute(actor: StaffActor, id: string, input: DecisionInput): Promise<{ applied: boolean }> {
  requirePermission(actor, Permission.DISPUTE_MANAGE);
  const reason = cleanText(input.reason, 'reason', { min: DISPUTE_LIMITS.reasonMin, max: DISPUTE_LIMITS.reasonMax });
  const row = await loadDispute(prisma, id);
  if (row.kind !== 'CLAIM') {
    throw conflict(ErrorCode.DISPUTE_TRANSITION_NOT_ALLOWED, 'A chargeback is decided by the card network, not here.', [
      { code: 'CHARGEBACK', meta: { from: row.status } },
    ]);
  }
  if (!['AWAITING_SELLER', 'UNDER_REVIEW', 'APPEALED'].includes(row.status)) {
    assertDisputeTransition('CLAIM', row.status, statusForDecision(input.resolution));
    throw conflict(ErrorCode.DISPUTE_TRANSITION_NOT_ALLOWED, 'This claim is not waiting for a decision.');
  }
  const amount = decisionAmount(row, input.resolution, input.amountMinor);
  if (isRefund(input.resolution)) await assertNoOpenChargeback(row.orderId);

  const settings = await readDisputeSettings();
  const needsApproval =
    amount !== null &&
    needsSecondApproval({
      resolution: input.resolution,
      amountMinor: amount,
      currency: row.currency,
      thresholdMinor: settings.approvalThresholdMinor,
      thresholdCurrency: settings.approvalCurrency,
    });

  if (needsApproval) {
    await prisma.$transaction(async (tx) => {
      const now = new Date();
      await moveStatus(
        tx,
        row,
        'PENDING_APPROVAL',
        {
          proposedResolution: input.resolution,
          proposedAmountMinor: amount,
          proposedReason: reason,
          proposedById: actor.userId,
          proposedAt: now,
        },
        { party: 'STAFF', actorUserId: actor.userId, at: now },
      );
      await writeEvent(tx, { disputeId: id, kind: 'DECISION_PROPOSED', party: 'STAFF', visibleToBuyer: false, visibleToSeller: false, actorUserId: actor.userId, body: reason, toValue: input.resolution, amountMinor: amount, createdAt: new Date(now.getTime() + 1) });
      await recordAudit({ action: AuditAction.DISPUTE_DECISION_PROPOSED, resourceType: 'dispute', resourceId: id, ...auditActor(actor), after: { reference: row.reference, resolution: input.resolution, amountMinor: amount, thresholdMinor: settings.approvalThresholdMinor, thresholdCurrency: settings.approvalCurrency } }, tx);
      await createAdminNotification(
        {
          kind: AdminNotificationKind.DISPUTE_APPROVAL_REQUESTED,
          variables: { reference: row.reference, amount: serialiseMoney(amount, row.currency).formatted, currency: row.currency, proposedBy: actor.email },
          linkPath: consoleDisputePath(id),
          requiredPermission: Permission.DISPUTE_APPROVE,
          relatedType: 'dispute',
          relatedId: id,
          dedupeKey: `dispute-approval:${id}:${now.getTime()}`,
        },
        tx,
      );
    });
    return { applied: false };
  }

  if (isRefund(input.resolution)) requirePermission(actor, Permission.REFUND_CREATE);
  await applyDecision(actor, row, { resolution: input.resolution, amount, reason, decidedById: actor.userId, approvedById: null });
  return { applied: true };
}

/** A second member of staff approves a colleague's proposal. Never their own. */
export async function approveDecision(actor: StaffActor, id: string): Promise<void> {
  requirePermission(actor, Permission.DISPUTE_APPROVE);
  const row = await loadDispute(prisma, id);
  if (row.status !== 'PENDING_APPROVAL' || row.proposedResolution === null) {
    throw conflict(ErrorCode.DISPUTE_TRANSITION_NOT_ALLOWED, 'There is no decision waiting for approval on this dispute.', [
      { code: 'TRANSITION', meta: { from: row.status } },
    ]);
  }
  if (row.proposedById === actor.userId) {
    throw forbidden(ErrorCode.DISPUTE_SELF_APPROVAL_FORBIDDEN, 'A decision must be approved by somebody other than the person who proposed it.');
  }
  if (isRefund(row.proposedResolution)) {
    requirePermission(actor, Permission.REFUND_CREATE);
    await assertNoOpenChargeback(row.orderId);
    const left = maxRefundable(row.order);
    if ((row.proposedAmountMinor ?? 0n) > left) {
      throw conflict(ErrorCode.REFUND_EXCEEDS_CAPTURED, `The maximum refundable amount is now ${serialiseMoney(left, row.currency).formatted} ${row.currency}.`, [
        { field: 'amountMinor', code: 'EXCEEDS_MAX', meta: { maxRefundableMinor: left.toString() } },
      ]);
    }
  }
  await applyDecision(actor, row, {
    resolution: row.proposedResolution,
    amount: row.proposedAmountMinor,
    reason: row.proposedReason ?? '',
    decidedById: row.proposedById ?? actor.userId,
    approvedById: actor.userId,
  });
}

/** A second member of staff sends a proposal back, with their reason. */
export async function refuseDecision(actor: StaffActor, id: string, rawReason: string): Promise<void> {
  requirePermission(actor, Permission.DISPUTE_APPROVE);
  const reason = cleanText(rawReason, 'reason', { min: DISPUTE_LIMITS.reasonMin, max: DISPUTE_LIMITS.reasonMax });
  const row = await loadDispute(prisma, id);
  if (row.status !== 'PENDING_APPROVAL') {
    throw conflict(ErrorCode.DISPUTE_TRANSITION_NOT_ALLOWED, 'There is no decision waiting for approval on this dispute.', [
      { code: 'TRANSITION', meta: { from: row.status } },
    ]);
  }
  if (row.proposedById === actor.userId) {
    throw forbidden(ErrorCode.DISPUTE_SELF_APPROVAL_FORBIDDEN, 'A decision must be reviewed by somebody other than the person who proposed it.');
  }
  await prisma.$transaction(async (tx) => {
    const now = new Date();
    await moveStatus(
      tx,
      row,
      'UNDER_REVIEW',
      { proposedResolution: null, proposedAmountMinor: null, proposedReason: null, proposedById: null, proposedAt: null },
      { party: 'STAFF', actorUserId: actor.userId, at: now },
    );
    await writeEvent(tx, { disputeId: id, kind: 'DECISION_REFUSED', party: 'STAFF', visibleToBuyer: false, visibleToSeller: false, actorUserId: actor.userId, body: reason, toValue: row.proposedResolution, amountMinor: row.proposedAmountMinor, createdAt: new Date(now.getTime() + 1) });
    await recordAudit({ action: AuditAction.DISPUTE_DECISION_REFUSED, resourceType: 'dispute', resourceId: id, ...auditActor(actor), before: { resolution: row.proposedResolution, amountMinor: row.proposedAmountMinor, proposedById: row.proposedById }, after: { reference: row.reference } }, tx);
  });
}

const OUTCOME_WORDS: Record<DisputeResolutionName, string> = {
  REFUND_FULL: 'a full refund',
  REFUND_PARTIAL: 'a partial refund',
  REPLACEMENT: 'a replacement from the seller',
  REJECT: 'the claim was not upheld',
};

/**
 * Carry out a decision: the refund through the ordinary refund path first,
 * then the dispute's own record, in that order.
 *
 * The refund is keyed `dispute:<id>:<round>`, so a retry after a crash - or
 * a second click - finds the refund already made rather than making another.
 * If the refund fails at the provider nothing about the dispute changes and
 * the error goes back to the person deciding.
 */
async function applyDecision(
  actor: StaffActor,
  row: DisputeRow,
  decision: {
    resolution: DisputeResolutionName;
    amount: bigint | null;
    reason: string;
    decidedById: string;
    approvedById: string | null;
  },
): Promise<void> {
  let refundId: string | null = null;
  if (isRefund(decision.resolution) && decision.amount !== null) {
    const idempotencyKey = `dispute:${row.id}:${String(row.appealCount)}`;
    const existing = await prisma.refund.findUnique({ where: { idempotencyKey }, select: { id: true } });
    refundId =
      existing?.id ??
      (
        await createRefund({
          orderId: row.orderId,
          amountMinor: decision.amount.toString(),
          reason: `Dispute ${row.reference}: ${decision.reason}`.slice(0, 500),
          idempotencyKey,
          actorUserId: actor.userId,
          actorEmail: actor.email,
          ipAddress: actor.ipAddress ?? null,
          correlationId: actor.correlationId ?? null,
        })
      ).refundId;
  }

  const settings = await readDisputeSettings();
  const to = statusForDecision(decision.resolution);
  await prisma.$transaction(async (tx) => {
    const now = new Date();
    const appealDueAt = row.appealCount === 0 && settings.appealWindowDays > 0 ? addHours(now, settings.appealWindowDays * 24) : null;
    await moveStatus(
      tx,
      row,
      to,
      {
        resolution: decision.resolution,
        resolutionAmountMinor: decision.amount,
        decisionReason: decision.reason,
        decidedById: decision.decidedById,
        approvedById: decision.approvedById,
        decidedAt: now,
        refundId,
        appealDueAt,
        closedAt: now,
        proposedResolution: null,
        proposedAmountMinor: null,
        proposedReason: null,
        proposedById: null,
        proposedAt: null,
      },
      { party: 'STAFF', actorUserId: actor.userId, at: now },
    );
    if (decision.approvedById !== null) {
      await writeEvent(tx, { disputeId: row.id, kind: 'DECISION_APPROVED', party: 'STAFF', visibleToBuyer: false, visibleToSeller: false, actorUserId: decision.approvedById, toValue: decision.resolution, amountMinor: decision.amount, createdAt: new Date(now.getTime() + 1) });
    }
    // The decision and its reason, told to both parties.
    await writeEvent(tx, { disputeId: row.id, kind: 'DECISION_APPLIED', party: 'STAFF', visibleToBuyer: true, visibleToSeller: true, actorUserId: decision.decidedById, body: decision.reason, toValue: decision.resolution, amountMinor: decision.amount, createdAt: new Date(now.getTime() + 2) });
    await recordAudit(
      {
        action: decision.approvedById === null ? AuditAction.DISPUTE_DECIDED : AuditAction.DISPUTE_DECISION_APPROVED,
        resourceType: 'dispute',
        resourceId: row.id,
        ...auditActor(actor),
        before: { status: row.status },
        after: {
          reference: row.reference,
          status: to,
          resolution: decision.resolution,
          amountMinor: decision.amount,
          refundId,
          decidedById: decision.decidedById,
          approvedById: decision.approvedById,
        },
      },
      tx,
    );
    await tellBuyer(tx, row, 'DECIDED', { outcome: OUTCOME_WORDS[decision.resolution] });
    await tellSeller(
      tx,
      row,
      `Claim ${row.reference} was decided`,
      decision.resolution === 'REPLACEMENT'
        ? 'The marketplace decided the buyer should receive a replacement. Please send one and record it on the order.'
        : isRefund(decision.resolution)
          ? 'The marketplace refunded the buyer. Your settlement for this order reflects it.'
          : 'The marketplace did not uphold the claim.',
    );
  });
  await dispatchPendingNotifications().catch(() => undefined);
}

/**
 * What a decision would do to the money, before anybody makes it: the
 * amount, whether it needs a second approval, and each seller's settlement
 * before and after - worked out with the same rule the settlements use.
 */
export async function previewDecision(
  actor: StaffActor,
  id: string,
  input: { resolution: DisputeResolutionName; amountMinor?: string | null | undefined },
) {
  requirePermission(actor, Permission.DISPUTE_VIEW);
  const row = await loadDispute(prisma, id);
  const settings = await readDisputeSettings();
  let amount: bigint | null = null;
  let problem: string | null = null;
  try {
    amount = decisionAmount(row, input.resolution, input.amountMinor);
  } catch (error) {
    problem = error instanceof AppError ? error.code : 'INVALID';
  }
  const settlements = await prisma.sellerOrderSettlement.findMany({
    where: { sellerOrderGroup: { orderId: row.orderId } },
    select: {
      sellerOrderGroupId: true,
      currency: true,
      grossProceedsMinor: true,
      sellerDeliveryProceedsMinor: true,
      platformFeeMinor: true,
      platformFeeTaxMinor: true,
      refundsAdjustmentsMinor: true,
      estimatedSettlementMinor: true,
      sellerOrderGroup: {
        select: {
          sellerOrderNumber: true,
          sellerAccount: { select: { displayName: true } },
          commissionInvoices: { select: { number: true, status: true }, take: 1, orderBy: { createdAt: 'desc' } },
        },
      },
    },
  });
  const succeeded = await prisma.refund.aggregate({ where: { orderId: row.orderId, status: 'SUCCEEDED', currency: row.currency }, _sum: { amountMinor: true } });
  const operatorLineCount = await prisma.orderItem.count({ where: { orderId: row.orderId, sellerOfferId: null } });
  const attribution = attributeRefundsToSellers({
    succeededRefundsMinor: (succeeded._sum.amountMinor ?? 0n) + (amount ?? 0n),
    paidMinor: row.order.paidMinor,
    grandTotalMinor: row.order.grandTotalMinor,
    operatorLineCount,
    groups: settlements.map((s) => ({ id: s.sellerOrderGroupId, proceedsMinor: s.grossProceedsMinor + s.sellerDeliveryProceedsMinor })),
  });

  return {
    resolution: input.resolution,
    amount: money(amount, row.currency),
    problem,
    maxRefundable: money(maxRefundable(row.order), row.currency),
    needsApproval:
      amount !== null &&
      needsSecondApproval({ resolution: input.resolution, amountMinor: amount, currency: row.currency, thresholdMinor: settings.approvalThresholdMinor, thresholdCurrency: settings.approvalCurrency }),
    settlement: {
      basis: attribution.basis,
      unattributed: money(attribution.unattributedMinor, row.currency),
      sellers: settlements.map((s) => {
        const after = attribution.basis === 'AMBIGUOUS' ? s.refundsAdjustmentsMinor : (attribution.byGroup.get(s.sellerOrderGroupId) ?? 0n);
        return {
          sellerOrderGroupId: s.sellerOrderGroupId,
          sellerOrderNumber: s.sellerOrderGroup.sellerOrderNumber,
          sellerName: s.sellerOrderGroup.sellerAccount.displayName,
          refundsBefore: money(s.refundsAdjustmentsMinor, s.currency),
          refundsAfter: money(after, s.currency),
          settlementBefore: money(s.estimatedSettlementMinor, s.currency),
          settlementAfter: money(
            estimatedSettlement({
              goodsMinor: s.grossProceedsMinor,
              sellerDeliveryMinor: s.sellerDeliveryProceedsMinor,
              platformFeeMinor: s.platformFeeMinor,
              platformFeeTaxMinor: s.platformFeeTaxMinor,
              refundsAdjustmentsMinor: after,
            }),
            s.currency,
          ),
          commissionInvoice: s.sellerOrderGroup.commissionInvoices[0] ?? null,
        };
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/**
 * The dispute beat, run by the worker.
 *
 *   1. A claim whose seller let the time to answer pass goes to the operator
 *      (UNDER_REVIEW), with a line in the history saying why. Nothing is
 *      decided: a missed deadline is a fact for the person deciding.
 *   2. A decision, or a chargeback's evidence, past its deadline rings the
 *      console bell - once per deadline.
 */
export async function sweepDisputeDeadlines(now: Date = new Date()): Promise<{ escalated: number; alerted: number }> {
  const late = await prisma.dispute.findMany({
    where: { kind: 'CLAIM', status: 'AWAITING_SELLER', sellerResponseDueAt: { lt: now } },
    select: { id: true },
    take: 200,
  });
  let escalated = 0;
  for (const { id } of late) {
    try {
      await prisma.$transaction(async (tx) => {
        const row = await loadDispute(tx, id);
        if (row.status !== 'AWAITING_SELLER') return;
        await moveStatus(tx, row, 'UNDER_REVIEW', {}, { party: 'SYSTEM', actorUserId: null, at: now });
        await writeEvent(tx, { disputeId: id, kind: 'ESCALATED', party: 'SYSTEM', visibleToBuyer: true, visibleToSeller: true, toValue: 'SELLER_LATE', createdAt: new Date(now.getTime() + 1) });
        await recordAudit({ action: AuditAction.DISPUTE_ESCALATED, resourceType: 'dispute', resourceId: id, actorType: 'SYSTEM', after: { reference: row.reference, by: 'SELLER_LATE' } }, tx);
        await bellStaff(tx, row, 'SELLER_LATE', `dispute-seller-late:${id}`);
        await tellSeller(tx, row, `Claim ${row.reference} went to the marketplace`, 'The time to answer passed, so the marketplace will decide. You can still add your account and evidence.', `dispute-seller-late:${id}`);
      });
      escalated += 1;
    } catch {
      // Somebody moved it at the same moment; the next beat looks again.
    }
  }

  const overdue = await prisma.dispute.findMany({
    where: {
      OR: [
        { status: { in: [...OPEN_CLAIM_STATUSES] }, decisionDueAt: { lt: now } },
        { status: 'NEEDS_RESPONSE', evidenceDueAt: { lt: new Date(now.getTime() + 24 * 3_600_000) } },
      ],
    },
    select: { id: true, reference: true, kind: true, decisionDueAt: true, evidenceDueAt: true },
    take: 200,
  });
  for (const row of overdue) {
    const which = row.kind === 'CHARGEBACK' ? 'EVIDENCE' : 'DECISION';
    const due = (which === 'EVIDENCE' ? row.evidenceDueAt : row.decisionDueAt)?.getTime() ?? 0;
    await createAdminNotification({
      kind: AdminNotificationKind.DISPUTE_SLA_BREACHED,
      variables: { reference: row.reference, which },
      linkPath: consoleDisputePath(row.id),
      requiredPermission: Permission.DISPUTE_VIEW,
      relatedType: 'dispute',
      relatedId: row.id,
      dedupeKey: `dispute-late:${row.id}:${which}:${String(due)}`,
    });
  }
  return { escalated, alerted: overdue.length };
}

/** For the settings screen and the claim form. */
export async function readDisputeSettingsView() {
  return settingsView(await readDisputeSettings());
}

export { DisputeReasonValues };
