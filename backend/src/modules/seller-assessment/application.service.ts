/**
 * Gate 1: the seller's application, saved and resumed section by section,
 * submitted, returned for correction, and accepted as a complete file.
 *
 * An incomplete file never grants trading access - nothing in here touches a
 * trading approval. Accepting the file only starts the review clock (a
 * five-business-day service target, never a promise of approval) and lays out
 * the scope matrix Gate 3 will classify.
 */
import { z } from 'zod';
import {
  applicationProblems,
  addBusinessDays,
  canMoveAssessment,
  CHECKLIST,
  DIMENSIONS,
  GATES,
  INELIGIBLE_PROBLEMS,
  isSingleCountryCode,
  REVIEWABLE,
  SELLER_EDITABLE,
  type ApplicationFacts,
  type AssessmentStatus,
} from '../../domain/seller-assessment.js';
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { notifySeller } from '../seller/notification.service.js';
import {
  latestEvidence,
  loadAssessment,
  nextNumber,
  notAllowed,
  policyInForce,
  requireCapability,
  storeEvidence,
  toJsonValue,
  writeEvent,
  assertVersion,
  type AssessmentActor,
  type Client,
  type EvidenceCategory,
  type SellerActor,
} from './context.js';

const text = (max: number) => z.string().trim().max(max);
const opt = (max: number) => text(max).nullable().optional();
const key = z.string().trim().regex(/^[a-z0-9][a-z0-9._:-]{0,63}$/i).nullable().optional();
const country = z.string().trim().toUpperCase().length(2);
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();
const address = z.object({ line1: text(255), line2: opt(255), city: text(120), state: text(120), postcode: text(16), country }).partial();

/** The application form. Every section optional while saving; completeness is judged by the domain rules. */
export const applicationSchema = z
  .object({
    applicantType: z.enum(['MANUFACTURER', 'BRAND_OWNER', 'TRADER', 'UNAUTHORISED_DISTRIBUTOR', 'RESELLER', 'INDIVIDUAL', 'DROPSHIPPER']).nullable(),
    entity: z.object({ legalName: text(255), registrationNumber: text(64), entityType: text(48), incorporatedOn: isoDay, country, registeredAddress: address, operatingAddresses: z.array(address).max(10) }).partial(),
    directors: z.array(z.object({ name: text(160), din: opt(16), designation: opt(80) })).max(30),
    beneficialOwners: z.array(z.object({ name: text(160), nationality: country.nullable().optional(), ownershipPercent: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/), controlling: z.boolean() })).max(30),
    signatory: z.object({ name: text(160), designation: text(80), isDirector: z.boolean(), delegationEvidenceKey: key }).partial(),
    financial: z
      .object({
        financialYearStart: isoDay,
        financialYearEnd: isoDay,
        revenueMinor: z.string().regex(/^\d{1,18}$/).nullable(),
        currency: z.string().trim().toUpperCase().length(3),
        measure: z.enum(['ENTITY_REVENUE_FROM_OPERATIONS_EX_GST', 'GROUP', 'FORECAST', 'UNAUDITED_GTV']),
        basis: z.enum(['AUDITED_LATEST', 'PRECEDING_AUDIT_PLUS_CA_CERTIFIED']),
        auditedStatementsKey: key,
        caConfirmationKey: key,
        precedingAuditKey: key,
        solvencyNote: opt(2000),
        creditReferences: opt(2000),
      })
      .partial(),
    taxIds: z.object({ pan: opt(10), gstin: opt(15), iec: opt(10), licences: z.array(z.object({ kind: text(120), number: text(120), issuer: text(160), expiresOn: isoDay, evidenceKey: key })).max(40) }).partial(),
    bank: z.object({ beneficiaryName: text(255), accountLast4: z.string().regex(/^\d{4}$/), bankCode: text(16), evidenceKey: key }).partial(),
    brands: z.array(z.object({ ref: text(32), name: text(160), trademarkNumber: opt(64), rightsBasis: z.enum(['OWNED', 'LICENSED']), evidenceKey: key })).max(30),
    facilities: z
      .array(
        z.object({
          ref: text(32),
          name: text(160),
          address: address,
          countryCode: country,
          ownedByApplicant: z.boolean(),
          processes: text(2000),
          agreementEvidenceKey: key,
          qualityAgreementEvidenceKey: key,
          sellerFactoryId: z.string().length(26).nullable().optional(),
        }),
      )
      .max(30),
    outsourced: z.array(z.object({ process: text(255), provider: text(255), countryCode: country, critical: z.boolean(), facilityRef: opt(32) })).max(40),
    products: z
      .array(
        z.object({
          key: z.string().trim().regex(/^[A-Za-z0-9._:-]{1,64}$/),
          name: text(255),
          version: text(64),
          sku: opt(64),
          offerId: z.string().length(26).nullable().optional(),
          intendedUse: text(2000),
          composition: opt(2000),
          brandRef: opt(32),
          facilityRef: text(32),
          madeInCountry: country,
          countries: z.array(country).max(60),
          channels: z.array(z.enum(['B2B', 'B2C'])).max(2),
        }),
      )
      .max(200),
    fulfilment: z
      .object({
        model: z.enum(['SELLER_FULFILLED', 'MARKETPLACE_FULFILLED', 'MIXED']),
        monthlyCapacity: opt(255),
        leadTimeDays: z.number().int().min(0).max(365).nullable().optional(),
        afterSales: opt(2000),
        insurance: z.array(z.object({ kind: z.enum(['PRODUCT_LIABILITY', 'RECALL', 'CARGO', 'OPERATIONAL']), insurer: text(160), policyNumber: text(64), limitMinor: z.string().regex(/^\d{1,18}$/), currency: z.string().length(3), territories: text(512), expiresOn: isoDay, evidenceKey: key })).max(10),
      })
      .partial(),
    consent: z.object({ personalDataChecks: z.boolean(), auditAccess: z.boolean() }).partial(),
  })
  .partial();

export type Application = z.infer<typeof applicationSchema>;

function asApplication(json: unknown): Application {
  const parsed = applicationSchema.safeParse(json ?? {});
  return parsed.success ? parsed.data : {};
}

/** The domain facts behind Gate 1, with evidence checked against what was actually uploaded. */
export function factsOf(app: Application, evidenceKeys: ReadonlySet<string>): ApplicationFacts {
  const has = (k: string | null | undefined) => typeof k === 'string' && evidenceKeys.has(k);
  const e = app.entity ?? {};
  const ra = e.registeredAddress ?? {};
  const fin = app.financial ?? {};
  return {
    applicantType: app.applicantType ?? null,
    entityCountry: e.country ?? null,
    legalEntityComplete: Boolean(e.legalName && e.registrationNumber && e.entityType),
    addressesComplete: Boolean(ra.line1 && ra.city && ra.postcode && ra.country) && (e.operatingAddresses ?? []).length > 0,
    directors: (app.directors ?? []).length,
    beneficialOwners: (app.beneficialOwners ?? []).length,
    signatoryNamed: Boolean(app.signatory?.name),
    delegationNeeded: app.signatory?.isDirector === false,
    delegationEvidence: has(app.signatory?.delegationEvidenceKey),
    panGstPresent: Boolean(app.taxIds?.pan && app.taxIds.gstin),
    bankPresent: Boolean(app.bank?.beneficiaryName && app.bank.accountLast4 && has(app.bank.evidenceKey)),
    brands: (app.brands ?? []).map((b) => ({ rightsEvidence: has(b.evidenceKey) })),
    facilities: (app.facilities ?? []).map((f) => ({ countryCode: f.countryCode, ownedByApplicant: f.ownedByApplicant, agreementEvidence: has(f.agreementEvidenceKey) && has(f.qualityAgreementEvidenceKey) })),
    outsourced: (app.outsourced ?? []).map((o) => ({ countryCode: o.countryCode, critical: o.critical })),
    auditAccessGranted: app.consent?.auditAccess === true,
    products: (app.products ?? []).map((p) => ({ madeInCountry: p.madeInCountry, countries: p.countries.length, channels: p.channels.length, facilityDeclared: (app.facilities ?? []).some((f) => f.ref === p.facilityRef) })),
    fulfilmentDeclared: Boolean(app.fulfilment?.model),
    insuranceDeclared: (app.fulfilment?.insurance ?? []).some((i) => has(i.evidenceKey)),
    personalDataConsent: app.consent?.personalDataChecks === true,
    turnover: {
      amountMinor: fin.revenueMinor ? BigInt(fin.revenueMinor) : null,
      currency: fin.currency ?? null,
      measure: fin.measure ?? null,
      basis: fin.basis ?? null,
      auditedStatementsEvidence: has(fin.auditedStatementsKey),
      caConfirmationEvidence: has(fin.caConfirmationKey),
      precedingAuditEvidence: has(fin.precedingAuditKey),
    },
  };
}

export async function problemsFor(client: Client, assessment: { id: string; applicationJson: unknown }) {
  const policy = await policyInForce(client);
  const evidence = await latestEvidence(client, assessment.id);
  const app = asApplication(assessment.applicationJson);
  const problems = applicationProblems(factsOf(app, new Set(evidence.keys())), policy.config);
  return { problems, ineligible: problems.filter((p) => INELIGIBLE_PROBLEMS.has(p)), app };
}

async function move(client: Client, row: { id: string; status: string; version: number }, to: AssessmentStatus, data: Record<string, unknown> = {}) {
  if (!canMoveAssessment(row.status, to)) notAllowed(`An assessment that is ${row.status} cannot become ${to}.`);
  const updated = await client.sellerAssessment.updateMany({ where: { id: row.id, version: row.version }, data: { ...data, status: to, version: { increment: 1 } } });
  if (updated.count !== 1) notAllowed('This assessment changed at the same time. Reload and try again.', [{ field: 'expectedVersion', code: 'STALE' }]);
}

export { move as moveAssessment };

// --- Seller -------------------------------------------------------------------

/** The seller's current open assessment, or the most recent one. */
export async function sellerAssessment(seller: SellerActor) {
  return prisma.sellerAssessment.findFirst({ where: { sellerAccountId: seller.sellerAccountId }, orderBy: { createdAt: 'desc' } });
}

/** Start an application (or an extension / renewal of a current approval). One open assessment at a time. */
export async function startApplication(seller: SellerActor, kind: 'INITIAL' | 'EXTENSION' | 'RENEWAL' | 'REASSESSMENT') {
  return prisma.$transaction(async (tx) => {
    const open = await tx.sellerAssessment.findFirst({ where: { sellerAccountId: seller.sellerAccountId, status: { in: ['DRAFT', 'SUBMITTED', 'CORRECTION_REQUESTED', 'IN_REVIEW', 'REMEDIATION'] } } });
    if (open !== null) return open;
    const base = kind === 'INITIAL' ? null : await tx.sellerTradingApproval.findFirst({ where: { sellerAccountId: seller.sellerAccountId }, orderBy: { issuedAt: 'desc' } });
    if (kind !== 'INITIAL' && kind !== 'REASSESSMENT' && base === null) notAllowed('There is no trading approval to extend or renew. Start an initial application.');
    const previous = await tx.sellerAssessment.findFirst({ where: { sellerAccountId: seller.sellerAccountId }, orderBy: { createdAt: 'desc' }, select: { applicationJson: true } });
    const policy = await policyInForce(tx);
    const id = newId();
    await tx.sellerAssessment.create({
      data: {
        id,
        number: await nextNumber(tx, 'SAO', 'seller-assessment'),
        sellerAccountId: seller.sellerAccountId,
        kind,
        policyVersion: policy.version,
        // A renewal or extension starts from the last application; the seller corrects it.
        applicationJson: toJsonValue(previous?.applicationJson ?? {}),
        baseApprovalId: base?.id ?? null,
      },
    });
    await seedRows(tx, id);
    await writeEvent(tx, { sellerAccountId: seller.sellerAccountId, assessmentId: id, subjectType: 'ASSESSMENT', subjectId: id, kind: 'CREATED', actorUserId: seller.profileId, actorRole: 'SELLER', policyVersion: policy.version, data: { kind } });
    return tx.sellerAssessment.findUniqueOrThrow({ where: { id } });
  });
}

/** The eight gates, the 23 checklist items. Untouched means unreviewed. */
export async function seedRows(tx: Client, assessmentId: string): Promise<void> {
  await tx.sellerAssessmentGate.createMany({ data: GATES.map((gate) => ({ id: newId(), assessmentId, gate })) });
  await tx.sellerAssessmentChecklistItem.createMany({ data: CHECKLIST.map((item) => ({ id: newId(), assessmentId, code: item.code })) });
}

async function sellerOwned(seller: SellerActor, id: string) {
  const row = await prisma.sellerAssessment.findFirst({ where: { id, sellerAccountId: seller.sellerAccountId } });
  if (row === null) throw notFound('Seller assessment');
  return row;
}

/** Save one or more sections. Allowed only while the seller holds the file. */
export async function saveApplication(seller: SellerActor, id: string, input: { patch: unknown; expectedRevision: number }) {
  const parsed = applicationSchema.safeParse(input.patch);
  if (!parsed.success) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Some answers are not valid.', parsed.error.issues.slice(0, 30).map((i) => ({ field: i.path.join('.'), code: i.code.toUpperCase() })));
  }
  for (const p of parsed.data.products ?? []) {
    for (const c of p.countries) if (!isSingleCountryCode(c)) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Name each destination country on its own; a region is not a country.', [{ field: 'products.countries', code: 'NOT_A_COUNTRY' }]);
  }
  const row = await sellerOwned(seller, id);
  if (!SELLER_EDITABLE.includes(row.status as AssessmentStatus)) notAllowed('The application can be changed only while it is a draft or returned for correction.');
  const merged = { ...asApplication(row.applicationJson), ...parsed.data };
  const updated = await prisma.sellerAssessment.updateMany({
    where: { id, applicationRevision: input.expectedRevision },
    data: { applicationJson: toJsonValue(merged), applicationRevision: { increment: 1 } },
  });
  if (updated.count !== 1) notAllowed('The application was saved somewhere else. Reload to see the latest answers.', [{ field: 'expectedRevision', code: 'STALE' }]);
  return { revision: input.expectedRevision + 1 };
}

export async function uploadSellerEvidence(seller: SellerActor, id: string, input: { category: EvidenceCategory; evidenceKey: string; label: string; fileName: string; bytes: Buffer }) {
  const row = await sellerOwned(seller, id);
  const open: string[] = [...SELLER_EDITABLE, ...REVIEWABLE];
  if (!open.includes(row.status)) notAllowed('This assessment is closed.');
  return prisma.$transaction(async (tx) => {
    const stored = await storeEvidence(tx, { assessmentId: id, sellerAccountId: seller.sellerAccountId, ...input, uploadedByUserId: seller.profileId, uploadedByRole: 'SELLER' });
    await writeEvent(tx, { sellerAccountId: seller.sellerAccountId, assessmentId: id, subjectType: 'EVIDENCE', subjectId: stored.id, kind: 'EVIDENCE_ADDED', actorUserId: seller.profileId, actorRole: 'SELLER', evidenceRefs: [`${input.evidenceKey}@v${String(stored.evidenceVersion)}`] });
    return stored;
  });
}

/** Submit. Gaps are reported, not hidden; an ineligible applicant is told why. */
export async function submitApplication(seller: SellerActor, id: string) {
  const row = await sellerOwned(seller, id);
  const { problems, ineligible } = await problemsFor(prisma, row);
  if (problems.length > 0) {
    notAllowed(ineligible.length > 0 ? 'This application is not eligible under the seller assessment policy.' : 'The application is not complete yet.', problems.map((p) => ({ field: 'application', code: p })));
  }
  await prisma.$transaction(async (tx) => {
    await move(tx, row, 'SUBMITTED', { submittedAt: new Date(), correctionNote: null });
    await writeEvent(tx, { sellerAccountId: row.sellerAccountId, assessmentId: id, subjectType: 'ASSESSMENT', subjectId: id, kind: 'SUBMITTED', actorUserId: seller.profileId, actorRole: 'SELLER', policyVersion: row.policyVersion, data: { revision: row.applicationRevision } });
  });
}

// --- Audit: Gate 1 ------------------------------------------------------------

/** Return the file to the seller with a reason they can act on. Nothing is traded meanwhile. */
export async function requestCorrection(actor: AssessmentActor, id: string, input: { note: string; expectedVersion?: number }) {
  const capability = requireCapability(actor, 'ASSESS', 'HEAD_OF_ASSURANCE');
  await prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    assertVersion(row, input.expectedVersion);
    await move(tx, row, 'CORRECTION_REQUESTED', { correctionNote: input.note });
    await tx.sellerAssessmentGate.updateMany({ where: { assessmentId: id, gate: 1 }, data: { status: 'CORRECTION_REQUESTED', reason: input.note, decidedByUserId: actor.userId, decidedAt: new Date(), policyVersion: row.policyVersion } });
    await writeEvent(tx, { sellerAccountId: row.sellerAccountId, assessmentId: id, subjectType: 'GATE', kind: 'GATE_DECIDED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason: input.note, policyVersion: row.policyVersion, data: { gate: 1, status: 'CORRECTION_REQUESTED' } });
    await notifySeller({ sellerAccountId: row.sellerAccountId, kind: 'SELLER_ASSESSMENT', title: `${row.number}: corrections requested`, body: input.note.slice(0, 500), linkPath: '/seller/assessment', tx });
  });
}

/**
 * Accept a complete file (Gate 1 passed). Starts the five-business-day review
 * target and lays out one scope row per product x country x channel.
 */
export async function acceptFile(actor: AssessmentActor, id: string, input: { reason: string; expectedVersion?: number }) {
  const capability = requireCapability(actor, 'ASSESS', 'HEAD_OF_ASSURANCE');
  await prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    assertVersion(row, input.expectedVersion);
    const { problems, app } = await problemsFor(tx, row);
    if (problems.length > 0) notAllowed('Gate 1 cannot pass while the application has gaps.', problems.map((p) => ({ field: 'application', code: p })));
    const policy = await policyInForce(tx);
    const now = new Date();
    await move(tx, row, 'IN_REVIEW', { fileCompleteAt: now, reviewTargetAt: addBusinessDays(now, policy.config.adminReviewTargetBusinessDays) });
    await tx.sellerAssessmentGate.updateMany({ where: { assessmentId: id, gate: 1 }, data: { status: 'PASSED', reason: input.reason, decidedByUserId: actor.userId, decidedAt: now, policyVersion: row.policyVersion } });
    const rows = (app.products ?? []).flatMap((p) =>
      p.countries.flatMap((c) =>
        p.channels.map((channel) => ({
          id: newId(),
          assessmentId: id,
          productKey: p.offerId ? `offer:${p.offerId}` : `sku:${p.key}`,
          offerId: p.offerId ?? null,
          productName: p.name,
          productVersion: p.version,
          intendedUse: p.intendedUse,
          facilityRef: p.facilityRef,
          countryCode: c,
          channel,
        })),
      ),
    );
    await tx.sellerAssessmentScopeItem.createMany({ data: rows, skipDuplicates: true });
    await writeEvent(tx, { sellerAccountId: row.sellerAccountId, assessmentId: id, subjectType: 'GATE', kind: 'GATE_DECIDED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason: input.reason, policyVersion: row.policyVersion, data: { gate: 1, status: 'PASSED', scopeRows: rows.length } });
  });
}

export const DIMENSION_CODES = DIMENSIONS.map((d) => d.code);
