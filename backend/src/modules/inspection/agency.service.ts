/**
 * Inspection agencies, their people, and the independence checks.
 *
 * An agency is created by the operator, never by self-registration, like a
 * logistics partner. Its people sign in with ordinary storefront accounts; the
 * member row is what turns an account into an inspector, and it is resolved
 * from the SESSION on every request - no route reads an agency id from a
 * parameter.
 *
 * Independence (FLOW-003, JOURNEY-036/037) is checked here and nowhere else,
 * so the booking, acceptance, assignment and every write on a job ask the same
 * question the same way:
 *   - an agency the seller is affiliated with is never offered the seller's job;
 *   - nobody who is a member of the seller, or is the buyer, may act on it;
 *   - an inspector must hold a verified identity, current credentials and, where
 *     the policy says so, competence for the order's category.
 */
import { ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import {
  inspectionPermissionsFor,
  isAssignmentScoped,
  type InspectionAgencyPermissionKey,
  type InspectionAgencyRoleName,
} from '../../domain/inspection-permissions.js';
import { newId } from '../../infra/ids.js';
import type { PrismaTransaction } from '../../infra/prisma.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { normaliseEmail } from '../identity/auth.service.js';
import type { InspectionActor } from './context.js';

// ---------------------------------------------------------------------------
// The member, from the session
// ---------------------------------------------------------------------------

export interface InspectionMembership {
  memberId: string;
  agencyId: string;
  agencyName: string;
  userId: string;
  fullName: string;
  role: InspectionAgencyRoleName;
  permissions: ReadonlySet<InspectionAgencyPermissionKey>;
  /** An INSPECTOR sees only the jobs they are named on. */
  assignmentScoped: boolean;
}

export async function resolveInspectionMembership(userId: string): Promise<InspectionMembership> {
  const member = await prisma.inspectionAgencyMember.findUnique({
    where: { userId },
    select: {
      id: true,
      agencyId: true,
      userId: true,
      fullName: true,
      role: true,
      status: true,
      agency: { select: { name: true, status: true } },
    },
  });

  if (member === null || member.status !== 'ACTIVE') {
    throw forbidden(
      ErrorCode.INSPECTION_AGENCY_MEMBER_REQUIRED,
      'This account is not an active member of an inspection agency.',
    );
  }

  if (member.agency.status !== 'ACTIVE') {
    throw forbidden(
      ErrorCode.INSPECTION_AGENCY_MEMBER_REQUIRED,
      'This inspection agency is suspended on this marketplace.',
    );
  }

  return {
    memberId: member.id,
    agencyId: member.agencyId,
    agencyName: member.agency.name,
    userId: member.userId,
    fullName: member.fullName,
    role: member.role,
    permissions: inspectionPermissionsFor(member.role),
    assignmentScoped: isAssignmentScoped(member.role),
  };
}

export function assertInspectionPermission(
  membership: InspectionMembership,
  permission: InspectionAgencyPermissionKey,
): void {
  if (!membership.permissions.has(permission)) {
    throw forbidden(
      ErrorCode.INSPECTION_AGENCY_MEMBER_REQUIRED,
      'Your role in the agency does not allow this.',
    );
  }
}

export function agencyActor(membership: InspectionMembership, correlationId?: string | null): InspectionActor {
  return {
    party: 'AGENCY',
    userId: membership.userId,
    label: `${membership.fullName} (${membership.agencyName})`,
    correlationId: correlationId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

type Client = PrismaTransaction | typeof prisma;

/** The storefront user ids of everybody in the seller, and of the buyer. */
export async function interestedUserIds(
  client: Client,
  input: { sellerAccountId: string; orderId: string },
): Promise<{ sellerUserIds: Set<string>; buyerUserId: string | null }> {
  const [members, order] = await Promise.all([
    client.sellerMember.findMany({
      where: { sellerAccountId: input.sellerAccountId },
      select: { customerProfileId: true },
    }),
    client.order.findUnique({ where: { id: input.orderId }, select: { customerProfileId: true } }),
  ]);

  const profileIds = members.map((member) => member.customerProfileId);
  if (order !== null) profileIds.push(order.customerProfileId);

  const profiles = await client.customerProfile.findMany({
    where: { id: { in: profileIds } },
    select: { id: true, userId: true },
  });

  const byProfile = new Map(profiles.map((profile) => [profile.id, profile.userId]));

  return {
    sellerUserIds: new Set(
      members.map((member) => byProfile.get(member.customerProfileId)).filter((id): id is string => id !== undefined),
    ),
    buyerUserId: order === null ? null : (byProfile.get(order.customerProfileId) ?? null),
  };
}

/**
 * Refuse a person who is part of the seller or is the buyer. Used for every
 * agency action on a job, so a seller's employee who is also listed in an
 * agency still cannot touch that seller's inspection.
 */
export async function assertNoPersonalConflict(
  client: Client,
  userId: string,
  input: { sellerAccountId: string; orderId: string },
): Promise<void> {
  const interested = await interestedUserIds(client, input);

  if (interested.sellerUserIds.has(userId)) {
    throw conflict(
      ErrorCode.INSPECTION_CONFLICT_OF_INTEREST,
      'You are a member of the seller whose goods these are, so you cannot act on this inspection.',
      [{ code: 'SELLER_MEMBER' }],
    );
  }

  if (interested.buyerUserId === userId) {
    throw conflict(
      ErrorCode.INSPECTION_CONFLICT_OF_INTEREST,
      'You placed this order, so you cannot act on its inspection.',
      [{ code: 'BUYER' }],
    );
  }
}

function jsonIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export interface EligibilityProblem {
  code:
    | 'AGENCY_SUSPENDED'
    | 'CATEGORY_NOT_SERVED'
    | 'COUNTRY_NOT_SERVED'
    | 'AFFILIATED_WITH_SELLER'
    | 'MEMBER_IS_SELLER'
    | 'CAPACITY_FULL';
}

/**
 * May this agency take this seller's job, at this place, on this day?
 * Returns every problem rather than the first, so a booking screen can say
 * why an agency is greyed out.
 */
export async function agencyEligibility(
  client: Client,
  input: {
    agencyId: string;
    sellerAccountId: string;
    orderId: string;
    categoryIds: string[];
    country: string | null;
    scheduledFor: Date;
    excludeJobId?: string;
  },
): Promise<EligibilityProblem[]> {
  const agency = await client.inspectionAgency.findUnique({
    where: { id: input.agencyId },
    select: {
      status: true,
      categoryIdsJson: true,
      countriesJson: true,
      affiliatedSellerIdsJson: true,
      dailyCapacity: true,
      members: { where: { status: 'ACTIVE' }, select: { userId: true } },
    },
  });

  if (agency === null) throw notFound('Inspection agency');

  const problems: EligibilityProblem[] = [];
  if (agency.status !== 'ACTIVE') problems.push({ code: 'AGENCY_SUSPENDED' });

  const categories = jsonIds(agency.categoryIdsJson);
  if (categories !== null && categories.length > 0 && !input.categoryIds.some((id) => categories.includes(id))) {
    problems.push({ code: 'CATEGORY_NOT_SERVED' });
  }

  const countries = jsonIds(agency.countriesJson);
  if (countries !== null && countries.length > 0 && (input.country === null || !countries.includes(input.country))) {
    problems.push({ code: 'COUNTRY_NOT_SERVED' });
  }

  if ((jsonIds(agency.affiliatedSellerIdsJson) ?? []).includes(input.sellerAccountId)) {
    problems.push({ code: 'AFFILIATED_WITH_SELLER' });
  }

  const interested = await interestedUserIds(client, input);
  if (agency.members.some((member) => interested.sellerUserIds.has(member.userId))) {
    problems.push({ code: 'MEMBER_IS_SELLER' });
  }

  const dayStart = new Date(Date.UTC(
    input.scheduledFor.getUTCFullYear(),
    input.scheduledFor.getUTCMonth(),
    input.scheduledFor.getUTCDate(),
  ));
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const booked = await client.inspectionJob.count({
    where: {
      agencyId: input.agencyId,
      scheduledFor: { gte: dayStart, lt: dayEnd },
      status: { notIn: ['DECLINED', 'CANCELLED'] },
      ...(input.excludeJobId === undefined ? {} : { id: { not: input.excludeJobId } }),
    },
  });
  if (booked >= agency.dailyCapacity) problems.push({ code: 'CAPACITY_FULL' });

  return problems;
}

export function assertEligible(problems: EligibilityProblem[]): void {
  if (problems.length === 0) return;
  throw conflict(
    ErrorCode.INSPECTION_AGENCY_NOT_ELIGIBLE,
    problems.some((problem) => problem.code === 'AFFILIATED_WITH_SELLER' || problem.code === 'MEMBER_IS_SELLER')
      ? 'This agency is not independent of the seller, so it cannot inspect this order.'
      : problems.some((problem) => problem.code === 'CAPACITY_FULL')
        ? 'This agency is fully booked on that day. Choose another day or agency.'
        : 'This agency cannot inspect this order.',
    problems.map((problem) => ({ code: problem.code })),
  );
}

/**
 * Can this member inspect this order? Identity, credentials, competence and
 * personal conflict, in that order (JOURNEY-037).
 */
export async function assertInspectorQualified(
  client: Client,
  input: {
    memberId: string;
    agencyId: string;
    categoryIds: string[];
    scheduledFor: Date;
    sellerAccountId: string;
    orderId: string;
    requireCompetence: boolean;
  },
): Promise<{ userId: string; fullName: string }> {
  const member = await client.inspectionAgencyMember.findUnique({
    where: { id: input.memberId },
    select: {
      id: true,
      agencyId: true,
      userId: true,
      fullName: true,
      role: true,
      status: true,
      identityVerifiedAt: true,
      credentialExpiresAt: true,
      competenceCategoryIdsJson: true,
    },
  });

  if (member === null || member.agencyId !== input.agencyId) throw notFound('Inspector');

  const problem = (code: string, message: string): never => {
    throw conflict(ErrorCode.INSPECTOR_NOT_QUALIFIED, message, [{ code, meta: { memberId: member.id } }]);
  };

  if (member.status !== 'ACTIVE') problem('INACTIVE', `${member.fullName} is not active in the agency.`);
  if (member.role !== 'INSPECTOR') problem('NOT_AN_INSPECTOR', `${member.fullName} does not hold the inspector role.`);
  if (member.identityVerifiedAt === null) {
    problem('IDENTITY_NOT_VERIFIED', `${member.fullName}'s identity has not been verified yet.`);
  }
  if (member.credentialExpiresAt !== null && member.credentialExpiresAt.getTime() < input.scheduledFor.getTime()) {
    problem('CREDENTIALS_EXPIRED', `${member.fullName}'s credentials expire before the inspection date.`);
  }
  if (input.requireCompetence) {
    const competence = jsonIds(member.competenceCategoryIdsJson) ?? [];
    if (!input.categoryIds.some((id) => competence.includes(id))) {
      problem('NOT_COMPETENT_FOR_CATEGORY', `${member.fullName} is not authorised for this product category.`);
    }
  }

  await assertNoPersonalConflict(client, member.userId, input);

  return { userId: member.userId, fullName: member.fullName };
}

// ---------------------------------------------------------------------------
// The operator manages agencies
// ---------------------------------------------------------------------------

export interface OperatorActor {
  userId: string;
  email: string;
  correlationId?: string | null;
}

export interface AgencyInput {
  name: string;
  legalName: string;
  registrationNumber?: string | null;
  country: string;
  contactEmail: string;
  contactPhone?: string | null;
  accreditation?: string | null;
  categoryIds?: string[] | null;
  countries?: string[] | null;
  affiliatedSellerIds?: string[] | null;
  independenceStatement?: string | null;
  dailyCapacity?: number;
  defaultFeeMinor?: bigint | null;
  feeCurrency?: string | null;
}

function agencyData(input: Partial<AgencyInput>) {
  return {
    ...(input.name === undefined ? {} : { name: input.name.trim() }),
    ...(input.legalName === undefined ? {} : { legalName: input.legalName.trim() }),
    ...(input.registrationNumber === undefined ? {} : { registrationNumber: input.registrationNumber?.trim() || null }),
    ...(input.country === undefined ? {} : { country: input.country.toUpperCase() }),
    ...(input.contactEmail === undefined ? {} : { contactEmail: input.contactEmail.trim() }),
    ...(input.contactPhone === undefined ? {} : { contactPhone: input.contactPhone?.trim() || null }),
    ...(input.accreditation === undefined ? {} : { accreditation: input.accreditation?.trim() || null }),
    ...(input.categoryIds === undefined ? {} : { categoryIdsJson: input.categoryIds ?? undefined }),
    ...(input.countries === undefined
      ? {}
      : { countriesJson: input.countries?.map((code) => code.toUpperCase()) ?? undefined }),
    ...(input.affiliatedSellerIds === undefined ? {} : { affiliatedSellerIdsJson: input.affiliatedSellerIds ?? undefined }),
    ...(input.independenceStatement === undefined
      ? {}
      : {
          independenceStatement: input.independenceStatement?.trim() || null,
          independenceDeclaredAt: input.independenceStatement?.trim() ? new Date() : null,
        }),
    ...(input.dailyCapacity === undefined ? {} : { dailyCapacity: input.dailyCapacity }),
    ...(input.defaultFeeMinor === undefined ? {} : { defaultFeeMinor: input.defaultFeeMinor }),
    ...(input.feeCurrency === undefined ? {} : { feeCurrency: input.feeCurrency?.toUpperCase() ?? null }),
  };
}

/**
 * An agency's name must not be a seller's. Cheap, and the check a reviewer
 * would make first: "Acme Exports" inspecting "Acme Exports" is not
 * independent however the paperwork reads.
 */
async function assertNotASeller(name: string, legalName: string): Promise<void> {
  const clash = await prisma.sellerAccount.findFirst({
    where: {
      OR: [
        { displayNameNormalized: name.trim().toLowerCase() },
        { legalName: legalName.trim() },
      ],
    },
    select: { id: true },
  });

  if (clash !== null) {
    throw conflict(
      ErrorCode.INSPECTION_CONFLICT_OF_INTEREST,
      'An inspection agency cannot be a seller on this marketplace.',
      [{ code: 'AGENCY_IS_SELLER' }],
    );
  }
}

export async function createAgency(actor: OperatorActor, input: AgencyInput): Promise<{ id: string }> {
  await assertNotASeller(input.name, input.legalName);
  const id = newId();

  await prisma.$transaction(async (tx) => {
    await tx.inspectionAgency.create({ data: { id, ...agencyData(input), createdById: actor.userId } as never });
    await recordAudit(
      {
        action: AuditAction.INSPECTION_AGENCY_CHANGED,
        resourceType: 'inspection_agency',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { ...input, defaultFeeMinor: input.defaultFeeMinor?.toString() ?? null },
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return { id };
}

export async function updateAgency(
  actor: OperatorActor,
  agencyId: string,
  input: Partial<AgencyInput> & { status?: 'ACTIVE' | 'SUSPENDED'; suspendedReason?: string | null },
): Promise<void> {
  const before = await prisma.inspectionAgency.findUnique({ where: { id: agencyId } });
  if (before === null) throw notFound('Inspection agency');

  if (input.status === 'SUSPENDED' && (input.suspendedReason ?? '').trim().length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say why the agency is suspended.', [
      { field: 'suspendedReason', code: 'REQUIRED' },
    ]);
  }

  if (input.name !== undefined || input.legalName !== undefined) {
    await assertNotASeller(input.name ?? before.name, input.legalName ?? before.legalName);
  }

  await prisma.$transaction(async (tx) => {
    await tx.inspectionAgency.update({
      where: { id: agencyId },
      data: {
        ...agencyData(input),
        ...(input.status === undefined
          ? {}
          : { status: input.status, suspendedReason: input.status === 'SUSPENDED' ? input.suspendedReason ?? null : null }),
      } as never,
    });
    await recordAudit(
      {
        action: AuditAction.INSPECTION_AGENCY_CHANGED,
        resourceType: 'inspection_agency',
        resourceId: agencyId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { status: before.status, name: before.name },
        after: { ...input, defaultFeeMinor: input.defaultFeeMinor?.toString() },
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}

export interface MemberInput {
  email: string;
  role: InspectionAgencyRoleName;
  fullName: string;
  jobTitle?: string | null;
  idDocumentType?: string | null;
  idDocumentNumber?: string | null;
  competenceCategoryIds?: string[] | null;
  credentials?: string | null;
  credentialExpiresAt?: Date | null;
}

/**
 * Add a person to an agency by the email of their storefront account.
 *
 * The person creates their own account first; nobody is given one. Refused
 * for anybody who is a member of a seller - an inspector who also sells is
 * never independent of their own shop, and checking per job would leave the
 * account able to see the agency's other work.
 */
export async function addAgencyMember(
  by: { kind: 'OPERATOR'; actor: OperatorActor } | { kind: 'AGENCY'; membership: InspectionMembership },
  agencyId: string,
  input: MemberInput,
): Promise<{ id: string }> {
  if (by.kind === 'AGENCY' && by.membership.agencyId !== agencyId) throw notFound('Inspection agency');

  const user = await prisma.user.findUnique({
    where: { emailNormalized: normaliseEmail(input.email) },
    select: { id: true, type: true, customerProfile: { select: { id: true } } },
  });

  if (user === null || user.type !== 'CUSTOMER' || user.customerProfile === null) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'There is no storefront account with that email. Ask the person to create one, then add them.',
      [{ field: 'email', code: 'ACCOUNT_NOT_FOUND' }],
    );
  }

  const sells = await prisma.sellerMember.findUnique({
    where: { customerProfileId: user.customerProfile.id },
    select: { id: true },
  });
  if (sells !== null) {
    throw conflict(
      ErrorCode.INSPECTION_CONFLICT_OF_INTEREST,
      'This person is a member of a seller on this marketplace, so they cannot work for an inspection agency here.',
      [{ code: 'SELLER_MEMBER' }],
    );
  }

  const existing = await prisma.inspectionAgencyMember.findUnique({ where: { userId: user.id }, select: { id: true } });
  if (existing !== null) {
    throw conflict(ErrorCode.CONFLICT, 'This person already belongs to an inspection agency.', [
      { field: 'email', code: 'ALREADY_A_MEMBER' },
    ]);
  }

  const id = newId();
  const actorUserId = by.kind === 'OPERATOR' ? by.actor.userId : by.membership.userId;

  await prisma.$transaction(async (tx) => {
    await tx.inspectionAgencyMember.create({
      data: {
        id,
        agencyId,
        userId: user.id,
        role: input.role,
        fullName: input.fullName.trim(),
        jobTitle: input.jobTitle?.trim() || null,
        idDocumentType: input.idDocumentType?.trim() || null,
        idDocumentNumber: input.idDocumentNumber?.trim() || null,
        competenceCategoryIdsJson: input.competenceCategoryIds ?? undefined,
        credentials: input.credentials?.trim() || null,
        credentialExpiresAt: input.credentialExpiresAt ?? null,
        addedById: actorUserId,
      },
    });
    await recordAudit(
      {
        action: AuditAction.INSPECTION_AGENCY_CHANGED,
        resourceType: 'inspection_agency_member',
        resourceId: id,
        actorType: by.kind === 'OPERATOR' ? 'ADMIN' : 'CUSTOMER',
        actorUserId,
        after: { agencyId, role: input.role, fullName: input.fullName },
        correlationId: by.kind === 'OPERATOR' ? by.actor.correlationId ?? null : null,
      },
      tx,
    );
  });

  return { id };
}

export async function updateAgencyMember(
  by: { kind: 'OPERATOR'; actor: OperatorActor } | { kind: 'AGENCY'; membership: InspectionMembership },
  memberId: string,
  input: Partial<Omit<MemberInput, 'email'>> & { status?: 'ACTIVE' | 'DISABLED'; verifyIdentity?: boolean },
): Promise<void> {
  const member = await prisma.inspectionAgencyMember.findUnique({
    where: { id: memberId },
    select: { id: true, agencyId: true, userId: true },
  });
  if (member === null) throw notFound('Agency member');
  if (by.kind === 'AGENCY' && by.membership.agencyId !== member.agencyId) throw notFound('Agency member');

  // Verifying somebody's identity is the marketplace's check on the agency,
  // not the agency's on itself.
  if (input.verifyIdentity === true && by.kind !== 'OPERATOR') {
    throw forbidden(ErrorCode.PERMISSION_DENIED, 'Only the marketplace verifies an inspector’s identity.');
  }
  if (by.kind === 'AGENCY' && by.membership.memberId === memberId && input.status === 'DISABLED') {
    throw conflict(ErrorCode.CONFLICT, 'You cannot disable your own membership.');
  }

  const actorUserId = by.kind === 'OPERATOR' ? by.actor.userId : by.membership.userId;

  await prisma.$transaction(async (tx) => {
    await tx.inspectionAgencyMember.update({
      where: { id: memberId },
      data: {
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(input.fullName === undefined ? {} : { fullName: input.fullName.trim() }),
        ...(input.jobTitle === undefined ? {} : { jobTitle: input.jobTitle?.trim() || null }),
        ...(input.idDocumentType === undefined
          ? {}
          : { idDocumentType: input.idDocumentType?.trim() || null, identityVerifiedAt: null }),
        ...(input.idDocumentNumber === undefined
          ? {}
          : { idDocumentNumber: input.idDocumentNumber?.trim() || null, identityVerifiedAt: null }),
        ...(input.competenceCategoryIds === undefined
          ? {}
          : { competenceCategoryIdsJson: input.competenceCategoryIds ?? undefined }),
        ...(input.credentials === undefined ? {} : { credentials: input.credentials?.trim() || null }),
        ...(input.credentialExpiresAt === undefined ? {} : { credentialExpiresAt: input.credentialExpiresAt }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.verifyIdentity === true
          ? { identityVerifiedAt: new Date(), identityVerifiedById: actorUserId }
          : {}),
      },
    });
    await recordAudit(
      {
        action: AuditAction.INSPECTION_AGENCY_CHANGED,
        resourceType: 'inspection_agency_member',
        resourceId: memberId,
        actorType: by.kind === 'OPERATOR' ? 'ADMIN' : 'CUSTOMER',
        actorUserId,
        after: { ...input, idDocumentNumber: input.idDocumentNumber === undefined ? undefined : '[changed]' },
      },
      tx,
    );
  });
}

/** A document number as screens show it: the last four characters. */
export function maskDocumentNumber(value: string | null): string | null {
  if (value === null) return null;
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
}
