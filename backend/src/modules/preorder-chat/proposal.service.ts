/**
 * Preorder proposals: the bridge from a conversation to the preorder workflow.
 *
 * Chat is where a customer and the business reach an understanding - a
 * quantity, a container size, a date, a rough price. It is NOT where anybody
 * commits to one. Typing "yes" in a conversation reserves nothing, prices
 * nothing and orders nothing, and nothing in this file reacts to what anybody
 * types.
 *
 * So when staff and customer agree, staff send a PROPOSAL: a structured card
 * with the quantity, the unit and what that is in pieces (from the seller's
 * own verified figures), a delivery date, an indicative price clearly labelled
 * as such, a split schedule if there is one, and an expiry. The customer opens
 * it with "Review proposal", which opens the ORDINARY preorder form filled in
 * with those figures. They check it, accept the preorder terms there, and
 * submit a real preorder request. From that moment the preorder workflow
 * decides everything: the supplier answers with terms, and those terms - with
 * the hash the customer confirms - are what bind.
 *
 * A proposal is never edited. "Update preorder proposal" writes revision n+1
 * and marks revision n SUPERSEDED, so the card the customer saw yesterday is
 * still the card they saw.
 */
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import { activeKeyFor, holdsActiveKey } from '../../domain/preorder-chat-state.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  AdminNotificationKind,
  createAdminNotification,
} from '../notifications/admin-notification.service.js';
import { buildChatContext, CHAT_ORDERING_UNITS } from './context.service.js';
import {
  appendSystemMessage,
  staffConversationRow,
  type ChatOutcome,
  type CustomerActor,
  type StaffActor,
} from './conversation.service.js';
import type { ChatBusEvent } from './realtime/events.js';
import { PROPOSAL_SELECT, proposalView, type ProposalRow } from './views.js';

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

export const proposalInputSchema = z
  .object({
    orderingUnit: z.enum(CHAT_ORDERING_UNITS),
    unitQuantity: z.number().int().positive().max(1_000_000_000),
    /** Minor units per piece, as a string, like every amount on this API. */
    indicativeUnitPriceMinor: z
      .string()
      .regex(/^\d{1,15}$/, 'A whole number of minor units.')
      .nullable()
      .default(null),
    availabilityNote: z.string().trim().max(500).nullable().default(null),
    deliveryDate: isoDay,
    splitDeliveries: z
      .array(z.object({ date: isoDay, baseUnits: z.number().int().positive() }).strict())
      .max(24)
      .default([]),
    termsNote: z.string().trim().max(1000).nullable().default(null),
    expiresInHours: z.number().int().min(1).max(2160).default(72),
  })
  .strict();

export type ProposalInput = z.infer<typeof proposalInputSchema>;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function proposalEvents(
  conversationId: string,
  customerProfileId: string,
  messageId: string | null,
  seq: number,
): ChatBusEvent[] {
  return [
    ...(messageId === null
      ? []
      : [{ kind: 'message.created' as const, conversationId, customerProfileId, messageId, seq }]),
    {
      kind: 'conversation.updated',
      conversationId,
      customerProfileId,
      reason: 'proposal',
      staffOnly: false,
    },
  ];
}

async function seqOf(messageId: string | null): Promise<number> {
  if (messageId === null) return 0;
  const row = await prisma.preorderChatMessage.findUnique({
    where: { id: messageId },
    select: { serverSequence: true },
  });
  return row?.serverSequence ?? 0;
}

/** The card messages for one proposal, so their state changes reach both sides. */
async function cardMessageIds(proposalId: string): Promise<string[]> {
  const rows = await prisma.preorderChatMessage.findMany({
    where: { proposalId },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * Create a proposal, or a new revision of the one already open.
 *
 * The pieces are worked out HERE from the product's current verified unit
 * sizes, not taken from the form: a 40-ft container is whatever the seller
 * has verified it holds, and a proposal that said otherwise would be the
 * first thing a dispute pointed at.
 */
export async function createProposal(
  actor: StaffActor,
  conversationId: string,
  input: ProposalInput,
): Promise<ChatOutcome<Record<string, unknown>>> {
  if (!actor.permissions.has(Permission.PREORDER_CHAT_REPLY)) {
    throw forbidden(ErrorCode.PERMISSION_DENIED, 'You do not have permission to perform this action.');
  }
  const row = await staffConversationRow(conversationId);
  if (row.status === 'CLOSED' || row.status === 'SPAM' || row.status === 'BLOCKED') {
    throw conflict(
      ErrorCode.PREORDER_CHAT_TRANSITION_NOT_ALLOWED,
      'Reopen the conversation before sending a proposal.',
      [{ code: 'STATUS', meta: { from: row.status, to: row.status } }],
    );
  }

  const context = await buildChatContext({
    productId: row.productId,
    variantId: row.variantId,
    orderingUnit: input.orderingUnit,
    unitQuantity: input.unitQuantity,
    desiredDeliveryDate: null,
  });
  const pieces = context.snapshot.request.baseUnits;
  if (pieces === null) {
    throw badRequest(
      ErrorCode.PREORDER_CONTAINER_NOT_CONFIGURED,
      'The seller has not verified how many pieces fit in that container.',
      [{ field: 'orderingUnit', code: 'NOT_CONFIGURED', meta: { unit: input.orderingUnit } }],
    );
  }

  const problems: { field: string; code: string }[] = [];
  if (input.deliveryDate <= todayUtc()) problems.push({ field: 'deliveryDate', code: 'NOT_FUTURE' });
  if (input.expiresInHours > env.PREORDER_PROPOSAL_MAX_EXPIRY_HOURS) {
    problems.push({ field: 'expiresInHours', code: 'TOO_LONG' });
  }
  if (input.splitDeliveries.length > 0) {
    const total = input.splitDeliveries.reduce((sum, part) => sum + part.baseUnits, 0);
    if (total !== pieces) problems.push({ field: 'splitDeliveries', code: 'DOES_NOT_ADD_UP' });
    for (let index = 1; index < input.splitDeliveries.length; index += 1) {
      const previous = input.splitDeliveries[index - 1];
      const current = input.splitDeliveries[index];
      if (previous !== undefined && current !== undefined && current.date <= previous.date) {
        problems.push({ field: `splitDeliveries.${String(index)}.date`, code: 'NOT_AFTER_PREVIOUS' });
      }
    }
    const first = input.splitDeliveries[0];
    if (first !== undefined && first.date <= todayUtc()) {
      problems.push({ field: 'splitDeliveries.0.date', code: 'NOT_FUTURE' });
    }
  }
  if (problems.length > 0) {
    throw badRequest(ErrorCode.PREORDER_PROPOSAL_INVALID, 'The proposal does not hold together.', problems);
  }

  // The currency an order would be charged in: the seller's offer, or the
  // store's own product.
  const offerId = context.keys.offerId;
  const priced =
    offerId === null
      ? await prisma.product.findUnique({ where: { id: row.productId }, select: { currency: true } })
      : await prisma.sellerOffer.findUnique({ where: { id: offerId }, select: { currency: true } });
  if (priced === null) throw notFound('Product');
  const currency = priced.currency;

  const proposalId = newId();
  const { messageId, superseded } = await prisma.$transaction(async (tx) => {
    const open = await tx.preorderChatProposal.findMany({
      where: { conversationId, state: 'PROPOSED' },
      select: { id: true },
    });
    await tx.preorderChatProposal.updateMany({
      where: { id: { in: open.map((proposal) => proposal.id) } },
      data: { state: 'SUPERSEDED' },
    });
    const latest = await tx.preorderChatProposal.findFirst({
      where: { conversationId },
      orderBy: { revision: 'desc' },
      select: { revision: true },
    });

    await tx.preorderChatProposal.create({
      data: {
        id: proposalId,
        conversationId,
        revision: (latest?.revision ?? 0) + 1,
        orderingUnit: input.orderingUnit,
        unitQuantity: input.unitQuantity,
        equivalentBaseUnits: pieces,
        indicativeUnitPriceMinor:
          input.indicativeUnitPriceMinor === null ? null : BigInt(input.indicativeUnitPriceMinor),
        currency,
        availabilityNote: input.availabilityNote,
        deliveryDate: new Date(`${input.deliveryDate}T00:00:00.000Z`),
        ...(input.splitDeliveries.length > 0 ? { splitDeliveriesJson: input.splitDeliveries } : {}),
        termsNote: input.termsNote,
        expiresAt: new Date(Date.now() + input.expiresInHours * 3_600_000),
        createdByUserId: actor.userId,
      },
    });

    await recordAudit(
      {
        action: AuditAction.PREORDER_CHAT_PROPOSAL_CREATED,
        resourceType: 'preorder_chat',
        resourceId: conversationId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: {
          proposalId,
          supersedes: open.map((proposal) => proposal.id),
          orderingUnit: input.orderingUnit,
          unitQuantity: input.unitQuantity,
          equivalentBaseUnits: pieces,
          indicativeUnitPriceMinor: input.indicativeUnitPriceMinor,
          currency,
          deliveryDate: input.deliveryDate,
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    const id = await appendSystemMessage(
      tx,
      conversationId,
      open.length > 0 ? 'proposal.updated' : 'proposal.created',
      { proposalId },
      `proposal:${proposalId}`,
      { proposalId, messageType: 'STRUCTURED_OFFER' },
    );
    return { messageId: id, superseded: open.map((proposal) => proposal.id) };
  });

  const updatedCards = (await Promise.all(superseded.map(cardMessageIds))).flat();
  const proposal = (await prisma.preorderChatProposal.findUniqueOrThrow({
    where: { id: proposalId },
    select: PROPOSAL_SELECT,
  })) as ProposalRow;

  return {
    value: proposalView(proposal),
    events: [
      ...proposalEvents(conversationId, row.customerProfileId, messageId, await seqOf(messageId)),
      ...updatedCards.map((id) => ({
        kind: 'message.updated' as const,
        conversationId,
        customerProfileId: row.customerProfileId,
        messageId: id,
      })),
    ],
  };
}

export async function listProposals(conversationId: string): Promise<Record<string, unknown>[]> {
  const rows = (await prisma.preorderChatProposal.findMany({
    where: { conversationId },
    orderBy: { revision: 'desc' },
    select: PROPOSAL_SELECT,
  })) as ProposalRow[];
  return rows.map((row) => proposalView(row));
}

async function openProposal(conversationId: string, proposalId: string): Promise<ProposalRow> {
  const proposal = (await prisma.preorderChatProposal.findFirst({
    where: { id: proposalId, conversationId },
    select: PROPOSAL_SELECT,
  })) as ProposalRow | null;
  if (proposal === null) throw notFound('Proposal');
  if (proposal.state !== 'PROPOSED' || proposal.expiresAt <= new Date()) {
    throw conflict(
      ErrorCode.PREORDER_CHAT_PROPOSAL_NOT_OPEN,
      'This proposal is no longer open. Ask the team for a new one.',
      [{ code: 'STATE', meta: { state: proposal.expiresAt <= new Date() ? 'EXPIRED' : proposal.state } }],
    );
  }
  return proposal;
}

export async function withdrawProposal(
  actor: StaffActor,
  conversationId: string,
  proposalId: string,
): Promise<ChatOutcome<Record<string, unknown>>> {
  if (!actor.permissions.has(Permission.PREORDER_CHAT_REPLY)) {
    throw forbidden(ErrorCode.PERMISSION_DENIED, 'You do not have permission to perform this action.');
  }
  const row = await staffConversationRow(conversationId);
  await openProposal(conversationId, proposalId);

  const messageId = await prisma.$transaction(async (tx) => {
    await tx.preorderChatProposal.update({
      where: { id: proposalId },
      data: { state: 'WITHDRAWN', respondedAt: new Date() },
    });
    await recordAudit(
      {
        action: AuditAction.PREORDER_CHAT_PROPOSAL_WITHDRAWN,
        resourceType: 'preorder_chat',
        resourceId: conversationId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { proposalId },
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
    return appendSystemMessage(tx, conversationId, 'proposal.withdrawn', { proposalId }, `proposal:${proposalId}:withdrawn`);
  });

  const cards = await cardMessageIds(proposalId);
  return {
    value: proposalView(
      (await prisma.preorderChatProposal.findUniqueOrThrow({ where: { id: proposalId }, select: PROPOSAL_SELECT })),
    ),
    events: [
      ...proposalEvents(conversationId, row.customerProfileId, messageId, await seqOf(messageId)),
      ...cards.map((id) => ({
        kind: 'message.updated' as const,
        conversationId,
        customerProfileId: row.customerProfileId,
        messageId: id,
      })),
    ],
  };
}

// ---------------------------------------------------------------------------
// The customer's answers
// ---------------------------------------------------------------------------

async function ownedConversation(actor: CustomerActor, conversationId: string) {
  const row = await prisma.preorderChatConversation.findFirst({
    where: { id: conversationId, customerProfileId: actor.customerProfileId },
    select: {
      id: true,
      status: true,
      productId: true,
      variantId: true,
      variantKey: true,
      customerProfileId: true,
      preorderRequestId: true,
      productName: true,
    },
  });
  if (row === null) throw notFound('Conversation');
  return row;
}

/**
 * One proposal and what the preorder form needs to open on it.
 *
 * The form still runs its own eligibility check and the customer still sees
 * and accepts the preorder terms - this only saves them retyping the figures.
 */
export async function getProposalForCustomer(
  actor: CustomerActor,
  conversationId: string,
  proposalId: string,
): Promise<Record<string, unknown>> {
  const conversation = await ownedConversation(actor, conversationId);
  const proposal = (await prisma.preorderChatProposal.findFirst({
    where: { id: proposalId, conversationId },
    select: PROPOSAL_SELECT,
  })) as ProposalRow | null;
  if (proposal === null) throw notFound('Proposal');
  return {
    proposal: proposalView(proposal),
    prefill: {
      productId: conversation.productId,
      variantId: conversation.variantId,
      orderingUnit: proposal.orderingUnit,
      unitQuantity: proposal.unitQuantity,
      requestedDeliveryDate: proposal.deliveryDate.toISOString().slice(0, 10),
    },
  };
}

export const declineSchema = z
  .object({ reason: z.string().trim().max(500).nullable().default(null) })
  .strict();

export async function declineProposal(
  actor: CustomerActor,
  conversationId: string,
  proposalId: string,
  input: z.infer<typeof declineSchema>,
): Promise<ChatOutcome<Record<string, unknown>>> {
  const conversation = await ownedConversation(actor, conversationId);
  await openProposal(conversationId, proposalId);

  const messageId = await prisma.$transaction(async (tx) => {
    await tx.preorderChatProposal.update({
      where: { id: proposalId },
      data: { state: 'DECLINED', respondedAt: new Date(), declineReason: input.reason },
    });
    await recordAudit(
      {
        action: AuditAction.PREORDER_CHAT_PROPOSAL_ANSWERED,
        resourceType: 'preorder_chat',
        resourceId: conversationId,
        actorType: 'CUSTOMER',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { proposalId, outcome: 'DECLINED' },
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
    await createAdminNotification(
      {
        kind: AdminNotificationKind.PREORDER_CHAT_PROPOSAL_ANSWERED,
        variables: { productName: conversation.productName, outcome: 'DECLINED' },
        linkPath: `/preorder-chats/${conversationId}`,
        requiredPermission: Permission.PREORDER_CHAT_VIEW,
        relatedType: 'preorder_chat',
        relatedId: conversationId,
        dedupeKey: `preorder-chat-proposal:${proposalId}:declined`,
      },
      tx,
    );
    return appendSystemMessage(tx, conversationId, 'proposal.declined', { proposalId }, `proposal:${proposalId}:declined`);
  });

  const cards = await cardMessageIds(proposalId);
  return {
    value: proposalView(
      (await prisma.preorderChatProposal.findUniqueOrThrow({ where: { id: proposalId }, select: PROPOSAL_SELECT })),
    ),
    events: [
      ...proposalEvents(conversationId, conversation.customerProfileId, messageId, await seqOf(messageId)),
      ...cards.map((id) => ({
        kind: 'message.updated' as const,
        conversationId,
        customerProfileId: conversation.customerProfileId,
        messageId: id,
      })),
    ],
  };
}

export const submittedSchema = z.object({ preorderRequestId: z.string().length(26) }).strict();

/**
 * "I sent a preorder request from this proposal."
 *
 * Checked, not believed: the request must be this customer's, for this
 * product and option, and made after the proposal was. The conversation is
 * linked to it, so staff see the preorder beside the chat that led to it. The
 * request itself is untouched - it is the preorder workflow's, and it goes to
 * the supplier exactly as any other request does.
 */
export async function markProposalSubmitted(
  actor: CustomerActor,
  conversationId: string,
  proposalId: string,
  input: z.infer<typeof submittedSchema>,
): Promise<ChatOutcome<Record<string, unknown>>> {
  const conversation = await ownedConversation(actor, conversationId);
  const proposal = (await prisma.preorderChatProposal.findFirst({
    where: { id: proposalId, conversationId },
    select: PROPOSAL_SELECT,
  })) as ProposalRow | null;
  if (proposal === null) throw notFound('Proposal');

  // Idempotent: the same answer twice is the same answer.
  if (proposal.state === 'SUBMITTED' && proposal.preorderRequestId === input.preorderRequestId) {
    return { value: proposalView(proposal), events: [] };
  }
  await openProposal(conversationId, proposalId);

  const request = await prisma.preorderRequest.findUnique({
    where: { id: input.preorderRequestId },
    select: {
      id: true,
      customerProfileId: true,
      productId: true,
      variantKey: true,
      requestNumber: true,
      createdAt: true,
    },
  });
  if (
    request === null ||
    request.customerProfileId !== actor.customerProfileId ||
    request.productId !== conversation.productId ||
    request.variantKey !== conversation.variantKey ||
    request.createdAt < proposal.createdAt
  ) {
    throw badRequest(
      ErrorCode.PREORDER_CHAT_PREORDER_MISMATCH,
      'That preorder does not match this proposal.',
      [{ field: 'preorderRequestId', code: 'MISMATCH' }],
    );
  }

  const messageId = await prisma.$transaction(async (tx) => {
    await tx.preorderChatProposal.update({
      where: { id: proposalId },
      data: { state: 'SUBMITTED', respondedAt: new Date(), preorderRequestId: request.id },
    });

    // Link the conversation to the request, where nothing else holds that key.
    if (conversation.preorderRequestId === null && holdsActiveKey(conversation.status)) {
      const key = activeKeyFor({
        customerProfileId: conversation.customerProfileId,
        productId: conversation.productId,
        variantKey: conversation.variantKey,
        preorderKey: request.id,
      });
      const taken = await tx.preorderChatConversation.findUnique({
        where: { activeKey: key },
        select: { id: true },
      });
      if (taken === null) {
        await tx.preorderChatConversation.update({
          where: { id: conversationId },
          data: { preorderRequestId: request.id, preorderKey: request.id, activeKey: key },
        });
      }
    }

    await recordAudit(
      {
        action: AuditAction.PREORDER_CHAT_PROPOSAL_ANSWERED,
        resourceType: 'preorder_chat',
        resourceId: conversationId,
        actorType: 'CUSTOMER',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { proposalId, outcome: 'SUBMITTED', preorderRequestId: request.id },
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
    await createAdminNotification(
      {
        kind: AdminNotificationKind.PREORDER_CHAT_PROPOSAL_ANSWERED,
        variables: { productName: conversation.productName, outcome: 'SUBMITTED' },
        linkPath: `/preorder-chats/${conversationId}`,
        requiredPermission: Permission.PREORDER_CHAT_VIEW,
        relatedType: 'preorder_chat',
        relatedId: conversationId,
        dedupeKey: `preorder-chat-proposal:${proposalId}:submitted`,
      },
      tx,
    );
    return appendSystemMessage(
      tx,
      conversationId,
      'proposal.submitted',
      { proposalId, requestNumber: request.requestNumber, preorderRequestId: request.id },
      `proposal:${proposalId}:submitted`,
    );
  });

  const cards = await cardMessageIds(proposalId);
  return {
    value: proposalView(
      (await prisma.preorderChatProposal.findUniqueOrThrow({ where: { id: proposalId }, select: PROPOSAL_SELECT })),
    ),
    events: [
      ...proposalEvents(conversationId, conversation.customerProfileId, messageId, await seqOf(messageId)),
      {
        kind: 'conversation.updated',
        conversationId,
        customerProfileId: conversation.customerProfileId,
        reason: 'linked',
        staffOnly: false,
      },
      ...cards.map((id) => ({
        kind: 'message.updated' as const,
        conversationId,
        customerProfileId: conversation.customerProfileId,
        messageId: id,
      })),
    ],
  };
}
