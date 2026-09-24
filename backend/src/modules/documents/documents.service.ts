/**
 * The seller documents, as each audience reaches them.
 *
 *   Seller     every document on their own consignments: prepare, preview,
 *              issue, credit, supersede, download, batch-download.
 *   Buyer      issued invoices and credit notes on their own orders, and a
 *              packing SUMMARY (package count, weights) - not the carrier's
 *              document with its handling and vehicle details.
 *   Carrier    the packing list, through its own portal's document list
 *              (`logistics_shipment_documents`, audience BOTH). Never the
 *              invoice, which is OPERATOR-only.
 *   Operator   everything, read-only, under `invoice.read`.
 *
 * Downloads go through a single-use token that lives five minutes, is bound to
 * the person who asked for it and to one document, and whose SHA-256 is all
 * that is stored - the same pattern the logistics portal and the report
 * exports use. A download is audited.
 */
import { z } from 'zod';

import { env } from '../../config/env.js';
import { ErrorCode, conflict, forbidden, notFound } from '../../domain/errors.js';
import { generateToken, sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { storage } from '../../infra/storage/index.js';
import { zipStored } from '../../infra/zip.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import type { SellerMembership } from '../seller/account.service.js';
import { recordSellerAudit } from '../seller/audit.service.js';
import {
  loadGroup,
  loadOrderItems,
  loadOwnedShipment,
  packagesLockReason,
} from './consignment.service.js';
import { verificationCode, type VerifiableKind } from './document-format.js';
import { issuePackingListInTx, serialisePackingList } from './packing-list.service.js';
import { discardStored, issueInvoiceInTx, serialiseInvoice } from './seller-invoice.service.js';

export type DocumentKind = 'invoice' | 'packing-list';

// ---------------------------------------------------------------------------
// The seller's view
// ---------------------------------------------------------------------------

async function consignmentView(
  sellerAccountId: string,
  shipmentId: string,
): Promise<Record<string, unknown>> {
  const shipment = await loadOwnedShipment(sellerAccountId, shipmentId);
  const group = await loadGroup(shipment.sellerOrderGroupId ?? '');
  const items = await loadOrderItems(group.lines.map((line) => line.orderItemId));
  const byId = new Map(items.map((item) => [item.id, item]));

  const [invoices, lists, lock] = await Promise.all([
    prisma.sellerInvoice.findMany({
      where: { logisticsShipmentId: shipment.id },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.sellerPackingList.findMany({
      where: { logisticsShipmentId: shipment.id },
      orderBy: { createdAt: 'asc' },
    }),
    packagesLockReason(shipment.id),
  ]);

  const label = (orderItemId: string) => {
    const item = byId.get(orderItemId);
    return {
      name:
        item === undefined
          ? ''
          : item.variantNameSnapshot === null
            ? item.nameSnapshot
            : `${item.nameSnapshot} — ${item.variantNameSnapshot}`,
      sku: item?.sellerOffer?.sellerSku ?? item?.skuSnapshot ?? '',
      hsn: item?.sellerOffer?.hsnCode ?? null,
    };
  };

  return {
    id: shipment.id,
    shipmentReference: shipment.shipmentReference,
    status: shipment.status,
    packedAt: shipment.packedAt?.toISOString() ?? null,
    splitFromShipmentId: shipment.splitFromShipmentId,
    packagesLocked: lock,
    lines: shipment.lines.map((line) => ({
      orderItemId: line.orderItemId,
      quantity: line.quantity,
      ...label(line.orderItemId),
    })),
    packages: shipment.packages.map((pack) => ({
      id: pack.id,
      reference: pack.packageReference,
      packagingType: pack.packagingType,
      lengthMm: pack.lengthMm,
      widthMm: pack.widthMm,
      heightMm: pack.heightMm,
      grossWeightGrams: pack.weightGrams,
      netWeightGrams: pack.netWeightGrams,
      containerNumber: pack.containerNumber,
      sealNumber: pack.sealNumber,
      scannedOutAt: pack.scannedOutAt?.toISOString() ?? null,
      contents: pack.contents.map((content) => ({
        orderItemId: content.orderItemId,
        quantity: content.quantity,
        batchNumber: content.batchNumber,
        expiryDate: content.expiryDate?.toISOString().slice(0, 10) ?? null,
        serialNumbers: content.serialNumbersJson,
      })),
    })),
    invoices: invoices.map((row) => serialiseInvoice(row, 'SELLER')),
    packingLists: lists.map((row) => serialisePackingList(row, 'SELLER')),
  };
}

export async function readConsignmentDocuments(
  membership: SellerMembership,
  shipmentId: string,
): Promise<Record<string, unknown>> {
  return consignmentView(membership.sellerAccountId, shipmentId);
}

/** Every consignment of one seller order, with its documents. */
export async function readSellerOrderDocuments(
  membership: SellerMembership,
  groupId: string,
): Promise<Record<string, unknown>> {
  const group = await prisma.sellerOrderGroup.findUnique({
    where: { id: groupId },
    select: { id: true, sellerAccountId: true, orderId: true },
  });
  if (group === null || group.sellerAccountId !== membership.sellerAccountId)
    throw notFound('Order');
  const shipments = await prisma.logisticsShipment.findMany({
    where: { sellerOrderGroupId: group.id, sellerAccountId: membership.sellerAccountId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return {
    consignments: await Promise.all(
      shipments.map((shipment) => consignmentView(membership.sellerAccountId, shipment.id)),
    ),
  };
}

// ---------------------------------------------------------------------------
// Mark packed
// ---------------------------------------------------------------------------

/**
 * Mark a consignment packed - which means its invoice AND packing list are
 * validated and issued. One transaction: the invoice (if not already issued),
 * the packing list, and `packedAt`. A failure anywhere - a missing HSN, a
 * package whose contents do not add up, a PDF that will not render, storage
 * that will not take the file - rolls back all of it, returns both numbers to
 * their counters, and leaves the consignment unpacked.
 */
export async function packConsignment(
  membership: SellerMembership,
  shipmentId: string,
  correlationId: string | null,
): Promise<Record<string, unknown>> {
  const shipment = await loadOwnedShipment(membership.sellerAccountId, shipmentId);
  if (shipment.packedAt !== null) return consignmentView(membership.sellerAccountId, shipment.id);

  const stored: string[] = [];
  try {
    await prisma.$transaction(
      async (tx) => {
        const invoice = await issueInvoiceInTx(tx, membership, shipment, stored, correlationId);
        const list = await issuePackingListInTx(tx, membership, shipment, stored, correlationId);
        // The list must name the invoice it travels under.
        await tx.sellerPackingList.update({
          where: { id: list.id },
          data: { sellerInvoiceId: invoice.id },
        });

        const packed = await tx.logisticsShipment.updateMany({
          where: { id: shipment.id, packedAt: null },
          data: { packedAt: new Date() },
        });
        if (packed.count !== 1) {
          throw conflict(
            ErrorCode.SELLER_DOCUMENT_IMMUTABLE,
            'This consignment was marked packed a moment ago.',
            [{ code: 'ALREADY_PACKED' }],
          );
        }

        await recordAudit(
          {
            action: AuditAction.CONSIGNMENT_PACKED,
            resourceType: 'logistics_shipment',
            resourceId: shipment.id,
            actorType: 'CUSTOMER',
            after: { invoiceNumber: invoice.number, packingListNumber: list.number },
            correlationId,
          },
          tx,
        );
        await recordSellerAudit({
          sellerAccountId: membership.sellerAccountId,
          action: 'consignment.packed',
          actor: { type: 'CUSTOMER', label: membership.displayName },
          resourceType: 'logistics_shipment',
          resourceId: shipment.id,
          summary: `${shipment.shipmentReference} packed under ${invoice.number} and ${list.number}`,
          tx,
        });
      },
      { timeout: 45_000 },
    );
  } catch (error) {
    await discardStored(stored);
    throw error;
  }

  const { dispatchPendingNotifications } = await import('../notifications/notification.service.js');
  await dispatchPendingNotifications();
  return consignmentView(membership.sellerAccountId, shipment.id);
}

// ---------------------------------------------------------------------------
// Download links
// ---------------------------------------------------------------------------

interface Located {
  kind: DocumentKind;
  id: string;
  storageKey: string;
  fileName: string;
  sellerAccountId: string;
  orderId: string;
  customerProfileId: string;
}

async function locate(kind: DocumentKind, id: string): Promise<Located | null> {
  if (kind === 'invoice') {
    const row = await prisma.sellerInvoice.findUnique({
      where: { id },
      include: { order: { select: { customerProfileId: true } } },
    });
    if (row === null || row.storageKey === null || row.number === null) return null;
    return {
      kind,
      id,
      storageKey: row.storageKey,
      fileName: `${row.number.replace(/\//g, '-')}.pdf`,
      sellerAccountId: row.sellerAccountId,
      orderId: row.orderId,
      customerProfileId: row.order.customerProfileId,
    };
  }
  const row = await prisma.sellerPackingList.findUnique({
    where: { id },
    include: { order: { select: { customerProfileId: true } } },
  });
  if (row === null || row.storageKey === null || row.number === null) return null;
  return {
    kind,
    id,
    storageKey: row.storageKey,
    fileName: `${row.number}.pdf`,
    sellerAccountId: row.sellerAccountId,
    orderId: row.orderId,
    customerProfileId: row.order.customerProfileId,
  };
}

type Audience = 'seller' | 'buyer' | 'admin';

async function mintLink(
  userId: string,
  audience: Audience,
  kind: DocumentKind | 'batch',
  id: string,
): Promise<{ url: string; expiresAt: string }> {
  const { token } = generateToken(32);
  const expiresAt = new Date(Date.now() + env.LOGISTICS_DOCUMENT_URL_TTL_SECONDS * 1000);
  await prisma.authToken.create({
    data: {
      id: newId(),
      userId,
      type: 'EMAIL_VERIFICATION',
      tokenHash: sha256Hex(`seller-document:${audience}:${kind}:${id}:${token}`),
      expiresAt,
      createdById: userId,
    },
  });
  const base = audience === 'admin' ? '/api/v1/admin/documents' : '/api/v1/documents';
  return {
    url: `${base}/${kind}/${id}/download?token=${token}`,
    expiresAt: expiresAt.toISOString(),
  };
}

async function redeemToken(
  userId: string,
  audience: Audience,
  kind: DocumentKind | 'batch',
  id: string,
  token: string,
): Promise<void> {
  const record = await prisma.authToken.findUnique({
    where: { tokenHash: sha256Hex(`seller-document:${audience}:${kind}:${id}:${token}`) },
    select: { id: true, userId: true, expiresAt: true, consumedAt: true },
  });
  if (
    record === null ||
    record.userId !== userId ||
    record.consumedAt !== null ||
    record.expiresAt.getTime() <= Date.now()
  ) {
    throw forbidden(ErrorCode.TOKEN_INVALID, 'This download link is no longer valid.');
  }
  const consumed = await prisma.authToken.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1)
    throw forbidden(ErrorCode.TOKEN_INVALID, 'This download link is no longer valid.');
}

async function auditDownload(
  located: Located,
  audience: Audience,
  userId: string,
  correlationId: string | null,
): Promise<void> {
  await recordAudit({
    action: AuditAction.SELLER_DOCUMENT_DOWNLOADED,
    resourceType: located.kind === 'invoice' ? 'seller_invoice' : 'seller_packing_list',
    resourceId: located.id,
    actorType: audience === 'admin' ? 'ADMIN' : 'CUSTOMER',
    actorUserId: userId,
    after: { audience, fileName: located.fileName },
    correlationId,
  });
}

/** May this audience have this document? Answered as "not found" when not. */
function authorise(
  located: Located | null,
  audience: Audience,
  subject: { sellerAccountId?: string; customerProfileId?: string },
): Located {
  if (located === null) throw notFound('Document');
  if (audience === 'seller' && located.sellerAccountId !== subject.sellerAccountId)
    throw notFound('Document');
  if (audience === 'buyer') {
    // A buyer receives invoices and credit notes, never the carrier's packing list.
    if (located.kind !== 'invoice' || located.customerProfileId !== subject.customerProfileId)
      throw notFound('Document');
  }
  return located;
}

export async function sellerDocumentLink(
  membership: SellerMembership,
  userId: string,
  kind: DocumentKind,
  id: string,
) {
  authorise(await locate(kind, id), 'seller', { sellerAccountId: membership.sellerAccountId });
  return mintLink(userId, 'seller', kind, id);
}

export async function buyerDocumentLink(
  customerProfileId: string,
  userId: string,
  kind: DocumentKind,
  id: string,
) {
  authorise(await locate(kind, id), 'buyer', { customerProfileId });
  return mintLink(userId, 'buyer', kind, id);
}

export async function adminDocumentLink(userId: string, kind: DocumentKind, id: string) {
  authorise(await locate(kind, id), 'admin', {});
  return mintLink(userId, 'admin', kind, id);
}

/**
 * Hand over the bytes of a customer-surface link (seller or buyer). The session
 * is checked as well as the token, so a forwarded link does not work for
 * anybody else - and the ownership is checked again at the moment of reading.
 */
export async function redeemCustomerDocument(input: {
  userId: string;
  customerProfileId: string;
  sellerAccountId: string | null;
  kind: DocumentKind;
  id: string;
  token: string;
  correlationId: string | null;
}): Promise<{ bytes: Buffer; fileName: string }> {
  const located = await locate(input.kind, input.id);
  let audience: Audience;
  if (
    located !== null &&
    input.sellerAccountId !== null &&
    located.sellerAccountId === input.sellerAccountId
  ) {
    audience = 'seller';
    await redeemToken(input.userId, 'seller', input.kind, input.id, input.token);
  } else {
    audience = 'buyer';
    authorise(located, 'buyer', { customerProfileId: input.customerProfileId });
    await redeemToken(input.userId, 'buyer', input.kind, input.id, input.token);
  }
  const found = located as Located;
  await auditDownload(found, audience, input.userId, input.correlationId);
  return { bytes: await storage.get(found.storageKey), fileName: found.fileName };
}

export async function redeemAdminDocument(input: {
  userId: string;
  kind: DocumentKind;
  id: string;
  token: string;
  correlationId: string | null;
}) {
  const located = authorise(await locate(input.kind, input.id), 'admin', {});
  await redeemToken(input.userId, 'admin', input.kind, input.id, input.token);
  await auditDownload(located, 'admin', input.userId, input.correlationId);
  return { bytes: await storage.get(located.storageKey), fileName: located.fileName };
}

// --- Batch -------------------------------------------------------------------------

export const batchInputSchema = z
  .object({
    documents: z
      .array(z.object({ kind: z.enum(['invoice', 'packing-list']), id: z.string().length(26) }))
      .min(1)
      .max(100),
  })
  .strict();

/**
 * One ZIP of several of the seller's own issued documents.
 *
 * Stateless, so it works across processes and restarts: the link carries the
 * document list, and the token's hash binds to a digest of exactly that list,
 * so the list cannot be edited after the link is minted. Every member is
 * re-checked for ownership when the link is redeemed.
 */
function batchDigest(documents: readonly { kind: DocumentKind; id: string }[]): string {
  return sha256Hex(documents.map((document) => `${document.kind}:${document.id}`).join(',')).slice(
    0,
    26,
  );
}

export function parseBatchDocuments(value: string): { kind: DocumentKind; id: string }[] {
  return value
    .split(',')
    .filter((part) => part !== '')
    .slice(0, 100)
    .map((part) => {
      const [kind = '', id = ''] = part.split(':');
      if ((kind !== 'invoice' && kind !== 'packing-list') || id.length !== 26) {
        throw forbidden(ErrorCode.TOKEN_INVALID, 'This download link is no longer valid.');
      }
      return { kind, id };
    });
}

export async function sellerBatchLink(
  membership: SellerMembership,
  userId: string,
  input: z.infer<typeof batchInputSchema>,
) {
  for (const document of input.documents) {
    authorise(await locate(document.kind, document.id), 'seller', {
      sellerAccountId: membership.sellerAccountId,
    });
  }
  const digest = batchDigest(input.documents);
  const link = await mintLink(userId, 'seller', 'batch', digest);
  const docs = input.documents.map((document) => `${document.kind}:${document.id}`).join(',');
  return { ...link, url: `${link.url}&docs=${encodeURIComponent(docs)}` };
}

export async function redeemSellerBatch(input: {
  userId: string;
  sellerAccountId: string;
  batchId: string;
  documents: { kind: DocumentKind; id: string }[];
  token: string;
  correlationId: string | null;
}) {
  if (batchDigest(input.documents) !== input.batchId)
    throw forbidden(ErrorCode.TOKEN_INVALID, 'This download link is no longer valid.');
  await redeemToken(input.userId, 'seller', 'batch', input.batchId, input.token);

  const entries: { name: string; bytes: Buffer }[] = [];
  for (const document of input.documents) {
    const located = authorise(await locate(document.kind, document.id), 'seller', {
      sellerAccountId: input.sellerAccountId,
    });
    entries.push({ name: located.fileName, bytes: await storage.get(located.storageKey) });
    await auditDownload(located, 'seller', input.userId, input.correlationId);
  }
  return {
    bytes: zipStored(entries, new Date()),
    fileName: `documents-${new Date().toISOString().slice(0, 10)}.zip`,
  };
}

// ---------------------------------------------------------------------------
// The buyer's and the operator's lists
// ---------------------------------------------------------------------------

export async function listBuyerOrderDocuments(
  customerProfileId: string,
  orderId: string,
): Promise<Record<string, unknown>> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { customerProfileId: true },
  });
  if (order === null || order.customerProfileId !== customerProfileId) throw notFound('Order');
  const [invoices, lists] = await Promise.all([
    prisma.sellerInvoice.findMany({
      where: { orderId, status: { in: ['ISSUED', 'VOIDED', 'CREDIT_NOTE_REQUIRED'] } },
      orderBy: { issuedAt: 'asc' },
      include: { sellerAccount: { select: { displayName: true } } },
    }),
    prisma.sellerPackingList.findMany({
      where: { orderId, status: 'ISSUED' },
      orderBy: { issuedAt: 'asc' },
    }),
  ]);
  return {
    invoices: invoices.map((row) => ({
      ...serialiseInvoice(row, 'BUYER'),
      sellerName: row.sellerAccount.displayName,
    })),
    packing: lists.map((row) => serialisePackingList(row, 'BUYER')),
  };
}

export async function listAdminOrderDocuments(orderId: string): Promise<Record<string, unknown>> {
  const [invoices, lists] = await Promise.all([
    prisma.sellerInvoice.findMany({
      where: { orderId, status: { notIn: ['DRAFT', 'VALIDATION_REQUIRED', 'READY_TO_ISSUE'] } },
      orderBy: { createdAt: 'asc' },
      include: { sellerAccount: { select: { displayName: true } } },
    }),
    prisma.sellerPackingList.findMany({
      where: { orderId, status: { notIn: ['DRAFT', 'VALIDATION_REQUIRED', 'READY_TO_ISSUE'] } },
      orderBy: { createdAt: 'asc' },
      include: { sellerAccount: { select: { displayName: true } } },
    }),
  ]);
  return {
    invoices: invoices.map((row) => ({
      ...serialiseInvoice(row, 'ADMIN'),
      sellerName: row.sellerAccount.displayName,
    })),
    packingLists: lists.map((row) => ({
      ...serialisePackingList(row, 'ADMIN'),
      sellerName: row.sellerAccount.displayName,
    })),
  };
}

// ---------------------------------------------------------------------------
// Public verification
// ---------------------------------------------------------------------------

/**
 * Is this a document this deployment issued? Answers only what is printed on
 * the document already - its number, kind, status, date and issuer. No buyer,
 * no amounts.
 */
export async function verifyDocument(
  kind: VerifiableKind,
  number: string,
  code: string,
): Promise<Record<string, unknown>> {
  const given = code.toUpperCase();

  if (kind === 'invoice') {
    // Several sellers may use the same number; the code names which one.
    const candidates = await prisma.sellerInvoice.findMany({
      where: { number },
      take: 50,
      select: {
        sellerAccountId: true,
        status: true,
        kind: true,
        issuedAt: true,
        sellerAccount: { select: { legalName: true } },
      },
    });
    const row =
      candidates.find(
        (candidate) => verificationCode('invoice', number, candidate.sellerAccountId) === given,
      ) ?? null;
    if (row === null) return { valid: false };
    return {
      valid: true,
      kind: row.kind,
      number,
      status: row.status,
      issuedAt: row.issuedAt?.toISOString() ?? null,
      issuer: row.sellerAccount.legalName,
    };
  }
  if (given !== verificationCode(kind, number)) return { valid: false };
  const row = await prisma.sellerPackingList.findUnique({
    where: { number },
    select: {
      status: true,
      issuedAt: true,
      packageCount: true,
      sellerAccount: { select: { legalName: true } },
    },
  });
  if (row === null) return { valid: false };
  return {
    valid: true,
    kind: 'PACKING_LIST',
    number,
    status: row.status,
    issuedAt: row.issuedAt?.toISOString() ?? null,
    issuer: row.sellerAccount.legalName,
    packageCount: row.packageCount,
  };
}
