/**
 * The resolver, tested against the shape of a real catalogue.
 *
 * The case that matters most is the one a naive selector always gets wrong:
 * black runs to size 7, brown runs to size 10, and a buyer who has picked
 * black must not be offered a size 8 that does not exist in black - while a
 * buyer who has picked nothing yet must still see the whole size run.
 */
import { describe, expect, it } from 'vitest';
import { findTemplate, resolveActiveAxes } from '../../src/domain/variants/registry.js';
import {
  resolveVariants,
  selectionForVariant,
  selectionFromParams,
  type ResolvableVariant,
} from '../../src/domain/variants/resolver.js';

const footwearAxes = resolveActiveAxes(findTemplate(['footwear']), [
  'size_system',
  'size',
  'colour',
]);

function shoe(
  id: string,
  colour: string,
  size: string,
  availableQty: number | null,
  priceMinor: bigint | null = 499900n,
): ResolvableVariant {
  return {
    id,
    sku: id.toUpperCase(),
    options: { size_system: 'UK/India', size, colour },
    isActive: true,
    availableQty,
    priceMinor,
  };
}

/** Black: 6, 7. Brown: 7 (out of stock), 8. No black 8 is sold at all. */
const shoes: ResolvableVariant[] = [
  shoe('v1', 'Black', '6', 4),
  shoe('v2', 'Black', '7', 0),
  shoe('v3', 'Brown', '7', 2, 529900n),
  shoe('v4', 'Brown', '8', 9, 549900n),
];

const axisOf = (
  resolution: ReturnType<typeof resolveVariants>,
  key: string,
): { label: string; state: string }[] =>
  resolution.axes.find((entry) => entry.key === key)?.values.map((entry) => ({
    label: entry.label,
    state: entry.state,
  })) ?? [];

describe('resolveVariants with nothing chosen', () => {
  const resolution = resolveVariants(footwearAxes, shoes, {});

  it('offers every value any live variant carries', () => {
    expect(axisOf(resolution, 'size').map((entry) => entry.label)).toEqual(['6', '7', '8']);
    expect(axisOf(resolution, 'colour').map((entry) => entry.label)).toEqual(['Black', 'Brown']);
  });

  it('sorts numeric sizes numerically', () => {
    const many = [...shoes, shoe('v5', 'Brown', '10', 1), shoe('v6', 'Brown', '9', 1)];
    const sizes = axisOf(resolveVariants(footwearAxes, many, {}), 'size').map(
      (entry) => entry.label,
    );
    expect(sizes).toEqual(['6', '7', '8', '9', '10']);
  });

  it('names every unanswered axis, first one first', () => {
    expect(resolution.missingAxisKeys).toEqual(['size_system', 'size', 'colour']);
    expect(resolution.isComplete).toBe(false);
    expect(resolution.variantId).toBeNull();
  });

  it('gives a price range across everything still reachable', () => {
    expect(resolution.priceRange).toEqual({ minMinor: 499900n, maxMinor: 549900n });
  });

  it('marks a size out of stock only when EVERY variant offering it is empty', () => {
    // Size 7 exists in black (0) and brown (2), so it is still available.
    expect(axisOf(resolution, 'size')).toEqual([
      { label: '6', state: 'AVAILABLE' },
      { label: '7', state: 'AVAILABLE' },
      { label: '8', state: 'AVAILABLE' },
    ]);
  });
});

describe('resolveVariants once a colour is chosen', () => {
  const resolution = resolveVariants(footwearAxes, shoes, { colour: 'Black' });

  it('distinguishes not offered from out of stock', () => {
    expect(axisOf(resolution, 'size')).toEqual([
      { label: '6', state: 'AVAILABLE' },
      // Black 7 exists; there are none left.
      { label: '7', state: 'OUT_OF_STOCK' },
      // There is no black 8. Nothing to wait for.
      { label: '8', state: 'NOT_OFFERED' },
    ]);
  });

  it('still offers the other colours, so the buyer can change their mind', () => {
    expect(axisOf(resolution, 'colour')).toEqual([
      { label: 'Black', state: 'AVAILABLE' },
      { label: 'Brown', state: 'AVAILABLE' },
    ]);
  });

  it('narrows the price range to what is still reachable', () => {
    expect(resolution.priceRange).toEqual({ minMinor: 499900n, maxMinor: 499900n });
  });
});

describe('resolveVariants with a complete selection', () => {
  const resolution = resolveVariants(footwearAxes, shoes, {
    size_system: 'UK/India',
    colour: 'Brown',
    size: '8',
  });

  it('identifies exactly one variant', () => {
    expect(resolution.isComplete).toBe(true);
    expect(resolution.variantId).toBe('v4');
    expect(resolution.matchCount).toBe(1);
    expect(resolution.missingAxisKeys).toEqual([]);
  });

  it('matches whatever the seller typed, however it was spelled in the request', () => {
    const loose = resolveVariants(footwearAxes, shoes, {
      size_system: 'uk/india',
      colour: ' brown ',
      size: '8',
    });
    expect(loose.variantId).toBe('v4');
  });
});

describe('resolveVariants edge cases', () => {
  it('ignores an inactive variant entirely', () => {
    const withArchived: ResolvableVariant[] = [
      ...shoes,
      { ...shoe('v9', 'Green', '8', 5), isActive: false },
    ];
    const resolution = resolveVariants(footwearAxes, withArchived, {});
    expect(axisOf(resolution, 'colour').map((entry) => entry.label)).toEqual(['Black', 'Brown']);
  });

  it('treats an unpublished stock figure as purchasable, not as zero', () => {
    const hidden = [shoe('v1', 'Black', '6', null)];
    const resolution = resolveVariants(footwearAxes, hidden, {});
    expect(axisOf(resolution, 'size')).toEqual([{ label: '6', state: 'AVAILABLE' }]);
  });

  it('blocks a dependent axis until its prerequisite is answered', () => {
    const resolution = resolveVariants(footwearAxes, shoes, {});
    expect(resolution.axes.find((entry) => entry.key === 'size')?.isBlocked).toBe(true);

    const answered = resolveVariants(footwearAxes, shoes, { size_system: 'UK/India' });
    expect(answered.axes.find((entry) => entry.key === 'size')?.isBlocked).toBe(false);
  });

  it('refuses to call a selection complete when two rows match it', () => {
    const duplicated = [shoe('a', 'Black', '6', 1), shoe('b', 'Black', '6', 1)];
    const resolution = resolveVariants(footwearAxes, duplicated, {
      size_system: 'UK/India',
      colour: 'Black',
      size: '6',
    });

    expect(resolution.matchCount).toBe(2);
    expect(resolution.isComplete).toBe(false);
    expect(resolution.variantId).toBeNull();
  });

  it('falls back to the product family price for a variant with no override', () => {
    const inheriting = [shoe('v1', 'Black', '6', 1, null)];
    const resolution = resolveVariants(footwearAxes, inheriting, {}, 250000n);
    expect(resolution.priceRange).toEqual({ minMinor: 250000n, maxMinor: 250000n });
  });

  it('reports no range at all when nothing is priced', () => {
    const unpriced = [shoe('v1', 'Black', '6', 1, null)];
    expect(resolveVariants(footwearAxes, unpriced, {}, null).priceRange).toBeNull();
  });

  it('handles a product with no variants without throwing', () => {
    const resolution = resolveVariants(footwearAxes, [], {});
    expect(resolution.matchCount).toBe(0);
    expect(resolution.isComplete).toBe(false);
    expect(resolution.missingAxisKeys).toEqual([]);
  });
});

describe('selection round trips', () => {
  it('rebuilds the selection that names a known variant', () => {
    expect(selectionForVariant(footwearAxes, shoes[3]!)).toEqual({
      size_system: 'UK/India',
      size: '8',
      colour: 'Brown',
    });
  });

  it('reads a shared link, folding whatever spelling it carries', () => {
    expect(selectionFromParams(footwearAxes, { colour: 'BROWN', size: '8' }, shoes)).toEqual({
      colour: 'Brown',
      size: '8',
    });
  });

  it('drops a link value no variant offers, rather than opening on an impossible state', () => {
    expect(selectionFromParams(footwearAxes, { colour: 'Purple', size: '8' }, shoes)).toEqual({
      size: '8',
    });
  });

  it('ignores a parameter for an axis this product does not use', () => {
    expect(selectionFromParams(footwearAxes, { voltage: '230 V' }, shoes)).toEqual({});
  });
});
