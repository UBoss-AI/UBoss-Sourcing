/**
 * The specification and description rules, without a database.
 */
import { describe, expect, it } from 'vitest';
import {
  SPEC_GROUPS,
  cleanBlock,
  cleanLine,
  contentIssues,
  listingContentSchema,
  productRowsFrom,
  shownSpecifications,
  type StoredSpecRow,
} from '../../src/domain/product-specifications.js';
import { descriptionSectionsFor } from '../../src/modules/catalog/product-content.service.js';

const row = (name: string, value: string, extra: Partial<StoredSpecRow> = {}): StoredSpecRow => ({
  name,
  value,
  unit: null,
  groupKey: null,
  sortOrder: 0,
  ...extra,
});

describe('cleaning what a seller typed', () => {
  it('removes tags, event handlers and invisible characters from a line', () => {
    expect(cleanLine('Steel <b onmouseover="x()">304</b>​ grade')).toBe('Steel 304 grade');
    expect(cleanLine('<script>alert(1)</script>ok')).toBe('alert(1) ok');
    expect(cleanLine('javascript:alert(1)')).toBe('javascript:alert(1)');
  });

  it('keeps intentional line breaks in a block, and no more than one blank line', () => {
    expect(cleanBlock('One\r\n\r\n\r\n\r\nTwo\n  three  ')).toBe('One\n\nTwo\nthree');
    expect(cleanBlock('<iframe src="https://evil.test"></iframe>Text')).toBe('Text');
  });
});

describe('validating a listing’s content', () => {
  it('parses a complete payload and defaults the rest', () => {
    const parsed = listingContentSchema.parse({ specifications: [{ group: 'GENERAL', rows: [{ label: 'Model', value: 'X1' }] }] });
    expect(parsed.descriptionSections).toEqual([]);
    expect(parsed.specifications[0]?.rows[0]).toEqual({ label: 'Model', value: 'X1', unit: null, highlight: false });
  });

  it('refuses an unknown group, an unknown unit and an extra field', () => {
    expect(() => listingContentSchema.parse({ specifications: [{ group: 'MISC', rows: [] }] })).toThrow();
    expect(() =>
      listingContentSchema.parse({ specifications: [{ group: 'GENERAL', rows: [{ label: 'W', value: '1', unit: 'stone' }] }] }),
    ).toThrow();
    expect(() => listingContentSchema.parse({ specifications: [], html: '<p>x</p>' })).toThrow();
  });

  it('reports a label used twice, an empty value and an empty section', () => {
    const content = listingContentSchema.parse({
      specifications: [
        { group: 'GENERAL', rows: [{ label: 'Weight', value: '1 kg' }] },
        { group: 'TECHNICAL', rows: [{ label: ' weight ', value: '' }] },
      ],
      descriptionSections: [{ heading: '', body: '   ' }],
    });
    expect(contentIssues(content).map((issue) => issue.code).sort()).toEqual([
      'DUPLICATE_LABEL',
      'EMPTY_SECTION',
      'EMPTY_VALUE',
    ]);
  });
});

describe('showing specifications', () => {
  it('groups in the fixed order, hides empties and duplicates, and reads old rows as General', () => {
    const shown = shownSpecifications([
      row('Warranty', '2 years', { groupKey: 'WARRANTY', sortOrder: 1 }),
      row('Model', 'SB-750', { sortOrder: 0 }),
      row('Colour', 'null', { groupKey: 'GENERAL', sortOrder: 2 }),
      row('Capacity', '750', { groupKey: 'TECHNICAL', unit: 'ml', sortOrder: 3 }),
      row('capacity', '999', { groupKey: 'TECHNICAL', sortOrder: 4 }),
      row('Voltage', '', { groupKey: 'TECHNICAL', sortOrder: 5 }),
      row('Oddity', 'kept', { groupKey: 'NOT_A_GROUP', unit: 'furlongs', sortOrder: 6 }),
    ]);
    expect(shown.map((group) => group.group)).toEqual(['GENERAL', 'TECHNICAL', 'WARRANTY']);
    expect(shown[0]?.rows.map((entry) => entry.label)).toEqual(['Model', 'Oddity']);
    expect(shown[0]?.rows[1]?.unit).toBeNull();
    expect(shown[1]?.rows).toEqual([{ label: 'Capacity', value: '750', unit: 'ml', highlight: false }]);
    expect(SPEC_GROUPS.indexOf('GENERAL')).toBe(0);
  });

  it('replaces a product value with the variant’s and adds the variant’s own', () => {
    const product = [row('Capacity', '750', { groupKey: 'TECHNICAL', unit: 'ml' }), row('Model', 'SB')];
    const variant = [
      row('Capacity', '1000', { unit: 'ml' }),
      row('Height', '29', { groupKey: 'DIMENSIONS_WEIGHT', unit: 'cm' }),
    ];
    const shown = shownSpecifications(product, variant);
    expect(shown.find((group) => group.group === 'TECHNICAL')?.rows[0]?.value).toBe('1000');
    expect(shown.find((group) => group.group === 'DIMENSIONS_WEIGHT')?.rows[0]?.label).toBe('Height');
    // The product's own list is untouched for anybody who did not pick that variant.
    expect(shownSpecifications(product).find((group) => group.group === 'TECHNICAL')?.rows[0]?.value).toBe('750');
  });

  it('stores one row per label, groups in order', () => {
    const rows = productRowsFrom(
      listingContentSchema.parse({
        specifications: [
          { group: 'WARRANTY', rows: [{ label: 'Warranty', value: '1 year' }] },
          { group: 'GENERAL', rows: [{ label: 'Model', value: 'A', highlight: true }] },
        ],
      }),
    );
    expect(rows.map((entry) => [entry.groupKey, entry.name, entry.sortOrder, entry.isHighlight])).toEqual([
      ['GENERAL', 'Model', 0, true],
      ['WARRANTY', 'Warranty', 1, false],
    ]);
  });
});

describe('description sections for a reader', () => {
  const base = { altText: null, image: null, sortOrder: 0 };
  it('shows the reader’s language when it exists, and never a mixture', () => {
    const rows = [
      { ...base, heading: 'Overview', body: 'English', language: null },
      { ...base, heading: 'Überblick', body: 'Deutsch', language: 'de' },
    ];
    expect(descriptionSectionsFor(rows, 'de').map((section) => section.body)).toEqual(['Deutsch']);
    expect(descriptionSectionsFor(rows, 'fr').map((section) => section.body)).toEqual(['English']);
  });

  it('gives a picture words for a screen reader, never nothing', () => {
    const [section] = descriptionSectionsFor(
      [{ ...base, heading: 'The lid', body: 'x', language: null, image: { url: '/m/a.png', altText: null, width: 10, height: 10 } }],
      null,
    );
    expect(section?.image?.alt).toBe('The lid');
  });
});
