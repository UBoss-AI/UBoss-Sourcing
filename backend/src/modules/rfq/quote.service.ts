/**
 * Quotes on a request for quotation (checklist Master row 18).
 *
 * An invited seller answers with ONE quote: a unit price in a currency, an
 * optional ladder of price tiers, and the commercial terms around it - MOQ,
 * lead time, capacity, Incoterm, payment, inspection, warranty, tooling,
 * sample cost, a shipping estimate, what is and is not included in the price,
 * and how long the offer stands. That is version 1 of the quote. Every figure
 * of money is a string of minor units; a figure the seller did not give is
 * NULL and reads "not provided", never zero.
 */
import { z } from 'zod';
import { ErrorCode, badRequest, conflict, type AppError, type ErrorDetail } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { INCOTERMS, compareQuantities, isQuantity, normaliseQuantity } from '../../domain/rfq.js';
import { assertInvitationTransition, RESPONSIVE_INVITATION_STATUSES } from '../../domain/rfq-state.js';
import { offerTermsHash, type OfferTerms } from '../../domain/rfq-quote.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  dispatchPendingNotifications,
  enqueueNotification,
  NotificationEvent,
} from '../notifications/notification.service.js';
import { resolveSellerNotifications } from '../seller/notification.service.js';
import { rfqNotFound, type RfqBuyer, type RfqSupplier } from './access.js';
import { buyerRfqUrl, expireLapsedInvitations, invitationResolutionKey, loadRfqForBuyer, recordEvent } from './rfq.service.js';
import { loadInvitation, responseClosed } from './supplier.service.js';

const minor = z.string().regex(/^(?:0|[1-9]\d{0,14})$/, 'Enter an amount in minor units.');
const positiveMinor = z.string().regex(/^[1-9]\d{0,14}$/, 'Enter an amount above zero in minor units.');
const quantity = z.string().trim().refine(isQuantity, { message: 'Enter a positive number with at most three decimal places.' });
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((value) => (value === null || value.length === 0 ? null : value));

/** The terms every offer version carries, whoever writes it. */
export const offerTermsSchema = z.object({
  unitPriceMinor: positiveMinor,
  quantity,
  moq: quantity.nullable().default(null),
  leadTimeDays: z.number().int().min(0).max(3650).nullable().default(null),
  incoterm: z
    .string()
    .refine((value) => INCOTERMS.includes(value), { message: 'Choose an Incoterms 2020 rule.' })
    .nullable()
    .default(null),
  incotermPlace: text(120),
  paymentTerms: text(500),
  inspectionTerms: text(500),
  comment: text(2000),
  expiresAt: z.string().datetime({ offset: true }),
  attachmentIds: z.array(z.string().length(26)).max(10).default([]),
});

/** A seller's first quote: the terms above and everything only a seller states. */
export const quoteInputSchema = offerTermsSchema
  .extend({
    currency: z.string().regex(/^[A-Z]{3}$/),
    capacityPerMonth: quantity.nullable().default(null),
    warranty: text(500),
    toolingMinor: minor.nullable().default(null),
    sampleCostMinor: minor.nullable().default(null),
    shippingEstimateMinor: minor.nullable().default(null),
    taxesDisclosure: text(1000),
    tiers: z
      .array(z.object({ minQuantity: quantity, unitPriceMinor: positiveMinor }).strict())
      .max(10)
      .default([]),
  })
  .strict();

export const shortlistSchema = z.object({ shortlisted: z.boolean() }).strict();

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

type VersionRow = Prisma.RfqQuoteVersionGetPayload<Record<string, never>>;
type QuoteRow = Prisma.RfqQuoteGetPayload<Record<string, never>>;

function decimal(value: Prisma.Decimal | null): string | null {
  return value === null ? null : normaliseQuantity(value.toFixed(3));
}

function tiersOf(value: Prisma.JsonValue | null): { minQuantity: string; unitPriceMinor: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    typeof entry === 'object' &&
    entry !== null &&
    !Array.isArray(entry) &&
    typeof entry['minQuantity'] === 'string' &&
    typeof entry['unitPriceMinor'] === 'string'
      ? [{ minQuantity: entry['minQuantity'], unitPriceMinor: entry['unitPriceMinor'] }]
      : [],
  );
}

/** A version's terms in the canonical, hashable form. */
export function termsOf(row: VersionRow): OfferTerms {
  return {
    quoteId: row.quoteId,
    versionNumber: row.versionNumber,
    author: row.authorParty === 'BUYER' ? 'BUYER' : 'SUPPLIER',
    currency: row.currency,
    unitPriceMinor: row.unitPriceMinor.toString(),
    quantity: decimal(row.quantity) ?? '0',
    moq: decimal(row.moq),
    leadTimeDays: row.leadTimeDays,
    capacityPerMonth: decimal(row.capacityPerMonth),
    incoterm: row.incoterm,
    incotermPlace: row.incotermPlace,
    paymentTerms: row.paymentTerms,
    inspectionTerms: row.inspectionTerms,
    warranty: row.warranty,
    toolingMinor: row.toolingMinor?.toString() ?? null,
    sampleCostMinor: row.sampleCostMinor?.toString() ?? null,
    shippingEstimateMinor: row.shippingEstimateMinor?.toString() ?? null,
    taxesDisclosure: row.taxesDisclosure,
    tiers: tiersOf(row.tiersJson),
    expiresAt: row.expiresAt.toISOString(),
  };
}

const money = (value: bigint | null, currency: string) => (value === null ? null : serialiseMoney(value, currency));

export interface OfferVersionView {
  id: string;
  versionNumber: number;
  author: 'BUYER' | 'SUPPLIER';
  state: string;
  isExpired: boolean;
  termsHash: string;
  terms: OfferTerms;
  unitPrice: ReturnType<typeof serialiseMoney>;
  tooling: ReturnType<typeof serialiseMoney> | null;
  sampleCost: ReturnType<typeof serialiseMoney> | null;
  shippingEstimate: ReturnType<typeof serialiseMoney> | null;
  comment: string | null;
  responseNote: string | null;
  createdAt: string;
  respondedAt: string | null;
}

export function versionView(row: VersionRow): OfferVersionView {
  return {
    id: row.id,
    versionNumber: row.versionNumber,
    author: row.authorParty === 'BUYER' ? 'BUYER' : 'SUPPLIER',
    state: row.state,
    isExpired: row.state === 'PROPOSED' && row.expiresAt.getTime() <= Date.now(),
    termsHash: row.termsHash,
    terms: termsOf(row),
    unitPrice: serialiseMoney(row.unitPriceMinor, row.currency),
    tooling: money(row.toolingMinor, row.currency),
    sampleCost: money(row.sampleCostMinor, row.currency),
    shippingEstimate: money(row.shippingEstimateMinor, row.currency),
    comment: row.comment,
    responseNote: row.responseNote,
    createdAt: row.createdAt.toISOString(),
    respondedAt: row.respondedAt?.toISOString() ?? null,
  };
}

export interface QuoteView {
  id: string;
  rfqId: string;
  sellerAccountId: string;
  status: string;
  currency: string;
  shortlisted: boolean;
  basedOnRequirementVersion: number;
  currentVersionNumber: number;
  current: OfferVersionView | null;
  versions: OfferVersionView[];
  acceptedVersionId: string | null;
  acceptedTermsHash: string | null;
  acceptedAt: string | null;
  closedReason: string | null;
  createdAt: string;
}

export async function quoteView(quote: QuoteRow): Promise<QuoteView> {
  const versions = await prisma.rfqQuoteVersion.findMany({ where: { quoteId: quote.id }, orderBy: { versionNumber: 'asc' } });
  const views = versions.map(versionView);
  return {
    id: quote.id,
    rfqId: quote.rfqId,
    sellerAccountId: quote.sellerAccountId,
    status: quote.status,
    currency: quote.currency,
    shortlisted: quote.shortlisted,
    basedOnRequirementVersion: quote.basedOnRequirementVersion,
    currentVersionNumber: quote.currentVersionNumber,
    current: views.find((entry) => entry.id === quote.currentVersionId) ?? null,
    versions: views,
    acceptedVersionId: quote.acceptedVersionId,
    acceptedTermsHash: quote.acceptedTermsHash,
    acceptedAt: quote.acceptedAt?.toISOString() ?? null,
    closedReason: quote.closedReason,
    createdAt: quote.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Checks shared with negotiation
// ---------------------------------------------------------------------------

/** What the schema cannot check: a real currency, an expiry ahead, a tier ladder that climbs. */
export async function assertOfferWellFormed(input: {
  currency: string;
  expiresAt: string;
  moq?: string | null;
  quantity: string;
  tiers?: { minQuantity: string; unitPriceMinor: string }[];
}): Promise<void> {
  const problems: ErrorDetail[] = [];
  const currency = await prisma.currency.findFirst({ where: { code: input.currency, isActive: true }, select: { code: true } });
  if (currency === null) problems.push({ field: 'currency', code: 'UNKNOWN' });
  if (new Date(input.expiresAt).getTime() <= Date.now()) problems.push({ field: 'expiresAt', code: 'IN_PAST' });
  const tiers = input.tiers ?? [];
  for (let index = 1; index < tiers.length; index += 1) {
    const previous = tiers[index - 1];
    const current = tiers[index];
    if (previous !== undefined && current !== undefined && compareQuantities(current.minQuantity, previous.minQuantity) <= 0) {
      problems.push({ field: `tiers.${String(index)}.minQuantity`, code: 'NOT_ASCENDING' });
    }
  }
  if (problems.length > 0) {
    throw badRequest(ErrorCode.RFQ_QUOTE_INVALID, 'Some terms of this offer are not valid.', problems);
  }
}

/** Link files the writer uploaded (and nobody has seen) to the version they belong to. */
export async function linkOfferFiles(
  tx: PrismaTransaction,
  input: { rfqId: string; sellerAccountId: string; party: 'BUYER' | 'SUPPLIER'; versionId: string; attachmentIds: string[] },
): Promise<void> {
  if (input.attachmentIds.length === 0) return;
  const linked = await tx.rfqAttachment.updateMany({
    where: {
      id: { in: input.attachmentIds },
      rfqId: input.rfqId,
      sellerAccountId: input.sellerAccountId,
      uploadedByParty: input.party,
      quoteVersionId: null,
      purpose: { in: ['QUOTE', 'NEGOTIATION'] },
    },
    data: { quoteVersionId: input.versionId },
  });
  if (linked.count !== new Set(input.attachmentIds).size) {
    throw badRequest(ErrorCode.RFQ_QUOTE_INVALID, 'One of those files cannot be sent with this offer.', [
      { field: 'attachmentIds', code: 'UNKNOWN' },
    ]);
  }
}

// ---------------------------------------------------------------------------
// The seller quotes
// ---------------------------------------------------------------------------

/**
 * Submit this seller's quote. One per seller per request: the UNIQUE index
 * refuses a second (`RFQ_QUOTE_EXISTS`) - a changed price is a counter-offer.
 * Refused after the deadline, once the seller declined, or once the request
 * closed.
 */
export async function submitQuote(
  supplier: RfqSupplier,
  rfqId: string,
  input: z.infer<typeof quoteInputSchema>,
): Promise<QuoteView> {
  const first = await loadInvitation(supplier, rfqId);
  await expireLapsedInvitations(first.rfq);
  const invitation = await loadInvitation(supplier, rfqId);
  const rfq = invitation.rfq;
  if (rfq.status !== 'OPEN') throw responseClosed(rfq.status);
  if (rfq.responseDeadline === null || rfq.responseDeadline.getTime() <= Date.now()) throw responseClosed('DEADLINE_PASSED');
  if (invitation.status === 'QUOTED') {
    throw conflict(ErrorCode.RFQ_QUOTE_EXISTS, 'You have already quoted. Send a counter-offer to change your terms.');
  }
  if (!RESPONSIVE_INVITATION_STATUSES.includes(invitation.status)) throw responseClosed(invitation.status);
  await assertOfferWellFormed(input);
  assertInvitationTransition({ from: invitation.status, to: 'QUOTED', actor: 'SUPPLIER' });

  const quoteId = newId();
  const versionId = newId();
  const now = new Date();
  const terms: OfferTerms = {
    quoteId,
    versionNumber: 1,
    author: 'SUPPLIER',
    currency: input.currency,
    unitPriceMinor: input.unitPriceMinor,
    quantity: normaliseQuantity(input.quantity),
    moq: input.moq === null ? null : normaliseQuantity(input.moq),
    leadTimeDays: input.leadTimeDays,
    capacityPerMonth: input.capacityPerMonth === null ? null : normaliseQuantity(input.capacityPerMonth),
    incoterm: input.incoterm,
    incotermPlace: input.incotermPlace,
    paymentTerms: input.paymentTerms,
    inspectionTerms: input.inspectionTerms,
    warranty: input.warranty,
    toolingMinor: input.toolingMinor,
    sampleCostMinor: input.sampleCostMinor,
    shippingEstimateMinor: input.shippingEstimateMinor,
    taxesDisclosure: input.taxesDisclosure,
    tiers: input.tiers.map((tier) => ({ minQuantity: normaliseQuantity(tier.minQuantity), unitPriceMinor: tier.unitPriceMinor })),
    expiresAt: new Date(input.expiresAt).toISOString(),
  };

  try {
    await prisma.$transaction(async (tx) => {
      const moved = await tx.rfqInvitation.updateMany({
        where: { id: invitation.id, status: invitation.status },
        data: { status: 'QUOTED', respondedAt: now },
      });
      if (moved.count !== 1) throw responseClosed('STALE');
      await tx.rfqQuote.create({
        data: {
          id: quoteId,
          rfqId,
          sellerAccountId: supplier.sellerAccountId,
          invitationId: invitation.id,
          currency: input.currency,
          currentVersionId: versionId,
          currentVersionNumber: 1,
          basedOnRequirementVersion: rfq.currentRequirementVersion,
        },
      });
      await tx.rfqQuoteVersion.create({ data: versionData(versionId, rfqId, terms, supplier.userId, input.comment) });
      await linkOfferFiles(tx, {
        rfqId,
        sellerAccountId: supplier.sellerAccountId,
        party: 'SUPPLIER',
        versionId,
        attachmentIds: input.attachmentIds,
      });
      await recordEvent(tx, {
        rfqId,
        kind: 'QUOTE_SUBMITTED',
        actorParty: 'SUPPLIER',
        actorUserId: supplier.userId,
        sellerAccountId: supplier.sellerAccountId,
        meta: { versionNumber: 1 },
      });
      await tellBuyer(tx, rfq, `${supplier.displayName} sent a quote`, `rfq:${rfqId}:quote:${supplier.sellerAccountId}`);
      await recordAudit(
        {
          action: AuditAction.RFQ_QUOTE_SUBMITTED,
          resourceType: 'rfq_request',
          resourceId: rfqId,
          actorType: 'CUSTOMER',
          actorUserId: supplier.userId,
          after: { quoteId, versionId, versionNumber: 1, termsHash: offerTermsHash(terms), sellerAccountId: supplier.sellerAccountId },
        },
        tx,
      );
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002') {
      throw conflict(ErrorCode.RFQ_QUOTE_EXISTS, 'You have already quoted. Send a counter-offer to change your terms.');
    }
    throw error;
  }
  await resolveSellerNotifications({ resolutionKey: invitationResolutionKey(rfqId, supplier.sellerAccountId), note: 'Quoted' });
  await dispatchPendingNotifications();
  const quote = await prisma.rfqQuote.findUniqueOrThrow({ where: { id: quoteId } });
  return quoteView(quote);
}

/** The row an offer version is written as. */
export function versionData(
  id: string,
  rfqId: string,
  terms: OfferTerms,
  authorUserId: string,
  comment: string | null,
): Prisma.RfqQuoteVersionUncheckedCreateInput {
  return {
    id,
    quoteId: terms.quoteId,
    rfqId,
    versionNumber: terms.versionNumber,
    authorParty: terms.author,
    authorUserId,
    currency: terms.currency,
    unitPriceMinor: BigInt(terms.unitPriceMinor),
    quantity: terms.quantity,
    moq: terms.moq,
    leadTimeDays: terms.leadTimeDays,
    capacityPerMonth: terms.capacityPerMonth,
    incoterm: terms.incoterm,
    incotermPlace: terms.incotermPlace,
    paymentTerms: terms.paymentTerms,
    inspectionTerms: terms.inspectionTerms,
    warranty: terms.warranty,
    toolingMinor: terms.toolingMinor === null ? null : BigInt(terms.toolingMinor),
    sampleCostMinor: terms.sampleCostMinor === null ? null : BigInt(terms.sampleCostMinor),
    shippingEstimateMinor: terms.shippingEstimateMinor === null ? null : BigInt(terms.shippingEstimateMinor),
    taxesDisclosure: terms.taxesDisclosure,
    tiersJson: terms.tiers,
    comment,
    expiresAt: new Date(terms.expiresAt),
    termsHash: offerTermsHash(terms),
  };
}

/** Email the buyer that something moved, at most once per `dedupeKey`. */
export async function tellBuyer(
  tx: PrismaTransaction,
  rfq: { id: string; reference: string; title: string; customerProfileId: string },
  step: string,
  dedupeKey: string,
): Promise<void> {
  const buyer = await tx.customerProfile.findUnique({
    where: { id: rfq.customerProfileId },
    select: { fullName: true, user: { select: { email: true } } },
  });
  if (buyer === null) return;
  await enqueueNotification(
    {
      eventKey: NotificationEvent.RFQ_UPDATE_FOR_BUYER,
      recipientEmail: buyer.user.email,
      recipientName: buyer.fullName,
      variables: { rfqReference: rfq.reference, title: rfq.title, step, rfqUrl: buyerRfqUrl(rfq.id) },
      dedupeKey,
      relatedType: 'rfq_request',
      relatedId: rfq.id,
    },
    tx,
  );
}

/** This seller's quote on the request, or null before it quoted. */
export async function supplierQuote(supplier: RfqSupplier, rfqId: string): Promise<QuoteView | null> {
  await loadInvitation(supplier, rfqId);
  const quote = await prisma.rfqQuote.findUnique({
    where: { rfqId_sellerAccountId: { rfqId, sellerAccountId: supplier.sellerAccountId } },
  });
  return quote === null ? null : quoteView(quote);
}

// ---------------------------------------------------------------------------
// The buyer's side
// ---------------------------------------------------------------------------

export async function loadQuoteForBuyer(buyer: RfqBuyer, rfqId: string, quoteId: string): Promise<QuoteRow> {
  const rfq = await loadRfqForBuyer(buyer, rfqId);
  const quote = await prisma.rfqQuote.findFirst({ where: { id: quoteId, rfqId: rfq.id } });
  if (quote === null) rfqNotFound();
  return quote;
}

/** Every quote on the buyer's request, with its current offer. */
export async function listBuyerQuotes(buyer: RfqBuyer, rfqId: string): Promise<QuoteView[]> {
  const rfq = await loadRfqForBuyer(buyer, rfqId);
  const quotes = await prisma.rfqQuote.findMany({ where: { rfqId: rfq.id }, orderBy: { createdAt: 'asc' } });
  return Promise.all(quotes.map(quoteView));
}

/** Put a quote on the shortlist, or take it off. Only the buyer; changes no term. */
export async function setShortlist(
  buyer: RfqBuyer,
  rfqId: string,
  quoteId: string,
  input: z.infer<typeof shortlistSchema>,
): Promise<QuoteView> {
  const quote = await loadQuoteForBuyer(buyer, rfqId, quoteId);
  await prisma.$transaction(async (tx) => {
    await tx.rfqQuote.update({
      where: { id: quote.id },
      data: { shortlisted: input.shortlisted, shortlistedAt: input.shortlisted ? new Date() : null },
    });
    await recordAudit(
      {
        action: AuditAction.RFQ_QUOTE_SHORTLISTED,
        resourceType: 'rfq_request',
        resourceId: rfqId,
        actorType: 'CUSTOMER',
        actorUserId: buyer.userId,
        actorEmail: buyer.email,
        after: { quoteId, shortlisted: input.shortlisted },
      },
      tx,
    );
  });
  return quoteView(await prisma.rfqQuote.findUniqueOrThrow({ where: { id: quote.id } }));
}

export function quoteInvalid(problems: ErrorDetail[]): AppError {
  return badRequest(ErrorCode.RFQ_QUOTE_INVALID, 'Some terms of this offer are not valid.', problems);
}
