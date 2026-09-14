/**
 * "Is this listing finished, and what exactly is missing?"
 *
 * The counters these produce are the ones the seller watches while typing and
 * the ones the submit gate reads, so a bug here is a seller being told a
 * listing is ready and then refused - with no way to tell which answer was
 * wrong. The cases below are the ones where "obviously complete" and "actually
 * complete" come apart.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateListing,
  evaluatePackHierarchy,
  evaluatePriceTiers,
  hasValue,
  validateAttributeValue,
  type AttributeDefinition,
} from '../../src/domain/listing-completeness.js';
import { generateTitle, type TitleComponentDefinition } from '../../src/domain/listing-title.js';

function definition(over: Partial<AttributeDefinition> = {}): AttributeDefinition {
  return {
    attributeKey: 'field',
    label: 'Field',
    section: 'PRODUCT_DESCRIPTION',
    type: 'TEXT',
    isRequired: false,
    ...over,
  };
}

const NO_MEDIA = { mediaSlots: [], media: [] };

function evaluate(
  definitions: AttributeDefinition[],
  values: Record<string, unknown>,
  over: Partial<Parameters<typeof evaluateListing>[0]> = {},
) {
  return evaluateListing({
    definitions,
    values,
    ...NO_MEDIA,
    isRegulatedDevice: false,
    hasPrice: true,
    hasStock: true,
    ...over,
  });
}

describe('hasValue', () => {
  it('treats false and zero as answers', () => {
    // The case that breaks naive truthiness: "sterile: no" and "weight: 0" are
    // answers, and counting them as blank blocks every non-sterile product.
    expect(hasValue(false)).toBe(true);
    expect(hasValue(0)).toBe(true);
  });

  it('treats an empty collection as unanswered', () => {
    // A multi-select the seller opened and closed leaves `[]`, which is truthy
    // and would otherwise count as a completed field.
    expect(hasValue([])).toBe(false);
    expect(hasValue({})).toBe(false);
    expect(hasValue('   ')).toBe(false);
    expect(hasValue(null)).toBe(false);
    expect(hasValue(undefined)).toBe(false);
  });
});

describe('validateAttributeValue', () => {
  it('accepts a missing value - absence is the caller\'s business', () => {
    expect(validateAttributeValue(definition({ isRequired: true }), undefined)).toBeNull();
  });

  it('constrains measurement units', () => {
    const measurement = definition({
      type: 'MEASUREMENT',
      allowedUnits: ['mm', 'cm'],
    });

    expect(validateAttributeValue(measurement, { amount: 120, unit: 'mm' })).toBeNull();

    // "12 inch" and "120 mm" sorting apart in a buyer's filter is what an
    // unconstrained unit field actually breaks.
    expect(validateAttributeValue(measurement, { amount: 12, unit: 'inch' })?.code).toBe(
      'UNIT_NOT_ALLOWED',
    );

    expect(validateAttributeValue(measurement, { amount: 120 })?.code).toBe('UNIT_REQUIRED');
  });

  it('refuses the three ways a repeatable group goes wrong', () => {
    const group = definition({ type: 'KEY_VALUE_LIST', label: 'In the box' });

    expect(validateAttributeValue(group, [{ name: 'Mask', quantity: 1 }])).toBeNull();

    // Pressed "+" twice.
    expect(validateAttributeValue(group, [{ name: '', quantity: 1 }])?.code).toBe('EMPTY_ROW');
    // A quantity of zero means the item is not in the box.
    expect(validateAttributeValue(group, [{ name: 'Filter', quantity: 0 }])?.code).toBe(
      'QUANTITY_INVALID',
    );
    expect(validateAttributeValue(group, [{ name: 'Filter', quantity: -2 }])?.code).toBe(
      'QUANTITY_INVALID',
    );
  });

  it('does not punish a seller for an operator\'s broken pattern', () => {
    // A regex nobody on that screen can fix must not block the listing.
    const broken = definition({ pattern: '([unclosed' });
    expect(validateAttributeValue(broken, 'anything')).toBeNull();
  });

  it('enforces a working pattern', () => {
    const gtin = definition({ pattern: '^[0-9]{8}$|^[0-9]{12,14}$' });
    expect(validateAttributeValue(gtin, '05012345678900')).toBeNull();
    expect(validateAttributeValue(gtin, '12345')?.code).toBe('PATTERN_MISMATCH');
  });
});

describe('evaluateListing', () => {
  it('does not count a field that holds an invalid value', () => {
    // The failure this prevents is "8/8 complete" sitting above a red field,
    // which is the most confusing thing a form this size can do.
    const result = evaluate(
      [definition({ attributeKey: 'gtin', isRequired: true, pattern: '^[0-9]{8}$' })],
      { gtin: 'not-a-barcode' },
    );

    const section = result.sections.find((entry) => entry.section === 'PRODUCT_DESCRIPTION');

    expect(section?.completed).toBe(0);
    expect(section?.state).toBe('ERROR');
    expect(result.isSubmittable).toBe(false);
  });

  it('blocks on an invalid OPTIONAL value too', () => {
    // A malformed identifier is malformed whether or not the field was
    // required, and publishing it would put a wrong barcode in front of a
    // buyer.
    const result = evaluate(
      [definition({ attributeKey: 'gtin', isRequired: false, pattern: '^[0-9]{8}$' })],
      { gtin: 'nope' },
    );

    expect(result.isSubmittable).toBe(false);
  });

  it('calls a section with nothing required OPTIONAL, never incomplete', () => {
    // "Additional information (0/18)" where none of the eighteen is required
    // must not send the seller hunting for a blocker that does not exist.
    const result = evaluate(
      [
        definition({ attributeKey: 'a', section: 'ADDITIONAL_INFORMATION' }),
        definition({ attributeKey: 'b', section: 'ADDITIONAL_INFORMATION' }),
      ],
      {},
    );

    const section = result.sections.find((entry) => entry.section === 'ADDITIONAL_INFORMATION');

    expect(section?.state).toBe('OPTIONAL');
    expect(section?.required).toBe(0);
    expect(result.isSubmittable).toBe(true);
  });

  it('skips regulatory fields entirely on a product that is not regulated', () => {
    // The case that makes this a general marketplace: a bag of screws in a
    // category that also contains a UDI field must not be asked for one.
    const definitions = [
      definition({ attributeKey: 'udi_di', isRequired: true, isRegulatoryOnly: true, section: 'MEDICAL_COMPLIANCE' }),
    ];

    const unregulated = evaluate(definitions, {}, { isRegulatedDevice: false });
    expect(unregulated.isSubmittable).toBe(true);
    expect(
      unregulated.sections.find((entry) => entry.section === 'MEDICAL_COMPLIANCE')?.total,
    ).toBe(0);

    const regulated = evaluate(definitions, {}, { isRegulatedDevice: true });
    expect(regulated.isSubmittable).toBe(false);
    expect(regulated.issues.some((issue) => issue.code === 'REQUIRED_FIELD_MISSING')).toBe(true);
  });

  it('names the field behind every refusal', () => {
    // The difference between a review a seller can act on and a dead end.
    const result = evaluate(
      [definition({ attributeKey: 'model_number', label: 'Model number', isRequired: true })],
      {},
    );

    const issue = result.issues.find((entry) => entry.code === 'REQUIRED_FIELD_MISSING');

    expect(issue?.attributeKey).toBe('model_number');
    expect(issue?.section).toBe('PRODUCT_DESCRIPTION');
    expect(issue?.message).toContain('Model number');
  });

  it('blocks a missing required photograph and names the slot', () => {
    const result = evaluate([], {}, {
      mediaSlots: [
        { slot: 'FRONT_VIEW', label: 'Front view', isRequired: true },
        { slot: 'SIDE_VIEW', label: 'Side view', isRequired: false },
      ],
      media: [{ slot: 'SIDE_VIEW', uploaded: true }],
    });

    const issue = result.issues.find((entry) => entry.code === 'REQUIRED_IMAGE_MISSING');

    expect(issue?.attributeKey).toBe('FRONT_VIEW');
    expect(result.isSubmittable).toBe(false);

    const photos = result.sections.find((entry) => entry.section === 'PRODUCT_PHOTOS');
    expect(photos?.completed).toBe(1);
    expect(photos?.total).toBe(2);
  });

  it('blocks on a missing price but only warns about missing stock', () => {
    // A made-to-order item has no stock to declare, and refusing it would be
    // refusing a legitimate way of selling. No price is different: there is
    // nothing to charge.
    const noPrice = evaluate([], {}, { hasPrice: false });
    expect(noPrice.isSubmittable).toBe(false);
    expect(noPrice.issues.find((issue) => issue.code === 'PRICE_REQUIRED')?.severity).toBe('BLOCKER');

    const noStock = evaluate([], {}, { hasStock: false });
    expect(noStock.isSubmittable).toBe(true);
    expect(noStock.issues.find((issue) => issue.code === 'NO_STOCK_ALLOCATED')?.severity).toBe(
      'WARNING',
    );
  });
});

describe('evaluatePackHierarchy', () => {
  it('multiplies the levels out', () => {
    // "One box of 100 units, ten boxes of 1,000 units."
    expect(evaluatePackHierarchy({ unitsPerPack: 100, packsPerBox: 10 }).totalUnits).toBe(1000);
  });

  it('catches a stated total that disagrees with the arithmetic', () => {
    const result = evaluatePackHierarchy({
      unitsPerPack: 100,
      packsPerBox: 10,
      statedTotalUnits: 100,
    });

    expect(result.issues.some((issue) => issue.code === 'PACK_TOTAL_MISMATCH')).toBe(true);
  });

  it('refuses a fractional or zero level', () => {
    // These are counts of physical things. Half a syringe per pack is a
    // data-entry error.
    expect(
      evaluatePackHierarchy({ unitsPerPack: 2.5 }).issues.some(
        (issue) => issue.code === 'PACK_LEVEL_INVALID',
      ),
    ).toBe(true);

    expect(
      evaluatePackHierarchy({ unitsPerPack: 0 }).issues.some(
        (issue) => issue.code === 'PACK_LEVEL_INVALID',
      ),
    ).toBe(true);
  });

  it('treats a product sold as a single unit as one, not zero', () => {
    expect(evaluatePackHierarchy({}).totalUnits).toBe(1);
  });
});

describe('evaluatePriceTiers', () => {
  it('accepts bands that get cheaper as they get bigger', () => {
    const issues = evaluatePriceTiers(1000n, [
      { minQuantity: 10, priceMinor: 900n },
      { minQuantity: 50, priceMinor: 800n },
    ]);

    expect(issues).toHaveLength(0);
  });

  it('refuses a band that is not cheaper than the one below', () => {
    // Ordering more costing more reads to a buyer as a bug in the shop.
    const issues = evaluatePriceTiers(1000n, [{ minQuantity: 10, priceMinor: 1100n }]);
    expect(issues.some((issue) => issue.code === 'TIER_NOT_CHEAPER')).toBe(true);
  });

  it('refuses two bands starting at the same quantity', () => {
    // One quantity with two prices has no answer a buyer would accept.
    const issues = evaluatePriceTiers(1000n, [
      { minQuantity: 10, priceMinor: 900n },
      { minQuantity: 10, priceMinor: 850n },
    ]);

    expect(issues.some((issue) => issue.code === 'TIER_QUANTITY_DUPLICATE')).toBe(true);
  });

  it('refuses a band starting at one - that is the base price', () => {
    const issues = evaluatePriceTiers(1000n, [{ minQuantity: 1, priceMinor: 900n }]);
    expect(issues.some((issue) => issue.code === 'TIER_QUANTITY_INVALID')).toBe(true);
  });
});

describe('generateTitle', () => {
  function component(over: Partial<TitleComponentDefinition>): TitleComponentDefinition {
    return { ...definition(), titleOrder: 0, ...over };
  }

  it('builds a title from the brand and the components, in order', () => {
    const result = generateTitle({
      brandName: 'Aesculap',
      components: [
        component({ attributeKey: 'size', label: 'Size', titleOrder: 20 }),
        component({ attributeKey: 'generic_name', label: 'Product name', titleOrder: 10 }),
      ],
      values: { generic_name: 'Nitrile glove', size: 'Medium' },
    });

    expect(result.ready).toBe(true);
    expect(result.title).toBe('Aesculap, Nitrile glove, Medium');
  });

  it('refuses to build a title while a required component is missing', () => {
    // This is what keeps "Preview title" honestly disabled rather than
    // producing a half-title the seller then believes.
    const result = generateTitle({
      components: [
        component({ attributeKey: 'generic_name', label: 'Product name', isRequired: true }),
      ],
      values: {},
    });

    expect(result.ready).toBe(false);
    expect(result.ready === false && result.blockedBy[0]?.reason).toBe('MISSING');
  });

  it('skips an optional component that is absent, without a hole in the title', () => {
    const result = generateTitle({
      components: [
        component({ attributeKey: 'generic_name', label: 'Name', titleOrder: 10, isRequired: true }),
        component({ attributeKey: 'gauge', label: 'Gauge', titleOrder: 20 }),
      ],
      values: { generic_name: 'Cannula' },
    });

    expect(result.ready).toBe(true);
    expect(result.title).toBe('Cannula');
  });

  it('carries the unit into the title', () => {
    // Dropping the unit is how two different products end up with one name.
    const result = generateTitle({
      components: [
        component({
          attributeKey: 'length',
          label: 'Length',
          type: 'MEASUREMENT',
          allowedUnits: ['mm'],
          titleOrder: 10,
        }),
      ],
      values: { length: { amount: 120, unit: 'mm' } },
    });

    expect(result.title).toBe('120 mm');
  });

  it('includes a true boolean as its label and omits a false one', () => {
    // "Sterile" belongs in a title; "Sterile: No" does not.
    const components = [
      component({ attributeKey: 'name', label: 'Name', titleOrder: 10 }),
      component({ attributeKey: 'sterile', label: 'Sterile', type: 'BOOLEAN', titleOrder: 20 }),
    ];

    expect(generateTitle({ components, values: { name: 'Swab', sterile: true } }).title).toBe(
      'Swab, Sterile',
    );

    expect(generateTitle({ components, values: { name: 'Swab', sterile: false } }).title).toBe(
      'Swab',
    );
  });

  it('produces the same title twice for components sharing an order', () => {
    // Without the tie-break, two runs could swap them and one listing would
    // have two titles.
    const components = [
      component({ attributeKey: 'b_field', label: 'B', titleOrder: 10 }),
      component({ attributeKey: 'a_field', label: 'A', titleOrder: 10 }),
    ];

    const values = { a_field: 'Alpha', b_field: 'Bravo' };

    expect(generateTitle({ components, values }).title).toBe(
      generateTitle({ components: [...components].reverse(), values }).title,
    );
  });

  it('is not ready when there is nothing at all to build from', () => {
    // An empty title would otherwise be stored and published.
    const result = generateTitle({ components: [], values: {} });
    expect(result.ready).toBe(false);
  });
});
