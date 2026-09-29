/**
 * Requests for quotation: the seller's side (Master row 17).
 *
 * A seller reaches a request ONLY through its own invitation, found by the
 * seller account the session resolved to. A request it was not invited to is
 * "not found", exactly like one that does not exist. What it sees of the
 * request is what the buyer asked (the current requirement and every
 * version), the requirement's files, its own thread and files, and the
 * timeline events shared with every seller or about itself - never another
 * seller's name, answer, quote or messages.
 */
import { z } from 'zod';
import { ErrorCode, conflict, type AppError } from '../../domain/errors.js';
import { assertInvitationTransition, RESPONSIVE_INVITATION_STATUSES, type RfqStatusName } from '../../domain/rfq-state.js';
import type { RfqRequirement } from '../../domain/rfq.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  dispatchPendingNotifications,
  enqueueNotification,
  NotificationEvent,
} from '../notifications/notification.service.js';
import { resolveSellerNotifications } from '../seller/notification.service.js';
import { rfqNotFound, type RfqSupplier } from './access.js';
import {
  ATTACHMENT_SELECT,
  attachmentView,
  rfqAttachmentPolicy,
  supplierAttachmentWhere,
  type RfqAttachmentView,
} from './attachment.service.js';
import {
  buyerRfqUrl,
  expireLapsedInvitations,
  invitationResolutionKey,
  recordEvent,
  requirementOf,
} from './rfq.service.js';

export const SUPPLIER_RFQ_FILTERS = ['action', 'quoted', 'closed', 'all'] as const;
export const supplierListQuerySchema = z.object({ filter: z.enum(SUPPLIER_RFQ_FILTERS).default('action') });
export const declineSchema = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();

/** The seller can no longer answer; `code` says why. */
export function responseClosed(code: string): AppError {
  return conflict(ErrorCode.RFQ_RESPONSE_CLOSED, 'This request is no longer taking answers from you.', [{ code }]);
}

export async function loadInvitation(supplier: RfqSupplier, rfqId: string) {
  const invitation = await prisma.rfqInvitation.findUnique({
    where: { rfqId_sellerAccountId: { rfqId, sellerAccountId: supplier.sellerAccountId } },
    include: { rfq: true },
  });
  if (invitation === null || invitation.rfq.status === 'DRAFT') rfqNotFound();
  return invitation;
}

export interface SupplierRfqListItem {
  id: string;
  reference: string;
  status: RfqStatusName;
  title: string;
  categoryName: string | null;
  quantity: string | null;
  unitOfMeasure: string | null;
  destinationCountry: string | null;
  responseDeadline: string | null;
  isPastDeadline: boolean;
  invitationStatus: string;
  currentRequirementVersion: number;
  invitedAt: string;
}

/** The requests this seller was asked to quote on. The default view is what needs an answer. */
export async function listSupplierRfqs(
  supplier: RfqSupplier,
  filter: (typeof SUPPLIER_RFQ_FILTERS)[number],
): Promise<{ items: SupplierRfqListItem[]; counts: Record<string, number> }> {
  const now = new Date();
  const base = { sellerAccountId: supplier.sellerAccountId, rfq: { status: { not: 'DRAFT' as const } } };
  const action = {
    ...base,
    status: { in: [...RESPONSIVE_INVITATION_STATUSES] },
    rfq: { status: 'OPEN' as const, responseDeadline: { gt: now } },
  };
  const where =
    filter === 'action'
      ? action
      : filter === 'quoted'
        ? { ...base, status: 'QUOTED' as const }
        : filter === 'closed'
          ? { ...base, NOT: { OR: [{ status: 'QUOTED' as const }, action] } }
          : base;
  const [rows, actionCount, quotedCount, allCount] = await Promise.all([
    prisma.rfqInvitation.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 200,
      include: { rfq: { include: { category: { select: { name: true } } } } },
    }),
    prisma.rfqInvitation.count({ where: action }),
    prisma.rfqInvitation.count({ where: { ...base, status: 'QUOTED' } }),
    prisma.rfqInvitation.count({ where: base }),
  ]);
  return {
    counts: { action: actionCount, quoted: quotedCount, closed: allCount - actionCount - quotedCount, all: allCount },
    items: rows.map((row) => {
      const requirement = requirementOf(row.rfq);
      return {
        id: row.rfq.id,
        reference: row.rfq.reference,
        status: row.rfq.status,
        title: row.rfq.title,
        categoryName: row.rfq.category?.name ?? null,
        quantity: requirement.quantity,
        unitOfMeasure: requirement.unitOfMeasure,
        destinationCountry: requirement.destinationCountry,
        responseDeadline: requirement.responseDeadline,
        isPastDeadline: row.rfq.responseDeadline !== null && row.rfq.responseDeadline.getTime() <= now.getTime(),
        invitationStatus: row.status,
        currentRequirementVersion: row.rfq.currentRequirementVersion,
        invitedAt: row.invitedAt.toISOString(),
      };
    }),
  };
}

export interface SupplierRfqView {
  id: string;
  reference: string;
  status: RfqStatusName;
  isPastDeadline: boolean;
  requirement: RfqRequirement;
  category: { id: string; name: string } | null;
  currentRequirementVersion: number;
  buyer: { kind: 'INDIVIDUAL' } | { kind: 'COMPANY'; companyName: string };
  invitation: {
    id: string;
    status: string;
    source: string;
    invitedAt: string;
    viewedAt: string | null;
    respondedAt: string | null;
    declineReason: string | null;
    notifiedVersion: number;
  };
  versions: { versionNumber: number; changedFields: string[]; changeSummary: string | null; createdAt: string }[];
  attachments: RfqAttachmentView[];
  attachmentPolicy: ReturnType<typeof rfqAttachmentPolicy>;
  timeline: { id: string; kind: string; actor: string; meta: Record<string, unknown> | null; at: string }[];
  actions: { canAsk: boolean; canDecline: boolean; canQuote: boolean };
}

/**
 * One request, as this seller sees it. Opening it the first time marks the
 * invitation VIEWED - the buyer's supplier list then says so.
 */
export async function getSupplierRfq(supplier: RfqSupplier, rfqId: string): Promise<SupplierRfqView> {
  let invitation = await loadInvitation(supplier, rfqId);
  await expireLapsedInvitations(invitation.rfq);
  invitation = await loadInvitation(supplier, rfqId);

  if (invitation.status === 'INVITED') {
    assertInvitationTransition({ from: 'INVITED', to: 'VIEWED', actor: 'SUPPLIER' });
    await prisma.$transaction(async (tx) => {
      const moved = await tx.rfqInvitation.updateMany({
        where: { id: invitation.id, status: 'INVITED' },
        data: { status: 'VIEWED', viewedAt: new Date() },
      });
      if (moved.count === 1) {
        await recordEvent(tx, {
          rfqId,
          kind: 'VIEWED',
          actorParty: 'SUPPLIER',
          actorUserId: supplier.userId,
          sellerAccountId: supplier.sellerAccountId,
        });
      }
    });
    invitation = await loadInvitation(supplier, rfqId);
  }

  const rfq = invitation.rfq;
  const [category, company, versions, attachments, events] = await Promise.all([
    rfq.categoryId === null
      ? Promise.resolve(null)
      : prisma.category.findUnique({ where: { id: rfq.categoryId }, select: { id: true, name: true } }),
    rfq.buyerCompanyId === null
      ? Promise.resolve(null)
      : prisma.buyerCompany.findUnique({
          where: { id: rfq.buyerCompanyId },
          select: { tradingName: true, legalName: true, applicationReference: true },
        }),
    prisma.rfqRequirementVersion.findMany({ where: { rfqId }, orderBy: { versionNumber: 'asc' } }),
    prisma.rfqAttachment.findMany({
      where: supplierAttachmentWhere(rfqId, supplier.sellerAccountId),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { ...ATTACHMENT_SELECT, quoteVersionId: true },
    }),
    prisma.rfqEvent.findMany({
      where: {
        rfqId,
        OR: [{ sharedWithSuppliers: true }, { sellerAccountId: supplier.sellerAccountId }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 500,
    }),
  ]);

  const open = rfq.status === 'OPEN';
  const beforeDeadline = rfq.responseDeadline !== null && rfq.responseDeadline.getTime() > Date.now();
  const responsive = RESPONSIVE_INVITATION_STATUSES.includes(invitation.status);

  return {
    id: rfq.id,
    reference: rfq.reference,
    status: rfq.status,
    isPastDeadline: !beforeDeadline,
    requirement: requirementOf(rfq),
    category,
    currentRequirementVersion: rfq.currentRequirementVersion,
    buyer:
      company === null
        ? { kind: 'INDIVIDUAL' }
        : { kind: 'COMPANY', companyName: company.tradingName ?? company.legalName ?? company.applicationReference },
    invitation: {
      id: invitation.id,
      status: invitation.status,
      source: invitation.source,
      invitedAt: invitation.invitedAt.toISOString(),
      viewedAt: invitation.viewedAt?.toISOString() ?? null,
      respondedAt: invitation.respondedAt?.toISOString() ?? null,
      declineReason: invitation.declineReason,
      notifiedVersion: invitation.notifiedVersion,
    },
    versions: versions.map((version) => ({
      versionNumber: version.versionNumber,
      changedFields: Array.isArray(version.changedFieldsJson)
        ? version.changedFieldsJson.filter((field): field is string => typeof field === 'string')
        : [],
      changeSummary: version.changeSummary,
      createdAt: version.createdAt.toISOString(),
    })),
    attachments: attachments.map(attachmentView),
    attachmentPolicy: rfqAttachmentPolicy(),
    timeline: events.map((event) => ({
      id: event.id,
      kind: event.kind,
      actor: event.actorParty,
      meta: (event.metaJson ?? null) as Record<string, unknown> | null,
      at: event.createdAt.toISOString(),
    })),
    actions: {
      canAsk: open && ['INVITED', 'VIEWED', 'QUOTED'].includes(invitation.status),
      canDecline: open && responsive,
      canQuote: open && responsive && beforeDeadline,
    },
  };
}

/** Say no, with a reason the buyer reads. Only while the invitation is still unanswered. */
export async function declineRfq(
  supplier: RfqSupplier,
  rfqId: string,
  input: z.infer<typeof declineSchema>,
): Promise<SupplierRfqView> {
  const invitation = await loadInvitation(supplier, rfqId);
  await expireLapsedInvitations(invitation.rfq);
  const current = await loadInvitation(supplier, rfqId);
  if (current.rfq.status !== 'OPEN') throw responseClosed(current.rfq.status);
  assertInvitationTransition({ from: current.status, to: 'DECLINED', actor: 'SUPPLIER' });

  await prisma.$transaction(async (tx) => {
    const moved = await tx.rfqInvitation.updateMany({
      where: { id: current.id, status: current.status },
      data: { status: 'DECLINED', respondedAt: new Date(), declineReason: input.reason },
    });
    if (moved.count !== 1) throw responseClosed('STALE');
    await recordEvent(tx, {
      rfqId,
      kind: 'DECLINED',
      actorParty: 'SUPPLIER',
      actorUserId: supplier.userId,
      sellerAccountId: supplier.sellerAccountId,
    });
    const buyer = await tx.customerProfile.findUnique({
      where: { id: current.rfq.customerProfileId },
      select: { fullName: true, user: { select: { email: true } } },
    });
    if (buyer !== null) {
      await enqueueNotification(
        {
          eventKey: NotificationEvent.RFQ_UPDATE_FOR_BUYER,
          recipientEmail: buyer.user.email,
          recipientName: buyer.fullName,
          variables: {
            rfqReference: current.rfq.reference,
            title: current.rfq.title,
            step: `${supplier.displayName} declined to quote`,
            rfqUrl: buyerRfqUrl(rfqId),
          },
          dedupeKey: `rfq:${rfqId}:declined:${supplier.sellerAccountId}`,
          relatedType: 'rfq_request',
          relatedId: rfqId,
        },
        tx,
      );
    }
    await recordAudit(
      {
        action: AuditAction.RFQ_INVITATION_DECLINED,
        resourceType: 'rfq_request',
        resourceId: rfqId,
        actorType: 'CUSTOMER',
        actorUserId: supplier.userId,
        before: { status: current.status },
        after: { status: 'DECLINED', sellerAccountId: supplier.sellerAccountId },
      },
      tx,
    );
  });
  await resolveSellerNotifications({
    resolutionKey: invitationResolutionKey(rfqId, supplier.sellerAccountId),
    note: 'Declined',
  });
  await dispatchPendingNotifications();
  return getSupplierRfq(supplier, rfqId);
}
