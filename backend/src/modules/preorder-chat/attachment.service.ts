/**
 * Files in a preorder chat: a specification PDF, a photograph of a label.
 *
 * The same four rules the seller-document store follows, because they are the
 * same problem:
 *
 *   1. **The bytes decide the type.** `sniffDocumentType` accepts a PDF or a
 *      JPEG, PNG, WebP or GIF and refuses everything else - no archives, no
 *      office documents that run macros, no SVG, no executables, whatever the
 *      file claims to be called.
 *   2. **Scanned before stored.** An infected file never reaches storage, and
 *      a scanner that does not answer fails the upload closed. Where no scanner
 *      is configured, attachments are unavailable unless the operator has
 *      explicitly accepted unscanned files, which production refuses.
 *   3. **Private, and out through a single-use link.** The object sits under
 *      the private storage prefix at a random key. A download needs a link
 *      minted for one signed-in participant, valid for minutes, spent on first
 *      use - and the session that redeems it must be that participant's.
 *   4. **Audited both ways.** Who put a file in a conversation, and who took
 *      one out.
 */
import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import { safeFileName } from '../../domain/chat-text.js';
import {
  ErrorCode,
  badRequest,
  conflict,
  forbidden,
  notFound,
  serviceUnavailable,
} from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import { onCustomerMessage, onStaffMessage } from '../../domain/preorder-chat-state.js';
import { generateToken, sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import {
  MalwareDetectedError,
  MalwareScannerUnavailableError,
  scanForMalware,
} from '../../infra/malware-scan.js';
import { prisma } from '../../infra/prisma.js';
import { sniffDocumentType, storage } from '../../infra/storage/index.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { attachmentAvailability, attachmentsServable } from './attachment-policy.js';
import {
  appendMessage,
  loadMessageView,
  senderKeyFor,
  type ChatOutcome,
  type CustomerActor,
  type StaffActor,
} from './conversation.service.js';
import type { ChatSide } from './realtime/events.js';

/** How long a download link works for. */
const LINK_TTL_MS = 5 * 60_000;

export interface UploadInput {
  bytes: Buffer;
  fileName: string;
  clientMessageId: string;
}

function assertAvailable(): void {
  const availability = attachmentAvailability();
  if (!availability.available) {
    throw conflict(
      ErrorCode.PREORDER_CHAT_ATTACHMENTS_UNAVAILABLE,
      availability.reason === 'DISABLED'
        ? 'Attachments are switched off on this installation.'
        : 'Attachments are unavailable because no malware scanner is configured.',
      [{ code: availability.reason }],
    );
  }
}

async function scan(bytes: Buffer): Promise<'CLEAN' | 'SCANNER_UNCONFIGURED'> {
  try {
    const result = await scanForMalware(bytes);
    return result.status === 'CLEAN' ? 'CLEAN' : 'SCANNER_UNCONFIGURED';
  } catch (error) {
    if (error instanceof MalwareDetectedError) {
      throw badRequest(ErrorCode.MALWARE_DETECTED, 'The file failed the security scan.', [
        { field: 'file', code: 'MALWARE_DETECTED' },
      ]);
    }
    if (error instanceof MalwareScannerUnavailableError) {
      throw serviceUnavailable('The file security scanner is temporarily unavailable.', error);
    }
    throw error;
  }
}

function validateBytes(bytes: Buffer): { mimeType: string; extension: string } {
  if (bytes.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The file is empty.', [{ field: 'file', code: 'EMPTY' }]);
  }
  if (bytes.length > env.PREORDER_CHAT_ATTACHMENT_MAX_BYTES) {
    throw badRequest(
      ErrorCode.MEDIA_TOO_LARGE,
      `Files can be up to ${(env.PREORDER_CHAT_ATTACHMENT_MAX_BYTES / 1_048_576).toFixed(0)} MB.`,
      [{ field: 'file', code: 'FILE_TOO_LARGE', meta: { maxBytes: env.PREORDER_CHAT_ATTACHMENT_MAX_BYTES } }],
    );
  }
  // Throws MEDIA_TYPE_NOT_ALLOWED for anything but a PDF or an image.
  return sniffDocumentType(bytes);
}

/**
 * Store one file and post it as a message.
 *
 * `side` decides who is sending; the caller has already authorised them, and
 * the conversation's status is checked here exactly as for a text message -
 * a closed conversation takes no files either.
 */
export async function uploadAttachment(
  side: ChatSide,
  actor: CustomerActor | StaffActor,
  conversationId: string,
  input: UploadInput,
): Promise<ChatOutcome<{ message: Record<string, unknown>; duplicate: boolean }>> {
  assertAvailable();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(input.clientMessageId)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'A message id is required.', [
      { field: 'clientMessageId', code: 'INVALID' },
    ]);
  }

  const conversation = await prisma.preorderChatConversation.findFirst({
    where:
      side === 'CUSTOMER'
        ? { id: conversationId, customerProfileId: (actor as CustomerActor).customerProfileId }
        : { id: conversationId },
    select: { id: true, status: true, customerProfileId: true },
  });
  if (conversation === null) throw notFound('Conversation');

  if (side === 'STAFF' && !(actor as StaffActor).permissions.has(Permission.PREORDER_CHAT_REPLY)) {
    throw forbidden(ErrorCode.PERMISSION_DENIED, 'You do not have permission to perform this action.');
  }

  const senderType = side === 'CUSTOMER' ? 'CUSTOMER' : 'ADMIN';
  const senderKey = senderKeyFor(senderType, actor.userId);

  // A retry of an upload that already landed: answer with it, store nothing.
  const retry = await prisma.preorderChatMessage.findUnique({
    where: { senderKey_clientMessageId: { senderKey, clientMessageId: input.clientMessageId } },
    select: { id: true, conversationId: true },
  });
  if (retry !== null) {
    if (retry.conversationId !== conversationId) {
      throw conflict(ErrorCode.PREORDER_CHAT_MESSAGE_ID_REUSED, 'That message id was already used.');
    }
    return { value: { message: (await loadMessageView(retry.id, side)) ?? {}, duplicate: true }, events: [] };
  }

  if (side === 'CUSTOMER') {
    const block = await prisma.preorderChatCustomerBlock.findUnique({
      where: { customerProfileId: conversation.customerProfileId },
      select: { id: true },
    });
    if (block !== null) {
      throw forbidden(ErrorCode.PREORDER_CHAT_BLOCKED, 'Messaging is not available on this account.');
    }
  }
  const outcome = side === 'CUSTOMER' ? onCustomerMessage(conversation.status) : onStaffMessage(conversation.status);
  if (!outcome.accepted) {
    if (outcome.code === 'PREORDER_CHAT_BLOCKED') {
      throw forbidden(ErrorCode.PREORDER_CHAT_BLOCKED, 'Messaging is not available on this account.');
    }
    throw conflict(ErrorCode.PREORDER_CHAT_CLOSED, 'This conversation is closed.');
  }

  const sniffed = validateBytes(input.bytes);
  const scanState = await scan(input.bytes);
  if (scanState === 'SCANNER_UNCONFIGURED' && !env.PREORDER_CHAT_ALLOW_UNSCANNED_ATTACHMENTS) {
    // Unreachable while `assertAvailable` holds; kept so the two can never drift.
    assertAvailable();
  }

  const stored = await storage.put(input.bytes, sniffed.mimeType, sniffed.extension, 'private');
  const fileName = safeFileName(input.fileName, `attachment.${sniffed.extension}`);
  const attachmentId = newId();

  let messageId: string;
  try {
    messageId = await prisma.$transaction(async (tx) => {
      const id = await appendMessage(tx, {
        conversationId,
        senderType,
        senderUserId: actor.userId,
        clientMessageId: input.clientMessageId,
        messageType: 'ATTACHMENT',
        body: '',
        nextStatus: outcome.next,
        reopened: conversation.status === 'RESOLVED',
      });
      await tx.preorderChatAttachment.create({
        data: {
          id: attachmentId,
          conversationId,
          messageId: id,
          storageKey: stored.storageKey,
          fileName,
          contentType: stored.mimeType,
          byteSize: stored.sizeBytes,
          contentHash: createHash('sha256').update(input.bytes).digest('hex'),
          scanState,
          uploadedByUserId: actor.userId,
          uploaderType: senderType,
        },
      });
      // The preview says a file arrived, by name.
      await tx.preorderChatConversation.update({
        where: { id: conversationId },
        data: { lastMessagePreview: `📎 ${fileName}`.slice(0, 200), lastMessageSender: senderType },
      });
      await recordAudit(
        {
          action: AuditAction.PREORDER_CHAT_ATTACHMENT_UPLOADED,
          resourceType: 'preorder_chat',
          resourceId: conversationId,
          actorType: side === 'CUSTOMER' ? 'CUSTOMER' : 'ADMIN',
          actorUserId: actor.userId,
          actorEmail: actor.email,
          after: {
            attachmentId,
            contentType: stored.mimeType,
            byteSize: stored.sizeBytes,
            scanState,
          },
          ipAddress: actor.ipAddress ?? null,
          correlationId: actor.correlationId ?? null,
        },
        tx,
      );
      return id;
    });
  } catch (error) {
    // Nothing references the object now; do not leave it behind.
    await storage.delete(stored.storageKey).catch(() => undefined);
    throw error;
  }

  const message = (await loadMessageView(messageId, side)) ?? {};
  return {
    value: { message, duplicate: false },
    events: [
      {
        kind: 'message.created',
        conversationId,
        customerProfileId: conversation.customerProfileId,
        messageId,
        seq: (message['seq'] as number | undefined) ?? 0,
      },
      {
        kind: 'conversation.updated',
        conversationId,
        customerProfileId: conversation.customerProfileId,
        reason: 'message',
        staffOnly: false,
      },
    ],
  };
}

function tokenHash(side: ChatSide, attachmentId: string, token: string): string {
  return sha256Hex(`preorder-chat-attachment:${side}:${attachmentId}:${token}`);
}

async function attachmentIn(
  side: ChatSide,
  actor: CustomerActor | StaffActor,
  conversationId: string,
  attachmentId: string,
) {
  const attachment = await prisma.preorderChatAttachment.findFirst({
    where: {
      id: attachmentId,
      conversationId,
      // A customer reaches only their own conversation's files - part of the
      // query, so another customer's is never loaded.
      ...(side === 'CUSTOMER'
        ? { conversation: { customerProfileId: (actor as CustomerActor).customerProfileId } }
        : {}),
      // A redacted message's file is gone.
      message: { redactedAt: null },
    },
    select: { id: true, storageKey: true, fileName: true, contentType: true, scanState: true },
  });
  if (attachment === null) throw notFound('Attachment');
  if (!attachmentsServable(attachment.scanState)) {
    throw conflict(
      ErrorCode.PREORDER_CHAT_ATTACHMENTS_UNAVAILABLE,
      'This installation does not serve files that have not been scanned for malware.',
    );
  }
  return attachment;
}

/** A link that works for five minutes, once, for this person. */
export async function createAttachmentLink(
  side: ChatSide,
  actor: CustomerActor | StaffActor,
  conversationId: string,
  attachmentId: string,
): Promise<{ url: string; expiresAt: string; fileName: string; contentType: string }> {
  const attachment = await attachmentIn(side, actor, conversationId, attachmentId);
  const { token } = generateToken(32);
  const expiresAt = new Date(Date.now() + LINK_TTL_MS);

  // The AuthToken table, like the seller documents, so the existing expiry
  // sweep and single-use rule apply without a store of their own.
  await prisma.authToken.create({
    data: {
      id: newId(),
      userId: actor.userId,
      type: 'EMAIL_VERIFICATION',
      tokenHash: tokenHash(side, attachment.id, token),
      expiresAt,
      createdById: actor.userId,
    },
  });

  const base =
    side === 'CUSTOMER'
      ? `/api/v1/preorder-chats/${conversationId}/attachments/${attachment.id}/download`
      : `/api/v1/admin/preorder-chats/${conversationId}/attachments/${attachment.id}/download`;

  return {
    url: `${base}?token=${token}`,
    expiresAt: expiresAt.toISOString(),
    fileName: attachment.fileName,
    contentType: attachment.contentType,
  };
}

/**
 * Hand over the bytes for a link, once.
 *
 * Both the token AND the session must be right: a link copied into another
 * person's browser does not work for them.
 */
export async function redeemAttachmentLink(
  side: ChatSide,
  actor: CustomerActor | StaffActor,
  conversationId: string,
  attachmentId: string,
  token: string,
): Promise<{ body: Buffer; contentType: string; fileName: string }> {
  const record = await prisma.authToken.findUnique({
    where: { tokenHash: tokenHash(side, attachmentId, token) },
    select: { id: true, userId: true, expiresAt: true, consumedAt: true },
  });
  if (
    record === null ||
    record.userId !== actor.userId ||
    record.consumedAt !== null ||
    record.expiresAt.getTime() <= Date.now()
  ) {
    throw forbidden(ErrorCode.TOKEN_INVALID, 'This download link is no longer valid.');
  }

  const attachment = await attachmentIn(side, actor, conversationId, attachmentId);

  const consumed = await prisma.authToken.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) {
    throw forbidden(ErrorCode.TOKEN_ALREADY_USED, 'This download link has already been used.');
  }

  const body = await storage.get(attachment.storageKey);
  await recordAudit({
    action: AuditAction.PREORDER_CHAT_ATTACHMENT_DOWNLOADED,
    resourceType: 'preorder_chat',
    resourceId: conversationId,
    actorType: side === 'CUSTOMER' ? 'CUSTOMER' : 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    after: { attachmentId },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return { body, contentType: attachment.contentType, fileName: attachment.fileName };
}
