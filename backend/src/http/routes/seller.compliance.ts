/**
 * Compliance in the Seller Hub (`/api/v1/seller/compliance/*`).
 *
 * A seller sees, for the categories they sell in: which approved requirements
 * apply, their qualification cases and what the reviewer said, their
 * compliance documents and where each stands. They can ask for a
 * qualification, answer a request for changes, add, replace and submit a
 * document, and withdraw a case.
 *
 * They never see a reviewer's internal notes, never edit a decision, and
 * never see another seller's anything: every query is filtered by the seller
 * account the session's membership resolves to.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { prisma } from '../../infra/prisma.js';
import { caseDetail, caseRequestInput, caseView, qualificationGate, requestCase, sellerRespond } from '../../modules/compliance/case.service.js';
import {
  complianceDocumentDetail,
  complianceDocumentInput,
  createComplianceDocument,
  documentView,
  submitComplianceDocument,
} from '../../modules/compliance/document.service.js';
import { approvedRules } from '../../modules/compliance/requirement.service.js';
import { currentUser } from '../plugins/auth.js';
import { currentSeller, requireSeller } from '../plugins/seller.js';

const id = z.string().length(26);
const idParam = z.object({ id });

export function registerSellerComplianceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Your compliance at a glance: qualification and product cases, documents,
   * and - for each category you sell in - whether an approved requirement
   * reaches it and whether you are qualified.
   */
  app.get('/compliance', { preHandler: requireSeller(SellerPermission.ACCOUNT_READ) }, async (request, reply) => {
    const seller = currentSeller(request);
    const [cases, documents, offers, rules] = await Promise.all([
      prisma.complianceCase.findMany({ where: { sellerAccountId: seller.sellerAccountId }, orderBy: { updatedAt: 'desc' }, include: { category: { select: { name: true } } } }),
      prisma.sellerCertification.findMany({ where: { sellerAccountId: seller.sellerAccountId, archivedAt: null }, orderBy: { updatedAt: 'desc' } }),
      prisma.sellerOffer.findMany({
        where: { sellerAccountId: seller.sellerAccountId },
        select: { product: { select: { categoryId: true, category: { select: { name: true } } } } },
        distinct: ['productId'],
        take: 2000,
      }),
      approvedRules(),
    ]);
    const categories = new Map<string, string>();
    for (const offer of offers) categories.set(offer.product.categoryId, offer.product.category.name);
    const myCategories = await Promise.all(
      [...categories.entries()].map(async ([categoryId, name]) => ({ categoryId, name, ...(await qualificationGate(seller.sellerAccountId, categoryId)) })),
    );
    return reply.header('Cache-Control', 'no-store').send({
      cases: cases.map((row) => ({ ...caseView(row, 'seller'), categoryName: row.category.name })),
      documents: documents.map((row) => documentView(row, 'seller')),
      categories: myCategories,
      approvedRuleCount: rules.length,
    });
  });

  /** The approved requirements that apply in one category, so a seller knows what to provide. Drafts are never shown. */
  app.get('/compliance/requirements', { preHandler: requireSeller(SellerPermission.ACCOUNT_READ) }, async (request, reply) => {
    const { categoryId } = z.object({ categoryId: id }).parse(request.query);
    const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { path: true } });
    const path = (category?.path ?? '').split('/').filter((part) => part.length > 0);
    const rules = (await approvedRules()).filter((rule) => rule.categoryIds.some((ruleCategory) => ruleCategory === categoryId || (rule.includeDescendants && path.includes(ruleCategory))));
    const details = await prisma.complianceRequirement.findMany({
      where: { id: { in: rules.map((rule) => rule.id) } },
      select: { id: true, code: true, name: true, description: true, requiredEvidence: true, obligation: true, level: true, applicability: true, supplyRolesJson: true, destinationMarketsJson: true, sourceUrl: true, sourceTitle: true },
    });
    return reply.header('Cache-Control', 'no-store').send({ requirements: details });
  });

  /** Ask for a qualification (a category, role and market) or a product compliance review. Asking twice returns the same case. */
  app.post('/compliance/cases', { preHandler: requireSeller(SellerPermission.ACCOUNT_SUBMIT) }, async (request, reply) => {
    const seller = currentSeller(request);
    const auth = currentUser(request);
    const opened = await requestCase(
      { party: 'SELLER', sellerAccountId: seller.sellerAccountId, userId: auth.id, label: seller.displayName, correlationId: request.correlationId },
      caseRequestInput.parse(request.body),
    );
    return reply.status(opened.created ? 201 : 200).send(opened);
  });

  /** One of your cases: what applies, what is satisfied, what is missing, and what the reviewer said. */
  app.get('/compliance/cases/:id', { preHandler: requireSeller(SellerPermission.ACCOUNT_READ) }, async (request, reply) => {
    const { id: caseId } = idParam.parse(request.params);
    return reply.header('Cache-Control', 'no-store').send(await caseDetail(caseId, 'seller', currentSeller(request).sellerAccountId));
  });

  /** Answer a request for changes (after adding the documents asked for), or withdraw the case. */
  app.post('/compliance/cases/:id/respond', { preHandler: requireSeller(SellerPermission.ACCOUNT_SUBMIT) }, async (request, reply) => {
    const { id: caseId } = idParam.parse(request.params);
    const seller = currentSeller(request);
    const input = z.object({ action: z.enum(['RESUBMIT', 'WITHDRAW']), message: z.string().trim().max(2000).nullable().optional() }).parse(request.body);
    await sellerRespond({ party: 'SELLER', sellerAccountId: seller.sellerAccountId, userId: currentUser(request).id, label: seller.displayName }, caseId, input);
    return reply.send({ ok: true });
  });

  /** Add a compliance document - a certificate, licence, registration, declaration, test report or authorisation - with its scope and dates. */
  app.post('/compliance/documents', { preHandler: requireSeller(SellerPermission.ACCOUNT_WRITE) }, async (request, reply) => {
    const seller = currentSeller(request);
    const created = await createComplianceDocument(
      { sellerAccountId: seller.sellerAccountId, userId: currentUser(request).id, label: seller.displayName, correlationId: request.correlationId },
      complianceDocumentInput.parse(request.body),
    );
    return reply.status(201).send(created);
  });

  /** One of your documents with its versions and the reviewer's messages to you. */
  app.get('/compliance/documents/:id', { preHandler: requireSeller(SellerPermission.ACCOUNT_READ) }, async (request, reply) => {
    const { id: documentId } = idParam.parse(request.params);
    return reply.header('Cache-Control', 'no-store').send(await complianceDocumentDetail(documentId, 'seller', currentSeller(request).sellerAccountId));
  });

  /** Send a draft, a returned or an expired document for review. */
  app.post('/compliance/documents/:id/submit', { preHandler: requireSeller(SellerPermission.ACCOUNT_SUBMIT) }, async (request, reply) => {
    const { id: documentId } = idParam.parse(request.params);
    const seller = currentSeller(request);
    await submitComplianceDocument({ sellerAccountId: seller.sellerAccountId, userId: currentUser(request).id, label: seller.displayName }, documentId);
    return reply.send({ ok: true });
  });

  return Promise.resolve();
}
