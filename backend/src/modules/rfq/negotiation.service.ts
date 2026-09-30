/**
 * Negotiating a quote, and accepting one (checklist Master row 19).
 *
 * Only two people take part in a quote: the request's buyer and the seller
 * who wrote it. Either may COUNTER - a new immutable version that supersedes
 * the one on the table - and the side that did not write the version on the
 * table may ACCEPT or REJECT it. The seller may WITHDRAW its quote.
 *
 * ACCEPTANCE IS ONE WINNER
 *
 * Accepting is three conditional updates in one transaction, each on the
 * state that was read:
 *
 *   1. the request OPEN -> AWARDED, only while it has no awarded quote;
 *   2. the quote OPEN -> ACCEPTED, only while this version is its current one;
 *   3. the version PROPOSED -> ACCEPTED.
 *
 * If any of them finds the row moved, the whole transaction is refused, so
 * two people acting at once - a buyer accepting while the seller counters, or
 * two quotes accepted in the same second - cannot produce two accepted
 * states. Repeating an acceptance that already happened answers with the
 * accepted quote rather than an error: that is what makes it idempotent.
 *
 * The accepted terms are frozen on the quote (`acceptedTermsJson`) with their
 * hash. `acceptedTerms` returns exactly them; a purchase order built later
 * would have to match that hash. Building the purchase order is not part of
 * this product yet.
 */
import { z } from 'zod';
import { ErrorCode, conflict, notFound, type AppError } from '../../domain/errors.js';
import { normaliseQuantity } from '../../domain/rfq.js';
import { assertInvitationTransition, assertRfqTransition } from '../../domain/rfq-state.js';
import { assertQuoteTransition, mayAnswer, offerTermsHash, type OfferTerms } from '../../domain/rfq-quote.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  dispatchPendingNotifications,
  enqueueNotification,
  NotificationEvent,
} from '../notifications/notification.service.js';
import { notifySeller } from '../seller/notification.service.js';
import { rfqNotFound } from './access.js';
import {
  assertOfferWellFormed,
  linkOfferFiles,
  offerTermsSchema,
  quoteView,
  tellBuyer,
  termsOf,
  versionData,
  type QuoteView,
} from './quote.service.js';
import { recordEvent, sellerResponderEmails, sellerRfqUrl } from './rfq.service.js';

export const counterSchema = offerTermsSchema.extend({ expectedVersionNumber: z.number().int().min(1) }).strict();
export const acceptSchema = z.object({ versionId: z.string().length(26), termsHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const rejectSchema = z
  .object({ versionId: z.string().length(26), note: z.string().trim().max(1000).nullable().default(null) })
  .strict();

export interface Negotiator {
  party: 'BUYER' | 'SUPPLIER';
  userId: string;
  email: string | null;
}

type QuoteRow = Prisma.RfqQuoteGetPayload<Record<string, never>>;
type RfqRow = Prisma.RfqRequestGetPayload<Record<string, never>>;

function notOpen(code: string, message: string): AppError {
  return conflict(ErrorCode.RFQ_OFFER_NOT_OPEN, message, [{ code }]);
}

async function loadContext(quoteId: string): Promise<{ quote: QuoteRow; rfq: RfqRow }> {
  const quote = await prisma.rfqQuote.findUnique({ where: { id: quoteId } });
  if (quote === null) rfqNotFound();
  const rfq = await prisma.rfqRequest.findUniqueOrThrow({ where: { id: quote.rfqId } });
  return { quote, rfq };
}

async function currentVersion(quote: QuoteRow) {
  if (quote.currentVersionId === null) throw notOpen('NO_OFFER', 'This quote has no offer on the table.');
  return prisma.rfqQuoteVersion.findUniqueOrThrow({ where: { id: quote.currentVersionId } });
}

/** Tell the other side something moved on this quote. */
async function tellOtherSide(
  tx: PrismaTransaction,
  actor: Negotiator,
  rfq: RfqRow,
  quote: QuoteRow,
  step: string,
  dedupeKey: string,
): Promise<void> {
  if (actor.party === 'SUPPLIER') {
    await tellBuyer(tx, rfq, step, dedupeKey);
    return;
  }
  await notifySeller({
    sellerAccountId: quote.sellerAccountId,
    kind: 'RFQ_UPDATE',
    title: `Request ${rfq.reference}: ${step}`,
    body: `The buyer ${step} on "${rfq.title}".`,
    linkPath: `/seller/rfqs/${rfq.id}`,
    subjectType: 'rfq_request',
    subjectId: rfq.id,
    dedupeKey,
    tx,
  });
  for (const email of await sellerResponderEmails(quote.sellerAccountId)) {
    await enqueueNotification(
      {
        eventKey: NotificationEvent.RFQ_UPDATE_FOR_SELLER,
        recipientEmail: email,
        variables: { rfqReference: rfq.reference, title: rfq.title, step: `the buyer ${step}`, sellerUrl: sellerRfqUrl(rfq.id) },
        dedupeKey: `${dedupeKey}:${email}`,
        relatedType: 'rfq_request',
        relatedId: rfq.id,
      },
      tx,
    );
  }
}

function assertParticipating(quote: QuoteRow, rfq: RfqRow): void {
  if (rfq.status !== 'OPEN') throw notOpen(rfq.status, 'This request is no longer open.');
  if (quote.status !== 'OPEN') throw notOpen(quote.status, 'This quote is no longer open.');
}

// ---------------------------------------------------------------------------
// Counter-offer
// ---------------------------------------------------------------------------

/**
 * Put new terms on the table. Names the version the writer was answering:
 * if that is no longer the current one, somebody else moved first and the
 * counter is refused rather than silently superseding what they sent.
 */
export async function counterOffer(
  actor: Negotiator,
  quoteId: string,
  input: z.infer<typeof counterSchema>,
): Promise<QuoteView> {
  const { quote, rfq } = await loadContext(quoteId);
  assertParticipating(quote, rfq);
  const previous = await currentVersion(quote);
  if (previous.versionNumber !== input.expectedVersionNumber) {
    throw notOpen('STALE', 'The terms changed while you were writing. Read the latest offer first.');
  }
  await assertOfferWellFormed({ currency: quote.currency, expiresAt: input.expiresAt, quantity: input.quantity });

  const carried = termsOf(previous);
  const versionId = newId();
  const terms: OfferTerms = {
    ...carried,
    versionNumber: previous.versionNumber + 1,
    author: actor.party,
    unitPriceMinor: input.unitPriceMinor,
    quantity: normaliseQuantity(input.quantity),
    moq: input.moq === null ? null : normaliseQuantity(input.moq),
    leadTimeDays: input.leadTimeDays,
    incoterm: input.incoterm,
    incotermPlace: input.incotermPlace,
    paymentTerms: input.paymentTerms,
    inspectionTerms: input.inspectionTerms,
    // A counter is one price for one quantity: tiers belong to the first quote.
    tiers: [],
    expiresAt: new Date(input.expiresAt).toISOString(),
  };

  await prisma.$transaction(async (tx) => {
    const moved = await tx.rfqQuote.updateMany({
      where: { id: quote.id, status: 'OPEN', currentVersionId: previous.id },
      data: { currentVersionId: versionId, currentVersionNumber: terms.versionNumber },
    });
    if (moved.count !== 1) throw notOpen('STALE', 'The terms changed while you were writing. Read the latest offer first.');
    await tx.rfqQuoteVersion.updateMany({ where: { id: previous.id, state: 'PROPOSED' }, data: { state: 'SUPERSEDED' } });
    await tx.rfqQuoteVersion.create({ data: versionData(versionId, rfq.id, terms, actor.userId, input.comment) });
    await linkOfferFiles(tx, {
      rfqId: rfq.id,
      sellerAccountId: quote.sellerAccountId,
      party: actor.party,
      versionId,
      attachmentIds: input.attachmentIds,
    });
    await recordEvent(tx, {
      rfqId: rfq.id,
      kind: 'COUNTER_OFFER',
      actorParty: actor.party,
      actorUserId: actor.userId,
      sellerAccountId: quote.sellerAccountId,
      meta: { versionNumber: terms.versionNumber },
    });
    await tellOtherSide(tx, actor, rfq, quote, `sent a counter-offer (version ${String(terms.versionNumber)})`, `rfq:${rfq.id}:quote:${quote.id}:v${String(terms.versionNumber)}`);
    await recordAudit(
      {
        action: AuditAction.RFQ_OFFER_COUNTERED,
        resourceType: 'rfq_request',
        resourceId: rfq.id,
        actorType: 'CUSTOMER',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { quoteId: quote.id, versionNumber: previous.versionNumber, termsHash: previous.termsHash },
        after: { quoteId: quote.id, versionId, versionNumber: terms.versionNumber, termsHash: offerTermsHash(terms), party: actor.party },
      },
      tx,
    );
  });
  await dispatchPendingNotifications();
  return quoteView(await prisma.rfqQuote.findUniqueOrThrow({ where: { id: quote.id } }));
}

// ---------------------------------------------------------------------------
// Accept
// ---------------------------------------------------------------------------

function alreadyAwarded(): AppError {
  return conflict(ErrorCode.RFQ_ALREADY_AWARDED, 'Another quote on this request has already been accepted.', [
    { code: 'AWARDED' },
  ]);
}

/**
 * Accept the offer on the table, by the side that did not write it. See the
 * header for why this cannot produce two winners.
 */
export async function acceptOffer(
  actor: Negotiator,
  quoteId: string,
  input: z.infer<typeof acceptSchema>,
): Promise<QuoteView> {
  const { quote, rfq } = await loadContext(quoteId);
  // The same acceptance again: answer with what was accepted.
  if (quote.status === 'ACCEPTED' && quote.acceptedVersionId === input.versionId) return quoteView(quote);
  if (rfq.awardedQuoteId !== null && rfq.awardedQuoteId !== quote.id) throw alreadyAwarded();
  assertParticipating(quote, rfq);

  const version = await prisma.rfqQuoteVersion.findFirst({ where: { id: input.versionId, quoteId: quote.id } });
  if (version === null) rfqNotFound();
  const author = version.authorParty === 'BUYER' ? 'BUYER' : 'SUPPLIER';
  if (!mayAnswer(author, actor.party)) throw notOpen('OWN_OFFER', 'You cannot accept your own offer. The other side answers it.');
  if (quote.currentVersionId !== version.id || version.state !== 'PROPOSED') {
    throw notOpen('STALE', 'These are no longer the terms on the table. Read the latest offer first.');
  }
  if (version.termsHash !== input.termsHash) {
    throw notOpen('TERMS_CHANGED', 'The terms you were shown are not the terms on the table. Reload and read them again.');
  }
  if (version.expiresAt.getTime() <= Date.now()) {
    throw conflict(ErrorCode.RFQ_OFFER_EXPIRED, 'This offer has expired. Send a counter-offer instead.', [{ code: 'EXPIRED' }]);
  }
  assertRfqTransition({ from: 'OPEN', to: 'AWARDED', actor: 'SYSTEM' });
  assertQuoteTransition({ from: 'OPEN', to: 'ACCEPTED', actor: actor.party });

  const terms = termsOf(version);
  const now = new Date();
  const others = await prisma.rfqQuote.findMany({
    where: { rfqId: rfq.id, status: 'OPEN', id: { not: quote.id } },
    select: { id: true, sellerAccountId: true },
  });

  try {
    await prisma.$transaction(async (tx) => {
      const awarded = await tx.rfqRequest.updateMany({
        where: { id: rfq.id, status: 'OPEN', awardedQuoteId: null },
        data: { status: 'AWARDED', awardedQuoteId: quote.id, awardedAt: now, closedAt: now, version: { increment: 1 } },
      });
      if (awarded.count !== 1) throw alreadyAwarded();
      const accepted = await tx.rfqQuote.updateMany({
        where: { id: quote.id, status: 'OPEN', currentVersionId: version.id },
        data: {
          status: 'ACCEPTED',
          acceptedVersionId: version.id,
          acceptedTermsHash: version.termsHash,
          acceptedTermsJson: terms as unknown as Prisma.InputJsonValue,
          acceptedAt: now,
          acceptedByParty: actor.party,
          acceptedByUserId: actor.userId,
        },
      });
      if (accepted.count !== 1) throw notOpen('STALE', 'These are no longer the terms on the table. Read the latest offer first.');
      const versionMoved = await tx.rfqQuoteVersion.updateMany({
        where: { id: version.id, state: 'PROPOSED' },
        data: { state: 'ACCEPTED', respondedAt: now, respondedByUserId: actor.userId },
      });
      if (versionMoved.count !== 1) throw notOpen('STALE', 'These are no longer the terms on the table.');

      for (const other of others) {
        assertQuoteTransition({ from: 'OPEN', to: 'CLOSED', actor: 'SYSTEM' });
        await tx.rfqQuote.updateMany({ where: { id: other.id, status: 'OPEN' }, data: { status: 'CLOSED', closedReason: 'AWARDED_ELSEWHERE' } });
        await tx.rfqQuoteVersion.updateMany({ where: { quoteId: other.id, state: 'PROPOSED' }, data: { state: 'CLOSED' } });
        await notifySeller({
          sellerAccountId: other.sellerAccountId,
          kind: 'RFQ_UPDATE',
          title: `Request ${rfq.reference} awarded to another supplier`,
          body: `The buyer accepted another quote on "${rfq.title}". Your quote is closed.`,
          linkPath: `/seller/rfqs/${rfq.id}`,
          subjectType: 'rfq_request',
          subjectId: rfq.id,
          dedupeKey: `rfq:${rfq.id}:awarded:${other.sellerAccountId}`,
          tx,
        });
      }

      await recordEvent(tx, {
        rfqId: rfq.id,
        kind: 'OFFER_ACCEPTED',
        actorParty: actor.party,
        actorUserId: actor.userId,
        sellerAccountId: quote.sellerAccountId,
        meta: { versionNumber: version.versionNumber, termsHash: version.termsHash },
      });
      await recordEvent(tx, { rfqId: rfq.id, kind: 'AWARDED', actorParty: 'SYSTEM', actorUserId: null, sharedWithSuppliers: true });
      await tellOtherSide(tx, actor, rfq, quote, `accepted offer version ${String(version.versionNumber)}`, `rfq:${rfq.id}:accepted`);
      await recordAudit(
        {
          action: AuditAction.RFQ_OFFER_ACCEPTED,
          resourceType: 'rfq_request',
          resourceId: rfq.id,
          actorType: 'CUSTOMER',
          actorUserId: actor.userId,
          actorEmail: actor.email,
          before: { rfqStatus: 'OPEN', quoteStatus: 'OPEN' },
          after: {
            rfqStatus: 'AWARDED',
            quoteId: quote.id,
            versionId: version.id,
            versionNumber: version.versionNumber,
            termsHash: version.termsHash,
            party: actor.party,
            closedQuotes: others.map((other) => other.id),
          },
        },
        tx,
      );
    });
  } catch (error) {
    // Lost a race: if what won is this very acceptance, answer with it.
    const after = await prisma.rfqQuote.findUniqueOrThrow({ where: { id: quote.id } });
    if (after.status === 'ACCEPTED' && after.acceptedVersionId === version.id) return quoteView(after);
    throw error;
  }
  await dispatchPendingNotifications();
  return quoteView(await prisma.rfqQuote.findUniqueOrThrow({ where: { id: quote.id } }));
}

// ---------------------------------------------------------------------------
// Reject and withdraw
// ---------------------------------------------------------------------------

/** Turn down the offer on the table; the quote is then closed as rejected. */
export async function rejectOffer(
  actor: Negotiator,
  quoteId: string,
  input: z.infer<typeof rejectSchema>,
): Promise<QuoteView> {
  const { quote, rfq } = await loadContext(quoteId);
  assertParticipating(quote, rfq);
  const version = await currentVersion(quote);
  if (version.id !== input.versionId || version.state !== 'PROPOSED') {
    throw notOpen('STALE', 'These are no longer the terms on the table. Read the latest offer first.');
  }
  const author = version.authorParty === 'BUYER' ? 'BUYER' : 'SUPPLIER';
  if (!mayAnswer(author, actor.party)) throw notOpen('OWN_OFFER', 'You cannot reject your own offer.');
  assertQuoteTransition({ from: 'OPEN', to: 'REJECTED', actor: actor.party });

  await prisma.$transaction(async (tx) => {
    const moved = await tx.rfqQuote.updateMany({
      where: { id: quote.id, status: 'OPEN', currentVersionId: version.id },
      data: { status: 'REJECTED' },
    });
    if (moved.count !== 1) throw notOpen('STALE', 'These are no longer the terms on the table.');
    await tx.rfqQuoteVersion.update({
      where: { id: version.id },
      data: { state: 'REJECTED', respondedAt: new Date(), respondedByUserId: actor.userId, responseNote: input.note },
    });
    await recordEvent(tx, {
      rfqId: rfq.id,
      kind: 'OFFER_REJECTED',
      actorParty: actor.party,
      actorUserId: actor.userId,
      sellerAccountId: quote.sellerAccountId,
      meta: { versionNumber: version.versionNumber },
    });
    await tellOtherSide(tx, actor, rfq, quote, `rejected offer version ${String(version.versionNumber)}`, `rfq:${rfq.id}:quote:${quote.id}:rejected`);
    await recordAudit(
      {
        action: AuditAction.RFQ_OFFER_REJECTED,
        resourceType: 'rfq_request',
        resourceId: rfq.id,
        actorType: 'CUSTOMER',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { quoteId: quote.id, versionId: version.id, versionNumber: version.versionNumber, party: actor.party, note: input.note },
      },
      tx,
    );
  });
  await dispatchPendingNotifications();
  return quoteView(await prisma.rfqQuote.findUniqueOrThrow({ where: { id: quote.id } }));
}

/** The seller takes its quote back, while it is still open. */
export async function withdrawQuote(actor: Negotiator, quoteId: string): Promise<QuoteView> {
  const { quote, rfq } = await loadContext(quoteId);
  assertParticipating(quote, rfq);
  assertQuoteTransition({ from: 'OPEN', to: 'WITHDRAWN', actor: 'SUPPLIER' });
  const invitation = await prisma.rfqInvitation.findUniqueOrThrow({ where: { id: quote.invitationId } });
  assertInvitationTransition({ from: invitation.status, to: 'WITHDRAWN', actor: 'SUPPLIER' });

  await prisma.$transaction(async (tx) => {
    const moved = await tx.rfqQuote.updateMany({ where: { id: quote.id, status: 'OPEN' }, data: { status: 'WITHDRAWN' } });
    if (moved.count !== 1) throw notOpen('STALE', 'This quote changed while you were working on it.');
    await tx.rfqQuoteVersion.updateMany({ where: { quoteId: quote.id, state: 'PROPOSED' }, data: { state: 'WITHDRAWN' } });
    await tx.rfqInvitation.updateMany({ where: { id: invitation.id, status: 'QUOTED' }, data: { status: 'WITHDRAWN' } });
    await recordEvent(tx, {
      rfqId: rfq.id,
      kind: 'QUOTE_WITHDRAWN',
      actorParty: 'SUPPLIER',
      actorUserId: actor.userId,
      sellerAccountId: quote.sellerAccountId,
    });
    await tellBuyer(tx, rfq, 'a supplier withdrew its quote', `rfq:${rfq.id}:quote:${quote.id}:withdrawn`);
    await recordAudit(
      {
        action: AuditAction.RFQ_QUOTE_WITHDRAWN,
        resourceType: 'rfq_request',
        resourceId: rfq.id,
        actorType: 'CUSTOMER',
        actorUserId: actor.userId,
        after: { quoteId: quote.id, currentVersionNumber: quote.currentVersionNumber },
      },
      tx,
    );
  });
  await dispatchPendingNotifications();
  return quoteView(await prisma.rfqQuote.findUniqueOrThrow({ where: { id: quote.id } }));
}

// ---------------------------------------------------------------------------
// The agreed terms
// ---------------------------------------------------------------------------

export interface AcceptedTerms {
  rfqId: string;
  reference: string;
  quoteId: string;
  sellerAccountId: string;
  supplierName: string;
  versionId: string;
  versionNumber: number;
  termsHash: string;
  terms: OfferTerms;
  acceptedAt: string;
  acceptedBy: 'BUYER' | 'SUPPLIER';
  purchaseOrder:
    | { status: 'NOT_RAISED' }
    | { status: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED'; id: string; reference: string };
}

/**
 * The terms both sides agreed to, exactly as frozen at acceptance. Refuses
 * (as not found) a request with no accepted quote. The stored hash is
 * checked against the frozen terms, so a changed row cannot pass for them.
 */
export async function acceptedTerms(rfqId: string, sellerAccountId?: string): Promise<AcceptedTerms> {
  const rfq = await prisma.rfqRequest.findUniqueOrThrow({ where: { id: rfqId } });
  if (rfq.awardedQuoteId === null) throw notFound('Accepted terms');
  const quote = await prisma.rfqQuote.findUniqueOrThrow({
    where: { id: rfq.awardedQuoteId },
    include: { sellerAccount: { select: { displayName: true } } },
  });
  if (sellerAccountId !== undefined && quote.sellerAccountId !== sellerAccountId) throw notFound('Accepted terms');
  if (quote.acceptedTermsJson === null || quote.acceptedTermsHash === null || quote.acceptedVersionId === null || quote.acceptedAt === null) {
    throw notFound('Accepted terms');
  }
  const terms = quote.acceptedTermsJson as unknown as OfferTerms;
  if (offerTermsHash(terms) !== quote.acceptedTermsHash) {
    throw new Error(`accepted terms of quote ${quote.id} no longer match their hash`);
  }
  const purchaseOrder = await prisma.rfqPurchaseOrder.findUnique({
    where: { rfqId: rfq.id },
    select: { id: true, reference: true, status: true },
  });
  return {
    rfqId: rfq.id,
    reference: rfq.reference,
    quoteId: quote.id,
    sellerAccountId: quote.sellerAccountId,
    supplierName: quote.sellerAccount.displayName,
    versionId: quote.acceptedVersionId,
    versionNumber: terms.versionNumber,
    termsHash: quote.acceptedTermsHash,
    terms,
    acceptedAt: quote.acceptedAt.toISOString(),
    acceptedBy: quote.acceptedByParty === 'SUPPLIER' ? 'SUPPLIER' : 'BUYER',
    purchaseOrder:
      purchaseOrder === null
        ? { status: 'NOT_RAISED' }
        : { status: purchaseOrder.status, id: purchaseOrder.id, reference: purchaseOrder.reference },
  };
}
