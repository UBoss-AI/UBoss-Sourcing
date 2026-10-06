/**
 * The compliance requirement matrix: versioned rules, drafted, submitted and
 * approved by two different people.
 *
 *   DRAFT ──submit──▶ IN_REVIEW ──approve──▶ APPROVED ──(newer version approved)──▶ RETIRED
 *     ▲                   │ reject                │ retire
 *     └──── revise ◀──────┴── REJECTED            ▼
 *                                              RETIRED
 *
 * - A change to an approved rule is a NEW version (`revise`), drafted and
 *   approved like the first. Approving it retires the previous version in the
 *   same transaction, so exactly one version of a code is ever in force.
 * - Only a SUPERVISOR approves, and never a version they drafted.
 * - Researched rules are loaded as DRAFTS from the dated research file. They
 *   decide nothing until a supervisor approves them; the console shows every
 *   category's coverage, including how many drafts are still waiting.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import type { PrismaTransaction } from '../../infra/prisma.js';
import { prisma } from '../../infra/prisma.js';
import { withWriteConflictRetry } from '../../infra/write-conflict.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { notifyAuditUsers, staffUserIds } from '../audit-console/notification.service.js';
import { recordComplianceEvent, type ComplianceActor } from './events.js';

const SUPPLY_ROLES = ['MANUFACTURER', 'IMPORTER', 'DISTRIBUTOR', 'AUTHORISED_REPRESENTATIVE'] as const;
const RISK_CLASSES = ['CLASS_I', 'I_STERILE', 'I_MEASURING', 'I_REUSABLE_SURGICAL', 'IIA', 'IIB', 'III'] as const;
const market = z.string().trim().regex(/^(?:[A-Z]{2}|EU)$/);

export const requirementInput = z.strictObject({
  code: z.string().trim().regex(/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/).max(64),
  name: z.string().trim().min(3).max(255),
  description: z.string().trim().min(10).max(8000),
  requiredEvidence: z.string().trim().min(5).max(4000),
  obligation: z.enum(['LEGAL', 'CONTRACTUAL', 'OPTIONAL_QUALIFICATION']),
  level: z.enum(['SELLER_CATEGORY', 'PRODUCT']),
  categoryIds: z.array(z.string().length(26)).min(1).max(200),
  includeDescendants: z.boolean().default(true),
  supplyRoles: z.array(z.enum(SUPPLY_ROLES)).max(4).default([]),
  originCountries: z.array(z.string().trim().regex(/^[A-Z]{2}$/)).max(60).default([]),
  destinationMarkets: z.array(market).max(60).default([]),
  riskClasses: z.array(z.enum(RISK_CLASSES)).max(7).default([]),
  productTypeNote: z.string().trim().max(1024).nullable().optional(),
  intendedUseNote: z.string().trim().max(1024).nullable().optional(),
  applicability: z.enum(['APPLIES', 'CONDITIONAL', 'UNRESOLVED']),
  applicabilityNote: z.string().trim().max(8000).nullable().optional(),
  expiryKind: z.enum(['DOCUMENT_EXPIRY', 'NO_EXPIRY', 'PERIODIC_REVIEW']),
  reviewMonths: z.number().int().min(1).max(240).nullable().optional(),
  sourceUrl: z.string().trim().url().max(1024).refine((url) => url.startsWith('https://'), 'An https address'),
  sourceTitle: z.string().trim().min(3).max(512),
  sourcePublisher: z.string().trim().min(2).max(255),
  lastReviewedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']).nullable().optional(),
  effectiveFrom: z.coerce.date().nullable().optional(),
});
export type RequirementInput = z.infer<typeof requirementInput>;

function refuse(code: string, message: string): never {
  throw conflict(ErrorCode.COMPLIANCE_RULE_TRANSITION_NOT_ALLOWED, message, [{ code }]);
}

function assertConsistent(input: Pick<RequirementInput, 'expiryKind' | 'reviewMonths'>): void {
  if (input.expiryKind === 'PERIODIC_REVIEW' && (input.reviewMonths ?? null) === null) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say how often, in months, a periodic review is due.', [
      { field: 'reviewMonths', code: 'REQUIRED' },
    ]);
  }
}

async function assertCategories(ids: readonly string[]): Promise<void> {
  const found = await prisma.category.count({ where: { id: { in: [...ids] }, archivedAt: null } });
  if (found !== new Set(ids).size) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'One of those categories does not exist.', [{ field: 'categoryIds', code: 'UNKNOWN' }]);
  }
}

function dataOf(input: RequirementInput) {
  return {
    name: input.name,
    description: input.description,
    requiredEvidence: input.requiredEvidence,
    obligation: input.obligation,
    level: input.level,
    categoryIdsJson: [...new Set(input.categoryIds)],
    includeDescendants: input.includeDescendants,
    supplyRolesJson: input.supplyRoles,
    originCountriesJson: input.originCountries,
    destinationMarketsJson: input.destinationMarkets,
    riskClassesJson: input.riskClasses,
    productTypeNote: input.productTypeNote ?? null,
    intendedUseNote: input.intendedUseNote ?? null,
    applicability: input.applicability,
    applicabilityNote: input.applicabilityNote ?? null,
    expiryKind: input.expiryKind,
    reviewMonths: input.expiryKind === 'PERIODIC_REVIEW' ? input.reviewMonths ?? null : null,
    sourceUrl: input.sourceUrl,
    sourceTitle: input.sourceTitle,
    sourcePublisher: input.sourcePublisher,
    lastReviewedOn: new Date(`${input.lastReviewedOn}T00:00:00.000Z`),
    confidence: input.confidence ?? null,
    effectiveFrom: input.effectiveFrom ?? null,
  };
}

async function audit(tx: PrismaTransaction, action: (typeof AuditAction)[keyof typeof AuditAction], actor: ComplianceActor, id: string, after: Record<string, unknown>) {
  await recordAudit(
    {
      action,
      resourceType: 'compliance_requirement',
      resourceId: id,
      actorType: actor.type === 'ADMIN' ? 'ADMIN' : actor.type === 'AUDIT' ? 'AUDIT' : 'SYSTEM',
      actorUserId: actor.userId,
      after,
      correlationId: actor.correlationId ?? null,
    },
    tx,
  );
}

export async function draftRequirement(actor: ComplianceActor, input: RequirementInput): Promise<{ id: string }> {
  assertConsistent(input);
  await assertCategories(input.categoryIds);
  const existing = await prisma.complianceRequirement.findFirst({ where: { code: input.code }, select: { id: true } });
  if (existing !== null) {
    throw conflict(ErrorCode.CONFLICT, 'A rule with that code exists. Draft a new version of it instead.', [{ field: 'code', code: 'CODE_TAKEN' }]);
  }
  const id = newId();
  await prisma.$transaction(async (tx) => {
    await tx.complianceRequirement.create({
      data: { id, code: input.code, ruleVersion: 1, status: 'DRAFT', ...dataOf(input), draftedByUserId: actor.userId, draftedByLabel: actor.label },
    });
    await recordComplianceEvent(tx, { subjectType: 'REQUIREMENT', subjectId: id, kind: 'drafted', actor, summary: `Rule ${input.code} v1 drafted.` });
    await audit(tx, AuditAction.COMPLIANCE_RULE_DRAFTED, actor, id, { code: input.code, ruleVersion: 1 });
  });
  return { id };
}

/** Change a DRAFT or REJECTED version in place. Anything else is revised instead. */
export async function updateDraft(actor: ComplianceActor, id: string, input: RequirementInput, expectedLockVersion: number): Promise<void> {
  assertConsistent(input);
  await assertCategories(input.categoryIds);
  await prisma.$transaction(async (tx) => {
    const row = await tx.complianceRequirement.findUnique({ where: { id } });
    if (row === null) throw notFound('Compliance rule');
    if (row.status !== 'DRAFT' && row.status !== 'REJECTED') refuse('NOT_A_DRAFT', 'Only a draft can be changed. Draft a new version instead.');
    if (input.code !== row.code) refuse('CODE_FIXED', 'A rule keeps its code across versions.');
    const moved = await tx.complianceRequirement.updateMany({
      where: { id, lockVersion: expectedLockVersion },
      data: { ...dataOf(input), status: 'DRAFT', decisionNote: null, lockVersion: { increment: 1 } },
    });
    if (moved.count !== 1) refuse('STALE', 'This rule changed while you were editing it. Reload it.');
    await recordComplianceEvent(tx, { subjectType: 'REQUIREMENT', subjectId: id, kind: 'edited', actor, summary: `Draft of ${row.code} v${String(row.ruleVersion)} edited.` });
  });
}

/** A new DRAFT version of an approved (or retired) rule, copied from it. */
export async function reviseRequirement(actor: ComplianceActor, id: string): Promise<{ id: string; ruleVersion: number }> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.complianceRequirement.findUnique({ where: { id } });
    if (row === null) throw notFound('Compliance rule');
    const open = await tx.complianceRequirement.findFirst({
      where: { code: row.code, status: { in: ['DRAFT', 'IN_REVIEW'] } },
      select: { ruleVersion: true },
    });
    if (open !== null) refuse('DRAFT_OPEN', `Version ${String(open.ruleVersion)} of ${row.code} is already being drafted.`);
    const latest = await tx.complianceRequirement.findFirst({ where: { code: row.code }, orderBy: { ruleVersion: 'desc' }, select: { ruleVersion: true } });
    const ruleVersion = (latest?.ruleVersion ?? row.ruleVersion) + 1;
    const newIdValue = newId();
    const { id: _id, createdAt: _c, updatedAt: _u, lockVersion: _l, ...copy } = row;
    await tx.complianceRequirement.create({
      data: {
        ...copy,
        id: newIdValue,
        ruleVersion,
        status: 'DRAFT',
        categoryIdsJson: row.categoryIdsJson as never,
        supplyRolesJson: row.supplyRolesJson as never,
        originCountriesJson: row.originCountriesJson as never,
        destinationMarketsJson: row.destinationMarketsJson as never,
        riskClassesJson: row.riskClassesJson as never,
        draftedByUserId: actor.userId,
        draftedByLabel: actor.label,
        submittedAt: null,
        decidedByUserId: null,
        decidedByLabel: null,
        decidedAt: null,
        decisionNote: null,
        retiredAt: null,
        effectiveTo: null,
        supersedesId: row.id,
      },
    });
    await recordComplianceEvent(tx, { subjectType: 'REQUIREMENT', subjectId: newIdValue, kind: 'revised', actor, summary: `${row.code} v${String(ruleVersion)} drafted from v${String(row.ruleVersion)}.` });
    await audit(tx, AuditAction.COMPLIANCE_RULE_DRAFTED, actor, newIdValue, { code: row.code, ruleVersion, from: row.ruleVersion });
    return { id: newIdValue, ruleVersion };
  });
}

export async function submitRequirement(actor: ComplianceActor, id: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const row = await tx.complianceRequirement.findUnique({ where: { id } });
    if (row === null) throw notFound('Compliance rule');
    if (row.status !== 'DRAFT') refuse('NOT_A_DRAFT', 'Only a draft can be submitted for approval.');
    await tx.complianceRequirement.update({ where: { id }, data: { status: 'IN_REVIEW', submittedAt: new Date(), lockVersion: { increment: 1 } } });
    await recordComplianceEvent(tx, { subjectType: 'REQUIREMENT', subjectId: id, kind: 'submitted', actor, summary: `${row.code} v${String(row.ruleVersion)} submitted for approval.` });
    await audit(tx, AuditAction.COMPLIANCE_RULE_SUBMITTED, actor, id, { code: row.code });
    const supervisors = (await staffUserIds(tx, ['SUPERVISOR'])).filter((userId) => userId !== row.draftedByUserId);
    await notifyAuditUsers(tx, supervisors, {
      kind: 'RULE_SUBMITTED',
      title: `Rule ${row.code} v${String(row.ruleVersion)} is waiting for approval`,
      link: `/rules?rule=${id}`,
      subjectType: 'compliance_requirement',
      subjectId: id,
      dedupeKey: `rule-submitted:${id}`,
    });
  });
}

/**
 * Approve or reject a submitted rule. Maker-checker: the person who drafted
 * this version cannot decide it. Approving retires the version in force.
 */
export async function decideRequirement(
  actor: ComplianceActor,
  id: string,
  input: { decision: 'APPROVE' | 'REJECT'; note: string },
): Promise<void> {
  if (input.note.trim().length < 10) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Record what you checked, in at least ten characters.', [{ field: 'note', code: 'REQUIRED' }]);
  }
  await withWriteConflictRetry(() => prisma.$transaction(async (tx) => {
    const row = await tx.complianceRequirement.findUnique({ where: { id } });
    if (row === null) throw notFound('Compliance rule');
    if (row.status !== 'IN_REVIEW') refuse('NOT_IN_REVIEW', 'Only a submitted rule can be approved or rejected.');
    if (row.draftedByUserId !== null && row.draftedByUserId === actor.userId) {
      refuse('SAME_PERSON', 'You drafted this version, so somebody else must decide it.');
    }
    const now = new Date();
    if (input.decision === 'APPROVE') {
      await tx.complianceRequirement.updateMany({
        where: { code: row.code, status: 'APPROVED', id: { not: id } },
        data: { status: 'RETIRED', retiredAt: now, effectiveTo: now, lockVersion: { increment: 1 } },
      });
    }
    const moved = await tx.complianceRequirement.updateMany({
      where: { id, status: 'IN_REVIEW', lockVersion: row.lockVersion },
      data: {
        status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        decidedByUserId: actor.userId,
        decidedByLabel: actor.label,
        decidedAt: now,
        decisionNote: input.note.trim(),
        effectiveFrom: input.decision === 'APPROVE' ? row.effectiveFrom ?? now : row.effectiveFrom,
        lockVersion: { increment: 1 },
      },
    });
    if (moved.count !== 1) refuse('STALE', 'Somebody else decided this rule a moment ago.');
    await recordComplianceEvent(tx, {
      subjectType: 'REQUIREMENT',
      subjectId: id,
      kind: input.decision === 'APPROVE' ? 'approved' : 'rejected',
      actor,
      summary: `${row.code} v${String(row.ruleVersion)} ${input.decision === 'APPROVE' ? 'approved' : 'rejected'}: ${input.note.trim()}`,
    });
    await audit(tx, AuditAction.COMPLIANCE_RULE_DECIDED, actor, id, { code: row.code, ruleVersion: row.ruleVersion, decision: input.decision });
  }));
}

export async function retireRequirement(actor: ComplianceActor, id: string, reason: string): Promise<void> {
  if (reason.trim().length < 10) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say why the rule is withdrawn.', [{ field: 'reason', code: 'REQUIRED' }]);
  }
  await prisma.$transaction(async (tx) => {
    const row = await tx.complianceRequirement.findUnique({ where: { id } });
    if (row === null) throw notFound('Compliance rule');
    if (row.status !== 'APPROVED' && row.status !== 'DRAFT' && row.status !== 'REJECTED') refuse('NOT_RETIRABLE', 'This rule cannot be withdrawn now.');
    const now = new Date();
    await tx.complianceRequirement.update({ where: { id }, data: { status: 'RETIRED', retiredAt: now, effectiveTo: now, decisionNote: reason.trim(), lockVersion: { increment: 1 } } });
    await recordComplianceEvent(tx, { subjectType: 'REQUIREMENT', subjectId: id, kind: 'retired', actor, summary: `${row.code} v${String(row.ruleVersion)} withdrawn: ${reason.trim()}` });
    await audit(tx, AuditAction.COMPLIANCE_RULE_RETIRED, actor, id, { code: row.code, reason: reason.trim() });
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export type RequirementRow = Awaited<ReturnType<typeof prisma.complianceRequirement.findMany>>[number];

export function requirementView(row: RequirementRow) {
  return {
    id: row.id,
    code: row.code,
    ruleVersion: row.ruleVersion,
    status: row.status,
    name: row.name,
    description: row.description,
    requiredEvidence: row.requiredEvidence,
    obligation: row.obligation,
    level: row.level,
    categoryIds: strings(row.categoryIdsJson),
    includeDescendants: row.includeDescendants,
    supplyRoles: strings(row.supplyRolesJson),
    originCountries: strings(row.originCountriesJson),
    destinationMarkets: strings(row.destinationMarketsJson),
    riskClasses: strings(row.riskClassesJson),
    productTypeNote: row.productTypeNote,
    intendedUseNote: row.intendedUseNote,
    applicability: row.applicability,
    applicabilityNote: row.applicabilityNote,
    expiryKind: row.expiryKind,
    reviewMonths: row.reviewMonths,
    sourceUrl: row.sourceUrl,
    sourceTitle: row.sourceTitle,
    sourcePublisher: row.sourcePublisher,
    lastReviewedOn: row.lastReviewedOn.toISOString().slice(0, 10),
    confidence: row.confidence,
    importedFrom: row.importedFrom,
    effectiveFrom: row.effectiveFrom?.toISOString() ?? null,
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
    draftedByUserId: row.draftedByUserId,
    draftedByLabel: row.draftedByLabel,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    decidedByLabel: row.decidedByLabel,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    supersedesId: row.supersedesId,
    lockVersion: row.lockVersion,
  };
}

export async function listRequirements(filters: { status?: string | null; categoryId?: string | null; search?: string | null }) {
  const rows = await prisma.complianceRequirement.findMany({
    where: {
      ...(filters.status ? { status: filters.status as never } : { status: { not: 'RETIRED' } }),
      ...(filters.search ? { OR: [{ code: { contains: filters.search } }, { name: { contains: filters.search } }] } : {}),
    },
    orderBy: [{ code: 'asc' }, { ruleVersion: 'desc' }],
    take: 500,
  });
  const views = rows.map(requirementView);
  return filters.categoryId ? views.filter((rule) => rule.categoryIds.includes(filters.categoryId as string)) : views;
}

export async function requirementDetail(id: string) {
  const row = await prisma.complianceRequirement.findUnique({ where: { id } });
  if (row === null) throw notFound('Compliance rule');
  const [versions, history] = await Promise.all([
    prisma.complianceRequirement.findMany({ where: { code: row.code }, orderBy: { ruleVersion: 'desc' }, select: { id: true, ruleVersion: true, status: true, decidedAt: true, decidedByLabel: true } }),
    prisma.complianceEvent.findMany({ where: { subjectType: 'REQUIREMENT', subjectId: { in: [id] } }, orderBy: { createdAt: 'asc' } }),
  ]);
  return {
    rule: requirementView(row),
    versions: versions.map((version) => ({ ...version, decidedAt: version.decidedAt?.toISOString() ?? null })),
    history: history.map((event) => ({ kind: event.kind, actorLabel: event.actorLabel, summary: event.summary, at: event.createdAt.toISOString() })),
  };
}

/** The approved rules in force, for evaluation. */
export async function approvedRules(now = new Date()) {
  const rows = await prisma.complianceRequirement.findMany({
    where: {
      status: 'APPROVED',
      OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }],
      AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }],
    },
  });
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    ruleVersion: row.ruleVersion,
    name: row.name,
    obligation: row.obligation,
    level: row.level,
    categoryIds: strings(row.categoryIdsJson),
    includeDescendants: row.includeDescendants,
    supplyRoles: strings(row.supplyRolesJson),
    originCountries: strings(row.originCountriesJson),
    destinationMarkets: strings(row.destinationMarketsJson),
    riskClasses: strings(row.riskClassesJson),
    applicability: row.applicability,
    expiryKind: row.expiryKind,
    reviewMonths: row.reviewMonths,
  }));
}

/**
 * Rule coverage by real category: for every live department and category,
 * how many approved, draft and unresolved rules reach it - so a category with
 * nothing approved is visible as exactly that.
 */
export async function ruleCoverage() {
  const [categories, rules] = await Promise.all([
    prisma.category.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true, slug: true, depth: true, path: true, parentId: true, _count: { select: { products: true } } },
      orderBy: [{ path: 'asc' }],
    }),
    prisma.complianceRequirement.findMany({
      where: { status: { in: ['DRAFT', 'IN_REVIEW', 'APPROVED'] } },
      select: { status: true, applicability: true, categoryIdsJson: true, includeDescendants: true, obligation: true },
    }),
  ]);

  return categories.map((category) => {
    const ancestors = category.path.split('/').filter((part) => part.length > 0);
    const reaching = rules.filter((rule) => {
      const ids = strings(rule.categoryIdsJson);
      return ids.includes(category.id) || (rule.includeDescendants && ids.some((id) => ancestors.includes(id) && id !== category.id));
    });
    const count = (predicate: (rule: (typeof rules)[number]) => boolean) => reaching.filter(predicate).length;
    const approved = count((rule) => rule.status === 'APPROVED');
    return {
      categoryId: category.id,
      name: category.name,
      slug: category.slug,
      depth: category.depth,
      parentId: category.parentId,
      products: category._count.products,
      approved,
      approvedMandatory: count((rule) => rule.status === 'APPROVED' && rule.obligation !== 'OPTIONAL_QUALIFICATION'),
      awaitingApproval: count((rule) => rule.status === 'DRAFT' || rule.status === 'IN_REVIEW'),
      unresolved: count((rule) => rule.applicability === 'UNRESOLVED'),
      conditional: count((rule) => rule.applicability === 'CONDITIONAL'),
      /** Nothing approved reaches it: its sellers cannot be qualified yet. */
      needsReview: approved === 0,
    };
  });
}

// ---------------------------------------------------------------------------
// The researched drafts
// ---------------------------------------------------------------------------

const RESEARCH_FILE = fileURLToPath(new URL('../../seed/compliance-requirements.draft.json', import.meta.url));
export const RESEARCH_TAG = 'research-2026-10-06';

const researchEntry = z.object({
  code: z.string(),
  name: z.string(),
  description: z.string(),
  requiredEvidence: z.string(),
  obligation: z.enum(['LEGAL', 'CONTRACTUAL', 'OPTIONAL_QUALIFICATION']),
  level: z.enum(['SELLER_CATEGORY', 'PRODUCT']),
  categorySlugs: z.array(z.string()).min(1),
  includeDescendants: z.boolean(),
  supplyRoles: z.array(z.enum(SUPPLY_ROLES)),
  originCountries: z.array(z.string()),
  destinationMarkets: z.array(z.string()),
  riskClasses: z.array(z.enum(RISK_CLASSES)),
  productTypeNote: z.string().nullable().optional(),
  intendedUseNote: z.string().nullable().optional(),
  applicability: z.enum(['APPLIES', 'CONDITIONAL', 'UNRESOLVED']),
  applicabilityNote: z.string().nullable().optional(),
  expiry: z.object({ kind: z.enum(['DOCUMENT_EXPIRY', 'NO_EXPIRY', 'PERIODIC_REVIEW']), reviewMonths: z.number().int().nullable().optional() }),
  sourceUrl: z.string(),
  sourceTitle: z.string(),
  sourcePublisher: z.string(),
  lastReviewedOn: z.string(),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
});

export function readResearchFile(): z.infer<typeof researchEntry>[] {
  return z.array(researchEntry).parse(JSON.parse(readFileSync(RESEARCH_FILE, 'utf8')));
}

/**
 * Load the dated research as DRAFT rules, once. A code that already exists is
 * left alone, so re-running never overwrites a reviewer's edits, and a slug
 * this installation does not have is skipped and reported - never invented.
 */
export async function importResearchDrafts(actor: ComplianceActor): Promise<{ created: number; skipped: { code: string; reason: string }[] }> {
  const entries = readResearchFile();
  const categories = await prisma.category.findMany({ where: { archivedAt: null }, select: { id: true, slug: true } });
  const bySlug = new Map(categories.map((category) => [category.slug, category.id]));
  const skipped: { code: string; reason: string }[] = [];
  let created = 0;

  for (const entry of entries) {
    const exists = await prisma.complianceRequirement.findFirst({ where: { code: entry.code }, select: { id: true } });
    if (exists !== null) {
      skipped.push({ code: entry.code, reason: 'ALREADY_PRESENT' });
      continue;
    }
    const categoryIds = entry.categorySlugs.map((slug) => bySlug.get(slug)).filter((id): id is string => id !== undefined);
    if (categoryIds.length === 0) {
      skipped.push({ code: entry.code, reason: 'NO_MATCHING_CATEGORY' });
      continue;
    }
    const id = newId();
    await prisma.$transaction(async (tx) => {
      await tx.complianceRequirement.create({
        data: {
          id,
          code: entry.code,
          ruleVersion: 1,
          status: 'DRAFT',
          name: entry.name.slice(0, 255),
          description: entry.description,
          requiredEvidence: entry.requiredEvidence,
          obligation: entry.obligation,
          level: entry.level,
          categoryIdsJson: categoryIds,
          includeDescendants: entry.includeDescendants,
          supplyRolesJson: entry.supplyRoles,
          originCountriesJson: entry.originCountries,
          destinationMarketsJson: entry.destinationMarkets,
          riskClassesJson: entry.riskClasses,
          productTypeNote: entry.productTypeNote?.slice(0, 1024) ?? null,
          intendedUseNote: entry.intendedUseNote?.slice(0, 1024) ?? null,
          applicability: entry.applicability,
          applicabilityNote: entry.applicabilityNote ?? null,
          expiryKind: entry.expiry.kind,
          reviewMonths: entry.expiry.kind === 'PERIODIC_REVIEW' ? entry.expiry.reviewMonths ?? null : null,
          sourceUrl: entry.sourceUrl.slice(0, 1024),
          sourceTitle: entry.sourceTitle.slice(0, 512),
          sourcePublisher: entry.sourcePublisher.slice(0, 255),
          lastReviewedOn: new Date(`${entry.lastReviewedOn}T00:00:00.000Z`),
          confidence: entry.confidence,
          importedFrom: RESEARCH_TAG,
          draftedByUserId: actor.userId,
          draftedByLabel: actor.label,
        },
      });
      await recordComplianceEvent(tx, {
        subjectType: 'REQUIREMENT',
        subjectId: id,
        kind: 'imported',
        actor,
        summary: `${entry.code} loaded as a draft from the ${RESEARCH_TAG} research. Not in force until approved.`,
      });
    });
    created += 1;
  }
  return { created, skipped };
}
