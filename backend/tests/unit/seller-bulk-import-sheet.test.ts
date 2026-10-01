/**
 * Master row 37: the seller bulk import reads CSV and XLSX through the shared
 * parsers (`parseCsv`, `xlsx-reader`), deciding the format from the bytes.
 */
import { describe, expect, it } from 'vitest';
import { readSellerSheet } from '../../src/modules/seller/bulk-import.service.js';

/** A minimal .xlsx: an uncompressed zip of the three parts the reader needs. */
function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

describe('readSellerSheet', () => {
  it('reads a CSV, quoted cells included', () => {
    const sheet = readSellerSheet(Buffer.from('seller_sku,price\r\n"A,1",12.50\r\n', 'utf8'));
    expect(sheet.format).toBe('CSV');
    expect(sheet.rows).toEqual([
      ['seller_sku', 'price'],
      ['A,1', '12.50'],
    ]);
  });

  it('reads the first worksheet of an XLSX, keeping column positions', () => {
    const xml = (rows: string): string =>
      `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`;
    const buffer = storedZip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Listings" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': xml(
        '<row r="1"><c r="A1" t="inlineStr"><is><t>seller_sku</t></is></c><c r="C1" t="inlineStr"><is><t>available_quantity</t></is></c></row>' +
          '<row r="2"><c r="A2" t="inlineStr"><is><t>SKU-9</t></is></c><c r="C2"><v>40</v></c></row>',
      ),
    });
    const sheet = readSellerSheet(buffer);
    expect(sheet.format).toBe('XLSX');
    expect(sheet.rows[0]).toEqual(['seller_sku', '', 'available_quantity']);
    expect(sheet.rows[1]).toEqual(['SKU-9', '', '40']);
  });

  it('refuses binary that is not a spreadsheet', () => {
    expect(() => readSellerSheet(Buffer.from([0x00, 0x01, 0x02, 0x41]))).toThrow(/not a CSV or XLSX/);
  });
});
