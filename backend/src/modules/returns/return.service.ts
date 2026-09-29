/**
 * Returns: a buyer sending goods back, from the request to the refund.
 *
 *   buyer asks  ->  seller answers  ->  staff approve or reject (with a reason)
 *   -> instructions or a label  ->  received  ->  inspected  ->  refunded
 *
 * THE RULES THIS FILE KEEPS
 *
 *   - **Eligibility is the operator's setting.** A line may go back only once
 *     its fulfiller has delivered it, within `ReturnSettings.windowDays` of that
 *     delivery, and only up to the quantity not already on another return that
 *     was not rejected. The quantity rule is checked again under a lock on the
 *     order row, because two returns sent at once must not both fit.
 *   - **One return, one fulfiller.** A return concerns one seller's part of the
 *     order or the operator's own lines, never both: the seller who answers,
 *     the address the goods go back to and the settlement the refund comes out
 *     of all differ per fulfiller.
 *   - **Status moves only through `domain/return-state.ts`.** The ORDER's status
 *     moves only through `transitionOrder`, and only when every line of the
 *     order has come back and been inspected.
 *   - **The refund is the ordinary refund.** `createRefund` - with its quote,
 *     its idempotency key, its lock and `chk_order_refund_within_paid` - is the
 *     only way money goes back. This file links the refund to the return and
 *     re-derives the sellers' settlements, which then attribute it to the
 *     return's seller. A seller's issued invoice is flagged for a credit note,
 *     as a returned order's already is.
 *   - **Tenancy is the query.** A buyer reaches a return through their own
 *     order scope, a seller through their own seller account; anything else is
 *     "not found", never "forbidden".
 *   - **Every step is audited and told** - by email to the buyer and to the
 *     seller's owners and order managers, and in the seller's Hub.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { ErrorCode, AppError, badRequest, conflict, notFound } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import {
  OPEN_RETURN_STATUSES,
  allowedReturnTransitions,
  assertReturnTransition,
  isReturnReasonCode,
  returnedLineValueMinor,
  type ReturnActor,
  type ReturnStatusName,
} from '../../domain/return-state.js';
import { sellerRoleHas, SellerPermission } from '../../domain/seller-permissions.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit, type AuditActionKey, type AuditActorType } from '../audit/audit.service.js';
import { restockFromOrder } from '../inventory/inventory.service.js';
import {
  NotificationEvent,
  dispatchPendingNotifications,
  enqueueNotification,
} from '../notifications/notification.service.js';
import { createRefund, settleRefundedOrder } from '../payments/refund.service.js';
import { notifySeller } from '../seller/notification.service.js';
import { syncSettlementRefundsFor } from '../seller/settlement-refund.service.js';
import {
  RETURN_FILES_PER_RETURN,
  RETURN_FILES_PER_REQUEST,
  countReturnFiles,
  discardStoredFiles,
  recordReturnFiles,
  returnFilePolicy,
  returnFilesAvailable,
  storeReturnFiles,
  type PreparedFile,
} from './return-files.service.js';
import { getReturnPolicy } from './return-settings.service.js';

type Tx = Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a person sees instead of the id. Stable: derived from the id alone. */
export function returnReference(id: string): string {
  return `RET-${id.slice(-8).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

/** Where a buyer's order may be looked up - the same `where` as the order page. */
export interface BuyerScope {
  customerProfileId?: string;
  buyerCompanyId: string | null;
}

export interface BuyerActor {
  userId: string;
  email: string;
  scope: BuyerScope;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export interface SellerActor {
  userId: string;
  email: string;
  sellerAccountId: string;
  canHandle: boolean;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export interface StaffActor {
  userId: string;
  email: string;
  permissions: readonly string[];
  ipAddress?: string | null;
  correlationId?: string | null;
}

type AnyActor =
  | { side: 'BUYER'; actor: BuyerActor }
  | { side: 'SELLER'; actor: SellerActor }
  | { side: 'STAFF'; actor: StaffActor }
  | { side: 'SYSTEM' };

function auditActorType(who: AnyActor): AuditActorType {
  if (who.side === 'STAFF') return 'ADMIN';
  if (who.side === 'SYSTEM') return 'SYSTEM';
  return 'CUSTOMER';
}

function eventActorType(who: AnyActor): string {
  if (who.side === 'BUYER') return 'CUSTOMER';
  if (who.side === 'STAFF') return 'ADMIN';
  return who.side;
}

function actorUserId(who: AnyActor): string | null {
  return who.side === 'SYSTEM' ? null : who.actor.userId;
}

function actorEmail(who: AnyActor): string | null {
  return who.side === 'SYSTEM' ? null : who.actor.email;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

interface ItemRow {
  id: string;
  nameSnapshot: string;
  skuSnapshot: string;
  variantNameSnapshot: string | null;
  imageUrlSnapshot: string | null;
  quantity: number;
  lineTotalMinor: bigint;
  productId: string;
  variantId: string | null;
}

/** Quantity of each order item already on a return that was not rejected. */
async function returnedByItem(client: Tx | typeof prisma, orderId: string): Promise<Map<string, number>> {
  const returns = await client.returnRequest.findMany({
    where: { orderId, status: { not: 'REJECTED' } },
    select: { itemsJson: true, lines: { select: { orderItemId: true, quantity: true } } },
  });
  const totals = new Map<string, number>();
  const add = (itemId: string, quantity: number): void => {
    totals.set(itemId, (totals.get(itemId) ?? 0) + quantity);
  };
  for (const entry of returns) {
    if (entry.lines.length > 0) {
      for (const line of entry.lines) add(line.orderItemId, line.quantity);
      continue;
    }
    // A return recorded before lines existed keeps them in its JSON, either as
    // the list itself or under `requested`.
    const raw: unknown = entry.itemsJson;
    const list: unknown =
      Array.isArray(raw) ? raw : typeof raw === 'object' && raw !== null ? (raw as { requested?: unknown }).requested : [];
    if (!Array.isArray(list)) continue;
    for (const candidate of list as unknown[]) {
      if (typeof candidate !== 'object' || candidate === null) continue;
      const line = candidate as { orderItemId?: unknown; quantity?: unknown };
      if (typeof line.orderItemId === 'string' && typeof line.quantity === 'number') {
        add(line.orderItemId, line.quantity);
      }
    }
  }
  return totals;
}

interface OrderContext {
  order: {
    id: string;
    orderNumber: string;
    status: string;
    currency: string;
    customerProfileId: string;
    paidMinor: bigint;
    refundedMinor: bigint;
  };
  items: ItemRow[];
  /** orderItemId -> seller group id, for lines a seller fulfils. */
  groupOfItem: Map<string, string>;
  groups: Map<
    string,
    { id: string; sellerAccountId: string; sellerName: string; sellerOrderNumber: string; status: string; deliveredAt: Date | null }
  >;
  /** When the operator's own lines (or the whole order) were delivered. */
  orderDeliveredAt: Date | null;
}

async function loadOrderContext(orderId: string): Promise<OrderContext | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      currency: true,
      customerProfileId: true,
      paidMinor: true,
      refundedMinor: true,
      items: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          nameSnapshot: true,
          skuSnapshot: true,
          variantNameSnapshot: true,
          imageUrlSnapshot: true,
          quantity: true,
          lineTotalMinor: true,
          productId: true,
          variantId: true,
        },
      },
      sellerOrderGroups: {
        select: {
          id: true,
          sellerAccountId: true,
          sellerOrderNumber: true,
          status: true,
          deliveredAt: true,
          sellerAccount: { select: { displayName: true } },
          lines: { select: { orderItemId: true } },
        },
      },
      statusHistory: {
        where: { toStatus: 'DELIVERED' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true },
      },
    },
  });
  if (order === null) return null;

  const groupOfItem = new Map<string, string>();
  const groups: OrderContext['groups'] = new Map();
  for (const group of order.sellerOrderGroups) {
    groups.set(group.id, {
      id: group.id,
      sellerAccountId: group.sellerAccountId,
      sellerName: group.sellerAccount.displayName,
      sellerOrderNumber: group.sellerOrderNumber,
      status: group.status,
      deliveredAt: group.deliveredAt,
    });
    for (const line of group.lines) groupOfItem.set(line.orderItemId, group.id);
  }

  return {
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      currency: order.currency,
      customerProfileId: order.customerProfileId,
      paidMinor: order.paidMinor,
      refundedMinor: order.refundedMinor,
    },
    items: order.items,
    groupOfItem,
    groups,
    orderDeliveredAt: order.statusHistory[0]?.createdAt ?? null,
  };
}

/**
 * When a fulfiller's part of the order was delivered, or null if it has not
 * been. A seller's part follows its own group; the operator's lines follow the
 * order. A delivered ORDER counts for every part, since it is only delivered
 * once all of it is.
 */
function deliveredAtFor(context: OrderContext, groupId: string | null): Date | null {
  if (groupId !== null) {
    const group = context.groups.get(groupId);
    if (group?.status === 'DELIVERED' && group.deliveredAt !== null) return group.deliveredAt;
  }
  if (context.order.status === 'DELIVERED') return context.orderDeliveredAt ?? new Date(0);
  return null;
}

export interface EligibilityView {
  orderId: string;
  orderNumber: string;
  eligible: boolean;
  /** Why not, when not: NOT_DELIVERED, WINDOW_CLOSED, RETURNS_OFF or NOTHING_LEFT. */
  reason: string | null;
  windowDays: number;
  reasonCodes: string[];
  evidenceRequired: string[];
  replacementEnabled: boolean;
  files: ReturnType<typeof returnFilePolicy>;
  groups: {
    sellerOrderGroupId: string | null;
    sellerName: string | null;
    deliveredAt: string | null;
    windowClosesAt: string | null;
    open: boolean;
    lines: {
      orderItemId: string;
      name: string;
      sku: string;
      variantName: string | null;
      imageUrl: string | null;
      ordered: number;
      alreadyReturned: number;
      returnable: number;
      unitValue: ReturnType<typeof serialiseMoney>;
    }[];
  }[];
}

function eligibilityOf(
  context: OrderContext,
  returned: Map<string, number>,
  policy: Awaited<ReturnType<typeof getReturnPolicy>>,
  now: Date,
): EligibilityView {
  const buckets = new Map<string, EligibilityView['groups'][number]>();
  for (const item of context.items) {
    const groupId = context.groupOfItem.get(item.id) ?? null;
    const key = groupId ?? 'OPERATOR';
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      const deliveredAt = deliveredAtFor(context, groupId);
      const closesAt =
        deliveredAt === null ? null : new Date(deliveredAt.getTime() + policy.windowDays * DAY_MS);
      bucket = {
        sellerOrderGroupId: groupId,
        sellerName: groupId === null ? null : (context.groups.get(groupId)?.sellerName ?? null),
        deliveredAt: deliveredAt?.toISOString() ?? null,
        windowClosesAt: closesAt?.toISOString() ?? null,
        open: closesAt !== null && policy.windowDays > 0 && closesAt.getTime() > now.getTime(),
        lines: [],
      };
      buckets.set(key, bucket);
    }
    const already = returned.get(item.id) ?? 0;
    bucket.lines.push({
      orderItemId: item.id,
      name: item.nameSnapshot,
      sku: item.skuSnapshot,
      variantName: item.variantNameSnapshot,
      imageUrl: item.imageUrlSnapshot,
      ordered: item.quantity,
      alreadyReturned: already,
      returnable: bucket.open ? Math.max(0, item.quantity - already) : 0,
      unitValue: serialiseMoney(returnedLineValueMinor(item, 1), context.order.currency),
    });
  }

  const groups = [...buckets.values()];
  let reason: string | null = null;
  if (policy.windowDays === 0) reason = 'RETURNS_OFF';
  else if (groups.every((group) => group.deliveredAt === null)) reason = 'NOT_DELIVERED';
  else if (groups.every((group) => !group.open)) reason = 'WINDOW_CLOSED';
  else if (groups.every((group) => group.lines.every((line) => line.returnable === 0))) {
    reason = 'NOTHING_LEFT';
  }

  return {
    orderId: context.order.id,
    orderNumber: context.order.orderNumber,
    eligible: reason === null,
    reason,
    windowDays: policy.windowDays,
    reasonCodes: policy.reasonCodes,
    evidenceRequired: returnFilesAvailable() ? policy.evidenceRequired : [],
    replacementEnabled: policy.replacementEnabled,
    files: returnFilePolicy(),
    groups,
  };
}

async function buyerOrderId(scope: BuyerScope, orderId: string): Promise<string> {
  const order = await prisma.order.findFirst({ where: { id: orderId, ...scope }, select: { id: true } });
  if (order === null) throw notFound('Order');
  return order.id;
}

/** What the "Return items" form needs for one of the buyer's orders. */
export async function readReturnEligibility(scope: BuyerScope, orderId: string): Promise<EligibilityView> {
  const id = await buyerOrderId(scope, orderId);
  const context = await loadOrderContext(id);
  if (context === null) throw notFound('Order');
  return eligibilityOf(context, await returnedByItem(prisma, id), await getReturnPolicy(), new Date());
}

// ---------------------------------------------------------------------------
// Creating a return
// ---------------------------------------------------------------------------

export interface ReturnRequestInput {
  reasonCode: string;
  description?: string | null;
  preferredResolution?: 'REFUND' | 'REPLACEMENT';
  items: { orderItemId: string; quantity: number }[];
}

function notEligible(code: string, message: string, meta?: Record<string, string | number>): AppError {
  return conflict(ErrorCode.RETURN_NOT_ELIGIBLE, message, [{ code, ...(meta ? { meta } : {}) }]);
}

/**
 * Check a request against the order and the policy. Returns the one fulfiller
 * the lines belong to. Throws the first reason it cannot go ahead.
 */
function validateRequest(
  context: OrderContext,
  returned: Map<string, number>,
  policy: Awaited<ReturnType<typeof getReturnPolicy>>,
  input: ReturnRequestInput,
  options: { enforceWindow: boolean; enforceReasonList: boolean },
): { groupId: string | null } {
  if (!isReturnReasonCode(input.reasonCode)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Choose a reason for the return.', [
      { field: 'reasonCode', code: 'INVALID' },
    ]);
  }
  if (options.enforceReasonList && !policy.reasonCodes.includes(input.reasonCode)) {
    throw notEligible('REASON_NOT_OFFERED', 'That reason is not offered for returns here.');
  }
  if (input.preferredResolution === 'REPLACEMENT' && !policy.replacementEnabled) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Replacements are not offered here.', [
      { field: 'preferredResolution', code: 'NOT_OFFERED' },
    ]);
  }
  if (input.items.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Choose at least one item to return.', [
      { field: 'items', code: 'REQUIRED' },
    ]);
  }
  const seen = new Set<string>();
  const itemById = new Map(context.items.map((item) => [item.id, item]));
  const fulfillers = new Set<string>();
  const problems: { field: string; code: string; message: string; meta?: Record<string, number> }[] = [];

  input.items.forEach((line, index) => {
    const item = itemById.get(line.orderItemId);
    if (item === undefined || seen.has(line.orderItemId)) {
      problems.push({
        field: `items.${String(index)}.orderItemId`,
        code: item === undefined ? 'NOT_ON_ORDER' : 'DUPLICATE',
        message: 'That line is not part of this order, or is listed twice.',
      });
      return;
    }
    seen.add(line.orderItemId);
    fulfillers.add(context.groupOfItem.get(item.id) ?? 'OPERATOR');
  });
  if (problems.length > 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'This return cannot be recorded.', problems);
  }
  if (fulfillers.size > 1) {
    throw notEligible(
      'MIXED_SELLERS',
      'These items come from different sellers. Send one return for each seller.',
    );
  }
  const [only] = [...fulfillers];
  const groupId = only === undefined || only === 'OPERATOR' ? null : only;

  if (options.enforceWindow) {
    if (policy.windowDays === 0) {
      throw notEligible('RETURNS_OFF', 'Returns cannot be requested online here. Contact support.');
    }
    const deliveredAt = deliveredAtFor(context, groupId);
    if (deliveredAt === null) {
      throw notEligible('NOT_DELIVERED', 'These items have not been delivered yet.');
    }
    const closesAt = new Date(deliveredAt.getTime() + policy.windowDays * DAY_MS);
    if (closesAt.getTime() <= Date.now()) {
      throw notEligible('WINDOW_CLOSED', `Returns close ${String(policy.windowDays)} days after delivery.`, {
        windowDays: policy.windowDays,
        closedAt: closesAt.toISOString(),
      });
    }
  } else if (!['SHIPPED', 'DELIVERED'].includes(context.order.status) && deliveredAtFor(context, groupId) === null) {
    throw notEligible('NOT_DELIVERED', 'Nothing on this order has been sent yet.');
  }

  const over: { field: string; code: string; message: string; meta: Record<string, number> }[] = [];
  input.items.forEach((line, index) => {
    const item = itemById.get(line.orderItemId);
    if (item === undefined) return;
    const returnable = Math.max(0, item.quantity - (returned.get(item.id) ?? 0));
    if (line.quantity < 1 || line.quantity > returnable) {
      over.push({
        field: `items.${String(index)}.quantity`,
        code: 'EXCEEDS_RETURNABLE',
        message: `${item.nameSnapshot}: ${String(returnable)} can still be returned.`,
        meta: { returnable, requested: line.quantity },
      });
    }
  });
  if (over.length > 0) {
    throw new AppError({
      statusCode: 409,
      code: ErrorCode.RETURN_QUANTITY_EXCEEDED,
      message: 'More was asked for than can be returned.',
      details: over,
    });
  }

  return { groupId };
}

async function writeEvent(
  tx: Tx,
  input: {
    returnRequestId: string;
    kind: string;
    toStatus?: ReturnStatusName | null;
    note?: string | null;
    visibleToBuyer?: boolean;
    who: AnyActor;
  },
): Promise<void> {
  await tx.returnRequestEvent.create({
    data: {
      id: newId(),
      returnRequestId: input.returnRequestId,
      kind: input.kind,
      toStatus: input.toStatus ?? null,
      note: input.note ?? null,
      visibleToBuyer: input.visibleToBuyer ?? true,
      actorType: eventActorType(input.who),
      actorId: actorUserId(input.who),
    },
  });
}

async function audit(
  tx: Tx | undefined,
  action: AuditActionKey,
  returnId: string,
  who: AnyActor,
  after: Record<string, unknown>,
): Promise<void> {
  const context = who.side === 'SYSTEM' ? null : who.actor;
  await recordAudit(
    {
      action,
      resourceType: 'return_request',
      resourceId: returnId,
      actorType: auditActorType(who),
      actorUserId: actorUserId(who),
      actorEmail: actorEmail(who),
      after,
      ipAddress: context?.ipAddress ?? null,
      correlationId: context?.correlationId ?? null,
    },
    tx,
  );
}

/** Lock the order row so two returns against it are decided one after the other. */
async function lockOrder(tx: Tx, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;
}

async function insertReturn(
  context: OrderContext,
  input: ReturnRequestInput,
  groupId: string | null,
  origin: 'BUYER' | 'STAFF',
  who: AnyActor,
  files: Awaited<ReturnType<typeof storeReturnFiles>>,
  policy: Awaited<ReturnType<typeof getReturnPolicy>>,
  enforce: { enforceWindow: boolean; enforceReasonList: boolean },
): Promise<string> {
  const returnId = newId();
  await prisma.$transaction(async (tx) => {
    await lockOrder(tx, context.order.id);
    // Again, under the lock: another return may have been written since.
    validateRequest(context, await returnedByItem(tx, context.order.id), policy, input, enforce);

    await tx.returnRequest.create({
      data: {
        id: returnId,
        orderId: context.order.id,
        status: 'REQUESTED',
        reason: (input.description ?? '').trim().slice(0, 512),
        reasonCode: input.reasonCode,
        preferredResolution: input.preferredResolution ?? 'REFUND',
        origin,
        sellerOrderGroupId: groupId,
        itemsJson: input.items.map((line) => ({ orderItemId: line.orderItemId, quantity: line.quantity })),
        requestedById: actorUserId(who) ?? '',
        lines: {
          create: input.items.map((line) => ({
            id: newId(),
            orderItemId: line.orderItemId,
            quantity: line.quantity,
          })),
        },
      },
    });
    await writeEvent(tx, { returnRequestId: returnId, kind: 'REQUESTED', toStatus: 'REQUESTED', who });
    if (files.length > 0) {
      await recordReturnFiles(tx, {
        returnRequestId: returnId,
        kind: 'EVIDENCE',
        files,
        uploadedById: actorUserId(who) ?? '',
        uploaderType: who.side === 'STAFF' ? 'ADMIN' : 'CUSTOMER',
        auditActorType: auditActorType(who),
        actorEmail: actorEmail(who) ?? '',
      });
    }
    await audit(tx, AuditAction.RETURN_REQUESTED, returnId, who, {
      orderId: context.order.id,
      sellerOrderGroupId: groupId,
      reasonCode: input.reasonCode,
      preferredResolution: input.preferredResolution ?? 'REFUND',
      origin,
      lines: input.items.length,
      files: files.length,
    });
  });
  return returnId;
}

/**
 * A buyer asks to return lines of one of their own orders.
 *
 * `files` are already checked for type and size by the route; they are scanned
 * and stored here, after every rule has passed, and removed again if the
 * return cannot be written.
 */
export async function createBuyerReturn(
  actor: BuyerActor,
  orderId: string,
  input: ReturnRequestInput,
  files: readonly PreparedFile[],
): Promise<{ return: ReturnView }> {
  const id = await buyerOrderId(actor.scope, orderId);
  const context = await loadOrderContext(id);
  if (context === null) throw notFound('Order');
  const policy = await getReturnPolicy();
  const enforce = { enforceWindow: true, enforceReasonList: true };

  const { groupId } = validateRequest(context, await returnedByItem(prisma, id), policy, input, enforce);

  if (files.length > RETURN_FILES_PER_REQUEST) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, `Attach up to ${String(RETURN_FILES_PER_REQUEST)} files.`, [
      { field: 'files', code: 'TOO_MANY', meta: { limit: RETURN_FILES_PER_REQUEST } },
    ]);
  }
  const evidenceNeeded =
    returnFilesAvailable() && policy.evidenceRequired.includes(input.reasonCode as never);
  if (evidenceNeeded && !files.some((file) => file.mediaKind !== 'DOCUMENT')) {
    throw badRequest(
      ErrorCode.RETURN_EVIDENCE_REQUIRED,
      'Add at least one photograph or video of the problem.',
      [{ field: 'files', code: 'REQUIRED' }],
    );
  }

  const stored = await storeReturnFiles(files);
  let returnId: string;
  try {
    returnId = await insertReturn(context, input, groupId, 'BUYER', { side: 'BUYER', actor }, stored, policy, enforce);
  } catch (error) {
    await discardStoredFiles(stored);
    throw error;
  }

  await announce(returnId, 'REQUESTED');
  return { return: await readBuyerReturn(actor.scope, returnId) };
}

/**
 * Staff record a return for a buyer - a phone call, an email. The window and
 * the reason list are the buyer's limits, not staff's; quantities still hold.
 */
export async function createStaffReturn(
  actor: StaffActor,
  orderId: string,
  input: ReturnRequestInput,
): Promise<{ returnId: string }> {
  const context = await loadOrderContext(orderId);
  if (context === null) throw notFound('Order');
  const policy = await getReturnPolicy();
  const enforce = { enforceWindow: false, enforceReasonList: false };
  const { groupId } = validateRequest(context, await returnedByItem(prisma, orderId), policy, input, enforce);
  const returnId = await insertReturn(
    context,
    input,
    groupId,
    'STAFF',
    { side: 'STAFF', actor },
    [],
    policy,
    enforce,
  );
  await announce(returnId, 'REQUESTED');
  return { returnId };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const RETURN_INCLUDE = {
  order: {
    select: {
      id: true,
      orderNumber: true,
      status: true,
      currency: true,
      paidMinor: true,
      refundedMinor: true,
      customerProfileId: true,
      customerProfile: { select: { fullName: true } },
    },
  },
  sellerOrderGroup: {
    select: {
      id: true,
      sellerAccountId: true,
      sellerOrderNumber: true,
      sellerAccount: { select: { displayName: true } },
    },
  },
  lines: {
    orderBy: { createdAt: 'asc' as const },
    include: {
      orderItem: {
        select: {
          id: true,
          nameSnapshot: true,
          skuSnapshot: true,
          variantNameSnapshot: true,
          imageUrlSnapshot: true,
          quantity: true,
          lineTotalMinor: true,
          productId: true,
          variantId: true,
        },
      },
    },
  },
  events: { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
  files: {
    orderBy: { createdAt: 'asc' as const },
    select: {
      id: true,
      kind: true,
      fileName: true,
      contentType: true,
      mediaKind: true,
      byteSize: true,
      uploaderType: true,
      createdAt: true,
    },
  },
  refund: {
    select: { id: true, status: true, amountMinor: true, currency: true, createdAt: true, completedAt: true },
  },
} satisfies Prisma.ReturnRequestInclude;

type ReturnRow = Prisma.ReturnRequestGetPayload<{ include: typeof RETURN_INCLUDE }>;

export type ViewerSide = 'BUYER' | 'SELLER' | 'STAFF';

export interface ReturnView {
  id: string;
  reference: string;
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  status: ReturnStatusName;
  origin: string;
  reasonCode: string | null;
  description: string;
  preferredResolution: string;
  seller: { sellerOrderGroupId: string; name: string; sellerOrderNumber: string } | null;
  buyerName?: string;
  decisionNote: string | null;
  returnInstructions: string | null;
  resolutionNote: string | null;
  sellerResponse?: string | null;
  sellerResponseNote?: string | null;
  sellerRespondedAt?: string | null;
  createdAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  receivedAt: string | null;
  inspectedAt: string | null;
  completedAt: string | null;
  lines: {
    orderItemId: string;
    name: string;
    sku: string;
    variantName: string | null;
    imageUrl: string | null;
    quantity: number;
    sellableQty: number | null;
    damagedQty: number | null;
    value: ReturnType<typeof serialiseMoney>;
  }[];
  value: ReturnType<typeof serialiseMoney>;
  refund: {
    id: string;
    status: string;
    amount: ReturnType<typeof serialiseMoney>;
    createdAt: string;
    completedAt: string | null;
  } | null;
  /** STAFF only: what may still be refunded on the whole order. */
  maxRefundable?: ReturnType<typeof serialiseMoney>;
  files: {
    id: string;
    kind: string;
    fileName: string;
    contentType: string;
    mediaKind: string;
    byteSize: number;
    uploaderType: string;
    createdAt: string;
  }[];
  timeline: { kind: string; toStatus: string | null; note: string | null; actorType: string; createdAt: string }[];
  /** What this viewer may do next. Empty for the buyer. */
  nextSteps: { to: string; requiresReason: boolean }[];
  /** Whether a refund may be issued now (staff), and whether a replacement may be recorded. */
  canRefund?: boolean;
  canRecordReplacement?: boolean;
  canRespond?: boolean;
}

function toView(row: ReturnRow, side: ViewerSide): ReturnView {
  const currency = row.order.currency;
  const lines = row.lines.map((line) => ({
    orderItemId: line.orderItemId,
    name: line.orderItem.nameSnapshot,
    sku: line.orderItem.skuSnapshot,
    variantName: line.orderItem.variantNameSnapshot,
    imageUrl: line.orderItem.imageUrlSnapshot,
    quantity: line.quantity,
    sellableQty: line.sellableQty,
    damagedQty: line.damagedQty,
    value: serialiseMoney(returnedLineValueMinor(line.orderItem, line.quantity), currency),
  }));
  const valueMinor = row.lines.reduce(
    (total, line) => total + returnedLineValueMinor(line.orderItem, line.quantity),
    0n,
  );
  const status = row.status;
  const actor: ReturnActor = side === 'SELLER' ? 'SELLER' : 'STAFF';
  const maxRefundable = row.order.paidMinor - row.order.refundedMinor;

  const view: ReturnView = {
    id: row.id,
    reference: returnReference(row.id),
    orderId: row.orderId,
    orderNumber: row.order.orderNumber,
    orderStatus: row.order.status,
    status,
    origin: row.origin,
    reasonCode: row.reasonCode,
    description: row.reason,
    preferredResolution: row.preferredResolution,
    seller:
      row.sellerOrderGroup === null
        ? null
        : {
            sellerOrderGroupId: row.sellerOrderGroup.id,
            name: row.sellerOrderGroup.sellerAccount.displayName,
            sellerOrderNumber: row.sellerOrderGroup.sellerOrderNumber,
          },
    decisionNote: row.decisionNote,
    returnInstructions: row.returnInstructions,
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    receivedAt: row.receivedAt?.toISOString() ?? null,
    inspectedAt: row.inspectedAt?.toISOString() ?? null,
    completedAt: status === 'COMPLETED' ? (row.completedAt?.toISOString() ?? null) : null,
    lines,
    value: serialiseMoney(valueMinor, currency),
    refund:
      row.refund === null
        ? null
        : {
            id: row.refund.id,
            status: row.refund.status,
            amount: serialiseMoney(row.refund.amountMinor, row.refund.currency),
            createdAt: row.refund.createdAt.toISOString(),
            completedAt: row.refund.completedAt?.toISOString() ?? null,
          },
    files: row.files.map((file) => ({ ...file, createdAt: file.createdAt.toISOString() })),
    timeline: row.events
      .filter((event) => side !== 'BUYER' || event.visibleToBuyer)
      .map((event) => ({
        kind: event.kind,
        toStatus: event.toStatus,
        note: event.note,
        actorType: event.actorType,
        createdAt: event.createdAt.toISOString(),
      })),
    nextSteps: side === 'BUYER' ? [] : allowedReturnTransitions(status, actor),
  };

  if (side !== 'BUYER') {
    view.sellerResponse = row.sellerResponse;
    view.sellerResponseNote = row.sellerResponseNote;
    view.sellerRespondedAt = row.sellerRespondedAt?.toISOString() ?? null;
  }
  if (side === 'STAFF') {
    view.buyerName = row.order.customerProfile.fullName;
    view.maxRefundable = serialiseMoney(maxRefundable > 0n ? maxRefundable : 0n, currency);
    view.canRefund = status === 'INSPECTED' && row.refundId === null && row.completedAt === null;
    view.canRecordReplacement =
      status === 'INSPECTED' && row.refundId === null && row.completedAt === null;
  }
  if (side === 'SELLER') {
    view.canRespond = status === 'REQUESTED' || status === 'APPROVED';
  }
  return view;
}

async function loadRow(where: Prisma.ReturnRequestWhereInput): Promise<ReturnRow> {
  const row = await prisma.returnRequest.findFirst({ where, include: RETURN_INCLUDE });
  if (row === null) throw notFound('Return');
  return row;
}

export async function readBuyerReturn(scope: BuyerScope, returnId: string): Promise<ReturnView> {
  return toView(await loadRow({ id: returnId, order: scope }), 'BUYER');
}

export async function readSellerReturn(actor: SellerActor, returnId: string): Promise<ReturnView> {
  return toView(
    await loadRow({ id: returnId, sellerOrderGroup: { sellerAccountId: actor.sellerAccountId } }),
    'SELLER',
  );
}

export async function readStaffReturn(returnId: string): Promise<ReturnView> {
  return toView(await loadRow({ id: returnId }), 'STAFF');
}

export interface ReturnListQuery {
  page: number;
  limit: number;
  status?: ReturnStatusName | 'OPEN';
  orderId?: string;
}

async function listWhere(
  where: Prisma.ReturnRequestWhereInput,
  query: ReturnListQuery,
  side: ViewerSide,
): Promise<{ returns: ReturnView[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
  const filter: Prisma.ReturnRequestWhereInput = {
    ...where,
    ...(query.status === 'OPEN'
      ? { status: { in: [...OPEN_RETURN_STATUSES] } }
      : query.status !== undefined
        ? { status: query.status }
        : {}),
    ...(query.orderId !== undefined ? { orderId: query.orderId } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.returnRequest.findMany({
      where: filter,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: RETURN_INCLUDE,
    }),
    prisma.returnRequest.count({ where: filter }),
  ]);
  return {
    returns: rows.map((row) => toView(row, side)),
    pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
  };
}

export function listBuyerReturns(scope: BuyerScope, query: ReturnListQuery) {
  return listWhere({ order: scope }, query, 'BUYER');
}

export function listSellerReturns(actor: SellerActor, query: ReturnListQuery) {
  return listWhere({ sellerOrderGroup: { sellerAccountId: actor.sellerAccountId } }, query, 'SELLER');
}

export function listStaffReturns(query: ReturnListQuery) {
  return listWhere({}, query, 'STAFF');
}

/**
 * Whether one seller's part of an order has a return still being worked -
 * requested, approved, received or inspected and not yet refunded. For the
 * rules that hold a seller's money while a buyer may still get some back.
 */
export async function hasOpenReturn(sellerOrderGroupId: string): Promise<boolean> {
  const open = await prisma.returnRequest.count({
    where: { sellerOrderGroupId, status: { in: [...OPEN_RETURN_STATUSES] } },
  });
  return open > 0;
}

/** The ids a scoped reader may reach. Used by the file routes before a link is minted. */
export async function buyerReturnId(scope: BuyerScope, returnId: string): Promise<string> {
  const row = await prisma.returnRequest.findFirst({ where: { id: returnId, order: scope }, select: { id: true } });
  if (row === null) throw notFound('Return');
  return row.id;
}

export async function sellerReturnId(actor: SellerActor, returnId: string): Promise<string> {
  const row = await prisma.returnRequest.findFirst({
    where: { id: returnId, sellerOrderGroup: { sellerAccountId: actor.sellerAccountId } },
    select: { id: true },
  });
  if (row === null) throw notFound('Return');
  return row.id;
}

export async function staffReturnId(returnId: string): Promise<string> {
  const row = await prisma.returnRequest.findUnique({ where: { id: returnId }, select: { id: true } });
  if (row === null) throw notFound('Return');
  return row.id;
}

// ---------------------------------------------------------------------------
// Files after the request
// ---------------------------------------------------------------------------

/**
 * Add files to a return: more evidence from the buyer while it is open, or a
 * return label from the seller or staff once it is approved.
 */
export async function addReturnFiles(
  who: Exclude<AnyActor, { side: 'SYSTEM' }>,
  returnId: string,
  files: readonly PreparedFile[],
): Promise<ReturnView> {
  const row = await prisma.returnRequest.findUniqueOrThrow({
    where: { id: returnId },
    select: { id: true, status: true },
  });
  const kind = who.side === 'BUYER' ? 'EVIDENCE' : 'LABEL';
  const status = row.status;
  if (!OPEN_RETURN_STATUSES.includes(status) || (kind === 'LABEL' && status !== 'APPROVED')) {
    throw conflict(
      ErrorCode.RETURN_TRANSITION_NOT_ALLOWED,
      kind === 'LABEL'
        ? 'A return label can be added once the return is approved and before the goods arrive.'
        : 'Files can be added only while the return is open.',
      [{ code: 'NOT_OPEN', meta: { from: status, to: status } }],
    );
  }
  if (who.side === 'SELLER' && !who.actor.canHandle) throw notFound('Return');
  if ((await countReturnFiles(returnId)) + files.length > RETURN_FILES_PER_RETURN) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, `A return can carry up to ${String(RETURN_FILES_PER_RETURN)} files.`, [
      { field: 'file', code: 'LIMIT', meta: { limit: RETURN_FILES_PER_RETURN } },
    ]);
  }

  const stored = await storeReturnFiles(files);
  try {
    await prisma.$transaction(async (tx) => {
      await recordReturnFiles(tx, {
        returnRequestId: returnId,
        kind,
        files: stored,
        uploadedById: who.actor.userId,
        uploaderType: who.side === 'BUYER' ? 'CUSTOMER' : who.side === 'SELLER' ? 'SELLER' : 'ADMIN',
        auditActorType: auditActorType(who),
        actorEmail: who.actor.email,
      });
      await writeEvent(tx, { returnRequestId: returnId, kind: kind === 'LABEL' ? 'LABEL' : 'EVIDENCE', who });
    });
  } catch (error) {
    await discardStoredFiles(stored);
    throw error;
  }
  if (kind === 'LABEL') await announce(returnId, 'INSTRUCTIONS');
  return readAs(who, returnId);
}

async function readAs(who: Exclude<AnyActor, { side: 'SYSTEM' }>, returnId: string): Promise<ReturnView> {
  if (who.side === 'BUYER') return readBuyerReturn(who.actor.scope, returnId);
  if (who.side === 'SELLER') return readSellerReturn(who.actor, returnId);
  return readStaffReturn(returnId);
}

// ---------------------------------------------------------------------------
// The seller's answer, and instructions
// ---------------------------------------------------------------------------

/** Where the goods go back to, when nobody has written instructions of their own. */
async function defaultInstructions(sellerOrderGroupId: string | null): Promise<string | null> {
  if (sellerOrderGroupId === null) return (await getReturnPolicy()).operatorInstructions;
  const group = await prisma.sellerOrderGroup.findUnique({
    where: { id: sellerOrderGroupId },
    select: { sellerAccountId: true, sellerAccount: { select: { displayName: true } } },
  });
  if (group === null) return null;
  const location = await prisma.sellerLocation.findFirst({
    where: { sellerAccountId: group.sellerAccountId, isReturnLocation: true, archivedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { name: true, addressLine1: true, addressLine2: true, city: true, region: true, postcode: true, countryCode: true },
  });
  if (location === null) return null;
  return [
    `Send the items back to ${group.sellerAccount.displayName}, ${location.name}:`,
    location.addressLine1,
    location.addressLine2,
    [location.postcode, location.city].filter(Boolean).join(' '),
    location.region,
    location.countryCode,
    'Pack them securely and write the return reference on the parcel.',
  ]
    .filter((part) => part !== null && part !== undefined && part.length > 0)
    .join('\n');
}

export async function respondAsSeller(
  actor: SellerActor,
  returnId: string,
  input: { response: 'ACCEPT' | 'CONTEST'; note?: string | null; instructions?: string | null },
): Promise<ReturnView> {
  const id = await sellerReturnId(actor, returnId);
  if (!actor.canHandle) throw notFound('Return');
  const who: AnyActor = { side: 'SELLER', actor };
  if (input.response === 'CONTEST' && (input.note ?? '').trim().length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say why you contest the return.', [
      { field: 'note', code: 'REQUIRED' },
    ]);
  }

  await prisma.$transaction(async (tx) => {
    const updated = await tx.returnRequest.updateMany({
      where: { id, status: { in: ['REQUESTED', 'APPROVED'] } },
      data: {
        sellerResponse: input.response,
        sellerResponseNote: (input.note ?? '').trim() || null,
        sellerRespondedAt: new Date(),
        sellerRespondedById: actor.userId,
        ...(input.instructions !== undefined && input.instructions !== null && input.instructions.trim().length > 0
          ? { returnInstructions: input.instructions.trim(), instructionsSetAt: new Date() }
          : {}),
      },
    });
    if (updated.count === 0) {
      throw conflict(ErrorCode.RETURN_TRANSITION_NOT_ALLOWED, 'This return has already been decided.', [
        { code: 'DECIDED' },
      ]);
    }
    await writeEvent(tx, {
      returnRequestId: id,
      kind: 'SELLER_RESPONDED',
      note: `${input.response}${input.note ? `: ${input.note.trim()}` : ''}`,
      visibleToBuyer: false,
      who,
    });
    await audit(tx, AuditAction.RETURN_SELLER_RESPONDED, id, who, {
      response: input.response,
      sellerAccountId: actor.sellerAccountId,
      instructionsSet: input.instructions !== undefined && input.instructions !== null,
    });
  });
  return readSellerReturn(actor, id);
}

/** Write or replace how the goods should come back. Seller (their own) or staff. */
export async function setReturnInstructions(
  who: { side: 'SELLER'; actor: SellerActor } | { side: 'STAFF'; actor: StaffActor },
  returnId: string,
  instructions: string,
): Promise<ReturnView> {
  const id = who.side === 'SELLER' ? await sellerReturnId(who.actor, returnId) : await staffReturnId(returnId);
  if (who.side === 'SELLER' && !who.actor.canHandle) throw notFound('Return');
  const text = instructions.trim();
  let announceIt = false;
  await prisma.$transaction(async (tx) => {
    const row = await tx.returnRequest.findUniqueOrThrow({ where: { id }, select: { status: true } });
    if (!['REQUESTED', 'APPROVED'].includes(row.status)) {
      throw conflict(ErrorCode.RETURN_TRANSITION_NOT_ALLOWED, 'The goods are already on their way back.', [
        { code: 'NOT_OPEN', meta: { from: row.status, to: row.status } },
      ]);
    }
    announceIt = row.status === 'APPROVED';
    await tx.returnRequest.update({ where: { id }, data: { returnInstructions: text, instructionsSetAt: new Date() } });
    await writeEvent(tx, { returnRequestId: id, kind: 'INSTRUCTIONS', note: text, visibleToBuyer: announceIt, who });
    await audit(tx, AuditAction.RETURN_INSTRUCTIONS_SET, id, who, { length: text.length });
  });
  if (announceIt) await announce(id, 'INSTRUCTIONS');
  return who.side === 'SELLER' ? readSellerReturn(who.actor, id) : readStaffReturn(id);
}

// ---------------------------------------------------------------------------
// Staff decisions
// ---------------------------------------------------------------------------

async function move(
  tx: Tx,
  input: {
    returnId: string;
    to: ReturnStatusName;
    actor: ReturnActor;
    who: AnyActor;
    reason?: string | null;
    data?: Prisma.ReturnRequestUpdateInput;
    eventNote?: string | null;
  },
): Promise<{ from: ReturnStatusName }> {
  const row = await tx.returnRequest.findUniqueOrThrow({ where: { id: input.returnId }, select: { status: true } });
  const from = row.status;
  assertReturnTransition({ from, to: input.to, actor: input.actor, reason: input.reason ?? null });
  // Conditional on the status read, so two people pressing at once cannot both win.
  const updated = await tx.returnRequest.updateMany({
    where: { id: input.returnId, status: from },
    data: { status: input.to },
  });
  if (updated.count !== 1) {
    throw conflict(ErrorCode.RETURN_TRANSITION_NOT_ALLOWED, 'Somebody else changed this return. Refresh it.', [
      { code: 'CHANGED', meta: { from, to: input.to } },
    ]);
  }
  if (input.data !== undefined) await tx.returnRequest.update({ where: { id: input.returnId }, data: input.data });
  await writeEvent(tx, {
    returnRequestId: input.returnId,
    kind: input.to,
    toStatus: input.to,
    note: input.eventNote ?? null,
    who: input.who,
  });
  return { from };
}

export async function approveReturn(
  actor: StaffActor,
  returnId: string,
  input: { note?: string | null; instructions?: string | null },
): Promise<ReturnView> {
  const id = await staffReturnId(returnId);
  const who: AnyActor = { side: 'STAFF', actor };
  const row = await prisma.returnRequest.findUniqueOrThrow({
    where: { id },
    select: { returnInstructions: true, sellerOrderGroupId: true },
  });
  const instructions =
    (input.instructions ?? '').trim() ||
    row.returnInstructions ||
    (await defaultInstructions(row.sellerOrderGroupId)) ||
    null;

  await prisma.$transaction(async (tx) => {
    await move(tx, {
      returnId: id,
      to: 'APPROVED',
      actor: 'STAFF',
      who,
      data: {
        approvedAt: new Date(),
        decidedById: actor.userId,
        decidedAt: new Date(),
        decisionNote: (input.note ?? '').trim() || null,
        ...(instructions !== null ? { returnInstructions: instructions, instructionsSetAt: new Date() } : {}),
      },
      eventNote: (input.note ?? '').trim() || null,
    });
    await audit(tx, AuditAction.RETURN_APPROVED, id, who, { instructionsSet: instructions !== null });
  });
  await announce(id, 'APPROVED');
  return readStaffReturn(id);
}

export async function rejectReturn(actor: StaffActor, returnId: string, reason: string): Promise<ReturnView> {
  const id = await staffReturnId(returnId);
  const who: AnyActor = { side: 'STAFF', actor };
  const text = reason.trim();
  await prisma.$transaction(async (tx) => {
    await move(tx, {
      returnId: id,
      to: 'REJECTED',
      actor: 'STAFF',
      who,
      reason: text,
      data: {
        rejectedAt: new Date(),
        decidedById: actor.userId,
        decidedAt: new Date(),
        decisionNote: text.slice(0, 512),
        completedAt: new Date(),
      },
      eventNote: text,
    });
    await audit(tx, AuditAction.RETURN_REJECTED, id, who, { reason: text });
  });
  await announce(id, 'REJECTED');
  return readStaffReturn(id);
}

/** The goods arrived back. Staff, or the seller whose building they came to. */
export async function receiveReturn(
  who: { side: 'SELLER'; actor: SellerActor } | { side: 'STAFF'; actor: StaffActor },
  returnId: string,
  note?: string | null,
): Promise<ReturnView> {
  const id = who.side === 'SELLER' ? await sellerReturnId(who.actor, returnId) : await staffReturnId(returnId);
  if (who.side === 'SELLER' && !who.actor.canHandle) throw notFound('Return');
  await prisma.$transaction(async (tx) => {
    await move(tx, {
      returnId: id,
      to: 'RECEIVED',
      actor: who.side === 'SELLER' ? 'SELLER' : 'STAFF',
      who,
      data: { receivedAt: new Date() },
      eventNote: (note ?? '').trim() || null,
    });
    await audit(tx, AuditAction.RETURN_RECEIVED, id, who, {});
  });
  await announce(id, 'RECEIVED');
  return who.side === 'SELLER' ? readSellerReturn(who.actor, id) : readStaffReturn(id);
}

/**
 * Record what came back sellable and what came back damaged. The operator's
 * own sellable units rejoin stock and damaged ones are written off to
 * quarantine; a seller's goods are in the seller's own building, so their stock
 * is theirs to adjust in Seller Hub.
 */
export async function inspectReturn(
  who: { side: 'SELLER'; actor: SellerActor } | { side: 'STAFF'; actor: StaffActor },
  returnId: string,
  input: { outcome: { orderItemId: string; sellableQty: number; damagedQty: number }[]; note?: string | null },
): Promise<ReturnView> {
  const id = who.side === 'SELLER' ? await sellerReturnId(who.actor, returnId) : await staffReturnId(returnId);
  if (who.side === 'SELLER' && !who.actor.canHandle) throw notFound('Return');

  const row = await prisma.returnRequest.findUniqueOrThrow({
    where: { id },
    include: { lines: { include: { orderItem: { select: { productId: true, variantId: true, nameSnapshot: true } } } } },
  });
  const lineByItem = new Map(row.lines.map((line) => [line.orderItemId, line]));
  const problems: { field: string; code: string; message: string }[] = [];
  const outcomeByItem = new Map<string, { sellableQty: number; damagedQty: number }>();
  input.outcome.forEach((entry, index) => {
    const line = lineByItem.get(entry.orderItemId);
    if (line === undefined) {
      problems.push({ field: `outcome.${String(index)}.orderItemId`, code: 'NOT_ON_RETURN', message: 'That line is not part of this return.' });
      return;
    }
    if (entry.sellableQty < 0 || entry.damagedQty < 0 || entry.sellableQty + entry.damagedQty > line.quantity) {
      problems.push({
        field: `outcome.${String(index)}`,
        code: 'EXCEEDS_RETURNED',
        message: `${line.orderItem.nameSnapshot}: ${String(line.quantity)} came back; the split must not add up to more.`,
      });
      return;
    }
    outcomeByItem.set(entry.orderItemId, { sellableQty: entry.sellableQty, damagedQty: entry.damagedQty });
  });
  if (problems.length > 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'This inspection cannot be recorded.', problems);
  }

  await prisma.$transaction(async (tx) => {
    await move(tx, {
      returnId: id,
      to: 'INSPECTED',
      actor: who.side === 'SELLER' ? 'SELLER' : 'STAFF',
      who,
      data: { inspectedAt: new Date() },
      eventNote: (input.note ?? '').trim() || null,
    });
    for (const line of row.lines) {
      const outcome = outcomeByItem.get(line.orderItemId) ?? { sellableQty: 0, damagedQty: 0 };
      await tx.returnRequestLine.update({
        where: { id: line.id },
        data: { sellableQty: outcome.sellableQty, damagedQty: outcome.damagedQty },
      });
    }
    if (row.sellerOrderGroupId === null) {
      await restockFromOrder(
        row.orderId,
        row.lines.map((line) => {
          const outcome = outcomeByItem.get(line.orderItemId) ?? { sellableQty: 0, damagedQty: 0 };
          return {
            productId: line.orderItem.productId,
            variantId: line.orderItem.variantId,
            sellableQty: outcome.sellableQty,
            damagedQty: outcome.damagedQty,
          };
        }),
        'RETURN_RESTOCK',
        tx,
      );
    }
    await audit(tx, AuditAction.RETURN_INSPECTED, id, who, {
      sellable: [...outcomeByItem.values()].reduce((total, entry) => total + entry.sellableQty, 0),
      damaged: [...outcomeByItem.values()].reduce((total, entry) => total + entry.damagedQty, 0),
      restocked: row.sellerOrderGroupId === null,
    });
  });

  if (who.side === 'STAFF') await markOrderReturnedIfWhole(row.orderId, who.actor);
  await announce(id, 'INSPECTED');
  return who.side === 'SELLER' ? readSellerReturn(who.actor, id) : readStaffReturn(id);
}

/**
 * Move the ORDER to RETURNED once every unit on it has come back and been
 * inspected. A partial return leaves the order DELIVERED - most of it still
 * is - and the return carries its own status.
 */
async function markOrderReturnedIfWhole(orderId: string, actor: StaffActor): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true, items: { select: { id: true, quantity: true } } },
  });
  if (order === null || (order.status !== 'DELIVERED' && order.status !== 'SHIPPED')) return;
  if (!actor.permissions.includes('order.return')) return;
  const inspected = await prisma.returnRequestLine.findMany({
    where: { returnRequest: { orderId, status: { in: ['INSPECTED', 'COMPLETED'] } } },
    select: { orderItemId: true, quantity: true },
  });
  const back = new Map<string, number>();
  for (const line of inspected) back.set(line.orderItemId, (back.get(line.orderItemId) ?? 0) + line.quantity);
  if (!order.items.every((item) => (back.get(item.id) ?? 0) >= item.quantity)) return;

  const { transitionOrder } = await import('../orders/order.service.js');
  await transitionOrder({
    orderId,
    to: 'RETURNED',
    actor: {
      userId: actor.userId,
      email: actor.email,
      type: 'ADMIN',
      permissions: actor.permissions,
      ...(actor.ipAddress !== undefined ? { ipAddress: actor.ipAddress } : {}),
      ...(actor.correlationId !== undefined ? { correlationId: actor.correlationId } : {}),
    },
    reason: 'Every item on the order came back and was inspected',
  });
}

/**
 * Pay the buyer back for an inspected return, through the ordinary refund.
 *
 * The amount defaults to what the returned goods cost and may not be more than
 * that; `createRefund` then holds it within what is still refundable on the
 * order, and the database's `chk_order_refund_within_paid` behind it. A return
 * is refunded once: the claim below stops two presses from issuing two.
 */
export async function refundReturn(
  actor: StaffActor,
  returnId: string,
  input: { amountMinor?: string; note?: string | null; idempotencyKey: string },
): Promise<ReturnView> {
  const id = await staffReturnId(returnId);
  const row = await loadRow({ id });
  if (row.refundId !== null) return toView(row, 'STAFF');

  const valueMinor = row.lines.reduce(
    (total, line) => total + returnedLineValueMinor(line.orderItem, line.quantity),
    0n,
  );
  if (input.amountMinor !== undefined && /^\d+$/.test(input.amountMinor) && BigInt(input.amountMinor) > valueMinor) {
    throw conflict(ErrorCode.REFUND_EXCEEDS_CAPTURED, 'A return refund cannot be more than the returned goods cost.', [
      {
        field: 'amountMinor',
        code: 'EXCEEDS_RETURNED_VALUE',
        meta: { returnedValueMinor: valueMinor.toString(), requestedMinor: input.amountMinor },
      },
    ]);
  }

  assertReturnTransition({ from: row.status, to: 'COMPLETED', actor: 'STAFF' });
  // The claim: an INSPECTED return with `completedAt` set is a refund in
  // flight. A second press finds nothing to claim.
  const claimed = await prisma.returnRequest.updateMany({
    where: { id, status: 'INSPECTED', refundId: null, completedAt: null },
    data: { completedAt: new Date() },
  });
  if (claimed.count !== 1) {
    throw conflict(ErrorCode.RETURN_TRANSITION_NOT_ALLOWED, 'A refund for this return is already being issued.', [
      { code: 'IN_FLIGHT', meta: { from: row.status, to: 'COMPLETED' } },
    ]);
  }

  const reference = returnReference(id);
  let refund: Awaited<ReturnType<typeof createRefund>>;
  try {
    const amountMinor = input.amountMinor ?? (valueMinor > 0n ? valueMinor.toString() : null);
    refund = await createRefund({
      orderId: row.orderId,
      ...(amountMinor !== null ? { amountMinor } : {}),
      reason: `Return ${reference}${input.note ? `: ${input.note.trim()}` : ''}`.slice(0, 512),
      idempotencyKey: `return:${id}:${input.idempotencyKey}`.slice(0, 128),
      actorUserId: actor.userId,
      actorEmail: actor.email,
      ipAddress: actor.ipAddress ?? null,
      correlationId: actor.correlationId ?? null,
    });
  } catch (error) {
    await prisma.returnRequest.updateMany({ where: { id, refundId: null }, data: { completedAt: null } });
    throw error;
  }

  const who: AnyActor = { side: 'STAFF', actor };
  await prisma.$transaction(async (tx) => {
    await move(tx, {
      returnId: id,
      to: 'COMPLETED',
      actor: 'STAFF',
      who,
      data: { refund: { connect: { id: refund.refundId } }, completedAt: new Date() },
      eventNote: `${refund.amount.formatted} ${refund.amount.currency}`,
    });
    await writeEvent(tx, {
      returnRequestId: id,
      kind: 'REFUND_ISSUED',
      note: `${refund.amount.formatted} ${refund.amount.currency} (${refund.status})`,
      who,
    });
    if (row.sellerOrderGroupId !== null) {
      const invoices = await import('../documents/seller-invoice.service.js');
      await invoices.flagInvoicesForCredit(
        { orderId: row.orderId, sellerOrderGroupId: row.sellerOrderGroupId },
        `Return ${reference} was refunded to the buyer`,
        tx,
      );
    }
    await audit(tx, AuditAction.RETURN_REFUNDED, id, who, {
      refundId: refund.refundId,
      amountMinor: refund.amount.minor,
      refundStatus: refund.status,
    });
  });

  // Now the refund names this return, the sellers' settlements can say whose it was.
  await syncSettlementRefundsFor(row.orderId).catch((error: unknown) => {
    logger.error({ err: error, returnId: id }, 'settlement refresh after a return refund failed');
  });
  await markOrderReturnedIfWhole(row.orderId, actor).catch((error: unknown) => {
    logger.warn({ err: error, returnId: id }, 'order not moved to RETURNED after a return refund');
  });
  await settleRefundedOrder(row.orderId, { userId: actor.userId, email: actor.email, permissions: actor.permissions });
  await announce(id, 'REFUNDED');
  return readStaffReturn(id);
}

/** Close an inspected return with a replacement sent instead of a refund. */
export async function completeWithReplacement(actor: StaffActor, returnId: string, note: string): Promise<ReturnView> {
  const id = await staffReturnId(returnId);
  const who: AnyActor = { side: 'STAFF', actor };
  const text = note.trim();
  await prisma.$transaction(async (tx) => {
    const row = await tx.returnRequest.findUniqueOrThrow({ where: { id }, select: { refundId: true, completedAt: true } });
    if (row.refundId !== null || row.completedAt !== null) {
      throw conflict(ErrorCode.RETURN_TRANSITION_NOT_ALLOWED, 'This return is already being refunded.', [
        { code: 'IN_FLIGHT' },
      ]);
    }
    await move(tx, {
      returnId: id,
      to: 'COMPLETED',
      actor: 'STAFF',
      who,
      data: { resolutionNote: text.slice(0, 512), completedAt: new Date() },
      eventNote: text,
    });
    await writeEvent(tx, { returnRequestId: id, kind: 'REPLACEMENT', note: text, who });
    await audit(tx, AuditAction.RETURN_REPLACED, id, who, { note: text });
  });
  await announce(id, 'REPLACED');
  return readStaffReturn(id);
}

// ---------------------------------------------------------------------------
// Telling people
// ---------------------------------------------------------------------------

type Step = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'INSTRUCTIONS' | 'RECEIVED' | 'INSPECTED' | 'REFUNDED' | 'REPLACED';

const SELLER_STEP_WORDS: Readonly<Record<Step, string>> = Object.freeze({
  REQUESTED: 'requested',
  APPROVED: 'approved by the marketplace',
  REJECTED: 'rejected by the marketplace',
  INSTRUCTIONS: 'return instructions updated',
  RECEIVED: 'goods received',
  INSPECTED: 'goods inspected',
  REFUNDED: 'buyer refunded',
  REPLACED: 'closed with a replacement',
});

function publicUrl(path: string, base: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

/**
 * Email the buyer and the seller about one step, and put it in the seller's
 * Hub. Never fails the step it reports: the step has happened whether or not
 * the mail went, and the outbox retries delivery on its own.
 */
async function announce(returnId: string, step: Step): Promise<void> {
  try {
    const row = await prisma.returnRequest.findUniqueOrThrow({
      where: { id: returnId },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            customerProfile: { select: { fullName: true, user: { select: { email: true } } } },
          },
        },
        sellerOrderGroup: { select: { id: true, sellerAccountId: true, sellerOrderNumber: true } },
        refund: { select: { amountMinor: true, currency: true } },
      },
    });
    const reference = returnReference(returnId);
    const returnUrl = publicUrl(`/account/returns/${returnId}`, env.CUSTOMER_WEB_PUBLIC_URL);
    const base = {
      returnReference: reference,
      orderNumber: row.order.orderNumber,
      returnUrl,
    };

    const buyerEvent: Partial<Record<Step, { key: string; variables: Record<string, string> }>> = {
      REQUESTED: { key: NotificationEvent.RETURN_REQUESTED, variables: {} },
      APPROVED: {
        key: NotificationEvent.RETURN_APPROVED,
        variables: {
          instructions:
            row.returnInstructions ?? 'The seller will send you instructions shortly. You will get another email.',
        },
      },
      REJECTED: { key: NotificationEvent.RETURN_REJECTED, variables: { decisionReason: row.decisionNote ?? '' } },
      INSTRUCTIONS: {
        key: NotificationEvent.RETURN_INSTRUCTIONS,
        variables: { instructions: row.returnInstructions ?? 'A return label has been added to your return.' },
      },
      RECEIVED: { key: NotificationEvent.RETURN_RECEIVED, variables: {} },
      INSPECTED: {
        key: NotificationEvent.RETURN_INSPECTED,
        variables: {
          nextStep:
            row.preferredResolution === 'REPLACEMENT'
              ? 'Your replacement is being arranged.'
              : 'Your refund is being arranged.',
        },
      },
      REPLACED: {
        key: NotificationEvent.RETURN_COMPLETED,
        variables: { outcome: `A replacement has been sent. ${row.resolutionNote ?? ''}`.trim() },
      },
      // REFUNDED is told by the refund's own email (refund.processed).
    };

    const forBuyer = buyerEvent[step];
    if (forBuyer !== undefined) {
      await enqueueNotification({
        eventKey: forBuyer.key,
        recipientEmail: row.order.customerProfile.user.email,
        recipientName: row.order.customerProfile.fullName,
        variables: { ...base, ...forBuyer.variables },
        dedupeKey: `return:${returnId}:${step}:${step === 'INSTRUCTIONS' ? String(Date.now()) : 'once'}`,
        relatedType: 'return_request',
        relatedId: returnId,
      });
    }

    if (row.sellerOrderGroup !== null) {
      const group = row.sellerOrderGroup;
      const sellerUrl = publicUrl(`/seller/returns/${returnId}`, env.CUSTOMER_WEB_PUBLIC_URL);
      const members = await prisma.sellerMember.findMany({
        where: { sellerAccountId: group.sellerAccountId, removedAt: null },
        select: { role: true, customerProfile: { select: { user: { select: { email: true } } } } },
      });
      const recipients = [
        ...new Set(
          members
            .filter((member) => sellerRoleHas(member.role, SellerPermission.RETURN_HANDLE))
            .map((member) => member.customerProfile.user.email),
        ),
      ];
      const detail =
        step === 'REJECTED'
          ? `Reason: ${row.decisionNote ?? ''}`
          : step === 'REFUNDED' && row.refund !== null
            ? `Refunded: ${serialiseMoney(row.refund.amountMinor, row.refund.currency).formatted} ${row.refund.currency}. Your settlement for this order is updated.`
            : 'No action is needed from you unless Seller Hub says otherwise.';
      for (const email of recipients) {
        await enqueueNotification({
          eventKey: step === 'REQUESTED' ? NotificationEvent.RETURN_NEW_FOR_SELLER : NotificationEvent.RETURN_UPDATE_FOR_SELLER,
          recipientEmail: email,
          variables: {
            returnReference: reference,
            sellerOrderNumber: group.sellerOrderNumber,
            reasonCode: row.reasonCode ?? 'OTHER',
            step: SELLER_STEP_WORDS[step],
            detail,
            sellerUrl,
          },
          dedupeKey: `return:${returnId}:${step}:seller:${email}:${step === 'INSTRUCTIONS' ? String(Date.now()) : 'once'}`,
          relatedType: 'return_request',
          relatedId: returnId,
        });
      }
      await notifySeller({
        sellerAccountId: group.sellerAccountId,
        kind: 'RETURN_OR_DISPUTE',
        title: `Return ${reference} on ${group.sellerOrderNumber}: ${SELLER_STEP_WORDS[step]}`,
        body:
          step === 'REQUESTED'
            ? 'A buyer asked to return items. Accept or contest it, and say how the goods should come back.'
            : detail,
        linkPath: `/seller/returns/${returnId}`,
        severity: step === 'REQUESTED' ? 'WARNING' : 'INFO',
        subjectType: 'return_request',
        subjectId: returnId,
        dedupeKey: `return:${returnId}:${step}:${step === 'INSTRUCTIONS' ? String(Date.now()) : 'once'}`,
      });
    }
    await dispatchPendingNotifications();
  } catch (error) {
    logger.error({ err: error, returnId, step }, 'return notification failed');
  }
}
