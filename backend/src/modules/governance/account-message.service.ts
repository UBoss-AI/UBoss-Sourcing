/**
 * A member of staff writes to a customer or a seller (JOURNEY-061).
 *
 * A customer gets an email through the notification outbox, using the
 * editable `account.staff_message` template (subject and message are what the
 * member of staff wrote). A seller gets a notice in Seller Hub, and the email
 * as well when the account has a person to send it to. Every message is
 * audited against the record it was sent about, so it appears in that
 * record's History.
 */
import { z } from 'zod';
import { notFound } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { enqueueNotification } from '../notifications/notification.service.js';
import { notifySeller } from '../seller/notification.service.js';
import type { StaffActor } from './pending-action.service.js';

export const STAFF_MESSAGE_EVENT = 'account.staff_message';

export const accountMessageInput = z
  .object({
    target: z.enum(['CUSTOMER', 'SELLER']),
    /** A customer profile id, or a seller account id. */
    id: z.string().length(26),
    subject: z.string().trim().min(3).max(160),
    message: z.string().trim().min(3).max(4000),
  })
  .strict();
export type AccountMessageInput = z.infer<typeof accountMessageInput>;

export async function sendAccountMessage(
  input: AccountMessageInput,
  actor: StaffActor,
): Promise<{ emailQueued: boolean; noticePosted: boolean }> {
  let email: { address: string; name: string | null } | null = null;
  let noticePosted = false;
  let resourceType: string;

  if (input.target === 'CUSTOMER') {
    resourceType = 'customer';
    const profile = await prisma.customerProfile.findUnique({
      where: { id: input.id },
      select: { firstName: true, user: { select: { email: true } } },
    });
    if (profile === null) throw notFound('Customer');
    email = { address: profile.user.email, name: profile.firstName };
  } else {
    resourceType = 'seller_account';
    const seller = await prisma.sellerAccount.findUnique({
      where: { id: input.id },
      select: { id: true, displayName: true, createdByProfileId: true },
    });
    if (seller === null) throw notFound('Seller');
    await notifySeller({
      sellerAccountId: seller.id,
      kind: 'APPLICATION_STATUS',
      title: input.subject,
      body: input.message,
      linkPath: '/seller',
      severity: 'INFO',
      subjectType: 'staff_message',
      subjectId: seller.id,
    });
    noticePosted = true;
    if (seller.createdByProfileId !== null) {
      const owner = await prisma.customerProfile.findUnique({
        where: { id: seller.createdByProfileId },
        select: { firstName: true, user: { select: { email: true } } },
      });
      if (owner !== null) email = { address: owner.user.email, name: owner.firstName };
    }
  }

  const queued =
    email === null
      ? null
      : await enqueueNotification({
          eventKey: STAFF_MESSAGE_EVENT,
          recipientEmail: email.address,
          recipientName: email.name,
          variables: { subject: input.subject, message: input.message },
          relatedType: resourceType,
          relatedId: input.id,
          correlationId: actor.correlationId ?? null,
        });

  await recordAudit({
    action: AuditAction.ACCOUNT_MESSAGE_SENT,
    resourceType,
    resourceId: input.id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: null,
    after: { subject: input.subject, message: input.message, emailQueued: queued !== null, noticePosted },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return { emailQueued: queued !== null, noticePosted };
}
