/**
 * The agreement screen after sign-in, for every surface: what the person has
 * accepted and acknowledged, and the two separate acts that record it.
 *
 * Mounted under each surface's own `/auth` prefix, so each reads its own
 * cookie jar and a storefront session can never record a staff acceptance.
 * The scope comes from the surface - and on the storefront from `scope`,
 * which may be SELLER only for somebody who is a member of a seller - never
 * from anything that names a kind of document.
 *
 * Every route here is guarded by the surface's "before agreements" guard:
 * signed in in full, second factor included, and not yet through the screen.
 * They are the way through it, so they cannot sit behind it.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ErrorCode, forbidden } from '../../domain/errors.js';
import type { AgreementScopeName } from '../../domain/legal-document.js';
import type { AuditActorType } from '../../modules/audit/audit.service.js';
import {
  clearAgreement,
  getAgreementStatus,
  individualAgreementScope,
  listAgreementHistory,
  recordAgreement,
  type AgreementCompany,
  type AgreementRole,
} from '../../modules/legal/agreement.service.js';
import { resolveSellerMembership } from '../../modules/seller/account.service.js';
import { requireAuditBeforeAgreements } from '../plugins/audit.js';
import {
  buyerContextOf,
  currentUser,
  requireAdminBeforeAgreements,
  requireCustomerBeforeAgreements,
} from '../plugins/auth.js';
import { requireLogisticsBeforeAgreements } from '../plugins/logistics.js';

const statusQuery = z.object({
  scope: z.enum(['BUYER', 'SELLER']).optional(),
  locale: z.string().trim().max(10).default('en'),
});

const recordBody = z.object({
  scope: z.enum(['BUYER', 'SELLER']).optional(),
  documentIds: z.array(z.string().length(26)).min(1).max(5),
  locale: z.string().trim().max(10).default('en'),
});

const clearQuery = z.object({
  scope: z.enum(['BUYER', 'SELLER']).optional(),
  locale: z.string().trim().max(10).default('en'),
});

type FixedScope = Exclude<AgreementScopeName, 'BUYER' | 'SELLER' | 'COMPANY_BUYER'>;

interface ResolvedScope {
  scope: AgreementScopeName;
  /** The seller the signed-in person is a member of; null outside the SELLER scope. */
  sellerAccountId: string | null;
  /** The company a COMPANY_BUYER screen is for; null on every other scope. */
  company: AgreementCompany | null;
}

/**
 * The storefront's two scopes. SELLER only for a member of a seller, and the
 * seller is the one their membership names - a request can never say which.
 */
async function storefrontScope(request: FastifyRequest, asked: 'BUYER' | 'SELLER' | undefined): Promise<ResolvedScope> {
  if (asked !== 'SELLER') {
    // The buyer screen follows the session's CONFIRMED context: acting for a
    // company is the company screen for that company, whatever tab the person
    // signed in from and whatever the browser asks for. Shopping for yourself
    // is the consumer screen once its three documents are in force.
    const context = buyerContextOf(request);
    return context.kind === 'COMPANY'
      ? { scope: 'COMPANY_BUYER', sellerAccountId: null, company: { companyId: context.companyId, role: context.role } }
      : { scope: await individualAgreementScope(), sellerAccountId: null, company: null };
  }
  const profileId = currentUser(request).customerProfileId;
  if (profileId === null) {
    throw forbidden(ErrorCode.ACCOUNT_NOT_ACTIVATED, 'This account is not fully set up.');
  }
  const membership = await resolveSellerMembership(profileId);
  return { scope: 'SELLER', sellerAccountId: membership.sellerAccountId, company: null };
}

function actorOf(request: FastifyRequest, actorType: AuditActorType, resolved: Partial<ResolvedScope> = {}) {
  const auth = currentUser(request);
  return {
    userId: auth.id,
    email: auth.email,
    actorType,
    correlationId: request.correlationId,
    sellerAccountId: resolved.sellerAccountId ?? null,
    company: resolved.company ?? null,
  };
}

async function sendStatus(
  request: FastifyRequest,
  reply: FastifyReply,
  scope: AgreementScopeName,
  locale: string,
  company: AgreementCompany | null = null,
) {
  const status = await getAgreementStatus(currentUser(request).id, scope, locale, company);
  return reply.header('cache-control', 'no-store').send(status);
}

async function record(
  request: FastifyRequest,
  reply: FastifyReply,
  role: AgreementRole,
  actorType: AuditActorType,
  fixed: FixedScope | null,
) {
  const body = recordBody.parse(request.body);
  const resolved: ResolvedScope =
    fixed === null ? await storefrontScope(request, body.scope) : { scope: fixed, sellerAccountId: null, company: null };
  await recordAgreement(actorOf(request, actorType, resolved), {
    scope: resolved.scope,
    role,
    documentIds: body.documentIds,
  });
  return sendStatus(request, reply, resolved.scope, body.locale, resolved.company);
}

async function clear(
  request: FastifyRequest,
  reply: FastifyReply,
  role: AgreementRole,
  actorType: AuditActorType,
  fixed: FixedScope | null,
) {
  const query = clearQuery.parse(request.query);
  const resolved: ResolvedScope =
    fixed === null ? await storefrontScope(request, query.scope) : { scope: fixed, sellerAccountId: null, company: null };
  await clearAgreement(actorOf(request, actorType, resolved), { scope: resolved.scope, role });
  return sendStatus(request, reply, resolved.scope, query.locale, resolved.company);
}

async function history(request: FastifyRequest, reply: FastifyReply) {
  const entries = await listAgreementHistory(currentUser(request).id);
  return reply.header('cache-control', 'no-store').send({ entries });
}

/** Storefront and Seller Hub: `/api/v1/auth/agreements`. */
export function registerCustomerAgreementRoutes(app: FastifyInstance): Promise<void> {
  // Whether this buyer (or, with scope=SELLER, this seller) has accepted the Terms and acknowledged the Privacy Policy in force, with both documents to read.
  app.get('/agreements', { preHandler: requireCustomerBeforeAgreements }, async (request, reply) => {
    const query = statusQuery.parse(request.query);
    const resolved = await storefrontScope(request, query.scope);
    return sendStatus(request, reply, resolved.scope, query.locale, resolved.company);
  });

  // "I agree" in the Terms dialog: records acceptance of the named Terms in force. Never acknowledges the Privacy Policy.
  app.post('/agreements/terms', { preHandler: requireCustomerBeforeAgreements }, async (request, reply) =>
    record(request, reply, 'TERMS', 'CUSTOMER', null),
  );

  // "I acknowledge" in the Privacy Policy dialog: records the acknowledgment of the notice in force. Never accepts the Terms and consents to nothing optional.
  app.post('/agreements/privacy', { preHandler: requireCustomerBeforeAgreements }, async (request, reply) =>
    record(request, reply, 'PRIVACY', 'CUSTOMER', null),
  );

  // Untick the Terms box before Continue. The record is kept, marked cleared, and the screen asks again.
  app.delete('/agreements/terms', { preHandler: requireCustomerBeforeAgreements }, async (request, reply) =>
    clear(request, reply, 'TERMS', 'CUSTOMER', null),
  );

  // Accept the Platform Services Agreement under its own box: the Seller Hub's (SELLER), the company screen's (COMPANY_BUYER) or the consumer screen's (CONSUMER).
  app.post('/agreements/services', { preHandler: requireCustomerBeforeAgreements }, async (request, reply) =>
    record(request, reply, 'SERVICES', 'CUSTOMER', null),
  );

  // Untick the Platform Services Agreement box before Continue; the record is kept, marked cleared.
  app.delete('/agreements/services', { preHandler: requireCustomerBeforeAgreements }, async (request, reply) =>
    clear(request, reply, 'SERVICES', 'CUSTOMER', null),
  );

  // Untick the Privacy Policy box before Continue. Withdraws no consent; the record is kept, marked cleared.
  app.delete('/agreements/privacy', { preHandler: requireCustomerBeforeAgreements }, async (request, reply) =>
    clear(request, reply, 'PRIVACY', 'CUSTOMER', null),
  );

  // Every Terms acceptance and privacy-notice acknowledgment this person has given, newest first, for their account page.
  app.get('/agreements/history', { preHandler: requireCustomerBeforeAgreements }, async (request, reply) =>
    history(request, reply),
  );

  return Promise.resolve();
}

/** Admin console: `/api/v1/admin/auth/agreements`. */
export function registerStaffAgreementRoutes(app: FastifyInstance): Promise<void> {
  // Whether this member of staff has accepted the staff terms and acknowledged the Privacy Policy in force.
  app.get('/agreements', { preHandler: requireAdminBeforeAgreements() }, async (request, reply) => {
    const query = statusQuery.parse(request.query);
    return sendStatus(request, reply, 'STAFF', query.locale);
  });

  // "I agree" in the staff terms dialog.
  app.post('/agreements/terms', { preHandler: requireAdminBeforeAgreements() }, async (request, reply) =>
    record(request, reply, 'TERMS', 'ADMIN', 'STAFF'),
  );

  // "I acknowledge" in the Privacy Policy dialog.
  app.post('/agreements/privacy', { preHandler: requireAdminBeforeAgreements() }, async (request, reply) =>
    record(request, reply, 'PRIVACY', 'ADMIN', 'STAFF'),
  );

  // Untick the staff terms box before Continue.
  app.delete('/agreements/terms', { preHandler: requireAdminBeforeAgreements() }, async (request, reply) =>
    clear(request, reply, 'TERMS', 'ADMIN', 'STAFF'),
  );

  // Untick the Privacy Policy box before Continue.
  app.delete('/agreements/privacy', { preHandler: requireAdminBeforeAgreements() }, async (request, reply) =>
    clear(request, reply, 'PRIVACY', 'ADMIN', 'STAFF'),
  );

  // Every acceptance and acknowledgment this member of staff has given, newest first.
  app.get('/agreements/history', { preHandler: requireAdminBeforeAgreements() }, async (request, reply) =>
    history(request, reply),
  );

  return Promise.resolve();
}

/** Carrier portal: `/api/v1/logistics/auth/agreements`. */
export function registerLogisticsAgreementRoutes(app: FastifyInstance): Promise<void> {
  // Whether this carrier staff member has accepted the Logistics Partner Terms and acknowledged the Privacy Policy in force.
  app.get('/agreements', { preHandler: requireLogisticsBeforeAgreements() }, async (request, reply) => {
    const query = statusQuery.parse(request.query);
    return sendStatus(request, reply, 'LOGISTICS', query.locale);
  });

  // "I agree" in the Logistics Partner Terms dialog.
  app.post('/agreements/terms', { preHandler: requireLogisticsBeforeAgreements() }, async (request, reply) =>
    record(request, reply, 'TERMS', 'LOGISTICS', 'LOGISTICS'),
  );

  // "I acknowledge" in the Privacy Policy dialog.
  app.post('/agreements/privacy', { preHandler: requireLogisticsBeforeAgreements() }, async (request, reply) =>
    record(request, reply, 'PRIVACY', 'LOGISTICS', 'LOGISTICS'),
  );

  // Untick the Logistics Partner Terms box before Continue.
  app.delete('/agreements/terms', { preHandler: requireLogisticsBeforeAgreements() }, async (request, reply) =>
    clear(request, reply, 'TERMS', 'LOGISTICS', 'LOGISTICS'),
  );

  // Untick the Privacy Policy box before Continue.
  app.delete('/agreements/privacy', { preHandler: requireLogisticsBeforeAgreements() }, async (request, reply) =>
    clear(request, reply, 'PRIVACY', 'LOGISTICS', 'LOGISTICS'),
  );

  // Every acceptance and acknowledgment this person has given, newest first.
  app.get('/agreements/history', { preHandler: requireLogisticsBeforeAgreements() }, async (request, reply) =>
    history(request, reply),
  );

  return Promise.resolve();
}

/** Audit Console: `/api/v1/audit/auth/agreements`. */
export function registerAuditAgreementRoutes(app: FastifyInstance): Promise<void> {
  // Whether this Audit Console user has accepted the console terms and acknowledged the Privacy Policy in force.
  app.get('/agreements', { preHandler: requireAuditBeforeAgreements() }, async (request, reply) => {
    const query = statusQuery.parse(request.query);
    return sendStatus(request, reply, 'AUDIT', query.locale);
  });

  // "I agree" in the Audit Console terms dialog.
  app.post('/agreements/terms', { preHandler: requireAuditBeforeAgreements() }, async (request, reply) =>
    record(request, reply, 'TERMS', 'AUDIT', 'AUDIT'),
  );

  // "I acknowledge" in the Privacy Policy dialog.
  app.post('/agreements/privacy', { preHandler: requireAuditBeforeAgreements() }, async (request, reply) =>
    record(request, reply, 'PRIVACY', 'AUDIT', 'AUDIT'),
  );

  // Untick the Audit Console terms box before Continue.
  app.delete('/agreements/terms', { preHandler: requireAuditBeforeAgreements() }, async (request, reply) =>
    clear(request, reply, 'TERMS', 'AUDIT', 'AUDIT'),
  );

  // Untick the Privacy Policy box before Continue.
  app.delete('/agreements/privacy', { preHandler: requireAuditBeforeAgreements() }, async (request, reply) =>
    clear(request, reply, 'PRIVACY', 'AUDIT', 'AUDIT'),
  );

  // Every acceptance and acknowledgment this person has given, newest first.
  app.get('/agreements/history', { preHandler: requireAuditBeforeAgreements() }, async (request, reply) =>
    history(request, reply),
  );

  return Promise.resolve();
}
