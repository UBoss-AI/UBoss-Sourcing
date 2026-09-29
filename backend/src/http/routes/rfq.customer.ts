/**
 * Requests for quotation: the buyer's side (checklist Master rows 16-19).
 *
 * Every route needs a storefront session and acts in the session's buyer
 * context - the person, or the company they are buying for - and a request
 * outside that context answers 404, exactly like one that does not exist.
 *
 * Reading needs nothing more. Writing a draft needs the company's PURCHASE
 * capability, allowed before the company is approved, the way a basket is;
 * anything that asks sellers or commits to terms needs PURCHASE in an
 * APPROVED company.
 *
 * `FEATURE_RFQ=false` answers every route here with 404 FEATURE_DISABLED.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { AppError, ErrorCode, badRequest } from '../../domain/errors.js';
import { INCOTERMS } from '../../domain/rfq.js';
import {
  RFQ_INSPECTION_REQUIREMENTS,
  RFQ_SAMPLE_REQUIREMENTS,
  RFQ_UNITS_OF_MEASURE,
} from '../../domain/rfq.js';
import { rfqNotFound, type RfqBuyer } from '../../modules/rfq/access.js';
import { listThread, messageBodySchema, postMessage, threadQuerySchema } from '../../modules/rfq/message.service.js';
import { prisma } from '../../infra/prisma.js';
import { buildComparison, comparisonCsv, comparisonQuerySchema } from '../../modules/rfq/comparison.service.js';
import {
  attachEvidence,
  buyerMoveSample,
  listBuyerSamples,
  requestSample,
  sampleCreateSchema,
  sampleForEvidence,
  sampleReasonSchema,
} from '../../modules/rfq/sample.service.js';
import {
  acceptOffer,
  acceptSchema,
  acceptedTerms,
  counterOffer,
  counterSchema,
  rejectOffer,
  rejectSchema,
  type Negotiator,
} from '../../modules/rfq/negotiation.service.js';
import {
  listBuyerQuotes,
  loadQuoteForBuyer,
  quoteView,
  setShortlist,
  shortlistSchema,
} from '../../modules/rfq/quote.service.js';
import {
  readRfqAttachment,
  removePendingAttachment,
  rfqAttachmentPolicy,
  storeRfqAttachment,
} from '../../modules/rfq/attachment.service.js';
import { searchSuppliers } from '../../modules/rfq/matching.service.js';
import { buyerRfqSummary } from '../../modules/rfq/summary.service.js';
import {
  amendRfq,
  createDraft,
  deleteDraft,
  endRfq,
  getBuyerRfq,
  inviteSupplier,
  listBuyerRfqs,
  loadRfqForBuyer,
  previewMatches,
  rfqDraftSchema,
  rfqInviteSchema,
  rfqAmendSchema,
  rfqListQuerySchema,
  rfqReasonSchema,
  rfqSaveSchema,
  rfqSubmitSchema,
  saveDraft,
  submitRfq,
} from '../../modules/rfq/rfq.service.js';
import {
  assertBuyerCapability,
  buyerContextOf,
  currentUser,
  requireCustomer,
} from '../plugins/auth.js';
import { sendAttachment } from './preorder-chats.js';

const idParams = z.object({ id: z.string().length(26) });
const attachmentParams = z.object({ id: z.string().length(26), attachmentId: z.string().length(26) });
const supplierQuery = z.object({
  q: z.string().trim().max(80).default(''),
  categoryId: z.string().length(26).optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
});
const WRITE_RATE_LIMIT = { max: 60, timeWindow: '1 minute' } as const;

/** Refuse every route while the feature is switched off. */
export async function requireFeature(): Promise<void> {
  if (!env.FEATURE_RFQ) {
    throw new AppError({
      statusCode: 404,
      code: ErrorCode.FEATURE_DISABLED,
      message: 'Requests for quotation are not offered on this marketplace.',
    });
  }
  await Promise.resolve();
}

export function buyerOf(request: FastifyRequest): RfqBuyer {
  const auth = currentUser(request);
  return {
    userId: auth.id,
    email: auth.email,
    customerProfileId: auth.customerProfileId ?? '',
    context: buyerContextOf(request),
  };
}

/** May build a draft: PURCHASE in the company, before approval too. */
function assertDrafting(request: FastifyRequest): void {
  assertBuyerCapability(request, 'PURCHASE', { allowPending: true });
}

/** May ask sellers or commit to terms: PURCHASE in an approved company. */
export function assertPurchasing(request: FastifyRequest): void {
  assertBuyerCapability(request, 'PURCHASE');
}

async function readUpload(request: FastifyRequest): Promise<{ bytes: Buffer; fileName: string }> {
  const upload = await request.file({ limits: { fileSize: env.RFQ_ATTACHMENT_MAX_BYTES, files: 1 } });
  if (upload === undefined) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'No file was attached.', [
      { field: 'file', code: 'REQUIRED' },
    ]);
  }
  const bytes = await upload.toBuffer();
  return { bytes, fileName: upload.filename };
}

export { readUpload as readRfqUpload };

export function registerCustomerRfqRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireFeature);

  /**
   * What the request form offers: units of measure, Incoterms, sample and
   * inspection choices, the deadline limit and the file rules.
   */
  app.get('/form-options', { preHandler: requireCustomer }, async (_request, reply) =>
    reply.header('Cache-Control', 'no-store').status(200).send({
      unitsOfMeasure: RFQ_UNITS_OF_MEASURE,
      incoterms: INCOTERMS,
      sampleRequirements: RFQ_SAMPLE_REQUIREMENTS,
      inspectionRequirements: RFQ_INSPECTION_REQUIREMENTS,
      maxResponseDays: env.RFQ_MAX_RESPONSE_DAYS,
      maxInvitedSuppliers: env.RFQ_MAX_INVITED_SUPPLIERS,
      attachments: rfqAttachmentPolicy(),
    }),
  );

  /** Sourcing figures and next actions for the buyer dashboard. A failed block is null, never an error. */
  app.get('/summary', { preHandler: requireCustomer }, async (request, reply) => {
    return reply.header('Cache-Control', 'no-store').status(200).send(await buyerRfqSummary(buyerOf(request)));
  });

  /** Your requests for quotation, newest activity first, with a count per status. */
  app.get('/', { preHandler: requireCustomer }, async (request, reply) => {
    const query = rfqListQuerySchema.parse(request.query);
    const result = await listBuyerRfqs(buyerOf(request), query);
    return reply.header('Cache-Control', 'no-store').status(200).send(result);
  });

  /** Start a draft request for quotation. Needs an Idempotency-Key. Writes an audit entry. */
  app.post(
    '/',
    { preHandler: requireCustomer, config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      assertDrafting(request);
      const input = rfqDraftSchema.parse(request.body ?? {});
      return reply.status(201).send({ rfq: await createDraft(buyerOf(request), input) });
    },
  );

  /**
   * Approved sellers a buyer may pick by name, with whether each would match
   * the category and destination given.
   */
  app.get('/suppliers', { preHandler: requireCustomer }, async (request, reply) => {
    const query = supplierQuery.parse(request.query);
    const buyer = buyerOf(request);
    const suppliers = await searchSuppliers({
      q: query.q,
      categoryId: query.categoryId ?? null,
      destinationCountry: query.country ?? null,
      customerProfileId: buyer.customerProfileId,
    });
    return reply.header('Cache-Control', 'no-store').status(200).send({ suppliers });
  });

  /** One of your requests: requirement, versions, sellers asked, files and timeline. */
  app.get('/:id', { preHandler: requireCustomer }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const rfq = await getBuyerRfq(buyerOf(request), id);
    return reply.header('Cache-Control', 'no-store').status(200).send({ rfq });
  });

  /** Save a draft again, whole. Conditional on the version it was opened at. */
  app.put(
    '/:id',
    { preHandler: requireCustomer, config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      assertDrafting(request);
      const { id } = idParams.parse(request.params);
      const input = rfqSaveSchema.parse(request.body);
      return reply.status(200).send({ rfq: await saveDraft(buyerOf(request), id, input) });
    },
  );

  /** Delete a draft and its files. A request already sent cannot be deleted. */
  app.delete('/:id', { preHandler: requireCustomer }, async (request, reply) => {
    assertDrafting(request);
    const { id } = idParams.parse(request.params);
    await deleteDraft(buyerOf(request), id);
    return reply.status(204).send();
  });

  /** Which sellers a draft would be sent to now, and whether any match. */
  app.get('/:id/matches', { preHandler: requireCustomer }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const result = await previewMatches(buyerOf(request), id);
    return reply.header('Cache-Control', 'no-store').status(200).send(result);
  });

  /**
   * Send a draft to the matching sellers and any picked by name. Validated
   * again on the server; needs an Idempotency-Key. Writes an audit entry and
   * tells every invited seller.
   */
  app.post(
    '/:id/submit',
    { preHandler: requireCustomer, config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      assertPurchasing(request);
      const { id } = idParams.parse(request.params);
      const input = rfqSubmitSchema.parse(request.body);
      return reply.status(200).send({ rfq: await submitRfq(buyerOf(request), id, input) });
    },
  );

  /** Ask one more approved seller, by name, on a request already sent. */
  app.post(
    '/:id/invitations',
    { preHandler: requireCustomer, config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      assertPurchasing(request);
      const { id } = idParams.parse(request.params);
      const input = rfqInviteSchema.parse(request.body);
      return reply.status(200).send({ rfq: await inviteSupplier(buyerOf(request), id, input) });
    },
  );

  /** Cancel a draft or an open request. Every seller still taking part is told. */
  app.post(
    '/:id/cancel',
    { preHandler: requireCustomer, config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      assertPurchasing(request);
      const { id } = idParams.parse(request.params);
      const input = rfqReasonSchema.parse(request.body);
      return reply.status(200).send({ rfq: await endRfq(buyerOf(request), id, 'CANCELLED', input) });
    },
  );

  /** Close an open request without choosing any quote. */
  app.post(
    '/:id/close',
    { preHandler: requireCustomer, config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      assertPurchasing(request);
      const { id } = idParams.parse(request.params);
      const input = rfqReasonSchema.parse(request.body);
      return reply.status(200).send({ rfq: await endRfq(buyerOf(request), id, 'CLOSED', input) });
    },
  );

  /**
   * Attach a PDF or image to the requirement. Checked by its contents, scanned
   * and stored privately. On a sent request it waits for the next version.
   */
  app.post(
    '/:id/attachments',
    { preHandler: requireCustomer, config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      assertDrafting(request);
      const { id } = idParams.parse(request.params);
      const buyer = buyerOf(request);
      const rfq = await loadRfqForBuyer(buyer, id);
      if (rfq.status !== 'DRAFT' && rfq.status !== 'OPEN') {
        throw new AppError({
          statusCode: 409,
          code: ErrorCode.RFQ_NOT_EDITABLE,
          message: 'Files can only be added to a draft or an open request.',
          details: [{ code: rfq.status }],
        });
      }
      const file = await readUpload(request);
      const attachment = await storeRfqAttachment(
        rfq.id,
        { ...file, purpose: 'REQUIREMENT', sellerAccountId: null },
        { party: 'BUYER', userId: buyer.userId, email: buyer.email },
      );
      return reply.status(201).send({ attachment });
    },
  );

  /** Remove a requirement file that is not yet part of any version sent to sellers. */
  app.delete('/:id/attachments/:attachmentId', { preHandler: requireCustomer }, async (request, reply) => {
    assertDrafting(request);
    const { id, attachmentId } = attachmentParams.parse(request.params);
    const buyer = buyerOf(request);
    const rfq = await loadRfqForBuyer(buyer, id);
    await removePendingAttachment(
      rfq.id,
      attachmentId,
      { uploadedByParty: 'BUYER', quoteVersionId: null },
      { party: 'BUYER', userId: buyer.userId, email: buyer.email },
    );
    return reply.status(204).send();
  });

  /** Download a file on your request. Served as a download, never inline. */
  app.get(
    '/:id/attachments/:attachmentId/download',
    { preHandler: requireCustomer },
    async (request, reply: FastifyReply) => {
      const { id, attachmentId } = attachmentParams.parse(request.params);
      const buyer = buyerOf(request);
      const rfq = await loadRfqForBuyer(buyer, id);
      const file = await readRfqAttachment(rfq.id, attachmentId, {}, {
        party: 'BUYER',
        userId: buyer.userId,
        email: buyer.email,
      });
      return sendAttachment(reply, file);
    },
  );

  /**
   * Publish a new version of a sent requirement, with what changed and why.
   * Every seller still taking part is told. Writes an audit entry.
   */
  app.post(
    '/:id/versions',
    { preHandler: requireCustomer, config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      assertPurchasing(request);
      const { id } = idParams.parse(request.params);
      const input = rfqAmendSchema.parse(request.body);
      return reply.status(200).send({ rfq: await amendRfq(buyerOf(request), id, input) });
    },
  );

  /** Every quote on your request, each with its current offer and its history. */
  app.get('/:id/quotes', { preHandler: requireCustomer }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    return reply.header('Cache-Control', 'no-store').status(200).send({ quotes: await listBuyerQuotes(buyerOf(request), id) });
  });

  /** One quote on your request, with every offer version. */
  app.get('/:id/quotes/:quoteId', { preHandler: requireCustomer }, async (request, reply) => {
    const { id, quoteId } = quoteParams.parse(request.params);
    const quote = await loadQuoteForBuyer(buyerOf(request), id, quoteId);
    return reply.header('Cache-Control', 'no-store').status(200).send({ quote: await quoteView(quote) });
  });

  /** Put a quote on your shortlist, or take it off. Writes an audit entry. */
  app.put('/:id/quotes/:quoteId/shortlist', { preHandler: requireCustomer }, async (request, reply) => {
    assertDrafting(request);
    const { id, quoteId } = quoteParams.parse(request.params);
    const input = shortlistSchema.parse(request.body);
    return reply.status(200).send({ quote: await setShortlist(buyerOf(request), id, quoteId, input) });
  });

  /**
   * The quotes side by side, sortable and filterable, with every figure as
   * quoted and, beside it, converted into `?currency=` at the published rate
   * (source and date given). Missing terms are null, never zero.
   */
  app.get('/:id/comparison', { preHandler: requireCustomer }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const query = comparisonQuerySchema.parse(request.query);
    return reply.header('Cache-Control', 'no-store').status(200).send({ comparison: await buildComparison(buyerOf(request), id, query) });
  });

  /** The same comparison as a CSV file, spreadsheet formulas neutralised. Writes an audit entry. */
  app.get('/:id/comparison.csv', { preHandler: requireCustomer }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const query = comparisonQuerySchema.parse(request.query);
    const file = await comparisonCsv(buyerOf(request), id, query);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .status(200)
      .send(file.content);
  });

  /**
   * Send a counter-offer on a quote: new terms as a new, immutable version.
   * Names the version being answered; refused if it moved. Writes an audit entry.
   */
  app.post(
    '/:id/quotes/:quoteId/offers',
    { preHandler: requireCustomer, config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      assertPurchasing(request);
      const { id, quoteId } = quoteParams.parse(request.params);
      const input = counterSchema.parse(request.body);
      const buyer = buyerOf(request);
      const quote = await loadQuoteForBuyer(buyer, id, quoteId);
      return reply.status(201).send({ quote: await counterOffer(negotiatorOf(buyer), quote.id, input) });
    },
  );

  /**
   * Accept the supplier's offer on the table, naming its terms hash. Awards the
   * request, closes every other quote and freezes the terms. Repeating it is
   * answered with the same result. Writes an audit entry.
   */
  app.post(
    '/:id/quotes/:quoteId/accept',
    { preHandler: requireCustomer, config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      assertPurchasing(request);
      const { id, quoteId } = quoteParams.parse(request.params);
      const input = acceptSchema.parse(request.body);
      const buyer = buyerOf(request);
      const quote = await loadQuoteForBuyer(buyer, id, quoteId);
      return reply.status(200).send({ quote: await acceptOffer(negotiatorOf(buyer), quote.id, input) });
    },
  );

  /** Reject the supplier's offer on the table; the quote closes as rejected. */
  app.post(
    '/:id/quotes/:quoteId/reject',
    { preHandler: requireCustomer, config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      assertPurchasing(request);
      const { id, quoteId } = quoteParams.parse(request.params);
      const input = rejectSchema.parse(request.body);
      const buyer = buyerOf(request);
      const quote = await loadQuoteForBuyer(buyer, id, quoteId);
      return reply.status(200).send({ quote: await rejectOffer(negotiatorOf(buyer), quote.id, input) });
    },
  );

  /** The terms both sides agreed to, frozen at acceptance, with their hash. */
  app.get('/:id/accepted-terms', { preHandler: requireCustomer }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const rfq = await loadRfqForBuyer(buyerOf(request), id);
    return reply.header('Cache-Control', 'no-store').status(200).send({ acceptedTerms: await acceptedTerms(rfq.id) });
  });

  /** The samples asked for on your request, with their status, evidence and what you may do next. */
  app.get('/:id/samples', { preHandler: requireCustomer }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    return reply.header('Cache-Control', 'no-store').status(200).send({ samples: await listBuyerSamples(buyerOf(request), id) });
  });

  /**
   * Ask a supplier taking part for a sample: quantity, address, date and
   * approval criteria. Needs an Idempotency-Key. Tells the supplier; audited.
   */
  app.post(
    '/:id/samples',
    { preHandler: requireCustomer, config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      assertPurchasing(request);
      const { id } = idParams.parse(request.params);
      const input = sampleCreateSchema.parse(request.body);
      return reply.status(201).send({ sample: await requestSample(buyerOf(request), id, input) });
    },
  );

  /** Cancel a sample request before it is shipped. The supplier is told; audited. */
  app.post(
    '/:id/samples/:sampleId/cancel',
    { preHandler: requireCustomer, config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      assertPurchasing(request);
      const { id, sampleId } = sampleParams.parse(request.params);
      const input = sampleReasonSchema.parse(request.body);
      return reply.status(200).send({ sample: await buyerMoveSample(buyerOf(request), id, sampleId, 'CANCELLED', input) });
    },
  );

  /** Confirm a shipped sample arrived. Only you can say it did; audited. */
  app.post(
    '/:id/samples/:sampleId/receive',
    { preHandler: requireCustomer, config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      assertPurchasing(request);
      const { id, sampleId } = sampleParams.parse(request.params);
      const input = sampleReasonSchema.parse(request.body);
      return reply.status(200).send({ sample: await buyerMoveSample(buyerOf(request), id, sampleId, 'DELIVERED', input) });
    },
  );

  /** Approve a delivered sample against its criteria; it becomes the reference sample. Audited. */
  app.post(
    '/:id/samples/:sampleId/approve',
    { preHandler: requireCustomer, config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      assertPurchasing(request);
      const { id, sampleId } = sampleParams.parse(request.params);
      const input = sampleReasonSchema.parse(request.body);
      return reply.status(200).send({ sample: await buyerMoveSample(buyerOf(request), id, sampleId, 'APPROVED', input) });
    },
  );

  /** Reject a delivered sample, with a reason the supplier reads. Audited. */
  app.post(
    '/:id/samples/:sampleId/reject',
    { preHandler: requireCustomer, config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      assertPurchasing(request);
      const { id, sampleId } = sampleParams.parse(request.params);
      const input = sampleReasonSchema.parse(request.body);
      return reply.status(200).send({ sample: await buyerMoveSample(buyerOf(request), id, sampleId, 'REJECTED', input) });
    },
  );

  /** Attach evidence about a sample: a photograph, a test report. Seen by you and that supplier. */
  app.post(
    '/:id/samples/:sampleId/attachments',
    { preHandler: requireCustomer, config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      assertDrafting(request);
      const { id, sampleId } = sampleParams.parse(request.params);
      const buyer = buyerOf(request);
      const rfq = await loadRfqForBuyer(buyer, id);
      const sample = await sampleForEvidence(rfq.id, sampleId);
      const file = await readUpload(request);
      const attachment = await storeRfqAttachment(
        rfq.id,
        { ...file, purpose: 'SAMPLE', sellerAccountId: sample.sellerAccountId },
        { party: 'BUYER', userId: buyer.userId, email: buyer.email },
      );
      await attachEvidence(attachment.id, sample.id);
      return reply.status(201).send({ attachment });
    },
  );

  /** The thread with one invited seller, oldest first; `?after=` for only new ones. */
  app.get('/:id/invitations/:invitationId/messages', { preHandler: requireCustomer }, async (request, reply) => {
    const { id, invitationId } = invitationParams.parse(request.params);
    const { after } = threadQuerySchema.parse(request.query);
    const invitation = await invitationForBuyer(buyerOf(request), id, invitationId);
    return reply
      .header('Cache-Control', 'no-store')
      .status(200)
      .send({ messages: await listThread(id, invitation.sellerAccountId, 'BUYER', after) });
  });

  /** Write to one invited seller. A resend with the same clientMessageId is not a second message. */
  app.post(
    '/:id/invitations/:invitationId/messages',
    { preHandler: requireCustomer, config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      assertDrafting(request);
      const { id, invitationId } = invitationParams.parse(request.params);
      const body = messageBodySchema.parse(request.body);
      const buyer = buyerOf(request);
      const invitation = await invitationForBuyer(buyer, id, invitationId);
      const rfq = await loadRfqForBuyer(buyer, id);
      const message = await postMessage({
        rfq,
        sellerAccountId: invitation.sellerAccountId,
        invitationStatus: invitation.status,
        party: 'BUYER',
        userId: buyer.userId,
        body,
      });
      return reply.status(201).send({ message });
    },
  );

  return Promise.resolve();
}

function negotiatorOf(buyer: RfqBuyer): Negotiator {
  return { party: 'BUYER', userId: buyer.userId, email: buyer.email };
}

const sampleParams = z.object({ id: z.string().length(26), sampleId: z.string().length(26) });

const quoteParams = z.object({ id: z.string().length(26), quoteId: z.string().length(26) });

const invitationParams = z.object({ id: z.string().length(26), invitationId: z.string().length(26) });

/** An invitation on one of the buyer's own requests; anything else is "not found". */
async function invitationForBuyer(buyer: RfqBuyer, rfqId: string, invitationId: string) {
  const rfq = await loadRfqForBuyer(buyer, rfqId);
  const invitation = await prisma.rfqInvitation.findFirst({ where: { id: invitationId, rfqId: rfq.id } });
  if (invitation === null) rfqNotFound();
  return invitation;
}
