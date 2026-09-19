/**
 * Browser-side variant resolution.
 *
 * Deliberately asserts the same cases as
 * `backend/tests/unit/variant-resolver.test.ts` and
 * `backend/tests/unit/variant-commerce.test.ts`. The two implementations are a
 * mirror rather than a shared package, and a mirror is only safe while both
 * halves are held to the same examples — so when one of these changes, the
 * other is expected to change with it.
 */
import { describe, expect, it } from 'vitest';
import {
  lineContent,
  normaliseValue,
  resolveVariants,
  rulesForVariant,
  selectionForVariant,
  selectionFromParams,
  selectionToParams,
  sortAxisValues,
  summarisePack,
} from './variants';
import type { ProductVariant, VariantAxisDefinition } from './types';
import { money } from '@/test/fixtures';

function definition(
  key: string,
  overrides: Partial<VariantAxisDefinition> = {},
): VariantAxisDefinition {
  return {
    key,
    label: key,
    input: 'TEXT_SELECT',
    display: 'CHIPS',
    sort: 'GIVEN',
    units: null,
    dependsOn: [],
    inTitle: true,
    ...overrides,
  };
}

const DEFINITIONS: Record<string, VariantAxisDefinition> = {
  size_system: definition('size_system', { label: 'Size system' }),
  size: definition('size', {
    label: 'Size',
    input: 'NUMERIC',
    display: 'SIZE_BUTTONS',
    sort: 'NUMERIC',
    dependsOn: ['size_system'],
  }),
  colour: definition('colour', { label: 'Colour', input: 'COLOUR', display: 'SWATCHES' }),
};

const AXES = ['size_system', 'size', 'colour'];

function shoe(
  id: string,
  colour: string,
  size: string,
  availableQty: number | null = null,
  priceMinor = '499900',
): ProductVariant {
  return {
    id,
    sku: id.toUpperCase(),
    name: `${colour} ${size}`,
    options: { size_system: 'UK/India', size, colour },
    price: money(priceMinor),
    availableQty,
  };
}

/** Black runs 6–7, brown runs 7–8. There is no black 8 at all. */
const SHOES: ProductVariant[] = [
  shoe('v1', 'Black', '6', 4),
  shoe('v2', 'Black', '7', 0),
  shoe('v3', 'Brown', '7', 2, '529900'),
  shoe('v4', 'Brown', '8', 9, '549900'),
];

const statesOf = (resolution: ReturnType<typeof resolveVariants>, key: string) =>
  resolution.axes
    .find((axis) => axis.key === key)
    ?.values.map((value) => `${value.label}:${value.state}`) ?? [];

describe('normaliseValue', () => {
  it('folds case, spacing and punctuation', () => {
    expect(normaliseValue('UK 8')).toBe('uk-8');
    expect(normaliseValue('  Uk   8 ')).toBe('uk-8');
  });

  it('folds the letters that do not decompose, so German values survive', () => {
    // Without this, "Größe" becomes "gro-e" and collides with "Gro E" — and a
    // shared link built on one spelling resolves to nothing on the other.
    expect(normaliseValue('Größe')).toBe('grosse');
    expect(normaliseValue('Crème')).toBe('creme');
  });
});

describe('sortAxisValues', () => {
  it('puts 8 before 10', () => {
    expect(sortAxisValues(['10', '8', '9'], 'NUMERIC')).toEqual(['8', '9', '10']);
  });

  it('hangs apparel sizes as a rail does', () => {
    expect(sortAxisValues(['XL', 'S', 'M', '2XL', 'L'], 'APPAREL')).toEqual([
      'S',
      'M',
      'L',
      'XL',
      '2XL',
    ]);
  });

  it('leaves a given order alone', () => {
    expect(sortAxisValues(['Roasted', 'Raw'], 'GIVEN')).toEqual(['Roasted', 'Raw']);
  });
});

describe('resolveVariants', () => {
  it('offers the whole run before anything is chosen', () => {
    const resolution = resolveVariants(AXES, DEFINITIONS, SHOES, {});
    expect(statesOf(resolution, 'size')).toEqual([
      '6:AVAILABLE',
      '7:AVAILABLE',
      '8:AVAILABLE',
    ]);
    expect(resolution.isComplete).toBe(false);
  });

  it('tells "out of stock" and "not offered" apart once a colour is chosen', () => {
    const resolution = resolveVariants(AXES, DEFINITIONS, SHOES, { colour: 'Black' });

    // Black 7 exists and there are none. Black 8 has never been sold.
    expect(statesOf(resolution, 'size')).toEqual([
      '6:AVAILABLE',
      '7:OUT_OF_STOCK',
      '8:NOT_OFFERED',
    ]);
  });

  it('keeps the other colours live, so a shopper can change their mind', () => {
    // An axis never disables itself on its own answer. Picking black must not
    // grey out brown, or the only way back is to reload the page.
    const resolution = resolveVariants(AXES, DEFINITIONS, SHOES, { colour: 'Black' });
    expect(statesOf(resolution, 'colour')).toEqual(['Black:AVAILABLE', 'Brown:AVAILABLE']);
  });

  it('closes a colour off once a size it does not come in is chosen', () => {
    // Black 6 is on offer and brown starts at 7, so with size 6 held, brown is
    // genuinely not something that can be bought — and saying so is the point.
    // Switching colour then means changing the size too, which the buyer can
    // do by tapping 6 again.
    const resolution = resolveVariants(AXES, DEFINITIONS, SHOES, { colour: 'Black', size: '6' });
    expect(statesOf(resolution, 'colour')).toEqual(['Black:AVAILABLE', 'Brown:NOT_OFFERED']);
  });

  it('identifies one variant from a complete selection', () => {
    const resolution = resolveVariants(AXES, DEFINITIONS, SHOES, {
      size_system: 'UK/India',
      colour: 'Brown',
      size: '8',
    });

    expect(resolution.isComplete).toBe(true);
    expect(resolution.variant?.id).toBe('v4');
    expect(resolution.missingAxisKeys).toEqual([]);
  });

  it('blocks size until the size system is answered', () => {
    const before = resolveVariants(AXES, DEFINITIONS, SHOES, {});
    expect(before.axes.find((axis) => axis.key === 'size')?.isBlocked).toBe(true);

    const after = resolveVariants(AXES, DEFINITIONS, SHOES, { size_system: 'UK/India' });
    expect(after.axes.find((axis) => axis.key === 'size')?.isBlocked).toBe(false);
  });

  it('narrows the price range as the choice narrows', () => {
    expect(resolveVariants(AXES, DEFINITIONS, SHOES, {}).priceRange).toEqual({
      min: money('499900'),
      max: money('549900'),
    });

    expect(
      resolveVariants(AXES, DEFINITIONS, SHOES, { colour: 'Black' }).priceRange,
    ).toEqual({ min: money('499900'), max: money('499900') });
  });

  it('reads the boolean the server actually sends, not a quantity', () => {
    // The public API publishes `isInStock` and never a figure. If the resolver
    // only understood a quantity, OUT_OF_STOCK could never appear in the real
    // app and every empty size would read as "not offered".
    const stocked: ProductVariant[] = [
      { ...shoe('a', 'Black', '6'), isInStock: true },
      { ...shoe('b', 'Black', '7'), isInStock: false },
    ];

    expect(statesOf(resolveVariants(AXES, DEFINITIONS, stocked, {}), 'size')).toEqual([
      '6:AVAILABLE',
      '7:OUT_OF_STOCK',
    ]);
  });

  it('treats an unpublished stock figure as purchasable, not as zero', () => {
    // This storefront never publishes warehouse quantities. A selector that
    // greyed everything out on a shop that hides its numbers is unusable.
    const hidden = [shoe('v9', 'Green', '9', null)];
    expect(statesOf(resolveVariants(AXES, DEFINITIONS, hidden, {}), 'size')).toEqual([
      '9:AVAILABLE',
    ]);
  });

  it('refuses to complete when two rows match the same selection', () => {
    const duplicated = [shoe('a', 'Black', '6', 1), shoe('b', 'Black', '6', 1)];
    const resolution = resolveVariants(AXES, DEFINITIONS, duplicated, {
      size_system: 'UK/India',
      colour: 'Black',
      size: '6',
    });

    expect(resolution.matchCount).toBe(2);
    expect(resolution.isComplete).toBe(false);
    expect(resolution.variant).toBeNull();
  });
});

describe('links', () => {
  it('reads a shared link whatever spelling it carries', () => {
    const params = new URLSearchParams({ colour: 'BROWN', size: '8' });
    expect(selectionFromParams(AXES, params, SHOES)).toEqual({ colour: 'Brown', size: '8' });
  });

  it('drops a value no variant offers, rather than opening on nothing', () => {
    const params = new URLSearchParams({ colour: 'Purple', size: '8' });
    expect(selectionFromParams(AXES, params, SHOES)).toEqual({ size: '8' });
  });

  it('writes the selection back folded', () => {
    expect(selectionToParams({ colour: 'Brown', size: '8' })).toEqual({
      colour: 'brown',
      size: '8',
    });
  });

  it('round-trips a known variant', () => {
    const selection = selectionForVariant(AXES, SHOES[3]!);
    const resolution = resolveVariants(AXES, DEFINITIONS, SHOES, selection);
    expect(resolution.variant?.id).toBe('v4');
  });
});

describe('packs', () => {
  const seeds: ProductVariant = {
    id: 'seed-500-10',
    sku: 'SEED-500-10',
    name: 'Raw / 500 g / Pack of 10',
    options: { preparation: 'Raw', net_weight: '500 g', pack_count: '10' },
    price: money('62000'),
    multipackCount: 10,
    netContentValue: '500',
    netContentUnit: 'g',
  };

  it('multiplies net content by the pack count', () => {
    expect(summarisePack(seeds).totalContent).toEqual({ value: '5000', unit: 'g' });
  });

  it('keeps pack count and cart quantity apart', () => {
    const summary = summarisePack(seeds);

    // Two packs is twenty packets and 10 kg — NOT a "Pack of 20".
    expect(lineContent(summary, 2)).toEqual({ value: '10000', unit: 'g' });
    expect(summary.multipackCount).toBe(10);
  });

  it('says nothing where the seller stated no content', () => {
    expect(summarisePack({ ...seeds, netContentValue: null }).totalContent).toBeNull();
  });

  it('does the arithmetic without a float', () => {
    const tenth = summarisePack({
      ...seeds,
      multipackCount: 3,
      netContentValue: '0.1',
      netContentUnit: 'kg',
    });
    expect(tenth.totalContent).toEqual({ value: '0.3', unit: 'kg' });
  });
});

describe('rulesForVariant', () => {
  const product = { minOrderQty: 10, qtyIncrement: 5, maxOrderQty: null };

  it('falls back to the product where the variant says nothing', () => {
    expect(rulesForVariant(product, SHOES[0]!)).toEqual(product);
  });

  it('honours the variant where it trades on its own terms', () => {
    const pallet: ProductVariant = { ...SHOES[0]!, minOrderQty: 24, qtyIncrement: 24 };
    expect(rulesForVariant(product, pallet)).toEqual({
      minOrderQty: 24,
      qtyIncrement: 24,
      maxOrderQty: null,
    });
  });

  it('uses the product rules when nothing is chosen yet', () => {
    expect(rulesForVariant(product, null)).toEqual(product);
  });
});
