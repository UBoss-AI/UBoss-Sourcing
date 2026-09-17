/**
 * Development data for the logistics partner portal.
 *
 * WHY THIS EXISTS, AND WHAT IT DELIBERATELY IS NOT
 *
 * In production nobody is seeded. A carrier exists because an operator created
 * it and invited its first owner by email, and that is the only way in - see
 * `modules/logistics/partner.service.ts`. This file exists so that somebody
 * setting up a development machine can open the portal and see a working
 * screen instead of an empty one, without first having to run the worker,
 * find an activation link in a log and redeem it.
 *
 * Three consequences of that, all of them on purpose:
 *
 *   - **It only runs when the portal is switched on.** With
 *     `FEATURE_LOGISTICS_PORTAL` off there is nothing for these rows to be
 *     used by, and seeding them would put carrier accounts on every
 *     installation that never asked for one.
 *   - **It refuses to run outside development.** The passwords below are
 *     printed in a console log. A production process that reached this
 *     function would be creating known credentials on a live system.
 *   - **The owner has no second factor set up.** That is not an oversight: an
 *     owner must set one up before they can do anything, and seeding past that
 *     would be seeding past the control. Sign in as the dispatcher to reach
 *     the working screens; sign in as the owner to see the enrolment the
 *     product actually requires.
 *
 * Idempotent, like the rest of the seed: it keys on the carrier's code and the
 * users' email addresses, so running it twice changes nothing.
 */
import { env } from '../config/env.js';
import { permissionsForLogisticsRole } from '../domain/logistics-permissions.js';
import { hashPassword } from '../infra/crypto.js';
import { newId } from '../infra/ids.js';
import { prisma } from '../infra/prisma.js';
import { createShipment } from '../modules/logistics/shipment-create.service.js';
import { acceptAssignment, offerAssignment } from '../modules/logistics/assignment.service.js';
import { recordShipmentEvent } from '../modules/logistics/shipment-event.service.js';
import type { LogisticsMembership } from '../modules/logistics/partner.service.js';

const PARTNER_CODE = 'LP-DEV-MERIDIAN';

export const LOGISTICS_SEED_ACCOUNTS = Object.freeze([
  {
    email: 'carrier.owner@uboss.local',
    password: 'CarrierDev!2026',
    fullName: 'Ana Duarte',
    role: 'LOGISTICS_PARTNER_OWNER' as const,
    note: 'must set up a second factor at first sign-in',
  },
  {
    email: 'carrier.dispatch@uboss.local',
    password: 'DispatchDev!2026',
    fullName: 'Tomasz Bąk',
    role: 'DISPATCHER' as const,
    note: 'goes straight to the dashboard',
  },
  {
    email: 'carrier.driver@uboss.local',
    password: 'DriverDev!2026',
    fullName: 'Ingrid Sørensen',
    role: 'DRIVER' as const,
    note: 'sees only their own round',
  },
]);

const PICKUP = {
  line1: 'Hafenstraße 14',
  line2: 'Halle 3',
  city: 'Hamburg',
  postalCode: '20457',
  countryCode: 'DE',
};

const DELIVERY = {
  line1: 'Klinikweg 8',
  city: 'Bremen',
  postalCode: '28195',
  countryCode: 'DE',
};

export interface LogisticsSeedResult {
  skipped: boolean;
  reason?: string;
  partnerCode?: string;
  shipments?: number;
}

export async function seedLogistics(): Promise<LogisticsSeedResult> {
  if (!env.FEATURE_LOGISTICS_PORTAL) {
    return { skipped: true, reason: 'FEATURE_LOGISTICS_PORTAL is off' };
  }

  if (env.NODE_ENV === 'production') {
    return { skipped: true, reason: 'refused in production - these are known passwords' };
  }

  const partnerId = await upsertPartner();
  const memberIds = await upsertMembers(partnerId);

  await upsertCapabilities(partnerId);
  await upsertRegions(partnerId);
  await upsertSlaPolicy(partnerId);
  await upsertDriverProfile(partnerId, memberIds.driverPartnerUserId);

  const shipments = await seedShipments(partnerId, memberIds.dispatcher);

  return { skipped: false, partnerCode: PARTNER_CODE, shipments };
}

// ---------------------------------------------------------------------------
// The carrier
// ---------------------------------------------------------------------------

async function upsertPartner(): Promise<string> {
  const existing = await prisma.logisticsPartner.findUnique({
    where: { partnerCode: PARTNER_CODE },
    select: { id: true },
  });

  if (existing !== null) return existing.id;

  const id = newId();

  await prisma.logisticsPartner.create({
    data: {
      id,
      partnerCode: PARTNER_CODE,
      legalName: 'Meridian Kühltransport GmbH',
      displayName: 'Meridian Cold Chain',
      displayNameNormalized: 'meridiancoldchain',
      registrationCountry: 'DE',
      registrationNumber: 'HRB 118422',
      taxNumber: 'DE289471226',
      contactEmail: 'ops@meridian.example',
      contactPhone: '+49 40 555 0180',
      emergencyPhone: '+49 40 555 0199',
      websiteUrl: 'https://meridian.example',
      addressJson: PICKUP,
      status: 'ACTIVE',
      contractStatus: 'ACTIVE',
      contractReference: 'UB-CAR-2026-004',
      contractStartsAt: new Date('2026-01-01T00:00:00.000Z'),
      contractEndsAt: new Date('2027-12-31T00:00:00.000Z'),
      maxOpenShipments: 400,
      autoAssignEnabled: false,
      internalNotes:
        'Development carrier. Reliable on the Hamburg-Bremen corridor; has asked twice about ' +
        'extending into Poland.',
    },
  });

  return id;
}

// ---------------------------------------------------------------------------
// Its people
// ---------------------------------------------------------------------------

async function upsertMembers(
  partnerId: string,
): Promise<{ dispatcher: LogisticsMembership; driverPartnerUserId: string }> {
  let dispatcher: LogisticsMembership | null = null;
  let driverPartnerUserId = '';

  for (const account of LOGISTICS_SEED_ACCOUNTS) {
    const normalized = account.email.toLowerCase();

    let user = await prisma.user.findUnique({
      where: { emailNormalized: normalized },
      select: { id: true },
    });

    if (user === null) {
      user = await prisma.user.create({
        data: {
          id: newId(),
          type: 'LOGISTICS',
          email: account.email,
          emailNormalized: normalized,
          passwordHash: await hashPassword(account.password),
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
        },
        select: { id: true },
      });
    }

    let member = await prisma.logisticsPartnerUser.findFirst({
      where: { logisticsPartnerId: partnerId, userId: user.id },
      select: { id: true },
    });

    if (member === null) {
      member = await prisma.logisticsPartnerUser.create({
        data: {
          id: newId(),
          logisticsPartnerId: partnerId,
          userId: user.id,
          role: account.role,
          status: 'ACTIVE',
          fullName: account.fullName,
          jobTitle: account.role === 'DISPATCHER' ? 'Duty dispatcher' : null,
        },
        select: { id: true },
      });
    }

    if (account.role === 'DISPATCHER') {
      /*
       * The membership the services take, built here rather than read back.
       * `resolveLogisticsMembership` is the production path and it reads a
       * session; a seed has no session, so it supplies the same shape.
       */
      dispatcher = {
        logisticsPartnerId: partnerId,
        partnerCode: PARTNER_CODE,
        displayName: 'Meridian Cold Chain',
        legalName: 'Meridian Kühltransport GmbH',
        partnerStatus: 'ACTIVE',
        registrationCountry: 'DE',
        partnerUserId: member.id,
        userId: user.id,
        fullName: account.fullName,
        role: account.role,
        permissions: permissionsForLogisticsRole(account.role),
        canAcceptNewWork: true,
        requiresMfa: false,
        regionScope: null,
        driverProfileId: null,
      };
    }

    if (account.role === 'DRIVER') driverPartnerUserId = member.id;
  }

  if (dispatcher === null) throw new Error('the dispatcher account was not created');

  return { dispatcher, driverPartnerUserId };
}

async function upsertDriverProfile(partnerId: string, partnerUserId: string): Promise<void> {
  if (partnerUserId.length === 0) return;

  const existing = await prisma.logisticsDriverProfile.findUnique({
    where: { partnerUserId },
    select: { id: true },
  });

  if (existing !== null) return;

  await prisma.logisticsDriverProfile.create({
    data: {
      id: newId(),
      logisticsPartnerId: partnerId,
      // The name lives on the driver record now, not on the account. This one
      // has both: they are the seeded driver who signs in on a phone, which is
      // what makes `/driver/tasks` demonstrable on a fresh checkout.
      fullName: 'Ingrid Sørensen',
      partnerUserId,
      state: 'ACTIVE',
      employeeReference: 'MER-0142',
      canCarryColdChain: true,
      canCarrySterile: true,
      // Not consented. Consent is given by the person, on their device, and
      // seeding it would be seeding somebody else's agreement.
      locationConsentAt: null,
    },
  });
}

// ---------------------------------------------------------------------------
// What it may carry, where, and how fast
// ---------------------------------------------------------------------------

async function upsertCapabilities(partnerId: string): Promise<void> {
  const approved = [
    { kind: 'COLD_CHAIN_2_8' as const, min: 2, max: 8 },
    { kind: 'TEMPERATURE_CONTROLLED' as const, min: -20, max: 25 },
    { kind: 'STERILE_HANDLING' as const, min: null, max: null },
    { kind: 'NEXT_DAY' as const, min: null, max: null },
    { kind: 'PALLET' as const, min: null, max: null },
  ];

  for (const entry of approved) {
    await prisma.logisticsCapability.upsert({
      where: { logisticsPartnerId_kind: { logisticsPartnerId: partnerId, kind: entry.kind } },
      update: {},
      create: {
        id: newId(),
        logisticsPartnerId: partnerId,
        kind: entry.kind,
        state: 'APPROVED',
        evidenceReference: 'GDP certificate 2026/114',
        decidedAt: new Date(),
        decisionNote: 'Seeded for development.',
        ...(entry.min === null ? {} : { temperatureMinC: entry.min, temperatureMaxC: entry.max }),
      },
    });
  }

  // One still waiting on a decision, so the approval screen has something on
  // it the first time somebody opens it.
  await prisma.logisticsCapability.upsert({
    where: {
      logisticsPartnerId_kind: { logisticsPartnerId: partnerId, kind: 'DANGEROUS_GOODS' },
    },
    update: {},
    create: {
      id: newId(),
      logisticsPartnerId: partnerId,
      kind: 'DANGEROUS_GOODS',
      state: 'REQUESTED',
      evidenceReference: 'ADR certificate pending renewal',
    },
  });
}

async function upsertRegions(partnerId: string): Promise<void> {
  const regions = [
    { scope: 'COUNTRY' as const, countryCode: 'DE', regionValue: '' },
    { scope: 'COUNTRY' as const, countryCode: 'NL', regionValue: '' },
    { scope: 'CITY' as const, countryCode: 'DK', regionValue: 'Copenhagen' },
  ];

  for (const region of regions) {
    const existing = await prisma.logisticsServiceRegion.findFirst({
      where: {
        logisticsPartnerId: partnerId,
        scope: region.scope,
        countryCode: region.countryCode,
        regionValue: region.regionValue,
      },
      select: { id: true },
    });

    if (existing !== null) continue;

    await prisma.logisticsServiceRegion.create({
      data: {
        id: newId(),
        logisticsPartnerId: partnerId,
        scope: region.scope,
        countryCode: region.countryCode,
        regionValue: region.regionValue,
        supportsPickup: true,
        supportsDelivery: true,
        isActive: true,
      },
    });
  }
}

async function upsertSlaPolicy(partnerId: string): Promise<void> {
  const existing = await prisma.logisticsSlaPolicy.findFirst({
    where: { logisticsPartnerId: partnerId, isDefault: true },
    select: { id: true },
  });

  if (existing !== null) return;

  await prisma.logisticsSlaPolicy.create({
    data: {
      id: newId(),
      logisticsPartnerId: partnerId,
      name: 'Standard cold chain',
      serviceType: 'STANDARD',
      pickupHours: 12,
      deliveryHours: 48,
      riskWindowMinutes: 180,
      maxDeliveryAttempts: 3,
      podRequiresRecipientName: true,
      podRequiresSignature: true,
      podRequiresPhoto: false,
      podRequiresOtp: false,
      podRequiresDesignation: true,
      isDefault: true,
      isActive: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Something to look at
// ---------------------------------------------------------------------------

/**
 * Four consignments in four different states.
 *
 * Enough for the dashboard's counters to be non-zero, the list to have
 * something to filter, and the timeline to have something on it - and few
 * enough that a developer can hold all of them in their head while working out
 * whether a screen is telling the truth.
 *
 * Each one is moved through the REAL state machine rather than written
 * directly, so a seeded consignment is in a state the product could actually
 * have put it in.
 */
async function seedShipments(
  partnerId: string,
  dispatcher: LogisticsMembership,
): Promise<number> {
  const plans = [
    {
      receiver: 'Bremen Klinikum',
      city: 'Bremen',
      postalCode: '28195',
      coldChain: true,
      packages: 4,
      grams: 18_400,
      summary: 'Diagnostic reagents, refrigerated',
      /** Offered, and left waiting for the carrier to answer. */
      advanceTo: [] as const,
    },
    {
      receiver: 'Lübeck Praxiszentrum',
      city: 'Lübeck',
      postalCode: '23552',
      coldChain: false,
      packages: 2,
      grams: 6_100,
      summary: 'Sterile consumables',
      advanceTo: ['ACCEPT'] as const,
    },
    {
      receiver: 'Rotterdam Medisch Centrum',
      city: 'Rotterdam',
      postalCode: '3011',
      coldChain: true,
      packages: 6,
      grams: 26_800,
      summary: 'Vaccines, 2-8 degrees',
      advanceTo: ['ACCEPT', 'PICKUP_SCHEDULED', 'PICKED_UP', 'DISPATCHED', 'IN_TRANSIT'] as const,
    },
    {
      receiver: 'Hannover Laborhaus',
      city: 'Hannover',
      postalCode: '30159',
      coldChain: false,
      packages: 1,
      grams: 2_300,
      summary: 'Instrument spares',
      advanceTo: [
        'ACCEPT',
        'PICKUP_SCHEDULED',
        'PICKED_UP',
        'DISPATCHED',
        'IN_TRANSIT',
        'OUT_FOR_DELIVERY',
      ] as const,
    },
  ];

  let created = 0;

  for (const plan of plans) {
    /*
     * Checked per consignment rather than by counting the carrier's work.
     *
     * A count would make a run that failed halfway through unfixable: the
     * rows the first attempt did create would satisfy the guard, and the
     * ones it never reached would never be created. Keyed on the receiver,
     * a second run finishes what the first one started and leaves the rest
     * alone - which is what "idempotent" is supposed to mean.
     */
    const existing = await prisma.logisticsShipment.findFirst({
      where: { receivingCompanyName: plan.receiver, assignedPartnerId: partnerId },
      select: { id: true },
    });

    if (existing !== null) {
      created += 1;
      continue;
    }

    const shipment = await createShipment({
      sellerCompanyName: 'Northwind Medical Supplies',
      receivingCompanyName: plan.receiver,
      pickupAddress: PICKUP,
      deliveryAddress: { ...DELIVERY, city: plan.city, postalCode: plan.postalCode },
      pickupContactName: 'Warehouse office',
      pickupContactPhone: '+49 40 555 0180',
      deliveryContactName: 'Goods-in desk',
      deliveryContactPhone: '+49 421 555 0144',
      deliveryContactEmail: 'goods-in@example.test',
      packageCount: plan.packages,
      totalWeightGrams: plan.grams,
      productCategorySummary: plan.summary,
      requiresColdChain: plan.coldChain,
      requiresTemperatureRange: plan.coldChain,
      ...(plan.coldChain ? { temperatureMinC: 2, temperatureMaxC: 8 } : {}),
      expectedPickupAt: hoursFromNow(6),
      estimatedDeliveryAt: hoursFromNow(36),
    });

    await prisma.logisticsShipment.update({
      where: { id: shipment.id },
      data: { status: 'AWAITING_ASSIGNMENT' },
    });

    await offerAssignment({
      shipmentId: shipment.id,
      logisticsPartnerId: partnerId,
      offeredByUserId: null,
      automatic: false,
      respondByHours: 24,
      correlationId: `seed-${shipment.id}`,
    });

    for (const step of plan.advanceTo) {
      if (step === 'ACCEPT') {
        await acceptAssignment(dispatcher, shipment.id, `seed-${shipment.id}`);
        continue;
      }

      await recordShipmentEvent({
        shipmentId: shipment.id,
        status: step,
        actor: 'PARTNER',
        source: 'LOGISTICS_PORTAL',
        actorLogisticsPartnerId: partnerId,
        actorUserId: dispatcher.userId,
        permissions: [...dispatcher.permissions],
        occurredAt: new Date(),
        idempotencyKey: `seed-${shipment.id}-${step}`,
      });
    }

    created += 1;
  }

  return created;
}

function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}
