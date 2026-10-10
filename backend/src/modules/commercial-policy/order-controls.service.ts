/**
 * Order controls (Doc 07 s1-s2, s4; Doc 08 s1, s5).
 *
 * At confirmation every order line gets a commercial snapshot: the actual
 * seller and manufacturer, the approved SKU version, site and scope, the
 * country and B2B/B2C context, the importer and local actors, the money
 * (goods, tax, charges, commission with its rate, base, source and rounding),
 * the delivery term and named place, and the policy versions in force. It is
 * written once. While the seller order is still NEW, the controls still
 * missing (return route, insurance decision, packaging, transport review, an
 * elected FCA / DDP term) are recorded by the seller or staff; after
 * acceptance the snapshot is never rewritten, so a later rule change leaves a
 * confirmed order exactly as agreed.
 *
 * Payment success does not accept a seller order: acceptance stays a separate
 * step, and under `DELIVERY_POLICY_GATES=enforce` it is refused while any
 * acceptance control is missing.
 */
import { env } from '../../config/env.js';
import {
  acceptanceControlGaps,
  applyBps,
  importerOfRecord,
  proposedInsuredValue,
  resolveDeliveryTerm,
  type DeliveryTerm,
  type SalesChannel,
} from '../../domain/commercial-policy.js';
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction } from '../audit/audit.service.js';
import { departmentSlugOf, scheduledCommissionBps } from './schedules.service.js';
import { audit, serialise, type Client, type StaffActor } from './shared.js';

export function deliveryGateMode(): 'off' | 'report' | 'enforce' {
  return env.DELIVERY_POLICY_GATES;
}

interface AddressShape {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  countryCode?: string;
  company?: string;
}

/** The precise named place: building or terminal address, never just a country. */
export function namedPlaceOf(address: AddressShape | null): string | null {
  if (address === null) return null;
  const parts = [address.company, address.line1, address.line2, address.city, address.region, address.postalCode, address.country ?? address.countryCode].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  return parts.length === 0 ? null : parts.join(', ').slice(0, 400);
}

/** The approved import route for a destination, channel and category (category route first, then country-wide). */
export async function approvedImportRoute(client: Client, countryCode: string, channel: SalesChannel, categoryIds: readonly (string | null)[], now = new Date()) {
  const keys = [...new Set(categoryIds.filter((c): c is string => c !== null)), ''];
  const routes = await client.importRoute.findMany({ where: { countryCode: countryCode.toUpperCase(), channel, categoryKey: { in: keys }, status: 'APPROVED' } });
  const live = routes.filter((r) => r.validUntil === null || r.validUntil.getTime() > now.getTime());
  return (catKey: string | null) => live.find((r) => r.categoryKey === (catKey ?? '')) ?? live.find((r) => r.categoryKey === '') ?? null;
}

async function policyVersionsInForce(client: Client, termsDocumentId: string | null): Promise<Record<string, unknown>> {
  const now = new Date();
  const docs = await client.legalDocument.findMany({
    where: { kind: { in: ['RETURNS_POLICY', 'BUYER_PROTECTION_POLICY'] }, status: 'PUBLISHED', effectiveAt: { lte: now }, locale: 'en' },
    orderBy: { effectiveAt: 'desc' },
    select: { id: true, kind: true, version: true },
  });
  const pick = (kind: string) => docs.find((d) => d.kind === kind) ?? null;
  const schedules = await client.commercialSchedule.findMany({ where: { status: 'ACTIVE' }, select: { id: true, kind: true, version: true } });
  return {
    termsDocumentId,
    returnsPolicy: pick('RETURNS_POLICY'),
    buyerProtectionPolicy: pick('BUYER_PROTECTION_POLICY'),
    activeCommercialSchedules: schedules,
    capturedAt: now.toISOString(),
  };
}

/**
 * Write the snapshot for every line of a confirmed order. Called inside the
 * confirmation transaction after the seller split. Idempotent: a line that
 * already has one is left alone.
 */
export async function snapshotOrderLines(tx: Client, orderId: string): Promise<number> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { currency: true, shippingAddressJson: true, buyerContextKind: true, termsDocumentId: true, fulfilmentDeliveryFrom: true, fulfilmentDeliveryTo: true },
  });
  if (order === null) return 0;
  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: {
      id: true,
      sellerOfferId: true,
      lineSubtotalMinor: true,
      taxAmountMinor: true,
      product: { select: { categoryId: true, manufacturer: { select: { legalName: true } } } },
      sellerOffer: { select: { sellerAccountId: true, capacityLeadTimeDays: true, countryOfOrigin: true, version: true, sellerAccount: { select: { registrationCountry: true } } } },
      packaging: { select: { packageType: true, packageQuantity: true } },
    },
  });
  const done = new Set((await tx.orderLineCommercialSnapshot.findMany({ where: { orderId }, select: { orderItemId: true } })).map((r) => r.orderItemId));
  const pending = items.filter((i) => !done.has(i.id));
  if (pending.length === 0) return 0;

  const address = (order.shippingAddressJson ?? null) as AddressShape | null;
  const destination = (address?.country ?? address?.countryCode ?? '').toUpperCase();
  const channel: SalesChannel = order.buyerContextKind === 'COMPANY' ? 'B2B' : 'B2C';
  const sellerLines = await tx.sellerOrderLine.findMany({ where: { orderItemId: { in: pending.map((p) => p.id) } }, select: { orderItemId: true, commissionMinor: true, orderGroupId: true, orderGroup: { select: { commissionBasisPointsApplied: true, settlement: { select: { platformFeePolicyVersion: true, breakdownJson: true } } } } } });
  const allocations = await tx.certificationRecoveryAllocation.findMany({ where: { orderId, status: { in: ['RESERVED', 'CONFIRMED'] } }, select: { id: true, orderItemId: true, amountMinor: true } });
  const operatorCountry = (await tx.businessProfile.findFirst({ select: { vatCountry: true } }))?.vatCountry ?? null;
  const policies = await policyVersionsInForce(tx, order.termsDocumentId);
  const routeFor = await approvedImportRoute(tx, destination, channel, pending.map((p) => p.product.categoryId));
  const handling = destination === '' ? [] : await tx.handlingRequirement.findMany({ where: { isActive: true, OR: [{ destinationCountry: null }, { destinationCountry: destination }] }, select: { kind: true, categoryId: true, requiredEvidence: true } });

  const rows = [];
  for (const item of pending) {
    const sellerAccountId = item.sellerOffer?.sellerAccountId ?? null;
    const sellerCountry = item.sellerOffer?.sellerAccount.registrationCountry ?? operatorCountry;
    const term: DeliveryTerm = resolveDeliveryTerm({ channel, sellerCountry: sellerCountry ?? destination, destinationCountry: destination, election: null, fcaApproved: false, ddpArrangementApproved: false }).term;
    const importer = importerOfRecord(term, channel);
    const route = importer === 'APPROVED_ARRANGEMENT' ? routeFor(item.product.categoryId) : null;
    const scope =
      item.sellerOfferId === null
        ? null
        : await tx.sellerTradingApprovalScope.findFirst({ where: { offerId: item.sellerOfferId, countryCode: destination, channel, status: 'ACTIVE' }, orderBy: { validUntil: 'desc' }, select: { id: true, productVersion: true, facilityRef: true } });
    const sl = sellerLines.find((l) => l.orderItemId === item.id);
    const commissionMinor = sl?.commissionMinor ?? 0n;
    // The rate actually applied to THIS line: an adopted schedule rate where it produced the fee, else the group rate.
    const scheduled = sellerAccountId === null ? null : await scheduledCommissionBps(tx, { categoryId: item.product.categoryId, country: destination, channel, sellerAccountId });
    const fromSchedule = scheduled !== null && commissionMinor === applyBps(item.lineSubtotalMinor, scheduled.bps);
    const bps = fromSchedule ? scheduled.bps : (sl?.orderGroup.commissionBasisPointsApplied ?? 0);
    const breakdown = (sl?.orderGroup.settlement?.breakdownJson ?? []) as { source?: string }[];
    const source = sellerAccountId === null ? 'OPERATOR_SALE' : fromSchedule ? 'COMMERCIAL_SCHEDULE' : (breakdown.find((b) => b.source !== 'COMMERCIAL_SCHEDULE')?.source ?? 'LEGACY_PLATFORM_RATE');
    const alloc = allocations.find((a) => a.orderItemId === item.id) ?? null;
    const dept = await departmentSlugOf(tx, item.product.categoryId);
    const requirements = handling.filter((h) => h.categoryId === null || h.categoryId === item.product.categoryId).map((h) => ({ kind: h.kind, requiredEvidence: h.requiredEvidence }));
    const localActors = route === null ? null : (route.localActorsJson as unknown);
    const snapshot = {
      id: newId(),
      orderId,
      orderItemId: item.id,
      sellerOrderGroupId: sl?.orderGroupId ?? null,
      sellerAccountId,
      offerId: item.sellerOfferId,
      manufacturerName: item.product.manufacturer?.legalName ?? null,
      productVersion: scope?.productVersion ?? null,
      facilityRef: scope?.facilityRef ?? null,
      approvalScopeId: scope?.id ?? null,
      sellerCountry: sellerCountry ?? null,
      destinationCountry: destination === '' ? 'ZZ' : destination,
      channel,
      departmentSlug: dept,
      deliveryTerm: term,
      namedPlace: namedPlaceOf(address),
      importerOfRecord: route?.importerParty ?? importer,
      importRouteId: route?.id ?? null,
      localActorsJson: localActors as never,
      promisedDeliveryFrom: order.fulfilmentDeliveryFrom ?? null,
      promisedDeliveryTo: order.fulfilmentDeliveryTo ?? null,
      leadTimeDays: item.sellerOffer?.capacityLeadTimeDays ?? null,
      packagingNote: item.packaging === null ? null : `${String(item.packaging.packageQuantity)} x ${item.packaging.packageType}`,
      transportRestrictionsJson: { requirements, reviewed: false } as never,
      insuranceJson: { decided: false, proposedInsuredValueMinor: proposedInsuredValue(item.lineSubtotalMinor, null).toString(), proposal: true } as never,
      goodsMinor: item.lineSubtotalMinor,
      taxMinor: item.taxAmountMinor,
      currency: order.currency,
      commissionBaseMinor: item.lineSubtotalMinor,
      commissionBps: bps,
      commissionMinor,
      commissionSource: source,
      commissionRuleVersion: fromSchedule ? `COMMISSION v${String(scheduled.version)}` : (sl?.orderGroup.settlement?.platformFeePolicyVersion !== null && sl?.orderGroup.settlement?.platformFeePolicyVersion !== undefined ? `fee-policy v${String(sl.orderGroup.settlement.platformFeePolicyVersion)}` : null),
      certificationAllocationId: alloc?.id ?? null,
      certificationChargeMinor: alloc?.amountMinor ?? 0n,
      policyVersionsJson: policies as never,
      controlGapsJson: [] as never,
    };
    snapshot.controlGapsJson = gapsOf(snapshot) as never;
    rows.push(snapshot);
  }
  await tx.orderLineCommercialSnapshot.createMany({ data: rows, skipDuplicates: true });
  return rows.length;
}

type SnapshotLike = {
  sellerAccountId: string | null;
  manufacturerName: string | null;
  productVersion: string | null;
  facilityRef: string | null;
  destinationCountry: string;
  channel: string;
  importerOfRecord: string;
  importRouteId: string | null;
  localActorsJson: unknown;
  goodsMinor: bigint;
  deliveryTerm: string;
  namedPlace: string | null;
  leadTimeDays: number | null;
  returnRoute?: string | null;
  packagingNote: string | null;
  transportRestrictionsJson: unknown;
  insuranceJson: unknown;
  policyVersionsJson: unknown;
};

function gapsOf(s: SnapshotLike): string[] {
  const actors = Array.isArray(s.localActorsJson) ? (s.localActorsJson as { verified?: boolean }[]) : [];
  const needsRoute = s.importerOfRecord === 'APPROVED_ARRANGEMENT' && s.importRouteId === null;
  const operatorLine = s.sellerAccountId === null;
  return acceptanceControlGaps({
    sellerAccountId: operatorLine ? 'OPERATOR' : s.sellerAccountId,
    manufacturer: s.manufacturerName,
    approvedProductVersion: operatorLine ? 'OPERATOR' : s.productVersion,
    facilityRef: operatorLine ? 'OPERATOR' : s.facilityRef,
    destinationCountry: s.destinationCountry === 'ZZ' ? null : s.destinationCountry,
    channel: s.channel as SalesChannel,
    importer: needsRoute ? null : s.importerOfRecord,
    localActorsSatisfied: !needsRoute && actors.every((a) => a.verified === true),
    goodsPriceMinor: s.goodsMinor,
    taxesKnown: true,
    deliveryTerm: s.deliveryTerm as DeliveryTerm,
    namedPlace: s.namedPlace,
    leadTimeDays: s.leadTimeDays,
    returnRoute: s.returnRoute ?? null,
    packagingRecorded: s.packagingNote !== null && s.packagingNote.trim() !== '',
    transportRestrictionsReviewed: (s.transportRestrictionsJson as { reviewed?: boolean } | null)?.reviewed === true,
    insuranceDecided: (s.insuranceJson as { decided?: boolean } | null)?.decided === true,
    policyVersionsRecorded: s.policyVersionsJson !== null,
  });
}

export async function readOrderControls(orderId: string, scope: { sellerAccountId?: string } = {}) {
  const rows = await prisma.orderLineCommercialSnapshot.findMany({ where: { orderId, ...(scope.sellerAccountId ? { sellerAccountId: scope.sellerAccountId } : {}) }, orderBy: { createdAt: 'asc' } });
  return serialise(rows);
}

export async function readGroupControls(sellerOrderGroupId: string, scope: { sellerAccountId?: string } = {}) {
  const group = await prisma.sellerOrderGroup.findUnique({ where: { id: sellerOrderGroupId }, select: { id: true, sellerAccountId: true, status: true } });
  if (group === null || (scope.sellerAccountId !== undefined && group.sellerAccountId !== scope.sellerAccountId)) throw notFound('Seller order');
  const lines = await prisma.orderLineCommercialSnapshot.findMany({ where: { sellerOrderGroupId }, orderBy: { createdAt: 'asc' } });
  return serialise({ status: group.status, editable: group.status === 'NEW', gateMode: deliveryGateMode(), lines });
}

export interface ControlsInput {
  returnRoute?: string;
  packagingNote?: string;
  transportRestrictionsReviewed?: boolean;
  insurance?: { decided: true; arrangement: string; insuredValueMinor?: string | null };
  namedPlace?: string;
  leadTimeDays?: number;
  technicalAcceptanceDays?: number | null;
  titleTransferPoint?: string;
  riskTransferPoint?: string;
  /** A business buyer's express election, with the approval reference. */
  election?: { term: 'FCA' | 'DDP'; approvalReference: string; importRouteId?: string | null } | null;
}

/** Record the controls still missing. Only while the seller order is NEW: after acceptance the snapshot is frozen. */
export async function recordAcceptanceControls(sellerOrderGroupId: string, input: ControlsInput, actor: StaffActor & { sellerAccountId?: string }) {
  return prisma.$transaction(async (tx) => {
    const group = await tx.sellerOrderGroup.findUnique({ where: { id: sellerOrderGroupId }, select: { sellerAccountId: true, status: true } });
    if (group === null || (actor.sellerAccountId !== undefined && group.sellerAccountId !== actor.sellerAccountId)) throw notFound('Seller order');
    if (group.status !== 'NEW') throw conflict(ErrorCode.CONFLICT, 'The order has been accepted; its agreed terms can no longer be changed here.');
    const lines = await tx.orderLineCommercialSnapshot.findMany({ where: { sellerOrderGroupId } });
    for (const line of lines) {
      let deliveryTerm = line.deliveryTerm;
      let importer = line.importerOfRecord;
      let importRouteId = line.importRouteId;
      if (input.election) {
        const route = input.election.importRouteId ? await tx.importRoute.findFirst({ where: { id: input.election.importRouteId, status: 'APPROVED' } }) : null;
        const resolved = resolveDeliveryTerm({
          channel: line.channel as SalesChannel,
          sellerCountry: line.sellerCountry ?? line.destinationCountry,
          destinationCountry: line.destinationCountry,
          election: input.election.term,
          fcaApproved: input.election.term === 'FCA' && input.election.approvalReference.trim() !== '',
          ddpArrangementApproved: input.election.term === 'DDP' && route !== null,
        });
        if (resolved.problems.length > 0) throw conflict(ErrorCode.ORDER_ACCEPTANCE_CONTROLS_MISSING, 'That delivery term cannot be used for this order.', resolved.problems.map((code) => ({ code })));
        deliveryTerm = resolved.term;
        importer = route?.importerParty ?? importerOfRecord(resolved.term, line.channel as SalesChannel);
        importRouteId = route?.id ?? importRouteId;
      }
      const restrictions = { ...((line.transportRestrictionsJson ?? {}) as object), ...(input.transportRestrictionsReviewed !== undefined ? { reviewed: input.transportRestrictionsReviewed, reviewedBy: actor.userId } : {}) };
      const insurance = input.insurance ? { ...((line.insuranceJson ?? {}) as object), decided: true, arrangement: input.insurance.arrangement, insuredValueMinor: input.insurance.insuredValueMinor ?? null, decidedBy: actor.userId } : line.insuranceJson;
      const next = {
        returnRoute: input.returnRoute ?? line.returnRoute,
        packagingNote: input.packagingNote ?? line.packagingNote,
        namedPlace: input.namedPlace ?? line.namedPlace,
        leadTimeDays: input.leadTimeDays ?? line.leadTimeDays,
        technicalAcceptanceDays: input.technicalAcceptanceDays !== undefined ? input.technicalAcceptanceDays : line.technicalAcceptanceDays,
        titleTransferPoint: input.titleTransferPoint ?? line.titleTransferPoint,
        riskTransferPoint: input.riskTransferPoint ?? line.riskTransferPoint,
        deliveryTerm,
        importerOfRecord: importer,
        importRouteId,
        transportRestrictionsJson: restrictions as never,
        insuranceJson: insurance as never,
      };
      const gaps = gapsOf({ ...line, ...next });
      await tx.orderLineCommercialSnapshot.update({ where: { id: line.id }, data: { ...next, controlGapsJson: gaps as never } });
    }
    await audit(tx, actor, AuditAction.LOGISTICS_CONTROL_RECORDED, 'seller_order_group', sellerOrderGroupId, null, { controls: input });
  });
}

/** The acceptance gate: called when a seller order moves to ACCEPTED. */
export async function assertAcceptanceControls(client: Client, sellerOrderGroupId: string): Promise<void> {
  const mode = deliveryGateMode();
  if (mode === 'off') return;
  const lines = await client.orderLineCommercialSnapshot.findMany({ where: { sellerOrderGroupId }, select: { controlGapsJson: true } });
  const gaps = [...new Set(lines.flatMap((l) => (l.controlGapsJson ?? []) as string[]))];
  if (lines.length === 0) gaps.push('SNAPSHOT_MISSING');
  if (gaps.length === 0) return;
  if (mode === 'report') {
    logger.warn({ sellerOrderGroupId, gaps }, 'delivery controls would refuse acceptance (report mode)');
    return;
  }
  throw conflict(ErrorCode.ORDER_ACCEPTANCE_CONTROLS_MISSING, 'This order cannot be accepted until its delivery and commercial terms are recorded.', gaps.map((code) => ({ code })));
}

/**
 * Checkout: a consumer order crossing a border needs an approved import route
 * for its destination (category route or country-wide). A consumer is never
 * assumed to be a qualified importer.
 */
export async function assertImportRoutes(client: Client, input: { countryCode: string; channel: SalesChannel; lines: readonly { categoryId: string | null; sellerCountry: string | null }[] }): Promise<void> {
  const mode = deliveryGateMode();
  if (mode === 'off' || input.channel !== 'B2C') return;
  const crossBorder = input.lines.filter((l) => l.sellerCountry !== null && l.sellerCountry.toUpperCase() !== input.countryCode.toUpperCase());
  if (crossBorder.length === 0) return;
  const routeFor = await approvedImportRoute(client, input.countryCode, 'B2C', crossBorder.map((l) => l.categoryId));
  const missing = crossBorder.filter((l) => routeFor(l.categoryId) === null);
  if (missing.length === 0) return;
  if (mode === 'report') {
    logger.warn({ countryCode: input.countryCode, missing: missing.length }, 'import route gate would block (report mode)');
    return;
  }
  throw conflict(ErrorCode.IMPORT_ROUTE_NOT_APPROVED, `Some items cannot be delivered to consumers in ${input.countryCode} yet: no approved import arrangement covers them. Remove them to continue.`, missing.map((l) => ({ field: 'categoryId', code: 'NO_ROUTE', meta: { categoryId: l.categoryId } })));
}

/** Checkout: only to a country enabled on approved launch evidence (when the gate is on). */
export async function assertCountryLaunched(client: Client, countryCode: string): Promise<void> {
  if (env.COUNTRY_LAUNCH_GATE !== 'enforce') return;
  const launch = await client.countryLaunch.findUnique({ where: { countryCode: countryCode.toUpperCase() }, select: { status: true } });
  if (launch?.status === 'ENABLED') return;
  throw conflict(ErrorCode.COUNTRY_NOT_LAUNCHED, `We do not deliver to ${countryCode.toUpperCase()} yet.`);
}

// --- Import routes (admin) -----------------------------------------------------

export async function listImportRoutes(countryCode?: string) {
  return serialise(await prisma.importRoute.findMany({ where: countryCode ? { countryCode: countryCode.toUpperCase() } : {}, orderBy: [{ countryCode: 'asc' }, { channel: 'asc' }] }));
}

export async function upsertImportRoute(input: { countryCode: string; categoryId: string | null; channel: SalesChannel; importerParty: string; importerName?: string | null; localActors: { role: string; name: string; evidence: string; verified: boolean }[]; regulatedCategory: boolean; evidence?: string | null; validUntil?: Date | null; note?: string | null }, actor: StaffActor) {
  return prisma.$transaction(async (tx) => {
    const key = { countryCode: input.countryCode.toUpperCase(), categoryKey: input.categoryId ?? '', channel: input.channel };
    const existing = await tx.importRoute.findUnique({ where: { countryCode_categoryKey_channel: key } });
    const data = { importerParty: input.importerParty, importerName: input.importerName ?? null, localActorsJson: input.localActors as never, regulatedCategory: input.regulatedCategory, evidence: input.evidence ?? null, validUntil: input.validUntil ?? null, note: input.note ?? null, status: 'DRAFT', reviewerUserId: null, reviewedAt: null, preparedById: actor.userId };
    const row = existing === null ? await tx.importRoute.create({ data: { id: newId(), ...key, categoryId: input.categoryId, ...data } }) : await tx.importRoute.update({ where: { id: existing.id }, data });
    await audit(tx, actor, AuditAction.IMPORT_ROUTE_DECIDED, 'import_route', row.id, existing, { ...data, action: 'DRAFTED' });
    return serialise(row);
  });
}

/** Approve or reject a route. The reviewer is not the preparer; every local actor must be verified. */
export async function decideImportRoute(id: string, input: { approve: boolean; note: string }, actor: StaffActor) {
  const { separationRefusal } = await import('./shared.js');
  return prisma.$transaction(async (tx) => {
    const row = await tx.importRoute.findUnique({ where: { id } });
    if (row === null) throw notFound('Import route');
    if (row.preparedById === actor.userId) throw separationRefusal('REVIEWER_IS_PREPARER', 'The person who prepared this route cannot approve it.');
    if (input.approve) {
      const actors = (row.localActorsJson ?? []) as { verified?: boolean }[];
      const problems = [...(actors.some((a) => a.verified !== true) ? ['LOCAL_ACTOR_UNVERIFIED'] : []), ...(row.evidence === null || row.evidence.trim() === '' ? ['EVIDENCE_MISSING'] : [])];
      if (problems.length > 0) throw conflict(ErrorCode.IMPORT_ROUTE_NOT_APPROVED, 'This route cannot be approved yet.', problems.map((code) => ({ code })));
    }
    const status = input.approve ? 'APPROVED' : 'REJECTED';
    await tx.importRoute.update({ where: { id }, data: { status, reviewerUserId: actor.userId, reviewedAt: new Date(), note: input.note } });
    await audit(tx, actor, AuditAction.IMPORT_ROUTE_DECIDED, 'import_route', id, { status: row.status }, { status, note: input.note });
  });
}

/**
 * Every Doc 07 / Doc 08 rule that decides whether a basket may be bought for
 * this destination: country launched, nothing under a safety hold, a lawful
 * import route for consumer orders. One call so checkout, payment start and
 * repeat orders ask the same question.
 */
export async function assertCheckoutDeliveryRules(client: Client, input: { countryCode: string; channel: SalesChannel; items: readonly { productId: string; sellerOfferId: string | null }[]; purpose?: 'PURCHASE' | 'RECURRING' }): Promise<void> {
  if (input.countryCode.trim() === '') return;
  await assertCountryLaunched(client, input.countryCode);
  const offerIds = [...new Set(input.items.map((i) => i.sellerOfferId).filter((v): v is string => v !== null))];
  const productIds = [...new Set(input.items.map((i) => i.productId))];
  const offers = offerIds.length === 0 ? [] : await client.sellerOffer.findMany({ where: { id: { in: offerIds } }, select: { id: true, sellerAccountId: true, productId: true, sellerAccount: { select: { registrationCountry: true } } } });
  const { assertNoSafetyHold } = await import('./safety.service.js');
  await assertNoSafetyHold(client, { offerIds, productIds, sellerAccountIds: offers.map((o) => o.sellerAccountId), purpose: input.purpose ?? 'PURCHASE' });
  if (deliveryGateMode() === 'off' || input.channel !== 'B2C') return;
  const products = await client.product.findMany({ where: { id: { in: productIds } }, select: { id: true, categoryId: true } });
  const operatorCountry = (await client.businessProfile.findFirst({ select: { vatCountry: true } }))?.vatCountry ?? null;
  await assertImportRoutes(client, {
    countryCode: input.countryCode,
    channel: input.channel,
    lines: input.items.map((i) => ({
      categoryId: products.find((p) => p.id === i.productId)?.categoryId ?? null,
      sellerCountry: i.sellerOfferId === null ? operatorCountry : (offers.find((o) => o.id === i.sellerOfferId)?.sellerAccount.registrationCountry ?? null),
    })),
  });
}
