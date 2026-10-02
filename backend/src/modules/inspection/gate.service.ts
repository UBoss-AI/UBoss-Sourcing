/**
 * The dispatch gate, as the services see it.
 *
 * `domain/inspection-gate.ts` decides open or shut from facts; this file
 * gathers the facts, inside the caller's transaction, and is the only thing
 * the seller-order and consignment services call before a guarded move. It
 * also decides whether an order needs inspecting at all, the first time
 * anybody asks, and records the answer with the rule that fired (FLOW-001).
 *
 * Nothing here trusts a status column to say whether goods may leave. The
 * requirement's `status` is a summary for screens, rewritten from the same
 * facts by `refreshRequirementStatus`; the verdict is always recomputed.
 */
import type { PrismaTransaction } from '../../infra/prisma.js';
import { prisma } from '../../infra/prisma.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import {
  GATE_NOT_APPLICABLE,
  evaluateInspectionGate,
  scopeFingerprint,
  type InspectionGateVerdict,
  type ScopeFingerprint,
} from '../../domain/inspection-gate.js';
import { INSPECTION_GATED_SHIPMENT_STATUSES, type ShipmentStatusName } from '../../domain/logistics-shipment-state.js';
import { decideRequirement, supplierRiskFrom, type RuleCandidate, type SupplierRiskTier } from '../../domain/inspection-rules.js';
import { OPEN_JOB_STATUSES } from '../../domain/inspection-state.js';
import { purchaseOrderInspectionReason } from '../../domain/rfq-po-order.js';
import { createLogisticsNotification } from '../logistics/notification.service.js';
import { notifySeller } from '../seller/notification.service.js';
import {
  AuditAction,
  SYSTEM_ACTOR,
  readPolicy,
  recordInspectionEvent,
  type InspectionActor,
  type InspectionPolicyRow,
} from './context.js';

type Client = PrismaTransaction;

/** Seller order statuses from which the goods have not yet left. */
const PRE_DISPATCH_GROUP_STATUSES = ['NEW', 'ACCEPTED', 'PROCESSING', 'READY_FOR_DISPATCH'] as const;

// ---------------------------------------------------------------------------
// What is being sent
// ---------------------------------------------------------------------------

/** The fingerprint of a seller order's goods, packages, containers and seals. */
export async function currentScope(client: Client | typeof prisma, sellerOrderGroupId: string): Promise<ScopeFingerprint> {
  const [lines, consignments] = await Promise.all([
    client.sellerOrderLine.findMany({
      where: { orderGroupId: sellerOrderGroupId },
      select: { orderItemId: true, quantity: true },
    }),
    client.logisticsShipment.findMany({
      where: { sellerOrderGroupId, status: { not: 'CANCELLED' } },
      select: {
        id: true,
        packages: {
          select: {
            sequence: true,
            packagingType: true,
            containerNumber: true,
            sealNumber: true,
            weightGrams: true,
            lengthMm: true,
            widthMm: true,
            heightMm: true,
            contents: { select: { orderItemId: true, quantity: true, batchNumber: true } },
          },
        },
      },
    }),
  ]);

  return scopeFingerprint({
    lines,
    consignments: consignments.map((consignment) => ({
      shipmentId: consignment.id,
      packages: consignment.packages.map((pack) => ({
        ...pack,
        contents: pack.contents.map((content) => ({
          orderItemId: content.orderItemId,
          quantity: content.quantity,
          batchNumber: content.batchNumber ?? null,
        })),
      })),
    })),
  });
}

// ---------------------------------------------------------------------------
// Does this order need inspecting?
// ---------------------------------------------------------------------------

function destinationCountryOf(address: unknown): string | null {
  if (typeof address !== 'object' || address === null) return null;
  const record = address as Record<string, unknown>;
  const value = record['country'] ?? record['countryCode'];
  return typeof value === 'string' && value.trim().length === 2 ? value.trim().toUpperCase() : null;
}

/** Operator rating, raised by recent failures (domain/inspection-rules.ts). */
export async function supplierRiskOf(
  client: Client | typeof prisma,
  sellerAccountId: string,
  policy: InspectionPolicyRow,
): Promise<{ tier: SupplierRiskTier; rated: SupplierRiskTier | null; recentFailures: number }> {
  const since = new Date(Date.now() - policy.supplierRiskLookbackDays * 24 * 60 * 60 * 1000);

  const [rating, recentFailures] = await Promise.all([
    client.inspectionSupplierRisk.findUnique({ where: { sellerAccountId }, select: { tier: true } }),
    client.inspectionReport.count({
      where: {
        status: 'SIGNED',
        result: 'FAIL',
        signedAt: { gte: since },
        job: { requirement: { sellerAccountId } },
      },
    }),
  ]);

  const rated = rating?.tier ?? null;
  return {
    tier: supplierRiskFrom({ rated, recentFailures, failThreshold: policy.supplierRiskFailThreshold }),
    rated,
    recentFailures,
  };
}

export async function activeRules(client: Client | typeof prisma): Promise<RuleCandidate[]> {
  const rows = await client.inspectionRule.findMany({ where: { isActive: true } });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    level: row.level === 'MANDATORY' ? 'MANDATORY' : 'RISK_TRIGGERED',
    priority: row.priority,
    createdAt: row.createdAt,
    isActive: row.isActive,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    categoryId: row.categoryId,
    minOrderValueMinor: row.minOrderValueMinor,
    currency: row.currency,
    destinationCountries: Array.isArray(row.destinationCountriesJson)
      ? (row.destinationCountriesJson as unknown[]).filter((code): code is string => typeof code === 'string')
      : null,
    supplierRiskAtLeast: row.supplierRiskAtLeast,
    planId: row.planId,
    preferredAgencyId: row.preferredAgencyId,
    allowConditionalRelease: row.allowConditionalRelease,
  }));
}

/** The facts the engine reads, for one seller order. */
export async function orderFactsFor(client: Client | typeof prisma, sellerOrderGroupId: string) {
  const group = await client.sellerOrderGroup.findUniqueOrThrow({
    where: { id: sellerOrderGroupId },
    select: {
      id: true,
      orderId: true,
      sellerAccountId: true,
      status: true,
      goodsTotalMinor: true,
      currency: true,
      lines: { select: { orderItemId: true } },
      order: { select: { shippingAddressJson: true } },
    },
  });

  const items = await client.orderItem.findMany({
    where: { id: { in: group.lines.map((line) => line.orderItemId) } },
    select: { product: { select: { categoryId: true, category: { select: { path: true } } } } },
  });

  const categoryIds = new Set<string>();
  for (const item of items) {
    categoryIds.add(item.product.categoryId);
    for (const id of item.product.category.path.split('/')) if (id !== '') categoryIds.add(id);
  }

  return {
    group,
    categoryIds: [...categoryIds],
    destinationCountry: destinationCountryOf(group.order.shippingAddressJson),
  };
}

/**
 * What an RFQ purchase order behind this order says about inspection: its
 * reference, the reason it demands one (null when it asks for none), and the
 * buyer's approved reference sample from that supplier - the latest one the
 * buyer approved on the request. Null for an order not made from one.
 */
export async function purchaseOrderInspectionFor(
  client: Client | typeof prisma,
  orderId: string,
  sellerAccountId: string,
): Promise<{ reference: string; reason: string | null; referenceSampleId: string | null } | null> {
  const po = await client.rfqPurchaseOrder.findUnique({
    where: { orderId },
    select: { reference: true, rfqId: true, sellerAccountId: true, contractJson: true },
  });
  if (po?.sellerAccountId !== sellerAccountId) return null;
  const quality = (po.contractJson as { quality?: { inspectionRequirement?: string; inspectionTerms?: string | null } }).quality;
  const sample = await client.rfqSample.findFirst({
    where: { rfqId: po.rfqId, sellerAccountId, status: 'APPROVED', referenceCode: { not: null } },
    orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  return {
    reference: po.reference,
    reason: purchaseOrderInspectionReason(po.reference, {
      inspectionRequirement: quality?.inspectionRequirement ?? 'NONE',
      inspectionTerms: quality?.inspectionTerms ?? null,
    }),
    referenceSampleId: sample?.id ?? null,
  };
}

/**
 * The requirement for a seller order, deciding it if nobody has yet.
 *
 * Returns null for a seller order whose goods had already left before this
 * feature existed - there is nothing left to inspect, and inventing an
 * "awaiting booking" for a delivered order would be a lie on the screen.
 */
export async function ensureRequirement(
  client: Client,
  sellerOrderGroupId: string,
  actor: InspectionActor = SYSTEM_ACTOR,
): Promise<{ id: string; level: string } | null> {
  const existing = await client.inspectionRequirement.findUnique({
    where: { sellerOrderGroupId },
    select: { id: true, level: true },
  });
  if (existing !== null) return existing;

  const facts = await orderFactsFor(client, sellerOrderGroupId);
  if (!(PRE_DISPATCH_GROUP_STATUSES as readonly string[]).includes(facts.group.status)) return null;

  const policy = await readPolicy(client);
  const risk = await supplierRiskOf(client, facts.group.sellerAccountId, policy);
  const now = new Date();

  const ruled = decideRequirement(await activeRules(client), {
    categoryIds: facts.categoryIds,
    valueMinor: facts.group.goodsTotalMinor,
    currency: facts.group.currency,
    destinationCountry: facts.destinationCountry,
    supplierRisk: risk.tier,
    buyerRequested: false,
    now,
  });

  // An order made from an RFQ purchase order carries the contract's own
  // inspection terms (LIVE-004), and they can only raise what the rules said:
  // a purchase order that asks for an inspection makes it MANDATORY. Its
  // approved reference sample is what the goods are measured against
  // (JOURNEY-019).
  const contracted = await purchaseOrderInspectionFor(client, facts.group.orderId, facts.group.sellerAccountId);
  const decision =
    contracted !== null && contracted.reason !== null && ruled.level !== 'MANDATORY'
      ? {
          ...ruled,
          level: 'MANDATORY' as const,
          reason: contracted.reason,
          ruleId: null,
          ruleName: `Purchase order ${contracted.reference}`,
        }
      : ruled;

  const id = newId();
  const inputs = {
    categoryIds: facts.categoryIds,
    valueMinor: facts.group.goodsTotalMinor.toString(),
    currency: facts.group.currency,
    destinationCountry: facts.destinationCountry,
    supplierRisk: risk.tier,
    supplierRiskRated: risk.rated,
    recentFailures: risk.recentFailures,
    matched: decision.matched,
    purchaseOrder: contracted === null ? null : { reference: contracted.reference, requiresInspection: contracted.reason !== null },
    referenceSampleId: contracted?.referenceSampleId ?? null,
  };

  try {
    await client.inspectionRequirement.create({
      data: {
        id,
        sellerOrderGroupId,
        orderId: facts.group.orderId,
        sellerAccountId: facts.group.sellerAccountId,
        level: decision.level,
        status: decision.level === 'NOT_REQUIRED' ? 'NOT_REQUIRED' : 'AWAITING_BOOKING',
        ruleId: decision.ruleId,
        ruleName: decision.ruleName,
        reason: decision.reason,
        inputsJson: inputs,
        planId: decision.planId,
        preferredAgencyId: decision.preferredAgencyId,
        allowConditionalRelease: decision.allowConditionalRelease,
        referenceSampleId: contracted?.referenceSampleId ?? null,
        evaluatedAt: now,
      },
    });
  } catch (error) {
    // Two requests decided it at once; the unique index kept one.
    if ((error as { code?: string }).code === 'P2002') {
      return client.inspectionRequirement.findUniqueOrThrow({
        where: { sellerOrderGroupId },
        select: { id: true, level: true },
      });
    }
    throw error;
  }

  await recordInspectionEvent(client, {
    requirementId: id,
    orderId: facts.group.orderId,
    kind: 'requirement_decided',
    actor,
    summary: decision.reason,
    data: { level: decision.level, ruleId: decision.ruleId, ruleName: decision.ruleName, inputs },
    audit: AuditAction.INSPECTION_REQUIREMENT_DECIDED,
  });

  if (decision.level !== 'NOT_REQUIRED') {
    await notifySeller({
      sellerAccountId: facts.group.sellerAccountId,
      kind: 'INSPECTION_UPDATE',
      title: 'This order needs a pre-shipment inspection',
      body: `${decision.reason} Book an inspection and present the lot before you dispatch.`,
      linkPath: `/seller/orders/${sellerOrderGroupId}`,
      severity: 'WARNING',
      subjectType: 'inspection_requirement',
      subjectId: id,
      dedupeKey: `inspection-required:${id}`,
      tx: client,
    });
  }

  return { id, level: decision.level };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/** Every fact the pure gate needs, for one requirement. */
async function gateFacts(
  client: Client | typeof prisma,
  requirementId: string,
  options: { alreadyCollected: boolean },
) {
  const requirement = await client.inspectionRequirement.findUniqueOrThrow({
    where: { id: requirementId },
    select: { id: true, level: true, sellerOrderGroupId: true, loadReleasedAt: true },
  });

  const policy = await readPolicy(client);
  const blockingSeverities = [
    'CRITICAL' as const,
    ...(policy.majorNcrBlocksDispatch ? (['MAJOR'] as const) : []),
    ...(policy.minorNcrBlocksDispatch ? (['MINOR'] as const) : []),
  ];

  const [release, latestSigned, openJob, blockingNcrCount, scope] = await Promise.all([
    client.inspectionRelease.findFirst({
      where: { requirementId, state: { in: ['ACTIVE', 'PENDING_APPROVAL'] } },
      orderBy: { requestedAt: 'desc' },
      select: { id: true, kind: true, state: true, boundScopeHash: true },
    }),
    client.inspectionReport.findFirst({
      where: { status: 'SIGNED', job: { requirementId } },
      orderBy: { signedAt: 'desc' },
      select: { id: true, result: true, publishedToBuyerAt: true, jobId: true },
    }),
    client.inspectionJob.findFirst({
      where: { requirementId, status: { in: [...OPEN_JOB_STATUSES] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, kind: true },
    }),
    // Only findings on a signed report hold the goods. A defect written into a
    // report still being drafted is the inspector's working, not a finding.
    client.inspectionDefect.count({
      where: {
        requirementId,
        status: { not: 'VERIFIED_CLOSED' },
        severity: { in: blockingSeverities },
        job: { status: 'COMPLETED' },
      },
    }),
    currentScope(client, requirement.sellerOrderGroupId),
  ]);

  const buyerReviewEndsAt =
    policy.buyerReviewHours > 0 &&
    policy.buyerReportAccess === 'BEFORE_RELEASE' &&
    latestSigned?.publishedToBuyerAt !== null &&
    latestSigned?.publishedToBuyerAt !== undefined
      ? new Date(latestSigned.publishedToBuyerAt.getTime() + policy.buyerReviewHours * 60 * 60 * 1000)
      : null;

  const verdict = evaluateInspectionGate({
    requirementId,
    level: requirement.level,
    release:
      release === null
        ? null
        : {
            kind: release.kind,
            state: release.state === 'ACTIVE' ? 'ACTIVE' : 'PENDING_APPROVAL',
            boundScopeHash: release.boundScopeHash,
          },
    latestSignedResult: latestSigned?.result ?? null,
    hasOpenJob: openJob !== null,
    blockingNcrCount,
    currentScopeHash: scope.hash,
    alreadyCollected: options.alreadyCollected,
    buyerReviewEndsAt,
    now: new Date(),
  });

  return { verdict, requirement, release, latestSigned, openJob, blockingNcrCount, scope, policy };
}

/**
 * The verdict for a seller order, deciding the requirement first if needed.
 * Call inside the transaction that will make the move.
 */
export async function evaluateSellerOrderGate(
  client: Client,
  sellerOrderGroupId: string,
): Promise<InspectionGateVerdict> {
  const requirement = await ensureRequirement(client, sellerOrderGroupId);
  if (requirement === null) return { ...GATE_NOT_APPLICABLE, reason: 'NOT_REQUIRED' };
  if (requirement.level === 'NOT_REQUIRED') {
    return { open: true, reason: 'NOT_REQUIRED', requirementId: requirement.id, level: 'NOT_REQUIRED' };
  }
  return (await gateFacts(client, requirement.id, { alreadyCollected: false })).verdict;
}

/**
 * The verdict for a consignment about to move from `from` to a guarded status.
 *
 * A consignment with no seller order behind it - a warehouse transfer, a
 * sample - has nothing to inspect. One already in the carrier's hands keeps
 * moving: its release was checked at collection.
 */
export async function evaluateShipmentGate(
  client: Client,
  shipmentId: string,
  from: ShipmentStatusName,
): Promise<InspectionGateVerdict> {
  const shipment = await client.logisticsShipment.findUnique({
    where: { id: shipmentId },
    select: { sellerOrderGroupId: true, pickedUpAt: true, dispatchedAt: true },
  });

  if (shipment === null || shipment.sellerOrderGroupId === null) return GATE_NOT_APPLICABLE;

  const alreadyCollected =
    shipment.pickedUpAt !== null ||
    shipment.dispatchedAt !== null ||
    INSPECTION_GATED_SHIPMENT_STATUSES.includes(from);

  if (alreadyCollected) {
    const existing = await client.inspectionRequirement.findUnique({
      where: { sellerOrderGroupId: shipment.sellerOrderGroupId },
      select: { id: true, level: true },
    });
    return {
      open: true,
      reason: 'ALREADY_RELEASED',
      requirementId: existing?.id ?? null,
      level: existing?.level ?? null,
    };
  }

  const requirement = await ensureRequirement(client, shipment.sellerOrderGroupId);
  if (requirement === null) return { ...GATE_NOT_APPLICABLE, reason: 'NOT_REQUIRED' };
  if (requirement.level === 'NOT_REQUIRED') {
    return { open: true, reason: 'NOT_REQUIRED', requirementId: requirement.id, level: 'NOT_REQUIRED' };
  }

  return (await gateFacts(client, requirement.id, { alreadyCollected: false })).verdict;
}

/** Read-only verdict for screens. Never creates a requirement. */
export async function peekGate(requirementId: string): Promise<InspectionGateVerdict> {
  return (await gateFacts(prisma, requirementId, { alreadyCollected: false })).verdict;
}

/**
 * The goods went through the gate. Recorded once per requirement: the first
 * guarded move to succeed is the load release (INSPECT-005).
 */
export async function recordGatePassage(
  client: Client,
  verdict: InspectionGateVerdict,
  context: { what: string; actor?: InspectionActor },
): Promise<void> {
  if (verdict.requirementId === null) return;
  if (verdict.reason !== 'PASSED' && verdict.reason !== 'CONDITIONALLY_RELEASED') return;

  const now = new Date();
  const claimed = await client.inspectionRequirement.updateMany({
    where: { id: verdict.requirementId, loadReleasedAt: null },
    data: { loadReleasedAt: now, status: 'DISPATCHED', version: { increment: 1 } },
  });
  if (claimed.count !== 1) return;

  const requirement = await client.inspectionRequirement.findUniqueOrThrow({
    where: { id: verdict.requirementId },
    select: { orderId: true },
  });

  await recordInspectionEvent(client, {
    requirementId: verdict.requirementId,
    orderId: requirement.orderId,
    kind: 'load_released',
    actor: context.actor ?? SYSTEM_ACTOR,
    summary: `The goods were released for dispatch: ${context.what}.`,
    data: { reason: verdict.reason },
    audit: AuditAction.INSPECTION_LOAD_RELEASED,
  });
}

// ---------------------------------------------------------------------------
// The summary status
// ---------------------------------------------------------------------------

/**
 * Rewrite the requirement's status from the facts. The gate never reads it;
 * the queues, cards and badges do.
 */
export async function refreshRequirementStatus(client: Client, requirementId: string): Promise<string> {
  const { verdict, requirement, openJob } = await gateFacts(client, requirementId, { alreadyCollected: false });

  let status: string;
  if (requirement.level === 'NOT_REQUIRED') status = 'NOT_REQUIRED';
  else if (requirement.loadReleasedAt !== null) status = 'DISPATCHED';
  else if (verdict.reason === 'PASSED') status = 'RELEASED';
  else if (verdict.reason === 'CONDITIONALLY_RELEASED') status = 'RELEASED_CONDITIONALLY';
  else if (verdict.reason === 'RELEASE_PENDING_APPROVAL') status = 'RELEASE_PENDING_APPROVAL';
  else if (openJob !== null) {
    status =
      openJob.status === 'IN_PROGRESS'
        ? 'IN_PROGRESS'
        : openJob.status === 'REPORT_SUBMITTED'
          ? 'REPORT_IN_REVIEW'
          : 'BOOKED';
  } else if (verdict.reason === 'FAILED') status = 'FAILED';
  else if (verdict.reason === 'BLOCKING_NCR_OPEN') status = 'BLOCKED_BY_NCR';
  else if (verdict.reason === 'SCOPE_CHANGED') status = 'REEVALUATION_REQUIRED';
  else if (verdict.reason === 'BUYER_REVIEW_PERIOD') status = 'REPORT_IN_REVIEW';
  else status = 'AWAITING_BOOKING';

  await client.inspectionRequirement.update({
    where: { id: requirementId },
    data: { status: status as never, version: { increment: 1 } },
  });

  return status;
}

/**
 * The seven states an order card shows (ENH-010): Not required, Required,
 * Booked, In progress, NCR, Reinspection, Released.
 */
export type InspectionCardStatus =
  | 'NOT_REQUIRED'
  | 'REQUIRED'
  | 'BOOKED'
  | 'IN_PROGRESS'
  | 'NCR'
  | 'REINSPECTION'
  | 'RELEASED';

export function cardStatusFor(status: string, hasOpenReinspection: boolean): InspectionCardStatus {
  if (hasOpenReinspection) return 'REINSPECTION';
  switch (status) {
    case 'NOT_REQUIRED':
      return 'NOT_REQUIRED';
    case 'BOOKED':
      return 'BOOKED';
    case 'IN_PROGRESS':
    case 'REPORT_IN_REVIEW':
      return 'IN_PROGRESS';
    case 'FAILED':
    case 'BLOCKED_BY_NCR':
      return 'NCR';
    case 'RELEASED':
    case 'RELEASED_CONDITIONALLY':
    case 'DISPATCHED':
      return 'RELEASED';
    default:
      return 'REQUIRED';
  }
}

/** Card status per seller order group, for list screens. Missing = not decided yet. */
export async function cardStatusesForGroups(groupIds: readonly string[]): Promise<Map<string, InspectionCardStatus>> {
  const result = new Map<string, InspectionCardStatus>();
  if (groupIds.length === 0) return result;

  const rows = await prisma.inspectionRequirement.findMany({
    where: { sellerOrderGroupId: { in: [...groupIds] } },
    select: {
      sellerOrderGroupId: true,
      status: true,
      jobs: {
        where: { kind: 'REINSPECTION', status: { in: [...OPEN_JOB_STATUSES] } },
        select: { id: true },
        take: 1,
      },
    },
  });

  for (const row of rows) result.set(row.sellerOrderGroupId, cardStatusFor(row.status, row.jobs.length > 0));
  return result;
}

const CARD_WEIGHT: Record<InspectionCardStatus, number> = {
  NOT_REQUIRED: 0,
  RELEASED: 1,
  BOOKED: 2,
  IN_PROGRESS: 3,
  REINSPECTION: 4,
  REQUIRED: 5,
  NCR: 6,
};

/**
 * One status per buyer order: the one that most needs attention across its
 * sellers' parts. Null when no part has been decided.
 */
export async function cardStatusesForOrders(orderIds: readonly string[]): Promise<Map<string, InspectionCardStatus>> {
  const result = new Map<string, InspectionCardStatus>();
  if (orderIds.length === 0) return result;

  const rows = await prisma.inspectionRequirement.findMany({
    where: { orderId: { in: [...orderIds] } },
    select: {
      orderId: true,
      status: true,
      jobs: {
        where: { kind: 'REINSPECTION', status: { in: [...OPEN_JOB_STATUSES] } },
        select: { id: true },
        take: 1,
      },
    },
  });

  for (const row of rows) {
    const status = cardStatusFor(row.status, row.jobs.length > 0);
    const current = result.get(row.orderId);
    if (current === undefined || CARD_WEIGHT[status] > CARD_WEIGHT[current]) result.set(row.orderId, status);
  }
  return result;
}

// ---------------------------------------------------------------------------
// After a release: tell the carrier
// ---------------------------------------------------------------------------

/**
 * Every carrier already booked on this seller order hears that the goods may
 * now be collected (UAT-UI-010). Called after a release becomes ACTIVE, once
 * the verdict is confirmed open.
 */
export async function notifyDispatchAuthorised(
  client: Client,
  requirementId: string,
  releaseId: string,
): Promise<number> {
  const { verdict, requirement } = await gateFacts(client, requirementId, { alreadyCollected: false });
  if (!verdict.open) return 0;

  const shipments = await client.logisticsShipment.findMany({
    where: {
      sellerOrderGroupId: requirement.sellerOrderGroupId,
      status: { notIn: ['CANCELLED', ...INSPECTION_GATED_SHIPMENT_STATUSES] },
      assignedPartnerId: { not: null },
    },
    select: { id: true, shipmentReference: true, assignedPartnerId: true },
  });

  let told = 0;
  for (const shipment of shipments) {
    if (shipment.assignedPartnerId === null) continue;
    const created = await createLogisticsNotification(
      {
        logisticsPartnerId: shipment.assignedPartnerId,
        shipmentId: shipment.id,
        kind: 'DISPATCH_AUTHORISED',
        title: `Dispatch authorised for ${shipment.shipmentReference}`,
        body: 'The goods passed their pre-shipment inspection. The consignment may now be collected.',
        variables: { shipmentReference: shipment.shipmentReference },
        dedupeKey: `dispatch-authorised:${releaseId}:${shipment.id}`,
      },
      client,
    );
    if (created.created) told += 1;
  }

  const order = await client.inspectionRequirement.findUniqueOrThrow({
    where: { id: requirementId },
    select: { orderId: true },
  });

  await recordInspectionEvent(client, {
    requirementId,
    orderId: order.orderId,
    kind: 'dispatch_authorised',
    actor: SYSTEM_ACTOR,
    summary:
      shipments.length === 0
        ? 'Dispatch authorised. No carrier is booked yet; the one booked next can collect straight away.'
        : `Dispatch authorised and ${String(told)} carrier${told === 1 ? '' : 's'} told the goods may be collected.`,
    data: { releaseId, shipments: shipments.map((shipment) => shipment.shipmentReference) },
  });

  return told;
}

// ---------------------------------------------------------------------------
// After a change to what was inspected
// ---------------------------------------------------------------------------

/**
 * Something changed on a consignment - packages, container, seal, quantity.
 *
 * The gate needs no telling: it compares fingerprints on every guarded move,
 * so a change is caught however it was made. This records it on the timeline
 * and the order's audit trail, moves the summary to REEVALUATION_REQUIRED and
 * tells the seller, so the change is visible before somebody tries to
 * dispatch (INSPECT-004, UAT-UI-011). Best-effort by design: a failure here
 * must not undo the seller's save, and the gate stays shut regardless.
 */
export async function onInspectedScopeChanged(
  client: Client,
  shipmentId: string,
  actor: InspectionActor,
  what: string,
): Promise<void> {
  try {
    const shipment = await client.logisticsShipment.findUnique({
      where: { id: shipmentId },
      select: { sellerOrderGroupId: true, shipmentReference: true },
    });
    if (shipment === null || shipment.sellerOrderGroupId === null) return;

    const requirement = await client.inspectionRequirement.findUnique({
      where: { sellerOrderGroupId: shipment.sellerOrderGroupId },
      select: { id: true, orderId: true, sellerAccountId: true, level: true },
    });
    if (requirement === null || requirement.level === 'NOT_REQUIRED') return;

    const release = await client.inspectionRelease.findFirst({
      where: { requirementId: requirement.id, state: 'ACTIVE' },
      orderBy: { requestedAt: 'desc' },
      select: { id: true, boundScopeHash: true, boundScopeJson: true },
    });
    if (release === null) return;

    const scope = await currentScope(client, shipment.sellerOrderGroupId);
    if (scope.hash === release.boundScopeHash) return;

    const loadReleased = await client.inspectionRequirement.findUniqueOrThrow({
      where: { id: requirement.id },
      select: { loadReleasedAt: true },
    });

    await recordInspectionEvent(client, {
      requirementId: requirement.id,
      orderId: requirement.orderId,
      kind: 'scope_changed',
      actor,
      summary:
        loadReleased.loadReleasedAt === null
          ? `${what} on ${shipment.shipmentReference} changed after the inspection. Dispatch is blocked until it is re-evaluated.`
          : `${what} on ${shipment.shipmentReference} changed after the goods were released.`,
      data: { releaseId: release.id, before: release.boundScopeJson, after: scope.summary },
      audit: AuditAction.INSPECTION_SCOPE_CHANGED,
    });

    await refreshRequirementStatus(client, requirement.id);

    if (loadReleased.loadReleasedAt === null) {
      await notifySeller({
        sellerAccountId: requirement.sellerAccountId,
        kind: 'INSPECTION_UPDATE',
        title: 'The inspected goods changed',
        body: `${what} on ${shipment.shipmentReference} no longer matches what was inspected. The inspection agency or the marketplace must re-evaluate it before the goods can leave.`,
        linkPath: `/seller/orders/${shipment.sellerOrderGroupId}`,
        severity: 'WARNING',
        subjectType: 'inspection_requirement',
        subjectId: requirement.id,
        tx: client,
      });
    }
  } catch (error) {
    logger.warn({ err: error, shipmentId }, 'could not record an inspected-scope change');
  }
}
