/**
 * Comparing quotes side by side (checklist Master row 18).
 *
 * THREE RULES
 *
 *   1. **What the seller said is always shown.** Every figure appears in the
 *      currency the seller quoted it in. A converted figure is shown BESIDE
 *      it, never instead of it, and says it is converted, at which rate, from
 *      which source and as of when - the project's own published rate set
 *      (`indicativeConversion`), mid-market, never a rate typed in here.
 *   2. **Missing is not zero.** A term the seller did not give is `null` and
 *      reads "not provided"; a quote without a shipping estimate is never
 *      cheaper for it.
 *   3. **One rounding.** A total is the applicable unit price times the
 *      quoted quantity, rounded half-up once (`lineTotalMinor`), in the
 *      quote's own currency; the converted total converts that total. A
 *      converted unit price is converted separately, so it is not the
 *      converted total divided back.
 *
 * The CSV export is built from exactly the same rows the screen shows, and
 * every cell is written through `csvRow`, which neutralises a spreadsheet
 * formula (a cell starting with =, +, -, @, tab or CR).
 */
import { z } from 'zod';
import { formatMinorToMajor, serialiseMoney } from '../../domain/money.js';
import { compareQuantities, lineTotalMinor } from '../../domain/rfq.js';
import type { Minor } from '../../domain/money.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { indicativeConversion, type IndicativeConversion } from '../catalog/indicative-fx.service.js';
import { csvRow } from '../reports/export.service.js';
import type { RfqBuyer } from './access.js';
import { termsOf } from './quote.service.js';
import { loadRfqForBuyer, requirementOf } from './rfq.service.js';

export const comparisonQuerySchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  sort: z.enum(['total', 'unitPrice', 'leadTime', 'moq', 'supplier']).default('total'),
  shortlisted: z.enum(['true', 'false']).optional(),
  status: z.enum(['OPEN', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'CLOSED']).optional(),
});

type Money = ReturnType<typeof serialiseMoney>;

export interface ConversionInfo {
  currency: string;
  rate: string;
  rateAsOf: string;
  provider: string;
  snapshotId: string | null;
}

export interface ComparisonRow {
  quoteId: string;
  supplier: { sellerAccountId: string; displayName: string; registrationCountry: string; verifiedAt: string | null; verified: boolean };
  status: string;
  shortlisted: boolean;
  versionNumber: number;
  author: 'BUYER' | 'SUPPLIER';
  basedOnRequirementVersion: number;
  onCurrentRequirement: boolean;
  expiresAt: string;
  isExpired: boolean;
  quantity: string;
  quoted: {
    currency: string;
    unitPrice: Money;
    applicableUnitPrice: Money;
    total: Money;
    tooling: Money | null;
    sampleCost: Money | null;
    shippingEstimate: Money | null;
  };
  /** Null when the quote is already in the chosen currency, or no rate is published for the pair. */
  converted: {
    unitPrice: Money;
    applicableUnitPrice: Money;
    total: Money;
    tooling: Money | null;
    sampleCost: Money | null;
    shippingEstimate: Money | null;
    conversion: ConversionInfo;
  } | null;
  /** Why there is no converted figure when one was asked for. */
  conversionUnavailable: boolean;
  moq: string | null;
  leadTimeDays: number | null;
  capacityPerMonth: string | null;
  incoterm: string | null;
  incotermPlace: string | null;
  paymentTerms: string | null;
  inspectionTerms: string | null;
  warranty: string | null;
  taxesDisclosure: string | null;
  tiers: { minQuantity: string; unitPrice: Money }[];
}

export interface Comparison {
  rfqId: string;
  reference: string;
  currency: string;
  unitOfMeasure: string | null;
  currentRequirementVersion: number;
  rows: ComparisonRow[];
}

/** The tier that applies to a quantity: the largest minimum at or below it, else the base price. */
function applicablePrice(base: string, tiers: { minQuantity: string; unitPriceMinor: string }[], quantity: string): string {
  let price = base;
  for (const tier of [...tiers].sort((a, b) => compareQuantities(a.minQuantity, b.minQuantity))) {
    if (compareQuantities(tier.minQuantity, quantity) <= 0) price = tier.unitPriceMinor;
  }
  return price;
}

export async function buildComparison(
  buyer: RfqBuyer,
  rfqId: string,
  query: z.infer<typeof comparisonQuerySchema>,
): Promise<Comparison> {
  const rfq = await loadRfqForBuyer(buyer, rfqId);
  const requirement = requirementOf(rfq);
  const target = query.currency ?? requirement.targetCurrency ?? null;

  const quotes = await prisma.rfqQuote.findMany({
    where: {
      rfqId: rfq.id,
      ...(query.shortlisted === 'true' ? { shortlisted: true } : {}),
      ...(query.status === undefined ? {} : { status: query.status }),
    },
    include: { sellerAccount: { select: { id: true, displayName: true, registrationCountry: true, status: true, approvedAt: true } } },
  });
  const versions = await prisma.rfqQuoteVersion.findMany({
    where: { id: { in: quotes.flatMap((quote) => (quote.currentVersionId === null ? [] : [quote.currentVersionId])) } },
  });
  const byId = new Map(versions.map((version) => [version.id, version]));

  const conversions = new Map<string, IndicativeConversion | null>();
  const conversionFor = async (from: string): Promise<IndicativeConversion | null> => {
    if (target === null || from === target) return null;
    if (!conversions.has(from)) conversions.set(from, await indicativeConversion(from, target));
    return conversions.get(from) ?? null;
  };

  const rows: ComparisonRow[] = [];
  for (const quote of quotes) {
    const version = quote.currentVersionId === null ? undefined : byId.get(quote.currentVersionId);
    if (version === undefined) continue;
    const terms = termsOf(version);
    const currency = terms.currency;
    const applicable = applicablePrice(terms.unitPriceMinor, terms.tiers, terms.quantity);
    const total = lineTotalMinor(BigInt(applicable), terms.quantity);
    const optional = (value: string | null): Minor | null => (value === null ? null : BigInt(value));
    const quoted = {
      currency,
      unitPrice: serialiseMoney(BigInt(terms.unitPriceMinor), currency),
      applicableUnitPrice: serialiseMoney(BigInt(applicable), currency),
      total: serialiseMoney(total, currency),
      tooling: terms.toolingMinor === null ? null : serialiseMoney(BigInt(terms.toolingMinor), currency),
      sampleCost: terms.sampleCostMinor === null ? null : serialiseMoney(BigInt(terms.sampleCostMinor), currency),
      shippingEstimate: terms.shippingEstimateMinor === null ? null : serialiseMoney(BigInt(terms.shippingEstimateMinor), currency),
    };
    const conversion = await conversionFor(currency);
    const convert = (value: Minor | null): Money | null =>
      value === null || conversion === null ? null : serialiseMoney(conversion.convert(value), conversion.toCurrency);
    const converted =
      conversion === null
        ? null
        : {
            unitPrice: convert(BigInt(terms.unitPriceMinor)) as Money,
            applicableUnitPrice: convert(BigInt(applicable)) as Money,
            total: convert(total) as Money,
            tooling: convert(optional(terms.toolingMinor)),
            sampleCost: convert(optional(terms.sampleCostMinor)),
            shippingEstimate: convert(optional(terms.shippingEstimateMinor)),
            conversion: {
              currency: conversion.toCurrency,
              rate: conversion.rate,
              rateAsOf: conversion.asOf.toISOString(),
              provider: conversion.provider,
              snapshotId: conversion.snapshotId,
            },
          };
    rows.push({
      quoteId: quote.id,
      supplier: {
        sellerAccountId: quote.sellerAccount.id,
        displayName: quote.sellerAccount.displayName,
        registrationCountry: quote.sellerAccount.registrationCountry,
        verifiedAt: quote.sellerAccount.approvedAt?.toISOString() ?? null,
        verified: quote.sellerAccount.status === 'APPROVED',
      },
      status: quote.status,
      shortlisted: quote.shortlisted,
      versionNumber: version.versionNumber,
      author: terms.author,
      basedOnRequirementVersion: quote.basedOnRequirementVersion,
      onCurrentRequirement: quote.basedOnRequirementVersion === rfq.currentRequirementVersion,
      expiresAt: terms.expiresAt,
      isExpired: version.state === 'PROPOSED' && version.expiresAt.getTime() <= Date.now(),
      quantity: terms.quantity,
      quoted,
      converted,
      conversionUnavailable: target !== null && currency !== target && conversion === null,
      moq: terms.moq,
      leadTimeDays: terms.leadTimeDays,
      capacityPerMonth: terms.capacityPerMonth,
      incoterm: terms.incoterm,
      incotermPlace: terms.incotermPlace,
      paymentTerms: terms.paymentTerms,
      inspectionTerms: terms.inspectionTerms,
      warranty: terms.warranty,
      taxesDisclosure: terms.taxesDisclosure,
      tiers: terms.tiers.map((tier) => ({ minQuantity: tier.minQuantity, unitPrice: serialiseMoney(BigInt(tier.unitPriceMinor), currency) })),
    });
  }

  rows.sort(comparator(query.sort, target));
  return {
    rfqId: rfq.id,
    reference: rfq.reference,
    currency: target ?? '',
    unitOfMeasure: requirement.unitOfMeasure,
    currentRequirementVersion: rfq.currentRequirementVersion,
    rows,
  };
}

/**
 * The comparable figure of a row in the chosen currency: its own when it
 * was quoted in it, the converted one otherwise, null when neither exists.
 * Nulls sort last whatever the direction - an unknown figure is not cheap.
 */
function comparable(row: ComparisonRow, target: string | null, pick: 'total' | 'unitPrice'): bigint | null {
  const field = pick === 'total' ? 'total' : 'applicableUnitPrice';
  if (target === null || row.quoted.currency === target) return BigInt(row.quoted[field].minor);
  return row.converted === null ? null : BigInt(row.converted[field].minor);
}

function nullsLast<T>(a: T | null, b: T | null, compare: (x: T, y: T) => number): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compare(a, b);
}

function comparator(sort: z.infer<typeof comparisonQuerySchema>['sort'], target: string | null) {
  return (a: ComparisonRow, b: ComparisonRow): number => {
    switch (sort) {
      case 'supplier':
        return a.supplier.displayName.localeCompare(b.supplier.displayName);
      case 'leadTime':
        return nullsLast(a.leadTimeDays, b.leadTimeDays, (x, y) => x - y);
      case 'moq':
        return nullsLast(a.moq, b.moq, compareQuantities);
      case 'unitPrice':
      case 'total':
        return nullsLast(comparable(a, target, sort), comparable(b, target, sort), (x, y) => (x < y ? -1 : x > y ? 1 : 0));
    }
  };
}

const NOT_PROVIDED = 'not provided';

function amount(money: Money | null | undefined): string {
  return money === null || money === undefined ? NOT_PROVIDED : formatMinorToMajor(BigInt(money.minor), money.currency);
}

function textCell(value: string | number | null): string {
  return value === null ? NOT_PROVIDED : String(value);
}

/** The comparison as CSV: the same rows and figures the screen shows. */
export async function comparisonCsv(
  buyer: RfqBuyer,
  rfqId: string,
  query: z.infer<typeof comparisonQuerySchema>,
): Promise<{ fileName: string; content: string }> {
  const comparison = await buildComparison(buyer, rfqId, query);
  const header = [
    'Supplier',
    'Verified by the marketplace since',
    'Quote status',
    'Shortlisted',
    'Offer version',
    'Offer written by',
    'Quoted against requirement version',
    'Quoted currency',
    'Unit price (quoted)',
    'Applicable unit price (quoted)',
    'Quantity',
    'Total (quoted)',
    'Tooling / NRE (quoted)',
    'Sample cost (quoted)',
    'Shipping estimate (quoted)',
    'Converted to',
    'Unit price (converted, approximate)',
    'Total (converted, approximate)',
    'Tooling / NRE (converted, approximate)',
    'Sample cost (converted, approximate)',
    'Shipping estimate (converted, approximate)',
    'Rate',
    'Rate as of (UTC)',
    'Rate source',
    'MOQ',
    'Lead time (days)',
    'Capacity per month',
    'Incoterm',
    'Incoterm place',
    'Payment terms',
    'Inspection terms',
    'Warranty',
    'Taxes, duties and exclusions',
    'Valid until (UTC)',
  ];
  const lines = [csvRow(header)];
  for (const row of comparison.rows) {
    lines.push(
      csvRow([
        row.supplier.displayName,
        textCell(row.supplier.verifiedAt),
        row.status,
        row.shortlisted ? 'yes' : 'no',
        row.versionNumber,
        row.author === 'BUYER' ? 'buyer' : 'supplier',
        row.basedOnRequirementVersion,
        row.quoted.currency,
        amount(row.quoted.unitPrice),
        amount(row.quoted.applicableUnitPrice),
        row.quantity,
        amount(row.quoted.total),
        amount(row.quoted.tooling),
        amount(row.quoted.sampleCost),
        amount(row.quoted.shippingEstimate),
        row.converted?.conversion.currency ?? NOT_PROVIDED,
        amount(row.converted?.applicableUnitPrice),
        amount(row.converted?.total),
        amount(row.converted?.tooling),
        amount(row.converted?.sampleCost),
        amount(row.converted?.shippingEstimate),
        row.converted?.conversion.rate ?? NOT_PROVIDED,
        row.converted?.conversion.rateAsOf ?? NOT_PROVIDED,
        row.converted?.conversion.provider ?? NOT_PROVIDED,
        textCell(row.moq),
        textCell(row.leadTimeDays),
        textCell(row.capacityPerMonth),
        textCell(row.incoterm),
        textCell(row.incotermPlace),
        textCell(row.paymentTerms),
        textCell(row.inspectionTerms),
        textCell(row.warranty),
        textCell(row.taxesDisclosure),
        row.expiresAt,
      ]),
    );
  }
  await recordAudit({
    action: AuditAction.RFQ_COMPARISON_EXPORTED,
    resourceType: 'rfq_request',
    resourceId: comparison.rfqId,
    actorType: 'CUSTOMER',
    actorUserId: buyer.userId,
    actorEmail: buyer.email,
    after: { rows: comparison.rows.length, currency: comparison.currency },
  });
  return { fileName: `${comparison.reference}-quotes.csv`, content: lines.join('') };
}
