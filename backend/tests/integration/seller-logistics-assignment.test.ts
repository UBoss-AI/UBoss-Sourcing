/**
 * Two sellers, two carriers, and no way from any one of them to another.
 *
 * The seller half of the fulfilment split, against a real MariaDB. The
 * responsibility model this file exists to prove:
 *
 *   A seller chooses a CARRIER for their own paid consignment.
 *   A carrier chooses a DRIVER for the consignments it has accepted.
 *
 * and every assertion below is one way somebody could cross that line. The
 * fixtures are built the way production builds them - two real sellers, two
 * real carriers, one approved arrangement - so what is under test is the
 * isolation the product has, not a filter this file supplies.
 *
 * WHAT IS DELIBERATELY NOT TESTED HERE
 *
 * That a seller cannot add or assign a driver. There is no such function to
 * call: the seller service exposes none, and the seller routes import none.
 * A test would have to invent the very code path it claims to be guarding
 * against, and would then pass forever whether or not the guard existed. The
 * carrier-side driver rules have their own file.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/domain/errors.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { createShipment } from '../../src/modules/logistics/shipment-create.service.js';
import {
  carrierChoicesForShipment,
  decideSellerCarrier,
  listSellerCarriers,
  requestSellerCarrier,
  sellerAssignCarrier,
} from '../../src/modules/seller/logistics-partner.service.js';

const ACME_CODE = 'SLP-ACME';
const RIVAL_CODE = 'SLP-RIVAL';
const VISTULA_CODE = 'SLP-VISTULA';
const ODRA_CODE = 'SLP-ODRA';

let acmeSellerId = '';
let rivalSellerId = '';
let vistulaId = '';
let odraId = '';
let adminUserId = '';

/** Acme's own consignment, and Rival's. */
let acmeShipmentId = '';
let rivalShipmentId = '';

const PL_ADDRESS = {
  line1: 'ul. Fabryczna 1',
  city: 'Warsaw',
  postalCode: '00-001',
  countryCode: 'PL',
};

async function cleanUp(): Promise<void> {
  const sellerIds = (
    await prisma.sellerAccount.findMany({
      where: { slug: { in: [ACME_CODE, RIVAL_CODE] } },
      select: { id: true },
    })
  ).map((row) => row.id);

  const partnerIds = (
    await prisma.logisticsPartner.findMany({
      where: { partnerCode: { in: [VISTULA_CODE, ODRA_CODE] } },
      select: { id: true },
    })
  ).map((row) => row.id);

  const shipmentIds = (
    await prisma.logisticsShipment.findMany({
      where: { sellerAccountId: { in: sellerIds } },
      select: { id: true },
    })
  ).map((row) => row.id);

  // Children first. Orders are ON DELETE RESTRICT elsewhere in this schema and
  // leftovers break the NEXT run's first file rather than this one, which is
  // the most confusing failure available in this suite.
  await prisma.logisticsShipmentEvent.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentPackage.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentAssignment.deleteMany({
    where: { shipmentId: { in: shipmentIds } },
  });
  await prisma.logisticsShipment.deleteMany({ where: { id: { in: shipmentIds } } });
  await prisma.logisticsNotification.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.sellerLogisticsPartner.deleteMany({
    where: { sellerAccountId: { in: sellerIds } },
  });
  await prisma.logisticsAuditLog.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsPartner.deleteMany({ where: { id: { in: partnerIds } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellerIds } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { contains: '@slptest.local' } } });
  await prisma.numberSequence.deleteMany({ where: { key: { startsWith: 'logistics-' } } });
}

async function makeSeller(slug: string, name: string): Promise<string> {
  const id = newId();

  await prisma.sellerAccount.create({
    data: {
      id,
      slug,
      legalName: `${name} sp. z o.o.`,
      displayName: name,
      displayNameNormalized: name.toLowerCase().replace(/[^a-z0-9]/g, ''),
      registrationCountry: 'PL',
      kind: 'WHOLESALER',
      status: 'APPROVED',
    },
  });

  return id;
}

async function makeCarrier(partnerCode: string, name: string): Promise<string> {
  const id = newId();

  await prisma.logisticsPartner.create({
    data: {
      id,
      partnerCode,
      legalName: `${name} Sp. z o.o.`,
      displayName: name,
      displayNameNormalized: name.toLowerCase().replace(/[^a-z0-9]/g, ''),
      registrationCountry: 'PL',
      contactEmail: `${partnerCode.toLowerCase()}@slptest.local`,
      status: 'ACTIVE',
      contractStatus: 'ACTIVE',
    },
  });

  return id;
}

async function makeShipment(sellerAccountId: string, seller: string): Promise<string> {
  const created = await createShipment({
    sellerAccountId,
    sellerCompanyName: seller,
    receivingCompanyName: 'Szpital Bielanski',
    pickupAddress: PL_ADDRESS,
    deliveryAddress: { ...PL_ADDRESS, city: 'Krakow', postalCode: '30-001' },
    packageCount: 1,
    totalWeightGrams: 2000,
  });

  await prisma.logisticsShipment.update({
    where: { id: created.id },
    data: { status: 'AWAITING_ASSIGNMENT' },
  });

  return created.id;
}

/** Approve an arrangement the way the marketplace does, through the service. */
async function approve(
  sellerAccountId: string,
  logisticsPartnerId: string,
  overrides: Parameters<typeof decideSellerCarrier>[0] extends infer T
    ? T extends { linkId: string }
      ? Partial<Omit<T, 'linkId' | 'to' | 'decidedByUserId'>>
      : never
    : never = {},
): Promise<string> {
  const requested = await requestSellerCarrier({
    sellerAccountId,
    logisticsPartnerId,
    sellerMemberId: null,
    actorEmail: 'fixture@slptest.local',
  });

  await decideSellerCarrier({
    linkId: requested.linkId,
    to: 'APPROVED',
    decidedByUserId: adminUserId,
    ...overrides,
  });

  return requested.linkId;
}

beforeEach(async () => {
  await cleanUp();

  const admin = await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email: 'staff@slptest.local',
      emailNormalized: 'staff@slptest.local',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  adminUserId = admin.id;

  acmeSellerId = await makeSeller(ACME_CODE, 'Acme Medical');
  rivalSellerId = await makeSeller(RIVAL_CODE, 'Rival Supplies');

  vistulaId = await makeCarrier(VISTULA_CODE, 'Vistula Freight');
  odraId = await makeCarrier(ODRA_CODE, 'Odra Logistics');

  acmeShipmentId = await makeShipment(acmeSellerId, 'Acme Medical');
  rivalShipmentId = await makeShipment(rivalSellerId, 'Rival Supplies');
});

afterAll(async () => {
  await cleanUp();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe('a seller with an approved carrier', () => {
  it('offers its own consignment and the carrier is recorded on it', async () => {
    await approve(acmeSellerId, vistulaId);

    const result = await sellerAssignCarrier({
      sellerAccountId: acmeSellerId,
      shipmentId: acmeShipmentId,
      logisticsPartnerId: vistulaId,
      sellerMemberId: null,
      actorEmail: 'ops@slptest.local',
    });

    expect(result.assignmentId).toBeTruthy();
    expect(result.replacedPartnerId).toBeNull();

    const shipment = await prisma.logisticsShipment.findUniqueOrThrow({
      where: { id: acmeShipmentId },
    });
    expect(shipment.assignedPartnerId).toBe(vistulaId);

    // The offer is a real row in the carrier's own queue, not a field.
    const assignment = await prisma.logisticsShipmentAssignment.findFirstOrThrow({
      where: { shipmentId: acmeShipmentId, state: 'OFFERED' },
    });
    expect(assignment.logisticsPartnerId).toBe(vistulaId);

    // And it is on the seller's trail, because a seller looking at a late
    // delivery needs to know who sent it where.
    const audit = await prisma.sellerAuditLog.findFirstOrThrow({
      where: { sellerAccountId: acmeSellerId, action: 'seller.carrier.assigned' },
    });
    expect(audit.resourceId).toBe(acmeShipmentId);
  });

  it('lists the carrier as an option, and the unapproved one as not', async () => {
    await approve(acmeSellerId, vistulaId);

    const options = await carrierChoicesForShipment(acmeSellerId, acmeShipmentId);

    const vistula = options.find((row) => row.logisticsPartnerId === vistulaId);
    expect(vistula?.isEligible).toBe(true);

    // Odra is not in Acme's list at all, because Acme never asked for it.
    expect(options.some((row) => row.logisticsPartnerId === odraId)).toBe(false);
  });

  it('reassigns with a reason and keeps the earlier offer as history', async () => {
    await approve(acmeSellerId, vistulaId);
    await approve(acmeSellerId, odraId);

    await sellerAssignCarrier({
      sellerAccountId: acmeSellerId,
      shipmentId: acmeShipmentId,
      logisticsPartnerId: vistulaId,
      sellerMemberId: null,
      actorEmail: 'ops@slptest.local',
    });

    const moved = await sellerAssignCarrier({
      sellerAccountId: acmeSellerId,
      shipmentId: acmeShipmentId,
      logisticsPartnerId: odraId,
      sellerMemberId: null,
      actorEmail: 'ops@slptest.local',
      reason: 'Vistula could not collect before the cutoff.',
    });

    expect(moved.replacedPartnerId).toBe(vistulaId);

    const shipment = await prisma.logisticsShipment.findUniqueOrThrow({
      where: { id: acmeShipmentId },
    });
    expect(shipment.assignedPartnerId).toBe(odraId);

    // Both offers survive. "Why did two carriers have this parcel?" is asked
    // after a late delivery, and an overwrite would make it unanswerable.
    const all = await prisma.logisticsShipmentAssignment.findMany({
      where: { shipmentId: acmeShipmentId },
    });
    expect(all).toHaveLength(2);
    expect(all.filter((row) => row.state === 'OFFERED')).toHaveLength(1);
  });

  it('refuses a reassignment with no reason', async () => {
    await approve(acmeSellerId, vistulaId);
    await approve(acmeSellerId, odraId);

    await sellerAssignCarrier({
      sellerAccountId: acmeSellerId,
      shipmentId: acmeShipmentId,
      logisticsPartnerId: vistulaId,
      sellerMemberId: null,
      actorEmail: 'ops@slptest.local',
    });

    await expect(
      sellerAssignCarrier({
        sellerAccountId: acmeSellerId,
        shipmentId: acmeShipmentId,
        logisticsPartnerId: odraId,
        sellerMemberId: null,
        actorEmail: 'ops@slptest.local',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('one seller cannot reach another', () => {
  it('cannot offer a carrier for a consignment that is not theirs', async () => {
    // Acme is properly set up with Vistula. The consignment belongs to Rival.
    await approve(acmeSellerId, vistulaId);

    await expect(
      sellerAssignCarrier({
        sellerAccountId: acmeSellerId,
        shipmentId: rivalShipmentId,
        logisticsPartnerId: vistulaId,
        sellerMemberId: null,
        actorEmail: 'ops@slptest.local',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });

    const shipment = await prisma.logisticsShipment.findUniqueOrThrow({
      where: { id: rivalShipmentId },
    });
    expect(shipment.assignedPartnerId).toBeNull();
  });

  it('cannot even ask which carriers could take another seller consignment', async () => {
    // NOT_FOUND rather than FORBIDDEN, so the answer does not confirm that
    // the consignment exists.
    await expect(carrierChoicesForShipment(acmeSellerId, rivalShipmentId)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('cannot borrow another seller approved arrangement', async () => {
    // THE CENTRAL CLAIM. Rival is approved for Vistula; Acme is not. Acme
    // owns the consignment, so ownership is not what stops this - only the
    // arrangement is.
    await approve(rivalSellerId, vistulaId);

    await expect(
      sellerAssignCarrier({
        sellerAccountId: acmeSellerId,
        shipmentId: acmeShipmentId,
        logisticsPartnerId: vistulaId,
        sellerMemberId: null,
        actorEmail: 'ops@slptest.local',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.LOGISTICS_PARTNER_NOT_ELIGIBLE });
  });

  it('sees only its own arrangements', async () => {
    await approve(acmeSellerId, vistulaId);
    await approve(rivalSellerId, odraId);

    const acme = await listSellerCarriers(acmeSellerId);
    const rival = await listSellerCarriers(rivalSellerId);

    expect(acme.map((row) => row.logisticsPartnerId)).toEqual([vistulaId]);
    expect(rival.map((row) => row.logisticsPartnerId)).toEqual([odraId]);
  });

  it('cannot approve its own arrangement by requesting one', async () => {
    // The whole point of the queue. A request is REQUESTED and stays there
    // until a member of the marketplace's staff decides it.
    const requested = await requestSellerCarrier({
      sellerAccountId: acmeSellerId,
      logisticsPartnerId: vistulaId,
      sellerMemberId: null,
      actorEmail: 'ops@slptest.local',
    });

    expect(requested.status).toBe('REQUESTED');

    await expect(
      sellerAssignCarrier({
        sellerAccountId: acmeSellerId,
        shipmentId: acmeShipmentId,
        logisticsPartnerId: vistulaId,
        sellerMemberId: null,
        actorEmail: 'ops@slptest.local',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.LOGISTICS_PARTNER_NOT_ELIGIBLE });
  });
});

// ---------------------------------------------------------------------------
// The state of the arrangement
// ---------------------------------------------------------------------------

describe('an arrangement that is not usable', () => {
  it('refuses a suspended arrangement for new work', async () => {
    const linkId = await approve(acmeSellerId, vistulaId);

    await decideSellerCarrier({
      linkId,
      to: 'SUSPENDED',
      decidedByUserId: adminUserId,
      reason: 'Insurance certificate lapsed.',
    });

    await expect(
      sellerAssignCarrier({
        sellerAccountId: acmeSellerId,
        shipmentId: acmeShipmentId,
        logisticsPartnerId: vistulaId,
        sellerMemberId: null,
        actorEmail: 'ops@slptest.local',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.LOGISTICS_PARTNER_NOT_ELIGIBLE });
  });

  it('refuses when the carrier itself is suspended, however good the arrangement', async () => {
    await approve(acmeSellerId, vistulaId);
    await prisma.logisticsPartner.update({
      where: { id: vistulaId },
      data: { status: 'SUSPENDED' },
    });

    await expect(
      sellerAssignCarrier({
        sellerAccountId: acmeSellerId,
        shipmentId: acmeShipmentId,
        logisticsPartnerId: vistulaId,
        sellerMemberId: null,
        actorEmail: 'ops@slptest.local',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.LOGISTICS_PARTNER_NOT_ELIGIBLE });
  });

  it('refuses a route outside the agreed countries', async () => {
    await approve(acmeSellerId, vistulaId, { serviceCountries: ['DE'] });

    await expect(
      sellerAssignCarrier({
        sellerAccountId: acmeSellerId,
        shipmentId: acmeShipmentId,
        logisticsPartnerId: vistulaId,
        sellerMemberId: null,
        actorEmail: 'ops@slptest.local',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.LOGISTICS_PARTNER_NOT_ELIGIBLE });
  });

  it('refuses a carrier that does not exist, without saying so', async () => {
    // Identical to "you are not set up to use that carrier". Distinguishing
    // the two would make this endpoint a way to enumerate the marketplace's
    // carrier list one guess at a time.
    await expect(
      sellerAssignCarrier({
        sellerAccountId: acmeSellerId,
        shipmentId: acmeShipmentId,
        logisticsPartnerId: newId(),
        sellerMemberId: null,
        actorEmail: 'ops@slptest.local',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.LOGISTICS_PARTNER_NOT_ELIGIBLE });
  });

  it('refuses a consignment that has already finished', async () => {
    await approve(acmeSellerId, vistulaId);
    await prisma.logisticsShipment.update({
      where: { id: acmeShipmentId },
      data: { status: 'DELIVERED' },
    });

    await expect(
      sellerAssignCarrier({
        sellerAccountId: acmeSellerId,
        shipmentId: acmeShipmentId,
        logisticsPartnerId: vistulaId,
        sellerMemberId: null,
        actorEmail: 'ops@slptest.local',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.LOGISTICS_SHIPMENT_TERMINAL });
  });
});

// ---------------------------------------------------------------------------
// The arrangement record itself
// ---------------------------------------------------------------------------

describe('requesting and deciding', () => {
  it('keeps exactly one row per seller and carrier, however often it is asked for', async () => {
    const linkId = await approve(acmeSellerId, vistulaId);

    await decideSellerCarrier({
      linkId,
      to: 'ENDED',
      decidedByUserId: adminUserId,
      reason: 'Contract not renewed.',
    });

    // Asking again moves the same row back rather than creating a second
    // arrangement that could disagree with the first.
    const again = await requestSellerCarrier({
      sellerAccountId: acmeSellerId,
      logisticsPartnerId: vistulaId,
      sellerMemberId: null,
      actorEmail: 'ops@slptest.local',
    });

    expect(again.linkId).toBe(linkId);
    expect(again.status).toBe('REQUESTED');

    const rows = await prisma.sellerLogisticsPartner.findMany({
      where: { sellerAccountId: acmeSellerId, logisticsPartnerId: vistulaId },
    });
    expect(rows).toHaveLength(1);
  });

  it('refuses a duplicate request while one is already open', async () => {
    await requestSellerCarrier({
      sellerAccountId: acmeSellerId,
      logisticsPartnerId: vistulaId,
      sellerMemberId: null,
      actorEmail: 'ops@slptest.local',
    });

    await expect(
      requestSellerCarrier({
        sellerAccountId: acmeSellerId,
        logisticsPartnerId: vistulaId,
        sellerMemberId: null,
        actorEmail: 'ops@slptest.local',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('refuses an adverse decision with no reason', async () => {
    const requested = await requestSellerCarrier({
      sellerAccountId: acmeSellerId,
      logisticsPartnerId: vistulaId,
      sellerMemberId: null,
      actorEmail: 'ops@slptest.local',
    });

    await expect(
      decideSellerCarrier({
        linkId: requested.linkId,
        to: 'REJECTED',
        decidedByUserId: adminUserId,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('records who decided it, and when', async () => {
    const linkId = await approve(acmeSellerId, vistulaId);

    const row = await prisma.sellerLogisticsPartner.findUniqueOrThrow({ where: { id: linkId } });

    expect(row.decidedByUserId).toBe(adminUserId);
    expect(row.decidedAt).not.toBeNull();
    expect(row.status).toBe('APPROVED');
  });

  it('refuses a transition the state machine does not allow', async () => {
    const requested = await requestSellerCarrier({
      sellerAccountId: acmeSellerId,
      logisticsPartnerId: vistulaId,
      sellerMemberId: null,
      actorEmail: 'ops@slptest.local',
    });

    await decideSellerCarrier({
      linkId: requested.linkId,
      to: 'REJECTED',
      decidedByUserId: adminUserId,
      reason: 'No liability cover on file.',
    });

    // A rejected arrangement cannot be approved directly; the seller has to
    // ask again, which puts a fresh decision in the queue.
    await expect(
      decideSellerCarrier({
        linkId: requested.linkId,
        to: 'APPROVED',
        decidedByUserId: adminUserId,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });
});
