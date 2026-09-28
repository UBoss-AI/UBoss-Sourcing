/**
 * The operator's commission invoices to sellers, and their credit notes.
 *
 * WHAT IS INVOICED. One commission event: the `SellerOrderSettlement` of one
 * seller order, calculated when the buyer's order was confirmed. Its platform
 * fee and the tax on that fee are the invoice's figures, copied, never
 * recalculated - `domain/commission-invoice.ts` only decides how they are
 * presented, and refuses what it cannot present truthfully.
 *
 * WHAT IS NOT TOUCHED. The payment, the refund and the payout flows. This
 * reads the captured payment and the settlement as they are, and changes
 * neither: an invoice records a charge, it does not move money.
 *
 * THE LIFECYCLE (every status write goes through
 * `domain/commission-invoice-state.ts`):
 *
 *   generate  -> a DRAFT, built from its sources. One live invoice per
 *                commission event (`activeKey`, UNIQUE), and a retried request
 *                with the same Idempotency-Key returns the same draft.
 *   regenerate-> rebuild the draft from its sources, e.g. after the seller
 *                fixed their GSTIN.
 *   preview   -> the draft PDF, watermarked, with no number, barcode or QR.
 *   issue     -> in ONE transaction: lock the row, rebuild and insist the
 *                result is exactly what was previewed (same snapshot hash),
 *                reserve the number from a locked counter, render the A6 PDF,
 *                store it privately with its SHA-256, freeze everything. If
 *                any step fails the number rolls back with the transaction and
 *                nothing is issued. Issuing an issued invoice returns it.
 *   credit    -> a credit note in its own series, never more than is left.
 *   void      -> a draft is discarded; an issued invoice only where the
 *                settings allow it, and its number stays used.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { CommissionInvoice, CommissionInvoiceLine, CommissionInvoiceSettings, Prisma } from '../../generated/prisma/client.js';
import {
  buildCommissionLines,
  commissionAmountInWords,
  commissionFinancialYear,
  commissionTotals,
  creditFigures,
  CreditArithmeticError,
  documentFileName,
  formatDocumentNumber,
  proportionalCreditTaxable,
  resolveCommissionTax,
  sequenceKey,
  trimPercent,
  type CommissionIssue,
  type CommissionLine,
  type CommissionTaxResolution,
  type CommissionTotals,
  type FeeBreakdownEntry,
} from '../../domain/commission-invoice.js';
import { activeKeyFor, assertCommissionMove, isIssuedStatus } from '../../domain/commission-invoice-state.js';
import { resolveTimezone, todayIn } from '../../domain/delivery-dates.js';
import { AppError, ErrorCode, badRequest, conflict, forbidden, notFound, unprocessable } from '../../domain/errors.js';
import { GST_STATE_CODES } from '../../domain/gst.js';
import { halfRate } from '../../domain/seller-invoice.js';
import { serialiseMoney, type Minor } from '../../domain/money.js';
import { env } from '../../config/env.js';
import { generateToken, sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { storage } from '../../infra/storage/index.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { COMMISSION_TEMPLATE_VERSION, renderCommissionDocument, type CommissionPdfDocument } from '../documents/commission-invoice-pdf.js';
import { formatAmount, formatDay, formatPlain, verificationUrl } from '../documents/document-format.js';
import { marketplaceNameFrom } from '../settings/marketplace-name.js';
import { issuerGaps, loadSettings, type FinanceActor } from './commission-settings.service.js';

export type { FinanceActor } from './commission-settings.service.js';

/** The renderer, behind an object so a test can make it fail and prove nothing is issued. */
export const renderers = { commission: renderCommissionDocument };

type Client = PrismaTransaction | typeof prisma;

// ---------------------------------------------------------------------------
// Loading the sources
// ---------------------------------------------------------------------------

async function loadContext(client: Client, sellerOrderGroupId: string) {
  const group = await client.sellerOrderGroup.findUnique({
    where: { id: sellerOrderGroupId },
    select: {
      id: true,
      status: true,
      sellerOrderNumber: true,
      dispatchedAt: true,
      deliveredAt: true,
      orderId: true,
      order: {
        select: { id: true, orderNumber: true, status: true, currency: true, paidMinor: true, grandTotalMinor: true },
      },
      sellerAccount: {
        select: { id: true, legalName: true, displayName: true, registrationCountry: true, businessProfile: true },
      },
      settlement: true,
    },
  });
  if (group === null) throw notFound('Seller order');

  const [payment, settlementLine, profile] = await Promise.all([
    client.paymentTransaction.findFirst({
      where: { orderId: group.orderId, status: 'CAPTURED' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, provider: true, providerPaymentId: true, capturedMinor: true, currency: true },
    }),
    client.sellerSettlementLine.findFirst({
      where: { orderGroupId: group.id, kind: 'COMMISSION' },
      orderBy: { createdAt: 'desc' },
      select: { settlement: { select: { reference: true, status: true } } },
    }),
    client.businessProfile.findFirst({ select: { timezone: true, displayName: true } }),
  ]);

  // The tax rule counts as verified when every policy the fee came from is
  // verified NOW: finance may verify a rule after the order was confirmed,
  // and the rate - the only thing that matters to the figure - is unchanged.
  let taxVerified = group.settlement?.feeTaxVerified ?? false;
  if (group.settlement !== null && !taxVerified) {
    const policyIds = breakdownOf(group.settlement.breakdownJson)
      .map((entry) => entry.policyId)
      .filter((id): id is string => id !== null);
    if (policyIds.length > 0) {
      const verified = await client.platformFeePolicy.count({ where: { id: { in: policyIds }, isTaxRuleVerified: true } });
      taxVerified = verified === new Set(policyIds).size;
    }
  }

  return {
    group,
    payment,
    settlementLine,
    taxVerified,
    timezone: resolveTimezone(profile?.timezone, 'UTC'),
    marketplaceName: marketplaceNameFrom(profile?.displayName),
  };
}

type Context = Awaited<ReturnType<typeof loadContext>>;

function breakdownOf(value: Prisma.JsonValue): FeeBreakdownEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
    const entry = item as Record<string, unknown>;
    const text = (key: string) => (typeof entry[key] === 'string' ? (entry[key]) : '');
    return [
      {
        policyId: typeof entry.policyId === 'string' ? entry.policyId : null,
        policyVersion: typeof entry.policyVersion === 'number' ? entry.policyVersion : null,
        feeType: text('feeType'),
        percentRate: text('percentRate'),
        basisMinor: text('basisMinor'),
        feeMinor: text('feeMinor'),
        taxRatePercent: text('taxRatePercent') === '' ? '0' : text('taxRatePercent'),
        taxMinor: text('taxMinor'),
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface Blocker {
  code: string;
  message: string;
}

const UNPAID_ORDER_STATUSES = new Set(['DRAFT', 'PENDING_APPROVAL', 'PENDING_PAYMENT']);
const CANCELLED_GROUP_STATUSES = new Set(['CANCELLED', 'REFUNDED', 'RETURNED']);

/**
 * Why this seller order cannot have a commission invoice yet - empty when it
 * can. These are about the ORDER; what the document itself is missing (an
 * address, a GSTIN) is the build's `issues`.
 */
export function eligibilityBlockers(context: Context, settings: CommissionInvoiceSettings): Blocker[] {
  const { group, payment } = context;
  const blockers: Blocker[] = [];
  const paid = payment !== null || (group.order.paidMinor > 0n && group.order.paidMinor >= group.order.grandTotalMinor);
  if (!paid || UNPAID_ORDER_STATUSES.has(group.order.status)) {
    blockers.push({ code: 'PAYMENT_NOT_CAPTURED', message: "The buyer's payment for this order has not been captured." });
  }
  if (group.order.status === 'CANCELLED' || group.order.status === 'REFUNDED') {
    blockers.push({ code: 'ORDER_CANCELLED', message: 'The order was cancelled or refunded.' });
  }
  if (CANCELLED_GROUP_STATUSES.has(group.status)) {
    blockers.push({ code: 'SELLER_ORDER_CANCELLED', message: "The seller's part of this order was cancelled, returned or refunded." });
  }
  if (group.status === 'DISPUTED') {
    blockers.push({ code: 'DISPUTE_OPEN', message: "The seller's part of this order is in dispute." });
  }
  if (group.settlement === null) {
    blockers.push({ code: 'COMMISSION_NOT_CALCULATED', message: 'No commission has been calculated for this seller order.' });
  } else if (group.settlement.platformFeeMinor <= 0n) {
    blockers.push({ code: 'NO_COMMISSION', message: 'The commission on this seller order is zero.' });
  }
  const reached =
    settings.eligibleStage === 'CONFIRMED'
      ? ['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(group.order.status)
      : settings.eligibleStage === 'SHIPPED'
        ? group.status === 'SHIPPED' || group.status === 'DELIVERED' || group.dispatchedAt !== null
        : group.status === 'DELIVERED' || group.deliveredAt !== null;
  if (!reached) {
    blockers.push({
      code: `STAGE_NOT_REACHED_${settings.eligibleStage}`,
      message: `Commission is invoiced once the seller order is ${settings.eligibleStage.toLowerCase()}; this one is not yet.`,
    });
  }
  return blockers;
}

// ---------------------------------------------------------------------------
// Building the document
// ---------------------------------------------------------------------------

interface IssuerSnapshot {
  legalEntityCode: string;
  legalName: string;
  tradeName: string | null;
  marketplaceName: string;
  addressLines: string[];
  country: string | null;
  stateCode: string | null;
  stateName: string | null;
  taxRegime: string;
  taxRegistrationLabel: string;
  taxRegistrationNumber: string | null;
  businessIdentifierLabel: string;
  businessIdentifier: string | null;
  businessEmail: string | null;
  supportContact: string | null;
  jurisdictionNote: string | null;
  footerNote: string | null;
  serviceCodeLabel: string;
}

interface SellerSnapshot {
  sellerAccountId: string;
  legalName: string;
  displayName: string;
  addressLines: string[];
  country: string | null;
  region: string | null;
  stateCode: string | null;
  stateName: string | null;
  taxId: string | null;
  email: string | null;
}

interface SourceSnapshot {
  orderId: string;
  orderNumber: string;
  sellerOrderGroupId: string;
  sellerOrderNumber: string;
  paymentReference: string | null;
  paymentProvider: string | null;
  settlementId: string;
  settlementReference: string | null;
  collection: 'PAYABLE_BY_SELLER' | 'ADJUSTED_AGAINST_SETTLEMENT';
  feePolicyId: string | null;
  feePolicyVersion: number | null;
  feeBasisMinor: string;
  platformFeeMinor: string;
  platformFeeTaxMinor: string;
  feeTaxRatePercent: string;
  feeTaxLabel: string;
  feeTaxVerified: boolean;
  settlementComputedAt: string;
  tax: { split: CommissionTaxResolution['split']; labels: CommissionTaxResolution['labels'] };
}

export interface Built {
  currency: string;
  documentType: CommissionTaxResolution['documentType'];
  treatment: CommissionTaxResolution['treatment'];
  reverseCharge: boolean;
  placeOfSupply: { code: string; name: string } | null;
  issuer: IssuerSnapshot;
  seller: SellerSnapshot;
  source: SourceSnapshot;
  notes: string[];
  lines: CommissionLine[];
  totals: CommissionTotals;
  amountInWords: string;
  issues: CommissionIssue[];
  snapshotHash: string;
}

function clip(value: string | null | undefined, max = 200): string | null {
  const trimmed = (value ?? '').replace(/\s+/g, ' ').trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

function addressLines(parts: {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postcode: string | null;
  country: string | null;
}): string[] {
  const place = [parts.city, parts.region].map((part) => clip(part)).filter(Boolean).join(', ');
  const tail = [place, clip(parts.postcode)].filter(Boolean).join(' ');
  return [clip(parts.line1), clip(parts.line2), [tail, clip(parts.country)].filter(Boolean).join(', ')].filter(
    (line): line is string => line !== null && line !== '',
  );
}

/** JSON with bigint as strings, keys in the order they were built. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item));
}

export function build(context: Context, settings: CommissionInvoiceSettings): Built {
  const { group } = context;
  const settlement = group.settlement;
  if (settlement === null) {
    throw unprocessable(ErrorCode.COMMISSION_INVOICE_NOT_ELIGIBLE, 'No commission has been calculated for this seller order.', [
      { code: 'COMMISSION_NOT_CALCULATED' },
    ]);
  }
  const profile = group.sellerAccount.businessProfile;
  const billingSame = profile === null || (profile.billingAddressLine1 ?? '').trim() === '';
  const sellerAddress = {
    line1: billingSame ? (profile?.registeredAddressLine1 ?? null) : profile.billingAddressLine1,
    line2: billingSame ? (profile?.registeredAddressLine2 ?? null) : profile.billingAddressLine2,
    city: billingSame ? (profile?.registeredCity ?? null) : profile.billingCity,
    region: billingSame ? (profile?.registeredRegion ?? null) : profile.billingRegion,
    postcode: billingSame ? (profile?.registeredPostcode ?? null) : profile.billingPostcode,
    country: (billingSame ? profile?.registeredCountry : profile.billingCountry) ?? group.sellerAccount.registrationCountry,
  };
  const sellerCountry = clip(sellerAddress.country)?.toUpperCase() ?? null;
  const sellerTaxId = clip(profile?.taxRegistrationNumber, 64)?.toUpperCase() ?? null;

  const resolution = resolveCommissionTax(
    {
      regime: settings.taxRegime,
      country: settings.country,
      stateCode: settings.stateCode,
      taxRegistrationNumber: settings.taxRegistrationNumber,
      lutReference: settings.exportLutReference,
      zeroTaxDocumentType: settings.zeroTaxDocumentType,
      requireSellerTaxId: settings.requireSellerTaxId,
    },
    { country: sellerCountry, taxId: sellerTaxId, region: sellerAddress.region },
    {
      taxMinor: settlement.platformFeeTaxMinor,
      ratePercent: settlement.feeTaxRatePercent.toString(),
      verified: context.taxVerified,
      label: settlement.feeTaxLabel,
    },
  );

  const issues: CommissionIssue[] = [...issuerGaps(settings), ...resolution.issues];
  if ((group.sellerAccount.legalName ?? '').trim() === '') {
    issues.push({ field: 'seller.legalName', code: 'SELLER_LEGAL_NAME_MISSING', message: "The seller's legal business name is missing." });
  }
  if ((sellerAddress.line1 ?? '').trim() === '' || (sellerAddress.city ?? '').trim() === '') {
    issues.push({ field: 'seller.address', code: 'SELLER_ADDRESS_MISSING', message: "The seller's registered billing address is incomplete in their business profile." });
  }
  if (settlement.currency !== group.order.currency) {
    issues.push({ field: 'settlement.currency', code: 'CURRENCY_MISMATCH', message: 'The settlement and the order are in different currencies.' });
  }

  const currency = settlement.currency;
  const lines = buildCommissionLines({
    source: {
      platformFeeMinor: settlement.platformFeeMinor,
      platformFeeTaxMinor: settlement.platformFeeTaxMinor,
      feeTaxRatePercent: settlement.feeTaxRatePercent.toString(),
      feeBasisMinor: settlement.feeBasisMinor,
      breakdown: breakdownOf(settlement.breakdownJson),
    },
    currency,
    orderNumber: group.order.orderNumber,
    sellerOrderNumber: group.sellerOrderNumber,
    descriptionTemplate: settings.serviceDescription,
    serviceCode: settings.serviceCode,
    split: resolution.split,
  });
  const totals = commissionTotals(lines, currency, settings.roundGrandTotal);

  const issuer: IssuerSnapshot = {
    legalEntityCode: settings.legalEntityCode,
    legalName: clip(settings.legalName, 255) ?? '',
    tradeName: clip(settings.tradeName, 255),
    marketplaceName: context.marketplaceName,
    addressLines: addressLines({
      line1: settings.addressLine1,
      line2: settings.addressLine2,
      city: settings.city,
      region: settings.region,
      postcode: settings.postcode,
      country: settings.country,
    }),
    country: settings.country,
    stateCode: settings.taxRegime === 'IN_GST' ? settings.stateCode : null,
    stateName: settings.taxRegime === 'IN_GST' ? (GST_STATE_CODES[settings.stateCode ?? ''] ?? null) : null,
    taxRegime: settings.taxRegime,
    taxRegistrationLabel: settings.taxRegistrationLabel,
    taxRegistrationNumber: settings.taxRegime === 'NONE' ? null : clip(settings.taxRegistrationNumber, 32),
    businessIdentifierLabel: settings.businessIdentifierLabel,
    businessIdentifier: clip(settings.businessIdentifier, 32),
    businessEmail: clip(settings.businessEmail, 320),
    supportContact: clip(settings.supportContact, 160),
    jurisdictionNote: clip(settings.jurisdictionNote, 255),
    footerNote: clip(settings.footerNote, 1000),
    serviceCodeLabel: settings.serviceCodeLabel,
  };
  const seller: SellerSnapshot = {
    sellerAccountId: group.sellerAccount.id,
    legalName: clip(group.sellerAccount.legalName, 255) ?? '',
    displayName: clip(group.sellerAccount.displayName, 160) ?? '',
    addressLines: addressLines(sellerAddress),
    country: sellerCountry,
    region: clip(sellerAddress.region),
    stateCode: resolution.sellerStateCode,
    stateName: resolution.sellerStateCode === null ? null : (GST_STATE_CODES[resolution.sellerStateCode] ?? null),
    taxId: sellerTaxId,
    email: clip(profile?.supportEmail ?? profile?.representativeEmail, 320),
  };
  const adjusted = context.settlementLine?.settlement.status === 'PAID';
  const source: SourceSnapshot = {
    orderId: group.order.id,
    orderNumber: group.order.orderNumber,
    sellerOrderGroupId: group.id,
    sellerOrderNumber: group.sellerOrderNumber,
    paymentReference: context.payment?.providerPaymentId ?? context.payment?.id ?? null,
    paymentProvider: context.payment?.provider ?? null,
    settlementId: settlement.id,
    settlementReference: context.settlementLine?.settlement.reference ?? null,
    collection: adjusted ? 'ADJUSTED_AGAINST_SETTLEMENT' : 'PAYABLE_BY_SELLER',
    feePolicyId: settlement.platformFeePolicyId,
    feePolicyVersion: settlement.platformFeePolicyVersion,
    feeBasisMinor: settlement.feeBasisMinor.toString(),
    platformFeeMinor: settlement.platformFeeMinor.toString(),
    platformFeeTaxMinor: settlement.platformFeeTaxMinor.toString(),
    feeTaxRatePercent: settlement.feeTaxRatePercent.toString(),
    feeTaxLabel: settlement.feeTaxLabel,
    feeTaxVerified: context.taxVerified,
    settlementComputedAt: settlement.computedAt.toISOString(),
    tax: { split: resolution.split, labels: resolution.labels },
  };

  const hashed = {
    currency,
    documentType: resolution.documentType,
    treatment: resolution.treatment,
    reverseCharge: resolution.reverseCharge,
    placeOfSupply: resolution.placeOfSupply,
    issuer,
    seller,
    source,
    notes: resolution.declarations,
    lines,
    totals,
    template: COMMISSION_TEMPLATE_VERSION,
  };

  return {
    currency,
    documentType: resolution.documentType,
    treatment: resolution.treatment,
    reverseCharge: resolution.reverseCharge,
    placeOfSupply: resolution.placeOfSupply,
    issuer,
    seller,
    source,
    notes: resolution.declarations,
    lines,
    totals,
    amountInWords: commissionAmountInWords(totals.grandTotalMinor, currency),
    issues,
    snapshotHash: createHash('sha256').update(stableJson(hashed)).digest('hex'),
  };
}

function lineRows(invoiceId: string, lines: readonly CommissionLine[]): Prisma.CommissionInvoiceLineCreateManyInput[] {
  return lines.map((line) => ({
    id: newId(),
    invoiceId,
    position: line.position,
    kind: line.kind,
    description: line.description.slice(0, 512),
    detail: line.detail,
    serviceCode: line.serviceCode,
    orderReference: line.orderReference,
    feeType: line.feeType,
    basisMinor: line.basisMinor,
    feeRatePercent: line.feeRatePercent,
    policyId: line.policyId,
    policyVersion: line.policyVersion,
    taxableMinor: line.taxableMinor,
    taxRatePercent: line.taxRatePercent,
    cgstMinor: line.cgstMinor,
    sgstMinor: line.sgstMinor,
    igstMinor: line.igstMinor,
    otherTaxMinor: line.otherTaxMinor,
    taxMinor: line.taxMinor,
    totalMinor: line.totalMinor,
  }));
}

function snapshotColumns(built: Built) {
  return {
    currency: built.currency,
    documentType: built.documentType,
    taxTreatment: built.treatment,
    reverseCharge: built.reverseCharge,
    placeOfSupplyJson: (built.placeOfSupply ?? undefined) as never,
    issuerJson: built.issuer as never,
    sellerJson: built.seller as never,
    sourceJson: built.source as never,
    notesJson: built.notes as never,
    validationJson: built.issues as never,
    snapshotHash: built.snapshotHash,
    subtotalMinor: built.totals.subtotalMinor,
    discountMinor: built.totals.discountMinor,
    taxableMinor: built.totals.taxableMinor,
    cgstMinor: built.totals.cgstMinor,
    sgstMinor: built.totals.sgstMinor,
    igstMinor: built.totals.igstMinor,
    otherTaxMinor: built.totals.otherTaxMinor,
    totalTaxMinor: built.totals.totalTaxMinor,
    roundingMinor: built.totals.roundingMinor,
    grandTotalMinor: built.totals.grandTotalMinor,
    amountInWords: built.amountInWords.slice(0, 512),
    templateVersion: COMMISSION_TEMPLATE_VERSION,
  };
}

/** The stored document, back in the shape `build` produces - what a preview and a re-render read. */
function storedDocument(row: CommissionInvoice, lines: readonly CommissionInvoiceLine[]): Omit<Built, 'issues' | 'snapshotHash'> {
  return {
    currency: row.currency,
    documentType: row.documentType,
    treatment: row.taxTreatment as Built['treatment'],
    reverseCharge: row.reverseCharge,
    placeOfSupply: (row.placeOfSupplyJson as Built['placeOfSupply'] | null) ?? null,
    issuer: row.issuerJson as unknown as IssuerSnapshot,
    seller: row.sellerJson as unknown as SellerSnapshot,
    source: row.sourceJson as unknown as SourceSnapshot,
    notes: (row.notesJson as string[] | null) ?? [],
    lines: [...lines]
      .sort((a, b) => a.position - b.position)
      .map((line) => ({
        position: line.position,
        kind: line.kind as CommissionLine['kind'],
        description: line.description,
        detail: line.detail,
        serviceCode: line.serviceCode,
        orderReference: line.orderReference,
        feeType: line.feeType,
        basisMinor: line.basisMinor,
        feeRatePercent: line.feeRatePercent?.toString() ?? null,
        policyId: line.policyId,
        policyVersion: line.policyVersion,
        taxableMinor: line.taxableMinor,
        taxRatePercent: line.taxRatePercent.toString(),
        cgstMinor: line.cgstMinor,
        sgstMinor: line.sgstMinor,
        igstMinor: line.igstMinor,
        otherTaxMinor: line.otherTaxMinor,
        taxMinor: line.taxMinor,
        totalMinor: line.totalMinor,
      })),
    totals: {
      subtotalMinor: row.subtotalMinor,
      discountMinor: row.discountMinor,
      taxableMinor: row.taxableMinor,
      cgstMinor: row.cgstMinor,
      sgstMinor: row.sgstMinor,
      igstMinor: row.igstMinor,
      otherTaxMinor: row.otherTaxMinor,
      totalTaxMinor: row.totalTaxMinor,
      roundingMinor: row.roundingMinor,
      grandTotalMinor: row.grandTotalMinor,
    },
    amountInWords: row.amountInWords ?? '',
  };
}

// ---------------------------------------------------------------------------
// The PDF
// ---------------------------------------------------------------------------

const TITLES: Readonly<Record<Built['documentType'], string>> = Object.freeze({
  TAX_INVOICE: 'TAX INVOICE',
  INVOICE: 'INVOICE',
  BILL_OF_SUPPLY: 'BILL OF SUPPLY',
});

function formatDateTime(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
    timeZoneName: 'short',
  }).format(at);
}

function supplierParty(issuer: IssuerSnapshot) {
  const lines: string[] = [];
  if (issuer.tradeName !== null) lines.push(issuer.tradeName);
  lines.push(...issuer.addressLines);
  if (issuer.taxRegistrationNumber !== null) lines.push(`${issuer.taxRegistrationLabel}: ${issuer.taxRegistrationNumber}`);
  if (issuer.businessIdentifier !== null) lines.push(`${issuer.businessIdentifierLabel}: ${issuer.businessIdentifier}`);
  if (issuer.stateCode !== null) lines.push(`State: ${issuer.stateName ?? issuer.stateCode} (${issuer.stateCode})`);
  if (issuer.businessEmail !== null) lines.push(issuer.businessEmail);
  if (issuer.supportContact !== null) lines.push(`Support: ${issuer.supportContact}`);
  return { heading: 'From — Supplier', name: issuer.legalName === '' ? '(legal name not set)' : issuer.legalName, lines };
}

function sellerParty(seller: SellerSnapshot, taxLabel: string) {
  const lines: string[] = [];
  if (seller.displayName !== '' && seller.displayName !== seller.legalName) lines.push(`Display name: ${seller.displayName}`);
  lines.push(`Seller ID: ${seller.sellerAccountId}`);
  lines.push(...seller.addressLines);
  if (seller.taxId !== null) lines.push(`${taxLabel}: ${seller.taxId}`);
  if (seller.stateCode !== null) lines.push(`State: ${seller.stateName ?? seller.stateCode} (${seller.stateCode})`);
  if (seller.email !== null) lines.push(seller.email);
  return { heading: 'Bill To — Seller', name: seller.legalName, lines };
}

function placeOfSupplyLabel(place: Built['placeOfSupply']): string {
  if (place === null) return '-';
  return place.code === place.name ? place.code : `${place.name} (${place.code})`;
}

/** The tax rows under the totals: each component that applies, with its rate where there is one rate. */
function taxTotalRows(document: Omit<Built, 'issues' | 'snapshotHash'>, totals: { cgstMinor: Minor; sgstMinor: Minor; igstMinor: Minor; otherTaxMinor: Minor }) {
  const rates = [...new Set(document.lines.map((line) => trimPercent(line.taxRatePercent)))];
  const single = rates.length === 1 ? (rates[0] ?? null) : null;
  const labels = document.source.tax.labels;
  const plain = (amount: Minor) => formatPlain(amount, document.currency);
  const rows: { label: string; value: string }[] = [];
  const split = document.source.tax.split;
  if (split === 'CGST_SGST') {
    const half = single === null ? null : halfRate(single);
    rows.push({ label: half === null ? labels.cgst : `${labels.cgst} (${half}%)`, value: plain(totals.cgstMinor) });
    rows.push({ label: half === null ? labels.sgst : `${labels.sgst} (${half}%)`, value: plain(totals.sgstMinor) });
  } else if (split === 'IGST') {
    rows.push({ label: single === null ? labels.igst : `${labels.igst} (${single}%)`, value: plain(totals.igstMinor) });
  } else if (split === 'OTHER') {
    rows.push({ label: single === null ? labels.other : `${labels.other} (${single}%)`, value: plain(totals.otherTaxMinor) });
  } else {
    rows.push({ label: 'Tax', value: plain(0n) });
  }
  return rows;
}

function invoicePdf(
  document: Omit<Built, 'issues' | 'snapshotHash'>,
  meta: {
    draft: boolean;
    number: string | null;
    issuedAt: Date;
    financialYear: string | null;
    dueDay: string | null;
    status: string;
    timezone: string;
  },
): CommissionPdfDocument {
  const { currency } = document;
  const plain = (amount: Minor) => formatPlain(amount, currency);
  const title = TITLES[document.documentType];
  const facts: [string, string][] = [
    ['Invoice no.', meta.number ?? 'Assigned at issue'],
    ['Invoice date', meta.draft ? 'Set at issue' : formatDateTime(meta.issuedAt, meta.timezone)],
    ['Financial year', meta.financialYear ?? '-'],
  ];
  if (meta.dueDay !== null) facts.push(['Due date', formatDay(meta.dueDay)]);
  facts.push(
    ['Currency', currency],
    ['Place of supply', placeOfSupplyLabel(document.placeOfSupply)],
    ['Reverse charge', document.reverseCharge ? 'Yes' : 'No'],
    ['Order no.', document.source.orderNumber],
    ['Payment ref.', document.source.paymentReference ?? '-'],
    ['Settlement ref.', document.source.settlementReference ?? 'Not yet settled'],
  );
  if (meta.draft) facts.push(['Status', 'Draft']);

  const adjusted = document.source.collection === 'ADJUSTED_AGAINST_SETTLEMENT';
  const number = meta.number;
  return {
    title,
    subtitle: 'Platform Commission',
    draft: meta.draft,
    number: meta.draft ? null : number,
    issuedAt: meta.issuedAt,
    supplier: supplierParty(document.issuer),
    recipient: sellerParty(document.seller, document.issuer.taxRegime === 'IN_GST' ? 'GSTIN' : 'Tax ID'),
    facts,
    currency,
    codeHeader: document.issuer.serviceCodeLabel,
    lines: document.lines.map((line) => ({
      description: line.description,
      detail: line.detail,
      code: line.serviceCode ?? '-',
      orderReference: line.orderReference,
      taxable: plain(line.taxableMinor),
      rate: `${trimPercent(line.taxRatePercent)}%`,
      tax: plain(line.taxMinor),
      total: plain(line.totalMinor),
    })),
    totals: [
      { label: 'Commission subtotal', value: plain(document.totals.subtotalMinor) },
      { label: 'Discount / adjustment', value: plain(document.totals.discountMinor) },
      { label: 'Taxable value', value: plain(document.totals.taxableMinor) },
      ...taxTotalRows(document, document.totals),
      { label: 'Rounding', value: plain(document.totals.roundingMinor) },
      { label: 'Grand total', value: formatAmount(document.totals.grandTotalMinor, currency), strong: true },
    ],
    amountInWords: document.amountInWords,
    collection: adjusted
      ? {
          label: 'Adjusted Against Seller Settlement',
          value: formatAmount(document.totals.grandTotalMinor, currency),
          note: document.source.settlementReference === null ? null : `Settlement ${document.source.settlementReference}.`,
        }
      : {
          label: `Amount Payable by Seller to ${document.issuer.marketplaceName}`,
          value: formatAmount(document.totals.grandTotalMinor, currency),
          note: 'Outstanding at issue.',
        },
    declarations: document.notes,
    qr:
      meta.draft || number === null
        ? null
        : {
            url: verificationUrl('commission-invoice', number),
            caption: 'Verify this document: scan to confirm it was issued by the supplier above. This is not a GST e-invoice QR code; no IRN has been generated.',
          },
    footerLines: [
      'Invoice for marketplace services supplied to the seller. Not the seller’s invoice to the buyer, not a shipping label, not a receipt and not proof of any transfer.',
      ...(document.issuer.jurisdictionNote === null ? [] : [document.issuer.jurisdictionNote]),
      ...(document.issuer.footerNote === null ? [] : [document.issuer.footerNote]),
      'Computer-generated document; no signature required.',
    ],
    brand: document.issuer.marketplaceName,
    metadata: {
      title: `Commission invoice ${number ?? 'DRAFT'}`,
      subject: `${title} - Platform Commission`,
      author: document.issuer.legalName,
      keywords: `commission invoice, ${number ?? 'draft'}, ${document.documentType}, ${meta.status}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Numbers, storage, events
// ---------------------------------------------------------------------------

/** Make sure the counter row exists, outside any transaction, so first use cannot race on the insert. */
async function ensureSequence(key: string, prefix: string, padding: number): Promise<void> {
  await prisma.numberSequence.createMany({ data: [{ key, value: 0n, prefix: prefix.slice(0, 16), padding }], skipDuplicates: true });
}

/** The next number, under the counter row's lock. Rolled back with the transaction that took it. */
async function takeNumber(tx: PrismaTransaction, key: string): Promise<number> {
  const row = await tx.numberSequence.update({ where: { key }, data: { value: { increment: 1 } } });
  return Number(row.value);
}

async function storePdf(bytes: Buffer, stored: string[]) {
  const object = await storage.put(bytes, 'application/pdf', 'pdf', 'private');
  stored.push(object.storageKey);
  return { storageKey: object.storageKey, contentHash: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length };
}

async function discardStored(keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    await storage.delete(key).catch((error: unknown) => {
      logger.warn({ err: error, key }, 'could not remove a commission document left by a rolled-back issue');
    });
  }
}

function jsonSafe(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(stableJson(value)) as Prisma.InputJsonValue;
}

async function event(
  tx: Client,
  input: {
    invoiceId: string;
    creditNoteId?: string | null;
    action: string;
    from?: string | null;
    to?: string | null;
    actor: FinanceActor | null;
    detail?: Record<string, unknown>;
    snapshotHash?: string | null;
  },
): Promise<void> {
  await tx.commissionInvoiceEvent.create({
    data: {
      id: newId(),
      invoiceId: input.invoiceId,
      creditNoteId: input.creditNoteId ?? null,
      action: input.action,
      fromStatus: input.from ?? null,
      toStatus: input.to ?? null,
      actorUserId: input.actor?.userId ?? null,
      detailJson: input.detail === undefined ? undefined : jsonSafe(input.detail),
      snapshotHash: input.snapshotHash ?? null,
    },
  });
}

async function audit(action: string, invoiceId: string, actor: FinanceActor, after: Record<string, unknown>, tx?: Client): Promise<void> {
  await recordAudit(
    {
      action: action as (typeof AuditAction)[keyof typeof AuditAction],
      resourceType: 'commission_invoice',
      resourceId: invoiceId,
      actorType: 'ADMIN',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      after: JSON.parse(stableJson(after)) as Record<string, unknown>,
      ipAddress: actor.ipAddress ?? null,
      correlationId: actor.correlationId ?? null,
    },
    tx,
  );
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

// ---------------------------------------------------------------------------
// Generate, regenerate, discard
// ---------------------------------------------------------------------------

export const idempotencyKeySchema = z.string().trim().min(8).max(128);

/**
 * Create the draft commission invoice for one seller order - or return the one
 * that already exists. Safe to call any number of times: a retry with the same
 * key returns the same draft, and a second key for an order that already has a
 * live invoice returns that invoice.
 */
export async function generateDraft(actor: FinanceActor, sellerOrderGroupId: string, idempotencyKey: string) {
  const key = idempotencyKeySchema.parse(idempotencyKey);
  const replay = await prisma.commissionInvoice.findUnique({ where: { idempotencyKey: key } });
  if (replay !== null) {
    if (replay.sellerOrderGroupId !== sellerOrderGroupId) {
      throw conflict(ErrorCode.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY, 'This Idempotency-Key was already used for another seller order.');
    }
    return { invoice: await readInvoice(replay.id), created: false };
  }

  const settings = await loadSettings();
  const context = await loadContext(prisma, sellerOrderGroupId);
  const settlementId = context.group.settlement?.id ?? null;
  if (settlementId !== null) {
    const live = await prisma.commissionInvoice.findUnique({ where: { activeKey: settlementId } });
    if (live !== null) return { invoice: await readInvoice(live.id), created: false };
  }
  const blockers = eligibilityBlockers(context, settings);
  if (blockers.length > 0 || settlementId === null) {
    throw unprocessable(ErrorCode.COMMISSION_INVOICE_NOT_ELIGIBLE, 'This seller order cannot have a commission invoice yet.', blockers);
  }

  const built = build(context, settings);
  const id = newId();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.commissionInvoice.create({
        data: {
          id,
          legalEntityCode: settings.legalEntityCode,
          sellerAccountId: context.group.sellerAccount.id,
          orderId: context.group.orderId,
          sellerOrderGroupId: context.group.id,
          settlementId,
          status: 'DRAFT',
          activeKey: activeKeyFor('DRAFT', settlementId),
          idempotencyKey: key,
          createdByUserId: actor.userId,
          ...snapshotColumns(built),
        },
      });
      await tx.commissionInvoiceLine.createMany({ data: lineRows(id, built.lines) });
      await event(tx, {
        invoiceId: id,
        action: 'generated',
        to: 'DRAFT',
        actor,
        detail: { grandTotalMinor: built.totals.grandTotalMinor, currency: built.currency, issues: built.issues.length },
        snapshotHash: built.snapshotHash,
      });
      await audit(AuditAction.COMMISSION_INVOICE_GENERATED, id, actor, { sellerOrderGroupId, snapshotHash: built.snapshotHash }, tx);
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Two requests raced; the other one's draft is the draft.
    const winner =
      (await prisma.commissionInvoice.findUnique({ where: { idempotencyKey: key } })) ??
      (await prisma.commissionInvoice.findUnique({ where: { activeKey: settlementId } }));
    if (winner === null) throw error;
    return { invoice: await readInvoice(winner.id), created: false };
  }
  return { invoice: await readInvoice(id), created: true };
}

async function lockInvoice(tx: PrismaTransaction, invoiceId: string): Promise<CommissionInvoice> {
  await tx.$queryRaw`SELECT id FROM commission_invoices WHERE id = ${invoiceId} FOR UPDATE`;
  const row = await tx.commissionInvoice.findUnique({ where: { id: invoiceId } });
  if (row === null) throw notFound('Commission invoice');
  return row;
}

/** Rebuild a draft from its sources - after the seller fixed their profile, or finance verified the tax rule. */
export async function regenerateDraft(actor: FinanceActor, invoiceId: string) {
  const settings = await loadSettings();
  await prisma.$transaction(async (tx) => {
    const row = await lockInvoice(tx, invoiceId);
    assertCommissionMove(row.status, 'REGENERATE');
    const built = build(await loadContext(tx, row.sellerOrderGroupId), settings);
    await tx.commissionInvoiceLine.deleteMany({ where: { invoiceId } });
    await tx.commissionInvoiceLine.createMany({ data: lineRows(invoiceId, built.lines) });
    await tx.commissionInvoice.update({ where: { id: invoiceId }, data: { ...snapshotColumns(built), legalEntityCode: settings.legalEntityCode } });
    await event(tx, {
      invoiceId,
      action: 'regenerated',
      from: 'DRAFT',
      to: 'DRAFT',
      actor,
      detail: { previousHash: row.snapshotHash, grandTotalMinor: built.totals.grandTotalMinor, issues: built.issues.length },
      snapshotHash: built.snapshotHash,
    });
    await audit(AuditAction.COMMISSION_INVOICE_REGENERATED, invoiceId, actor, { previousHash: row.snapshotHash, snapshotHash: built.snapshotHash }, tx);
  });
  return readInvoice(invoiceId);
}

// ---------------------------------------------------------------------------
// Preview and issue
// ---------------------------------------------------------------------------

/** The draft PDF: watermarked, no number, no barcode, no QR. Issued invoices are downloaded, not previewed. */
export async function previewPdf(actor: FinanceActor, invoiceId: string): Promise<{ bytes: Buffer; fileName: string }> {
  const row = await prisma.commissionInvoice.findUnique({ where: { id: invoiceId }, include: { lines: true } });
  if (row === null) throw notFound('Commission invoice');
  if (row.status !== 'DRAFT') {
    throw conflict(ErrorCode.COMMISSION_INVOICE_IMMUTABLE, 'Only a draft is previewed. Download the issued PDF instead.', [{ code: 'NOT_DRAFT' }]);
  }
  const timezone = await operatorTimezone();
  const draftDocument = storedDocument(row, row.lines);
  const rendered = await renderers.commission(
    invoicePdf(draftDocument, {
      draft: true,
      number: null,
      issuedAt: row.updatedAt,
      financialYear: null,
      dueDay: null,
      status: row.status,
      timezone,
    }),
  );
  await event(prisma, { invoiceId, action: 'previewed', actor, snapshotHash: row.snapshotHash, detail: { pages: rendered.pageCount } });
  await audit(AuditAction.COMMISSION_INVOICE_PREVIEWED, invoiceId, actor, { snapshotHash: row.snapshotHash });
  return { bytes: rendered.bytes, fileName: documentFileName('invoice', `DRAFT-${row.id}`, draftDocument.issuer.marketplaceName) };
}

async function operatorTimezone(client: Client = prisma): Promise<string> {
  const profile = await client.businessProfile.findFirst({ select: { timezone: true } });
  return resolveTimezone(profile?.timezone, 'UTC');
}

function addDays(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const value = new Date(Date.UTC(year, month - 1, date + days));
  return value.toISOString().slice(0, 10);
}

/**
 * Issue a draft. Returns the issued invoice; an invoice that is already issued
 * is returned as it is, so a double click or a retried request issues once.
 *
 * `expectedSnapshotHash` is the hash of the draft the person previewed. If the
 * sources moved since - the seller edited their address, a refund changed the
 * settlement - the rebuilt draft has a different hash and nothing is issued:
 * the person is asked to regenerate and look again. What they approved is
 * what is issued, or nothing is.
 */
export async function issueInvoice(actor: FinanceActor, invoiceId: string, expectedSnapshotHash: string | null) {
  const current = await prisma.commissionInvoice.findUnique({ where: { id: invoiceId } });
  if (current === null) throw notFound('Commission invoice');
  if (isIssuedStatus(current.status)) return { invoice: await readInvoice(invoiceId), created: false };

  const settings = await loadSettings();
  const timezone = await operatorTimezone();
  const issuedAt = new Date();
  const issueDay = todayIn(timezone, issuedAt);
  const fy = commissionFinancialYear(issueDay, settings.financialYearStartMonth);
  const key = sequenceKey('invoice', settings.invoicePrefix, fy);
  await ensureSequence(key, settings.invoicePrefix, settings.sequencePadding);

  const stored: string[] = [];
  let outcome = 'issued' as 'issued' | 'already';
  try {
    await prisma.$transaction(
      async (tx) => {
        const row = await lockInvoice(tx, invoiceId);
        if (isIssuedStatus(row.status)) {
          outcome = 'already';
          return;
        }
        const next = assertCommissionMove(row.status, 'ISSUE');
        const context = await loadContext(tx, row.sellerOrderGroupId);
        const blockers = eligibilityBlockers(context, settings);
        if (blockers.length > 0) {
          throw unprocessable(ErrorCode.COMMISSION_INVOICE_NOT_ELIGIBLE, 'This seller order can no longer be invoiced.', blockers);
        }
        const built = build(context, settings);
        if (built.issues.length > 0) {
          throw new AppError({
            statusCode: 422,
            code: ErrorCode.COMMISSION_INVOICE_VALIDATION_FAILED,
            message: 'The invoice cannot be issued until these are fixed.',
            details: built.issues,
          });
        }
        if (built.snapshotHash !== row.snapshotHash || (expectedSnapshotHash !== null && expectedSnapshotHash !== row.snapshotHash)) {
          throw new AppError({
            statusCode: 422,
            code: ErrorCode.COMMISSION_INVOICE_VALIDATION_FAILED,
            message: 'The figures or details behind this draft have changed since it was built. Regenerate it and review the preview again.',
            details: [{ code: 'SOURCES_CHANGED', field: 'snapshotHash', message: 'Regenerate the draft and review it before issuing.' }],
          });
        }

        const sequence = await takeNumber(tx, key);
        const number = formatDocumentNumber(settings.invoicePrefix, fy, sequence, settings.sequencePadding);
        const dueDay = settings.paymentTermsDays === null ? null : addDays(issueDay, settings.paymentTermsDays);

        let rendered: { bytes: Buffer; pageCount: number };
        try {
          rendered = await renderers.commission(
            invoicePdf(built, { draft: false, number, issuedAt, financialYear: fy, dueDay, status: 'ISSUED', timezone }),
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
        await tx.commissionDocument.create({
          data: {
            id: documentId,
            invoiceId,
            kind: 'INVOICE',
            storageKey: file.storageKey,
            fileName: documentFileName('invoice', number, built.issuer.marketplaceName),
            contentHash: file.contentHash,
            sizeBytes: file.sizeBytes,
            pageCount: rendered.pageCount,
            templateVersion: COMMISSION_TEMPLATE_VERSION,
          },
        });
        const updated = await tx.commissionInvoice.updateMany({
          where: { id: invoiceId, status: 'DRAFT' },
          data: {
            ...snapshotColumns(built),
            status: next,
            activeKey: activeKeyFor(next, row.settlementId),
            legalEntityCode: settings.legalEntityCode,
            series: settings.invoicePrefix,
            financialYear: fy,
            sequenceNumber: sequence,
            number,
            issueDate: new Date(`${issueDay}T00:00:00.000Z`),
            issuedAt,
            dueDate: dueDay === null ? null : new Date(`${dueDay}T00:00:00.000Z`),
            issuedByUserId: actor.userId,
            collectionStatus: built.source.collection === 'ADJUSTED_AGAINST_SETTLEMENT' ? 'ADJUSTED_AGAINST_SETTLEMENT' : 'OUTSTANDING',
          },
        });
        if (updated.count !== 1) {
          throw conflict(ErrorCode.COMMISSION_INVOICE_IMMUTABLE, 'This invoice was issued a moment ago.', [{ code: 'ALREADY_ISSUED' }]);
        }
        await event(tx, {
          invoiceId,
          action: 'issued',
          from: 'DRAFT',
          to: next,
          actor,
          detail: { number, grandTotalMinor: built.totals.grandTotalMinor, currency: built.currency, contentHash: file.contentHash, pages: rendered.pageCount },
          snapshotHash: built.snapshotHash,
        });
        await audit(
          AuditAction.COMMISSION_INVOICE_ISSUED,
          invoiceId,
          actor,
          { number, sellerAccountId: row.sellerAccountId, grandTotalMinor: built.totals.grandTotalMinor, currency: built.currency, contentHash: file.contentHash },
          tx,
        );
      },
      { timeout: 30_000, maxWait: 15_000 },
    );
  } catch (error) {
    await discardStored(stored);
    throw error;
  }
  if (outcome === 'already') await discardStored(stored);
  return { invoice: await readInvoice(invoiceId), created: outcome === 'issued' };
}

// ---------------------------------------------------------------------------
// Void, collection
// ---------------------------------------------------------------------------

export const voidInputSchema = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();

/**
 * Discard a draft, or - only where the settings permit it and nothing has
 * been credited - void an issued invoice. A voided number is never reused:
 * the counter only moves forward, and the event records the number voided.
 */
export async function voidInvoice(actor: FinanceActor, invoiceId: string, raw: unknown, expect: 'DRAFT' | 'ISSUED') {
  const { reason } = voidInputSchema.parse(raw);
  const settings = await loadSettings();
  await prisma.$transaction(async (tx) => {
    const row = await lockInvoice(tx, invoiceId);
    if (row.status === 'VOID') return;
    // Discarding a draft and voiding an issued invoice are different acts with
    // different permissions, so each route may only do its own.
    const move = expect === 'DRAFT' ? 'DISCARD' : 'VOID_ISSUED';
    if (move === 'VOID_ISSUED' && !settings.allowVoidAfterIssue) {
      throw conflict(
        ErrorCode.COMMISSION_INVOICE_VOID_NOT_PERMITTED,
        'Issued commission invoices cannot be voided under the current settings. Issue a credit note instead.',
      );
    }
    const next = assertCommissionMove(row.status, move);
    await tx.commissionInvoice.update({
      where: { id: invoiceId },
      data: { status: next, activeKey: null, voidedAt: new Date(), voidReason: reason, voidedByUserId: actor.userId },
    });
    await event(tx, {
      invoiceId,
      action: move === 'DISCARD' ? 'voided' : 'number_voided',
      from: row.status,
      to: next,
      actor,
      detail: { number: row.number, reasonLength: reason.length },
    });
    await audit(AuditAction.COMMISSION_INVOICE_VOIDED, invoiceId, actor, { number: row.number, from: row.status, reason }, tx);
  });
  return readInvoice(invoiceId);
}

export const collectionInputSchema = z
  .object({
    reference: z.string().trim().min(2).max(128),
    collectedAt: z.coerce.date().optional(),
  })
  .strict();

/**
 * Record that the seller paid. A statement by finance, with the reference of
 * the payment they received - never inferred, and never printed onto the
 * issued PDF, which says what was true when it was issued.
 */
export async function recordCollection(actor: FinanceActor, invoiceId: string, raw: unknown) {
  const input = collectionInputSchema.parse(raw);
  await prisma.$transaction(async (tx) => {
    const row = await lockInvoice(tx, invoiceId);
    if (!isIssuedStatus(row.status)) {
      throw conflict(ErrorCode.COMMISSION_INVOICE_INVALID_TRANSITION, 'Only an issued invoice can be marked paid.', [
        { code: 'INVALID_TRANSITION', meta: { status: row.status, move: 'RECORD_COLLECTION' } },
      ]);
    }
    const collectedAt = input.collectedAt ?? new Date();
    await tx.commissionInvoice.update({
      where: { id: invoiceId },
      data: { collectionStatus: 'PAID', collectionReference: input.reference, collectedAt },
    });
    await event(tx, {
      invoiceId,
      action: 'collection_recorded',
      actor,
      detail: { from: row.collectionStatus, to: 'PAID', collectedAt: collectedAt.toISOString() },
    });
    await audit(AuditAction.COMMISSION_INVOICE_COLLECTION_RECORDED, invoiceId, actor, { reference: input.reference, collectedAt }, tx);
  });
  return readInvoice(invoiceId);
}

// ---------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------

export const creditInputSchema = z
  .object({
    reason: z.enum(['ORDER_CANCELLED', 'FULL_REFUND', 'PARTIAL_REFUND', 'COMMISSION_REVERSAL', 'CHARGEBACK', 'SELLER_DISPUTE', 'TAX_ADJUSTMENT']),
    basis: z.enum(['FULL', 'PROPORTIONAL_TO_REFUND', 'CUSTOM_AMOUNT']),
    /** Taxable amount to reverse, in minor units. CUSTOM_AMOUNT only. */
    taxableMinor: z.string().trim().regex(/^\d{1,18}$/).optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

interface StoredCreditLine {
  position: number;
  taxableMinor: string;
  cgstMinor: string;
  sgstMinor: string;
  igstMinor: string;
  otherTaxMinor: string;
  taxMinor: string;
}

function creditedLines(notes: { linesJson: Prisma.JsonValue }[]) {
  const byPosition = new Map<number, { position: number; taxableMinor: Minor; cgstMinor: Minor; sgstMinor: Minor; igstMinor: Minor; otherTaxMinor: Minor }>();
  for (const note of notes) {
    for (const line of (note.linesJson as unknown as StoredCreditLine[] | null) ?? []) {
      const entry = byPosition.get(line.position) ?? { position: line.position, taxableMinor: 0n, cgstMinor: 0n, sgstMinor: 0n, igstMinor: 0n, otherTaxMinor: 0n };
      entry.taxableMinor += BigInt(line.taxableMinor);
      entry.cgstMinor += BigInt(line.cgstMinor);
      entry.sgstMinor += BigInt(line.sgstMinor);
      entry.igstMinor += BigInt(line.igstMinor);
      entry.otherTaxMinor += BigInt(line.otherTaxMinor);
      byPosition.set(line.position, entry);
    }
  }
  return [...byPosition.values()];
}

const REASON_WORDS: Readonly<Record<z.infer<typeof creditInputSchema>['reason'], string>> = Object.freeze({
  ORDER_CANCELLED: 'Order cancelled',
  FULL_REFUND: 'Full refund to the buyer',
  PARTIAL_REFUND: 'Partial refund to the buyer',
  COMMISSION_REVERSAL: 'Commission reversal',
  CHARGEBACK: 'Chargeback',
  SELLER_DISPUTE: 'Seller dispute',
  TAX_ADJUSTMENT: 'Tax adjustment',
});

/**
 * Issue a credit note against an issued commission invoice.
 *
 * The amount is the server's: everything left (FULL), the refunded share of
 * the fee from the settlement's own refund figure (PROPORTIONAL_TO_REFUND),
 * or a taxable amount finance entered (CUSTOM_AMOUNT) - never a total or a tax
 * the client worked out. The tax follows the taxable amount line by line and
 * component by component, and a credit can never take the invoice below zero.
 */
export async function createCreditNote(actor: FinanceActor, invoiceId: string, raw: unknown, idempotencyKey: string) {
  const input = creditInputSchema.parse(raw);
  const key = idempotencyKeySchema.parse(idempotencyKey);
  const replay = await prisma.commissionCreditNote.findUnique({ where: { idempotencyKey: key } });
  if (replay !== null) {
    if (replay.invoiceId !== invoiceId) {
      throw conflict(ErrorCode.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY, 'This Idempotency-Key was already used for another invoice.');
    }
    return { invoice: await readInvoice(invoiceId), creditNoteId: replay.id, created: false };
  }
  if (input.basis === 'CUSTOM_AMOUNT' && input.taxableMinor === undefined) {
    throw badRequest(ErrorCode.COMMISSION_CREDIT_INVALID, 'Enter the taxable amount to credit.', [{ field: 'taxableMinor', code: 'REQUIRED' }]);
  }

  const settings = await loadSettings();
  const timezone = await operatorTimezone();
  const issuedAt = new Date();
  const issueDay = todayIn(timezone, issuedAt);
  const fy = commissionFinancialYear(issueDay, settings.financialYearStartMonth);
  const seqKey = sequenceKey('credit-note', settings.creditNotePrefix, fy);
  await ensureSequence(seqKey, settings.creditNotePrefix, settings.sequencePadding);

  const stored: string[] = [];
  const creditNoteId = newId();
  try {
    await prisma.$transaction(
      async (tx) => {
        const row = await lockInvoice(tx, invoiceId);
        if (!isIssuedStatus(row.status) || row.status === 'FULLY_CREDITED') {
          throw conflict(ErrorCode.COMMISSION_CREDIT_INVALID, row.status === 'FULLY_CREDITED' ? 'This invoice is already fully credited.' : 'Only an issued invoice can be credited.', [
            { code: 'STATUS', meta: { status: row.status } },
          ]);
        }
        const lines = await tx.commissionInvoiceLine.findMany({ where: { invoiceId }, orderBy: { position: 'asc' } });
        const earlier = await tx.commissionCreditNote.findMany({ where: { invoiceId }, select: { linesJson: true, roundingMinor: true, taxableMinor: true } });
        const credited = creditedLines(earlier);
        const alreadyTaxable = earlier.reduce((sum, note) => sum + note.taxableMinor, 0n);
        const remaining = row.taxableMinor - alreadyTaxable;

        let taxable: Minor;
        if (input.basis === 'FULL') {
          taxable = remaining;
        } else if (input.basis === 'CUSTOM_AMOUNT') {
          taxable = BigInt(input.taxableMinor ?? '0');
        } else {
          const settlement = await tx.sellerOrderSettlement.findUniqueOrThrow({ where: { id: row.settlementId } });
          taxable = proportionalCreditTaxable({
            invoiceTaxableMinor: row.taxableMinor,
            alreadyCreditedTaxableMinor: alreadyTaxable,
            refundedMinor: settlement.refundsAdjustmentsMinor,
            proceedsMinor: settlement.grossProceedsMinor + settlement.sellerDeliveryProceedsMinor,
          });
          if (taxable <= 0n) {
            throw conflict(ErrorCode.COMMISSION_CREDIT_INVALID, 'No refund recorded on this seller order is left to credit in proportion.', [{ code: 'NO_REFUND' }]);
          }
        }

        let figures;
        try {
          figures = creditFigures({
            invoice: lines,
            credited,
            invoiceRoundingMinor: row.roundingMinor,
            creditedRoundingMinor: earlier.reduce((sum, note) => sum + note.roundingMinor, 0n),
            taxableMinor: taxable,
            currency: row.currency,
            roundGrandTotal: settings.roundGrandTotal,
          });
        } catch (error) {
          if (error instanceof CreditArithmeticError) {
            throw conflict(ErrorCode.COMMISSION_CREDIT_INVALID, error.message, [{ code: 'AMOUNT', meta: { remainingMinor: remaining.toString() } }]);
          }
          throw error;
        }
        const next = assertCommissionMove(row.status, figures.completes ? 'CREDIT_REST' : 'CREDIT_PART');

        const sequence = await takeNumber(tx, seqKey);
        const number = formatDocumentNumber(settings.creditNotePrefix, fy, sequence, settings.sequencePadding);
        const invoiceDocument = storedDocument(row, lines);
        const reasonWords = REASON_WORDS[input.reason];

        const pdf = creditNotePdf(invoiceDocument, {
          number,
          issuedAt,
          financialYear: fy,
          timezone,
          invoiceNumber: row.number ?? '',
          invoiceDay: row.issueDate?.toISOString().slice(0, 10) ?? issueDay,
          reason: reasonWords,
          note: input.note ?? null,
          figures,
        });
        let rendered: { bytes: Buffer; pageCount: number };
        try {
          rendered = await renderers.commission(pdf);
        } catch (error) {
          throw new AppError({ statusCode: 500, code: ErrorCode.DOCUMENT_RENDER_FAILED, message: 'The credit note PDF could not be produced. Nothing was issued.', cause: error });
        }
        const file = await storePdf(rendered.bytes, stored);

        await tx.commissionCreditNote.create({
          data: {
            id: creditNoteId,
            invoiceId,
            legalEntityCode: settings.legalEntityCode,
            sellerAccountId: row.sellerAccountId,
            idempotencyKey: key,
            series: settings.creditNotePrefix,
            financialYear: fy,
            sequenceNumber: sequence,
            number,
            issueDate: new Date(`${issueDay}T00:00:00.000Z`),
            issuedAt,
            reason: input.reason,
            basis: input.basis,
            note: input.note ?? null,
            currency: row.currency,
            taxableMinor: figures.taxableMinor,
            cgstMinor: figures.cgstMinor,
            sgstMinor: figures.sgstMinor,
            igstMinor: figures.igstMinor,
            otherTaxMinor: figures.otherTaxMinor,
            totalTaxMinor: figures.totalTaxMinor,
            roundingMinor: figures.roundingMinor,
            grandTotalMinor: figures.grandTotalMinor,
            amountInWords: commissionAmountInWords(figures.grandTotalMinor, row.currency).slice(0, 512),
            linesJson: JSON.parse(stableJson(figures.lines)) as never,
            issuedByUserId: actor.userId,
          },
        });
        await tx.commissionDocument.create({
          data: {
            id: newId(),
            creditNoteId,
            kind: 'CREDIT_NOTE',
            storageKey: file.storageKey,
            fileName: documentFileName('credit-note', number, invoiceDocument.issuer.marketplaceName),
            contentHash: file.contentHash,
            sizeBytes: file.sizeBytes,
            pageCount: rendered.pageCount,
            templateVersion: COMMISSION_TEMPLATE_VERSION,
          },
        });
        await tx.commissionInvoice.update({
          where: { id: invoiceId },
          data: { status: next, activeKey: activeKeyFor(next, row.settlementId), creditedMinor: row.creditedMinor + figures.grandTotalMinor },
        });
        await event(tx, {
          invoiceId,
          creditNoteId,
          action: 'credited',
          from: row.status,
          to: next,
          actor,
          detail: { number, reason: input.reason, basis: input.basis, grandTotalMinor: figures.grandTotalMinor, contentHash: file.contentHash },
        });
        await audit(
          AuditAction.COMMISSION_CREDIT_NOTE_ISSUED,
          invoiceId,
          actor,
          { creditNoteNumber: number, invoiceNumber: row.number, reason: input.reason, basis: input.basis, grandTotalMinor: figures.grandTotalMinor, contentHash: file.contentHash },
          tx,
        );
      },
      { timeout: 30_000, maxWait: 15_000 },
    );
  } catch (error) {
    await discardStored(stored);
    if (isUniqueViolation(error)) {
      const winner = await prisma.commissionCreditNote.findUnique({ where: { idempotencyKey: key } });
      if (winner !== null) return { invoice: await readInvoice(invoiceId), creditNoteId: winner.id, created: false };
    }
    throw error;
  }
  return { invoice: await readInvoice(invoiceId), creditNoteId, created: true };
}

function creditNotePdf(
  invoice: Omit<Built, 'issues' | 'snapshotHash'>,
  meta: {
    number: string;
    issuedAt: Date;
    financialYear: string;
    timezone: string;
    invoiceNumber: string;
    invoiceDay: string;
    reason: string;
    note: string | null;
    figures: ReturnType<typeof creditFigures>;
  },
): CommissionPdfDocument {
  const { currency } = invoice;
  const plain = (amount: Minor) => formatPlain(amount, currency);
  const byPosition = new Map(invoice.lines.map((line) => [line.position, line]));
  const base = invoicePdf(invoice, {
    draft: false,
    number: meta.number,
    issuedAt: meta.issuedAt,
    financialYear: meta.financialYear,
    dueDay: null,
    status: 'ISSUED',
    timezone: meta.timezone,
  });
  return {
    ...base,
    title: 'CREDIT NOTE',
    facts: [
      ['Credit note no.', meta.number],
      ['Date', formatDateTime(meta.issuedAt, meta.timezone)],
      ['Financial year', meta.financialYear],
      ['Against invoice', meta.invoiceNumber],
      ['Invoice date', formatDay(meta.invoiceDay)],
      ['Currency', currency],
      ['Place of supply', placeOfSupplyLabel(invoice.placeOfSupply)],
      ['Order no.', invoice.source.orderNumber],
      ['Reason', meta.reason],
    ],
    lines: meta.figures.lines
      .filter((line) => line.taxableMinor > 0n || line.taxMinor > 0n)
      .map((line) => {
        const original = byPosition.get(line.position);
        return {
          description: `Reversal: ${original?.description ?? 'platform commission'}`,
          detail: null,
          code: original?.serviceCode ?? '-',
          orderReference: original?.orderReference ?? invoice.source.sellerOrderNumber,
          taxable: plain(line.taxableMinor),
          rate: `${trimPercent(original?.taxRatePercent ?? '0')}%`,
          tax: plain(line.taxMinor),
          total: plain(line.taxableMinor + line.taxMinor),
        };
      }),
    totals: [
      { label: 'Taxable value credited', value: plain(meta.figures.taxableMinor) },
      ...taxTotalRows(invoice, meta.figures),
      { label: 'Rounding', value: plain(meta.figures.roundingMinor) },
      { label: 'Total credited', value: formatAmount(meta.figures.grandTotalMinor, currency), strong: true },
    ],
    amountInWords: commissionAmountInWords(meta.figures.grandTotalMinor, currency),
    collection: {
      label: `Credited to the seller by ${invoice.issuer.marketplaceName}`,
      value: formatAmount(meta.figures.grandTotalMinor, currency),
      note: meta.figures.completes ? 'Reverses the invoice in full.' : 'Reverses the invoice in part.',
    },
    declarations: [`Issued against invoice ${meta.invoiceNumber} dated ${formatDay(meta.invoiceDay)}.`, ...(meta.note === null ? [] : [meta.note])],
    qr: { url: verificationUrl('commission-credit-note', meta.number), caption: 'Verify this document: scan to confirm this credit note was issued by the supplier above. Not a GST e-invoice QR code.' },
    brand: invoice.issuer.marketplaceName,
    metadata: {
      title: `Commission credit note ${meta.number}`,
      subject: 'CREDIT NOTE - Platform Commission',
      author: invoice.issuer.legalName,
      keywords: `commission credit note, ${meta.number}, against ${meta.invoiceNumber}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function money(amount: Minor, currency: string) {
  return serialiseMoney(amount, currency);
}

/** Why an issued invoice may now want a credit note. Advice for the screen, never automatic. */
function creditSuggestion(row: {
  status: string;
  taxableMinor: Minor;
  order: { status: string };
  sellerOrderGroup: { status: string };
  settlement: { refundsAdjustmentsMinor: Minor; grossProceedsMinor: Minor; sellerDeliveryProceedsMinor: Minor };
  creditNotes: { taxableMinor: Minor }[];
}): string | null {
  if (row.status !== 'ISSUED' && row.status !== 'PARTIALLY_CREDITED') return null;
  if (['CANCELLED', 'REFUNDED'].includes(row.order.status) || CANCELLED_GROUP_STATUSES.has(row.sellerOrderGroup.status)) return 'ORDER_CANCELLED_OR_REFUNDED';
  if (row.sellerOrderGroup.status === 'DISPUTED') return 'DISPUTE_OPEN';
  const due = proportionalCreditTaxable({
    invoiceTaxableMinor: row.taxableMinor,
    alreadyCreditedTaxableMinor: row.creditNotes.reduce((sum, note) => sum + note.taxableMinor, 0n),
    refundedMinor: row.settlement.refundsAdjustmentsMinor,
    proceedsMinor: row.settlement.grossProceedsMinor + row.settlement.sellerDeliveryProceedsMinor,
  });
  return due > 0n ? 'REFUND_RECORDED' : null;
}

export async function readInvoice(invoiceId: string) {
  const row = await prisma.commissionInvoice.findUnique({
    where: { id: invoiceId },
    include: {
      lines: { orderBy: { position: 'asc' } },
      creditNotes: { orderBy: { createdAt: 'asc' }, include: { documents: { select: { id: true, fileName: true, contentHash: true, sizeBytes: true, pageCount: true } } } },
      documents: { select: { id: true, fileName: true, contentHash: true, sizeBytes: true, pageCount: true, createdAt: true } },
      events: { orderBy: { createdAt: 'asc' } },
      order: { select: { status: true, orderNumber: true, paidMinor: true, grandTotalMinor: true } },
      sellerOrderGroup: { select: { status: true, sellerOrderNumber: true } },
      settlement: true,
      sellerAccount: { select: { legalName: true, displayName: true, registrationCountry: true } },
    },
  });
  if (row === null) throw notFound('Commission invoice');
  const currency = row.currency;
  const settings = await loadSettings();
  let blockers: Blocker[] = [];
  if (row.status === 'DRAFT') blockers = eligibilityBlockers(await loadContext(prisma, row.sellerOrderGroupId), settings);
  const actorIds = [...new Set(row.events.map((item) => item.actorUserId).filter((id): id is string => id !== null))];
  const actors = await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } });
  const actorEmail = new Map(actors.map((actor) => [actor.id, actor.email]));
  const document = storedDocument(row, row.lines);

  return {
    id: row.id,
    status: row.status,
    documentType: row.documentType,
    number: row.number,
    financialYear: row.financialYear,
    issueDate: row.issueDate?.toISOString().slice(0, 10) ?? null,
    issuedAt: row.issuedAt?.toISOString() ?? null,
    dueDate: row.dueDate?.toISOString().slice(0, 10) ?? null,
    currency,
    taxTreatment: row.taxTreatment,
    reverseCharge: row.reverseCharge,
    placeOfSupply: document.placeOfSupply,
    snapshotHash: row.snapshotHash,
    issuer: document.issuer,
    seller: document.seller,
    source: document.source,
    notes: document.notes,
    issues: (row.validationJson as CommissionIssue[] | null) ?? [],
    blockers,
    canIssue: row.status === 'DRAFT' && blockers.length === 0 && ((row.validationJson as unknown[] | null) ?? []).length === 0,
    /** A draft can always be discarded; an issued invoice only where the settings allow it and nothing is credited. */
    canVoid: row.status === 'DRAFT' || (row.status === 'ISSUED' && settings.allowVoidAfterIssue && row.creditNotes.length === 0),
    lines: row.lines.map((line) => ({
      position: line.position,
      kind: line.kind,
      description: line.description,
      detail: line.detail,
      serviceCode: line.serviceCode,
      orderReference: line.orderReference,
      feeType: line.feeType,
      basis: money(line.basisMinor, currency),
      feeRatePercent: line.feeRatePercent === null ? null : trimPercent(line.feeRatePercent.toString()),
      policyVersion: line.policyVersion,
      taxable: money(line.taxableMinor, currency),
      taxRatePercent: trimPercent(line.taxRatePercent.toString()),
      cgst: money(line.cgstMinor, currency),
      sgst: money(line.sgstMinor, currency),
      igst: money(line.igstMinor, currency),
      otherTax: money(line.otherTaxMinor, currency),
      tax: money(line.taxMinor, currency),
      total: money(line.totalMinor, currency),
    })),
    taxLabels: document.source.tax.labels,
    totals: {
      subtotal: money(row.subtotalMinor, currency),
      discount: money(row.discountMinor, currency),
      taxable: money(row.taxableMinor, currency),
      cgst: money(row.cgstMinor, currency),
      sgst: money(row.sgstMinor, currency),
      igst: money(row.igstMinor, currency),
      otherTax: money(row.otherTaxMinor, currency),
      totalTax: money(row.totalTaxMinor, currency),
      rounding: money(row.roundingMinor, currency),
      grandTotal: money(row.grandTotalMinor, currency),
      credited: money(row.creditedMinor, currency),
      outstanding: money(row.grandTotalMinor - row.creditedMinor, currency),
    },
    amountInWords: row.amountInWords,
    collection: {
      status: row.collectionStatus,
      reference: row.collectionReference,
      collectedAt: row.collectedAt?.toISOString() ?? null,
    },
    sources: {
      orderStatus: row.order.status,
      sellerOrderStatus: row.sellerOrderGroup.status,
      orderPaid: money(row.order.paidMinor, currency),
      orderTotal: money(row.order.grandTotalMinor, currency),
      settlement: {
        grossProceeds: money(row.settlement.grossProceedsMinor, currency),
        sellerDeliveryProceeds: money(row.settlement.sellerDeliveryProceedsMinor, currency),
        feeBasis: money(row.settlement.feeBasisMinor, currency),
        platformFee: money(row.settlement.platformFeeMinor, currency),
        platformFeeTax: money(row.settlement.platformFeeTaxMinor, currency),
        refundsAdjustments: money(row.settlement.refundsAdjustmentsMinor, currency),
        feeTaxRatePercent: trimPercent(row.settlement.feeTaxRatePercent.toString()),
        feeTaxLabel: row.settlement.feeTaxLabel,
        policyVersion: row.settlement.platformFeePolicyVersion,
        computedAt: row.settlement.computedAt.toISOString(),
      },
    },
    creditSuggestion: creditSuggestion(row),
    document: row.documents[0] ?? null,
    creditNotes: row.creditNotes.map((note) => ({
      id: note.id,
      number: note.number,
      issueDate: note.issueDate.toISOString().slice(0, 10),
      reason: note.reason,
      basis: note.basis,
      note: note.note,
      taxable: money(note.taxableMinor, currency),
      totalTax: money(note.totalTaxMinor, currency),
      grandTotal: money(note.grandTotalMinor, currency),
      document: note.documents[0] ?? null,
    })),
    history: row.events.map((item) => ({
      id: item.id,
      action: item.action,
      fromStatus: item.fromStatus,
      toStatus: item.toStatus,
      actor: item.actorUserId === null ? null : (actorEmail.get(item.actorUserId) ?? item.actorUserId),
      detail: item.detailJson,
      snapshotHash: item.snapshotHash,
      at: item.createdAt.toISOString(),
    })),
    voidReason: row.voidReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const listQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['DRAFT', 'ISSUED', 'PARTIALLY_CREDITED', 'FULLY_CREDITED', 'VOID']).optional(),
  collectionStatus: z.enum(['OUTSTANDING', 'PAID', 'ADJUSTED_AGAINST_SETTLEMENT']).optional(),
  country: z.string().trim().length(2).optional(),
  currency: z.string().trim().length(3).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** The Commission Invoices list, paginated on the server. */
export async function listInvoices(raw: unknown) {
  const query = listQuerySchema.parse(raw);
  const and: Prisma.CommissionInvoiceWhereInput[] = [];
  if (query.status !== undefined) and.push({ status: query.status });
  if (query.collectionStatus !== undefined) and.push({ collectionStatus: query.collectionStatus, status: { in: ['ISSUED', 'PARTIALLY_CREDITED', 'FULLY_CREDITED'] } });
  if (query.currency !== undefined) and.push({ currency: query.currency.toUpperCase() });
  if (query.country !== undefined) and.push({ sellerAccount: { registrationCountry: query.country.toUpperCase() } });
  if (query.from !== undefined || query.to !== undefined) {
    const from = query.from === undefined ? undefined : new Date(`${query.from}T00:00:00.000Z`);
    const to = query.to === undefined ? undefined : new Date(`${query.to}T23:59:59.999Z`);
    and.push({
      OR: [
        { issueDate: { gte: from, lte: to } },
        { issueDate: null, createdAt: { gte: from, lte: to } },
      ],
    });
  }
  if (query.q !== undefined && query.q !== '') {
    const q = query.q;
    and.push({
      OR: [
        { number: { contains: q } },
        { sellerAccountId: q },
        { sellerAccount: { legalName: { contains: q } } },
        { sellerAccount: { displayName: { contains: q } } },
        { order: { orderNumber: { contains: q } } },
        { sellerOrderGroup: { sellerOrderNumber: { contains: q } } },
      ],
    });
  }
  const where: Prisma.CommissionInvoiceWhereInput = and.length === 0 ? {} : { AND: and };
  const [total, rows] = await Promise.all([
    prisma.commissionInvoice.count({ where }),
    prisma.commissionInvoice.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        sellerAccount: { select: { legalName: true, displayName: true, registrationCountry: true } },
        order: { select: { orderNumber: true, status: true } },
        sellerOrderGroup: { select: { sellerOrderNumber: true, status: true } },
        settlement: { select: { refundsAdjustmentsMinor: true, grossProceedsMinor: true, sellerDeliveryProceedsMinor: true } },
        creditNotes: { select: { taxableMinor: true } },
        documents: { select: { id: true } },
      },
    }),
  ]);
  return {
    page: query.page,
    pageSize: query.pageSize,
    total,
    items: rows.map((row) => ({
      id: row.id,
      number: row.number,
      status: row.status,
      documentType: row.documentType,
      sellerAccountId: row.sellerAccountId,
      sellerName: row.sellerAccount.legalName,
      sellerDisplayName: row.sellerAccount.displayName,
      sellerCountry: row.sellerAccount.registrationCountry,
      orderId: row.orderId,
      orderNumber: row.order.orderNumber,
      sellerOrderNumber: row.sellerOrderGroup.sellerOrderNumber,
      currency: row.currency,
      taxable: money(row.taxableMinor, row.currency),
      totalTax: money(row.totalTaxMinor, row.currency),
      grandTotal: money(row.grandTotalMinor, row.currency),
      credited: money(row.creditedMinor, row.currency),
      collectionStatus: row.collectionStatus,
      issueDate: row.issueDate?.toISOString().slice(0, 10) ?? null,
      createdAt: row.createdAt.toISOString(),
      hasIssues: ((row.validationJson as unknown[] | null) ?? []).length > 0,
      documentId: row.documents[0]?.id ?? null,
      creditSuggestion: creditSuggestion(row),
    })),
  };
}

export const candidateQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * Seller orders with a commission and no live commission invoice - the
 * queue of what could be invoiced, each with why it cannot be yet.
 */
export async function listCandidates(raw: unknown) {
  const query = candidateQuerySchema.parse(raw);
  const where: Prisma.SellerOrderSettlementWhereInput = {
    platformFeeMinor: { gt: 0n },
    commissionInvoices: { none: { activeKey: { not: null } } },
    ...(query.q === undefined || query.q === ''
      ? {}
      : {
          OR: [
            { sellerAccountId: query.q },
            { sellerAccount: { legalName: { contains: query.q } } },
            { sellerAccount: { displayName: { contains: query.q } } },
            { sellerOrderGroup: { order: { orderNumber: { contains: query.q } } } },
          ],
        }),
  };
  const settings = await loadSettings();
  const [total, rows] = await Promise.all([
    prisma.sellerOrderSettlement.count({ where }),
    prisma.sellerOrderSettlement.findMany({
      where,
      orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: { sellerOrderGroupId: true },
    }),
  ]);
  const items = [];
  for (const row of rows) {
    const context = await loadContext(prisma, row.sellerOrderGroupId);
    const settlement = context.group.settlement;
    if (settlement === null) continue;
    items.push({
      sellerOrderGroupId: context.group.id,
      sellerOrderNumber: context.group.sellerOrderNumber,
      orderId: context.group.orderId,
      orderNumber: context.group.order.orderNumber,
      orderStatus: context.group.order.status,
      sellerOrderStatus: context.group.status,
      sellerAccountId: context.group.sellerAccount.id,
      sellerName: context.group.sellerAccount.legalName,
      currency: settlement.currency,
      platformFee: money(settlement.platformFeeMinor, settlement.currency),
      platformFeeTax: money(settlement.platformFeeTaxMinor, settlement.currency),
      computedAt: settlement.computedAt.toISOString(),
      blockers: eligibilityBlockers(context, settings),
    });
  }
  return { page: query.page, pageSize: query.pageSize, total, items };
}

/** Every seller order on one buyer order, with its commission and its invoice - the order page's panel. */
export async function commissionForOrder(orderId: string) {
  const groups = await prisma.sellerOrderGroup.findMany({ where: { orderId }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  const settings = await loadSettings();
  const result = [];
  for (const { id } of groups) {
    const context = await loadContext(prisma, id);
    const settlement = context.group.settlement;
    const invoices = await prisma.commissionInvoice.findMany({
      where: { sellerOrderGroupId: id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, number: true, grandTotalMinor: true, currency: true, activeKey: true, documents: { select: { id: true } } },
    });
    const live = invoices.find((invoice) => invoice.activeKey !== null) ?? null;
    result.push({
      sellerOrderGroupId: id,
      sellerOrderNumber: context.group.sellerOrderNumber,
      sellerName: context.group.sellerAccount.legalName,
      sellerAccountId: context.group.sellerAccount.id,
      platformFee: settlement === null ? null : money(settlement.platformFeeMinor, settlement.currency),
      platformFeeTax: settlement === null ? null : money(settlement.platformFeeTaxMinor, settlement.currency),
      blockers: live === null ? eligibilityBlockers(context, settings) : [],
      active:
        live === null
          ? null
          : { id: live.id, status: live.status, number: live.number, grandTotal: money(live.grandTotalMinor, live.currency), documentId: live.documents[0]?.id ?? null },
      previous: invoices
        .filter((invoice) => invoice.activeKey === null)
        .map((invoice) => ({ id: invoice.id, status: invoice.status, number: invoice.number })),
    });
  }
  return { orderId, sellerOrders: result };
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/**
 * A five-minute, single-use link to one issued PDF, bound to the member of
 * staff who asked for it. Only its SHA-256 is stored; a forwarded link does
 * not work for anybody else.
 */
export async function downloadLink(actor: FinanceActor, documentId: string) {
  const document = await prisma.commissionDocument.findUnique({ where: { id: documentId }, select: { id: true } });
  if (document === null) throw notFound('Document');
  const { token } = generateToken(32);
  const expiresAt = new Date(Date.now() + env.LOGISTICS_DOCUMENT_URL_TTL_SECONDS * 1000);
  await prisma.authToken.create({
    data: {
      id: newId(),
      userId: actor.userId,
      type: 'EMAIL_VERIFICATION',
      tokenHash: sha256Hex(`commission-document:admin:${documentId}:${token}`),
      expiresAt,
      createdById: actor.userId,
    },
  });
  return { url: `/api/v1/admin/commission-invoices/documents/${documentId}/download?token=${token}`, expiresAt: expiresAt.toISOString() };
}

export async function redeemDownload(actor: FinanceActor, documentId: string, token: string): Promise<{ bytes: Buffer; fileName: string; contentHash: string }> {
  const record = await prisma.authToken.findUnique({
    where: { tokenHash: sha256Hex(`commission-document:admin:${documentId}:${token}`) },
    select: { id: true, userId: true, expiresAt: true, consumedAt: true },
  });
  if (record === null || record.userId !== actor.userId || record.consumedAt !== null || record.expiresAt.getTime() <= Date.now()) {
    throw forbidden(ErrorCode.TOKEN_INVALID, 'This download link is no longer valid.');
  }
  const consumed = await prisma.authToken.updateMany({ where: { id: record.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (consumed.count !== 1) throw forbidden(ErrorCode.TOKEN_INVALID, 'This download link is no longer valid.');

  const document = await prisma.commissionDocument.findUnique({
    where: { id: documentId },
    include: { creditNote: { select: { invoiceId: true, number: true } } },
  });
  if (document === null) throw notFound('Document');
  const bytes = await storage.get(document.storageKey);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== document.contentHash) {
    logger.error({ documentId }, 'a stored commission document no longer matches the hash recorded at issue');
    throw new AppError({ statusCode: 500, code: ErrorCode.INTERNAL_ERROR, message: 'This document could not be verified. Nothing was downloaded.' });
  }
  const invoiceId = document.invoiceId ?? document.creditNote?.invoiceId ?? '';
  await event(prisma, {
    invoiceId,
    creditNoteId: document.creditNoteId,
    action: 'downloaded',
    actor,
    detail: { documentId, kind: document.kind, contentHash: document.contentHash },
  });
  await audit(AuditAction.COMMISSION_INVOICE_DOWNLOADED, invoiceId, actor, { documentId, fileName: document.fileName });
  return { bytes, fileName: document.fileName, contentHash: document.contentHash };
}

// ---------------------------------------------------------------------------
// Public verification
// ---------------------------------------------------------------------------

/** What the public check may say about a commission document: that it exists, its number, type, status and date. */
export async function verifyCommissionDocument(kind: 'commission-invoice' | 'commission-credit-note', number: string) {
  if (kind === 'commission-invoice') {
    const row = await prisma.commissionInvoice.findUnique({
      where: { number },
      select: { status: true, documentType: true, issuedAt: true, issuerJson: true },
    });
    if (row === null) return null;
    return {
      kind: row.documentType,
      status: row.status,
      issuedAt: row.issuedAt?.toISOString() ?? null,
      issuer: (row.issuerJson as unknown as IssuerSnapshot).legalName,
    };
  }
  const note = await prisma.commissionCreditNote.findUnique({
    where: { number },
    select: { issuedAt: true, invoice: { select: { issuerJson: true } } },
  });
  if (note === null) return null;
  return {
    kind: 'CREDIT_NOTE',
    status: 'ISSUED',
    issuedAt: note.issuedAt.toISOString(),
    issuer: (note.invoice.issuerJson as unknown as IssuerSnapshot).legalName,
  };
}
