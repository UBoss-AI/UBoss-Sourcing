/**
 * Seller Assessment: what every service in this module shares - the policy in
 * force, numbering, the append-only event log, capability and independence
 * checks, and private evidence.
 *
 * Who may do what is decided here, not by a route: a route only proves the
 * person is Audit staff with `audit.assessment.work`; the capability for the
 * exact step, the assignment and the separation of duties are checked here
 * against the database, every time.
 */
import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import {
  DECISION_EVENT_KINDS,
  DRAFT_POLICY_DEFAULTS,
  type AssessmentCapability,
  type AssessmentPolicyConfig,
  type RetentionCategory,
} from '../../domain/seller-assessment.js';
import { ErrorCode, badRequest, conflict, forbidden, notFound, serviceUnavailable } from '../../domain/errors.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../infra/ids.js';
import { MalwareDetectedError, MalwareScannerUnavailableError, scanForMalware } from '../../infra/malware-scan.js';
import type { prisma} from '../../infra/prisma.js';
import { type PrismaTransaction } from '../../infra/prisma.js';
import { sniffDocumentType, storage } from '../../infra/storage/index.js';

export type Client = PrismaTransaction | typeof prisma;

/** An Audit Console staff member acting on an assessment. */
export interface AssessmentActor {
  userId: string;
  fullName: string;
  role: string;
  capabilities: readonly AssessmentCapability[];
}

export interface SellerActor {
  sellerAccountId: string;
  profileId: string;
}

// --- Policy -------------------------------------------------------------------

export interface PolicyInForce {
  version: string;
  status: 'ADOPTED' | 'DRAFT';
  config: AssessmentPolicyConfig;
}

function configOf(json: unknown): AssessmentPolicyConfig {
  return { ...DRAFT_POLICY_DEFAULTS, ...(typeof json === 'object' && json !== null ? (json as Partial<AssessmentPolicyConfig>) : {}) };
}

/**
 * The adopted, disclosed version whose effective date has come; else the
 * latest draft (marked DRAFT, so a caller can refuse to decide under it).
 */
export async function policyInForce(client: Client, now = new Date()): Promise<PolicyInForce> {
  const adopted = await client.sellerAssessmentPolicy.findFirst({
    where: { status: 'ADOPTED', effectiveFrom: { lte: now }, disclosedAt: { not: null } },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (adopted !== null) return { version: adopted.version, status: 'ADOPTED', config: configOf(adopted.configJson) };
  const draft = await client.sellerAssessmentPolicy.findFirst({ where: { status: 'DRAFT' }, orderBy: { createdAt: 'desc' } });
  return { version: draft?.version ?? '1.0', status: 'DRAFT', config: configOf(draft?.configJson) };
}

/** Binding decisions (release, decline) need an adopted policy, unless a non-production deployment allows drafts. */
export async function decisionPolicy(client: Client): Promise<PolicyInForce> {
  const policy = await policyInForce(client);
  if (policy.status === 'DRAFT' && !env.SELLER_ASSESSMENT_ALLOW_DRAFT_POLICY) {
    throw conflict(ErrorCode.SELLER_ASSESSMENT_POLICY_NOT_ADOPTED, `Policy ${policy.version} is a draft. Record its adoption, effective date and disclosure before a binding decision.`);
  }
  return policy;
}

// --- Numbering ----------------------------------------------------------------

export async function nextNumber(tx: Client, prefix: 'SAO' | 'STA' | 'SAF' | 'SAN', name: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  const key = `${name}:${String(year)}`;
  await tx.numberSequence.upsert({ where: { key }, update: { value: { increment: 1 } }, create: { key, value: 1, prefix, padding: 6 } });
  const seq = await tx.numberSequence.findUniqueOrThrow({ where: { key } });
  return `${seq.prefix}-${String(year)}-${seq.value.toString().padStart(seq.padding, '0')}`;
}

// --- Events -------------------------------------------------------------------

export interface EventInput {
  sellerAccountId: string;
  assessmentId?: string | null;
  subjectType: string;
  subjectId?: string | null;
  kind: string;
  actorUserId: string | null;
  actorRole: 'AUDIT' | 'SELLER' | 'ADMIN' | 'SYSTEM';
  capability?: AssessmentCapability | null;
  reason?: string | null;
  policyVersion?: string | null;
  evidenceRefs?: string[];
  data?: Prisma.InputJsonValue;
}

/** Append-only. Nothing in this module updates or deletes an event. */
export async function writeEvent(client: Client, input: EventInput): Promise<void> {
  await client.sellerAssessmentEvent.create({
    data: {
      id: newId(),
      sellerAccountId: input.sellerAccountId,
      assessmentId: input.assessmentId ?? null,
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? null,
      kind: input.kind,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      capability: input.capability ?? null,
      reason: input.reason?.slice(0, 8000) ?? null,
      policyVersion: input.policyVersion ?? null,
      evidenceRefsJson: input.evidenceRefs === undefined || input.evidenceRefs.length === 0 ? undefined : input.evidenceRefs,
      dataJson: input.data,
    },
  });
}

// --- Capabilities and independence ---------------------------------------------

export function requireCapability(actor: AssessmentActor, ...any: AssessmentCapability[]): AssessmentCapability {
  const held = any.find((cap) => actor.capabilities.includes(cap));
  if (held === undefined) {
    throw forbidden(ErrorCode.SELLER_ASSESSMENT_CAPABILITY_REQUIRED, `This step needs the ${any.join(' or ')} assessment capability.`);
  }
  return held;
}

/** Everybody who took part in a decision on this assessment, from the event log. */
export async function participants(client: Client, assessmentId: string): Promise<Set<string>> {
  const rows = await client.sellerAssessmentEvent.findMany({
    where: { assessmentId, kind: { in: [...DECISION_EVENT_KINDS] }, actorUserId: { not: null } },
    select: { actorUserId: true },
  });
  return new Set(rows.map((row) => row.actorUserId as string));
}

export function independenceRefused(what: string): never {
  throw forbidden(ErrorCode.SELLER_ASSESSMENT_INDEPENDENCE_REQUIRED, `${what} must be somebody who took no part in the decision being reviewed.`);
}

// --- Loading ------------------------------------------------------------------

export async function loadAssessment(client: Client, id: string) {
  const row = await client.sellerAssessment.findUnique({ where: { id } });
  if (row === null) throw notFound('Seller assessment');
  return row;
}

export function notAllowed(message: string, details?: { field: string; code: string }[]): never {
  throw conflict(ErrorCode.SELLER_ASSESSMENT_NOT_ALLOWED, message, details);
}

export function assertVersion(row: { version: number }, expected: number | undefined): void {
  if (expected !== undefined && row.version !== expected) notAllowed('This record changed since you opened it. Reload and try again.', [{ field: 'expectedVersion', code: 'STALE' }]);
}

// --- Evidence -----------------------------------------------------------------

const MAX_EVIDENCE_BYTES = 15 * 1024 * 1024;

export const EVIDENCE_CATEGORIES = ['IDENTITY', 'BANKING', 'FINANCIAL', 'OWNERSHIP', 'BRAND', 'MANUFACTURING', 'AGREEMENT', 'PRODUCT', 'LABORATORY', 'CERTIFICATE', 'INSURANCE', 'CONTRACT', 'CAPA', 'INCIDENT', 'APPEAL', 'OTHER'] as const;
export type EvidenceCategory = (typeof EVIDENCE_CATEGORIES)[number];

/** Identity and banking keep their own statutory rules; everything else is the general assessment record. */
export function retentionCategoryFor(category: EvidenceCategory): RetentionCategory {
  if (category === 'IDENTITY' || category === 'OWNERSHIP') return 'IDENTITY';
  if (category === 'BANKING') return 'BANKING';
  if (category === 'PRODUCT' || category === 'LABORATORY' || category === 'CERTIFICATE') return 'PRODUCT_SPECIFIC';
  return 'GENERAL_ASSESSMENT';
}

/** Categories the Admin Panel may not download: identity, ownership and banking stay with Audit. */
export const ADMIN_WITHHELD_CATEGORIES: readonly EvidenceCategory[] = ['IDENTITY', 'OWNERSHIP', 'BANKING'];

async function scan(bytes: Buffer): Promise<string> {
  try {
    const result = await scanForMalware(bytes);
    return result.status === 'CLEAN' ? 'CLEAN' : 'SCANNER_UNCONFIGURED';
  } catch (error) {
    if (error instanceof MalwareDetectedError) throw badRequest(ErrorCode.MALWARE_DETECTED, 'The uploaded file failed the security scan.');
    if (error instanceof MalwareScannerUnavailableError) throw serviceUnavailable('The file security scanner is temporarily unavailable.', error);
    throw error;
  }
}

/**
 * Store one evidence file privately as the next version of its key. The
 * previous version stays - a historical decision keeps the file it used.
 */
export async function storeEvidence(
  client: Client,
  input: {
    assessmentId: string;
    sellerAccountId: string;
    category: EvidenceCategory;
    evidenceKey: string;
    label: string;
    fileName: string;
    bytes: Buffer;
    uploadedByUserId: string;
    uploadedByRole: 'AUDIT' | 'SELLER';
  },
): Promise<{ id: string; evidenceVersion: number }> {
  if (input.bytes.length === 0 || input.bytes.length > MAX_EVIDENCE_BYTES) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Upload a PDF or image up to 15 MB.', [{ field: 'file', code: 'SIZE' }]);
  }
  if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(input.evidenceKey)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The evidence key is not valid.', [{ field: 'evidenceKey', code: 'MALFORMED' }]);
  }
  const type = sniffDocumentType(input.bytes);
  const scanState = await scan(input.bytes);
  const stored = await storage.put(input.bytes, type.mimeType, type.extension, 'private');
  const previous = await client.sellerAssessmentEvidence.findFirst({
    where: { assessmentId: input.assessmentId, evidenceKey: input.evidenceKey },
    orderBy: { evidenceVersion: 'desc' },
    select: { id: true, evidenceVersion: true },
  });
  const id = newId();
  const evidenceVersion = (previous?.evidenceVersion ?? 0) + 1;
  await client.sellerAssessmentEvidence.create({
    data: {
      id,
      assessmentId: input.assessmentId,
      sellerAccountId: input.sellerAccountId,
      category: input.category,
      evidenceKey: input.evidenceKey,
      label: input.label.slice(0, 255),
      evidenceVersion,
      supersedesId: previous?.id ?? null,
      storageKey: stored.storageKey,
      fileName: input.fileName.replace(/[\r\n"]/g, '').slice(0, 255),
      contentType: type.mimeType,
      byteSize: input.bytes.length,
      contentHash: createHash('sha256').update(input.bytes).digest('hex'),
      scanState,
      uploadedByUserId: input.uploadedByUserId,
      uploadedByRole: input.uploadedByRole,
      retentionCategory: retentionCategoryFor(input.category),
    },
  });
  return { id, evidenceVersion };
}

/** Latest version of every evidence key on an assessment. */
export async function latestEvidence(client: Client, assessmentId: string) {
  const rows = await client.sellerAssessmentEvidence.findMany({ where: { assessmentId }, orderBy: { evidenceVersion: 'desc' } });
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latest.has(row.evidenceKey)) latest.set(row.evidenceKey, row);
  return latest;
}

export async function readEvidenceBytes(row: { storageKey: string; fileName: string; contentType: string; scanState: string }) {
  if (row.scanState !== 'CLEAN' && row.scanState !== 'SCANNER_UNCONFIGURED') notAllowed('This file has not passed the security scan.');
  return { fileName: row.fileName, contentType: row.contentType, bytes: await storage.get(row.storageKey) };
}

export function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))) as Prisma.InputJsonValue;
}
