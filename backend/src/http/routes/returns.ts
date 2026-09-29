/**
 * Returns, on all three surfaces.
 *
 *   - Storefront (`/api/v1/...`): a buyer asks to return lines of their own
 *     order, with a reason code and photographs, and follows it to the refund.
 *   - Seller Hub (`/api/v1/seller/...`): the seller of those goods answers it,
 *     says how they come back, and records their arrival and inspection.
 *   - Console (`/api/v1/admin/...`): staff decide it, and issue the refund
 *     through the ordinary refund path.
 *
 * Rules live in `modules/returns/return.service.ts`. This file turns requests
 * into its calls: who is asking, from which scope, with which files.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import { RETURN_REASON_CODES, ReturnStatusValues } from '../../domain/return-state.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { IdempotencyScope, runIdempotent } from '../../modules/orders/idempotency.service.js';
import {
  RETURN_FILES_PER_REQUEST,
  createReturnFileLink,
  prepareReturnFile,
  redeemReturnFileLink,
  type PreparedFile,
} from '../../modules/returns/return-files.service.js';
import {
  addReturnFiles,
  approveReturn,
  buyerReturnId,
  completeWithReplacement,
  createBuyerReturn,
  createStaffReturn,
  inspectReturn,
  listBuyerReturns,
  listSellerReturns,
  listStaffReturns,
  readBuyerReturn,
  readReturnEligibility,
  readSellerReturn,
  readStaffReturn,
  receiveReturn,
  refundReturn,
  rejectReturn,
  respondAsSeller,
  sellerReturnId,
  setReturnInstructions,
  staffReturnId,
  type BuyerActor,
  type SellerActor,
  type StaffActor,
} from '../../modules/returns/return.service.js';
import {
  getReturnPolicy,
  returnPolicyInput,
  updateReturnPolicy,
} from '../../modules/returns/return-settings.service.js';
import { currentUser, orderScopeWhere, requireAdmin, requireCustomer } from '../plugins/auth.js';
import { currentSeller, requireSeller } from '../plugins/seller.js';
import { sendAttachment } from './preorder-chats.js';

const idParam = z.object({ id: z.string().length(26) });
const fileParams = z.object({ id: z.string().length(26), fileId: z.string().length(26) });
const tokenQuery = z.object({ token: z.string().min(16).max(128) });

const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum([...ReturnStatusValues, 'OPEN']).optional(),
  orderId: z.string().length(26).optional(),
});

const requestBody = z.object({
  reasonCode: z.enum(RETURN_REASON_CODES),
  description: z.string().trim().max(512).nullable().optional(),
  preferredResolution: z.enum(['REFUND', 'REPLACEMENT']).optional(),
  items: z
    .array(
      z.object({
        orderItemId: z.string().length(26),
        quantity: z.number().int().min(1).max(1_000_000),
      }),
    )
    .min(1)
    .max(200),
});

const inspectBody = z.object({
  outcome: z
    .array(
      z.object({
        orderItemId: z.string().length(26),
        sellableQty: z.number().int().min(0).max(1_000_000),
        damagedQty: z.number().int().min(0).max(1_000_000),
      }),
    )
    .min(1)
    .max(200),
  note: z.string().trim().max(512).nullable().optional(),
});

const instructionsBody = z.object({ instructions: z.string().trim().min(1).max(4000) });

function idempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw badRequest(ErrorCode.IDEMPOTENCY_KEY_REQUIRED, 'Send an Idempotency-Key header with this request.', [
      { field: 'Idempotency-Key', code: 'REQUIRED' },
    ]);
  }
  return key.trim().slice(0, 96);
}

function isTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { code?: unknown }).code === 'FST_REQ_FILE_TOO_LARGE' ||
      (error as { statusCode?: unknown }).statusCode === 413)
  );
}

function tooLarge(): never {
  throw badRequest(
    ErrorCode.MEDIA_TOO_LARGE,
    `Files can be up to ${(env.RETURN_FILE_MAX_BYTES / 1_048_576).toFixed(0)} MB.`,
    [{ field: 'file', code: 'FILE_TOO_LARGE', meta: { maxBytes: env.RETURN_FILE_MAX_BYTES } }],
  );
}

/**
 * A request's JSON and files. Multipart carries a `payload` field of JSON and
 * up to six `files`; a plain JSON body is a request without files. Every file
 * is checked for type and size here, before any rule runs or anything is
 * stored.
 */
async function readPayloadAndFiles(
  request: FastifyRequest,
  maxFiles: number,
): Promise<{ payload: unknown; files: PreparedFile[] }> {
  if (!request.isMultipart()) return { payload: request.body, files: [] };

  let payload: unknown = undefined;
  const files: PreparedFile[] = [];
  try {
    const parts = request.parts({
      limits: { files: maxFiles, fileSize: env.RETURN_FILE_MAX_BYTES + 1, fields: 5, parts: maxFiles + 5 },
    });
    for await (const part of parts) {
      if (part.type === 'file') {
        const bytes = await part.toBuffer();
        if (part.file.truncated || bytes.length > env.RETURN_FILE_MAX_BYTES) tooLarge();
        files.push(prepareReturnFile({ bytes, fileName: part.filename }));
      } else if (part.fieldname === 'payload' && typeof part.value === 'string') {
        try {
          payload = JSON.parse(part.value) as unknown;
        } catch {
          throw badRequest(ErrorCode.VALIDATION_FAILED, 'The request is not valid JSON.', [
            { field: 'payload', code: 'INVALID_JSON' },
          ]);
        }
      }
    }
  } catch (error) {
    if (isTooLarge(error)) tooLarge();
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'FST_FILES_LIMIT'
    ) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, `Attach up to ${String(maxFiles)} files.`, [
        { field: 'files', code: 'TOO_MANY', meta: { limit: maxFiles } },
      ]);
    }
    throw error;
  }
  return { payload, files };
}

// ---------------------------------------------------------------------------
// Storefront
// ---------------------------------------------------------------------------

function buyerActor(request: FastifyRequest, options: { placedByMe?: boolean } = {}): BuyerActor {
  const auth = currentUser(request);
  return {
    userId: auth.id,
    email: auth.email,
    scope: orderScopeWhere(request, options),
    ipAddress: request.ip,
    correlationId: request.correlationId,
  };
}

export function registerCustomerReturnRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCustomer);

  // What can be returned from one of your orders: the window, the reasons offered and each line's quantity left.
  app.get('/orders/:id/returns/eligibility', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const view = await readReturnEligibility(buyerActor(request).scope, id);
    return reply.header('Cache-Control', 'no-store').status(200).send(view);
  });

  // Ask to return lines of your own delivered order, with a reason and photos. Needs an Idempotency-Key.
  app.post(
    '/orders/:id/returns',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const key = idempotencyKey(request);
      const actor = buyerActor(request, { placedByMe: true });
      const { payload, files } = await readPayloadAndFiles(request, RETURN_FILES_PER_REQUEST);
      const input = requestBody.parse(payload);
      const result = await runIdempotent({
        scope: IdempotencyScope.RETURN_REQUEST_CREATE,
        key,
        ownerId: actor.userId,
        body: { orderId: id, input, files: files.map((file) => file.contentHash) },
        operation: () => createBuyerReturn(actor, id, input, files),
      });
      return reply.status(result.httpStatus).send(result.value);
    },
  );

  // Your returns, newest first. Filter by status (OPEN for everything still being worked) or order.
  app.get('/returns', async (request, reply) => {
    const query = listQuery.parse(request.query);
    const result = await listBuyerReturns(buyerActor(request).scope, query);
    return reply.header('Cache-Control', 'no-store').status(200).send(result);
  });

  // One of your returns with its timeline, files and refund. Somebody else's answers "not found".
  app.get('/returns/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const view = await readBuyerReturn(buyerActor(request).scope, id);
    return reply.header('Cache-Control', 'no-store').status(200).send({ return: view });
  });

  // Add one more photograph or video to your open return. Checked by its contents, scanned, stored privately.
  app.post(
    '/returns/:id/files',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const actor = buyerActor(request);
      const returnId = await buyerReturnId(actor.scope, id);
      const { files } = await readPayloadAndFiles(request, 1);
      if (files.length === 0) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'No file was attached.', [{ field: 'file', code: 'REQUIRED' }]);
      }
      const view = await addReturnFiles({ side: 'BUYER', actor }, returnId, files);
      return reply.status(201).send({ return: view });
    },
  );

  // A five-minute, single-use link to one file of your return.
  app.post('/returns/:id/files/:fileId/link', async (request, reply) => {
    const { id, fileId } = fileParams.parse(request.params);
    const actor = buyerActor(request);
    const returnId = await buyerReturnId(actor.scope, id);
    const link = await createReturnFileLink({
      side: 'BUYER',
      userId: actor.userId,
      returnRequestId: returnId,
      fileId,
      downloadPath: `/api/v1/returns/${returnId}/files/${fileId}/download`,
    });
    return reply.status(200).send(link);
  });

  // Download a file of your return with a link from the route above. Spent on first use.
  app.get('/returns/:id/files/:fileId/download', async (request, reply) => {
    const { id, fileId } = fileParams.parse(request.params);
    const { token } = tokenQuery.parse(request.query);
    const actor = buyerActor(request);
    const returnId = await buyerReturnId(actor.scope, id);
    const file = await redeemReturnFileLink({
      side: 'BUYER',
      userId: actor.userId,
      email: actor.email,
      auditActorType: 'CUSTOMER',
      returnRequestId: returnId,
      fileId,
      token,
    });
    return sendAttachment(reply, file);
  });

  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Seller Hub
// ---------------------------------------------------------------------------

function sellerActor(request: FastifyRequest): SellerActor {
  const auth = currentUser(request);
  const seller = currentSeller(request);
  return {
    userId: auth.id,
    email: auth.email,
    sellerAccountId: seller.sellerAccountId,
    canHandle: seller.permissions.has(SellerPermission.RETURN_HANDLE),
    ipAddress: request.ip,
    correlationId: request.correlationId,
  };
}

export function registerSellerReturnRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSeller());

  // Returns of your goods, newest first. Filter by status (OPEN for everything still being worked).
  app.get('/returns', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => {
    const query = listQuery.parse(request.query);
    const result = await listSellerReturns(sellerActor(request), query);
    return reply.header('Cache-Control', 'no-store').status(200).send(result);
  });

  // One return of your goods, with the buyer's reason and photos. Another seller's answers "not found".
  app.get('/returns/:id', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const view = await readSellerReturn(sellerActor(request), id);
    return reply.header('Cache-Control', 'no-store').status(200).send({ return: view });
  });

  // Accept or contest a return (contesting needs a note), optionally with how the goods should come back.
  app.post(
    '/returns/:id/response',
    { preHandler: requireSeller(SellerPermission.RETURN_HANDLE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          response: z.enum(['ACCEPT', 'CONTEST']),
          note: z.string().trim().max(2000).nullable().optional(),
          instructions: z.string().trim().max(4000).nullable().optional(),
        })
        .parse(request.body);
      const view = await respondAsSeller(sellerActor(request), id, body);
      return reply.status(200).send({ return: view });
    },
  );

  // Write how the goods should come back to you. The buyer is emailed once the return is approved.
  app.post(
    '/returns/:id/instructions',
    { preHandler: requireSeller(SellerPermission.RETURN_HANDLE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { instructions } = instructionsBody.parse(request.body);
      const view = await setReturnInstructions({ side: 'SELLER', actor: sellerActor(request) }, id, instructions);
      return reply.status(200).send({ return: view });
    },
  );

  // Attach a return label you made at your carrier (PDF or image) to an approved return.
  app.post(
    '/returns/:id/labels',
    { preHandler: requireSeller(SellerPermission.RETURN_HANDLE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const actor = sellerActor(request);
      const returnId = await sellerReturnId(actor, id);
      const { files } = await readPayloadAndFiles(request, 1);
      if (files.length === 0) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'No file was attached.', [{ field: 'file', code: 'REQUIRED' }]);
      }
      const view = await addReturnFiles({ side: 'SELLER', actor }, returnId, files);
      return reply.status(201).send({ return: view });
    },
  );

  // The goods have arrived back with you.
  app.post(
    '/returns/:id/receive',
    { preHandler: requireSeller(SellerPermission.RETURN_HANDLE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ note: z.string().trim().max(512).nullable().optional() }).parse(request.body ?? {});
      const view = await receiveReturn({ side: 'SELLER', actor: sellerActor(request) }, id, body.note ?? null);
      return reply.status(200).send({ return: view });
    },
  );

  // Record how many units came back sellable and how many damaged. Adjust your own stock in Inventory.
  app.post(
    '/returns/:id/inspect',
    { preHandler: requireSeller(SellerPermission.RETURN_HANDLE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = inspectBody.parse(request.body);
      const view = await inspectReturn({ side: 'SELLER', actor: sellerActor(request) }, id, body);
      return reply.status(200).send({ return: view });
    },
  );

  // A five-minute, single-use link to one file of a return of your goods.
  app.post(
    '/returns/:id/files/:fileId/link',
    { preHandler: requireSeller(SellerPermission.ORDER_READ) },
    async (request, reply) => {
      const { id, fileId } = fileParams.parse(request.params);
      const actor = sellerActor(request);
      const returnId = await sellerReturnId(actor, id);
      const link = await createReturnFileLink({
        side: 'SELLER',
        userId: actor.userId,
        returnRequestId: returnId,
        fileId,
        downloadPath: `/api/v1/seller/returns/${returnId}/files/${fileId}/download`,
      });
      return reply.status(200).send(link);
    },
  );

  // Download a file of a return of your goods with a link from the route above.
  app.get(
    '/returns/:id/files/:fileId/download',
    { preHandler: requireSeller(SellerPermission.ORDER_READ) },
    async (request, reply) => {
      const { id, fileId } = fileParams.parse(request.params);
      const { token } = tokenQuery.parse(request.query);
      const actor = sellerActor(request);
      const returnId = await sellerReturnId(actor, id);
      const file = await redeemReturnFileLink({
        side: 'SELLER',
        userId: actor.userId,
        email: actor.email,
        auditActorType: 'CUSTOMER',
        returnRequestId: returnId,
        fileId,
        token,
      });
      return sendAttachment(reply, file);
    },
  );

  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

function staffActor(request: FastifyRequest): StaffActor {
  const auth = currentUser(request);
  return {
    userId: auth.id,
    email: auth.email,
    permissions: auth.permissions,
    ipAddress: request.ip,
    correlationId: request.correlationId,
  };
}

async function sendStaffView(reply: FastifyReply, view: unknown, status = 200): Promise<FastifyReply> {
  return reply.status(status).send({ return: view });
}

export function registerAdminReturnRoutes(app: FastifyInstance): Promise<void> {
  // Returns, newest first, a page at a time. Filter by status (OPEN for everything still being worked) or order.
  app.get('/returns', { preHandler: requireAdmin(Permission.ORDER_READ) }, async (request, reply) => {
    const query = listQuery.parse(request.query);
    return reply.header('Cache-Control', 'no-store').status(200).send(await listStaffReturns(query));
  });

  // One return in full: lines, the buyer's reason and photos, the seller's answer, the timeline and any refund.
  app.get('/returns/:id', { preHandler: requireAdmin(Permission.ORDER_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.header('Cache-Control', 'no-store').status(200).send({ return: await readStaffReturn(id) });
  });

  // The return policy: window in days, reason codes offered, which need a photo, replacements, instructions.
  app.get('/return-settings', { preHandler: requireAdmin(Permission.ORDER_READ) }, async (_request, reply) =>
    reply.status(200).send({ policy: await getReturnPolicy() }),
  );

  // Change the return policy. Writes an audit entry.
  app.put('/return-settings', { preHandler: requireAdmin(Permission.SETTINGS_WRITE) }, async (request, reply) => {
    const body = returnPolicyInput.parse(request.body);
    const auth = currentUser(request);
    const policy = await updateReturnPolicy(body, {
      userId: auth.id,
      email: auth.email,
      ipAddress: request.ip,
      correlationId: request.correlationId,
    });
    return reply.status(200).send({ policy });
  });

  // Record a return for a buyer (a call, an email), with a reason code and quantities. Not bound by the window.
  app.post(
    '/orders/:id/returns',
    { preHandler: requireAdmin(Permission.ORDER_RETURN) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = requestBody
        .extend({
          reasonCode: z.enum(RETURN_REASON_CODES).default('OTHER'),
          // The field staff used before reason codes; kept as the description.
          reason: z.string().trim().max(512).optional(),
        })
        .parse(request.body);
      const result = await createStaffReturn(staffActor(request), id, {
        reasonCode: body.reasonCode,
        description: body.description ?? body.reason ?? null,
        ...(body.preferredResolution !== undefined ? { preferredResolution: body.preferredResolution } : {}),
        items: body.items,
      });
      return reply.status(201).send(result);
    },
  );

  // Approve a requested return, optionally with a note and how the goods should come back.
  app.post(
    '/returns/:id/approve',
    { preHandler: requireAdmin(Permission.ORDER_RETURN) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          note: z.string().trim().max(512).nullable().optional(),
          instructions: z.string().trim().max(4000).nullable().optional(),
        })
        .parse(request.body ?? {});
      return sendStaffView(reply, await approveReturn(staffActor(request), id, body));
    },
  );

  // Reject a return. A reason is required - the buyer is told it. Refused once the return is finished.
  app.post(
    '/returns/:id/reject',
    { preHandler: requireAdmin(Permission.ORDER_RETURN) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          reason: z.string().trim().min(1).max(512).optional(),
          note: z.string().trim().min(1).max(512).optional(),
        })
        .parse(request.body ?? {});
      const reason = body.reason ?? body.note;
      if (reason === undefined) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say why the return is rejected.', [
          { field: 'reason', code: 'REQUIRED' },
        ]);
      }
      return sendStaffView(reply, await rejectReturn(staffActor(request), id, reason));
    },
  );

  // Write or replace how the goods should come back.
  app.post(
    '/returns/:id/instructions',
    { preHandler: requireAdmin(Permission.ORDER_RETURN) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { instructions } = instructionsBody.parse(request.body);
      return sendStaffView(reply, await setReturnInstructions({ side: 'STAFF', actor: staffActor(request) }, id, instructions));
    },
  );

  // Attach a return label (PDF or image) made at the carrier to an approved return.
  app.post(
    '/returns/:id/labels',
    { preHandler: requireAdmin(Permission.ORDER_RETURN) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const returnId = await staffReturnId(id);
      const { files } = await readPayloadAndFiles(request, 1);
      if (files.length === 0) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'No file was attached.', [{ field: 'file', code: 'REQUIRED' }]);
      }
      return sendStaffView(reply, await addReturnFiles({ side: 'STAFF', actor: staffActor(request) }, returnId, files), 201);
    },
  );

  // Record that the goods have arrived back.
  app.post(
    '/returns/:id/receive',
    { preHandler: requireAdmin(Permission.ORDER_RETURN) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ note: z.string().trim().max(512).nullable().optional() }).parse(request.body ?? {});
      return sendStaffView(reply, await receiveReturn({ side: 'STAFF', actor: staffActor(request) }, id, body.note ?? null));
    },
  );

  // Record the inspection: per line, how many are sellable and how many damaged. The operator's own sellable units rejoin stock.
  app.post(
    '/returns/:id/inspect',
    { preHandler: requireAdmin(Permission.ORDER_RETURN) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = inspectBody.parse(request.body);
      return sendStaffView(reply, await inspectReturn({ side: 'STAFF', actor: staffActor(request) }, id, body));
    },
  );

  // Refund an inspected return through the ordinary refund path. Needs an Idempotency-Key; never more than the goods cost.
  app.post(
    '/returns/:id/refund',
    {
      preHandler: requireAdmin(Permission.REFUND_CREATE),
      config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          amountMinor: z.string().regex(/^\d+$/, 'Expected whole minor units, e.g. "117280".').optional(),
          note: z.string().trim().max(400).nullable().optional(),
        })
        .parse(request.body ?? {});
      const view = await refundReturn(staffActor(request), id, {
        ...(body.amountMinor !== undefined ? { amountMinor: body.amountMinor } : {}),
        note: body.note ?? null,
        idempotencyKey: idempotencyKey(request),
      });
      return sendStaffView(reply, view, 201);
    },
  );

  // Close an inspected return with a replacement sent instead of a refund. A note saying what was sent is required.
  app.post(
    '/returns/:id/replacement',
    { preHandler: requireAdmin(Permission.ORDER_RETURN) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { note } = z.object({ note: z.string().trim().min(1).max(512) }).parse(request.body);
      return sendStaffView(reply, await completeWithReplacement(staffActor(request), id, note));
    },
  );

  // A five-minute, single-use link to one file of a return.
  app.post(
    '/returns/:id/files/:fileId/link',
    { preHandler: requireAdmin(Permission.ORDER_READ) },
    async (request, reply) => {
      const { id, fileId } = fileParams.parse(request.params);
      const returnId = await staffReturnId(id);
      const auth = currentUser(request);
      const link = await createReturnFileLink({
        side: 'STAFF',
        userId: auth.id,
        returnRequestId: returnId,
        fileId,
        downloadPath: `/api/v1/admin/returns/${returnId}/files/${fileId}/download`,
      });
      return reply.status(200).send(link);
    },
  );

  // Download a file of a return with a link from the route above.
  app.get(
    '/returns/:id/files/:fileId/download',
    { preHandler: requireAdmin(Permission.ORDER_READ) },
    async (request, reply) => {
      const { id, fileId } = fileParams.parse(request.params);
      const { token } = tokenQuery.parse(request.query);
      const returnId = await staffReturnId(id);
      const auth = currentUser(request);
      const file = await redeemReturnFileLink({
        side: 'STAFF',
        userId: auth.id,
        email: auth.email,
        auditActorType: 'ADMIN',
        returnRequestId: returnId,
        fileId,
        token,
      });
      return sendAttachment(reply, file);
    },
  );

  return Promise.resolve();
}
