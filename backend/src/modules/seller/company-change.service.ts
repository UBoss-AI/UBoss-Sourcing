/**
 * Change control for a seller's verified company details (JOURNEY-027).
 *
 * Once a seller application is approved, the business profile is no longer
 * editable (`assertApplicationEditable`). The legal name, the registration
 * and tax numbers and the registered address were what the marketplace
 * checked, and they appear on invoices and on the public supplier page, so
 * they do not change by the seller typing over them. The seller PROPOSES a
 * change; a member of staff approves or rejects it, with a reason, and both
 * the request and the decision are audited.
 *
 * MATERIAL CHANGES
 *
 * A different legal name, registration number, tax number or registered
 * country is a different business for verification purposes. Approving one
 * applies it AND opens a fresh verification case of the kind it touches
 * (`BUSINESS_REGISTRATION`, `TAX_REGISTRATION`), so the previous verification
 * no longer stands for facts nobody checked. An address change inside the
 * same country is applied without re-verification.
 *
 * Stored in `seller_profile_change_requests` (section `COMPANY`), one pending
 * request per seller: proposing again withdraws the earlier one.
 */
import { z } from 'zod';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { taxNumberProblem } from '../../domain/seller-kyb.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { assertSellerPermission, type SellerMembership } from './account.service.js';
import { OPERATOR_LABEL, recordSellerAudit } from './audit.service.js';
import { notifySeller } from './notification.service.js';
import { assertRegisteredAddress } from './onboarding.service.js';

export const COMPANY_SECTION = 'COMPANY';

/** The verified company fields a change request may carry. */
export const COMPANY_FIELDS = [
  'legalName',
  'companyRegistrationNumber',
  'taxRegistrationNumber',
  'eoriNumber',
  'registeredAddressLine1',
  'registeredAddressLine2',
  'registeredCity',
  'registeredRegion',
  'registeredPostcode',
  'registeredCountry',
] as const;

export type CompanyField = (typeof COMPANY_FIELDS)[number];

/** The fields whose change re-opens verification, and which check each one re-opens. */
export const MATERIAL_FIELDS: Readonly<Partial<Record<CompanyField, 'BUSINESS_REGISTRATION' | 'TAX_REGISTRATION'>>> =
  Object.freeze({
    legalName: 'BUSINESS_REGISTRATION',
    companyRegistrationNumber: 'BUSINESS_REGISTRATION',
    registeredCountry: 'BUSINESS_REGISTRATION',
    taxRegistrationNumber: 'TAX_REGISTRATION',
  });

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const companyChangeInput = z
  .strictObject({
    legalName: z.string().trim().min(2).max(255).optional(),
    companyRegistrationNumber: optionalText(64),
    taxRegistrationNumber: optionalText(64),
    eoriNumber: optionalText(32),
    registeredAddressLine1: optionalText(255),
    registeredAddressLine2: optionalText(255),
    registeredCity: optionalText(120),
    registeredRegion: optionalText(120),
    registeredPostcode: optionalText(20),
    registeredCountry: z.string().trim().length(2).toUpperCase().nullable().optional(),
    note: z.string().trim().max(1000).optional(),
  });

export const companyChangeDecisionInput = z
  .strictObject({
    decision: z.enum(['APPROVED', 'REJECTED']),
    reason: z.string().trim().max(1000).optional(),
  })
  .superRefine((value, context) => {
    if (value.decision === 'REJECTED' && (value.reason ?? '').length < 3) {
      context.addIssue({ code: 'custom', path: ['reason'], message: 'Say why the change is not accepted.' });
    }
  });

type CompanyValues = Record<CompanyField, string | null>;

export interface CompanyChangeView {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';
  /** Only the fields this request changes. */
  proposed: Partial<CompanyValues>;
  /** The same fields as they were when it was proposed. */
  previous: Partial<CompanyValues>;
  /** Whether approving it re-opens verification. */
  material: boolean;
  reverifies: ('BUSINESS_REGISTRATION' | 'TAX_REGISTRATION')[];
  note: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface CompanyChangeQueueEntry extends CompanyChangeView {
  seller: { id: string; displayName: string; legalName: string };
}

export interface SellerCompanyDetails {
  /** What is on file now. */
  current: CompanyValues;
  /** False while the application can still be edited directly. */
  changeControlled: boolean;
  pending: CompanyChangeView | null;
  history: CompanyChangeView[];
}

async function currentValues(sellerAccountId: string): Promise<CompanyValues> {
  const account = await prisma.sellerAccount.findUnique({
    where: { id: sellerAccountId },
    select: {
      legalName: true,
      businessProfile: {
        select: {
          companyRegistrationNumber: true,
          taxRegistrationNumber: true,
          eoriNumber: true,
          registeredAddressLine1: true,
          registeredAddressLine2: true,
          registeredCity: true,
          registeredRegion: true,
          registeredPostcode: true,
          registeredCountry: true,
        },
      },
    },
  });
  if (account === null) throw notFound('Seller');
  const profile = account.businessProfile;
  return {
    legalName: account.legalName,
    companyRegistrationNumber: profile?.companyRegistrationNumber ?? null,
    taxRegistrationNumber: profile?.taxRegistrationNumber ?? null,
    eoriNumber: profile?.eoriNumber ?? null,
    registeredAddressLine1: profile?.registeredAddressLine1 ?? null,
    registeredAddressLine2: profile?.registeredAddressLine2 ?? null,
    registeredCity: profile?.registeredCity ?? null,
    registeredRegion: profile?.registeredRegion ?? null,
    registeredPostcode: profile?.registeredPostcode ?? null,
    registeredCountry: profile?.registeredCountry ?? null,
  };
}

function asValues(json: unknown): Partial<CompanyValues> {
  if (typeof json !== 'object' || json === null) return {};
  const out: Partial<CompanyValues> = {};
  for (const field of COMPANY_FIELDS) {
    if (field in json) {
      const value = (json as Record<string, unknown>)[field];
      out[field] = typeof value === 'string' ? value : null;
    }
  }
  return out;
}

function reverifiesFor(fields: readonly string[]): ('BUSINESS_REGISTRATION' | 'TAX_REGISTRATION')[] {
  const kinds = new Set<'BUSINESS_REGISTRATION' | 'TAX_REGISTRATION'>();
  for (const field of fields) {
    const kind = MATERIAL_FIELDS[field as CompanyField];
    if (kind !== undefined) kinds.add(kind);
  }
  return [...kinds].sort();
}

function view(row: {
  id: string;
  status: string;
  proposedJson: unknown;
  previousJson: unknown;
  decisionReason: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}): CompanyChangeView {
  const proposed = asValues(row.proposedJson);
  const reverifies = reverifiesFor(Object.keys(proposed));
  const rawNote =
    typeof row.proposedJson === 'object' && row.proposedJson !== null && 'note' in row.proposedJson
      ? (row.proposedJson as { note?: unknown }).note
      : null;
  const note = typeof rawNote === 'string' && rawNote.length > 0 ? rawNote : null;
  return {
    id: row.id,
    status: row.status as CompanyChangeView['status'],
    proposed,
    previous: asValues(row.previousJson),
    material: reverifies.length > 0,
    reverifies,
    note,
    decisionReason: row.decisionReason,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** What is on file, whether it is change-controlled, the pending request and the history. */
export async function readCompanyDetails(membership: SellerMembership): Promise<SellerCompanyDetails> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_READ);
  const [current, rows] = await Promise.all([
    currentValues(membership.sellerAccountId),
    prisma.sellerProfileChangeRequest.findMany({
      where: { sellerAccountId: membership.sellerAccountId, section: COMPANY_SECTION },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);
  const views = rows.map(view);
  return {
    current,
    changeControlled: !membership.isApplicationEditable,
    pending: views.find((entry) => entry.status === 'PENDING') ?? null,
    history: views.filter((entry) => entry.status !== 'PENDING'),
  };
}

/**
 * Propose a change. Only the fields that actually differ are kept; a request
 * that changes nothing is refused. A pending request is withdrawn by a new one.
 */
export async function proposeCompanyChange(
  membership: SellerMembership,
  input: z.infer<typeof companyChangeInput>,
  correlationId?: string | null,
): Promise<CompanyChangeView> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_WRITE);
  if (membership.isApplicationEditable) {
    throw conflict(
      ErrorCode.COMPANY_CHANGE_NOT_ALLOWED,
      'Your application can still be edited, so change these details in the application itself.',
    );
  }

  const current = await currentValues(membership.sellerAccountId);
  const proposed: Partial<CompanyValues> = {};
  const previous: Partial<CompanyValues> = {};
  for (const field of COMPANY_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    const next = value === null || value === '' ? null : value;
    if (next === current[field]) continue;
    if (field === 'legalName' && next === null) continue;
    proposed[field] = next;
    previous[field] = current[field];
  }
  if (Object.keys(proposed).length === 0) {
    throw badRequest(ErrorCode.COMPANY_CHANGE_EMPTY, 'Nothing here is different from what is on file.');
  }

  // The same checks the application applies to these fields.
  await assertRegisteredAddress(membership, {
    ...(proposed.registeredCountry === undefined ? {} : { registeredCountry: proposed.registeredCountry }),
    ...(proposed.registeredPostcode === undefined ? {} : { registeredPostcode: proposed.registeredPostcode }),
  });
  if (typeof proposed.taxRegistrationNumber === 'string') {
    const problem = taxNumberProblem(
      proposed.registeredCountry ?? current.registeredCountry ?? membership.registrationCountry,
      proposed.taxRegistrationNumber,
    );
    if (problem !== null) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'That is not a valid tax number.', [
        { field: 'taxRegistrationNumber', code: problem },
      ]);
    }
  }

  const note = input.note === undefined || input.note.length === 0 ? null : input.note;
  const id = newId();
  const row = await prisma.$transaction(async (tx) => {
    await tx.sellerProfileChangeRequest.updateMany({
      where: { sellerAccountId: membership.sellerAccountId, section: COMPANY_SECTION, status: 'PENDING' },
      data: { status: 'WITHDRAWN', decidedAt: new Date(), decisionReason: 'Replaced by a newer request.' },
    });
    const created = await tx.sellerProfileChangeRequest.create({
      data: {
        id,
        sellerAccountId: membership.sellerAccountId,
        section: COMPANY_SECTION,
        subjectId: '',
        proposedJson: { ...proposed, ...(note === null ? {} : { note }) },
        previousJson: previous,
        submittedByProfileId: membership.customerProfileId,
      },
    });
    await recordSellerAudit({
      sellerAccountId: membership.sellerAccountId,
      action: 'seller.company_change.requested',
      actor: { type: 'CUSTOMER', label: membership.displayName },
      resourceType: 'seller_profile_change_request',
      resourceId: id,
      before: previous,
      after: proposed,
      summary: 'Asked the marketplace to change verified company details.',
      correlationId: correlationId ?? null,
      tx,
    });
    return created;
  });
  return view(row);
}

/** Take back a request nobody has decided yet. */
export async function withdrawCompanyChange(
  membership: SellerMembership,
  changeId: string,
  correlationId?: string | null,
): Promise<CompanyChangeView> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_WRITE);
  const row = await prisma.sellerProfileChangeRequest.findFirst({
    where: { id: changeId, sellerAccountId: membership.sellerAccountId, section: COMPANY_SECTION },
  });
  if (row === null) throw notFound('Change request');
  const moved = await prisma.sellerProfileChangeRequest.updateMany({
    where: { id: row.id, status: 'PENDING' },
    data: { status: 'WITHDRAWN', decidedAt: new Date() },
  });
  if (moved.count === 0) {
    throw conflict(ErrorCode.COMPANY_CHANGE_NOT_PENDING, 'This request has already been decided or withdrawn.');
  }
  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.company_change.withdrawn',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_profile_change_request',
    resourceId: row.id,
    summary: 'Withdrew a company details change request.',
    correlationId: correlationId ?? null,
  });
  const fresh = await prisma.sellerProfileChangeRequest.findUniqueOrThrow({ where: { id: row.id } });
  return view(fresh);
}

/** The staff queue: pending by default, oldest first. */
export async function listCompanyChangesForReview(input: {
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';
  sellerAccountId?: string;
}): Promise<CompanyChangeQueueEntry[]> {
  const status = input.status ?? 'PENDING';
  const rows = await prisma.sellerProfileChangeRequest.findMany({
    where: {
      section: COMPANY_SECTION,
      status,
      ...(input.sellerAccountId === undefined ? {} : { sellerAccountId: input.sellerAccountId }),
    },
    orderBy: { createdAt: status === 'PENDING' ? 'asc' : 'desc' },
    take: 200,
    include: { sellerAccount: { select: { id: true, displayName: true, legalName: true } } },
  });
  return rows.map((row) => ({ ...view(row), seller: row.sellerAccount }));
}

/**
 * Approve or reject. Approval writes the proposed values and, for a material
 * change, retires the current verification case of each kind it touches and
 * opens a fresh one for a reviewer. Conditional on the request still being
 * PENDING, so two reviewers get one decision and one refusal.
 */
export async function decideCompanyChange(input: {
  changeId: string;
  decision: 'APPROVED' | 'REJECTED';
  reason: string | null;
  actor: { userId: string; email: string | null; correlationId?: string | null };
}): Promise<CompanyChangeQueueEntry> {
  const row = await prisma.sellerProfileChangeRequest.findFirst({
    where: { id: input.changeId, section: COMPANY_SECTION },
  });
  if (row === null) throw notFound('Change request');
  if (row.status !== 'PENDING') {
    throw conflict(ErrorCode.COMPANY_CHANGE_NOT_PENDING, 'This request has already been decided or withdrawn.');
  }
  const proposed = asValues(row.proposedJson);
  const reverifies = reverifiesFor(Object.keys(proposed));
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    const moved = await tx.sellerProfileChangeRequest.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: {
        status: input.decision,
        decidedByUserId: input.actor.userId,
        decidedAt: now,
        decisionReason: input.reason,
      },
    });
    if (moved.count === 0) {
      throw conflict(ErrorCode.COMPANY_CHANGE_NOT_PENDING, 'A colleague decided this request first.');
    }

    if (input.decision === 'APPROVED') {
      const { legalName, ...profileFields } = proposed;
      if (legalName !== undefined && legalName !== null) {
        await tx.sellerAccount.update({ where: { id: row.sellerAccountId }, data: { legalName } });
      }
      if (Object.keys(profileFields).length > 0) {
        await tx.sellerBusinessProfile.upsert({
          where: { sellerAccountId: row.sellerAccountId },
          create: { id: newId(), sellerAccountId: row.sellerAccountId, ...profileFields },
          update: profileFields,
        });
      }
      // Re-verification: the old case no longer stands for these facts.
      for (const kind of reverifies) {
        await tx.sellerVerificationCase.updateMany({
          where: { sellerAccountId: row.sellerAccountId, kind, isCurrent: true },
          data: { isCurrent: false },
        });
        await tx.sellerVerificationCase.create({
          data: {
            id: newId(),
            sellerAccountId: row.sellerAccountId,
            kind,
            state: 'IN_PROGRESS',
            provider: 'manual_review',
            failureReason: null,
            internalDetail: `Re-opened by approved company change ${row.id}.`,
            isCurrent: true,
          },
        });
      }
    }

    await recordAudit(
      {
        action: AuditAction.SELLER_COMPANY_CHANGE_DECIDED,
        resourceType: 'seller_profile_change_request',
        resourceId: row.id,
        actorType: 'ADMIN',
        actorUserId: input.actor.userId,
        actorEmail: input.actor.email,
        before: { status: 'PENDING', values: row.previousJson },
        after: { status: input.decision, values: input.decision === 'APPROVED' ? proposed : undefined, reverifies },
        correlationId: input.actor.correlationId ?? null,
      },
      tx,
    );
    await recordSellerAudit({
      sellerAccountId: row.sellerAccountId,
      action: input.decision === 'APPROVED' ? 'seller.company_change.approved' : 'seller.company_change.rejected',
      actor: { type: 'ADMIN', label: OPERATOR_LABEL },
      resourceType: 'seller_profile_change_request',
      resourceId: row.id,
      before: row.previousJson,
      after: input.decision === 'APPROVED' ? proposed : undefined,
      summary:
        input.decision === 'APPROVED'
          ? reverifies.length > 0
            ? 'The company details change was approved and applied. It changes verified facts, so they are being checked again.'
            : 'The company details change was approved and applied.'
          : `The company details change was not accepted: ${input.reason ?? ''}`,
      correlationId: input.actor.correlationId ?? null,
      tx,
    });
  });

  await notifySeller({
    sellerAccountId: row.sellerAccountId,
    kind: 'APPLICATION_STATUS',
    title: input.decision === 'APPROVED' ? 'Company details change approved' : 'Company details change not accepted',
    body:
      input.decision === 'APPROVED'
        ? reverifies.length > 0
          ? 'Your change was applied. Because it changes facts the marketplace verified, they are being checked again.'
          : 'Your change was applied.'
        : `Your change was not accepted: ${input.reason ?? ''}`,
    linkPath: '/seller/profile',
    severity: input.decision === 'APPROVED' ? 'SUCCESS' : 'WARNING',
    subjectType: 'seller_profile_change_request',
    subjectId: row.id,
  });

  const fresh = await prisma.sellerProfileChangeRequest.findUniqueOrThrow({
    where: { id: row.id },
    include: { sellerAccount: { select: { id: true, displayName: true, legalName: true } } },
  });
  return { ...view(fresh), seller: fresh.sellerAccount };
}
