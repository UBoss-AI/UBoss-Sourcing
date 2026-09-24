/**
 * The packing list for one consignment - one vehicle, one load.
 *
 * Built from the consignment's packages and what each holds, which the seller
 * states in `savePackages`. It refuses to issue unless the packages hold
 * EXACTLY what the consignment carries, every package has a gross weight, and
 * serialised goods list one serial per piece. Issued inside one transaction
 * with its number (PL-2026-000123, platform-wide), its PDF, the PDF's SHA-256
 * and a copy attached to the consignment for the assigned carrier - and never
 * edited afterwards. A change before collection supersedes it with a new
 * version under a new number.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { resolveTimezone, todayIn } from '../../domain/delivery-dates.js';
import { AppError, ErrorCode, conflict, notFound, type ErrorDetail } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { storage } from '../../infra/storage/index.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import type { SellerMembership } from '../seller/account.service.js';
import { recordSellerAudit } from '../seller/audit.service.js';
import {
  contentsProblems,
  ensureShipmentLines,
  loadGroup,
  loadOrderItems,
  loadOwnedShipment,
  type LoadedGroup,
  type OwnedShipment,
} from './consignment.service.js';
import { verificationCode } from './document-format.js';
import {
  PACKING_LIST_TEMPLATE_VERSION,
  renderPackingList,
  type PackingListDocument,
} from './packing-list-pdf.js';
import { discardStored } from './seller-invoice.service.js';

export const packingRenderers = { packingList: renderPackingList };

const liveKeyFor = (shipmentId: string) => `${shipmentId}:PACKING_LIST`;
const DRAFT = ['DRAFT', 'VALIDATION_REQUIRED', 'READY_TO_ISSUE'] as const;

interface Address {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  state?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  country?: string | null;
  contactName?: string | null;
}

function lines(address: Address): string[] {
  return [
    address.line1 ?? '',
    address.line2 ?? '',
    [address.city, address.region ?? address.state, address.postalCode]
      .filter((part) => (part ?? '') !== '')
      .join(', '),
    address.countryCode ?? address.country ?? '',
  ].filter((line) => line.trim() !== '');
}

interface BuiltList {
  document: PackingListDocument;
  issues: ErrorDetail[];
  totals: { packages: number; pieces: number; net: number; gross: number; volume: number };
  vehicleRegistration: string | null;
  driverReference: string | null;
  sellerInvoiceId: string | null;
  invoiceNumber: string | null;
}

async function build(
  tx: PrismaTransaction,
  shipment: OwnedShipment,
  group: LoadedGroup,
): Promise<BuiltList> {
  const issues: ErrorDetail[] = [];
  const shipmentLines = await ensureShipmentLines(tx, shipment, group);
  const packages = await tx.logisticsShipmentPackage.findMany({
    where: { shipmentId: shipment.id },
    orderBy: { sequence: 'asc' },
    include: { contents: { orderBy: { createdAt: 'asc' } } },
  });
  const items = await loadOrderItems(
    shipmentLines.map((line) => line.orderItemId),
    tx,
  );
  const byId = new Map(items.map((item) => [item.id, item]));
  const labels = new Map(items.map((item) => [item.id, item.nameSnapshot]));

  const [seller, invoice, location] = await Promise.all([
    tx.sellerAccount.findUniqueOrThrow({
      where: { id: group.sellerAccountId },
      include: { businessProfile: true },
    }),
    tx.sellerInvoice.findUnique({
      where: { liveKey: `${shipment.id}:TAX_INVOICE` },
      select: { id: true, number: true, status: true },
    }),
    group.locationId === null
      ? Promise.resolve(null)
      : tx.sellerLocation.findUnique({
          where: { id: group.locationId },
          select: { name: true, code: true, timezone: true },
        }),
  ]);

  if (['CANCELLED', 'LOST', 'RETURNED'].includes(shipment.status))
    issues.push({ field: 'consignment', code: 'CLOSED', message: 'This consignment is closed.' });
  if (
    !['ACCEPTED', 'PROCESSING', 'READY_FOR_DISPATCH', 'SHIPPED', 'DELIVERED'].includes(group.status)
  ) {
    issues.push({
      field: 'sellerOrder',
      code: 'NOT_ACCEPTED',
      message: 'Accept the order before packing it.',
    });
  }
  if (packages.every((pack) => pack.contents.length === 0)) {
    issues.push({
      field: 'packages',
      code: 'EMPTY',
      message: 'Say what goes in each package before issuing the packing list.',
    });
  } else {
    issues.push(...contentsProblems(shipmentLines, packages, labels));
  }

  for (const pack of packages) {
    if (pack.weightGrams <= 0)
      issues.push({
        field: `packages.${pack.packageReference}.weight`,
        code: 'REQUIRED',
        message: `${pack.packageReference} has no gross weight.`,
        meta: { reference: pack.packageReference },
      });
    if (pack.netWeightGrams !== null && pack.netWeightGrams > pack.weightGrams) {
      issues.push({
        field: `packages.${pack.packageReference}.netWeight`,
        code: 'INVALID',
        message: `${pack.packageReference}: net weight is above gross weight.`,
        meta: { reference: pack.packageReference },
      });
    }
    if (pack.lengthMm === null || pack.widthMm === null || pack.heightMm === null) {
      issues.push({
        field: `packages.${pack.packageReference}.dimensions`,
        code: 'REQUIRED',
        message: `${pack.packageReference} has no dimensions.`,
        meta: { reference: pack.packageReference },
      });
    }
    for (const content of pack.contents) {
      const serials = Array.isArray(content.serialNumbersJson)
        ? (content.serialNumbersJson as unknown[])
        : null;
      if (serials !== null && serials.length !== content.quantity) {
        issues.push({
          field: `packages.${pack.packageReference}.serials`,
          code: 'COUNT',
          message: `${pack.packageReference}: ${String(serials.length)} serials for ${String(content.quantity)} pieces.`,
          meta: {
            reference: pack.packageReference,
            serials: serials.length,
            pieces: content.quantity,
          },
        });
      }
    }
  }

  const driver = shipment.driverAssignments[0] ?? null;
  const booking = shipment.manualCarrierBookings[0] ?? null;
  const purchase = shipment.purchases[0] ?? null;
  const carrier =
    shipment.assignedPartner?.displayName ??
    shipment.assignedPartner?.legalName ??
    booking?.provider ??
    purchase?.provider ??
    'Not yet assigned';
  const tracking =
    shipment.carrierTrackingNumber ??
    booking?.carrierTrackingNumber ??
    purchase?.providerTrackingNumber ??
    shipment.trackingNumber;

  const totals = packages.reduce(
    (sum, pack) => ({
      packages: sum.packages + 1,
      pieces: sum.pieces + pack.contents.reduce((pieces, content) => pieces + content.quantity, 0),
      net: sum.net + (pack.netWeightGrams ?? 0),
      gross: sum.gross + pack.weightGrams,
      volume:
        sum.volume +
        (pack.lengthMm === null || pack.widthMm === null || pack.heightMm === null
          ? 0
          : Math.round((pack.lengthMm * pack.widthMm * pack.heightMm) / 1000)),
    }),
    { packages: 0, pieces: 0, net: 0, gross: 0, volume: 0 },
  );

  const describe = (orderItemId: string) => {
    const item = byId.get(orderItemId);
    return item === undefined ? orderItemId : `${item.sellerOffer?.sellerSku ?? item.skuSnapshot}`;
  };

  const handling = [
    ...(shipment.isDangerousGoods
      ? [
          `Dangerous goods${shipment.dangerousGoodsClass === null ? '' : `, class ${shipment.dangerousGoodsClass}`}. Handle and declare accordingly.`,
        ]
      : []),
    ...(shipment.requiresColdChain || shipment.requiresTemperatureRange
      ? [
          `Temperature-controlled${shipment.temperatureMinC === null || shipment.temperatureMaxC === null ? '' : `: keep between ${shipment.temperatureMinC.toString()} °C and ${shipment.temperatureMaxC.toString()} °C`}.`,
        ]
      : []),
    ...(shipment.requiresSterileHandling
      ? ['Sterile goods: do not open or puncture packaging.']
      : []),
    ...(shipment.isFragile ? ['Fragile.'] : []),
    ...(shipment.handlingNotes === null ? [] : [shipment.handlingNotes]),
  ];

  const profile = seller.businessProfile;
  const timezone = resolveTimezone(profile?.timezone, location?.timezone);
  const issueDay = todayIn(timezone);
  const pickup = shipment.pickupAddressJson as Address;
  const delivery = shipment.deliveryAddressJson as Address;

  const document: PackingListDocument = {
    number: null,
    issueDay,
    issuedAt: new Date(`${issueDay}T00:00:00.000Z`),
    shipper: {
      name: seller.legalName,
      lines: [
        ...(profile?.registeredAddressLine1 === null ||
        profile?.registeredAddressLine1 === undefined
          ? []
          : [profile.registeredAddressLine1]),
        [profile?.registeredCity, profile?.registeredPostcode, profile?.registeredCountry]
          .filter(Boolean)
          .join(', '),
      ].filter((line) => line !== ''),
    },
    consignee: {
      name: shipment.receivingCompanyName,
      lines: [
        ...(shipment.deliveryContactName === null ? [] : [`Attn: ${shipment.deliveryContactName}`]),
        ...lines(delivery),
      ],
    },
    origin: [
      location === null ? 'Seller location' : `${location.name} (${location.code})`,
      ...lines(pickup),
    ],
    destination: lines(delivery),
    facts: [
      ['Order', group.order.orderNumber],
      ['Seller order', group.sellerOrderNumber],
      ['Consignment', shipment.shipmentReference],
      ['Invoice', invoice?.number ?? 'Not yet issued'],
      ['Carrier', String(carrier)],
      ['Tracking', tracking],
      ['Vehicle', driver?.vehicle?.registration ?? '—'],
      ['Driver ref.', driver === null ? '—' : driver.driverProfileId.slice(-8)],
      [
        'Pickup',
        shipment.expectedPickupAt?.toISOString().slice(0, 10) ??
          booking?.expectedPickupAt?.toISOString().slice(0, 10) ??
          '—',
      ],
      ['Expected delivery', shipment.estimatedDeliveryAt?.toISOString().slice(0, 10) ?? '—'],
    ],
    packages: packages.map((pack) => ({
      reference: pack.packageReference,
      type: pack.packagingType ?? 'Package',
      contents: pack.contents
        .map(
          (content) =>
            `${describe(content.orderItemId)} × ${String(content.quantity)}${content.batchNumber === '' ? '' : ` (lot ${content.batchNumber})`}`,
        )
        .join('\n'),
      netWeightGrams: pack.netWeightGrams,
      grossWeightGrams: pack.weightGrams,
      dimensions:
        pack.lengthMm === null || pack.widthMm === null || pack.heightMm === null
          ? '—'
          : `${String(pack.lengthMm)} × ${String(pack.widthMm)} × ${String(pack.heightMm)}`,
      volumeCm3:
        pack.lengthMm === null || pack.widthMm === null || pack.heightMm === null
          ? null
          : Math.round((pack.lengthMm * pack.widthMm * pack.heightMm) / 1000),
      seal:
        [
          pack.containerNumber === null ? null : `Container ${pack.containerNumber}`,
          pack.sealNumber === null ? null : `Seal ${pack.sealNumber}`,
        ]
          .filter(Boolean)
          .join(' · ') || null,
    })),
    lines: shipmentLines.map((line) => {
      const item = byId.get(line.orderItemId);
      const contents = packages.flatMap((pack) =>
        pack.contents.filter((content) => content.orderItemId === line.orderItemId),
      );
      const serials = contents.flatMap((content) =>
        Array.isArray(content.serialNumbersJson) ? (content.serialNumbersJson as string[]) : [],
      );
      return {
        sku: item?.sellerOffer?.sellerSku ?? item?.skuSnapshot ?? '',
        description:
          item === undefined
            ? ''
            : item.variantNameSnapshot === null
              ? item.nameSnapshot
              : `${item.nameSnapshot} — ${item.variantNameSnapshot}`,
        quantity: line.quantity,
        unitsPerCarton: item?.packaging?.unitsPerCarton ?? null,
        cartonsPerPallet: item?.packaging?.cartonsPerPallet ?? null,
        palletsPerContainer: item?.packaging?.palletsPerContainer ?? null,
        batches: [
          ...new Set(
            contents.map((content) => content.batchNumber).filter((batch) => batch !== ''),
          ),
        ].join(', '),
        serials:
          serials.length === 0
            ? ''
            : serials.length > 6
              ? `${serials.slice(0, 6).join(', ')} … (${String(serials.length)})`
              : serials.join(', '),
        origin: item?.sellerOffer?.countryOfOrigin ?? '—',
      };
    }),
    totals: {
      packages: totals.packages,
      pieces: totals.pieces,
      netWeightGrams: totals.net,
      grossWeightGrams: totals.gross,
      volumeCm3: totals.volume,
    },
    handling,
  };

  return {
    document,
    issues,
    totals,
    vehicleRegistration: driver?.vehicle?.registration ?? null,
    driverReference: driver === null ? null : driver.driverProfileId.slice(-8),
    sellerInvoiceId: invoice !== null && invoice.status === 'ISSUED' ? invoice.id : null,
    invoiceNumber: invoice?.number ?? null,
  };
}

function snapshot(built: BuiltList): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({ ...built.document, issuedAt: built.document.issuedAt.toISOString() }),
  ) as Record<string, unknown>;
}

export async function preparePackingList(
  membership: SellerMembership,
  shipmentId: string,
): Promise<Record<string, unknown>> {
  const shipment = await loadOwnedShipment(membership.sellerAccountId, shipmentId);
  const group = await loadGroup(shipment.sellerOrderGroupId ?? '');

  const id = await prisma.$transaction(async (tx) => {
    const live = await tx.sellerPackingList.findUnique({
      where: { liveKey: liveKeyFor(shipment.id) },
    });
    if (live !== null && !(DRAFT as readonly string[]).includes(live.status)) return live.id;
    const built = await build(tx, shipment, group);
    const data = {
      status:
        built.issues.length === 0 ? ('READY_TO_ISSUE' as const) : ('VALIDATION_REQUIRED' as const),
      templateVersion: PACKING_LIST_TEMPLATE_VERSION,
      snapshotJson: snapshot(built) as never,
      validationJson: built.issues as never,
      packageCount: built.totals.packages,
      totalBaseUnits: built.totals.pieces,
      netWeightGrams: BigInt(built.totals.net),
      grossWeightGrams: BigInt(built.totals.gross),
      volumeCm3: BigInt(built.totals.volume),
      vehicleRegistration: built.vehicleRegistration,
      driverReference: built.driverReference,
      sellerInvoiceId: built.sellerInvoiceId,
    };
    if (live === null) {
      const newRowId = newId();
      await tx.sellerPackingList.create({
        data: {
          id: newRowId,
          sellerAccountId: membership.sellerAccountId,
          orderId: group.orderId,
          sellerOrderGroupId: group.id,
          logisticsShipmentId: shipment.id,
          liveKey: liveKeyFor(shipment.id),
          ...data,
        },
      });
      return newRowId;
    }
    await tx.sellerPackingList.update({ where: { id: live.id }, data });
    return live.id;
  });

  return readPackingList(membership.sellerAccountId, id);
}

export async function packingListPdfForSeller(
  membership: SellerMembership,
  shipmentId: string,
  correlationId: string | null,
): Promise<{ bytes: Buffer; fileName: string; issued: boolean }> {
  const shipment = await loadOwnedShipment(membership.sellerAccountId, shipmentId);
  const live = await prisma.sellerPackingList.findUnique({
    where: { liveKey: liveKeyFor(shipment.id) },
  });
  if (live !== null && live.storageKey !== null && live.number !== null) {
    return {
      bytes: await storage.get(live.storageKey),
      fileName: `${live.number}.pdf`,
      issued: true,
    };
  }
  const group = await loadGroup(shipment.sellerOrderGroupId ?? '');
  const built = await prisma.$transaction((tx) => build(tx, shipment, group));
  const { bytes } = await packingRenderers.packingList(built.document, { draft: true });
  await recordAudit({
    action: AuditAction.PACKING_LIST_PREVIEWED,
    resourceType: 'logistics_shipment',
    resourceId: shipment.id,
    actorType: 'CUSTOMER',
    after: { issues: built.issues.length, sellerAccountId: membership.sellerAccountId },
    correlationId,
  });
  return { bytes, fileName: `draft-packing-list-${shipment.shipmentReference}.pdf`, issued: false };
}

async function nextPackingListNumber(tx: PrismaTransaction): Promise<string> {
  const year = new Date().getUTCFullYear();
  const key = `packing-list:${String(year)}`;
  await tx.numberSequence.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1, prefix: 'PL', padding: 6 },
  });
  const row = await tx.numberSequence.findUniqueOrThrow({ where: { key } });
  return `PL-${String(year)}-${row.value.toString().padStart(row.padding, '0')}`;
}

/** Issue inside the caller's transaction. An issued list is returned as it is. */
export async function issuePackingListInTx(
  tx: PrismaTransaction,
  membership: SellerMembership,
  shipment: OwnedShipment,
  stored: string[],
  correlationId: string | null,
): Promise<{ id: string; number: string; created: boolean }> {
  const live = await tx.sellerPackingList.findUnique({
    where: { liveKey: liveKeyFor(shipment.id) },
  });
  if (
    live !== null &&
    live.number !== null &&
    !(DRAFT as readonly string[]).includes(live.status)
  ) {
    return { id: live.id, number: live.number, created: false };
  }

  const group = await loadGroup(shipment.sellerOrderGroupId ?? '', tx);
  const built = await build(tx, shipment, group);
  if (built.issues.length > 0) {
    throw new AppError({
      statusCode: 422,
      code: ErrorCode.SELLER_DOCUMENT_VALIDATION_FAILED,
      message: 'The packing list cannot be issued until these are fixed.',
      details: built.issues,
    });
  }

  const number = await nextPackingListNumber(tx);
  const issuedAt = new Date();
  built.document.number = number;
  built.document.issuedAt = issuedAt;

  let rendered: { bytes: Buffer; pageCount: number };
  try {
    rendered = await packingRenderers.packingList(built.document, { draft: false });
  } catch (error) {
    throw new AppError({
      statusCode: 500,
      code: ErrorCode.DOCUMENT_RENDER_FAILED,
      message: 'The packing list PDF could not be produced. Nothing was issued.',
      cause: error,
    });
  }

  const object = await storage.put(rendered.bytes, 'application/pdf', 'pdf', 'private');
  stored.push(object.storageKey);
  const contentHash = createHash('sha256').update(rendered.bytes).digest('hex');

  const documentId = newId();
  await tx.logisticsShipmentDocument.create({
    data: {
      id: documentId,
      shipmentId: shipment.id,
      kind: 'PACKING_LIST',
      // The carrier holding the consignment needs it, and it carries no prices.
      audience: 'BOTH',
      fileName: `${number}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: rendered.bytes.length,
      storageKey: object.storageKey,
      contentHash,
      scanState: 'GENERATED',
      scannedAt: issuedAt,
      scanDetail: 'Generated by this server from the issued packing list.',
      uploadedBySource: 'SYSTEM_AUTOMATION',
    },
  });

  const data = {
    status: 'ISSUED' as const,
    number,
    templateVersion: PACKING_LIST_TEMPLATE_VERSION,
    issuedAt,
    issuedByLabel: membership.displayName.slice(0, 160),
    snapshotJson: snapshot(built) as never,
    validationJson: [] as never,
    packageCount: built.totals.packages,
    totalBaseUnits: built.totals.pieces,
    netWeightGrams: BigInt(built.totals.net),
    grossWeightGrams: BigInt(built.totals.gross),
    volumeCm3: BigInt(built.totals.volume),
    vehicleRegistration: built.vehicleRegistration,
    driverReference: built.driverReference,
    sellerInvoiceId: built.sellerInvoiceId,
    verificationCode: verificationCode('packing-list', number),
    storageKey: object.storageKey,
    contentHash,
    sizeBytes: rendered.bytes.length,
    pageCount: rendered.pageCount,
    logisticsDocumentId: documentId,
  };

  let id: string;
  if (live === null) {
    id = newId();
    await tx.sellerPackingList.create({
      data: {
        id,
        sellerAccountId: membership.sellerAccountId,
        orderId: group.orderId,
        sellerOrderGroupId: group.id,
        logisticsShipmentId: shipment.id,
        liveKey: liveKeyFor(shipment.id),
        ...data,
      },
    });
  } else {
    id = live.id;
    const updated = await tx.sellerPackingList.updateMany({
      where: { id: live.id, status: { in: [...DRAFT] } },
      data,
    });
    if (updated.count !== 1)
      throw conflict(
        ErrorCode.SELLER_DOCUMENT_IMMUTABLE,
        'This packing list was issued a moment ago.',
        [{ code: 'ALREADY_ISSUED' }],
      );
  }

  await recordAudit(
    {
      action: AuditAction.PACKING_LIST_ISSUED,
      resourceType: 'seller_packing_list',
      resourceId: id,
      actorType: 'CUSTOMER',
      after: {
        number,
        shipmentId: shipment.id,
        packages: built.totals.packages,
        pieces: built.totals.pieces,
        contentHash,
      },
      correlationId,
    },
    tx,
  );
  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'packing_list.issued',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_packing_list',
    resourceId: id,
    after: { number, contentHash },
    summary: `Issued packing list ${number} for ${shipment.shipmentReference}`,
    tx,
  });

  return { id, number, created: true };
}

export async function issuePackingList(
  membership: SellerMembership,
  shipmentId: string,
  correlationId: string | null,
): Promise<Record<string, unknown>> {
  const shipment = await loadOwnedShipment(membership.sellerAccountId, shipmentId);
  const stored: string[] = [];
  let result: { id: string };
  try {
    result = await prisma.$transaction(
      (tx) => issuePackingListInTx(tx, membership, shipment, stored, correlationId),
      { timeout: 30_000 },
    );
  } catch (error) {
    await discardStored(stored);
    throw error;
  }
  return readPackingList(membership.sellerAccountId, result.id);
}

export const supersedeInputSchema = z
  .object({ reason: z.string().trim().min(3).max(1000) })
  .strict();

/**
 * Retire an issued packing list so the load can be re-packed and a new one
 * issued. Allowed only before the carrier has scanned anything out.
 */
export async function supersedePackingList(
  membership: SellerMembership,
  shipmentId: string,
  input: z.infer<typeof supersedeInputSchema>,
  correlationId: string | null,
): Promise<void> {
  const shipment = await loadOwnedShipment(membership.sellerAccountId, shipmentId);
  const scanned = await prisma.logisticsShipmentPackage.count({
    where: { shipmentId: shipment.id, scannedOutAt: { not: null } },
  });
  if (scanned > 0)
    throw conflict(
      ErrorCode.SHIPMENT_PACKAGES_LOCKED,
      'The carrier has already collected packages under this packing list.',
      [{ code: 'SCANNED' }],
    );
  const live = await prisma.sellerPackingList.findUnique({
    where: { liveKey: liveKeyFor(shipment.id) },
  });
  if (live === null || live.status !== 'ISSUED') throw notFound('Issued packing list');

  await prisma.$transaction(async (tx) => {
    const updated = await tx.sellerPackingList.updateMany({
      where: { id: live.id, status: 'ISSUED' },
      data: { status: 'SUPERSEDED', liveKey: null, voidReason: input.reason, voidedAt: new Date() },
    });
    if (updated.count !== 1)
      throw conflict(
        ErrorCode.SELLER_DOCUMENT_IMMUTABLE,
        'This packing list changed a moment ago.',
        [{ code: 'STALE' }],
      );
    // The carrier's copy is withdrawn from the consignment; the row stays as evidence.
    if (live.logisticsDocumentId !== null) {
      await tx.logisticsShipmentDocument.update({
        where: { id: live.logisticsDocumentId },
        data: { deletedAt: new Date() },
      });
    }
    await tx.logisticsShipment.update({ where: { id: shipment.id }, data: { packedAt: null } });
    await recordAudit(
      {
        action: AuditAction.PACKING_LIST_SUPERSEDED,
        resourceType: 'seller_packing_list',
        resourceId: live.id,
        actorType: 'CUSTOMER',
        before: { number: live.number },
        after: { reason: input.reason },
        correlationId,
      },
      tx,
    );
    await recordSellerAudit({
      sellerAccountId: membership.sellerAccountId,
      action: 'packing_list.superseded',
      actor: { type: 'CUSTOMER', label: membership.displayName },
      resourceType: 'seller_packing_list',
      resourceId: live.id,
      summary: `Superseded packing list ${live.number ?? ''}`,
      tx,
    });
  });
}

type ListRow = NonNullable<Awaited<ReturnType<typeof prisma.sellerPackingList.findUnique>>>;

export function serialisePackingList(
  row: ListRow,
  audience: 'SELLER' | 'BUYER' | 'ADMIN' | 'LOGISTICS',
): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    number: row.number,
    shipmentId: row.logisticsShipmentId,
    orderId: row.orderId,
    issuedAt: row.issuedAt?.toISOString() ?? null,
    packageCount: row.packageCount,
    totalBaseUnits: row.totalBaseUnits,
    netWeightGrams: row.netWeightGrams.toString(),
    grossWeightGrams: row.grossWeightGrams.toString(),
    volumeCm3: row.volumeCm3.toString(),
    vehicleRegistration: audience === 'BUYER' ? null : row.vehicleRegistration,
    driverReference: audience === 'BUYER' ? null : row.driverReference,
    snapshot: audience === 'BUYER' ? null : row.snapshotJson,
    validation: audience === 'SELLER' ? row.validationJson : null,
    contentHash: row.contentHash,
    pageCount: row.pageCount,
    voidReason: row.voidReason,
  };
}

export async function readPackingList(
  sellerAccountId: string,
  id: string,
): Promise<Record<string, unknown>> {
  const row = await prisma.sellerPackingList.findUnique({ where: { id } });
  if (row === null || row.sellerAccountId !== sellerAccountId) throw notFound('Packing list');
  return serialisePackingList(row, 'SELLER');
}
