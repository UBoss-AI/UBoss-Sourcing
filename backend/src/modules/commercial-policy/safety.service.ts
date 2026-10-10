/**
 * Product safety cases and recalls (Doc 07 s7, s11; Doc 08 s9).
 *
 * A credible safety report is triaged at once and contained to its scope -
 * the offers, products, sites or lots affected - not the seller's whole
 * catalogue. Containment is read live by checkout and dispatch, so it holds
 * the moment a person records it, whatever flag is set and whether or not a
 * job runs. It never stops anyone managing existing orders, returns, refunds
 * or remedies.
 *
 * Reporting to authorities is decided by a qualified person and recorded as
 * such; a decision marked as AI output is refused. Reinstatement needs the
 * containment, cause, correction, tests and current certificates on file and
 * a release by someone other than the person who opened the case.
 */
import { randomBytes } from 'node:crypto';
import { ErrorCode, AppError, conflict, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction } from '../audit/audit.service.js';
import { audit, separationRefusal, serialise, type Client, type StaffActor } from './shared.js';

export const SAFETY_SCOPE_KINDS = ['OFFER', 'PRODUCT', 'FACILITY', 'LOT', 'SELLER'] as const;
export type SafetyScopeKind = (typeof SAFETY_SCOPE_KINDS)[number];
export const SAFETY_ACTION_KINDS = ['REPORTING_DECISION', 'CUSTOMER_NOTICE', 'RETRIEVAL', 'DISPOSAL', 'REPAIR', 'REPLACEMENT', 'EFFECTIVENESS_CHECK', 'NOTE'] as const;
export type SafetyActionKind = (typeof SAFETY_ACTION_KINDS)[number];

const OPEN_STATUSES = ['TRIAGE', 'CONTAINED', 'INVESTIGATING', 'CORRECTIVE_ACTION', 'RELEASE_PENDING'];

function reference(): string {
  const r = randomBytes(4).toString('hex').toUpperCase();
  return `SC-${r.slice(0, 4)}-${r.slice(4)}`;
}

export async function openSafetyCase(input: { title: string; description: string; severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'; sourceType: 'DISPUTE' | 'INCIDENT' | 'SURVEILLANCE' | 'STAFF' | 'AUTHORITY' | 'REHEARSAL'; sourceId?: string | null; sellerAccountId?: string | null; scope: { kind: SafetyScopeKind; ref: string; label?: string | null }[] }, actor: StaffActor) {
  return prisma.$transaction(async (tx) => {
    const id = newId();
    await tx.safetyCase.create({ data: { id, reference: reference(), title: input.title, description: input.description, severity: input.severity, sourceType: input.sourceType, sourceId: input.sourceId ?? null, sellerAccountId: input.sellerAccountId ?? null, openedById: actor.userId } });
    if (input.scope.length > 0) await tx.safetyCaseScope.createMany({ data: input.scope.map((s) => ({ id: newId(), safetyCaseId: id, kind: s.kind, ref: s.ref, label: s.label ?? null })), skipDuplicates: true });
    if (input.sourceType === 'DISPUTE' && input.sourceId) await tx.disputeCaseProfile.updateMany({ where: { disputeId: input.sourceId }, data: { safetyCaseId: id } });
    await audit(tx, actor, AuditAction.SAFETY_CASE_CHANGED, 'safety_case', id, null, { action: 'OPENED', ...input });
    return { id };
  });
}

/** Immediate triage: contain the scope. Containment applies to new purchases, dispatch and repeat orders. */
export async function containSafetyCase(id: string, input: { severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'; stopListings: boolean; stopShipments: boolean; stopRecurring: boolean; note: string; addScope?: { kind: SafetyScopeKind; ref: string; label?: string | null }[] }, actor: StaffActor) {
  await prisma.$transaction(async (tx) => {
    const row = await tx.safetyCase.findUnique({ where: { id } });
    if (row === null) throw notFound('Safety case');
    if (!OPEN_STATUSES.includes(row.status)) throw conflict(ErrorCode.CONFLICT, 'This safety case is closed.');
    if (input.addScope && input.addScope.length > 0) await tx.safetyCaseScope.createMany({ data: input.addScope.map((s) => ({ id: newId(), safetyCaseId: id, kind: s.kind, ref: s.ref, label: s.label ?? null })), skipDuplicates: true });
    await tx.safetyCaseScope.updateMany({ where: { safetyCaseId: id }, data: { contained: true } });
    await tx.safetyCase.update({ where: { id }, data: { status: 'CONTAINED', severity: input.severity, triagedById: row.triagedById ?? actor.userId, triagedAt: row.triagedAt ?? new Date(), containmentJson: { stopListings: input.stopListings, stopShipments: input.stopShipments, stopRecurring: input.stopRecurring, note: input.note, by: actor.userId, at: new Date().toISOString() } } });
    await tx.safetyCaseAction.create({ data: { id: newId(), safetyCaseId: id, kind: 'NOTE', detail: `Contained: ${input.note}`, actorUserId: actor.userId } });
    await audit(tx, actor, AuditAction.SAFETY_CASE_CHANGED, 'safety_case', id, { status: row.status }, { status: 'CONTAINED', ...input });
  });
}

interface Containment {
  stopListings?: boolean;
  stopShipments?: boolean;
  stopRecurring?: boolean;
}

async function activeContainments(client: Client) {
  const cases = await client.safetyCase.findMany({ where: { status: { in: OPEN_STATUSES } }, select: { id: true, reference: true, containmentJson: true } });
  if (cases.length === 0) return [];
  const scopes = await client.safetyCaseScope.findMany({ where: { safetyCaseId: { in: cases.map((c) => c.id) }, contained: true }, select: { safetyCaseId: true, kind: true, ref: true } });
  return scopes.map((s) => {
    const c = cases.find((x) => x.id === s.safetyCaseId);
    return { ...s, reference: c?.reference ?? '', containment: (c?.containmentJson ?? {}) as Containment };
  });
}

/** Purchase and repeat-order check: refuse anything inside a contained scope. Always on - only a person's containment triggers it. */
export async function assertNoSafetyHold(client: Client, input: { offerIds: readonly (string | null)[]; productIds: readonly string[]; sellerAccountIds?: readonly string[]; purpose: 'PURCHASE' | 'RECURRING' | 'DISPATCH'; facilityRefs?: readonly (string | null)[]; lots?: readonly string[] }): Promise<void> {
  const holds = await activeContainments(client);
  if (holds.length === 0) return;
  const want = (h: (typeof holds)[number]) => (input.purpose === 'PURCHASE' ? h.containment.stopListings !== false : input.purpose === 'RECURRING' ? h.containment.stopRecurring !== false : h.containment.stopShipments !== false);
  const hits = holds.filter((h) => want(h) && (
    (h.kind === 'OFFER' && input.offerIds.includes(h.ref)) ||
    (h.kind === 'PRODUCT' && input.productIds.includes(h.ref)) ||
    (h.kind === 'SELLER' && (input.sellerAccountIds ?? []).includes(h.ref)) ||
    (h.kind === 'FACILITY' && (input.facilityRefs ?? []).includes(h.ref)) ||
    (h.kind === 'LOT' && (input.lots ?? []).includes(h.ref))
  ));
  if (hits.length === 0) return;
  throw new AppError({
    statusCode: 409,
    code: ErrorCode.PRODUCT_UNDER_SAFETY_HOLD,
    message: input.purpose === 'DISPATCH' ? 'This shipment is held under a product safety case and cannot be dispatched until the case is released.' : 'This product is temporarily unavailable while a safety review is completed. Remove it to continue.',
    details: hits.map((h) => ({ field: h.kind.toLowerCase(), code: 'SAFETY_HOLD', meta: { ref: h.ref, case: h.reference } })),
  });
}

/** Trace what a case reaches: orders, customers, countries, unshipped seller orders, repeat orders and stock. */
export async function traceSafetyCase(id: string) {
  const row = await prisma.safetyCase.findUnique({ where: { id } });
  if (row === null) throw notFound('Safety case');
  const scope = await prisma.safetyCaseScope.findMany({ where: { safetyCaseId: id } });
  const offerIds = scope.filter((s) => s.kind === 'OFFER').map((s) => s.ref);
  const productIds = scope.filter((s) => s.kind === 'PRODUCT').map((s) => s.ref);
  const facilityRefs = scope.filter((s) => s.kind === 'FACILITY').map((s) => s.ref);
  const lots = scope.filter((s) => s.kind === 'LOT').map((s) => s.ref);
  const sellerIds = scope.filter((s) => s.kind === 'SELLER').map((s) => s.ref);

  const facilityItems = facilityRefs.length === 0 ? [] : await prisma.orderLineCommercialSnapshot.findMany({ where: { facilityRef: { in: facilityRefs } }, select: { orderItemId: true } });
  const lotGroups = lots.length === 0 ? [] : (await prisma.dispatchEvidence.findMany({ select: { sellerOrderGroupId: true, lotsJson: true } })).filter((d) => (Array.isArray(d.lotsJson) ? (d.lotsJson as { lot?: string; serial?: string }[]) : []).some((l) => lots.includes(l.lot ?? '') || lots.includes(l.serial ?? ''))).map((d) => d.sellerOrderGroupId);
  const lotItems = lotGroups.length === 0 ? [] : await prisma.sellerOrderLine.findMany({ where: { orderGroupId: { in: lotGroups } }, select: { orderItemId: true } });
  const items = await prisma.orderItem.findMany({
    where: {
      OR: [
        ...(offerIds.length > 0 ? [{ sellerOfferId: { in: offerIds } }] : []),
        ...(productIds.length > 0 ? [{ productId: { in: productIds } }] : []),
        ...(facilityItems.length > 0 ? [{ id: { in: facilityItems.map((f) => f.orderItemId) } }] : []),
        ...(sellerIds.length > 0 ? [{ sellerOffer: { sellerAccountId: { in: sellerIds } } }] : []),
        ...(lotItems.length > 0 ? [{ id: { in: lotItems.map((l) => l.orderItemId) } }] : []),
      ],
    },
    select: { id: true, quantity: true, orderId: true, order: { select: { orderNumber: true, customerProfileId: true, status: true, shippingAddressJson: true } } },
    take: 5000,
  });
  if (items.length === 0 && offerIds.length + productIds.length + facilityRefs.length + lots.length + sellerIds.length === 0) return serialise({ orders: [], customers: 0, countries: [], unshipped: [], recurring: 0, stockUnits: 0 });
  const orders = [...new Map(items.map((i) => [i.orderId, { orderId: i.orderId, orderNumber: i.order.orderNumber, status: i.order.status, country: ((i.order.shippingAddressJson ?? {}) as { country?: string }).country ?? null }])).values()];
  const groups = await prisma.sellerOrderGroup.findMany({ where: { orderId: { in: orders.map((o) => o.orderId) }, status: { in: ['NEW', 'ACCEPTED', 'PROCESSING', 'READY_FOR_DISPATCH'] } }, select: { id: true, sellerOrderNumber: true, status: true } });
  const recurring = offerIds.length + productIds.length === 0 ? 0 : await prisma.recurringScheduleItem.count({ where: { productId: { in: productIds.length > 0 ? productIds : ['-'] } } });
  const stock = offerIds.length === 0 ? [] : await prisma.sellerInventory.findMany({ where: { offerId: { in: offerIds } }, select: { availableQuantity: true, reservedQuantity: true } });
  return serialise({
    orders,
    unitsSold: items.reduce((s, i) => s + i.quantity, 0),
    customers: new Set(items.map((i) => i.order.customerProfileId)).size,
    countries: [...new Set(orders.map((o) => o.country).filter((c): c is string => c !== null))],
    unshipped: groups,
    recurring,
    stockUnits: stock.reduce((s, x) => s + x.availableQuantity + x.reservedQuantity, 0),
  });
}

/** Reporting decisions are a qualified person's, never an AI's. */
export async function recordSafetyAction(id: string, input: { kind: SafetyActionKind; detail: string; authority?: string | null; decision?: 'REPORT' | 'NOT_REQUIRED' | 'PENDING_ADVICE' | null; deadlineAt?: Date | null; qualifiedRole?: string | null; quantity?: number | null; effectivenessPercentBp?: number | null; aiGenerated?: boolean }, actor: StaffActor) {
  if (input.aiGenerated === true) throw new AppError({ statusCode: 422, code: ErrorCode.CASE_DECISION_NOT_REASONED, message: 'A safety decision cannot rest on AI output alone. A qualified person must record it.', details: [{ code: 'AI_ONLY_DECISION' }] });
  if (input.kind === 'REPORTING_DECISION' && (input.decision === null || input.decision === undefined || !input.qualifiedRole || !input.authority)) {
    throw new AppError({ statusCode: 422, code: ErrorCode.VALIDATION_FAILED, message: 'A reporting decision names the authority, the decision and the qualified role of the person deciding.' });
  }
  await prisma.$transaction(async (tx) => {
    const row = await tx.safetyCase.findUnique({ where: { id } });
    if (row === null) throw notFound('Safety case');
    await tx.safetyCaseAction.create({ data: { id: newId(), safetyCaseId: id, kind: input.kind, detail: input.detail, authority: input.authority ?? null, decision: input.decision ?? null, deadlineAt: input.deadlineAt ?? null, qualifiedRole: input.qualifiedRole ?? null, quantity: input.quantity ?? null, effectivenessPercentBp: input.effectivenessPercentBp ?? null, actorUserId: actor.userId } });
    if (row.status === 'CONTAINED' || row.status === 'TRIAGE') await tx.safetyCase.update({ where: { id }, data: { status: input.kind === 'NOTE' ? row.status : 'INVESTIGATING' } });
    await audit(tx, actor, AuditAction.SAFETY_CASE_CHANGED, 'safety_case', id, null, { action: input.kind, ...input });
  });
}

export async function recordCorrection(id: string, input: { rootCause: string; correctionEvidence: string; verificationTests: string; currentCertificates: string }, actor: StaffActor) {
  await prisma.$transaction(async (tx) => {
    const row = await tx.safetyCase.findUnique({ where: { id } });
    if (row === null) throw notFound('Safety case');
    await tx.safetyCase.update({ where: { id }, data: { ...input, status: 'RELEASE_PENDING' } });
    await audit(tx, actor, AuditAction.SAFETY_CASE_CHANGED, 'safety_case', id, null, { action: 'CORRECTION_RECORDED' });
  });
}

/** Human release: everything on file, by someone other than the person who opened the case. */
export async function releaseSafetyCase(id: string, input: { note: string }, actor: StaffActor) {
  await prisma.$transaction(async (tx) => {
    const row = await tx.safetyCase.findUnique({ where: { id } });
    if (row === null) throw notFound('Safety case');
    if (row.openedById === actor.userId) throw separationRefusal('RELEASER_IS_OPENER', 'The person who opened this case cannot release it.');
    const missing = [
      ...(row.containmentJson === null ? ['CONTAINMENT'] : []),
      ...(!row.rootCause ? ['ROOT_CAUSE'] : []),
      ...(!row.correctionEvidence ? ['CORRECTION'] : []),
      ...(!row.verificationTests ? ['TESTS'] : []),
      ...(!row.currentCertificates ? ['CURRENT_CERTIFICATES'] : []),
    ];
    if (missing.length > 0) throw conflict(ErrorCode.SAFETY_RELEASE_NOT_READY, 'This case cannot be released yet.', missing.map((code) => ({ code })));
    await tx.safetyCaseScope.updateMany({ where: { safetyCaseId: id }, data: { contained: false } });
    await tx.safetyCase.update({ where: { id }, data: { status: 'RELEASED', releaseApprovedById: actor.userId, releasedAt: new Date() } });
    await tx.safetyCaseAction.create({ data: { id: newId(), safetyCaseId: id, kind: 'NOTE', detail: `Released: ${input.note}`, actorUserId: actor.userId } });
    await audit(tx, actor, AuditAction.SAFETY_CASE_CHANGED, 'safety_case', id, { status: row.status }, { status: 'RELEASED', note: input.note });
  });
}

export async function listSafetyCases(status?: string) {
  return serialise(await prisma.safetyCase.findMany({ where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: 200 }));
}

export async function readSafetyCase(id: string) {
  const row = await prisma.safetyCase.findUnique({ where: { id } });
  if (row === null) throw notFound('Safety case');
  const [scope, actions] = await Promise.all([prisma.safetyCaseScope.findMany({ where: { safetyCaseId: id } }), prisma.safetyCaseAction.findMany({ where: { safetyCaseId: id }, orderBy: { createdAt: 'asc' } })]);
  return serialise({ ...row, scope, actions });
}

export async function recordRehearsal(input: { scenario: string; scopeTraced: string; minutesToTrace?: number | null; findings?: string | null; outcome: 'PASSED' | 'GAPS_FOUND' | 'FAILED'; performedAt: Date }, actor: StaffActor) {
  const id = newId();
  await prisma.recallRehearsal.create({ data: { id, year: input.performedAt.getUTCFullYear(), scenario: input.scenario, scopeTraced: input.scopeTraced, minutesToTrace: input.minutesToTrace ?? null, findings: input.findings ?? null, outcome: input.outcome, performedAt: input.performedAt, recordedById: actor.userId } });
  await audit(prisma, actor, AuditAction.SAFETY_CASE_CHANGED, 'recall_rehearsal', id, null, input);
  return { id };
}

/** The annual rehearsal (Doc 07 s11): due when none was recorded in the last 12 months. */
export async function rehearsalStatus(now = new Date()) {
  const last = await prisma.recallRehearsal.findFirst({ orderBy: { performedAt: 'desc' } });
  const due = last === null || now.getTime() - last.performedAt.getTime() > 365 * 24 * 3_600_000;
  return serialise({ last, due });
}
