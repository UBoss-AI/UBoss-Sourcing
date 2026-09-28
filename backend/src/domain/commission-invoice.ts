/**
 * The operator's invoice to a seller for the platform commission, as pure
 * arithmetic and rules.
 *
 * WHAT IT IS. The marketplace supplied a service to the seller - listing,
 * selling and collecting for them - and charged a commission (the platform
 * fee) for it. This is the invoice for THAT supply. The seller is the
 * recipient; the operator's registered legal entity is the supplier. It is not
 * the seller's invoice for the goods, and nothing on it is a product HSN.
 *
 * WHERE THE FIGURES COME FROM. The seller order's settlement, calculated once
 * at confirmation on the fee policy then in force (`SellerOrderSettlement`).
 * The fee and the tax on it are copied, never recalculated: this file only
 * decides how an amount already charged is PRESENTED - which lines, which tax
 * components, which document title - and it refuses to present one it cannot
 * present truthfully.
 *
 * WHAT IT WILL NOT SAY. It never calls a tax GST unless finance verified the
 * fee policy's tax rule, never prints CGST/SGST/IGST for a supplier that is
 * not configured under Indian GST, and never invents a component a seller
 * outside India would owe. Each of those is an `issue`, which blocks issuance
 * and tells the person what to fix.
 *
 * ROUNDING. Every amount is bigint minor units. Tax components are split with
 * `splitGst` (the odd paisa goes to the state half, so the parts add up). The
 * optional whole-unit rounding of the grand total is half up, shown as its own
 * signed line. A credit note's tax follows its taxable amount in proportion,
 * half up per component, and a credit that takes the invoice to zero takes
 * exactly what is left of every column - so an invoice and its credits always
 * net to zero, never to one paisa.
 */
import { GST_STATE_CODES, OTHER_COUNTRY_CODE, amountInWords, checkGstin, financialYear, splitGst, stateCodeForName } from './gst.js';
import { apportion, currencyExponent, formatMinorToMajor, type Minor } from './money.js';

export type CommissionTaxRegime = 'IN_GST' | 'VAT' | 'OTHER' | 'NONE';
export type CommissionDocumentType = 'TAX_INVOICE' | 'INVOICE' | 'BILL_OF_SUPPLY';

export type CommissionTaxTreatment =
  | 'IN_INTRA_STATE'
  | 'IN_INTER_STATE'
  | 'IN_EXPORT_WITH_TAX'
  | 'IN_EXPORT_UNDER_LUT'
  | 'DOMESTIC'
  | 'CROSS_BORDER'
  | 'REVERSE_CHARGE'
  | 'NOT_TAXED';

export interface CommissionIssue {
  field: string;
  code: string;
  message: string;
}

/**
 * GST state codes that are union territories without a legislature. Inside
 * one of these the state half of GST is UTGST, not SGST (UTGST Act 2017).
 * Delhi, Puducherry and Jammu and Kashmir have legislatures and levy SGST.
 */
export const UTGST_STATE_CODES: ReadonlySet<string> = new Set(['04', '26', '31', '35', '38', '97']);

// ---------------------------------------------------------------------------
// Tax treatment
// ---------------------------------------------------------------------------

export interface IssuerTaxFacts {
  regime: CommissionTaxRegime;
  country: string | null;
  stateCode: string | null;
  taxRegistrationNumber: string | null;
  lutReference: string | null;
  zeroTaxDocumentType: CommissionDocumentType;
  requireSellerTaxId: boolean;
}

export interface SellerTaxFacts {
  country: string | null;
  /** GSTIN, VAT number or whatever the seller's country issues. */
  taxId: string | null;
  /** The region the seller's billing address names, as typed. */
  region: string | null;
}

export interface FeeTaxFacts {
  /** The tax on the fee, exactly as the settlement stored it. */
  taxMinor: Minor;
  /** The rate that produced it, percent. */
  ratePercent: string;
  /** Whether finance verified every fee policy the tax came from. */
  verified: boolean;
  /** The label the fee policy gives the tax, e.g. "GST". */
  label: string;
}

export interface TaxComponentLabels {
  cgst: string;
  sgst: string;
  igst: string;
  other: string;
}

export interface CommissionTaxResolution {
  treatment: CommissionTaxTreatment;
  documentType: CommissionDocumentType;
  reverseCharge: boolean;
  /** Where the service is supplied, for the document. Null where not applicable. */
  placeOfSupply: { code: string; name: string } | null;
  /** How tax is split into components. */
  split: 'CGST_SGST' | 'IGST' | 'OTHER' | 'NONE';
  labels: TaxComponentLabels;
  /** The seller's state, where it could be established. */
  sellerStateCode: string | null;
  /** Printed under the totals: LUT and reverse-charge statements. */
  declarations: string[];
  issues: CommissionIssue[];
}

function upper(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase();
}

/**
 * How the tax on the fee must be presented - and whether it can be at all.
 *
 * India (IGST Act s.12(2)): a service to a registered business is supplied
 * where the recipient is registered, so the seller's GSTIN state decides
 * CGST + SGST/UTGST against IGST. A seller outside India receives an export
 * of the service: IGST where the fee was taxed, or zero-rated under a Letter
 * of Undertaking where it was not.
 *
 * Elsewhere: tax in the seller's own country is shown under the configured
 * label as charged; across a border, a zero-taxed supply to a seller with a
 * VAT number is marked reverse charge.
 */
export function resolveCommissionTax(
  issuer: IssuerTaxFacts,
  seller: SellerTaxFacts,
  fee: FeeTaxFacts,
): CommissionTaxResolution {
  const issues: CommissionIssue[] = [];
  const declarations: string[] = [];
  const taxed = fee.taxMinor > 0n;
  const issuerCountry = upper(issuer.country);
  const sellerCountry = upper(seller.country);
  const labels: TaxComponentLabels = {
    cgst: 'CGST',
    sgst: 'SGST',
    igst: 'IGST',
    other: fee.label.trim() === '' ? 'Tax' : fee.label.trim(),
  };

  if (sellerCountry === '') {
    issues.push({ field: 'seller.country', code: 'SELLER_COUNTRY_MISSING', message: "The seller's billing country is missing." });
  }
  if (taxed && !fee.verified) {
    issues.push({
      field: 'feePolicy.tax',
      code: 'TAX_RULE_UNVERIFIED',
      message:
        'The tax on this fee comes from a fee policy whose tax rule finance has not verified. Verify it under Finance → Platform fees before issuing.',
    });
  }

  if (issuer.regime === 'NONE') {
    if (taxed) {
      issues.push({
        field: 'settings.taxRegime',
        code: 'TAX_WITHOUT_REGISTRATION',
        message: 'Tax was charged on this fee, but the issuing entity is set up with no tax registration. Set the tax regime in the invoice settings.',
      });
    }
    return {
      treatment: 'NOT_TAXED',
      documentType: issuer.zeroTaxDocumentType === 'TAX_INVOICE' ? 'INVOICE' : issuer.zeroTaxDocumentType,
      reverseCharge: false,
      placeOfSupply: null,
      split: 'NONE',
      labels,
      sellerStateCode: null,
      declarations,
      issues,
    };
  }

  if (upper(issuer.taxRegistrationNumber) === '') {
    issues.push({
      field: 'settings.taxRegistrationNumber',
      code: 'ISSUER_TAX_ID_MISSING',
      message: "The issuing entity's tax registration number is missing from the invoice settings.",
    });
  }

  if (issuer.regime === 'IN_GST') {
    return resolveIndianGst(issuer, seller, fee, { issues, declarations, labels, sellerCountry, issuerCountry });
  }

  // VAT or another registered sales tax.
  const domestic = sellerCountry !== '' && sellerCountry === issuerCountry;
  if (domestic && issuer.requireSellerTaxId && upper(seller.taxId) === '') {
    issues.push({ field: 'seller.taxId', code: 'SELLER_TAX_ID_MISSING', message: "The seller's tax registration number is missing." });
  }
  let treatment: CommissionTaxTreatment;
  let reverseCharge = false;
  if (domestic) {
    treatment = taxed ? 'DOMESTIC' : 'NOT_TAXED';
  } else if (!taxed && issuer.regime === 'VAT' && upper(seller.taxId) !== '') {
    treatment = 'REVERSE_CHARGE';
    reverseCharge = true;
    declarations.push('Reverse charge: VAT to be accounted for by the recipient (Art. 196, Council Directive 2006/112/EC).');
  } else {
    treatment = taxed ? 'CROSS_BORDER' : 'NOT_TAXED';
  }
  return {
    treatment,
    documentType: taxed ? 'TAX_INVOICE' : reverseCharge ? 'INVOICE' : zeroTaxType(issuer),
    reverseCharge,
    placeOfSupply: sellerCountry === '' ? null : { code: sellerCountry, name: sellerCountry },
    split: taxed ? 'OTHER' : 'NONE',
    labels,
    sellerStateCode: null,
    declarations,
    issues,
  };
}

function zeroTaxType(issuer: IssuerTaxFacts): CommissionDocumentType {
  // A document with no tax on it is never headed "tax invoice" by default.
  return issuer.zeroTaxDocumentType === 'TAX_INVOICE' ? 'INVOICE' : issuer.zeroTaxDocumentType;
}

function resolveIndianGst(
  issuer: IssuerTaxFacts,
  seller: SellerTaxFacts,
  fee: FeeTaxFacts,
  context: {
    issues: CommissionIssue[];
    declarations: string[];
    labels: TaxComponentLabels;
    sellerCountry: string;
    issuerCountry: string;
  },
): CommissionTaxResolution {
  const { issues, declarations, labels, sellerCountry, issuerCountry } = context;
  const taxed = fee.taxMinor > 0n;

  if (issuerCountry !== 'IN') {
    issues.push({ field: 'settings.country', code: 'ISSUER_COUNTRY_MISMATCH', message: 'Indian GST is selected, but the issuing entity is not in India.' });
  }
  const issuerState = (issuer.stateCode ?? '').trim();
  if (GST_STATE_CODES[issuerState] === undefined) {
    issues.push({ field: 'settings.stateCode', code: 'ISSUER_STATE_INVALID', message: "The issuing entity's GST state code is missing or not a GST state code." });
  }
  const issuerGstin = upper(issuer.taxRegistrationNumber);
  if (issuerGstin !== '') {
    const problem = checkGstin(issuerGstin);
    if (problem !== null) {
      issues.push({ field: 'settings.taxRegistrationNumber', code: `ISSUER_GSTIN_${problem}`, message: "The issuing entity's GSTIN is not a valid GSTIN." });
    } else if (issuerGstin.slice(0, 2) !== issuerState) {
      issues.push({ field: 'settings.stateCode', code: 'ISSUER_GSTIN_STATE_MISMATCH', message: "The issuing entity's GSTIN belongs to a different state from its configured state code." });
    }
  }

  if (sellerCountry !== 'IN' && sellerCountry !== '') {
    // An export of the service. Whether the conditions of IGST Act s.2(6) are
    // met - payment in convertible foreign exchange among them - is a matter
    // for the operator's tax adviser; this only refuses the zero-rated form
    // without the undertaking that permits it.
    const underLut = !taxed;
    if (underLut) {
      const lut = (issuer.lutReference ?? '').trim();
      if (lut === '') {
        issues.push({
          field: 'settings.exportLutReference',
          code: 'LUT_REQUIRED',
          message: 'This seller is outside India and no tax was charged on the fee. Add the Letter of Undertaking reference to the invoice settings to issue it as a zero-rated export.',
        });
      } else {
        declarations.push(`Supply meant for export under LUT ${lut} without payment of integrated tax.`);
      }
    } else {
      declarations.push('Supply meant for export on payment of integrated tax.');
    }
    return {
      treatment: underLut ? 'IN_EXPORT_UNDER_LUT' : 'IN_EXPORT_WITH_TAX',
      documentType: 'TAX_INVOICE',
      reverseCharge: false,
      placeOfSupply: { code: OTHER_COUNTRY_CODE, name: 'Other Country' },
      split: underLut ? 'NONE' : 'IGST',
      labels,
      sellerStateCode: null,
      declarations,
      issues,
    };
  }

  // A seller in India. Their registered state decides the components.
  const sellerGstin = upper(seller.taxId);
  let sellerState: string | null = null;
  if (sellerGstin !== '') {
    const problem = checkGstin(sellerGstin);
    if (problem === null) {
      sellerState = sellerGstin.slice(0, 2);
    } else {
      issues.push({ field: 'seller.taxId', code: `SELLER_GSTIN_${problem}`, message: "The seller's GSTIN is not a valid GSTIN." });
    }
  } else if (issuer.requireSellerTaxId) {
    issues.push({ field: 'seller.taxId', code: 'SELLER_TAX_ID_MISSING', message: "The seller's GSTIN is missing from their business profile." });
  }
  if (sellerState === null) sellerState = stateCodeForName(seller.region);
  if (sellerState === null) {
    issues.push({ field: 'seller.region', code: 'SELLER_STATE_UNKNOWN', message: "The seller's state could not be established from their GSTIN or billing address." });
  }

  const intraState = sellerState !== null && sellerState === issuerState;
  if (intraState && UTGST_STATE_CODES.has(issuerState)) labels.sgst = 'UTGST';

  const placeOfSupply =
    sellerState === null ? null : { code: sellerState, name: GST_STATE_CODES[sellerState] ?? sellerState };

  return {
    treatment: intraState ? 'IN_INTRA_STATE' : 'IN_INTER_STATE',
    documentType: taxed ? 'TAX_INVOICE' : zeroTaxType(issuer),
    reverseCharge: false,
    placeOfSupply,
    split: !taxed ? 'NONE' : intraState ? 'CGST_SGST' : 'IGST',
    labels,
    sellerStateCode: sellerState,
    declarations,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/** One entry of `SellerOrderSettlement.breakdownJson`, as the fee calculation wrote it. */
export interface FeeBreakdownEntry {
  policyId: string | null;
  policyVersion: number | null;
  feeType: string;
  percentRate: string;
  basisMinor: string;
  feeMinor: string;
  taxRatePercent: string;
  taxMinor: string;
}

export interface CommissionSource {
  platformFeeMinor: Minor;
  platformFeeTaxMinor: Minor;
  feeTaxRatePercent: string;
  feeBasisMinor: Minor;
  breakdown: readonly FeeBreakdownEntry[];
}

export interface CommissionLine {
  position: number;
  kind: 'PLATFORM_COMMISSION' | 'SERVICE_FEE';
  description: string;
  detail: string | null;
  serviceCode: string | null;
  orderReference: string;
  feeType: string | null;
  basisMinor: Minor;
  feeRatePercent: string | null;
  policyId: string | null;
  policyVersion: number | null;
  taxableMinor: Minor;
  taxRatePercent: string;
  cgstMinor: Minor;
  sgstMinor: Minor;
  igstMinor: Minor;
  otherTaxMinor: Minor;
  taxMinor: Minor;
  totalMinor: Minor;
}

function parseBig(value: string | undefined): Minor | null {
  if (value === undefined || !/^-?\d+$/.test(value)) return null;
  return BigInt(value);
}

/** "18.000000" -> "18", "12.500000" -> "12.5". A label, never arithmetic. */
export function trimPercent(rate: string): string {
  if (!rate.includes('.')) return rate === '' ? '0' : rate;
  const trimmed = rate.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' ? '0' : trimmed;
}

/**
 * The service lines, from the settlement's own record of how the fee was
 * reached.
 *
 * One line per fee policy that charged something - a seller whose goods fell
 * under two category policies sees two commission lines, each with its own
 * basis and rate - when the breakdown adds up to the stored fee and tax
 * exactly. When it does not (a settlement written before breakdowns carried
 * tax), there is one line with the stored totals: the stored totals are the
 * authority, and a breakdown that disagrees with them is never printed.
 */
export function buildCommissionLines(input: {
  source: CommissionSource;
  currency: string;
  orderNumber: string;
  sellerOrderNumber: string;
  descriptionTemplate: string;
  serviceCode: string | null;
  split: CommissionTaxResolution['split'];
}): CommissionLine[] {
  const description = input.descriptionTemplate.includes('{orderNumber}')
    ? input.descriptionTemplate.replace(/\{orderNumber\}/g, input.orderNumber)
    : `${input.descriptionTemplate} ${input.orderNumber}`.trim();

  const entries = input.source.breakdown
    .map((entry) => ({
      entry,
      fee: parseBig(entry.feeMinor),
      tax: parseBig(entry.taxMinor),
      basis: parseBig(entry.basisMinor),
    }))
    .filter((row) => row.fee !== null && row.fee > 0n);

  const feeSum = entries.reduce((sum, row) => sum + (row.fee ?? 0n), 0n);
  const taxSum = entries.reduce((sum, row) => sum + (row.tax ?? 0n), 0n);
  const consistent =
    entries.length > 0 &&
    entries.every((row) => row.tax !== null && row.basis !== null) &&
    feeSum === input.source.platformFeeMinor &&
    taxSum === input.source.platformFeeTaxMinor;

  const raw = consistent
    ? entries.map((row) => ({
        taxable: row.fee ?? 0n,
        tax: row.tax ?? 0n,
        basis: row.basis ?? 0n,
        feeType: row.entry.feeType,
        percentRate: row.entry.percentRate,
        taxRate: row.entry.taxRatePercent,
        policyId: row.entry.policyId,
        policyVersion: row.entry.policyVersion,
      }))
    : [
        {
          taxable: input.source.platformFeeMinor,
          tax: input.source.platformFeeTaxMinor,
          basis: input.source.feeBasisMinor,
          feeType: null as string | null,
          percentRate: null as string | null,
          taxRate: input.source.feeTaxRatePercent,
          policyId: null as string | null,
          policyVersion: null as number | null,
        },
      ];

  return raw.map((row, index) => {
    const components = splitTax(row.tax, input.split);
    return {
      position: index + 1,
      kind: 'PLATFORM_COMMISSION' as const,
      description,
      detail: lineDetail(row.feeType, row.percentRate, row.basis, input.currency),
      serviceCode: input.serviceCode,
      orderReference: input.sellerOrderNumber,
      feeType: row.feeType,
      basisMinor: row.basis,
      feeRatePercent: row.feeType === 'FLAT' || row.percentRate === null ? null : row.percentRate,
      policyId: row.policyId,
      policyVersion: row.policyVersion,
      taxableMinor: row.taxable,
      taxRatePercent: row.taxRate,
      ...components,
      taxMinor: row.tax,
      totalMinor: row.taxable + row.tax,
    };
  });
}

function lineDetail(feeType: string | null, percentRate: string | null, basis: Minor, currency: string): string | null {
  if (feeType === null || percentRate === null) return null;
  const on = `${formatMinorToMajor(basis, currency)} ${currency}`;
  if (feeType === 'FLAT') return 'Flat fee per order';
  if (feeType === 'PERCENT_PLUS_FLAT') return `${trimPercent(percentRate)}% of ${on} plus a flat fee`;
  return `${trimPercent(percentRate)}% of ${on}`;
}

/** One amount of tax, split into the components the treatment calls for. */
export function splitTax(
  taxMinor: Minor,
  split: CommissionTaxResolution['split'],
): { cgstMinor: Minor; sgstMinor: Minor; igstMinor: Minor; otherTaxMinor: Minor } {
  if (split === 'CGST_SGST') {
    const parts = splitGst(taxMinor, 'INTRA_STATE');
    return { cgstMinor: parts.cgst, sgstMinor: parts.sgst, igstMinor: 0n, otherTaxMinor: 0n };
  }
  if (split === 'IGST') return { cgstMinor: 0n, sgstMinor: 0n, igstMinor: taxMinor, otherTaxMinor: 0n };
  // 'NONE' only ever arrives with a zero tax; anything else would be a tax
  // with no name, so it is kept visible under the configured label.
  return { cgstMinor: 0n, sgstMinor: 0n, igstMinor: 0n, otherTaxMinor: taxMinor };
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export interface CommissionTotals {
  subtotalMinor: Minor;
  discountMinor: Minor;
  taxableMinor: Minor;
  cgstMinor: Minor;
  sgstMinor: Minor;
  igstMinor: Minor;
  otherTaxMinor: Minor;
  totalTaxMinor: Minor;
  roundingMinor: Minor;
  grandTotalMinor: Minor;
}

/**
 * Half-up to a whole major unit: 1,234.50 -> 1,235.00, 1,234.49 -> 1,234.00.
 * A zero-decimal currency is already whole.
 */
export function roundToWholeUnit(amount: Minor, currency: string): Minor {
  const exponent = currencyExponent(currency);
  if (exponent === 0) return amount;
  const scale = 10n ** BigInt(exponent);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const whole = absolute / scale;
  const remainder = absolute % scale;
  const rounded = (remainder * 2n >= scale ? whole + 1n : whole) * scale;
  return negative ? -rounded : rounded;
}

/**
 * The document's totals. There is no discount on a commission - the fee is
 * already what the policy charged after its minimum and maximum - so the
 * column is shown as zero rather than left out, and nothing here can make it
 * anything else.
 */
export function commissionTotals(lines: readonly CommissionLine[], currency: string, roundGrandTotal: boolean): CommissionTotals {
  const sum = (pick: (line: CommissionLine) => Minor) => lines.reduce((total, line) => total + pick(line), 0n);
  const subtotalMinor = sum((line) => line.taxableMinor);
  const discountMinor = 0n;
  const taxableMinor = subtotalMinor - discountMinor;
  const totalTaxMinor = sum((line) => line.taxMinor);
  const beforeRounding = taxableMinor + totalTaxMinor;
  const grandTotalMinor = roundGrandTotal ? roundToWholeUnit(beforeRounding, currency) : beforeRounding;
  return {
    subtotalMinor,
    discountMinor,
    taxableMinor,
    cgstMinor: sum((line) => line.cgstMinor),
    sgstMinor: sum((line) => line.sgstMinor),
    igstMinor: sum((line) => line.igstMinor),
    otherTaxMinor: sum((line) => line.otherTaxMinor),
    totalTaxMinor,
    roundingMinor: grandTotalMinor - beforeRounding,
    grandTotalMinor,
  };
}

/**
 * "Rupees One Thousand One Hundred and Eighty Paise Only".
 *
 * `amountInWords` in `gst.ts` assumes two decimals; a zero-decimal currency
 * is written in whole units so a yen amount is not read as hundredths.
 */
export function commissionAmountInWords(amount: Minor, currency: string): string {
  const exponent = currencyExponent(currency);
  if (exponent === 2) return amountInWords(amount, currency);
  const scale = 10n ** BigInt(2 - Math.min(exponent, 2));
  return amountInWords(amount * scale, currency).replace(/ and [A-Za-z ]+ Hundredths/, '');
}

// ---------------------------------------------------------------------------
// Numbering
// ---------------------------------------------------------------------------

const PREFIX = /^[A-Z0-9](?:[A-Z0-9/-]{0,14}[A-Z0-9])?$/;

export function isValidDocumentPrefix(prefix: string): boolean {
  return PREFIX.test(prefix) && !prefix.includes('//');
}

/** "GM/COM" + "2026-27" + 1 -> "GM/COM/2026-27/000001". */
export function formatDocumentNumber(prefix: string, financialYearLabel: string, sequence: number, padding: number): string {
  return `${prefix}/${financialYearLabel}/${String(sequence).padStart(padding, '0')}`;
}

/**
 * The counter a number is drawn from: one per series prefix, per financial
 * year. A new year - or a new prefix - starts again at one, and two series
 * never share a counter.
 *
 * Keyed on exactly what the printed number is made of (`prefix/year/sequence`)
 * and nothing more, because the number is unique across the whole table. It
 * used to include the legal entity code as well; changing that code in
 * Settings while keeping the prefix then opened a fresh counter that printed
 * `GM/COM/2026-27/000001` a second time, hit the unique index, rolled its own
 * increment back, and so failed identically on every attempt from then on -
 * no invoice or credit note could be issued again.
 */
export function sequenceKey(kind: 'invoice' | 'credit-note', prefix: string, financialYearLabel: string): string {
  return `commission-${kind}:${prefix}:${financialYearLabel}`;
}

export function commissionFinancialYear(day: string, startMonth: number): string {
  return financialYear(day, startMonth).label;
}

/** Letters, digits and single hyphens only - safe on every file system. */
function fileSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * "Northwind-Commission-Invoice-GM-COM-2026-27-000001.pdf".
 *
 * Named after the operator's own marketplace, never a literal: every buyer of
 * this software issues these under their own name.
 */
export function documentFileName(kind: 'invoice' | 'credit-note', number: string, brand: string): string {
  const safe = fileSafe(number);
  const name = fileSafe(brand);
  return `${name === '' ? '' : `${name}-`}Commission-${kind === 'invoice' ? 'Invoice' : 'Credit-Note'}-${safe === '' ? 'draft' : safe}.pdf`;
}

// ---------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------

export interface CreditableLine {
  position: number;
  taxableMinor: Minor;
  cgstMinor: Minor;
  sgstMinor: Minor;
  igstMinor: Minor;
  otherTaxMinor: Minor;
}

export interface CreditLine {
  position: number;
  taxableMinor: Minor;
  cgstMinor: Minor;
  sgstMinor: Minor;
  igstMinor: Minor;
  otherTaxMinor: Minor;
  taxMinor: Minor;
}

export interface CreditFigures {
  lines: CreditLine[];
  taxableMinor: Minor;
  cgstMinor: Minor;
  sgstMinor: Minor;
  igstMinor: Minor;
  otherTaxMinor: Minor;
  totalTaxMinor: Minor;
  roundingMinor: Minor;
  grandTotalMinor: Minor;
  /** Whether this credit takes the invoice to zero. */
  completes: boolean;
}

export class CreditArithmeticError extends Error {}

function halfUpShare(amount: Minor, part: Minor, whole: Minor): Minor {
  if (whole <= 0n || part <= 0n || amount <= 0n) return 0n;
  return (amount * part * 2n + whole) / (2n * whole);
}

/**
 * What a credit note of `taxableMinor` reverses, line by line and component
 * by component.
 *
 * `invoice` is what was issued; `credited` is what earlier credit notes
 * already reversed, per line. A credit that takes the taxable amount to zero
 * reverses exactly what remains of every column, the rounding included, so
 * nothing is ever left over.
 */
export function creditFigures(input: {
  invoice: readonly CreditableLine[];
  credited: readonly CreditableLine[];
  invoiceRoundingMinor: Minor;
  creditedRoundingMinor: Minor;
  taxableMinor: Minor;
  currency: string;
  roundGrandTotal: boolean;
}): CreditFigures {
  const creditedBy = new Map(input.credited.map((line) => [line.position, line]));
  const remaining = input.invoice.map((line) => {
    const done = creditedBy.get(line.position);
    return {
      position: line.position,
      taxableMinor: line.taxableMinor - (done?.taxableMinor ?? 0n),
      cgstMinor: line.cgstMinor - (done?.cgstMinor ?? 0n),
      sgstMinor: line.sgstMinor - (done?.sgstMinor ?? 0n),
      igstMinor: line.igstMinor - (done?.igstMinor ?? 0n),
      otherTaxMinor: line.otherTaxMinor - (done?.otherTaxMinor ?? 0n),
      originalTaxable: line.taxableMinor,
      original: line,
    };
  });
  const remainingTaxable = remaining.reduce((sum, line) => sum + line.taxableMinor, 0n);

  if (input.taxableMinor <= 0n) throw new CreditArithmeticError('A credit note must reverse something.');
  if (input.taxableMinor > remainingTaxable) {
    throw new CreditArithmeticError('A credit note cannot reverse more than is left on the invoice.');
  }

  const completes = input.taxableMinor === remainingTaxable;
  const shares = completes
    ? remaining.map((line) => line.taxableMinor)
    : apportion(
        input.taxableMinor,
        remaining.map((line) => (line.taxableMinor > 0n ? line.taxableMinor : 0n)),
      );

  const lines: CreditLine[] = remaining.map((line, index) => {
    const share = shares[index] ?? 0n;
    const fully = completes || share === line.taxableMinor;
    const take = (left: Minor, original: Minor): Minor => {
      if (fully) return left;
      const proportional = halfUpShare(original, share, line.originalTaxable);
      return proportional > left ? left : proportional;
    };
    const cgstMinor = take(line.cgstMinor, line.original.cgstMinor);
    const sgstMinor = take(line.sgstMinor, line.original.sgstMinor);
    const igstMinor = take(line.igstMinor, line.original.igstMinor);
    const otherTaxMinor = take(line.otherTaxMinor, line.original.otherTaxMinor);
    return {
      position: line.position,
      taxableMinor: share,
      cgstMinor,
      sgstMinor,
      igstMinor,
      otherTaxMinor,
      taxMinor: cgstMinor + sgstMinor + igstMinor + otherTaxMinor,
    };
  });

  const sum = (pick: (line: CreditLine) => Minor) => lines.reduce((total, line) => total + pick(line), 0n);
  const taxableMinor = sum((line) => line.taxableMinor);
  const totalTaxMinor = sum((line) => line.taxMinor);
  const beforeRounding = taxableMinor + totalTaxMinor;
  let roundingMinor: Minor;
  if (completes) {
    roundingMinor = input.invoiceRoundingMinor - input.creditedRoundingMinor;
  } else {
    roundingMinor = input.roundGrandTotal ? roundToWholeUnit(beforeRounding, input.currency) - beforeRounding : 0n;
  }

  return {
    lines,
    taxableMinor,
    cgstMinor: sum((line) => line.cgstMinor),
    sgstMinor: sum((line) => line.sgstMinor),
    igstMinor: sum((line) => line.igstMinor),
    otherTaxMinor: sum((line) => line.otherTaxMinor),
    totalTaxMinor,
    roundingMinor,
    grandTotalMinor: beforeRounding + roundingMinor,
    completes,
  };
}

/**
 * The share of the fee a refund takes back: the invoice's taxable amount in
 * the proportion the seller's refunded proceeds bear to their proceeds,
 * half up, less what earlier credit notes already reversed. Never negative,
 * never more than is left.
 */
export function proportionalCreditTaxable(input: {
  invoiceTaxableMinor: Minor;
  alreadyCreditedTaxableMinor: Minor;
  refundedMinor: Minor;
  proceedsMinor: Minor;
}): Minor {
  if (input.proceedsMinor <= 0n || input.refundedMinor <= 0n) return 0n;
  const refunded = input.refundedMinor > input.proceedsMinor ? input.proceedsMinor : input.refundedMinor;
  const target = halfUpShare(input.invoiceTaxableMinor, refunded, input.proceedsMinor);
  const due = target - input.alreadyCreditedTaxableMinor;
  const left = input.invoiceTaxableMinor - input.alreadyCreditedTaxableMinor;
  if (due <= 0n) return 0n;
  return due > left ? left : due;
}
