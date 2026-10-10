/**
 * Delivery, returns, disputes, commercial schedules, recovery, security,
 * insurance, product evidence, safety and country launch (Doc 07, Doc 08).
 *
 *   /admin/...  commercial, finance, support and operations controls. Product
 *               evidence and safety cases are READ ONLY here: the Audit
 *               Console decides them.
 *   /audit/...  product evidence verification, safety cases and recall.
 *   /seller/... the seller's own order controls, dispatch evidence, case
 *               requests, return authorisations, fees and security.
 *   /...        the buyer's own case controls and refund status.
 *
 * Every guard is inline on its route so the reference docs show it.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuditPermission } from '../../domain/audit-console-permissions.js';
import {
  CASE_CATEGORIES,
  CUSTOMS_DOCUMENT_KINDS,
  DOC07_ADMINISTRATIVE_WINDOWS,
  DOC08_ASSURANCE_MATRIX,
  DOC08_CATEGORY_REGISTER,
  DOC08_COMMISSION_SCHEDULE,
  HANDLING_REQUIREMENT_KINDS,
  PRODUCT_EVIDENCE_KINDS,
  PROVIDER_REVIEW_ITEMS,
  REMEDY_KINDS,
  SCHEDULE_KINDS,
  doc08WorkedExample,
  reconcileCategoryRegister,
} from '../../domain/commercial-policy.js';
import { notFound } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { prisma } from '../../infra/prisma.js';
import * as cases from '../../modules/commercial-policy/cases.service.js';
import * as evidence from '../../modules/commercial-policy/evidence-launch.service.js';
import * as finance from '../../modules/commercial-policy/finance.service.js';
import * as logistics from '../../modules/commercial-policy/logistics-controls.service.js';
import * as orders from '../../modules/commercial-policy/order-controls.service.js';
import * as safety from '../../modules/commercial-policy/safety.service.js';
import * as schedules from '../../modules/commercial-policy/schedules.service.js';
import { serialise, type StaffActor } from '../../modules/commercial-policy/shared.js';
import { currentAudit, requireAudit } from '../plugins/audit.js';
import { currentUser, orderScopeWhere, requireAdmin, requireCustomerForRemedies } from '../plugins/auth.js';
import { currentLogistics, requireLogistics } from '../plugins/logistics.js';
import { currentSeller, requireSeller } from '../plugins/seller.js';
import { LogisticsPermission } from '../../domain/logistics-permissions.js';

const id26 = z.object({ id: z.string().length(26) });
const minor = z.string().regex(/^\d{1,19}$/);
const optMinor = minor.nullable().optional();
const isoDate = z.coerce.date();
const country = z.string().length(2).transform((v) => v.toUpperCase());
const channel = z.enum(['B2B', 'B2C']);

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store');
}

function adminActor(request: FastifyRequest): StaffActor {
  const u = currentUser(request);
  return { userId: u.id, email: u.email, actorType: 'ADMIN', ipAddress: request.ip, correlationId: request.correlationId };
}

function auditActor(request: FastifyRequest): StaffActor {
  const a = currentAudit(request);
  return { userId: a.userId, email: a.email, actorType: 'AUDIT', ipAddress: request.ip, correlationId: request.correlationId };
}

function sellerActor(request: FastifyRequest): StaffActor & { sellerAccountId: string } {
  const u = currentUser(request);
  return { userId: u.id, email: u.email, actorType: 'CUSTOMER', ipAddress: request.ip, correlationId: request.correlationId, sellerAccountId: currentSeller(request).sellerAccountId };
}

const controlsBody = z.object({
  returnRoute: z.string().min(3).max(400).optional(),
  packagingNote: z.string().min(2).max(400).optional(),
  transportRestrictionsReviewed: z.boolean().optional(),
  insurance: z.object({ decided: z.literal(true), arrangement: z.string().min(3).max(400), insuredValueMinor: optMinor }).optional(),
  namedPlace: z.string().min(6).max(400).optional(),
  leadTimeDays: z.number().int().min(0).max(730).optional(),
  technicalAcceptanceDays: z.number().int().min(0).max(730).nullable().optional(),
  titleTransferPoint: z.string().max(200).optional(),
  riskTransferPoint: z.string().max(200).optional(),
  election: z.object({ term: z.enum(['FCA', 'DDP']), approvalReference: z.string().min(1).max(200), importRouteId: z.string().length(26).nullable().optional() }).nullable().optional(),
});

const bookingBody = z.object({
  lane: z.string().min(3).max(200),
  grossWeightGrams: z.number().int().min(1),
  dimensions: z.object({ lengthMm: z.number().int().min(1), widthMm: z.number().int().min(1), heightMm: z.number().int().min(1), packages: z.number().int().min(1) }),
  packaging: z.string().min(2).max(400),
  hazardClass: z.string().max(32).nullable().optional(),
  cargoCover: z.object({ insurer: z.string().max(200).optional(), insuredValueMinor: minor.optional(), exclusions: z.string().max(2000).optional(), insuredParties: z.string().max(400).optional() }).nullable().optional(),
  custody: z.array(z.object({ leg: z.string().min(1).max(40), responsible: z.string().min(1).max(200) })).min(1).max(10),
  returnCapability: z.string().max(400).nullable().optional(),
  singleSourceReason: z.string().max(2000).nullable().optional(),
  quotes: z.array(z.object({ providerName: z.string().min(1).max(200), logisticsPartnerId: z.string().length(26).nullable().optional(), amountMinor: minor, currency: z.string().length(3), transitDaysMin: z.number().int().min(0).nullable().optional(), transitDaysMax: z.number().int().min(0).nullable().optional(), cargoCover: z.string().max(400).nullable().optional(), comparable: z.boolean().optional(), validUntil: isoDate.nullable().optional(), reference: z.string().max(120).nullable().optional() })).max(10),
  selectedIndex: z.number().int().min(0).max(9).nullable(),
});

const dispatchBody = z.object({
  quantities: z.array(z.object({ orderItemId: z.string().length(26), quantity: z.number().int().min(0) })).min(1).max(500),
  lots: z.array(z.object({ orderItemId: z.string().length(26), lot: z.string().max(64).optional(), serial: z.string().max(64).optional() })).max(5000).optional(),
  seals: z.array(z.string().min(1).max(64)).max(100).optional(),
  packingPhotoRefs: z.array(z.string().min(1).max(400)).max(50).optional(),
  temperatureLogRef: z.string().max(400).nullable().optional(),
  handlingEvidence: z.array(z.object({ kind: z.enum(HANDLING_REQUIREMENT_KINDS), evidence: z.string().min(1).max(2000) })).max(10).optional(),
});

const custodyBody = z.object({ shipmentLegId: z.string().length(26).nullable().optional(), fromParty: z.string().min(1).max(200), toParty: z.string().min(1).max(200), place: z.string().min(2).max(400), handedOverAt: isoDate, packages: z.number().int().min(0), sealsIntact: z.boolean(), exceptionNote: z.string().max(2000).nullable().optional() });

const raBody = z.object({ returnRoute: z.string().min(3).max(400), freightPayer: z.enum(['SELLER', 'BUYER', 'PLATFORM', 'PROVIDER']), payerReason: z.string().min(5).max(2000), carrier: z.string().max(120).nullable().optional(), trackingNumber: z.string().max(120).nullable().optional(), returnBy: isoDate.nullable().optional() });
const raEvidenceBody = z.object({ receivedEvidence: z.string().max(4000).nullable().optional(), inspectionEvidence: z.string().max(4000).nullable().optional(), deductionMinor: optMinor, deductionBasis: z.string().max(2000).nullable().optional() });

// ===========================================================================
// Admin
// ===========================================================================

export function registerAdminCommercialPolicyRoutes(app: FastifyInstance): Promise<void> {
  // The source tables imported from Doc 07 / Doc 08, and the catalogue reconciliation.
  app.get('/commercial/reference', { preHandler: requireAdmin(Permission.FINANCE_POLICY_READ) }, async (_request, reply) => {
    const departments = await prisma.category.findMany({ where: { parentId: null, archivedAt: null }, select: { name: true, slug: true, children: { where: { archivedAt: null }, select: { name: true } } } });
    return noStore(reply).send(serialise({ commission: DOC08_COMMISSION_SCHEDULE, register: DOC08_CATEGORY_REGISTER, assurance: DOC08_ASSURANCE_MATRIX, windows: DOC07_ADMINISTRATIVE_WINDOWS, workedExample: doc08WorkedExample(), catalogueDifferences: reconcileCategoryRegister(departments) }));
  });

  // Every versioned commercial schedule, newest first per kind.
  app.get('/commercial/schedules', { preHandler: requireAdmin(Permission.FINANCE_POLICY_READ) }, async (request, reply) => {
    const q = z.object({ kind: z.enum(SCHEDULE_KINDS).optional(), status: z.enum(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'RETIRED']).optional() }).parse(request.query);
    return noStore(reply).send({ schedules: await schedules.listSchedules(q) });
  });

  // One schedule with its history and what still stops its activation.
  app.get('/commercial/schedules/:id', { preHandler: requireAdmin(Permission.FINANCE_POLICY_READ) }, async (request, reply) => noStore(reply).send(await schedules.readSchedule(id26.parse(request.params).id)));

  // The financial effect of a schedule on sample figures, before approval.
  app.get('/commercial/schedules/:id/preview', { preHandler: requireAdmin(Permission.FINANCE_POLICY_READ) }, async (request, reply) => {
    const q = z.object({ goodsMinor: minor.default('10000000'), externalFreightMinor: minor.default('800000'), channel: channel.default('B2B'), departmentSlug: z.string().max(120).optional() }).parse(request.query);
    return noStore(reply).send(await schedules.previewSchedule(id26.parse(request.params).id, { goodsMinor: BigInt(q.goodsMinor), externalFreightMinor: BigInt(q.externalFreightMinor), channel: q.channel, departmentSlug: q.departmentSlug ?? null }));
  });

  // Draft a new version of a schedule kind, copied from the latest.
  app.post('/commercial/schedules', { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE) }, async (request, reply) => {
    const body = z.object({ kind: z.enum(SCHEDULE_KINDS) }).parse(request.body);
    return reply.status(201).send(await schedules.draftNewVersion(body.kind, adminActor(request)));
  });

  // Edit a DRAFT schedule's scope, body, dates and signed-schedule reference.
  app.patch('/commercial/schedules/:id', { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE) }, async (request, reply) => {
    const body = z.object({ title: z.string().min(3).max(200).optional(), scope: z.object({ countries: z.array(country).max(250).optional(), channels: z.array(channel).max(2).optional(), sellerAccountIds: z.array(z.string().length(26)).max(500).optional() }).optional(), body: z.unknown().optional(), effectiveFrom: isoDate.nullable().optional(), effectiveUntil: isoDate.nullable().optional(), scheduleReference: z.string().max(200).nullable().optional(), note: z.string().max(4000).nullable().optional() }).parse(request.body);
    await schedules.editDraft(id26.parse(request.params).id, body, adminActor(request));
    return reply.status(204).send();
  });

  // Submit a draft for approval.
  app.post('/commercial/schedules/:id/submit', { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE) }, async (request, reply) => {
    await schedules.submitForApproval(id26.parse(request.params).id, adminActor(request));
    return reply.status(204).send();
  });

  // Approve or return a submitted schedule, with the adoption evidence. Not by its preparer.
  app.post('/commercial/schedules/:id/decision', { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE) }, async (request, reply) => {
    const body = z.object({ approve: z.boolean(), evidence: z.string().min(5).max(4000), providerConfirmationRef: z.string().max(200).nullable().optional() }).parse(request.body);
    await schedules.decideSchedule(id26.parse(request.params).id, body, adminActor(request));
    return reply.status(204).send();
  });

  // Record the payment provider's written confirmation.
  app.post('/commercial/schedules/:id/provider-confirmation', { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE) }, async (request, reply) => {
    const body = z.object({ reference: z.string().min(3).max(200) }).parse(request.body);
    await schedules.recordProviderConfirmation(id26.parse(request.params).id, body.reference, adminActor(request));
    return reply.status(204).send();
  });

  // Activate an approved schedule. A person's act; refused with each missing item.
  app.post('/commercial/schedules/:id/activate', { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE) }, async (request, reply) => {
    await schedules.activateSchedule(id26.parse(request.params).id, adminActor(request));
    return reply.status(204).send();
  });

  // Retire a schedule.
  app.post('/commercial/schedules/:id/retire', { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE) }, async (request, reply) => {
    const body = z.object({ reason: z.string().min(3).max(2000) }).parse(request.body);
    await schedules.retireSchedule(id26.parse(request.params).id, adminActor(request), body.reason);
    return reply.status(204).send();
  });

  // Import routes: importer and local actors per destination, category and channel.
  app.get('/commercial/import-routes', { preHandler: requireAdmin(Permission.SETTINGS_READ) }, async (request, reply) => {
    const q = z.object({ countryCode: country.optional() }).parse(request.query);
    return noStore(reply).send({ routes: await orders.listImportRoutes(q.countryCode) });
  });

  // Draft or replace an import route (returns it to DRAFT for review).
  app.put('/commercial/import-routes', { preHandler: requireAdmin(Permission.SETTINGS_WRITE) }, async (request, reply) => {
    const body = z.object({ countryCode: country, categoryId: z.string().length(26).nullable(), channel, importerParty: z.enum(['BUYER', 'SELLER', 'APPROVED_ARRANGEMENT', 'MARKETPLACE', 'OTHER']), importerName: z.string().max(200).nullable().optional(), localActors: z.array(z.object({ role: z.string().min(2).max(80), name: z.string().min(2).max(200), evidence: z.string().max(2000), verified: z.boolean() })).max(20), regulatedCategory: z.boolean(), evidence: z.string().max(4000).nullable().optional(), validUntil: isoDate.nullable().optional(), note: z.string().max(2000).nullable().optional() }).parse(request.body);
    return reply.send(await orders.upsertImportRoute(body, adminActor(request)));
  });

  // Approve or reject an import route. Not by its preparer.
  app.post('/commercial/import-routes/:id/decision', { preHandler: requireAdmin(Permission.SETTINGS_WRITE) }, async (request, reply) => {
    const body = z.object({ approve: z.boolean(), note: z.string().min(3).max(2000) }).parse(request.body);
    await orders.decideImportRoute(id26.parse(request.params).id, body, adminActor(request));
    return reply.status(204).send();
  });

  // An order's frozen line snapshots: seller, manufacturer, scope, term, importer, money, policy versions.
  app.get('/orders/:id/commercial-controls', { preHandler: requireAdmin(Permission.ORDER_READ) }, async (request, reply) => noStore(reply).send({ lines: await orders.readOrderControls(id26.parse(request.params).id), refunds: await finance.refundStatusView(id26.parse(request.params).id) }));

  // A seller order's acceptance controls.
  app.get('/seller-orders/:id/controls', { preHandler: requireAdmin(Permission.ORDER_READ) }, async (request, reply) => noStore(reply).send(await orders.readGroupControls(id26.parse(request.params).id)));

  // Record missing acceptance controls while the seller order is NEW.
  app.patch('/seller-orders/:id/controls', { preHandler: requireAdmin(Permission.ORDER_FULFIL) }, async (request, reply) => {
    await orders.recordAcceptanceControls(id26.parse(request.params).id, controlsBody.parse(request.body), adminActor(request));
    return reply.status(204).send();
  });

  // Dispatch controls: booking, quotes, documents, evidence, custody, partial shipments and the gate's gaps.
  app.get('/seller-orders/:id/dispatch-controls', { preHandler: requireAdmin(Permission.LOGISTICS_READ) }, async (request, reply) => noStore(reply).send(await logistics.readDispatchControls(id26.parse(request.params).id)));

  // Record a freight booking with its compared quotes.
  app.put('/seller-orders/:id/freight-booking', { preHandler: requireAdmin(Permission.LOGISTICS_WRITE) }, async (request, reply) => reply.send(await logistics.saveFreightBooking(id26.parse(request.params).id, bookingBody.parse(request.body), adminActor(request))));

  // Record dispatch evidence (quantities, lots, seals, photos, temperature, handling).
  app.put('/seller-orders/:id/dispatch-evidence', { preHandler: requireAdmin(Permission.LOGISTICS_WRITE) }, async (request, reply) => reply.send(await logistics.saveDispatchEvidence(id26.parse(request.params).id, dispatchBody.parse(request.body), { ...adminActor(request), role: 'STAFF' })));

  // Record a custody handover.
  app.post('/seller-orders/:id/custody-handovers', { preHandler: requireAdmin(Permission.LOGISTICS_WRITE) }, async (request, reply) => reply.status(201).send(await logistics.recordCustodyHandover(id26.parse(request.params).id, custodyBody.parse(request.body), { ...adminActor(request), role: 'STAFF' })));

  // Approve a partial shipment with proportionate billing.
  app.post('/seller-orders/:id/partial-shipments', { preHandler: requireAdmin(Permission.ORDER_APPROVE) }, async (request, reply) => {
    const body = z.object({ orderApprovalRef: z.string().min(3).max(200), approvedByParty: z.enum(['BUYER', 'STAFF']), quantities: z.array(z.object({ orderItemId: z.string().length(26), quantity: z.number().int().min(1) })).min(1).max(500) }).parse(request.body);
    return reply.status(201).send(await logistics.approvePartialShipment(id26.parse(request.params).id, body, adminActor(request)));
  });

  // Logistics provider screening records.
  app.get('/commercial/provider-reviews', { preHandler: requireAdmin(Permission.LOGISTICS_READ) }, async (_request, reply) => noStore(reply).send({ items: PROVIDER_REVIEW_ITEMS, reviews: await logistics.listProviderReviews() }));

  // Record or update a provider review.
  app.put('/commercial/provider-reviews', { preHandler: requireAdmin(Permission.LOGISTICS_WRITE) }, async (request, reply) => {
    const item = z.object({ status: z.enum(['VERIFIED', 'PENDING', 'NOT_APPLICABLE', 'FAILED']), evidence: z.string().max(2000).nullable().optional() });
    const body = z.object({ id: z.string().length(26).optional(), providerName: z.string().min(2).max(200), logisticsPartnerId: z.string().length(26).nullable().optional(), items: z.record(z.enum(PROVIDER_REVIEW_ITEMS), item) }).parse(request.body);
    return reply.send(await logistics.saveProviderReview(body, adminActor(request)));
  });

  // Approve or reject a provider review. Not by its recorder.
  app.post('/commercial/provider-reviews/:id/decision', { preHandler: requireAdmin(Permission.LOGISTICS_WRITE) }, async (request, reply) => {
    await logistics.decideProviderReview(id26.parse(request.params).id, z.object({ approve: z.boolean() }).parse(request.body).approve, adminActor(request));
    return reply.status(204).send();
  });

  // Dangerous goods, battery, timber packaging and temperature requirements.
  app.get('/commercial/handling-requirements', { preHandler: requireAdmin(Permission.LOGISTICS_READ) }, async (_request, reply) => noStore(reply).send({ requirements: await logistics.listHandlingRequirements(), customsDocumentKinds: CUSTOMS_DOCUMENT_KINDS }));

  // Create or update a handling requirement.
  app.put('/commercial/handling-requirements', { preHandler: requireAdmin(Permission.LOGISTICS_WRITE) }, async (request, reply) => {
    const body = z.object({ id: z.string().length(26).optional(), kind: z.enum(HANDLING_REQUIREMENT_KINDS), categoryId: z.string().length(26).nullable().optional(), destinationCountry: country.nullable().optional(), requiredEvidence: z.string().min(3).max(2000), isActive: z.boolean() }).parse(request.body);
    return reply.send(await logistics.saveHandlingRequirement(body, adminActor(request)));
  });

  // A dispute's case controls: profile, clocks, requests, remedies, testing, recoveries.
  app.get('/disputes/:id/case-controls', { preHandler: requireAdmin(Permission.DISPUTE_VIEW) }, async (request, reply) => noStore(reply).send(await cases.readCaseControls(id26.parse(request.params).id)));

  // Acknowledge a case.
  app.post('/disputes/:id/case-controls/acknowledge', { preHandler: requireAdmin(Permission.DISPUTE_MANAGE) }, async (request, reply) => {
    await cases.acknowledgeCase(id26.parse(request.params).id, adminActor(request));
    return reply.status(204).send();
  });

  // Record why the evidence is sufficient; starts the decision clock once.
  app.post('/disputes/:id/case-controls/evidence-sufficient', { preHandler: requireAdmin(Permission.DISPUTE_MANAGE) }, async (request, reply) => {
    await cases.markEvidenceSufficient(id26.parse(request.params).id, z.object({ reason: z.string().min(10).max(4000) }).parse(request.body).reason, adminActor(request));
    return reply.status(204).send();
  });

  // Request proportionate evidence from a party.
  app.post('/disputes/:id/case-controls/evidence-requests', { preHandler: requireAdmin(Permission.DISPUTE_MANAGE) }, async (request, reply) => {
    const body = z.object({ requestedFrom: z.enum(['BUYER', 'SELLER', 'PROVIDER']), purpose: z.enum(['EVIDENCE', 'MATERIAL_CONTRARY_EVIDENCE', 'SELLER_RESPONSE']), description: z.string().min(5).max(4000), proportionalityNote: z.string().min(5).max(2000), dueAt: isoDate.nullable().optional() }).parse(request.body);
    return reply.status(201).send(await cases.requestEvidence(id26.parse(request.params).id, body, adminActor(request)));
  });

  // Record independent testing and its interim / final cost allocation.
  app.put('/disputes/:id/case-controls/testing', { preHandler: requireAdmin(Permission.DISPUTE_MANAGE) }, async (request, reply) => {
    const payer = z.enum(['PLATFORM', 'SELLER', 'BUYER', 'PROVIDER']);
    const body = z.object({ id: z.string().length(26).optional(), laboratory: z.string().min(2).max(200), protocol: z.string().min(5).max(4000), agreedByBuyer: z.boolean(), agreedBySeller: z.boolean(), interimPayer: payer, costMinor: minor, currency: z.string().length(3), sampleCustody: z.string().max(2000).nullable().optional(), resultSummary: z.string().max(4000).nullable().optional(), finalPayer: payer.nullable().optional(), finalAllocationReason: z.string().max(2000).nullable().optional() }).parse(request.body);
    return reply.send(await cases.recordTesting(id26.parse(request.params).id, { ...body, costMinor: BigInt(body.costMinor) }, adminActor(request)));
  });

  // Record the reasoned decision and remedies (amounts, payers, return freight, completion).
  app.put('/disputes/:id/case-controls/decision', { preHandler: requireAdmin(Permission.DISPUTE_MANAGE) }, async (request, reply) => {
    const party = z.enum(['SELLER', 'PLATFORM', 'PROVIDER', 'BUYER', 'INSURER']);
    const body = z.object({ reasoning: z.string().max(8000), remedies: z.array(z.object({ kind: z.enum(REMEDY_KINDS), amountMinor: optMinor, currency: z.string().length(3).nullable().optional(), payer: party, quantity: z.number().int().min(1).nullable().optional(), note: z.string().max(2000).nullable().optional() })).max(10), returnFreightPayer: party.nullable(), expectedCompletionAt: isoDate.nullable(), aiGenerated: z.boolean().optional() }).parse(request.body);
    await cases.recordReasonedDecision(id26.parse(request.params).id, { ...body, remedies: body.remedies.map((r) => ({ ...r, amountMinor: r.amountMinor ? BigInt(r.amountMinor) : null })) }, adminActor(request));
    return reply.status(204).send();
  });

  // Mark a remedy completed (with its refund, where one was made).
  app.post('/disputes/remedies/:id/complete', { preHandler: requireAdmin(Permission.DISPUTE_MANAGE) }, async (request, reply) => {
    await cases.completeRemedy(id26.parse(request.params).id, z.object({ refundId: z.string().length(26).nullable().optional(), note: z.string().max(2000).nullable().optional() }).parse(request.body), adminActor(request));
    return reply.status(204).send();
  });

  // Assign an independent appeal reviewer.
  app.post('/disputes/:id/case-controls/appeal-reviewer', { preHandler: requireAdmin(Permission.DISPUTE_APPROVE) }, async (request, reply) => {
    await cases.assignAppealReviewer(id26.parse(request.params).id, z.object({ reviewerUserId: z.string().length(26) }).parse(request.body).reviewerUserId, adminActor(request));
    return reply.status(204).send();
  });

  // Record a carrier, insurer, chargeback or seller recovery; overlaps are flagged, never blocked.
  app.post('/orders/:id/loss-recoveries', { preHandler: requireAdmin(Permission.REFUND_CREATE) }, async (request, reply) => {
    const body = z.object({ sellerOrderGroupId: z.string().length(26).nullable().optional(), disputeId: z.string().length(26).nullable().optional(), lossKey: z.string().min(1).max(64), lossMinor: minor, source: z.enum(['CHARGEBACK', 'REFUND', 'CARRIER', 'INSURER', 'SELLER', 'OTHER']), sourceReference: z.string().min(1).max(128), amountMinor: minor, currency: z.string().length(3) }).parse(request.body);
    return reply.status(201).send(await cases.recordLossRecovery({ ...body, orderId: id26.parse(request.params).id, lossMinor: BigInt(body.lossMinor), amountMinor: BigInt(body.amountMinor) }, adminActor(request)));
  });

  // Issue a return authorisation: route, freight payer and reason.
  app.put('/returns/:id/authorization', { preHandler: requireAdmin(Permission.ORDER_RETURN) }, async (request, reply) => reply.send(await evidence.issueReturnAuthorization(id26.parse(request.params).id, raBody.parse(request.body), adminActor(request))));

  // Record return receipt and inspection evidence, and any evidenced deduction.
  app.patch('/returns/:id/authorization', { preHandler: requireAdmin(Permission.ORDER_RETURN) }, async (request, reply) => {
    const b = raEvidenceBody.parse(request.body);
    await evidence.recordReturnEvidence(id26.parse(request.params).id, { ...b, deductionMinor: b.deductionMinor ? BigInt(b.deductionMinor) : null }, adminActor(request));
    return reply.status(204).send();
  });

  // The return authorisation, if issued.
  app.get('/returns/:id/authorization', { preHandler: requireAdmin(Permission.ORDER_READ) }, async (request, reply) => noStore(reply).send({ authorization: await evidence.readReturnAuthorization(id26.parse(request.params).id) }));

  // Commission reversals proposed by refunds.
  app.get('/commercial/commission-adjustments', { preHandler: requireAdmin(Permission.COMMISSION_INVOICE_VIEW) }, async (request, reply) => {
    const q = z.object({ status: z.enum(['PROPOSED', 'APPLIED', 'DECLINED']).optional(), sellerOrderGroupId: z.string().length(26).optional() }).parse(request.query);
    return noStore(reply).send({ adjustments: await finance.listCommissionAdjustments(q) });
  });

  // Apply a proposed reversal against an issued credit note.
  app.post('/commercial/commission-adjustments/:id/apply', { preHandler: requireAdmin(Permission.COMMISSION_CREDIT_NOTE_CREATE) }, async (request, reply) => {
    await finance.applyCommissionAdjustment(id26.parse(request.params).id, z.object({ creditNoteReference: z.string().min(3).max(120) }).parse(request.body), adminActor(request));
    return reply.status(204).send();
  });

  // Certification-recovery programmes.
  app.get('/commercial/certification-programmes', { preHandler: requireAdmin(Permission.FINANCE_POLICY_READ) }, async (request, reply) => noStore(reply).send({ programmes: await finance.listProgrammes(z.object({ sellerAccountId: z.string().length(26).optional() }).parse(request.query).sellerAccountId) }));

  // One programme's ledger: costs, allocations and the unrecovered balance.
  app.get('/commercial/certification-programmes/:id', { preHandler: requireAdmin(Permission.FINANCE_POLICY_READ) }, async (request, reply) => noStore(reply).send(await finance.readProgramme(id26.parse(request.params).id)));

  // Create a programme (Gloviaa funds first).
  app.post('/commercial/certification-programmes', { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE) }, async (request, reply) => {
    const body = z.object({ sellerAccountId: z.string().length(26), title: z.string().min(3).max(200), currency: z.string().length(3), capBps: z.number().int().min(0).max(100).optional(), periodStart: isoDate, periodEnd: isoDate, fxPolicy: z.string().max(400).nullable().optional() }).parse(request.body);
    return reply.status(201).send(await finance.createProgramme(body, adminActor(request)));
  });

  // Record a third-party cost, credit or seller deduction.
  app.post('/commercial/certification-programmes/:id/costs', { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE) }, async (request, reply) => {
    const body = z.object({ kind: z.enum(['COST', 'CREDIT', 'SELLER_DEDUCTION']), externalReference: z.string().min(2).max(128), supplierName: z.string().min(2).max(200), amountMinor: minor, currency: z.string().length(3), originalAmountMinor: optMinor, originalCurrency: z.string().length(3).nullable().optional(), fxRate: z.string().max(32).nullable().optional(), evidence: z.string().min(3).max(4000) }).parse(request.body);
    return reply.status(201).send(await finance.recordProgrammeCost(id26.parse(request.params).id, { ...body, amountMinor: BigInt(body.amountMinor), originalAmountMinor: body.originalAmountMinor ? BigInt(body.originalAmountMinor) : null }, adminActor(request)));
  });

  // Verify a cost as eligible (not by its recorder).
  app.post('/commercial/certification-costs/:id/verify', { preHandler: requireAdmin(Permission.FINANCE_TAX_VERIFY) }, async (request, reply) => {
    await finance.verifyProgrammeCost(id26.parse(request.params).id, z.object({ eligible: z.boolean() }).parse(request.body).eligible, adminActor(request));
    return reply.status(204).send();
  });

  // Activate, pause or close a programme (activation needs the adopted schedule).
  app.post('/commercial/certification-programmes/:id/status', { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE) }, async (request, reply) => {
    await finance.setProgrammeStatus(id26.parse(request.params).id, z.object({ status: z.enum(['ACTIVE', 'PAUSED', 'CLOSED']) }).parse(request.body).status, adminActor(request));
    return reply.status(204).send();
  });

  // Security schedules and their reviews.
  app.get('/commercial/security', { preHandler: requireAdmin(Permission.FINANCE_POLICY_READ) }, async (request, reply) => noStore(reply).send(await finance.listSecurity(z.object({ sellerAccountId: z.string().length(26).optional() }).parse(request.query).sellerAccountId)));

  // Propose a seller's security (no stacking without a documented exposure).
  app.post('/commercial/security', { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE) }, async (request, reply) => {
    const body = z.object({ sellerAccountId: z.string().length(26), tier: z.enum(['STANDARD', 'HIGH_RISK']), form: z.enum(['RESERVE', 'GUARANTEE', 'DEPOSIT', 'COMBINED']), reserveBps: z.number().int().min(0).max(5000).optional(), holdDays: z.number().int().min(0).max(730).optional(), guaranteeMinor: optMinor, depositMinor: optMinor, capMinor: optMinor, currency: z.string().length(3), exposureBasis: z.string().min(10).max(4000), documentedExposureMinor: optMinor, permittedUses: z.array(z.string().min(2).max(200)).min(1).max(20), noticeTerms: z.string().max(2000).nullable().optional(), disputeRoute: z.string().max(2000).nullable().optional(), scheduleReference: z.string().max(200).nullable().optional() }).parse(request.body);
    const big = (v: string | null | undefined) => (v ? BigInt(v) : undefined);
    return reply.status(201).send(await finance.proposeSecuritySchedule({ ...body, guaranteeMinor: big(body.guaranteeMinor), depositMinor: big(body.depositMinor), capMinor: big(body.capMinor) ?? null, documentedExposureMinor: big(body.documentedExposureMinor) ?? null }, adminActor(request)));
  });

  // Activate a proposed security with the provider's permission (not by its proposer).
  app.post('/commercial/security/:id/activate', { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE) }, async (request, reply) => {
    await finance.activateSecuritySchedule(id26.parse(request.params).id, z.object({ providerPermissionRef: z.string().min(3).max(200) }).parse(request.body), adminActor(request));
    return reply.status(204).send();
  });

  // Complete a monthly or quarterly security review.
  app.post('/commercial/security-reviews/:id', { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE) }, async (request, reply) => {
    const body = z.object({ exposureMinor: minor, outcome: z.enum(['NO_CHANGE', 'REDUCE_EXCESS', 'CONSIDER_REDUCTION', 'ISSUE_FOUND']), note: z.string().min(5).max(4000) }).parse(request.body);
    return reply.send(await finance.completeSecurityReview(id26.parse(request.params).id, { ...body, exposureMinor: BigInt(body.exposureMinor) }, adminActor(request)));
  });

  // The insurance register, with the proposed groups and each policy's gaps.
  app.get('/commercial/insurance', { preHandler: requireAdmin(Permission.FINANCE_POLICY_READ) }, async (request, reply) => noStore(reply).send(await finance.listInsurance(z.object({ holderType: z.enum(['SELLER', 'PLATFORM']).optional(), sellerAccountId: z.string().length(26).optional() }).parse(request.query))));

  // Record or update an insurance policy (returns it to PENDING verification).
  app.put('/commercial/insurance', { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE) }, async (request, reply) => {
    const body = z.object({ id: z.string().length(26).optional(), holderType: z.enum(['SELLER', 'PLATFORM']), sellerAccountId: z.string().length(26).nullable().optional(), coverType: z.string().min(2).max(32), riskGroup: z.enum(['GROUP_1', 'GROUP_2', 'GROUP_3']).nullable().optional(), insurer: z.string().min(2).max(200), policyNumber: z.string().min(1).max(120), insuredEntity: z.string().min(2).max(200), additionalInsured: z.string().max(400).nullable().optional(), sites: z.array(z.string().max(200)).max(50), products: z.array(z.string().max(200)).max(200), territories: z.array(z.string().max(80)).max(250), currency: z.string().length(3), perOccurrenceMinor: optMinor, aggregateMinor: optMinor, deductibleMinor: optMinor, exclusions: z.string().max(8000).nullable().optional(), claimsMadeRetroDate: isoDate.nullable().optional(), effectiveFrom: isoDate, expiresAt: isoDate, cancellationNoticeDays: z.number().int().min(0).max(365).nullable().optional(), brokerName: z.string().max(200).nullable().optional(), brokerReviewedAt: isoDate.nullable().optional(), brokerReviewRef: z.string().max(200).nullable().optional() }).parse(request.body);
    const big = (v: string | null | undefined) => (v ? BigInt(v) : null);
    return reply.send(await finance.saveInsurancePolicy({ ...body, perOccurrenceMinor: big(body.perOccurrenceMinor), aggregateMinor: big(body.aggregateMinor), deductibleMinor: big(body.deductibleMinor) }, adminActor(request)));
  });

  // Verify an insurance policy with the insurer (not by its recorder).
  app.post('/commercial/insurance/:id/verify', { preHandler: requireAdmin(Permission.FINANCE_TAX_VERIFY) }, async (request, reply) => {
    await finance.verifyInsurancePolicy(id26.parse(request.params).id, z.object({ verified: z.boolean(), method: z.string().min(3).max(200) }).parse(request.body), adminActor(request));
    return reply.status(204).send();
  });

  // Propose the bespoke 30/60/10 plan on a business order (needs the adopted schedule).
  app.post('/orders/:id/payment-plan', { preHandler: requireAdmin(Permission.ORDER_APPROVE) }, async (request, reply) => reply.status(201).send(await evidence.proposePaymentPlan(id26.parse(request.params).id, adminActor(request))));

  // Record seller, buyer or provider agreement to the plan.
  app.post('/orders/:id/payment-plan/agreement', { preHandler: requireAdmin(Permission.ORDER_APPROVE) }, async (request, reply) => reply.send(await evidence.recordPaymentPlanAgreement(id26.parse(request.params).id, z.object({ party: z.enum(['SELLER', 'BUYER', 'PROVIDER']), providerConfirmationRef: z.string().max(200).nullable().optional() }).parse(request.body), adminActor(request))));

  // Country launch overview.
  app.get('/commercial/launch', { preHandler: requireAdmin(Permission.SETTINGS_READ) }, async (_request, reply) => noStore(reply).send({ countries: await evidence.listLaunches() }));

  // One country's launch decisions and blockers.
  app.get('/commercial/launch/:countryCode', { preHandler: requireAdmin(Permission.SETTINGS_READ) }, async (request, reply) => noStore(reply).send(await evidence.readLaunch(z.object({ countryCode: country }).parse(request.params).countryCode)));

  // Update a launch decision's owner, scope, evidence and expiry.
  app.put('/commercial/launch/:countryCode/:key', { preHandler: requireAdmin(Permission.SETTINGS_WRITE) }, async (request, reply) => {
    const p = z.object({ countryCode: country, key: z.string().min(2).max(48) }).parse(request.params);
    const body = z.object({ status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'NOT_APPLICABLE']), ownerName: z.string().max(120).nullable().optional(), ownerUserId: z.string().length(26).nullable().optional(), scope: z.string().max(4000).nullable().optional(), evidence: z.string().max(8000).nullable().optional(), expiresAt: isoDate.nullable().optional(), blockingReason: z.string().max(2000).nullable().optional(), sourceCheckedOn: isoDate.nullable().optional(), sourceNote: z.string().max(2000).nullable().optional() }).parse(request.body);
    await evidence.saveLaunchItem(p.countryCode, p.key, body, adminActor(request));
    return reply.status(204).send();
  });

  // Approve or reject a launch decision (not by its owner).
  app.post('/commercial/launch/:countryCode/:key/review', { preHandler: requireAdmin(Permission.FEATURE_FLAG_WRITE) }, async (request, reply) => {
    const p = z.object({ countryCode: country, key: z.string().min(2).max(48) }).parse(request.params);
    await evidence.reviewLaunchItem(p.countryCode, p.key, z.object({ approve: z.boolean(), note: z.string().min(3).max(2000) }).parse(request.body), adminActor(request));
    return reply.status(204).send();
  });

  // Enable a country (refused while any decision is open).
  app.post('/commercial/launch/:countryCode/enable', { preHandler: requireAdmin(Permission.FEATURE_FLAG_WRITE) }, async (request, reply) => {
    await evidence.enableCountry(z.object({ countryCode: country }).parse(request.params).countryCode, z.object({ note: z.string().min(3).max(2000) }).parse(request.body).note, adminActor(request));
    return reply.status(204).send();
  });

  // Disable a country.
  app.post('/commercial/launch/:countryCode/disable', { preHandler: requireAdmin(Permission.FEATURE_FLAG_WRITE) }, async (request, reply) => {
    await evidence.disableCountry(z.object({ countryCode: country }).parse(request.params).countryCode, z.object({ note: z.string().min(3).max(2000) }).parse(request.body).note, adminActor(request));
    return reply.status(204).send();
  });

  // Product evidence, read only (the Audit Console verifies it).
  app.get('/commercial/product-evidence', { preHandler: requireAdmin(Permission.INSPECTION_READ) }, async (request, reply) => noStore(reply).send({ evidence: await evidence.listEvidence(z.object({ sellerAccountId: z.string().length(26).optional(), offerId: z.string().length(26).optional(), countryCode: country.optional() }).parse(request.query)) }));

  // Safety cases, read only (the Audit Console decides them).
  app.get('/commercial/safety-cases', { preHandler: requireAdmin(Permission.INSPECTION_READ) }, async (request, reply) => noStore(reply).send({ cases: await safety.listSafetyCases(z.object({ status: z.string().max(20).optional() }).parse(request.query).status) }));

  // One safety case, read only.
  app.get('/commercial/safety-cases/:id', { preHandler: requireAdmin(Permission.INSPECTION_READ) }, async (request, reply) => noStore(reply).send(await safety.readSafetyCase(id26.parse(request.params).id)));

  return Promise.resolve();
}

// ===========================================================================
// Audit Console
// ===========================================================================

const evidenceBody = z.object({ sellerAccountId: z.string().length(26), offerId: z.string().length(26).nullable().optional(), productKey: z.string().min(1).max(64), productVersion: z.string().min(1).max(64), facilityRef: z.string().min(1).max(64), countryCode: country, departmentSlug: z.string().max(120).nullable().optional(), kind: z.enum(PRODUCT_EVIDENCE_KINDS), scheme: z.string().min(2).max(200), issuer: z.string().min(2).max(200), accreditation: z.string().max(200).nullable().optional(), scope: z.string().min(3).max(4000), certificateNumber: z.string().max(120).nullable().optional(), issuedOn: isoDate.nullable().optional(), expiresOn: isoDate.nullable().optional(), changeConditions: z.string().max(4000).nullable().optional(), surveillanceDueAt: isoDate.nullable().optional(), requiredForTrading: z.boolean(), existingAccepted: z.boolean().optional(), gapAssessment: z.string().max(4000).nullable().optional() });
const scopeItem = z.object({ kind: z.enum(safety.SAFETY_SCOPE_KINDS), ref: z.string().min(1).max(128), label: z.string().max(200).nullable().optional() });
const severity = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);

export function registerAuditCommercialPolicyRoutes(app: FastifyInstance): Promise<void> {
  // Product evidence per SKU/version, site and country.
  app.get('/product-evidence', { preHandler: requireAudit(AuditPermission.ASSESSMENT_READ) }, async (request, reply) => noStore(reply).send({ evidence: await evidence.listEvidence(z.object({ sellerAccountId: z.string().length(26).optional(), offerId: z.string().length(26).optional(), countryCode: country.optional() }).parse(request.query)) }));

  // Doc 08 s8 reviewer prompts for a department.
  app.get('/product-evidence/prompts', { preHandler: requireAudit(AuditPermission.ASSESSMENT_READ) }, async (request, reply) => noStore(reply).send({ ...evidence.assurancePrompts(z.object({ departmentSlug: z.string().max(120).optional() }).parse(request.query).departmentSlug ?? null), matrix: DOC08_ASSURANCE_MATRIX }));

  // Record a piece of product evidence.
  app.post('/product-evidence', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK) }, async (request, reply) => reply.status(201).send(await evidence.recordEvidence(evidenceBody.parse(request.body), auditActor(request))));

  // Verify, suspend, withdraw or reject evidence (verification not by its recorder).
  app.post('/product-evidence/:id/status', { preHandler: requireAudit(AuditPermission.SELLER_VERIFY) }, async (request, reply) => {
    const body = z.object({ status: z.enum(['UNVERIFIED', 'VERIFIED', 'SUSPENDED', 'WITHDRAWN', 'EXPIRED', 'REJECTED']), method: z.string().max(200).nullable().optional(), evidence: z.string().max(4000).nullable().optional(), reason: z.string().max(2000).nullable().optional() }).parse(request.body);
    await evidence.setEvidenceStatus(id26.parse(request.params).id, body, auditActor(request));
    return reply.status(204).send();
  });

  // Safety cases.
  app.get('/safety-cases', { preHandler: requireAudit(AuditPermission.ASSESSMENT_READ) }, async (request, reply) => noStore(reply).send({ cases: await safety.listSafetyCases(z.object({ status: z.string().max(20).optional() }).parse(request.query).status), rehearsal: await safety.rehearsalStatus() }));

  // One safety case with its scope and actions.
  app.get('/safety-cases/:id', { preHandler: requireAudit(AuditPermission.ASSESSMENT_READ) }, async (request, reply) => noStore(reply).send(await safety.readSafetyCase(id26.parse(request.params).id)));

  // Trace what a case reaches: orders, customers, countries, unshipped orders, repeat orders, stock.
  app.get('/safety-cases/:id/trace', { preHandler: requireAudit(AuditPermission.ASSESSMENT_READ) }, async (request, reply) => noStore(reply).send(await safety.traceSafetyCase(id26.parse(request.params).id)));

  // Open a safety case.
  app.post('/safety-cases', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK) }, async (request, reply) => {
    const body = z.object({ title: z.string().min(3).max(200), description: z.string().min(5).max(8000), severity, sourceType: z.enum(['DISPUTE', 'INCIDENT', 'SURVEILLANCE', 'STAFF', 'AUTHORITY', 'REHEARSAL']), sourceId: z.string().length(26).nullable().optional(), sellerAccountId: z.string().length(26).nullable().optional(), scope: z.array(scopeItem).max(200) }).parse(request.body);
    return reply.status(201).send(await safety.openSafetyCase(body, auditActor(request)));
  });

  // Triage and contain: stop listings, shipments and repeat orders in scope.
  app.post('/safety-cases/:id/contain', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK) }, async (request, reply) => {
    const body = z.object({ severity, stopListings: z.boolean(), stopShipments: z.boolean(), stopRecurring: z.boolean(), note: z.string().min(3).max(4000), addScope: z.array(scopeItem).max(200).optional() }).parse(request.body);
    await safety.containSafetyCase(id26.parse(request.params).id, body, auditActor(request));
    return reply.status(204).send();
  });

  // Record a reporting decision, notice, recall action or effectiveness check.
  app.post('/safety-cases/:id/actions', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK) }, async (request, reply) => {
    const body = z.object({ kind: z.enum(safety.SAFETY_ACTION_KINDS), detail: z.string().min(3).max(8000), authority: z.string().max(200).nullable().optional(), decision: z.enum(['REPORT', 'NOT_REQUIRED', 'PENDING_ADVICE']).nullable().optional(), deadlineAt: isoDate.nullable().optional(), qualifiedRole: z.string().max(120).nullable().optional(), quantity: z.number().int().min(0).nullable().optional(), effectivenessPercentBp: z.number().int().min(0).max(10_000).nullable().optional(), aiGenerated: z.boolean().optional() }).parse(request.body);
    await safety.recordSafetyAction(id26.parse(request.params).id, body, auditActor(request));
    return reply.status(204).send();
  });

  // Record the cause, correction, tests and current certificates.
  app.post('/safety-cases/:id/correction', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK) }, async (request, reply) => {
    const body = z.object({ rootCause: z.string().min(5).max(8000), correctionEvidence: z.string().min(5).max(8000), verificationTests: z.string().min(5).max(8000), currentCertificates: z.string().min(5).max(8000) }).parse(request.body);
    await safety.recordCorrection(id26.parse(request.params).id, body, auditActor(request));
    return reply.status(204).send();
  });

  // Human release (not by the person who opened the case).
  app.post('/safety-cases/:id/release', { preHandler: requireAudit(AuditPermission.RELEASE_REQUEST) }, async (request, reply) => {
    await safety.releaseSafetyCase(id26.parse(request.params).id, z.object({ note: z.string().min(3).max(4000) }).parse(request.body), auditActor(request));
    return reply.status(204).send();
  });

  // Record an annual recall-traceability rehearsal.
  app.post('/recall-rehearsals', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK) }, async (request, reply) => {
    const body = z.object({ scenario: z.string().min(5).max(4000), scopeTraced: z.string().min(5).max(4000), minutesToTrace: z.number().int().min(0).nullable().optional(), findings: z.string().max(8000).nullable().optional(), outcome: z.enum(['PASSED', 'GAPS_FOUND', 'FAILED']), performedAt: isoDate }).parse(request.body);
    return reply.status(201).send(await safety.recordRehearsal(body, auditActor(request)));
  });

  return Promise.resolve();
}

// ===========================================================================
// Seller
// ===========================================================================

async function ownReturn(request: FastifyRequest): Promise<string> {
  const { id } = id26.parse(request.params);
  const r = await prisma.returnRequest.findUnique({ where: { id }, select: { sellerOrderGroup: { select: { sellerAccountId: true } } } });
  if (r?.sellerOrderGroup?.sellerAccountId !== currentSeller(request).sellerAccountId) throw notFound('Return');
  return id;
}

export function registerSellerCommercialPolicyRoutes(app: FastifyInstance): Promise<void> {
  // My order's acceptance controls and frozen terms (commission rate, base, rule version, rounding).
  app.get('/orders/:id/controls', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => noStore(reply).send(await orders.readGroupControls(id26.parse(request.params).id, { sellerAccountId: currentSeller(request).sellerAccountId })));

  // Record missing acceptance controls while my order is NEW.
  app.patch('/orders/:id/controls', { preHandler: requireSeller(SellerPermission.ORDER_FULFIL) }, async (request, reply) => {
    await orders.recordAcceptanceControls(id26.parse(request.params).id, controlsBody.parse(request.body), sellerActor(request));
    return reply.status(204).send();
  });

  // My order's dispatch controls and the gate's open gaps.
  app.get('/orders/:id/dispatch-controls', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => noStore(reply).send(await logistics.readDispatchControls(id26.parse(request.params).id, { sellerAccountId: currentSeller(request).sellerAccountId })));

  // Record a freight booking for my order.
  app.put('/orders/:id/freight-booking', { preHandler: requireSeller(SellerPermission.ORDER_FULFIL) }, async (request, reply) => reply.send(await logistics.saveFreightBooking(id26.parse(request.params).id, bookingBody.parse(request.body), sellerActor(request))));

  // Record dispatch evidence for my order.
  app.put('/orders/:id/dispatch-evidence', { preHandler: requireSeller(SellerPermission.ORDER_FULFIL) }, async (request, reply) => reply.send(await logistics.saveDispatchEvidence(id26.parse(request.params).id, dispatchBody.parse(request.body), { ...sellerActor(request), role: 'SELLER' })));

  // Record a custody handover for my order.
  app.post('/orders/:id/custody-handovers', { preHandler: requireSeller(SellerPermission.ORDER_FULFIL) }, async (request, reply) => reply.status(201).send(await logistics.recordCustodyHandover(id26.parse(request.params).id, custodyBody.parse(request.body), { ...sellerActor(request), role: 'SELLER' })));

  // Case requests addressed to me on one of my disputes.
  app.get('/disputes/:reference/case-controls', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => {
    const { reference } = z.object({ reference: z.string().min(4).max(16) }).parse(request.params);
    const d = await prisma.dispute.findFirst({ where: { reference, sellerAccountId: currentSeller(request).sellerAccountId }, select: { id: true } });
    if (d === null) throw notFound('Dispute');
    return noStore(reply).send(await cases.readPartyCaseControls(d.id, 'SELLER'));
  });

  // Answer an evidence request addressed to me.
  app.post('/disputes/:reference/case-controls/evidence-requests/:requestId', { preHandler: requireSeller(SellerPermission.RETURN_HANDLE) }, async (request, reply) => {
    const p = z.object({ reference: z.string().min(4).max(16), requestId: z.string().length(26) }).parse(request.params);
    const d = await prisma.dispute.findFirst({ where: { reference: p.reference, sellerAccountId: currentSeller(request).sellerAccountId }, select: { id: true } });
    if (d === null) throw notFound('Dispute');
    await cases.answerEvidenceRequest(p.requestId, 'SELLER', z.object({ note: z.string().min(3).max(8000) }).parse(request.body).note, { disputeId: d.id });
    return reply.status(204).send();
  });

  // Issue a return authorisation for one of my returns.
  app.put('/returns/:id/authorization', { preHandler: requireSeller(SellerPermission.RETURN_HANDLE) }, async (request, reply) => reply.send(await evidence.issueReturnAuthorization(await ownReturn(request), raBody.parse(request.body), sellerActor(request))));

  // Record receipt and inspection evidence for one of my returns.
  app.patch('/returns/:id/authorization', { preHandler: requireSeller(SellerPermission.RETURN_HANDLE) }, async (request, reply) => {
    const b = raEvidenceBody.parse(request.body);
    await evidence.recordReturnEvidence(await ownReturn(request), { ...b, deductionMinor: b.deductionMinor ? BigInt(b.deductionMinor) : null }, sellerActor(request));
    return reply.status(204).send();
  });

  // My return's authorisation.
  app.get('/returns/:id/authorization', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => noStore(reply).send({ authorization: await evidence.readReturnAuthorization(await ownReturn(request)) }));

  // My fees: commission reversals proposed for my orders, and my security schedules.
  app.get('/commercial/fees', { preHandler: requireSeller(SellerPermission.FINANCE_READ) }, async (request, reply) => {
    const sellerAccountId = currentSeller(request).sellerAccountId;
    const groups = await prisma.sellerOrderGroup.findMany({ where: { sellerAccountId }, select: { id: true }, orderBy: { createdAt: 'desc' }, take: 200 });
    const adjustments = await prisma.commissionAdjustment.findMany({ where: { sellerOrderGroupId: { in: groups.map((g) => g.id) } }, orderBy: { createdAt: 'desc' } });
    return noStore(reply).send(serialise({ adjustments, security: await finance.listSecurity(sellerAccountId), programmes: await finance.listProgrammes(sellerAccountId) }));
  });

  return Promise.resolve();
}

// ===========================================================================
// Buyer
// ===========================================================================

export function registerCustomerCommercialPolicyRoutes(app: FastifyInstance): Promise<void> {
  // My claim's case facts, requests to me and the decided remedies.
  app.get('/disputes/:reference/case-controls', { preHandler: requireCustomerForRemedies }, async (request, reply) => {
    const { reference } = z.object({ reference: z.string().min(4).max(16) }).parse(request.params);
    const d = await prisma.dispute.findFirst({ where: { reference, order: orderScopeWhere(request) }, select: { id: true } });
    if (d === null) throw notFound('Dispute');
    return noStore(reply).send({ ...((await cases.readPartyCaseControls(d.id, 'BUYER')) as object), categories: CASE_CATEGORIES });
  });

  // Answer an evidence request addressed to me (including material contrary evidence).
  app.post('/disputes/:reference/case-controls/evidence-requests/:requestId', { preHandler: requireCustomerForRemedies }, async (request, reply) => {
    const p = z.object({ reference: z.string().min(4).max(16), requestId: z.string().length(26) }).parse(request.params);
    const d = await prisma.dispute.findFirst({ where: { reference: p.reference, order: orderScopeWhere(request) }, select: { id: true } });
    if (d === null) throw notFound('Dispute');
    await cases.answerEvidenceRequest(p.requestId, 'BUYER', z.object({ note: z.string().min(3).max(8000) }).parse(request.body).note, { disputeId: d.id });
    return reply.status(204).send();
  });

  // My order's refunds: when each was instructed and the provider's actual status.
  app.get('/orders/:id/refund-status', { preHandler: requireCustomerForRemedies }, async (request, reply) => {
    const { id } = id26.parse(request.params);
    const order = await prisma.order.findFirst({ where: { id, ...orderScopeWhere(request) }, select: { id: true } });
    if (order === null) throw notFound('Order');
    return noStore(reply).send({ refunds: await finance.refundStatusView(id) });
  });

  return Promise.resolve();
}

// ===========================================================================
// Logistics partner portal
// ===========================================================================

/** The seller order behind a shipment assigned to the caller's company; 404 for anything else. */
async function partnerGroup(request: FastifyRequest): Promise<string> {
  const { id } = id26.parse(request.params);
  const shipment = await prisma.logisticsShipment.findUnique({ where: { id }, select: { assignedPartnerId: true, sellerOrderGroupId: true } });
  if (shipment === null || shipment.assignedPartnerId !== currentLogistics(request).logisticsPartnerId || shipment.sellerOrderGroupId === null) throw notFound('Shipment');
  return shipment.sellerOrderGroupId;
}

export function registerLogisticsCommercialPolicyRoutes(app: FastifyInstance): Promise<void> {
  // Custody, documents and the dispatch gaps for a shipment assigned to my company.
  app.get('/shipments/:id/custody', { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_READ) }, async (request, reply) => {
    const view = (await logistics.readDispatchControls(await partnerGroup(request))) as { gaps?: unknown; documents?: unknown; custody?: unknown; requirements?: unknown };
    return noStore(reply).send({ gaps: view.gaps ?? [], documents: view.documents ?? [], custody: view.custody ?? [], requirements: view.requirements ?? [] });
  });

  // Record a custody handover for a shipment assigned to my company.
  app.post('/shipments/:id/custody', { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_STATUS_WRITE) }, async (request, reply) => {
    const groupId = await partnerGroup(request);
    const u = currentUser(request);
    return reply.status(201).send(await logistics.recordCustodyHandover(groupId, custodyBody.parse(request.body), { userId: u.id, email: u.email, actorType: 'LOGISTICS', ipAddress: request.ip, correlationId: request.correlationId, role: 'PARTNER' }));
  });

  return Promise.resolve();
}
