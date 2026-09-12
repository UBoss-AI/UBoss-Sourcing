/**
 * Turning what a spreadsheet cell contains into something a database column can
 * hold, and deciding when two rows are the same product.
 *
 * The identity question is the one that matters. The workbook this was written
 * for contains 18 product codes used more than once, 50 barcodes used more than
 * once, six rows whose product code is literally "N/A", and seven whose code is
 * "Generic". Keying on either column alone would merge products that are not
 * the same thing - a 14G cannula overwriting an 18G because a supplier reused a
 * code - and that merge is silent, permanent and very hard to notice.
 *
 * So identity is a composite fingerprint, and it is deliberately conservative:
 * when two rows differ in any field a buyer could tell apart, they are two
 * records. The cost of being wrong that way is a duplicate an administrator can
 * merge. The cost of being wrong the other way is a customer receiving the
 * wrong gauge of needle.
 */
import { createHash } from 'node:crypto';

/**
 * Spellings of "this field is empty" that a hand-kept sheet uses.
 *
 * All of these mean nothing was recorded, and every one of them would otherwise
 * become a product named "N/A" or a barcode of "-". Note what is NOT here:
 * "0", "none", "nil". A zero may be a real production capacity, and guessing
 * about words this list does not contain is how a real value disappears.
 */
const BLANK_MARKERS = new Set(['', '-', '--', '---', 'n/a', 'na', 'n.a.', 'n/a.', '#n/a', 'null']);

/**
 * A cell's value, or null when the cell says nothing.
 *
 * Whitespace is collapsed rather than only trimmed: the source contains
 * "3 ML  ORAL DISPENSING SYRINGE" with a double space, and left alone that is a
 * different string from the same name typed once, which is enough to turn one
 * product into two.
 */
export function cleanCell(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  // A trailing comma is punctuation somebody left behind - the source has
  // "3E114," as a product code - not part of the value.
  const trimmed = collapsed.replace(/[,;]+$/, '').trim();
  if (BLANK_MARKERS.has(trimmed.toLowerCase())) return null;
  return trimmed === '' ? null : trimmed;
}

/** The comparison form of a value: case-folded and whitespace-collapsed. */
export function normaliseForMatch(value: string | null | undefined): string {
  return (cleanCell(value) ?? '').toLocaleUpperCase('en-GB');
}

/**
 * A barcode reduced to the digits, or null.
 *
 * The source writes the same barcode two ways - "8904379800013" and
 * "(01) 0 8904379800013" - where "(01)" is the GS1 application identifier
 * saying "what follows is a GTIN" and the lone 0 is the fourteenth digit. Both
 * are the same article, so both must reduce to the same fourteen digits, or the
 * catalogue holds it twice.
 *
 * Anything that is not 8, 12, 13 or 14 digits after that is not a GTIN and is
 * left out of the normalised column - the raw text is kept regardless, so
 * nothing is lost and nothing is invented.
 */
export function normaliseGtin(value: string | null | undefined): string | null {
  const raw = cleanCell(value);
  if (raw === null) return null;

  // Strip a leading application identifier before taking the digits, or its
  // "01" would become part of the barcode.
  const digits = raw.replace(/^\(\s*01\s*\)/, '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(digits.length)) return null;

  // GTIN-8, -12 and -13 are the same identifier as a GTIN-14 with leading
  // zeros. Padding makes the two spellings in the source compare equal.
  return digits.padStart(14, '0');
}

/**
 * The fields that decide whether two source rows are the same article.
 *
 * Every one of them is something a buyer can see on the box. Packing type is in
 * the list because the workbook lists the same syringe as a blister pack and as
 * a ribbon pack, with different barcodes and different carton sizes - they are
 * two things to order, not one thing described twice.
 */
export interface VariantIdentity {
  category: string;
  productCode: string | null;
  gtin: string | null;
  genericName: string | null;
  model: string | null;
  brand: string | null;
  packingType: string | null;
}

/**
 * The fields that group rows into one product.
 *
 * Model is deliberately absent: varying the model is exactly what makes a row a
 * variant rather than a separate product, so a 14G and an 18G of one branded
 * cannula become one listing with two sizes instead of two near-identical
 * listings side by side in a grid.
 */
export interface FamilyIdentity {
  category: string;
  genericName: string | null;
  brand: string | null;
  sterilisation: string | null;
  packingType: string | null;
  /** Only used when there is no generic name to group on. */
  productCode: string | null;
}

function fingerprintOf(parts: (string | null)[]): string {
  // A unit separator rather than a printable one: a value containing the
  // delimiter could otherwise shift the fields either side of it and make two
  // different rows hash the same.
  return createHash('sha256').update(parts.map((part) => part ?? '').join('\u001F')).digest('hex');
}

export function variantFingerprint(identity: VariantIdentity): string {
  return fingerprintOf([
    'variant/v1',
    normaliseForMatch(identity.category),
    normaliseForMatch(identity.productCode),
    identity.gtin,
    normaliseForMatch(identity.genericName),
    normaliseForMatch(identity.model),
    normaliseForMatch(identity.brand),
    normaliseForMatch(identity.packingType),
  ]);
}

export function familyFingerprint(identity: FamilyIdentity): string {
  // A row with no generic name has nothing to group on but its own code, so it
  // becomes a family of one rather than joining every other unnamed row.
  const grouping = identity.genericName ?? identity.productCode;
  return fingerprintOf([
    'family/v1',
    normaliseForMatch(identity.category),
    normaliseForMatch(grouping),
    normaliseForMatch(identity.brand),
    normaliseForMatch(identity.sterilisation),
    normaliseForMatch(identity.packingType),
  ]);
}

/**
 * Sterilisation as one of three answers, or null.
 *
 * The column contains "ETO STERILE", "GAMMA STERILE", "Non-Sterile", "Gamma",
 * "Sterile Fluid Path" and, in two rows, an entire product description. A
 * customer filtering the catalogue wants to know whether it is sterile; the
 * method is a specification, kept separately and verbatim.
 *
 * Returns null rather than a guess when the cell is prose - a filter that
 * silently assigns an unreadable row to "Sterile" is worse than one that leaves
 * it out, because a non-sterile item reaching a sterile field is a patient
 * safety problem rather than a catalogue tidiness problem.
 */
export function sterilityOf(value: string | null | undefined): 'STERILE' | 'NON_STERILE' | null {
  const text = normaliseForMatch(value);
  if (text === '') return null;
  // Checked first: "NON-STERILE" contains "STERILE", so the order is the rule.
  if (/\bNON[\s-]?STERIL/.test(text) || /\bUNSTERIL/.test(text)) return 'NON_STERILE';
  if (/\bSTERIL/.test(text) || /\bGAMMA\b/.test(text) || /\bETO\b/.test(text)) return 'STERILE';
  return null;
}

/**
 * Abbreviations that must not be title-cased, and the volume units that read
 * wrong capitalised.
 *
 * Every entry earns its place by appearing in the source: "I.V. Cannula",
 * "ENFit", "ETO STERILE", "1 ML". The list is short and specific rather than
 * clever, because a general rule for "which capitals are an acronym" does not
 * exist and a wrong guess renames a product.
 */
const CASING_FIXES: [RegExp, string][] = [
  [/\bI\.v\.\b/g, 'I.V.'],
  [/\bIv\b/g, 'IV'],
  [/\bEto\b/g, 'ETO'],
  [/\bEnfit\b/g, 'ENFit'],
  [/\bUdi\b/g, 'UDI'],
  [/\bPvc\b/g, 'PVC'],
  [/\bAbg\b/g, 'ABG'],
  [/\bDc\b/g, 'DC'],
  // "3 Ml" and "12.7 Mm" - the amount is fine, the unit is not.
  [/\b(\d+(?:\.\d+)?)\s*Ml\b/g, '$1 ml'],
  [/\b(\d+(?:\.\d+)?)\s*Mm\b/g, '$1 mm'],
  [/\b(\d+(?:\.\d+)?)\s*Cm\b/g, '$1 cm'],
];

/**
 * Title Case for a value written entirely in capitals; left alone otherwise.
 *
 * The source shouts - "DISPOSABLE HYPODERMIC SYRINGE" - and a grid of shouted
 * names is unreadable. Only fully-uppercase values are touched, because a name
 * with any lowercase in it was typed deliberately and "EasyFlow" must not
 * become "Easyflow".
 *
 * This is for names and brands. It is not applied to a model or a gauge, where
 * the capitals mean something: "29G X 12.7MM" is a specification, and title
 * case would make it read like prose.
 */
export function titleCase(value: string): string {
  if (value !== value.toLocaleUpperCase('en-GB')) return value;

  const cased = value
    .toLocaleLowerCase('en-GB')
    .replace(
      /(^|[\s(/.-])([a-z])/g,
      (_match, prefix: string, letter: string) => prefix + letter.toLocaleUpperCase('en-GB'),
    );

  return CASING_FIXES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), cased);
}
