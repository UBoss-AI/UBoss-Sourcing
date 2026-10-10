/**
 * Gates 2-7 of the Seller Assessment: the reviewers' work.
 *
 * Every write names the capability it used and lands in the event log, so the
 * release approver's independence can be checked against what people actually
 * did. A gate passes only when its own evidence is in place - the decision is
 * a person's, the preconditions are the software's.
 */
import { z } from 'zod';
import {
  AI_ALLOWED_TASKS,
  AI_FORBIDDEN_ACTIONS,
  CHECKLIST,
  CONTRACT_KINDS,
  DIMENSIONS,
  GATE_CAPABILITY,
  HARD_STOPS,
  MOCK_ORDER_STEPS,
  REVIEWABLE,
  SITE_AUDIT_AREAS,
  SPECIALIST_AREAS,
  checklistProblems,
  closureProblems,
  computeScore,
  findingBlocksRelease,
  findingDeadlines,
  isSingleCountryCode,
  mockStepModeProblem,
  unmetPrerequisites,
  type AssessmentCapability,
  type ChecklistOutcome,
  type DimensionCode,
  type FindingClass,
  type FindingStatus,
  type GateNumber,
  type GateStatus,
  type HardStop,
  type WorkpaperKind,
} from '../../domain/seller-assessment.js';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { notifySeller } from '../seller/notification.service.js';
import {
  assertVersion,
  independenceRefused,
  latestEvidence,
  loadAssessment,
  nextNumber,
  notAllowed,
  policyInForce,
  requireCapability,
  storeEvidence,
  toJsonValue,
  writeEvent,
  type AssessmentActor,
  type Client,
  type EvidenceCategory,
  type SellerActor,
} from './context.js';

function assertReviewable(row: { status: string }): void {
  if (!(REVIEWABLE as readonly string[]).includes(row.status)) notAllowed(`An assessment that is ${row.status} is not open for review.`);
}

/** A gate with a named reviewer is decided by that person, or by the Head of Seller Assurance. */
async function assertAssigned(client: Client, actor: AssessmentActor, assessmentId: string, gate: GateNumber) {
  const row = await client.sellerAssessmentGate.findUniqueOrThrow({ where: { assessmentId_gate: { assessmentId, gate } } });
  if (row.assignedUserId !== null && row.assignedUserId !== actor.userId && !actor.capabilities.includes('HEAD_OF_ASSURANCE')) {
    notAllowed(`Gate ${String(gate)} is assigned to another reviewer.`, [{ field: 'gate', code: 'ASSIGNED_ELSEWHERE' }]);
  }
  return row;
}

// --- Ownership and assignment ---------------------------------------------------

export async function assign(actor: AssessmentActor, id: string, input: { ownerUserId?: string | null; riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH'; gates?: { gate: GateNumber; userId: string | null }[] }) {
  const capability = requireCapability(actor, 'HEAD_OF_ASSURANCE');
  await prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    const people = [input.ownerUserId, ...(input.gates ?? []).map((g) => g.userId)].filter((v): v is string => typeof v === 'string');
    if (people.length > 0) {
      const staff = await tx.auditStaffMember.count({ where: { userId: { in: people }, status: 'ACTIVE' } });
      if (staff !== new Set(people).size) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Assign only active Audit staff.');
    }
    if (input.ownerUserId !== undefined || input.riskLevel !== undefined) {
      await tx.sellerAssessment.update({ where: { id }, data: { ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}), ...(input.riskLevel ? { riskLevel: input.riskLevel } : {}), version: { increment: 1 } } });
    }
    for (const g of input.gates ?? []) await tx.sellerAssessmentGate.update({ where: { assessmentId_gate: { assessmentId: id, gate: g.gate } }, data: { assignedUserId: g.userId } });
    await writeEvent(tx, { sellerAccountId: row.sellerAccountId, assessmentId: id, subjectType: 'ASSESSMENT', subjectId: id, kind: 'ASSIGNED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, data: toJsonValue(input) });
  });
}

// --- Checklist (Section 8) ----------------------------------------------------

export async function reviewChecklistItem(
  actor: AssessmentActor,
  id: string,
  code: string,
  input: { outcome: Exclude<ChecklistOutcome, 'UNREVIEWED'>; evidenceRef: string; comment: string | null; expiresOn: string | null; naReason: string | null },
) {
  const item = CHECKLIST.find((c) => c.code === code);
  if (item === undefined) throw notFound('Checklist item');
  const capability = requireCapability(actor, GATE_CAPABILITY[item.gate], 'ASSESS');
  if (input.outcome === 'NOT_APPLICABLE') {
    if (!item.naAllowed) notAllowed(`${code} is a mandatory requirement and cannot be marked not applicable.`, [{ field: 'outcome', code: 'NA_NOT_ALLOWED' }]);
    if ((input.naReason ?? '').trim().length < 10) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Not applicable needs a reason.', [{ field: 'naReason', code: 'REQUIRED' }]);
  }
  if (input.outcome === 'PASS' && item.expiryExpected && input.expiresOn === null) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'This item depends on dated evidence: record its expiry.', [{ field: 'expiresOn', code: 'REQUIRED' }]);
  }
  if (code === 'C23') notAllowed('C23 is recorded by the independent release approver at release.');
  await prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    assertReviewable(row);
    await tx.sellerAssessmentChecklistItem.update({
      where: { assessmentId_code: { assessmentId: id, code } },
      data: {
        outcome: input.outcome,
        evidenceRef: input.evidenceRef,
        comment: input.comment,
        expiresOn: input.expiresOn === null ? null : new Date(`${input.expiresOn}T00:00:00Z`),
        reviewerUserId: actor.userId,
        reviewedAt: new Date(),
        naReason: input.outcome === 'NOT_APPLICABLE' ? input.naReason : null,
        // A new N/A always needs a fresh second-person approval.
        naApprovedByUserId: null,
        naApprovedAt: null,
      },
    });
    await writeEvent(tx, { sellerAccountId: row.sellerAccountId, assessmentId: id, subjectType: 'CHECKLIST', kind: 'CHECKLIST_REVIEWED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason: input.comment ?? input.naReason, policyVersion: row.policyVersion, evidenceRefs: [input.evidenceRef], data: { code, outcome: input.outcome } });
  });
}

/** N/A needs a second, authorised person: the Head of Seller Assurance, never the reviewer who proposed it. */
export async function approveNotApplicable(actor: AssessmentActor, id: string, code: string, input: { note: string }) {
  const capability = requireCapability(actor, 'HEAD_OF_ASSURANCE');
  await prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    assertReviewable(row);
    const item = await tx.sellerAssessmentChecklistItem.findUniqueOrThrow({ where: { assessmentId_code: { assessmentId: id, code } } });
    if (item.outcome !== 'NOT_APPLICABLE') notAllowed('Only an item marked not applicable needs this approval.');
    if (item.reviewerUserId === actor.userId) independenceRefused('Approval of a not-applicable item');
    await tx.sellerAssessmentChecklistItem.update({ where: { id: item.id }, data: { naApprovedByUserId: actor.userId, naApprovedAt: new Date() } });
    await writeEvent(tx, { sellerAccountId: row.sellerAccountId, assessmentId: id, subjectType: 'CHECKLIST', kind: 'CHECKLIST_NA_APPROVED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason: input.note, policyVersion: row.policyVersion, data: { code } });
  });
}

// --- Scores (Section 4) -------------------------------------------------------

export async function rateDimension(actor: AssessmentActor, id: string, dimension: DimensionCode, input: { rating: number; evidenceRef: string; reasoning: string }) {
  const capability = requireCapability(actor, 'ASSESS');
  if (!DIMENSIONS.some((d) => d.code === dimension)) throw notFound('Score dimension');
  if (!Number.isInteger(input.rating) || input.rating < 0 || input.rating > 5) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Rate from 0 to 5.', [{ field: 'rating', code: 'RANGE' }]);
  await prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    assertReviewable(row);
    const now = new Date();
    await tx.sellerAssessmentScore.upsert({
      where: { assessmentId_dimension: { assessmentId: id, dimension } },
      create: { id: newId(), assessmentId: id, dimension, ...input, ratedByUserId: actor.userId, ratedAt: now },
      update: { ...input, ratedByUserId: actor.userId, ratedAt: now },
    });
    const policy = await policyInForce(tx);
    const all = await tx.sellerAssessmentScore.findMany({ where: { assessmentId: id } });
    const score = computeScore(Object.fromEntries(all.map((s) => [s.dimension, s.rating])), policy.config);
    await tx.sellerAssessment.update({ where: { id }, data: { scoreTimesFive: score.unrated.length === 0 ? score.scoreTimesFive : null, scoreBand: score.band } });
    await writeEvent(tx, { sellerAccountId: row.sellerAccountId, assessmentId: id, subjectType: 'SCORE', kind: 'SCORE_RATED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason: input.reasoning, policyVersion: row.policyVersion, evidenceRefs: [input.evidenceRef], data: { dimension, rating: input.rating } });
  });
}

// --- Scope classification (Gate 3, Section 11) -----------------------------------

export const classificationSchema = z.object({
  catalogueCategory: z.string().trim().min(1).max(160),
  hsProposal: z.string().trim().regex(/^\d{4,10}$/),
  regulatoryClass: z.string().trim().min(1).max(255),
  requiredTests: z.string().trim().min(1).max(4000),
  authorisations: z.string().trim().min(1).max(4000),
  authorisationExpiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  localResponsible: z.string().trim().min(1).max(512),
  importerLicence: z.string().trim().min(1).max(512),
  labelsLanguages: z.string().trim().min(1).max(512),
  warnings: z.string().trim().min(1).max(4000),
  restrictions: z.string().trim().max(4000),
  recallObligations: z.string().trim().min(1).max(4000),
  shippingInsurance: z.string().trim().min(1).max(4000),
  decision: z.enum(['APPROVED', 'BLOCKED']),
  decisionReason: z.string().trim().min(5).max(4000),
  nextReviewAt: z.string().datetime().nullable(),
});

/** One combination at a time: a country template may help the reviewer, it never clears another country. */
export async function classifyScope(actor: AssessmentActor, id: string, scopeItemId: string, input: z.infer<typeof classificationSchema>) {
  const capability = requireCapability(actor, 'REGULATORY');
  await prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    assertReviewable(row);
    const item = await tx.sellerAssessmentScopeItem.findFirst({ where: { id: scopeItemId, assessmentId: id } });
    if (item === null) throw notFound('Scope item');
    if (!isSingleCountryCode(item.countryCode)) notAllowed('A scope row must name one country.');
    await tx.sellerAssessmentScopeItem.update({
      where: { id: scopeItemId },
      data: {
        ...input,
        authorisationExpiresOn: input.authorisationExpiresOn === null ? null : new Date(`${input.authorisationExpiresOn}T00:00:00Z`),
        nextReviewAt: input.nextReviewAt === null ? null : new Date(input.nextReviewAt),
        classifiedByUserId: actor.userId,
        classifiedAt: new Date(),
      },
    });
    await writeEvent(tx, { sellerAccountId: row.sellerAccountId, assessmentId: id, subjectType: 'SCOPE', subjectId: scopeItemId, kind: 'SCOPE_CLASSIFIED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason: input.decisionReason, policyVersion: row.policyVersion, data: { decision: input.decision, country: item.countryCode, channel: item.channel, productKey: item.productKey } });
  });
}

// --- Findings / CAPA (Gate 6, Section 10) --------------------------------------

export async function raiseFinding(actor: AssessmentActor, id: string, input: { classification: FindingClass; requirement: string; evidence: string; ownerName: string | null }) {
  const capability = requireCapability(actor, 'ASSESS', 'REGULATORY', 'FINANCE', 'OPERATIONS', 'LEGAL');
  return prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    assertReviewable(row);
    const policy = await policyInForce(tx);
    const now = new Date();
    const d = findingDeadlines(input.classification, now, policy.config);
    const findingId = newId();
    const number = await nextNumber(tx, 'SAF', 'seller-assessment-finding');
    await tx.sellerAssessmentFinding.create({ data: { id: findingId, number, assessmentId: id, sellerAccountId: row.sellerAccountId, ...input, raisedAt: now, ...d, raisedByUserId: actor.userId } });
    await writeEvent(tx, { sellerAccountId: row.sellerAccountId, assessmentId: id, subjectType: 'FINDING', subjectId: findingId, kind: 'FINDING_RAISED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason: input.requirement, policyVersion: row.policyVersion, data: { number, classification: input.classification } });
    if (input.classification === 'CRITICAL') {
      await recordHardStopTx(tx, actor, row, 'CRITICAL_FINDING', `Critical finding ${number}: ${input.requirement}`.slice(0, 2000), capability);
    }
    await notifySeller({ sellerAccountId: row.sellerAccountId, kind: 'SELLER_ASSESSMENT', title: `${number}: ${input.classification.toLowerCase()} finding`, body: input.requirement.slice(0, 500), linkPath: '/seller/assessment', tx });
    return { id: findingId, number };
  });
}

/** The seller answers: containment, root cause, actions, owner. Never closes a finding. */
export async function respondToFinding(seller: SellerActor, findingId: string, input: { containment: string | null; rootCause: string | null; correctiveAction: string | null; preventiveAction: string | null; ownerName: string | null; closureEvidenceIds: string[]; expectedVersion: number }) {
  await prisma.$transaction(async (tx) => {
    const f = await tx.sellerAssessmentFinding.findFirst({ where: { id: findingId, sellerAccountId: seller.sellerAccountId } });
    if (f === null) throw notFound('Finding');
    if (f.status === 'VERIFIED_CLOSED') notAllowed('This finding is closed.');
    assertVersion(f, input.expectedVersion);
    const own = await tx.sellerAssessmentEvidence.count({ where: { id: { in: input.closureEvidenceIds }, assessmentId: f.assessmentId } });
    if (own !== input.closureEvidenceIds.length) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Attach evidence from this assessment only.', [{ field: 'closureEvidenceIds', code: 'NOT_FOUND' }]);
    const status: FindingStatus = input.correctiveAction ? 'ACTION_SUBMITTED' : input.containment ? 'CONTAINED' : 'PLAN_SUBMITTED';
    await tx.sellerAssessmentFinding.update({ where: { id: findingId }, data: { containment: input.containment, rootCause: input.rootCause, correctiveAction: input.correctiveAction, preventiveAction: input.preventiveAction, ownerName: input.ownerName, closureEvidenceIdsJson: input.closureEvidenceIds, status, version: { increment: 1 } } });
    await writeEvent(tx, { sellerAccountId: f.sellerAccountId, assessmentId: f.assessmentId, subjectType: 'FINDING', subjectId: findingId, kind: 'FINDING_RESPONDED', actorUserId: seller.profileId, actorRole: 'SELLER', data: { status } });
  });
}

/** Only an auditor closes a finding, on objective effectiveness evidence. */
export async function closeFinding(actor: AssessmentActor, findingId: string, input: { effectivenessVerification: string; decision: 'CLOSE' | 'REOPEN'; expectedVersion: number }) {
  const capability = requireCapability(actor, 'ASSESS');
  await prisma.$transaction(async (tx) => {
    const f = await tx.sellerAssessmentFinding.findUnique({ where: { id: findingId } });
    if (f === null) throw notFound('Finding');
    assertVersion(f, input.expectedVersion);
    if (input.decision === 'CLOSE') {
      const gaps = closureProblems({ ...f, classification: f.classification as FindingClass, closureEvidenceCount: Array.isArray(f.closureEvidenceIdsJson) ? f.closureEvidenceIdsJson.length : 0, effectivenessVerification: input.effectivenessVerification });
      if (gaps.length > 0) notAllowed('This finding cannot be closed yet.', gaps.map((g) => ({ field: 'finding', code: g })));
    }
    await tx.sellerAssessmentFinding.update({
      where: { id: findingId },
      data: input.decision === 'CLOSE'
        ? { status: 'VERIFIED_CLOSED', effectivenessVerification: input.effectivenessVerification, closedByUserId: actor.userId, closedAt: new Date(), version: { increment: 1 } }
        : { status: 'REOPENED', effectivenessVerification: input.effectivenessVerification, version: { increment: 1 } },
    });
    await writeEvent(tx, { sellerAccountId: f.sellerAccountId, assessmentId: f.assessmentId, subjectType: 'FINDING', subjectId: findingId, kind: input.decision === 'CLOSE' ? 'FINDING_CLOSED' : 'FINDING_REOPENED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason: input.effectivenessVerification });
  });
}

// --- Workpapers -----------------------------------------------------------------

const yes = z.boolean();
const PAYLOADS: Record<WorkpaperKind, z.ZodType> = {
  SITE_AUDIT: z.object({ facilityRef: z.string().min(1).max(64), visitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), auditors: z.string().min(2).max(512), reportId: z.string().min(1).max(64), areas: z.record(z.enum(SITE_AUDIT_AREAS), z.enum(['SATISFACTORY', 'FINDING_RAISED', 'NOT_APPLICABLE'])), outsourcedProcessesCovered: z.string().max(4000), notes: z.string().max(8000) }),
  SAMPLE_PLAN: z.object({ basis: z.enum(['STATISTICAL', 'RISK_BASED']), justification: z.string().min(10).max(4000), method: z.string().min(2).max(2000), quantities: z.string().min(1).max(1000), acceptanceCriteria: z.string().min(2).max(4000), laboratory: z.string().min(2).max(255), testScope: z.string().min(2).max(4000), selectedBy: z.string().min(2).max(255), sealNumbers: z.string().min(1).max(1000), custody: z.array(z.object({ at: z.string().datetime(), from: z.string().max(255), to: z.string().max(255), sealIntact: yes })).min(1).max(50), results: z.string().max(8000), resultOutcome: z.enum(['PENDING', 'PASS', 'FAIL']) }),
  LAB_COMPETENCE: z.object({ laboratory: z.string().min(2).max(255), iso17025Accreditation: z.string().max(255).nullable(), accreditationScopeCoversTests: yes, legalRecognitionRequired: yes, legalRecognitionReference: z.string().max(512).nullable(), verifiedAgainst: z.string().min(2).max(512), evidenceRef: z.string().min(1).max(255) }),
  CONTRACT: z.object({ contractKind: z.enum(CONTRACT_KINDS), executedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), counterpartySignatory: z.string().min(2).max(255), evidenceRef: z.string().min(1).max(255) }),
  MOCK_ORDER: z.object({ reference: z.string().min(1).max(64), steps: z.array(z.object({ step: z.enum(MOCK_ORDER_STEPS), mode: z.enum(['SIMULATED', 'PROVIDER_VERIFIED']), integration: z.enum(['NONE', 'PAYMENTS', 'CARRIER']), outcome: z.enum(['PASS', 'FAIL']), note: z.string().max(2000) })).min(MOCK_ORDER_STEPS.length).max(20) }),
  IDENTITY_CHECK: z.object({ subject: z.enum(['REGISTRATION', 'PAN', 'GST', 'IEC', 'ADDRESS', 'DIRECTORS', 'BENEFICIAL_OWNERSHIP', 'SIGNATORY']), source: z.string().min(2).max(512), retrievedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), outcome: z.enum(['MATCH', 'MISMATCH', 'UNVERIFIABLE']), lawfulBasis: z.string().min(2).max(512), note: z.string().max(4000) }),
  BANK_VERIFICATION: z.object({ method: z.string().min(2).max(512), knownContact: z.string().min(2).max(255), beneficiaryMatchesEntity: yes, outcome: z.enum(['CONFIRMED', 'MISMATCH']), note: z.string().max(4000) }),
  SANCTIONS_SCREENING: z.object({ lists: z.string().min(2).max(1000), source: z.string().min(2).max(512), provider: z.enum(['MANUAL', 'PROVIDER']), subjects: z.string().min(2).max(2000), outcome: z.enum(['NO_MATCH', 'FALSE_POSITIVE_RESOLVED', 'PROHIBITED_MATCH', 'UNRESOLVED']), note: z.string().max(4000) }),
  SPECIALIST_REVIEW: z.object({ area: z.enum(SPECIALIST_AREAS), outcome: z.enum(['SATISFACTORY', 'NOT_SATISFACTORY']), note: z.string().min(10).max(8000) }),
  AI_OUTPUT: z.object({ task: z.enum(AI_ALLOWED_TASKS), tool: z.string().min(1).max(160), source: z.string().min(2).max(1000), retrievedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']), uncertainty: z.string().min(2).max(2000), output: z.string().min(1).max(8000), humanReviewNote: z.string().min(5).max(4000) }),
};

const WORKPAPER_CAPABILITY: Record<WorkpaperKind, AssessmentCapability[]> = {
  SITE_AUDIT: ['ASSESS'],
  SAMPLE_PLAN: ['ASSESS'],
  LAB_COMPETENCE: ['ASSESS'],
  CONTRACT: ['LEGAL'],
  MOCK_ORDER: ['OPERATIONS'],
  IDENTITY_CHECK: ['FINANCE', 'ASSESS'],
  BANK_VERIFICATION: ['FINANCE'],
  SANCTIONS_SCREENING: ['FINANCE', 'ASSESS'],
  SPECIALIST_REVIEW: [],
  AI_OUTPUT: ['ASSESS', 'REGULATORY', 'FINANCE'],
};

function integrationEnabled(kind: string): boolean {
  if (kind === 'NONE') return true;
  if (kind === 'PAYMENTS') return env.STRIPE_SECRET_KEY !== '' || env.RAZORPAY_KEY_ID !== '';
  return false; // No carrier is verified from here; carrier credentials are per seller.
}

export async function recordWorkpaper(actor: AssessmentActor, id: string, kind: WorkpaperKind, payload: unknown, subjectRef: string | null) {
  const parsed = PAYLOADS[kind].safeParse(payload);
  if (!parsed.success) throw badRequest(ErrorCode.VALIDATION_FAILED, 'The record is incomplete.', parsed.error.issues.slice(0, 20).map((i) => ({ field: i.path.join('.'), code: i.code.toUpperCase() })));
  const data = parsed.data as Record<string, unknown>;
  const capability = kind === 'SPECIALIST_REVIEW' ? requireCapability(actor, data['area'] as AssessmentCapability) : requireCapability(actor, ...WORKPAPER_CAPABILITY[kind]);
  let mode: 'RECORDED' | 'SIMULATED' = 'RECORDED';
  if (kind === 'MOCK_ORDER') {
    const steps = data['steps'] as { step: string; mode: string; integration: string }[];
    for (const s of steps) {
      const problem = mockStepModeProblem({ mode: s.mode, integrationEnabled: integrationEnabled(s.integration) });
      if (problem !== null) notAllowed(`${s.step}: a disabled integration cannot be marked as tested with a provider.`, [{ field: 'steps', code: problem }]);
    }
    if (!MOCK_ORDER_STEPS.every((step) => steps.some((s) => s.step === step))) notAllowed('The mock order must cover every step.', [{ field: 'steps', code: 'INCOMPLETE' }]);
    if (steps.some((s) => s.mode === 'SIMULATED')) mode = 'SIMULATED';
  }
  if (kind === 'AI_OUTPUT') {
    const out = JSON.stringify(data).toUpperCase();
    if (AI_FORBIDDEN_ACTIONS.some((a) => out.includes(a))) notAllowed('An AI output is advice to a reviewer. It cannot approve, certify, resolve a sanctions match, decide legal compliance or move money.');
  }
  return prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    assertReviewable(row);
    const previous = await tx.sellerAssessmentWorkpaper.findFirst({ where: { assessmentId: id, kind, subjectRef }, orderBy: { revision: 'desc' } });
    const wid = newId();
    await tx.sellerAssessmentWorkpaper.create({ data: { id: wid, assessmentId: id, kind, subjectRef, mode, payloadJson: toJsonValue(data), revision: (previous?.revision ?? 0) + 1, supersedesId: previous?.id ?? null, recordedByUserId: actor.userId, recordedAt: new Date() } });
    await writeEvent(tx, { sellerAccountId: row.sellerAccountId, assessmentId: id, subjectType: 'WORKPAPER', subjectId: wid, kind: kind === 'SPECIALIST_REVIEW' ? 'SPECIALIST_REVIEWED' : 'WORKPAPER_RECORDED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, policyVersion: row.policyVersion, data: { kind, subjectRef, mode } });
    if (kind === 'SANCTIONS_SCREENING' && data['outcome'] === 'PROHIBITED_MATCH') await recordHardStopTx(tx, actor, row, 'PROHIBITED_SANCTIONS_MATCH', String(data['note']), capability);
    return { id: wid };
  });
}

/** Latest revision of each workpaper (kind + subject). */
async function currentWorkpapers(client: Client, assessmentId: string) {
  const rows = await client.sellerAssessmentWorkpaper.findMany({ where: { assessmentId }, orderBy: { revision: 'desc' } });
  const seen = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    // One current record per kind, subject and sub-kind: each specialist area,
    // contract kind and identity subject stands on its own.
    const p = r.payloadJson as Record<string, string | undefined>;
    const k = `${r.kind}|${r.subjectRef ?? ''}|${p['area'] ?? p['contractKind'] ?? p['subject'] ?? ''}`;
    if (!seen.has(k)) seen.set(k, r);
  }
  return [...seen.values()];
}

// --- External certification (Gate 5) -----------------------------------------

export const certSchema = z.object({
  bodyName: z.string().trim().min(2).max(255),
  scheme: z.string().trim().min(2).max(255),
  procurementRef: z.string().trim().max(128).nullable(),
  paymentRef: z.string().trim().max(128).nullable(),
  accreditationBody: z.string().trim().max(255).nullable(),
  accreditationNumber: z.string().trim().max(128).nullable(),
  sectorScope: z.string().trim().max(4000).nullable(),
  legalRecognition: z.string().trim().max(4000).nullable(),
  conflictCheck: z.string().trim().max(4000).nullable(),
  facilityRefs: z.array(z.string().max(64)).max(30),
  productKeys: z.array(z.string().max(64)).max(200),
  surveillanceConditions: z.string().trim().max(4000).nullable(),
});

/** The marketplace appoints (and pays) the body. A seller has no route that can replace it. */
export async function appointCertificationBody(actor: AssessmentActor, id: string, input: z.infer<typeof certSchema>) {
  const capability = requireCapability(actor, 'HEAD_OF_ASSURANCE', 'ASSESS');
  return prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    assertReviewable(row);
    const live = await tx.sellerExternalCertification.findFirst({ where: { assessmentId: id, status: { in: ['APPOINTED', 'IN_PROGRESS', 'ISSUED_UNVERIFIED', 'AUTHENTICATED'] } } });
    // Replacing an appointed body is a Head of Seller Assurance decision with a reason, never the seller's choice.
    if (live !== null && !actor.capabilities.includes('HEAD_OF_ASSURANCE')) notAllowed('A body is already appointed. Only the Head of Seller Assurance can replace it, with a reason.');
    if (live !== null) await tx.sellerExternalCertification.update({ where: { id: live.id }, data: { status: 'REFUSED', statusReason: 'Replaced by a new marketplace appointment.', version: { increment: 1 } } });
    const cid = newId();
    const { facilityRefs, productKeys, ...rest } = input;
    await tx.sellerExternalCertification.create({ data: { id: cid, assessmentId: id, sellerAccountId: row.sellerAccountId, ...rest, facilityRefsJson: facilityRefs, productKeysJson: productKeys, appointedByUserId: actor.userId, appointedAt: new Date() } });
    await writeEvent(tx, { sellerAccountId: row.sellerAccountId, assessmentId: id, subjectType: 'CERTIFICATION', subjectId: cid, kind: 'CERTIFICATION_RECORDED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, data: { bodyName: input.bodyName, scheme: input.scheme, replaced: live?.id ?? null } });
    return { id: cid };
  });
}

/**
 * Record what the body issued, and how its authenticity was checked against the
 * issuer - never on the strength of a seller upload. `verifiedAccreditation`
 * and `verifiedIndependence` are statements the reviewer makes, with evidence.
 */
export async function recordCertificate(
  actor: AssessmentActor,
  certId: string,
  input: { certificateNumber: string; issuer: string; issuedOn: string; expiresOn: string; authenticityMethod: string; authenticityReference: string; accreditationVerified: boolean; independenceVerified: boolean; status: 'ISSUED_UNVERIFIED' | 'AUTHENTICATED'; expectedVersion: number },
) {
  const capability = requireCapability(actor, 'ASSESS');
  await prisma.$transaction(async (tx) => {
    const cert = await tx.sellerExternalCertification.findUnique({ where: { id: certId } });
    if (cert === null) throw notFound('Certification');
    assertVersion(cert, input.expectedVersion);
    if (['WITHDRAWN', 'REFUSED'].includes(cert.status)) notAllowed('This certification is closed.');
    if (input.status === 'AUTHENTICATED' && (input.authenticityMethod.trim().length < 5 || input.authenticityReference.trim().length < 3)) {
      notAllowed('Authentication needs the method and the issuer reference it was checked against.', [{ field: 'authenticityReference', code: 'REQUIRED' }]);
    }
    if (input.expiresOn <= input.issuedOn) throw badRequest(ErrorCode.VALIDATION_FAILED, 'The expiry must follow the issue date.', [{ field: 'expiresOn', code: 'ORDER' }]);
    await tx.sellerExternalCertification.update({
      where: { id: certId },
      data: {
        certificateNumber: input.certificateNumber,
        issuer: input.issuer,
        issuedOn: new Date(`${input.issuedOn}T00:00:00Z`),
        expiresOn: new Date(`${input.expiresOn}T00:00:00Z`),
        authenticityMethod: input.authenticityMethod,
        authenticityReference: input.authenticityReference,
        accreditationVerified: input.accreditationVerified,
        independenceVerified: input.independenceVerified,
        status: input.status,
        authenticatedByUserId: input.status === 'AUTHENTICATED' ? actor.userId : null,
        authenticatedAt: input.status === 'AUTHENTICATED' ? new Date() : null,
        version: { increment: 1 },
      },
    });
    await writeEvent(tx, { sellerAccountId: cert.sellerAccountId, assessmentId: cert.assessmentId, subjectType: 'CERTIFICATION', subjectId: certId, kind: input.status === 'AUTHENTICATED' ? 'CERTIFICATION_AUTHENTICATED' : 'CERTIFICATION_RECORDED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason: input.authenticityMethod, data: { certificateNumber: input.certificateNumber, expiresOn: input.expiresOn } });
  });
}

/** Withdrawal or suspension by the issuer takes effect at the purchase gate immediately (it reads this row). */
export async function withdrawCertificate(actor: AssessmentActor, certId: string, input: { status: 'WITHDRAWN' | 'SUSPENDED'; reason: string }) {
  const capability = requireCapability(actor, 'ASSESS', 'HEAD_OF_ASSURANCE');
  await prisma.$transaction(async (tx) => {
    const cert = await tx.sellerExternalCertification.findUnique({ where: { id: certId } });
    if (cert === null) throw notFound('Certification');
    await tx.sellerExternalCertification.update({ where: { id: certId }, data: { status: input.status, statusReason: input.reason, version: { increment: 1 } } });
    await writeEvent(tx, { sellerAccountId: cert.sellerAccountId, assessmentId: cert.assessmentId, subjectType: 'CERTIFICATION', subjectId: certId, kind: 'CERTIFICATION_WITHDRAWN', actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason: input.reason });
  });
}

// --- Hard stops (Section 3) ---------------------------------------------------

async function recordHardStopTx(tx: Client, actor: AssessmentActor, row: { id: string; sellerAccountId: string; hardStopsJson: unknown; policyVersion: string }, stop: HardStop, reason: string, capability: AssessmentCapability) {
  const current = Array.isArray(row.hardStopsJson) ? (row.hardStopsJson as { stop: string }[]) : [];
  const next = [...current.filter((h) => h.stop !== stop), { stop, reason: reason.slice(0, 2000), at: new Date().toISOString(), by: actor.userId }];
  await tx.sellerAssessment.update({ where: { id: row.id }, data: { hardStopsJson: next } });
  await writeEvent(tx, { sellerAccountId: row.sellerAccountId, assessmentId: row.id, subjectType: 'ASSESSMENT', subjectId: row.id, kind: 'HARD_STOP_RECORDED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason, policyVersion: row.policyVersion, data: { stop } });
}

/** No commercial executive may override one; there is no route that clears a hard stop. */
export async function recordHardStop(actor: AssessmentActor, id: string, input: { stop: HardStop; reason: string }) {
  if (!HARD_STOPS.includes(input.stop)) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Unknown hard stop.');
  const capability = requireCapability(actor, 'ASSESS', 'REGULATORY', 'FINANCE', 'OPERATIONS', 'LEGAL', 'HEAD_OF_ASSURANCE');
  await prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    await recordHardStopTx(tx, actor, row, input.stop, input.reason, capability);
  });
}

// --- Gates ----------------------------------------------------------------------

export async function gatePreconditions(client: Client, assessmentId: string, gate: GateNumber): Promise<string[]> {
  const now = new Date();
  const checklist = await client.sellerAssessmentChecklistItem.findMany({ where: { assessmentId } });
  const codes = CHECKLIST.filter((c) => c.gate === gate).map((c) => c.code);
  const out = checklistProblems(checklist.map((c) => ({ code: c.code, outcome: c.outcome as ChecklistOutcome, naApprovedByUserId: c.naApprovedByUserId, expiresOn: c.expiresOn })), now, CHECKLIST.filter((c) => !codes.includes(c.code)).map((c) => c.code)).map((p) => `${p.code}:${p.problem}`);
  const papers = await currentWorkpapers(client, assessmentId);
  const pay = (r: { payloadJson: unknown }) => r.payloadJson as Record<string, unknown>;
  const specialist = (area: string) => papers.some((p) => p.kind === 'SPECIALIST_REVIEW' && pay(p)['area'] === area && pay(p)['outcome'] === 'SATISFACTORY');
  if (gate === 2) {
    if (!papers.some((p) => p.kind === 'BANK_VERIFICATION' && pay(p)['outcome'] === 'CONFIRMED')) out.push('BANK_NOT_CONFIRMED');
    const screen = papers.filter((p) => p.kind === 'SANCTIONS_SCREENING');
    if (screen.length === 0 || screen.some((p) => ['PROHIBITED_MATCH', 'UNRESOLVED'].includes(String(pay(p)['outcome'])))) out.push('SANCTIONS_NOT_RESOLVED');
    if (papers.some((p) => p.kind === 'IDENTITY_CHECK' && pay(p)['outcome'] !== 'MATCH')) out.push('IDENTITY_MISMATCH');
    if (!specialist('FINANCE')) out.push('FINANCE_REVIEW_MISSING');
  }
  if (gate === 3) {
    const scope = await client.sellerAssessmentScopeItem.findMany({ where: { assessmentId }, select: { decision: true } });
    if (scope.length === 0) out.push('SCOPE_EMPTY');
    if (scope.some((s) => s.decision === 'PENDING')) out.push('SCOPE_UNCLASSIFIED');
    if (!scope.some((s) => s.decision === 'APPROVED')) out.push('NO_APPROVED_SCOPE');
    if (!specialist('REGULATORY')) out.push('REGULATORY_REVIEW_MISSING');
  }
  if (gate === 4) {
    const facilities = await client.sellerAssessmentScopeItem.findMany({ where: { assessmentId, decision: 'APPROVED' }, select: { facilityRef: true }, distinct: ['facilityRef'] });
    for (const f of facilities) if (!papers.some((p) => p.kind === 'SITE_AUDIT' && pay(p)['facilityRef'] === f.facilityRef)) out.push(`SITE_AUDIT_MISSING:${f.facilityRef}`);
    const plan = papers.find((p) => p.kind === 'SAMPLE_PLAN');
    if (plan === undefined) out.push('SAMPLE_PLAN_MISSING');
    else if (pay(plan)['resultOutcome'] !== 'PASS') out.push('SAMPLE_RESULTS_NOT_PASSED');
    if (!papers.some((p) => p.kind === 'LAB_COMPETENCE')) out.push('LAB_COMPETENCE_MISSING');
  }
  if (gate === 5) {
    const cert = await client.sellerExternalCertification.findFirst({ where: { assessmentId, status: 'AUTHENTICATED' } });
    if (cert === null) out.push('CERT_NOT_AUTHENTICATED');
    else {
      if (!cert.accreditationVerified || !cert.independenceVerified) out.push('CERT_BODY_NOT_VERIFIED');
      if (cert.expiresOn === null || cert.expiresOn.getTime() <= now.getTime()) out.push('CERT_EXPIRED');
    }
  }
  if (gate === 6) {
    const findings = await client.sellerAssessmentFinding.findMany({ where: { assessmentId }, select: { classification: true, status: true } });
    if (findings.some((f) => findingBlocksRelease(f as { classification: FindingClass; status: FindingStatus }))) out.push('CRITICAL_OR_MAJOR_OPEN');
  }
  if (gate === 7) {
    for (const k of CONTRACT_KINDS) if (!papers.some((p) => p.kind === 'CONTRACT' && pay(p)['contractKind'] === k)) out.push(`CONTRACT_MISSING:${k}`);
    const mock = papers.find((p) => p.kind === 'MOCK_ORDER');
    if (mock === undefined) out.push('MOCK_ORDER_MISSING');
    else if ((pay(mock)['steps'] as { outcome: string }[]).some((s) => s.outcome !== 'PASS')) out.push('MOCK_ORDER_FAILED');
    if (!specialist('LEGAL')) out.push('LEGAL_REVIEW_MISSING');
    if (!specialist('OPERATIONS')) out.push('OPERATIONS_REVIEW_MISSING');
  }
  return out;
}

/** Decide gates 2-7. Gate 1 is accepting the file; Gate 8 is release. */
export async function decideGate(actor: AssessmentActor, id: string, gate: GateNumber, input: { status: Exclude<GateStatus, 'NOT_STARTED'>; reason: string }) {
  if (gate === 1 || gate === 8) notAllowed('Gate 1 is decided by accepting the file and Gate 8 by release.');
  const capability = requireCapability(actor, ...(gate === 7 ? (['LEGAL', 'OPERATIONS'] as const) : [GATE_CAPABILITY[gate]]));
  await prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    assertReviewable(row);
    await assertAssigned(tx, actor, id, gate);
    if (input.status === 'PASSED') {
      const gates = await tx.sellerAssessmentGate.findMany({ where: { assessmentId: id } });
      const unmet = unmetPrerequisites(gate, Object.fromEntries(gates.map((g) => [g.gate, g.status as GateStatus])));
      if (unmet.length > 0) notAllowed(`Gate ${String(gate)} needs gate ${unmet.join(', ')} passed first.`, unmet.map((g) => ({ field: 'gate', code: `PREREQUISITE_${String(g)}` })));
      const gaps = await gatePreconditions(tx, id, gate);
      if (gaps.length > 0) notAllowed(`Gate ${String(gate)} is not ready to pass.`, gaps.map((g) => ({ field: 'gate', code: g })));
    }
    await tx.sellerAssessmentGate.update({ where: { assessmentId_gate: { assessmentId: id, gate } }, data: { status: input.status, reason: input.reason, decidedByUserId: actor.userId, decidedAt: new Date(), policyVersion: row.policyVersion } });
    await writeEvent(tx, { sellerAccountId: row.sellerAccountId, assessmentId: id, subjectType: 'GATE', kind: 'GATE_DECIDED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason: input.reason, policyVersion: row.policyVersion, data: { gate, status: input.status } });
  });
}

// --- Audit-side evidence --------------------------------------------------------

export async function uploadAuditEvidence(actor: AssessmentActor, id: string, input: { category: EvidenceCategory; evidenceKey: string; label: string; fileName: string; bytes: Buffer }) {
  requireCapability(actor, 'ASSESS', 'REGULATORY', 'FINANCE', 'OPERATIONS', 'LEGAL', 'HEAD_OF_ASSURANCE');
  return prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    const stored = await storeEvidence(tx, { assessmentId: id, sellerAccountId: row.sellerAccountId, ...input, uploadedByUserId: actor.userId, uploadedByRole: 'AUDIT' });
    await writeEvent(tx, { sellerAccountId: row.sellerAccountId, assessmentId: id, subjectType: 'EVIDENCE', subjectId: stored.id, kind: 'EVIDENCE_ADDED', actorUserId: actor.userId, actorRole: 'AUDIT', evidenceRefs: [`${input.evidenceKey}@v${String(stored.evidenceVersion)}`] });
    return stored;
  });
}

export { latestEvidence };
