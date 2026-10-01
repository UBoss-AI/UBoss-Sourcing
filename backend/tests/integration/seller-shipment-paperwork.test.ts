/**
 * Master rows 42 and 56, against a real MariaDB.
 *
 * Shipment documents: a seller records the certificate of origin (generated
 * as a draft PDF, or uploaded), the bill of lading or air waybill by its
 * number, and category documents a trade rule requires - each with versions,
 * issuer, expiry and a validation state - and the buyer sees the ones a buyer
 * may see, on their own order only.
 *
 * Shipment booking: a seller states mode, Incoterm, ports and pickup for a
 * consignment and may name an outside carrier, which becomes a hand booking
 * with no tracking number invented; the buyer sees the same booking.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';

let prisma: PrismaClient;
let newId: () => string;
let seller: SellerMembership;
let rival: SellerMembership;

const PREFIX = 'sspw-';
const EMAILS = ['sspw-buyer@test.local', 'sspw-other@test.local', 'sspw-seller@test.local', 'sspw-rival@test.local'];
const RULE_NAME = 'SSPW glove import permit';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

let buyerProfileId = '';
let otherBuyerProfileId = '';
let orderId = '';
let groupId = '';
let domesticShipmentId = '';
let exportShipmentId = '';
let categoryId = '';

async function cleanUp(): Promise<void> {
  const sellers = (
    await prisma.sellerAccount.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } })
  ).map((row) => row.id);
  const profiles = (
    await prisma.customerProfile.findMany({
      where: { user: { emailNormalized: { in: EMAILS } } },
      select: { id: true },
    })
  ).map((row) => row.id);
  const orders = (
    await prisma.order.findMany({ where: { customerProfileId: { in: profiles } }, select: { id: true } })
  ).map((row) => row.id);

  await prisma.tradeComplianceRule.deleteMany({ where: { name: RULE_NAME } });
  await prisma.orderTradeDocument.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  const shipments = (
    await prisma.logisticsShipment.findMany({ where: { sellerAccountId: { in: sellers } }, select: { id: true } })
  ).map((row) => row.id);
  await prisma.sellerManualCarrierBooking.deleteMany({ where: { shipmentId: { in: shipments } } });
  await prisma.consignmentBookingTerms.deleteMany({ where: { shipmentId: { in: shipments } } });
  await prisma.logisticsShipmentEvent.deleteMany({ where: { shipmentId: { in: shipments } } });
  await prisma.logisticsShipment.deleteMany({ where: { id: { in: shipments } } });
  await prisma.adminNotification.deleteMany({ where: { relatedId: { in: shipments } } });
  await prisma.notificationOutbox.deleteMany({ where: { relatedId: { in: [...shipments, ...orders] } } });
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
  await prisma.category.deleteMany({ where: { slug: `${PREFIX}category` } });
  await prisma.customerProfile.deleteMany({ where: { id: { in: profiles } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: { in: EMAILS } } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { in: EMAILS } } });
}

async function makeProfile(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: { id: newId(), type: 'CUSTOMER', email, emailNormalized: email, status: 'ACTIVE', emailVerifiedAt: new Date() },
  });
  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId: user.id, fullName: `Person ${email}`, organization: 'Org', activatedAt: new Date() },
  });
  return profile.id;
}

async function makeSeller(slug: string, ownerProfileId: string): Promise<string> {
  const id = newId();
  await prisma.sellerAccount.create({
    data: {
      id,
      legalName: `${slug} Exports Private Limited`,
      displayName: `${slug} Exports`,
      displayNameNormalized: `${slug} exports`,
      slug: `${PREFIX}${slug}`,
      kind: 'MANUFACTURER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });
  await prisma.sellerMember.create({
    data: { id: newId(), sellerAccountId: id, customerProfileId: ownerProfileId, role: 'OWNER' },
  });
  return id;
}

const actor = () => ({ sellerAccountId: seller.sellerAccountId, label: 'Omega dispatch' });
const logisticsActor = () => ({ sellerAccountId: seller.sellerAccountId, memberId: seller.memberId, label: 'Omega dispatch' });
const buyerScope = () => ({ customerProfileId: buyerProfileId, buyerCompanyId: null });

async function trade() {
  return import('../../src/modules/seller/trade-documents.service.js');
}
async function booking() {
  return import('../../src/modules/seller/shipment-booking.service.js');
}

beforeAll(async () => {
  ({ prisma } = (await import('../../src/infra/prisma.js')) as unknown as { prisma: PrismaClient });
  ({ newId } = await import('../../src/infra/ids.js'));
  const { resolveSellerMembership } = await import('../../src/modules/seller/account.service.js');
  await cleanUp();

  buyerProfileId = await makeProfile(EMAILS[0] ?? '');
  otherBuyerProfileId = await makeProfile(EMAILS[1] ?? '');
  const sellerPerson = await makeProfile(EMAILS[2] ?? '');
  const rivalPerson = await makeProfile(EMAILS[3] ?? '');
  const sellerAccountId = await makeSeller('omega', sellerPerson);
  await makeSeller('sigma', rivalPerson);
  seller = await resolveSellerMembership(sellerPerson);
  rival = await resolveSellerMembership(rivalPerson);

  const taxClass = await prisma.taxClass.findFirstOrThrow({ select: { id: true } });
  categoryId = (
    await prisma.category.create({ data: { id: newId(), name: 'SSPW', slug: `${PREFIX}category`, isActive: true } })
  ).id;
  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId,
      taxClassId: taxClass.id,
      name: 'Nitrile examination gloves',
      slug: `${PREFIX}gloves`,
      sku: 'SSPW-GLOVE',
      basePriceMinor: 0n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      isMarketplaceProduct: true,
    },
  });
  const offerId = newId();
  await prisma.sellerOffer.create({
    data: {
      id: offerId,
      sellerAccountId,
      productId: product.id,
      variantKey: '',
      sellerSku: 'OMEGA-NG-M',
      status: 'ACTIVE',
      priceMinor: 1000n,
      currency: 'INR',
      hsnCode: '40151900',
      countryOfOrigin: 'IN',
    },
  });
  const locationId = newId();
  await prisma.sellerLocation.create({
    data: {
      id: locationId,
      sellerAccountId,
      code: 'PUNE',
      name: 'Pune plant',
      addressLine1: '12 MIDC',
      city: 'Pune',
      region: 'Maharashtra',
      postcode: '411019',
      countryCode: 'IN',
      timezone: 'Asia/Kolkata',
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
      orderNumber: `SSPW-${orderId.slice(-8)}`,
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
      nameSnapshot: 'Nitrile examination gloves',
      skuSnapshot: 'SSPW-GLOVE',
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
      status: 'ACCEPTED',
      locationId,
      goodsTotalMinor: 100_000n,
      taxTotalMinor: 0n,
      shippingTotalMinor: 0n,
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
  const pickupAddress = { line1: '12 MIDC', city: 'Pune', region: 'Maharashtra', postalCode: '411019', countryCode: 'IN' };
  const common = {
    orderId,
    sellerOrderGroupId: groupId,
    sellerAccountId,
    sellerCompanyName: 'omega Exports',
    receivingCustomerProfileId: buyerProfileId,
    receivingCompanyName: 'Hamburg Klinik',
    pickupAddress,
    currency: 'INR',
  };
  exportShipmentId = (
    await createShipment({
      ...common,
      deliveryAddress: { line1: '1 Hafenstrasse', city: 'Hamburg', region: 'HH', postalCode: '20457', countryCode: 'DE' },
    })
  ).id;
  domesticShipmentId = (
    await createShipment({
      ...common,
      deliveryAddress: { line1: '4 Hospital Road', city: 'Pune', region: 'Maharashtra', postalCode: '411001', countryCode: 'IN' },
    })
  ).id;
});

afterAll(async () => {
  await cleanUp();
});

describe('shipment documents (Master row 42)', () => {
  it('generates a certificate of origin draft as a PDF version awaiting review', async () => {
    const { generateCertificateOfOriginDraft, sellerTradeDocumentFile } = await trade();
    const document = await generateCertificateOfOriginDraft({
      actor: actor(),
      orderGroupId: groupId,
      shipmentId: exportShipmentId,
    });
    expect(document.kind).toBe('CERTIFICATE_OF_ORIGIN');
    expect(document.shipmentId).toBe(exportShipmentId);
    expect(document.current).toMatchObject({ version: 1, source: 'GENERATED', validation: 'PENDING_REVIEW', hasFile: true });
    expect(document.current?.issuerName).toBe('omega Exports Private Limited');

    const file = await sellerTradeDocumentFile(seller.sellerAccountId, document.current?.id ?? '');
    expect(file.contentType).toBe('application/pdf');
    expect(file.bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('keeps the old version when the certified copy is uploaded as version 2', async () => {
    const { addTradeDocumentVersion } = await trade();
    const document = await addTradeDocumentVersion({
      actor: actor(),
      orderGroupId: groupId,
      shipmentId: exportShipmentId,
      kind: 'CERTIFICATE_OF_ORIGIN',
      referenceNumber: 'COO-2026-778',
      issuerName: 'Federation of Indian Export Organisations',
      issuedOn: new Date('2026-10-01T00:00:00Z'),
      expiresOn: new Date('2027-10-01T00:00:00Z'),
      file: { fileName: 'coo.pdf', bytes: PDF },
    });
    expect(document.currentVersion).toBe(2);
    expect(document.current).toMatchObject({
      source: 'UPLOADED',
      issuerName: 'Federation of Indian Export Organisations',
      expiresOn: '2027-10-01',
      superseded: false,
    });
    expect(document.versions.find((v) => v.version === 1)?.superseded).toBe(true);
  });

  it('refuses a bill of lading with no number, an expiry before issue, and a file that is not a PDF or image', async () => {
    const { addTradeDocumentVersion } = await trade();
    const base = { actor: actor(), orderGroupId: groupId, shipmentId: exportShipmentId, issuerName: 'Maersk' };

    await expect(addTradeDocumentVersion({ ...base, kind: 'BILL_OF_LADING', file: { fileName: 'bl.pdf', bytes: PDF } }))
      .rejects.toMatchObject({ code: 'TRADE_DOCUMENT_INVALID' });
    await expect(
      addTradeDocumentVersion({
        ...base,
        kind: 'INSPECTION_CERTIFICATE',
        referenceNumber: 'X1',
        issuedOn: new Date('2026-10-02T00:00:00Z'),
        expiresOn: new Date('2026-10-01T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'TRADE_DOCUMENT_INVALID' });
    await expect(
      addTradeDocumentVersion({ ...base, kind: 'OTHER', file: { fileName: 'x.exe', bytes: Buffer.from('MZ-not-a-document') } }),
    ).rejects.toMatchObject({ code: 'MEDIA_TYPE_NOT_ALLOWED' });
    await expect(addTradeDocumentVersion({ ...base, kind: 'NONSENSE', referenceNumber: 'N1' })).rejects.toMatchObject({
      code: 'TRADE_DOCUMENT_INVALID',
    });

    const bl = await addTradeDocumentVersion({ ...base, kind: 'BILL_OF_LADING', referenceNumber: 'MAEU123456789' });
    expect(bl.current).toMatchObject({ source: 'REFERENCE', referenceNumber: 'MAEU123456789', hasFile: false });

    const sb = await addTradeDocumentVersion({ ...base, kind: 'SHIPPING_BILL', issuerName: 'Indian Customs', referenceNumber: 'SB-445566' });
    expect(sb.buyerVisible).toBe(false);
  });

  it('lists what a category rule requires, and marks it satisfied once recorded', async () => {
    const { addTradeDocumentVersion, listSellerTradeDocuments } = await trade();
    await prisma.tradeComplianceRule.create({
      data: {
        id: newId(),
        name: RULE_NAME,
        destinationCountry: 'DE',
        categoryId,
        hsPrefix: '4015',
        requiredDocumentKind: 'CATEGORY:CE_DECLARATION',
        requiredDocumentName: 'EU declaration of conformity',
        responsibleParty: 'SELLER',
      },
    });

    let listed = await listSellerTradeDocuments(seller.sellerAccountId, groupId);
    expect(listed.required).toEqual([
      expect.objectContaining({ kind: 'CATEGORY:CE_DECLARATION', name: 'EU declaration of conformity', satisfied: false }),
    ]);
    expect(listed.consignments.map((c) => c.id).sort()).toEqual([domesticShipmentId, exportShipmentId].sort());
    expect(listed.issued).toEqual({ commercialInvoices: 0, packingLists: 0 });

    await addTradeDocumentVersion({
      actor: actor(),
      orderGroupId: groupId,
      shipmentId: null,
      kind: 'CATEGORY:CE_DECLARATION',
      title: 'EU declaration of conformity',
      issuerName: 'omega Exports Private Limited',
      file: { fileName: 'doc.pdf', bytes: PDF },
    });
    listed = await listSellerTradeDocuments(seller.sellerAccountId, groupId);
    expect(listed.required[0]?.satisfied).toBe(true);
  });

  it('is invisible to another seller', async () => {
    const { addTradeDocumentVersion, listSellerTradeDocuments, generateCertificateOfOriginDraft } = await trade();
    const other = { sellerAccountId: rival.sellerAccountId, label: 'Rival' };
    await expect(listSellerTradeDocuments(rival.sellerAccountId, groupId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      addTradeDocumentVersion({ actor: other, orderGroupId: groupId, shipmentId: null, kind: 'OTHER', issuerName: 'x', referenceNumber: 'y' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      generateCertificateOfOriginDraft({ actor: other, orderGroupId: groupId, shipmentId: null }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('shows the buyer only buyer-visible current versions, never a rejected one, and only on their own order', async () => {
    const { listBuyerTradeDocuments, buyerTradeDocumentFile, validateTradeDocumentVersion, listSellerTradeDocuments } =
      await trade();

    let documents = await listBuyerTradeDocuments(buyerScope(), orderId);
    const kinds = documents.map((d) => d.kind).sort();
    expect(kinds).toEqual(['BILL_OF_LADING', 'CATEGORY:CE_DECLARATION', 'CERTIFICATE_OF_ORIGIN']);
    const coo = documents.find((d) => d.kind === 'CERTIFICATE_OF_ORIGIN');
    expect(coo).toMatchObject({ version: 2, issuerName: 'Federation of Indian Export Organisations', hasFile: true });
    expect((await buyerTradeDocumentFile(buyerScope(), orderId, coo?.versionId ?? '')).bytes.equals(PDF)).toBe(true);

    // The shipping bill is the exporter's customs paper, not the buyer's.
    const all = await listSellerTradeDocuments(seller.sellerAccountId, groupId);
    const shippingBill = all.documents.find((d) => d.kind === 'SHIPPING_BILL');
    await expect(
      buyerTradeDocumentFile(buyerScope(), orderId, shippingBill?.current?.id ?? ''),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      listBuyerTradeDocuments({ customerProfileId: otherBuyerProfileId, buyerCompanyId: null }, orderId),
    ).rejects.toMatchObject({ statusCode: 404 });

    // Staff review: a rejection needs a reason, and hides the version from the buyer.
    await expect(
      validateTradeDocumentVersion({ versionId: coo?.versionId ?? '', decision: 'REJECTED', note: '', staffUserId: newId(), staffLabel: 'r' }),
    ).rejects.toMatchObject({ code: 'TRADE_DOCUMENT_INVALID' });
    const rejected = await validateTradeDocumentVersion({
      versionId: coo?.versionId ?? '',
      decision: 'REJECTED',
      note: 'Stamp illegible',
      staffUserId: newId(),
      staffLabel: 'reviewer@test.local',
    });
    expect(rejected).toMatchObject({ validation: 'REJECTED', validationNote: 'Stamp illegible' });
    documents = await listBuyerTradeDocuments(buyerScope(), orderId);
    expect(documents.some((d) => d.kind === 'CERTIFICATE_OF_ORIGIN')).toBe(false);

    const bl = documents.find((d) => d.kind === 'BILL_OF_LADING');
    const valid = await validateTradeDocumentVersion({
      versionId: bl?.versionId ?? '',
      decision: 'VALID',
      note: null,
      staffUserId: newId(),
      staffLabel: 'reviewer@test.local',
    });
    expect(valid.validation).toBe('VALID');

    // A superseded version cannot be reviewed.
    const cooDoc = all.documents.find((d) => d.kind === 'CERTIFICATE_OF_ORIGIN');
    const v1 = cooDoc?.versions.find((v) => v.version === 1);
    await expect(
      validateTradeDocumentVersion({ versionId: v1?.id ?? '', decision: 'VALID', note: null, staffUserId: newId(), staffLabel: 'r' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('reads an expired certificate as EXPIRED without storing it', async () => {
    const { validationStateOf } = await trade();
    expect(validationStateOf('VALID', new Date('2026-01-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'))).toBe('EXPIRED');
    expect(validationStateOf('REJECTED', new Date('2026-01-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'))).toBe('REJECTED');
    expect(validationStateOf('PENDING_REVIEW', null)).toBe('PENDING_REVIEW');
  });
});

describe('shipment booking (Master row 56)', () => {
  const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  it('refuses an unknown Incoterm, a port that is not a UN/LOCODE, and a window that ends before it starts', async () => {
    const { saveShipmentBooking } = await booking();
    const save = (b: Record<string, unknown>) =>
      saveShipmentBooking({
        actor: logisticsActor(),
        shipmentId: domesticShipmentId,
        booking: { mode: 'ROAD', incoterm: 'DAP', ...b },
      });
    await expect(save({ incoterm: 'XYZ' })).rejects.toMatchObject({ code: 'BOOKING_TERMS_INVALID' });
    await expect(save({ originPort: 'PUNE' })).rejects.toMatchObject({ code: 'BOOKING_TERMS_INVALID' });
    await expect(
      save({ pickupDate: tomorrow(), pickupWindowFrom: '14:00', pickupWindowTo: '09:00' }),
    ).rejects.toMatchObject({ code: 'BOOKING_TERMS_INVALID' });
    await expect(save({ mode: 'TELEPORT' })).rejects.toMatchObject({ code: 'BOOKING_TERMS_INVALID' });
  });

  it('requires both ports for a cross-border sea consignment', async () => {
    const { saveShipmentBooking } = await booking();
    await expect(
      saveShipmentBooking({
        actor: logisticsActor(),
        shipmentId: exportShipmentId,
        booking: { mode: 'SEA', incoterm: 'FOB', originPort: 'INNSA' },
      }),
    ).rejects.toMatchObject({ code: 'BOOKING_TERMS_INVALID' });
  });

  it('stores mode, Incoterm, ports and pickup, and the buyer sees them', async () => {
    const { saveShipmentBooking, listBuyerShipmentDetails } = await booking();
    const saved = await saveShipmentBooking({
      actor: logisticsActor(),
      shipmentId: exportShipmentId,
      booking: {
        mode: 'sea',
        incoterm: 'fob',
        incotermPlace: 'Nhava Sheva',
        originPort: 'innsa',
        destinationPort: 'DEHAM',
        routeNote: 'Via Colombo',
        pickupDate: tomorrow(),
        pickupWindowFrom: '09:00',
        pickupWindowTo: '13:00',
      },
    });
    expect(saved.crossBorder).toBe(true);
    expect(saved.canEdit).toBe(true);
    expect(saved.terms).toMatchObject({
      mode: 'SEA',
      incoterm: 'FOB',
      incotermPlace: 'Nhava Sheva',
      originPort: 'INNSA',
      destinationPort: 'DEHAM',
      pickupDate: tomorrow(),
      pickupWindowFrom: '09:00',
      pickupWindowTo: '13:00',
    });
    expect(saved.carrier.kind).toBe('NONE');

    const details = await listBuyerShipmentDetails(buyerScope(), orderId);
    const shipment = details.find((d) => d.shipmentId === exportShipmentId);
    expect(shipment?.terms).toMatchObject({ mode: 'SEA', incoterm: 'FOB', originPort: 'INNSA', destinationPort: 'DEHAM' });
    expect(shipment?.terms).not.toHaveProperty('updatedByLabel');
    expect(details.find((d) => d.shipmentId === domesticShipmentId)?.terms).toBeNull();

    await expect(
      listBuyerShipmentDetails({ customerProfileId: otherBuyerProfileId, buyerCompanyId: null }, orderId),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('books an outside carrier by hand, inventing no tracking number', async () => {
    const { saveShipmentBooking, listBuyerShipmentDetails } = await booking();
    const saved = await saveShipmentBooking({
      actor: logisticsActor(),
      shipmentId: domesticShipmentId,
      booking: { mode: 'COURIER', incoterm: 'DAP', pickupDate: tomorrow(), manualCarrier: 'DHL' },
    });
    expect(saved.carrier).toEqual({ kind: 'MANUAL_CARRIER', name: 'DHL', trackingNumber: null });

    const row = await prisma.sellerManualCarrierBooking.findUnique({ where: { activeShipmentId: domesticShipmentId } });
    expect(row).toMatchObject({ provider: 'DHL', status: 'BOOKING_REQUIRED', carrierTrackingNumber: null });

    const details = await listBuyerShipmentDetails(buyerScope(), orderId);
    expect(details.find((d) => d.shipmentId === domesticShipmentId)?.carrier.name).toBe('DHL');
  });

  it('is invisible to another seller', async () => {
    const { saveShipmentBooking, readShipmentBooking } = await booking();
    await expect(readShipmentBooking(rival.sellerAccountId, exportShipmentId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      saveShipmentBooking({
        actor: { sellerAccountId: rival.sellerAccountId, memberId: rival.memberId, label: 'Rival' },
        shipmentId: exportShipmentId,
        booking: { mode: 'ROAD', incoterm: 'EXW' },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
