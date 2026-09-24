/**
 * Seller invoices and packing lists, end to end, against real PDFs, real
 * storage and real number sequences.
 *
 * THE FIXTURE
 *
 * A Maharashtra seller (GSTIN 27AAPFU0939F1ZV) sells 100 gloves at ₹10.00
 * with 18% GST (exclusive) to a buyer in Pune - an INTRA-state supply, so the
 * ₹180.00 tax is shown as ₹90.00 CGST + ₹90.00 SGST. Freight on the seller
 * order is ₹50.00. The order is paid and the seller has accepted it.
 */
import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { prisma as PrismaClient } from '../../src/infra/prisma.js';
import type { newId as NewId } from '../../src/infra/ids.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';

let prisma: typeof PrismaClient;
let newId: typeof NewId;
let seller: SellerMembership;
let rival: SellerMembership;

const PREFIX = 'sdoc-';
const EMAILS = [
  'sdoc-buyer@test.local',
  'sdoc-other@test.local',
  'sdoc-seller@test.local',
  'sdoc-rival@test.local',
];

let sellerAccountId = '';
let buyerProfileId = '';
let otherBuyerProfileId = '';
let orderId = '';
let orderItemId = '';
let groupId = '';
let shipmentId = '';
let offerId = '';
let partnerId = '';
let buyerUserId = '';

async function cleanUp(): Promise<void> {
  const sellers = (
    await prisma.sellerAccount.findMany({
      where: { slug: { startsWith: PREFIX } },
      select: { id: true },
    })
  ).map((row) => row.id);
  const profiles = (
    await prisma.customerProfile.findMany({
      where: { user: { emailNormalized: { in: EMAILS } } },
      select: { id: true },
    })
  ).map((row) => row.id);
  const orders = (
    await prisma.order.findMany({
      where: { customerProfileId: { in: profiles } },
      select: { id: true },
    })
  ).map((row) => row.id);

  await prisma.sellerInvoice.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerPackingList.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.logisticsShipmentAssignment.deleteMany({
    where: { partner: { partnerCode: { startsWith: 'SDOC' } } },
  });
  await prisma.logisticsShipment.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.logisticsPartner.deleteMany({ where: { partnerCode: { startsWith: 'SDOC' } } });
  await prisma.sellerOrderLine.deleteMany({
    where: { orderGroup: { sellerAccountId: { in: sellers } } },
  });
  await prisma.sellerOrderGroup.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.order.deleteMany({ where: { id: { in: orders } } });
  await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerInvoiceSettings.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerBusinessProfile.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerLocation.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerMember.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellers } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.category.deleteMany({ where: { slug: 'sdoc-category' } });
  await prisma.address.deleteMany({ where: { customerProfileId: { in: profiles } } });
  await prisma.customerProfile.deleteMany({ where: { id: { in: profiles } } });
  await prisma.authToken.deleteMany({ where: { user: { emailNormalized: { in: EMAILS } } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: { in: EMAILS } } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { in: EMAILS } } });
  await prisma.numberSequence.deleteMany({
    where: { key: { in: sellers.map((id) => `seller-invoice:${id}:INV:26-27`) } },
  });
}

async function makeProfile(
  email: string,
  organization: string,
): Promise<{ profileId: string; userId: string }> {
  const user = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email,
      emailNormalized: email,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  const profile = await prisma.customerProfile.create({
    data: {
      id: newId(),
      userId: user.id,
      fullName: `Person ${email}`,
      organization,
      activatedAt: new Date(),
    },
  });
  return { profileId: profile.id, userId: user.id };
}

async function makeSeller(slug: string, ownerProfileId: string, gstin: string): Promise<string> {
  const id = newId();
  await prisma.sellerAccount.create({
    data: {
      id,
      legalName: `${slug} Healthcare Private Limited`,
      displayName: `${slug} Healthcare`,
      displayNameNormalized: `${slug} healthcare`,
      slug: `${PREFIX}${slug}`,
      kind: 'MANUFACTURER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });
  await prisma.sellerMember.create({
    data: { id: newId(), sellerAccountId: id, customerProfileId: ownerProfileId, role: 'OWNER' },
  });
  await prisma.sellerBusinessProfile.create({
    data: {
      id: newId(),
      sellerAccountId: id,
      taxRegistrationNumber: gstin,
      registeredAddressLine1: '12 MIDC Industrial Area',
      registeredCity: 'Pune',
      registeredRegion: 'Maharashtra',
      registeredPostcode: '411019',
      registeredCountry: 'IN',
      timezone: 'Asia/Kolkata',
    },
  });
  await prisma.sellerInvoiceSettings.create({
    data: {
      id: newId(),
      sellerAccountId: id,
      jurisdiction: 'IN_GST',
      invoiceSeries: 'INV',
      signatoryName: 'A. Director',
      signatoryDesignation: 'Director',
    },
  });
  return id;
}

async function services() {
  return {
    consignment: await import('../../src/modules/documents/consignment.service.js'),
    invoice: await import('../../src/modules/documents/seller-invoice.service.js'),
    packing: await import('../../src/modules/documents/packing-list.service.js'),
    documents: await import('../../src/modules/documents/documents.service.js'),
  };
}

async function packEverything(shipment = shipmentId, quantity = 100): Promise<void> {
  const { consignment } = await services();
  await consignment.savePackages(seller, shipment, {
    packages: [
      {
        packagingType: 'Carton',
        lengthMm: 400,
        widthMm: 300,
        heightMm: 250,
        grossWeightGrams: 6000,
        netWeightGrams: 5200,
        containerNumber: null,
        sealNumber: null,
        contents: [
          {
            orderItemId,
            quantity,
            batchNumber: 'LOT-26A',
            expiryDate: '2028-09-30',
            serialNumbers: null,
          },
        ],
      },
    ],
  });
}

beforeAll(async () => {
  ({ prisma } = await import('../../src/infra/prisma.js'));
  ({ newId } = await import('../../src/infra/ids.js'));
  const { resolveSellerMembership } = await import('../../src/modules/seller/account.service.js');
  await cleanUp();

  const buyer = await makeProfile(EMAILS[0] ?? '', 'Acme Hospitals Pvt Ltd');
  buyerProfileId = buyer.profileId;
  buyerUserId = buyer.userId;
  otherBuyerProfileId = (await makeProfile(EMAILS[1] ?? '', 'Other Clinic')).profileId;
  const sellerPerson = await makeProfile(EMAILS[2] ?? '', 'Seller staff');
  const rivalPerson = await makeProfile(EMAILS[3] ?? '', 'Rival staff');

  sellerAccountId = await makeSeller('omega', sellerPerson.profileId, '27AAPFU0939F1ZV');
  await makeSeller('sigma', rivalPerson.profileId, '29AAACB2894G1ZJ');
  seller = await resolveSellerMembership(sellerPerson.profileId);
  rival = await resolveSellerMembership(rivalPerson.profileId);

  const taxClass =
    (await prisma.taxClass.findFirst({ select: { id: true } })) ??
    (await prisma.taxClass.create({
      data: {
        id: newId(),
        code: 'SDOC18',
        name: 'GST 18%',
        ratePercent: '18.000000',
        isActive: true,
      },
      select: { id: true },
    }));
  const category = await prisma.category.create({
    data: { id: newId(), name: 'Docs', slug: 'sdoc-category', isActive: true },
  });
  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Nitrile examination gloves',
      slug: `${PREFIX}gloves`,
      sku: 'SDOC-GLOVE',
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
    contactName: 'Receiving dock',
    contactPhone: '+919800000000',
    line1: '4 Hospital Road',
    line2: null,
    city: 'Pune',
    state: 'Maharashtra',
    postalCode: '411001',
    country: 'IN',
  };

  orderId = newId();
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `SDOC-${orderId.slice(-8)}`,
      customerProfileId: buyerProfileId,
      status: 'CONFIRMED',
      currency: 'INR',
      subtotalMinor: 100_000n,
      taxMinor: 18_000n,
      shippingMinor: 5_000n,
      grandTotalMinor: 123_000n,
      billingAddressJson: address,
      shippingAddressJson: address,
      placedAt: new Date(),
    },
  });

  orderItemId = newId();
  await prisma.orderItem.create({
    data: {
      id: orderItemId,
      orderId,
      productId: product.id,
      sellerOfferId: offerId,
      nameSnapshot: 'Nitrile examination gloves',
      skuSnapshot: 'SDOC-GLOVE',
      taxClassCodeSnapshot: 'GST18',
      unitPriceMinor: 1000n,
      quantity: 100,
      lineSubtotalMinor: 100_000n,
      taxRatePercent: '18.000000',
      taxInclusive: false,
      taxAmountMinor: 18_000n,
      discountMinor: 0n,
      lineTotalMinor: 118_000n,
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
      taxTotalMinor: 18_000n,
      shippingTotalMinor: 5_000n,
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
  const created = await createShipment({
    orderId,
    sellerOrderGroupId: groupId,
    sellerAccountId,
    sellerCompanyName: 'omega Healthcare',
    receivingCustomerProfileId: buyerProfileId,
    receivingCompanyName: 'Acme Hospitals Pvt Ltd',
    pickupAddress: {
      line1: '12 MIDC',
      city: 'Pune',
      region: 'Maharashtra',
      postalCode: '411019',
      countryCode: 'IN',
    },
    deliveryAddress: {
      line1: '4 Hospital Road',
      city: 'Pune',
      region: 'Maharashtra',
      postalCode: '411001',
      countryCode: 'IN',
    },
    currency: 'INR',
  });
  shipmentId = created.id;

  partnerId = newId();
  await prisma.logisticsPartner.create({
    data: {
      id: partnerId,
      partnerCode: `SDOC${partnerId.slice(-6)}`,
      legalName: 'SDOC Carriers Ltd',
      displayName: 'SDOC Carriers',
      displayNameNormalized: `sdoc carriers ${partnerId.slice(-6).toLowerCase()}`,
      registrationCountry: 'IN',
      contactEmail: 'ops@sdoc.test',
    },
  });
  await prisma.logisticsShipmentAssignment.create({
    data: { id: newId(), shipmentId, logisticsPartnerId: partnerId, state: 'ACCEPTED' },
  });
});

afterAll(async () => {
  const { invoice, packing } = await services();
  invoice.renderers.invoice = (
    await import('../../src/modules/documents/invoice-pdf.js')
  ).renderInvoice;
  packing.packingRenderers.packingList = (
    await import('../../src/modules/documents/packing-list-pdf.js')
  ).renderPackingList;
  await cleanUp();
});

describe('the invoice draft', () => {
  it('is prepared for the seller’s own eligible consignment, with the GST split', async () => {
    const { invoice } = await services();
    const draft = (await invoice.prepareInvoice(seller, shipmentId)) as {
      status: string;
      supplyType: string;
      totals: Record<string, { minor: string }>;
      validation: unknown[];
    };
    expect(draft.validation).toEqual([]);
    expect(draft.status).toBe('READY_TO_ISSUE');
    expect(draft.supplyType).toBe('INTRA_STATE');
    expect(draft.totals['taxable']?.minor).toBe('100000');
    expect(draft.totals['cgst']?.minor).toBe('9000');
    expect(draft.totals['sgst']?.minor).toBe('9000');
    expect(draft.totals['igst']?.minor).toBe('0');
    expect(draft.totals['freight']?.minor).toBe('5000');
    expect(draft.totals['grandTotal']?.minor).toBe('123000');
  });

  it('is invisible to another seller, who cannot prepare, issue or pack it', async () => {
    const { invoice, documents } = await services();
    await expect(invoice.prepareInvoice(rival, shipmentId)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(invoice.issueInvoice(rival, shipmentId, null)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(documents.packConsignment(rival, shipmentId, null)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('refuses to issue, naming the field, when a required tax field is missing', async () => {
    const { invoice } = await services();
    await prisma.sellerOffer.update({ where: { id: offerId }, data: { hsnCode: null } });
    try {
      const draft = (await invoice.prepareInvoice(seller, shipmentId)) as {
        status: string;
        validation: { field: string }[];
      };
      expect(draft.status).toBe('VALIDATION_REQUIRED');
      expect(draft.validation.map((entry) => entry.field)).toContain('lines.0.hsn');
      await expect(invoice.issueInvoice(seller, shipmentId, null)).rejects.toMatchObject({
        code: 'SELLER_DOCUMENT_VALIDATION_FAILED',
      });
      expect(
        await prisma.sellerInvoice.count({
          where: { logisticsShipmentId: shipmentId, status: 'ISSUED' },
        }),
      ).toBe(0);
    } finally {
      await prisma.sellerOffer.update({ where: { id: offerId }, data: { hsnCode: '40151900' } });
    }
  });

  it('refuses an invalid GSTIN by its checksum', async () => {
    const { invoice } = await services();
    await prisma.sellerBusinessProfile.update({
      where: { sellerAccountId },
      data: { taxRegistrationNumber: '27AAPFU0939F1ZA' },
    });
    try {
      const draft = (await invoice.prepareInvoice(seller, shipmentId)) as {
        validation: { field: string }[];
      };
      expect(draft.validation.map((entry) => entry.field)).toContain('seller.gstin');
    } finally {
      await prisma.sellerBusinessProfile.update({
        where: { sellerAccountId },
        data: { taxRegistrationNumber: '27AAPFU0939F1ZV' },
      });
    }
  });
});

describe('packing', () => {
  it('refuses packages that do not add up to what the consignment carries', async () => {
    const { consignment, packing } = await services();
    await consignment.savePackages(seller, shipmentId, {
      packages: [
        {
          packagingType: 'Carton',
          lengthMm: 400,
          widthMm: 300,
          heightMm: 250,
          grossWeightGrams: 6000,
          netWeightGrams: null,
          containerNumber: null,
          sealNumber: null,
          contents: [
            { orderItemId, quantity: 60, batchNumber: '', expiryDate: null, serialNumbers: null },
          ],
        },
      ],
    });
    const draft = (await packing.preparePackingList(seller, shipmentId)) as {
      status: string;
      validation: { code: string }[];
    };
    expect(draft.status).toBe('VALIDATION_REQUIRED');
    expect(draft.validation.map((entry) => entry.code)).toContain('MISMATCH');
  });

  it('marks nothing packed and issues no number when the PDF cannot be rendered', async () => {
    const { invoice, documents } = await services();
    await packEverything();

    const key = `seller-invoice:${sellerAccountId}:INV:26-27`;
    const before = (await prisma.numberSequence.findUnique({ where: { key } }))?.value ?? 0n;
    const original = invoice.renderers.invoice;
    invoice.renderers.invoice = () => Promise.reject(new Error('renderer down'));
    try {
      await expect(documents.packConsignment(seller, shipmentId, null)).rejects.toMatchObject({
        code: 'DOCUMENT_RENDER_FAILED',
      });
    } finally {
      invoice.renderers.invoice = original;
    }

    const shipment = await prisma.logisticsShipment.findUniqueOrThrow({
      where: { id: shipmentId },
    });
    expect(shipment.packedAt).toBeNull();
    expect(
      await prisma.sellerInvoice.count({
        where: { logisticsShipmentId: shipmentId, status: 'ISSUED' },
      }),
    ).toBe(0);
    expect(
      await prisma.sellerPackingList.count({
        where: { logisticsShipmentId: shipmentId, status: 'ISSUED' },
      }),
    ).toBe(0);
    expect((await prisma.numberSequence.findUnique({ where: { key } }))?.value ?? 0n).toBe(before);
  });

  it('issues both documents and marks the consignment packed, together', async () => {
    const { documents } = await services();
    const view = (await documents.packConsignment(seller, shipmentId, null)) as {
      packedAt: string | null;
      invoices: { number: string; status: string; contentHash: string }[];
      packingLists: { number: string; status: string }[];
    };
    expect(view.packedAt).not.toBeNull();
    expect(view.invoices[0]?.status).toBe('ISSUED');
    expect(view.invoices[0]?.number).toMatch(/^INV\/\d{2}-\d{2}\/00001$/);
    expect(view.packingLists[0]?.status).toBe('ISSUED');
    expect(view.packingLists[0]?.number).toMatch(/^PL-\d{4}-\d{6}$/);

    // The stored PDF is exactly the bytes the hash names.
    const row = await prisma.sellerInvoice.findFirstOrThrow({
      where: { logisticsShipmentId: shipmentId, status: 'ISSUED' },
    });
    const { storage } = await import('../../src/infra/storage/index.js');
    const bytes = await storage.get(row.storageKey ?? '');
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.contentHash);

    // The packing list names the invoice it travels under.
    const list = await prisma.sellerPackingList.findFirstOrThrow({
      where: { logisticsShipmentId: shipmentId, status: 'ISSUED' },
    });
    expect(list.sellerInvoiceId).toBe(row.id);
    expect(list.totalBaseUnits).toBe(100);
    expect(list.grossWeightGrams).toBe(6000n);
  });

  it('never creates a second invoice number on a retry', async () => {
    const { invoice } = await services();
    const again = (await invoice.issueInvoice(seller, shipmentId, null)) as { number: string };
    const count = await prisma.sellerInvoice.count({
      where: { logisticsShipmentId: shipmentId, kind: 'TAX_INVOICE' },
    });
    expect(count).toBe(1);
    expect(again.number).toMatch(/00001$/);
  });

  it('cannot be silently edited once issued', async () => {
    const { consignment } = await services();
    await expect(
      consignment.savePackages(seller, shipmentId, {
        packages: [
          {
            packagingType: 'Carton',
            lengthMm: 1,
            widthMm: 1,
            heightMm: 1,
            grossWeightGrams: 1,
            netWeightGrams: null,
            containerNumber: null,
            sealNumber: null,
            contents: [
              {
                orderItemId,
                quantity: 100,
                batchNumber: '',
                expiryDate: null,
                serialNumbers: null,
              },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'SHIPMENT_PACKAGES_LOCKED' });
    await expect(
      consignment.splitConsignment(seller, shipmentId, { lines: [{ orderItemId, quantity: 10 }] }),
    ).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('records the issue in the audit trail', async () => {
    const actions = (
      await prisma.auditLog.findMany({
        where: {
          action: { in: ['seller_invoice.issued', 'packing_list.issued', 'consignment.packed'] },
        },
        select: { action: true, afterJson: true },
      })
    ).filter(
      (row) =>
        JSON.stringify(row.afterJson).includes(shipmentId) || row.action === 'consignment.packed',
    );
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'seller_invoice.issued',
        'packing_list.issued',
        'consignment.packed',
      ]),
    );
  });
});

describe('who sees what', () => {
  it('shows the buyer only issued invoices, and never the packing list PDF', async () => {
    const { documents } = await services();
    const mine = (await documents.listBuyerOrderDocuments(buyerProfileId, orderId)) as {
      invoices: { id: string; seller: unknown }[];
      packing: { snapshot: unknown }[];
    };
    expect(mine.invoices).toHaveLength(1);
    expect(mine.packing[0]?.snapshot).toBeNull();
    await expect(
      documents.listBuyerOrderDocuments(otherBuyerProfileId, orderId),
    ).rejects.toMatchObject({ statusCode: 404 });

    const list = await prisma.sellerPackingList.findFirstOrThrow({
      where: { logisticsShipmentId: shipmentId },
    });
    await expect(
      documents.buyerDocumentLink(buyerProfileId, buyerUserId, 'packing-list', list.id),
    ).rejects.toMatchObject({ statusCode: 404 });
    const link = await documents.buyerDocumentLink(
      buyerProfileId,
      buyerUserId,
      'invoice',
      mine.invoices[0]?.id ?? '',
    );
    expect(link.url).toMatch(/^\/api\/v1\/documents\/invoice\//);

    // Single use: the token redeems once.
    const token = new URL(`http://x${link.url}`).searchParams.get('token') ?? '';
    const file = await documents.redeemCustomerDocument({
      userId: buyerUserId,
      customerProfileId: buyerProfileId,
      sellerAccountId: null,
      kind: 'invoice',
      id: mine.invoices[0]?.id ?? '',
      token,
      correlationId: null,
    });
    expect(file.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    await expect(
      documents.redeemCustomerDocument({
        userId: buyerUserId,
        customerProfileId: buyerProfileId,
        sellerAccountId: null,
        kind: 'invoice',
        id: mine.invoices[0]?.id ?? '',
        token,
        correlationId: null,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('gives the assigned carrier the packing list and never the invoice', async () => {
    const docs = await prisma.logisticsShipmentDocument.findMany({
      where: { shipmentId, deletedAt: null },
    });
    const invoiceDoc = docs.find((doc) => doc.kind === 'COMMERCIAL_INVOICE');
    const listDoc = docs.find((doc) => doc.kind === 'PACKING_LIST');
    expect(invoiceDoc?.audience).toBe('OPERATOR');
    expect(listDoc?.audience).toBe('BOTH');
    expect(listDoc?.scanState).toBe('GENERATED');

    const { createDocumentLink } = await import('../../src/modules/logistics/document.service.js');
    const membership = {
      logisticsPartnerId: partnerId,
      partnerCode: 'SDOC',
      displayName: 'SDOC Carriers',
      legalName: 'SDOC Carriers Ltd',
      partnerStatus: 'ACTIVE',
      registrationCountry: 'IN',
      partnerUserId: newId(),
      userId: buyerUserId,
      fullName: 'Dispatcher',
      role: 'LOGISTICS_PARTNER_ADMIN',
      permissions: new Set(['logistics.document.read', 'logistics.shipment.read']),
      canAcceptNewWork: true,
      requiresMfa: false,
      driverProfileId: null,
    } as never;

    await expect(createDocumentLink(membership, invoiceDoc?.id ?? '')).rejects.toMatchObject({
      statusCode: 404,
    });
    const link = await createDocumentLink(membership, listDoc?.id ?? '');
    expect(link.fileName).toMatch(/^PL-/);
  });

  it('answers the public check with the issuer and status, and nothing about the buyer', async () => {
    const { documents } = await services();
    const { verificationCode } = await import('../../src/modules/documents/document-format.js');
    const list = await prisma.sellerPackingList.findFirstOrThrow({
      where: { logisticsShipmentId: shipmentId },
    });
    const answer = await documents.verifyDocument(
      'packing-list',
      list.number ?? '',
      verificationCode('packing-list', list.number ?? ''),
    );
    expect(answer).toMatchObject({
      valid: true,
      status: 'ISSUED',
      issuer: 'omega Healthcare Private Limited',
    });
    expect(JSON.stringify(answer)).not.toContain('Acme');
    expect(
      await documents.verifyDocument('packing-list', list.number ?? '', 'AAAAAAAAAAAAAAAA'),
    ).toEqual({ valid: false });
  });

  it('names the right seller when two sellers use the same invoice number', async () => {
    const { documents } = await services();
    const { verificationCode } = await import('../../src/modules/documents/document-format.js');
    const invoice = await prisma.sellerInvoice.findFirstOrThrow({
      where: { logisticsShipmentId: shipmentId, status: 'ISSUED' },
    });
    const number = invoice.number ?? '';

    // The rival's code for the same number must not verify this seller's invoice.
    expect(
      await documents.verifyDocument(
        'invoice',
        number,
        verificationCode('invoice', number, rival.sellerAccountId),
      ),
    ).toEqual({ valid: false });
    // A code over the number alone is not enough either.
    expect(
      await documents.verifyDocument('invoice', number, verificationCode('invoice', number)),
    ).toEqual({
      valid: false,
    });
    expect(
      await documents.verifyDocument(
        'invoice',
        number,
        verificationCode('invoice', number, sellerAccountId),
      ),
    ).toMatchObject({ valid: true, issuer: 'omega Healthcare Private Limited' });
  });
});

describe('corrections', () => {
  it('credits an issued invoice with a new number, never reusing the old one', async () => {
    const { invoice } = await services();
    const issued = await prisma.sellerInvoice.findFirstOrThrow({
      where: { logisticsShipmentId: shipmentId, kind: 'TAX_INVOICE', status: 'ISSUED' },
    });

    // The order is cancelled: the hook `transitionOrder` runs flags the invoice
    // as owing a credit note (called directly; cancelling needs the operator's
    // inventory set up, which is not what this file is about).
    await prisma.$transaction((tx) =>
      invoice.flagInvoicesForCredit({ orderId }, 'Buyer withdrew', tx),
    );
    expect(
      (await prisma.sellerInvoice.findUniqueOrThrow({ where: { id: issued.id } })).status,
    ).toBe('CREDIT_NOTE_REQUIRED');

    const credit = (await invoice.creditInvoice(
      seller,
      issued.id,
      { reason: 'Order cancelled' },
      null,
    )) as {
      kind: string;
      number: string;
      totals: { grandTotal: { minor: string } };
    };
    expect(credit.kind).toBe('CREDIT_NOTE');
    expect(credit.number).toMatch(/^CN\//);
    expect(credit.totals.grandTotal.minor).toBe('-123000');

    const after = await prisma.sellerInvoice.findUniqueOrThrow({ where: { id: issued.id } });
    expect(after.status).toBe('VOIDED');
    expect(after.number).toBe(issued.number);
    expect(after.contentHash).toBe(issued.contentHash);

    // A second credit note for the same invoice is refused.
    await expect(
      invoice.creditInvoice(seller, issued.id, { reason: 'Again' }, null),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('split consignments', () => {
  it('give each vehicle its own packing list, and concurrent issues their own invoice numbers', async () => {
    // A fresh order line on a fresh consignment, so the split starts clean.
    const { consignment, invoice, packing } = await services();
    await prisma.order.update({ where: { id: orderId }, data: { status: 'CONFIRMED' } });
    await prisma.sellerOrderGroup.update({ where: { id: groupId }, data: { status: 'ACCEPTED' } });

    const { createShipment } =
      await import('../../src/modules/logistics/shipment-create.service.js');
    // Clear the first consignment's claim on the line so a new one can carry it.
    await prisma.logisticsShipment.update({
      where: { id: shipmentId },
      data: { status: 'CANCELLED' },
    });
    const second = await createShipment({
      orderId,
      sellerOrderGroupId: groupId,
      sellerAccountId,
      sellerCompanyName: 'omega Healthcare',
      receivingCompanyName: 'Acme Hospitals Pvt Ltd',
      pickupAddress: { line1: '12 MIDC', city: 'Pune', postalCode: '411019', countryCode: 'IN' },
      deliveryAddress: {
        line1: '4 Hospital Road',
        city: 'Pune',
        postalCode: '411001',
        countryCode: 'IN',
      },
    });

    const split = await consignment.splitConsignment(seller, second.id, {
      lines: [{ orderItemId, quantity: 40 }],
    });
    const lines = await prisma.logisticsShipmentLine.findMany({
      where: { shipmentId: { in: [second.id, split.shipmentId] } },
    });
    expect(lines.find((line) => line.shipmentId === second.id)?.quantity).toBe(60);
    expect(lines.find((line) => line.shipmentId === split.shipmentId)?.quantity).toBe(40);

    await packEverything(second.id, 60);
    await packEverything(split.shipmentId, 40);

    const [a, b] = await Promise.all([
      invoice.issueInvoice(seller, second.id, null),
      invoice.issueInvoice(seller, split.shipmentId, null),
    ]);
    const numbers = [(a as { number: string }).number, (b as { number: string }).number];
    expect(new Set(numbers).size).toBe(2);

    // The two invoices add up to the order line exactly.
    const rows = await prisma.sellerInvoice.findMany({
      where: { logisticsShipmentId: { in: [second.id, split.shipmentId] }, status: 'ISSUED' },
    });
    expect(rows.reduce((sum, row) => sum + row.taxableMinor, 0n)).toBe(100_000n);
    expect(rows.reduce((sum, row) => sum + row.cgstMinor + row.sgstMinor, 0n)).toBe(18_000n);

    const [l1, l2] = await Promise.all([
      packing.issuePackingList(seller, second.id, null),
      packing.issuePackingList(seller, split.shipmentId, null),
    ]);
    expect((l1 as { number: string }).number).not.toBe((l2 as { number: string }).number);
    expect(
      (l1 as { totalBaseUnits: number }).totalBaseUnits +
        (l2 as { totalBaseUnits: number }).totalBaseUnits,
    ).toBe(100);
  });
});
