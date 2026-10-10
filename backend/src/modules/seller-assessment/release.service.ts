/**
 * Gate 8: independent release, and the Seller Trading Approval it creates.
 *
 * The approval is the marketplace's INTERNAL trading approval. It is kept apart
 * from (1) the independent body's certificate, whose dates are the issuer's and
 * which this record can only cut short, never extend, and (2) Shipment
 * Assessment certificates, which are about one shipment. Its PDF says so.
 */
import {
  CHECKLIST,
  DIMENSIONS,
  approvalValidUntil,
  certProblems,
  checklistProblems,
  computeScore,
  findingBlocksRelease,
  isIndependentApprover,
  type ChecklistOutcome,
  type FindingClass,
  type FindingStatus,
  type GateNumber,
} from '../../domain/seller-assessment.js';
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { notifySeller } from '../seller/notification.service.js';
import { issueDocument } from '../shipment-assessment/documents.service.js';
import { moveAssessment, problemsFor } from './application.service.js';
import {
  decisionPolicy,
  independenceRefused,
  loadAssessment,
  nextNumber,
  notAllowed,
  participants,
  policyInForce,
  requireCapability,
  toJsonValue,
  writeEvent,
  assertVersion,
  type AssessmentActor,
  type Client,
} from './context.js';
import { gatePreconditions } from './review.service.js';

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '-');

/** Every reason this assessment cannot be released, all at once. */
export async function releaseGaps(client: Client, id: string, scopeItemIds: readonly string[] | null) {
  const row = await loadAssessment(client, id);
  const gaps: string[] = [];
  const now = new Date();
  const { problems } = await problemsFor(client, row);
  for (const p of problems) gaps.push(`APPLICATION:${p}`);
  const gates = await client.sellerAssessmentGate.findMany({ where: { assessmentId: id }, orderBy: { gate: 'asc' } });
  for (const g of gates) if (g.gate < 8 && g.status !== 'PASSED') gaps.push(`GATE_${String(g.gate)}_NOT_PASSED`);
  for (let gate = 2; gate <= 7; gate += 1) for (const g of await gatePreconditions(client, id, gate as GateNumber)) gaps.push(`GATE_${String(gate)}:${g}`);
  const checklist = await client.sellerAssessmentChecklistItem.findMany({ where: { assessmentId: id } });
  for (const p of checklistProblems(checklist.map((c) => ({ code: c.code, outcome: c.outcome as ChecklistOutcome, naApprovedByUserId: c.naApprovedByUserId, expiresOn: c.expiresOn })), now, ['C23'])) gaps.push(`CHECKLIST:${p.code}:${p.problem}`);
  const policy = await decisionPolicy(client);
  const scores = await client.sellerAssessmentScore.findMany({ where: { assessmentId: id } });
  const score = computeScore(Object.fromEntries(scores.map((s) => [s.dimension, s.rating])), policy.config);
  if (score.band !== 'RELEASE_ELIGIBLE') gaps.push(`SCORE:${score.band}`);
  for (const d of score.belowDimensionMinimum) gaps.push(`SCORE_DIMENSION_BELOW_MINIMUM:${d}`);
  const findings = await client.sellerAssessmentFinding.findMany({ where: { assessmentId: id } });
  for (const f of findings) if (findingBlocksRelease(f as unknown as { classification: FindingClass; status: FindingStatus })) gaps.push(`FINDING_OPEN:${f.number}`);
  // Hard stops override any score. There is no way to clear one inside this assessment.
  const stops = Array.isArray(row.hardStopsJson) ? (row.hardStopsJson as { stop: string }[]) : [];
  for (const s of stops) gaps.push(`HARD_STOP:${s.stop}`);
  const cert = await client.sellerExternalCertification.findFirst({ where: { assessmentId: id }, orderBy: { appointedAt: 'desc' } });
  const scope = await client.sellerAssessmentScopeItem.findMany({ where: { assessmentId: id, decision: 'APPROVED', ...(scopeItemIds === null ? {} : { id: { in: [...scopeItemIds] } }) } });
  if (scopeItemIds !== null && scope.length !== scopeItemIds.length) gaps.push('SCOPE_NOT_APPROVED_AT_GATE_3');
  if (scope.length === 0) gaps.push('SCOPE_EMPTY');
  const certFacts = cert === null ? null : {
    status: cert.status as 'AUTHENTICATED',
    appointedByGloviaa: true,
    accreditationVerified: cert.accreditationVerified,
    independenceVerified: cert.independenceVerified,
    authenticityVerified: cert.authenticatedAt !== null,
    expiresOn: cert.expiresOn,
    facilityIds: (cert.facilityRefsJson as string[] | null) ?? [],
    productKeys: (cert.productKeysJson as string[] | null) ?? [],
  };
  const certGaps = new Set<string>();
  for (const s of scope) for (const p of certProblems(certFacts, { facilityId: s.facilityRef, productKey: s.productKey }, now)) certGaps.add(p === 'CERT_OUT_OF_SCOPE' ? `${p}:${s.productKey}@${s.facilityRef}` : p);
  if (scope.length === 0) for (const p of certProblems(certFacts, null, now)) certGaps.add(p);
  gaps.push(...certGaps);
  for (const s of scope) if (s.authorisationExpiresOn !== null && s.authorisationExpiresOn.getTime() <= now.getTime()) gaps.push(`AUTHORISATION_EXPIRED:${s.id}`);
  return { row, gaps, score, cert, scope, policy, checklist };
}

/**
 * Release exactly the scope named. Needs the RELEASE capability, a person who
 * took no part in the assessment, and every condition met. Pending extensions
 * are not part of it - only the rows named here become purchasable.
 */
export async function release(actor: AssessmentActor, id: string, input: { scopeItemIds: string[]; reason: string; nextReviewAt: string | null; expectedVersion: number }) {
  const capability = requireCapability(actor, 'RELEASE');
  return prisma.$transaction(async (tx) => {
    // Lock the row so a concurrent suspension or second release waits for us.
    await tx.$queryRaw`SELECT id FROM seller_assessments WHERE id = ${id} FOR UPDATE`;
    const { row, gaps, score, cert, scope, policy, checklist } = await releaseGaps(tx, id, input.scopeItemIds);
    assertVersion(row, input.expectedVersion);
    if (row.status !== 'IN_REVIEW') notAllowed(`An assessment that is ${row.status} cannot be released.`);
    const involved = await participants(tx, id);
    if (row.ownerUserId !== null) involved.add(row.ownerUserId);
    if (!isIndependentApprover(actor.userId, involved)) independenceRefused('The release approver');
    if (gaps.length > 0) throw conflict(ErrorCode.SELLER_ASSESSMENT_RELEASE_BLOCKED, 'Release is blocked.', gaps.slice(0, 100).map((g) => ({ field: 'release', code: g })));
    if (cert === null) throw notFound('Certification');

    const now = new Date();
    const app = (row.applicationJson ?? {}) as Record<string, unknown>;
    const insurance = (((app['fulfilment'] as Record<string, unknown> | undefined)?.['insurance'] ?? []) as { expiresOn?: string | null; kind: string; insurer: string; limitMinor: string; currency: string; territories: string }[]);
    const licences = (((app['taxIds'] as Record<string, unknown> | undefined)?.['licences'] ?? []) as { expiresOn?: string | null }[]);
    const toDate = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00Z`) : null);
    const validUntil = approvalValidUntil(now, policy.config.approvalValidityMonths, [
      cert.expiresOn,
      ...checklist.map((c) => c.expiresOn),
      ...scope.map((s) => s.authorisationExpiresOn),
      ...insurance.map((i) => toDate(i.expiresOn)),
      ...licences.map((l) => toDate(l.expiresOn)),
    ]);
    if (validUntil.getTime() <= now.getTime()) notAllowed('A mandatory certificate, licence or insurance has already expired.');
    const nextReviewAt = input.nextReviewAt === null ? validUntil : new Date(Math.min(new Date(input.nextReviewAt).getTime(), validUntil.getTime()));

    // C23: the independent approver checks the release and the purchase gate.
    await tx.sellerAssessmentChecklistItem.update({ where: { assessmentId_code: { assessmentId: id, code: 'C23' } }, data: { outcome: 'PASS', evidenceRef: `release by ${actor.fullName}`, reviewerUserId: actor.userId, reviewedAt: now, comment: input.reason } });
    await tx.sellerAssessmentGate.update({ where: { assessmentId_gate: { assessmentId: id, gate: 8 } }, data: { status: 'PASSED', reason: input.reason, decidedByUserId: actor.userId, decidedAt: now, policyVersion: policy.version } });

    // A renewal supersedes the approval it renews; an extension leaves it in force.
    if (row.kind === 'RENEWAL' && row.baseApprovalId !== null) {
      await tx.sellerTradingApproval.updateMany({ where: { id: row.baseApprovalId, status: { in: ['ACTIVE', 'SUSPENDED'] } }, data: { status: 'SUPERSEDED', statusChangedAt: now, statusReason: 'Renewed.' } });
    }

    const signoff = async (cap: string) => {
      const ev = await tx.sellerAssessmentEvent.findFirst({ where: { assessmentId: id, capability: cap, kind: { in: ['GATE_DECIDED', 'SPECIALIST_REVIEWED'] } }, orderBy: { createdAt: 'desc' } });
      const name = ev?.actorUserId ? (await tx.auditStaffMember.findUnique({ where: { userId: ev.actorUserId }, select: { fullName: true } }))?.fullName ?? ev.actorUserId : null;
      return { userId: ev?.actorUserId ?? null, name, at: ev?.createdAt.toISOString() ?? null };
    };
    const siteAudit = await tx.sellerAssessmentWorkpaper.findFirst({ where: { assessmentId: id, kind: 'SITE_AUDIT' }, orderBy: { recordedAt: 'desc' } });
    const findings = await tx.sellerAssessmentFinding.findMany({ where: { assessmentId: id, status: 'VERIFIED_CLOSED' }, select: { number: true } });
    const fin = (app['financial'] ?? {}) as Record<string, string | undefined>;
    const seller = await tx.sellerAccount.findUniqueOrThrow({ where: { id: row.sellerAccountId }, select: { legalName: true, displayName: true } });
    const record = {
      sellerLegalName: seller.legalName,
      sellerId: row.sellerAccountId,
      financialYear: `${fin['financialYearStart'] ?? '-'} to ${fin['financialYearEnd'] ?? '-'}`,
      verifiedTurnoverMinor: fin['revenueMinor'] ?? '',
      turnoverCurrency: fin['currency'] ?? '',
      applicantType: (app['applicantType'] as string | undefined) ?? '',
      auditReport: siteAudit === null ? null : { reportId: (siteAudit.payloadJson as Record<string, unknown>)['reportId'], date: (siteAudit.payloadJson as Record<string, unknown>)['visitDate'] },
      independentBody: { body: cert.bodyName, scheme: cert.scheme },
      certificate: { number: cert.certificateNumber, issuer: cert.issuer, verificationReference: cert.authenticityReference, issuedOn: day(cert.issuedOn), expiresOn: day(cert.expiresOn), surveillance: cert.surveillanceConditions },
      approvedFacilities: [...new Set(scope.map((s) => s.facilityRef))],
      approvedBrandsAndSkus: [...new Set(scope.map((s) => `${s.productName} ${s.productVersion} (${s.productKey})`))],
      approvedCountries: [...new Set(scope.map((s) => s.countryCode))],
      channels: [...new Set(scope.map((s) => s.channel))],
      importerArrangements: [...new Set(scope.map((s) => `${s.countryCode}: ${s.localResponsible ?? '-'}; importer licence ${s.importerLicence ?? '-'}`))],
      insurance: insurance.map((i) => ({ kind: i.kind, insurer: i.insurer, limitMinor: i.limitMinor, currency: i.currency, territories: i.territories, expiresOn: i.expiresOn ?? null })),
      auditScore: score.display,
      capaClosureIds: findings.map((f) => f.number),
      signoffs: { auditLead: await signoff('ASSESS'), regulatory: await signoff('REGULATORY'), finance: await signoff('FINANCE'), releaseApprover: { userId: actor.userId, name: actor.fullName, at: now.toISOString() } },
      nextReviewDate: day(nextReviewAt),
      policyVersion: policy.version,
      policyStatus: policy.status,
    };

    const approvalId = newId();
    const number = await nextNumber(tx, 'STA', 'seller-trading-approval');
    await tx.sellerTradingApproval.create({
      data: {
        id: approvalId,
        number,
        sellerAccountId: row.sellerAccountId,
        assessmentId: id,
        policyVersion: policy.version,
        policyStatusAtRelease: policy.status,
        externalCertificationId: cert.id,
        recordJson: toJsonValue(record),
        scoreTimesFive: score.scoreTimesFive,
        issuedAt: now,
        validUntil,
        nextReviewAt,
        releaseApproverUserId: actor.userId,
        supersedesId: row.kind === 'RENEWAL' ? row.baseApprovalId : null,
      },
    });
    await tx.sellerTradingApprovalScope.createMany({
      data: scope.map((s) => ({
        id: newId(),
        approvalId,
        sellerAccountId: row.sellerAccountId,
        scopeItemId: s.id,
        offerId: s.offerId,
        productKey: s.productKey,
        productVersion: s.productVersion,
        facilityRef: s.facilityRef,
        countryCode: s.countryCode,
        channel: s.channel,
        validUntil: s.authorisationExpiresOn !== null && s.authorisationExpiresOn < validUntil ? s.authorisationExpiresOn : validUntil,
        scheduleJson: toJsonValue({
          productAndVersion: `${s.productName} ${s.productVersion}`,
          manufacturerSite: s.facilityRef,
          countryAndChannel: `${s.countryCode} ${s.channel}`,
          regulatoryClassification: s.regulatoryClass,
          requiredTestsAndAuthorisations: `${s.requiredTests ?? ''} | ${s.authorisations ?? ''}`,
          localImporterOrResponsible: s.localResponsible,
          labelsAndLanguage: s.labelsLanguages,
          certificateValidityAndConditions: `${day(cert.issuedOn)} to ${day(cert.expiresOn)}; ${cert.surveillanceConditions ?? ''}`,
          insuranceAndShippingRestrictions: `${s.shippingInsurance ?? ''} | ${s.restrictions ?? ''}`,
          decision: 'APPROVED',
          reviewer: s.classifiedByUserId,
          nextReview: day(s.nextReviewAt ?? nextReviewAt),
        }),
      })),
    });

    const doc = await issueDocument(tx, {
      kind: 'SELLER_TRADING_APPROVAL',
      sellerAccountId: row.sellerAccountId,
      validUntil,
      signer: { userId: actor.userId, name: actor.fullName, role: 'Independent release approver' },
      scope: { approval: number, seller: seller.displayName, countries: record.approvedCountries, channels: record.channels, items: scope.length },
      facts: [
        ['Approval number', number],
        ['Seller', `${seller.legalName} (${row.sellerAccountId})`],
        ['Assessment', row.number],
        ['Policy version', `${policy.version} (${policy.status})`],
        ['Audit score', `${score.display} / 100`],
        ['Independent body and scheme', `${cert.bodyName} - ${cert.scheme}`],
        ['External certificate', `${cert.certificateNumber ?? '-'} issued by ${cert.issuer ?? '-'}, ${day(cert.issuedOn)} to ${day(cert.expiresOn)}`],
        ['Next review', day(nextReviewAt)],
      ],
      paragraphs: [
        'This is the marketplace operator\'s INTERNAL trading approval. It records that the operator\'s own assessment found the scope below eligible to be sold on its marketplace.',
        'It is not the external certificate, it is not issued by the independent body named above, and it is not a government, statutory or accreditation approval. The external certificate\'s dates and conditions are set by its issuer; this approval ends no later than that certificate and cannot extend it.',
        'Only the exact products, versions, sites, countries and channels listed are covered. Any other product, country, channel or site, and any pending extension, is not approved.',
      ],
      table: {
        columns: [{ header: 'Product / version', weight: 3 }, { header: 'Site', weight: 2 }, { header: 'Country', weight: 1 }, { header: 'Channel', weight: 1 }, { header: 'Valid until', weight: 2 }],
        rows: scope.map((s) => [`${s.productName} ${s.productVersion}`, s.facilityRef, s.countryCode, s.channel, day(s.authorisationExpiresOn !== null && s.authorisationExpiresOn < validUntil ? s.authorisationExpiresOn : validUntil)]),
      },
      detail: toJsonValue(record) as never,
    });
    await tx.sellerTradingApproval.update({ where: { id: approvalId }, data: { auditDocumentId: doc.id } });
    await moveAssessment(tx, row, 'RELEASED', { decision: 'RELEASED', decisionReason: input.reason, decidedByUserId: actor.userId, decidedAt: now, scoreTimesFive: score.scoreTimesFive, scoreBand: score.band });
    await writeEvent(tx, { sellerAccountId: row.sellerAccountId, assessmentId: id, subjectType: 'APPROVAL', subjectId: approvalId, kind: 'RELEASED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason: input.reason, policyVersion: policy.version, data: { number, scope: scope.length, validUntil: validUntil.toISOString(), document: doc.number } });
    await recordAudit({ action: AuditAction.SELLER_ASSESSMENT_RELEASED, resourceType: 'SellerTradingApproval', resourceId: approvalId, actorType: 'AUDIT', actorUserId: actor.userId, after: { number, assessment: row.number, scope: scope.length } }, tx);
    await notifySeller({ sellerAccountId: row.sellerAccountId, kind: 'SELLER_ASSESSMENT', title: `Trading approval ${number} issued`, body: `Approved for ${String(scope.length)} product, country and channel combinations until ${day(validUntil)}.`, linkPath: '/seller/assessment', tx });
    return { id: approvalId, number, document: doc.number };
  });
}

/** Decline (score below the remediation floor, a hard stop, or ineligibility) or send to remediation. */
export async function decide(actor: AssessmentActor, id: string, input: { decision: 'DECLINED' | 'REMEDIATION' | 'REASSESS'; reason: string; expectedVersion: number }) {
  const capability = requireCapability(actor, 'HEAD_OF_ASSURANCE', 'ASSESS');
  await prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    assertVersion(row, input.expectedVersion);
    const policy = await decisionPolicy(tx);
    const to = input.decision === 'REASSESS' ? 'IN_REVIEW' : input.decision;
    await moveAssessment(tx, row, to, input.decision === 'DECLINED' ? { decision: 'DECLINED', decisionReason: input.reason, decidedByUserId: actor.userId, decidedAt: new Date() } : {});
    await writeEvent(tx, { sellerAccountId: row.sellerAccountId, assessmentId: id, subjectType: 'ASSESSMENT', subjectId: id, kind: `DECISION_${input.decision}`, actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason: input.reason, policyVersion: policy.version });
    await notifySeller({ sellerAccountId: row.sellerAccountId, kind: 'SELLER_ASSESSMENT', title: `${row.number}: ${input.decision === 'DECLINED' ? 'declined' : 'remediation and reassessment'}`, body: input.reason.slice(0, 500), linkPath: '/seller/assessment', tx });
  });
}

// --- Reading ------------------------------------------------------------------

const QUEUE_STATUS: Record<string, string[]> = {
  draft: ['DRAFT'],
  submitted: ['SUBMITTED'],
  correction: ['CORRECTION_REQUESTED'],
  review: ['IN_REVIEW'],
  remediation: ['REMEDIATION'],
  released: ['RELEASED'],
  closed: ['DECLINED', 'WITHDRAWN'],
};

export async function listAssessments(q: { queue: string | null; search: string | null; ownerUserId: string | null; risk: string | null; overdue: boolean; expiringDays: number | null; page: number; pageSize: number }) {
  const now = new Date();
  const where = {
    ...(q.queue && QUEUE_STATUS[q.queue] ? { status: { in: QUEUE_STATUS[q.queue] } } : {}),
    ...(q.ownerUserId ? { ownerUserId: q.ownerUserId } : {}),
    ...(q.risk ? { riskLevel: q.risk } : {}),
    ...(q.overdue ? { reviewTargetAt: { lt: now }, status: { in: ['IN_REVIEW', 'SUBMITTED'] } } : {}),
    ...(q.search ? { OR: [{ number: { contains: q.search } }, { sellerAccount: { legalName: { contains: q.search } } }, { sellerAccount: { displayName: { contains: q.search } } }] } : {}),
    ...(q.expiringDays !== null ? { sellerAccount: { tradingApprovals: { some: { status: 'ACTIVE', validUntil: { lte: new Date(now.getTime() + q.expiringDays * 86_400_000) } } } } } : {}),
  };
  const [rows, total, counts] = await Promise.all([
    prisma.sellerAssessment.findMany({
      where,
      orderBy: [{ reviewTargetAt: 'asc' }, { createdAt: 'desc' }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: { sellerAccount: { select: { legalName: true, displayName: true } }, gates: { select: { gate: true, status: true } }, findings: { where: { status: { not: 'VERIFIED_CLOSED' } }, select: { classification: true } } },
    }),
    prisma.sellerAssessment.count({ where }),
    prisma.sellerAssessment.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);
  const owners = await prisma.auditStaffMember.findMany({ where: { userId: { in: rows.map((r) => r.ownerUserId).filter((v): v is string => v !== null) } }, select: { userId: true, fullName: true } });
  return {
    total,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    rows: rows.map((r) => ({
      id: r.id,
      number: r.number,
      kind: r.kind,
      status: r.status,
      seller: r.sellerAccount.displayName,
      legalName: r.sellerAccount.legalName,
      sellerAccountId: r.sellerAccountId,
      owner: owners.find((o) => o.userId === r.ownerUserId)?.fullName ?? null,
      riskLevel: r.riskLevel,
      policyVersion: r.policyVersion,
      gatesPassed: r.gates.filter((g) => g.status === 'PASSED').length,
      stage: r.gates.sort((a, b) => a.gate - b.gate).find((g) => g.status !== 'PASSED')?.gate ?? 8,
      reviewTargetAt: r.reviewTargetAt?.toISOString() ?? null,
      overdue: r.reviewTargetAt !== null && r.reviewTargetAt < now && ['IN_REVIEW', 'SUBMITTED'].includes(r.status),
      openFindings: { critical: r.findings.filter((f) => f.classification === 'CRITICAL').length, major: r.findings.filter((f) => f.classification === 'MAJOR').length, minor: r.findings.filter((f) => f.classification === 'MINOR').length },
      hardStops: Array.isArray(r.hardStopsJson) ? (r.hardStopsJson as unknown[]).length : 0,
      submittedAt: r.submittedAt?.toISOString() ?? null,
    })),
  };
}

export type Audience = 'AUDIT' | 'ADMIN' | 'SELLER';

/**
 * One assessment in full for Audit; a summary for Admin (no internal notes,
 * no identity or banking file names); the seller's own view (its own
 * application, what it must correct, findings to answer - never reviewer notes
 * or other parties' evidence).
 */
export async function readAssessment(id: string, audience: Audience, sellerAccountId?: string) {
  const row = await prisma.sellerAssessment.findFirst({
    where: { id, ...(sellerAccountId ? { sellerAccountId } : {}) },
    include: {
      sellerAccount: { select: { legalName: true, displayName: true, status: true, approvedAt: true } },
      gates: { orderBy: { gate: 'asc' } },
      checklist: { orderBy: { code: 'asc' } },
      scores: true,
      evidence: { orderBy: [{ evidenceKey: 'asc' }, { evidenceVersion: 'desc' }] },
      scopeItems: { orderBy: [{ productKey: 'asc' }, { countryCode: 'asc' }, { channel: 'asc' }] },
      findings: { orderBy: { raisedAt: 'asc' } },
      workpapers: { orderBy: { recordedAt: 'desc' } },
      certifications: { orderBy: { appointedAt: 'desc' } },
    },
  });
  if (row === null) throw notFound('Seller assessment');
  const { problems } = await problemsFor(prisma, row);
  const policy = await policyInForce(prisma);
  const score = computeScore(Object.fromEntries(row.scores.map((s) => [s.dimension, s.rating])), policy.config);
  const approvals = await prisma.sellerTradingApproval.findMany({ where: { sellerAccountId: row.sellerAccountId }, orderBy: { issuedAt: 'desc' }, include: { scopes: true } });
  const events = audience === 'SELLER' ? [] : await prisma.sellerAssessmentEvent.findMany({ where: { OR: [{ assessmentId: id }, { sellerAccountId: row.sellerAccountId, assessmentId: null }] }, orderBy: { createdAt: 'asc' }, take: 500 });
  const userIds = [...new Set([...events.map((e) => e.actorUserId), ...row.checklist.map((c) => c.reviewerUserId), ...row.checklist.map((c) => c.naApprovedByUserId), ...row.scores.map((s) => s.ratedByUserId), row.ownerUserId, ...row.gates.map((g) => g.assignedUserId), ...row.gates.map((g) => g.decidedByUserId)].filter((v): v is string => typeof v === 'string'))];
  const staff = await prisma.auditStaffMember.findMany({ where: { userId: { in: userIds } }, select: { userId: true, fullName: true } });
  const name = (uid: string | null | undefined) => (uid ? staff.find((s) => s.userId === uid)?.fullName ?? (audience === 'AUDIT' ? uid : 'Reviewer') : null);
  const withheldForAdmin = new Set(['IDENTITY', 'OWNERSHIP', 'BANKING']);
  const evidence = row.evidence.filter((e) => audience !== 'SELLER' || e.uploadedByRole === 'SELLER');
  const view = {
    id: row.id,
    number: row.number,
    kind: row.kind,
    status: row.status,
    version: row.version,
    applicationRevision: row.applicationRevision,
    policyVersion: row.policyVersion,
    policyInForce: { version: policy.version, status: policy.status },
    seller: { id: row.sellerAccountId, legalName: row.sellerAccount.legalName, displayName: row.sellerAccount.displayName, accountStatus: row.sellerAccount.status, legacyApprovedAt: row.sellerAccount.approvedAt?.toISOString() ?? null },
    application: audience === 'ADMIN' ? null : row.applicationJson,
    applicationProblems: problems,
    correctionNote: row.correctionNote,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    fileCompleteAt: row.fileCompleteAt?.toISOString() ?? null,
    reviewTargetAt: row.reviewTargetAt?.toISOString() ?? null,
    owner: name(row.ownerUserId),
    ownerUserId: audience === 'AUDIT' ? row.ownerUserId : null,
    riskLevel: row.riskLevel,
    legacyNote: row.legacyNote,
    decision: row.decision,
    decisionReason: row.decisionReason,
    hardStops: row.hardStopsJson ?? [],
    gates: row.gates.map((g) => ({ gate: g.gate, status: g.status, reason: audience === 'SELLER' && g.status !== 'CORRECTION_REQUESTED' ? null : g.reason, assignedTo: audience === 'SELLER' ? null : name(g.assignedUserId), assignedUserId: audience === 'AUDIT' ? g.assignedUserId : null, decidedBy: audience === 'SELLER' ? null : name(g.decidedByUserId), decidedAt: g.decidedAt?.toISOString() ?? null, policyVersion: g.policyVersion })),
    checklist: audience === 'SELLER' ? [] : row.checklist.map((c) => ({ code: c.code, text: CHECKLIST.find((i) => i.code === c.code)?.text ?? '', gate: CHECKLIST.find((i) => i.code === c.code)?.gate ?? null, naAllowed: CHECKLIST.find((i) => i.code === c.code)?.naAllowed ?? false, outcome: c.outcome, evidenceRef: c.evidenceRef, reviewer: name(c.reviewerUserId), reviewedAt: c.reviewedAt?.toISOString() ?? null, expiresOn: c.expiresOn?.toISOString().slice(0, 10) ?? null, comment: audience === 'AUDIT' ? c.comment : null, naReason: c.naReason, naApprovedBy: name(c.naApprovedByUserId), naApprovedAt: c.naApprovedAt?.toISOString() ?? null })),
    score: audience === 'SELLER' ? null : {
      display: score.display,
      band: score.band,
      belowDimensionMinimum: score.belowDimensionMinimum,
      dimensions: DIMENSIONS.map((d) => {
        const s = row.scores.find((x) => x.dimension === d.code);
        return { code: d.code, label: d.label, weight: d.weight, evidenceNeeded: d.evidence, rating: s?.rating ?? null, contribution: s === undefined ? null : ((d.weight * s.rating) / 5).toFixed(1), evidenceRef: s?.evidenceRef ?? null, reasoning: audience === 'AUDIT' ? s?.reasoning ?? null : null, ratedBy: name(s?.ratedByUserId), ratedAt: s?.ratedAt.toISOString() ?? null };
      }),
      thresholds: { release: policy.config.releaseScoreMinimum, remediation: policy.config.remediationScoreMinimum, dimension: policy.config.dimensionRatingMinimum },
    },
    evidence: evidence.map((e) => ({ id: e.id, category: e.category, evidenceKey: e.evidenceKey, label: e.label, version: e.evidenceVersion, fileName: audience === 'ADMIN' && withheldForAdmin.has(e.category) ? null : e.fileName, contentType: e.contentType, byteSize: e.byteSize, uploadedByRole: e.uploadedByRole, scanState: e.scanState, retentionCategory: e.retentionCategory, legalHold: e.legalHold, createdAt: e.createdAt.toISOString(), downloadable: !(audience === 'ADMIN' && withheldForAdmin.has(e.category)) })),
    scope: row.scopeItems.map((s) => ({ id: s.id, productKey: s.productKey, offerId: s.offerId, productName: s.productName, productVersion: s.productVersion, intendedUse: s.intendedUse, facilityRef: s.facilityRef, countryCode: s.countryCode, channel: s.channel, decision: s.decision, ...(audience === 'SELLER' ? {} : { catalogueCategory: s.catalogueCategory, hsProposal: s.hsProposal, regulatoryClass: s.regulatoryClass, requiredTests: s.requiredTests, authorisations: s.authorisations, authorisationExpiresOn: s.authorisationExpiresOn?.toISOString().slice(0, 10) ?? null, localResponsible: s.localResponsible, importerLicence: s.importerLicence, labelsLanguages: s.labelsLanguages, warnings: s.warnings, restrictions: s.restrictions, recallObligations: s.recallObligations, shippingInsurance: s.shippingInsurance, decisionReason: s.decisionReason, classifiedAt: s.classifiedAt?.toISOString() ?? null, nextReviewAt: s.nextReviewAt?.toISOString() ?? null }) })),
    findings: row.findings.map((f) => ({ id: f.id, number: f.number, classification: f.classification, requirement: f.requirement, evidence: f.evidence, containment: f.containment, rootCause: f.rootCause, correctiveAction: f.correctiveAction, preventiveAction: f.preventiveAction, ownerName: f.ownerName, raisedAt: f.raisedAt.toISOString(), containmentDueAt: f.containmentDueAt?.toISOString() ?? null, planDueAt: f.planDueAt?.toISOString() ?? null, closureDueAt: f.closureDueAt.toISOString(), overdue: f.status !== 'VERIFIED_CLOSED' && f.closureDueAt.getTime() < Date.now(), status: f.status, closureEvidenceIds: f.closureEvidenceIdsJson ?? [], effectivenessVerification: f.effectivenessVerification, closedAt: f.closedAt?.toISOString() ?? null, version: f.version })),
    workpapers: audience === 'SELLER' ? [] : row.workpapers.map((w) => ({ id: w.id, kind: w.kind, subjectRef: w.subjectRef, mode: w.mode, revision: w.revision, supersedesId: w.supersedesId, payload: audience === 'AUDIT' || !['IDENTITY_CHECK', 'BANK_VERIFICATION', 'SANCTIONS_SCREENING'].includes(w.kind) ? w.payloadJson : null, recordedBy: name(w.recordedByUserId), recordedAt: w.recordedAt.toISOString() })),
    certifications: row.certifications.map((c) => ({ id: c.id, bodyName: c.bodyName, scheme: c.scheme, status: c.status, certificateNumber: c.certificateNumber, issuer: c.issuer, issuedOn: c.issuedOn?.toISOString().slice(0, 10) ?? null, expiresOn: c.expiresOn?.toISOString().slice(0, 10) ?? null, ...(audience === 'SELLER' ? {} : { procurementRef: c.procurementRef, paymentRef: c.paymentRef, accreditationBody: c.accreditationBody, accreditationNumber: c.accreditationNumber, accreditationVerified: c.accreditationVerified, sectorScope: c.sectorScope, legalRecognition: c.legalRecognition, conflictCheck: c.conflictCheck, independenceVerified: c.independenceVerified, facilityRefs: c.facilityRefsJson ?? [], productKeys: c.productKeysJson ?? [], authenticityMethod: c.authenticityMethod, authenticityReference: c.authenticityReference, authenticatedAt: c.authenticatedAt?.toISOString() ?? null, surveillanceConditions: c.surveillanceConditions, statusReason: c.statusReason, version: c.version }) })),
    approvals: approvals.map((a) => ({ id: a.id, number: a.number, status: a.status, assessmentId: a.assessmentId, issuedAt: a.issuedAt.toISOString(), validUntil: a.validUntil.toISOString(), nextReviewAt: a.nextReviewAt.toISOString(), policyVersion: a.policyVersion, policyStatusAtRelease: a.policyStatusAtRelease, score: (a.scoreTimesFive / 5).toFixed(2), statusReason: a.statusReason, auditDocumentId: a.auditDocumentId, record: audience === 'AUDIT' ? a.recordJson : null, scopes: a.scopes.map((s) => ({ id: s.id, productKey: s.productKey, productVersion: s.productVersion, offerId: s.offerId, facilityRef: s.facilityRef, countryCode: s.countryCode, channel: s.channel, status: s.status, validUntil: s.validUntil.toISOString(), blockedReason: s.blockedReason })) })),
    timeline: events.map((e) => ({ id: e.id, kind: e.kind, subjectType: e.subjectType, actor: e.actorRole === 'SELLER' ? 'Seller' : e.actorRole === 'SYSTEM' ? 'System' : name(e.actorUserId), actorRole: e.actorRole, capability: e.capability, reason: audience === 'AUDIT' ? e.reason : null, policyVersion: e.policyVersion, evidenceRefs: e.evidenceRefsJson ?? [], data: audience === 'AUDIT' ? e.dataJson : null, at: e.createdAt.toISOString() })),
  };
  return view;
}

export async function evidenceRow(id: string, where: { assessmentId?: string; sellerAccountId?: string; uploadedByRole?: string; notCategories?: string[] }) {
  const row = await prisma.sellerAssessmentEvidence.findFirst({
    where: { id, ...(where.assessmentId ? { assessmentId: where.assessmentId } : {}), ...(where.sellerAccountId ? { sellerAccountId: where.sellerAccountId } : {}), ...(where.uploadedByRole ? { uploadedByRole: where.uploadedByRole } : {}), ...(where.notCategories ? { category: { notIn: where.notCategories } } : {}) },
  });
  if (row === null) throw notFound('Evidence');
  return row;
}
