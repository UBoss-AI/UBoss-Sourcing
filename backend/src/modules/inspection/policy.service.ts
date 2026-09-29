/**
 * The operator's inspection rules engine: policy, rules, plans, supplier risk.
 *
 * Everything that decides WHEN an order is inspected, HOW it is sampled and
 * WHAT is checked lives here as data the operator edits (SCREEN-070,
 * JOURNEY-063). Nothing in the inspection module hard-codes a threshold, an
 * AQL, a window or a fee: this is a product other companies run, and each of
 * them has its own contracts.
 */
import { z } from 'zod';
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { SUPPORTED_AQL_VALUES, isInspectionLevel, normaliseAql } from '../../domain/inspection-aql.js';
import { DEFAULT_CHECKLIST, checklistSchema, type ChecklistItem } from '../../domain/inspection-state.js';
import { newId } from '../../infra/ids.js';
import type { PrismaTransaction } from '../../infra/prisma.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { POLICY_ID, readPolicy } from './context.js';
import type { OperatorActor } from './agency.service.js';

async function audit(actor: OperatorActor, resourceType: string, resourceId: string | null, after: unknown, tx?: PrismaTransaction): Promise<void> {
  await recordAudit(
    {
      action: AuditAction.INSPECTION_POLICY_CHANGED,
      resourceType,
      resourceId,
      actorType: 'ADMIN',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      after,
      correlationId: actor.correlationId ?? null,
    },
    tx,
  );
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export const policyUpdateSchema = z
  .object({
    majorNcrBlocksDispatch: z.boolean(),
    minorNcrBlocksDispatch: z.boolean(),
    buyerReportAccess: z.enum(['BEFORE_RELEASE', 'AFTER_RELEASE', 'NONE']),
    buyerNcrVisibility: z.enum(['ALL', 'MAJOR_AND_CRITICAL', 'NONE']),
    buyerReviewHours: z.number().int().min(0).max(720),
    buyerMayRequest: z.boolean(),
    supplierRiskLookbackDays: z.number().int().min(1).max(3650),
    supplierRiskFailThreshold: z.number().int().min(0).max(100),
    agencyAcceptSlaHours: z.number().int().min(1).max(720),
    reportSlaHours: z.number().int().min(1).max(2160),
    conditionalReleaseMinReasonLength: z.number().int().min(10).max(2000),
    requireInspectorCompetence: z.boolean(),
    requirePackingListForReadiness: z.boolean(),
  })
  .partial();

export async function updatePolicy(actor: OperatorActor, input: z.infer<typeof policyUpdateSchema>): Promise<void> {
  await readPolicy();
  await prisma.$transaction(async (tx) => {
    await tx.inspectionPolicy.update({ where: { id: POLICY_ID }, data: { ...input, updatedById: actor.userId } });
    await audit(actor, 'inspection_policy', null, input, tx);
  });
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

const aqlString = z
  .string()
  .trim()
  .refine((value) => normaliseAql(value) !== null, {
    message: `Use one of ${SUPPORTED_AQL_VALUES.join(', ')}.`,
  })
  .transform((value) => normaliseAql(value) ?? value);

export const planInputSchema = z.object({
  name: z.string().trim().min(2).max(160),
  categoryId: z.string().length(26).nullable(),
  isActive: z.boolean().default(true),
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date().nullable().default(null),
  inspectionLevel: z.string().refine(isInspectionLevel, { message: 'Use I, II or III.' }),
  aqlCritical: aqlString,
  aqlMajor: aqlString,
  aqlMinor: aqlString,
  checklist: checklistSchema,
  language: z.string().trim().min(2).max(8).default('en'),
});

export type PlanInput = z.infer<typeof planInputSchema>;

function assertDates(from: Date, to: Date | null): void {
  if (to !== null && to.getTime() <= from.getTime()) {
    throw badRequest(ErrorCode.INSPECTION_POLICY_INVALID, 'The end date must come after the start date.', [
      { field: 'effectiveTo', code: 'BEFORE_START' },
    ]);
  }
}

async function assertCategory(categoryId: string | null): Promise<void> {
  if (categoryId === null) return;
  const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } });
  if (category === null) {
    throw badRequest(ErrorCode.INSPECTION_POLICY_INVALID, 'That category does not exist.', [
      { field: 'categoryId', code: 'NOT_FOUND' },
    ]);
  }
}

export async function createPlan(actor: OperatorActor, input: PlanInput): Promise<{ id: string }> {
  assertDates(input.effectiveFrom, input.effectiveTo);
  await assertCategory(input.categoryId);
  const id = newId();

  await prisma.$transaction(async (tx) => {
    await tx.inspectionPlan.create({
      data: {
        id,
        name: input.name,
        categoryId: input.categoryId,
        isActive: input.isActive,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        inspectionLevel: input.inspectionLevel,
        aqlCritical: input.aqlCritical,
        aqlMajor: input.aqlMajor,
        aqlMinor: input.aqlMinor,
        checklistJson: input.checklist,
        language: input.language,
        createdById: actor.userId,
      },
    });
    await audit(actor, 'inspection_plan', id, input, tx);
  });

  return { id };
}

/**
 * Editing a plan makes a new version. Jobs already booked keep the copy they
 * were booked with, so nothing an inspector is working from changes under
 * them.
 */
export async function updatePlan(actor: OperatorActor, planId: string, input: PlanInput): Promise<void> {
  assertDates(input.effectiveFrom, input.effectiveTo);
  await assertCategory(input.categoryId);
  const existing = await prisma.inspectionPlan.findUnique({ where: { id: planId }, select: { version: true } });
  if (existing === null) throw notFound('Inspection plan');

  await prisma.$transaction(async (tx) => {
    await tx.inspectionPlan.update({
      where: { id: planId },
      data: {
        name: input.name,
        categoryId: input.categoryId,
        isActive: input.isActive,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        inspectionLevel: input.inspectionLevel,
        aqlCritical: input.aqlCritical,
        aqlMajor: input.aqlMajor,
        aqlMinor: input.aqlMinor,
        checklistJson: input.checklist,
        language: input.language,
        version: existing.version + 1,
      },
    });
    await audit(actor, 'inspection_plan', planId, { ...input, version: existing.version + 1 }, tx);
  });
}

export async function listPlans() {
  const rows = await prisma.inspectionPlan.findMany({ orderBy: [{ categoryId: 'asc' }, { name: 'asc' }] });
  return rows.map((row) => ({ ...row, checklist: row.checklistJson as ChecklistItem[] }));
}

export interface PlanSnapshot {
  planId: string | null;
  name: string;
  version: number;
  inspectionLevel: 'I' | 'II' | 'III';
  aqlCritical: string;
  aqlMajor: string;
  aqlMinor: string;
  checklist: ChecklistItem[];
  language: string;
}

/**
 * The plan a job is booked on: the rule's own plan if it named one, else the
 * most specific active plan for the order's categories, else the default plan
 * (no category), else the platform's starting checklist at level II with
 * AQL 0 / 2.5 / 4.0 - which an operator is expected to replace.
 */
export async function choosePlan(
  client: PrismaTransaction | typeof prisma,
  input: { planId: string | null; categoryIds: string[]; now: Date },
): Promise<PlanSnapshot> {
  const effective = {
    isActive: true,
    effectiveFrom: { lte: input.now },
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: input.now } }],
  };

  let plan =
    input.planId === null
      ? null
      : await client.inspectionPlan.findFirst({ where: { id: input.planId, ...effective } });

  if (plan === null && input.categoryIds.length > 0) {
    const candidates = await client.inspectionPlan.findMany({
      where: { categoryId: { in: input.categoryIds }, ...effective },
      orderBy: { updatedAt: 'desc' },
    });
    // The deepest category wins: a plan for "Gloves" beats one for "Consumables".
    const depthOf = new Map(input.categoryIds.map((id, index) => [id, index]));
    const categories = await client.category.findMany({
      where: { id: { in: candidates.map((candidate) => candidate.categoryId ?? '') } },
      select: { id: true, depth: true },
    });
    const depth = new Map(categories.map((category) => [category.id, category.depth]));
    candidates.sort(
      (a, b) =>
        (depth.get(b.categoryId ?? '') ?? 0) - (depth.get(a.categoryId ?? '') ?? 0) ||
        (depthOf.get(a.categoryId ?? '') ?? 0) - (depthOf.get(b.categoryId ?? '') ?? 0),
    );
    plan = candidates[0] ?? null;
  }

  if (plan === null) {
    plan = await client.inspectionPlan.findFirst({ where: { categoryId: null, ...effective }, orderBy: { updatedAt: 'desc' } });
  }

  if (plan === null) {
    return {
      planId: null,
      name: 'Platform starting plan',
      version: 1,
      inspectionLevel: 'II',
      aqlCritical: '0',
      aqlMajor: '2.5',
      aqlMinor: '4.0',
      checklist: [...DEFAULT_CHECKLIST],
      language: 'en',
    };
  }

  return {
    planId: plan.id,
    name: plan.name,
    version: plan.version,
    inspectionLevel: isInspectionLevel(plan.inspectionLevel) ? plan.inspectionLevel : 'II',
    aqlCritical: plan.aqlCritical,
    aqlMajor: plan.aqlMajor,
    aqlMinor: plan.aqlMinor,
    checklist: plan.checklistJson as ChecklistItem[],
    language: plan.language,
  };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export const ruleInputSchema = z
  .object({
    name: z.string().trim().min(2).max(160),
    isActive: z.boolean().default(true),
    priority: z.number().int().min(0).max(100_000).default(100),
    level: z.enum(['MANDATORY', 'RISK_TRIGGERED']),
    categoryId: z.string().length(26).nullable().default(null),
    minOrderValueMinor: z
      .string()
      .regex(/^\d{1,18}$/)
      .nullable()
      .default(null),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable()
      .default(null),
    destinationCountries: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .max(250)
      .nullable()
      .default(null),
    supplierRiskAtLeast: z.enum(['LOW', 'MEDIUM', 'HIGH']).nullable().default(null),
    planId: z.string().length(26).nullable().default(null),
    preferredAgencyId: z.string().length(26).nullable().default(null),
    allowConditionalRelease: z.boolean().default(true),
    effectiveFrom: z.coerce.date(),
    effectiveTo: z.coerce.date().nullable().default(null),
  })
  .superRefine((value, context) => {
    if (value.minOrderValueMinor !== null && value.currency === null) {
      context.addIssue({ code: 'custom', path: ['currency'], message: 'A value threshold needs its currency.' });
    }
  });

export type RuleInput = z.infer<typeof ruleInputSchema>;

async function validateRuleRefs(input: RuleInput): Promise<void> {
  assertDates(input.effectiveFrom, input.effectiveTo);
  await assertCategory(input.categoryId);
  if (input.planId !== null) {
    const plan = await prisma.inspectionPlan.findUnique({ where: { id: input.planId }, select: { id: true } });
    if (plan === null) {
      throw badRequest(ErrorCode.INSPECTION_POLICY_INVALID, 'That plan does not exist.', [
        { field: 'planId', code: 'NOT_FOUND' },
      ]);
    }
  }
  if (input.preferredAgencyId !== null) {
    const agency = await prisma.inspectionAgency.findUnique({ where: { id: input.preferredAgencyId }, select: { id: true } });
    if (agency === null) {
      throw badRequest(ErrorCode.INSPECTION_POLICY_INVALID, 'That agency does not exist.', [
        { field: 'preferredAgencyId', code: 'NOT_FOUND' },
      ]);
    }
  }
}

function ruleData(input: RuleInput) {
  return {
    name: input.name,
    isActive: input.isActive,
    priority: input.priority,
    level: input.level,
    categoryId: input.categoryId,
    minOrderValueMinor: input.minOrderValueMinor === null ? null : BigInt(input.minOrderValueMinor),
    currency: input.currency,
    destinationCountriesJson: input.destinationCountries ?? undefined,
    supplierRiskAtLeast: input.supplierRiskAtLeast,
    planId: input.planId,
    preferredAgencyId: input.preferredAgencyId,
    allowConditionalRelease: input.allowConditionalRelease,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
  };
}

/**
 * A new rule applies to orders decided from now on. Orders already decided
 * keep the answer they were given, with the rule that gave it - the
 * operator re-evaluates one on purpose if they mean it to change.
 */
export async function createRule(actor: OperatorActor, input: RuleInput): Promise<{ id: string }> {
  await validateRuleRefs(input);
  const id = newId();
  await prisma.$transaction(async (tx) => {
    await tx.inspectionRule.create({ data: { id, ...ruleData(input), createdById: actor.userId } as never });
    await audit(actor, 'inspection_rule', id, input, tx);
  });
  return { id };
}

export async function updateRule(actor: OperatorActor, ruleId: string, input: RuleInput): Promise<void> {
  const existing = await prisma.inspectionRule.findUnique({ where: { id: ruleId }, select: { id: true } });
  if (existing === null) throw notFound('Inspection rule');
  await validateRuleRefs(input);
  await prisma.$transaction(async (tx) => {
    await tx.inspectionRule.update({ where: { id: ruleId }, data: { ...ruleData(input), updatedById: actor.userId } as never });
    await audit(actor, 'inspection_rule', ruleId, input, tx);
  });
}

export async function listRules() {
  const rows = await prisma.inspectionRule.findMany({ orderBy: [{ isActive: 'desc' }, { level: 'asc' }, { priority: 'asc' }] });
  return rows.map((row) => ({
    ...row,
    minOrderValueMinor: row.minOrderValueMinor?.toString() ?? null,
    destinationCountries: (row.destinationCountriesJson as string[] | null) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Supplier risk
// ---------------------------------------------------------------------------

export async function setSupplierRisk(
  actor: OperatorActor,
  sellerAccountId: string,
  input: { tier: 'LOW' | 'MEDIUM' | 'HIGH'; reason: string },
): Promise<void> {
  const seller = await prisma.sellerAccount.findUnique({ where: { id: sellerAccountId }, select: { id: true } });
  if (seller === null) throw notFound('Seller');

  await prisma.$transaction(async (tx) => {
    await tx.inspectionSupplierRisk.upsert({
      where: { sellerAccountId },
      create: { sellerAccountId, tier: input.tier, reason: input.reason.trim(), setById: actor.userId },
      update: { tier: input.tier, reason: input.reason.trim(), setById: actor.userId, setAt: new Date() },
    });
    await audit(actor, 'inspection_supplier_risk', sellerAccountId, input, tx);
  });
}

export async function listSupplierRisks() {
  const rows = await prisma.inspectionSupplierRisk.findMany({ orderBy: { setAt: 'desc' } });
  const sellers = await prisma.sellerAccount.findMany({
    where: { id: { in: rows.map((row) => row.sellerAccountId) } },
    select: { id: true, displayName: true },
  });
  const names = new Map(sellers.map((seller) => [seller.id, seller.displayName]));
  return rows.map((row) => ({ ...row, sellerName: names.get(row.sellerAccountId) ?? null }));
}
