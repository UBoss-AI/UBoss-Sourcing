/**
 * Questions and answers on a request for quotation (Master row 17).
 *
 * One thread per invited seller. The buyer reads and writes in every thread;
 * a seller only ever in its own, because the thread is keyed on the seller
 * the SESSION resolves to - there is no seller id a seller could change.
 *
 * Polling cannot duplicate: a reader asks for messages after the last id it
 * holds, and ids are monotonic. A sender that resends (a bad line, a double
 * press) sends the same `clientMessageId`, and the UNIQUE index makes the
 * second write find the first message instead of adding another.
 */
import { z } from 'zod';
import { ErrorCode, conflict } from '../../domain/errors.js';
import { LIVE_INVITATION_STATUSES, type RfqInvitationStatusName } from '../../domain/rfq-state.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import {
  dispatchPendingNotifications,
  enqueueNotification,
  NotificationEvent,
} from '../notifications/notification.service.js';
import { notifySeller } from '../seller/notification.service.js';
import { rfqNotFound } from './access.js';
import { buyerRfqUrl, recordEvent } from './rfq.service.js';

export const messageBodySchema = z
  .object({
    body: z.string().trim().min(1).max(4000),
    clientMessageId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,64}$/)
      .nullable()
      .default(null),
  })
  .strict();

export const threadQuerySchema = z.object({ after: z.string().length(26).optional() });

export interface RfqMessageView {
  id: string;
  from: 'BUYER' | 'SUPPLIER';
  body: string;
  mine: boolean;
  at: string;
}

function view(
  row: { id: string; authorParty: string; body: string; createdAt: Date },
  reader: 'BUYER' | 'SUPPLIER',
): RfqMessageView {
  const from = row.authorParty === 'SUPPLIER' ? 'SUPPLIER' : 'BUYER';
  return { id: row.id, from, body: row.body, mine: from === reader, at: row.createdAt.toISOString() };
}

/** The thread with one seller, oldest first; only what follows `after` when given. */
export async function listThread(
  rfqId: string,
  sellerAccountId: string,
  reader: 'BUYER' | 'SUPPLIER',
  after?: string,
): Promise<RfqMessageView[]> {
  const rows = await prisma.rfqMessage.findMany({
    where: { rfqId, sellerAccountId, ...(after === undefined ? {} : { id: { gt: after } }) },
    orderBy: { id: 'asc' },
    take: 500,
  });
  return rows.map((row) => view(row, reader));
}

/**
 * Write one message in a thread. The caller has checked the writer may reach
 * this thread; this checks the thread is still open.
 */
export async function postMessage(input: {
  rfq: { id: string; reference: string; title: string; status: string; customerProfileId: string };
  sellerAccountId: string;
  invitationStatus: RfqInvitationStatusName;
  party: 'BUYER' | 'SUPPLIER';
  userId: string;
  body: z.infer<typeof messageBodySchema>;
}): Promise<RfqMessageView> {
  if (input.rfq.status !== 'OPEN') {
    throw conflict(ErrorCode.RFQ_RESPONSE_CLOSED, 'Questions are closed: this request is no longer open.', [
      { code: input.rfq.status },
    ]);
  }
  if (!LIVE_INVITATION_STATUSES.includes(input.invitationStatus)) {
    throw conflict(ErrorCode.RFQ_RESPONSE_CLOSED, 'This seller is no longer taking part in the request.', [
      { code: input.invitationStatus },
    ]);
  }

  if (input.body.clientMessageId !== null) {
    const existing = await prisma.rfqMessage.findUnique({
      where: {
        rfqId_sellerAccountId_clientMessageId: {
          rfqId: input.rfq.id,
          sellerAccountId: input.sellerAccountId,
          clientMessageId: input.body.clientMessageId,
        },
      },
    });
    if (existing !== null) return view(existing, input.party);
  }

  const id = newId();
  await prisma.$transaction(async (tx) => {
    const created = await tx.rfqMessage.createMany({
      data: [
        {
          id,
          rfqId: input.rfq.id,
          sellerAccountId: input.sellerAccountId,
          authorParty: input.party,
          authorUserId: input.userId,
          body: input.body.body,
          clientMessageId: input.body.clientMessageId,
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 0) return;
    await recordEvent(tx, {
      rfqId: input.rfq.id,
      kind: input.party === 'BUYER' ? 'BUYER_MESSAGE' : 'SUPPLIER_MESSAGE',
      actorParty: input.party,
      actorUserId: input.userId,
      sellerAccountId: input.sellerAccountId,
    });
    if (input.party === 'BUYER') {
      await notifySeller({
        sellerAccountId: input.sellerAccountId,
        kind: 'RFQ_UPDATE',
        title: `New message on ${input.rfq.reference}`,
        body: `The buyer wrote on "${input.rfq.title}".`,
        linkPath: `/seller/rfqs/${input.rfq.id}`,
        subjectType: 'rfq_request',
        subjectId: input.rfq.id,
        tx,
      });
    } else {
      const buyer = await tx.customerProfile.findUnique({
        where: { id: input.rfq.customerProfileId },
        select: { fullName: true, user: { select: { email: true } } },
      });
      if (buyer !== null) {
        // One email an hour per thread: a conversation is not a mail flood.
        const hour = new Date().toISOString().slice(0, 13);
        await enqueueNotification(
          {
            eventKey: NotificationEvent.RFQ_UPDATE_FOR_BUYER,
            recipientEmail: buyer.user.email,
            recipientName: buyer.fullName,
            variables: {
              rfqReference: input.rfq.reference,
              title: input.rfq.title,
              step: 'a supplier sent you a message',
              rfqUrl: buyerRfqUrl(input.rfq.id),
            },
            dedupeKey: `rfq:${input.rfq.id}:message:${input.sellerAccountId}:${hour}`,
            relatedType: 'rfq_request',
            relatedId: input.rfq.id,
          },
          tx,
        );
      }
    }
  });
  await dispatchPendingNotifications();

  const row =
    (await prisma.rfqMessage.findUnique({ where: { id } })) ??
    (input.body.clientMessageId === null
      ? null
      : await prisma.rfqMessage.findUnique({
          where: {
            rfqId_sellerAccountId_clientMessageId: {
              rfqId: input.rfq.id,
              sellerAccountId: input.sellerAccountId,
              clientMessageId: input.body.clientMessageId,
            },
          },
        }));
  if (row === null) rfqNotFound();
  return view(row, input.party);
}
