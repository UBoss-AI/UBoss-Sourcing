/**
 * Documents the Audit Team issues:
 *
 *  - Seller Verification Certificate (after final verification approval)
 *  - Shipment Assessment Certificate (after a passed, QA-approved round)
 *  - Shipment Assessment Waiver / Release Authorization (after an approved waiver)
 *  - Failed / Held Assessment Report (a findings report, never a pass)
 *
 * Each has a unique number, an immutable PDF with a SHA-256, a QR to the
 * public status check, and a sign-off record naming the person, role and time.
 * That sign-off is NOT a cryptographic signature and every PDF says so.
 * A correction is a new row (version + 1, `supersedesId`); the old PDF stays.
 */
import { createHash } from 'node:crypto';
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { certificateValidUntil, SIGNING_MECHANISM, samplingStatement, scopeStatement, waiverStatement } from '../../domain/shipment-assessment.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { storage } from '../../infra/storage/index.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { qrPng, verificationUrl } from '../documents/document-format.js';
import { PdfBuilder } from '../documents/pdf.js';
import { getMarketplaceName } from '../settings/marketplace-name.js';
import { activePolicy, nextNumber, type Client } from './context.js';

export type Kind = 'SELLER_VERIFICATION_CERTIFICATE' | 'SELLER_TRADING_APPROVAL' | 'SHIPMENT_ASSESSMENT_CERTIFICATE' | 'SHIPMENT_WAIVER_AUTHORIZATION' | 'SHIPMENT_FINDINGS_REPORT';

const TITLES: Record<Kind, string> = {
  SELLER_TRADING_APPROVAL: 'Seller Trading Approval (internal marketplace approval)',
  SELLER_VERIFICATION_CERTIFICATE: 'Seller Verification Certificate',
  SHIPMENT_ASSESSMENT_CERTIFICATE: 'Shipment Assessment Certificate',
  SHIPMENT_WAIVER_AUTHORIZATION: 'Shipment Assessment Waiver / Release Authorization',
  SHIPMENT_FINDINGS_REPORT: 'Shipment Assessment Findings Report',
};

export interface Signer {
  userId: string;
  name: string;
  role: string;
}

interface IssueInput {
  kind: Kind;
  sellerAccountId: string;
  assessmentId?: string | null;
  round?: number | null;
  releaseId?: string | null;
  validUntil?: Date | null;
  dispatchBy?: Date | null;
  signer: Signer;
  /** Minimal public scope for the verification page. */
  scope: Prisma.InputJsonObject;
  facts: [string, string][];
  paragraphs: string[];
  table?: { columns: { header: string; weight: number }[]; rows: string[][] } | null;
  detail: Prisma.InputJsonObject;
  supersedesId?: string | null;
}

function day(value: Date | null | undefined): string {
  return value === null || value === undefined ? '-' : value.toISOString().slice(0, 10);
}

/** Render, store and record one document. Inside the decision's transaction. */
export async function issueDocument(tx: PrismaTransaction, input: IssueInput): Promise<{ id: string; number: string }> {
  const number = await nextNumber(tx, 'AC', 'audit-document');
  const issuedAt = new Date();
  const marketplace = await getMarketplaceName(tx);
  const previous = input.supersedesId === null || input.supersedesId === undefined ? null : await tx.auditDocument.findUnique({ where: { id: input.supersedesId } });

  const pdf = new PdfBuilder({ title: TITLES[input.kind], issuedAt, author: marketplace, subject: TITLES[input.kind], reference: number, watermark: null });
  pdf.title(TITLES[input.kind], `${marketplace} - ${scopeStatement(marketplace)}`, number);
  pdf.facts(
    [
      ['Document number', number],
      ['Version', String((previous?.version ?? 0) + 1)],
      ['Issued', issuedAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'],
      ...(input.validUntil ? ([['Valid until', day(input.validUntil)]] as [string, string][]) : []),
      ...(input.dispatchBy ? ([['Dispatch by', day(input.dispatchBy)]] as [string, string][]) : []),
      ...(previous === null ? [] : ([['Supersedes', previous.number]] as [string, string][])),
      ...input.facts,
    ],
    2,
  );
  for (const text of input.paragraphs) pdf.paragraph(text);
  if (input.table && input.table.rows.length > 0) pdf.table(input.table.columns, input.table.rows);
  pdf.paragraph('This document makes no claim of ISO certification, government approval or accredited inspection.', { muted: true });
  pdf.paragraph(SIGNING_MECHANISM, { muted: true, size: 7 });
  const url = verificationUrl('audit-document', number);
  pdf.closing({
    qrPng: await qrPng(url),
    qrCaption: 'Scan to check the current status',
    signatures: [{ heading: 'Issued by (authorised sign-off)', lines: [input.signer.name, input.signer.role, issuedAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'] }],
  });
  const { bytes, pageCount } = await pdf.finish();
  const stored = await storage.put(bytes, 'application/pdf', 'pdf', 'private');

  const id = newId();
  await tx.auditDocument.create({
    data: {
      id,
      number,
      kind: input.kind,
      version: (previous?.version ?? 0) + 1,
      supersedesId: previous?.id ?? null,
      status: 'ACTIVE',
      sellerAccountId: input.sellerAccountId,
      assessmentId: input.assessmentId ?? null,
      round: input.round ?? null,
      releaseId: input.releaseId ?? null,
      scopeJson: { title: TITLES[input.kind], marketplace, ...input.scope },
      detailJson: input.detail,
      issuedAt,
      validUntil: input.validUntil ?? null,
      dispatchBy: input.dispatchBy ?? null,
      signedByUserId: input.signer.userId,
      signedByName: input.signer.name.slice(0, 160),
      signedByRole: input.signer.role.slice(0, 48),
      signingMechanism: SIGNING_MECHANISM.slice(0, 255),
      storageKey: stored.storageKey,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      byteSize: bytes.length,
      pageCount,
    },
  });
  if (previous !== null) {
    await tx.auditDocument.update({ where: { id: previous.id }, data: { status: 'SUPERSEDED', statusChangedAt: issuedAt } });
  }
  await recordAudit(
    { action: AuditAction.AUDIT_DOCUMENT_ISSUED, resourceType: 'AuditDocument', resourceId: id, actorType: 'AUDIT', actorUserId: input.signer.userId, after: { number, kind: input.kind, supersedes: previous?.number ?? null } },
    tx,
  );
  return { id, number };
}

/** The status a reader sees: an ACTIVE document past its date is EXPIRED, whatever the sweep has done. */
export function effectiveStatus(row: { status: string; validUntil: Date | null; dispatchBy: Date | null }, now = new Date()): string {
  if (row.status !== 'ACTIVE') return row.status;
  const end = row.validUntil ?? row.dispatchBy;
  return end !== null && end.getTime() <= now.getTime() ? 'EXPIRED' : 'ACTIVE';
}

/** Public check. Status and minimal scope only: no address, no commercial or evidence detail. */
export async function verifyAuditDocument(number: string): Promise<Record<string, unknown> | null> {
  const row = await prisma.auditDocument.findUnique({ where: { number } });
  if (row === null) return null;
  const scope = row.scopeJson as Record<string, unknown>;
  return {
    kind: row.kind,
    issuer: typeof scope['marketplace'] === 'string' ? scope['marketplace'] : null,
    status: effectiveStatus(row),
    version: row.version,
    issuedAt: row.issuedAt.toISOString(),
    validUntil: row.validUntil?.toISOString() ?? null,
    dispatchBy: row.dispatchBy?.toISOString() ?? null,
    scope: row.scopeJson,
  };
}

export function documentView(row: {
  id: string;
  number: string;
  kind: string;
  version: number;
  status: string;
  issuedAt: Date;
  validUntil: Date | null;
  dispatchBy: Date | null;
  signedByName: string;
  signedByRole: string;
  round: number | null;
  supersedesId: string | null;
  revokedReason: string | null;
}) {
  return {
    id: row.id,
    number: row.number,
    kind: row.kind,
    version: row.version,
    status: effectiveStatus(row),
    issuedAt: row.issuedAt.toISOString(),
    validUntil: row.validUntil?.toISOString() ?? null,
    dispatchBy: row.dispatchBy?.toISOString() ?? null,
    signedByName: row.signedByName,
    signedByRole: row.signedByRole,
    round: row.round,
    supersedesId: row.supersedesId,
    revokedReason: row.revokedReason,
  };
}

/** The PDF bytes, for a caller whose route has already scoped the document. */
export async function readDocumentPdf(client: Client, where: { id: string; sellerAccountId?: string; assessmentIdIn?: string[]; kinds?: Kind[] }) {
  const row = await client.auditDocument.findFirst({
    where: {
      id: where.id,
      ...(where.sellerAccountId === undefined ? {} : { sellerAccountId: where.sellerAccountId }),
      ...(where.assessmentIdIn === undefined ? {} : { assessmentId: { in: where.assessmentIdIn } }),
      ...(where.kinds === undefined ? {} : { kind: { in: where.kinds } }),
    },
  });
  if (row === null) throw notFound('Document');
  return { fileName: `${row.number}.pdf`, bytes: await storage.get(row.storageKey) };
}

export async function revokeDocument(signer: Signer, id: string, reason: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const row = await tx.auditDocument.findUnique({ where: { id } });
    if (row === null) throw notFound('Document');
    if (row.status !== 'ACTIVE') throw conflict(ErrorCode.AUDIT_DOCUMENT_NOT_ALLOWED, 'Only an active document can be revoked.');
    const now = new Date();
    await tx.auditDocument.update({ where: { id }, data: { status: 'REVOKED', statusChangedAt: now, revokedByUserId: signer.userId, revokedReason: reason.slice(0, 1000) } });
    // A revoked release document takes its unused release with it.
    if (row.releaseId !== null) {
      await tx.shipmentReleaseAuthorization.updateMany({
        where: { id: row.releaseId, status: 'ACTIVE' },
        data: { status: 'INVALIDATED', activeSlot: null, invalidatedAt: now, invalidationReason: `Document ${row.number} revoked: ${reason}`.slice(0, 1000), version: { increment: 1 } },
      });
    }
    await recordAudit({ action: AuditAction.AUDIT_DOCUMENT_REVOKED, resourceType: 'AuditDocument', resourceId: id, actorType: 'AUDIT', actorUserId: signer.userId, after: { number: row.number, reason } }, tx);
  });
}

// --- Seller Verification Certificate ------------------------------------------

/**
 * Issue (or re-issue as a new version) a seller's verification certificate.
 * Only for an APPROVED seller. Validity is the policy's months, cut short by
 * the first expiry among the approved, current supporting documents.
 */
export async function issueSellerCertificate(
  signer: Signer,
  sellerAccountId: string,
  input: { categories: string[]; markets: string[]; scopeNote: string; siteLocationId: string | null },
): Promise<{ id: string; number: string }> {
  return prisma.$transaction(async (tx) => {
    const seller = await tx.sellerAccount.findUnique({
      where: { id: sellerAccountId },
      select: {
        legalName: true,
        displayName: true,
        status: true,
        approvedAt: true,
        registrationCountry: true,
        businessProfile: { select: { companyRegistrationNumber: true, registeredCity: true, registeredCountry: true } },
        documents: { where: { supersededAt: null, approvedAt: { not: null } }, select: { id: true, kind: true, expiresOn: true } },
        locations: { where: { archivedAt: null }, select: { id: true, name: true, city: true, countryCode: true } },
      },
    });
    if (seller === null) throw notFound('Seller');
    if (seller.status !== 'APPROVED' || seller.approvedAt === null) {
      throw conflict(ErrorCode.AUDIT_DOCUMENT_NOT_ALLOWED, 'A certificate is issued only after the final verification approval.');
    }
    const site = input.siteLocationId === null ? null : seller.locations.find((location) => location.id === input.siteLocationId) ?? null;
    const policy = await activePolicy(tx);
    const issuedAt = new Date();
    const expiries = seller.documents.map((doc) => doc.expiresOn).filter((value): value is Date => value !== null);
    const validUntil = certificateValidUntil(issuedAt, policy.sellerCertificateMonths, expiries);
    if (validUntil.getTime() <= issuedAt.getTime()) {
      throw conflict(ErrorCode.AUDIT_DOCUMENT_NOT_ALLOWED, 'A required supporting document has already expired. Renew it first.');
    }
    const current = await tx.auditDocument.findFirst({ where: { sellerAccountId, kind: 'SELLER_VERIFICATION_CERTIFICATE', status: 'ACTIVE' }, select: { id: true } });
    const marketplace = await getMarketplaceName(tx);
    return issueDocument(tx, {
      kind: 'SELLER_VERIFICATION_CERTIFICATE',
      sellerAccountId,
      validUntil,
      signer,
      supersedesId: current?.id ?? null,
      scope: { seller: seller.displayName, categories: input.categories, markets: input.markets },
      facts: [
        ['Seller (legal name)', seller.legalName],
        ['Registration', `${seller.businessProfile?.companyRegistrationNumber ?? '-'} (${seller.registrationCountry})`],
        ['Site', site === null ? 'Registered business only' : `${site.name}, ${site.city}, ${site.countryCode}`],
        ['Verification approved', day(seller.approvedAt)],
        ['Verified categories', input.categories.join(', ') || '-'],
        ['Markets', input.markets.join(', ') || '-'],
        ['Review due', day(validUntil)],
      ],
      paragraphs: [
        `${scopeStatement(marketplace)} Scope: ${input.scopeNote}`,
        `Review is due after ${String(policy.sellerCertificateMonths)} months under the ${marketplace} platform policy, or earlier if supporting evidence expires. This is a platform policy, not a legal or ISO requirement. Material changes, suspension or revoked evidence trigger a new review.`,
        `Evidence references: ${seller.documents.map((doc) => `${doc.kind} ${doc.id}`).join('; ') || 'none'}.`,
      ],
      detail: { categories: input.categories, markets: input.markets, scopeNote: input.scopeNote, siteLocationId: site?.id ?? null, evidence: seller.documents.map((doc) => doc.id), policyVersion: policy.version },
    });
  });
}

// --- Shipment documents --------------------------------------------------------

export interface ShipmentDocContext {
  assessment: { id: string; number: string; sellerAccountId: string; orderId: string; sellerOrderGroupId: string; l1Location: string | null };
  round: {
    round: number;
    checklistVersion: string;
    inspectionLocation: string | null;
    submittedAt: Date | null;
    orderedQuantity: number | null;
    declaredQuantity: number | null;
    presentedQuantity: number | null;
    countedQuantity: number | null;
    sampledQuantity: number | null;
    approvedQuantity: number | null;
    samplingMethod: string | null;
    findingsSummary: string | null;
  } | null;
  checks: { itemCode: string; section: string; outcome: string; note: string | null; sampled: boolean }[];
  assessorName: string | null;
  qaName: string | null;
}

async function shipmentScope(tx: PrismaTransaction, ctx: ShipmentDocContext) {
  const group = await tx.sellerOrderGroup.findUniqueOrThrow({
    where: { id: ctx.assessment.sellerOrderGroupId },
    select: { sellerOrderNumber: true, order: { select: { orderNumber: true } }, sellerAccount: { select: { displayName: true } } },
  });
  return group;
}

function checkTable(checks: ShipmentDocContext['checks']) {
  return {
    columns: [
      { header: 'Item', weight: 1 },
      { header: 'Section', weight: 1 },
      { header: 'Result', weight: 1.4 },
      { header: 'Note', weight: 5 },
    ],
    rows: checks.map((check) => [check.itemCode, check.section, `${check.outcome}${check.sampled ? ' (sample)' : ''}`, check.note ?? '']),
  };
}

export async function issueShipmentCertificate(
  tx: PrismaTransaction,
  ctx: ShipmentDocContext,
  release: { id: string; dispatchDeadline: Date; loadingChecksRequired: boolean },
  signer: Signer,
) {
  const group = await shipmentScope(tx, ctx);
  const round = ctx.round;
  return issueDocument(tx, {
    kind: 'SHIPMENT_ASSESSMENT_CERTIFICATE',
    sellerAccountId: ctx.assessment.sellerAccountId,
    assessmentId: ctx.assessment.id,
    round: round?.round ?? null,
    releaseId: release.id,
    dispatchBy: release.dispatchDeadline,
    signer,
    scope: { seller: group.sellerAccount.displayName, assessment: ctx.assessment.number, approvedQuantity: round?.approvedQuantity ?? null },
    facts: [
      ['Assessment', ctx.assessment.number],
      ['Order / seller order', `${group.order.orderNumber} / ${group.sellerOrderNumber}`],
      ['Seller', group.sellerAccount.displayName],
      ['Round', String(round?.round ?? '-')],
      ['Inspected at', round?.inspectionLocation ?? ctx.assessment.l1Location ?? '-'],
      ['Inspection date', day(round?.submittedAt)],
      ['Inspector', ctx.assessorName ?? '-'],
      ['QA reviewer', ctx.qaName ?? '-'],
      ['Checklist version', round?.checklistVersion ?? '-'],
      ['Ordered / counted / approved', `${String(round?.orderedQuantity ?? '-')} / ${String(round?.countedQuantity ?? '-')} / ${String(round?.approvedQuantity ?? '-')}`],
    ],
    paragraphs: [
      round === null ? '' : samplingStatement(round, round.samplingMethod),
      `Findings: ${round?.findingsSummary ?? 'No findings recorded.'}`,
      release.loadingChecksRequired
        ? 'Final loading checks (vehicle / container, securing, final count, seals, documents) are still required before departure.'
        : 'Final loading checks were recorded as passed during this assessment.',
      'Reassessment is required if batches, quantities, packaging, seals, destination or storage conditions change, if the dispatch deadline passes, or if new blocking findings arise. The dispatch deadline is not a guarantee of product quality during transport. This document covers this shipment only and cannot authorise another.',
    ].filter((text) => text !== ''),
    table: checkTable(ctx.checks),
    detail: { round: round?.round ?? null, releaseId: release.id },
  });
}

export async function issueWaiverDocument(
  tx: PrismaTransaction,
  ctx: ShipmentDocContext,
  waiver: { badge: string | null; policyVersion: number; reason: string },
  release: { id: string; dispatchDeadline: Date },
  signer: Signer,
) {
  const group = await shipmentScope(tx, ctx);
  const marketplace = await getMarketplaceName(tx);
  return issueDocument(tx, {
    kind: 'SHIPMENT_WAIVER_AUTHORIZATION',
    sellerAccountId: ctx.assessment.sellerAccountId,
    assessmentId: ctx.assessment.id,
    releaseId: release.id,
    dispatchBy: release.dispatchDeadline,
    signer,
    scope: { seller: group.sellerAccount.displayName, assessment: ctx.assessment.number, waiver: true },
    facts: [
      ['Assessment', ctx.assessment.number],
      ['Order / seller order', `${group.order.orderNumber} / ${group.sellerOrderNumber}`],
      ['Seller', group.sellerAccount.displayName],
      ['Badge at decision', waiver.badge ?? 'none'],
      ['Policy version', String(waiver.policyVersion)],
      ['Approved by', signer.name],
    ],
    paragraphs: [
      waiverStatement(marketplace),
      `Reason: ${waiver.reason}`,
      'This waiver does not remove the final loading checks or any independent compliance check. It covers this shipment only, until the dispatch deadline, and is void if the shipment, the badge or the seller standing changes.',
    ],
    detail: { badge: waiver.badge, policyVersion: waiver.policyVersion, releaseId: release.id },
  });
}

export async function issueFindingsReport(tx: PrismaTransaction, ctx: ShipmentDocContext, outcome: 'FAILED' | 'HELD', signer: Signer) {
  const group = await shipmentScope(tx, ctx);
  const round = ctx.round;
  return issueDocument(tx, {
    kind: 'SHIPMENT_FINDINGS_REPORT',
    sellerAccountId: ctx.assessment.sellerAccountId,
    assessmentId: ctx.assessment.id,
    round: round?.round ?? null,
    signer,
    scope: { seller: group.sellerAccount.displayName, assessment: ctx.assessment.number, outcome },
    facts: [
      ['Assessment', ctx.assessment.number],
      ['Order / seller order', `${group.order.orderNumber} / ${group.sellerOrderNumber}`],
      ['Outcome', outcome === 'FAILED' ? 'FAILED - shipment blocked' : 'ON HOLD - shipment blocked'],
      ['Round', String(round?.round ?? '-')],
      ['Inspector', ctx.assessorName ?? '-'],
      ['Checklist version', round?.checklistVersion ?? '-'],
    ],
    paragraphs: [
      'This is a findings report. It is not a certificate and does not release the shipment. No part of the shipment may proceed to L2 until corrective action is taken and a reassessment passes.',
      round === null ? '' : samplingStatement(round, round.samplingMethod),
      `Findings: ${round?.findingsSummary ?? '-'}`,
    ].filter((text) => text !== ''),
    table: checkTable(ctx.checks),
    detail: { round: round?.round ?? null, outcome },
  });
}
