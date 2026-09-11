/**
 * The mapping engine, and the money that goes through it.
 *
 * Two groups of tests here, and the second is the one that matters most.
 *
 * The first checks the mechanics: paths that reach into somebody's JSON, paths
 * that build a body for them, validation that catches a mapping before it is
 * saved, and the sample check that catches one only a real response can catch.
 *
 * The second checks that money crossing this boundary is never a float. A
 * purchase order raised for one minor unit less than the invoice is a dispute
 * nobody can explain, and `12.34 * 100` is 1233.9999999999998 - so the
 * conversions are string arithmetic and these tests are what keeps them that
 * way.
 */
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_FIELDS,
  applyInbound,
  applyOutbound,
  applyTransform,
  assertMappingValid,
  decimalToMinor,
  extractRecords,
  minorToDecimal,
  missingRequiredFields,
  readPath,
  statusFromErp,
  statusToErp,
  verifyAgainstSample,
  writePath,
  type MappingRow,
} from '../../src/modules/customer-erp/mapping.service.js';

function row(overrides: Partial<MappingRow>): MappingRow {
  return {
    entity: 'ORDER',
    platformField: 'orderNumber',
    erpPath: 'reference',
    constantValue: null,
    erpValue: null,
    transform: null,
    required: false,
    ...overrides,
  };
}

describe('reading a path', () => {
  it('follows dots and array indices', () => {
    const source = { Items: [{ Material: 'ABC-1' }, { Material: 'ABC-2' }] };

    expect(readPath(source, 'Items.0.Material')).toBe('ABC-1');
    // Both spellings, because both turn up in the documentation buyers copy
    // from and neither is more correct than the other.
    expect(readPath(source, 'Items[1].Material')).toBe('ABC-2');
  });

  it('distinguishes "not there" from "explicitly null"', () => {
    // A real distinction: null is the ERP telling us it has no value, and
    // undefined is the mapping pointing somewhere that does not exist. The
    // sample check reports the second and not the first.
    expect(readPath({ a: null }, 'a')).toBeNull();
    expect(readPath({ a: null }, 'b')).toBeUndefined();
    expect(readPath({ a: { b: 1 } }, 'a.c.d')).toBeUndefined();
  });
});

describe('writing a path', () => {
  it('creates arrays for numeric segments and objects for the rest', () => {
    const target: Record<string, unknown> = {};
    writePath(target, 'Items.0.Material', 'ABC-1');

    // `{Items:[{...}]}`, not `{Items:{"0":{...}}}` - a distinction SAP cares
    // about a great deal.
    expect(Array.isArray(target['Items'])).toBe(true);
    expect(target).toEqual({ Items: [{ Material: 'ABC-1' }] });
  });

  it('fills several leaves under one parent', () => {
    const target: Record<string, unknown> = {};
    writePath(target, 'header.company', '1000');
    writePath(target, 'header.currency', 'EUR');

    expect(target).toEqual({ header: { company: '1000', currency: 'EUR' } });
  });
});

describe('money', () => {
  it('converts minor units to a decimal by string arithmetic', () => {
    expect(minorToDecimal('1234')).toBe('12.34');
    expect(minorToDecimal('5')).toBe('0.05');
    expect(minorToDecimal('0')).toBe('0.00');
    expect(minorToDecimal('-1234')).toBe('-12.34');
    // Zero-exponent currencies. A JPY total rendered as "12000.00" is off by a
    // factor of a hundred, and the ERP would accept it without complaint.
    expect(minorToDecimal('12000', 0)).toBe('12000');
  });

  it('survives totals a float would not', () => {
    // Above 2^53. A `Number` round trip loses the last digits silently, and
    // for a currency with no minor units this is a real total rather than a
    // theoretical one.
    const huge = '9007199254740993456';
    expect(minorToDecimal(huge)).toBe('90071992547409934.56');
    expect(decimalToMinor(minorToDecimal(huge))).toBe(huge);
  });

  it('converts a decimal back to minor units without touching a float', () => {
    expect(decimalToMinor('12.34')).toBe('1234');
    // The case that makes this a string routine: `12.34 * 100` is
    // 1233.9999999999998, and `Math.round` of it happens to be right - until
    // the value is one a rounding does not rescue.
    expect(decimalToMinor('0.07')).toBe('7');
    expect(decimalToMinor('1.005')).toBe('100');
    expect(decimalToMinor('-12.34')).toBe('-1234');
    expect(decimalToMinor('12')).toBe('1200');
  });

  it('round-trips', () => {
    for (const minor of ['0', '1', '99', '100', '123456789012345678']) {
      expect(decimalToMinor(minorToDecimal(minor))).toBe(minor);
    }
  });
});

describe('transforms', () => {
  it('applies only the named ones', () => {
    expect(applyTransform('  x  ', 'TRIM')).toBe('x');
    expect(applyTransform('eur', 'UPPERCASE')).toBe('EUR');
    expect(applyTransform('EUR', 'LOWERCASE')).toBe('eur');
    expect(applyTransform('1234', 'MINOR_TO_DECIMAL')).toBe('12.34');
    expect(applyTransform('12.34', 'DECIMAL_TO_MINOR')).toBe('1234');
    expect(applyTransform('2026-09-11T10:00:00.000Z', 'DATE_ONLY')).toBe('2026-09-11');
  });

  it('leaves a value alone when there is no transform', () => {
    expect(applyTransform('x', null)).toBe('x');
    expect(applyTransform(null, 'UPPERCASE')).toBeNull();
  });

  it('never produces "[object Object]"', () => {
    // A mapping pointing at a nested structure rather than a leaf is a mapping
    // error. Rendering it as JSON makes that visible; coercing it produces a
    // value that looks like data, passes every validation the ERP has, and is
    // discovered months later as somebody's material number.
    const result = applyTransform({ nested: true }, 'TRIM');
    expect(String(result)).not.toContain('[object Object]');
    expect(String(result)).toContain('nested');
  });
});

/**
 * The field-level messages behind a validation failure.
 *
 * `assertMappingValid` throws one error carrying a `details` array, because
 * that is what lets a form highlight the row that is wrong rather than showing
 * a banner. The summary message is deliberately generic; the useful text is in
 * the details, so that is what these assertions read.
 */
function detailMessages(build: () => void): string[] {
  try {
    build();
  } catch (error) {
    const details = (error as { details?: { message?: string }[] }).details ?? [];
    return details.map((detail) => detail.message ?? '');
  }

  throw new Error('expected the mapping to be refused, and it was not');
}

describe('validation', () => {
  it('refuses a field this platform does not have', () => {
    const messages = detailMessages(() =>
      assertMappingValid([row({ platformField: 'inventedField' })]),
    );

    expect(messages.join(' ')).toContain('inventedField');
  });

  it('refuses the same field twice', () => {
    const messages = detailMessages(() =>
      assertMappingValid([row({}), row({ erpPath: 'somethingElse' })]),
    );

    expect(messages.join(' ')).toMatch(/more than once/i);
  });

  it('allows one platform status to have several ERP spellings', () => {
    // Some ERPs distinguish "goods issued" from "delivered" and both mean the
    // same thing here, so a STATUS row is keyed by (our status, their word).
    expect(() =>
      assertMappingValid([
        row({ entity: 'STATUS', platformField: 'DELIVERED', erpPath: '', erpValue: 'Goods Issued' }),
        row({ entity: 'STATUS', platformField: 'DELIVERED', erpPath: '', erpValue: 'Delivered' }),
      ]),
    ).not.toThrow();
  });

  it('refuses a row that names neither a field nor a fixed value', () => {
    const messages = detailMessages(() => assertMappingValid([row({ erpPath: '' })]));
    expect(messages.join(' ')).toMatch(/fixed value/i);
  });

  it('refuses a path that is not a path', () => {
    // Not injection prevention on its own - `readPath` and `writePath` only
    // ever walk object keys - but a path with spaces and punctuation in it is a
    // buyer having pasted something that is not a field name, and telling them
    // so now is better than an empty purchase order later.
    const messages = detailMessages(() =>
      assertMappingValid([row({ erpPath: 'a b; DROP TABLE' })]),
    );

    expect(messages.join(' ')).toMatch(/dot/i);
  });

  it('reports which required fields are unmapped, in words', () => {
    const missing = missingRequiredFields([], ['ORDER']);

    // Labels rather than keys: the answer is shown to a person.
    expect(missing).toContain('Our order number');
    expect(missing).toContain('Line: quantity');
  });

  it('asks only about the entities in play', () => {
    // A buyer who has switched invoices off is not held to the invoice mapping.
    expect(missingRequiredFields([], ['INVOICE'])).toContain('Invoice number');
    expect(missingRequiredFields([], ['ORDER'])).not.toContain('Invoice number');
  });
});

describe('applying a mapping outbound', () => {
  it('builds the ERP shape and reports what was missing', () => {
    const rows: MappingRow[] = [
      row({ platformField: 'orderNumber', erpPath: 'header.reference', required: true }),
      row({ platformField: 'currency', erpPath: 'header.currency', transform: 'UPPERCASE' }),
      row({ platformField: 'grossAmount', erpPath: 'header.total', transform: 'MINOR_TO_DECIMAL' }),
      row({ platformField: 'vendorId', erpPath: 'header.vendor', required: true }),
      row({ platformField: 'lineSku', erpPath: 'lines.0.sku', constantValue: 'FIXED' }),
    ];

    const { body, missing } = applyOutbound(rows, 'ORDER', {
      orderNumber: 'UB-2026-000123',
      currency: 'eur',
      grossAmount: '1420000',
      vendorId: null,
    });

    expect(body).toEqual({
      header: { reference: 'UB-2026-000123', currency: 'EUR', total: '14200.00' },
      lines: [{ sku: 'FIXED' }],
    });

    // Reported rather than silently omitted: an ERP receiving a line with no
    // quantity will either reject it or, worse, accept it as zero.
    expect(missing).toEqual(['Vendor / supplier ID']);
  });

  /**
   * Required is a property of a DOCUMENT, not of the entity across every
   * document written through it.
   *
   * One entity serves several documents. The INVENTORY mapping shapes both a
   * stock figure read back from an ERP - which is nothing without a SKU - and
   * the header of a goods receipt, which is a statement about an order and has
   * no single SKU at all, its materials being one per line. Holding the second
   * to the first refused every goods receipt this platform tried to post, with
   * a message telling the buyer to fix a mapping that was already correct.
   */
  it('holds a document only to the fields it carries', () => {
    const rows: MappingRow[] = [
      row({ entity: 'INVENTORY', platformField: 'sku', erpPath: 'material', required: true }),
      row({ entity: 'INVENTORY', platformField: 'receiptQuantity', erpPath: 'quantity' }),
    ];

    // A goods receipt header. It has a quantity and no SKU, and does not claim
    // to have one.
    const receipt = applyOutbound(rows, 'INVENTORY', { receiptQuantity: 3 });

    expect(receipt.body).toEqual({ quantity: 3 });
    expect(receipt.missing).toEqual([]);

    // A stock record, which does claim to carry a SKU - and has not got one.
    const stock = applyOutbound(rows, 'INVENTORY', { sku: null, receiptQuantity: 3 });

    expect(stock.missing).toEqual(['SKU / material number']);
  });
});

describe('applying a mapping inbound', () => {
  it('reads the ERP shape into ours', () => {
    const rows: MappingRow[] = [
      row({ entity: 'INVENTORY', platformField: 'sku', erpPath: 'Material', transform: 'TRIM' }),
      row({ entity: 'INVENTORY', platformField: 'onHandQty', erpPath: 'Qty' }),
    ];

    expect(applyInbound(rows, 'INVENTORY', { Material: ' ABC-1 ', Qty: 42 })).toEqual({
      sku: 'ABC-1',
      onHandQty: 42,
    });
  });
});

describe('status vocabulary', () => {
  const rows: MappingRow[] = [
    row({ entity: 'STATUS', platformField: 'SHIPPED', erpPath: '', erpValue: 'Goods Issued' }),
  ];

  it('translates both ways from one set of rows', () => {
    expect(statusToErp(rows, 'SHIPPED')).toBe('Goods Issued');
    expect(statusFromErp(rows, 'goods issued')).toBe('SHIPPED');
    expect(statusFromErp(rows, 'something else')).toBeNull();
  });
});

describe('checking a mapping against a real record', () => {
  it('reports every mapped field, found or not', () => {
    const rows: MappingRow[] = [
      row({ entity: 'INVENTORY', platformField: 'sku', erpPath: 'Material', required: true }),
      row({ entity: 'INVENTORY', platformField: 'plant', erpPath: 'Werks' }),
    ];

    const result = verifyAgainstSample(rows, 'INVENTORY', { Material: 'ABC-1' });

    expect(result.ok).toBe(true);
    expect(result.fields).toHaveLength(2);
    expect(result.fields.find((f) => f.platformField === 'sku')?.found).toBe(true);
    // Optional fields are reported too. A buyer looking at this list is
    // checking their own work, and "not found" beside an optional field is
    // exactly what they spot immediately and we never could.
    expect(result.fields.find((f) => f.platformField === 'plant')?.found).toBe(false);
  });

  it('fails when a required field is not there', () => {
    const rows: MappingRow[] = [
      row({ entity: 'INVENTORY', platformField: 'sku', erpPath: 'Material_No', required: true }),
    ];

    // A well-formed path that finds nothing, which is the whole reason
    // activation needs a real response rather than a structural check.
    const result = verifyAgainstSample(rows, 'INVENTORY', { Material: 'ABC-1' });

    expect(result.ok).toBe(false);
    expect(result.missing).toContain('SKU / material number');
  });

  it('never returns a whole nested object as a sample value', () => {
    const rows: MappingRow[] = [row({ entity: 'INVENTORY', platformField: 'sku', erpPath: 'blob' })];

    const result = verifyAgainstSample(rows, 'INVENTORY', {
      blob: { long: 'x'.repeat(5000) },
    });

    expect((result.fields[0]?.sample ?? '').length).toBeLessThanOrEqual(120);
  });
});

describe('finding the records in a response', () => {
  it('uses the configured path', () => {
    expect(extractRecords({ d: { results: [1, 2] } }, 'd.results')).toEqual([1, 2]);
  });

  it('finds the array without being told, for the shapes everybody uses', () => {
    expect(extractRecords([1, 2], null)).toEqual([1, 2]);
    expect(extractRecords({ value: [1] }, null)).toEqual([1]);
    expect(extractRecords({ data: [1] }, null)).toEqual([1]);
    expect(extractRecords({ items: [1] }, null)).toEqual([1]);
  });

  it('refuses a body with no records rather than guessing', () => {
    expect(() => extractRecords({ ok: true }, null)).toThrow(/list of records/i);
    expect(() => extractRecords({ d: { results: [] } }, 'nowhere')).toThrow(/no list/i);
  });
});

describe('the published field list', () => {
  it('has no duplicate keys inside an entity', () => {
    for (const [entity, specs] of Object.entries(PLATFORM_FIELDS)) {
      const keys = specs.map((spec) => spec.key);
      expect(new Set(keys).size, `${entity} has a duplicate key`).toBe(keys.length);
    }
  });

  it('gives every field a label somebody could read', () => {
    for (const specs of Object.values(PLATFORM_FIELDS)) {
      for (const spec of specs) {
        expect(spec.label.length).toBeGreaterThan(2);
      }
    }
  });
});
