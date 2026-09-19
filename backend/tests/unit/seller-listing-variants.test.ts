/**
 * The seller's side of variants: what the wizard sends, and what survives it.
 *
 * The cases here are the ones that would cost a real seller real money if the
 * normalisation got them wrong - a regenerated matrix that loses the prices, a
 * duplicate row that only fails at approval, a size run invented for a shirt
 * nobody measured.
 */
import { describe, expect, it } from 'vitest';
import { findTemplate } from '../../src/domain/variants/registry.js';
import {
  generateMatrix,
  normaliseAxes,
  normaliseRows,
  projectMatrix,
  readDraftVariants,
  validateVariants,
  variantNameOf,
  type DraftVariantAxis,
  type DraftVariantRow,
} from '../../src/modules/seller/listing-variants.js';

const CLOTHING = findTemplate(['everyday-clothing', 'clothing-textiles']);

function row(over: Partial<DraftVariantRow> = {}): DraftVariantRow {
  return {
    optionSignature: '',
    options: { colour: 'Black', size: 'M' },
    name: 'Black / M',
    sku: 'TSH-BLK-M',
    isActive: true,
    priceMinor: '49900',
    stock: [{ locationId: '01JQW0000000000000000000AA', availableQuantity: 5 }],
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('reading what a draft stored', () => {
  it('tells "not asked yet" apart from "one configuration"', () => {
    expect(readDraftVariants(null, null).axes).toBeNull();
    expect(readDraftVariants({ axes: [] }, null).axes).toEqual([]);
  });

  it('ignores a shape it does not recognise rather than throwing', () => {
    expect(readDraftVariants('nonsense', 42).axes).toBeNull();
    expect(readDraftVariants({ axes: 'nope' }, null).axes).toBeNull();
  });
});

describe('normalising axes', () => {
  it('drops an axis the category does not offer, and says which', () => {
    const { axes, unknownKeys } = normaliseAxes(CLOTHING, [
      { axisKey: 'colour', values: [{ label: 'Black' }] },
      { axisKey: 'octane_rating', values: [{ label: '95' }] },
    ]);

    expect(axes.map((axis) => axis.axisKey)).toEqual(['colour']);
    expect(unknownKeys).toEqual(['octane_rating']);
  });

  it('accepts any axis when the category has no template at all', () => {
    // Medical Devices and operator-invented shelves. A marketplace that
    // refuses what it did not anticipate is not a marketplace.
    const { axes, unknownKeys } = normaliseAxes(null, [
      { axisKey: 'tip_style', values: [{ label: 'Luer lock' }] },
    ]);

    expect(axes).toHaveLength(1);
    expect(unknownKeys).toEqual([]);
  });

  it('folds two spellings of one value into one choice, keeping the first', () => {
    const { axes } = normaliseAxes(CLOTHING, [
      { axisKey: 'size', values: [{ label: 'XL' }, { label: 'xl' }, { label: ' XL ' }] },
    ]);

    expect(axes[0]?.values).toEqual([{ label: 'XL' }]);
  });

  it('drops a blank value instead of refusing the save', () => {
    const { axes } = normaliseAxes(CLOTHING, [
      { axisKey: 'size', values: [{ label: 'S' }, { label: '   ' }, { label: 'M' }] },
    ]);

    expect(axes[0]?.values.map((value) => value.label)).toEqual(['S', 'M']);
  });

  it('keeps a measurement value distinct by its unit', () => {
    const { axes } = normaliseAxes(null, [
      {
        axisKey: 'net_weight',
        values: [
          { label: '500', amount: '500', unit: 'g' },
          { label: '500', amount: '500', unit: 'kg' },
        ],
      },
    ]);

    expect(axes[0]?.values).toHaveLength(2);
  });
});

describe('normalising rows', () => {
  it('recomputes the signature rather than trusting the client', () => {
    const { rows } = normaliseRows([row({ optionSignature: 'whatever-the-client-said' })]);

    expect(rows[0]?.optionSignature).not.toBe('whatever-the-client-said');
    expect(rows[0]?.optionSignature).toContain('colour');
  });

  it('collapses two rows describing the same combination', () => {
    const { rows, duplicateSignatures } = normaliseRows([
      row({ sku: 'FIRST' }),
      row({ sku: 'SECOND' }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sku).toBe('FIRST');
    expect(duplicateSignatures).toHaveLength(1);
  });

  it('treats differently-cased option values as one combination', () => {
    const { rows } = normaliseRows([
      row({ options: { colour: 'Black', size: 'M' }, sku: 'A' }),
      row({ options: { colour: 'black', size: 'm' }, sku: 'B' }),
    ]);

    expect(rows).toHaveLength(1);
  });

  it('drops a row with no options at all', () => {
    const { rows } = normaliseRows([row({ options: {} })]);
    expect(rows).toEqual([]);
  });

  it('never lets stock go negative', () => {
    const { rows } = normaliseRows([
      row({ stock: [{ locationId: '01JQW0000000000000000000AA', availableQuantity: -8 }] }),
    ]);

    expect(rows[0]?.stock[0]?.availableQuantity).toBe(0);
  });
});

describe('staying inside the columns', () => {
  /*
   * These two exist because development runs MariaDB 10.4 and production runs
   * 11.4. The first truncates an over-long value, the second rejects it - so
   * an unbounded string is a bug that passes locally and fails on the runner,
   * or worse, passes both and corrupts quietly.
   */
  const longOptions: Record<string, string> = {
    colour: 'A'.repeat(120),
    size: 'B'.repeat(120),
    width: 'C'.repeat(120),
    material: 'D'.repeat(120),
    finish: 'E'.repeat(120),
  };

  it('keeps the option signature inside its 512-character column', () => {
    const { rows } = normaliseRows([row({ options: longOptions })]);
    expect(rows[0]?.optionSignature.length).toBeLessThanOrEqual(512);
  });

  it('keeps two different long combinations telling themselves apart', () => {
    // Plain truncation would fold these into one and the unique index would
    // reject the second as a duplicate of a combination it is not.
    const { rows } = normaliseRows([
      row({ options: longOptions, sku: 'A' }),
      row({ options: { ...longOptions, finish: `${'E'.repeat(119)}X` }, sku: 'B' }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.optionSignature).not.toBe(rows[1]?.optionSignature);
  });

  it('keeps the variant name inside its 255-character column', () => {
    expect(variantNameOf({ name: null, options: longOptions }).length).toBeLessThanOrEqual(255);
    expect(variantNameOf({ name: 'Z'.repeat(400), options: {} }).length).toBe(255);
  });

  it('falls back to the option values when the seller named nothing', () => {
    expect(variantNameOf({ name: '  ', options: { colour: 'Black', size: 'M' } })).toBe(
      'Black / M',
    );
  });
});

describe('projecting the matrix', () => {
  it('multiplies the values, not the axes', () => {
    const axes: DraftVariantAxis[] = [
      { axisKey: 'size', values: [{ label: 'S' }, { label: 'M' }, { label: 'L' }, { label: 'XL' }] },
      { axisKey: 'colour', values: [{ label: 'Black' }, { label: 'White' }] },
    ];

    expect(projectMatrix(axes).total).toBe(8);
  });

  it('flags a matrix past the cap rather than building it', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ label: `v${index}` }));
    const axes: DraftVariantAxis[] = [
      { axisKey: 'size', values: many },
      { axisKey: 'colour', values: many },
    ];

    expect(projectMatrix(axes).exceedsMaximum).toBe(true);
  });
});

describe('generating the matrix', () => {
  const axes: DraftVariantAxis[] = [
    { axisKey: 'size', values: [{ label: 'S' }, { label: 'M' }] },
    { axisKey: 'colour', values: [{ label: 'Black' }, { label: 'White' }] },
  ];

  it('produces one row per combination', () => {
    const { rows } = generateMatrix(axes, { productCode: 'TSH' });
    expect(rows).toHaveLength(4);
  });

  it('gives every generated row a distinct code', () => {
    const { rows } = generateMatrix(axes, { productCode: 'TSH' });
    const skus = new Set(rows.map((entry) => entry.sku));

    expect(skus.size).toBe(4);
    for (const sku of skus) expect(sku).toContain('TSH');
  });

  it('leaves the code blank when there is nothing to build it from', () => {
    // Rather than inventing one. A code the seller has never seen is a code
    // their warehouse cannot pick against.
    const { rows } = generateMatrix(axes, {});
    expect(rows.every((entry) => entry.sku === '')).toBe(true);
  });

  it('KEEPS an already-priced row when a new colour is added', () => {
    const first = generateMatrix(axes, { productCode: 'TSH' });
    const priced = first.rows.map((entry) => ({ ...entry, priceMinor: '49900' }));

    const widened: DraftVariantAxis[] = [
      { axisKey: 'size', values: [{ label: 'S' }, { label: 'M' }] },
      { axisKey: 'colour', values: [{ label: 'Black' }, { label: 'White' }, { label: 'Navy' }] },
    ];

    const { rows } = generateMatrix(widened, { existing: priced, productCode: 'TSH' });

    expect(rows).toHaveLength(6);
    // The four that existed keep their price; the two new ones have none.
    expect(rows.filter((entry) => entry.priceMinor === '49900')).toHaveLength(4);
    expect(rows.filter((entry) => entry.priceMinor === undefined)).toHaveLength(2);
  });

  it('does not build anything past the cap', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ label: `v${index}` }));
    const { rows } = generateMatrix([
      { axisKey: 'size', values: many },
      { axisKey: 'colour', values: many },
    ]);

    expect(rows).toEqual([]);
  });
});

describe('validating what the seller entered', () => {
  it('says nothing at all before the question has been answered', () => {
    expect(validateVariants({ axes: null, rows: null })).toEqual([]);
  });

  it('says nothing when the seller answered "one configuration"', () => {
    expect(validateVariants({ axes: [], rows: null })).toEqual([]);
  });

  it('blocks an axis that was switched on and left empty', () => {
    const issues = validateVariants({
      axes: [{ axisKey: 'size', values: [] }],
      rows: [row()],
    });

    expect(issues.some((issue) => issue.code === 'VARIANT_AXIS_EMPTY')).toBe(true);
  });

  it('blocks two rows sharing a code', () => {
    const issues = validateVariants({
      axes: [{ axisKey: 'size', values: [{ label: 'M' }] }],
      rows: [
        row({ options: { size: 'M' }, sku: 'SAME' }),
        row({ options: { size: 'L' }, sku: 'same' }),
      ],
    });

    expect(issues.some((issue) => issue.code === 'SELLER_SKU_ALREADY_EXISTS')).toBe(true);
  });

  it('blocks a code this seller already uses on another listing', () => {
    const issues = validateVariants({
      axes: [{ axisKey: 'size', values: [{ label: 'M' }] }],
      rows: [row({ sku: 'TAKEN' })],
      skusInUseElsewhere: new Set(['taken']),
    });

    expect(issues.some((issue) => issue.code === 'SELLER_SKU_ALREADY_EXISTS')).toBe(true);
  });

  it('blocks an on-sale row with no price', () => {
    const issues = validateVariants({
      axes: [{ axisKey: 'size', values: [{ label: 'M' }] }],
      rows: [row({ priceMinor: null })],
    });

    expect(issues.some((issue) => issue.code === 'VARIANT_PRICE_MISSING')).toBe(true);
  });

  it('does NOT block a switched-off row with no price', () => {
    const issues = validateVariants({
      axes: [{ axisKey: 'size', values: [{ label: 'M' }] }],
      rows: [row({ isActive: false, priceMinor: null }), row({ options: { size: 'L' }, sku: 'B' })],
    });

    expect(issues.some((issue) => issue.code === 'VARIANT_PRICE_MISSING')).toBe(false);
  });

  it('blocks a "was" price below the selling price', () => {
    const issues = validateVariants({
      axes: [{ axisKey: 'size', values: [{ label: 'M' }] }],
      rows: [row({ priceMinor: '49900', compareAtPriceMinor: '19900' })],
    });

    expect(issues.some((issue) => issue.code === 'VARIANT_COMPARE_AT_BELOW_PRICE')).toBe(true);
  });

  it('WARNS about empty stock rather than blocking it', () => {
    // "We sell it, we are out of it" is a true thing to say about a shoe.
    const issues = validateVariants({
      axes: [{ axisKey: 'size', values: [{ label: 'M' }] }],
      rows: [row({ stock: [] })],
    });

    const stockIssue = issues.find((issue) => issue.code === 'VARIANT_STOCK_EMPTY');
    expect(stockIssue?.severity).toBe('WARNING');
  });

  it('blocks a matrix where every row is switched off', () => {
    const issues = validateVariants({
      axes: [{ axisKey: 'size', values: [{ label: 'M' }] }],
      rows: [row({ isActive: false })],
    });

    expect(issues.some((issue) => issue.code === 'VARIANT_NONE_ACTIVE')).toBe(true);
  });

  it('blocks axes chosen with no combinations built yet', () => {
    const issues = validateVariants({
      axes: [{ axisKey: 'size', values: [{ label: 'M' }] }],
      rows: [],
    });

    expect(issues.some((issue) => issue.code === 'VARIANT_ROWS_MISSING')).toBe(true);
  });

  it('blocks a minimum order above the maximum', () => {
    const issues = validateVariants({
      axes: [{ axisKey: 'size', values: [{ label: 'M' }] }],
      rows: [row({ minOrderQty: 10, maxOrderQty: 5 })],
    });

    expect(issues.some((issue) => issue.code === 'VARIANT_MAX_BELOW_MIN')).toBe(true);
  });

  it('every issue names a field, so the wizard can put it beside an input', () => {
    const issues = validateVariants({
      axes: [{ axisKey: 'size', values: [] }],
      rows: [row({ sku: '', priceMinor: null })],
    });

    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.attributeKey).toBeTruthy();
      expect(issue.section).toBe('PRICE_STOCK_SHIPPING');
    }
  });
});
