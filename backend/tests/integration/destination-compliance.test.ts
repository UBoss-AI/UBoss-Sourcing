/**
 * JOURNEY-046 (shipment booking) and JOURNEY-049 (destination documentation
 * readiness), against a real MariaDB, through the services.
 *
 *  - Cargo insurance: refused while the operator offers none, capped at the
 *    share of the goods value, premium stored in BigInt minor units beside the
 *    rate; the buyer sees it on their shipment details.
 *  - Freight options: the operator's lanes for the route and weight, with
 *    their validity dates. Booking view: countries and dispatch readiness.
 *  - HS codes: staff verify (correcting) or reject with a note, audited, the
 *    seller told; a changed code goes back to DECLARED.
 *  - Trade rules: audited CRUD; every responsible party listed; the buyer
 *    sees what they owe; prohibited goods, a seller document not yet valid,
 *    or an unverified HS code hold the goods with 409 until fixed or
 *    overridden in writing.
 *
 * The insurance settings row is global: it is restored in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';

let prisma: PrismaClient;
let newId: () => string;
let seller: SellerMembership;

const PREFIX = 'jdc-';
const EMAILS = ['jdc-buyer@test.local', 'jdc-seller@test.local'];
const RULE_PREFIX = 'JDC ';
const STAFF = { userId: '01JDCSTAFF0000000000000000', email: 'jdc-staff@test.local' };

let savedSettings: { insuranceBasisPoints: number; maxInsuredBasisPoints: number } | null = null;
let buyerProfileId = '';
let orderId = '';
let groupId = '';
let offerId = '';
let shipmentId = '';
let categoryId = '';
let laneId = '';

async function cleanUp(): Promise<void> {
  const sellers = (
    await prisma.sellerAccount.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } })
  ).map((row) => row.id);
  const profiles = (
    await prisma.customerProfile.findMany({ where: { user: { emailNormalized: { in: EMAILS } } }, select: { id: true } })
  ).map((row) => row.id);
  const orders = (
    await prisma.order.findMany({ where: { customerProfileId: { in: profiles } }, select: { id: true } })
  ).map((row) => row.id);

  await prisma.tradeComplianceRule.deleteMany({ where: { name: { startsWith: RULE_PREFIX } } });
  await prisma.logisticsLaneBand.deleteMany({ where: { lane: { name: { startsWith: RULE_PREFIX } } } });
  await prisma.logisticsLane.deleteMany({ where: { name: { startsWith: RULE_PREFIX } } });
  await prisma.auditLog.deleteMany({ where: { actorUserId: STAFF.userId } });
  await prisma.orderTradeDocument.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  const shipments = (
    await prisma.logisticsShipment.findMany({ where: { sellerAccountId: { in: sellers } }, select: { id: true } })
  ).map((row) => row.id);
  await prisma.consignmentBookingTerms.deleteMany({ where: { shipmentId: { in: shipments } } });
  await prisma.logisticsShipmentEvent.deleteMany({ where: { shipmentId: { in: shipments } } });
  await prisma.logisticsShipment.deleteMany({ where: { id: { in: shipments } } });
  await prisma.adminNotification.deleteMany({ where: { relatedId: { in: shipments } } });
  await prisma.notificationOutbox.deleteMany({ where: { relatedId: { in: [...shipments, ...orders] } } });
  await prisma.tradeComplianceOverride.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.sellerOrderLine.deleteMany({ where: { orderGroup: { sellerAccountId: { in: sellers } } } });
  await prisma.sellerOrderGroup.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.order.deleteMany({ where: { id: { in: orders } } });
  await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerLocation.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerMember.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellers } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.taxClass.deleteMany({ where: { code: `${PREFIX}T`.slice(0, 16) } });
  await prisma.category.deleteMany({ where: { slug: `${PREFIX}category` } });
  await prisma.customerProfile.deleteMany({ where: { id: { in: profiles } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: { in: EMAILS } } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { in: EMAILS } } });
  await prisma.user.deleteMany({ where: { id: STAFF.userId } });
}

async function makeProfile(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: { id: newId(), type: 'CUSTOMER', email, emailNormalized: email, status: 'ACTIVE', emailVerifiedAt: new Date() },
  });
  return (
    await prisma.customerProfile.create({
      data: { id: newId(), userId: user.id, fullName: `Person ${email}`, organization: 'Org', activatedAt: new Date() },
    })
  ).id;
}

const logisticsActor = () => ({ sellerAccountId: seller.sellerAccountId, memberId: seller.memberId, label: 'JDC dispatch' });
const BASE_BOOKING = { mode: 'SEA', incoterm: 'CIF', originPort: 'INNSA', destinationPort: 'DEHAM' };

async function booking() {
  return import('../../src/modules/seller/shipment-booking.service.js');
}
async function compliance() {
  return import('../../src/modules/compliance/destination-compliance.service.js');
}
async function setInsurance(insuranceBasisPoints: number, maxInsuredBasisPoints = 11_000): Promise<void> {
  const { saveInsuranceSettings } = await import('../../src/modules/compliance/trade-settings.service.js');
  await saveInsuranceSettings({ insuranceBasisPoints, maxInsuredBasisPoints }, STAFF);
}

beforeAll(async () => {
  ({ prisma } = (await import('../../src/infra/prisma.js')) as unknown as { prisma: PrismaClient });
  ({ newId } = await import('../../src/infra/ids.js'));
  const { resolveSellerMembership } = await import('../../src/modules/seller/account.service.js');
  await cleanUp();
  // Audit rows reference a real user, so the staff actor needs one.
  await prisma.user.create({
    data: { id: STAFF.userId, type: 'ADMIN', email: STAFF.email, emailNormalized: STAFF.email, status: 'ACTIVE', emailVerifiedAt: new Date() },
  });

  const row = await prisma.logisticsTradeSettings.findUnique({ where: { id: 'default' } });
  savedSettings = row === null ? null : { insuranceBasisPoints: row.insuranceBasisPoints, maxInsuredBasisPoints: row.maxInsuredBasisPoints };

  buyerProfileId = await makeProfile(EMAILS[0] ?? '');
  const sellerPerson = await makeProfile(EMAILS[1] ?? '');
  const sellerAccountId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerAccountId,
      legalName: 'JDC Exports Private Limited',
      displayName: 'JDC Exports',
      displayNameNormalized: 'jdc exports',
      slug: `${PREFIX}seller`,
      kind: 'MANUFACTURER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });
  await prisma.sellerMember.create({
    data: { id: newId(), sellerAccountId, customerProfileId: sellerPerson, role: 'OWNER' },
  });
  seller = await resolveSellerMembership(sellerPerson);

  const taxClass =
    (await prisma.taxClass.findFirst({ select: { id: true } })) ??
    (await prisma.taxClass.create({
      data: { id: newId(), code: `${PREFIX}T`.slice(0, 16), name: 'GST 18%', ratePercent: '18.000000', isActive: true },
      select: { id: true },
    }));
  categoryId = (
    await prisma.category.create({ data: { id: newId(), name: 'JDC', slug: `${PREFIX}category`, isActive: true } })
  ).id;
  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId,
      taxClassId: taxClass.id,
      name: 'Surgical masks',
      slug: `${PREFIX}masks`,
      sku: 'JDC-MASK',
      basePriceMinor: 0n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      isMarketplaceProduct: true,
    },
  });
  offerId = newId();
  await prisma.sellerOffer.create({
    data: {
      id: offerId,
      sellerAccountId,
      productId: product.id,
      variantKey: '',
      sellerSku: 'JDC-MASK-50',
      status: 'ACTIVE',
      priceMinor: 1000n,
      currency: 'INR',
      hsnCode: '63079090',
      countryOfOrigin: 'IN',
    },
  });

  const address = {
    contactName: 'Dock',
    contactPhone: '+4940000000',
    line1: '1 Hafenstrasse',
    line2: null,
    city: 'Hamburg',
    state: 'HH',
    postalCode: '20457',
    country: 'DE',
  };
  orderId = newId();
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `JDC-${orderId.slice(-8)}`,
      customerProfileId: buyerProfileId,
      status: 'CONFIRMED',
      currency: 'INR',
      subtotalMinor: 100_000n,
      taxMinor: 0n,
      shippingMinor: 0n,
      grandTotalMinor: 100_000n,
      billingAddressJson: address,
      shippingAddressJson: address,
      placedAt: new Date(),
    },
  });
  const orderItemId = newId();
  await prisma.orderItem.create({
    data: {
      id: orderItemId,
      orderId,
      productId: product.id,
      sellerOfferId: offerId,
      nameSnapshot: 'Surgical masks',
      skuSnapshot: 'JDC-MASK',
      taxClassCodeSnapshot: 'ZERO',
      unitPriceMinor: 1000n,
      quantity: 100,
      lineSubtotalMinor: 100_000n,
      taxRatePercent: '0.000000',
      taxInclusive: false,
      taxAmountMinor: 0n,
      discountMinor: 0n,
      lineTotalMinor: 100_000n,
    },
  });
  groupId = newId();
  await prisma.sellerOrderGroup.create({
    data: {
      id: groupId,
      sellerAccountId,
      orderId,
      sellerOrderNumber: `SO-${groupId.slice(-6)}`,
      status: 'PROCESSING',
      goodsTotalMinor: 100_000n,
      currency: 'INR',
    },
  });
  await prisma.sellerOrderLine.create({
    data: {
      id: newId(),
      orderGroupId: groupId,
      orderItemId,
      offerId,
      quantity: 100,
      unitPriceMinor: 1000n,
      lineTotalMinor: 100_000n,
      currency: 'INR',
    },
  });

  const { createShipment } = await import('../../src/modules/logistics/shipment-create.service.js');
  shipmentId = (
    await createShipment({
      orderId,
      sellerOrderGroupId: groupId,
      sellerAccountId,
      sellerCompanyName: 'JDC Exports',
      receivingCustomerProfileId: buyerProfileId,
      receivingCompanyName: 'Hamburg Klinik',
      pickupAddress: { line1: '12 MIDC', city: 'Pune', region: 'Maharashtra', postalCode: '411019', countryCode: 'IN' },
      deliveryAddress: { line1: '1 Hafenstrasse', city: 'Hamburg', region: 'HH', postalCode: '20457', countryCode: 'DE' },
      currency: 'INR',
    })
  ).id;
  await prisma.logisticsShipment.update({ where: { id: shipmentId }, data: { totalWeightGrams: 12_000 } });
});

afterAll(async () => {
  if (savedSettings === null) await prisma.logisticsTradeSettings.deleteMany({ where: { id: 'default' } });
  else await prisma.logisticsTradeSettings.update({ where: { id: 'default' }, data: savedSettings });
  await cleanUp();
});

describe('cargo insurance on a booking (JOURNEY-046)', () => {
  it('is refused with 409 while the marketplace offers none', async () => {
    await setInsurance(0);
    const { saveShipmentBooking, readShipmentBooking } = await booking();
    expect((await readShipmentBooking(seller.sellerAccountId, shipmentId)).insurance.offered).toBe(false);
    await expect(
      saveShipmentBooking({ actor: logisticsActor(), shipmentId, booking: { ...BASE_BOOKING, insured: true, insuredValueMinor: '100000' } }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'SHIPMENT_INSURANCE_NOT_OFFERED' });
  });

  it('caps the insured value and stores the premium beside the rate; the buyer sees it', async () => {
    await setInsurance(35, 11_000);
    const { saveShipmentBooking, readShipmentBooking, listBuyerShipmentDetails } = await booking();
    const offer = (await readShipmentBooking(seller.sellerAccountId, shipmentId)).insurance;
    expect(offer).toMatchObject({ offered: true, goodsValueMinor: '100000', maxInsuredValueMinor: '110000', currency: 'INR' });

    await expect(
      saveShipmentBooking({ actor: logisticsActor(), shipmentId, booking: { ...BASE_BOOKING, insured: true, insuredValueMinor: '110001' } }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'BOOKING_TERMS_INVALID' });

    const saved = await saveShipmentBooking({
      actor: logisticsActor(),
      shipmentId,
      booking: { ...BASE_BOOKING, insured: true, insuredValueMinor: '110000' },
    });
    expect(saved.terms).toMatchObject({
      insured: true,
      insuredValueMinor: '110000',
      insurancePremiumMinor: '385',
      insuranceBasisPointsApplied: 35,
      insuranceCurrency: 'INR',
    });
    expect(saved).toMatchObject({ originCountry: 'IN', destinationCountry: 'DE', crossBorder: true });

    const buyer = await listBuyerShipmentDetails({ customerProfileId: buyerProfileId, buyerCompanyId: null }, orderId);
    expect(buyer[0]?.terms).toMatchObject({ insured: true, insurancePremiumMinor: '385' });

    const cleared = await saveShipmentBooking({ actor: logisticsActor(), shipmentId, booking: { ...BASE_BOOKING, insured: false } });
    expect(cleared.terms).toMatchObject({ insured: false, insuredValueMinor: null, insurancePremiumMinor: null });
  });

  it('lists the operator lanes for the route and weight, with their validity dates', async () => {
    const { saveLane } = await import('../../src/modules/logistics/lane-rate.service.js');
    const validTo = new Date(Date.now() + 30 * 86_400_000);
    laneId = (
      await saveLane(
        null,
        {
          name: `${RULE_PREFIX}Nhava Sheva to Hamburg`,
          originCountry: 'IN',
          originRegion: '',
          destinationCountry: 'DE',
          destinationRegion: '',
          mode: 'SEA',
          carrierName: 'JDC Line',
          serviceLevel: 'STANDARD',
          transitDaysMin: 20,
          transitDaysMax: 28,
          isServiceable: true,
          currency: 'INR',
          minimumChargeMinor: '0',
          fuelSurchargeBasisPoints: 0,
          validFrom: new Date(Date.now() - 86_400_000),
          validTo,
          isActive: true,
          bands: [{ minWeightGrams: 0, maxWeightGrams: null, amountMinor: '50000', perKgMinor: '0' }],
        },
        STAFF,
      )
    ).id;
    const { listFreightOptions } = await booking();
    const freight = await listFreightOptions(seller.sellerAccountId, shipmentId);
    expect(freight).toMatchObject({ originCountry: 'IN', destinationCountry: 'DE', weightGrams: 12_000 });
    expect(freight.options.find((option) => option.laneId === laneId)).toMatchObject({
      totalMinor: '50000',
      validTo: validTo.toISOString(),
    });
  });
});

describe('HS code verification (JOURNEY-049)', () => {
  it('verifies with a correction, audited and the seller told; a changed code goes back to DECLARED', async () => {
    const { decideHsCode, listHsReviews } = await import('../../src/modules/compliance/hs-verification.service.js');
    expect((await listHsReviews('DECLARED')).map((row) => row.offerId)).toContain(offerId);

    await expect(decideHsCode(offerId, { decision: 'VERIFIED', declaredCode: '99999999' }, STAFF)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const verified = await decideHsCode(offerId, { decision: 'VERIFIED', correctedCode: '63079098', declaredCode: '63079090' }, STAFF);
    expect(verified).toMatchObject({ state: 'VERIFIED', verifiedCode: '63079098' });
    expect(await prisma.auditLog.count({ where: { resourceId: offerId, action: 'listing.hs_code_verified' } })).toBe(1);
    expect(await prisma.sellerNotification.count({ where: { subjectId: offerId, kind: 'LISTING_DECISION' } })).toBe(1);

    const { saveTradeCodes } = await import('../../src/modules/documents/invoice-settings.service.js');
    const saved = await saveTradeCodes(seller, offerId, { hsnCode: '63079091', countryOfOrigin: 'IN' });
    expect(saved).toMatchObject({ hsVerification: { state: 'DECLARED', verifiedCode: null } });

    await expect(decideHsCode(offerId, { decision: 'REJECTED', declaredCode: '63079091' }, STAFF)).rejects.toMatchObject({
      statusCode: 400,
    });
    const rejected = await decideHsCode(offerId, { decision: 'REJECTED', note: 'Masks are 6307.90.98', declaredCode: '63079091' }, STAFF);
    expect(rejected).toMatchObject({ state: 'REJECTED', note: 'Masks are 6307.90.98' });
  });
});

describe('trade rules and the pre-dispatch hold (JOURNEY-049)', () => {
  it('saves and deletes rules with an audit entry each', async () => {
    const { saveTradeRule, deleteTradeRule, listTradeRules } = await import('../../src/modules/compliance/trade-rule-admin.service.js');
    await expect(
      saveTradeRule(null, { name: `${RULE_PREFIX}does nothing`, destinationCountry: 'DE', hsPrefix: '', restriction: 'NONE', responsibleParty: 'SELLER', requiresHsVerification: false, documentBuyerVisible: true, isActive: true }, STAFF),
    ).rejects.toMatchObject({ statusCode: 400 });
    const rule = await saveTradeRule(
      null,
      { name: `${RULE_PREFIX}temporary`, destinationCountry: 'DE', categoryId, hsPrefix: '6307', restriction: 'PROHIBITED', responsibleParty: 'SELLER', requiresHsVerification: false, documentBuyerVisible: true, isActive: true },
      STAFF,
    );
    expect((await listTradeRules({ destinationCountry: 'DE' })).map((row) => row.id)).toContain(rule.id);
    await deleteTradeRule(rule.id, STAFF);
    expect(await prisma.auditLog.count({ where: { resourceId: rule.id, action: { in: ['trade_rule.saved', 'trade_rule.deleted'] } } })).toBe(2);
  });

  it('lists every party, shows the buyer what they owe, and holds the goods until fixed or overridden', async () => {
    const { saveTradeRule } = await import('../../src/modules/compliance/trade-rule-admin.service.js');
    const common = { destinationCountry: 'DE', categoryId, hsPrefix: '', documentBuyerVisible: true, isActive: true };
    await saveTradeRule(null, { ...common, name: `${RULE_PREFIX}EU conformity`, restriction: 'RESTRICTED', requiredDocumentKind: 'CATEGORY:CE_DECLARATION', requiredDocumentName: 'EU declaration of conformity', responsibleParty: 'SELLER', requiresHsVerification: true }, STAFF);
    await saveTradeRule(null, { ...common, name: `${RULE_PREFIX}Import licence`, restriction: 'NONE', requiredDocumentKind: 'IMPORT_LICENCE', responsibleParty: 'BUYER', requiresHsVerification: false }, STAFF);

    const { listSellerTradeDocuments, addTradeDocumentVersion, validateTradeDocumentVersion } = await import('../../src/modules/seller/trade-documents.service.js');
    const listed = await listSellerTradeDocuments(seller.sellerAccountId, groupId);
    expect(listed.required).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'CATEGORY:CE_DECLARATION', responsibleParty: 'SELLER', restriction: 'RESTRICTED', status: 'MISSING' }),
        expect.objectContaining({ kind: 'IMPORT_LICENCE', responsibleParty: 'BUYER', status: 'MISSING' }),
      ]),
    );
    expect(listed.compliance.open).toBe(false);
    expect(listed.compliance.holds.map((hold) => hold.code).sort()).toEqual(['DOCUMENT_MISSING', 'HS_REJECTED']);

    const { buyerComplianceActions, evaluateSellerOrderCompliance, grantComplianceOverride, revokeComplianceOverride } = await compliance();
    expect(await buyerComplianceActions({ customerProfileId: buyerProfileId, buyerCompanyId: null }, orderId)).toEqual([
      expect.objectContaining({ ruleName: `${RULE_PREFIX}Import licence`, documentName: 'IMPORT_LICENCE' }),
    ]);

    const { assertComplianceOpen } = await import('../../src/domain/compliance-hold.js');
    const held = await evaluateSellerOrderCompliance(prisma, groupId);
    expect(() => {
      assertComplianceOpen(held, { from: 'PROCESSING', to: 'READY_FOR_DISPATCH' });
    }).toThrow(expect.objectContaining({ statusCode: 409, code: 'DESTINATION_DOCUMENTS_NOT_READY' }));

    const { readShipmentBooking } = await booking();
    expect((await readShipmentBooking(seller.sellerAccountId, shipmentId)).dispatchReadiness.compliance).toMatchObject({ open: false, holds: 2 });

    // Staff override in writing, audited; it covers what holds the goods now.
    await expect(grantComplianceOverride({ sellerOrderGroupId: groupId, reason: 'short', actor: STAFF })).rejects.toMatchObject({ statusCode: 400 });
    const overridden = await grantComplianceOverride({ sellerOrderGroupId: groupId, reason: 'Customs broker confirmed the classification in writing.', actor: STAFF });
    expect(overridden.verdict).toMatchObject({ open: true, overridden: true });
    expect(await prisma.auditLog.count({ where: { resourceId: groupId, action: 'compliance.hold_overridden' } })).toBe(1);

    const revoked = await revokeComplianceOverride({ sellerOrderGroupId: groupId, actor: STAFF });
    expect(revoked.verdict.open).toBe(false);

    // Fixing the causes opens it without an override.
    const { decideHsCode } = await import('../../src/modules/compliance/hs-verification.service.js');
    await decideHsCode(offerId, { decision: 'VERIFIED', declaredCode: '63079091' }, STAFF);
    const document = await addTradeDocumentVersion({
      actor: { sellerAccountId: seller.sellerAccountId, label: 'JDC dispatch' },
      orderGroupId: groupId,
      shipmentId: null,
      kind: 'CATEGORY:CE_DECLARATION',
      title: 'EU declaration of conformity',
      issuerName: 'JDC Exports Private Limited',
      referenceNumber: 'CE-2026-01',
    });
    expect((await evaluateSellerOrderCompliance(prisma, groupId)).holds.map((hold) => hold.code)).toEqual(['DOCUMENT_NOT_VALID']);
    await validateTradeDocumentVersion({
      versionId: document.current?.id ?? '',
      decision: 'VALID',
      note: null,
      staffUserId: STAFF.userId,
      staffLabel: STAFF.email,
    });
    expect((await evaluateSellerOrderCompliance(prisma, groupId)).open).toBe(true);
  });
});
