/**
 * Reporting and translating a message (checklist JOURNEY-055).
 *
 * Three conversations carry messages between people: a preorder chat (buyer
 * and the operator's team), an RFQ thread (buyer and one invited seller) and
 * an order thread (buyer and one seller). This file is the one place that
 * answers "may this person see this message?" for all three, and both actions
 * below go through it, so neither can be used to read a message the person
 * could not already read on their own screen.
 *
 * REPORTING
 *
 * "Report message" writes a `MessageReport` (one per person per message - a
 * second press finds the first), an audit entry, and an ALERT on the staff
 * bell for whoever holds `review.read`. Nothing is hidden or deleted by a
 * report: staff decide - ACTIONED or DISMISSED, with a note - and act through
 * the existing controls (redacting a chat message, suspending an account).
 * The words are never copied into the report or the bell; staff read the
 * message where it is.
 *
 * TRANSLATING
 *
 * Optional and off by default (FEATURE_MESSAGE_TRANSLATION). When on, and the
 * operator has stored a DeepL key in Settings - the same key the catalogue
 * translation uses; no other provider is used or invented - "Translate" sends
 * that one message's text to DeepL and returns it in the reader's language.
 * Nothing is stored and the original stays what the thread shows.
 */
import type { MessageReportReason, MessageThreadKind, Prisma } from '../../generated/prisma/client.js';
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import { env } from '../../config/env.js';
import { decryptSecret } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  AdminNotificationKind,
  ResolutionKey,
  createAdminNotification,
  resolveAdminNotifications,
} from '../notifications/admin-notification.service.js';

export type MessageViewer =
  | {
      party: 'BUYER';
      userId: string;
      email: string;
      customerProfileId: string;
      /** The session's order ownership `where`, from `orderScopeWhere`. */
      orderScope: Prisma.OrderWhereInput;
      /** The session's RFQ ownership `where`, from `buyerScopeWhere`. */
      rfqScope: Prisma.RfqRequestWhereInput;
    }
  | { party: 'SELLER'; userId: string; email: string; sellerAccountId: string };

interface ResolvedMessage {
  threadId: string;
  body: string;
  ownMessage: boolean;
}

/** The message, if this person can read it. Anything else is "not found". */
async function resolveMessage(
  kind: MessageThreadKind,
  messageId: string,
  viewer: MessageViewer,
): Promise<ResolvedMessage> {
  if (kind === 'ORDER') {
    const row = await prisma.orderMessage.findFirst({
      where: {
        id: messageId,
        sellerOrderGroup:
          viewer.party === 'SELLER' ? { sellerAccountId: viewer.sellerAccountId } : { order: viewer.orderScope },
      },
      select: { sellerOrderGroupId: true, body: true, authorParty: true },
    });
    if (row === null) throw notFound('Message');
    return { threadId: row.sellerOrderGroupId, body: row.body, ownMessage: row.authorParty === viewer.party };
  }

  if (kind === 'RFQ') {
    const row = await prisma.rfqMessage.findFirst({
      where: {
        id: messageId,
        ...(viewer.party === 'SELLER' ? { sellerAccountId: viewer.sellerAccountId } : { rfq: viewer.rfqScope }),
      },
      select: { rfqId: true, body: true, authorParty: true },
    });
    if (row === null) throw notFound('Message');
    const own = viewer.party === 'SELLER' ? row.authorParty === 'SUPPLIER' : row.authorParty === 'BUYER';
    return { threadId: row.rfqId, body: row.body, ownMessage: own };
  }

  // A preorder chat is the buyer and the operator's team; no seller is in it.
  if (viewer.party !== 'BUYER') throw notFound('Message');
  const row = await prisma.preorderChatMessage.findFirst({
    where: { id: messageId, conversation: { customerProfileId: viewer.customerProfileId } },
    select: { conversationId: true, body: true, senderType: true, redactedAt: true },
  });
  if (row === null) throw notFound('Message');
  return {
    threadId: row.conversationId,
    body: row.redactedAt === null ? row.body : '',
    ownMessage: row.senderType === 'CUSTOMER',
  };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export const MESSAGE_REPORT_REASONS = ['SPAM', 'ABUSE', 'FRAUD', 'PERSONAL_DATA', 'OFF_PLATFORM', 'OTHER'] as const;
export const MESSAGE_THREAD_KINDS = ['PREORDER_CHAT', 'RFQ', 'ORDER'] as const;

export interface MessageReportReceipt {
  id: string;
  status: 'OPEN' | 'ACTIONED' | 'DISMISSED';
  createdAt: string;
}

export async function reportMessage(
  viewer: MessageViewer,
  input: { threadKind: MessageThreadKind; messageId: string; reason: MessageReportReason; note: string | null },
): Promise<MessageReportReceipt> {
  const message = await resolveMessage(input.threadKind, input.messageId, viewer);
  if (message.ownMessage) {
    throw conflict(ErrorCode.MESSAGE_REPORT_OWN_MESSAGE, 'You cannot report a message you wrote.');
  }

  const key = {
    threadKind_messageId_reporterUserId: {
      threadKind: input.threadKind,
      messageId: input.messageId,
      reporterUserId: viewer.userId,
    },
  };
  const existing = await prisma.messageReport.findUnique({ where: key });
  if (existing !== null) {
    return { id: existing.id, status: existing.status, createdAt: existing.createdAt.toISOString() };
  }

  const id = newId();
  await prisma.$transaction(async (tx) => {
    const created = await tx.messageReport.createMany({
      data: [
        {
          id,
          threadKind: input.threadKind,
          messageId: input.messageId,
          threadId: message.threadId,
          reporterUserId: viewer.userId,
          reporterParty: viewer.party,
          reason: input.reason,
          note: input.note,
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 0) return;
    await recordAudit(
      {
        action: AuditAction.MESSAGE_REPORTED,
        resourceType: 'message_report',
        resourceId: id,
        actorType: 'CUSTOMER',
        actorUserId: viewer.userId,
        actorEmail: viewer.email,
        after: { threadKind: input.threadKind, messageId: input.messageId, reason: input.reason, party: viewer.party },
      },
      tx,
    );
  });

  const row = await prisma.messageReport.findUnique({ where: key });
  if (row === null) throw notFound('Report');
  if (row.id === id) {
    await createAdminNotification({
      kind: AdminNotificationKind.MESSAGE_REPORTED,
      variables: { threadKind: input.threadKind, reason: input.reason, reporterParty: viewer.party },
      requiredPermission: Permission.REVIEW_READ,
      relatedType: 'message_report',
      relatedId: id,
      linkPath: '/message-reports',
      dedupeKey: `message_report:${id}`,
      resolutionKey: ResolutionKey.messageReport(id),
    });
  }
  return { id: row.id, status: row.status, createdAt: row.createdAt.toISOString() };
}

export interface AdminMessageReport {
  id: string;
  threadKind: MessageThreadKind;
  messageId: string;
  threadId: string;
  reason: MessageReportReason;
  note: string | null;
  status: 'OPEN' | 'ACTIONED' | 'DISMISSED';
  reporter: { email: string; party: string };
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  /** The reported words, read where they are, for the reviewer only. Empty if removed since. */
  messageBody: string;
  /** Where the conversation is in the Admin Panel, where there is a screen for it. */
  linkPath: string | null;
}

async function bodyOf(kind: MessageThreadKind, messageId: string): Promise<string> {
  if (kind === 'ORDER') return (await prisma.orderMessage.findUnique({ where: { id: messageId }, select: { body: true } }))?.body ?? '';
  if (kind === 'RFQ') return (await prisma.rfqMessage.findUnique({ where: { id: messageId }, select: { body: true } }))?.body ?? '';
  const chat = await prisma.preorderChatMessage.findUnique({ where: { id: messageId }, select: { body: true, redactedAt: true } });
  return chat === null || chat.redactedAt !== null ? '' : chat.body;
}

function adminLinkOf(kind: MessageThreadKind, threadId: string): string | null {
  // RFQ and order threads have no staff screen of their own; the report
  // carries the words, and the request or order is found by its id.
  return kind === 'PREORDER_CHAT' ? `/preorder-chats/${threadId}` : null;
}

/** The moderation queue, open reports first, newest first within. */
export async function listMessageReports(filters: {
  status?: 'OPEN' | 'ACTIONED' | 'DISMISSED';
  limit: number;
}): Promise<AdminMessageReport[]> {
  const rows = await prisma.messageReport.findMany({
    where: filters.status === undefined ? {} : { status: filters.status },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: filters.limit,
    include: { reporter: { select: { email: true } }, reviewedBy: { select: { email: true } } },
  });
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      threadKind: row.threadKind,
      messageId: row.messageId,
      threadId: row.threadId,
      reason: row.reason,
      note: row.note,
      status: row.status,
      reporter: { email: row.reporter.email, party: row.reporterParty },
      reviewedBy: row.reviewedBy?.email ?? null,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      reviewNote: row.reviewNote,
      createdAt: row.createdAt.toISOString(),
      messageBody: await bodyOf(row.threadKind, row.messageId),
      linkPath: adminLinkOf(row.threadKind, row.threadId),
    })),
  );
}

/**
 * Decide a report, with a note. Closes the staff bell for it in the same
 * transaction, and is audited. A report can be decided again (a second
 * opinion); each decision is its own audit entry.
 */
export async function decideMessageReport(
  reportId: string,
  input: { decision: 'ACTIONED' | 'DISMISSED'; note: string },
  actor: { userId: string; email: string },
): Promise<void> {
  const existing = await prisma.messageReport.findUnique({ where: { id: reportId }, select: { id: true, status: true } });
  if (existing === null) throw notFound('Report');
  await prisma.$transaction(async (tx) => {
    await tx.messageReport.update({
      where: { id: reportId },
      data: { status: input.decision, reviewNote: input.note, reviewedByUserId: actor.userId, reviewedAt: new Date() },
    });
    await recordAudit(
      {
        action: AuditAction.MESSAGE_REPORT_DECIDED,
        resourceType: 'message_report',
        resourceId: reportId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { status: existing.status },
        after: { status: input.decision, note: input.note },
      },
      tx,
    );
    await resolveAdminNotifications(
      {
        resolutionKey: ResolutionKey.messageReport(reportId),
        reason: input.decision === 'ACTIONED' ? 'Report actioned' : 'Report dismissed',
        source: 'DOMAIN_EVENT',
        resolvedByUserId: actor.userId,
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

const DEEPL_TARGETS: Readonly<Record<string, string>> = {
  en: 'EN-GB',
  de: 'DE',
  el: 'EL',
  es: 'ES',
  fr: 'FR',
  it: 'IT',
  nl: 'NL',
  pl: 'PL',
};

/** Whether "Translate" is offered: the flag is on and a key is stored. */
export async function messageTranslationAvailable(): Promise<boolean> {
  if (!env.FEATURE_MESSAGE_TRANSLATION) return false;
  const row = await prisma.catalogTranslationSync.findFirst({ select: { apiKeyEncrypted: true } });
  return row?.apiKeyEncrypted !== null && row?.apiKeyEncrypted !== undefined;
}

export async function translateMessage(
  viewer: MessageViewer,
  input: { threadKind: MessageThreadKind; messageId: string; language: string },
): Promise<{ text: string; detectedLanguage: string | null; language: string }> {
  const unavailable = (): never => {
    throw conflict(ErrorCode.MESSAGE_TRANSLATION_UNAVAILABLE, 'Message translation is not available on this marketplace.');
  };
  if (!env.FEATURE_MESSAGE_TRANSLATION) unavailable();
  const target = DEEPL_TARGETS[input.language];
  if (target === undefined) unavailable();

  const message = await resolveMessage(input.threadKind, input.messageId, viewer);
  if (message.body.trim() === '') return { text: '', detectedLanguage: null, language: input.language };

  const settings = await prisma.catalogTranslationSync.findFirst({ select: { apiKeyEncrypted: true } });
  if (settings?.apiKeyEncrypted === null || settings?.apiKeyEncrypted === undefined) unavailable();
  const apiKey = decryptSecret(settings?.apiKeyEncrypted as string);
  const endpoint = apiKey.endsWith(':fx') ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate';

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `DeepL-Auth-Key ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: [message.body], target_lang: target }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    // The words are a private message: never logged.
    logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'message translation unreachable');
    return unavailable();
  }
  if (!response.ok) {
    logger.warn({ status: response.status }, 'message translation refused');
    unavailable();
  }
  const body = (await response.json()) as { translations?: { text?: unknown; detected_source_language?: unknown }[] };
  const first = body.translations?.[0];
  if (first === undefined || typeof first.text !== 'string') unavailable();
  return {
    text: first?.text as string,
    detectedLanguage: typeof first?.detected_source_language === 'string' ? first.detected_source_language.toLowerCase() : null,
    language: input.language,
  };
}
