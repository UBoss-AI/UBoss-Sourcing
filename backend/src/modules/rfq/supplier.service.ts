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
import { ErrorCode, badRequest, conflict, type AppError } from '../../domain/errors.js';
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
import { recordSellerAudit } from '../seller/audit.service.js';
import { sellerQualifications, type SellerQualification } from './matching.service.js';
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

export const SUPPLIER_RFQ_FILTERS = ['action', 'quoted', 'closed', 'all', 'hidden'] as const;
export const supplierListQuerySchema = z.object({
  filter: z.enum(SUPPLIER_RFQ_FILTERS).default('action'),
  /** `me`, `unassigned` or a team member's id (JOURNEY-030). */
  assignee: z.union([z.enum(['me', 'unassigned']), z.string().length(26)]).optional(),
});
export const assignSchema = z.object({ memberId: z.string().length(26).nullable() }).strict();

/**
 * What the seller is told about who is asking (JOURNEY-030): a business the
 * marketplace verified, a business whose verification is not finished or has
 * lapsed, or a person buying for themselves.
 */
export type BuyerVerification = 'VERIFIED_BUSINESS' | 'BUSINESS_PENDING' | 'BUSINESS_NOT_VERIFIED' | 'INDIVIDUAL';

function buyerVerificationOf(company: { status: string } | null): BuyerVerification {
  if (company === null) return 'INDIVIDUAL';
  if (company.status === 'APPROVED') return 'VERIFIED_BUSINESS';
  if (['REJECTED', 'SUSPENDED', 'REVERIFICATION_REQUIRED'].includes(company.status)) return 'BUSINESS_NOT_VERIFIED';
  return 'BUSINESS_PENDING';
}

function decimalOrNull(value: { toString(): string } | null): number | null {
  if (value === null) return null;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : null;
}
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
  /** How well this seller fits the request, from the matching facts (JOURNEY-030). */
  qualification: SellerQualification;
  buyerVerification: BuyerVerification;
  hidden: boolean;
  assignedMember: { id: string; name: string } | null;
}

/** The requests this seller was asked to quote on. The default view is what needs an answer. */
export async function listSupplierRfqs(
  supplier: RfqSupplier,
  filter: (typeof SUPPLIER_RFQ_FILTERS)[number],
  /** `me`, `unassigned` or a team member's id. */
  assignee?: string,
): Promise<{ items: SupplierRfqListItem[]; counts: Record<string, number> }> {
  const now = new Date();
  const assigned =
    assignee === undefined
      ? {}
      : assignee === 'unassigned'
        ? { assignedMemberId: null }
        : { assignedMemberId: assignee === 'me' ? supplier.memberId : assignee };
  // Hidden invitations live in their own view; every other view leaves them out.
  const visible = { hiddenAt: null, ...assigned };
  const allBase = { sellerAccountId: supplier.sellerAccountId, rfq: { status: { not: 'DRAFT' as const } } };
  const base = { ...allBase, ...visible };
  const action = {
    ...base,
    status: { in: [...RESPONSIVE_INVITATION_STATUSES] },
    rfq: { status: 'OPEN' as const, responseDeadline: { gt: now } },
  };
  const hiddenWhere = { ...allBase, ...assigned, hiddenAt: { not: null } };
  const where =
    filter === 'action'
      ? action
      : filter === 'quoted'
        ? { ...base, status: 'QUOTED' as const }
        : filter === 'closed'
          ? { ...base, NOT: { OR: [{ status: 'QUOTED' as const }, action] } }
          : filter === 'hidden'
            ? hiddenWhere
            : base;
  const [rows, actionCount, quotedCount, allCount, hiddenCount] = await Promise.all([
    prisma.rfqInvitation.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 200,
      include: { rfq: { include: { category: { select: { name: true } } } } },
    }),
    prisma.rfqInvitation.count({ where: action }),
    prisma.rfqInvitation.count({ where: { ...base, status: 'QUOTED' } }),
    prisma.rfqInvitation.count({ where: base }),
    prisma.rfqInvitation.count({ where: hiddenWhere }),
  ]);

  const companyIds = [...new Set(rows.map((row) => row.rfq.buyerCompanyId).filter((id): id is string => id !== null))];
  const memberIds = [...new Set(rows.map((row) => row.assignedMemberId).filter((id): id is string => id !== null))];
  const [companies, members, qualifications] = await Promise.all([
    companyIds.length === 0
      ? Promise.resolve([])
      : prisma.buyerCompany.findMany({ where: { id: { in: companyIds } }, select: { id: true, status: true } }),
    memberIds.length === 0
      ? Promise.resolve([])
      : prisma.sellerMember.findMany({
          where: { id: { in: memberIds }, sellerAccountId: supplier.sellerAccountId },
          select: { id: true, customerProfile: { select: { fullName: true } } },
        }),
    sellerQualifications(
      supplier.sellerAccountId,
      rows.map((row) => ({
        id: row.rfq.id,
        categoryId: row.rfq.categoryId,
        destinationCountry: row.rfq.destinationCountry,
        customerProfileId: row.rfq.customerProfileId,
        quantity: decimalOrNull(row.rfq.quantity),
        deliveryTargetDate: row.rfq.deliveryTargetDate,
      })),
      now,
    ),
  ]);
  const companyStatus = new Map(companies.map((company) => [company.id, { status: String(company.status) }]));
  const memberName = new Map(members.map((member) => [member.id, member.customerProfile.fullName]));

  return {
    counts: {
      action: actionCount,
      quoted: quotedCount,
      closed: allCount - actionCount - quotedCount,
      all: allCount,
      hidden: hiddenCount,
    },
    items: rows.map((row) => {
      const requirement = requirementOf(row.rfq);
      return {
        qualification: qualifications.get(row.rfq.id) ?? { score: 0, reasons: [], flags: [] },
        buyerVerification: buyerVerificationOf(
          row.rfq.buyerCompanyId === null ? null : (companyStatus.get(row.rfq.buyerCompanyId) ?? { status: 'UNKNOWN' }),
        ),
        hidden: row.hiddenAt !== null,
        assignedMember:
          row.assignedMemberId === null
            ? null
            : { id: row.assignedMemberId, name: memberName.get(row.assignedMemberId) ?? '' },
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
  qualification: SellerQualification;
  buyerVerification: BuyerVerification;
  hidden: boolean;
  assignedMember: { id: string; name: string } | null;
}

/**
 * Hide an invitation from this seller's inbox, or bring it back (JOURNEY-030).
 * The seller's view only: the buyer's list is unchanged, and a hidden
 * invitation can still be opened and answered. Audited.
 */
export async function setRfqHidden(supplier: RfqSupplier, rfqId: string, hidden: boolean): Promise<SupplierRfqView> {
  const invitation = await loadInvitation(supplier, rfqId);
  await prisma.$transaction(async (tx) => {
    await tx.rfqInvitation.update({
      where: { id: invitation.id },
      data: hidden ? { hiddenAt: new Date(), hiddenByMemberId: supplier.memberId } : { hiddenAt: null, hiddenByMemberId: null },
    });
    await recordSellerAudit({
      tx,
      sellerAccountId: supplier.sellerAccountId,
      action: hidden ? 'seller.rfq.hidden' : 'seller.rfq.unhidden',
      actor: { type: 'CUSTOMER', userId: supplier.userId, label: supplier.displayName },
      resourceType: 'rfq_invitation',
      resourceId: invitation.id,
      summary: hidden
        ? `Request ${invitation.rfq.reference} was hidden from the inbox.`
        : `Request ${invitation.rfq.reference} was brought back to the inbox.`,
    });
  });
  return getSupplierRfq(supplier, rfqId);
}

/**
 * Give the answer to one member of the team, or to nobody (JOURNEY-030). The
 * member must be on this seller's team now. Audited.
 */
export async function assignRfq(
  supplier: RfqSupplier,
  rfqId: string,
  input: z.infer<typeof assignSchema>,
): Promise<SupplierRfqView> {
  const invitation = await loadInvitation(supplier, rfqId);
  let name = '';
  if (input.memberId !== null) {
    const member = await prisma.sellerMember.findFirst({
      where: { id: input.memberId, sellerAccountId: supplier.sellerAccountId, removedAt: null },
      select: { id: true, customerProfile: { select: { fullName: true } } },
    });
    if (member === null) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Choose somebody on your team.', [
        { field: 'memberId', code: 'NOT_A_MEMBER' },
      ]);
    }
    name = member.customerProfile.fullName;
  }
  await prisma.$transaction(async (tx) => {
    await tx.rfqInvitation.update({
      where: { id: invitation.id },
      data: { assignedMemberId: input.memberId, assignedAt: input.memberId === null ? null : new Date() },
    });
    await recordSellerAudit({
      tx,
      sellerAccountId: supplier.sellerAccountId,
      action: input.memberId === null ? 'seller.rfq.unassigned' : 'seller.rfq.assigned',
      actor: { type: 'CUSTOMER', userId: supplier.userId, label: supplier.displayName },
      resourceType: 'rfq_invitation',
      resourceId: invitation.id,
      before: { assignedMemberId: invitation.assignedMemberId },
      after: { assignedMemberId: input.memberId },
      summary:
        input.memberId === null
          ? `Request ${invitation.rfq.reference} no longer has an owner.`
          : `Request ${invitation.rfq.reference} was given to ${name}.`,
    });
  });
  return getSupplierRfq(supplier, rfqId);
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
          select: { tradingName: true, legalName: true, applicationReference: true, status: true },
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

  const [qualifications, assignee] = await Promise.all([
    sellerQualifications(supplier.sellerAccountId, [
      {
        id: rfq.id,
        categoryId: rfq.categoryId,
        destinationCountry: rfq.destinationCountry,
        customerProfileId: rfq.customerProfileId,
        quantity: decimalOrNull(rfq.quantity),
        deliveryTargetDate: rfq.deliveryTargetDate,
      },
    ]),
    invitation.assignedMemberId === null
      ? Promise.resolve(null)
      : prisma.sellerMember.findFirst({
          where: { id: invitation.assignedMemberId, sellerAccountId: supplier.sellerAccountId },
          select: { id: true, customerProfile: { select: { fullName: true } } },
        }),
  ]);

  return {
    qualification: qualifications.get(rfq.id) ?? { score: 0, reasons: [], flags: [] },
    buyerVerification: buyerVerificationOf(company === null ? null : { status: String(company.status) }),
    hidden: invitation.hiddenAt !== null,
    assignedMember:
      invitation.assignedMemberId === null
        ? null
        : { id: invitation.assignedMemberId, name: assignee?.customerProfile.fullName ?? '' },
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
