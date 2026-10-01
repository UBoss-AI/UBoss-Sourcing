/**
 * Shipment documents beyond the invoice and the packing list (Master row 42).
 *
 * The commercial invoice and the packing list are ISSUED by this system, in
 * `documents/seller-invoice.service.ts` and `documents/packing-list.service.ts`.
 * Everything else a consignment travels with - the certificate of origin, the
 * shipping bill, the bill of lading or air waybill, an inspection certificate,
 * a licence, or a document a category rule requires - is kept here as a slot
 * per seller order (or per consignment) with numbered versions.
 *
 * Rules that hold for every version:
 *
 *  - A version is never edited. A correction is a new version; the one it
 *    replaces keeps its bytes and gets `supersededAt`.
 *  - The bytes decide the file type (a PDF or an image), never the header, and
 *    the file is scanned before it is stored, under the PRIVATE prefix.
 *  - The seller states who issued it. Only marketplace staff mark a version
 *    VALID or REJECTED; EXPIRED is read from `expiresOn`, never stored.
 *  - The buyer sees a document only when its kind is buyer-visible, and only
 *    its current version, and never a rejected one.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { assertNotMalware } from '../../infra/malware-scan.js';
import { prisma } from '../../infra/prisma.js';
import { sniffDocumentType, storage } from '../../infra/storage/index.js';
import { PdfBuilder } from '../documents/pdf.js';
import { recordSellerAudit } from './audit.service.js';

/** The document kinds a seller may record here. `CATEGORY:<code>` is also accepted. */
export const TRADE_DOCUMENT_KINDS = Object.freeze([
  'CERTIFICATE_OF_ORIGIN',
  'SHIPPING_BILL',
  'BILL_OF_LADING',
  'AIR_WAYBILL',
  'INSPECTION_CERTIFICATE',
  'EXPORT_LICENCE',
  'IMPORT_LICENCE',
  'OTHER',
] as const);

/** Kinds the buyer sees unless the slot says otherwise. A category document is too. */
const BUYER_VISIBLE_KINDS: ReadonlySet<string> = new Set([
  'CERTIFICATE_OF_ORIGIN',
  'BILL_OF_LADING',
  'AIR_WAYBILL',
  'INSPECTION_CERTIFICATE',
  'IMPORT_LICENCE',
]);

/** Kinds that are a carrier's number: a version must carry the number. */
const REFERENCE_KINDS: ReadonlySet<string> = new Set(['BILL_OF_LADING', 'AIR_WAYBILL', 'SHIPPING_BILL']);

const CATEGORY_KIND = /^CATEGORY:[A-Z0-9_-]{1,40}$/;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export function isTradeDocumentKind(kind: string): boolean {
  return (TRADE_DOCUMENT_KINDS as readonly string[]).includes(kind) || CATEGORY_KIND.test(kind);
}

export function isBuyerVisible(kind: string, override: string | null): boolean {
  if (override === 'VISIBLE') return true;
  if (override === 'HIDDEN') return false;
  return BUYER_VISIBLE_KINDS.has(kind) || kind.startsWith('CATEGORY:');
}

export type TradeValidationState = 'PENDING_REVIEW' | 'VALID' | 'REJECTED' | 'EXPIRED';

/** EXPIRED wins over everything but a rejection: an expired certificate is not valid. */
export function validationStateOf(
  validation: 'PENDING_REVIEW' | 'VALID' | 'REJECTED',
  expiresOn: Date | null,
  today: Date = new Date(),
): TradeValidationState {
  if (validation === 'REJECTED') return 'REJECTED';
  if (expiresOn !== null && expiresOn.toISOString().slice(0, 10) < today.toISOString().slice(0, 10)) {
    return 'EXPIRED';
  }
  return validation;
}

function invalid(message: string, field: string, code: string): never {
  throw badRequest(ErrorCode.TRADE_DOCUMENT_INVALID, message, [{ field, code }]);
}

function day(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

export interface TradeDocumentVersionView {
  id: string;
  version: number;
  source: 'GENERATED' | 'UPLOADED' | 'REFERENCE';
  referenceNumber: string | null;
  issuerName: string;
  issuedOn: string | null;
  expiresOn: string | null;
  fileName: string | null;
  hasFile: boolean;
  validation: TradeValidationState;
  validationNote: string | null;
  superseded: boolean;
  createdByLabel: string;
  createdAt: string;
}

export interface TradeDocumentView {
  id: string;
  kind: string;
  title: string;
  /** The consignment it belongs to, or null for the whole seller order. */
  shipmentId: string | null;
  buyerVisible: boolean;
  currentVersion: number;
  current: TradeDocumentVersionView | null;
  versions: TradeDocumentVersionView[];
}

type VersionRow = {
  id: string;
  version: number;
  source: 'GENERATED' | 'UPLOADED' | 'REFERENCE';
  referenceNumber: string | null;
  issuerName: string;
  issuedOn: Date | null;
  expiresOn: Date | null;
  fileName: string | null;
  storageKey: string | null;
  validation: 'PENDING_REVIEW' | 'VALID' | 'REJECTED';
  validationNote: string | null;
  supersededAt: Date | null;
  createdByLabel: string;
  createdAt: Date;
};

const VERSION_SELECT = {
  id: true,
  version: true,
  source: true,
  referenceNumber: true,
  issuerName: true,
  issuedOn: true,
  expiresOn: true,
  fileName: true,
  storageKey: true,
  validation: true,
  validationNote: true,
  supersededAt: true,
  createdByLabel: true,
  createdAt: true,
} as const;

function versionView(row: VersionRow): TradeDocumentVersionView {
  return {
    id: row.id,
    version: row.version,
    source: row.source,
    referenceNumber: row.referenceNumber,
    issuerName: row.issuerName,
    issuedOn: day(row.issuedOn),
    expiresOn: day(row.expiresOn),
    fileName: row.fileName,
    hasFile: row.storageKey !== null,
    validation: validationStateOf(row.validation, row.expiresOn),
    validationNote: row.validationNote,
    superseded: row.supersededAt !== null,
    createdByLabel: row.createdByLabel,
    createdAt: row.createdAt.toISOString(),
  };
}

function documentView(row: {
  id: string;
  kind: string;
  title: string;
  shipmentKey: string;
  buyerVisibility: string | null;
  currentVersion: number;
  versions: VersionRow[];
}): TradeDocumentView {
  const versions = [...row.versions].sort((a, b) => b.version - a.version).map(versionView);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    shipmentId: row.shipmentKey === '' ? null : row.shipmentKey,
    buyerVisible: isBuyerVisible(row.kind, row.buyerVisibility),
    currentVersion: row.currentVersion,
    current: versions.find((version) => version.version === row.currentVersion) ?? null,
    versions,
  };
}

export interface RequiredTradeDocument {
  kind: string;
  name: string;
  ruleName: string;
  note: string | null;
  /** Whether a current version exists that is VALID or awaiting review. */
  satisfied: boolean;
}

export interface SellerTradeDocuments {
  documents: TradeDocumentView[];
  /** What the operator's destination and category rules ask the seller for. */
  required: RequiredTradeDocument[];
  /** The two documents this system issues, counted per state, for one summary line. */
  issued: { commercialInvoices: number; packingLists: number };
  consignments: { id: string; reference: string }[];
}

export interface TradeActor {
  sellerAccountId: string;
  label: string;
}

async function requireGroup(sellerAccountId: string, orderGroupId: string) {
  const group = await prisma.sellerOrderGroup.findFirst({
    where: { id: orderGroupId, sellerAccountId },
    select: {
      id: true,
      orderId: true,
      sellerOrderNumber: true,
      status: true,
      order: { select: { orderNumber: true, shippingAddressJson: true } },
      lines: {
        select: {
          quantity: true,
          offer: {
            select: {
              hsnCode: true,
              countryOfOrigin: true,
              sellerSku: true,
              product: { select: { name: true, categoryId: true } },
            },
          },
        },
      },
      sellerAccount: { select: { legalName: true, registrationCountry: true } },
    },
  });
  if (group === null) throw notFound('Order');
  return group;
}

function destinationCountryOf(address: unknown): string {
  if (typeof address === 'object' && address !== null && 'country' in address) {
    const country = (address).country;
    if (typeof country === 'string') return country.toUpperCase();
  }
  return '';
}

async function requiredFor(
  group: Awaited<ReturnType<typeof requireGroup>>,
  documents: TradeDocumentView[],
): Promise<RequiredTradeDocument[]> {
  const destination = destinationCountryOf(group.order.shippingAddressJson);
  const categoryIds = [...new Set(group.lines.map((line) => line.offer.product.categoryId))];
  const hsCodes = group.lines.map((line) => line.offer.hsnCode ?? '');

  const rules = await prisma.tradeComplianceRule.findMany({
    where: {
      isActive: true,
      responsibleParty: 'SELLER',
      requiredDocumentKind: { not: null },
      destinationCountry: { in: ['', destination] },
      OR: [{ categoryId: null }, { categoryId: { in: categoryIds } }],
    },
    select: { name: true, hsPrefix: true, requiredDocumentKind: true, requiredDocumentName: true, note: true },
    orderBy: { name: 'asc' },
  });

  return rules
    .filter((rule) => rule.hsPrefix === '' || hsCodes.some((code) => code.startsWith(rule.hsPrefix)))
    .map((rule) => {
      const kind = rule.requiredDocumentKind ?? '';
      const satisfied = documents.some(
        (document) =>
          document.kind === kind &&
          document.current !== null &&
          (document.current.validation === 'VALID' || document.current.validation === 'PENDING_REVIEW'),
      );
      return {
        kind,
        name: rule.requiredDocumentName ?? kind,
        ruleName: rule.name,
        note: rule.note,
        satisfied,
      };
    });
}

/** Every trade document of one of the seller's orders, with what the rules require. */
export async function listSellerTradeDocuments(
  sellerAccountId: string,
  orderGroupId: string,
): Promise<SellerTradeDocuments> {
  const group = await requireGroup(sellerAccountId, orderGroupId);

  const [rows, invoices, packingLists, consignments] = await Promise.all([
    prisma.orderTradeDocument.findMany({
      where: { orderGroupId: group.id, sellerAccountId },
      orderBy: [{ shipmentKey: 'asc' }, { kind: 'asc' }],
      select: {
        id: true,
        kind: true,
        title: true,
        shipmentKey: true,
        buyerVisibility: true,
        currentVersion: true,
        versions: { select: VERSION_SELECT },
      },
    }),
    prisma.sellerInvoice.count({ where: { sellerOrderGroupId: group.id, sellerAccountId, status: 'ISSUED' } }),
    prisma.sellerPackingList.count({ where: { sellerOrderGroupId: group.id, sellerAccountId, status: 'ISSUED' } }),
    prisma.logisticsShipment.findMany({
      where: { sellerOrderGroupId: group.id, sellerAccountId },
      select: { id: true, shipmentReference: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const documents = rows.map(documentView);

  return {
    documents,
    required: await requiredFor(group, documents),
    issued: { commercialInvoices: invoices, packingLists },
    consignments: consignments.map((row) => ({ id: row.id, reference: row.shipmentReference })),
  };
}

export interface AddTradeDocumentInput {
  actor: TradeActor;
  orderGroupId: string;
  shipmentId: string | null;
  kind: string;
  title?: string | null;
  referenceNumber?: string | null;
  issuerName: string;
  issuedOn?: Date | null;
  expiresOn?: Date | null;
  file?: { fileName: string; bytes: Buffer } | null;
  correlationId?: string | null;
}

const KIND_TITLES: Readonly<Record<string, string>> = Object.freeze({
  CERTIFICATE_OF_ORIGIN: 'Certificate of origin',
  SHIPPING_BILL: 'Shipping bill',
  BILL_OF_LADING: 'Bill of lading',
  AIR_WAYBILL: 'Air waybill',
  INSPECTION_CERTIFICATE: 'Inspection certificate',
  EXPORT_LICENCE: 'Export licence',
  IMPORT_LICENCE: 'Import licence',
  OTHER: 'Other document',
});

async function storeFile(file: { fileName: string; bytes: Buffer }) {
  if (file.bytes.length === 0 || file.bytes.length > MAX_FILE_BYTES) {
    throw badRequest(ErrorCode.MEDIA_TOO_LARGE, 'That file is too large. The limit is 10 MB.', [
      { field: 'file', code: 'TOO_LARGE', meta: { maxBytes: MAX_FILE_BYTES } },
    ]);
  }
  const sniffed = sniffDocumentType(file.bytes);
  await assertNotMalware(file.bytes);
  const stored = await storage.put(file.bytes, sniffed.mimeType, sniffed.extension, 'private');
  return {
    storageKey: stored.storageKey,
    fileName: file.fileName.slice(0, 255),
    contentType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    sha256: stored.checksum.slice(0, 64),
  };
}

/** Write one new version into a slot, creating the slot the first time. */
async function writeVersion(input: {
  actor: TradeActor;
  group: { id: string; orderId: string };
  shipmentKey: string;
  kind: string;
  title: string;
  source: 'GENERATED' | 'UPLOADED' | 'REFERENCE';
  referenceNumber: string | null;
  issuerName: string;
  issuedOn: Date | null;
  expiresOn: Date | null;
  file: Awaited<ReturnType<typeof storeFile>> | null;
}): Promise<string> {
  return prisma.$transaction(async (tx) => {
    let slot = await tx.orderTradeDocument.findUnique({
      where: {
        orderGroupId_shipmentKey_kind: {
          orderGroupId: input.group.id,
          shipmentKey: input.shipmentKey,
          kind: input.kind,
        },
      },
      select: { id: true, currentVersion: true },
    });

    if (slot === null) {
      slot = await tx.orderTradeDocument.create({
        data: {
          id: newId(),
          orderGroupId: input.group.id,
          orderId: input.group.orderId,
          sellerAccountId: input.actor.sellerAccountId,
          shipmentKey: input.shipmentKey,
          kind: input.kind,
          title: input.title,
        },
        select: { id: true, currentVersion: true },
      });
    }

    const version = slot.currentVersion + 1;
    const versionId = newId();
    const now = new Date();

    await tx.orderTradeDocumentVersion.updateMany({
      where: { documentId: slot.id, supersededAt: null },
      data: { supersededAt: now },
    });
    await tx.orderTradeDocumentVersion.create({
      data: {
        id: versionId,
        documentId: slot.id,
        version,
        source: input.source,
        referenceNumber: input.referenceNumber,
        issuerName: input.issuerName,
        issuedOn: input.issuedOn,
        expiresOn: input.expiresOn,
        storageKey: input.file?.storageKey ?? null,
        fileName: input.file?.fileName ?? null,
        contentType: input.file?.contentType ?? null,
        sizeBytes: input.file?.sizeBytes ?? null,
        sha256: input.file?.sha256 ?? null,
        scanState: input.file === null ? null : 'CLEAN',
        createdByLabel: input.actor.label.slice(0, 160),
      },
    });
    // The version number is the optimistic lock: two writers that read the
    // same `currentVersion` both try to create version N, and the UNIQUE on
    // (documentId, version) refuses the second.
    await tx.orderTradeDocument.update({
      where: { id: slot.id },
      data: { currentVersion: version, title: input.title },
    });
    await tx.orderTradeDocumentEvent.create({
      data: {
        id: newId(),
        documentId: slot.id,
        versionId,
        action:
          input.source === 'GENERATED' ? 'GENERATED' : input.source === 'UPLOADED' ? 'UPLOADED' : 'REFERENCE_RECORDED',
        actorType: 'SELLER',
        actorLabel: input.actor.label.slice(0, 160),
      },
    });
    return slot.id;
  });
}

async function resolveShipmentKey(
  sellerAccountId: string,
  orderGroupId: string,
  shipmentId: string | null,
): Promise<string> {
  if (shipmentId === null || shipmentId === '') return '';
  const shipment = await prisma.logisticsShipment.findFirst({
    where: { id: shipmentId, sellerAccountId, sellerOrderGroupId: orderGroupId },
    select: { id: true },
  });
  if (shipment === null) throw notFound('Consignment');
  return shipment.id;
}

/**
 * Record a new version of a trade document: an uploaded file, or a reference
 * number (a waybill, a shipping bill) with an optional scan of it.
 */
export async function addTradeDocumentVersion(input: AddTradeDocumentInput): Promise<TradeDocumentView> {
  const kind = input.kind.trim().toUpperCase();
  if (!isTradeDocumentKind(kind)) invalid('Choose what kind of document this is.', 'kind', 'UNKNOWN_KIND');

  const issuerName = input.issuerName.trim();
  if (issuerName === '') invalid('Say who issued this document.', 'issuerName', 'REQUIRED');

  const referenceNumber = input.referenceNumber?.trim() ?? '';
  const issuedOn = input.issuedOn ?? null;
  const expiresOn = input.expiresOn ?? null;

  if (issuedOn !== null && expiresOn !== null && expiresOn < issuedOn) {
    invalid('The expiry date is before the issue date.', 'expiresOn', 'BEFORE_ISSUE');
  }
  if (REFERENCE_KINDS.has(kind) && referenceNumber === '') {
    invalid('Enter the document number.', 'referenceNumber', 'REQUIRED');
  }
  const hasFile = input.file !== undefined && input.file !== null;
  if (!hasFile && referenceNumber === '') {
    invalid('Attach the document, or enter its number.', 'file', 'FILE_OR_REFERENCE');
  }

  const group = await requireGroup(input.actor.sellerAccountId, input.orderGroupId);
  const shipmentKey = await resolveShipmentKey(input.actor.sellerAccountId, group.id, input.shipmentId);

  const file = hasFile && input.file ? await storeFile(input.file) : null;
  const title = (input.title?.trim() ?? '') || KIND_TITLES[kind] || kind.replace(/^CATEGORY:/, '');

  const documentId = await writeVersion({
    actor: input.actor,
    group,
    shipmentKey,
    kind,
    title: title.slice(0, 160),
    source: file === null ? 'REFERENCE' : 'UPLOADED',
    referenceNumber: referenceNumber === '' ? null : referenceNumber.slice(0, 64),
    issuerName: issuerName.slice(0, 200),
    issuedOn,
    expiresOn,
    file,
  });

  await recordSellerAudit({
    sellerAccountId: input.actor.sellerAccountId,
    action: 'seller.trade_document.version_added',
    actor: { type: 'CUSTOMER', label: input.actor.label },
    resourceType: 'order_trade_document',
    resourceId: documentId,
    after: { kind, hasFile: file !== null, referenceNumber: referenceNumber === '' ? null : referenceNumber },
    summary: `Recorded a ${title} for ${group.sellerOrderNumber}.`,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
  });

  return requireDocumentView(input.actor.sellerAccountId, documentId);
}

async function requireDocumentView(sellerAccountId: string, documentId: string): Promise<TradeDocumentView> {
  const row = await prisma.orderTradeDocument.findFirst({
    where: { id: documentId, sellerAccountId },
    select: {
      id: true,
      kind: true,
      title: true,
      shipmentKey: true,
      buyerVisibility: true,
      currentVersion: true,
      versions: { select: VERSION_SELECT },
    },
  });
  if (row === null) throw notFound('Document');
  return documentView(row);
}

/**
 * Generate a certificate of origin DRAFT from the order: the exporter, the
 * consignee's country and every line with its declared country of origin.
 *
 * It is a draft for a chamber of commerce or an issuing authority to certify,
 * which is why it is watermarked and recorded as PENDING_REVIEW: this system
 * prepares the paper, it does not certify origin.
 */
export async function generateCertificateOfOriginDraft(input: {
  actor: TradeActor;
  orderGroupId: string;
  shipmentId: string | null;
  correlationId?: string | null;
}): Promise<TradeDocumentView> {
  const group = await requireGroup(input.actor.sellerAccountId, input.orderGroupId);
  const shipmentKey = await resolveShipmentKey(input.actor.sellerAccountId, group.id, input.shipmentId);

  const missing = group.lines.filter((line) => (line.offer.countryOfOrigin ?? '') === '');
  if (missing.length > 0) {
    throw badRequest(ErrorCode.TRADE_DOCUMENT_INVALID, 'Every item needs a country of origin first.', [
      { field: 'countryOfOrigin', code: 'REQUIRED', meta: { sku: missing[0]?.offer.sellerSku ?? '' } },
    ]);
  }

  const issuedAt = new Date();
  const reference = `${group.sellerOrderNumber}-COO`;
  const pdf = new PdfBuilder({
    title: `Certificate of origin ${reference}`,
    issuedAt,
    author: group.sellerAccount.legalName,
    subject: `Certificate of origin draft for ${group.sellerOrderNumber}`,
    reference: `Certificate of origin ${reference} · ${group.sellerAccount.legalName}`,
    watermark: 'DRAFT FOR CERTIFICATION',
  });
  pdf.title('CERTIFICATE OF ORIGIN', 'Draft prepared by the exporter for certification', null);
  pdf.facts(
    [
      ['Exporter', group.sellerAccount.legalName],
      ['Exporter country', group.sellerAccount.registrationCountry],
      ['Order', group.order.orderNumber],
      ['Seller order', group.sellerOrderNumber],
      ['Destination country', destinationCountryOf(group.order.shippingAddressJson) || '—'],
      ['Prepared on', issuedAt.toISOString().slice(0, 10)],
    ],
    3,
  );
  pdf.table(
    [
      { header: 'SKU', weight: 6 },
      { header: 'Description', weight: 14 },
      { header: 'HS code', weight: 5 },
      { header: 'Qty', weight: 4, align: 'right' },
      { header: 'Origin', weight: 4, align: 'center' },
    ],
    group.lines.map((line) => [
      line.offer.sellerSku,
      line.offer.product.name,
      line.offer.hsnCode ?? '—',
      String(line.quantity),
      line.offer.countryOfOrigin ?? '—',
    ]),
  );
  pdf.paragraph(
    'The exporter declares that the goods above originate in the countries shown. This draft is not a certificate until an issuing authority has certified it.',
    { muted: true },
  );
  const { bytes } = await pdf.finish();

  const stored = await storage.put(bytes, 'application/pdf', 'pdf', 'private');
  const documentId = await writeVersion({
    actor: input.actor,
    group,
    shipmentKey,
    kind: 'CERTIFICATE_OF_ORIGIN',
    title: KIND_TITLES['CERTIFICATE_OF_ORIGIN'] ?? 'Certificate of origin',
    source: 'GENERATED',
    referenceNumber: reference.slice(0, 64),
    issuerName: group.sellerAccount.legalName.slice(0, 200),
    issuedOn: null,
    expiresOn: null,
    file: {
      storageKey: stored.storageKey,
      fileName: `${reference}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: stored.sizeBytes,
      sha256: stored.checksum.slice(0, 64),
    },
  });

  await recordSellerAudit({
    sellerAccountId: input.actor.sellerAccountId,
    action: 'seller.trade_document.generated',
    actor: { type: 'CUSTOMER', label: input.actor.label },
    resourceType: 'order_trade_document',
    resourceId: documentId,
    after: { kind: 'CERTIFICATE_OF_ORIGIN', reference },
    summary: `Generated a certificate of origin draft for ${group.sellerOrderNumber}.`,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
  });

  return requireDocumentView(input.actor.sellerAccountId, documentId);
}

interface FileOut {
  bytes: Buffer;
  fileName: string;
  contentType: string;
}

async function readVersionFile(version: {
  storageKey: string | null;
  fileName: string | null;
  contentType: string | null;
}): Promise<FileOut> {
  if (version.storageKey === null) throw notFound('Document file');
  return {
    bytes: await storage.get(version.storageKey),
    fileName: version.fileName ?? 'document',
    contentType: version.contentType ?? 'application/octet-stream',
  };
}

/** The file of one version, for the seller who owns it. */
export async function sellerTradeDocumentFile(sellerAccountId: string, versionId: string): Promise<FileOut> {
  const version = await prisma.orderTradeDocumentVersion.findFirst({
    where: { id: versionId, document: { sellerAccountId } },
    select: { storageKey: true, fileName: true, contentType: true },
  });
  if (version === null) throw notFound('Document');
  return readVersionFile(version);
}

// ---------------------------------------------------------------------------
// The buyer
// ---------------------------------------------------------------------------

export interface BuyerTradeDocument {
  id: string;
  kind: string;
  title: string;
  shipmentReference: string | null;
  sellerName: string;
  versionId: string;
  version: number;
  referenceNumber: string | null;
  issuerName: string;
  issuedOn: string | null;
  expiresOn: string | null;
  hasFile: boolean;
  validation: TradeValidationState;
}

export interface OrderScope {
  customerProfileId?: string;
  buyerCompanyId: string | null;
}

async function requireBuyerOrder(scope: OrderScope, orderId: string): Promise<{ id: string }> {
  const order = await prisma.order.findFirst({ where: { id: orderId, ...scope }, select: { id: true } });
  if (order === null) throw notFound('Order');
  return order;
}

/** The trade documents the buyer may see on one of their own orders: current versions only. */
export async function listBuyerTradeDocuments(scope: OrderScope, orderId: string): Promise<BuyerTradeDocument[]> {
  const order = await requireBuyerOrder(scope, orderId);

  const rows = await prisma.orderTradeDocument.findMany({
    where: { orderId: order.id, currentVersion: { gt: 0 } },
    orderBy: [{ shipmentKey: 'asc' }, { kind: 'asc' }],
    select: {
      id: true,
      kind: true,
      title: true,
      shipmentKey: true,
      buyerVisibility: true,
      currentVersion: true,
      orderGroup: { select: { sellerAccount: { select: { displayName: true } } } },
      versions: { where: { supersededAt: null }, select: VERSION_SELECT },
    },
  });

  const shipmentKeys = [...new Set(rows.map((row) => row.shipmentKey).filter((key) => key !== ''))];
  const shipments =
    shipmentKeys.length === 0
      ? []
      : await prisma.logisticsShipment.findMany({
          where: { id: { in: shipmentKeys }, orderId: order.id },
          select: { id: true, shipmentReference: true },
        });
  const references = new Map(shipments.map((row) => [row.id, row.shipmentReference]));

  const out: BuyerTradeDocument[] = [];
  for (const row of rows) {
    if (!isBuyerVisible(row.kind, row.buyerVisibility)) continue;
    const current = row.versions.find((version) => version.version === row.currentVersion);
    if (current === undefined || current.validation === 'REJECTED') continue;
    out.push({
      id: row.id,
      kind: row.kind,
      title: row.title,
      shipmentReference: row.shipmentKey === '' ? null : (references.get(row.shipmentKey) ?? null),
      sellerName: row.orderGroup.sellerAccount.displayName,
      versionId: current.id,
      version: current.version,
      referenceNumber: current.referenceNumber,
      issuerName: current.issuerName,
      issuedOn: day(current.issuedOn),
      expiresOn: day(current.expiresOn),
      hasFile: current.storageKey !== null,
      validation: validationStateOf(current.validation, current.expiresOn),
    });
  }
  return out;
}

/** The file of a buyer-visible current version on one of the buyer's own orders. */
export async function buyerTradeDocumentFile(
  scope: OrderScope,
  orderId: string,
  versionId: string,
): Promise<FileOut> {
  const order = await requireBuyerOrder(scope, orderId);
  const version = await prisma.orderTradeDocumentVersion.findFirst({
    where: { id: versionId, supersededAt: null, document: { orderId: order.id } },
    select: {
      storageKey: true,
      fileName: true,
      contentType: true,
      validation: true,
      document: { select: { kind: true, buyerVisibility: true } },
    },
  });
  if (
    version === null ||
    version.validation === 'REJECTED' ||
    !isBuyerVisible(version.document.kind, version.document.buyerVisibility)
  ) {
    throw notFound('Document');
  }
  return readVersionFile(version);
}

// ---------------------------------------------------------------------------
// The marketplace
// ---------------------------------------------------------------------------

/** Every trade document on one order, every seller, every version: the reviewer's view. */
export async function listAdminTradeDocuments(orderId: string): Promise<TradeDocumentView[]> {
  const rows = await prisma.orderTradeDocument.findMany({
    where: { orderId },
    orderBy: [{ sellerAccountId: 'asc' }, { shipmentKey: 'asc' }, { kind: 'asc' }],
    select: {
      id: true,
      kind: true,
      title: true,
      shipmentKey: true,
      buyerVisibility: true,
      currentVersion: true,
      versions: { select: VERSION_SELECT },
    },
  });
  return rows.map(documentView);
}

/** The file of any version, for marketplace staff reviewing it. */
export async function adminTradeDocumentFile(versionId: string): Promise<FileOut> {
  const version = await prisma.orderTradeDocumentVersion.findUnique({
    where: { id: versionId },
    select: { storageKey: true, fileName: true, contentType: true },
  });
  if (version === null) throw notFound('Document');
  return readVersionFile(version);
}

/**
 * Mark the current version of a trade document VALID or REJECTED. A rejection
 * needs a note: a seller told "rejected" with no reason cannot fix it.
 */
export async function validateTradeDocumentVersion(input: {
  versionId: string;
  decision: 'VALID' | 'REJECTED';
  note: string | null;
  staffUserId: string;
  staffLabel: string;
}): Promise<TradeDocumentVersionView> {
  const note = input.note?.trim() ?? '';
  if (input.decision === 'REJECTED' && note === '') {
    invalid('Say why the document is rejected.', 'note', 'REQUIRED');
  }

  const version = await prisma.orderTradeDocumentVersion.findUnique({
    where: { id: input.versionId },
    select: { id: true, documentId: true, supersededAt: true },
  });
  if (version === null) throw notFound('Document');
  if (version.supersededAt !== null) {
    throw conflict(ErrorCode.CONFLICT, 'A newer version of this document has been recorded.', [
      { code: 'SUPERSEDED' },
    ]);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.orderTradeDocumentVersion.update({
      where: { id: version.id },
      data: {
        validation: input.decision,
        validatedAt: new Date(),
        validatedByUserId: input.staffUserId,
        validationNote: note === '' ? null : note.slice(0, 1000),
      },
      select: VERSION_SELECT,
    });
    await tx.orderTradeDocumentEvent.create({
      data: {
        id: newId(),
        documentId: version.documentId,
        versionId: version.id,
        action: input.decision === 'VALID' ? 'VALIDATED' : 'REJECTED',
        actorType: 'STAFF',
        actorLabel: input.staffLabel.slice(0, 160),
        note: note === '' ? null : note.slice(0, 1000),
      },
    });
    return row;
  });

  return versionView(updated);
}
