/**
 * Reading a supplier product sheet as a catalogue.
 *
 * The layout is not a table. It is 22 tables stacked in one sheet: a category
 * name on its own row, the same twenty-column header repeated underneath it,
 * then that category's products, then a blank row, then the next category. A
 * reader that assumes one header at the top produces 22 products called "Name"
 * and loses the category of every real row.
 *
 * So this module classifies every row before it maps any of them, and it
 * refuses to guess. A row that is not confidently a category, a header, a date
 * stamp or a product is recorded as skipped with the reason, and appears in the
 * report - never silently dropped, and never turned into a product on the
 * grounds that it had some text in it.
 */
import { excelSerialToDate, type SheetRow, type Worksheet } from './xlsx-reader.js';
import { parseDimension, type ParsedDimension } from './dimension-parser.js';
import { parsePacking, type ParsedPacking } from './packing-parser.js';
import {
  cleanCell,
  familyFingerprint,
  normaliseForMatch,
  normaliseGtin,
  sterilityOf,
  titleCase,
  variantFingerprint,
} from './sheet-values.js';

/**
 * The column contract, by spreadsheet letter.
 *
 * Letters rather than header text, because the header text is repeated 22 times
 * with inconsistent spelling ("Apply  For Manufacturing License" has two
 * spaces) and matching on it would make the importer fragile in exactly the way
 * a hand-kept sheet punishes. The letters are stable; if a future revision
 * moves a column, this constant is the one place that changes.
 */
export const COLUMNS = {
  productCode: 'A',
  subitems: 'B',
  gtin: 'C',
  genericName: 'D',
  model: 'E',
  sterilisation: 'F',
  brand: 'G',
  packingType: 'H',
  stickerArtworkSize: 'I',
  primaryPackSize: 'J',
  innerBoxSize: 'K',
  outerCartonSize: 'L',
  /**
   * MRP. Named so the mapping is complete and readable, and then deliberately
   * never read. A maximum retail price is a consumer-facing figure from a
   * different market and a different regulation; it is not this deployment's
   * selling price, and importing it as one would put a number in front of a
   * buyer that nobody in the business agreed to charge.
   */
  maximumRetailPrice: 'M',
  packingQuantity: 'N',
  productionCapacity: 'O',
  launchDate: 'P',
  manufacturingLicence: 'Q',
  testLicence: 'R',
  shelfLife: 'S',
  internalStatus: 'T',
} as const;

/** Header labels used to recognise a repeated header row. */
const HEADER_MARKERS: [string, string][] = [
  ['A', 'NAME'],
  ['B', 'SUBITEMS'],
  ['D', 'GENERIC NAME +MODEL'],
  ['M', 'MRP'],
  ['T', 'STATUS'],
];

/** How many of those must match. Three of five survives a retyped header. */
const HEADER_MATCH_THRESHOLD = 3;

/** A product row needs this many populated cells. Fewer is a stray note. */
const MIN_PRODUCT_CELLS = 3;

export type RowKind = 'TITLE' | 'CATEGORY' | 'HEADER' | 'DATE_STAMP' | 'BLANK' | 'PRODUCT' | 'SKIPPED';

export interface SkippedRow {
  rowNumber: number;
  reason: string;
  /** What was in the row, so the report can show it without a second read. */
  preview: string;
}

/** One source row, read and understood, before anything is written. */
export interface SheetRecord {
  sourceRow: number;
  category: string;

  /** Identity, normalised. */
  productCode: string | null;
  gtinRaw: string | null;
  gtinNormalised: string | null;
  genericName: string | null;
  model: string | null;
  sterilisation: string | null;
  brand: string | null;
  packingType: string | null;
  shelfLife: string | null;

  /** Sterile / non-sterile, as a filterable answer. Null when unreadable. */
  sterility: 'STERILE' | 'NON_STERILE' | null;

  packing: ParsedPacking;
  dimensions: {
    primaryPack: ParsedDimension;
    innerBox: ParsedDimension;
    outerCarton: ParsedDimension;
    stickerArtwork: ParsedDimension;
  };

  /** Operator-internal. */
  productionCapacityPerMonth: string | null;
  launchDate: Date | null;
  manufacturingLicenceStatus: string | null;
  testLicenceStatus: string | null;
  internalStatus: string | null;

  /** Identity keys. */
  variantFingerprint: string;
  familyFingerprint: string;

  /** The whole row as read, keyed by column letter. */
  raw: Record<string, string>;

  /** The display name this row contributes to its product. */
  displayName: string;
}

export interface MappedSheet {
  sheetName: string;
  categories: string[];
  records: SheetRecord[];
  skipped: SkippedRow[];
  /** Rows that looked like products but carried no usable identifier. */
  withoutIdentifier: SkippedRow[];
}

function cellText(row: SheetRow, column: string): string | null {
  return cleanCell(row.cells.get(column)?.value);
}

function isHeaderRow(row: SheetRow): boolean {
  let matched = 0;
  for (const [column, expected] of HEADER_MARKERS) {
    if (normaliseForMatch(row.cells.get(column)?.value) === expected) matched += 1;
  }
  return matched >= HEADER_MATCH_THRESHOLD;
}

function populatedColumns(row: SheetRow): string[] {
  return [...row.cells.keys()].filter((column) => cellText(row, column) !== null);
}

function previewOf(row: SheetRow): string {
  return populatedColumns(row)
    .slice(0, 4)
    .map((column) => `${column}=${cellText(row, column) ?? ''}`)
    .join(' | ')
    .slice(0, 200);
}

/**
 * A launch date from a cell that may hold either an Excel serial or text.
 *
 * The workbook holds both: product rows carry the serial 46241, and the stray
 * row under each category carries the text "2026-08-07". Returning null for
 * anything else is deliberate - a launch date nobody can read is better absent
 * than approximated, because it is read as a commitment.
 */
function launchDateFrom(row: SheetRow): Date | null {
  const cell = row.cells.get(COLUMNS.launchDate);
  if (cell === undefined) return null;

  if (cell.isNumeric) {
    const serial = Number.parseFloat(cell.value);
    return excelSerialToDate(serial);
  }

  const text = cleanCell(cell.value);
  if (text === null) return null;

  // ISO only. A sheet written by people who use both "07/08/2026" and
  // "08/07/2026" cannot be read either way without knowing which, and getting
  // it wrong moves a launch by five months.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A short, factual product name from the fields that describe the article.
 *
 * Assembled rather than taken from one column because no single column holds a
 * usable name: column D is a description, column A is a code, and the model is
 * separate. Nothing is added that the sheet does not say - no claim, no
 * indication, no "high quality".
 */
function displayNameFor(parts: {
  genericName: string | null;
  model: string | null;
  brand: string | null;
  productCode: string | null;
}): string {
  const base = parts.genericName === null ? null : titleCase(parts.genericName);
  const name = base ?? (parts.brand === null ? null : titleCase(parts.brand)) ?? parts.productCode ?? 'Unnamed product';

  // The model is appended only when the name does not already carry it - the
  // source writes "ENFit Enteral Syringe 1ml" in column D and "1ml" again in
  // column E, and "ENFit Enteral Syringe 1ml 1ml" is how that reads if nobody
  // checks.
  if (parts.model !== null && !normaliseForMatch(name).includes(normaliseForMatch(parts.model))) {
    return `${name} ${parts.model}`;
  }
  return name;
}

/**
 * Read a worksheet into records, categories and a list of what was skipped.
 *
 * The shape of the loop is the contract: a category is only a category when a
 * header follows it, and a product row is only a product when a category and a
 * header have both been seen above it. A file whose first rows are not laid out
 * that way yields no products and says so, rather than importing the header.
 */
export function mapWorksheet(sheet: Worksheet): MappedSheet {
  const byNumber = new Map(sheet.rows.map((row) => [row.rowNumber, row]));
  const lastRow = sheet.rows.reduce((highest, row) => Math.max(highest, row.rowNumber), 0);

  const categories: string[] = [];
  const records: SheetRecord[] = [];
  const skipped: SkippedRow[] = [];
  const withoutIdentifier: SkippedRow[] = [];

  let category: string | null = null;
  let headerSeenForCategory = false;

  /** The next row below `from` that has anything in it at all. */
  const nextPopulated = (from: number): SheetRow | null => {
    for (let index = from + 1; index <= lastRow; index += 1) {
      const candidate = byNumber.get(index);
      if (candidate !== undefined && populatedColumns(candidate).length > 0) return candidate;
    }
    return null;
  };

  for (let rowNumber = 1; rowNumber <= lastRow; rowNumber += 1) {
    const row = byNumber.get(rowNumber);
    if (row === undefined) continue;

    const filled = populatedColumns(row);
    if (filled.length === 0) continue;

    if (isHeaderRow(row)) {
      headerSeenForCategory = true;
      continue;
    }

    // A lone value in column A is either a category band or the document's own
    // title. What tells them apart is what comes next: a category is followed
    // by the header its products sit under; a title is followed by a category.
    if (filled.length === 1 && filled[0] === COLUMNS.productCode) {
      const following = nextPopulated(rowNumber);
      if (following !== null && isHeaderRow(following)) {
        category = cellText(row, COLUMNS.productCode);
        headerSeenForCategory = false;
        if (category !== null && !categories.includes(category)) categories.push(category);
      }
      continue;
    }

    // A lone date under a category band - a revision stamp, not a product.
    if (filled.length === 1 && filled[0] === COLUMNS.launchDate) continue;

    if (category === null || !headerSeenForCategory) {
      skipped.push({
        rowNumber,
        reason: 'Appears above the first category heading and header row.',
        preview: previewOf(row),
      });
      continue;
    }

    if (filled.length < MIN_PRODUCT_CELLS) {
      skipped.push({
        rowNumber,
        reason: `Only ${String(filled.length)} of the twenty columns are filled in; too little to be a product.`,
        preview: previewOf(row),
      });
      continue;
    }

    const productCode = cellText(row, COLUMNS.productCode);
    const gtinRaw = cellText(row, COLUMNS.gtin);
    const genericName = cellText(row, COLUMNS.genericName);
    const model = cellText(row, COLUMNS.model);
    const brand = cellText(row, COLUMNS.brand);

    // Six rows in the source workbook carry "N/A" as their product code, which
    // `cleanCell` reduces to nothing. They are still real products with a
    // barcode and a name, so the test is "is there anything at all to identify
    // this by", not "is there a code".
    if (productCode === null && gtinRaw === null && genericName === null) {
      withoutIdentifier.push({
        rowNumber,
        reason: 'No product code, barcode or name - nothing to identify it by.',
        preview: previewOf(row),
      });
      continue;
    }

    const sterilisation = cellText(row, COLUMNS.sterilisation);
    const packingType = cellText(row, COLUMNS.packingType);

    const raw: Record<string, string> = {};
    for (const column of filled) {
      raw[column] = cellText(row, column) ?? '';
    }

    const identity = {
      category,
      productCode,
      gtin: normaliseGtin(gtinRaw),
      genericName,
      model,
      brand,
      packingType,
    };

    records.push({
      sourceRow: rowNumber,
      category,
      productCode,
      gtinRaw,
      gtinNormalised: identity.gtin,
      genericName,
      model,
      sterilisation,
      brand,
      packingType,
      shelfLife: cellText(row, COLUMNS.shelfLife),
      sterility: sterilityOf(sterilisation),
      packing: parsePacking(cellText(row, COLUMNS.packingQuantity)),
      dimensions: {
        primaryPack: parseDimension(cellText(row, COLUMNS.primaryPackSize)),
        innerBox: parseDimension(cellText(row, COLUMNS.innerBoxSize)),
        outerCarton: parseDimension(cellText(row, COLUMNS.outerCartonSize)),
        stickerArtwork: parseDimension(cellText(row, COLUMNS.stickerArtworkSize)),
      },
      productionCapacityPerMonth: cellText(row, COLUMNS.productionCapacity),
      launchDate: launchDateFrom(row),
      manufacturingLicenceStatus: cellText(row, COLUMNS.manufacturingLicence),
      testLicenceStatus: cellText(row, COLUMNS.testLicence),
      internalStatus: cellText(row, COLUMNS.internalStatus),
      variantFingerprint: variantFingerprint(identity),
      familyFingerprint: familyFingerprint({
        category,
        genericName,
        brand,
        sterilisation,
        packingType,
        productCode,
      }),
      raw,
      displayName: displayNameFor({ genericName, model, brand, productCode }),
    });
  }

  return { sheetName: sheet.name, categories, records, skipped, withoutIdentifier };
}
