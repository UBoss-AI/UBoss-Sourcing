import { describe, expect, it } from 'vitest';
import { readRows } from '../../src/modules/cart/upload.service.js';

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

describe('SKU list upload reads Excel (ENH-016)', () => {
  it('reads the first worksheet of an .xlsx into rows', () => {
    const buffer = storedZip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Order" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml':
        '<?xml version="1.0"?><worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="inlineStr"><is><t>sku</t></is></c><c r="B1" t="inlineStr"><is><t>quantity</t></is></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>SKU-9</t></is></c><c r="B2"><v>40</v></c></row>' +
        '</sheetData></worksheet>',
    });
    expect(readRows('order.XLSX', buffer)).toEqual([['sku', 'quantity'], ['SKU-9', '40']]);
  });
  it('refuses another extension and a file over 1 MB', () => {
    expect(() => readRows('order.txt', Buffer.from('a,b'))).toThrow();
    expect(() => readRows('order.csv', Buffer.alloc(1_000_001))).toThrow();
  });
});
