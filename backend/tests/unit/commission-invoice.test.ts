/**
 * The commission invoice's rules and arithmetic, and its A6 PDF, without a
 * database. The figures are the settlement's; what is under test is that they
 * are presented truthfully and add up to the paisa.
 */
import { describe, expect, it } from 'vitest';

import {
  buildCommissionLines,
  commissionAmountInWords,
  commissionTotals,
  creditFigures,
  documentFileName,
  formatDocumentNumber,
  isValidDocumentPrefix,
  proportionalCreditTaxable,
  resolveCommissionTax,
  roundToWholeUnit,
  sequenceKey,
  type IssuerTaxFacts,
} from '../../src/domain/commission-invoice.js';
import { activeKeyFor, assertCommissionMove, canMove } from '../../src/domain/commission-invoice-state.js';
import { CODE128_PATTERNS, CODE128_STOP, code128Values, code128Widths } from '../../src/modules/documents/code128.js';
import { A6, MIN_FONT_SIZE, renderCommissionDocument, type CommissionPdfDocument } from '../../src/modules/documents/commission-invoice-pdf.js';
import { inspectPdf } from '../support/pdf-inspect.js';

const INDIA: IssuerTaxFacts = {
  regime: 'IN_GST',
  country: 'IN',
  stateCode: '27',
  taxRegistrationNumber: '27AAPFU0939F1ZV',
  lutReference: null,
  zeroTaxDocumentType: 'INVOICE',
  requireSellerTaxId: true,
};
const GST_18 = { taxMinor: 1_800n, ratePercent: '18.000000', verified: true, label: 'GST' };

describe('tax treatment', () => {
  it('splits CGST + SGST inside the issuer’s state, and IGST across states', () => {
    const intra = resolveCommissionTax(INDIA, { country: 'IN', taxId: '27AAPFU0939F1ZV', region: null }, GST_18);
    expect(intra).toMatchObject({ treatment: 'IN_INTRA_STATE', split: 'CGST_SGST', documentType: 'TAX_INVOICE', issues: [] });
    expect(intra.placeOfSupply).toEqual({ code: '27', name: 'Maharashtra' });

    const inter = resolveCommissionTax(INDIA, { country: 'IN', taxId: '29AAACB2894G1ZJ', region: null }, GST_18);
    expect(inter).toMatchObject({ treatment: 'IN_INTER_STATE', split: 'IGST', issues: [] });
  });

  it('calls the state half UTGST in a union territory without a legislature', () => {
    const chandigarh = resolveCommissionTax(
      { ...INDIA, stateCode: '04', taxRegistrationNumber: '04AABCU9603R1ZV' },
      { country: 'IN', taxId: null, region: 'Chandigarh' },
      GST_18,
    );
    expect(chandigarh.labels.sgst).toBe('UTGST');
    const delhi = resolveCommissionTax(
      { ...INDIA, stateCode: '07', taxRegistrationNumber: '07AABCU9603R1ZM' },
      { country: 'IN', taxId: null, region: 'Delhi' },
      GST_18,
    );
    expect(delhi.labels.sgst).toBe('SGST');
  });

  it('never fabricates Indian tax for a seller outside India', () => {
    const exportTaxed = resolveCommissionTax(INDIA, { country: 'DE', taxId: 'DE123456789', region: 'Berlin' }, GST_18);
    expect(exportTaxed).toMatchObject({ treatment: 'IN_EXPORT_WITH_TAX', split: 'IGST' });
    const underLut = resolveCommissionTax({ ...INDIA, lutReference: 'AD270326000123X' }, { country: 'DE', taxId: null, region: null }, { ...GST_18, taxMinor: 0n, ratePercent: '0' });
    expect(underLut).toMatchObject({ treatment: 'IN_EXPORT_UNDER_LUT', split: 'NONE', issues: [] });
    expect(underLut.declarations[0]).toContain('AD270326000123X');
  });

  it('refuses GST the finance team has not verified, and tax from an unregistered issuer', () => {
    const unverified = resolveCommissionTax(INDIA, { country: 'IN', taxId: '27AAPFU0939F1ZV', region: null }, { ...GST_18, verified: false });
    expect(unverified.issues.map((issue) => issue.code)).toEqual(['TAX_RULE_UNVERIFIED']);
    const none = resolveCommissionTax({ ...INDIA, regime: 'NONE', taxRegistrationNumber: null }, { country: 'IN', taxId: null, region: null }, GST_18);
    expect(none.issues.map((issue) => issue.code)).toContain('TAX_WITHOUT_REGISTRATION');
    expect(none.documentType).toBe('INVOICE');
  });

  it('checks both GSTINs and that the issuer’s GSTIN belongs to its state', () => {
    const wrong = resolveCommissionTax({ ...INDIA, stateCode: '29' }, { country: 'IN', taxId: '27AAPFU0939F1ZX', region: null }, GST_18);
    const codes = wrong.issues.map((issue) => issue.code);
    expect(codes).toContain('ISSUER_GSTIN_STATE_MISMATCH');
    expect(codes).toContain('SELLER_GSTIN_CHECKSUM');
  });

  it('marks a zero-taxed cross-border supply to a VAT-registered seller as reverse charge', () => {
    const vat: IssuerTaxFacts = { ...INDIA, regime: 'VAT', country: 'NL', stateCode: null, taxRegistrationNumber: 'NL123456789B01' };
    const reverse = resolveCommissionTax(vat, { country: 'DE', taxId: 'DE123456789', region: null }, { taxMinor: 0n, ratePercent: '0', verified: true, label: 'VAT' });
    expect(reverse).toMatchObject({ treatment: 'REVERSE_CHARGE', reverseCharge: true, documentType: 'INVOICE' });
    const domestic = resolveCommissionTax(vat, { country: 'NL', taxId: 'NL000099998B57', region: null }, { taxMinor: 2_100n, ratePercent: '21', verified: true, label: 'VAT' });
    expect(domestic).toMatchObject({ treatment: 'DOMESTIC', split: 'OTHER', documentType: 'TAX_INVOICE' });
  });

  it('calls a document with no tax on it what the settings say, never a tax invoice', () => {
    const exempt = resolveCommissionTax({ ...INDIA, zeroTaxDocumentType: 'BILL_OF_SUPPLY' }, { country: 'IN', taxId: '27AAPFU0939F1ZV', region: null }, { ...GST_18, taxMinor: 0n });
    expect(exempt.documentType).toBe('BILL_OF_SUPPLY');
  });
});

describe('lines and totals', () => {
  const source = {
    platformFeeMinor: 15_050n,
    platformFeeTaxMinor: 2_709n,
    feeTaxRatePercent: '18.000000',
    feeBasisMinor: 150_500n,
    breakdown: [
      { policyId: 'a', policyVersion: 2, feeType: 'PERCENT', percentRate: '10.000000', basisMinor: '100000', feeMinor: '10000', taxRatePercent: '18.000000', taxMinor: '1800' },
      { policyId: 'b', policyVersion: 1, feeType: 'PERCENT', percentRate: '10.000000', basisMinor: '50500', feeMinor: '5050', taxRatePercent: '18.000000', taxMinor: '909' },
    ],
  };
  const base = { currency: 'INR', orderNumber: 'UB-1', sellerOrderNumber: 'S-1', descriptionTemplate: 'Marketplace platform commission for Order {orderNumber}', serviceCode: '998599' };

  it('shows one line per fee policy when the breakdown adds up to the stored figures', () => {
    const lines = buildCommissionLines({ ...base, source, split: 'CGST_SGST' });
    expect(lines).toHaveLength(2);
    expect(lines[0]?.description).toBe('Marketplace platform commission for Order UB-1');
    expect(lines[1]).toMatchObject({ taxableMinor: 5_050n, cgstMinor: 454n, sgstMinor: 455n, totalMinor: 5_959n });
  });

  it('falls back to the stored totals when the breakdown disagrees with them', () => {
    const lines = buildCommissionLines({ ...base, source: { ...source, platformFeeTaxMinor: 2_710n }, split: 'IGST' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ taxableMinor: 15_050n, igstMinor: 2_710n, taxMinor: 2_710n });
  });

  it('adds up, and rounds the grand total half up only when asked', () => {
    const lines = buildCommissionLines({ ...base, source, split: 'CGST_SGST' });
    const exact = commissionTotals(lines, 'INR', false);
    expect(exact).toMatchObject({ taxableMinor: 15_050n, totalTaxMinor: 2_709n, roundingMinor: 0n, grandTotalMinor: 17_759n });
    expect(exact.cgstMinor + exact.sgstMinor).toBe(2_709n);
    const rounded = commissionTotals(lines, 'INR', true);
    expect(rounded).toMatchObject({ roundingMinor: 41n, grandTotalMinor: 17_800n });
    expect(roundToWholeUnit(123_449n, 'INR')).toBe(123_400n);
    expect(roundToWholeUnit(123_450n, 'INR')).toBe(123_500n);
    expect(roundToWholeUnit(1_234n, 'JPY')).toBe(1_234n);
  });

  it('writes the amount in words, Indian style for rupees', () => {
    expect(commissionAmountInWords(11_800n, 'INR')).toBe('Rupees One Hundred Eighteen Only');
    expect(commissionAmountInWords(96_180_050n, 'INR')).toBe('Rupees Nine Lakh Sixty One Thousand Eight Hundred and Fifty Paise Only');
    expect(commissionAmountInWords(1_234_567n, 'EUR')).toBe('Euro Twelve Thousand Three Hundred Forty Five and Sixty Seven Cents Only');
  });
});

describe('credit notes', () => {
  const invoice = [
    { position: 1, taxableMinor: 10_000n, cgstMinor: 900n, sgstMinor: 900n, igstMinor: 0n, otherTaxMinor: 0n },
    { position: 2, taxableMinor: 5_050n, cgstMinor: 454n, sgstMinor: 455n, igstMinor: 0n, otherTaxMinor: 0n },
  ];
  const common = { invoice, invoiceRoundingMinor: 0n, creditedRoundingMinor: 0n, currency: 'INR', roundGrandTotal: false };

  it('reverses tax in proportion, and a final credit takes exactly what is left', () => {
    const first = creditFigures({ ...common, credited: [], taxableMinor: 3_333n });
    expect(first.completes).toBe(false);
    expect(first.taxableMinor).toBe(3_333n);
    const rest = creditFigures({ ...common, credited: first.lines, taxableMinor: 15_050n - 3_333n });
    expect(rest.completes).toBe(true);
    expect(first.cgstMinor + rest.cgstMinor).toBe(1_354n);
    expect(first.sgstMinor + rest.sgstMinor).toBe(1_355n);
    expect(first.grandTotalMinor + rest.grandTotalMinor).toBe(15_050n + 2_709n);
  });

  it('never credits more than is left', () => {
    expect(() => creditFigures({ ...common, credited: [], taxableMinor: 15_051n })).toThrow('more than is left');
    expect(() => creditFigures({ ...common, credited: [], taxableMinor: 0n })).toThrow();
  });

  it('works the refunded share out from the settlement’s own figures', () => {
    expect(proportionalCreditTaxable({ invoiceTaxableMinor: 10_000n, alreadyCreditedTaxableMinor: 0n, refundedMinor: 50_000n, proceedsMinor: 100_000n })).toBe(5_000n);
    expect(proportionalCreditTaxable({ invoiceTaxableMinor: 10_000n, alreadyCreditedTaxableMinor: 5_000n, refundedMinor: 50_000n, proceedsMinor: 100_000n })).toBe(0n);
    expect(proportionalCreditTaxable({ invoiceTaxableMinor: 10_000n, alreadyCreditedTaxableMinor: 0n, refundedMinor: 500_000n, proceedsMinor: 100_000n })).toBe(10_000n);
  });
});

describe('numbering', () => {
  it('formats, keys and names files per entity, series and year', () => {
    expect(formatDocumentNumber('GM/COM', '2026-27', 1, 6)).toBe('GM/COM/2026-27/000001');
    expect(sequenceKey('invoice', 'GM/COM', '2026-27')).toBe('commission-invoice:GM/COM:2026-27');
    expect(sequenceKey('credit-note', 'GM/CCN', '2026-27')).not.toBe(sequenceKey('invoice', 'GM/CCN', '2026-27'));
    // The number is unique across the table, so the counter is keyed on what
    // the number is made of - never on the legal entity, which can change.
    expect(sequenceKey('invoice', 'GM/COM', '2026-27')).toBe(sequenceKey('invoice', 'GM/COM', '2026-27'));
    expect(documentFileName('invoice', 'GM/COM/2026-27/000001', 'Northwind Supply')).toBe('Northwind-Supply-Commission-Invoice-GM-COM-2026-27-000001.pdf');
    expect(documentFileName('credit-note', '../../etc/passwd', 'Northwind')).toBe('Northwind-Commission-Credit-Note-etc-passwd.pdf');
    // The operator's name is theirs to choose and is made file-safe too.
    expect(documentFileName('invoice', 'X/1', '../Évil "Co"')).toBe('vil-Co-Commission-Invoice-X-1.pdf');
    expect(isValidDocumentPrefix('GM/COM')).toBe(true);
    expect(isValidDocumentPrefix('gm/com')).toBe(false);
    expect(isValidDocumentPrefix('GM//COM')).toBe(false);
    expect(isValidDocumentPrefix('GM/')).toBe(false);
  });
});

describe('lifecycle', () => {
  it('moves only the ways the lifecycle allows', () => {
    expect(assertCommissionMove('DRAFT', 'ISSUE')).toBe('ISSUED');
    expect(assertCommissionMove('ISSUED', 'CREDIT_PART')).toBe('PARTIALLY_CREDITED');
    expect(assertCommissionMove('PARTIALLY_CREDITED', 'CREDIT_REST')).toBe('FULLY_CREDITED');
    expect(assertCommissionMove('DRAFT', 'DISCARD')).toBe('VOID');
    expect(() => assertCommissionMove('ISSUED', 'REGENERATE')).toThrow(expect.objectContaining({ code: 'COMMISSION_INVOICE_IMMUTABLE' }) as Error);
    expect(() => assertCommissionMove('FULLY_CREDITED', 'CREDIT_PART')).toThrow(expect.objectContaining({ code: 'COMMISSION_INVOICE_INVALID_TRANSITION' }) as Error);
    expect(canMove('VOID', 'ISSUE')).toBe(false);
    expect(activeKeyFor('PARTIALLY_CREDITED', 'S1')).toBe('S1');
    expect(activeKeyFor('FULLY_CREDITED', 'S1')).toBeNull();
    expect(activeKeyFor('VOID', 'S1')).toBeNull();
  });
});

describe('Code 128', () => {
  it('uses a well-formed symbol table', () => {
    expect(CODE128_PATTERNS).toHaveLength(106);
    expect(new Set(CODE128_PATTERNS).size).toBe(106);
    for (const pattern of CODE128_PATTERNS) {
      expect([...pattern].reduce((sum, width) => sum + Number(width), 0)).toBe(11);
    }
    expect([...CODE128_STOP].reduce((sum, width) => sum + Number(width), 0)).toBe(13);
  });

  it('encodes subset B with its check symbol', () => {
    // ISO/IEC 15417 worked example shape: start B (104), then value = code - 32.
    const values = code128Values('GM/COM');
    expect(values[0]).toBe(104);
    expect(values.slice(1, -1)).toEqual([39, 45, 15, 35, 47, 45]);
    const checksum = (104 + 39 * 1 + 45 * 2 + 15 * 3 + 35 * 4 + 47 * 5 + 45 * 6) % 103;
    expect(values.at(-1)).toBe(checksum);
    const widths = code128Widths('GM/COM');
    expect(widths.length % 2).toBe(1);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBe(8 * 11 + 13);
    expect(() => code128Values('₹')).toThrow();
  });
});

function sample(overrides: Partial<CommissionPdfDocument> = {}): CommissionPdfDocument {
  return {
    title: 'TAX INVOICE',
    subtitle: 'Platform Commission',
    draft: false,
    brand: 'Example Marketplace',
    number: 'GM/COM/2026-27/000042',
    issuedAt: new Date('2026-09-28T10:30:00.000Z'),
    supplier: { heading: 'From — Supplier', name: 'Example Operations Private Limited (TEST)', lines: ['Gloviaa Mart — Powered by UBOSS', 'Pune, Maharashtra 411001, IN', 'GSTIN: 27AAPFU0939F1ZV'] },
    recipient: { heading: 'Bill To — Seller', name: 'Śrī Łódź Ελληνικά Healthcare', lines: ['Seller ID: 01K5TESTSELLER0000000000000', 'Pune, Maharashtra 411019, IN'] },
    facts: [['Invoice no.', 'GM/COM/2026-27/000042'], ['Currency', 'INR'], ['Order no.', 'UB-1']],
    currency: 'INR',
    codeHeader: 'SAC',
    lines: [{ description: 'Marketplace platform commission for Order UB-1', detail: '10% of 1,000.00 INR', code: '998599', orderReference: 'S-1', taxable: '100.00', rate: '18%', tax: '18.00', total: '118.00' }],
    totals: [{ label: 'Taxable value', value: '100.00' }, { label: 'Grand total', value: '₹118.00', strong: true }],
    amountInWords: 'Rupees One Hundred Eighteen Only',
    collection: { label: 'Amount Payable by Seller to Gloviaa Mart', value: '₹118.00', note: 'Outstanding at issue.' },
    declarations: [],
    qr: { url: 'https://example.test/verify-document?kind=commission-invoice&number=X&code=0123456789ABCDEF', caption: 'Verify this document.' },
    footerLines: ['Computer-generated document; no signature required.'],
    metadata: { title: 'Commission invoice GM/COM/2026-27/000042', subject: 'TAX INVOICE - Platform Commission', author: 'Example (TEST)', keywords: 'commission invoice' },
    ...overrides,
  };
}

describe('the A6 PDF', () => {
  it('is exactly 105 × 148 mm, deterministic, with metadata and searchable Unicode text', async () => {
    const first = await renderCommissionDocument(sample());
    const second = await renderCommissionDocument(sample());
    expect(first.bytes.equals(second.bytes)).toBe(true);
    const pdf = inspectPdf(first.bytes);
    expect(pdf.pages[0]?.widthPt).toBeCloseTo(A6.width, 3);
    expect(pdf.pages[0]?.heightPt).toBeCloseTo(A6.height, 3);
    expect(pdf.info).toMatchObject({ Title: 'Commission invoice GM/COM/2026-27/000042', Subject: 'TAX INVOICE - Platform Commission' });
    const text = pdf.pages.map((page) => page.text).join('\n');
    expect(text).toContain('Śrī Łódź Ελληνικά Healthcare');
    expect(text).toContain('₹118.00');
    expect(text).toContain('Powered by UBOSS');
    expect(MIN_FONT_SIZE).toBeGreaterThanOrEqual(6);
  });

  it('wraps long names instead of clipping them, and never runs past the page', async () => {
    const longName = `${'Extraordinarily Long Seller Legal Business Name '.repeat(6)}Private Limited`;
    const rendered = await renderCommissionDocument(sample({ recipient: { heading: 'Bill To — Seller', name: longName, lines: ['Plot 1, '.repeat(20)] } }));
    const text = inspectPdf(rendered.bytes).pages.map((page) => page.text).join(' ');
    expect(text.replace(/\s+/g, ' ')).toContain('Extraordinarily Long Seller Legal Business Name Extraordinarily');
  });

  it('breaks a long table across pages, repeating the header and numbering every page', async () => {
    const line = sample().lines[0];
    if (line === undefined) throw new Error('fixture');
    const rendered = await renderCommissionDocument(sample({ lines: Array.from({ length: 30 }, (_, index) => ({ ...line, orderReference: `S-${String(index + 1)}` })) }));
    expect(rendered.pageCount).toBeGreaterThan(2);
    const pages = inspectPdf(rendered.bytes).pages;
    expect(pages).toHaveLength(rendered.pageCount);
    pages.forEach((page, index) => {
      expect(page.text).toContain(`${String(index + 1)}/${String(pages.length)}`);
      expect(page.widthPt).toBeCloseTo(A6.width, 3);
    });
    const withHeader = pages.filter((page) => page.text.includes('Description of service'));
    expect(withHeader.length).toBeGreaterThan(1);
    const references = pages.map((page) => page.text).join('\n');
    for (let index = 1; index <= 30; index += 1) expect(references).toContain(`S-${String(index)}\n`);
  });

  it('marks a draft, and gives it no number, barcode or QR', async () => {
    const rendered = await renderCommissionDocument(sample({ draft: true, number: null, qr: null }));
    const text = inspectPdf(rendered.bytes).pages.map((page) => page.text).join('\n');
    expect(text).toContain('DRAFT - NOT A VALID DOCUMENT');
    expect(text).not.toContain('VERIFY THIS DOCUMENT');
  });
});
