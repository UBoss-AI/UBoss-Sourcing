/**
 * Seller commission invoices, end to end: real settlements, real number
 * sequences, real storage and real A6 PDFs read back as text.
 *
 * THE FIXTURE
 *
 * The issuing entity is registered in Maharashtra (GSTIN 27AAPFU0939F1ZV,
 * TEST data only). Each test builds its own paid seller order with a
 * settlement: by default ₹1,000.00 of goods, a ₹100.00 platform fee and
 * ₹18.00 of tax on the fee (18%, verified), for a Pune seller - an
 * INTRA-state supply, so the tax prints as ₹9.00 CGST + ₹9.00 SGST.
 */
import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { storage } from '../../src/infra/storage/index.js';
import * as service from '../../src/modules/commission-invoicing/commission-invoice.service.js';
import { saveSettings } from '../../src/modules/commission-invoicing/commission-settings.service.js';
import { verificationCode } from '../../src/modules/documents/document-format.js';
import { verifyDocument } from '../../src/modules/documents/documents.service.js';
import { A6 } from '../../src/modules/documents/commission-invoice-pdf.js';
import { inspectPdf } from '../support/pdf-inspect.js';

const PREFIX = 'cinv-';
const ENTITY = 'CITEST';
const ADMIN_EMAIL = 'cinv-admin@test.local';
const OTHER_ADMIN_EMAIL = 'cinv-other-admin@test.local';
const BUYER_EMAIL = 'cinv-buyer@test.local';

let savedDisplayName: { id: string; displayName: string } | null = null;
let actor: service.FinanceActor;
let otherActor: service.FinanceActor;
let buyerProfileId = '';
let counter = 0;

const SETTINGS = {
  legalEntityCode: ENTITY,
  legalName: 'Example Marketplace Operations Private Limited (TEST)',
  tradeName: 'Gloviaa Mart — Powered by UBOSS',
  addressLine1: '4th Floor, Test Tower',
  addressLine2: 'Sample Road',
  city: 'Pune',
  region: 'Maharashtra',
  postcode: '411001',
  country: 'IN',
  stateCode: '27',
  taxRegime: 'IN_GST' as const,
  taxRegistrationLabel: 'GSTIN',
  taxRegistrationNumber: '27AAPFU0939F1ZV',
  businessIdentifierLabel: 'PAN',
  businessIdentifier: 'AAPFU0939F',
  businessEmail: 'billing@example.test',
  supportContact: '+91 00000 00000',
  jurisdictionNote: null,
  serviceCode: '998599',
  serviceCodeLabel: 'SAC',
  serviceDescription: 'Marketplace platform commission for Order {orderNumber}',
  invoicePrefix: 'CT/COM',
  creditNotePrefix: 'CT/CCN',
  sequencePadding: 6,
  financialYearStartMonth: 4,
  eligibleStage: 'DELIVERED' as const,
  paymentTermsDays: 15,
  roundGrandTotal: false,
  requireSellerTaxId: true,
  exportLutReference: null as string | null,
  zeroTaxDocumentType: 'INVOICE' as const,
  allowVoidAfterIssue: false,
  footerNote: null,
};

async function settingsVersion(): Promise<number> {
  return (await prisma.commissionInvoiceSettings.findUnique({ where: { singleton: 'default' } }))?.version ?? 0;
}

async function configure(overrides: Partial<typeof SETTINGS> = {}): Promise<void> {
  await saveSettings(actor, { ...SETTINGS, ...overrides, expectedVersion: await settingsVersion() });
}

function key(): string {
  counter += 1;
  return `cinv-test-key-${String(Date.now())}-${String(counter)}`;
}

interface OrderOptions {
  sellerCountry?: string;
  gstin?: string | null;
  region?: string;
  feeMinor?: bigint;
  taxMinor?: bigint;
  taxRate?: string;
  verified?: boolean;
  groupStatus?: 'DELIVERED' | 'SHIPPED' | 'CANCELLED';
  paid?: boolean;
  legalName?: string;
  addressLine1?: string;
}

/** A paid seller order with a settlement, as the order split writes one. */
async function sellerOrder(options: OrderOptions = {}): Promise<{ groupId: string; sellerId: string; orderId: string; settlementId: string }> {
  counter += 1;
  const tag = `${String(Date.now()).slice(-6)}${String(counter)}`;
  const sellerId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerId,
      legalName: options.legalName ?? `Cinv ${tag} Healthcare Private Limited`,
      displayName: `Cinv ${tag}`,
      displayNameNormalized: `cinv ${tag}`,
      slug: `${PREFIX}${tag}`,
      kind: 'MANUFACTURER',
      registrationCountry: options.sellerCountry ?? 'IN',
      status: 'APPROVED',
    },
  });
  await prisma.sellerBusinessProfile.create({
    data: {
      id: newId(),
      sellerAccountId: sellerId,
      taxRegistrationNumber: options.gstin === undefined ? '27AAPFU0939F1ZV' : options.gstin,
      registeredAddressLine1: options.addressLine1 ?? '12 MIDC Industrial Area',
      registeredCity: options.sellerCountry === 'DE' ? 'Berlin' : 'Pune',
      registeredRegion: options.region ?? (options.sellerCountry === 'DE' ? 'Berlin' : 'Maharashtra'),
      registeredPostcode: '411019',
      registeredCountry: options.sellerCountry ?? 'IN',
      supportEmail: 'accounts@seller.test',
    },
  });
  const orderId = newId();
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `CINV-${tag}`,
      customerProfileId: buyerProfileId,
      status: options.paid === false ? 'PENDING_PAYMENT' : 'DELIVERED',
      currency: 'INR',
      subtotalMinor: 100_000n,
      taxMinor: 18_000n,
      grandTotalMinor: 118_000n,
      paidMinor: options.paid === false ? 0n : 118_000n,
      billingAddressJson: { line1: '4 Hospital Road', city: 'Pune', state: 'Maharashtra', postalCode: '411001', country: 'IN' },
      shippingAddressJson: { line1: '4 Hospital Road', city: 'Pune', state: 'Maharashtra', postalCode: '411001', country: 'IN' },
      placedAt: new Date(),
    },
  });
  const groupId = newId();
  await prisma.sellerOrderGroup.create({
    data: {
      id: groupId,
      sellerAccountId: sellerId,
      orderId,
      sellerOrderNumber: `S-${tag}`,
      status: options.groupStatus ?? 'DELIVERED',
      goodsTotalMinor: 100_000n,
      commissionMinor: options.feeMinor ?? 10_000n,
      currency: 'INR',
      deliveredAt: (options.groupStatus ?? 'DELIVERED') === 'DELIVERED' ? new Date() : null,
    },
  });
  const fee = options.feeMinor ?? 10_000n;
  const tax = options.taxMinor ?? 1_800n;
  const settlementId = newId();
  await prisma.sellerOrderSettlement.create({
    data: {
      id: settlementId,
      sellerOrderGroupId: groupId,
      sellerAccountId: sellerId,
      currency: 'INR',
      grossProceedsMinor: 100_000n,
      feeBasisMinor: 100_000n,
      platformFeeMinor: fee,
      platformFeeTaxMinor: tax,
      estimatedSettlementMinor: 100_000n - fee - tax,
      feeTaxRatePercent: options.taxRate ?? '18.000000',
      feeTaxLabel: 'GST',
      feeTaxVerified: options.verified ?? true,
      breakdownJson: [
        {
          key: 'policy:test',
          source: 'POLICY',
          policyId: null,
          policyVersion: 3,
          feeType: 'PERCENT',
          feeBasis: 'PRODUCT_SUBTOTAL',
          percentRate: '10.000000',
          basisMinor: '100000',
          feeMinor: fee.toString(),
          taxRatePercent: options.taxRate ?? '18.000000',
          taxMinor: tax.toString(),
          note: null,
        },
      ],
    },
  });
  return { groupId, sellerId, orderId, settlementId };
}

async function cleanUp(): Promise<void> {
  const sellers = (await prisma.sellerAccount.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } })).map((row) => row.id);
  const invoices = await prisma.commissionInvoice.findMany({ where: { sellerAccountId: { in: sellers } }, select: { id: true } });
  const invoiceIds = invoices.map((row) => row.id);
  const documents = await prisma.commissionDocument.findMany({
    where: { OR: [{ invoiceId: { in: invoiceIds } }, { creditNote: { invoiceId: { in: invoiceIds } } }] },
    select: { id: true, storageKey: true },
  });
  for (const document of documents) await storage.delete(document.storageKey).catch(() => undefined);
  await prisma.commissionDocument.deleteMany({ where: { id: { in: documents.map((row) => row.id) } } });
  await prisma.commissionCreditNote.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
  await prisma.commissionInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
  await prisma.sellerOrderSettlement.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerOrderGroup.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: 'CINV-' } } });
  await prisma.sellerBusinessProfile.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellers } } });
  await prisma.numberSequence.deleteMany({ where: { key: { startsWith: 'commission-invoice:CT/COM:' } } });
  await prisma.numberSequence.deleteMany({ where: { key: { startsWith: 'commission-credit-note:CT/CCN:' } } });
  await prisma.commissionInvoiceSettings.deleteMany({ where: { legalEntityCode: ENTITY } });
  await prisma.auditLog.deleteMany({ where: { resourceType: { in: ['commission_invoice', 'commission_invoice_settings'] }, actorEmail: { in: [ADMIN_EMAIL, OTHER_ADMIN_EMAIL] } } });
  await prisma.authToken.deleteMany({ where: { user: { emailNormalized: { in: [ADMIN_EMAIL, OTHER_ADMIN_EMAIL] } } } });
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: BUYER_EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { in: [ADMIN_EMAIL, OTHER_ADMIN_EMAIL, BUYER_EMAIL] } } });
}

async function issued(options: OrderOptions = {}) {
  const order = await sellerOrder(options);
  const draft = await service.generateDraft(actor, order.groupId, key());
  const result = await service.issueInvoice(actor, draft.invoice.id, draft.invoice.snapshotHash);
  return { ...order, invoice: result.invoice };
}

async function download(documentId: string, who = actor) {
  const link = await service.downloadLink(who, documentId);
  const token = new URL(link.url, 'http://local').searchParams.get('token') ?? '';
  return service.redeemDownload(who, documentId, token);
}

beforeAll(async () => {
  await cleanUp();
  const make = async (email: string, type: 'ADMIN' | 'CUSTOMER') =>
    prisma.user.create({ data: { id: newId(), type, email, emailNormalized: email, status: 'ACTIVE', emailVerifiedAt: new Date() } });
  const admin = await make(ADMIN_EMAIL, 'ADMIN');
  const other = await make(OTHER_ADMIN_EMAIL, 'ADMIN');
  const buyer = await make(BUYER_EMAIL, 'CUSTOMER');
  actor = { userId: admin.id, email: ADMIN_EMAIL };
  otherActor = { userId: other.id, email: OTHER_ADMIN_EMAIL };
  buyerProfileId = (await prisma.customerProfile.create({ data: { id: newId(), userId: buyer.id, fullName: 'Cinv Buyer', activatedAt: new Date() } })).id;

  // The file name carries the operator's display name; another file may have
  // left a profile under its own name, so pin it here and put it back after.
  const profile = await prisma.businessProfile.findFirst({ select: { id: true, displayName: true } });
  if (profile !== null) {
    savedDisplayName = { id: profile.id, displayName: profile.displayName };
    await prisma.businessProfile.update({ where: { id: profile.id }, data: { displayName: 'Gloviaa Mart' } });
  }
  if ((await prisma.businessProfile.findFirst({ select: { id: true } })) === null) {
    await prisma.businessProfile.create({
      data: { id: newId(), legalName: 'Test Operator', displayName: 'Gloviaa Mart', supportEmail: 'support@test.local', currency: 'INR', timezone: 'Asia/Kolkata' },
    });
  }
  await prisma.commissionInvoiceSettings.deleteMany({});
  await configure();
});

afterAll(async () => {
  if (savedDisplayName !== null) {
    await prisma.businessProfile.update({ where: { id: savedDisplayName.id }, data: { displayName: savedDisplayName.displayName } });
  }
  await cleanUp();
});

describe('eligibility', () => {
  it('lets a paid, delivered seller order have a draft', async () => {
    const { groupId } = await sellerOrder();
    const panel = await service.commissionForOrder((await prisma.sellerOrderGroup.findUniqueOrThrow({ where: { id: groupId } })).orderId);
    expect(panel.sellerOrders[0]?.blockers).toEqual([]);
    const draft = await service.generateDraft(actor, groupId, key());
    expect(draft.created).toBe(true);
    expect(draft.invoice.status).toBe('DRAFT');
    expect(draft.invoice.number).toBeNull();
  });

  it('refuses an unpaid order, and says why', async () => {
    const { groupId } = await sellerOrder({ paid: false });
    await expect(service.generateDraft(actor, groupId, key())).rejects.toMatchObject({
      code: 'COMMISSION_INVOICE_NOT_ELIGIBLE',
      details: expect.arrayContaining([expect.objectContaining({ code: 'PAYMENT_NOT_CAPTURED' })]) as unknown,
    });
  });

  it('refuses a seller order that has not reached the configured stage, or was cancelled', async () => {
    const shipped = await sellerOrder({ groupStatus: 'SHIPPED' });
    await expect(service.generateDraft(actor, shipped.groupId, key())).rejects.toMatchObject({
      details: expect.arrayContaining([expect.objectContaining({ code: 'STAGE_NOT_REACHED_DELIVERED' })]) as unknown,
    });
    const cancelled = await sellerOrder({ groupStatus: 'CANCELLED' });
    await expect(service.generateDraft(actor, cancelled.groupId, key())).rejects.toMatchObject({
      details: expect.arrayContaining([expect.objectContaining({ code: 'SELLER_ORDER_CANCELLED' })]) as unknown,
    });
  });
});

describe('the calculation', () => {
  it('is the settlement’s fee and tax, split CGST + SGST inside one state', async () => {
    const { groupId } = await sellerOrder();
    const { invoice } = await service.generateDraft(actor, groupId, key());
    expect(invoice.totals.taxable.minor).toBe('10000');
    expect(invoice.totals.cgst.minor).toBe('900');
    expect(invoice.totals.sgst.minor).toBe('900');
    expect(invoice.totals.igst.minor).toBe('0');
    expect(invoice.totals.grandTotal.minor).toBe('11800');
    expect(invoice.taxTreatment).toBe('IN_INTRA_STATE');
    expect(invoice.documentType).toBe('TAX_INVOICE');
    expect(invoice.lines).toHaveLength(1);
    expect(invoice.lines[0]?.serviceCode).toBe('998599');
    expect(invoice.lines[0]?.description).toContain('Marketplace platform commission for Order CINV-');
    expect(invoice.amountInWords).toBe('Rupees One Hundred Eighteen Only');
    expect(invoice.issues).toEqual([]);
  });

  it('shows IGST for a seller registered in another state', async () => {
    const { groupId } = await sellerOrder({ gstin: '29AAACB2894G1ZJ', region: 'Karnataka' });
    const { invoice } = await service.generateDraft(actor, groupId, key());
    expect(invoice.taxTreatment).toBe('IN_INTER_STATE');
    expect(invoice.totals.igst.minor).toBe('1800');
    expect(invoice.totals.cgst.minor).toBe('0');
    expect(invoice.placeOfSupply).toEqual({ code: '29', name: 'Karnataka' });
  });

  it('gives a seller outside India no Indian tax components, and asks for the LUT when none was charged', async () => {
    const { groupId } = await sellerOrder({ sellerCountry: 'DE', gstin: 'DE123456789', taxMinor: 0n, taxRate: '0' });
    const { invoice } = await service.generateDraft(actor, groupId, key());
    expect(invoice.taxTreatment).toBe('IN_EXPORT_UNDER_LUT');
    expect(invoice.totals.totalTax.minor).toBe('0');
    expect(invoice.totals.cgst.minor).toBe('0');
    expect(invoice.totals.igst.minor).toBe('0');
    expect(invoice.issues.map((issue) => issue.code)).toContain('LUT_REQUIRED');
    expect(invoice.placeOfSupply).toEqual({ code: '96', name: 'Other Country' });
  });

  it('blocks issuing tax the finance team has not verified', async () => {
    const { groupId } = await sellerOrder({ verified: false });
    const { invoice } = await service.generateDraft(actor, groupId, key());
    expect(invoice.issues.map((issue) => issue.code)).toContain('TAX_RULE_UNVERIFIED');
    await expect(service.issueInvoice(actor, invoice.id, null)).rejects.toMatchObject({ code: 'COMMISSION_INVOICE_VALIDATION_FAILED' });
  });

  it('blocks a seller with no GSTIN, with a message naming it', async () => {
    const { groupId } = await sellerOrder({ gstin: null });
    const { invoice } = await service.generateDraft(actor, groupId, key());
    const issue = invoice.issues.find((item) => item.code === 'SELLER_TAX_ID_MISSING');
    expect(issue?.message).toContain('GSTIN');
    await expect(service.issueInvoice(actor, invoice.id, null)).rejects.toMatchObject({ code: 'COMMISSION_INVOICE_VALIDATION_FAILED' });
    expect((await prisma.commissionInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).number).toBeNull();
  });
});

describe('idempotency and concurrency', () => {
  it('makes one draft however many times it is asked, by retry or by racing clicks', async () => {
    const { groupId, settlementId } = await sellerOrder();
    const retryKey = key();
    const first = await service.generateDraft(actor, groupId, retryKey);
    const retry = await service.generateDraft(actor, groupId, retryKey);
    expect(retry.invoice.id).toBe(first.invoice.id);
    expect(retry.created).toBe(false);

    const racing = await Promise.allSettled(Array.from({ length: 5 }, () => service.generateDraft(actor, groupId, key())));
    for (const result of racing) {
      expect(result.status).toBe('fulfilled');
      if (result.status === 'fulfilled') expect(result.value.invoice.id).toBe(first.invoice.id);
    }
    expect(await prisma.commissionInvoice.count({ where: { settlementId } })).toBe(1);
  });

  it('never gives two invoices the same number, even issued at the same moment', async () => {
    const drafts = [];
    for (let index = 0; index < 4; index += 1) {
      const { groupId } = await sellerOrder();
      drafts.push((await service.generateDraft(actor, groupId, key())).invoice);
    }
    const results = await Promise.allSettled(drafts.map((draft) => service.issueInvoice(actor, draft.id, draft.snapshotHash)));
    const numbers = results.map((result) => (result.status === 'fulfilled' ? result.value.invoice.number : `failed:${String(result.reason)}`));
    expect(new Set(numbers).size).toBe(4);
    for (const number of numbers) expect(number).toMatch(/^CT\/COM\/\d{4}-\d{2}\/\d{6}$/);
  });

  it('issues once when issue is clicked twice', async () => {
    const { groupId } = await sellerOrder();
    const { invoice } = await service.generateDraft(actor, groupId, key());
    const [a, b] = await Promise.allSettled([service.issueInvoice(actor, invoice.id, invoice.snapshotHash), service.issueInvoice(actor, invoice.id, invoice.snapshotHash)]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('fulfilled');
    const numbers = [a, b].map((result) => (result.status === 'fulfilled' ? result.value.invoice.number : null));
    expect(numbers[0]).toBe(numbers[1]);
    expect(await prisma.commissionDocument.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });
});

describe('issuing', () => {
  it('freezes the invoice, stores a verifiable A6 PDF for the right seller and order', async () => {
    const { invoice, sellerId, orderId } = await issued({ legalName: 'Śrī Łódź Healthcare Private Limited' });
    expect(invoice.status).toBe('ISSUED');
    expect(invoice.number).toMatch(/^CT\/COM\/\d{4}-\d{2}\/\d{6}$/);
    const row = await prisma.commissionInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(row.sellerAccountId).toBe(sellerId);
    expect(row.orderId).toBe(orderId);
    expect(invoice.document).not.toBeNull();

    const file = await download(invoice.document?.id ?? '');
    expect(createHash('sha256').update(file.bytes).digest('hex')).toBe(invoice.document?.contentHash);
    expect(file.fileName).toBe(`Gloviaa-Mart-Commission-Invoice-${(invoice.number ?? '').replace(/\//g, '-')}.pdf`);

    const pdf = inspectPdf(file.bytes);
    for (const page of pdf.pages) {
      expect(page.widthPt).toBeCloseTo(A6.width, 2);
      expect(page.heightPt).toBeCloseTo(A6.height, 2);
    }
    expect((A6.width * 25.4) / 72).toBeCloseTo(105, 6);
    expect((A6.height * 25.4) / 72).toBeCloseTo(148, 6);
    const text = pdf.pages.map((page) => page.text).join('\n');
    expect(text).toContain('TAX INVOICE');
    expect(text).toContain('Platform Commission');
    expect(text).toContain('Bill To — Seller'.toUpperCase());
    expect(text).toContain('Śrī Łódź Healthcare');
    expect(text).toContain(invoice.number ?? '');
    expect(text).toContain('Rupees One Hundred Eighteen Only');
    expect(text).toContain('CGST (9%)');
    expect(text).toContain('Amount Payable by Seller to');
    expect(text).toContain('Verify this document');
    expect(text).toContain(`1/${String(pdf.pages.length)}`);
    expect(text).not.toContain('HSN');
    expect(pdf.info.Title).toBe(`Commission invoice ${invoice.number ?? ''}`);
    expect(pdf.info.Subject).toBe('TAX INVOICE - Platform Commission');
  });

  it('never changes once issued', async () => {
    const { invoice } = await issued();
    await expect(service.regenerateDraft(actor, invoice.id)).rejects.toMatchObject({ code: 'COMMISSION_INVOICE_IMMUTABLE' });
    await expect(service.previewPdf(actor, invoice.id)).rejects.toMatchObject({ code: 'COMMISSION_INVOICE_IMMUTABLE' });
    await expect(service.voidInvoice(actor, invoice.id, { reason: 'Changed our mind' }, 'ISSUED')).rejects.toMatchObject({ code: 'COMMISSION_INVOICE_VOID_NOT_PERMITTED' });
    // The discard route - held by whoever may create drafts - cannot reach an issued invoice.
    await expect(service.voidInvoice(actor, invoice.id, { reason: 'Changed our mind' }, 'DRAFT')).rejects.toMatchObject({ code: 'COMMISSION_INVOICE_IMMUTABLE' });
    const again = await service.issueInvoice(actor, invoice.id, null);
    expect(again.created).toBe(false);
    expect(again.invoice.number).toBe(invoice.number);
  });

  it('refuses to issue a draft whose sources moved since it was previewed', async () => {
    const { groupId, sellerId } = await sellerOrder();
    const { invoice } = await service.generateDraft(actor, groupId, key());
    const preview = await service.previewPdf(actor, invoice.id);
    expect(inspectPdf(preview.bytes).pages[0]?.text).toContain('DRAFT');
    await prisma.sellerBusinessProfile.update({ where: { sellerAccountId: sellerId }, data: { registeredAddressLine1: '99 New Road' } });
    await expect(service.issueInvoice(actor, invoice.id, invoice.snapshotHash)).rejects.toMatchObject({
      details: [expect.objectContaining({ code: 'SOURCES_CHANGED' })] as unknown,
    });
    const regenerated = await service.regenerateDraft(actor, invoice.id);
    expect(regenerated.seller.addressLines[0]).toBe('99 New Road');
    const result = await service.issueInvoice(actor, invoice.id, regenerated.snapshotHash);
    expect(result.invoice.status).toBe('ISSUED');
  });

  it('issues nothing and consumes no number when the PDF cannot be rendered', async () => {
    const { groupId } = await sellerOrder();
    const { invoice } = await service.generateDraft(actor, groupId, key());
    const before = await prisma.numberSequence.findMany({ where: { key: { startsWith: 'commission-invoice:CT/COM:' } } });
    const original = service.renderers.commission;
    service.renderers.commission = () => Promise.reject(new Error('renderer down'));
    try {
      await expect(service.issueInvoice(actor, invoice.id, invoice.snapshotHash)).rejects.toMatchObject({ code: 'DOCUMENT_RENDER_FAILED' });
    } finally {
      service.renderers.commission = original;
    }
    const after = await prisma.numberSequence.findMany({ where: { key: { startsWith: 'commission-invoice:CT/COM:' } } });
    expect(after.map((row) => row.value)).toEqual(before.map((row) => row.value));
    expect((await prisma.commissionInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe('DRAFT');
  });

  it('can be checked publicly without revealing the seller or the amount', async () => {
    const { invoice } = await issued();
    const number = invoice.number ?? '';
    const answer = await verifyDocument('commission-invoice', number, verificationCode('commission-invoice', number));
    expect(answer).toMatchObject({ valid: true, number, kind: 'TAX_INVOICE', issuer: SETTINGS.legalName });
    expect(JSON.stringify(answer)).not.toContain('Cinv');
    expect(await verifyDocument('commission-invoice', number, '0000000000000000')).toEqual({ valid: false });
  });
});

describe('downloads', () => {
  it('works once, and only for the member of staff the link was made for', async () => {
    const { invoice } = await issued();
    const documentId = invoice.document?.id ?? '';
    const link = await service.downloadLink(actor, documentId);
    const token = new URL(link.url, 'http://local').searchParams.get('token') ?? '';
    await expect(service.redeemDownload(otherActor, documentId, token)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    await service.redeemDownload(actor, documentId, token);
    await expect(service.redeemDownload(actor, documentId, token)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    const history = await service.readInvoice(invoice.id);
    expect(history.history.map((item) => item.action)).toEqual(['generated', 'issued', 'downloaded']);
  });
});

describe('credit notes', () => {
  it('credits part, then the rest, reversing tax in proportion and netting to zero', async () => {
    const { invoice } = await issued();
    const part = await service.createCreditNote(actor, invoice.id, { reason: 'PARTIAL_REFUND', basis: 'CUSTOM_AMOUNT', taxableMinor: '2500' }, key());
    expect(part.invoice.status).toBe('PARTIALLY_CREDITED');
    const first = part.invoice.creditNotes[0];
    expect(first?.taxable.minor).toBe('2500');
    expect(first?.totalTax.minor).toBe('450');
    expect(first?.number).toMatch(/^CT\/CCN\/\d{4}-\d{2}\/\d{6}$/);

    const pdf = inspectPdf((await download(first?.document?.id ?? '')).bytes);
    const text = pdf.pages.map((page) => page.text).join('\n');
    expect(text).toContain('CREDIT NOTE');
    expect(text).toContain(invoice.number ?? '');

    const rest = await service.createCreditNote(actor, invoice.id, { reason: 'ORDER_CANCELLED', basis: 'FULL' }, key());
    expect(rest.invoice.status).toBe('FULLY_CREDITED');
    expect(rest.invoice.totals.credited.minor).toBe(invoice.totals.grandTotal.minor);
    const notes = await prisma.commissionCreditNote.findMany({ where: { invoiceId: invoice.id } });
    expect(notes.reduce((sum, note) => sum + note.cgstMinor, 0n)).toBe(900n);
    expect(notes.reduce((sum, note) => sum + note.sgstMinor, 0n)).toBe(900n);
    await expect(service.createCreditNote(actor, invoice.id, { reason: 'FULL_REFUND', basis: 'FULL' }, key())).rejects.toMatchObject({ code: 'COMMISSION_CREDIT_INVALID' });
  });

  it('credits the refunded share of the fee, and lets a replacement be issued once fully credited', async () => {
    const { invoice, settlementId, groupId } = await issued();
    await prisma.sellerOrderSettlement.update({ where: { id: settlementId }, data: { refundsAdjustmentsMinor: 50_000n } });
    const refundKey = key();
    const credit = await service.createCreditNote(actor, invoice.id, { reason: 'PARTIAL_REFUND', basis: 'PROPORTIONAL_TO_REFUND' }, refundKey);
    expect(credit.invoice.creditNotes[0]?.taxable.minor).toBe('5000');
    const replay = await service.createCreditNote(actor, invoice.id, { reason: 'PARTIAL_REFUND', basis: 'PROPORTIONAL_TO_REFUND' }, refundKey);
    expect(replay.created).toBe(false);
    expect(await prisma.commissionCreditNote.count({ where: { invoiceId: invoice.id } })).toBe(1);

    await expect(service.generateDraft(actor, groupId, key())).resolves.toMatchObject({ created: false });
    await service.createCreditNote(actor, invoice.id, { reason: 'TAX_ADJUSTMENT', basis: 'FULL' }, key());
    const replacement = await service.generateDraft(actor, groupId, key());
    expect(replacement.created).toBe(true);
    expect(replacement.invoice.id).not.toBe(invoice.id);
  });

  it('refuses to credit more than is left', async () => {
    const { invoice } = await issued();
    await expect(
      service.createCreditNote(actor, invoice.id, { reason: 'SELLER_DISPUTE', basis: 'CUSTOM_AMOUNT', taxableMinor: '10001' }, key()),
    ).rejects.toMatchObject({ code: 'COMMISSION_CREDIT_INVALID' });
  });
});

describe('the list', () => {
  it('finds invoices by number, seller and order, with server-side pagination', async () => {
    const { invoice, sellerId } = await issued();
    const byNumber = await service.listInvoices({ q: invoice.number ?? '' });
    expect(byNumber.items.map((row) => row.id)).toEqual([invoice.id]);
    const bySeller = await service.listInvoices({ q: sellerId });
    expect(bySeller.items.map((row) => row.id)).toContain(invoice.id);
    const byOrder = await service.listInvoices({ q: invoice.source.orderNumber });
    expect(byOrder.items[0]?.id).toBe(invoice.id);
    const page = await service.listInvoices({ status: 'ISSUED', pageSize: 2, page: 1 });
    expect(page.items.length).toBeLessThanOrEqual(2);
    expect(page.total).toBeGreaterThanOrEqual(page.items.length);
    const outstanding = await service.listInvoices({ collectionStatus: 'OUTSTANDING', currency: 'INR', country: 'IN' });
    expect(outstanding.items.every((row) => row.collectionStatus === 'OUTSTANDING')).toBe(true);
  });

  it('records a payment from the seller without touching the issued PDF', async () => {
    const { invoice } = await issued();
    const paid = await service.recordCollection(actor, invoice.id, { reference: 'NEFT-TEST-001' });
    expect(paid.collection.status).toBe('PAID');
    expect(paid.document?.contentHash).toBe(invoice.document?.contentHash);
  });

  it('discards a draft so the order can be invoiced afresh', async () => {
    const { groupId } = await sellerOrder();
    const { invoice } = await service.generateDraft(actor, groupId, key());
    const discarded = await service.voidInvoice(actor, invoice.id, { reason: 'Built against the wrong settings' }, 'DRAFT');
    expect(discarded.status).toBe('VOID');
    const fresh = await service.generateDraft(actor, groupId, key());
    expect(fresh.invoice.id).not.toBe(invoice.id);
  });
});
