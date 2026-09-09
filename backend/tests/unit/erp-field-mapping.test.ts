/**
 * The field mapping: reading somebody else's JSON without trusting it.
 *
 * This module is what makes one code path serve two customers whose ERPs have
 * nothing in common, so the tests are built around two real, incompatible
 * response shapes - an SAP-flavoured envelope and a flat REST array - and prove
 * that the same functions read both with nothing but configuration between
 * them.
 *
 * Beyond that, three properties that are not about convenience:
 *
 *   **A mapping is customer input.** `readPath` must not be a route to
 *   `Object.prototype`, so `__proto__` and friends are refused rather than
 *   walked.
 *
 *   **A missing quantity is not zero.** "The ERP said nothing" and "the ERP
 *   said none left" are different facts, and collapsing the first into the
 *   second empties a warehouse on the strength of a renamed field.
 *
 *   **Money never touches a float.** `"12.34"` becomes `1234n` by string
 *   arithmetic, because `12.34 * 100` is 1233.9999999999998 and a customer
 *   would be billed accordingly.
 */
import { describe, expect, it } from 'vitest';
import {
  type FieldMapping,
  assertMappingValid,
  coerceCurrency,
  coerceMoneyMinor,
  coerceQuantity,
  coerceString,
  extractRecords,
  parseFieldMapping,
  readPath,
  validateFieldMapping,
  verifyAgainstSample,
} from '../../src/modules/integrations/erp-field-mapping.js';

// ---------------------------------------------------------------------------
// Two customers, two ERPs, one code path
// ---------------------------------------------------------------------------

/** A wrapped envelope with German column names and stringly-typed numbers. */
const SAP_STYLE = {
  d: {
    results: [
      { Material: 'GLV-M', Werks: '1000', LabSt: '42.000', Meins: 'EA', Preis: '12.34', Waers: 'EUR' },
      { Material: 'SYR-10', Werks: '1000', LabSt: '7', Meins: 'BOX' },
    ],
  },
};

/** A flat array with lower-case names and real JSON numbers. */
const REST_STYLE = [
  { sku: 'GLV-M', warehouse: 'MAIN', qty_available: 42, uom: 'EA' },
  { sku: 'SYR-10', warehouse: 'MAIN', qty_available: 7, uom: 'BOX' },
];

const SAP_MAPPING: FieldMapping = {
  itemsPath: 'd.results',
  fields: {
    sku: 'Material',
    warehouseId: 'Werks',
    availableQuantity: 'LabSt',
    unitOfMeasure: 'Meins',
    price: 'Preis',
    currency: 'Waers',
  },
};

const REST_MAPPING: FieldMapping = {
  fields: {
    sku: 'sku',
    warehouseId: 'warehouse',
    availableQuantity: 'qty_available',
    unitOfMeasure: 'uom',
  },
};

describe('one code path, two incompatible ERPs', () => {
  it('finds the records in a wrapped envelope', () => {
    const records = extractRecords(SAP_MAPPING, SAP_STYLE);
    expect(records).toHaveLength(2);
    expect(readPath(records?.[0], 'Material')).toBe('GLV-M');
  });

  it('finds the records in a bare array', () => {
    const records = extractRecords(REST_MAPPING, REST_STYLE);
    expect(records).toHaveLength(2);
    expect(readPath(records?.[0], 'sku')).toBe('GLV-M');
  });

  it('reads the same quantity out of both, despite one being a string', () => {
    const fromSap = coerceQuantity(readPath(SAP_STYLE.d.results[0], 'LabSt'));
    const fromRest = coerceQuantity(readPath(REST_STYLE[0], 'qty_available'));

    expect(fromSap).toBe(42);
    expect(fromRest).toBe(42);
  });

  it('treats a single object as a list of one', () => {
    // An ERP answering a one-SKU query with an object rather than a
    // one-element array is common enough that refusing would be pedantry, and
    // it cannot be ambiguous.
    const records = extractRecords({ fields: {} }, { sku: 'GLV-M', qty: 1 });
    expect(records).toHaveLength(1);
  });

  it('returns null - not empty - when the path names nothing', () => {
    // The distinction the caller acts on: null means "your mapping points at
    // the wrong place", empty means "your ERP had nothing to say today".
    expect(extractRecords({ itemsPath: 'no.such.path', fields: {} }, SAP_STYLE)).toBeNull();
    expect(extractRecords({ itemsPath: 'd.results', fields: {} }, { d: { results: [] } })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reading a path, safely
// ---------------------------------------------------------------------------

describe('readPath', () => {
  it('walks dots and array indices', () => {
    expect(readPath({ a: { b: [{ c: 'found' }] } }, 'a.b.0.c')).toBe('found');
  });

  it('returns undefined for anything absent, rather than throwing', () => {
    expect(readPath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(readPath(null, 'a')).toBeUndefined();
    expect(readPath({ a: [] }, 'a.5')).toBeUndefined();
  });

  it('refuses to walk into the prototype chain', () => {
    // A mapping is customer input. Without this, `__proto__.polluted` in a form
    // field reaches Object.prototype and from there every plain object in the
    // process.
    expect(readPath({}, '__proto__')).toBeUndefined();
    expect(readPath({}, '__proto__.polluted')).toBeUndefined();
    expect(readPath({}, 'constructor.prototype')).toBeUndefined();
  });

  it('returns own properties only, never inherited ones', () => {
    const parent = { inherited: 'should not be readable' };
    const child = Object.create(parent) as Record<string, unknown>;
    child['own'] = 'readable';

    expect(readPath(child, 'own')).toBe('readable');
    expect(readPath(child, 'inherited')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

describe('coerceQuantity', () => {
  it.each([
    [42, 42],
    ['42', 42],
    ['42.000', 42],
    ['  42  ', 42],
    [0, 0],
    ['0', 0],
  ])('reads %s as %s', (input, expected) => {
    expect(coerceQuantity(input)).toBe(expected);
  });

  it.each([
    [null, 'null'],
    [undefined, 'absent'],
    ['', 'an empty string'],
    ['N/A', 'a word'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'infinity'],
    [{}, 'an object'],
  ])('returns null for %s (%s), never zero', (input: unknown, _why: string) => {
    // The load-bearing assertion in this file. A quantity that cannot be read
    // must not become a zero, because a zero empties a warehouse and a null
    // reports a problem.
    expect(coerceQuantity(input)).toBeNull();
  });

  it('refuses a fractional quantity rather than rounding it', () => {
    // This platform counts whole units. Turning 0.4 into 0 - or into 1 - is a
    // decision about somebody's stock that nothing here is entitled to make.
    expect(coerceQuantity('0.4')).toBeNull();
    expect(coerceQuantity(2.5)).toBeNull();
  });
});

describe('coerceMoneyMinor', () => {
  it('converts by string arithmetic, not by multiplying a float', () => {
    // 12.34 * 100 is 1233.9999999999998 in IEEE 754. This is the test that
    // says the implementation does not do that.
    expect(coerceMoneyMinor('12.34', 2)).toBe(1234n);
    expect(coerceMoneyMinor('0.07', 2)).toBe(7n);
    expect(coerceMoneyMinor('1000000000000.01', 2)).toBe(100000000000001n);
  });

  it('honours the currency exponent rather than assuming two', () => {
    expect(coerceMoneyMinor('500', 0)).toBe(500n); // JPY
    expect(coerceMoneyMinor('1.234', 3)).toBe(1234n); // KWD
  });

  it('refuses more decimals than the currency has', () => {
    // Not a rounding problem to solve quietly: it means the mapping points at
    // the wrong field, or the ERP is sending a unit price where a line total
    // was expected.
    expect(coerceMoneyMinor('12.345', 2)).toBeNull();
  });

  it('handles a negative amount without losing the sign', () => {
    expect(coerceMoneyMinor('-12.34', 2)).toBe(-1234n);
  });

  it.each([['abc'], [''], [null], [{}]])('returns null for %s', (input) => {
    expect(coerceMoneyMinor(input, 2)).toBeNull();
  });
});

describe('coerceCurrency and coerceString', () => {
  it('upper-cases a currency and refuses anything that is not three letters', () => {
    expect(coerceCurrency('eur')).toBe('EUR');
    expect(coerceCurrency(' usd ')).toBe('USD');
    expect(coerceCurrency('EURO')).toBeNull();
    expect(coerceCurrency(978)).toBeNull();
  });

  it('accepts an unquoted numeric SKU, which is common and valid', () => {
    expect(coerceString(4471)).toBe('4471');
    expect(coerceString('  MED-4471 ')).toBe('MED-4471');
    expect(coerceString('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validateFieldMapping', () => {
  it('accepts a mapping that has what the enabled features need', () => {
    const result = validateFieldMapping(REST_MAPPING, { inventory: true, order: false });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('requires SKU and quantity before inventory sync can be switched on', () => {
    const result = validateFieldMapping(
      { fields: { sku: 'sku' } },
      { inventory: true, order: false },
    );

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('FIELD_REQUIRED');
    expect(result.issues[0]?.field).toBe('fieldMapping.fields.availableQuantity');
  });

  it('requires nothing about inventory when only order sending is on', () => {
    // The point of per-feature requirements: a customer syncing stock and not
    // pushing orders should not have to map an ERP order id.
    const result = validateFieldMapping(
      { fields: { sku: 'sku', erpOrderId: 'id' } },
      { inventory: false, order: true },
    );

    expect(result.ok).toBe(true);
  });

  it('refuses two fields reading from one path', () => {
    // Nearly always a copy-paste slip, and the consequence - a price read out
    // of the quantity column - is bad enough to refuse rather than warn about.
    const result = validateFieldMapping(
      { fields: { sku: 'code', availableQuantity: 'qty', reservedQuantity: 'qty' } },
      { inventory: true, order: false },
    );

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('PATH_DUPLICATED');
  });

  it('refuses a path that would walk out of the object', () => {
    const result = validateFieldMapping(
      { fields: { sku: '__proto__', availableQuantity: 'qty' } },
      { inventory: true, order: false },
    );

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('PATH_INVALID');
  });

  it('names a field this system does not have', () => {
    const result = validateFieldMapping(
      { fields: { sku: 'sku', availableQuantity: 'qty', invented: 'x' } as FieldMapping['fields'] },
      { inventory: true, order: false },
    );

    expect(result.issues.map((issue) => issue.code)).toContain('UNKNOWN_FIELD');
  });

  it('throws through assertMappingValid on the write path', () => {
    expect(() =>
      assertMappingValid({ fields: {} }, { inventory: true, order: false }),
    ).toThrowError(/mapping is not complete/i);
  });
});

// ---------------------------------------------------------------------------
// Verification against a real response
// ---------------------------------------------------------------------------

describe('verifyAgainstSample', () => {
  it('passes when the mapping describes the document in front of it', () => {
    const result = verifyAgainstSample(SAP_MAPPING, SAP_STYLE, { inventory: true, order: false });

    expect(result.ok).toBe(true);
    // The resolved list is what the screen shows: "SKU -> Material -> GLV-M",
    // so a customer can see at a glance that the price column is reading the
    // quantity.
    expect(result.resolved).toContainEqual({ field: 'sku', path: 'Material', sample: 'GLV-M' });
  });

  it('fails, and says where to look, when the items path is wrong', () => {
    const result = verifyAgainstSample(
      { ...SAP_MAPPING, itemsPath: 'data.items' },
      SAP_STYLE,
      { inventory: true, order: false },
    );

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe('ITEMS_PATH_NOT_A_LIST');
    expect(result.issues[0]?.message).toContain('data.items');
  });

  it('fails when a required field is absent from a real record', () => {
    const result = verifyAgainstSample(
      { itemsPath: 'd.results', fields: { sku: 'Material', availableQuantity: 'Bestand' } },
      SAP_STYLE,
      { inventory: true, order: false },
    );

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('PATH_NOT_FOUND');
  });

  it('reports a type mismatch in words a customer can act on', () => {
    const result = verifyAgainstSample(
      { itemsPath: 'd.results', fields: { sku: 'Material', availableQuantity: 'Meins' } },
      SAP_STYLE,
      { inventory: true, order: false },
    );

    expect(result.ok).toBe(false);
    const issue = result.issues.find((entry) => entry.code === 'TYPE_MISMATCH');
    expect(issue?.message).toContain('whole number');
    // The offending value is quoted back, which is what turns "it did not work"
    // into "you are reading the unit-of-measure column".
    expect(issue?.message).toContain('EA');
  });

  it('does not fail over an OPTIONAL field the ERP omitted', () => {
    // The second SAP record has no price. Plenty of ERPs omit a field on a
    // record with no value for it, and refusing the whole mapping over that
    // would make the feature unusable.
    const result = verifyAgainstSample(SAP_MAPPING, SAP_STYLE, {
      inventory: true,
      order: false,
    });

    expect(result.ok).toBe(true);
  });

  it('does not ask a stock record for an ERP order id', () => {
    // The bug this pins: a connection test reads the INVENTORY endpoint, and
    // `erpOrderId` describes the response to an order CREATION - which a test
    // deliberately never makes. Checked against a stock record it can never
    // resolve, so every passing test reported a "field mapping problem" that
    // was a question asked of the wrong document.
    const withOrderField: FieldMapping = {
      ...SAP_MAPPING,
      fields: { ...SAP_MAPPING.fields, erpOrderId: 'id' },
    };

    const unrestricted = verifyAgainstSample(withOrderField, SAP_STYLE, {
      inventory: true,
      order: false,
    });

    expect(unrestricted.issues.some((issue) => issue.field.endsWith('erpOrderId'))).toBe(true);

    // Told which document it is holding, it does not look at order fields.
    const restricted = verifyAgainstSample(
      withOrderField,
      SAP_STYLE,
      { inventory: true, order: false },
      ['product', 'inventory', 'pricing'],
    );

    expect(restricted.ok).toBe(true);
    expect(restricted.issues).toEqual([]);
    // And the inventory fields are still checked, so this is a narrower
    // question rather than no question.
    expect(restricted.resolved.some((entry) => entry.field === 'sku')).toBe(true);
  });

  it('cannot be verified against an empty response, and says so', () => {
    const result = verifyAgainstSample(SAP_MAPPING, { d: { results: [] } }, {
      inventory: true,
      order: false,
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe('ITEMS_EMPTY');
  });
});

// ---------------------------------------------------------------------------
// Reading a mapping back out of the database
// ---------------------------------------------------------------------------

describe('parseFieldMapping', () => {
  it('narrows a JSON column into a mapping', () => {
    const parsed = parseFieldMapping({
      itemsPath: 'd.results',
      fields: { sku: 'Material', availableQuantity: 'LabSt' },
      warehouseMap: { '1000': 'MAIN' },
    });

    expect(parsed?.itemsPath).toBe('d.results');
    expect(parsed?.fields.sku).toBe('Material');
    expect(parsed?.warehouseMap).toEqual({ '1000': 'MAIN' });
  });

  it('drops fields this system does not know, rather than carrying them', () => {
    const parsed = parseFieldMapping({ fields: { sku: 'a', notAField: 'b' } });

    expect(parsed?.fields.sku).toBe('a');
    expect(Object.keys(parsed?.fields ?? {})).not.toContain('notAField');
  });

  it.each([[null], [undefined], ['a string'], [[]], [{}], [{ fields: 'not an object' }]])(
    'returns null for %s, so a corrupt row fails in one place',
    (input) => {
      expect(parseFieldMapping(input)).toBeNull();
    },
  );
});
