/**
 * A seller's tax invoice, for one consignment.
 *
 * WHO ISSUES IT. The seller, in their own legal name, under their own tax
 * registration, in their own numbered series - because on this marketplace the
 * seller is the supplier of the goods. Glovia appears on the document only as
 * the platform it was issued through, and says it is not the supplier.
 *
 * WHERE THE FIGURES COME FROM. The order line the buyer was charged against,
 * frozen at checkout, and nothing else: no client payload, no live price, no
 * recomputed tax. `domain/seller-invoice.ts` apportions a line across the
 * consignments that carry it so the invoices add up to the order exactly.
 *
 * WHAT MAKES IT FINAL. `issueInvoice` validates, allocates the number from a
 * locked counter, renders the PDF, stores it, records its SHA-256 and attaches
 * it to the consignment - all in ONE transaction. If rendering or storage
 * fails, the number is returned with the rollback and nothing is issued. A
 * live key per consignment makes a second issue return the first; an issued
 * invoice is never rewritten, and the only correction is a credit note.
 */
import type { SellerDocumentStatus } from '../../generated/prisma/enums.js';
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { resolveTimezone, todayIn } from '../../domain/delivery-dates.js';
import { ErrorCode, AppError, conflict, notFound, type ErrorDetail } from '../../domain/errors.js';
import {
  amountInWords,
  checkGstin,
  financialYear,
  GST_STATE_CODES,
  isValidHsn,
  placeOfSupply,
  splitGst,
  stateCodeForName,
  type GstSupplyType,
} from '../../domain/gst.js';
import {
  NOTHING_INVOICED,
  invoiceTotals,
  normaliseRate,
  shareOfLine,
  taxBreakdown,
  type AlreadyInvoiced,
  type LineShare,
} from '../../domain/seller-invoice.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { storage } from '../../infra/storage/index.js';
import { env } from '../../config/env.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  NotificationEvent,
  dispatchPendingNotifications,
  enqueueNotification,
} from '../notifications/notification.service.js';
import type { SellerMembership } from '../seller/account.service.js';
import { recordSellerAudit } from '../seller/audit.service.js';
import { notifySeller, resolveSellerNotifications } from '../seller/notification.service.js';
import {
  INVOICEABLE_GROUP,
  INVOICEABLE_ORDER,
  ensureShipmentLines,
  loadGroup,
  loadOrderItems,
  loadOwnedShipment,
  type LoadedGroup,
  type LoadedItem,
  type OwnedShipment,
} from './consignment.service.js';
import { formatAmount } from './document-format.js';
import {
  INVOICE_TEMPLATE_VERSION,
  renderInvoice,
  type InvoiceDocument,
  type InvoiceParty,
} from './invoice-pdf.js';

/**
 * The renderer, behind an object so a test can make it fail and prove that a
 * failed render issues nothing and marks nothing packed.
 */
export const renderers = { invoice: renderInvoice };

const EU_COUNTRIES = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
]);

type Jurisdiction = 'IN_GST' | 'EU_VAT' | 'GENERIC';

interface AddressSnapshot {
  contactName?: string | null;
  contactPhone?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

function addressLines(address: AddressSnapshot): string[] {
  return [
    address.line1 ?? '',
    address.line2 ?? '',
    [address.city, address.state, address.postalCode]
      .filter((part) => (part ?? '') !== '')
      .join(', '),
    address.country ?? '',
  ].filter((line) => line.trim() !== '');
}

export interface StoredInvoiceLine {
  orderItemId: string;
  description: string;
  sku: string;
  hsn: string | null;
  countryOfOrigin: string | null;
  orderedAs: string | null;
  quantity: number;
  unitPriceMinor: string;
  subtotalMinor: string;
  discountMinor: string;
  taxableMinor: string;
  ratePercent: string;
  cgstMinor: string;
  sgstMinor: string;
  igstMinor: string;
  taxMinor: string;
  totalMinor: string;
}

interface Built {
  sellerAccountId: string;
  jurisdiction: Jurisdiction;
  supplyType: string;
  gstSupplyType: GstSupplyType | null;
  reverseCharge: boolean;
  currency: string;
  seller: InvoiceParty & { legalName: string; json: Record<string, unknown> };
  buyer: InvoiceParty & { json: Record<string, unknown> };
  shipTo: InvoiceParty & { json: Record<string, unknown> };
  placeOfSupply: Record<string, unknown> | null;
  lines: StoredInvoiceLine[];
  shares: LineShare[];
  taxRows: ReturnType<typeof taxBreakdown>;
  totals: ReturnType<typeof invoiceTotals>;
  issues: ErrorDetail[];
  issueDay: string;
  timezone: string;
  settings: {
    invoiceSeries: string;
    creditNoteSeries: string;
    financialYearStartMonth: number;
    signatoryName: string | null;
    signatoryDesignation: string | null;
    lutReference: string | null;
    footerNotes: string | null;
  };
  facts: [string, string][];
  declarations: string[];
}

/**
 * One thing stopping the invoice. `field` + `code` is the stable pair both
 * frontends translate (with `meta` filling the blanks); `message` is the
 * English for API clients.
 */
function issue(
  field: string,
  code: string,
  message: string,
  meta?: Record<string, string | number>,
): ErrorDetail {
  return meta === undefined ? { field, code, message } : { field, code, message, meta };
}

function orderedAs(item: LoadedItem): string | null {
  const packaging = item.packaging;
  if (packaging === null) return null;
  const word =
    packaging.packageType === 'CARTON'
      ? 'carton'
      : packaging.packageType === 'CONTAINER'
        ? 'container'
        : 'pallet';
  return `Ordered as ${String(packaging.packageQuantity)} × ${word} of ${String(packaging.unitsPerPackage)}`;
}

function toPrior(
  lines: StoredInvoiceLine[],
  orderItemId: string,
  into: AlreadyInvoiced,
): AlreadyInvoiced {
  const found = lines.filter((line) => line.orderItemId === orderItemId);
  return found.reduce(
    (sum, line) => ({
      quantity: sum.quantity + line.quantity,
      subtotalMinor: sum.subtotalMinor + BigInt(line.subtotalMinor),
      discountMinor: sum.discountMinor + BigInt(line.discountMinor),
      taxMinor: sum.taxMinor + BigInt(line.taxMinor),
      totalMinor: sum.totalMinor + BigInt(line.totalMinor),
    }),
    into,
  );
}

/**
 * Everything the invoice for this consignment would say, and every reason it
 * cannot yet be issued. Reads only; writes nothing.
 */
async function build(
  client: PrismaTransaction,
  shipment: OwnedShipment,
  group: LoadedGroup,
  lines: { orderItemId: string; quantity: number }[],
): Promise<Built> {
  const issues: ErrorDetail[] = [];
  const order = group.order;

  const [seller, settingsRow, items, priorInvoices, location] = await Promise.all([
    client.sellerAccount.findUniqueOrThrow({
      where: { id: group.sellerAccountId },
      include: { businessProfile: true },
    }),
    client.sellerInvoiceSettings.findUnique({ where: { sellerAccountId: group.sellerAccountId } }),
    loadOrderItems(
      lines.map((line) => line.orderItemId),
      client,
    ),
    client.sellerInvoice.findMany({
      where: {
        sellerOrderGroupId: group.id,
        kind: 'TAX_INVOICE',
        status: { in: ['ISSUED', 'CREDIT_NOTE_REQUIRED'] },
        logisticsShipmentId: { not: shipment.id },
      },
      select: { linesJson: true },
    }),
    group.locationId === null
      ? Promise.resolve(null)
      : client.sellerLocation.findUnique({
          where: { id: group.locationId },
          select: { timezone: true, region: true, countryCode: true },
        }),
  ]);

  const profile = seller.businessProfile;
  const jurisdiction: Jurisdiction =
    settingsRow?.jurisdiction ??
    (seller.registrationCountry === 'IN'
      ? 'IN_GST'
      : EU_COUNTRIES.has(seller.registrationCountry)
        ? 'EU_VAT'
        : 'GENERIC');

  const settings = {
    invoiceSeries: settingsRow?.invoiceSeries ?? 'INV',
    creditNoteSeries: settingsRow?.creditNoteSeries ?? 'CN',
    financialYearStartMonth:
      settingsRow?.financialYearStartMonth ?? (jurisdiction === 'IN_GST' ? 4 : 1),
    signatoryName: settingsRow?.signatoryName ?? null,
    signatoryDesignation: settingsRow?.signatoryDesignation ?? null,
    lutReference: settingsRow?.lutReference ?? null,
    footerNotes: settingsRow?.footerNotes ?? null,
  };

  const timezone = resolveTimezone(
    profile?.timezone,
    location?.timezone,
    jurisdiction === 'IN_GST' ? 'Asia/Kolkata' : null,
  );
  const issueDay = todayIn(timezone);

  // --- Eligibility ---------------------------------------------------------------
  if (!INVOICEABLE_ORDER.has(order.status)) {
    issues.push(
      issue('order', 'NOT_PAID', 'The order has not been paid for, or it was cancelled.'),
    );
  }
  if (!INVOICEABLE_GROUP.has(group.status)) {
    issues.push(issue('sellerOrder', 'NOT_ACCEPTED', 'Accept the order before invoicing it.'));
  }
  if (['CANCELLED', 'LOST', 'RETURNED'].includes(shipment.status)) {
    issues.push(issue('consignment', 'CLOSED', 'This consignment is closed.'));
  }
  if (lines.length === 0)
    issues.push(issue('lines', 'EMPTY', 'This consignment carries nothing to invoice.'));

  // --- The supplier ---------------------------------------------------------------
  const registered = {
    line1: profile?.registeredAddressLine1 ?? null,
    line2: profile?.registeredAddressLine2 ?? null,
    city: profile?.registeredCity ?? null,
    state: profile?.registeredRegion ?? null,
    postalCode: profile?.registeredPostcode ?? null,
    country: profile?.registeredCountry ?? seller.registrationCountry,
  };
  const taxNumber = (profile?.taxRegistrationNumber ?? '').trim().toUpperCase();

  if (seller.legalName.trim() === '')
    issues.push(issue('seller.legalName', 'REQUIRED', 'Your legal name is missing.'));
  if (
    (registered.line1 ?? '') === '' ||
    (registered.city ?? '') === '' ||
    (registered.postalCode ?? '') === ''
  ) {
    issues.push(issue('seller.address', 'INCOMPLETE', 'Your registered address is incomplete.'));
  }

  let sellerStateCode: string | null = null;
  if (jurisdiction === 'IN_GST') {
    const problem = checkGstin(taxNumber);
    if (problem !== null) {
      issues.push(
        issue(
          'seller.gstin',
          taxNumber === '' ? 'REQUIRED' : problem,
          taxNumber === ''
            ? 'Add your GSTIN to your business profile to issue a GST invoice.'
            : `Your GSTIN ${taxNumber} is not valid (${problem === 'CHECKSUM' ? 'the check character does not match' : problem === 'STATE' ? 'unknown state code' : 'wrong format'}).`,
          { gstin: taxNumber },
        ),
      );
    } else {
      sellerStateCode = taxNumber.slice(0, 2);
    }
    if (settings.signatoryName === null) {
      issues.push(
        issue(
          'settings.signatoryName',
          'REQUIRED',
          'Name the person who signs your invoices in invoice settings.',
        ),
      );
    }
  } else if (jurisdiction === 'EU_VAT' && taxNumber === '') {
    issues.push(
      issue('seller.vatNumber', 'REQUIRED', 'Add your VAT number to your business profile.'),
    );
  }

  // --- The recipient ---------------------------------------------------------------
  const billing = (order.billingAddressJson ?? order.shippingAddressJson) as AddressSnapshot;
  const shipping = order.shippingAddressJson as AddressSnapshot;
  const buyerName =
    (order.customerProfile.organization ?? '').trim() !== ''
      ? (order.customerProfile.organization ?? '')
      : order.customerProfile.fullName;
  const buyerGstin = (order.customerProfile.gstin ?? '').trim().toUpperCase();
  const buyerVat = (order.buyerVatNumberSnapshot ?? order.customerProfile.vatNumber ?? '')
    .trim()
    .toUpperCase();

  if (buyerName.trim() === '')
    issues.push(issue('buyer.name', 'REQUIRED', 'The buyer has no name on their account.'));
  if (addressLines(billing).length < 2)
    issues.push(issue('buyer.address', 'INCOMPLETE', 'The buyer’s billing address is incomplete.'));
  if (jurisdiction === 'IN_GST' && buyerGstin !== '' && checkGstin(buyerGstin) !== null) {
    issues.push(
      issue('buyer.gstin', 'INVALID', `The buyer’s GSTIN ${buyerGstin} is not valid.`, {
        gstin: buyerGstin,
      }),
    );
  }

  // --- Lines ---------------------------------------------------------------------------
  const byId = new Map(items.map((item) => [item.id, item]));
  const priorLines = priorInvoices.flatMap(
    (row) => row.linesJson as unknown as StoredInvoiceLine[],
  );

  const shares: LineShare[] = [];
  const draftLines: Omit<StoredInvoiceLine, 'cgstMinor' | 'sgstMinor' | 'igstMinor'>[] = [];

  for (const [index, line] of lines.entries()) {
    const item = byId.get(line.orderItemId);
    if (item === undefined) continue;
    let share: LineShare;
    try {
      share = shareOfLine(
        {
          orderItemId: item.id,
          quantity: item.quantity,
          unitPriceMinor: item.unitPriceMinor,
          lineSubtotalMinor: item.lineSubtotalMinor,
          discountMinor: item.discountMinor,
          taxAmountMinor: item.taxAmountMinor,
          lineTotalMinor: item.lineTotalMinor,
          taxRatePercent: item.taxRatePercent.toString(),
          taxInclusive: item.taxInclusive,
        },
        line.quantity,
        toPrior(priorLines, item.id, NOTHING_INVOICED),
      );
    } catch (error) {
      issues.push(
        issue(
          `lines.${String(index)}`,
          'OVER_INVOICED',
          error instanceof Error ? error.message : 'This line cannot be invoiced.',
          { name: item.nameSnapshot },
        ),
      );
      continue;
    }

    const hsn = item.sellerOffer?.hsnCode ?? null;
    if (jurisdiction === 'IN_GST' && !isValidHsn(hsn)) {
      issues.push(
        issue(
          `lines.${String(index)}.hsn`,
          'REQUIRED',
          `${item.nameSnapshot}: add a 4, 6 or 8-digit HSN code to the listing.`,
          { name: item.nameSnapshot },
        ),
      );
    }

    shares.push(share);
    draftLines.push({
      orderItemId: item.id,
      description:
        item.variantNameSnapshot === null
          ? item.nameSnapshot
          : `${item.nameSnapshot} — ${item.variantNameSnapshot}`,
      sku: item.sellerOffer?.sellerSku ?? item.skuSnapshot,
      hsn,
      countryOfOrigin: item.sellerOffer?.countryOfOrigin ?? null,
      orderedAs: orderedAs(item),
      quantity: share.quantity,
      unitPriceMinor: item.unitPriceMinor.toString(),
      subtotalMinor: share.subtotalMinor.toString(),
      discountMinor: share.discountMinor.toString(),
      taxableMinor: share.taxableMinor.toString(),
      ratePercent: normaliseRate(item.taxRatePercent.toString()),
      taxMinor: share.taxMinor.toString(),
      totalMinor: share.totalMinor.toString(),
    });
  }

  // --- Place of supply and treatment ------------------------------------------------
  const taxCharged = shares.reduce((sum, share) => sum + share.taxMinor, 0n);
  let supplyType = 'OTHER';
  let gstSupplyType: GstSupplyType | null = null;
  let reverseCharge = false;
  let pos: Record<string, unknown> | null = null;
  const declarations: string[] = [];

  if (jurisdiction === 'IN_GST') {
    const place =
      sellerStateCode === null
        ? null
        : placeOfSupply({
            sellerStateCode,
            deliveryCountry: shipping.country ?? 'IN',
            deliveryState: shipping.state ?? null,
            taxChargedMinor: taxCharged,
          });
    if (place === null) {
      if (sellerStateCode !== null) {
        issues.push(
          issue(
            'placeOfSupply',
            'UNKNOWN_STATE',
            `The delivery state “${shipping.state ?? ''}” is not an Indian state or union territory this system recognises.`,
            { state: shipping.state ?? '' },
          ),
        );
      }
    } else {
      gstSupplyType = place.supplyType;
      supplyType = place.supplyType;
      pos = {
        stateCode: place.stateCode,
        stateName: place.stateName,
        basis: 'Where the movement of goods terminates (IGST Act s.10(1)(a))',
      };
      if (place.supplyType === 'EXPORT_UNDER_LUT') {
        if (settings.lutReference === null) {
          issues.push(
            issue(
              'settings.lutReference',
              'REQUIRED',
              'An export with no IGST needs your Letter of Undertaking reference in invoice settings.',
            ),
          );
        } else {
          const lutFrom = settingsRow?.lutValidFrom?.toISOString().slice(0, 10) ?? null;
          const lutTo = settingsRow?.lutValidTo?.toISOString().slice(0, 10) ?? null;
          if ((lutFrom !== null && issueDay < lutFrom) || (lutTo !== null && issueDay > lutTo)) {
            issues.push(
              issue(
                'settings.lutValidTo',
                'EXPIRED',
                'Your Letter of Undertaking is not valid on the invoice date.',
              ),
            );
          }
          declarations.push(
            `Supply meant for export under LUT ${settings.lutReference} without payment of integrated tax.`,
          );
        }
      } else if (place.supplyType === 'EXPORT_WITH_TAX') {
        declarations.push('Supply meant for export on payment of integrated tax.');
      }
    }
    declarations.push('Tax payable under reverse charge: No.');
    declarations.push(
      'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.',
    );
  } else if (jurisdiction === 'EU_VAT') {
    if (order.taxTreatment === 'INTRA_EU_REVERSE_CHARGE') {
      supplyType = 'EU_REVERSE_CHARGE';
      reverseCharge = true;
      if (buyerVat === '')
        issues.push(
          issue(
            'buyer.vatNumber',
            'REQUIRED',
            'A reverse-charge invoice needs the buyer’s VAT number.',
          ),
        );
      declarations.push(
        'Reverse charge: VAT to be accounted for by the recipient (Art. 196, Council Directive 2006/112/EC).',
      );
    } else if (order.taxTreatment === 'EXPORT') {
      supplyType = 'EU_EXPORT';
      declarations.push('Zero-rated export of goods (Art. 146, Council Directive 2006/112/EC).');
    } else {
      supplyType = 'EU_DOMESTIC';
    }
  }

  // Split each line's tax into its components, per line.
  const lineViews: StoredInvoiceLine[] = draftLines.map((line) => {
    const split =
      gstSupplyType === null
        ? { cgst: 0n, sgst: 0n, igst: 0n }
        : splitGst(BigInt(line.taxMinor), gstSupplyType);
    return {
      ...line,
      cgstMinor: split.cgst.toString(),
      sgstMinor: split.sgst.toString(),
      igstMinor: split.igst.toString(),
    };
  });

  const taxRows = taxBreakdown(
    lineViews.map((line) => ({
      ratePercent: line.ratePercent,
      taxableMinor: BigInt(line.taxableMinor),
      taxMinor: BigInt(line.taxMinor),
    })),
    gstSupplyType,
  );

  // Freight goes on the FIRST invoice of a seller order, as charged on it.
  const freight = priorInvoices.length === 0 ? group.shippingTotalMinor : 0n;
  const totals = invoiceTotals(shares, taxRows, freight);

  if (
    jurisdiction === 'IN_GST' &&
    (settings.invoiceSeries.length + 11 > 16 || !/^[A-Z0-9-]{1,5}$/.test(settings.invoiceSeries))
  ) {
    issues.push(
      issue(
        'settings.invoiceSeries',
        'INVALID',
        'A GST invoice series must be 1-5 letters or digits, so the full number stays within 16 characters.',
      ),
    );
  }

  const sellerStateName =
    sellerStateCode === null ? null : (GST_STATE_CODES[sellerStateCode] ?? null);
  const buyerStateCode = jurisdiction === 'IN_GST' ? stateCodeForName(billing.state ?? null) : null;
  const shipStateCode = jurisdiction === 'IN_GST' ? stateCodeForName(shipping.state ?? null) : null;

  const sellerParty = {
    legalName: seller.legalName,
    name: seller.legalName,
    lines: [
      ...(seller.displayName !== seller.legalName ? [`Trading as ${seller.displayName}`] : []),
      ...addressLines(registered),
      ...(profile?.supportEmail === null || profile?.supportEmail === undefined
        ? []
        : [profile.supportEmail]),
    ],
    taxLabel:
      jurisdiction === 'IN_GST' ? 'GSTIN' : jurisdiction === 'EU_VAT' ? 'VAT number' : 'Tax number',
    taxNumber: taxNumber === '' ? null : taxNumber,
    stateLabel:
      sellerStateCode === null ? null : `State: ${sellerStateName ?? ''} (code ${sellerStateCode})`,
    json: {
      legalName: seller.legalName,
      tradingName: seller.displayName,
      address: registered,
      taxNumber: taxNumber === '' ? null : taxNumber,
      stateCode: sellerStateCode,
      companyRegistrationNumber: profile?.companyRegistrationNumber ?? null,
      eoriNumber: profile?.eoriNumber ?? null,
      email: profile?.supportEmail ?? null,
    },
  };

  const buyerParty = {
    name: buyerName,
    lines: [
      ...(buyerName !== order.customerProfile.fullName
        ? [`Attn: ${order.customerProfile.fullName}`]
        : []),
      ...addressLines(billing),
    ],
    taxLabel:
      jurisdiction === 'IN_GST'
        ? 'GSTIN/UIN'
        : jurisdiction === 'EU_VAT'
          ? 'VAT number'
          : 'Tax number',
    taxNumber:
      jurisdiction === 'IN_GST'
        ? buyerGstin === ''
          ? null
          : buyerGstin
        : buyerVat === ''
          ? null
          : buyerVat,
    stateLabel:
      buyerStateCode === null
        ? null
        : `State: ${GST_STATE_CODES[buyerStateCode] ?? ''} (code ${buyerStateCode})`,
    json: {
      name: buyerName,
      contact: order.customerProfile.fullName,
      address: billing,
      gstin: buyerGstin || null,
      vatNumber: buyerVat || null,
    },
  };

  const shipParty = {
    name: shipping.contactName ?? buyerName,
    lines: addressLines(shipping),
    taxLabel: null,
    taxNumber: null,
    stateLabel:
      shipStateCode === null
        ? null
        : `State: ${GST_STATE_CODES[shipStateCode] ?? ''} (code ${shipStateCode})`,
    json: { name: shipping.contactName ?? buyerName, address: shipping },
  };

  const facts: [string, string][] = [
    ['Order', order.orderNumber],
    ['Seller order', group.sellerOrderNumber],
    ['Consignment', shipment.shipmentReference],
    ...(jurisdiction === 'IN_GST' && pos !== null
      ? [
          ['Place of supply', `${String(pos['stateName'])} (${String(pos['stateCode'])})`] as [
            string,
            string,
          ],
        ]
      : []),
    ...(jurisdiction === 'IN_GST'
      ? [
          [
            'Supply',
            gstSupplyType === 'INTRA_STATE'
              ? 'Intra-state'
              : gstSupplyType === 'INTER_STATE'
                ? 'Inter-state'
                : gstSupplyType === null
                  ? '—'
                  : 'Export',
          ] as [string, string],
        ]
      : []),
    ['Reverse charge', reverseCharge ? 'Yes' : 'No'],
  ];

  return {
    sellerAccountId: group.sellerAccountId,
    jurisdiction,
    supplyType,
    gstSupplyType,
    reverseCharge,
    currency: order.currency,
    seller: sellerParty,
    buyer: buyerParty,
    shipTo: shipParty,
    placeOfSupply: pos,
    lines: lineViews,
    shares,
    taxRows,
    totals,
    issues,
    issueDay,
    timezone,
    settings,
    facts,
    declarations,
  };
}

function toDocument(
  built: Built,
  input: {
    kind: 'TAX_INVOICE' | 'CREDIT_NOTE';
    number: string | null;
    issuedAt: Date;
    creditsNumber: string | null;
    lines?: StoredInvoiceLine[];
    totals?: Built['totals'];
    taxRows?: Built['taxRows'];
  },
): InvoiceDocument {
  const lines = input.lines ?? built.lines;
  const totals = input.totals ?? built.totals;
  const taxRows = input.taxRows ?? built.taxRows;
  return {
    kind: input.kind,
    jurisdiction: built.jurisdiction,
    number: input.number,
    issuerId: built.sellerAccountId,
    issueDay: built.issueDay,
    issuedAt: input.issuedAt,
    creditsNumber: input.creditsNumber,
    currency: built.currency,
    supplier: built.seller,
    recipient: built.buyer,
    shipTo: built.shipTo,
    facts: built.facts,
    lines: lines.map((line) => ({
      description: line.description,
      sku: line.sku,
      hsn: line.hsn,
      quantity: line.quantity,
      unitPriceMinor: BigInt(line.unitPriceMinor),
      discountMinor: BigInt(line.discountMinor),
      taxableMinor: BigInt(line.taxableMinor),
      ratePercent: line.ratePercent,
      cgstMinor: BigInt(line.cgstMinor),
      sgstMinor: BigInt(line.sgstMinor),
      igstMinor: BigInt(line.igstMinor),
      taxMinor: BigInt(line.taxMinor),
      totalMinor: BigInt(line.totalMinor),
      orderedAs: line.orderedAs,
    })),
    taxRows,
    totals,
    amountInWords: amountInWords(totals.grandTotalMinor, built.currency),
    declarations: built.declarations,
    signatory: {
      forName: built.seller.legalName,
      name: built.settings.signatoryName,
      designation: built.settings.signatoryDesignation,
    },
    footer:
      `${built.seller.legalName} is the supplier of these goods and issued this ${input.kind === 'CREDIT_NOTE' ? 'credit note' : 'invoice'} through the Glovia marketplace. ` +
      'Glovia operates the marketplace and is not the supplier.' +
      (built.settings.footerNotes === null ? '' : ` ${built.settings.footerNotes}`),
  };
}

function totalsColumns(totals: Built['totals']) {
  return {
    taxableMinor: totals.taxableMinor,
    discountMinor: totals.discountMinor,
    cgstMinor: totals.cgstMinor,
    sgstMinor: totals.sgstMinor,
    igstMinor: totals.igstMinor,
    cessMinor: totals.cessMinor,
    otherTaxMinor: totals.otherTaxMinor,
    freightMinor: totals.freightMinor,
    totalTaxMinor: totals.totalTaxMinor,
    grandTotalMinor: totals.grandTotalMinor,
  };
}

function taxRowsJson(rows: Built['taxRows']) {
  return rows.map((row) => ({
    ratePercent: row.ratePercent,
    taxableMinor: row.taxableMinor.toString(),
    cgstMinor: row.cgstMinor.toString(),
    sgstMinor: row.sgstMinor.toString(),
    igstMinor: row.igstMinor.toString(),
    otherMinor: row.otherMinor.toString(),
    taxMinor: row.taxMinor.toString(),
  }));
}

const liveKeyFor = (shipmentId: string) => `${shipmentId}:TAX_INVOICE`;

// ---------------------------------------------------------------------------
// Draft and preview
// ---------------------------------------------------------------------------

/**
 * Prepare (or refresh) the draft for a consignment and say whether it can be
 * issued. Rewrites a draft; never touches an issued invoice.
 */
export async function prepareInvoice(
  membership: SellerMembership,
  shipmentId: string,
): Promise<Record<string, unknown>> {
  const shipment = await loadOwnedShipment(membership.sellerAccountId, shipmentId);
  const group = await loadGroup(shipment.sellerOrderGroupId ?? '');

  const id = await prisma.$transaction(async (tx) => {
    const live = await tx.sellerInvoice.findUnique({ where: { liveKey: liveKeyFor(shipment.id) } });
    if (live !== null && !['DRAFT', 'VALIDATION_REQUIRED', 'READY_TO_ISSUE'].includes(live.status))
      return live.id;

    const lines = await ensureShipmentLines(tx, shipment, group);
    const built = await build(tx, shipment, group, lines);
    const status: SellerDocumentStatus =
      built.issues.length === 0 ? 'READY_TO_ISSUE' : 'VALIDATION_REQUIRED';

    const data = {
      status,
      jurisdiction: built.jurisdiction,
      templateVersion: INVOICE_TEMPLATE_VERSION[built.jurisdiction],
      currency: built.currency,
      sellerJson: built.seller.json as never,
      buyerJson: built.buyer.json as never,
      shipToJson: built.shipTo.json as never,
      linesJson: built.lines as never,
      taxBreakdownJson: taxRowsJson(built.taxRows) as never,
      placeOfSupplyJson: (built.placeOfSupply ?? undefined) as never,
      validationJson: built.issues as never,
      supplyType: built.supplyType,
      reverseCharge: built.reverseCharge,
      ...totalsColumns(built.totals),
      amountInWords: amountInWords(built.totals.grandTotalMinor, built.currency),
    };

    if (live === null) {
      const newIdValue = newId();
      await tx.sellerInvoice.create({
        data: {
          id: newIdValue,
          sellerAccountId: membership.sellerAccountId,
          orderId: group.orderId,
          sellerOrderGroupId: group.id,
          logisticsShipmentId: shipment.id,
          kind: 'TAX_INVOICE',
          liveKey: liveKeyFor(shipment.id),
          ...data,
        },
      });
      return newIdValue;
    }
    await tx.sellerInvoice.update({ where: { id: live.id }, data });
    return live.id;
  });

  return readInvoice(membership.sellerAccountId, id);
}

/** The draft PDF, watermarked. The issued PDF once there is one. */
export async function invoicePdfForSeller(
  membership: SellerMembership,
  shipmentId: string,
  correlationId: string | null,
): Promise<{ bytes: Buffer; fileName: string; issued: boolean }> {
  const shipment = await loadOwnedShipment(membership.sellerAccountId, shipmentId);
  const live = await prisma.sellerInvoice.findUnique({
    where: { liveKey: liveKeyFor(shipment.id) },
  });

  if (live !== null && live.storageKey !== null && live.number !== null) {
    return {
      bytes: await storage.get(live.storageKey),
      fileName: `${live.number.replace(/\//g, '-')}.pdf`,
      issued: true,
    };
  }

  const group = await loadGroup(shipment.sellerOrderGroupId ?? '');
  const lines = await prisma.$transaction((tx) => ensureShipmentLines(tx, shipment, group));
  const built = await build(prisma, shipment, group, lines);
  const { bytes } = await renderers.invoice(
    toDocument(built, {
      kind: 'TAX_INVOICE',
      number: null,
      issuedAt: new Date(`${built.issueDay}T00:00:00.000Z`),
      creditsNumber: null,
    }),
    { draft: true },
  );

  await recordAudit({
    action: AuditAction.SELLER_INVOICE_PREVIEWED,
    resourceType: 'logistics_shipment',
    resourceId: shipment.id,
    actorType: 'CUSTOMER',
    after: { issues: built.issues.length, sellerAccountId: membership.sellerAccountId },
    correlationId,
  });

  return { bytes, fileName: `draft-invoice-${shipment.shipmentReference}.pdf`, issued: false };
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

async function nextNumber(
  tx: PrismaTransaction,
  sellerAccountId: string,
  series: string,
  fyShort: string,
): Promise<{ number: string; sequence: number }> {
  const key = `seller-invoice:${sellerAccountId}:${series}:${fyShort}`;
  await tx.numberSequence.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1, prefix: series, padding: 5 },
  });
  const row = await tx.numberSequence.findUniqueOrThrow({ where: { key } });
  return {
    number: `${series}/${fyShort}/${row.value.toString().padStart(row.padding, '0')}`,
    sequence: Number(row.value),
  };
}

async function storePdf(
  bytes: Buffer,
  stored: string[],
): Promise<{ storageKey: string; contentHash: string; sizeBytes: number }> {
  const object = await storage.put(bytes, 'application/pdf', 'pdf', 'private');
  stored.push(object.storageKey);
  return {
    storageKey: object.storageKey,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
}

/** Delete objects written by a transaction that did not commit. Best effort. */
export async function discardStored(keys: string[]): Promise<void> {
  for (const key of keys) {
    await storage.delete(key).catch((error: unknown) => {
      logger.warn({ err: error, key }, 'could not remove a document left by a rolled-back issue');
    });
  }
}

/**
 * Issue the consignment's invoice inside the caller's transaction. Returns the
 * issued row; an already-issued invoice is returned as it is.
 */
export async function issueInvoiceInTx(
  tx: PrismaTransaction,
  membership: SellerMembership,
  shipment: OwnedShipment,
  stored: string[],
  correlationId: string | null,
): Promise<{ id: string; number: string; created: boolean }> {
  const live = await tx.sellerInvoice.findUnique({ where: { liveKey: liveKeyFor(shipment.id) } });
  if (
    live !== null &&
    live.number !== null &&
    !['DRAFT', 'VALIDATION_REQUIRED', 'READY_TO_ISSUE'].includes(live.status)
  ) {
    return { id: live.id, number: live.number, created: false };
  }

  const group = await loadGroup(shipment.sellerOrderGroupId ?? '', tx);
  const lines = await ensureShipmentLines(tx, shipment, group);
  const built = await build(tx, shipment, group, lines);

  if (built.issues.length > 0) {
    throw new AppError({
      statusCode: 422,
      code: ErrorCode.SELLER_DOCUMENT_VALIDATION_FAILED,
      message: 'The invoice cannot be issued until these are fixed.',
      details: built.issues,
    });
  }

  const fy = financialYear(built.issueDay, built.settings.financialYearStartMonth);
  const { number, sequence } = await nextNumber(
    tx,
    membership.sellerAccountId,
    built.settings.invoiceSeries,
    fy.short,
  );
  const issuedAt = new Date();

  let rendered: { bytes: Buffer; pageCount: number };
  try {
    rendered = await renderers.invoice(
      toDocument(built, { kind: 'TAX_INVOICE', number, issuedAt, creditsNumber: null }),
      { draft: false },
    );
  } catch (error) {
    throw new AppError({
      statusCode: 500,
      code: ErrorCode.DOCUMENT_RENDER_FAILED,
      message: 'The invoice PDF could not be produced. Nothing was issued.',
      cause: error,
    });
  }
  const file = await storePdf(rendered.bytes, stored);

  const documentId = newId();
  await tx.logisticsShipmentDocument.create({
    data: {
      id: documentId,
      shipmentId: shipment.id,
      kind: 'COMMERCIAL_INVOICE',
      // Priced, so for the operator only. A carrier needs the packing list,
      // which carries no prices.
      audience: 'OPERATOR',
      fileName: `${number.replace(/\//g, '-')}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: file.sizeBytes,
      storageKey: file.storageKey,
      contentHash: file.contentHash,
      scanState: 'GENERATED',
      scannedAt: issuedAt,
      scanDetail: 'Generated by this server from the issued invoice.',
      uploadedBySource: 'SYSTEM_AUTOMATION',
    },
  });

  const data = {
    status: 'ISSUED' as const,
    jurisdiction: built.jurisdiction,
    templateVersion: INVOICE_TEMPLATE_VERSION[built.jurisdiction],
    series: built.settings.invoiceSeries,
    financialYear: fy.label,
    sequenceNumber: sequence,
    number,
    issueDate: new Date(`${built.issueDay}T00:00:00.000Z`),
    issuedAt,
    issuedByLabel: membership.displayName.slice(0, 160),
    currency: built.currency,
    sellerJson: built.seller.json as never,
    buyerJson: built.buyer.json as never,
    shipToJson: built.shipTo.json as never,
    linesJson: built.lines as never,
    taxBreakdownJson: taxRowsJson(built.taxRows) as never,
    placeOfSupplyJson: (built.placeOfSupply ?? undefined) as never,
    validationJson: [] as never,
    supplyType: built.supplyType,
    reverseCharge: built.reverseCharge,
    ...totalsColumns(built.totals),
    amountInWords: amountInWords(built.totals.grandTotalMinor, built.currency),
    storageKey: file.storageKey,
    contentHash: file.contentHash,
    sizeBytes: file.sizeBytes,
    pageCount: rendered.pageCount,
    logisticsDocumentId: documentId,
  };

  let id: string;
  if (live === null) {
    id = newId();
    await tx.sellerInvoice.create({
      data: {
        id,
        sellerAccountId: membership.sellerAccountId,
        orderId: group.orderId,
        sellerOrderGroupId: group.id,
        logisticsShipmentId: shipment.id,
        kind: 'TAX_INVOICE',
        liveKey: liveKeyFor(shipment.id),
        ...data,
      },
    });
  } else {
    id = live.id;
    // Conditional on still being a draft: two issues racing each other both
    // allocate numbers, and exactly one of them lands. The loser's number is
    // rolled back with its transaction.
    const updated = await tx.sellerInvoice.updateMany({
      where: { id: live.id, status: { in: ['DRAFT', 'VALIDATION_REQUIRED', 'READY_TO_ISSUE'] } },
      data,
    });
    if (updated.count !== 1) {
      throw conflict(ErrorCode.SELLER_DOCUMENT_IMMUTABLE, 'This invoice was issued a moment ago.', [
        { code: 'ALREADY_ISSUED' },
      ]);
    }
  }

  await recordAudit(
    {
      action: AuditAction.SELLER_INVOICE_ISSUED,
      resourceType: 'seller_invoice',
      resourceId: id,
      actorType: 'CUSTOMER',
      after: {
        number,
        sellerAccountId: membership.sellerAccountId,
        shipmentId: shipment.id,
        grandTotalMinor: built.totals.grandTotalMinor,
        currency: built.currency,
        contentHash: file.contentHash,
        templateVersion: INVOICE_TEMPLATE_VERSION[built.jurisdiction],
      },
      correlationId,
    },
    tx,
  );

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller_invoice.issued',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_invoice',
    resourceId: id,
    after: { number, grandTotalMinor: built.totals.grandTotalMinor, contentHash: file.contentHash },
    summary: `Issued invoice ${number} for ${shipment.shipmentReference}`,
    tx,
  });

  await enqueueNotification(
    {
      eventKey: NotificationEvent.SELLER_INVOICE_ISSUED,
      recipientEmail: group.order.customerProfile.user.email,
      recipientName: group.order.customerProfile.fullName,
      variables: {
        invoiceNumber: number,
        sellerName: membership.displayName,
        total: formatAmount(built.totals.grandTotalMinor, built.currency),
        shipmentReference: shipment.shipmentReference,
        orderNumber: group.order.orderNumber,
        orderUrl: `${env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/$/, '')}/account/orders/${group.orderId}`,
      },
      dedupeKey: `seller_invoice:${id}:issued`,
      relatedType: 'seller_invoice',
      relatedId: id,
      correlationId,
    },
    tx,
  );

  return { id, number, created: true };
}

export async function issueInvoice(
  membership: SellerMembership,
  shipmentId: string,
  correlationId: string | null,
): Promise<Record<string, unknown>> {
  const shipment = await loadOwnedShipment(membership.sellerAccountId, shipmentId);
  const stored: string[] = [];
  let result: { id: string };
  try {
    result = await prisma.$transaction(
      (tx) => issueInvoiceInTx(tx, membership, shipment, stored, correlationId),
      {
        timeout: 30_000,
      },
    );
  } catch (error) {
    await discardStored(stored);
    throw error;
  }
  await dispatchPendingNotifications();
  return readInvoice(membership.sellerAccountId, result.id);
}

// ---------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------

export const creditInputSchema = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();

/**
 * Reverse an issued invoice with a credit note of equal and opposite value.
 *
 * The only correction an issued invoice permits. The original stays - its
 * number is never reused and its PDF never changes - and is marked VOIDED; the
 * credit note gets its own number from the credit-note series and names the
 * invoice it reverses. The consignment can then be invoiced afresh, under a
 * NEW number.
 */
export async function creditInvoice(
  membership: SellerMembership,
  invoiceId: string,
  input: z.infer<typeof creditInputSchema>,
  correlationId: string | null,
): Promise<Record<string, unknown>> {
  const original = await prisma.sellerInvoice.findUnique({ where: { id: invoiceId } });
  if (original === null || original.sellerAccountId !== membership.sellerAccountId)
    throw notFound('Invoice');
  if (
    original.kind !== 'TAX_INVOICE' ||
    !['ISSUED', 'CREDIT_NOTE_REQUIRED'].includes(original.status) ||
    original.number === null
  ) {
    throw conflict(ErrorCode.SELLER_DOCUMENT_IMMUTABLE, 'Only an issued invoice can be credited.', [
      { code: 'NOT_ISSUED' },
    ]);
  }

  const shipment = await loadOwnedShipment(
    membership.sellerAccountId,
    original.logisticsShipmentId,
  );
  const group = await loadGroup(original.sellerOrderGroupId);
  const stored: string[] = [];

  let creditId: string;
  try {
    creditId = await prisma.$transaction(
      async (tx) => {
        const lines = (original.linesJson as unknown as StoredInvoiceLine[]).map((line) => ({
          orderItemId: line.orderItemId,
          quantity: line.quantity,
        }));
        // The parties and treatment as the ORIGINAL stated them: a credit note
        // reverses that document, not whatever the profile says today.
        const built = await build(tx, shipment, group, lines);
        const negate = (value: string) => (-BigInt(value)).toString();
        const creditLines = (original.linesJson as unknown as StoredInvoiceLine[]).map((line) => ({
          ...line,
          subtotalMinor: negate(line.subtotalMinor),
          discountMinor: negate(line.discountMinor),
          taxableMinor: negate(line.taxableMinor),
          cgstMinor: negate(line.cgstMinor),
          sgstMinor: negate(line.sgstMinor),
          igstMinor: negate(line.igstMinor),
          taxMinor: negate(line.taxMinor),
          totalMinor: negate(line.totalMinor),
        }));
        const creditTaxRows = (
          original.taxBreakdownJson as unknown as {
            ratePercent: string;
            taxableMinor: string;
            cgstMinor: string;
            sgstMinor: string;
            igstMinor: string;
            otherMinor: string;
            taxMinor: string;
          }[]
        ).map((row) => ({
          ratePercent: row.ratePercent,
          taxableMinor: -BigInt(row.taxableMinor),
          cgstMinor: -BigInt(row.cgstMinor),
          sgstMinor: -BigInt(row.sgstMinor),
          igstMinor: -BigInt(row.igstMinor),
          otherMinor: -BigInt(row.otherMinor),
          taxMinor: -BigInt(row.taxMinor),
        }));
        const creditTotals = {
          subtotalMinor: -(original.taxableMinor + original.discountMinor),
          discountMinor: -original.discountMinor,
          taxableMinor: -original.taxableMinor,
          cgstMinor: -original.cgstMinor,
          sgstMinor: -original.sgstMinor,
          igstMinor: -original.igstMinor,
          cessMinor: -original.cessMinor,
          otherTaxMinor: -original.otherTaxMinor,
          totalTaxMinor: -original.totalTaxMinor,
          freightMinor: -original.freightMinor,
          grandTotalMinor: -original.grandTotalMinor,
        };

        const fy = financialYear(built.issueDay, built.settings.financialYearStartMonth);
        const { number, sequence } = await nextNumber(
          tx,
          membership.sellerAccountId,
          built.settings.creditNoteSeries,
          fy.short,
        );
        const issuedAt = new Date();

        const docBuilt: Built = {
          ...built,
          seller: { ...built.seller, json: original.sellerJson as Record<string, unknown> },
          buyer: { ...built.buyer, json: original.buyerJson as Record<string, unknown> },
          declarations: [`Credit note against invoice ${original.number ?? ''}: ${input.reason}`],
        };
        const rendered = await renderers.invoice(
          toDocument(docBuilt, {
            kind: 'CREDIT_NOTE',
            number,
            issuedAt,
            creditsNumber: original.number,
            lines: creditLines,
            totals: creditTotals,
            taxRows: creditTaxRows,
          }),
          { draft: false },
        );
        const file = await storePdf(rendered.bytes, stored);
        const id = newId();

        await tx.sellerInvoice.create({
          data: {
            id,
            sellerAccountId: original.sellerAccountId,
            orderId: original.orderId,
            sellerOrderGroupId: original.sellerOrderGroupId,
            logisticsShipmentId: original.logisticsShipmentId,
            kind: 'CREDIT_NOTE',
            status: 'ISSUED',
            jurisdiction: original.jurisdiction,
            // One credit note per invoice.
            liveKey: `${original.id}:CREDIT_NOTE`,
            series: built.settings.creditNoteSeries,
            financialYear: fy.label,
            sequenceNumber: sequence,
            number,
            creditsInvoiceId: original.id,
            templateVersion: original.templateVersion,
            issueDate: new Date(`${built.issueDay}T00:00:00.000Z`),
            issuedAt,
            issuedByLabel: membership.displayName.slice(0, 160),
            currency: original.currency,
            sellerJson: original.sellerJson as never,
            buyerJson: original.buyerJson as never,
            shipToJson: original.shipToJson as never,
            linesJson: creditLines as never,
            taxBreakdownJson: creditTaxRows.map((row) => ({
              ...row,
              taxableMinor: row.taxableMinor.toString(),
              cgstMinor: row.cgstMinor.toString(),
              sgstMinor: row.sgstMinor.toString(),
              igstMinor: row.igstMinor.toString(),
              otherMinor: row.otherMinor.toString(),
              taxMinor: row.taxMinor.toString(),
            })) as never,
            placeOfSupplyJson: (original.placeOfSupplyJson ?? undefined) as never,
            supplyType: original.supplyType,
            reverseCharge: original.reverseCharge,
            taxableMinor: creditTotals.taxableMinor,
            discountMinor: creditTotals.discountMinor,
            cgstMinor: creditTotals.cgstMinor,
            sgstMinor: creditTotals.sgstMinor,
            igstMinor: creditTotals.igstMinor,
            cessMinor: creditTotals.cessMinor,
            otherTaxMinor: creditTotals.otherTaxMinor,
            freightMinor: creditTotals.freightMinor,
            totalTaxMinor: creditTotals.totalTaxMinor,
            grandTotalMinor: creditTotals.grandTotalMinor,
            amountInWords: amountInWords(creditTotals.grandTotalMinor, original.currency),
            storageKey: file.storageKey,
            contentHash: file.contentHash,
            sizeBytes: file.sizeBytes,
            pageCount: rendered.pageCount,
          },
        });

        const voided = await tx.sellerInvoice.updateMany({
          where: { id: original.id, status: { in: ['ISSUED', 'CREDIT_NOTE_REQUIRED'] } },
          data: { status: 'VOIDED', liveKey: null, voidedAt: issuedAt, voidReason: input.reason },
        });
        if (voided.count !== 1) {
          throw conflict(
            ErrorCode.SELLER_DOCUMENT_IMMUTABLE,
            'This invoice was credited a moment ago.',
            [{ code: 'ALREADY_CREDITED' }],
          );
        }

        await resolveSellerNotifications(
          { resolutionKey: `seller-invoice:${original.id}:credit`, note: 'Credit note issued' },
          tx,
        );

        await recordAudit(
          {
            action: AuditAction.SELLER_INVOICE_CREDITED,
            resourceType: 'seller_invoice',
            resourceId: original.id,
            actorType: 'CUSTOMER',
            before: { number: original.number, status: original.status },
            after: {
              creditNoteNumber: number,
              reason: input.reason,
              contentHash: file.contentHash,
            },
            correlationId,
          },
          tx,
        );
        await recordSellerAudit({
          sellerAccountId: membership.sellerAccountId,
          action: 'seller_invoice.credited',
          actor: { type: 'CUSTOMER', label: membership.displayName },
          resourceType: 'seller_invoice',
          resourceId: original.id,
          after: { creditNoteNumber: number },
          summary: `Credited invoice ${original.number ?? ''} with ${number}`,
          tx,
        });

        return id;
      },
      { timeout: 30_000 },
    );
  } catch (error) {
    await discardStored(stored);
    throw error;
  }

  return readInvoice(membership.sellerAccountId, creditId);
}

/**
 * An invoice whose goods were cancelled or returned owes a credit note.
 * Called from the order's and the seller order's own transitions.
 */
export async function flagInvoicesForCredit(
  filter: { orderId: string; sellerOrderGroupId?: string },
  reason: string,
  tx: PrismaTransaction,
): Promise<void> {
  const invoices = await tx.sellerInvoice.findMany({
    where: {
      orderId: filter.orderId,
      ...(filter.sellerOrderGroupId === undefined
        ? {}
        : { sellerOrderGroupId: filter.sellerOrderGroupId }),
      kind: 'TAX_INVOICE',
      status: 'ISSUED',
    },
    select: { id: true, number: true, sellerAccountId: true },
  });

  for (const invoice of invoices) {
    await tx.sellerInvoice.update({
      where: { id: invoice.id },
      data: { status: 'CREDIT_NOTE_REQUIRED' },
    });
    await notifySeller({
      sellerAccountId: invoice.sellerAccountId,
      kind: 'INVOICE_CREDIT_NOTE_REQUIRED',
      class: 'ALERT',
      resolutionKey: `seller-invoice:${invoice.id}:credit`,
      severity: 'WARNING',
      title: `Invoice ${invoice.number ?? ''} needs a credit note`,
      body: reason,
      linkPath: '/seller/orders',
      subjectType: 'seller_invoice',
      subjectId: invoice.id,
      dedupeKey: `seller-invoice:${invoice.id}:credit`,
      tx,
    });
    await recordAudit(
      {
        action: AuditAction.SELLER_INVOICE_FLAGGED,
        resourceType: 'seller_invoice',
        resourceId: invoice.id,
        actorType: 'SYSTEM',
        after: { reason },
      },
      tx,
    );
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

type InvoiceRow = NonNullable<Awaited<ReturnType<typeof prisma.sellerInvoice.findUnique>>>;

export function serialiseInvoice(
  row: InvoiceRow,
  audience: 'SELLER' | 'BUYER' | 'ADMIN',
): Record<string, unknown> {
  const money = (value: bigint) => ({
    minor: value.toString(),
    currency: row.currency,
    formatted: formatAmount(value, row.currency),
  });
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    jurisdiction: row.jurisdiction,
    number: row.number,
    financialYear: row.financialYear,
    issueDate: row.issueDate?.toISOString().slice(0, 10) ?? null,
    issuedAt: row.issuedAt?.toISOString() ?? null,
    issuedByLabel: audience === 'BUYER' ? null : row.issuedByLabel,
    shipmentId: row.logisticsShipmentId,
    orderId: row.orderId,
    creditsInvoiceId: row.creditsInvoiceId,
    supplyType: row.supplyType,
    reverseCharge: row.reverseCharge,
    currency: row.currency,
    seller: row.sellerJson,
    buyer: row.buyerJson,
    placeOfSupply: row.placeOfSupplyJson,
    lines: row.linesJson,
    taxBreakdown: row.taxBreakdownJson,
    totals: {
      taxable: money(row.taxableMinor),
      discount: money(row.discountMinor),
      cgst: money(row.cgstMinor),
      sgst: money(row.sgstMinor),
      igst: money(row.igstMinor),
      cess: money(row.cessMinor),
      otherTax: money(row.otherTaxMinor),
      freight: money(row.freightMinor),
      totalTax: money(row.totalTaxMinor),
      grandTotal: money(row.grandTotalMinor),
    },
    amountInWords: row.amountInWords,
    validation: audience === 'SELLER' ? row.validationJson : null,
    contentHash: row.contentHash,
    pageCount: row.pageCount,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
    templateVersion: row.templateVersion,
  };
}

export async function readInvoice(
  sellerAccountId: string,
  invoiceId: string,
): Promise<Record<string, unknown>> {
  const row = await prisma.sellerInvoice.findUnique({ where: { id: invoiceId } });
  if (row === null || row.sellerAccountId !== sellerAccountId) throw notFound('Invoice');
  return serialiseInvoice(row, 'SELLER');
}
