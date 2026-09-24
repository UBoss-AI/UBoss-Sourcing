/**
 * The pure rules behind seller invoices and packing lists: GSTIN checksums,
 * place of supply, the CGST/SGST split, the financial year, apportioning an
 * order line across consignments, and the byte-for-byte determinism of the
 * rendered PDF and the batch ZIP.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  amountInWords,
  checkGstin,
  financialYear,
  gstinCheckCharacter,
  isValidHsn,
  placeOfSupply,
  splitGst,
  stateCodeForName,
} from '../../src/domain/gst.js';
import {
  NOTHING_INVOICED,
  shareOfLine,
  type OrderLineFigures,
} from '../../src/domain/seller-invoice.js';
import { crc32, zipStored } from '../../src/infra/zip.js';
import {
  renderPackingList,
  type PackingListDocument,
} from '../../src/modules/documents/packing-list-pdf.js';

describe('GSTIN', () => {
  it('accepts published sample GSTINs and computes their check character', () => {
    for (const gstin of ['27AAPFU0939F1ZV', '29AAACB2894G1ZJ', '33GSPTN0231G1ZM']) {
      expect(checkGstin(gstin)).toBeNull();
      expect(gstinCheckCharacter(gstin.slice(0, 14))).toBe(gstin[14]);
    }
  });

  it('names what is wrong: shape, state code or checksum', () => {
    expect(checkGstin('27AAPFU0939F1Z')).toBe('SHAPE');
    expect(checkGstin('99AAPFU0939F1ZV')).toBe('STATE');
    expect(checkGstin('27AAPFU0939F1ZA')).toBe('CHECKSUM');
    expect(checkGstin(null)).toBe('SHAPE');
  });

  it('accepts HSN codes of 4 to 8 digits only', () => {
    expect(isValidHsn('4015')).toBe(true);
    expect(isValidHsn('40151900')).toBe(true);
    expect(isValidHsn('401')).toBe(false);
    expect(isValidHsn('40AB')).toBe(false);
  });
});

describe('place of supply', () => {
  it('is intra-state when goods stay in the seller’s state, and inter-state otherwise', () => {
    expect(stateCodeForName('Maharashtra')).toBe('27');
    expect(
      placeOfSupply({
        sellerStateCode: '27',
        deliveryCountry: 'IN',
        deliveryState: 'maharashtra',
        taxChargedMinor: 1n,
      })?.supplyType,
    ).toBe('INTRA_STATE');
    expect(
      placeOfSupply({
        sellerStateCode: '27',
        deliveryCountry: 'IN',
        deliveryState: 'Karnataka',
        taxChargedMinor: 1n,
      }),
    ).toMatchObject({
      supplyType: 'INTER_STATE',
      stateCode: '29',
    });
  });

  it('is an export outside India, under LUT when no tax is charged', () => {
    expect(
      placeOfSupply({
        sellerStateCode: '27',
        deliveryCountry: 'DE',
        deliveryState: null,
        taxChargedMinor: 0n,
      }),
    ).toMatchObject({
      supplyType: 'EXPORT_UNDER_LUT',
      stateCode: '96',
    });
  });

  it('refuses to guess an unrecognised state', () => {
    expect(
      placeOfSupply({
        sellerStateCode: '27',
        deliveryCountry: 'IN',
        deliveryState: 'Atlantis',
        taxChargedMinor: 1n,
      }),
    ).toBeNull();
  });
});

describe('the GST split', () => {
  it('halves intra-state tax, giving an odd paisa to the state half', () => {
    expect(splitGst(18_001n, 'INTRA_STATE')).toEqual({ cgst: 9000n, sgst: 9001n, igst: 0n });
    expect(splitGst(18_001n, 'INTER_STATE')).toEqual({ cgst: 0n, sgst: 0n, igst: 18_001n });
  });
});

describe('the financial year', () => {
  it('starts in April for an Indian seller', () => {
    expect(financialYear('2027-03-15', 4)).toEqual({ label: '2026-27', short: '26-27' });
    expect(financialYear('2027-04-01', 4)).toEqual({ label: '2027-28', short: '27-28' });
    expect(financialYear('2027-04-01', 1).label).toBe('2027');
  });
});

describe('amount in words', () => {
  it('uses lakh and crore for rupees', () => {
    expect(amountInWords(12_345_678_90n, 'INR')).toMatch(/crore/i);
    expect(amountInWords(123_000_00n, 'INR')).toMatch(/lakh/i);
    expect(amountInWords(50n, 'INR')).toMatch(/paise/i);
  });
});

describe('apportioning an order line across consignments', () => {
  const line: OrderLineFigures = {
    orderItemId: 'x',
    quantity: 3,
    unitPriceMinor: 3333n,
    lineSubtotalMinor: 10_000n,
    discountMinor: 0n,
    taxAmountMinor: 1_801n,
    lineTotalMinor: 11_801n,
    taxRatePercent: '18',
    taxInclusive: false,
  };

  it('never loses or invents a paisa: the last consignment takes the remainder', () => {
    const first = shareOfLine(line, 1, NOTHING_INVOICED);
    const second = shareOfLine(line, 1, {
      quantity: 1,
      subtotalMinor: first.subtotalMinor,
      discountMinor: 0n,
      taxMinor: first.taxMinor,
      totalMinor: first.totalMinor,
    });
    const prior = {
      quantity: 2,
      subtotalMinor: first.subtotalMinor + second.subtotalMinor,
      discountMinor: 0n,
      taxMinor: first.taxMinor + second.taxMinor,
      totalMinor: first.totalMinor + second.totalMinor,
    };
    const third = shareOfLine(line, 1, prior);
    expect(first.taxMinor + second.taxMinor + third.taxMinor).toBe(1_801n);
    expect(first.totalMinor + second.totalMinor + third.totalMinor).toBe(11_801n);
    expect(third.taxableMinor).toBe(third.totalMinor - third.taxMinor);
  });

  it('refuses to invoice more pieces than the line holds', () => {
    expect(() => shareOfLine(line, 4, NOTHING_INVOICED)).toThrow();
    expect(() => shareOfLine(line, 0, NOTHING_INVOICED)).toThrow();
  });
});

describe('the batch ZIP', () => {
  it('stores entries whose checksums match and whose bytes are unchanged', () => {
    const bytes = Buffer.from('%PDF-1.7 hello');
    const zip = zipStored([{ name: 'a.pdf', bytes }]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt32LE(14)).toBe(crc32(bytes));
    expect(zip.includes(bytes)).toBe(true);
    // Stored, not deflated: method 0.
    expect(zip.readUInt16LE(8)).toBe(0);
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

describe('the rendered PDF', () => {
  const document: PackingListDocument = {
    number: 'PL-2026-000001',
    issueDay: '2026-09-24',
    issuedAt: new Date('2026-09-24T10:00:00.000Z'),
    shipper: { name: 'Omega Healthcare', lines: ['Pune'] },
    consignee: { name: 'Acme Hospitals', lines: ['Bengaluru'] },
    origin: ['Pune'],
    destination: ['Bengaluru'],
    facts: [['Order', 'SO-1']],
    packages: Array.from({ length: 80 }, (_, index) => ({
      reference: `PKG-${String(index + 1)}`,
      type: 'Carton',
      contents: 'SKU-1 × 10',
      netWeightGrams: 5000,
      grossWeightGrams: 5400,
      dimensions: '400 × 300 × 250 mm',
      volumeCm3: 30_000,
      seal: null,
    })),
    lines: [
      {
        sku: 'SKU-1',
        description: 'Gloves',
        quantity: 800,
        unitsPerCarton: 10,
        cartonsPerPallet: null,
        palletsPerContainer: null,
        batches: 'LOT-1',
        serials: '',
        origin: 'IN',
      },
    ],
    totals: {
      packages: 80,
      pieces: 800,
      netWeightGrams: 400_000,
      grossWeightGrams: 432_000,
      volumeCm3: 2_400_000,
    },
    handling: [],
  };

  it('runs over several pages and is identical byte for byte on every render', async () => {
    const first = await renderPackingList(document, { draft: false });
    const second = await renderPackingList(document, { draft: false });
    expect(first.pageCount).toBeGreaterThan(1);
    expect(first.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(createHash('sha256').update(first.bytes).digest('hex')).toBe(
      createHash('sha256').update(second.bytes).digest('hex'),
    );
  });
});
