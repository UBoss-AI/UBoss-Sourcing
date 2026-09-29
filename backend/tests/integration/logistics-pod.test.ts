/**
 * Proof of delivery: what the portal is told a delivery needs, and what
 * capturing it enforces.
 *
 * DELIVERED is only reachable with a proof of delivery, for every shipment, by
 * design (logistics-shipment-state.ts). Until the portal had a capture screen
 * that made "delivered" unreachable from the portal altogether. The screen
 * needs two things from here, and this file holds both:
 *
 *   - `readPodRequirements` tells it which fields the delivery's SLA policy
 *     demands, so it asks for exactly those;
 *   - `captureProofOfDelivery` refuses what the policy does not allow, names
 *     the missing field, moves the shipment to DELIVERED itself, and answers a
 *     repeat as a duplicate rather than an error.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsForLogisticsRole } from '../../src/domain/logistics-permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { LogisticsMembership } from '../../src/modules/logistics/partner.service.js';
import { acceptAssignment, offerAssignment } from '../../src/modules/logistics/assignment.service.js';
import { captureProofOfDelivery, readPodRequirements } from '../../src/modules/logistics/pod.service.js';
import { createShipment } from '../../src/modules/logistics/shipment-create.service.js';

const CODE = 'LP-TEST-POD';
const OWNER_EMAIL = 'pod-owner@carrier.test';
const DISPATCH_EMAIL = 'pod-dispatch@carrier.test';
const EMAILS = [OWNER_EMAIL, DISPATCH_EMAIL];
const ADDRESS = { line1: '1 Dock Road', city: 'Antwerp', postalCode: '2000', countryCode: 'BE' };

let partnerId = '';
let owner: LogisticsMembership;
let dispatcher: LogisticsMembership;
const shipmentIds: string[] = [];

async function cleanUp(): Promise<void> {
  const partnerIds = (
    await prisma.logisticsPartner.findMany({ where: { partnerCode: CODE }, select: { id: true } })
  ).map((row) => row.id);
  const ids = (
    await prisma.logisticsShipmentAssignment.findMany({
      where: { logisticsPartnerId: { in: partnerIds } },
      select: { shipmentId: true },
    })
  ).map((row) => row.shipmentId);
  const all = [...new Set([...ids, ...shipmentIds])];

  await prisma.logisticsProofOfDelivery.deleteMany({ where: { shipmentId: { in: all } } });
  await prisma.logisticsShipmentDocument.deleteMany({ where: { shipmentId: { in: all } } });
  await prisma.logisticsShipmentEvent.deleteMany({ where: { shipmentId: { in: all } } });
  await prisma.logisticsShipmentPackage.deleteMany({ where: { shipmentId: { in: all } } });
  await prisma.logisticsShipmentAssignment.deleteMany({ where: { shipmentId: { in: all } } });
  await prisma.logisticsShipmentException.deleteMany({ where: { shipmentId: { in: all } } });
  await prisma.logisticsNotification.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsShipment.deleteMany({ where: { id: { in: all } } });
  await prisma.logisticsAuditLog.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsSlaPolicy.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsPartnerUser.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsPartner.deleteMany({ where: { id: { in: partnerIds } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { in: EMAILS } } });
}

async function member(email: string, role: 'LOGISTICS_PARTNER_OWNER' | 'DISPATCHER'): Promise<LogisticsMembership> {
  const userId = newId();
  const partnerUserId = newId();
  await prisma.user.create({ data: { id: userId, type: 'LOGISTICS', email, emailNormalized: email, status: 'ACTIVE' } });
  await prisma.logisticsPartnerUser.create({
    data: { id: partnerUserId, logisticsPartnerId: partnerId, userId, role, status: 'ACTIVE', fullName: role },
  });
  return {
    logisticsPartnerId: partnerId,
    partnerCode: CODE,
    displayName: 'Proof Courier',
    legalName: 'Proof Courier NV',
    partnerStatus: 'ACTIVE',
    registrationCountry: 'BE',
    partnerUserId,
    userId,
    fullName: role,
    role,
    permissions: permissionsForLogisticsRole(role),
    canAcceptNewWork: true,
    requiresMfa: role === 'LOGISTICS_PARTNER_OWNER',
    regionScope: null,
    driverProfileId: null,
  };
}

/** A shipment this carrier holds, out for delivery, optionally under a policy. */
async function outForDelivery(policy?: { signature?: boolean; photo?: boolean; designation?: boolean }): Promise<string> {
  const created = await createShipment({
    sellerCompanyName: 'Northwind Medical',
    receivingCompanyName: 'St Luke Hospital',
    pickupAddress: ADDRESS,
    deliveryAddress: { ...ADDRESS, city: 'Ghent', postalCode: '9000' },
    deliveryContactName: 'Jan de Boer',
    deliveryContactPhone: '+32 478 12 34 56',
    packageCount: 1,
    totalWeightGrams: 1200,
  });
  shipmentIds.push(created.id);

  await prisma.logisticsShipment.update({ where: { id: created.id }, data: { status: 'AWAITING_ASSIGNMENT' } });
  await offerAssignment({ shipmentId: created.id, logisticsPartnerId: partnerId, offeredByUserId: null, automatic: false });
  await acceptAssignment(owner, created.id);

  let slaPolicyId: string | null = null;
  if (policy !== undefined) {
    slaPolicyId = newId();
    await prisma.logisticsSlaPolicy.create({
      data: {
        id: slaPolicyId,
        logisticsPartnerId: partnerId,
        name: `Policy ${slaPolicyId}`,
        podRequiresRecipientName: true,
        podRequiresSignature: policy.signature ?? false,
        podRequiresPhoto: policy.photo ?? false,
        podRequiresDesignation: policy.designation ?? false,
      },
    });
  }

  // The van is out: the one status from which DELIVERED is reachable.
  await prisma.logisticsShipment.update({
    where: { id: created.id },
    data: { status: 'OUT_FOR_DELIVERY', slaPolicyId },
  });
  return created.id;
}

async function document(shipmentId: string, kind: 'DELIVERY_SIGNATURE' | 'DELIVERY_PHOTO'): Promise<string> {
  const id = newId();
  await prisma.logisticsShipmentDocument.create({
    data: {
      id,
      shipmentId,
      kind,
      fileName: `${kind.toLowerCase()}.jpg`,
      contentType: 'image/jpeg',
      sizeBytes: 1024,
      storageKey: `test/${id}.jpg`,
      scanState: 'CLEAN',
    },
  });
  return id;
}

async function refusal(run: Promise<unknown>): Promise<{ code: string; fields: string[] }> {
  try {
    await run;
  } catch (error) {
    const e = error as { code: string; details?: { field?: string }[] };
    return { code: e.code, fields: (e.details ?? []).map((detail) => detail.field ?? '') };
  }
  throw new Error('expected a refusal');
}

beforeAll(async () => {
  await cleanUp();
  partnerId = newId();
  await prisma.logisticsPartner.create({
    data: {
      id: partnerId,
      partnerCode: CODE,
      legalName: 'Proof Courier NV',
      displayName: 'Proof Courier',
      displayNameNormalized: 'proofcourier',
      registrationCountry: 'BE',
      contactEmail: OWNER_EMAIL,
      status: 'ACTIVE',
      contractStatus: 'ACTIVE',
    },
  });
  owner = await member(OWNER_EMAIL, 'LOGISTICS_PARTNER_OWNER');
  dispatcher = await member(DISPATCH_EMAIL, 'DISPATCHER');
});

afterAll(async () => {
  await cleanUp();
});

describe('what the portal is told a delivery needs', () => {
  it('asks only for a name when no policy applies', async () => {
    const id = await outForDelivery();
    expect(await readPodRequirements(id)).toEqual({
      requiresRecipientName: true,
      requiresSignature: false,
      requiresPhoto: false,
      requiresOtp: false,
      requiresDesignation: false,
    });
  });

  it('follows the shipment’s own SLA policy', async () => {
    const id = await outForDelivery({ signature: true, photo: true, designation: true });
    expect(await readPodRequirements(id)).toMatchObject({
      requiresSignature: true,
      requiresPhoto: true,
      requiresDesignation: true,
    });
  });
});

describe('capturing a proof of delivery', () => {
  it('refuses a proof with no name, and names the field', async () => {
    const id = await outForDelivery();
    const refused = await refusal(captureProofOfDelivery(owner, { shipmentId: id, recipientName: ' ' }));

    expect(refused.code).toBe('SHIPMENT_POD_REQUIRED');
    expect(refused.fields).toContain('recipientName');
    expect((await prisma.logisticsShipment.findUniqueOrThrow({ where: { id } })).status).toBe('OUT_FOR_DELIVERY');
  });

  it('completes the delivery itself, and treats a second capture as the same one', async () => {
    const id = await outForDelivery();

    const first = await captureProofOfDelivery(owner, { shipmentId: id, recipientName: 'A. Kowalska' });
    expect(first).toMatchObject({ status: 'DELIVERED', duplicate: false });
    expect((await prisma.logisticsShipment.findUniqueOrThrow({ where: { id } })).status).toBe('DELIVERED');

    // A phone retrying on a flaky connection is told it worked, not that it failed.
    const second = await captureProofOfDelivery(owner, { shipmentId: id, recipientName: 'A. Kowalska' });
    expect(second).toMatchObject({ podId: first.podId, duplicate: true });
    expect(await prisma.logisticsProofOfDelivery.count({ where: { shipmentId: id } })).toBe(1);
  });

  it('insists on the signature and photograph the policy demands', async () => {
    const id = await outForDelivery({ signature: true, photo: true });

    const refused = await refusal(captureProofOfDelivery(owner, { shipmentId: id, recipientName: 'Ward sister' }));
    expect(refused.code).toBe('SHIPMENT_POD_REQUIRED');
    expect(refused.fields).toEqual(expect.arrayContaining(['signatureDocumentId', 'photoDocumentId']));

    const captured = await captureProofOfDelivery(owner, {
      shipmentId: id,
      recipientName: 'Ward sister',
      signatureDocumentId: await document(id, 'DELIVERY_SIGNATURE'),
      photoDocumentId: await document(id, 'DELIVERY_PHOTO'),
    });
    expect(captured.status).toBe('DELIVERED');
  });

  it('refuses a signature uploaded to a different shipment', async () => {
    const id = await outForDelivery({ signature: true });
    const elsewhere = await outForDelivery();

    const refused = await refusal(
      captureProofOfDelivery(owner, {
        shipmentId: id,
        recipientName: 'Ward sister',
        signatureDocumentId: await document(elsewhere, 'DELIVERY_SIGNATURE'),
      }),
    );
    expect(refused.code).toBe('VALIDATION_FAILED');
    expect(refused.fields).toContain('signatureDocumentId');
  });

  it('refuses a member of staff whose role may not complete deliveries', async () => {
    const id = await outForDelivery();
    const refused = await refusal(captureProofOfDelivery(dispatcher, { shipmentId: id, recipientName: 'Somebody' }));

    expect(refused.code).not.toBe('SHIPMENT_POD_REQUIRED');
    expect((await prisma.logisticsShipment.findUniqueOrThrow({ where: { id } })).status).toBe('OUT_FOR_DELIVERY');
  });
});
