/**
 * Buyer companies, from the storefront: registering a company, the
 * save-and-resume application, the business email code, documents, and
 * answering a reviewer.
 *
 * Every route is a signed-in buyer's and every one names the company in its
 * path. That id is never trusted: each service call starts by loading the
 * caller's ACTIVE membership in it, and a company the caller is not in is a
 * 404 indistinguishable from one that does not exist.
 *
 * None of these routes needs the session to be IN the company's context -
 * an applicant manages their application from their own account, which is
 * where a pending company's owner starts. Purchasing is what needs the
 * context, and it is guarded where purchasing happens.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import {
  BuyerCompanyEntityTypeValues,
  IDENTIFIER_SCHEMES,
  NOT_APPLICABLE_REASONS,
} from '../../domain/buyer-company-identifiers.js';
import {
  APPLICANT_RELATIONSHIPS,
  BuyerCompanyDocumentKindValues,
} from '../../domain/buyer-company-requirements.js';
import { ErrorCode } from '../../domain/errors.js';
import {
  INDUSTRIES,
  answerInfoRequest,
  confirmBusinessEmailCode,
  createCompanyDraft,
  readApplication,
  reopenRejectedApplication,
  resubmitApplication,
  saveApplication,
  sellerSourceFor,
  sendBusinessEmailCode,
  submitApplication,
} from '../../modules/buyer-companies/application.service.js';
import { consentVersion } from '../../modules/buyer-companies/consents.js';
import { listCompanyContexts } from '../../modules/buyer-companies/context.service.js';
import {
  uploadCompanyDocument,
  withdrawCompanyDocument,
} from '../../modules/buyer-companies/documents.service.js';
import { assertCompaniesEnabled, type Actor } from '../../modules/buyer-companies/shared.js';
import {
  ASSIGNABLE_ROLES,
  acceptInvitation,
  changeMemberRole,
  inviteMember,
  previewInvitation,
  readTeam,
  recordAccessReview,
  removeMember,
  resendInvitation,
  revokeInvitation,
} from '../../modules/buyer-companies/team.service.js';
import { currentUser, requireCustomer } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });

const entityType = z.enum(BuyerCompanyEntityTypeValues as [string, ...string[]]);
const nullableText = (max: number) => z.string().max(max).nullable().optional();

const createSchema = z.object({
  legalName: nullableText(255),
  registrationCountry: z.string().trim().length(2).toUpperCase().nullable().optional(),
  entityType: entityType.nullable().optional(),
  // Start from the seller account this person runs. The service refuses any
  // other id with the same 404 as an unknown one.
  fromSellerAccountId: z.string().length(26).nullable().optional(),
});

const addressSchema = z.object({
  kind: z.enum(['REGISTERED_OFFICE', 'OPERATING', 'BILLING', 'SHIPPING']),
  remove: z.boolean().optional(),
  line1: z.string().max(255).optional(),
  line2: nullableText(255),
  city: z.string().max(128).optional(),
  region: nullableText(128),
  postalCode: nullableText(32),
  countryCode: z.string().max(2).optional(),
});

/**
 * The optional procurement answers. Bounded and enumerated, because they
 * are stored as JSON and read back by staff: free-form JSON from a browser is
 * how a row ends up holding a megabyte of anything.
 */
const procurementSchema = z
  .object({
    expectedMonthlyVolume: z
      .enum(['UNDER_1K', '1K_10K', '10K_50K', '50K_250K', 'OVER_250K'])
      .nullable()
      .optional(),
    categories: z.array(z.string().max(64)).max(20).optional(),
    deliveryCountries: z.array(z.string().length(2).toUpperCase()).max(40).optional(),
    preferredCurrency: z.string().length(3).toUpperCase().nullable().optional(),
    paymentTermsInterest: z.boolean().optional(),
    erpIntegrationInterest: z.boolean().optional(),
    expectedUsers: z.enum(['1', '2_5', '6_20', 'OVER_20']).nullable().optional(),
  })
  .strict();

const patchSchema = z
  .object({
    business: z
      .object({
        legalName: nullableText(255),
        tradingName: nullableText(255),
        entityType: entityType.nullable().optional(),
        registrationCountry: nullableText(2),
        registrationNumber: nullableText(64),
        incorporationDate: nullableText(10),
        industry: z.enum(INDUSTRIES).nullable().optional(),
        website: nullableText(255),
        businessEmail: nullableText(320),
        businessPhone: nullableText(32),
      })
      .strict()
      .optional(),
    applicant: z
      .object({
        jobTitle: nullableText(128),
        relationship: z.enum(APPLICANT_RELATIONSHIPS).nullable().optional(),
        authorityConfirmed: z.boolean().optional(),
      })
      .strict()
      .optional(),
    addresses: z.array(addressSchema).max(4).optional(),
    identifiers: z
      .array(
        z.object({
          scheme: z.enum(IDENTIFIER_SCHEMES as unknown as [string, ...string[]]),
          value: z.string().max(64).nullable(),
          notApplicable: z.boolean(),
          notApplicableReason: z.enum(NOT_APPLICABLE_REASONS).nullable(),
        }),
      )
      .max(12)
      .optional(),
    procurement: procurementSchema.nullable().optional(),
  })
  .strict();

const submitSchema = z.object({
  consents: z.object({
    ACCURACY_DECLARATION: z.boolean(),
    BUSINESS_TERMS: z.boolean(),
    PRIVACY_NOTICE: z.boolean(),
    AUTHORITY_TO_ACT: z.boolean(),
  }),
});

const codeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the six-digit code.'),
});
const answerSchema = z.object({ message: z.string().trim().min(1).max(5000) });
const inviteSchema = z.object({ email: z.string().trim().email().max(320), role: z.enum(ASSIGNABLE_ROLES) });
const roleSchema = z.object({ role: z.enum(ASSIGNABLE_ROLES) });
const tokenSchema = z.object({ token: z.string().trim().min(20).max(100) });
const invitationParam = z.object({ id: z.string().length(26), invitationId: z.string().length(26) });
const memberParam = z.object({ id: z.string().length(26), memberId: z.string().length(26) });

function actorOf(request: FastifyRequest): Actor & { userAgent: string | null } {
  const auth = currentUser(request);
  const agent = request.headers['user-agent'];
  return {
    type: 'CUSTOMER',
    userId: auth.id,
    email: auth.email,
    ipAddress: request.ip,
    correlationId: request.correlationId,
    userAgent: typeof agent === 'string' ? agent : null,
  };
}

export function registerBuyerCompanyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCustomer);

  /** The companies the signed-in buyer belongs to, with each one's status and their role. */
  app.get('/', async (request, reply) => {
    assertCompaniesEnabled();
    const userId = currentUser(request).id;
    const [companies, sellerSource] = await Promise.all([
      listCompanyContexts(userId),
      // Only ever the caller's own seller account, so naming it here tells
      // them nothing they could not see in Seller Hub.
      sellerSourceFor(userId),
    ]);
    return reply.status(200).send({ companies, sellerSource, consentVersion: consentVersion() });
  });

  /**
   * Start a company application, with the signed-in buyer as its owner. The
   * owner cannot buy for the company until staff approve it.
   */
  app.post(
    '/',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const body = createSchema.parse(request.body ?? {});
      const actor = actorOf(request);
      const { companyId } = await createCompanyDraft({
        userId: actor.userId ?? '',
        legalName: body.legalName ?? null,
        registrationCountry: body.registrationCountry ?? null,
        entityType: (body.entityType ?? null) as never,
        fromSellerAccountId: body.fromSellerAccountId ?? null,
        actor,
      });
      return reply.status(201).send(await readApplication(actor.userId ?? '', companyId));
    },
  );

  /** One company application as its member sees it: details, requirements, what is missing, requests and timeline. */
  app.get('/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.status(200).send({
      ...(await readApplication(currentUser(request).id, id)),
      consentVersion: consentVersion(),
    });
  });

  /** Save one or more steps of the application. Refused while it is with a reviewer. */
  app.patch('/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = patchSchema.parse(request.body);
    const actor = actorOf(request);
    return reply
      .status(200)
      .send(await saveApplication(actor.userId ?? '', id, body as never, actor));
  });

  /** Send a six-digit code to the business email address. */
  app.post(
    '/:id/email-code',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const actor = actorOf(request);
      return reply.status(200).send(await sendBusinessEmailCode(actor.userId ?? '', id, actor));
    },
  );

  /** Enter the business email code. Completes a submission that was waiting on it. */
  app.post(
    '/:id/email-code/confirm',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = codeSchema.parse(request.body);
      const actor = actorOf(request);
      return reply
        .status(200)
        .send(await confirmBusinessEmailCode(actor.userId ?? '', id, body.code, actor));
    },
  );

  /** Send the application for review, recording each of the four declarations separately. */
  app.post(
    '/:id/submit',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = submitSchema.parse(request.body);
      const actor = actorOf(request);
      return reply
        .status(200)
        .send(
          await submitApplication({
            userId: actor.userId ?? '',
            companyId: id,
            consents: body.consents,
            actor,
          }),
        );
    },
  );

  /** Answer one of the reviewer's requests. */
  app.post('/:id/info-requests/:requestId/answer', async (request, reply) => {
    const params = z
      .object({ id: z.string().length(26), requestId: z.string().length(26) })
      .parse(request.params);
    const body = answerSchema.parse(request.body);
    const actor = actorOf(request);
    return reply
      .status(200)
      .send(
        await answerInfoRequest(
          actor.userId ?? '',
          params.id,
          params.requestId,
          body.message,
          actor,
        ),
      );
  });

  /** Send the application back to the reviewer after answering them. */
  app.post('/:id/resubmit', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const actor = actorOf(request);
    return reply.status(200).send(await resubmitApplication(actor.userId ?? '', id, actor));
  });

  /** Take a rejected application back to a draft to correct it, where the reviewer allowed that. */
  app.post('/:id/reopen', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const actor = actorOf(request);
    return reply.status(200).send(await reopenRejectedApplication(actor.userId ?? '', id, actor));
  });

  /**
   * Upload a supporting document. PDF, JPEG, PNG or WebP, decided from the
   * file's own bytes; scanned for malware and stored privately under a
   * generated name. Send the `kind` field before the file.
   */
  app.post(
    '/:id/documents',
    { config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      // One byte over the service's ceiling, so an over-size file reaches the
      // service and is refused with its own message rather than truncated.
      const upload = await request.file({
        limits: { fileSize: env.BUYER_COMPANY_DOCUMENT_MAX_BYTES + 1, files: 1 },
      });
      if (upload === undefined) {
        return reply.status(400).send({
          error: { code: ErrorCode.VALIDATION_FAILED, message: 'No file was attached.' },
        });
      }

      const bytes = await upload.toBuffer();
      const fields = upload.fields as Record<string, { value?: unknown } | undefined>;
      const text = (name: string): string | null =>
        typeof fields[name]?.value === 'string' && fields[name].value.length > 0
          ? fields[name].value
          : null;

      const parsed = z
        .object({
          kind: z.enum(BuyerCompanyDocumentKindValues as unknown as [string, ...string[]]),
          infoRequestId: z.string().length(26).nullable(),
        })
        .parse({ kind: text('kind'), infoRequestId: text('infoRequestId') });

      const actor = actorOf(request);
      const result = await uploadCompanyDocument({
        userId: actor.userId ?? '',
        companyId: id,
        kind: parsed.kind as never,
        infoRequestId: parsed.infoRequestId,
        bytes,
        actor,
      });

      return reply.status(201).send({
        documentId: result.documentId,
        application: await readApplication(actor.userId ?? '', id),
      });
    },
  );

  /** Withdraw a document nobody has decided on yet. */
  app.delete('/:id/documents/:documentId', async (request, reply) => {
    const params = z
      .object({ id: z.string().length(26), documentId: z.string().length(26) })
      .parse(request.params);
    const actor = actorOf(request);
    await withdrawCompanyDocument(actor.userId ?? '', params.id, params.documentId, actor);
    return reply.status(200).send(await readApplication(actor.userId ?? '', params.id));
  });

  // --- The team: who acts for the company, and as what (Master rows 11, 14) ---

  /** The company's active members and their roles; live invitations for the owner and administrators. */
  app.get('/:id/team', async (request, reply) => {
    assertCompaniesEnabled();
    const { id } = idParam.parse(request.params);
    return reply.header('cache-control', 'no-store').send(await readTeam(currentUser(request).id, id));
  });

  /** Invite somebody by email in one role. Owner or administrator of a verified company; only the owner gives the administrator role. */
  app.post(
    '/:id/invitations',
    { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
    async (request, reply) => {
      assertCompaniesEnabled();
      const { id } = idParam.parse(request.params);
      const body = inviteSchema.parse(request.body);
      const actor = actorOf(request);
      return reply.status(201).send(await inviteMember({ ...actor, userId: currentUser(request).id }, id, body));
    },
  );

  /** Send an invitation again with a new link and a new expiry; the old link stops working. */
  app.post(
    '/:id/invitations/:invitationId/resend',
    { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (request, reply) => {
      assertCompaniesEnabled();
      const params = invitationParam.parse(request.params);
      const actor = actorOf(request);
      return reply.send(await resendInvitation({ ...actor, userId: currentUser(request).id }, params.id, params.invitationId));
    },
  );

  /** Withdraw an invitation nobody has accepted yet. */
  app.delete('/:id/invitations/:invitationId', async (request, reply) => {
    assertCompaniesEnabled();
    const params = invitationParam.parse(request.params);
    const actor = actorOf(request);
    return reply.send(await revokeInvitation({ ...actor, userId: currentUser(request).id }, params.id, params.invitationId));
  });

  /** Change a member's role. Never the owner, never yourself; only the owner changes an administrator. */
  app.patch('/:id/members/:memberId', async (request, reply) => {
    assertCompaniesEnabled();
    const params = memberParam.parse(request.params);
    const { role } = roleSchema.parse(request.body);
    const actor = actorOf(request);
    return reply.send(await changeMemberRole({ ...actor, userId: currentUser(request).id }, params.id, params.memberId, role));
  });

  /** Remove a member. Their access ends on their next request. */
  app.delete('/:id/members/:memberId', async (request, reply) => {
    assertCompaniesEnabled();
    const params = memberParam.parse(request.params);
    const actor = actorOf(request);
    return reply.send(await removeMember({ ...actor, userId: currentUser(request).id }, params.id, params.memberId));
  });

  /** Record that you have reviewed who has access to the company. Owner or administrator; audited. */
  app.post(
    '/:id/access-reviews',
    { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (request, reply) => {
      assertCompaniesEnabled();
      const { id } = idParam.parse(request.params);
      const actor = actorOf(request);
      return reply.status(201).send(await recordAccessReview({ ...actor, userId: currentUser(request).id }, id));
    },
  );

  /** What an invitation link asks you to join. Only for the signed-in account it was sent to. */
  app.post(
    '/invitations/preview',
    { config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      assertCompaniesEnabled();
      const { token } = tokenSchema.parse(request.body);
      return reply.header('cache-control', 'no-store').send(await previewInvitation(currentUser(request).id, token));
    },
  );

  /** Accept an invitation. Your verified email must be the one it was sent to. */
  app.post(
    '/invitations/accept',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      assertCompaniesEnabled();
      const { token } = tokenSchema.parse(request.body);
      const actor = actorOf(request);
      return reply.send(await acceptInvitation({ ...actor, userId: currentUser(request).id }, token));
    },
  );

  return Promise.resolve();
}
