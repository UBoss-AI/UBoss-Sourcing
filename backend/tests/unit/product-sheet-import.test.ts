/**
 * Reading a supplier product sheet.
 *
 * Three things are pinned here, and each one is a way a catalogue import goes
 * wrong silently rather than loudly.
 *
 *   * **Packing.** "100Pcs x 20Box=2000PCS" decides how many syringes leave the
 *     warehouse when somebody orders one carton. A parser that guesses at the
 *     format it does not recognise ships the wrong quantity and nothing errors.
 *
 *   * **Identity.** The source workbook reuses product codes and barcodes
 *     across genuinely different articles. Keying on one column merges a 14G
 *     cannula into an 18G, permanently and quietly.
 *
 *   * **Units.** A box written "15*12 inch pouch" is not 15 x 12 mm. Assuming a
 *     unit nobody stated is a twenty-five-fold error in a figure somebody sizes
 *     a pallet from.
 *
 * The packing cases are taken verbatim from the workbook this was written for -
 * all 41 distinct spellings reduce to the handful of shapes below.
 */
import { describe, expect, it } from 'vitest';
import {
  packingFormula,
  parsePacking,
} from '../../src/modules/catalog/sheet-import/packing-parser.js';
import { parseDimension } from '../../src/modules/catalog/sheet-import/dimension-parser.js';
import {
  cleanCell,
  familyFingerprint,
  normaliseGtin,
  sterilityOf,
  titleCase,
  variantFingerprint,
} from '../../src/modules/catalog/sheet-import/sheet-values.js';

describe('packing quantities', () => {
  it('reads the three-number form, whatever it is spelled with', () => {
    for (const text of [
      '100Pcs x 20Box=2000PCS',
      '100 pcs x 20Box=2000 Pcs',
      '100pcs×20box=2,000 pcs/Outer',
      '100pcs-inner/outer-100*20=2000 pcs',
    ]) {
      const packing = parsePacking(text);

      expect(packing.status, text).toBe('PARSED');
      expect(packing.piecesPerInnerPack, text).toBe(100);
      expect(packing.innerPacksPerOuterCarton, text).toBe(20);
      expect(packing.piecesPerOuterCarton, text).toBe(2000);
      // The source text survives whatever the parser made of it. It is the
      // only thing that can settle an argument about what was supplied.
      expect(packing.raw, text).toBe(text);
    }
  });

  it('names the inner pack the way the source did', () => {
    expect(parsePacking('10 pcs x 12Pkt =120 Pcs').innerPackType).toBe('Packet');
    expect(parsePacking('50Pcs x 8Box=400Pcs').innerPackType).toBe('Box');
    expect(parsePacking('50 pcs one pouch/400 pcs').innerPackType).toBe('Pouch');
  });

  it('derives the missing factor only when the division is exact', () => {
    const exact = parsePacking('50 pcs one pouch/400 pcs');
    expect(exact.status).toBe('PARSED');
    expect(exact.piecesPerInnerPack).toBe(50);
    expect(exact.innerPacksPerOuterCarton).toBe(8);
    expect(exact.piecesPerOuterCarton).toBe(400);
    // It says where the figure came from rather than presenting it as stated.
    expect(exact.message).toMatch(/calculated/i);

    const inexact = parsePacking('inner -30 pcs/outer -400 pcs');
    expect(inexact.status).toBe('PARTIAL');
    expect(inexact.piecesPerInnerPack).toBe(30);
    expect(inexact.piecesPerOuterCarton).toBe(400);
    // 400 / 30 is 13.33. Nothing is rounded into the gap.
    expect(inexact.innerPacksPerOuterCarton).toBeNull();
  });

  it('flags a source whose own multiplication disagrees, and corrects nothing', () => {
    const packing = parsePacking('100Pcs x 20Box=1800Pcs');

    expect(packing.status).toBe('NEEDS_REVIEW');
    // Both figures are kept exactly as the source wrote them: the sheet is as
    // likely to be right about the total as about the factors, and choosing
    // for it is how a customer ends up disputing a quantity nobody can explain.
    expect(packing.piecesPerInnerPack).toBe(100);
    expect(packing.innerPacksPerOuterCarton).toBe(20);
    expect(packing.piecesPerOuterCarton).toBe(1800);
    expect(packing.message).toContain('2,000');
    expect(packing.message).toContain('1,800');
  });

  it('never invents an inner count from a bare total', () => {
    for (const text of ['400Pcs', '80 PCS', '300Pcs']) {
      const packing = parsePacking(text);
      expect(packing.status, text).toBe('PARTIAL');
      expect(packing.piecesPerInnerPack, text).toBeNull();
      expect(packing.innerPacksPerOuterCarton, text).toBeNull();
      expect(packing.piecesPerOuterCarton, text).toBe(Number.parseInt(text, 10));
    }
  });

  it('keeps unreadable text without turning it into a quantity', () => {
    const packing = parsePacking('as per customer requirement');

    expect(packing.status).toBe('UNPARSED');
    expect(packing.piecesPerOuterCarton).toBeNull();
    expect(packing.raw).toBe('as per customer requirement');
  });

  it('treats an empty cell as nothing said rather than as zero', () => {
    const packing = parsePacking(null);
    expect(packing.status).toBe('UNPARSED');
    expect(packing.piecesPerOuterCarton).toBeNull();
  });

  it('states the conversion the way every screen will show it', () => {
    expect(packingFormula(parsePacking('100Pcs x 20Box=2000Pcs'))).toBe(
      '100 pieces × 20 boxes = 2,000 pieces',
    );
    expect(packingFormula(parsePacking('10 pcs x 12Pkt =120 Pcs'))).toBe(
      '10 pieces × 12 packets = 120 pieces',
    );
    // A total with no breakdown states the total, and claims nothing else.
    expect(packingFormula(parsePacking('400Pcs'))).toBe('400 pieces per carton');
    expect(packingFormula(parsePacking(''))).toBeNull();
  });
});

describe('dimensions', () => {
  it('records a unit only when the source stated one', () => {
    const stated = parseDimension('460*350*210 mm');
    expect(stated.status).toBe('PARSED');
    expect(stated.displayValue).toBe('460 × 350 × 210');
    expect(stated.unit).toBe('mm');

    // The commonest shape in the source: numbers, no unit anywhere.
    const unstated = parseDimension('168 X 124 X 155');
    expect(unstated.status).toBe('UNIT_UNKNOWN');
    expect(unstated.displayValue).toBe('168 × 124 × 155');
    expect(unstated.unit).toBeNull();
  });

  it('reads a unit written against the digits', () => {
    // "35.5*155mm" has no word boundary before the unit, which is exactly the
    // spelling a naive \bmm\b pattern misses.
    expect(parseDimension('35.5*155mm').unit).toBe('mm');
    expect(parseDimension('35.5*155mm').displayValue).toBe('35.5 × 155');
  });

  it('does not read inches as millimetres', () => {
    const dimension = parseDimension('15*12 inch pouch');
    expect(dimension.unit).toBe('inch');
    expect(dimension.displayValue).toBe('15 × 12');
  });

  it('keeps a two-number source at two numbers', () => {
    // No invented height. A pouch is measured in two.
    expect(parseDimension('27 x 134').displayValue).toBe('27 × 134');
  });

  it('refuses to read a cell holding more than one measurement', () => {
    const dimension = parseDimension('460 x 350 x 210 and 600 x 400 x 300');
    expect(dimension.status).toBe('UNPARSED');
    expect(dimension.displayValue).toBeNull();
    expect(dimension.raw).toBe('460 x 350 x 210 and 600 x 400 x 300');
  });
});

describe('cell values', () => {
  it('reads the sheet spellings of "nothing recorded" as nothing', () => {
    for (const blank of ['', '  ', 'N/A', 'n/a', '-', '--', 'NA']) {
      expect(cleanCell(blank), blank).toBeNull();
    }
  });

  it('keeps a zero, which is a real answer', () => {
    expect(cleanCell('0')).toBe('0');
  });

  it('collapses the double spaces that would otherwise split one product in two', () => {
    expect(cleanCell('3 ML  ORAL DISPENSING SYRINGE')).toBe('3 ML ORAL DISPENSING SYRINGE');
  });

  it('drops the trailing comma somebody left on a product code', () => {
    expect(cleanCell('3E114,')).toBe('3E114');
  });
});

describe('barcodes', () => {
  it('reduces both spellings of one barcode to the same digits', () => {
    // The source writes the same article both ways. If these did not compare
    // equal the catalogue would hold it twice.
    expect(normaliseGtin('(01) 0 8904379800013')).toBe('08904379800013');
    expect(normaliseGtin('8904379800013')).toBe('08904379800013');
  });

  it('keeps the leading zero that a numeric column would have eaten', () => {
    expect(normaliseGtin('08904379800013')).toBe('08904379800013');
    expect(normaliseGtin('12345670')).toBe('00000012345670');
  });

  it('leaves a value that is not a barcode out of the normalised column', () => {
    expect(normaliseGtin('to be allotted')).toBeNull();
    expect(normaliseGtin('1234')).toBeNull();
    expect(normaliseGtin('N/A')).toBeNull();
  });
});

describe('product identity', () => {
  const base = {
    category: 'IV CANNULA',
    productCode: '3A114',
    gtin: '08904379800013',
    genericName: 'I.V. Cannula',
    model: '14G',
    brand: 'ACCU VEIN',
    packingType: 'BLISTER PACK',
  };

  it('ignores case and spacing, so a retyped row is the same row', () => {
    expect(variantFingerprint(base)).toBe(
      variantFingerprint({ ...base, genericName: 'i.v.  cannula', brand: 'Accu Vein' }),
    );
  });

  it('separates two articles that share a product code', () => {
    // Rows 223 and 231 of the source: one code, two barcodes, two pack counts.
    // Keyed on the code alone, one would overwrite the other.
    expect(variantFingerprint(base)).not.toBe(
      variantFingerprint({ ...base, gtin: '08904379800020' }),
    );
  });

  it('separates two articles that share a barcode', () => {
    expect(variantFingerprint(base)).not.toBe(variantFingerprint({ ...base, model: '18G' }));
  });

  it('treats a different packing as a different thing to order', () => {
    // Same syringe, blister and ribbon: different barcode, different carton.
    expect(variantFingerprint(base)).not.toBe(
      variantFingerprint({ ...base, packingType: 'RIBBON PACK' }),
    );
  });

  it('groups sizes of one branded product into a single listing', () => {
    const family = {
      category: 'IV CANNULA',
      genericName: 'I.V. Cannula',
      brand: 'ACCU VEIN',
      sterilisation: 'ETO STERILE',
      packingType: 'BLISTER PACK',
    };

    // The brand is what separates two listings of the same generic article.
    expect(familyFingerprint(family)).not.toBe(
      familyFingerprint({ ...family, brand: 'EASY FLON' }),
    );
    // Sterilisation and packing are real product differences too: the same
    // syringe blistered and ribboned has two barcodes and two carton sizes.
    expect(familyFingerprint(family)).not.toBe(
      familyFingerprint({ ...family, packingType: 'RIBBON PACK' }),
    );
  });

  it('groups rows with no generic name on their brand, not their code', () => {
    // The regression this exists for: the product code used to be the fallback
    // when column D was blank, and a code is unique per ROW by design. Eight
    // safety needles that differ only in gauge came out as eight identical
    // listings - and 140 rows of the source workbook have no name in column D.
    const needle = {
      category: 'SAFETY NEEDLE',
      genericName: null,
      brand: 'Easy Safy Pric',
      sterilisation: 'ETO STERILE',
      packingType: 'Blister Pack',
    };

    // Same product, four gauges and a spare code suffix each: one listing.
    // Nothing about the row's own code may reach the family key.
    expect(familyFingerprint(needle)).toBe(familyFingerprint({ ...needle }));

    // And a different brand in the same department is still a different
    // product, so the merge cannot run away.
    expect(familyFingerprint(needle)).not.toBe(
      familyFingerprint({ ...needle, brand: 'Some Other Brand' }),
    );
  });
});

describe('sterility', () => {
  it('reads the sheet vocabulary', () => {
    expect(sterilityOf('ETO STERILE')).toBe('STERILE');
    expect(sterilityOf('GAMMA STERILE')).toBe('STERILE');
    expect(sterilityOf('Gamma')).toBe('STERILE');
    expect(sterilityOf('Sterile Fluid Path')).toBe('STERILE');
  });

  it('reads non-sterile before it reads sterile', () => {
    // "NON-STERILE" contains "STERILE". Getting this order wrong puts a
    // non-sterile item in front of somebody filtering for a sterile one.
    expect(sterilityOf('Non-Sterile')).toBe('NON_STERILE');
    expect(sterilityOf('Non Sterile')).toBe('NON_STERILE');
    expect(sterilityOf('ORAL SYRINGE UNSTERILIZED 1 ML')).toBe('NON_STERILE');
  });

  it('answers nothing when the cell is not an answer', () => {
    expect(sterilityOf('')).toBeNull();
    expect(sterilityOf('N/A')).toBeNull();
    expect(sterilityOf('see specification')).toBeNull();
  });
});

describe('display names', () => {
  it('unshouts a name written in capitals', () => {
    expect(titleCase('DISPOSABLE HYPODERMIC SYRINGE')).toBe('Disposable Hypodermic Syringe');
    expect(titleCase('EASY JET ORAL DISPENSING SYRINGE')).toBe('Easy Jet Oral Dispensing Syringe');
  });

  it('leaves a name somebody capitalised deliberately alone', () => {
    expect(titleCase('EasyFlow')).toBe('EasyFlow');
    expect(titleCase('Veinfix')).toBe('Veinfix');
  });

  it('keeps the abbreviations that mean something', () => {
    expect(titleCase('I.V. CANNULA')).toBe('I.V. Cannula');
    expect(titleCase('3 ML ORAL DISPENSING SYRINGE')).toBe('3 ml Oral Dispensing Syringe');
  });
});
