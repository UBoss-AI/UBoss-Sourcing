/**
 * Requests for quotation: the buyer's side (checklist Master row 16).
 *
 * A buyer writes a DRAFT - saved as often as they like, resumed later - and
 * SUBMITS it. Submission is where the server decides, not the form: every
 * required field is checked again here, the deadline must still be in the
 * future, the category must be sellable into the destination, and the request
 * is sent to the sellers that match (plus any the buyer picked by name, minus
 * any they excluded). Each seller's invitation is recorded, and each is told.
 *
 * A double click cannot send a request twice. The route needs an
 * Idempotency-Key, so a repeat of the same press replays the first answer; a
 * separate second press finds the request no longer a DRAFT, and the
 * conditional update that moves it refuses.
 */
import { z } from 'zod';
import { env } from '../../config/env.js';
import { isIsoCountryCode } from '../../domain/country-boundaries.js';
import {
  AppError,
  ErrorCode,
  badRequest,
  conflict,
  type ErrorDetail,
} from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import {
  INCOTERMS,
  INCOTERMS_NEEDING_DESTINATION,
  RFQ_INSPECTION_REQUIREMENTS,
  RFQ_LIMITS,
  RFQ_SAMPLE_REQUIREMENTS,
  RFQ_UNITS_OF_MEASURE,
  isQuantity,
  changedRequirementFields,
  normaliseQuantity,
  type RfqRequirement,
} from '../../domain/rfq.js';
import {
  assertInvitationTransition,
  assertRfqTransition,
  type RfqStatusName,
} from '../../domain/rfq-state.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  dispatchPendingNotifications,
  enqueueNotification,
  NotificationEvent,
} from '../notifications/notification.service.js';
import { notifySeller, resolveSellerNotifications } from '../seller/notification.service.js';
import { storage } from '../../infra/storage/index.js';
import { SellerPermission, sellerRoleHas } from '../../domain/seller-permissions.js';
import { buyerScopeWhere, companyOf, rfqNotFound, type RfqBuyer } from './access.js';
import {
  categoryBlockedFor,
  eligibleForInvitation,
  matchSuppliers,
  supplierCards,
  type MatchResult,
} from './matching.service.js';
import {
  ATTACHMENT_SELECT,
  attachmentView,
  rfqAttachmentPolicy,
  type RfqAttachmentView,
} from './attachment.service.js';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const id26 = z.string().length(26);
const quantityString = z
  .string()
  .trim()
  .refine(isQuantity, { message: 'Enter a positive number with at most three decimal places.' });
const minorString = z.string().regex(/^[1-9]\d{0,14}$/, 'Enter a positive amount in minor units.');
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((value) => (value === null || value.length === 0 ? null : value));

/**
 * A draft, as the form sends it. Everything may be missing - a draft is
 * somebody half-way through - but whatever IS sent must be well formed.
 */
export const rfqDraftSchema = z
  .object({
    categoryId: id26.nullable().default(null),
    title: z.string().trim().max(RFQ_LIMITS.titleMax).default(''),
    specification: optionalText(RFQ_LIMITS.specificationMax),
    specs: z
      .array(
        z
          .object({
            key: z.string().trim().min(1).max(RFQ_LIMITS.specKeyMax),
            value: z.string().trim().min(1).max(RFQ_LIMITS.specValueMax),
          })
          .strict(),
      )
      .max(RFQ_LIMITS.specsMax)
      .default([]),
    quantity: quantityString.nullable().default(null),
    unitOfMeasure: z.enum(RFQ_UNITS_OF_MEASURE).nullable().default(null),
    annualVolume: quantityString.nullable().default(null),
    targetUnitPriceMinor: minorString.nullable().default(null),
    targetCurrency: z.string().regex(/^[A-Z]{3}$/).nullable().default(null),
    destinationCountry: z.string().regex(/^[A-Z]{2}$/).nullable().default(null),
    destinationAddress: optionalText(RFQ_LIMITS.addressMax),
    destinationPort: optionalText(RFQ_LIMITS.portMax),
    incoterm: z
      .string()
      .refine((value) => INCOTERMS.includes(value), { message: 'Choose an Incoterms 2020 rule.' })
      .nullable()
      .default(null),
    certifications: z
      .array(z.string().trim().min(1).max(RFQ_LIMITS.certificationMax))
      .max(RFQ_LIMITS.certificationsMax)
      .default([]),
    sampleRequirement: z.enum(RFQ_SAMPLE_REQUIREMENTS).default('NONE'),
    inspectionRequirement: z.enum(RFQ_INSPECTION_REQUIREMENTS).default('NONE'),
    responseDeadline: z.string().datetime({ offset: true }).nullable().default(null),
    deliveryTargetDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .default(null),
    notes: optionalText(RFQ_LIMITS.notesMax),
    includeSellerIds: z.array(id26).max(RFQ_LIMITS.selectionMax).default([]),
    excludeSellerIds: z.array(id26).max(RFQ_LIMITS.selectionMax).default([]),
  })
  .strict();

export type RfqDraftInput = z.infer<typeof rfqDraftSchema>;

export const rfqSaveSchema = rfqDraftSchema.extend({ expectedVersion: z.number().int().min(0) }).strict();
export const rfqSubmitSchema = z.object({ expectedVersion: z.number().int().min(0) }).strict();
export const rfqReasonSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    reason: z.string().trim().max(1000).nullable().default(null),
  })
  .strict();
export const rfqListQuerySchema = z.object({
  status: z.enum(['DRAFT', 'OPEN', 'CLOSED', 'AWARDED', 'CANCELLED']).optional(),
});
export const rfqInviteSchema = z.object({ sellerAccountId: id26 }).strict();

// ---------------------------------------------------------------------------
// Validation the schema cannot do
// ---------------------------------------------------------------------------

function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Field-level checks every save makes, so a draft never holds nonsense: a
 * category that does not exist, a currency this marketplace does not use, a
 * country that is not one, half a target price, a date that is not a date,
 * or a deadline already gone.
 */
async function assertWellFormed(input: RfqDraftInput, now: Date): Promise<void> {
  const problems: ErrorDetail[] = [];

  if (input.categoryId !== null) {
    const category = await prisma.category.findFirst({
      where: { id: input.categoryId, isActive: true, archivedAt: null },
      select: { id: true },
    });
    if (category === null) problems.push({ field: 'categoryId', code: 'UNKNOWN' });
  }

  if ((input.targetUnitPriceMinor === null) !== (input.targetCurrency === null)) {
    problems.push({
      field: input.targetUnitPriceMinor === null ? 'targetUnitPriceMinor' : 'targetCurrency',
      code: 'PAIR_REQUIRED',
    });
  }
  if (input.targetCurrency !== null) {
    const currency = await prisma.currency.findFirst({
      where: { code: input.targetCurrency, isActive: true },
      select: { code: true },
    });
    if (currency === null) problems.push({ field: 'targetCurrency', code: 'UNKNOWN' });
  }

  if (input.destinationCountry !== null && !isIsoCountryCode(input.destinationCountry)) {
    problems.push({ field: 'destinationCountry', code: 'UNKNOWN' });
  }

  if (input.responseDeadline !== null && new Date(input.responseDeadline).getTime() <= now.getTime()) {
    problems.push({ field: 'responseDeadline', code: 'IN_PAST' });
  }
  if (input.deliveryTargetDate !== null) {
    if (!isCalendarDate(input.deliveryTargetDate)) {
      problems.push({ field: 'deliveryTargetDate', code: 'INVALID' });
    } else if (input.deliveryTargetDate < todayUtc(now)) {
      problems.push({ field: 'deliveryTargetDate', code: 'IN_PAST' });
    }
  }

  const overlap = input.includeSellerIds.filter((id) => input.excludeSellerIds.includes(id));
  if (overlap.length > 0) problems.push({ field: 'excludeSellerIds', code: 'CONFLICT' });

  if (problems.length > 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Some details of this request are not valid.', problems);
  }
}

/**
 * What submission needs on top: every required field present, a deadline in
 * range, a destination where the Incoterm needs one, and a delivery date no
 * earlier than the deadline. Every problem at once, so the form can mark them
 * all rather than one per press.
 */
export function submissionProblems(requirement: RfqRequirement, now: Date): ErrorDetail[] {
  const problems: ErrorDetail[] = [];
  const required: (keyof RfqRequirement)[] = [
    'categoryId',
    'title',
    'specification',
    'quantity',
    'unitOfMeasure',
    'destinationCountry',
    'incoterm',
    'responseDeadline',
  ];
  for (const field of required) {
    const value = requirement[field];
    if (value === null || (typeof value === 'string' && value.trim().length === 0)) {
      problems.push({ field, code: 'REQUIRED' });
    }
  }

  if (
    requirement.incoterm !== null &&
    INCOTERMS_NEEDING_DESTINATION.includes(requirement.incoterm) &&
    requirement.destinationAddress === null &&
    requirement.destinationPort === null
  ) {
    problems.push({ field: 'destinationPort', code: 'DESTINATION_NEEDED', meta: { incoterm: requirement.incoterm } });
  }

  if (requirement.responseDeadline !== null) {
    const deadline = new Date(requirement.responseDeadline).getTime();
    if (deadline <= now.getTime()) {
      problems.push({ field: 'responseDeadline', code: 'IN_PAST' });
    } else if (deadline > now.getTime() + env.RFQ_MAX_RESPONSE_DAYS * 86_400_000) {
      problems.push({
        field: 'responseDeadline',
        code: 'TOO_FAR',
        meta: { maxDays: env.RFQ_MAX_RESPONSE_DAYS },
      });
    }
    if (
      requirement.deliveryTargetDate !== null &&
      requirement.deliveryTargetDate < requirement.responseDeadline.slice(0, 10)
    ) {
      problems.push({ field: 'deliveryTargetDate', code: 'BEFORE_DEADLINE' });
    }
  }
  if (requirement.deliveryTargetDate !== null && requirement.deliveryTargetDate < todayUtc(now)) {
    problems.push({ field: 'deliveryTargetDate', code: 'IN_PAST' });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Row <-> requirement
// ---------------------------------------------------------------------------

type RfqRow = Prisma.RfqRequestGetPayload<Record<string, never>>;

function stringList(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function specList(value: Prisma.JsonValue | null): { key: string; value: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    typeof entry === 'object' &&
    entry !== null &&
    !Array.isArray(entry) &&
    typeof entry['key'] === 'string' &&
    typeof entry['value'] === 'string'
      ? [{ key: entry['key'], value: entry['value'] }]
      : [],
  );
}

function decimalText(value: Prisma.Decimal | null): string | null {
  return value === null ? null : normaliseQuantity(value.toFixed(3));
}

export function requirementOf(row: RfqRow): RfqRequirement {
  return {
    categoryId: row.categoryId,
    title: row.title,
    specification: row.specification,
    specs: specList(row.specsJson),
    quantity: decimalText(row.quantity),
    unitOfMeasure: row.unitOfMeasure,
    annualVolume: decimalText(row.annualVolume),
    targetUnitPriceMinor: row.targetUnitPriceMinor?.toString() ?? null,
    targetCurrency: row.targetCurrency,
    destinationCountry: row.destinationCountry,
    destinationAddress: row.destinationAddress,
    destinationPort: row.destinationPort,
    incoterm: row.incoterm,
    certifications: stringList(row.certificationsJson),
    sampleRequirement: row.sampleRequirement,
    inspectionRequirement: row.inspectionRequirement,
    responseDeadline: row.responseDeadline?.toISOString() ?? null,
    deliveryTargetDate: row.deliveryTargetDate?.toISOString().slice(0, 10) ?? null,
    notes: row.notes,
  };
}

/** The requirement in canonical form, from a draft's input. */
export function requirementFromInput(input: RfqDraftInput): RfqRequirement {
  return {
    categoryId: input.categoryId,
    title: input.title,
    specification: input.specification,
    specs: input.specs,
    quantity: input.quantity === null ? null : normaliseQuantity(input.quantity),
    unitOfMeasure: input.unitOfMeasure,
    annualVolume: input.annualVolume === null ? null : normaliseQuantity(input.annualVolume),
    targetUnitPriceMinor: input.targetUnitPriceMinor,
    targetCurrency: input.targetCurrency,
    destinationCountry: input.destinationCountry,
    destinationAddress: input.destinationAddress,
    destinationPort: input.destinationPort,
    incoterm: input.incoterm,
    certifications: input.certifications,
    sampleRequirement: input.sampleRequirement,
    inspectionRequirement: input.inspectionRequirement,
    responseDeadline:
      input.responseDeadline === null ? null : new Date(input.responseDeadline).toISOString(),
    deliveryTargetDate: input.deliveryTargetDate,
    notes: input.notes,
  };
}

/** The columns a requirement is written to. */
export function requirementColumns(requirement: RfqRequirement): Prisma.RfqRequestUncheckedUpdateInput {
  return {
    categoryId: requirement.categoryId,
    title: requirement.title,
    specification: requirement.specification,
    specsJson: requirement.specs as unknown as Prisma.InputJsonValue,
    quantity: requirement.quantity,
    unitOfMeasure: requirement.unitOfMeasure,
    annualVolume: requirement.annualVolume,
    targetUnitPriceMinor:
      requirement.targetUnitPriceMinor === null ? null : BigInt(requirement.targetUnitPriceMinor),
    targetCurrency: requirement.targetCurrency,
    destinationCountry: requirement.destinationCountry,
    destinationAddress: requirement.destinationAddress,
    destinationPort: requirement.destinationPort,
    incoterm: requirement.incoterm,
    certificationsJson: requirement.certifications,
    sampleRequirement: requirement.sampleRequirement,
    inspectionRequirement: requirement.inspectionRequirement,
    responseDeadline: requirement.responseDeadline === null ? null : new Date(requirement.responseDeadline),
    deliveryTargetDate:
      requirement.deliveryTargetDate === null ? null : new Date(`${requirement.deliveryTargetDate}T00:00:00.000Z`),
    notes: requirement.notes,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function nextReference(tx: PrismaTransaction): Promise<string> {
  const year = new Date().getUTCFullYear();
  const key = `rfq:${String(year)}`;
  await tx.numberSequence.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1, prefix: 'RFQ', padding: 6 },
  });
  const sequence = await tx.numberSequence.findUniqueOrThrow({ where: { key } });
  return `RFQ-${String(year)}-${sequence.value.toString().padStart(sequence.padding, '0')}`;
}

export function publicUrl(path: string): string {
  return `${env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/$/, '')}${path}`;
}

export function buyerRfqUrl(id: string): string {
  return publicUrl(`/account/rfqs/${id}`);
}

export function sellerRfqUrl(id: string): string {
  return publicUrl(`/seller/rfqs/${id}`);
}

export function stale(): AppError {
  return conflict(
    ErrorCode.RFQ_TRANSITION_NOT_ALLOWED,
    'This request changed while you were working on it. Reload it and try again.',
    [{ code: 'STALE' }],
  );
}

/**
 * Move a request's status, conditionally on the status and version read.
 * The ONLY writer of `rfq_requests.status`.
 */
export async function moveRfq(
  tx: PrismaTransaction,
  row: { id: string; status: RfqStatusName; version: number },
  to: RfqStatusName,
  actor: 'BUYER' | 'SUPPLIER' | 'SYSTEM',
  data: Prisma.RfqRequestUncheckedUpdateManyInput = {},
): Promise<void> {
  assertRfqTransition({ from: row.status, to, actor });
  const updated = await tx.rfqRequest.updateMany({
    where: { id: row.id, status: row.status, version: row.version },
    data: { ...data, status: to, version: { increment: 1 } },
  });
  if (updated.count !== 1) throw stale();
}

export async function recordEvent(
  tx: PrismaTransaction,
  event: {
    rfqId: string;
    kind: string;
    actorParty: 'BUYER' | 'SUPPLIER' | 'SYSTEM';
    actorUserId: string | null;
    sellerAccountId?: string | null;
    sharedWithSuppliers?: boolean;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.rfqEvent.create({
    data: {
      id: newId(),
      rfqId: event.rfqId,
      kind: event.kind,
      actorParty: event.actorParty,
      actorUserId: event.actorUserId,
      sellerAccountId: event.sellerAccountId ?? null,
      sharedWithSuppliers: event.sharedWithSuppliers ?? false,
      metaJson: (event.meta ?? undefined) as never,
    },
  });
}

/** Emails of the members of a seller who may answer requests for it. */
export async function sellerResponderEmails(sellerAccountId: string): Promise<string[]> {
  const members = await prisma.sellerMember.findMany({
    where: { sellerAccountId, removedAt: null },
    select: { role: true, customerProfile: { select: { user: { select: { email: true } } } } },
  });
  return [
    ...new Set(
      members
        .filter((member) => sellerRoleHas(member.role, SellerPermission.ORDER_FULFIL))
        .map((member) => member.customerProfile.user.email),
    ),
  ];
}

export function invitationResolutionKey(rfqId: string, sellerAccountId: string): string {
  return `rfq:${rfqId}:seller:${sellerAccountId}`;
}

function quantityLabel(requirement: RfqRequirement): string {
  return requirement.quantity === null
    ? 'not stated'
    : `${requirement.quantity} ${(requirement.unitOfMeasure ?? '').toLowerCase().replace(/_/g, ' ')}`.trim();
}

/** Tell one seller they have been asked to quote: the Hub alert and an email. */
async function inviteNotices(
  tx: PrismaTransaction,
  rfq: { id: string; reference: string },
  requirement: RfqRequirement,
  sellerAccountId: string,
): Promise<void> {
  await notifySeller({
    sellerAccountId,
    kind: 'RFQ_INVITATION',
    class: 'ALERT',
    resolutionKey: invitationResolutionKey(rfq.id, sellerAccountId),
    title: `Request for quotation ${rfq.reference}`,
    body: `A buyer asked you to quote on "${requirement.title}". Quotes are accepted until ${requirement.responseDeadline?.slice(0, 16).replace('T', ' ') ?? ''} UTC.`,
    linkPath: `/seller/rfqs/${rfq.id}`,
    subjectType: 'rfq_request',
    subjectId: rfq.id,
    dedupeKey: `rfq:${rfq.id}:invite:${sellerAccountId}`,
    tx,
  });
  for (const email of await sellerResponderEmails(sellerAccountId)) {
    await enqueueNotification(
      {
        eventKey: NotificationEvent.RFQ_INVITATION,
        recipientEmail: email,
        variables: {
          rfqReference: rfq.reference,
          title: requirement.title,
          quantity: quantityLabel(requirement),
          destination: requirement.destinationCountry ?? '',
          deadline: `${requirement.responseDeadline?.slice(0, 16).replace('T', ' ') ?? ''} UTC`,
          sellerUrl: sellerRfqUrl(rfq.id),
        },
        dedupeKey: `rfq:${rfq.id}:invite:${sellerAccountId}:${email}`,
        relatedType: 'rfq_request',
        relatedId: rfq.id,
      },
      tx,
    );
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function loadForBuyer(buyer: RfqBuyer, id: string): Promise<RfqRow> {
  const row = await prisma.rfqRequest.findFirst({ where: { AND: [{ id }, buyerScopeWhere(buyer)] } });
  if (row === null) rfqNotFound();
  return row;
}

export { loadForBuyer as loadRfqForBuyer };

export interface RfqListItem {
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
  invitedCount: number;
  respondedCount: number;
  updatedAt: string;
  submittedAt: string | null;
}

/** The buyer's requests, newest activity first, with a count per status. */
export async function listBuyerRfqs(
  buyer: RfqBuyer,
  query: z.infer<typeof rfqListQuerySchema>,
): Promise<{ items: RfqListItem[]; counts: Record<RfqStatusName, number> }> {
  const scope = buyerScopeWhere(buyer);
  const now = Date.now();
  const [rows, grouped] = await Promise.all([
    prisma.rfqRequest.findMany({
      where: { AND: [scope, ...(query.status === undefined ? [] : [{ status: query.status }])] },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 200,
      include: {
        category: { select: { name: true } },
        invitations: { select: { status: true } },
      },
    }),
    prisma.rfqRequest.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
  ]);
  const counts: Record<RfqStatusName, number> = { DRAFT: 0, OPEN: 0, CLOSED: 0, AWARDED: 0, CANCELLED: 0 };
  for (const group of grouped) counts[group.status] = group._count._all;

  return {
    counts,
    items: rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      status: row.status,
      title: row.title,
      categoryName: row.category?.name ?? null,
      quantity: decimalText(row.quantity),
      unitOfMeasure: row.unitOfMeasure,
      destinationCountry: row.destinationCountry,
      responseDeadline: row.responseDeadline?.toISOString() ?? null,
      isPastDeadline: row.responseDeadline !== null && row.responseDeadline.getTime() <= now,
      invitedCount: row.invitations.length,
      respondedCount: row.invitations.filter((invitation) =>
        ['QUOTED', 'DECLINED', 'WITHDRAWN'].includes(invitation.status),
      ).length,
      updatedAt: row.updatedAt.toISOString(),
      submittedAt: row.submittedAt?.toISOString() ?? null,
    })),
  };
}

export interface BuyerRfqView {
  id: string;
  reference: string;
  status: RfqStatusName;
  version: number;
  isPastDeadline: boolean;
  requirement: RfqRequirement;
  targetPrice: { minor: string; formatted: string; currency: string } | null;
  category: { id: string; name: string } | null;
  owner: { kind: 'INDIVIDUAL' } | { kind: 'COMPANY'; companyId: string; companyName: string };
  currentRequirementVersion: number;
  matchOutcome: string | null;
  matchedSupplierCount: number;
  selection: {
    include: Awaited<ReturnType<typeof supplierCards>>;
    exclude: Awaited<ReturnType<typeof supplierCards>>;
  };
  invitations: {
    id: string;
    source: 'MATCHED' | 'BUYER_SELECTED';
    status: string;
    invitedAt: string;
    viewedAt: string | null;
    respondedAt: string | null;
    declineReason: string | null;
    supplier: Awaited<ReturnType<typeof supplierCards>>[number];
  }[];
  attachments: RfqAttachmentView[];
  attachmentPolicy: ReturnType<typeof rfqAttachmentPolicy>;
  versions: {
    versionNumber: number;
    changedFields: string[];
    changeSummary: string | null;
    createdAt: string;
  }[];
  timeline: {
    id: string;
    kind: string;
    actor: 'BUYER' | 'SUPPLIER' | 'SYSTEM';
    supplierName: string | null;
    meta: Record<string, unknown> | null;
    at: string;
  }[];
  submittedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
  actions: {
    canEdit: boolean;
    canSubmit: boolean;
    canCancel: boolean;
    canClose: boolean;
    canInvite: boolean;
    canAmend: boolean;
  };
}

function money(minor: bigint | null, currency: string | null) {
  return minor === null || currency === null ? null : serialiseMoney(minor, currency);
}

/** One of the buyer's requests, in full. */
export async function getBuyerRfq(buyer: RfqBuyer, id: string): Promise<BuyerRfqView> {
  const row = await loadForBuyer(buyer, id);
  await expireLapsedInvitations(row);
  return buyerView(await loadForBuyer(buyer, id));
}

export async function buyerView(row: RfqRow): Promise<BuyerRfqView> {
  const now = Date.now();
  const [category, company, invitations, attachments, versions, events] = await Promise.all([
    row.categoryId === null
      ? Promise.resolve(null)
      : prisma.category.findUnique({ where: { id: row.categoryId }, select: { id: true, name: true } }),
    row.buyerCompanyId === null
      ? Promise.resolve(null)
      : prisma.buyerCompany.findUnique({
          where: { id: row.buyerCompanyId },
          select: { id: true, tradingName: true, legalName: true, applicationReference: true },
        }),
    prisma.rfqInvitation.findMany({
      where: { rfqId: row.id },
      orderBy: [{ invitedAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.rfqAttachment.findMany({
      where: { rfqId: row.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { ...ATTACHMENT_SELECT, quoteVersionId: true },
    }),
    prisma.rfqRequirementVersion.findMany({
      where: { rfqId: row.id },
      orderBy: { versionNumber: 'asc' },
      select: { versionNumber: true, changedFieldsJson: true, changeSummary: true, createdAt: true },
    }),
    prisma.rfqEvent.findMany({
      where: { rfqId: row.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 500,
    }),
  ]);

  const include = stringList(row.includeSellerIdsJson);
  const exclude = stringList(row.excludeSellerIdsJson);
  const sellerIds = [
    ...new Set([...include, ...exclude, ...invitations.map((invitation) => invitation.sellerAccountId)]),
  ];
  const matchedIds = new Set(
    invitations.filter((invitation) => invitation.source === 'MATCHED').map((invitation) => invitation.sellerAccountId),
  );
  const cards = new Map(
    (await supplierCards(sellerIds, matchedIds)).map((supplier) => [supplier.sellerAccountId, supplier]),
  );
  const nameOf = (sellerId: string | null): string | null =>
    sellerId === null ? null : (cards.get(sellerId)?.displayName ?? null);

  const status = row.status;
  const open = status === 'OPEN';
  const pastDeadline = row.responseDeadline !== null && row.responseDeadline.getTime() <= now;

  return {
    id: row.id,
    reference: row.reference,
    status,
    version: row.version,
    isPastDeadline: pastDeadline,
    requirement: requirementOf(row),
    targetPrice: money(row.targetUnitPriceMinor, row.targetCurrency),
    category,
    owner:
      company === null
        ? { kind: 'INDIVIDUAL' }
        : {
            kind: 'COMPANY',
            companyId: company.id,
            companyName: company.tradingName ?? company.legalName ?? company.applicationReference,
          },
    currentRequirementVersion: row.currentRequirementVersion,
    matchOutcome: row.matchOutcome,
    matchedSupplierCount: row.matchedSupplierCount,
    selection: {
      include: include.flatMap((sellerId) => {
        const supplier = cards.get(sellerId);
        return supplier === undefined ? [] : [supplier];
      }),
      exclude: exclude.flatMap((sellerId) => {
        const supplier = cards.get(sellerId);
        return supplier === undefined ? [] : [supplier];
      }),
    },
    invitations: invitations.flatMap((invitation) => {
      const supplier = cards.get(invitation.sellerAccountId);
      if (supplier === undefined) return [];
      return [
        {
          id: invitation.id,
          source: invitation.source,
          status: invitation.status,
          invitedAt: invitation.invitedAt.toISOString(),
          viewedAt: invitation.viewedAt?.toISOString() ?? null,
          respondedAt: invitation.respondedAt?.toISOString() ?? null,
          declineReason: invitation.declineReason,
          supplier,
        },
      ];
    }),
    attachments: attachments.map(attachmentView),
    attachmentPolicy: rfqAttachmentPolicy(),
    versions: versions.map((version) => ({
      versionNumber: version.versionNumber,
      changedFields: stringList(version.changedFieldsJson),
      changeSummary: version.changeSummary,
      createdAt: version.createdAt.toISOString(),
    })),
    timeline: events.map((event) => ({
      id: event.id,
      kind: event.kind,
      actor: event.actorParty,
      supplierName: nameOf(event.sellerAccountId),
      meta: (event.metaJson ?? null) as Record<string, unknown> | null,
      at: event.createdAt.toISOString(),
    })),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    statusReason: row.statusReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    actions: {
      canEdit: status === 'DRAFT',
      canSubmit: status === 'DRAFT',
      canCancel: status === 'DRAFT' || open,
      canClose: open,
      canInvite: open && !pastDeadline,
      canAmend: open,
    },
  };
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

function selectionColumns(input: RfqDraftInput): Prisma.RfqRequestUncheckedUpdateInput {
  return {
    includeSellerIdsJson: [...new Set(input.includeSellerIds)],
    excludeSellerIdsJson: [...new Set(input.excludeSellerIds)],
  };
}

/** Start a draft. Everything may be missing; whatever is sent must be valid. */
export async function createDraft(buyer: RfqBuyer, input: RfqDraftInput): Promise<BuyerRfqView> {
  await assertWellFormed(input, new Date());
  const requirement = requirementFromInput(input);
  const id = newId();

  await prisma.$transaction(async (tx) => {
    const reference = await nextReference(tx);
    await tx.rfqRequest.create({
      data: {
        id,
        reference,
        customerProfileId: buyer.customerProfileId,
        buyerCompanyId: companyOf(buyer),
        createdByUserId: buyer.userId,
        ...(requirementColumns(requirement) as Partial<Prisma.RfqRequestUncheckedCreateInput>),
        ...(selectionColumns(input) as Partial<Prisma.RfqRequestUncheckedCreateInput>),
      },
    });
    await recordEvent(tx, { rfqId: id, kind: 'CREATED', actorParty: 'BUYER', actorUserId: buyer.userId });
    await recordAudit(
      {
        action: AuditAction.RFQ_CREATED,
        resourceType: 'rfq_request',
        resourceId: id,
        actorType: 'CUSTOMER',
        actorUserId: buyer.userId,
        actorEmail: buyer.email,
        after: { reference, buyerCompanyId: companyOf(buyer), categoryId: requirement.categoryId },
      },
      tx,
    );
  });

  return getBuyerRfq(buyer, id);
}

function assertDraft(row: RfqRow): void {
  if (row.status !== 'DRAFT') {
    throw conflict(
      ErrorCode.RFQ_NOT_EDITABLE,
      'This request has been sent. Change it by publishing a new version of the requirement.',
      [{ code: row.status }],
    );
  }
}

/** Save the whole draft again. Conditional on the version the form was opened at. */
export async function saveDraft(
  buyer: RfqBuyer,
  id: string,
  input: z.infer<typeof rfqSaveSchema>,
): Promise<BuyerRfqView> {
  const row = await loadForBuyer(buyer, id);
  assertDraft(row);
  if (row.version !== input.expectedVersion) throw stale();
  await assertWellFormed(input, new Date());
  const requirement = requirementFromInput(input);

  await prisma.$transaction(async (tx) => {
    const updated = await tx.rfqRequest.updateMany({
      where: { id: row.id, status: 'DRAFT', version: row.version },
      data: {
        ...(requirementColumns(requirement) as Prisma.RfqRequestUncheckedUpdateManyInput),
        ...(selectionColumns(input) as Prisma.RfqRequestUncheckedUpdateManyInput),
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw stale();
    await recordAudit(
      {
        action: AuditAction.RFQ_DRAFT_UPDATED,
        resourceType: 'rfq_request',
        resourceId: row.id,
        actorType: 'CUSTOMER',
        actorUserId: buyer.userId,
        actorEmail: buyer.email,
        after: { version: row.version + 1 },
      },
      tx,
    );
  });
  return getBuyerRfq(buyer, id);
}

/** Throw a draft away, with its files. Only a draft: anything sent is kept. */
export async function deleteDraft(buyer: RfqBuyer, id: string): Promise<void> {
  const row = await loadForBuyer(buyer, id);
  assertDraft(row);
  const files = await prisma.rfqAttachment.findMany({ where: { rfqId: row.id }, select: { storageKey: true } });
  await prisma.$transaction(async (tx) => {
    const removed = await tx.rfqRequest.deleteMany({ where: { id: row.id, status: 'DRAFT' } });
    if (removed.count !== 1) throw stale();
    await recordAudit(
      {
        action: AuditAction.RFQ_DRAFT_DELETED,
        resourceType: 'rfq_request',
        resourceId: row.id,
        actorType: 'CUSTOMER',
        actorUserId: buyer.userId,
        actorEmail: buyer.email,
        before: { reference: row.reference },
      },
      tx,
    );
  });
  for (const file of files) await storage.delete(file.storageKey).catch(() => undefined);
}

/** Who a draft would be sent to right now, for the review step. */
export async function previewMatches(buyer: RfqBuyer, id: string): Promise<MatchResult> {
  const row = await loadForBuyer(buyer, id);
  return matchSuppliers({
    categoryId: row.categoryId,
    destinationCountry: row.destinationCountry,
    customerProfileId: buyer.customerProfileId,
  });
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/**
 * Send a draft to sellers.
 *
 * In one transaction: the request moves DRAFT -> OPEN (conditional on the
 * version the buyer saw), version 1 of the requirement is written, the
 * draft's files are frozen into it, every invitation is written, and every
 * invited seller is told. If nothing matched and nobody was picked by hand,
 * submission still succeeds - the request says NO_MATCH and the buyer can
 * invite sellers by name from its page.
 */
export async function submitRfq(
  buyer: RfqBuyer,
  id: string,
  input: z.infer<typeof rfqSubmitSchema>,
): Promise<BuyerRfqView> {
  const row = await loadForBuyer(buyer, id);
  if (row.status !== 'DRAFT') {
    throw conflict(ErrorCode.RFQ_TRANSITION_NOT_ALLOWED, 'This request has already been sent.', [
      { code: 'ALREADY_SUBMITTED', meta: { status: row.status } },
    ]);
  }
  if (row.version !== input.expectedVersion) throw stale();

  const now = new Date();
  const requirement = requirementOf(row);
  const problems = submissionProblems(requirement, now);
  if (problems.length > 0) {
    throw new AppError({
      statusCode: 400,
      code: ErrorCode.RFQ_INCOMPLETE,
      message: 'This request is missing details a seller needs before it can be sent.',
      details: problems,
    });
  }

  const match = await matchSuppliers({
    categoryId: requirement.categoryId,
    destinationCountry: requirement.destinationCountry,
    customerProfileId: buyer.customerProfileId,
  });
  if (match.outcome === 'BLOCKED') {
    throw conflict(
      ErrorCode.RFQ_DESTINATION_BLOCKED,
      match.blockedReason ?? 'This category cannot be sold into that destination.',
      [{ field: 'destinationCountry', code: 'BLOCKED', meta: { reason: match.blockedReason } }],
    );
  }

  const include = stringList(row.includeSellerIdsJson);
  const exclude = new Set(stringList(row.excludeSellerIdsJson));
  const picked = await eligibleForInvitation(include, buyer.customerProfileId);
  if (picked.refused.length > 0) {
    throw conflict(
      ErrorCode.RFQ_SUPPLIER_NOT_ELIGIBLE,
      'A seller you picked cannot be asked to quote. Remove them and send again.',
      picked.refused.map((sellerAccountId) => ({
        field: 'includeSellerIds',
        code: 'NOT_ELIGIBLE',
        meta: { sellerAccountId },
      })),
    );
  }

  const matchedIds = match.suppliers.map((supplier) => supplier.sellerAccountId).filter((sellerId) => !exclude.has(sellerId));
  const handPicked = picked.eligible.filter((sellerId) => !matchedIds.includes(sellerId) && !exclude.has(sellerId));
  const invited = [...matchedIds, ...handPicked];
  if (invited.length > env.RFQ_MAX_INVITED_SUPPLIERS) {
    throw conflict(
      ErrorCode.RFQ_INVITATION_LIMIT_REACHED,
      `A request can be sent to at most ${String(env.RFQ_MAX_INVITED_SUPPLIERS)} sellers.`,
      [{ code: 'LIMIT', meta: { limit: env.RFQ_MAX_INVITED_SUPPLIERS } }],
    );
  }
  const outcome = match.suppliers.length > 0 ? 'MATCHED' : 'NO_MATCH';

  await prisma.$transaction(async (tx) => {
    await moveRfq(tx, row, 'OPEN', 'BUYER', {
      submittedAt: now,
      currentRequirementVersion: 1,
      matchedSupplierCount: match.suppliers.length,
      matchOutcome: outcome,
    });
    await tx.rfqRequirementVersion.create({
      data: {
        id: newId(),
        rfqId: row.id,
        versionNumber: 1,
        snapshotJson: requirement as unknown as Prisma.InputJsonValue,
        changedFieldsJson: [],
        createdByUserId: buyer.userId,
      },
    });
    await tx.rfqAttachment.updateMany({
      where: { rfqId: row.id, purpose: 'REQUIREMENT', requirementVersion: null },
      data: { requirementVersion: 1 },
    });
    if (invited.length > 0) {
      await tx.rfqInvitation.createMany({
        data: invited.map((sellerAccountId) => ({
          id: newId(),
          rfqId: row.id,
          sellerAccountId,
          source: matchedIds.includes(sellerAccountId) ? ('MATCHED' as const) : ('BUYER_SELECTED' as const),
          invitedAt: now,
          notifiedVersion: 1,
        })),
      });
    }

    await recordEvent(tx, {
      rfqId: row.id,
      kind: 'SUBMITTED',
      actorParty: 'BUYER',
      actorUserId: buyer.userId,
      sharedWithSuppliers: true,
      meta: { requirementVersion: 1 },
    });
    await recordEvent(tx, {
      rfqId: row.id,
      kind: outcome === 'MATCHED' ? 'SUPPLIERS_MATCHED' : 'NO_SUPPLIERS_MATCHED',
      actorParty: 'SYSTEM',
      actorUserId: null,
      meta: { matched: matchedIds.length, excluded: match.suppliers.length - matchedIds.length, handPicked: handPicked.length },
    });
    for (const sellerAccountId of invited) {
      await recordEvent(tx, {
        rfqId: row.id,
        kind: 'SUPPLIER_INVITED',
        actorParty: matchedIds.includes(sellerAccountId) ? 'SYSTEM' : 'BUYER',
        actorUserId: matchedIds.includes(sellerAccountId) ? null : buyer.userId,
        sellerAccountId,
      });
      await inviteNotices(tx, row, requirement, sellerAccountId);
    }

    await recordAudit(
      {
        action: AuditAction.RFQ_SUBMITTED,
        resourceType: 'rfq_request',
        resourceId: row.id,
        actorType: 'CUSTOMER',
        actorUserId: buyer.userId,
        actorEmail: buyer.email,
        before: { status: 'DRAFT' },
        after: {
          status: 'OPEN',
          requirementVersion: 1,
          matchOutcome: outcome,
          invited,
          matched: matchedIds,
          handPicked,
          excluded: [...exclude],
        },
      },
      tx,
    );
  });

  await dispatchPendingNotifications();
  return getBuyerRfq(buyer, id);
}

/**
 * Ask one more seller, by name, on a request already sent - the way out when
 * nothing matched. Refused past the deadline: a seller cannot quote then.
 */
export async function inviteSupplier(
  buyer: RfqBuyer,
  id: string,
  input: z.infer<typeof rfqInviteSchema>,
): Promise<BuyerRfqView> {
  const row = await loadForBuyer(buyer, id);
  if (row.status !== 'OPEN') {
    throw conflict(ErrorCode.RFQ_TRANSITION_NOT_ALLOWED, 'Sellers can only be added to an open request.', [
      { code: row.status },
    ]);
  }
  if (row.responseDeadline !== null && row.responseDeadline.getTime() <= Date.now()) {
    throw conflict(
      ErrorCode.RFQ_RESPONSE_CLOSED,
      'The deadline for quotes has passed. Move it later to ask more sellers.',
      [{ code: 'DEADLINE_PASSED' }],
    );
  }
  const { eligible } = await eligibleForInvitation([input.sellerAccountId], buyer.customerProfileId);
  if (eligible.length === 0) {
    throw conflict(ErrorCode.RFQ_SUPPLIER_NOT_ELIGIBLE, 'That seller cannot be asked to quote.', [
      { field: 'sellerAccountId', code: 'NOT_ELIGIBLE' },
    ]);
  }
  const existing = await prisma.rfqInvitation.count({ where: { rfqId: row.id } });
  if (existing >= env.RFQ_MAX_INVITED_SUPPLIERS) {
    throw conflict(
      ErrorCode.RFQ_INVITATION_LIMIT_REACHED,
      `A request can be sent to at most ${String(env.RFQ_MAX_INVITED_SUPPLIERS)} sellers.`,
      [{ code: 'LIMIT', meta: { limit: env.RFQ_MAX_INVITED_SUPPLIERS } }],
    );
  }
  const requirement = requirementOf(row);

  await prisma.$transaction(async (tx) => {
    // One place per seller per request. A second invitation of the same
    // seller is a no-op for the index to refuse, not a second row.
    const created = await tx.rfqInvitation.createMany({
      data: [
        {
          id: newId(),
          rfqId: row.id,
          sellerAccountId: input.sellerAccountId,
          source: 'BUYER_SELECTED',
          notifiedVersion: row.currentRequirementVersion,
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 0) return;
    await recordEvent(tx, {
      rfqId: row.id,
      kind: 'SUPPLIER_INVITED',
      actorParty: 'BUYER',
      actorUserId: buyer.userId,
      sellerAccountId: input.sellerAccountId,
    });
    await inviteNotices(tx, row, requirement, input.sellerAccountId);
    await recordAudit(
      {
        action: AuditAction.RFQ_SUPPLIER_INVITED,
        resourceType: 'rfq_request',
        resourceId: row.id,
        actorType: 'CUSTOMER',
        actorUserId: buyer.userId,
        actorEmail: buyer.email,
        after: { sellerAccountId: input.sellerAccountId, source: 'BUYER_SELECTED' },
      },
      tx,
    );
  });
  await dispatchPendingNotifications();
  return getBuyerRfq(buyer, id);
}

/**
 * Cancel (a draft or an open request) or close (an open request, without
 * choosing anybody). Every invited seller still taking part is told.
 */
export async function endRfq(
  buyer: RfqBuyer,
  id: string,
  to: 'CANCELLED' | 'CLOSED',
  input: z.infer<typeof rfqReasonSchema>,
): Promise<BuyerRfqView> {
  const row = await loadForBuyer(buyer, id);
  if (row.version !== input.expectedVersion) throw stale();
  assertRfqTransition({ from: row.status, to, actor: 'BUYER' });
  const now = new Date();
  const live = await prisma.rfqInvitation.findMany({
    where: { rfqId: row.id, status: { in: ['INVITED', 'VIEWED', 'QUOTED'] } },
    select: { sellerAccountId: true },
  });

  await prisma.$transaction(async (tx) => {
    await moveRfq(tx, row, to, 'BUYER', {
      ...(to === 'CANCELLED' ? { cancelledAt: now } : { closedAt: now }),
      statusReason: input.reason,
    });
    await recordEvent(tx, {
      rfqId: row.id,
      kind: to,
      actorParty: 'BUYER',
      actorUserId: buyer.userId,
      sharedWithSuppliers: true,
      meta: input.reason === null ? undefined : { reason: input.reason },
    });
    for (const { sellerAccountId } of live) {
      await notifySeller({
        sellerAccountId,
        kind: 'RFQ_UPDATE',
        title: `Request ${row.reference} ${to === 'CANCELLED' ? 'cancelled' : 'closed'}`,
        body: `The buyer ${to === 'CANCELLED' ? 'cancelled' : 'closed'} "${row.title}". No quote on it can be accepted now.`,
        linkPath: `/seller/rfqs/${row.id}`,
        subjectType: 'rfq_request',
        subjectId: row.id,
        tx,
      });
    }
    await recordAudit(
      {
        action: to === 'CANCELLED' ? AuditAction.RFQ_CANCELLED : AuditAction.RFQ_CLOSED,
        resourceType: 'rfq_request',
        resourceId: row.id,
        actorType: 'CUSTOMER',
        actorUserId: buyer.userId,
        actorEmail: buyer.email,
        before: { status: row.status },
        after: { status: to, reason: input.reason },
      },
      tx,
    );
  });
  // Nothing is waiting on the sellers any more.
  for (const { sellerAccountId } of live) {
    await resolveSellerNotifications({
      resolutionKey: invitationResolutionKey(row.id, sellerAccountId),
      note: to === 'CANCELLED' ? 'Request cancelled' : 'Request closed',
    });
  }
  return getBuyerRfq(buyer, id);
}

/** The person's own requests, not raised for any company. For erasure. */
export async function individualRfqIds(customerProfileId: string): Promise<string[]> {
  const rows = await prisma.rfqRequest.findMany({
    where: { customerProfileId, buyerCompanyId: null },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// The deadline, and changing a request already sent (Master row 17)
// ---------------------------------------------------------------------------

/**
 * Invitations still unanswered when the deadline passes become EXPIRED.
 *
 * Materialised when the request is next read, by either side - there is no
 * timer that has to be running for it to be true. The deadline is an instant
 * in UTC and compared as one.
 */
export async function expireLapsedInvitations(row: {
  id: string;
  status: RfqStatusName;
  responseDeadline: Date | null;
}): Promise<void> {
  if (row.status !== 'OPEN' || row.responseDeadline === null || row.responseDeadline.getTime() > Date.now()) return;
  const lapsed = await prisma.rfqInvitation.findMany({
    where: { rfqId: row.id, status: { in: ['INVITED', 'VIEWED'] } },
    select: { id: true, status: true, sellerAccountId: true },
  });
  if (lapsed.length === 0) return;
  for (const invitation of lapsed) {
    assertInvitationTransition({ from: invitation.status, to: 'EXPIRED', actor: 'SYSTEM' });
  }
  const expired: string[] = [];
  await prisma.$transaction(async (tx) => {
    for (const invitation of lapsed) {
      const moved = await tx.rfqInvitation.updateMany({
        where: { id: invitation.id, status: invitation.status },
        data: { status: 'EXPIRED' },
      });
      if (moved.count !== 1) continue;
      expired.push(invitation.sellerAccountId);
      await recordEvent(tx, {
        rfqId: row.id,
        kind: 'INVITATION_EXPIRED',
        actorParty: 'SYSTEM',
        actorUserId: null,
        sellerAccountId: invitation.sellerAccountId,
      });
    }
  });
  for (const sellerAccountId of expired) {
    await resolveSellerNotifications({
      resolutionKey: invitationResolutionKey(row.id, sellerAccountId),
      note: 'Deadline passed',
    });
  }
}

export const rfqAmendSchema = rfqDraftSchema
  .omit({ includeSellerIds: true, excludeSellerIds: true })
  .extend({
    expectedVersion: z.number().int().min(0),
    changeSummary: z.string().trim().min(3).max(1000),
  })
  .strict();

/**
 * Publish a new version of a sent requirement.
 *
 * Never an overwrite: the old version stays readable, the new one names the
 * fields that changed and the buyer's own words about why, and every seller
 * still taking part is told. Files added since the last version become part
 * of this one. Moving the deadline later gives sellers whose time ran out
 * their invitation back. The category cannot change - the sellers were
 * chosen for it; a different category is a new request.
 */
export async function amendRfq(
  buyer: RfqBuyer,
  id: string,
  input: z.infer<typeof rfqAmendSchema>,
): Promise<BuyerRfqView> {
  const row = await loadForBuyer(buyer, id);
  if (row.status !== 'OPEN') {
    throw conflict(ErrorCode.RFQ_TRANSITION_NOT_ALLOWED, 'Only an open request can be changed.', [{ code: row.status }]);
  }
  if (row.version !== input.expectedVersion) throw stale();
  const now = new Date();
  await assertWellFormed({ ...input, includeSellerIds: [], excludeSellerIds: [] }, now);

  const before = requirementOf(row);
  const after = requirementFromInput({ ...input, includeSellerIds: [], excludeSellerIds: [] });
  if (after.categoryId !== before.categoryId) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The category of a sent request cannot change.', [
      { field: 'categoryId', code: 'CATEGORY_LOCKED' },
    ]);
  }
  const pendingFiles = await prisma.rfqAttachment.count({
    where: { rfqId: row.id, purpose: 'REQUIREMENT', requirementVersion: null },
  });
  const changed: string[] = [...changedRequirementFields(before, after), ...(pendingFiles > 0 ? ['attachments'] : [])];
  if (changed.length === 0) {
    throw conflict(ErrorCode.RFQ_NO_CHANGE, 'Nothing in the requirement is different from the current version.');
  }
  const problems = submissionProblems(after, now);
  if (problems.length > 0) {
    throw new AppError({
      statusCode: 400,
      code: ErrorCode.RFQ_INCOMPLETE,
      message: 'This version is missing details a seller needs.',
      details: problems,
    });
  }
  if (after.destinationCountry !== null && after.destinationCountry !== before.destinationCountry && after.categoryId !== null) {
    const blocked = await categoryBlockedFor(after.categoryId, after.destinationCountry);
    if (blocked !== null) {
      throw conflict(ErrorCode.RFQ_DESTINATION_BLOCKED, blocked, [{ field: 'destinationCountry', code: 'BLOCKED' }]);
    }
  }

  const versionNumber = row.currentRequirementVersion + 1;
  const reopen =
    after.responseDeadline !== null && new Date(after.responseDeadline).getTime() > now.getTime();
  const invitations = await prisma.rfqInvitation.findMany({
    where: { rfqId: row.id, status: { in: ['INVITED', 'VIEWED', 'QUOTED', 'EXPIRED'] } },
    select: { id: true, status: true, sellerAccountId: true },
  });

  await prisma.$transaction(async (tx) => {
    const updated = await tx.rfqRequest.updateMany({
      where: { id: row.id, status: 'OPEN', version: row.version },
      data: {
        ...(requirementColumns(after) as Prisma.RfqRequestUncheckedUpdateManyInput),
        currentRequirementVersion: versionNumber,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw stale();
    await tx.rfqRequirementVersion.create({
      data: {
        id: newId(),
        rfqId: row.id,
        versionNumber,
        snapshotJson: after as unknown as Prisma.InputJsonValue,
        changedFieldsJson: changed,
        changeSummary: input.changeSummary,
        createdByUserId: buyer.userId,
      },
    });
    await tx.rfqAttachment.updateMany({
      where: { rfqId: row.id, purpose: 'REQUIREMENT', requirementVersion: null },
      data: { requirementVersion: versionNumber },
    });
    for (const invitation of invitations) {
      if (invitation.status === 'EXPIRED' && reopen) {
        assertInvitationTransition({ from: 'EXPIRED', to: 'INVITED', actor: 'SYSTEM' });
        await tx.rfqInvitation.updateMany({
          where: { id: invitation.id, status: 'EXPIRED' },
          data: { status: 'INVITED', notifiedVersion: versionNumber },
        });
      } else if (invitation.status !== 'EXPIRED') {
        await tx.rfqInvitation.update({ where: { id: invitation.id }, data: { notifiedVersion: versionNumber } });
      } else {
        continue;
      }
      await notifySeller({
        sellerAccountId: invitation.sellerAccountId,
        kind: 'RFQ_UPDATE',
        title: `Request ${row.reference} changed: version ${String(versionNumber)}`,
        body: `The buyer published version ${String(versionNumber)} of "${after.title}". Read what changed before you quote.`,
        linkPath: `/seller/rfqs/${row.id}`,
        subjectType: 'rfq_request',
        subjectId: row.id,
        dedupeKey: `rfq:${row.id}:v${String(versionNumber)}:${invitation.sellerAccountId}`,
        tx,
      });
      for (const email of await sellerResponderEmails(invitation.sellerAccountId)) {
        await enqueueNotification(
          {
            eventKey: NotificationEvent.RFQ_UPDATE_FOR_SELLER,
            recipientEmail: email,
            variables: {
              rfqReference: row.reference,
              title: after.title,
              step: `version ${String(versionNumber)} of the requirement was published`,
              sellerUrl: sellerRfqUrl(row.id),
            },
            dedupeKey: `rfq:${row.id}:v${String(versionNumber)}:${invitation.sellerAccountId}:${email}`,
            relatedType: 'rfq_request',
            relatedId: row.id,
          },
          tx,
        );
      }
    }
    await recordEvent(tx, {
      rfqId: row.id,
      kind: 'AMENDED',
      actorParty: 'BUYER',
      actorUserId: buyer.userId,
      sharedWithSuppliers: true,
      meta: { versionNumber, changedFields: changed },
    });
    await recordAudit(
      {
        action: AuditAction.RFQ_AMENDED,
        resourceType: 'rfq_request',
        resourceId: row.id,
        actorType: 'CUSTOMER',
        actorUserId: buyer.userId,
        actorEmail: buyer.email,
        before: { requirementVersion: row.currentRequirementVersion },
        after: { requirementVersion: versionNumber, changedFields: changed },
      },
      tx,
    );
  });
  await dispatchPendingNotifications();
  return getBuyerRfq(buyer, id);
}
