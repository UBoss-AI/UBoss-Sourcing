/**
 * Support requests, for all four audiences.
 *
 * - **Storefront** (`/support`): a signed-in buyer, for themselves or for a
 *   company they are buying for.
 * - **Seller Hub** (`/seller/support`): a member of a seller, in the Hub.
 * - **Logistics portal** (`/logistics/support`): a logistics partner's staff.
 * - **Staff** (`/admin/support-tickets`): the console's Support inbox.
 *
 * The three sender surfaces offer the same five routes and differ only in who
 * the sender is. Each builds its `SupportRequester` from its own verified
 * guard - never from the body - and the rules live in
 * `support-ticket.service.ts`; this file only validates and routes.
 *
 * Sending a request needs an `Idempotency-Key`, so a double-click or a network
 * retry sends one request. So does writing again on one.
 *
 * `FEATURE_SUPPORT_TICKETS` refuses sending a NEW request. Reading your own
 * and answering staff stay on, and the staff routes always work.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import { z } from 'zod';
import { ErrorCode, badRequest } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import {
  SupportTicketCategoryValues,
  SupportResolutionCodeValues,
  SupportTicketPriorityValues,
  SupportTicketStatusValues,
} from '../../domain/support-ticket-state.js';
import { IdempotencyScope, runIdempotent } from '../../modules/orders/idempotency.service.js';
import {
  createSupportAttachmentLink,
  redeemSupportAttachmentLink,
  supportAttachmentPolicy,
  uploadRequesterAttachment,
  uploadStaffAttachment,
  type AttachmentViewer,
} from '../../modules/support/support-attachment.service.js';
import { sendAttachment } from './preorder-chats.js';
import {
  SUPPORT_LIMITS,
  addRequesterMessage,
  addSupportInternalNote,
  assignSupportTicket,
  createSupportTicket,
  listOwnSupportTickets,
  listSupportAssignees,
  listSupportTicketsForAdmin,
  loadRequesterAccount,
  readOwnSupportTicket,
  readSupportContext,
  readSupportTicketForAdmin,
  replyToSupportTicket,
  updateSupportTicket,
  type SupportRequester,
  type SupportStaffActor,
} from '../../modules/support/support-ticket.service.js';
import {
  listSupportSlaPolicies,
  saveSupportSlaPolicies,
  slaPoliciesInput,
} from '../../modules/support/support-sla.service.js';
import {
  buyerContextOf,
  currentUser,
  orderScopeWhere,
  requireAdmin,
  requireCustomerBeforeAgreements,
} from '../plugins/auth.js';
import { currentLogistics, requireLogisticsBeforeAgreements } from '../plugins/logistics.js';
import { currentSeller, requireSellerBeforeAgreements } from '../plugins/seller.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * The form. Loose on length here and strict in the service, which counts
 * characters the way a person does and names the field it refuses - these
 * ceilings only stop an absurd body before any work is done.
 */
const createBody = z.object({
  // Optional: the page raises a ticket about the issue only, and the server
  // takes the sender's name from their account.
  name: z
    .string()
    .max(SUPPORT_LIMITS.nameMax * 4)
    .nullable()
    .optional(),
  companyName: z
    .string()
    .max(SUPPORT_LIMITS.companyNameMax * 4)
    .nullable()
    .optional(),
  category: z.enum(SupportTicketCategoryValues),
  subject: z.string().max(SUPPORT_LIMITS.subjectMax * 4),
  message: z.string().max(SUPPORT_LIMITS.messageMax * 4),
  orderNumber: z.string().max(SUPPORT_LIMITS.orderNumberMax).nullable().optional(),
  language: z.string().trim().min(2).max(10).nullable().optional(),
});

const messageBody = z.object({
  body: z.string().max(SUPPORT_LIMITS.messageMax * 4),
});

const referenceParams = z.object({
  reference: z
    .string()
    .trim()
    .regex(/^SR-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}$/),
});

const ownListQuery = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

function idempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw badRequest(
      ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
      'Send an Idempotency-Key header with this request.',
      [{ field: 'Idempotency-Key', code: 'REQUIRED' }],
    );
  }
  return key.trim().slice(0, 128);
}

// ---------------------------------------------------------------------------
// Who is asking - one builder per surface, each from its own guard
// ---------------------------------------------------------------------------

async function storefrontRequester(request: FastifyRequest): Promise<SupportRequester> {
  const auth = currentUser(request);
  const profileId = auth.customerProfileId ?? '';
  const context = buyerContextOf(request);
  const account = await loadRequesterAccount(auth.id, profileId);

  return {
    userId: auth.id,
    email: account.email,
    emailVerified: account.emailVerified,
    source: 'STOREFRONT',
    role: context.kind === 'COMPANY' ? 'COMPANY_BUYER' : 'BUYER',
    accountName: account.fullName ?? '',
    customerProfileId: profileId,
    buyerCompanyId: context.kind === 'COMPANY' ? context.companyId : null,
    sellerAccountId: null,
    logisticsPartnerId: null,
    fixedCompanyName: context.kind === 'COMPANY' ? context.companyName : null,
    // The same orders the Orders page shows this session - nothing wider.
    orderScope: { kind: 'BUYER', where: orderScopeWhere(request) },
    correlationId: request.correlationId,
    ipAddress: request.ip,
  };
}

async function sellerRequester(request: FastifyRequest): Promise<SupportRequester> {
  const auth = currentUser(request);
  const seller = currentSeller(request);
  const account = await loadRequesterAccount(auth.id, seller.customerProfileId);

  return {
    userId: auth.id,
    email: account.email,
    emailVerified: account.emailVerified,
    source: 'SELLER_HUB',
    role: 'SELLER',
    accountName: account.fullName ?? '',
    customerProfileId: seller.customerProfileId,
    buyerCompanyId: null,
    sellerAccountId: seller.sellerAccountId,
    logisticsPartnerId: null,
    fixedCompanyName: seller.displayName,
    // A member who may not read the seller's orders may not name one either.
    orderScope: {
      kind: 'SELLER',
      sellerAccountId: seller.sellerAccountId,
      canReadOrders: seller.permissions.has(SellerPermission.ORDER_READ),
    },
    correlationId: request.correlationId,
    ipAddress: request.ip,
  };
}

async function logisticsRequester(request: FastifyRequest): Promise<SupportRequester> {
  const auth = currentUser(request);
  const membership = currentLogistics(request);
  const account = await loadRequesterAccount(auth.id, null);

  return {
    userId: auth.id,
    email: account.email,
    emailVerified: account.emailVerified,
    source: 'LOGISTICS_PORTAL',
    role: 'LOGISTICS_PARTNER',
    accountName: membership.fullName,
    customerProfileId: null,
    buyerCompanyId: null,
    sellerAccountId: null,
    logisticsPartnerId: membership.logisticsPartnerId,
    fixedCompanyName: membership.displayName,
    // A carrier's consignments are not orders it may look up by number.
    orderScope: null,
    correlationId: request.correlationId,
    ipAddress: request.ip,
  };
}

// ---------------------------------------------------------------------------
// The five sender routes, written once and mounted three times
// ---------------------------------------------------------------------------

async function sendRequest(requester: SupportRequester, request: FastifyRequest) {
  const input = createBody.parse(request.body);
  return runIdempotent({
    scope: IdempotencyScope.SUPPORT_TICKET_CREATE,
    key: idempotencyKey(request),
    ownerId: requester.userId,
    body: input,
    operation: () => createSupportTicket(requester, input),
  });
}

async function writeAgain(requester: SupportRequester, request: FastifyRequest) {
  const { reference } = referenceParams.parse(request.params);
  const { body } = messageBody.parse(request.body);
  return runIdempotent({
    scope: IdempotencyScope.SUPPORT_TICKET_MESSAGE,
    key: idempotencyKey(request),
    ownerId: requester.userId,
    body: { reference, body },
    successStatus: 200,
    operation: async () => ({ ticket: await addRequesterMessage(requester, reference, body) }),
  });
}

/** The Support page's context, with what it may offer for files. */
async function contextFor(requester: SupportRequester) {
  return { ...(await readSupportContext(requester)), attachments: supportAttachmentPolicy() };
}

const attachmentParams = z.object({
  reference: referenceParams.shape.reference,
  attachmentId: z.string().length(26),
});

const tokenQuery = z.object({ token: z.string().min(16).max(128) });

/** One file, as multipart. The ceiling is the support setting, not the app-wide one. */
async function attachFile(requester: SupportRequester, request: FastifyRequest) {
  const { reference } = referenceParams.parse(request.params);
  const upload = await request.file({
    limits: { fileSize: env.SUPPORT_ATTACHMENT_MAX_BYTES, files: 1 },
  });
  if (upload === undefined) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'No file was attached.', [
      { field: 'file', code: 'REQUIRED' },
    ]);
  }
  const bytes = await upload.toBuffer();
  return uploadRequesterAttachment(requester, reference, { bytes, fileName: upload.filename });
}

async function linkFor(requester: SupportRequester, request: FastifyRequest, base: string) {
  const { reference, attachmentId } = attachmentParams.parse(request.params);
  const viewer: AttachmentViewer = { side: 'REQUESTER', requester, reference };
  return createSupportAttachmentLink(
    viewer,
    attachmentId,
    `${base}/tickets/${reference.toUpperCase()}/attachments/${attachmentId}/download`,
  );
}

async function download(requester: SupportRequester, request: FastifyRequest, reply: FastifyReply) {
  const { reference, attachmentId } = attachmentParams.parse(request.params);
  const { token } = tokenQuery.parse(request.query);
  const file = await redeemSupportAttachmentLink(
    { side: 'REQUESTER', requester, reference },
    attachmentId,
    token,
  );
  return sendAttachment(reply, file);
}

export function registerCustomerSupportRoutes(app: FastifyInstance): Promise<void> {
  // What the Support page needs: whether it takes requests, the contacts and the prefill.
  app.get('/context', { preHandler: requireCustomerBeforeAgreements }, async (request, reply) => {
    const context = await contextFor(await storefrontRequester(request));
    return reply.header('Cache-Control', 'no-store').status(200).send(context);
  });

  // Send a support request. Needs an Idempotency-Key.
  app.post(
    '/tickets',
    { preHandler: requireCustomerBeforeAgreements, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const result = await sendRequest(await storefrontRequester(request), request);
      return reply.status(result.httpStatus).send(result.value);
    },
  );

  // Your own support requests sent from the storefront, most recently active first.
  app.get('/tickets', { preHandler: requireCustomerBeforeAgreements }, async (request, reply) => {
    const query = ownListQuery.parse(request.query);
    const result = await listOwnSupportTickets(await storefrontRequester(request), query);
    return reply.header('Cache-Control', 'no-store').status(200).send(result);
  });

  // One of your support requests and its thread. Somebody else's answers "not found".
  app.get('/tickets/:reference', { preHandler: requireCustomerBeforeAgreements }, async (request, reply) => {
    const { reference } = referenceParams.parse(request.params);
    const ticket = await readOwnSupportTicket(await storefrontRequester(request), reference);
    return reply.header('Cache-Control', 'no-store').status(200).send({ ticket });
  });

  // Write again on one of your requests. Needs an Idempotency-Key.
  app.post(
    '/tickets/:reference/messages',
    { preHandler: requireCustomerBeforeAgreements, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const result = await writeAgain(await storefrontRequester(request), request);
      return reply.status(result.httpStatus).send(result.value);
    },
  );

  // Attach one image, video or PDF to your ticket. Checked by its contents, scanned, stored privately.
  app.post(
    '/tickets/:reference/attachments',
    { preHandler: requireCustomerBeforeAgreements, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const result = await attachFile(await storefrontRequester(request), request);
      return reply.status(201).send(result);
    },
  );

  // A download link for one file on your ticket: five minutes, single use, this session only.
  app.post(
    '/tickets/:reference/attachments/:attachmentId/link',
    { preHandler: requireCustomerBeforeAgreements, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const link = await linkFor(await storefrontRequester(request), request, '/api/v1/support');
      return reply.header('Cache-Control', 'no-store').status(200).send(link);
    },
  );

  // Redeem a download link. Served as a download, never inline.
  app.get(
    '/tickets/:reference/attachments/:attachmentId/download',
    { preHandler: requireCustomerBeforeAgreements },
    async (request, reply) => download(await storefrontRequester(request), request, reply),
  );

  return Promise.resolve();
}

export function registerSellerSupportRoutes(app: FastifyInstance): Promise<void> {
  // What the Seller Hub Support page needs: whether it takes requests, the contacts and the prefill.
  app.get('/support/context', { preHandler: requireSellerBeforeAgreements() }, async (request, reply) => {
    const context = await contextFor(await sellerRequester(request));
    return reply.header('Cache-Control', 'no-store').status(200).send(context);
  });

  // Send a support request from Seller Hub. Needs an Idempotency-Key.
  app.post(
    '/support/tickets',
    { preHandler: requireSellerBeforeAgreements(), config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const result = await sendRequest(await sellerRequester(request), request);
      return reply.status(result.httpStatus).send(result.value);
    },
  );

  // Your own support requests sent from this seller's Hub.
  app.get('/support/tickets', { preHandler: requireSellerBeforeAgreements() }, async (request, reply) => {
    const query = ownListQuery.parse(request.query);
    const result = await listOwnSupportTickets(await sellerRequester(request), query);
    return reply.header('Cache-Control', 'no-store').status(200).send(result);
  });

  // One of your Seller Hub support requests and its thread.
  app.get(
    '/support/tickets/:reference',
    { preHandler: requireSellerBeforeAgreements() },
    async (request, reply) => {
      const { reference } = referenceParams.parse(request.params);
      const ticket = await readOwnSupportTicket(await sellerRequester(request), reference);
      return reply.header('Cache-Control', 'no-store').status(200).send({ ticket });
    },
  );

  // Write again on one of your Seller Hub requests. Needs an Idempotency-Key.
  app.post(
    '/support/tickets/:reference/messages',
    { preHandler: requireSellerBeforeAgreements(), config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const result = await writeAgain(await sellerRequester(request), request);
      return reply.status(result.httpStatus).send(result.value);
    },
  );

  // Attach one image, video or PDF to your ticket. Checked by its contents, scanned, stored privately.
  app.post(
    '/support/tickets/:reference/attachments',
    { preHandler: requireSellerBeforeAgreements(), config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const result = await attachFile(await sellerRequester(request), request);
      return reply.status(201).send(result);
    },
  );

  // A download link for one file on your ticket: five minutes, single use, this session only.
  app.post(
    '/support/tickets/:reference/attachments/:attachmentId/link',
    { preHandler: requireSellerBeforeAgreements(), config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const link = await linkFor(await sellerRequester(request), request, '/api/v1/seller/support');
      return reply.header('Cache-Control', 'no-store').status(200).send(link);
    },
  );

  // Redeem a download link. Served as a download, never inline.
  app.get(
    '/support/tickets/:reference/attachments/:attachmentId/download',
    { preHandler: requireSellerBeforeAgreements() },
    async (request, reply) => download(await sellerRequester(request), request, reply),
  );

  return Promise.resolve();
}

export function registerLogisticsSupportRoutes(app: FastifyInstance): Promise<void> {
  // What the portal's Support page needs: whether it takes requests, the contacts and the prefill.
  app.get('/support/context', { preHandler: requireLogisticsBeforeAgreements() }, async (request, reply) => {
    const context = await contextFor(await logisticsRequester(request));
    return reply.header('Cache-Control', 'no-store').status(200).send(context);
  });

  // Send a support request from the logistics portal. Needs an Idempotency-Key.
  app.post(
    '/support/tickets',
    { preHandler: requireLogisticsBeforeAgreements(), config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const result = await sendRequest(await logisticsRequester(request), request);
      return reply.status(result.httpStatus).send(result.value);
    },
  );

  // Your own support requests sent from the portal for this company.
  app.get('/support/tickets', { preHandler: requireLogisticsBeforeAgreements() }, async (request, reply) => {
    const query = ownListQuery.parse(request.query);
    const result = await listOwnSupportTickets(await logisticsRequester(request), query);
    return reply.header('Cache-Control', 'no-store').status(200).send(result);
  });

  // One of your portal support requests and its thread.
  app.get(
    '/support/tickets/:reference',
    { preHandler: requireLogisticsBeforeAgreements() },
    async (request, reply) => {
      const { reference } = referenceParams.parse(request.params);
      const ticket = await readOwnSupportTicket(await logisticsRequester(request), reference);
      return reply.header('Cache-Control', 'no-store').status(200).send({ ticket });
    },
  );

  // Write again on one of your portal requests. Needs an Idempotency-Key.
  app.post(
    '/support/tickets/:reference/messages',
    {
      preHandler: requireLogisticsBeforeAgreements(),
      config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      const result = await writeAgain(await logisticsRequester(request), request);
      return reply.status(result.httpStatus).send(result.value);
    },
  );

  // Attach one image, video or PDF to your ticket. Checked by its contents, scanned, stored privately.
  app.post(
    '/support/tickets/:reference/attachments',
    {
      preHandler: requireLogisticsBeforeAgreements(),
      config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      const result = await attachFile(await logisticsRequester(request), request);
      return reply.status(201).send(result);
    },
  );

  // A download link for one file on your ticket: five minutes, single use, this session only.
  app.post(
    '/support/tickets/:reference/attachments/:attachmentId/link',
    { preHandler: requireLogisticsBeforeAgreements(), config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const link = await linkFor(
        await logisticsRequester(request),
        request,
        '/api/v1/logistics/support',
      );
      return reply.header('Cache-Control', 'no-store').status(200).send(link);
    },
  );

  // Redeem a download link. Served as a download, never inline.
  app.get(
    '/support/tickets/:reference/attachments/:attachmentId/download',
    { preHandler: requireLogisticsBeforeAgreements() },
    async (request, reply) => download(await logisticsRequester(request), request, reply),
  );

  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

function staffActor(request: FastifyRequest): SupportStaffActor {
  const auth = currentUser(request);
  return {
    userId: auth.id,
    email: auth.email,
    permissions: new Set(auth.permissions),
    ipAddress: request.ip,
    correlationId: request.correlationId,
  };
}

const ticketIdParams = z.object({ id: z.string().length(26) });

const adminListQuery = z.object({
  status: z.enum([...SupportTicketStatusValues, 'WORKING']).optional(),
  priority: z.enum(SupportTicketPriorityValues).optional(),
  category: z.enum(SupportTicketCategoryValues).optional(),
  source: z.enum(['STOREFRONT', 'SELLER_HUB', 'LOGISTICS_PORTAL']).optional(),
  assignee: z.union([z.literal('me'), z.literal('unassigned'), z.string().length(26)]).optional(),
  search: z.string().trim().max(120).optional(),
  /** `true`: only requests past a service-level deadline they still wait on. */
  breached: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const replyBody = z.object({
  body: z.string().max(SUPPORT_LIMITS.messageMax * 4),
  nextStatus: z.enum(SupportTicketStatusValues).nullable().optional(),
  resolutionCode: z.enum(SupportResolutionCodeValues).nullable().optional(),
});

const updateBody = z
  .object({
    status: z.enum(SupportTicketStatusValues).optional(),
    priority: z.enum(SupportTicketPriorityValues).optional(),
    resolutionCode: z.enum(SupportResolutionCodeValues).optional(),
  })
  .refine(
    (value) =>
      value.status !== undefined || value.priority !== undefined || value.resolutionCode !== undefined,
    { message: 'Send a status, a priority or a resolution code.' },
  );

const staffAttachmentParams = z.object({
  id: z.string().length(26),
  attachmentId: z.string().length(26),
});

const assignBody = z.object({ assigneeUserId: z.string().length(26).nullable() });

export function registerAdminSupportRoutes(app: FastifyInstance): Promise<void> {
  // The Support inbox: every request, most recently active first, with counts by status.
  app.get(
    '/support-tickets',
    { preHandler: requireAdmin(Permission.SUPPORT_TICKET_VIEW) },
    async (request, reply) => {
      const query = adminListQuery.parse(request.query);
      const result = await listSupportTicketsForAdmin(staffActor(request), {
        page: query.page,
        limit: query.limit,
        status: query.status,
        priority: query.priority,
        category: query.category,
        source: query.source,
        assignee: query.assignee,
        search: query.search,
        breached: query.breached === 'true',
      });
      return reply.header('Cache-Control', 'no-store').status(200).send(result);
    },
  );

  // The first-response and resolution targets for every support category.
  app.get(
    '/support-tickets/sla-policies',
    { preHandler: requireAdmin(Permission.SUPPORT_TICKET_VIEW) },
    async (_request, reply) => {
      return reply.status(200).send({ policies: await listSupportSlaPolicies() });
    },
  );

  // Set the first-response and resolution targets for one or more categories.
  app.put(
    '/support-tickets/sla-policies',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE) },
    async (request, reply) => {
      const input = slaPoliciesInput.parse(request.body);
      const policies = await saveSupportSlaPolicies(staffActor(request), input);
      return reply.status(200).send({ policies });
    },
  );

  // Attach one image, video or PDF to a ticket as the team. The sender sees it.
  app.post(
    '/support-tickets/:id/attachments',
    {
      preHandler: requireAdmin(Permission.SUPPORT_TICKET_REPLY),
      config: { rateLimit: { max: 30, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      const { id } = ticketIdParams.parse(request.params);
      const upload = await request.file({
        limits: { fileSize: env.SUPPORT_ATTACHMENT_MAX_BYTES, files: 1 },
      });
      if (upload === undefined) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'No file was attached.', [
          { field: 'file', code: 'REQUIRED' },
        ]);
      }
      const actor = staffActor(request);
      await uploadStaffAttachment(actor, id, { bytes: await upload.toBuffer(), fileName: upload.filename });
      return reply.status(201).send({ ticket: await readSupportTicketForAdmin(actor, id) });
    },
  );

  // Staff who may be given a support request.
  app.get(
    '/support-tickets/assignees',
    { preHandler: requireAdmin(Permission.SUPPORT_TICKET_VIEW) },
    async (_request, reply) => {
      return reply.status(200).send({ assignees: await listSupportAssignees() });
    },
  );

  // One request in full: who sent it, for whom, its thread and internal notes, and its history.
  app.get(
    '/support-tickets/:id',
    { preHandler: requireAdmin(Permission.SUPPORT_TICKET_VIEW) },
    async (request, reply) => {
      const { id } = ticketIdParams.parse(request.params);
      const ticket = await readSupportTicketForAdmin(staffActor(request), id);
      return reply.header('Cache-Control', 'no-store').status(200).send({ ticket });
    },
  );

  // Answer the sender. They are emailed that there is a reply; optionally move the status too.
  app.post(
    '/support-tickets/:id/replies',
    { preHandler: requireAdmin(Permission.SUPPORT_TICKET_REPLY) },
    async (request, reply) => {
      const { id } = ticketIdParams.parse(request.params);
      const body = replyBody.parse(request.body);
      const actor = staffActor(request);
      const result = await replyToSupportTicket(actor, id, body);
      const ticket = await readSupportTicketForAdmin(actor, id);
      return reply.status(200).send({ ticket, emailQueued: result.emailQueued });
    },
  );

  // Write an internal note. Never shown to the sender.
  app.post(
    '/support-tickets/:id/notes',
    { preHandler: requireAdmin(Permission.SUPPORT_TICKET_REPLY) },
    async (request, reply) => {
      const { id } = ticketIdParams.parse(request.params);
      const { body } = messageBody.parse(request.body);
      const actor = staffActor(request);
      await addSupportInternalNote(actor, id, body);
      return reply.status(200).send({ ticket: await readSupportTicketForAdmin(actor, id) });
    },
  );

  // Change a request's status, its priority, or both.
  app.patch(
    '/support-tickets/:id',
    { preHandler: requireAdmin(Permission.SUPPORT_TICKET_REPLY) },
    async (request, reply) => {
      const { id } = ticketIdParams.parse(request.params);
      const body = updateBody.parse(request.body);
      const actor = staffActor(request);
      await updateSupportTicket(actor, id, body);
      return reply.status(200).send({ ticket: await readSupportTicketForAdmin(actor, id) });
    },
  );

  // A download link for one file on a ticket: five minutes, single use, this session only.
  app.post(
    '/support-tickets/:id/attachments/:attachmentId/link',
    {
      preHandler: requireAdmin(Permission.SUPPORT_TICKET_VIEW),
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { id, attachmentId } = staffAttachmentParams.parse(request.params);
      const actor = staffActor(request);
      const link = await createSupportAttachmentLink(
        { side: 'STAFF', userId: actor.userId, email: actor.email, ticketId: id },
        attachmentId,
        `/api/v1/admin/support-tickets/${id}/attachments/${attachmentId}/download`,
      );
      return reply.header('Cache-Control', 'no-store').status(200).send(link);
    },
  );

  // Redeem a download link. Served as a download, never inline.
  app.get(
    '/support-tickets/:id/attachments/:attachmentId/download',
    { preHandler: requireAdmin(Permission.SUPPORT_TICKET_VIEW) },
    async (request, reply) => {
      const { id, attachmentId } = staffAttachmentParams.parse(request.params);
      const { token } = tokenQuery.parse(request.query);
      const actor = staffActor(request);
      const file = await redeemSupportAttachmentLink(
        {
          side: 'STAFF',
          userId: actor.userId,
          email: actor.email,
          ticketId: id,
          ipAddress: actor.ipAddress ?? null,
          correlationId: actor.correlationId ?? null,
        },
        attachmentId,
        token,
      );
      return sendAttachment(reply, file);
    },
  );

  // Take a request, give it to a colleague, or put it back in the queue.
  app.post(
    '/support-tickets/:id/assignment',
    { preHandler: requireAdmin(Permission.SUPPORT_TICKET_VIEW) },
    async (request, reply) => {
      const { id } = ticketIdParams.parse(request.params);
      const { assigneeUserId } = assignBody.parse(request.body);
      const actor = staffActor(request);
      await assignSupportTicket(actor, id, assigneeUserId);
      return reply.status(200).send({ ticket: await readSupportTicketForAdmin(actor, id) });
    },
  );

  return Promise.resolve();
}
