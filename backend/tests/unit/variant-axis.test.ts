/**
 * Option identity: normalisation, signatures, SKUs and matrix generation.
 *
 * The signature is the load-bearing thing here. It is what the unique index
 * compares, so if it is computed differently on the way in and on the way out,
 * the database happily stores two rows for one combination and the resolver
 * gets to choose between them at random.
 */
import { describe, expect, it } from 'vitest';
import {
  COMBINATION_WARNING_THRESHOLD,
  MAX_GENERATED_COMBINATIONS,
  countCombinations,
  duplicateSignatures,
  generateCombinations,
  generateSku,
  generateSkus,
  measurementText,
  normaliseAxisKey,
  normaliseValue,
  optionSignature,
  signatureOfMap,
  skuToken,
  sortAxisValues,
  variantDisplayName,
  type OptionValue,
} from '../../src/domain/variants/axis.js';
import { findTemplate } from '../../src/domain/variants/registry.js';

const value = (axisKey: string, label: string, amount?: string, unit?: string): OptionValue => ({
  axisKey,
  label,
  ...(amount === undefined ? {} : { amount }),
  ...(unit === undefined ? {} : { unit }),
});

describe('normaliseValue', () => {
  it('folds case, spacing and punctuation to one comparable form', () => {
    expect(normaliseValue('UK 8')).toBe('uk-8');
    expect(normaliseValue('uk-8')).toBe('uk-8');
    expect(normaliseValue('  Uk   8  ')).toBe('uk-8');
    expect(normaliseValue('Navy Blue')).toBe('navy-blue');
  });

  it('strips accents rather than turning them into separators', () => {
    expect(normaliseValue('Crème')).toBe('creme');
    expect(normaliseValue('Größe')).toBe('grosse');
  });

  it('keeps the digits of a measurement together with its unit', () => {
    expect(normaliseValue('2.5 mm2')).toBe('2-5-mm2');
  });

  it('never returns leading or trailing separators', () => {
    expect(normaliseValue('  ---Black---  ')).toBe('black');
    expect(normaliseValue('***')).toBe('');
  });

  it('folds an axis key to underscores, so a hand-typed key cannot collide', () => {
    expect(normaliseAxisKey('Size System')).toBe('size_system');
    expect(normaliseAxisKey('size-system')).toBe('size_system');
    expect(normaliseAxisKey('size_system')).toBe('size_system');
  });
});

describe('optionSignature', () => {
  it('is sorted by axis key, not by the order the values arrive in', () => {
    const forwards = optionSignature([
      value('colour', 'Black'),
      value('size_system', 'UK'),
      value('size', '8'),
    ]);
    const backwards = optionSignature([
      value('size', '8'),
      value('size_system', 'UK'),
      value('colour', 'Black'),
    ]);

    expect(forwards).toBe('colour:black|size:8|size_system:uk');
    expect(backwards).toBe(forwards);
  });

  it('gives two spellings of one value one signature', () => {
    expect(optionSignature([value('colour', 'Black')])).toBe(
      optionSignature([value('colour', ' black ')]),
    );
  });

  it('holds a measurement as its number and unit together', () => {
    expect(optionSignature([value('cross_section', '', '2.5', 'mm2')])).toBe(
      'cross_section:2-5-mm2',
    );
  });

  it('drops an empty value rather than storing a blank axis', () => {
    expect(optionSignature([value('colour', 'Black'), value('width', '')])).toBe('colour:black');
  });

  it('refuses one axis given twice', () => {
    expect(() => optionSignature([value('colour', 'Black'), value('Colour', 'Brown')])).toThrow(
      /twice/,
    );
  });

  it('matches the signature computed from the stored options map', () => {
    expect(signatureOfMap({ colour: 'Black', size: '8', size_system: 'UK' })).toBe(
      'colour:black|size:8|size_system:uk',
    );
  });
});

describe('measurementText', () => {
  it('puts a space between the number and the unit', () => {
    expect(measurementText(value('length', '', '100', 'm'))).toBe('100 m');
  });

  it('falls back to the label when there is no amount', () => {
    expect(measurementText(value('colour', 'Black'))).toBe('Black');
  });

  it('prints a bare number when the seller gave no unit', () => {
    expect(measurementText(value('cores', '', '4'))).toBe('4');
  });
});

describe('sortAxisValues', () => {
  it('sorts numeric sizes numerically, so 8 comes before 10', () => {
    expect(sortAxisValues(['10', '8', '9', '11', '6'], 'NUMERIC')).toEqual([
      '6',
      '8',
      '9',
      '10',
      '11',
    ]);
  });

  it('sorts decimal measurements numerically', () => {
    expect(sortAxisValues(['10 mm2', '1.5 mm2', '2.5 mm2', '4 mm2'], 'NUMERIC')).toEqual([
      '1.5 mm2',
      '2.5 mm2',
      '4 mm2',
      '10 mm2',
    ]);
  });

  it('puts a value with no number after every value with one', () => {
    expect(sortAxisValues(['Custom', '8', '6'], 'NUMERIC')).toEqual(['6', '8', 'Custom']);
  });

  it('sorts apparel sizes as a rail hangs them', () => {
    expect(sortAxisValues(['XL', 'S', '3XL', 'M', 'XS', '2XL', 'L'], 'APPAREL')).toEqual([
      'XS',
      'S',
      'M',
      'L',
      'XL',
      '2XL',
      '3XL',
    ]);
  });

  it('puts an unknown apparel size at the end rather than in the middle of the run', () => {
    expect(sortAxisValues(['L', 'One Size', 'S'], 'APPAREL')).toEqual(['S', 'L', 'One Size']);
  });

  it('leaves GIVEN order exactly as the seller typed it', () => {
    expect(sortAxisValues(['Roasted', 'Raw'], 'GIVEN')).toEqual(['Roasted', 'Raw']);
  });
});

describe('SKU generation', () => {
  const pattern = { prefix: 'UB', productCode: 'SHOE01' };

  it('builds a deterministic code from prefix, product and option tokens', () => {
    const sku = generateSku(pattern, [
      value('size', '8'),
      value('colour', 'Black'),
      value('width', 'Standard'),
    ]);

    // Axes in signature order - colour, size, width - so a template reorder
    // cannot change a SKU already printed on a label.
    expect(sku).toBe('UB-SHOE01-BLACK-8-STANDA');
  });

  it('produces the same SKU for the same combination, whatever order it arrives in', () => {
    const a = generateSku(pattern, [value('colour', 'Black'), value('size', '8')]);
    const b = generateSku(pattern, [value('size', '8'), value('colour', 'Black')]);
    expect(a).toBe(b);
  });

  it('caps a token at six characters', () => {
    expect(skuToken('Hot-dip galvanised')).toBe('HOTDIP');
    expect(skuToken('220-240 V')).toBe('220240');
  });

  it('breaks a collision with a suffix rather than reusing a SKU', () => {
    const taken = new Set(['UB-SHOE01-BLACK-8']);
    const [first, second] = generateSkus(
      pattern,
      [
        [value('colour', 'Black'), value('size', '8')],
        [value('colour', 'Black'), value('size', '8')],
      ],
      taken,
    );

    expect(first).toBe('UB-SHOE01-BLACK-8-2');
    expect(second).toBe('UB-SHOE01-BLACK-8-3');
  });

  it('does not exceed the 64 characters the SKU column holds', () => {
    const sku = generateSku(
      { prefix: 'VERYLONGPREFIX', productCode: 'ALSOAVERYLONGPRODUCTCODE' },
      [
        value('a', 'aaaaaaaaaa'),
        value('b', 'bbbbbbbbbb'),
        value('c', 'cccccccccc'),
        value('d', 'dddddddddd'),
        value('e', 'eeeeeeeeee'),
      ],
    );
    expect(sku.length).toBeLessThanOrEqual(64);
  });
});

describe('combination generation', () => {
  const axes = [
    { axisKey: 'colour', values: [value('colour', 'Black'), value('colour', 'Brown')] },
    { axisKey: 'size', values: [value('size', '8'), value('size', '9'), value('size', '10')] },
  ];

  it('counts without generating', () => {
    expect(countCombinations(axes)).toBe(6);
  });

  it('ignores an axis the seller entered no values for', () => {
    expect(countCombinations([...axes, { axisKey: 'width', values: [] }])).toBe(6);
  });

  it('varies the last axis fastest, so the table reads as a table', () => {
    const rows = generateCombinations(axes).map((row) =>
      row.map((entry) => entry.label).join('/'),
    );

    expect(rows).toEqual([
      'Black/8',
      'Black/9',
      'Black/10',
      'Brown/8',
      'Brown/9',
      'Brown/10',
    ]);
  });

  it('refuses a matrix nobody could check before saving', () => {
    const wide = Array.from({ length: 4 }, (_unused, index) => ({
      axisKey: `axis${index}`,
      values: Array.from({ length: 6 }, (_ignored, valueIndex) =>
        value(`axis${index}`, `v${valueIndex}`),
      ),
    }));

    expect(countCombinations(wide)).toBeGreaterThan(MAX_GENERATED_COMBINATIONS);
    expect(() => generateCombinations(wide)).toThrow(/more than the 500/);
  });

  it('warns well before it refuses', () => {
    expect(COMBINATION_WARNING_THRESHOLD).toBeLessThan(MAX_GENERATED_COMBINATIONS);
  });

  it('finds a duplicate combination even when the spellings differ', () => {
    expect(
      duplicateSignatures([
        [value('colour', 'Black')],
        [value('colour', ' black ')],
        [value('colour', 'Brown')],
      ]),
    ).toEqual(['colour:black']);
  });

  it('reports no duplicates for a clean matrix', () => {
    expect(duplicateSignatures(generateCombinations(axes))).toEqual([]);
  });
});

describe('variantDisplayName', () => {
  it('names a variant from the title axes, in template order', () => {
    const footwear = findTemplate(['footwear']);
    expect(footwear).not.toBeNull();

    const name = variantDisplayName(footwear?.axes ?? [], [
      value('colour', 'Black'),
      value('size', '8'),
      value('size_system', 'UK/India'),
    ]);

    expect(name).toBe('UK/India / 8 / Black');
  });

  it('leaves out an axis the product did not use', () => {
    const footwear = findTemplate(['footwear']);
    expect(variantDisplayName(footwear?.axes ?? [], [value('colour', 'Brown')])).toBe('Brown');
  });
});
