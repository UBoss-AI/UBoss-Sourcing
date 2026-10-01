/**
 * Destination documentation readiness and the pre-dispatch exception hold, as
 * the services see it (JOURNEY-049).
 *
 * `domain/compliance-hold.ts` decides from facts; this file gathers them for
 * one seller order - the destination, each line's category path and HS code
 * with its verification state, the trade rules in force for that destination,
 * the current version of every trade document, and any staff override - and
 * is what the seller-order and consignment services call before a guarded
 * move, inside their own transaction.
 *
 * It also holds the staff override: a written reason, audited, covering the
 * holds that existed when it was granted.
 */
import {
  COMPLIANCE_NOT_APPLICABLE,
  evaluateCompliance,
  validationStateOf,
  type ComplianceLineFact,
  type ComplianceRuleFact,
  type ComplianceVerdict,
  type TradeValidationState,
} from '../../domain/compliance-hold.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { INSPECTION_GATED_SHIPMENT_STATUSES, type ShipmentStatusName } from '../../domain/logistics-shipment-state.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { notifySeller } from '../seller/notification.service.js';

type Client = PrismaTransaction | typeof prisma;

/** The ISO country of a stored address, or ''. */
export function destinationCountryOf(address: unknown): string {
  if (typeof address !== 'object' || address === null) return '';
  const record = address as Record<string, unknown>;
  const value = record['country'] ?? record['countryCode'];
  return typeof value === 'string' && value.trim().length === 2 ? value.trim().toUpperCase() : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Every fact the pure evaluation needs, for one seller order. Null when there is no such order. */
async function factsFor(client: Client, sellerOrderGroupId: string) {
  const group = await client.sellerOrderGroup.findUnique({
    where: { id: sellerOrderGroupId },
    select: {
      id: true,
      orderId: true,
      sellerAccountId: true,
      sellerOrderNumber: true,
      status: true,
      order: { select: { shippingAddressJson: true } },
      lines: {
        select: {
          offer: {
            select: {
              sellerSku: true,
              hsnCode: true,
              hsVerificationState: true,
              hsVerifiedCode: true,
              product: { select: { categoryId: true, category: { select: { path: true } } } },
            },
          },
        },
      },
    },
  });
  if (group === null) return null;

  const destination = destinationCountryOf(group.order.shippingAddressJson);

  const lines: ComplianceLineFact[] = group.lines.map((line) => {
    const ids = new Set<string>([line.offer.product.categoryId]);
    for (const id of line.offer.product.category.path.split('/')) if (id !== '') ids.add(id);
    return {
      sku: line.offer.sellerSku,
      categoryIds: [...ids],
      hsCode: line.offer.hsnCode,
      hsState: line.offer.hsVerificationState,
      hsVerifiedCode: line.offer.hsVerifiedCode,
    };
  });

  const [ruleRows, documentRows, override] = await Promise.all([
    client.tradeComplianceRule.findMany({
      where: { isActive: true, destinationCountry: { in: destination === '' ? [''] : ['', destination] } },
      select: {
        id: true,
        name: true,
        destinationCountry: true,
        categoryId: true,
        hsPrefix: true,
        restriction: true,
        requiredDocumentKind: true,
        requiredDocumentName: true,
        responsibleParty: true,
        requiresHsVerification: true,
        note: true,
      },
      take: 500,
    }),
    client.orderTradeDocument.findMany({
      where: { orderGroupId: group.id, currentVersion: { gt: 0 } },
      select: {
        kind: true,
        currentVersion: true,
        versions: { where: { supersededAt: null }, select: { version: true, validation: true, expiresOn: true } },
      },
    }),
    client.tradeComplianceOverride.findUnique({
      where: { sellerOrderGroupId: group.id },
      select: { reason: true, holdKeysJson: true, grantedByLabel: true, createdAt: true, updatedAt: true, revokedAt: true },
    }),
  ]);

  const documents = new Map<string, TradeValidationState[]>();
  for (const row of documentRows) {
    const current = row.versions.find((version) => version.version === row.currentVersion);
    if (current === undefined) continue;
    const states = documents.get(row.kind) ?? [];
    states.push(validationStateOf(current.validation, current.expiresOn));
    documents.set(row.kind, states);
  }

  const rules: ComplianceRuleFact[] = ruleRows;
  return { group, destination, lines, rules, documents, override };
}

/** The verdict for one seller order. Read-only; safe inside the caller's transaction. */
export async function evaluateSellerOrderCompliance(
  client: Client,
  sellerOrderGroupId: string,
): Promise<ComplianceVerdict> {
  const facts = await factsFor(client, sellerOrderGroupId);
  if (facts === null) return COMPLIANCE_NOT_APPLICABLE;
  const active = facts.override !== null && facts.override.revokedAt === null ? facts.override : null;
  return evaluateCompliance({
    destination: facts.destination,
    rules: facts.rules,
    lines: facts.lines,
    documents: facts.documents,
    overrideKeys: active === null ? null : stringArray(active.holdKeysJson),
  });
}

/**
 * The verdict for a consignment about to move from `from` to a collected or
 * moving status. A consignment with no seller order behind it has nothing to
 * check; one already in the carrier's hands keeps moving - it was checked at
 * collection.
 */
export async function evaluateShipmentCompliance(
  client: Client,
  shipmentId: string,
  from: ShipmentStatusName,
): Promise<ComplianceVerdict> {
  const shipment = await client.logisticsShipment.findUnique({
    where: { id: shipmentId },
    select: { sellerOrderGroupId: true, pickedUpAt: true, dispatchedAt: true },
  });
  if (shipment === null || shipment.sellerOrderGroupId === null) return COMPLIANCE_NOT_APPLICABLE;
  if (shipment.pickedUpAt !== null || shipment.dispatchedAt !== null || INSPECTION_GATED_SHIPMENT_STATUSES.includes(from)) {
    return COMPLIANCE_NOT_APPLICABLE;
  }
  return evaluateSellerOrderCompliance(client, shipment.sellerOrderGroupId);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface ComplianceOverrideView {
  reason: string;
  grantedByLabel: string;
  grantedAt: string;
  revokedAt: string | null;
}

export interface SellerOrderComplianceView {
  sellerOrderGroupId: string;
  sellerOrderNumber: string;
  sellerName: string;
  status: string;
  verdict: ComplianceVerdict;
  override: ComplianceOverrideView | null;
}

function overrideView(row: {
  reason: string;
  grantedByLabel: string;
  updatedAt: Date;
  revokedAt: Date | null;
} | null): ComplianceOverrideView | null {
  if (row === null) return null;
  return {
    reason: row.reason,
    grantedByLabel: row.grantedByLabel,
    grantedAt: row.updatedAt.toISOString(),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
  };
}

/** Every seller order on one buyer order, with its readiness and any override. For staff. */
export async function adminOrderCompliance(orderId: string): Promise<SellerOrderComplianceView[]> {
  const groups = await prisma.sellerOrderGroup.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, sellerAccount: { select: { displayName: true } } },
  });
  if (groups.length === 0) {
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } });
    if (order === null) throw notFound('Order');
  }
  const out: SellerOrderComplianceView[] = [];
  for (const group of groups) {
    const facts = await factsFor(prisma, group.id);
    if (facts === null) continue;
    const active = facts.override !== null && facts.override.revokedAt === null ? facts.override : null;
    out.push({
      sellerOrderGroupId: group.id,
      sellerOrderNumber: facts.group.sellerOrderNumber,
      sellerName: group.sellerAccount.displayName,
      status: facts.group.status,
      verdict: evaluateCompliance({
        destination: facts.destination,
        rules: facts.rules,
        lines: facts.lines,
        documents: facts.documents,
        overrideKeys: active === null ? null : stringArray(active.holdKeysJson),
      }),
      override: overrideView(facts.override),
    });
  }
  return out;
}

/** The seller's own view of one of their orders: readiness and any override in force. */
export async function sellerOrderCompliance(
  sellerAccountId: string,
  sellerOrderGroupId: string,
): Promise<{ verdict: ComplianceVerdict; override: ComplianceOverrideView | null }> {
  const facts = await factsFor(prisma, sellerOrderGroupId);
  if (facts === null || facts.group.sellerAccountId !== sellerAccountId) throw notFound('Order');
  const active = facts.override !== null && facts.override.revokedAt === null ? facts.override : null;
  return {
    verdict: evaluateCompliance({
      destination: facts.destination,
      rules: facts.rules,
      lines: facts.lines,
      documents: facts.documents,
      overrideKeys: active === null ? null : stringArray(active.holdKeysJson),
    }),
    override: active === null ? null : overrideView(active),
  };
}

export interface BuyerComplianceAction {
  sellerName: string;
  ruleName: string;
  documentName: string | null;
  restriction: 'NONE' | 'RESTRICTED' | 'PROHIBITED';
  note: string | null;
}

/**
 * What the destination rules ask the BUYER to produce for one of their own
 * orders - an import licence, a permit - so they can have it ready before the
 * goods arrive. Ownership is the caller's order scope.
 */
export async function buyerComplianceActions(
  scope: { customerProfileId?: string; buyerCompanyId: string | null },
  orderId: string,
): Promise<BuyerComplianceAction[]> {
  const order = await prisma.order.findFirst({ where: { id: orderId, ...scope }, select: { id: true } });
  if (order === null) throw notFound('Order');
  const groups = await prisma.sellerOrderGroup.findMany({
    where: { orderId: order.id },
    orderBy: { createdAt: 'asc' },
    select: { id: true, sellerAccount: { select: { displayName: true } } },
  });
  const out: BuyerComplianceAction[] = [];
  for (const group of groups) {
    const verdict = await evaluateSellerOrderCompliance(prisma, group.id);
    for (const item of verdict.items) {
      if (item.responsibleParty !== 'BUYER') continue;
      out.push({
        sellerName: group.sellerAccount.displayName,
        ruleName: item.ruleName,
        documentName: item.documentName,
        restriction: item.restriction,
        note: item.note,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The staff override
// ---------------------------------------------------------------------------

export interface ComplianceStaffActor {
  userId: string;
  email: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

/**
 * Let the goods of one seller order leave despite its current holds, with a
 * written reason. Covers exactly the holds open now; a new one holds the goods
 * again. Audited, and the seller is told.
 */
export async function grantComplianceOverride(input: {
  sellerOrderGroupId: string;
  reason: string;
  actor: ComplianceStaffActor;
}): Promise<SellerOrderComplianceView> {
  const reason = input.reason.trim();
  if (reason.length < 10) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say why the goods may leave despite the hold.', [
      { field: 'reason', code: 'TOO_SHORT', meta: { minimum: 10 } },
    ]);
  }

  const groupId = await prisma.$transaction(async (tx) => {
    const facts = await factsFor(tx, input.sellerOrderGroupId);
    if (facts === null) throw notFound('Seller order');
    const verdict = evaluateCompliance({
      destination: facts.destination,
      rules: facts.rules,
      lines: facts.lines,
      documents: facts.documents,
      overrideKeys: null,
    });
    if (verdict.holds.length === 0) {
      throw conflict(ErrorCode.CONFLICT, 'Nothing holds these goods; there is nothing to override.', [
        { code: 'NOTHING_TO_OVERRIDE' },
      ]);
    }
    const keys = verdict.holds.map((hold) => hold.key);
    const data = {
      reason: reason.slice(0, 1000),
      holdKeysJson: keys,
      grantedByStaffId: input.actor.userId,
      grantedByLabel: input.actor.email.slice(0, 160),
      revokedAt: null,
      revokedByStaffId: null,
    };
    await tx.tradeComplianceOverride.upsert({
      where: { sellerOrderGroupId: facts.group.id },
      create: { id: newId(), sellerOrderGroupId: facts.group.id, orderId: facts.group.orderId, ...data },
      update: data,
    });
    await recordAudit(
      {
        action: AuditAction.COMPLIANCE_HOLD_OVERRIDDEN,
        resourceType: 'seller_order_group',
        resourceId: facts.group.id,
        actorType: 'ADMIN',
        actorUserId: input.actor.userId,
        actorEmail: input.actor.email,
        before: facts.override === null ? null : { holdKeys: stringArray(facts.override.holdKeysJson), revokedAt: facts.override.revokedAt },
        after: { reason: data.reason, holdKeys: keys, holds: verdict.holds.map((hold) => hold.code) },
        ipAddress: input.actor.ipAddress ?? null,
        correlationId: input.actor.correlationId ?? null,
      },
      tx,
    );
    await notifySeller({
      sellerAccountId: facts.group.sellerAccountId,
      kind: 'INSPECTION_UPDATE',
      title: `The compliance hold on ${facts.group.sellerOrderNumber} was overridden`,
      body: `The marketplace let these goods leave despite the destination hold. Reason: ${data.reason}`,
      linkPath: `/seller/orders/${facts.group.id}`,
      severity: 'INFO',
      subjectType: 'seller_order_group',
      subjectId: facts.group.id,
      tx,
    });
    return facts.group.id;
  });

  return requireAdminView(groupId);
}

/** Withdraw an override: the holds apply again. Audited. */
export async function revokeComplianceOverride(input: {
  sellerOrderGroupId: string;
  actor: ComplianceStaffActor;
}): Promise<SellerOrderComplianceView> {
  await prisma.$transaction(async (tx) => {
    const row = await tx.tradeComplianceOverride.findUnique({
      where: { sellerOrderGroupId: input.sellerOrderGroupId },
      select: { id: true, revokedAt: true, holdKeysJson: true, reason: true },
    });
    if (row === null || row.revokedAt !== null) throw notFound('Override');
    await tx.tradeComplianceOverride.update({
      where: { id: row.id },
      data: { revokedAt: new Date(), revokedByStaffId: input.actor.userId },
    });
    await recordAudit(
      {
        action: AuditAction.COMPLIANCE_HOLD_OVERRIDE_REVOKED,
        resourceType: 'seller_order_group',
        resourceId: input.sellerOrderGroupId,
        actorType: 'ADMIN',
        actorUserId: input.actor.userId,
        actorEmail: input.actor.email,
        before: { reason: row.reason, holdKeys: stringArray(row.holdKeysJson) },
        after: { revoked: true },
        ipAddress: input.actor.ipAddress ?? null,
        correlationId: input.actor.correlationId ?? null,
      },
      tx,
    );
  });
  return requireAdminView(input.sellerOrderGroupId);
}

async function requireAdminView(sellerOrderGroupId: string): Promise<SellerOrderComplianceView> {
  const group = await prisma.sellerOrderGroup.findUnique({
    where: { id: sellerOrderGroupId },
    select: { orderId: true },
  });
  if (group === null) throw notFound('Seller order');
  const views = await adminOrderCompliance(group.orderId);
  const view = views.find((row) => row.sellerOrderGroupId === sellerOrderGroupId);
  if (view === undefined) throw notFound('Seller order');
  return view;
}
