/**
 * The operator's side of the logistics portal.
 *
 * Everything a member of the marketplace's own staff does TO a carrier:
 * create it, approve what it may carry, set its regions and SLA, invite its
 * first owner, assign it work, suspend it, correct a status it got wrong, and
 * rotate the credentials of the API it is wired through.
 *
 * WHY THIS IS A SEPARATE FILE FROM `partner.service.ts`
 *
 * Because the argument shapes are different, visibly. Every partner-facing
 * function in this module takes a `LogisticsMembership` - a tenant, resolved
 * from a session. Every function HERE takes ids directly, because the caller
 * is the marketplace and its authority is an admin permission rather than a
 * membership. Keeping the two shapes apart is what makes it obvious, at a
 * glance, which side of the boundary a piece of code is on; a file that took
 * both would be a file where somebody eventually passed the wrong one.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 *
 * **A logistics partner is created here and nowhere else.** There is no public
 * registration route, no self-service sign-up, and no endpoint anywhere that
 * creates a `LogisticsPartner` without `logistics.write`. That is the first of
 * the portal's access rules and the easiest one to lose by accident, which is
 * why creation lives in one function in one file with one permission in front
 * of it.
 */
import type {
  CarrierProvider,
  LogisticsCapabilityKind,
  LogisticsCapabilityState,
  LogisticsPartnerRole,
  LogisticsPartnerStatus,
  LogisticsRegionScope,
  LogisticsServiceType,
} from '../../generated/prisma/enums.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import {
  assertShipmentCorrection,
  type ShipmentStatusName,
} from '../../domain/logistics-shipment-state.js';
import { encryptSecret, generateToken, maskSecret } from '../../infra/crypto.js';
import { newId, newRandomId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { OPERATOR_LABEL, recordLogisticsAudit } from './audit.service.js';
import { withdrawAssignment } from './assignment.service.js';
import { recordShipmentEvent } from './shipment-event.service.js';
import {
  inviteLogisticsUser,
  normaliseLogisticsName,
  type InvitedLogisticsUser,
} from './partner.service.js';

export interface AdminActor {
  userId: string;
  email: string;
  permissions: readonly string[];
  ipAddress?: string | null;
  correlationId?: string | null;
}

// ---------------------------------------------------------------------------
// Creating a carrier
// ---------------------------------------------------------------------------

export interface CreatePartnerInput {
  legalName: string;
  displayName: string;
  registrationCountry: string;
  contactEmail: string;
  contactPhone?: string | null;
  emergencyPhone?: string | null;
  websiteUrl?: string | null;
  registrationNumber?: string | null;
  taxNumber?: string | null;
  licenceNumber?: string | null;
  licenceExpiresAt?: Date | null;
  addressJson?: unknown;
  contractReference?: string | null;
  contractStartsAt?: Date | null;
  contractEndsAt?: Date | null;
  maxOpenShipments?: number | null;
  carrierIntegrationId?: string | null;
  internalNotes?: string | null;
  /** The first person at the carrier. Invited in the same transaction. */
  ownerEmail: string;
  ownerFullName: string;
}

export interface CreatedPartner {
  id: string;
  partnerCode: string;
  displayName: string;
  invitation: InvitedLogisticsUser;
}

/** `LP-000123`. Sequential, operator-facing, and never shown to a buyer. */
async function nextPartnerCode(): Promise<string> {
  const key = 'logistics-partner';

  await prisma.numberSequence.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1, prefix: 'LP', padding: 5 },
  });

  const sequence = await prisma.numberSequence.findUniqueOrThrow({ where: { key } });
  return `${sequence.prefix}-${sequence.value.toString().padStart(sequence.padding, '0')}`;
}

/**
 * Create a carrier and invite its first owner.
 *
 * The two happen together, deliberately. A carrier account with nobody in it
 * is an account nobody can activate, and the operator would have to remember a
 * second step - which they would forget, and which would surface as "the
 * portal does not work" a week later.
 *
 * The carrier starts PENDING_ACTIVATION. It becomes ACTIVE when the operator
 * says so, not when the owner accepts: accepting an invitation proves somebody
 * read an email, and does not prove the marketplace finished its checks.
 */
export async function createLogisticsPartner(
  actor: AdminActor,
  input: CreatePartnerInput,
): Promise<CreatedPartner> {
  const displayNameNormalized = normaliseLogisticsName(input.displayName);

  if (displayNameNormalized.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'That trading name cannot be used.', [
      { field: 'displayName', code: 'UNUSABLE_NAME' },
    ]);
  }

  const clash = await prisma.logisticsPartner.findFirst({
    where: { displayNameNormalized },
    select: { id: true, displayName: true },
  });

  if (clash !== null) {
    throw conflict(
      ErrorCode.CONFLICT,
      `A carrier called "${clash.displayName}" already exists. Two carriers that look identical ` +
        'on an assignment list is how a consignment goes to the wrong company.',
      [{ field: 'displayName', code: 'ALREADY_EXISTS' }],
    );
  }

  const id = newId();
  const partnerCode = await nextPartnerCode();

  await prisma.logisticsPartner.create({
    data: {
      id,
      partnerCode,
      legalName: input.legalName.trim().slice(0, 255),
      displayName: input.displayName.trim().slice(0, 160),
      displayNameNormalized,
      registrationCountry: input.registrationCountry.toUpperCase(),
      contactEmail: input.contactEmail.trim(),
      contactPhone: input.contactPhone ?? null,
      emergencyPhone: input.emergencyPhone ?? null,
      websiteUrl: input.websiteUrl ?? null,
      registrationNumber: input.registrationNumber ?? null,
      taxNumber: input.taxNumber ?? null,
      licenceNumber: input.licenceNumber ?? null,
      licenceExpiresAt: input.licenceExpiresAt ?? null,
      addressJson: (input.addressJson ?? undefined) as never,
      status: 'PENDING_ACTIVATION',
      contractStatus: (input.contractReference === undefined || input.contractReference === null) ? 'DRAFT' : 'ACTIVE',
      contractReference: input.contractReference ?? null,
      contractStartsAt: input.contractStartsAt ?? null,
      contractEndsAt: input.contractEndsAt ?? null,
      maxOpenShipments: input.maxOpenShipments ?? null,
      carrierIntegrationId: input.carrierIntegrationId ?? null,
      internalNotes: input.internalNotes ?? null,
      createdById: actor.userId,
    },
  });

  const invitation = await inviteLogisticsUser({
    logisticsPartnerId: id,
    email: input.ownerEmail,
    fullName: input.ownerFullName,
    role: 'LOGISTICS_PARTNER_OWNER',
    invitedByPartnerUserId: null,
    invitedByAdminUserId: actor.userId,
    actorLabel: OPERATOR_LABEL,
    correlationId: actor.correlationId ?? null,
  });

  await recordAudit({
    action: AuditAction.SETTINGS_UPDATED,
    resourceType: 'logistics_partner',
    resourceId: id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    after: { partnerCode, displayName: input.displayName },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return { id, partnerCode, displayName: input.displayName, invitation };
}

/**
 * Activate, suspend or close a carrier.
 *
 * Suspending is deliberately NOT the end of the carrier's access. It stops new
 * work being offered and leaves everything already in its hands workable, so
 * the twelve parcels in its vans can still be delivered and tracked. Cutting a
 * carrier off mid-journey punishes the customer rather than the carrier.
 *
 * `handoverShipments` is the explicit path for the other case: the operator
 * wants those twelve parcels back, now, and each one is withdrawn with a
 * reason that the carrier can read and the audit trail records.
 */
export async function setPartnerStatus(
  actor: AdminActor,
  partnerId: string,
  status: LogisticsPartnerStatus,
  reason: string | null,
  options: { handoverShipments?: boolean } = {},
): Promise<{ withdrawn: number }> {
  const partner = await prisma.logisticsPartner.findFirst({
    where: { id: partnerId, archivedAt: null },
    select: { id: true, status: true, displayName: true },
  });

  if (partner === null) throw notFound('Logistics partner');

  if ((status === 'SUSPENDED' || status === 'DEACTIVATED') && (reason ?? '').trim().length < 8) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Say why. The carrier is shown this, and a carrier told only "suspended" cannot fix anything.',
      [{ field: 'reason', code: 'REASON_REQUIRED' }],
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.logisticsPartner.update({
      where: { id: partner.id },
      data: {
        status,
        suspensionReason: status === 'SUSPENDED' ? reason : null,
        suspendedAt: status === 'SUSPENDED' ? new Date() : null,
        ...(status === 'DEACTIVATED' ? { contractStatus: 'TERMINATED' } : {}),
      },
    });

    await recordLogisticsAudit(
      {
        logisticsPartnerId: partner.id,
        actorUserId: actor.userId,
        actorLabel: OPERATOR_LABEL,
        action: 'logistics.partner.status_changed',
        resourceType: 'logistics_partner',
        resourceId: partner.id,
        before: { status: partner.status },
        after: { status, reason },
        summary:
          status === 'SUSPENDED'
            ? `Your account was suspended: ${reason ?? ''}`
            : `Your account status is now ${status}.`,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  /*
   * A DEACTIVATED carrier's people cannot sign in at all.
   *
   * Their sessions are revoked outside the transaction, for the same reason a
   * disabled member's are: revoking a session is not part of the status change
   * and must not be able to roll it back.
   */
  if (status === 'DEACTIVATED') {
    const members = await prisma.logisticsPartnerUser.findMany({
      where: { logisticsPartnerId: partner.id },
      select: { userId: true },
    });

    await prisma.session.updateMany({
      where: { userId: { in: members.map((member) => member.userId) }, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'logistics_partner_deactivated' },
    });
  }

  let withdrawn = 0;

  if (options.handoverShipments === true) {
    const live = await prisma.logisticsShipmentAssignment.findMany({
      where: { logisticsPartnerId: partner.id, state: { in: ['OFFERED', 'ACCEPTED'] } },
      select: { shipmentId: true },
    });

    for (const assignment of live) {
      try {
        await withdrawAssignment({
          shipmentId: assignment.shipmentId,
          reason: reason ?? `${partner.displayName} is no longer carrying for this marketplace.`,
          actorUserId: actor.userId,
          correlationId: actor.correlationId ?? null,
        });
        withdrawn += 1;
      } catch {
        // One stubborn consignment must not stop the handover. It stays with
        // the carrier and shows on the operator's list as still assigned.
        continue;
      }
    }
  }

  await recordAudit({
    action: AuditAction.SETTINGS_UPDATED,
    resourceType: 'logistics_partner',
    resourceId: partner.id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: { status: partner.status },
    after: { status, reason, withdrawn },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return { withdrawn };
}

// ---------------------------------------------------------------------------
// What a carrier may carry, and where
// ---------------------------------------------------------------------------

/**
 * Set a carrier's approved service regions.
 *
 * Operator-only, and that is the point. A carrier that could widen its own
 * approved regions could assign itself work it is not licensed or insured to
 * carry - and on a catalogue of medical goods that is not a theoretical
 * objection.
 *
 * The whole set is replaced rather than patched, so what is stored is always
 * exactly what the operator last approved. A patch API would eventually leave
 * a region nobody remembers adding.
 */
export async function setServiceRegions(
  actor: AdminActor,
  partnerId: string,
  regions: readonly {
    scope: LogisticsRegionScope;
    countryCode: string;
    regionValue?: string | null;
    supportsPickup?: boolean;
    supportsDelivery?: boolean;
  }[],
): Promise<{ count: number }> {
  const partner = await prisma.logisticsPartner.findFirst({
    where: { id: partnerId, archivedAt: null },
    select: { id: true },
  });

  if (partner === null) throw notFound('Logistics partner');

  await prisma.$transaction(async (tx) => {
    await tx.logisticsServiceRegion.deleteMany({ where: { logisticsPartnerId: partner.id } });

    await tx.logisticsServiceRegion.createMany({
      data: regions.map((region) => ({
        id: newId(),
        logisticsPartnerId: partner.id,
        scope: region.scope,
        countryCode: region.countryCode.toUpperCase(),
        // NOT NULL with an empty-string default: MariaDB treats every NULL in
        // a UNIQUE index as distinct, so a nullable column here would let one
        // carrier hold two "the whole of Belgium" rows.
        regionValue: (region.regionValue ?? '').trim().toUpperCase(),
        supportsPickup: region.supportsPickup ?? true,
        supportsDelivery: region.supportsDelivery ?? true,
      })),
      skipDuplicates: true,
    });

    await recordLogisticsAudit(
      {
        logisticsPartnerId: partner.id,
        actorUserId: actor.userId,
        actorLabel: OPERATOR_LABEL,
        action: 'logistics.partner.regions_set',
        resourceType: 'logistics_partner',
        resourceId: partner.id,
        after: { count: regions.length },
        summary: `Your approved service regions were updated (${String(regions.length)}).`,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return { count: regions.length };
}

/**
 * Approve, refuse or suspend one capability.
 *
 * A capability is an APPROVAL with evidence behind it, not a claim. Only an
 * APPROVED one is matched against a consignment that needs it, so this is the
 * function that decides whether a carrier is offered reagents.
 */
export async function decideCapability(
  actor: AdminActor,
  partnerId: string,
  kind: LogisticsCapabilityKind,
  decision: {
    state: LogisticsCapabilityState;
    evidenceReference?: string | null;
    evidenceExpiresAt?: Date | null;
    temperatureMinC?: number | null;
    temperatureMaxC?: number | null;
    note?: string | null;
  },
): Promise<void> {
  const partner = await prisma.logisticsPartner.findFirst({
    where: { id: partnerId, archivedAt: null },
    select: { id: true },
  });

  if (partner === null) throw notFound('Logistics partner');

  const existing = await prisma.logisticsCapability.findFirst({
    where: { logisticsPartnerId: partner.id, kind },
    select: { id: true, state: true },
  });

  const data = {
    state: decision.state,
    evidenceReference: decision.evidenceReference ?? null,
    evidenceExpiresAt: decision.evidenceExpiresAt ?? null,
    temperatureMinC: decision.temperatureMinC ?? null,
    temperatureMaxC: decision.temperatureMaxC ?? null,
    decidedByUserId: actor.userId,
    decidedAt: new Date(),
    decisionNote: decision.note ?? null,
  };

  await prisma.$transaction(async (tx) => {
    if (existing === null) {
      await tx.logisticsCapability.create({
        data: { id: newId(), logisticsPartnerId: partner.id, kind, ...data },
      });
    } else {
      await tx.logisticsCapability.update({ where: { id: existing.id }, data });
    }

    await recordLogisticsAudit(
      {
        logisticsPartnerId: partner.id,
        actorUserId: actor.userId,
        actorLabel: OPERATOR_LABEL,
        action: 'logistics.capability.decided',
        resourceType: 'logistics_capability',
        resourceId: existing?.id ?? null,
        before: existing === null ? undefined : { state: existing.state },
        after: { kind, state: decision.state },
        summary: `${kind} is now ${decision.state}.`,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}

/** Create or replace one SLA policy. */
export async function upsertSlaPolicy(
  actor: AdminActor,
  partnerId: string,
  policy: {
    id?: string | null;
    name: string;
    serviceType: LogisticsServiceType;
    pickupHours?: number | null;
    deliveryHours?: number | null;
    riskWindowMinutes?: number;
    maxDeliveryAttempts?: number;
    podRequiresRecipientName?: boolean;
    podRequiresSignature?: boolean;
    podRequiresPhoto?: boolean;
    podRequiresOtp?: boolean;
    podRequiresDesignation?: boolean;
    isDefault?: boolean;
    isActive?: boolean;
  },
): Promise<{ id: string }> {
  const partner = await prisma.logisticsPartner.findFirst({
    where: { id: partnerId, archivedAt: null },
    select: { id: true },
  });

  if (partner === null) throw notFound('Logistics partner');

  const id = policy.id ?? newId();

  const data = {
    name: policy.name.trim().slice(0, 120),
    serviceType: policy.serviceType,
    pickupHours: policy.pickupHours ?? null,
    deliveryHours: policy.deliveryHours ?? null,
    riskWindowMinutes: policy.riskWindowMinutes ?? 120,
    maxDeliveryAttempts: policy.maxDeliveryAttempts ?? 3,
    podRequiresRecipientName: policy.podRequiresRecipientName ?? true,
    podRequiresSignature: policy.podRequiresSignature ?? false,
    podRequiresPhoto: policy.podRequiresPhoto ?? false,
    podRequiresOtp: policy.podRequiresOtp ?? false,
    podRequiresDesignation: policy.podRequiresDesignation ?? false,
    isDefault: policy.isDefault ?? false,
    isActive: policy.isActive ?? true,
  };

  await prisma.$transaction(async (tx) => {
    // One default per carrier. Demoting the others first is what stops two
    // policies both claiming to be the fallback, which would make which one
    // applies depend on row order.
    if (data.isDefault) {
      await tx.logisticsSlaPolicy.updateMany({
        where: { logisticsPartnerId: partner.id },
        data: { isDefault: false },
      });
    }

    await tx.logisticsSlaPolicy.upsert({
      where: { id },
      create: { id, logisticsPartnerId: partner.id, ...data },
      update: data,
    });

    await recordLogisticsAudit(
      {
        logisticsPartnerId: partner.id,
        actorUserId: actor.userId,
        actorLabel: OPERATOR_LABEL,
        action: 'logistics.sla.updated',
        resourceType: 'logistics_sla_policy',
        resourceId: id,
        after: data,
        summary: `Your "${data.name}" service level was updated.`,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return { id };
}

/** Invite somebody into a carrier, as the marketplace. */
export async function inviteAsOperator(
  actor: AdminActor,
  partnerId: string,
  input: { email: string; fullName: string; role: LogisticsPartnerRole },
): Promise<InvitedLogisticsUser> {
  return inviteLogisticsUser({
    logisticsPartnerId: partnerId,
    email: input.email,
    fullName: input.fullName,
    role: input.role,
    invitedByPartnerUserId: null,
    invitedByAdminUserId: actor.userId,
    actorLabel: OPERATOR_LABEL,
    correlationId: actor.correlationId ?? null,
  });
}

// ---------------------------------------------------------------------------
// Correcting the record
// ---------------------------------------------------------------------------

/**
 * The operator says the status is wrong.
 *
 * NOT a transition. A correction is the marketplace overruling the timeline,
 * and it is the only way out of DELIVERED, RETURNED, LOST or CANCELLED in the
 * wrong direction. It exists because the alternative - an operator with no way
 * to fix a mis-scan - produces a support process that edits the database by
 * hand, which is worse in every way including the audit trail.
 *
 * Three conditions, all enforced: the actor is the marketplace's own staff, a
 * written reason of at least eight characters is mandatory, and the resulting
 * event is flagged `isCorrection` so a corrected timeline is legible as
 * corrected months later.
 */
export async function correctShipmentStatus(
  actor: AdminActor,
  shipmentId: string,
  to: ShipmentStatusName,
  reason: string,
): Promise<{ status: ShipmentStatusName }> {
  const shipment = await prisma.logisticsShipment.findUnique({
    where: { id: shipmentId },
    select: { id: true, status: true, shipmentReference: true, assignedPartnerId: true },
  });

  if (shipment === null) throw notFound('Shipment');

  assertShipmentCorrection({
    from: shipment.status,
    to,
    actor: 'UBOSS_ADMIN',
    reason,
  });

  const event = await recordShipmentEvent({
    shipmentId: shipment.id,
    status: to,
    actor: 'UBOSS_ADMIN',
    source: 'UBOSS_ADMIN',
    actorUserId: actor.userId,
    actorLabel: OPERATOR_LABEL,
    reason,
    isCorrection: true,
    internalNote: `Corrected by ${actor.email}.`,
    publicDescription: 'We have corrected the status of this delivery.',
    // A correction bypasses the POD requirement by definition: an operator
    // correcting a wrongly-delivered consignment cannot produce proof of a
    // delivery that did not happen.
    hasProofOfDelivery: true,
    correlationId: actor.correlationId ?? null,
  });

  await recordAudit({
    action: AuditAction.SETTINGS_UPDATED,
    resourceType: 'logistics_shipment',
    resourceId: shipment.id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: { status: shipment.status },
    after: { status: to, reason },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return { status: event.status };
}

// ---------------------------------------------------------------------------
// Moving a consignment along, from the operations desk
// ---------------------------------------------------------------------------

/**
 * The operator moves the consignment along: dispatched, on the way, delivered.
 *
 * A real transition, unlike `correctShipmentStatus`. The matrix decides whether
 * it is legal, a reason is demanded only where the matrix demands one, and the
 * event is NOT flagged as a correction, because nothing is being corrected.
 *
 * WHY THE MARKETPLACE CAN DO THIS AT ALL
 *
 * Because somebody has to when the carrier cannot. A carrier whose portal is
 * down, a small haulier who works from a phone and rings the operations desk,
 * a consignment the marketplace is moving itself - in every one of those the
 * alternative to this route is a status that stops while the parcel does not,
 * and a customer watching a tracking page that has quietly gone stale.
 * `UBOSS_ADMIN` already sits beside `PARTNER` throughout the transition matrix;
 * this is the route that finally reaches it.
 *
 * It is recorded as the operator, never as the carrier. `actorLabel` is
 * `OPERATOR_LABEL` and the source is `UBOSS_ADMIN`, so a carrier reading its
 * own timeline months later can see that the marketplace moved this one, and
 * does not have to account for a scan its staff never made.
 */
export async function advanceShipmentStatus(
  actor: AdminActor,
  shipmentId: string,
  to: ShipmentStatusName,
  options: {
    reason?: string | null;
    publicDescription?: string | null;
    internalNote?: string | null;
    occurredAt?: Date | null;
    locationLabel?: string | null;
    locationCountry?: string | null;
    hasProofOfDelivery?: boolean;
    idempotencyKey?: string | null;
  } = {},
): Promise<{ status: ShipmentStatusName; duplicate: boolean }> {
  const shipment = await prisma.logisticsShipment.findUnique({
    where: { id: shipmentId },
    select: { id: true, status: true, shipmentReference: true, assignedPartnerId: true },
  });

  if (shipment === null) throw notFound('Shipment');

  const event = await recordShipmentEvent({
    shipmentId: shipment.id,
    status: to,
    actor: 'UBOSS_ADMIN',
    source: 'UBOSS_ADMIN',
    actorUserId: actor.userId,
    actorLabel: OPERATOR_LABEL,
    reason: options.reason ?? null,
    publicDescription: options.publicDescription ?? null,
    // The operator's email goes in the internal note and nowhere else. The
    // note never leaves the portal; the sentence a customer reads is
    // `publicDescription`.
    internalNote:
      options.internalNote ??
      `Moved by ${actor.email} from the operations desk.`,
    occurredAt: options.occurredAt ?? new Date(),
    locationLabel: options.locationLabel ?? null,
    locationCountry: options.locationCountry ?? null,
    hasProofOfDelivery: options.hasProofOfDelivery ?? false,
    idempotencyKey: options.idempotencyKey ?? null,
    correlationId: actor.correlationId ?? null,
  });

  // Both trails, because the two sides read different ones: the marketplace's
  // own `audit_log` names the individual, the carrier's names the marketplace,
  // and neither can read the other.
  await recordAudit({
    action: AuditAction.SETTINGS_UPDATED,
    resourceType: 'logistics_shipment',
    resourceId: shipment.id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: { status: shipment.status },
    after: { status: to, reason: options.reason ?? null },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  if (shipment.assignedPartnerId !== null && !event.duplicate) {
    await recordLogisticsAudit({
      logisticsPartnerId: shipment.assignedPartnerId,
      actorUserId: actor.userId,
      actorLabel: OPERATOR_LABEL,
      action: 'logistics.shipment.status_moved',
      resourceType: 'logistics_shipment',
      resourceId: shipment.id,
      before: { status: shipment.status },
      after: { status: to },
      summary: `${shipment.shipmentReference} moved to ${to} by the marketplace.`,
      correlationId: actor.correlationId ?? null,
    });
  }

  return { status: event.status, duplicate: event.duplicate };
}

// ---------------------------------------------------------------------------
// Carrier integrations
// ---------------------------------------------------------------------------

export interface IntegrationView {
  id: string;
  provider: CarrierProvider;
  name: string;
  state: string;
  baseUrl: string;
  /** A hint, never the value. Enough to tell which key is configured. */
  credentialHint: string | null;
  hasWebhookSecret: boolean;
  /** The full inbound URL, for pasting into the carrier's own console. */
  webhookUrl: string;
  pollingEnabled: boolean;
  pollingIntervalMinutes: number;
  lastPollAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureMessage: string | null;
  consecutiveFailures: number;
  deadLetteredEvents: number;
  isActive: boolean;
}

/**
 * The integrations, as the admin screen shows them.
 *
 * NO CREDENTIAL IS EVER RETURNED, in any form that could be used. What comes
 * back is `maskSecret`'s hint - enough for a person to tell which key is
 * configured, never enough to use it - and a boolean for whether a webhook
 * secret exists at all.
 */
export async function listIntegrations(apiPublicUrl: string): Promise<IntegrationView[]> {
  const rows = await prisma.carrierIntegration.findMany({
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    select: {
      id: true,
      provider: true,
      name: true,
      state: true,
      baseUrl: true,
      credentialsEnc: true,
      webhookSecretEnc: true,
      webhookPathToken: true,
      pollingEnabled: true,
      pollingIntervalMinutes: true,
      lastPollAt: true,
      lastSuccessAt: true,
      lastFailureAt: true,
      lastFailureMessage: true,
      consecutiveFailures: true,
      isActive: true,
      _count: { select: { webhookEvents: true } },
    },
  });

  const deadLettered = await prisma.carrierWebhookEvent.groupBy({
    by: ['carrierIntegrationId'],
    where: { state: 'DEAD_LETTER' },
    _count: { _all: true },
  });

  const deadByIntegration = new Map(
    deadLettered.map((row) => [row.carrierIntegrationId, row._count._all]),
  );

  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    name: row.name,
    state: row.state,
    baseUrl: row.baseUrl,
    // The hint is derived from the ENVELOPE, not from the plaintext: the
    // envelope is already opaque, and decrypting a credential to build a hint
    // would put it in memory for no reason.
    credentialHint:
      row.credentialsEnc === null ? null : maskSecret(row.credentialsEnc.slice(0, 24)),
    hasWebhookSecret: row.webhookSecretEnc !== null,
    webhookUrl: `${apiPublicUrl.replace(/\/$/, '')}/api/v1/integrations/carriers/${row.webhookPathToken}/webhook`,
    pollingEnabled: row.pollingEnabled,
    pollingIntervalMinutes: row.pollingIntervalMinutes,
    lastPollAt: row.lastPollAt,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    lastFailureMessage: row.lastFailureMessage,
    consecutiveFailures: row.consecutiveFailures,
    deadLetteredEvents: deadByIntegration.get(row.id) ?? 0,
    isActive: row.isActive,
  }));
}

export interface UpsertIntegrationInput {
  id?: string | null;
  provider: CarrierProvider;
  name: string;
  baseUrl?: string | null;
  /** Written only when supplied. Absent leaves the stored one alone. */
  credentials?: Record<string, string> | null;
  pollingEnabled?: boolean;
  pollingIntervalMinutes?: number;
  rateLimitPerMinute?: number;
  webhookSignatureHeader?: string;
  webhookTimestampHeader?: string;
  webhookAlgorithm?: string;
  webhookToleranceSeconds?: number;
  isActive?: boolean;
}

/**
 * Create or update a carrier connection.
 *
 * The credential is encrypted with the integration's own id as additional
 * authenticated data, so a row copied into another integration fails to
 * decrypt rather than quietly working somewhere it was never meant to.
 *
 * `state` is derived rather than set: an integration with credentials is
 * CONFIGURED, one without is UNCONFIGURED. An operator cannot mark a
 * connection ready by typing the word - which is the whole reason the state
 * exists.
 */
export async function upsertIntegration(
  actor: AdminActor,
  input: UpsertIntegrationInput,
): Promise<{ id: string }> {
  const id = input.id ?? newId();
  const hasCredentials =
    (input.credentials !== undefined && input.credentials !== null) && Object.keys(input.credentials).length > 0;

  const existing =
    (input.id === undefined || input.id === null)
      ? null
      : await prisma.carrierIntegration.findUnique({
          where: { id: input.id },
          select: { id: true, credentialsEnc: true, provider: true },
        });

  if ((input.id !== undefined && input.id !== null) && existing === null) throw notFound('Carrier integration');

  const credentialsEnc = hasCredentials
    ? encryptSecret(JSON.stringify(input.credentials), `carrier_integration:${id}`)
    : (existing?.credentialsEnc ?? null);

  const state =
    input.provider === 'MANUAL'
      ? 'ACTIVE'
      : credentialsEnc === null
        ? 'UNCONFIGURED'
        : 'CONFIGURED';

  const data = {
    provider: input.provider,
    name: input.name.trim().slice(0, 120),
    state,
    baseUrl: (input.baseUrl ?? '').trim().slice(0, 512),
    credentialsEnc,
    pollingEnabled: input.pollingEnabled ?? false,
    pollingIntervalMinutes: input.pollingIntervalMinutes ?? 30,
    rateLimitPerMinute: input.rateLimitPerMinute ?? 60,
    webhookSignatureHeader: input.webhookSignatureHeader ?? 'x-signature',
    webhookTimestampHeader: input.webhookTimestampHeader ?? 'x-timestamp',
    webhookAlgorithm: input.webhookAlgorithm ?? 'sha256',
    webhookToleranceSeconds: input.webhookToleranceSeconds ?? 300,
    isActive: input.isActive ?? true,
  } as const;

  await prisma.carrierIntegration.upsert({
    where: { id },
    create: {
      id,
      ...data,
      // Unguessable, so the inbound endpoint is not enumerable. A speed bump
      // in front of the signature check rather than a replacement for it.
      webhookPathToken: newRandomId().slice(0, 32),
      createdById: actor.userId,
    },
    update: data,
  });

  await recordAudit({
    action: AuditAction.SETTINGS_UPDATED,
    resourceType: 'carrier_integration',
    resourceId: id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    // The credential itself never reaches the audit row - the redaction list
    // in `audit.service.ts` covers the key name, and this passes a boolean
    // rather than relying on that.
    after: { provider: input.provider, name: input.name, state, credentialsChanged: hasCredentials },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return { id };
}

/**
 * Mint a new webhook signing secret.
 *
 * Returned ONCE, in this response, so the operator can paste it into the
 * carrier's own console. Only its encrypted form is stored, and there is no
 * endpoint that reads it back - a product that can show you a signing secret a
 * second time is a product where reading somebody's screen is enough to forge
 * a tracking event.
 */
export async function rotateWebhookSecret(
  actor: AdminActor,
  integrationId: string,
): Promise<{ secret: string; webhookPathToken: string }> {
  const integration = await prisma.carrierIntegration.findUnique({
    where: { id: integrationId },
    select: { id: true, name: true },
  });

  if (integration === null) throw notFound('Carrier integration');

  const { token: secret } = generateToken(32);

  await prisma.carrierIntegration.update({
    where: { id: integration.id },
    data: {
      webhookSecretEnc: encryptSecret(secret, `carrier_integration:${integration.id}`),
      // Rotated together. A leaked secret and a known URL are one compromise,
      // not two, and rotating only half of it leaves the endpoint addressable
      // by whoever had the old pair.
      webhookPathToken: newRandomId().slice(0, 32),
    },
  });

  const refreshed = await prisma.carrierIntegration.findUniqueOrThrow({
    where: { id: integration.id },
    select: { webhookPathToken: true },
  });

  await recordAudit({
    action: AuditAction.SETTINGS_UPDATED,
    resourceType: 'carrier_integration',
    resourceId: integration.id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    after: { rotated: 'webhook_secret' },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return { secret, webhookPathToken: refreshed.webhookPathToken };
}

/**
 * Try the connection, and record honestly what happened.
 *
 * For MANUAL this succeeds and says so - there is nothing to reach. For an
 * unconfigured provider it fails with the variables it needs, which is exactly
 * the message the operator has to act on. It NEVER reports success for a
 * provider it did not actually call.
 */
export async function testIntegration(
  actor: AdminActor,
  integrationId: string,
): Promise<{ ok: boolean; message: string }> {
  const integration = await prisma.carrierIntegration.findUnique({
    where: { id: integrationId },
    select: { id: true, provider: true, name: true, credentialsEnc: true },
  });

  if (integration === null) throw notFound('Carrier integration');

  if (integration.provider === 'MANUAL') {
    await prisma.carrierIntegration.update({
      where: { id: integration.id },
      data: { state: 'ACTIVE', lastSuccessAt: new Date(), consecutiveFailures: 0 },
    });

    return {
      ok: true,
      message: 'This carrier works inside the portal. There is nothing to connect to.',
    };
  }

  if (integration.credentialsEnc === null) {
    await prisma.carrierIntegration.update({
      where: { id: integration.id },
      data: {
        state: 'UNCONFIGURED',
        lastFailureAt: new Date(),
        lastFailureMessage: 'No credentials are stored for this connection.',
      },
    });

    return {
      ok: false,
      message:
        `${integration.provider} has no credentials on this installation. Add them, then test ` +
        'again. Until then, no shipment will be sent to this carrier and nothing will be ' +
        'reported as booked with it.',
    };
  }

  /*
   * Credentials exist and there is no adapter that can use them yet.
   *
   * Reported as a failure, deliberately. The alternative - a green tick
   * because a key is present - is the exact lie this whole layer exists to
   * prevent: an operator would assign a consignment of reagents to a carrier
   * nobody has ever successfully called.
   */
  await prisma.carrierIntegration.update({
    where: { id: integration.id },
    data: {
      state: 'ERROR',
      lastFailureAt: new Date(),
      lastFailureMessage: 'No live adapter is implemented for this provider on this build.',
      consecutiveFailures: { increment: 1 },
    },
  });

  await recordAudit({
    action: AuditAction.SETTINGS_UPDATED,
    resourceType: 'carrier_integration',
    resourceId: integration.id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    after: { tested: true, ok: false },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return {
    ok: false,
    message:
      `Credentials are stored for ${integration.provider}, and this build has no live adapter ` +
      'for it. Shipments will not be booked with this carrier until one is wired up. Use the ' +
      'MANUAL provider, or a CUSTOM connection against your own endpoint, in the meantime.',
  };
}

/** Add or replace one provider-code mapping. */
export async function upsertStatusMapping(
  actor: AdminActor,
  integrationId: string,
  mapping: {
    providerCode: string;
    canonicalStatus: ShipmentStatusName | null;
    raisesExceptionType?: string | null;
    publicDescription?: string | null;
    note?: string | null;
  },
): Promise<void> {
  const integration = await prisma.carrierIntegration.findUnique({
    where: { id: integrationId },
    select: { id: true },
  });

  if (integration === null) throw notFound('Carrier integration');

  // Lower-cased on the way in, so a feed that changes case does not silently
  // stop matching.
  const providerCode = mapping.providerCode.trim().toLowerCase().slice(0, 64);

  await prisma.carrierStatusMapping.upsert({
    where: {
      carrierIntegrationId_providerCode: {
        carrierIntegrationId: integration.id,
        providerCode,
      },
    },
    create: {
      id: newId(),
      carrierIntegrationId: integration.id,
      providerCode,
      canonicalStatus: mapping.canonicalStatus as never,
      raisesExceptionType: (mapping.raisesExceptionType ?? null) as never,
      publicDescription: mapping.publicDescription ?? null,
      note: mapping.note ?? null,
    },
    update: {
      canonicalStatus: mapping.canonicalStatus as never,
      raisesExceptionType: (mapping.raisesExceptionType ?? null) as never,
      publicDescription: mapping.publicDescription ?? null,
      note: mapping.note ?? null,
    },
  });

  await recordAudit({
    action: AuditAction.SETTINGS_UPDATED,
    resourceType: 'carrier_status_mapping',
    resourceId: integration.id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    after: { providerCode, canonicalStatus: mapping.canonicalStatus },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });
}
