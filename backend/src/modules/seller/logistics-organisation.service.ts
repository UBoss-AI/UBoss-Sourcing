/**
 * A seller's own delivery arm, and the delivery company that works for them.
 *
 * The two modes that put a real logistics organisation behind a seller's
 * fulfilment method: SELF_MANAGED, where the seller runs the vans, and
 * DEDICATED_PARTNER, where a separate company does it under contract to that
 * seller alone.
 *
 * THE DISTINCTION THIS FILE EXISTS TO HOLD
 *
 * Both produce a `LogisticsPartner` row, and they are not the same thing:
 *
 *   SELF_MANAGED      `ownerSellerAccountId` is the seller. They configure it.
 *                     Nobody outside the marketplace has to agree to anything.
 *   DEDICATED_PARTNER `ownerSellerAccountId` is the seller too - it works for
 *                     them exclusively - but the company is somebody else's,
 *                     and it has to ACCEPT before the marketplace is asked to
 *                     approve anything.
 *
 * Collapsing them would mean a seller could conjure a courier company into
 * existence and start handing it parcels, which is a relationship the courier
 * never entered into.
 *
 * WHY A SELLER OWNER IS NOT AUTOMATICALLY A FLEET ADMINISTRATOR
 *
 * Creating a self-managed organisation INVITES a named person to it, by email,
 * as its first `LOGISTICS_PARTNER_OWNER`. It does not silently grant the
 * seller's own team logistics permissions, and there is no code path here that
 * does. That person may well be the same human being as the seller's owner -
 * but they sign in to the Logistics Portal as a separate account, with the
 * portal's own second factor, because driver records, licence numbers and
 * live locations are a different body of personal data from a product
 * catalogue.
 *
 * `users.emailNormalized` is unique across all three audiences, so the same
 * address cannot hold both memberships. That is the constraint doing the
 * enforcing rather than a rule somebody has to remember, and the refusal below
 * says so in words a seller can act on.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { SellerLogisticsRelationshipStatus } from '../../generated/prisma/enums.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import {
  canTransitionLink,
  transitionRequiresReason,
} from '../../domain/seller-logistics.js';
import { methodKeyFor } from '../../domain/seller-fulfilment.js';
import { generateToken, sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import {
  inviteLogisticsUser,
  normaliseLogisticsName,
} from '../logistics/partner.service.js';
import { nextPartnerCode } from '../logistics/admin.service.js';
import { recordSellerAudit } from './audit.service.js';
import type { SellerActor } from './fulfilment-method.service.js';
import { notifyInvitationResult } from './fulfilment-notification.service.js';
import { markLogisticsPartnerStep } from './onboarding.service.js';

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// THE HISTORY
// ---------------------------------------------------------------------------

export interface RelationshipEventInput {
  sellerLogisticsPartnerId: string;
  fromStatus: SellerLogisticsRelationshipStatus | null;
  toStatus: SellerLogisticsRelationshipStatus;
  reason?: string | null;
  actorUserId?: string | null;
  actorSellerMemberId?: string | null;
  actorPartnerUserId?: string | null;
  actorLabel?: string | null;
  tx?: Tx;
}

/**
 * Append one line to a relationship's history.
 *
 * Separate from the audit log on purpose. `SellerAuditLog` answers "what did
 * this person do"; this answers "how did this relationship get here", which is
 * the question asked during a dispute and which a filtered audit query answers
 * badly once an arrangement has been suspended and restored three times.
 *
 * Takes the transaction where there is one, so the row and the status it
 * describes are written together or not at all. A history that can disagree
 * with the column it describes is worse than no history.
 */
export async function recordRelationshipEvent(input: RelationshipEventInput): Promise<void> {
  const client = input.tx ?? prisma;

  await client.sellerLogisticsRelationshipEvent.create({
    data: {
      id: newId(),
      sellerLogisticsPartnerId: input.sellerLogisticsPartnerId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      reason: input.reason ?? null,
      actorUserId: input.actorUserId ?? null,
      actorSellerMemberId: input.actorSellerMemberId ?? null,
      actorPartnerUserId: input.actorPartnerUserId ?? null,
      actorLabel: input.actorLabel ?? null,
    },
  });
}

export interface RelationshipHistoryRow {
  id: string;
  fromStatus: SellerLogisticsRelationshipStatus | null;
  toStatus: SellerLogisticsRelationshipStatus;
  reason: string | null;
  actorLabel: string | null;
  createdAt: string;
}

/**
 * A relationship's history, for the seller who owns it.
 *
 * Returns `actorLabel` and never an actor id. Which named individual at the
 * marketplace refused a request is the marketplace's business, exactly as
 * `SellerAuditLog` already treats it - the seller learns that it was refused,
 * when, and why.
 */
export async function readRelationshipHistory(
  sellerAccountId: string,
  sellerLogisticsPartnerId: string,
): Promise<RelationshipHistoryRow[]> {
  const link = await prisma.sellerLogisticsPartner.findFirst({
    where: { id: sellerLogisticsPartnerId, sellerAccountId },
    select: { id: true },
  });

  if (link === null) throw notFound('Arrangement');

  const rows = await prisma.sellerLogisticsRelationshipEvent.findMany({
    where: { sellerLogisticsPartnerId },
    orderBy: { createdAt: 'asc' },
  });

  return rows.map((row) => ({
    id: row.id,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    reason: row.reason,
    actorLabel: row.actorLabel,
    createdAt: row.createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// SELF-MANAGED
// ---------------------------------------------------------------------------

export interface CreateSelfManagedInput {
  sellerAccountId: string;
  actor: SellerActor;
  /** The method row the seller already created by choosing Self-Managed. */
  fulfilmentMethodId: string;

  displayName: string;
  legalName: string;
  registrationCountry: string;
  registrationNumber?: string | null;
  taxNumber?: string | null;
  contactEmail: string;
  contactPhone?: string | null;
  emergencyPhone?: string | null;
  addressJson?: unknown;
  licenceNumber?: string | null;
  licenceExpiresAt?: Date | null;

  /**
   * Who runs the delivery operation, and the address their PORTAL account is
   * created against. Must not be an address that already has an account here -
   * see the header.
   */
  operationsOwnerEmail: string;
  operationsOwnerName: string;

  correlationId?: string | null;
}

export interface CreatedLogisticsOrganisation {
  logisticsPartnerId: string;
  partnerCode: string;
  displayName: string;
  /** Where the invitation went. Never the token itself. */
  invitedEmail: string;
}

/**
 * Create the seller's own delivery arm, and invite the person who will run it.
 *
 * Both in one call, deliberately, for the reason the operator's own carrier
 * creation gives: an organisation with nobody in it is one nobody can
 * activate, and a second step is a step somebody forgets - which surfaces
 * weeks later as "the portal does not work".
 *
 * WHAT IT DOES NOT DO: approve anything. The organisation is created
 * PENDING_ACTIVATION and the fulfilment method moves to PENDING_APPROVAL. A
 * seller declaring that they can carry reagents at 2-8C is a sales statement
 * until the marketplace has looked at their equipment, and the capability
 * table is where that is recorded.
 */
export async function createSelfManagedOrganisation(
  input: CreateSelfManagedInput,
): Promise<CreatedLogisticsOrganisation> {
  const method = await prisma.sellerFulfilmentMethod.findFirst({
    // Both ids in one query. A method belonging to another seller is not
    // found, rather than found and then refused.
    where: {
      id: input.fulfilmentMethodId,
      sellerAccountId: input.sellerAccountId,
      archivedAt: null,
    },
    select: { id: true, mode: true, status: true, logisticsPartnerId: true },
  });

  if (method === null) throw notFound('Delivery method');

  if (method.mode !== 'SELF_MANAGED') {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'That delivery method is not a self-managed one.',
      [{ field: 'fulfilmentMethodId', code: 'WRONG_MODE', meta: { mode: method.mode } }],
    );
  }

  if (method.logisticsPartnerId !== null) {
    throw conflict(
      ErrorCode.CONFLICT,
      'This delivery method already has a delivery operation behind it.',
      [{ code: 'ALREADY_LINKED' }],
    );
  }

  const displayNameNormalized = normaliseLogisticsName(input.displayName);

  if (displayNameNormalized.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'That trading name cannot be used.', [
      { field: 'displayName', code: 'UNUSABLE_NAME' },
    ]);
  }

  /*
   * The same name-collision check the operator's own carrier creation makes,
   * and for the same reason: two carriers that look identical on a dispatch
   * list is how a consignment goes to the wrong company. A seller's own arm is
   * on that list too.
   */
  const clash = await prisma.logisticsPartner.findFirst({
    where: { displayNameNormalized },
    select: { id: true, displayName: true },
  });

  if (clash !== null) {
    throw conflict(
      ErrorCode.CONFLICT,
      `A delivery company called "${clash.displayName}" already exists here. Choose a name that ` +
        'tells the two apart - it appears on dispatch lists beside every other carrier.',
      [{ field: 'displayName', code: 'ALREADY_EXISTS' }],
    );
  }

  const partnerId = newId();
  const partnerCode = await nextPartnerCode();

  await prisma.$transaction(async (tx) => {
    await tx.logisticsPartner.create({
      data: {
        id: partnerId,
        partnerCode,
        legalName: input.legalName.trim().slice(0, 255),
        displayName: input.displayName.trim().slice(0, 160),
        displayNameNormalized,
        registrationCountry: input.registrationCountry.toUpperCase(),
        registrationNumber: input.registrationNumber ?? null,
        taxNumber: input.taxNumber ?? null,
        licenceNumber: input.licenceNumber ?? null,
        licenceExpiresAt: input.licenceExpiresAt ?? null,
        contactEmail: input.contactEmail.trim(),
        contactPhone: input.contactPhone ?? null,
        emergencyPhone: input.emergencyPhone ?? null,
        addressJson: (input.addressJson ?? undefined) as never,
        // The two columns that make this the seller's own rather than the
        // marketplace's. The picker excludes any partner whose owner is
        // somebody else, so this is also what keeps it out of every other
        // seller's carrier list.
        partnerKind: 'SELLER_SELF_MANAGED',
        ownerSellerAccountId: input.sellerAccountId,
        status: 'PENDING_ACTIVATION',
      },
    });

    /*
     * Point the method at it, and rewrite the key.
     *
     * The method was created with `PENDING:SELF_MANAGED` - the placeholder
     * that stops a seller holding two draft self-managed methods. Now that the
     * organisation exists, the key becomes the real one, so the uniqueness
     * rule is about the organisation rather than about the mode.
     */
    await tx.sellerFulfilmentMethod.update({
      where: { id: method.id },
      data: {
        logisticsPartnerId: partnerId,
        methodKey: methodKeyFor({ mode: 'SELF_MANAGED', logisticsPartnerId: partnerId }),
        status: 'PENDING_APPROVAL',
        submittedAt: new Date(),
        statusReason: null,
      },
    });
  });

  /*
   * The first portal account, OUTSIDE the transaction.
   *
   * `inviteLogisticsUser` sends an email, and an email sent inside a
   * transaction that later rolls back is an invitation to an organisation that
   * does not exist. The organisation is committed first; a failure here leaves
   * a carrier with no users, which the operator can fix by inviting one - and
   * which is visible, unlike a phantom email.
   */
  const invitation = await inviteLogisticsUser({
    logisticsPartnerId: partnerId,
    email: input.operationsOwnerEmail,
    fullName: input.operationsOwnerName,
    role: 'LOGISTICS_PARTNER_OWNER',
    invitedByPartnerUserId: null,
    invitedByAdminUserId: null,
    actorLabel: input.actor.label ?? 'The seller',
    correlationId: input.correlationId ?? null,
  });

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.logistics.self_managed.created',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'LogisticsPartner',
    resourceId: partnerId,
    after: { partnerCode, displayName: input.displayName },
    summary: `Created ${input.displayName} as their own delivery operation.`,
    correlationId: input.correlationId ?? null,
  });

  await markLogisticsPartnerStep({
    membership: { sellerAccountId: input.sellerAccountId },
    isResumePoint: true,
  });

  return {
    logisticsPartnerId: partnerId,
    partnerCode,
    displayName: input.displayName,
    invitedEmail: invitation.email,
  };
}

// ---------------------------------------------------------------------------
// DEDICATED PARTNER - FINDING ONE THAT ALREADY EXISTS
// ---------------------------------------------------------------------------

export interface PartnerSearchResult {
  id: string;
  partnerCode: string;
  displayName: string;
  registrationCountry: string;
  /** Countries it declares it serves. Coverage, not contact details. */
  serviceCountries: string[];
  /** Capability names it is APPROVED for, never the ones it merely claims. */
  capabilities: string[];
  /** Whether this seller already has an arrangement with it. */
  existingStatus: SellerLogisticsRelationshipStatus | null;
}

/**
 * Find a delivery company this seller could ask to work for them.
 *
 * WHAT THIS DELIBERATELY DOES NOT RETURN. No contact email, no telephone
 * number, no address, no contract reference, no internal note, no operator
 * remark, and no indication of which other sellers use them. A picker is a
 * list of names a seller can request; it is not a directory of other
 * businesses' commercial arrangements, and an autocomplete that leaked one
 * would be a disclosure nobody authorised.
 *
 * WHAT IT EXCLUDES:
 *   - anything not ACTIVE, because a suspended carrier cannot take new work
 *   - anything archived
 *   - any organisation owned by ANOTHER seller, which is the rule that keeps a
 *     seller's own delivery arm, and their exclusive courier, off every
 *     competitor's list
 *
 * The search is server-side and the term is matched against the normalised
 * name and the code only. A blank term lists what is available rather than
 * refusing, because a seller who does not know any carrier's name is exactly
 * the seller who needs the list.
 */
export async function searchPartnersForSeller(
  sellerAccountId: string,
  term: string,
  limit = 20,
): Promise<PartnerSearchResult[]> {
  const normalised = normaliseLogisticsName(term);

  const partners = await prisma.logisticsPartner.findMany({
    where: {
      status: 'ACTIVE',
      archivedAt: null,
      // Owned by nobody (a marketplace carrier), or already owned by THIS
      // seller. Never another seller's.
      OR: [{ ownerSellerAccountId: null }, { ownerSellerAccountId: sellerAccountId }],
      ...(normalised.length === 0
        ? {}
        : {
            displayNameNormalized: { contains: normalised },
          }),
    },
    select: {
      id: true,
      partnerCode: true,
      displayName: true,
      registrationCountry: true,
      regions: {
        where: { isActive: true, isExclusion: false },
        select: { countryCode: true },
      },
      capabilities: {
        where: { state: 'APPROVED' },
        select: { kind: true },
      },
      sellerLinks: {
        where: { sellerAccountId },
        select: { status: true },
      },
    },
    orderBy: { displayName: 'asc' },
    take: Math.min(limit, 50),
  });

  return partners.map((partner) => ({
    id: partner.id,
    partnerCode: partner.partnerCode,
    displayName: partner.displayName,
    registrationCountry: partner.registrationCountry,
    serviceCountries: [...new Set(partner.regions.map((region) => region.countryCode))].sort(),
    capabilities: partner.capabilities.map((capability) => capability.kind),
    existingStatus: partner.sellerLinks[0]?.status ?? null,
  }));
}

// ---------------------------------------------------------------------------
// DEDICATED PARTNER - INVITING ONE THAT DOES NOT
// ---------------------------------------------------------------------------

export interface InvitePartnerInput {
  sellerAccountId: string;
  actor: SellerActor;
  fulfilmentMethodId: string;

  proposedLegalName: string;
  proposedDisplayName: string;
  businessEmail: string;
  businessPhone?: string | null;
  registrationNumber?: string | null;
  countryCode: string;
  addressJson?: unknown;
  primaryContactName?: string | null;
  expectedServiceCountries?: readonly string[] | null;
  requiredCapabilities?: readonly string[] | null;
  relationshipDescription?: string | null;

  /** How long the invitation stands. Days. */
  expiresInDays?: number;
}

export interface CreatedPartnerInvitation {
  invitationId: string;
  businessEmail: string;
  expiresAt: string;
  /**
   * The single-use token, returned ONCE and never stored in readable form.
   *
   * Returned to the CALLER rather than to the seller's browser: the route
   * hands it to the mail job and drops it. A seller who could read this could
   * redeem it themselves and become the courier, which is the whole thing the
   * invitation flow exists to prevent.
   */
  rawToken: string;
}

/**
 * Ask a delivery company the seller already works with to join.
 *
 * THE SELLER DOES NOT CREATE THE COMPANY'S ACCOUNT, and does not choose its
 * password. They describe the company and give a business address; the company
 * redeems a single-use token, verifies that address and chooses its own
 * credentials. A seller who could set that password could sign in as the
 * carrier and read every consignment it ever holds - including, once it works
 * for a second seller, somebody else's.
 *
 * What this creates is a PENDING invitation and nothing else. No
 * `LogisticsPartner`, no relationship, no entitlement. Those appear when the
 * company accepts.
 */
export async function inviteDedicatedPartner(
  input: InvitePartnerInput,
): Promise<CreatedPartnerInvitation> {
  const method = await prisma.sellerFulfilmentMethod.findFirst({
    where: {
      id: input.fulfilmentMethodId,
      sellerAccountId: input.sellerAccountId,
      archivedAt: null,
    },
    select: { id: true, mode: true },
  });

  if (method === null) throw notFound('Delivery method');

  if (method.mode !== 'DEDICATED_PARTNER') {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'That delivery method is not a dedicated-partner one.',
      [{ field: 'fulfilmentMethodId', code: 'WRONG_MODE', meta: { mode: method.mode } }],
    );
  }

  const businessEmail = input.businessEmail.trim().toLowerCase();

  /*
   * An outstanding invitation to the same address is reused rather than
   * duplicated.
   *
   * A seller who presses the button twice should not send two emails with two
   * tokens, because the first one then stops working the moment the second is
   * redeemed - and the company that clicked the older link is told their
   * invitation is invalid, which reads as the marketplace being broken.
   */
  const outstanding = await prisma.sellerLogisticsPartnerInvitation.findFirst({
    where: {
      sellerAccountId: input.sellerAccountId,
      businessEmail,
      state: 'SENT',
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });

  if (outstanding !== null) {
    throw conflict(
      ErrorCode.CONFLICT,
      'An invitation to that address is already outstanding. Withdraw it first if you want to ' +
        'send a new one.',
      [{ field: 'businessEmail', code: 'ALREADY_INVITED' }],
    );
  }

  const { token: rawToken } = generateToken();
  const invitationId = newId();

  const expiresAt = new Date(
    Date.now() + (input.expiresInDays ?? 14) * 24 * 60 * 60 * 1000,
  );

  await prisma.sellerLogisticsPartnerInvitation.create({
    data: {
      id: invitationId,
      sellerAccountId: input.sellerAccountId,
      state: 'SENT',
      proposedLegalName: input.proposedLegalName.trim().slice(0, 255),
      proposedDisplayName: input.proposedDisplayName.trim().slice(0, 160),
      businessEmail,
      businessPhone: input.businessPhone ?? null,
      registrationNumber: input.registrationNumber ?? null,
      countryCode: input.countryCode.toUpperCase(),
      addressJson: (input.addressJson ?? undefined) as never,
      primaryContactName: input.primaryContactName ?? null,
      expectedServiceCountriesJson: (input.expectedServiceCountries ?? undefined) as never,
      requiredCapabilitiesJson: (input.requiredCapabilities ?? undefined) as never,
      relationshipDescription: input.relationshipDescription ?? null,
      // The hash, never the token. A database read must not yield something
      // redeemable - the same rule `AuthToken` follows.
      tokenHash: sha256Hex(rawToken),
      expiresAt,
      invitedBySellerMemberId: input.actor.memberId,
    },
  });

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.logistics.partner.invited',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'SellerLogisticsPartnerInvitation',
    resourceId: invitationId,
    // The address is recorded; the token is not, here or anywhere.
    after: { businessEmail, proposedDisplayName: input.proposedDisplayName },
    summary: `Invited ${input.proposedDisplayName} to deliver for them.`,
  });

  return {
    invitationId,
    businessEmail,
    expiresAt: expiresAt.toISOString(),
    rawToken,
  };
}

/** Withdraw an invitation that has not been taken up. */
export async function revokePartnerInvitation(input: {
  sellerAccountId: string;
  actor: SellerActor;
  invitationId: string;
}): Promise<void> {
  const invitation = await prisma.sellerLogisticsPartnerInvitation.findFirst({
    where: {
      id: input.invitationId,
      sellerAccountId: input.sellerAccountId,
      state: 'SENT',
    },
    select: { id: true, proposedDisplayName: true },
  });

  if (invitation === null) throw notFound('Invitation');

  await prisma.sellerLogisticsPartnerInvitation.update({
    where: { id: invitation.id },
    data: { state: 'REVOKED' },
  });

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.logistics.partner.invitation_revoked',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'SellerLogisticsPartnerInvitation',
    resourceId: invitation.id,
    summary: `Withdrew the invitation to ${invitation.proposedDisplayName}.`,
  });
}

/**
 * What an invited company sees before it decides.
 *
 * Reached with the token and nothing else, so it deliberately discloses only
 * what a company needs in order to recognise the request: who is asking, what
 * they called the company, and what they want it to do. It does NOT disclose
 * the seller's address, their other carriers, their order volume or anything
 * else about their business - the holder of this link has not yet agreed to
 * anything and may be the wrong person entirely.
 */
export async function describePartnerInvitation(rawToken: string): Promise<{
  invitationId: string;
  sellerDisplayName: string;
  proposedDisplayName: string;
  proposedLegalName: string;
  businessEmail: string;
  countryCode: string;
  expectedServiceCountries: string[];
  requiredCapabilities: string[];
  relationshipDescription: string | null;
  expiresAt: string;
}> {
  const invitation = await findRedeemableInvitation(rawToken);

  return {
    invitationId: invitation.id,
    sellerDisplayName: invitation.sellerAccount.displayName,
    proposedDisplayName: invitation.proposedDisplayName,
    proposedLegalName: invitation.proposedLegalName,
    businessEmail: invitation.businessEmail,
    countryCode: invitation.countryCode,
    expectedServiceCountries: stringList(invitation.expectedServiceCountriesJson),
    requiredCapabilities: stringList(invitation.requiredCapabilitiesJson),
    relationshipDescription: invitation.relationshipDescription,
    expiresAt: invitation.expiresAt.toISOString(),
  };
}

/**
 * The invited company says yes.
 *
 * Creates the `LogisticsPartner`, links it to the seller in
 * PARTNER_ACCEPTANCE_PENDING -> REQUESTED, and invites the named contact as
 * its first portal owner. The marketplace still has to approve: a company
 * agreeing to work for a seller is two parties agreeing, and the marketplace
 * is the third.
 *
 * SINGLE USE. The invitation moves to ACCEPTED inside the same transaction
 * that creates the organisation, so two people clicking the same link produce
 * one company - the second finds nothing redeemable.
 */
export async function acceptPartnerInvitation(input: {
  rawToken: string;
  /** What the company calls itself, where it corrects the seller's guess. */
  displayName?: string | null;
  legalName?: string | null;
  contactName: string;
  contactEmail: string;
  contactPhone?: string | null;
  correlationId?: string | null;
}): Promise<CreatedLogisticsOrganisation> {
  const invitation = await findRedeemableInvitation(input.rawToken);

  // The company's own name wins over the seller's guess. A seller mistyping a
  // legal name must not rename a company that had no say in it.
  const displayName = (input.displayName ?? invitation.proposedDisplayName).trim().slice(0, 160);
  const legalName = (input.legalName ?? invitation.proposedLegalName).trim().slice(0, 255);
  const displayNameNormalized = normaliseLogisticsName(displayName);

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
      `A delivery company called "${clash.displayName}" already exists here. Choose a name that ` +
        'tells the two apart.',
      [{ field: 'displayName', code: 'ALREADY_EXISTS' }],
    );
  }

  const partnerId = newId();
  const partnerCode = await nextPartnerCode();
  const linkId = newId();

  await prisma.$transaction(async (tx) => {
    await tx.logisticsPartner.create({
      data: {
        id: partnerId,
        partnerCode,
        legalName,
        displayName,
        displayNameNormalized,
        registrationCountry: invitation.countryCode,
        registrationNumber: invitation.registrationNumber,
        contactEmail: input.contactEmail.trim(),
        contactPhone: input.contactPhone ?? invitation.businessPhone,
        addressJson: (invitation.addressJson ?? undefined) as never,
        partnerKind: 'SELLER_DEDICATED',
        // Exclusive to the seller who introduced them. This is what keeps a
        // dedicated courier off every other seller's picker.
        ownerSellerAccountId: invitation.sellerAccountId,
        status: 'PENDING_ACTIVATION',
      },
    });

    await tx.sellerLogisticsPartner.create({
      data: {
        id: linkId,
        sellerAccountId: invitation.sellerAccountId,
        logisticsPartnerId: partnerId,
        relationshipType: 'SELLER_DEDICATED',
        // Straight to REQUESTED: the company has just said yes, so the only
        // party left to hear from is the marketplace.
        status: 'REQUESTED',
        requestedBySellerMemberId: invitation.invitedBySellerMemberId,
        invitationId: invitation.id,
        serviceCountriesJson: invitation.expectedServiceCountriesJson ?? undefined,
        approvedCapabilitiesJson: invitation.requiredCapabilitiesJson ?? undefined,
      },
    });

    // Two lines, because two things happened and a history that showed only
    // the second could not answer "did they ever actually agree?".
    await recordRelationshipEvent({
      sellerLogisticsPartnerId: linkId,
      fromStatus: null,
      toStatus: 'INVITED',
      actorSellerMemberId: invitation.invitedBySellerMemberId,
      actorLabel: invitation.sellerAccount.displayName,
      tx,
    });

    await recordRelationshipEvent({
      sellerLogisticsPartnerId: linkId,
      fromStatus: 'INVITED',
      toStatus: 'REQUESTED',
      reason: 'The delivery company accepted the invitation.',
      actorLabel: displayName,
      tx,
    });

    /*
     * Spend the invitation INSIDE the transaction.
     *
     * `state` moves off SENT here, and `findRedeemableInvitation` only ever
     * matches SENT, so two people clicking the same link race for one row and
     * exactly one wins. Doing it after the commit would leave a window in
     * which both created a company.
     */
    await tx.sellerLogisticsPartnerInvitation.update({
      where: { id: invitation.id, state: 'SENT' },
      data: {
        state: 'ACCEPTED',
        acceptedAt: new Date(),
        logisticsPartnerId: partnerId,
        sellerLogisticsPartnerId: linkId,
      },
    });
  });

  const portalInvitation = await inviteLogisticsUser({
    logisticsPartnerId: partnerId,
    email: input.contactEmail,
    fullName: input.contactName,
    role: 'LOGISTICS_PARTNER_OWNER',
    invitedByPartnerUserId: null,
    invitedByAdminUserId: null,
    actorLabel: displayName,
    correlationId: input.correlationId ?? null,
  });

  /*
   * The seller finds out that the company said yes.
   *
   * They sent an email days ago to somebody outside this system and have no
   * other way of knowing it was answered - which is precisely the shape of
   * event a notification exists for.
   */
  await notifyInvitationResult({
    sellerAccountId: invitation.sellerAccountId,
    invitationId: invitation.id,
    companyName: displayName,
    accepted: true,
  });

  return {
    logisticsPartnerId: partnerId,
    partnerCode,
    displayName,
    invitedEmail: portalInvitation.email,
  };
}

/**
 * The one row a token may still be redeemed against.
 *
 * SENT, unexpired, and matched on the HASH - the token itself is never stored,
 * so this is a lookup by digest rather than a comparison. A token that is
 * unknown, spent, withdrawn or out of date gets one refusal between them: the
 * holder of a bad token learns only that it did not work, which is the same
 * posture the carrier webhook takes.
 */
async function findRedeemableInvitation(rawToken: string): Promise<{
  id: string;
  sellerAccountId: string;
  sellerAccount: { displayName: string };
  proposedDisplayName: string;
  proposedLegalName: string;
  businessEmail: string;
  businessPhone: string | null;
  registrationNumber: string | null;
  countryCode: string;
  addressJson: unknown;
  expectedServiceCountriesJson: unknown;
  requiredCapabilitiesJson: unknown;
  relationshipDescription: string | null;
  invitedBySellerMemberId: string | null;
  expiresAt: Date;
}> {
  const invitation = await prisma.sellerLogisticsPartnerInvitation.findFirst({
    where: {
      tokenHash: sha256Hex(rawToken),
      state: 'SENT',
      expiresAt: { gt: new Date() },
    },
    include: { sellerAccount: { select: { displayName: true } } },
  });

  if (invitation === null) {
    throw badRequest(
      ErrorCode.SELLER_PARTNER_INVITATION_INVALID,
      'That invitation link is not valid any more. Ask the business that sent it for a new one.',
      [{ code: 'INVITATION_UNUSABLE' }],
    );
  }

  return invitation;
}

/** A JSON column that should hold a list of short codes, read defensively. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

// ---------------------------------------------------------------------------
// ASKING FOR A CARRIER THAT ALREADY EXISTS
// ---------------------------------------------------------------------------

/**
 * Link a dedicated method to a delivery company that is already here.
 *
 * The other path through Phase 3: the seller picks from `searchPartnersForSeller`
 * rather than inviting somebody new. It produces the same REQUESTED
 * relationship and the same history, so the marketplace's approval queue does
 * not have to care which way a request arrived.
 */
export async function requestExistingPartner(input: {
  sellerAccountId: string;
  actor: SellerActor;
  fulfilmentMethodId: string;
  logisticsPartnerId: string;
}): Promise<{ linkId: string; status: SellerLogisticsRelationshipStatus }> {
  const [method, partner] = await Promise.all([
    prisma.sellerFulfilmentMethod.findFirst({
      where: {
        id: input.fulfilmentMethodId,
        sellerAccountId: input.sellerAccountId,
        archivedAt: null,
      },
      select: { id: true, mode: true, logisticsPartnerId: true },
    }),
    prisma.logisticsPartner.findFirst({
      where: {
        id: input.logisticsPartnerId,
        status: 'ACTIVE',
        archivedAt: null,
        // The same exclusion the search makes. A seller who guessed another
        // seller's carrier id finds nothing, rather than finding it and being
        // refused - which would confirm that it exists.
        OR: [{ ownerSellerAccountId: null }, { ownerSellerAccountId: input.sellerAccountId }],
      },
      select: { id: true, displayName: true },
    }),
  ]);

  if (method === null) throw notFound('Delivery method');

  if (partner === null) {
    throw badRequest(
      ErrorCode.SELLER_LOGISTICS_PARTNER_NOT_YOURS,
      'That delivery company is not one you can ask to work for you.',
      [{ field: 'logisticsPartnerId', code: 'NOT_AVAILABLE' }],
    );
  }

  if (method.mode !== 'DEDICATED_PARTNER') {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'That delivery method is not a dedicated-partner one.',
      [{ field: 'fulfilmentMethodId', code: 'WRONG_MODE', meta: { mode: method.mode } }],
    );
  }

  const existing = await prisma.sellerLogisticsPartner.findUnique({
    where: {
      sellerAccountId_logisticsPartnerId: {
        sellerAccountId: input.sellerAccountId,
        logisticsPartnerId: partner.id,
      },
    },
    select: { id: true, status: true },
  });

  const linkId = existing?.id ?? newId();

  await prisma.$transaction(async (tx) => {
    if (existing === null) {
      await tx.sellerLogisticsPartner.create({
        data: {
          id: linkId,
          sellerAccountId: input.sellerAccountId,
          logisticsPartnerId: partner.id,
          relationshipType: 'SELLER_DEDICATED',
          status: 'REQUESTED',
          requestedBySellerMemberId: input.actor.memberId,
        },
      });

      await recordRelationshipEvent({
        sellerLogisticsPartnerId: linkId,
        fromStatus: null,
        toStatus: 'REQUESTED',
        actorSellerMemberId: input.actor.memberId,
        actorLabel: input.actor.label,
        tx,
      });
    } else {
      /*
       * Re-asking after a refusal or an ending moves THE SAME ROW rather than
       * creating a second, so "may this seller use this carrier" is always
       * answered by exactly one row and can never be answered twice with two
       * different answers. The state machine decides whether the move is even
       * allowed.
       */
      if (existing.status !== 'REQUESTED') {
        if (!canTransitionLink(existing.status, 'REQUESTED')) {
          throw conflict(
            ErrorCode.CONFLICT,
            `Your arrangement with ${partner.displayName} cannot be requested again from where it stands.`,
            [{ code: 'TRANSITION_UNDEFINED', meta: { from: existing.status, to: 'REQUESTED' } }],
          );
        }

        await tx.sellerLogisticsPartner.update({
          where: { id: linkId },
          data: { status: 'REQUESTED', requestedAt: new Date(), statusReason: null },
        });

        await recordRelationshipEvent({
          sellerLogisticsPartnerId: linkId,
          fromStatus: existing.status,
          toStatus: 'REQUESTED',
          actorSellerMemberId: input.actor.memberId,
          actorLabel: input.actor.label,
          tx,
        });
      }
    }

    // Point the method at the company, so the approval queue and the picker
    // both know which one this is about.
    if (method.logisticsPartnerId === null) {
      await tx.sellerFulfilmentMethod.update({
        where: { id: method.id },
        data: {
          logisticsPartnerId: partner.id,
          methodKey: methodKeyFor({
            mode: 'DEDICATED_PARTNER',
            logisticsPartnerId: partner.id,
          }),
          status: 'PENDING_APPROVAL',
          submittedAt: new Date(),
        },
      });
    }
  });

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.logistics.partner.requested',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'SellerLogisticsPartner',
    resourceId: linkId,
    after: { logisticsPartnerId: partner.id, status: 'REQUESTED' },
    summary: `Asked ${partner.displayName} to deliver for them.`,
  });

  await markLogisticsPartnerStep({
    membership: { sellerAccountId: input.sellerAccountId },
    isResumePoint: true,
  });

  return { linkId, status: 'REQUESTED' };
}

/**
 * Move a relationship, recording why.
 *
 * The one function that writes `SellerLogisticsPartner.status`, so the state
 * machine and the history cannot be bypassed. Used by the admin routes for
 * approve, refuse, ask-for-changes, suspend and end - and the reason it lives
 * here rather than in the admin module is that the history table belongs to
 * the relationship, not to whoever happened to move it.
 */
export async function transitionRelationship(input: {
  sellerLogisticsPartnerId: string;
  toStatus: SellerLogisticsRelationshipStatus;
  reason: string | null;
  actorUserId?: string | null;
  actorSellerMemberId?: string | null;
  actorPartnerUserId?: string | null;
  actorLabel?: string | null;
}): Promise<void> {
  const link = await prisma.sellerLogisticsPartner.findUnique({
    where: { id: input.sellerLogisticsPartnerId },
    select: { id: true, status: true },
  });

  if (link === null) throw notFound('Arrangement');

  if (!canTransitionLink(link.status, input.toStatus)) {
    throw conflict(
      ErrorCode.CONFLICT,
      `An arrangement cannot move from ${link.status} to ${input.toStatus}.`,
      [{ code: 'TRANSITION_UNDEFINED', meta: { from: link.status, to: input.toStatus } }],
    );
  }

  if (
    transitionRequiresReason(input.toStatus) &&
    (input.reason === null || input.reason.trim().length === 0)
  ) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      `Moving an arrangement to ${input.toStatus} needs a reason.`,
      [{ field: 'reason', code: 'REQUIRED', meta: { to: input.toStatus } }],
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.sellerLogisticsPartner.update({
      where: { id: link.id },
      data: {
        status: input.toStatus,
        statusReason: input.reason,
        decidedByUserId: input.actorUserId ?? null,
        decidedAt: new Date(),
      },
    });

    await recordRelationshipEvent({
      sellerLogisticsPartnerId: link.id,
      fromStatus: link.status,
      toStatus: input.toStatus,
      reason: input.reason,
      actorUserId: input.actorUserId,
      actorSellerMemberId: input.actorSellerMemberId,
      actorPartnerUserId: input.actorPartnerUserId,
      actorLabel: input.actorLabel,
      tx,
    });
  });
}
