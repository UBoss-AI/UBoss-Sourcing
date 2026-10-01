/**
 * Production milestones and exceptions on one seller order group.
 *
 * Every move is decided by `domain/production-milestones.ts` inside the
 * transaction that writes it, with the group row locked so two members
 * clicking at once cannot both record the same stage.
 *
 * WHAT THE BUYER SEES
 *
 * Each change also writes a `SellerOrderBuyerUpdate`: a kind, a stage, a reason
 * code, a date and the one sentence the seller chose to share. The buyer's
 * timeline reads only that table, so a seller's internal note can never reach
 * a buyer by a later join.
 *
 * WHAT IT NEVER DOES
 *
 * It never changes the seller order's status, nor the buyer's order status.
 * Accepting, packing and ready-for-dispatch stay the moves the seller makes on
 * the order itself, through the seller state machine and `assertTransition`.
 * READY here is the seller's statement; it opens no gate.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import {
  PRODUCTION_STAGES,
  assertCanCompleteStage,
  assertCanDelayStage,
  assertProductionOpen,
  nextProductionStage,
  type ProductionDelayReasonName,
  type ProductionStageName,
} from '../../domain/production-milestones.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import {
  assertSellerOwnership,
  assertSellerPermission,
  type SellerMembership,
} from './account.service.js';
import { recordSellerAudit } from './audit.service.js';

function dateOnly(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

function parseDate(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Use a date like 2026-10-31.', [{ field, code: 'INVALID_DATE' }]);
  }
  return new Date(`${value}T00:00:00Z`);
}

function trimOrNull(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  return text.length === 0 ? null : text;
}

/** Lock the group, check it is the member's, and return what the rules need. */
async function lockGroup(tx: PrismaTransaction, membership: SellerMembership, groupId: string) {
  await tx.$queryRaw`SELECT id FROM seller_order_groups WHERE id = ${groupId} FOR UPDATE`;
  const group = await tx.sellerOrderGroup.findUnique({
    where: { id: groupId },
    select: { id: true, sellerAccountId: true, orderId: true, status: true, sellerOrderNumber: true },
  });
  if (group === null) throw notFound('Order');
  assertSellerOwnership(membership, group.sellerAccountId, 'Order');

  const done = await tx.sellerProductionMilestone.findMany({
    where: { orderGroupId: groupId, completedAt: { not: null } },
    select: { stage: true },
  });
  return { group, completed: new Set(done.map((row) => row.stage)) };
}

/** The production panel for one seller order. */
export async function readProduction(membership: SellerMembership, groupId: string) {
  assertSellerPermission(membership, SellerPermission.ORDER_READ);

  const group = await prisma.sellerOrderGroup.findUnique({
    where: { id: groupId },
    select: {
      sellerAccountId: true,
      status: true,
      productionMilestones: true,
      productionDelays: { orderBy: { raisedAt: 'desc' } },
    },
  });
  if (group === null) throw notFound('Order');
  assertSellerOwnership(membership, group.sellerAccountId, 'Order');

  const byStage = new Map(group.productionMilestones.map((row) => [row.stage, row]));
  const completed = new Set(
    group.productionMilestones.filter((row) => row.completedAt !== null).map((row) => row.stage),
  );
  let open = true;
  try {
    assertProductionOpen(group.status);
  } catch {
    open = false;
  }

  return {
    open,
    nextStage: open ? nextProductionStage(completed) : null,
    stages: PRODUCTION_STAGES.map((stage) => {
      const row = byStage.get(stage);
      return {
        stage,
        plannedFor: dateOnly(row?.plannedFor ?? null),
        completedAt: row?.completedAt?.toISOString() ?? null,
        completedByLabel: row?.completedByLabel ?? null,
        internalNote: row?.internalNote ?? null,
        buyerNote: row?.buyerNote ?? null,
      };
    }),
    delays: group.productionDelays.map((delay) => ({
      id: delay.id,
      stage: delay.stage,
      reason: delay.reason,
      detail: delay.detail,
      buyerMessage: delay.buyerMessage,
      revisedDate: dateOnly(delay.revisedDate),
      raisedAt: delay.raisedAt.toISOString(),
      raisedByLabel: delay.raisedByLabel,
      resolvedAt: delay.resolvedAt?.toISOString() ?? null,
      resolutionNote: delay.resolutionNote,
    })),
  };
}

export interface CompleteMilestoneInput {
  membership: SellerMembership;
  groupId: string;
  stage: ProductionStageName;
  internalNote?: string | null;
  buyerNote?: string | null;
  correlationId?: string | null;
}

/** Record that a stage is done. In order, never skipped, never twice. */
export async function completeMilestone(input: CompleteMilestoneInput): Promise<void> {
  const { membership } = input;
  assertSellerPermission(membership, SellerPermission.ORDER_FULFIL);
  const buyerNote = trimOrNull(input.buyerNote);
  const internalNote = trimOrNull(input.internalNote);

  await prisma.$transaction(async (tx) => {
    const { group, completed } = await lockGroup(tx, membership, input.groupId);
    assertCanCompleteStage({ groupStatus: group.status, completed, stage: input.stage });

    const now = new Date();
    await tx.sellerProductionMilestone.upsert({
      where: { orderGroupId_stage: { orderGroupId: group.id, stage: input.stage } },
      create: {
        id: newId(),
        orderGroupId: group.id,
        sellerAccountId: group.sellerAccountId,
        stage: input.stage,
        completedAt: now,
        completedByLabel: membership.displayName.slice(0, 160),
        internalNote,
        buyerNote,
      },
      update: { completedAt: now, completedByLabel: membership.displayName.slice(0, 160), internalNote, buyerNote },
    });

    await tx.sellerOrderBuyerUpdate.create({
      data: {
        id: newId(),
        orderGroupId: group.id,
        orderId: group.orderId,
        kind: 'MILESTONE_REACHED',
        stage: input.stage,
        message: buyerNote,
      },
    });

    await recordSellerAudit({
      tx,
      sellerAccountId: group.sellerAccountId,
      action: 'seller.production.milestone_completed',
      actor: { type: 'CUSTOMER', label: membership.displayName },
      resourceType: 'seller_order_group',
      resourceId: group.id,
      after: { stage: input.stage },
      summary: `${group.sellerOrderNumber}: ${input.stage} recorded.`,
      correlationId: input.correlationId ?? null,
    });
  });
}

/** Set or move the date a stage is expected. Not for a stage already done. */
export async function planMilestone(input: {
  membership: SellerMembership;
  groupId: string;
  stage: ProductionStageName;
  plannedFor: string;
  correlationId?: string | null;
}): Promise<void> {
  const { membership } = input;
  assertSellerPermission(membership, SellerPermission.ORDER_FULFIL);
  const plannedFor = parseDate(input.plannedFor, 'plannedFor');

  await prisma.$transaction(async (tx) => {
    const { group, completed } = await lockGroup(tx, membership, input.groupId);
    assertCanDelayStage({ groupStatus: group.status, completed, stage: input.stage });

    await tx.sellerProductionMilestone.upsert({
      where: { orderGroupId_stage: { orderGroupId: group.id, stage: input.stage } },
      create: {
        id: newId(),
        orderGroupId: group.id,
        sellerAccountId: group.sellerAccountId,
        stage: input.stage,
        plannedFor,
      },
      update: { plannedFor },
    });

    await tx.sellerOrderBuyerUpdate.create({
      data: {
        id: newId(),
        orderGroupId: group.id,
        orderId: group.orderId,
        kind: 'MILESTONE_PLANNED',
        stage: input.stage,
        expectedDate: plannedFor,
      },
    });
  });
}

/** Raise a production exception against a stage not yet done. */
export async function raiseDelay(input: {
  membership: SellerMembership;
  groupId: string;
  stage: ProductionStageName;
  reason: ProductionDelayReasonName;
  revisedDate: string;
  detail?: string | null;
  buyerMessage?: string | null;
  correlationId?: string | null;
}): Promise<{ delayId: string }> {
  const { membership } = input;
  assertSellerPermission(membership, SellerPermission.ORDER_FULFIL);
  const revisedDate = parseDate(input.revisedDate, 'revisedDate');
  const buyerMessage = trimOrNull(input.buyerMessage);
  const detail = trimOrNull(input.detail);

  if (input.reason === 'OTHER' && detail === null && buyerMessage === null) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say what the problem is.', [
      { field: 'detail', code: 'REQUIRED' },
    ]);
  }

  const delayId = newId();
  await prisma.$transaction(async (tx) => {
    const { group, completed } = await lockGroup(tx, membership, input.groupId);
    assertCanDelayStage({ groupStatus: group.status, completed, stage: input.stage });

    await tx.sellerProductionDelay.create({
      data: {
        id: delayId,
        orderGroupId: group.id,
        sellerAccountId: group.sellerAccountId,
        stage: input.stage,
        reason: input.reason,
        detail,
        buyerMessage,
        revisedDate,
        raisedByLabel: membership.displayName.slice(0, 160),
      },
    });

    await tx.sellerOrderBuyerUpdate.create({
      data: {
        id: newId(),
        orderGroupId: group.id,
        orderId: group.orderId,
        kind: 'DELAY_RAISED',
        stage: input.stage,
        reason: input.reason,
        expectedDate: revisedDate,
        message: buyerMessage,
      },
    });

    await recordSellerAudit({
      tx,
      sellerAccountId: group.sellerAccountId,
      action: 'seller.production.delay_raised',
      actor: { type: 'CUSTOMER', label: membership.displayName },
      resourceType: 'seller_order_group',
      resourceId: group.id,
      after: { stage: input.stage, reason: input.reason, revisedDate: input.revisedDate },
      summary: `${group.sellerOrderNumber}: production exception raised (${input.reason}).`,
      correlationId: input.correlationId ?? null,
    });
  });

  return { delayId };
}

/** Close an open exception. */
export async function resolveDelay(input: {
  membership: SellerMembership;
  groupId: string;
  delayId: string;
  resolutionNote?: string | null;
  correlationId?: string | null;
}): Promise<void> {
  const { membership } = input;
  assertSellerPermission(membership, SellerPermission.ORDER_FULFIL);
  const note = trimOrNull(input.resolutionNote);

  await prisma.$transaction(async (tx) => {
    const { group } = await lockGroup(tx, membership, input.groupId);
    const delay = await tx.sellerProductionDelay.findUnique({ where: { id: input.delayId } });
    if (delay === null || delay.orderGroupId !== group.id) throw notFound('Exception');
    if (delay.resolvedAt !== null) {
      throw conflict(ErrorCode.PRODUCTION_MILESTONE_NOT_ALLOWED, 'This exception is already resolved.', [
        { field: 'delayId', code: 'ALREADY_RESOLVED' },
      ]);
    }

    await tx.sellerProductionDelay.update({
      where: { id: delay.id },
      data: { resolvedAt: new Date(), resolvedByLabel: membership.displayName.slice(0, 160), resolutionNote: note },
    });

    await tx.sellerOrderBuyerUpdate.create({
      data: {
        id: newId(),
        orderGroupId: group.id,
        orderId: group.orderId,
        kind: 'DELAY_RESOLVED',
        stage: delay.stage,
        reason: delay.reason,
        message: note,
      },
    });

    await recordSellerAudit({
      tx,
      sellerAccountId: group.sellerAccountId,
      action: 'seller.production.delay_resolved',
      actor: { type: 'CUSTOMER', label: membership.displayName },
      resourceType: 'seller_order_group',
      resourceId: group.id,
      summary: `${group.sellerOrderNumber}: production exception resolved.`,
      correlationId: input.correlationId ?? null,
    });
  });
}
