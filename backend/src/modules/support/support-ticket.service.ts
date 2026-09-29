/**
 * Support requests: sending one, reading your own, and answering them.
 *
 * Three audiences, one set of rules:
 *
 *   - **Senders** - a buyer or seller on the storefront, a logistics partner in
 *     its portal. Each surface builds a `SupportRequester` from the session and
 *     hands it in; nothing the browser says about who it is, whom it acts for
 *     or which order it means is taken on trust. See `SupportRequester`.
 *   - **Staff** - the console's Support inbox. Everything a sender can see,
 *     plus internal notes, priority and assignment.
 *
 * WHAT A SENDER CAN READ
 *
 * Their own requests, sent from the surface they are on, and nothing else. The
 * filter is `requesterUserId` and `source` (and, in Seller Hub, the seller
 * they are signed in to) - never a company or a seller alone, so a colleague
 * at the same business does not see somebody else's problem. A reference that
 * is not theirs answers "not found", exactly like one that does not exist.
 *
 * Within a request they see the thread with `visibleToRequester` set, and
 * staff are "the team" - never a name or an address. See the note on
 * `SupportTicketEvent` in the schema.
 *
 * WHAT IS NEVER COPIED ANYWHERE
 *
 * The words. The audit trail records who did what to which request; the
 * console bell and every email carry the reference and a link. A support
 * message routinely holds an address, a phone number or an account detail,
 * and an inbox that is forwarded or read on a lock screen is not where that
 * belongs. Nothing here logs a message body either.
 *
 * Status moves only through `domain/support-ticket-state.ts`.
 */
import { randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { cleanChatText, characterCount } from '../../domain/chat-text.js';
import {
  AppError,
  ErrorCode,
  badRequest,
  conflict,
  forbidden,
  notFound,
  unprocessable,
} from '../../domain/errors.js';
import { Permission, permissionsForRoles, type PermissionKey } from '../../domain/permissions.js';
import {
  WORKING_STATUSES,
  assertStaffTransition,
  clearsResolutionCode,
  requiresResolutionCode,
  type SupportResolutionCodeName,
  assertWritable,
  onRequesterMessage,
  onStaffReply,
  timestampsFor,
  type SupportTicketCategoryName,
  type SupportTicketPriorityName,
  type SupportTicketStatusName,
} from '../../domain/support-ticket-state.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type {
  SupportRequesterRole,
  SupportTicketEventKind,
  SupportTicketSource,
} from '../../generated/prisma/enums.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  AdminNotificationKind,
  createAdminNotification,
} from '../notifications/admin-notification.service.js';
import { NotificationEvent, enqueueNotification } from '../notifications/notification.service.js';
import { breachedWhere, deadlinesFor, slaView } from './support-sla.service.js';

// ---------------------------------------------------------------------------
// Limits - one list, read by the routes' schemas and by the pages' counters
// ---------------------------------------------------------------------------

export const SUPPORT_LIMITS = Object.freeze({
  nameMax: 120,
  companyNameMax: 255,
  subjectMin: 3,
  subjectMax: 160,
  messageMin: 10,
  messageMax: 5000,
  orderNumberMax: 32,
});

/** Crockford base32 without I, L, O, U - readable over the telephone. */
const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * SR-XXXX-XXXX: 40 random bits. Not a sequence, so it says nothing about how
 * many requests exist and cannot be walked to find somebody else's.
 */
export function newSupportReference(): string {
  const bytes = randomBytes(8);
  let out = 'SR-';
  bytes.forEach((byte, index) => {
    if (index === 4) out += '-';
    out += REFERENCE_ALPHABET.charAt(byte % 32);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

/**
 * The sender, as the SERVER knows them.
 *
 * Built by each surface's route from the verified session - `auth`, the buyer
 * context, the seller membership, the logistics membership - and never from
 * the request body. That is what makes the tenant columns on a ticket true.
 */
export interface SupportRequester {
  userId: string;
  /** The account's email. Replies go here; the form cannot change it. */
  email: string;
  emailVerified: boolean;
  source: SupportTicketSource;
  role: SupportRequesterRole;
  /** The name to prefill with: the profile's, or the logistics member's. */
  accountName: string;
  customerProfileId: string | null;
  buyerCompanyId: string | null;
  sellerAccountId: string | null;
  logisticsPartnerId: string | null;
  /** The business they act for, when the session decides it. */
  fixedCompanyName: string | null;
  /**
   * Which orders the sender may name. Null means this surface cannot name an
   * order at all (the logistics portal).
   */
  orderScope:
    | { kind: 'BUYER'; where: { customerProfileId?: string; buyerCompanyId: string | null } }
    | { kind: 'SELLER'; sellerAccountId: string; canReadOrders: boolean }
    | null;
  correlationId?: string | null;
  ipAddress?: string | null;
}

/**
 * The name and email a sender's account holds, for the prefill and the
 * snapshot. Read fresh rather than from the token, so a name changed a minute
 * ago is the one the form shows.
 */
export async function loadRequesterAccount(
  userId: string,
  customerProfileId: string | null,
): Promise<{ email: string; emailVerified: boolean; fullName: string | null }> {
  const [user, profile] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true },
    }),
    customerProfileId === null
      ? Promise.resolve(null)
      : prisma.customerProfile.findUnique({
          where: { id: customerProfileId },
          select: { fullName: true },
        }),
  ]);
  return {
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    fullName: profile?.fullName ?? null,
  };
}

export interface SupportContactDetails {
  email: string | null;
  phone: string | null;
}

/** The operator's published contacts, from Settings -> Business profile. */
export async function readSupportContacts(): Promise<SupportContactDetails> {
  const profile = await prisma.businessProfile.findFirst({
    select: { supportEmail: true, supportPhone: true },
  });
  return { email: profile?.supportEmail ?? null, phone: profile?.supportPhone ?? null };
}

/**
 * What the Support page needs before anybody types: whether it takes
 * requests, the published contacts, and the prefill.
 */
export async function readSupportContext(requester: SupportRequester): Promise<{
  enabled: boolean;
  contacts: SupportContactDetails;
  requester: {
    name: string;
    email: string;
    emailVerified: boolean;
    role: SupportRequesterRole;
    companyName: string | null;
    companyNameEditable: boolean;
    canReferenceOrder: boolean;
  };
  limits: typeof SUPPORT_LIMITS & { perDay: number };
}> {
  return {
    enabled: env.FEATURE_SUPPORT_TICKETS,
    contacts: await readSupportContacts(),
    requester: {
      name: requester.accountName,
      email: requester.email,
      emailVerified: requester.emailVerified,
      role: requester.role,
      companyName: requester.fixedCompanyName,
      companyNameEditable: requester.fixedCompanyName === null,
      canReferenceOrder: canReferenceOrder(requester),
    },
    limits: { ...SUPPORT_LIMITS, perDay: env.SUPPORT_TICKETS_PER_DAY },
  };
}

function canReferenceOrder(requester: SupportRequester): boolean {
  if (requester.orderScope === null) return false;
  if (requester.orderScope.kind === 'SELLER') return requester.orderScope.canReadOrders;
  return true;
}

export function assertSupportTicketsEnabled(): void {
  if (!env.FEATURE_SUPPORT_TICKETS) {
    throw forbidden(
      ErrorCode.FEATURE_DISABLED,
      'Support requests are not taken here. Use the support email or phone number instead.',
    );
  }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Plain text as it will be stored, or a 400 naming the field.
 *
 * The same cleaning the chat uses: control characters and bidirectional
 * overrides go, line endings are normalised, the rest is kept exactly as
 * typed. Nothing is escaped, because nothing ever renders it as HTML - that
 * is the XSS defence, not this. Length is counted in characters as a person
 * counts them.
 */
function cleanText(
  raw: string,
  field: string,
  limits: { min: number; max: number },
  options: { singleLine?: boolean } = {},
): string {
  let text = cleanChatText(raw).trim();
  if (options.singleLine === true) text = text.replace(/\s+/g, ' ');

  const length = characterCount(text);
  if (length < limits.min) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, `${field} is too short.`, [
      { field, code: length === 0 ? 'REQUIRED' : 'TOO_SHORT', meta: { min: limits.min } },
    ]);
  }
  if (length > limits.max) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, `${field} is too long.`, [
      { field, code: 'TOO_LONG', meta: { max: limits.max } },
    ]);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const TICKET_SUMMARY_SELECT = {
  id: true,
  reference: true,
  category: true,
  subject: true,
  status: true,
  relatedOrderNumber: true,
  lastActivityAt: true,
  createdAt: true,
} satisfies Prisma.SupportTicketSelect;

type TicketSummaryRow = Prisma.SupportTicketGetPayload<{ select: typeof TICKET_SUMMARY_SELECT }>;

export interface RequesterTicketSummary {
  reference: string;
  category: SupportTicketCategoryName;
  subject: string;
  status: SupportTicketStatusName;
  relatedOrderNumber: string | null;
  lastActivityAt: string;
  createdAt: string;
}

function summaryView(row: TicketSummaryRow): RequesterTicketSummary {
  return {
    reference: row.reference,
    category: row.category,
    subject: row.subject,
    status: row.status,
    relatedOrderNumber: row.relatedOrderNumber,
    lastActivityAt: row.lastActivityAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** One line of the thread as the sender sees it. Staff are "the team". */
export interface RequesterThreadEntry {
  id: string;
  kind: 'REQUESTER_MESSAGE' | 'STAFF_REPLY' | 'STATUS_CHANGED';
  author: 'REQUESTER' | 'TEAM';
  body: string | null;
  status: SupportTicketStatusName | null;
  createdAt: string;
}

/** A file on a ticket, as either side sees it. */
export interface TicketAttachmentView {
  id: string;
  fileName: string;
  contentType: string;
  kind: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  byteSize: number;
  createdAt: string;
  /** Attached by the team rather than the sender. */
  fromTeam: boolean;
}

const ATTACHMENT_VIEW_SELECT = {
  orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
  select: {
    id: true,
    fileName: true,
    contentType: true,
    kind: true,
    byteSize: true,
    createdAt: true,
    uploadedByStaff: true,
  },
};

function attachmentView(row: {
  id: string;
  fileName: string;
  contentType: string;
  kind: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  byteSize: number;
  createdAt: Date;
  uploadedByStaff: boolean;
}): TicketAttachmentView {
  const { uploadedByStaff, ...rest } = row;
  return { ...rest, createdAt: row.createdAt.toISOString(), fromTeam: uploadedByStaff };
}

export interface RequesterTicketView extends RequesterTicketSummary {
  message: string;
  attachments: TicketAttachmentView[];
  companyName: string | null;
  canReply: boolean;
  thread: RequesterThreadEntry[];
}

const REQUESTER_THREAD_KINDS: readonly SupportTicketEventKind[] = [
  'REQUESTER_MESSAGE',
  'STAFF_REPLY',
  'STATUS_CHANGED',
];

async function requesterView(
  client: Pick<PrismaTransaction, 'supportTicket'>,
  ticketId: string,
): Promise<RequesterTicketView> {
  const row = await client.supportTicket.findUniqueOrThrow({
    where: { id: ticketId },
    select: {
      ...TICKET_SUMMARY_SELECT,
      message: true,
      companyNameSnapshot: true,
      attachments: ATTACHMENT_VIEW_SELECT,
      events: {
        // The privacy line, applied in the query itself. See the schema note.
        where: { visibleToRequester: true, kind: { in: [...REQUESTER_THREAD_KINDS] } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          kind: true,
          actorIsRequester: true,
          body: true,
          toValue: true,
          createdAt: true,
        },
      },
    },
  });

  return {
    ...summaryView(row),
    message: row.message,
    companyName: row.companyNameSnapshot,
    attachments: row.attachments.map(attachmentView),
    canReply: row.status !== 'CLOSED',
    thread: row.events.map((event) => ({
      id: event.id,
      kind: event.kind as RequesterThreadEntry['kind'],
      author: event.actorIsRequester ? 'REQUESTER' : 'TEAM',
      body: event.body,
      status: event.kind === 'STATUS_CHANGED' ? (event.toValue as SupportTicketStatusName) : null,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

/** The filter every sender read goes through. See "What a sender can read". */
function ownTicketWhere(requester: SupportRequester): Prisma.SupportTicketWhereInput {
  return {
    requesterUserId: requester.userId,
    source: requester.source,
    ...(requester.source === 'SELLER_HUB' ? { sellerAccountId: requester.sellerAccountId } : {}),
    ...(requester.source === 'LOGISTICS_PORTAL'
      ? { logisticsPartnerId: requester.logisticsPartnerId }
      : {}),
  };
}

export async function ownTicketId(requester: SupportRequester, reference: string): Promise<string> {
  const row = await prisma.supportTicket.findFirst({
    where: { ...ownTicketWhere(requester), reference: reference.trim().toUpperCase() },
    select: { id: true },
  });
  if (row === null) throw notFound('Support request');
  return row.id;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function trimSlash(url: string): string {
  return url.replace(/\/$/, '');
}

/** Where the sender reads the request, on the surface they sent it from. */
export function requesterTicketUrl(source: SupportTicketSource, reference: string): string {
  if (source === 'LOGISTICS_PORTAL') {
    return `${trimSlash(env.LOGISTICS_WEB_PUBLIC_URL)}/support/${reference}`;
  }
  const path = source === 'SELLER_HUB' ? 'seller/support/requests' : 'account/support';
  return `${trimSlash(env.CUSTOMER_WEB_PUBLIC_URL)}/${path}/${reference}`;
}

function consoleTicketPath(ticketId: string): string {
  return `/support/${ticketId}`;
}

function consoleTicketUrl(ticketId: string): string {
  return `${trimSlash(env.ADMIN_WEB_PUBLIC_URL)}${consoleTicketPath(ticketId)}`;
}

// ---------------------------------------------------------------------------
// Sending a request
// ---------------------------------------------------------------------------

export interface CreateSupportTicketInput {
  /**
   * How the sender would like to be addressed. Optional: the Support page is a
   * "raise a ticket" form that asks only about the issue, so this is normally
   * absent and the account's own name is used.
   */
  name?: string | null | undefined;
  companyName?: string | null | undefined;
  category: SupportTicketCategoryName;
  subject: string;
  message: string;
  orderNumber?: string | null | undefined;
  language?: string | null | undefined;
}

/**
 * The order a sender named, if they may see it.
 *
 * A typo and somebody else's order get the same 422: telling them apart would
 * tell a stranger which order numbers exist.
 */
async function resolveOrder(
  requester: SupportRequester,
  orderNumber: string,
): Promise<{ id: string; orderNumber: string }> {
  const refuse = (): AppError =>
    unprocessable(
      ErrorCode.SUPPORT_ORDER_NOT_FOUND,
      'That order number is not one of your orders. Check it, or leave the field empty.',
      [{ field: 'orderNumber', code: 'NOT_FOUND' }],
    );

  const scope = requester.orderScope;
  if (scope === null || !canReferenceOrder(requester)) throw refuse();

  if (scope.kind === 'BUYER') {
    const order = await prisma.order.findFirst({
      where: { orderNumber, ...scope.where },
      select: { id: true, orderNumber: true },
    });
    if (order === null) throw refuse();
    return order;
  }

  const group = await prisma.sellerOrderGroup.findFirst({
    where: { sellerAccountId: scope.sellerAccountId, order: { orderNumber } },
    select: { order: { select: { id: true, orderNumber: true } } },
  });
  if (group === null) throw refuse();
  return group.order;
}

function isReferenceCollision(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  return (
    // `target` is a column list on some drivers and an index name on others.
    candidate.code === 'P2002' &&
    (JSON.stringify(candidate.meta?.target) ?? '').includes('reference')
  );
}

/**
 * Send a support request.
 *
 * Everything that has to agree is one transaction: the ticket, its first
 * history line, the audit entry, the console bell and the emails. A request
 * that rolls back must not leave the team a notification about something
 * that does not exist, and one that commits must not lose its bell.
 *
 * `acknowledgementQueued` is true only when the sender's acknowledgement
 * email was actually queued - an operator may have switched that email off
 * in Settings -> Notifications, and the page must not claim otherwise.
 */
export async function createSupportTicket(
  requester: SupportRequester,
  input: CreateSupportTicketInput,
): Promise<{ ticket: RequesterTicketView; acknowledgementQueued: boolean }> {
  assertSupportTicketsEnabled();

  // Who is asking is the account's business, not the form's: the name comes
  // from the profile (or the logistics member record), and only a caller that
  // explicitly sends one overrides it. An account with no name at all is
  // addressed by its email, which is always there.
  const typedName = input.name?.trim() ?? '';
  const name = cleanText(
    typedName.length > 0 ? typedName : requester.accountName.trim() || requester.email,
    'name',
    { min: 1, max: SUPPORT_LIMITS.nameMax },
    { singleLine: true },
  );
  const subject = cleanText(
    input.subject,
    'subject',
    { min: SUPPORT_LIMITS.subjectMin, max: SUPPORT_LIMITS.subjectMax },
    { singleLine: true },
  );
  const message = cleanText(input.message, 'message', {
    min: SUPPORT_LIMITS.messageMin,
    max: SUPPORT_LIMITS.messageMax,
  });

  // The session decides the business when it can. Only a sender acting for
  // nobody in particular types one, and it is a note, not a claim.
  const typedCompany =
    input.companyName === undefined || input.companyName === null
      ? ''
      : cleanChatText(input.companyName).trim().replace(/\s+/g, ' ');
  if (characterCount(typedCompany) > SUPPORT_LIMITS.companyNameMax) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'companyName is too long.', [
      { field: 'companyName', code: 'TOO_LONG', meta: { max: SUPPORT_LIMITS.companyNameMax } },
    ]);
  }
  const companyName =
    requester.fixedCompanyName ?? (typedCompany.length === 0 ? null : typedCompany);

  const orderNumber = input.orderNumber?.trim().toUpperCase() ?? '';
  const order = orderNumber.length === 0 ? null : await resolveOrder(requester, orderNumber);

  // The daily cap. Counted per account, not per IP - the route's own limiter
  // covers the IP - so a shared office connection does not lock a colleague out.
  const since = new Date(Date.now() - 24 * 3_600_000);
  const sentToday = await prisma.supportTicket.count({
    where: { requesterUserId: requester.userId, createdAt: { gte: since } },
  });
  if (sentToday >= env.SUPPORT_TICKETS_PER_DAY) {
    throw new AppError({
      statusCode: 429,
      code: ErrorCode.SUPPORT_TICKET_LIMIT_REACHED,
      message:
        'You have sent as many support requests today as one account can. Add to one of your ' +
        'open requests instead, or try again tomorrow.',
      details: [{ code: 'LIMIT', meta: { limit: env.SUPPORT_TICKETS_PER_DAY, windowHours: 24 } }],
    });
  }

  const contacts = await readSupportContacts();
  const language = input.language?.trim().slice(0, 10) ?? null;
  // The service targets in force now, copied onto the request.
  const deadlines = await deadlinesFor(input.category, new Date());

  for (let attempt = 0; ; attempt += 1) {
    const id = newId();
    const reference = newSupportReference();
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.supportTicket.create({
          data: {
            id,
            reference,
            requesterUserId: requester.userId,
            requesterRole: requester.role,
            source: requester.source,
            customerProfileId: requester.customerProfileId,
            buyerCompanyId: requester.buyerCompanyId,
            sellerAccountId: requester.sellerAccountId,
            logisticsPartnerId: requester.logisticsPartnerId,
            nameSnapshot: name,
            emailSnapshot: requester.email,
            companyNameSnapshot: companyName,
            language: language === null || language.length === 0 ? null : language,
            category: input.category,
            subject,
            message,
            relatedOrderId: order?.id ?? null,
            relatedOrderNumber: order?.orderNumber ?? null,
            firstResponseDueAt: deadlines.firstResponseDueAt,
            resolutionDueAt: deadlines.resolutionDueAt,
          },
        });

        await tx.supportTicketEvent.create({
          data: {
            id: newId(),
            ticketId: id,
            kind: 'CREATED',
            visibleToRequester: true,
            actorUserId: requester.userId,
            actorIsRequester: true,
          },
        });

        await recordAudit(
          {
            action: AuditAction.SUPPORT_TICKET_CREATED,
            resourceType: 'support_ticket',
            resourceId: id,
            actorType: requester.source === 'LOGISTICS_PORTAL' ? 'LOGISTICS' : 'CUSTOMER',
            actorUserId: requester.userId,
            actorEmail: requester.email,
            after: {
              reference,
              category: input.category,
              source: requester.source,
              requesterRole: requester.role,
              relatedOrderId: order?.id ?? null,
            },
            ipAddress: requester.ipAddress ?? null,
            correlationId: requester.correlationId ?? null,
          },
          tx,
        );

        await createAdminNotification(
          {
            kind: AdminNotificationKind.SUPPORT_TICKET_OPENED,
            variables: {
              reference,
              category: input.category,
              requesterName: name,
              requesterRole: requester.role,
            },
            linkPath: consoleTicketPath(id),
            requiredPermission: Permission.SUPPORT_TICKET_VIEW,
            relatedType: 'support_ticket',
            relatedId: id,
            dedupeKey: `support-ticket-opened:${id}`,
          },
          tx,
        );

        const acknowledgement = await enqueueNotification(
          {
            eventKey: NotificationEvent.SUPPORT_TICKET_RECEIVED,
            recipientEmail: requester.email,
            recipientName: name,
            variables: { reference, ticketUrl: requesterTicketUrl(requester.source, reference) },
            dedupeKey: `support-ticket-received:${id}`,
            relatedType: 'support_ticket',
            relatedId: id,
            correlationId: requester.correlationId ?? null,
          },
          tx,
        );

        // The operator's published support inbox is the team's inbox. A
        // deployment that has not set one relies on the console bell alone.
        if (contacts.email !== null) {
          await enqueueNotification(
            {
              eventKey: NotificationEvent.SUPPORT_TICKET_NEW_FOR_TEAM,
              recipientEmail: contacts.email,
              variables: { reference, category: input.category, consoleUrl: consoleTicketUrl(id) },
              dedupeKey: `support-ticket-new-for-team:${id}`,
              relatedType: 'support_ticket',
              relatedId: id,
            },
            tx,
          );
        }

        return {
          ticket: await requesterView(tx, id),
          acknowledgementQueued: acknowledgement !== null,
        };
      });
    } catch (error) {
      // 40 random bits makes this vanishingly rare; a fresh reference fixes it.
      if (attempt < 3 && isReferenceCollision(error)) continue;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// The sender's own requests
// ---------------------------------------------------------------------------

export async function listOwnSupportTickets(
  requester: SupportRequester,
  query: { page: number; limit: number },
): Promise<{
  tickets: RequesterTicketSummary[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const where = ownTicketWhere(requester);
  const [rows, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      select: TICKET_SUMMARY_SELECT,
    }),
    prisma.supportTicket.count({ where }),
  ]);

  return {
    tickets: rows.map(summaryView),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    },
  };
}

export async function readOwnSupportTicket(
  requester: SupportRequester,
  reference: string,
): Promise<RequesterTicketView> {
  return requesterView(prisma, await ownTicketId(requester, reference));
}

/**
 * The sender writes again.
 *
 * Allowed on every status but CLOSED, and it moves a request staff were
 * waiting on - or one they had resolved - back into their queue.
 *
 * Deliberately not refused when `FEATURE_SUPPORT_TICKETS` is off: a sender
 * with an open request must still be able to answer the question staff asked
 * them, whatever the operator later decided about taking new requests.
 */
export async function addRequesterMessage(
  requester: SupportRequester,
  reference: string,
  rawBody: string,
): Promise<RequesterTicketView> {
  const body = cleanText(rawBody, 'body', { min: 1, max: SUPPORT_LIMITS.messageMax });
  const ticketId = await ownTicketId(requester, reference);

  return prisma.$transaction(async (tx) => {
    const ticket = await tx.supportTicket.findUniqueOrThrow({
      where: { id: ticketId },
      select: { status: true, reference: true, nameSnapshot: true },
    });
    const next = onRequesterMessage(ticket.status);
    const now = new Date();

    // Conditional on the status just read, so a staff member closing the
    // request at the same moment wins cleanly instead of being overwritten.
    const moved = await tx.supportTicket.updateMany({
      where: { id: ticketId, status: ticket.status },
      data: {
        lastActivityAt: now,
        ...(next === null
          ? {}
          : {
              status: next,
              ...timestampsFor(next, now),
              ...(clearsResolutionCode(next) ? { resolutionCode: null } : {}),
            }),
      },
    });
    if (moved.count === 0) {
      throw conflict(
        ErrorCode.CONFLICT,
        'This request changed while you were writing. Refresh and try again.',
      );
    }

    await tx.supportTicketEvent.create({
      data: {
        id: newId(),
        ticketId,
        kind: 'REQUESTER_MESSAGE',
        visibleToRequester: true,
        actorUserId: requester.userId,
        actorIsRequester: true,
        body,
        createdAt: now,
      },
    });

    if (next !== null) {
      await tx.supportTicketEvent.create({
        data: {
          id: newId(),
          ticketId,
          kind: 'STATUS_CHANGED',
          visibleToRequester: true,
          actorUserId: requester.userId,
          actorIsRequester: true,
          fromValue: ticket.status,
          toValue: next,
          createdAt: new Date(now.getTime() + 1),
        },
      });
    }

    await createAdminNotification(
      {
        kind: AdminNotificationKind.SUPPORT_TICKET_REPLIED,
        variables: { reference: ticket.reference, requesterName: ticket.nameSnapshot },
        linkPath: consoleTicketPath(ticketId),
        requiredPermission: Permission.SUPPORT_TICKET_VIEW,
        relatedType: 'support_ticket',
        relatedId: ticketId,
      },
      tx,
    );

    return requesterView(tx, ticketId);
  });
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

export interface SupportStaffActor {
  userId: string;
  email: string;
  permissions: ReadonlySet<string>;
  ipAddress?: string | null;
  correlationId?: string | null;
}

function requirePermission(actor: SupportStaffActor, permission: PermissionKey): void {
  if (!actor.permissions.has(permission)) {
    throw forbidden(ErrorCode.FORBIDDEN, 'Your role does not allow this.');
  }
}

async function staffTicketRow(ticketId: string) {
  const row = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: {
      id: true,
      reference: true,
      status: true,
      priority: true,
      assignedAdminId: true,
      source: true,
      emailSnapshot: true,
      nameSnapshot: true,
      resolutionCode: true,
      firstRespondedAt: true,
    },
  });
  if (row === null) throw notFound('Support request');
  return row;
}

export interface AdminTicketListQuery {
  page: number;
  limit: number;
  /** A status, or `WORKING` for everything not resolved or closed. */
  status?: SupportTicketStatusName | 'WORKING' | undefined;
  priority?: SupportTicketPriorityName | undefined;
  category?: SupportTicketCategoryName | undefined;
  source?: SupportTicketSource | undefined;
  /** `me`, `unassigned`, or a staff user id. */
  assignee?: string | undefined;
  search?: string | undefined;
  /** Only requests past a service-level deadline they are still waiting on. */
  breached?: boolean | undefined;
}

export async function listSupportTicketsForAdmin(
  actor: SupportStaffActor,
  query: AdminTicketListQuery,
) {
  const search = query.search?.trim() ?? '';
  const where: Prisma.SupportTicketWhereInput = {
    ...(query.status === undefined
      ? {}
      : query.status === 'WORKING'
        ? { status: { in: [...WORKING_STATUSES] } }
        : { status: query.status }),
    ...(query.priority === undefined ? {} : { priority: query.priority }),
    ...(query.category === undefined ? {} : { category: query.category }),
    ...(query.source === undefined ? {} : { source: query.source }),
    ...(query.assignee === undefined
      ? {}
      : query.assignee === 'unassigned'
        ? { assignedAdminId: null }
        : { assignedAdminId: query.assignee === 'me' ? actor.userId : query.assignee }),
    ...(query.breached === true
      ? { AND: [breachedWhere(), { status: { in: [...WORKING_STATUSES] } }] }
      : {}),
    ...(search.length === 0
      ? {}
      : {
          OR: [
            { reference: { contains: search.toUpperCase() } },
            { subject: { contains: search } },
            { nameSnapshot: { contains: search } },
            { emailSnapshot: { contains: search } },
            { companyNameSnapshot: { contains: search } },
            { relatedOrderNumber: { contains: search.toUpperCase() } },
          ],
        }),
  };

  const [rows, total, grouped] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      select: {
        id: true,
        reference: true,
        category: true,
        subject: true,
        status: true,
        priority: true,
        source: true,
        requesterRole: true,
        nameSnapshot: true,
        emailSnapshot: true,
        companyNameSnapshot: true,
        relatedOrderNumber: true,
        lastActivityAt: true,
        createdAt: true,
        firstResponseDueAt: true,
        resolutionDueAt: true,
        firstRespondedAt: true,
        resolvedAt: true,
        closedAt: true,
        resolutionCode: true,
        assignedAdmin: { select: { id: true, email: true } },
      },
    }),
    prisma.supportTicket.count({ where }),
    prisma.supportTicket.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);

  return {
    tickets: rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      category: row.category,
      subject: row.subject,
      status: row.status,
      priority: row.priority,
      source: row.source,
      requesterRole: row.requesterRole,
      requesterName: row.nameSnapshot,
      requesterEmail: row.emailSnapshot,
      companyName: row.companyNameSnapshot,
      relatedOrderNumber: row.relatedOrderNumber,
      assignee: row.assignedAdmin,
      lastActivityAt: row.lastActivityAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      resolutionCode: row.resolutionCode,
      sla: slaView(row),
    })),
    counts: Object.fromEntries(grouped.map((entry) => [entry.status, entry._count._all])),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    },
  };
}

/**
 * One request, in full, for staff.
 *
 * The related order is linked only for somebody holding `order.read`. Its
 * number is shown to everyone who can read the ticket, because the sender
 * typed it and it is part of what they said; being able to open the order
 * and see what somebody paid is a different trust.
 */
export async function readSupportTicketForAdmin(actor: SupportStaffActor, ticketId: string) {
  const row = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    include: {
      assignedAdmin: { select: { id: true, email: true } },
      buyerCompany: { select: { id: true, legalName: true, applicationReference: true } },
      sellerAccount: { select: { id: true, displayName: true } },
      logisticsPartner: { select: { id: true, displayName: true } },
      requester: { select: { id: true, email: true, status: true } },
      attachments: ATTACHMENT_VIEW_SELECT,
      events: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { actor: { select: { id: true, email: true } } },
      },
    },
  });
  if (row === null) throw notFound('Support request');

  const mayOpenOrder = actor.permissions.has(Permission.ORDER_READ);

  return {
    id: row.id,
    reference: row.reference,
    category: row.category,
    subject: row.subject,
    message: row.message,
    status: row.status,
    priority: row.priority,
    source: row.source,
    language: row.language,
    requester: {
      userId: row.requesterUserId,
      role: row.requesterRole,
      name: row.nameSnapshot,
      email: row.emailSnapshot,
      currentEmail: row.requester.email,
      accountStatus: row.requester.status,
      companyName: row.companyNameSnapshot,
      customerProfileId: row.customerProfileId,
      buyerCompany: row.buyerCompany,
      seller: row.sellerAccount,
      logisticsPartner: row.logisticsPartner,
    },
    relatedOrder:
      row.relatedOrderNumber === null
        ? null
        : {
            orderNumber: row.relatedOrderNumber,
            id: mayOpenOrder ? row.relatedOrderId : null,
          },
    assignee: row.assignedAdmin,
    attachments: row.attachments.map(attachmentView),
    resolutionCode: row.resolutionCode,
    sla: slaView(row),
    lastActivityAt: row.lastActivityAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    events: row.events.map((event) => ({
      id: event.id,
      kind: event.kind,
      visibleToRequester: event.visibleToRequester,
      actorIsRequester: event.actorIsRequester,
      actor: event.actor,
      body: event.body,
      fromValue: event.fromValue,
      toValue: event.toValue,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

type StaffUpdateClient = Pick<PrismaTransaction, 'supportTicket' | 'supportTicketEvent'>;

/** Move the status, conditionally on it still being what was read. */
async function applyStatus(
  tx: StaffUpdateClient,
  ticketId: string,
  from: SupportTicketStatusName,
  to: SupportTicketStatusName,
  actorUserId: string,
  now: Date,
): Promise<void> {
  const moved = await tx.supportTicket.updateMany({
    where: { id: ticketId, status: from },
    data: {
      status: to,
      lastActivityAt: now,
      ...timestampsFor(to, now),
      ...(clearsResolutionCode(to) ? { resolutionCode: null } : {}),
    },
  });
  if (moved.count === 0) {
    throw conflict(
      ErrorCode.CONFLICT,
      'Somebody changed this request a moment ago. Refresh and try again.',
    );
  }
  await tx.supportTicketEvent.create({
    data: {
      id: newId(),
      ticketId,
      kind: 'STATUS_CHANGED',
      visibleToRequester: true,
      actorUserId,
      fromValue: from,
      toValue: to,
      createdAt: now,
    },
  });
}

/**
 * Resolving or closing needs a code saying how it ended - unless the request
 * already carries one. 400 naming the field.
 */
function assertResolutionCode(
  to: SupportTicketStatusName,
  current: SupportResolutionCodeName | null,
  given: SupportResolutionCodeName | null | undefined,
): SupportResolutionCodeName | null {
  const code = given ?? null;
  if (requiresResolutionCode(to, current) && code === null) {
    throw badRequest(
      ErrorCode.SUPPORT_RESOLUTION_CODE_REQUIRED,
      'Choose how this request was resolved before resolving or closing it.',
      [{ field: 'resolutionCode', code: 'REQUIRED' }],
    );
  }
  return code;
}

/**
 * Answer the sender.
 *
 * The reply is shown on their request and they are emailed that there is one.
 * `nextStatus` lets the same action say what the reply means - "I have asked
 * you something" (WAITING_FOR_CUSTOMER) or "this is the answer" (RESOLVED) -
 * without a second click. Without it, answering an OPEN request makes it
 * IN_PROGRESS and every other status is left alone.
 */
export async function replyToSupportTicket(
  actor: SupportStaffActor,
  ticketId: string,
  input: {
    body: string;
    nextStatus?: SupportTicketStatusName | null | undefined;
    resolutionCode?: SupportResolutionCodeName | null | undefined;
  },
): Promise<{ emailQueued: boolean }> {
  requirePermission(actor, Permission.SUPPORT_TICKET_REPLY);
  const body = cleanText(input.body, 'body', { min: 1, max: SUPPORT_LIMITS.messageMax });
  const row = await staffTicketRow(ticketId);
  assertWritable(row.status);

  const implied = onStaffReply(row.status) ?? row.status;
  const target = input.nextStatus ?? implied;
  if (target !== implied) assertStaffTransition(implied, target);
  const resolutionCode =
    target === row.status ? null : assertResolutionCode(target, row.resolutionCode, input.resolutionCode);

  return prisma.$transaction(async (tx) => {
    const now = new Date();
    // The first reply is what the first-response target measures.
    if (row.firstRespondedAt === null) {
      await tx.supportTicket.update({ where: { id: ticketId }, data: { firstRespondedAt: now } });
    }
    await tx.supportTicketEvent.create({
      data: {
        id: newId(),
        ticketId,
        kind: 'STAFF_REPLY',
        visibleToRequester: true,
        actorUserId: actor.userId,
        body,
        createdAt: now,
      },
    });

    if (target !== row.status) {
      // Stepwise, so the thread shows each move: OPEN -> IN_PROGRESS -> RESOLVED.
      if (implied !== row.status) {
        await applyStatus(
          tx,
          ticketId,
          row.status,
          implied,
          actor.userId,
          new Date(now.getTime() + 1),
        );
      }
      if (target !== implied) {
        await applyStatus(tx, ticketId, implied, target, actor.userId, new Date(now.getTime() + 2));
      }
      if (resolutionCode !== null) {
        await tx.supportTicket.update({ where: { id: ticketId }, data: { resolutionCode } });
      }
    } else {
      await tx.supportTicket.update({ where: { id: ticketId }, data: { lastActivityAt: now } });
    }

    // Answering a request you had not taken takes it - the reply is the claim.
    if (row.assignedAdminId === null) {
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: { assignedAdminId: actor.userId },
      });
    }

    await recordAudit(
      {
        action: AuditAction.SUPPORT_TICKET_REPLIED,
        resourceType: 'support_ticket',
        resourceId: ticketId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { status: row.status },
        after: { status: target, length: characterCount(body), resolutionCode },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    const queued = await enqueueNotification(
      {
        eventKey: NotificationEvent.SUPPORT_TICKET_REPLY,
        recipientEmail: row.emailSnapshot,
        recipientName: row.nameSnapshot,
        variables: {
          reference: row.reference,
          ticketUrl: requesterTicketUrl(row.source, row.reference),
        },
        relatedType: 'support_ticket',
        relatedId: ticketId,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    return { emailQueued: queued !== null };
  });
}

/** A note for colleagues. Never shown to the sender, never emailed. */
export async function addSupportInternalNote(
  actor: SupportStaffActor,
  ticketId: string,
  rawBody: string,
): Promise<void> {
  requirePermission(actor, Permission.SUPPORT_TICKET_REPLY);
  const body = cleanText(rawBody, 'body', { min: 1, max: SUPPORT_LIMITS.messageMax });
  const row = await staffTicketRow(ticketId);

  await prisma.$transaction(async (tx) => {
    await tx.supportTicketEvent.create({
      data: {
        id: newId(),
        ticketId,
        kind: 'INTERNAL_NOTE',
        visibleToRequester: false,
        actorUserId: actor.userId,
        body,
      },
    });
    await recordAudit(
      {
        action: AuditAction.SUPPORT_TICKET_NOTE_ADDED,
        resourceType: 'support_ticket',
        resourceId: ticketId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { reference: row.reference, length: characterCount(body) },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}

/** Change the status or the priority, or both. */
export async function updateSupportTicket(
  actor: SupportStaffActor,
  ticketId: string,
  input: {
    status?: SupportTicketStatusName | undefined;
    priority?: SupportTicketPriorityName | undefined;
    resolutionCode?: SupportResolutionCodeName | undefined;
  },
): Promise<void> {
  requirePermission(actor, Permission.SUPPORT_TICKET_REPLY);
  const row = await staffTicketRow(ticketId);

  const statusChanges = input.status !== undefined && input.status !== row.status;
  const priorityChanges = input.priority !== undefined && input.priority !== row.priority;
  // A code on its own re-labels a resolved request; with a move it says how it ended.
  const target = statusChanges ? (input.status as SupportTicketStatusName) : row.status;
  const codeChanges =
    input.resolutionCode !== undefined &&
    input.resolutionCode !== row.resolutionCode &&
    (target === 'RESOLVED' || target === 'CLOSED');
  if (!statusChanges && !priorityChanges && !codeChanges) return;

  if (statusChanges) assertStaffTransition(row.status, input.status as SupportTicketStatusName);
  else assertWritable(row.status);
  if (statusChanges) assertResolutionCode(target, row.resolutionCode, input.resolutionCode);

  await prisma.$transaction(async (tx) => {
    const now = new Date();

    if (codeChanges) {
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: { resolutionCode: input.resolutionCode ?? null },
      });
    }

    if (statusChanges) {
      const to = input.status as SupportTicketStatusName;
      await applyStatus(tx, ticketId, row.status, to, actor.userId, now);
      await recordAudit(
        {
          action: AuditAction.SUPPORT_TICKET_STATUS_CHANGED,
          resourceType: 'support_ticket',
          resourceId: ticketId,
          actorType: 'ADMIN',
          actorUserId: actor.userId,
          actorEmail: actor.email,
          before: { status: row.status, resolutionCode: row.resolutionCode },
          after: { status: to, resolutionCode: input.resolutionCode ?? row.resolutionCode },
          ipAddress: actor.ipAddress ?? null,
          correlationId: actor.correlationId ?? null,
        },
        tx,
      );
    }

    if (priorityChanges) {
      const to = input.priority as SupportTicketPriorityName;
      await tx.supportTicket.update({ where: { id: ticketId }, data: { priority: to } });
      await tx.supportTicketEvent.create({
        data: {
          id: newId(),
          ticketId,
          kind: 'PRIORITY_CHANGED',
          // How staff organise themselves; not the sender's business.
          visibleToRequester: false,
          actorUserId: actor.userId,
          fromValue: row.priority,
          toValue: to,
          createdAt: new Date(now.getTime() + 1),
        },
      });
      await recordAudit(
        {
          action: AuditAction.SUPPORT_TICKET_PRIORITY_CHANGED,
          resourceType: 'support_ticket',
          resourceId: ticketId,
          actorType: 'ADMIN',
          actorUserId: actor.userId,
          actorEmail: actor.email,
          before: { priority: row.priority },
          after: { priority: to },
          ipAddress: actor.ipAddress ?? null,
          correlationId: actor.correlationId ?? null,
        },
        tx,
      );
    }
  });
}

/** Active staff who may answer support requests - the only valid assignees. */
export async function listSupportAssignees(): Promise<{ id: string; email: string }[]> {
  const users = await prisma.user.findMany({
    where: { type: 'ADMIN', status: 'ACTIVE', archivedAt: null },
    select: { id: true, email: true, roles: { select: { role: { select: { key: true } } } } },
    orderBy: { email: 'asc' },
    take: 500,
  });
  return users
    .filter((user) =>
      permissionsForRoles(user.roles.map((assignment) => assignment.role.key)).has(
        Permission.SUPPORT_TICKET_REPLY,
      ),
    )
    .map((user) => ({ id: user.id, email: user.email }));
}

/**
 * Give a request to somebody, take it, or put it back in the queue.
 *
 * Taking it yourself, or letting go of your own, needs only the reply
 * permission - picking up the next request is the job. Giving it to somebody
 * else, or taking it off them, needs `support_ticket.assign`, because it
 * decides a colleague's workload. The same split preorder chats make.
 */
export async function assignSupportTicket(
  actor: SupportStaffActor,
  ticketId: string,
  assigneeUserId: string | null,
): Promise<void> {
  const row = await staffTicketRow(ticketId);
  const selfTake = assigneeUserId === actor.userId;
  const selfRelease = assigneeUserId === null && row.assignedAdminId === actor.userId;
  requirePermission(
    actor,
    selfTake || selfRelease ? Permission.SUPPORT_TICKET_REPLY : Permission.SUPPORT_TICKET_ASSIGN,
  );

  if (assigneeUserId !== null) {
    const eligible = await listSupportAssignees();
    if (!eligible.some((candidate) => candidate.id === assigneeUserId)) {
      throw badRequest(
        ErrorCode.SUPPORT_ASSIGNEE_NOT_ELIGIBLE,
        'That member of staff cannot answer support requests.',
        [{ field: 'assigneeUserId', code: 'NOT_ELIGIBLE' }],
      );
    }
  }

  if (row.assignedAdminId === assigneeUserId) return;

  await prisma.$transaction(async (tx) => {
    await tx.supportTicket.update({
      where: { id: ticketId },
      data: { assignedAdminId: assigneeUserId },
    });
    await tx.supportTicketEvent.create({
      data: {
        id: newId(),
        ticketId,
        kind: 'ASSIGNED',
        visibleToRequester: false,
        actorUserId: actor.userId,
        fromValue: row.assignedAdminId,
        toValue: assigneeUserId,
      },
    });
    await recordAudit(
      {
        action: AuditAction.SUPPORT_TICKET_ASSIGNED,
        resourceType: 'support_ticket',
        resourceId: ticketId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { assignedAdminId: row.assignedAdminId },
        after: { assignedAdminId: assigneeUserId },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    if (assigneeUserId !== null && assigneeUserId !== actor.userId) {
      const assignee = await tx.user.findUnique({
        where: { id: assigneeUserId },
        select: { email: true },
      });
      if (assignee !== null) {
        await enqueueNotification(
          {
            eventKey: NotificationEvent.SUPPORT_TICKET_ASSIGNED,
            recipientEmail: assignee.email,
            variables: {
              reference: row.reference,
              assignedBy: actor.email,
              consoleUrl: consoleTicketUrl(ticketId),
            },
            relatedType: 'support_ticket',
            relatedId: ticketId,
          },
          tx,
        );
      }
    }
  });
}
