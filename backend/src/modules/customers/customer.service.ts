/**
 * Customers.
 *
 * Admin invitation is the primary onboarding path (SOP 7.1): the administrator
 * creates the account, the system emails a single-use activation link, and the
 * customer sets their own password. The admin never sees or sets it.
 *
 * Creating a customer touches three tables and sends an email. All three writes
 * share one transaction, and the email is queued through the outbox inside it -
 * so a rolled-back creation cannot leave a live invitation pointing at a user
 * who does not exist.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { normaliseEmail } from '../identity/auth.service.js';
import { revokeAllUserSessions } from '../identity/session.service.js';
import { buildTokenUrl, issueToken } from '../identity/token.service.js';
import {
  NotificationEvent,
  dispatchPendingNotifications,
  enqueueNotification,
} from '../notifications/notification.service.js';
import { Role } from '../../domain/permissions.js';

export interface CustomerActor {
  userId: string;
  email: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export interface AddressInput {
  kind?: 'BILLING' | 'SHIPPING' | 'BOTH';
  label?: string | null;
  contactName: string;
  contactPhone: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  isDefaultBilling?: boolean;
  isDefaultShipping?: boolean;
}

export interface CreateCustomerInput {
  email: string;
  fullName: string;
  organization?: string | null;
  department?: string | null;
  phone?: string | null;
  gstin?: string | null;
  customerCode?: string | null;
  internalNotes?: string | null;
  limits?: PurchasingLimitsInput;
  addresses?: AddressInput[];
  /** Send the activation email immediately. Default true. */
  sendInvitation?: boolean;
}

/**
 * Purchasing limits as they arrive from the admin panel.
 *
 * The amounts are per currency: the same account can have different terms in
 * each market it buys in, and a figure entered against one currency must never
 * be read against another. `requiresOrderApproval` is the exception - whether
 * an account needs sign-off is a policy about the account, not an amount.
 */
export interface PurchasingLimitsInput {
  requiresOrderApproval?: boolean;
  /** One entry per currency. Omitting a currency removes its terms. */
  perCurrency?: CurrencyLimitInput[];
}

export interface CurrencyLimitInput {
  currencyCode: string;
  perOrderMinMinor?: string | null;
  perOrderMaxMinor?: string | null;
  monthlySpendCapMinor?: string | null;
  approvalThresholdMinor?: string | null;
}

/** Money crosses the boundary as a string of minor units, never a JS number. */
function parseMinorOrNull(value: string | null | undefined, field: string): bigint | null {
  if (value === null || value === undefined) return null;
  if (!/^\d+$/.test(value.trim())) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Amounts must be whole minor units.', [
      { field, code: 'INVALID_MONEY' },
    ]);
  }
  return BigInt(value.trim());
}

interface LimitRow {
  currencyCode: string;
  perOrderMinMinor: bigint | null;
  perOrderMaxMinor: bigint | null;
  monthlySpendCapMinor: bigint | null;
  approvalThresholdMinor: bigint | null;
}

/** Wire shape for a customer's terms. Amounts are strings of minor units. */
function limitsView(
  requiresOrderApproval: boolean,
  rows: readonly LimitRow[],
): Record<string, unknown> {
  return {
    requiresOrderApproval,
    perCurrency: [...rows]
      .sort((a, b) => a.currencyCode.localeCompare(b.currencyCode))
      .map((row) => ({
        currencyCode: row.currencyCode,
        perOrderMinMinor: row.perOrderMinMinor?.toString() ?? null,
        perOrderMaxMinor: row.perOrderMaxMinor?.toString() ?? null,
        monthlySpendCapMinor: row.monthlySpendCapMinor?.toString() ?? null,
        approvalThresholdMinor: row.approvalThresholdMinor?.toString() ?? null,
      })),
  };
}

/** The only limit the profile row still carries. */
function approvalFlagData(limits: PurchasingLimitsInput | undefined): { requiresOrderApproval?: boolean } {
  if (limits?.requiresOrderApproval === undefined) return {};
  return { requiresOrderApproval: limits.requiresOrderApproval };
}

interface ParsedCurrencyLimit {
  currencyCode: string;
  perOrderMinMinor: bigint | null;
  perOrderMaxMinor: bigint | null;
  monthlySpendCapMinor: bigint | null;
  approvalThresholdMinor: bigint | null;
}

/** Validate each currency's terms. Returns null when the caller sent none. */
function parseCurrencyLimits(
  limits: PurchasingLimitsInput | undefined,
): ParsedCurrencyLimit[] | null {
  if (limits?.perCurrency === undefined) return null;

  const seen = new Set<string>();

  return limits.perCurrency.map((entry) => {
    const code = entry.currencyCode.trim().toUpperCase();

    if (seen.has(code)) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, `${code} is listed more than once.`, [
        { field: 'limits.perCurrency', code: 'DUPLICATE_CURRENCY' },
      ]);
    }
    seen.add(code);

    const field = `limits.perCurrency.${code}`;
    const perOrderMin = parseMinorOrNull(entry.perOrderMinMinor, `${field}.perOrderMinMinor`);
    const perOrderMax = parseMinorOrNull(entry.perOrderMaxMinor, `${field}.perOrderMaxMinor`);

    if (perOrderMin !== null && perOrderMax !== null && perOrderMax < perOrderMin) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        `The maximum ${code} order value cannot be lower than the minimum.`,
        [{ field: `${field}.perOrderMaxMinor`, code: 'INVALID_RANGE' }],
      );
    }

    return {
      currencyCode: code,
      perOrderMinMinor: perOrderMin,
      perOrderMaxMinor: perOrderMax,
      monthlySpendCapMinor: parseMinorOrNull(
        entry.monthlySpendCapMinor,
        `${field}.monthlySpendCapMinor`,
      ),
      approvalThresholdMinor: parseMinorOrNull(
        entry.approvalThresholdMinor,
        `${field}.approvalThresholdMinor`,
      ),
    };
  });
}

/**
 * Replace a customer's per-currency terms.
 *
 * Currencies absent from `parsed` have their terms withdrawn, which is how
 * staff stop an account buying in a market.
 */
async function writeCurrencyLimits(
  tx: PrismaTransaction,
  customerProfileId: string,
  parsed: ParsedCurrencyLimit[] | null,
  actorId: string | null,
): Promise<void> {
  if (parsed === null) return;

  await tx.customerLimit.deleteMany({
    where: {
      customerProfileId,
      currencyCode: { notIn: parsed.map((entry) => entry.currencyCode) },
    },
  });

  for (const entry of parsed) {
    const data = {
      perOrderMinMinor: entry.perOrderMinMinor,
      perOrderMaxMinor: entry.perOrderMaxMinor,
      monthlySpendCapMinor: entry.monthlySpendCapMinor,
      approvalThresholdMinor: entry.approvalThresholdMinor,
      updatedById: actorId,
    };

    await tx.customerLimit.upsert({
      where: {
        customerProfileId_currencyCode: {
          customerProfileId,
          currencyCode: entry.currencyCode,
        },
      },
      create: { customerProfileId, currencyCode: entry.currencyCode, ...data },
      update: data,
    });
  }
}

function addressCreateData(address: AddressInput, customerProfileId: string): Prisma.AddressUncheckedCreateInput {
  return {
    id: newId(),
    customerProfileId,
    kind: address.kind ?? 'BOTH',
    label: address.label ?? null,
    contactName: address.contactName.trim(),
    contactPhone: address.contactPhone.trim(),
    line1: address.line1.trim(),
    line2: address.line2 ?? null,
    city: address.city.trim(),
    state: address.state.trim(),
    postalCode: address.postalCode.trim(),
    country: address.country.trim().toUpperCase(),
    isDefaultBilling: address.isDefaultBilling ?? false,
    isDefaultShipping: address.isDefaultShipping ?? false,
  };
}

export interface CreatedCustomer {
  customerProfileId: string;
  userId: string;
  email: string;
  invitationSent: boolean;
}

export async function createCustomer(
  input: CreateCustomerInput,
  actor: CustomerActor,
): Promise<CreatedCustomer> {
  const emailNormalized = normaliseEmail(input.email);

  const existing = await prisma.user.findUnique({
    where: { emailNormalized },
    select: { id: true, type: true },
  });

  if (existing !== null) {
    throw conflict(ErrorCode.CONFLICT, 'An account already exists for that email address.', [
      { field: 'email', code: 'DUPLICATE_EMAIL' },
    ]);
  }

  const customerRole = await prisma.role.findUnique({ where: { key: Role.CUSTOMER } });
  if (customerRole === null) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'The customer role is missing. Run the seed to install roles and permissions.',
    );
  }

  const sendInvitation = input.sendInvitation ?? true;

  const result = await prisma.$transaction(async (tx) => {
    const userId = newId();
    const profileId = newId();

    await tx.user.create({
      data: {
        id: userId,
        type: 'CUSTOMER',
        email: input.email.trim(),
        emailNormalized,
        // No password. It is set by the customer when they accept the
        // invitation, so an administrator never knows it.
        passwordHash: null,
        status: 'PENDING_INVITATION',
        phone: input.phone ?? null,
        roles: { create: { roleId: customerRole.id, assignedById: actor.userId } },
      },
    });

    await tx.customerProfile.create({
      data: {
        id: profileId,
        userId,
        fullName: input.fullName.trim(),
        organization: input.organization ?? null,
        department: input.department ?? null,
        phone: input.phone ?? null,
        gstin: input.gstin ?? null,
        customerCode: input.customerCode ?? null,
        internalNotes: input.internalNotes ?? null,
        invitedById: actor.userId,
        invitedAt: sendInvitation ? new Date() : null,
        ...approvalFlagData(input.limits),
      },
    });

    await writeCurrencyLimits(tx, profileId, parseCurrencyLimits(input.limits), actor.userId);

    if (input.addresses !== undefined && input.addresses.length > 0) {
      await tx.address.createMany({
        data: input.addresses.map((address) => addressCreateData(address, profileId)),
      });
    }

    if (sendInvitation) {
      // Token and email are issued inside the transaction, so a rollback takes
      // both with it - no live invitation for a user that was never created.
      const invitation = await issueToken(userId, 'INVITATION', actor.userId, tx);

      await enqueueNotification(
        {
          eventKey: NotificationEvent.CUSTOMER_INVITATION,
          recipientEmail: input.email.trim(),
          recipientName: input.fullName.trim(),
          variables: {
            activationUrl: buildTokenUrl('INVITATION', invitation.token, 'CUSTOMER'),
            expiresAt: invitation.expiresAt.toISOString(),
          },
          dedupeKey: `invitation:${userId}:${invitation.expiresAt.getTime()}`,
          relatedType: 'user',
          relatedId: userId,
          correlationId: actor.correlationId ?? null,
        },
        tx,
      );
    }

    await recordAudit(
      {
        action: AuditAction.CUSTOMER_CREATED,
        resourceType: 'customer',
        resourceId: profileId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: {
          email: input.email,
          fullName: input.fullName,
          organization: input.organization,
          invitationSent: sendInvitation,
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    return { customerProfileId: profileId, userId, email: input.email.trim() };
  });

  // After commit: hand the queued notification to the worker. Doing this inside
  // the transaction would let the worker read an outbox row that is not
  // committed yet.
  if (sendInvitation) await dispatchPendingNotifications();

  return { ...result, invitationSent: sendInvitation };
}

export interface UpdateCustomerInput {
  fullName?: string;
  organization?: string | null;
  department?: string | null;
  phone?: string | null;
  gstin?: string | null;
  customerCode?: string | null;
  internalNotes?: string | null;
}

export async function updateCustomer(
  customerProfileId: string,
  input: UpdateCustomerInput,
  actor: CustomerActor,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.customerProfile.findUnique({ where: { id: customerProfileId } });
    if (existing === null) throw notFound('Customer');

    const data: Prisma.CustomerProfileUncheckedUpdateInput = {};
    if (input.fullName !== undefined) data.fullName = input.fullName.trim();
    if (input.organization !== undefined) data.organization = input.organization;
    if (input.department !== undefined) data.department = input.department;
    if (input.phone !== undefined) data.phone = input.phone;
    if (input.gstin !== undefined) data.gstin = input.gstin;
    if (input.customerCode !== undefined) data.customerCode = input.customerCode;
    if (input.internalNotes !== undefined) data.internalNotes = input.internalNotes;

    await tx.customerProfile.update({ where: { id: customerProfileId }, data });

    await recordAudit(
      {
        action: AuditAction.CUSTOMER_UPDATED,
        resourceType: 'customer',
        resourceId: customerProfileId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: {
          fullName: existing.fullName,
          organization: existing.organization,
          department: existing.department,
        },
        after: input,
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}

/**
 * Change purchasing limits.
 *
 * Audited separately from a general profile edit: limits are a financial
 * control, and "who raised this customer's cap to 50 lakh" is a question that
 * gets asked after the fact.
 */
export async function updatePurchasingLimits(
  customerProfileId: string,
  limits: PurchasingLimitsInput,
  actor: CustomerActor,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.customerProfile.findUnique({
      where: { id: customerProfileId },
      include: { limits: true },
    });
    if (existing === null) throw notFound('Customer');

    await tx.customerProfile.update({
      where: { id: customerProfileId },
      data: approvalFlagData(limits),
    });

    await writeCurrencyLimits(tx, customerProfileId, parseCurrencyLimits(limits), actor.userId);

    await recordAudit(
      {
        action: AuditAction.CUSTOMER_LIMITS_CHANGED,
        resourceType: 'customer',
        resourceId: customerProfileId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: {
          requiresOrderApproval: existing.requiresOrderApproval,
          // Every currency's terms, so "who raised this account's dollar cap"
          // is answerable from the trail alone.
          perCurrency: existing.limits.map((row) => ({
            currencyCode: row.currencyCode,
            perOrderMinMinor: row.perOrderMinMinor?.toString() ?? null,
            perOrderMaxMinor: row.perOrderMaxMinor?.toString() ?? null,
            monthlySpendCapMinor: row.monthlySpendCapMinor?.toString() ?? null,
            approvalThresholdMinor: row.approvalThresholdMinor?.toString() ?? null,
          })),
        },
        after: limits,
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}

/**
 * Activate or deactivate an account.
 *
 * Deactivation revokes every session immediately. SOP 3.1 requires that a
 * deactivated user loses access now, not at their next sign-in attempt - an
 * access token issued a minute ago would otherwise keep working.
 */
export async function setCustomerStatus(
  customerProfileId: string,
  active: boolean,
  actor: CustomerActor,
  reason?: string,
): Promise<{ sessionsRevoked: number }> {
  const profile = await prisma.customerProfile.findUnique({
    where: { id: customerProfileId },
    include: { user: { select: { id: true, email: true, status: true } } },
  });

  if (profile === null) throw notFound('Customer');

  let sessionsRevoked = 0;

  await prisma.$transaction(async (tx) => {
    // Reactivating a never-activated account must return it to
    // PENDING_INVITATION, not ACTIVE - it still has no password.
    const nextStatus = active
      ? profile.activatedAt === null
        ? 'PENDING_INVITATION'
        : 'ACTIVE'
      : 'DEACTIVATED';

    await tx.user.update({ where: { id: profile.userId }, data: { status: nextStatus } });

    await recordAudit(
      {
        action: AuditAction.CUSTOMER_STATUS_CHANGED,
        resourceType: 'customer',
        resourceId: customerProfileId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { status: profile.user.status },
        after: { status: nextStatus, reason: reason ?? null },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  if (!active) {
    sessionsRevoked = await revokeAllUserSessions(profile.userId, reason ?? 'deactivated_by_admin');
  }

  return { sessionsRevoked };
}

/**
 * Resend an invitation.
 *
 * `issueToken` supersedes any outstanding invitation, so the previous link
 * stops working the moment a new one is sent.
 */
export async function resendInvitation(
  customerProfileId: string,
  actor: CustomerActor,
): Promise<{ expiresAt: Date }> {
  const profile = await prisma.customerProfile.findUnique({
    where: { id: customerProfileId },
    include: { user: { select: { id: true, email: true, status: true } } },
  });

  if (profile === null) throw notFound('Customer');

  if (profile.user.status === 'ACTIVE') {
    throw conflict(
      ErrorCode.INVITATION_ALREADY_ACCEPTED,
      'This account is already active. Send a password reset instead.',
    );
  }

  if (profile.user.status === 'DEACTIVATED') {
    throw conflict(
      ErrorCode.ACCOUNT_DEACTIVATED,
      'This account is deactivated. Reactivate it before re-inviting.',
    );
  }

  const invitation = await prisma.$transaction(async (tx) => {
    const issued = await issueToken(profile.userId, 'INVITATION', actor.userId, tx);

    await tx.customerProfile.update({
      where: { id: customerProfileId },
      data: { invitedAt: new Date(), invitedById: actor.userId },
    });

    await enqueueNotification(
      {
        eventKey: NotificationEvent.CUSTOMER_INVITATION,
        recipientEmail: profile.user.email,
        recipientName: profile.fullName,
        variables: {
          activationUrl: buildTokenUrl('INVITATION', issued.token, 'CUSTOMER'),
          expiresAt: issued.expiresAt.toISOString(),
        },
        dedupeKey: `invitation:${profile.userId}:${issued.expiresAt.getTime()}`,
        relatedType: 'user',
        relatedId: profile.userId,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    await recordAudit(
      {
        action: AuditAction.CUSTOMER_INVITED,
        resourceType: 'customer',
        resourceId: customerProfileId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { resent: true, expiresAt: issued.expiresAt.toISOString() },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    return issued;
  });

  await dispatchPendingNotifications();

  return { expiresAt: invitation.expiresAt };
}

// --- Addresses -------------------------------------------------------------

/**
 * Add an address.
 *
 * Setting a default clears the previous one in the same transaction, so a
 * customer can never end up with two default shipping addresses and a checkout
 * that silently picks whichever the database returned first.
 */
export async function addAddress(
  customerProfileId: string,
  input: AddressInput,
  actor: CustomerActor,
): Promise<{ addressId: string }> {
  return prisma.$transaction(async (tx) => {
    const profile = await tx.customerProfile.findUnique({
      where: { id: customerProfileId },
      select: { id: true },
    });
    if (profile === null) throw notFound('Customer');

    const existingCount = await tx.address.count({
      where: { customerProfileId, archivedAt: null },
    });

    // The first address is the default for both, so checkout always has one.
    const isFirst = existingCount === 0;
    const data = addressCreateData(
      {
        ...input,
        isDefaultBilling: input.isDefaultBilling ?? isFirst,
        isDefaultShipping: input.isDefaultShipping ?? isFirst,
      },
      customerProfileId,
    );

    if (data.isDefaultBilling === true) {
      await tx.address.updateMany({
        where: { customerProfileId, isDefaultBilling: true },
        data: { isDefaultBilling: false },
      });
    }
    if (data.isDefaultShipping === true) {
      await tx.address.updateMany({
        where: { customerProfileId, isDefaultShipping: true },
        data: { isDefaultShipping: false },
      });
    }

    await tx.address.create({ data });

    await recordAudit(
      {
        action: AuditAction.CUSTOMER_UPDATED,
        resourceType: 'customer',
        resourceId: customerProfileId,
        actorType: actor.userId === '' ? 'CUSTOMER' : 'ADMIN',
        actorUserId: actor.userId === '' ? null : actor.userId,
        actorEmail: actor.email,
        after: { addressAdded: data.id, city: data.city },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    return { addressId: data.id };
  });
}

export async function updateAddress(
  customerProfileId: string,
  addressId: string,
  input: Partial<AddressInput>,
  _actor: CustomerActor,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Scoped by customerProfileId, so one customer cannot edit another's
    // address by guessing an id.
    const existing = await tx.address.findFirst({
      where: { id: addressId, customerProfileId, archivedAt: null },
    });
    if (existing === null) throw notFound('Address');

    const data: Prisma.AddressUncheckedUpdateInput = {};
    if (input.kind !== undefined) data.kind = input.kind;
    if (input.label !== undefined) data.label = input.label;
    if (input.contactName !== undefined) data.contactName = input.contactName.trim();
    if (input.contactPhone !== undefined) data.contactPhone = input.contactPhone.trim();
    if (input.line1 !== undefined) data.line1 = input.line1.trim();
    if (input.line2 !== undefined) data.line2 = input.line2;
    if (input.city !== undefined) data.city = input.city.trim();
    if (input.state !== undefined) data.state = input.state.trim();
    if (input.postalCode !== undefined) data.postalCode = input.postalCode.trim();
    if (input.country !== undefined) data.country = input.country.trim().toUpperCase();

    if (input.isDefaultBilling === true) {
      await tx.address.updateMany({
        where: { customerProfileId, isDefaultBilling: true },
        data: { isDefaultBilling: false },
      });
      data.isDefaultBilling = true;
    }
    if (input.isDefaultShipping === true) {
      await tx.address.updateMany({
        where: { customerProfileId, isDefaultShipping: true },
        data: { isDefaultShipping: false },
      });
      data.isDefaultShipping = true;
    }

    await tx.address.update({ where: { id: addressId }, data });
  });
}

/**
 * Archive an address.
 *
 * Soft delete: orders keep their own JSON snapshot, but recurring schedules
 * reference the row, so a hard delete would break future runs.
 */
export async function archiveAddress(
  customerProfileId: string,
  addressId: string,
): Promise<void> {
  const address = await prisma.address.findFirst({
    where: { id: addressId, customerProfileId, archivedAt: null },
  });
  if (address === null) throw notFound('Address');

  const scheduleCount = await prisma.recurringSchedule.count({
    where: {
      status: { in: ['ACTIVE', 'PAUSED'] },
      OR: [{ shippingAddressId: addressId }, { billingAddressId: addressId }],
    },
  });

  if (scheduleCount > 0) {
    throw conflict(
      ErrorCode.CONFLICT,
      `This address is used by ${String(scheduleCount)} recurring schedule(s). Update those first.`,
      [{ field: 'addressId', code: 'IN_USE_BY_SCHEDULE', meta: { scheduleCount } }],
    );
  }

  await prisma.address.update({
    where: { id: addressId },
    data: { archivedAt: new Date(), isDefaultBilling: false, isDefaultShipping: false },
  });
}

// --- Reads -----------------------------------------------------------------

export interface CustomerListQuery {
  page?: number;
  limit?: number;
  q?: string;
  status?: 'PENDING_INVITATION' | 'PENDING_APPROVAL' | 'ACTIVE' | 'DEACTIVATED';
  organization?: string;
}

export async function listCustomers(query: CustomerListQuery = {}): Promise<{
  customers: Record<string, unknown>[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const page = query.page ?? 1;
  const limit = Math.min(query.limit ?? 25, 100);

  const where: Prisma.CustomerProfileWhereInput = {
    ...(query.status !== undefined ? { user: { status: query.status } } : {}),
    ...(query.organization !== undefined ? { organization: { contains: query.organization } } : {}),
    ...(query.q !== undefined && query.q.length > 0
      ? {
          OR: [
            { fullName: { contains: query.q } },
            { organization: { contains: query.q } },
            { customerCode: { contains: query.q } },
            { user: { emailNormalized: { contains: query.q.toLowerCase() } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.customerProfile.findMany({
      where,
      // `id` as a tiebreaker keeps pagination stable.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
      include: {
        user: { select: { id: true, email: true, status: true, lastLoginAt: true } },
        limits: true,
        _count: { select: { orders: true, schedules: true, addresses: true } },
      },
    }),
    prisma.customerProfile.count({ where }),
  ]);

  return {
    customers: rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      email: row.user.email,
      status: row.user.status,
      fullName: row.fullName,
      organization: row.organization,
      department: row.department,
      phone: row.phone,
      customerCode: row.customerCode,
      activatedAt: row.activatedAt?.toISOString() ?? null,
      invitedAt: row.invitedAt?.toISOString() ?? null,
      lastLoginAt: row.user.lastLoginAt?.toISOString() ?? null,
      orderCount: row._count.orders,
      scheduleCount: row._count.schedules,
      addressCount: row._count.addresses,
      limits: limitsView(row.requiresOrderApproval, row.limits),
      createdAt: row.createdAt.toISOString(),
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getCustomer(customerProfileId: string): Promise<Record<string, unknown>> {
  const profile = await prisma.customerProfile.findUnique({
    where: { id: customerProfileId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          status: true,
          lastLoginAt: true,
          emailVerifiedAt: true,
          createdAt: true,
        },
      },
      addresses: { where: { archivedAt: null }, orderBy: { createdAt: 'asc' } },
      limits: true,
      _count: { select: { orders: true, schedules: true } },
    },
  });

  if (profile === null) throw notFound('Customer');

  return {
    id: profile.id,
    userId: profile.userId,
    email: profile.user.email,
    status: profile.user.status,
    fullName: profile.fullName,
    organization: profile.organization,
    department: profile.department,
    phone: profile.phone,
    gstin: profile.gstin,
    customerCode: profile.customerCode,
    // Internal notes are admin-only; this function is never called from a
    // customer-facing route.
    internalNotes: profile.internalNotes,
    consentAcceptedAt: profile.consentAcceptedAt?.toISOString() ?? null,
    consentVersion: profile.consentVersion,
    invitedAt: profile.invitedAt?.toISOString() ?? null,
    activatedAt: profile.activatedAt?.toISOString() ?? null,
    lastLoginAt: profile.user.lastLoginAt?.toISOString() ?? null,
    limits: limitsView(profile.requiresOrderApproval, profile.limits),
    addresses: profile.addresses,
    orderCount: profile._count.orders,
    scheduleCount: profile._count.schedules,
    createdAt: profile.user.createdAt.toISOString(),
  };
}

/** Whether self-registration is available, for the storefront to branch on. */
export function selfRegistrationEnabled(): boolean {
  return env.FEATURE_CUSTOMER_SELF_REGISTRATION;
}
