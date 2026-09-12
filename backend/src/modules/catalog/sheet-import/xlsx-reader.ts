/**
 * A small, read-only XLSX reader.
 *
 * There is a reason this exists rather than a dependency. `import.service.ts`
 * refuses XLSX uploads on purpose: parsing a spreadsheet handed over by a
 * stranger means trusting a large parser with a hostile zip, and every
 * spreadsheet can export CSV. That reasoning still holds for the upload path
 * and nothing here changes it.
 *
 * This reader serves a different job. An operator loading their own supplier
 * workbook from their own disk, from a command line, is not an untrusted
 * upload - and that workbook is a sheet of merged category bands and repeated
 * headers that does not survive a trip through CSV intact. So: a reader narrow
 * enough to audit in one sitting, which only ever reads, only from a local
 * path, and refuses anything it does not fully understand.
 *
 * What it deliberately does NOT do: formulas (it reads the cached result, which
 * is what the file already contains), styles, charts, images, external links,
 * or any form of evaluation. A cell is text or it is a number.
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

export interface SheetCell {
  /** The cell's value as text. Numbers arrive as the digits Excel stored. */
  value: string;
  /** True when the cell held a number rather than a string. */
  isNumeric: boolean;
}

export interface SheetRow {
  /** 1-based row number, exactly as the spreadsheet shows it. */
  rowNumber: number;
  /** Keyed by column letter - "A", "B", ... - with empty cells absent. */
  cells: Map<string, SheetCell>;
}

export interface Worksheet {
  name: string;
  rows: SheetRow[];
}

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

/**
 * A zip entry we are willing to read.
 *
 * Only the two compression methods a spreadsheet actually uses. Anything else
 * - encrypted, LZMA, a method invented since - is refused rather than guessed
 * at, because a half-decoded XML document produces a catalogue of nonsense
 * rather than an error.
 */
interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** `PK\x05\x06` - the end-of-central-directory signature. */
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;

/**
 * An .xlsx above this is not a product sheet, it is a mistake or an attack.
 * 64 MB of XML is roughly a quarter of a million rows.
 */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** One entry's decompressed size. Stops a zip bomb at the first big member. */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The EOCD is at the end, after a comment of up to 65,535 bytes. Scanning
  // backwards finds it in one read for the overwhelmingly common case of no
  // comment at all.
  const earliest = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('Not a readable .xlsx file: no zip end-of-central-directory record.');
}

function readCentralDirectory(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_FILE_SIGNATURE) {
      throw new Error('Not a readable .xlsx file: corrupt zip central directory.');
    }

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function readEntry(buffer: Buffer, entry: ZipEntry): string {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new Error(`"${entry.name}" in this workbook is implausibly large; refusing to read it.`);
  }

  const header = entry.localHeaderOffset;
  // The local header repeats the name and extra-field lengths, and they can
  // differ from the central directory's. The data starts after whatever this
  // copy says.
  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const body = buffer.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return body.toString('utf8');
  if (entry.method === 8) return inflateRawSync(body).toString('utf8');

  throw new Error(
    `"${entry.name}" uses zip compression method ${String(entry.method)}, which this reader does not ` +
      'understand. Re-save the workbook from Excel or LibreOffice as a plain .xlsx.',
  );
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  amp: '&',
};

/**
 * Unescape XML text.
 *
 * `&amp;` is resolved last, deliberately. Resolving it first would turn the
 * literal text `&amp;lt;` - which is how a spreadsheet stores "&lt;" typed into
 * a cell - into a `<`, and from there into markup that was never in the data.
 */
function unescapeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/** Every `<t>...</t>` run in a fragment, concatenated. */
function textRuns(fragment: string): string {
  let out = '';
  const pattern = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(fragment)) !== null) {
    out += unescapeXml(match[1] ?? '');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------

function parseSharedStrings(xml: string | null): string[] {
  if (xml === null) return [];
  const strings: string[] = [];
  const pattern = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\s*\/>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    strings.push(textRuns(match[1] ?? ''));
  }
  return strings;
}

/** The column letters off a cell reference: "BC12" -> "BC". */
function columnOf(reference: string): string {
  return /^([A-Z]+)/.exec(reference)?.[1] ?? '';
}

function parseSheet(xml: string, sharedStrings: string[], name: string): Worksheet {
  const rows: SheetRow[] = [];

  const rowPattern = /<row\s([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowPattern.exec(xml)) !== null) {
    const attributes = rowMatch[1] ?? '';
    const body = rowMatch[2] ?? '';
    const rowNumber = Number.parseInt(/\br="(\d+)"/.exec(attributes)?.[1] ?? '', 10);
    if (!Number.isFinite(rowNumber)) continue;

    const cells = new Map<string, SheetCell>();
    const cellPattern = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;

    while ((cellMatch = cellPattern.exec(body)) !== null) {
      const cellAttributes = cellMatch[1] ?? '';
      const cellBody = cellMatch[2] ?? '';
      const reference = /\br="([A-Z]+\d+)"/.exec(cellAttributes)?.[1];
      if (reference === undefined) continue;

      const type = /\bt="([^"]+)"/.exec(cellAttributes)?.[1] ?? 'n';
      let value: string;
      let isNumeric = false;

      if (type === 'inlineStr') {
        value = textRuns(cellBody);
      } else if (type === 's') {
        const index = Number.parseInt(/<v>([\s\S]*?)<\/v>/.exec(cellBody)?.[1] ?? '', 10);
        value = Number.isFinite(index) ? (sharedStrings[index] ?? '') : '';
      } else {
        // `n` (number), `str` (a formula's cached string result), `b`, `e`.
        // The cached result is the right thing to read: this reader evaluates
        // nothing, and the file already contains what the formula produced.
        value = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(cellBody)?.[1] ?? '');
        isNumeric = type === 'n' && value !== '';
      }

      if (value !== '') cells.set(columnOf(reference), { value, isNumeric });
    }

    rows.push({ rowNumber, cells });
  }

  return { name, rows };
}

/**
 * Read every worksheet in a workbook, in the order the workbook lists them.
 *
 * Sheet order matters: the sheet a person means by "the first tab" is the first
 * one in `workbook.xml`, which is not necessarily `sheet1.xml` on disk.
 */
export function readWorkbook(filePath: string): Worksheet[] {
  const buffer = readFileSync(filePath);
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error(
      `${filePath} is ${String(Math.round(buffer.length / 1024 / 1024))} MB. A product sheet is not ` +
        'that big; check the path.',
    );
  }

  const entries = readCentralDirectory(buffer);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));

  const read = (name: string): string | null => {
    const entry = byName.get(name);
    return entry === undefined ? null : readEntry(buffer, entry);
  };

  const workbookXml = read('xl/workbook.xml');
  if (workbookXml === null) {
    throw new Error(`${filePath} is not an .xlsx workbook (no xl/workbook.xml inside it).`);
  }

  const relsXml = read('xl/_rels/workbook.xml.rels') ?? '';
  const relationships = new Map<string, string>();
  const relPattern = /<Relationship\s([^>]*?)\/>/g;
  let relMatch: RegExpExecArray | null;
  while ((relMatch = relPattern.exec(relsXml)) !== null) {
    const attributes = relMatch[1] ?? '';
    const id = /\bId="([^"]+)"/.exec(attributes)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(attributes)?.[1];
    if (id !== undefined && target !== undefined) {
      relationships.set(id, target.replace(/^\/?xl\//, '').replace(/^\.\//, ''));
    }
  }

  const sharedStrings = parseSharedStrings(read('xl/sharedStrings.xml'));

  const sheets: Worksheet[] = [];
  const sheetPattern = /<sheet\s([^>]*?)\/>/g;
  let sheetMatch: RegExpExecArray | null;
  let fallbackIndex = 0;

  while ((sheetMatch = sheetPattern.exec(workbookXml)) !== null) {
    const attributes = sheetMatch[1] ?? '';
    fallbackIndex += 1;
    const name = unescapeXml(/\bname="([^"]*)"/.exec(attributes)?.[1] ?? `Sheet${String(fallbackIndex)}`);
    const relationshipId = /\br:id="([^"]+)"/.exec(attributes)?.[1];

    // A workbook whose relationship is missing still has its sheet on disk in
    // the conventional place; falling back beats refusing the whole file.
    const target = (relationshipId === undefined ? undefined : relationships.get(relationshipId)) ??
      `worksheets/sheet${String(fallbackIndex)}.xml`;

    const sheetXml = read(`xl/${target}`);
    if (sheetXml === null) continue;

    sheets.push(parseSheet(sheetXml, sharedStrings, name));
  }

  if (sheets.length === 0) {
    throw new Error(`${filePath} contains no readable worksheets.`);
  }

  return sheets;
}

/**
 * Excel's serial day number as a calendar date, or null.
 *
 * Day 1 is 1900-01-01 and the epoch is therefore 1899-12-30, not 12-31: Lotus
 * 1-2-3 believed 1900 was a leap year, Excel copied the bug for compatibility,
 * and every serial after 1900-02-28 is shifted by the day that never existed.
 * Subtracting one more day from the epoch is how that is absorbed, and it is
 * why serials below 61 are refused rather than converted - in that range the
 * two calendars genuinely disagree and no answer is right.
 *
 * The result is midnight UTC. A launch date is a date, not an instant, and
 * giving it a local time would move it across a midnight for half the world.
 */
export function excelSerialToDate(serial: number): Date | null {
  if (!Number.isFinite(serial) || serial < 61 || serial > 2958465) return null;
  const days = Math.floor(serial);
  return new Date(Date.UTC(1899, 11, 30) + days * 86400000);
}
