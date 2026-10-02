/**
 * The binding purchase-order review produced from an awarded RFQ (Master row 21).
 *
 * The accepted offer is the authority. This service copies it and the awarded
 * requirement into one canonical contract, hashes that snapshot, and never
 * edits it. Company approval rows are decisions about that hash; they are not
 * another place where commercial terms can drift.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import { roleHasCapability } from '../../domain/buyer-company-state.js';
import { lineTotalMinor } from '../../domain/rfq.js';
import { canonicalRfqJson, type OfferTerms } from '../../domain/rfq-quote.js';
import { serialiseMoney } from '../../domain/money.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import type { RfqBuyer } from './access.js';
import { acceptedTerms } from './negotiation.service.js';
import { loadRfqForBuyer, requirementOf } from './rfq.service.js';

export const submitPurchaseOrderSchema = z
  .object({
    acceptedTermsHash: z.string().regex(/^[a-f0-9]{64}$/),
    eAccepted: z.literal(true),
    signatureName: z.string().trim().min(2).max(160),
    signatureTitle: z.string().trim().max(160).nullable().default(null),
    buyerSku: z.string().trim().max(80).nullable().default(null),
  })
  .strict();

export const purchaseOrderDecisionSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    approved: z.boolean(),
    reason: z.string().trim().max(1000).nullable().default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.approved && (value.reason === null || value.reason.length === 0)) {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'Give a reason for rejecting this purchase order.',
      });
    }
  });

export interface PurchaseOrderActor {
  userId: string;
  email: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

interface ContractSnapshot {
  schemaVersion: 1;
  rfq: { id: string; reference: string; requirementVersion: number };
  quote: {
    id: string;
    versionId: string;
    versionNumber: number;
    acceptedTermsHash: string;
    acceptedAt: string;
  };
  buyer: { kind: 'INDIVIDUAL' | 'COMPANY'; companyId: string | null };
  supplier: { sellerAccountId: string; name: string };
  item: {
    buyerSku: string | null;
    title: string;
    specification: string | null;
    specifications: { key: string; value: string }[];
    quantity: string;
    unitOfMeasure: string | null;
  };
  delivery: {
    destinationCountry: string | null;
    destinationAddress: string | null;
    destinationPort: string | null;
    targetDate: string | null;
    leadTimeDays: number | null;
    incoterm: string | null;
    incotermPlace: string | null;
  };
  commercial: OfferTerms & {
    applicableUnitPriceMinor: string;
    goodsTotalMinor: string;
    toolingMinor: string;
    shippingMinor: string;
    grandTotalMinor: string;
  };
  quality: {
    certifications: string[];
    inspectionRequirement: string;
    inspectionTerms: string | null;
    sampleRequirement: string;
    warranty: string | null;
    /** Only when the accepted offer named any, so earlier orders hash as they did. */
    exportDocuments?: string[];
  };
  documents: { id: string; fileName: string; contentHash: string }[];
}

interface BuiltContract {
  snapshot: ContractSnapshot;
  hash: string;
  amounts: { currency: string; goods: bigint; tooling: bigint; shipping: bigint; grand: bigint };
}

function applicableUnitPrice(terms: OfferTerms): bigint {
  let price = BigInt(terms.unitPriceMinor);
  let minimum = -1n;
  const quantity = terms.quantity.split('.');
  const quantityThousandths =
    BigInt(quantity[0] ?? '0') * 1000n + BigInt(((quantity[1] ?? '') + '000').slice(0, 3));
  for (const tier of terms.tiers) {
    const parts = tier.minQuantity.split('.');
    const tierMinimum =
      BigInt(parts[0] ?? '0') * 1000n + BigInt(((parts[1] ?? '') + '000').slice(0, 3));
    if (tierMinimum <= quantityThousandths && tierMinimum > minimum) {
      minimum = tierMinimum;
      price = BigInt(tier.unitPriceMinor);
    }
  }
  return price;
}

async function buildContract(
  buyer: RfqBuyer,
  rfqId: string,
  buyerSku: string | null,
): Promise<BuiltContract> {
  const rfq = await loadRfqForBuyer(buyer, rfqId);
  const agreed = await acceptedTerms(rfq.id);
  const requirement = requirementOf(rfq);
  const documents = await prisma.rfqAttachment.findMany({
    where: {
      rfqId: rfq.id,
      purpose: 'REQUIREMENT',
      requirementVersion: rfq.currentRequirementVersion,
    },
    select: { id: true, fileName: true, contentHash: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const unitPrice = applicableUnitPrice(agreed.terms);
  const goods = lineTotalMinor(unitPrice, agreed.terms.quantity);
  const tooling = BigInt(agreed.terms.toolingMinor ?? '0');
  const shipping = BigInt(agreed.terms.shippingEstimateMinor ?? '0');
  const grand = goods + tooling + shipping;
  const snapshot: ContractSnapshot = {
    schemaVersion: 1,
    rfq: {
      id: rfq.id,
      reference: rfq.reference,
      requirementVersion: rfq.currentRequirementVersion,
    },
    quote: {
      id: agreed.quoteId,
      versionId: agreed.versionId,
      versionNumber: agreed.versionNumber,
      acceptedTermsHash: agreed.termsHash,
      acceptedAt: agreed.acceptedAt,
    },
    buyer: {
      kind: rfq.buyerCompanyId === null ? 'INDIVIDUAL' : 'COMPANY',
      companyId: rfq.buyerCompanyId,
    },
    supplier: { sellerAccountId: agreed.sellerAccountId, name: agreed.supplierName },
    item: {
      buyerSku,
      title: requirement.title,
      specification: requirement.specification,
      specifications: requirement.specs,
      quantity: agreed.terms.quantity,
      unitOfMeasure: requirement.unitOfMeasure,
    },
    delivery: {
      destinationCountry: requirement.destinationCountry,
      destinationAddress: requirement.destinationAddress,
      destinationPort: requirement.destinationPort,
      targetDate: requirement.deliveryTargetDate,
      leadTimeDays: agreed.terms.leadTimeDays,
      incoterm: agreed.terms.incoterm,
      incotermPlace: agreed.terms.incotermPlace,
    },
    commercial: {
      ...agreed.terms,
      applicableUnitPriceMinor: unitPrice.toString(),
      goodsTotalMinor: goods.toString(),
      toolingMinor: tooling.toString(),
      shippingMinor: shipping.toString(),
      grandTotalMinor: grand.toString(),
    },
    quality: {
      certifications: requirement.certifications,
      inspectionRequirement: requirement.inspectionRequirement,
      inspectionTerms: agreed.terms.inspectionTerms,
      sampleRequirement: requirement.sampleRequirement,
      warranty: agreed.terms.warranty,
      ...(agreed.terms.exportDocuments === undefined ? {} : { exportDocuments: agreed.terms.exportDocuments }),
    },
    documents,
  };
  return {
    snapshot,
    hash: createHash('sha256').update(canonicalRfqJson(snapshot)).digest('hex'),
    amounts: { currency: agreed.terms.currency, goods, tooling, shipping, grand },
  };
}

type PurchaseOrderRow = Prisma.RfqPurchaseOrderGetPayload<{ include: { approvals: true } }>;

function actionsFor(row: PurchaseOrderRow | null, buyer: RfqBuyer) {
  if (row === null) return { canSubmit: true, canApprove: false, canReject: false };
  if (row.status !== 'PENDING_APPROVAL' || buyer.context.kind !== 'COMPANY') {
    return { canSubmit: false, canApprove: false, canReject: false };
  }
  const pending =
    row.approvals.find(
      (approval) => approval.stage === 'APPROVER' && approval.decision === 'PENDING',
    ) ??
    row.approvals.find(
      (approval) => approval.stage === 'FINANCE' && approval.decision === 'PENDING',
    );
  if (pending === undefined || pending.requestedByUserId === buyer.userId) {
    return { canSubmit: false, canApprove: false, canReject: false };
  }
  const capability = pending.stage === 'APPROVER' ? 'APPROVE_ORDERS' : 'FINANCE';
  const priorApprover = row.approvals.find(
    (approval) => approval.stage === 'APPROVER',
  )?.decidedByUserId;
  const allowed =
    roleHasCapability(buyer.context.role, capability) &&
    (pending.stage !== 'FINANCE' || priorApprover !== buyer.userId);
  return { canSubmit: false, canApprove: allowed, canReject: allowed };
}

/** The order this purchase order became, as the buyer's screen needs it. */
interface LinkedOrder {
  id: string;
  orderNumber: string;
  status: string;
  currency: string;
  grandTotalMinor: bigint;
  confirmedAt: Date | null;
}

function view(row: PurchaseOrderRow, buyer: RfqBuyer, order: LinkedOrder | null = null) {
  // A cancelled order nobody paid for no longer counts: it may be replaced.
  const liveOrder =
    order !== null && (order.status !== 'CANCELLED' || order.confirmedAt !== null) ? order : null;
  const purchasing =
    buyer.context.kind === 'INDIVIDUAL' ||
    (buyer.context.companyStatus === 'APPROVED' &&
      roleHasCapability(buyer.context.role, 'PURCHASE'));
  return {
    id: row.id,
    reference: row.reference,
    rfqId: row.rfqId,
    quoteId: row.quoteId,
    status: row.status,
    version: row.version,
    acceptedTermsHash: row.acceptedTermsHash,
    contractHash: row.contractHash,
    contract: row.contractJson as unknown as ContractSnapshot,
    buyerSku: row.buyerSku,
    amounts: {
      currency: row.currency,
      goods: serialiseMoney(row.goodsTotalMinor, row.currency),
      tooling: serialiseMoney(row.toolingMinor, row.currency),
      shipping: serialiseMoney(row.shippingMinor, row.currency),
      grand: serialiseMoney(row.grandTotalMinor, row.currency),
    },
    electronicAcceptance: {
      acceptedAt: row.eAcceptedAt.toISOString(),
      signatureName: row.signatureName,
      signatureTitle: row.signatureTitle,
    },
    approvals: row.approvals
      .sort((a, b) => (a.stage === b.stage ? 0 : a.stage === 'APPROVER' ? -1 : 1))
      .map((approval) => ({
        stage: approval.stage,
        decision: approval.decision,
        decidedAt: approval.decidedAt?.toISOString() ?? null,
        reason: approval.reason,
      })),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt.toISOString(),
    actions: actionsFor(row, buyer),
    /** The marketplace order made from it (LIVE-004), or null before it is converted. */
    order:
      liveOrder === null
        ? null
        : {
            id: liveOrder.id,
            orderNumber: liveOrder.orderNumber,
            status: liveOrder.status,
            grandTotal: serialiseMoney(liveOrder.grandTotalMinor, liveOrder.currency),
          },
    /** Whether this buyer may turn it into an order now. */
    canConvert: row.status === 'APPROVED' && liveOrder === null && purchasing,
  };
}

async function linkedOrder(orderId: string | null): Promise<LinkedOrder | null> {
  if (orderId === null) return null;
  return prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      currency: true,
      grandTotalMinor: true,
      confirmedAt: true,
    },
  });
}

async function loadExisting(rfqId: string): Promise<PurchaseOrderRow | null> {
  return prisma.rfqPurchaseOrder.findUnique({ where: { rfqId }, include: { approvals: true } });
}

/** Read the immutable PO, or a non-persisted preview while the buyer reviews it. */
export async function reviewPurchaseOrder(buyer: RfqBuyer, rfqId: string) {
  await loadRfqForBuyer(buyer, rfqId);
  const existing = await loadExisting(rfqId);
  if (existing !== null)
    return {
      kind: 'PURCHASE_ORDER' as const,
      purchaseOrder: view(existing, buyer, await linkedOrder(existing.orderId)),
    };
  const built = await buildContract(buyer, rfqId, null);
  return {
    kind: 'PREVIEW' as const,
    preview: {
      acceptedTermsHash: built.snapshot.quote.acceptedTermsHash,
      contractHash: built.hash,
      contract: built.snapshot,
      amounts: {
        currency: built.amounts.currency,
        goods: serialiseMoney(built.amounts.goods, built.amounts.currency),
        tooling: serialiseMoney(built.amounts.tooling, built.amounts.currency),
        shipping: serialiseMoney(built.amounts.shipping, built.amounts.currency),
        grand: serialiseMoney(built.amounts.grand, built.amounts.currency),
      },
      actions: { canSubmit: true, canApprove: false, canReject: false },
    },
  };
}

export async function submitPurchaseOrder(
  buyer: RfqBuyer,
  rfqId: string,
  input: z.infer<typeof submitPurchaseOrderSchema>,
  actor: PurchaseOrderActor,
) {
  const existing = await loadExisting(rfqId);
  if (existing !== null) {
    if (existing.acceptedTermsHash !== input.acceptedTermsHash) {
      throw conflict(
        ErrorCode.RFQ_PURCHASE_ORDER_INVALID,
        'This purchase order was already raised from different terms.',
      );
    }
    return view(existing, buyer);
  }
  const rfq = await loadRfqForBuyer(buyer, rfqId);
  const buyerSku = input.buyerSku === null || input.buyerSku.length === 0 ? null : input.buyerSku;
  const built = await buildContract(buyer, rfqId, buyerSku);
  if (built.snapshot.quote.acceptedTermsHash !== input.acceptedTermsHash) {
    throw conflict(
      ErrorCode.RFQ_PURCHASE_ORDER_INVALID,
      'The accepted terms changed while this review was open. Reload them.',
      [{ code: 'STALE' }],
    );
  }

  const policy =
    rfq.buyerCompanyId === null
      ? null
      : await prisma.buyerCompanyApprovalPolicy.findUnique({
          where: { companyId: rfq.buyerCompanyId },
        });
  const policyEnabled = policy?.enabled === true;
  const currencyMismatch = policyEnabled && policy.currency !== built.amounts.currency;
  const needsFinance =
    policyEnabled &&
    policy !== null &&
    policy.financeThresholdMinor !== null &&
    (currencyMismatch || built.amounts.grand >= policy.financeThresholdMinor);
  const needsApprover =
    policyEnabled &&
    policy !== null &&
    (needsFinance || currencyMismatch || built.amounts.grand >= policy.approverThresholdMinor);
  const stages = [
    ...(needsApprover ? ['APPROVER' as const] : []),
    ...(needsFinance ? ['FINANCE' as const] : []),
  ];
  const now = new Date();
  const id = newId();
  const reference = `PO-${String(now.getUTCFullYear())}-${id.slice(-10).toUpperCase()}`;
  let row: PurchaseOrderRow;
  try {
    row = await prisma.$transaction(async (tx) => {
      await tx.rfqPurchaseOrder.create({
        data: {
          id,
          reference,
          rfqId: rfq.id,
          quoteId: built.snapshot.quote.id,
          customerProfileId: rfq.customerProfileId,
          buyerCompanyId: rfq.buyerCompanyId,
          sellerAccountId: built.snapshot.supplier.sellerAccountId,
          status: stages.length === 0 ? 'APPROVED' : 'PENDING_APPROVAL',
          acceptedTermsHash: input.acceptedTermsHash,
          contractHash: built.hash,
          contractJson: built.snapshot as unknown as Prisma.InputJsonValue,
          buyerSku,
          currency: built.amounts.currency,
          goodsTotalMinor: built.amounts.goods,
          toolingMinor: built.amounts.tooling,
          shippingMinor: built.amounts.shipping,
          grandTotalMinor: built.amounts.grand,
          requestedByUserId: buyer.userId,
          eAcceptedAt: now,
          signatureName: input.signatureName,
          signatureTitle: input.signatureTitle === '' ? null : input.signatureTitle,
          approvalPolicyJson:
            policy === null
              ? undefined
              : {
                  enabled: policy.enabled,
                  currency: policy.currency,
                  approverThresholdMinor: policy.approverThresholdMinor.toString(),
                  financeThresholdMinor: policy.financeThresholdMinor?.toString() ?? null,
                },
          approvedAt: stages.length === 0 ? now : null,
        },
      });
      if (stages.length > 0) {
        await tx.rfqPurchaseOrderApproval.createMany({
          data: stages.map((stage) => ({
            id: newId(),
            purchaseOrderId: id,
            stage,
            requestedByUserId: buyer.userId,
          })),
        });
      }
      await recordAudit(
        {
          action: AuditAction.RFQ_PURCHASE_ORDER_CREATED,
          resourceType: 'rfq_purchase_order',
          resourceId: id,
          actorType: 'CUSTOMER',
          actorUserId: actor.userId,
          actorEmail: actor.email,
          after: {
            reference,
            rfqId,
            contractHash: built.hash,
            acceptedTermsHash: input.acceptedTermsHash,
            status: stages.length === 0 ? 'APPROVED' : 'PENDING_APPROVAL',
            stages,
          },
          ipAddress: actor.ipAddress ?? null,
          correlationId: actor.correlationId ?? null,
        },
        tx,
      );
      return tx.rfqPurchaseOrder.findUniqueOrThrow({ where: { id }, include: { approvals: true } });
    });
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      (error as { code?: unknown }).code !== 'P2002'
    )
      throw error;
    const winner = await loadExisting(rfqId);
    if (winner === null) throw error;
    row = winner;
  }
  return view(row, buyer);
}

export async function decidePurchaseOrder(
  buyer: RfqBuyer,
  rfqId: string,
  input: z.infer<typeof purchaseOrderDecisionSchema>,
  actor: PurchaseOrderActor,
) {
  await loadRfqForBuyer(buyer, rfqId);
  if (buyer.context.kind !== 'COMPANY' || buyer.context.companyStatus !== 'APPROVED')
    throw notFound('Purchase order');
  const row = await loadExisting(rfqId);
  if (row === null) throw notFound('Purchase order');
  if (row.status !== 'PENDING_APPROVAL' || row.version !== input.expectedVersion) {
    throw conflict(
      ErrorCode.RFQ_PURCHASE_ORDER_APPROVAL_INVALID,
      'This approval changed while it was open. Reload it.',
      [{ code: 'STALE' }],
    );
  }
  const pending =
    row.approvals.find(
      (approval) => approval.stage === 'APPROVER' && approval.decision === 'PENDING',
    ) ??
    row.approvals.find(
      (approval) => approval.stage === 'FINANCE' && approval.decision === 'PENDING',
    );
  if (pending === undefined)
    throw conflict(
      ErrorCode.RFQ_PURCHASE_ORDER_APPROVAL_INVALID,
      'This purchase order has no pending approval.',
    );
  if (pending.requestedByUserId === buyer.userId) {
    throw conflict(
      ErrorCode.RFQ_PURCHASE_ORDER_APPROVAL_INVALID,
      'The person who raised this purchase order cannot approve it.',
      [{ code: 'MAKER_CHECKER' }],
    );
  }
  const capability = pending.stage === 'APPROVER' ? 'APPROVE_ORDERS' : 'FINANCE';
  if (!roleHasCapability(buyer.context.role, capability)) throw notFound('Purchase order approval');
  const priorApprover = row.approvals.find(
    (approval) => approval.stage === 'APPROVER',
  )?.decidedByUserId;
  if (pending.stage === 'FINANCE' && priorApprover === buyer.userId) {
    throw conflict(
      ErrorCode.RFQ_PURCHASE_ORDER_APPROVAL_INVALID,
      'Finance approval needs a different member from the order approver.',
      [{ code: 'MAKER_CHECKER' }],
    );
  }
  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const moved = await tx.rfqPurchaseOrderApproval.updateMany({
      where: { id: pending.id, decision: 'PENDING' },
      data: {
        decision: input.approved ? 'APPROVED' : 'REJECTED',
        decidedByUserId: buyer.userId,
        decidedAt: now,
        reason: input.reason,
      },
    });
    if (moved.count !== 1)
      throw conflict(
        ErrorCode.RFQ_PURCHASE_ORDER_APPROVAL_INVALID,
        'This approval changed while it was open.',
        [{ code: 'STALE' }],
      );
    const remaining = input.approved
      ? row.approvals.filter(
          (approval) => approval.id !== pending.id && approval.decision === 'PENDING',
        ).length
      : 0;
    const status = !input.approved ? 'REJECTED' : remaining === 0 ? 'APPROVED' : 'PENDING_APPROVAL';
    const poMoved = await tx.rfqPurchaseOrder.updateMany({
      where: { id: row.id, status: 'PENDING_APPROVAL', version: input.expectedVersion },
      data: {
        status,
        version: { increment: 1 },
        approvedAt: status === 'APPROVED' ? now : null,
        rejectedAt: status === 'REJECTED' ? now : null,
        rejectionReason: status === 'REJECTED' ? input.reason : null,
      },
    });
    if (poMoved.count !== 1)
      throw conflict(
        ErrorCode.RFQ_PURCHASE_ORDER_APPROVAL_INVALID,
        'This approval changed while it was open.',
        [{ code: 'STALE' }],
      );
    if (!input.approved) {
      await tx.rfqPurchaseOrderApproval.updateMany({
        where: { purchaseOrderId: row.id, decision: 'PENDING' },
        data: {
          decision: 'CANCELLED',
          decidedByUserId: buyer.userId,
          decidedAt: now,
          reason: 'Purchase order rejected at an earlier stage.',
        },
      });
    }
    await recordAudit(
      {
        action: input.approved
          ? AuditAction.RFQ_PURCHASE_ORDER_APPROVED
          : AuditAction.RFQ_PURCHASE_ORDER_REJECTED,
        resourceType: 'rfq_purchase_order',
        resourceId: row.id,
        actorType: 'CUSTOMER',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { status: row.status, stage: pending.stage, version: row.version },
        after: { status, stage: pending.stage, approved: input.approved, version: row.version + 1 },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
    return tx.rfqPurchaseOrder.findUniqueOrThrow({
      where: { id: row.id },
      include: { approvals: true },
    });
  });
  return view(updated, buyer);
}
