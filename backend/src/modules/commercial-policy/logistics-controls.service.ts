/**
 * Logistics booking, documents and dispatch evidence (Doc 07 s3-s5).
 *
 * Reuses what exists: trade documents (with their review status) hold the
 * export and import documents; the L1-L4 legs and Shipment Assessment stay
 * exactly where they are. This adds what the policy asks to be recorded and
 * checked: the booking facts and compared quotes, the provider screening,
 * route handling requirements, dispatch evidence and custody handovers, and
 * partial-shipment approval.
 *
 * No provider connection or verification is ever faked: a provider with no
 * live integration is "Credentials required", and every review item is only
 * as verified as the evidence a person recorded for it.
 */
import {
  CUSTOMS_DOCUMENT_KINDS,
  PROVIDER_REVIEW_ITEMS,
  dispatchGaps,
  logisticsCoordination,
  partialShipmentProblems,
  quoteSelectionProblems,
  type CustomsDocumentKind,
  type HandlingRequirementKind,
} from '../../domain/commercial-policy.js';
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction } from '../audit/audit.service.js';
import { deliveryGateMode } from './order-controls.service.js';
import { activeSchedule } from './schedules.service.js';
import { audit, serialise, type Client, type StaffActor } from './shared.js';

/** A material freight commitment: at or above this external cost, two comparable quotes or a reason. INR 50,000 by default; a setting. */
export const MATERIAL_FREIGHT_MINOR = 5_000_000n;

/** Documents needed before an export leaves (cross-border). Import release is tracked, but is the importer's step after arrival. */
export const EXPORT_DISPATCH_DOCUMENTS: readonly CustomsDocumentKind[] = ['COMMERCIAL_INVOICE', 'PACKING_LIST', 'ORIGIN_EVIDENCE', 'CLASSIFICATION', 'VALUATION'];

type GroupScope = { sellerAccountId?: string };

async function loadGroup(client: Client, groupId: string, scope: GroupScope) {
  const g = await client.sellerOrderGroup.findUnique({ where: { id: groupId }, select: { id: true, orderId: true, sellerAccountId: true, status: true, currency: true, lines: { select: { orderItemId: true, quantity: true } } } });
  if (g === null || (scope.sellerAccountId !== undefined && g.sellerAccountId !== scope.sellerAccountId)) throw notFound('Seller order');
  return g;
}

// --- Booking and quotes ------------------------------------------------------

export interface BookingInput {
  lane: string;
  grossWeightGrams: number;
  dimensions: { lengthMm: number; widthMm: number; heightMm: number; packages: number };
  packaging: string;
  hazardClass?: string | null;
  cargoCover?: { insurer?: string; insuredValueMinor?: string; exclusions?: string; insuredParties?: string } | null;
  custody: { leg: string; responsible: string }[];
  returnCapability?: string | null;
  singleSourceReason?: string | null;
  quotes: { providerName: string; logisticsPartnerId?: string | null; amountMinor: string; currency: string; transitDaysMin?: number | null; transitDaysMax?: number | null; cargoCover?: string | null; comparable?: boolean; validUntil?: Date | null; reference?: string | null }[];
  selectedIndex: number | null;
}

/** Record or replace a booking with its quotes. The coordination charge follows the ACTIVE logistics schedule, if any; otherwise none is computed. */
export async function saveFreightBooking(groupId: string, input: BookingInput, actor: StaffActor & GroupScope) {
  return prisma.$transaction(async (tx) => {
    const g = await loadGroup(tx, groupId, actor);
    const selected = input.selectedIndex === null ? null : input.quotes[input.selectedIndex] ?? null;
    const externalCost = selected === null ? null : BigInt(selected.amountMinor);
    const comparable = input.quotes.filter((q) => q.comparable !== false).length;
    const problems = quoteSelectionProblems({ materialCommitment: (externalCost ?? 0n) >= MATERIAL_FREIGHT_MINOR, comparableQuotes: comparable, singleSourceReason: input.singleSourceReason ?? null });
    if (problems.length > 0 && selected !== null) throw conflict(ErrorCode.VALIDATION_FAILED, 'A material freight commitment needs two comparable quotes, or a recorded reason for a single source.', problems.map((code) => ({ code })));
    const schedule = await activeSchedule(tx, 'LOGISTICS_CHARGE', { country: null, channel: 'B2B', sellerAccountId: g.sellerAccountId });
    const body = (schedule?.bodyJson ?? null) as { bps?: number; capMinor?: string | null } | null;
    const coordination = externalCost === null || body === null ? null : logisticsCoordination(externalCost, { kind: 'COST_PLUS', bps: body.bps ?? 500, capMinor: body.capMinor ? BigInt(body.capMinor) : null });
    const existing = await tx.freightBooking.findUnique({ where: { sellerOrderGroupId: groupId } });
    const bookingId = existing?.id ?? newId();
    if (existing !== null) await tx.freightQuoteOption.deleteMany({ where: { bookingId } });
    const quoteIds = input.quotes.map(() => newId());
    const data = {
      lane: input.lane,
      grossWeightGrams: input.grossWeightGrams,
      dimensionsJson: input.dimensions as never,
      packaging: input.packaging,
      hazardClass: input.hazardClass ?? null,
      cargoCoverJson: (input.cargoCover ?? null) as never,
      custodyJson: input.custody as never,
      returnCapability: input.returnCapability ?? null,
      materialCommitment: (externalCost ?? 0n) >= MATERIAL_FREIGHT_MINOR,
      selectedQuoteId: input.selectedIndex === null ? null : (quoteIds[input.selectedIndex] ?? null),
      singleSourceReason: input.singleSourceReason ?? null,
      externalCostMinor: externalCost,
      coordinationMinor: coordination?.coordinationMinor ?? null,
      currency: selected?.currency ?? g.currency,
      status: selected === null ? 'DRAFT' : 'SELECTED',
      recordedById: actor.userId,
    };
    if (existing === null) await tx.freightBooking.create({ data: { id: bookingId, sellerOrderGroupId: groupId, ...data } });
    else await tx.freightBooking.update({ where: { id: bookingId }, data });
    if (input.quotes.length > 0) {
      await tx.freightQuoteOption.createMany({
        data: input.quotes.map((q, i) => ({ id: quoteIds[i] ?? newId(), bookingId, providerName: q.providerName, logisticsPartnerId: q.logisticsPartnerId ?? null, amountMinor: BigInt(q.amountMinor), currency: q.currency, transitDaysMin: q.transitDaysMin ?? null, transitDaysMax: q.transitDaysMax ?? null, cargoCover: q.cargoCover ?? null, comparable: q.comparable !== false, validUntil: q.validUntil ?? null, reference: q.reference ?? null })),
      });
    }
    await audit(tx, actor, AuditAction.LOGISTICS_CONTROL_RECORDED, 'freight_booking', bookingId, existing, { ...data, quotes: input.quotes.length });
    return { id: bookingId, coordination: serialise(coordination) };
  });
}

// --- Provider review -----------------------------------------------------------

export type ReviewItemState = { status: 'VERIFIED' | 'PENDING' | 'NOT_APPLICABLE' | 'FAILED'; evidence?: string | null };

export async function saveProviderReview(input: { id?: string; providerName: string; logisticsPartnerId?: string | null; items: Partial<Record<(typeof PROVIDER_REVIEW_ITEMS)[number], ReviewItemState>> }, actor: StaffActor) {
  const items = Object.fromEntries(PROVIDER_REVIEW_ITEMS.map((k) => [k, input.items[k] ?? { status: 'PENDING', evidence: null }]));
  // A verified item without evidence is only "pending": nothing is passed on a say-so.
  for (const k of PROVIDER_REVIEW_ITEMS) {
    const it = items[k] as ReviewItemState;
    if (it.status === 'VERIFIED' && (it.evidence ?? '').trim() === '') items[k] = { status: 'PENDING', evidence: null };
  }
  const integration = input.logisticsPartnerId ? await prisma.carrierIntegration.count({ where: { partners: { some: { id: input.logisticsPartnerId } }, state: 'ACTIVE', credentialsEnc: { not: null } } }) : 0;
  const data = { providerName: input.providerName, logisticsPartnerId: input.logisticsPartnerId ?? null, itemsJson: items as never, integrationStatus: integration > 0 ? 'CONNECTED' : 'CREDENTIALS_REQUIRED', status: 'IN_REVIEW', reviewerUserId: null, reviewedAt: null, recordedById: actor.userId };
  const id = input.id ?? newId();
  if (input.id) await prisma.logisticsProviderReview.update({ where: { id }, data });
  else await prisma.logisticsProviderReview.create({ data: { id, ...data } });
  await audit(prisma, actor, AuditAction.LOGISTICS_CONTROL_RECORDED, 'logistics_provider_review', id, null, data);
  return { id };
}

/** Approve a provider review: every item verified with evidence or marked not applicable, by someone other than the recorder. */
export async function decideProviderReview(id: string, approve: boolean, actor: StaffActor) {
  const { separationRefusal } = await import('./shared.js');
  const row = await prisma.logisticsProviderReview.findUnique({ where: { id } });
  if (row === null) throw notFound('Provider review');
  if (row.recordedById === actor.userId) throw separationRefusal('REVIEWER_IS_RECORDER', 'The person who recorded this review cannot approve it.');
  const items = row.itemsJson as Record<string, ReviewItemState>;
  const open = PROVIDER_REVIEW_ITEMS.filter((k) => !['VERIFIED', 'NOT_APPLICABLE'].includes(items[k]?.status ?? 'PENDING'));
  if (approve && open.length > 0) throw conflict(ErrorCode.VALIDATION_FAILED, 'Every screening item must be verified with evidence, or marked not applicable, before approval.', open.map((code) => ({ code })));
  const now = new Date();
  await prisma.logisticsProviderReview.update({ where: { id }, data: { status: approve ? 'APPROVED' : 'REJECTED', reviewerUserId: actor.userId, reviewedAt: now, nextReviewAt: approve ? new Date(now.getTime() + 365 * 86_400_000) : null } });
  await audit(prisma, actor, AuditAction.LOGISTICS_CONTROL_RECORDED, 'logistics_provider_review', id, { status: row.status }, { status: approve ? 'APPROVED' : 'REJECTED' });
}

export async function listProviderReviews() {
  return serialise(await prisma.logisticsProviderReview.findMany({ orderBy: { updatedAt: 'desc' }, take: 200 }));
}

// --- Handling requirements -------------------------------------------------------

export async function listHandlingRequirements() {
  return serialise(await prisma.handlingRequirement.findMany({ orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] }));
}

export async function saveHandlingRequirement(input: { id?: string; kind: HandlingRequirementKind; categoryId?: string | null; destinationCountry?: string | null; requiredEvidence: string; isActive: boolean }, actor: StaffActor) {
  const id = input.id ?? newId();
  const data = { kind: input.kind, categoryId: input.categoryId ?? null, destinationCountry: input.destinationCountry?.toUpperCase() ?? null, requiredEvidence: input.requiredEvidence, isActive: input.isActive };
  if (input.id) await prisma.handlingRequirement.update({ where: { id }, data });
  else await prisma.handlingRequirement.create({ data: { id, ...data, createdById: actor.userId } });
  await audit(prisma, actor, AuditAction.LOGISTICS_CONTROL_RECORDED, 'handling_requirement', id, null, data);
  return { id };
}

// --- Dispatch evidence and custody ----------------------------------------------

export interface DispatchEvidenceInput {
  quantities: { orderItemId: string; quantity: number }[];
  lots?: { orderItemId: string; lot?: string; serial?: string }[];
  seals?: string[];
  packingPhotoRefs?: string[];
  temperatureLogRef?: string | null;
  handlingEvidence?: { kind: HandlingRequirementKind; evidence: string }[];
}

export async function saveDispatchEvidence(groupId: string, input: DispatchEvidenceInput, actor: StaffActor & GroupScope & { role: 'SELLER' | 'STAFF' | 'PARTNER' }) {
  return prisma.$transaction(async (tx) => {
    const g = await loadGroup(tx, groupId, actor);
    const known = new Set(g.lines.map((l) => l.orderItemId));
    if (input.quantities.some((q) => !known.has(q.orderItemId))) throw conflict(ErrorCode.VALIDATION_FAILED, 'A quantity names a line that is not in this order.');
    const data = { quantitiesJson: input.quantities as never, lotsJson: (input.lots ?? null) as never, sealsJson: (input.seals ?? null) as never, packingPhotoRefsJson: (input.packingPhotoRefs ?? null) as never, temperatureLogRef: input.temperatureLogRef ?? null, handlingEvidenceJson: (input.handlingEvidence ?? null) as never, recordedById: actor.userId, recordedByRole: actor.role };
    const row = await tx.dispatchEvidence.upsert({ where: { sellerOrderGroupId: groupId }, create: { id: newId(), sellerOrderGroupId: groupId, ...data }, update: data });
    await audit(tx, actor, AuditAction.LOGISTICS_CONTROL_RECORDED, 'dispatch_evidence', row.id, null, { groupId, role: actor.role });
    return { id: row.id };
  });
}

export async function recordCustodyHandover(groupId: string, input: { shipmentLegId?: string | null; fromParty: string; toParty: string; place: string; handedOverAt: Date; packages: number; sealsIntact: boolean; exceptionNote?: string | null }, actor: StaffActor & GroupScope & { role: 'SELLER' | 'STAFF' | 'PARTNER' }) {
  await loadGroup(prisma, groupId, actor);
  const id = newId();
  await prisma.custodyHandover.create({ data: { id, sellerOrderGroupId: groupId, shipmentLegId: input.shipmentLegId ?? null, fromParty: input.fromParty, toParty: input.toParty, place: input.place, handedOverAt: input.handedOverAt, packages: input.packages, sealsIntact: input.sealsIntact, exceptionNote: input.exceptionNote ?? null, recordedById: actor.userId, recordedByRole: actor.role } });
  await audit(prisma, actor, AuditAction.LOGISTICS_CONTROL_RECORDED, 'custody_handover', id, null, { groupId, ...input });
  return { id };
}

/** Partial shipment: explicit order approval, proportionate billing, and never past a no-partial-release assessment. */
export async function approvePartialShipment(groupId: string, input: { orderApprovalRef: string; approvedByParty: 'BUYER' | 'STAFF'; quantities: { orderItemId: string; quantity: number }[] }, actor: StaffActor & GroupScope) {
  return prisma.$transaction(async (tx) => {
    const g = await loadGroup(tx, groupId, actor);
    const assessment = await tx.shipmentAssessment.findFirst({ where: { sellerOrderGroupId: groupId }, select: { id: true } }).catch(() => null);
    const ordered = g.lines.reduce((s, l) => s + l.quantity, 0);
    const shipping = input.quantities.reduce((s, q) => s + q.quantity, 0);
    const problems = partialShipmentProblems({ orderApprovalRef: input.orderApprovalRef, assessmentForbidsPartial: assessment !== null, shippedQuantity: shipping, orderedQuantity: ordered });
    if (problems.length > 0) throw conflict(ErrorCode.PARTIAL_SHIPMENT_NOT_ALLOWED, 'This partial shipment cannot be approved.', problems.map((code) => ({ code })));
    const items = await tx.orderItem.findMany({ where: { id: { in: input.quantities.map((q) => q.orderItemId) } }, select: { id: true, quantity: true, lineSubtotalMinor: true } });
    // Proportionate billing: each line's goods value x shipped / ordered, half-up.
    const billed = input.quantities.reduce((sum, q) => {
      const it = items.find((i) => i.id === q.orderItemId);
      if (it === undefined || it.quantity === 0) return sum;
      return sum + (it.lineSubtotalMinor * BigInt(q.quantity) * 2n + BigInt(it.quantity)) / (BigInt(it.quantity) * 2n);
    }, 0n);
    const id = newId();
    await tx.partialShipmentApproval.create({ data: { id, sellerOrderGroupId: groupId, orderApprovalRef: input.orderApprovalRef, approvedByParty: input.approvedByParty, quantitiesJson: input.quantities as never, billedMinor: billed, currency: g.currency, recordedById: actor.userId } });
    await audit(tx, actor, AuditAction.LOGISTICS_CONTROL_RECORDED, 'partial_shipment', id, null, { groupId, billedMinor: billed.toString() });
    return { id, billedMinor: billed.toString() };
  });
}

// --- The dispatch view and gate -------------------------------------------------

export async function customsDocumentStatus(client: Client, groupId: string) {
  const docs = await client.orderTradeDocument.findMany({ where: { orderGroupId: groupId, kind: { in: [...CUSTOMS_DOCUMENT_KINDS] } }, select: { kind: true, currentVersion: true, versions: { select: { version: true, validation: true }, orderBy: { version: 'desc' }, take: 1 } } });
  return CUSTOMS_DOCUMENT_KINDS.map((kind) => {
    const d = docs.find((x) => x.kind === kind);
    const latest = d?.versions[0];
    return { kind, status: latest === undefined ? 'MISSING' : latest.validation, requiredBeforeDispatch: EXPORT_DISPATCH_DOCUMENTS.includes(kind) };
  });
}

export async function dispatchFacts(client: Client, groupId: string) {
  const g = await client.sellerOrderGroup.findUnique({ where: { id: groupId }, select: { id: true, orderId: true, sellerAccountId: true, lines: { select: { orderItemId: true, offerId: true, quantity: true } }, order: { select: { status: true, grandTotalMinor: true, paidMinor: true, shippingAddressJson: true } } } });
  if (g === null) return null;
  const [evidence, custody, snapshots, plan, docs] = await Promise.all([
    client.dispatchEvidence.findUnique({ where: { sellerOrderGroupId: groupId } }),
    client.custodyHandover.count({ where: { sellerOrderGroupId: groupId } }),
    client.orderLineCommercialSnapshot.findMany({ where: { sellerOrderGroupId: groupId }, select: { deliveryTerm: true, transportRestrictionsJson: true, facilityRef: true } }),
    client.orderPaymentPlan.findUnique({ where: { orderId: g.orderId }, select: { status: true } }),
    customsDocumentStatus(client, groupId),
  ]);
  const crossBorder = snapshots.some((s) => s.deliveryTerm !== 'DOMESTIC');
  const requirements = snapshots.flatMap((s) => ((s.transportRestrictionsJson as { requirements?: { kind: HandlingRequirementKind }[] } | null)?.requirements ?? []).map((r) => r.kind));
  const provided = new Set(((evidence?.handlingEvidenceJson ?? []) as { kind: string; evidence: string }[]).filter((h) => h.evidence.trim() !== '').map((h) => h.kind));
  const temperatureRequired = requirements.includes('TEMPERATURE_CONTROL');
  const paid = g.order.paidMinor >= g.order.grandTotalMinor;
  const lots = (evidence?.lotsJson ?? []) as { lot?: string; serial?: string }[];
  const qty = (evidence?.quantitiesJson ?? []) as { orderItemId: string; quantity: number }[];
  const facts = {
    paymentReady: paid || plan?.status === 'APPROVED',
    inspectionPassed: true, // enforced by the existing inspection gate in the same transition; not duplicated here.
    requiredDocumentsValid: !crossBorder || docs.filter((d) => d.requiredBeforeDispatch).every((d) => d.status === 'VALID'),
    eligibilityCurrent: true, // enforced by the seller-assessment dispatch gate in the same transition.
    quantitiesRecorded: qty.length > 0 && g.lines.every((l) => qty.some((q) => q.orderItemId === l.orderItemId)),
    lotsOrSerialsRecorded: lots.length > 0,
    lotTrackingRequired: false,
    sealsRecorded: ((evidence?.sealsJson ?? []) as string[]).length > 0,
    packingPhotosRecorded: ((evidence?.packingPhotoRefsJson ?? []) as string[]).length > 0,
    custodyHandoverRecorded: custody > 0,
    temperatureRequired,
    temperatureEvidenceRecorded: (evidence?.temperatureLogRef ?? '').trim() !== '',
    handlingRequirementsMet: requirements.filter((k) => k !== 'TEMPERATURE_CONTROL').every((k) => provided.has(k)),
    safetyHold: false,
  };
  return { facts, gaps: dispatchGaps(facts), documents: docs, requirements: [...new Set(requirements)], offers: g.lines.map((l) => l.offerId), facilityRefs: snapshots.map((s) => s.facilityRef), lots: lots.flatMap((l) => [l.lot, l.serial].filter((v): v is string => typeof v === 'string')), sellerAccountId: g.sellerAccountId };
}

export async function readDispatchControls(groupId: string, scope: GroupScope = {}) {
  await loadGroup(prisma, groupId, scope);
  const [facts, booking, evidence, custody, partials] = await Promise.all([
    dispatchFacts(prisma, groupId),
    prisma.freightBooking.findUnique({ where: { sellerOrderGroupId: groupId } }),
    prisma.dispatchEvidence.findUnique({ where: { sellerOrderGroupId: groupId } }),
    prisma.custodyHandover.findMany({ where: { sellerOrderGroupId: groupId }, orderBy: { handedOverAt: 'asc' } }),
    prisma.partialShipmentApproval.findMany({ where: { sellerOrderGroupId: groupId } }),
  ]);
  const quotes = booking === null ? [] : await prisma.freightQuoteOption.findMany({ where: { bookingId: booking.id } });
  return serialise({ gateMode: deliveryGateMode(), ...facts, booking, quotes, evidence, custody, partials });
}

/**
 * The dispatch gate (READY_FOR_DISPATCH / SHIPPED / carrier departure).
 * Safety containment always applies; the evidence checks follow
 * `DELIVERY_POLICY_GATES`.
 */
export async function assertDispatchControls(client: Client, groupId: string): Promise<void> {
  const f = await dispatchFacts(client, groupId);
  if (f === null) return;
  const { assertNoSafetyHold } = await import('./safety.service.js');
  const products = await client.sellerOffer.findMany({ where: { id: { in: f.offers } }, select: { productId: true } });
  await assertNoSafetyHold(client, { offerIds: f.offers, productIds: products.map((p) => p.productId), sellerAccountIds: [f.sellerAccountId], facilityRefs: f.facilityRefs, lots: f.lots, purpose: 'DISPATCH' });
  const mode = deliveryGateMode();
  if (mode === 'off' || f.gaps.length === 0) return;
  if (mode === 'report') {
    logger.warn({ groupId, gaps: f.gaps }, 'dispatch controls would refuse (report mode)');
    return;
  }
  throw conflict(ErrorCode.DISPATCH_EVIDENCE_MISSING, 'This order cannot be dispatched until its dispatch evidence is recorded.', f.gaps.map((code) => ({ code })));
}
