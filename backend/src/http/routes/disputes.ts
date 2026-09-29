/**
 * Disputes, for all three audiences.
 *
 * - **Storefront** (`/disputes`): a signed-in buyer raises a claim on an order
 *   or one line of it, follows it, adds evidence, writes, escalates, withdraws
 *   and appeals. Orders are those the Orders page shows this session.
 * - **Seller Hub** (`/seller/disputes`): a seller member reads the claims on
 *   their goods (`seller.order.read`) and answers them, with evidence and an
 *   offer (`seller.return.handle`).
 * - **Staff** (`/admin/disputes`): the dispute console - queue, SLA flags,
 *   assignment, notes, both sides' evidence, the decision and its approval.
 *
 * Each surface builds its actor from its own verified guard, never from the
 * body. The rules live in `modules/disputes/`; this file validates and routes.
 * Chargebacks have no route of their own: they arrive as signature-verified
 * payment webhooks (see `routes/payments.ts`) and are read here by staff.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import {
  DisputeReasonValues,
  DisputeRemedyValues,
  DisputeResolutionValues,
  DisputeStatusValues,
} from '../../domain/dispute-state.js';
import { ErrorCode, badRequest } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { IdempotencyScope, runIdempotent } from '../../modules/orders/idempotency.service.js';
import {
  REFERENCE_PATTERN,
  type BuyerActor,
  type SellerActor,
  type StaffActor,
} from '../../modules/disputes/dispute-common.js';
import {
  createDisputeEvidenceLink,
  redeemDisputeEvidenceLink,
  uploadDisputeEvidence,
} from '../../modules/disputes/dispute-evidence.service.js';
import {
  disputeSettingsInput,
  readDisputeSettings,
  saveDisputeSettings,
  settingsView,
} from '../../modules/disputes/dispute-settings.service.js';
import {
  addPartyMessage,
  addStaffMessage,
  addStaffNote,
  appealDecision,
  approveDecision,
  assignDispute,
  createClaim,
  decideDispute,
  escalateClaim,
  listDisputeAssignees,
  listDisputesForAdmin,
  listPartyDisputes,
  previewDecision,
  readClaimContext,
  readDisputeForAdmin,
  readPartyDispute,
  refuseDecision,
  respondAsSeller,
  startReview,
  withdrawClaim,
} from '../../modules/disputes/dispute.service.js';
import { currentUser, orderScopeWhere, requireAdmin, requireCustomer } from '../plugins/auth.js';
import { currentSeller, requireSeller } from '../plugins/seller.js';
import { sendAttachment } from './preorder-chats.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const referenceParams = z.object({ reference: z.string().trim().regex(REFERENCE_PATTERN) });
const attachmentParams = z.object({
  reference: z.string().trim().regex(REFERENCE_PATTERN),
  attachmentId: z.string().length(26),
});
const idParams = z.object({ id: z.string().length(26) });
const staffAttachmentParams = z.object({ id: z.string().length(26), attachmentId: z.string().length(26) });
const tokenQuery = z.object({ token: z.string().min(16).max(128) });

const minor = z.string().trim().max(24).nullable().optional();

const claimBody = z.object({
  orderId: z.string().length(26),
  orderItemId: z.string().length(26).nullable().optional(),
  reasonCode: z.enum(DisputeReasonValues),
  description: z.string().max(20_000),
  desiredOutcome: z.enum(DisputeRemedyValues),
  requestedAmountMinor: minor,
});

const messageBody = z.object({ body: z.string().max(20_000) });

const partyListQuery = z.object({
  orderId: z.string().length(26).optional(),
  status: z.enum(['OPEN', 'CLOSED']).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const responseBody = z.object({
  body: z.string().max(20_000),
  proposal: z.enum(DisputeRemedyValues).nullable().optional(),
  proposalAmountMinor: minor,
});

const adminListQuery = z.object({
  status: z.enum([...DisputeStatusValues, 'OPEN']).optional(),
  kind: z.enum(['CLAIM', 'CHARGEBACK']).optional(),
  breached: z.enum(['true', 'false']).optional(),
  assignee: z.union([z.literal('me'), z.literal('unassigned'), z.string().length(26)]).optional(),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const staffMessageBody = z.object({
  body: z.string().max(20_000),
  audience: z.enum(['BUYER', 'SELLER', 'BOTH']),
});

const noteBody = z.object({
  body: z.string().max(20_000),
  kind: z.enum(['INTERNAL_NOTE', 'EVIDENCE_NOTE']).default('INTERNAL_NOTE'),
});

const decisionBody = z.object({
  resolution: z.enum(DisputeResolutionValues),
  amountMinor: minor,
  reason: z.string().max(4000),
});

const previewQuery = z.object({
  resolution: z.enum(DisputeResolutionValues),
  amountMinor: z.string().trim().max(24).optional(),
});

const refuseBody = z.object({ reason: z.string().max(4000) });
const assignBody = z.object({ assigneeUserId: z.string().length(26).nullable() });

function idempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw badRequest(ErrorCode.IDEMPOTENCY_KEY_REQUIRED, 'Send an Idempotency-Key header with this request.', [
      { field: 'Idempotency-Key', code: 'REQUIRED' },
    ]);
  }
  return key.trim().slice(0, 128);
}

async function readUpload(request: FastifyRequest): Promise<{ bytes: Buffer; fileName: string }> {
  const upload = await request.file({ limits: { fileSize: env.SUPPORT_ATTACHMENT_MAX_BYTES, files: 1 } });
  if (upload === undefined) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'No file was attached.', [{ field: 'file', code: 'REQUIRED' }]);
  }
  return { bytes: await upload.toBuffer(), fileName: upload.filename };
}

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

function buyerActor(request: FastifyRequest): BuyerActor {
  const auth = currentUser(request);
  return {
    side: 'BUYER',
    userId: auth.id,
    email: auth.email,
    customerProfileId: auth.customerProfileId ?? '',
    orderScope: orderScopeWhere(request),
    ipAddress: request.ip,
    correlationId: request.correlationId,
  };
}

function sellerActor(request: FastifyRequest): SellerActor {
  const auth = currentUser(request);
  const seller = currentSeller(request);
  return {
    side: 'SELLER',
    userId: auth.id,
    email: auth.email,
    sellerAccountId: seller.sellerAccountId,
    canRespond: seller.permissions.has(SellerPermission.RETURN_HANDLE),
    ipAddress: request.ip,
    correlationId: request.correlationId,
  };
}

function staffActor(request: FastifyRequest): StaffActor {
  const auth = currentUser(request);
  return {
    side: 'STAFF',
    userId: auth.id,
    email: auth.email,
    permissions: new Set(auth.permissions),
    ipAddress: request.ip,
    correlationId: request.correlationId,
  };
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('Cache-Control', 'no-store');
}

// ---------------------------------------------------------------------------
// Storefront
// ---------------------------------------------------------------------------

export function registerCustomerDisputeRoutes(app: FastifyInstance): Promise<void> {
  // What the claim form needs: the reasons offered, the windows and the file rules.
  app.get('/context', { preHandler: requireCustomer }, async (_request, reply) => {
    return noStore(reply).status(200).send(await readClaimContext());
  });

  // Raise a claim on one of your orders, or one line of it. Needs an Idempotency-Key.
  app.post(
    '/',
    { preHandler: requireCustomer, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const actor = buyerActor(request);
      const input = claimBody.parse(request.body);
      const result = await runIdempotent({
        scope: IdempotencyScope.DISPUTE_CREATE,
        key: idempotencyKey(request),
        ownerId: actor.userId,
        body: input,
        operation: () => createClaim(actor, input),
      });
      return reply.status(result.httpStatus).send(result.value);
    },
  );

  // Your claims, most recently active first. `orderId` narrows to one order.
  app.get('/', { preHandler: requireCustomer }, async (request, reply) => {
    const query = partyListQuery.parse(request.query);
    return noStore(reply).status(200).send(await listPartyDisputes(buyerActor(request), query));
  });

  // One of your claims: its status, deadlines, decision, evidence and thread.
  app.get('/:reference', { preHandler: requireCustomer }, async (request, reply) => {
    const { reference } = referenceParams.parse(request.params);
    return noStore(reply).status(200).send({ dispute: await readPartyDispute(buyerActor(request), reference) });
  });

  // Write on your claim. The seller and the marketplace see it. Needs an Idempotency-Key.
  app.post(
    '/:reference/messages',
    { preHandler: requireCustomer, config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const actor = buyerActor(request);
      const { reference } = referenceParams.parse(request.params);
      const { body } = messageBody.parse(request.body);
      const result = await runIdempotent({
        scope: IdempotencyScope.DISPUTE_MESSAGE,
        key: idempotencyKey(request),
        ownerId: actor.userId,
        body: { reference, body },
        successStatus: 200,
        operation: async () => ({ dispute: await addPartyMessage(actor, reference, body) }),
      });
      return reply.status(result.httpStatus).send(result.value);
    },
  );

  // Ask the marketplace to decide, once the seller's time to answer has passed.
  app.post('/:reference/escalate', { preHandler: requireCustomer }, async (request, reply) => {
    const { reference } = referenceParams.parse(request.params);
    return reply.status(200).send({ dispute: await escalateClaim(buyerActor(request), reference) });
  });

  // Withdraw your claim. It cannot be reopened.
  app.post('/:reference/withdraw', { preHandler: requireCustomer }, async (request, reply) => {
    const { reference } = referenceParams.parse(request.params);
    return reply.status(200).send({ dispute: await withdrawClaim(buyerActor(request), reference) });
  });

  // Appeal the decision on your claim, once, inside the appeal window.
  app.post('/:reference/appeal', { preHandler: requireCustomer }, async (request, reply) => {
    const { reference } = referenceParams.parse(request.params);
    const { body } = messageBody.parse(request.body);
    return reply.status(200).send({ dispute: await appealDecision(buyerActor(request), reference, body) });
  });

  // Attach one image, video or PDF as evidence. Checked by its contents, scanned, stored privately.
  app.post(
    '/:reference/attachments',
    { preHandler: requireCustomer, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { reference } = referenceParams.parse(request.params);
      const upload = await readUpload(request);
      return reply.status(201).send(await uploadDisputeEvidence(buyerActor(request), { reference }, upload));
    },
  );

  // A download link for one file on your claim: five minutes, single use, this session only.
  app.post(
    '/:reference/attachments/:attachmentId/link',
    { preHandler: requireCustomer, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { reference, attachmentId } = attachmentParams.parse(request.params);
      const link = await createDisputeEvidenceLink(
        buyerActor(request),
        { reference },
        attachmentId,
        `/api/v1/disputes/${reference.toUpperCase()}/attachments/${attachmentId}/download`,
      );
      return noStore(reply).status(200).send(link);
    },
  );

  // Redeem a download link. Served as a download, never inline.
  app.get('/:reference/attachments/:attachmentId/download', { preHandler: requireCustomer }, async (request, reply) => {
    const { reference, attachmentId } = attachmentParams.parse(request.params);
    const { token } = tokenQuery.parse(request.query);
    return sendAttachment(reply, await redeemDisputeEvidenceLink(buyerActor(request), { reference }, attachmentId, token));
  });

  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Seller Hub
// ---------------------------------------------------------------------------

export function registerSellerDisputeRoutes(app: FastifyInstance): Promise<void> {
  // Claims on this seller's goods, most recently active first.
  app.get('/disputes', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => {
    const query = partyListQuery.parse(request.query);
    return noStore(reply).status(200).send(await listPartyDisputes(sellerActor(request), query));
  });

  // One claim on this seller's goods, with the buyer's evidence and the thread.
  app.get('/disputes/:reference', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => {
    const { reference } = referenceParams.parse(request.params);
    return noStore(reply).status(200).send({ dispute: await readPartyDispute(sellerActor(request), reference) });
  });

  // Answer a claim: your account and, optionally, what you offer. Moves it to the marketplace's review.
  app.post(
    '/disputes/:reference/response',
    { preHandler: requireSeller(SellerPermission.ORDER_READ), config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { reference } = referenceParams.parse(request.params);
      const input = responseBody.parse(request.body);
      return reply.status(200).send({ dispute: await respondAsSeller(sellerActor(request), reference, input) });
    },
  );

  // Write on a claim. The buyer and the marketplace see it. Needs an Idempotency-Key.
  app.post(
    '/disputes/:reference/messages',
    { preHandler: requireSeller(SellerPermission.ORDER_READ), config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const actor = sellerActor(request);
      const { reference } = referenceParams.parse(request.params);
      const { body } = messageBody.parse(request.body);
      const result = await runIdempotent({
        scope: IdempotencyScope.DISPUTE_MESSAGE,
        key: idempotencyKey(request),
        ownerId: actor.userId,
        body: { reference, body, side: 'SELLER' },
        successStatus: 200,
        operation: async () => ({ dispute: await addPartyMessage(actor, reference, body) }),
      });
      return reply.status(result.httpStatus).send(result.value);
    },
  );

  // Appeal the decision on a claim, once, inside the appeal window.
  app.post('/disputes/:reference/appeal', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => {
    const { reference } = referenceParams.parse(request.params);
    const { body } = messageBody.parse(request.body);
    return reply.status(200).send({ dispute: await appealDecision(sellerActor(request), reference, body) });
  });

  // Attach counter-evidence: one image, video or PDF, scanned and stored privately.
  app.post(
    '/disputes/:reference/attachments',
    { preHandler: requireSeller(SellerPermission.ORDER_READ), config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { reference } = referenceParams.parse(request.params);
      const upload = await readUpload(request);
      return reply.status(201).send(await uploadDisputeEvidence(sellerActor(request), { reference }, upload));
    },
  );

  // A download link for one file on a claim: five minutes, single use, this session only.
  app.post(
    '/disputes/:reference/attachments/:attachmentId/link',
    { preHandler: requireSeller(SellerPermission.ORDER_READ), config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { reference, attachmentId } = attachmentParams.parse(request.params);
      const link = await createDisputeEvidenceLink(
        sellerActor(request),
        { reference },
        attachmentId,
        `/api/v1/seller/disputes/${reference.toUpperCase()}/attachments/${attachmentId}/download`,
      );
      return noStore(reply).status(200).send(link);
    },
  );

  // Redeem a download link. Served as a download, never inline.
  app.get(
    '/disputes/:reference/attachments/:attachmentId/download',
    { preHandler: requireSeller(SellerPermission.ORDER_READ) },
    async (request, reply) => {
      const { reference, attachmentId } = attachmentParams.parse(request.params);
      const { token } = tokenQuery.parse(request.query);
      return sendAttachment(reply, await redeemDisputeEvidenceLink(sellerActor(request), { reference }, attachmentId, token));
    },
  );

  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Staff: the dispute console
// ---------------------------------------------------------------------------

export function registerAdminDisputeRoutes(app: FastifyInstance): Promise<void> {
  // The dispute queue: claims and chargebacks, with counts by status and SLA breach flags.
  app.get('/disputes', { preHandler: requireAdmin(Permission.DISPUTE_VIEW) }, async (request, reply) => {
    const query = adminListQuery.parse(request.query);
    const result = await listDisputesForAdmin(staffActor(request), {
      page: query.page,
      limit: query.limit,
      status: query.status,
      kind: query.kind,
      breached: query.breached === 'true',
      assignee: query.assignee,
      search: query.search,
    });
    return noStore(reply).status(200).send(result);
  });

  // The dispute rules: windows, SLAs, reasons offered and the approval threshold.
  app.get('/disputes/settings', { preHandler: requireAdmin(Permission.DISPUTE_VIEW) }, async (_request, reply) => {
    return noStore(reply).status(200).send({ settings: settingsView(await readDisputeSettings()) });
  });

  // Save the dispute rules. Versioned: a stale form is refused.
  app.put('/disputes/settings', { preHandler: requireAdmin(Permission.SETTINGS_WRITE) }, async (request, reply) => {
    const input = disputeSettingsInput.parse(request.body);
    return reply.status(200).send({ settings: await saveDisputeSettings(staffActor(request), input) });
  });

  // Staff who may be given a dispute.
  app.get('/disputes/assignees', { preHandler: requireAdmin(Permission.DISPUTE_VIEW) }, async (_request, reply) => {
    return reply.status(200).send({ assignees: await listDisputeAssignees() });
  });

  // One dispute in full: both sides, evidence, notes, SLA, the money and what you may do.
  app.get('/disputes/:id', { preHandler: requireAdmin(Permission.DISPUTE_VIEW) }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    return noStore(reply).status(200).send({ dispute: await readDisputeForAdmin(staffActor(request), id) });
  });

  // What a decision would do: the amount, whether it needs approval, each seller's settlement.
  app.get('/disputes/:id/decision-preview', { preHandler: requireAdmin(Permission.DISPUTE_VIEW) }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const query = previewQuery.parse(request.query);
    return noStore(reply).status(200).send({ preview: await previewDecision(staffActor(request), id, query) });
  });

  // Write to the buyer, the seller, or both.
  app.post('/disputes/:id/messages', { preHandler: requireAdmin(Permission.DISPUTE_MANAGE) }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const actor = staffActor(request);
    await addStaffMessage(actor, id, staffMessageBody.parse(request.body));
    return reply.status(200).send({ dispute: await readDisputeForAdmin(actor, id) });
  });

  // An internal note, or an evidence note on a chargeback. Never shown to a party.
  app.post('/disputes/:id/notes', { preHandler: requireAdmin(Permission.DISPUTE_MANAGE) }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const actor = staffActor(request);
    await addStaffNote(actor, id, noteBody.parse(request.body));
    return reply.status(200).send({ dispute: await readDisputeForAdmin(actor, id) });
  });

  // Take a claim into review before the seller's time to answer is up.
  app.post('/disputes/:id/review', { preHandler: requireAdmin(Permission.DISPUTE_MANAGE) }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const actor = staffActor(request);
    await startReview(actor, id);
    return reply.status(200).send({ dispute: await readDisputeForAdmin(actor, id) });
  });

  // Decide a claim, with a mandatory reason. A refund above the threshold waits for a second approver.
  app.post(
    '/disputes/:id/decision',
    { preHandler: requireAdmin(Permission.DISPUTE_MANAGE), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const actor = staffActor(request);
      const result = await decideDispute(actor, id, decisionBody.parse(request.body));
      return reply.status(200).send({ applied: result.applied, dispute: await readDisputeForAdmin(actor, id) });
    },
  );

  // Approve a colleague's refund decision. Never your own.
  app.post(
    '/disputes/:id/decision/approve',
    { preHandler: requireAdmin(Permission.DISPUTE_APPROVE), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const actor = staffActor(request);
      await approveDecision(actor, id);
      return reply.status(200).send({ dispute: await readDisputeForAdmin(actor, id) });
    },
  );

  // Send a colleague's refund decision back, with a reason. Never your own.
  app.post('/disputes/:id/decision/refuse', { preHandler: requireAdmin(Permission.DISPUTE_APPROVE) }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const actor = staffActor(request);
    await refuseDecision(actor, id, refuseBody.parse(request.body).reason);
    return reply.status(200).send({ dispute: await readDisputeForAdmin(actor, id) });
  });

  // Take a dispute, give it to a colleague, or put it back in the queue.
  app.post('/disputes/:id/assignment', { preHandler: requireAdmin(Permission.DISPUTE_VIEW) }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const actor = staffActor(request);
    await assignDispute(actor, id, assignBody.parse(request.body).assigneeUserId);
    return reply.status(200).send({ dispute: await readDisputeForAdmin(actor, id) });
  });

  // Attach a file as the marketplace - an inspection report, a carrier's statement. Both parties see it.
  app.post(
    '/disputes/:id/attachments',
    { preHandler: requireAdmin(Permission.DISPUTE_MANAGE), config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const actor = staffActor(request);
      await uploadDisputeEvidence(actor, { id }, await readUpload(request));
      return reply.status(201).send({ dispute: await readDisputeForAdmin(actor, id) });
    },
  );

  // A download link for one file on a dispute: five minutes, single use, this session only.
  app.post(
    '/disputes/:id/attachments/:attachmentId/link',
    { preHandler: requireAdmin(Permission.DISPUTE_VIEW), config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id, attachmentId } = staffAttachmentParams.parse(request.params);
      const link = await createDisputeEvidenceLink(
        staffActor(request),
        { id },
        attachmentId,
        `/api/v1/admin/disputes/${id}/attachments/${attachmentId}/download`,
      );
      return noStore(reply).status(200).send(link);
    },
  );

  // Redeem a download link. Served as a download, never inline.
  app.get(
    '/disputes/:id/attachments/:attachmentId/download',
    { preHandler: requireAdmin(Permission.DISPUTE_VIEW) },
    async (request, reply) => {
      const { id, attachmentId } = staffAttachmentParams.parse(request.params);
      const { token } = tokenQuery.parse(request.query);
      return sendAttachment(reply, await redeemDisputeEvidenceLink(staffActor(request), { id }, attachmentId, token));
    },
  );

  return Promise.resolve();
}
