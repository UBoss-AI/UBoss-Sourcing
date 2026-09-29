/**
 * Changing whether an order needs inspecting, after it was first decided, and
 * the agency's invoices.
 *
 * Two ways a decision moves, and both only ever RAISE it:
 *   - the buyer asks for an inspection (policy permitting) - NOT_REQUIRED
 *     becomes BUYER_REQUESTED;
 *   - the operator re-runs the rules - a rule added since can make an order
 *     MANDATORY or RISK_TRIGGERED.
 * Neither can lower a requirement. Waiving an inspection that a rule demanded
 * is a conditional release, which takes two people and a reason.
 *
 * Invoices (INSPECT-007) live here too, deliberately far from the report: no
 * function in this file reads or writes a report, a defect, a release or the
 * gate, so paying an agency - or disputing its bill - cannot change a result.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { decideRequirement } from '../../domain/inspection-rules.js';
import { InspectionAgencyPermission } from '../../domain/inspection-permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { agencyActor, assertInspectionPermission, type InspectionMembership, type OperatorActor } from './agency.service.js';
import { readPolicy, recordInspectionEvent, type InspectionActor } from './context.js';
import { ensureRequirement, orderFactsFor, refreshRequirementStatus, supplierRiskOf } from './gate.service.js';

const LEVEL_RANK: Record<string, number> = { NOT_REQUIRED: 0, BUYER_REQUESTED: 1, RISK_TRIGGERED: 2, MANDATORY: 3 };

/** The buyer asks for an inspection of one seller's part of their order. */
export async function requestInspectionAsBuyer(
  actor: InspectionActor & { customerProfileId: string },
  input: { orderId: string; sellerOrderGroupId: string; note?: string | null },
): Promise<void> {
  const policy = await readPolicy();
  if (!policy.buyerMayRequest) {
    throw conflict(ErrorCode.INSPECTION_BOOKING_NOT_ALLOWED, 'This marketplace does not take inspection requests from buyers.', [
      { code: 'BUYER_REQUESTS_OFF' },
    ]);
  }

  await prisma.$transaction(async (tx) => {
    const group = await tx.sellerOrderGroup.findFirst({
      where: { id: input.sellerOrderGroupId, orderId: input.orderId, order: { customerProfileId: actor.customerProfileId } },
      select: { id: true, status: true },
    });
    if (group === null) throw notFound('Order');

    if (!['NEW', 'ACCEPTED', 'PROCESSING'].includes(group.status)) {
      throw conflict(ErrorCode.INSPECTION_BOOKING_NOT_ALLOWED, 'This part of the order is already on its way; it can no longer be inspected.', [
        { code: 'PAST_DISPATCH', meta: { status: group.status } },
      ]);
    }

    const requirement = await ensureRequirement(tx, group.id, actor);
    if (requirement === null) throw notFound('Order');

    const current = await tx.inspectionRequirement.findUniqueOrThrow({ where: { id: requirement.id } });
    if (current.buyerRequested) {
      throw conflict(ErrorCode.CONFLICT, 'You have already asked for an inspection of this order.', [{ code: 'ALREADY_REQUESTED' }]);
    }

    const becomes = current.level === 'NOT_REQUIRED' ? 'BUYER_REQUESTED' : current.level;
    await tx.inspectionRequirement.update({
      where: { id: current.id },
      data: {
        buyerRequested: true,
        buyerRequestedAt: new Date(),
        buyerRequestNote: input.note?.trim().slice(0, 1024) || null,
        level: becomes,
        ...(current.level === 'NOT_REQUIRED' ? { reason: 'No rule requires it; the buyer asked for an inspection.' } : {}),
        version: { increment: 1 },
      },
    });

    await recordInspectionEvent(tx, {
      requirementId: current.id,
      orderId: input.orderId,
      kind: 'buyer_requested',
      actor,
      summary: current.level === 'NOT_REQUIRED'
        ? 'The buyer asked for a pre-shipment inspection. The goods now need one before they leave.'
        : 'The buyer asked for a pre-shipment inspection; one was already required.',
      data: { from: current.level, to: becomes, note: input.note ?? null },
      audit: AuditAction.INSPECTION_REQUIREMENT_DECIDED,
    });

    await refreshRequirementStatus(tx, current.id);
  });
}

/** The operator re-runs the rules on one seller order. Raises, never lowers. */
export async function reevaluateRequirement(actor: InspectionActor, requirementId: string): Promise<{ level: string; changed: boolean }> {
  return prisma.$transaction(async (tx) => {
    const requirement = await tx.inspectionRequirement.findUnique({ where: { id: requirementId } });
    if (requirement === null) throw notFound('Inspection');
    if (requirement.loadReleasedAt !== null) {
      throw conflict(ErrorCode.INSPECTION_BOOKING_NOT_ALLOWED, 'These goods have already left.', [{ code: 'ALREADY_DISPATCHED' }]);
    }

    const policy = await readPolicy(tx);
    const facts = await orderFactsFor(tx, requirement.sellerOrderGroupId);
    const risk = await supplierRiskOf(tx, requirement.sellerAccountId, policy);
    const rules = await tx.inspectionRule.findMany({ where: { isActive: true } });

    const decision = decideRequirement(
      rules.map((row) => ({
        ...row,
        level: row.level === 'MANDATORY' ? ('MANDATORY' as const) : ('RISK_TRIGGERED' as const),
        destinationCountries: Array.isArray(row.destinationCountriesJson) ? (row.destinationCountriesJson as string[]) : null,
      })),
      {
        categoryIds: facts.categoryIds,
        valueMinor: facts.group.goodsTotalMinor,
        currency: facts.group.currency,
        destinationCountry: facts.destinationCountry,
        supplierRisk: risk.tier,
        buyerRequested: requirement.buyerRequested,
        now: new Date(),
      },
    );

    if ((LEVEL_RANK[decision.level] ?? 0) <= (LEVEL_RANK[requirement.level] ?? 0)) {
      return { level: requirement.level, changed: false };
    }

    await tx.inspectionRequirement.update({
      where: { id: requirementId },
      data: {
        level: decision.level,
        ruleId: decision.ruleId,
        ruleName: decision.ruleName,
        reason: decision.reason,
        planId: decision.planId,
        preferredAgencyId: decision.preferredAgencyId ?? requirement.preferredAgencyId,
        allowConditionalRelease: decision.allowConditionalRelease,
        evaluatedAt: new Date(),
        version: { increment: 1 },
      },
    });

    await recordInspectionEvent(tx, {
      requirementId,
      orderId: requirement.orderId,
      kind: 'requirement_decided',
      actor,
      summary: `Re-evaluated: ${decision.reason}`,
      data: { from: requirement.level, to: decision.level, ruleId: decision.ruleId },
      audit: AuditAction.INSPECTION_REQUIREMENT_DECIDED,
    });

    await refreshRequirementStatus(tx, requirementId);
    return { level: decision.level, changed: true };
  });
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export async function submitInvoice(
  membership: InspectionMembership,
  jobId: string,
  input: { invoiceNumber: string; amountMinor: bigint; currency: string; note?: string | null },
  correlationId?: string | null,
): Promise<{ invoiceId: string }> {
  assertInspectionPermission(membership, InspectionAgencyPermission.INVOICE_WRITE);
  if (input.amountMinor <= 0n) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The amount must be more than zero.', [{ field: 'amountMinor', code: 'NOT_POSITIVE' }]);
  }

  return prisma.$transaction(async (tx) => {
    const job = await tx.inspectionJob.findFirst({
      where: { id: jobId, agencyId: membership.agencyId },
      select: { id: true, status: true, payer: true, jobNumber: true, requirementId: true, requirement: { select: { orderId: true } } },
    });
    if (job === null) throw notFound('Inspection');
    if (!['IN_PROGRESS', 'REPORT_SUBMITTED', 'COMPLETED'].includes(job.status)) {
      throw conflict(ErrorCode.INSPECTION_JOB_TRANSITION_NOT_ALLOWED, 'An invoice can be sent once the inspection has started.', [
        { code: 'NOT_STARTED' },
      ]);
    }

    const id = newId();
    try {
      await tx.inspectionAgencyInvoice.create({
        data: {
          id,
          jobId: job.id,
          agencyId: membership.agencyId,
          invoiceNumber: input.invoiceNumber.trim().slice(0, 64),
          amountMinor: input.amountMinor,
          currency: input.currency.toUpperCase(),
          payer: job.payer,
          submittedByMemberId: membership.memberId,
          note: input.note?.trim().slice(0, 1024) || null,
        },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw conflict(ErrorCode.CONFLICT, 'That invoice number has already been sent.', [{ field: 'invoiceNumber', code: 'DUPLICATE' }]);
      }
      throw error;
    }

    await recordInspectionEvent(tx, {
      requirementId: job.requirementId,
      orderId: job.requirement.orderId,
      jobId: job.id,
      kind: 'invoice_submitted',
      actor: agencyActor(membership, correlationId),
      summary: `Invoice ${input.invoiceNumber.trim()} submitted for ${job.jobNumber}.`,
      data: { invoiceId: id, amountMinor: input.amountMinor.toString(), currency: input.currency.toUpperCase() },
      visibleToBuyer: false,
      visibleToSeller: false,
    });

    return { invoiceId: id };
  });
}

/** The operator moves an invoice along. Touches nothing but the invoice. */
export async function decideInvoice(
  actor: OperatorActor,
  invoiceId: string,
  input: { status: 'APPROVED' | 'PAID' | 'DISPUTED' | 'VOID'; note?: string | null },
): Promise<void> {
  const invoice = await prisma.inspectionAgencyInvoice.findUnique({ where: { id: invoiceId } });
  if (invoice === null) throw notFound('Invoice');

  const allowed: Record<string, string[]> = {
    SUBMITTED: ['APPROVED', 'DISPUTED', 'VOID'],
    APPROVED: ['PAID', 'DISPUTED', 'VOID'],
    DISPUTED: ['APPROVED', 'VOID'],
    PAID: [],
    VOID: [],
  };
  if (!(allowed[invoice.status] ?? []).includes(input.status)) {
    throw conflict(ErrorCode.CONFLICT, `An invoice cannot move from ${invoice.status} to ${input.status}.`, [
      { code: 'TRANSITION_UNDEFINED', meta: { from: invoice.status, to: input.status } },
    ]);
  }

  await prisma.$transaction(async (tx) => {
    await tx.inspectionAgencyInvoice.update({
      where: { id: invoiceId },
      data: {
        status: input.status,
        decidedAt: new Date(),
        decidedById: actor.userId,
        ...(input.status === 'PAID' ? { paidAt: new Date() } : {}),
        ...(input.note === undefined ? {} : { note: input.note?.trim().slice(0, 1024) || null }),
      },
    });
    await recordAudit(
      {
        action: AuditAction.INSPECTION_INVOICE_CHANGED,
        resourceType: 'inspection_invoice',
        resourceId: invoiceId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { status: invoice.status },
        after: { status: input.status, note: input.note ?? null },
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}
