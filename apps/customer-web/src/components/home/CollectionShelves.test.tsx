/**
 * The curated shelves on the greeting page.
 *
 * Four things are worth a test here, and all four are about what happens when
 * the catalogue is not the one this file was written against - because this is
 * a product other companies buy and run, and their catalogue is theirs.
 *
 *   - **A shelf asks for its own departments.** Four slugs in one request, not
 *     four requests interleaved in the browser.
 *   - **A shelf with nothing in it renders nothing.** Not an empty grid, not a
 *     heading over a shrug. An operator who has retired a department should
 *     see the page shorten, not break.
 *   - **A shelf that fails renders nothing either.** This band is an optional
 *     enrichment; the hero, the department rail and the catalogue below it all
 *     work without it, so a 503 here must not put an error box on a landing
 *     page that is otherwise fine.
 *   - **"See all" goes somewhere true.** The link opens the catalogue narrowed
 *     to exactly the departments the shelf was sampled from - so a shopper who
 *     presses it sees all of what they were shown a sample of.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectionShelves } from './CollectionShelves';
import { COLLECTIONS } from './collections';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';

function makeProduct(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    slug: id,
    sku: id.toUpperCase(),
    shortDescription: null,
    description: null,
    descriptionHtml: null,
    price: { minor: '45000', formatted: '450.00', currency: 'INR' },
    compareAtPrice: null,
    tax: {
      code: 'GST18',
      name: 'GST 18%',
      ratePercent: '18',
      inclusive: true,
      country: 'IN',
      treatment: 'FLAT_RATE',
    },
    purchaseRules: {
      minOrderQty: 1,
      maxOrderQty: null,
      qtyIncrement: 1,
      isRecurringEligible: false,
    },
    category: null,
    isStockTracked: false,
    hasVariants: false,
    publishedAt: '2026-09-01T00:00:00.000Z',
    primaryImage: null,
    images: [],
    attributes: [],
    variants: [],
  };
}

const fetchMock = vi.fn();

/** Answer every shelf, optionally emptying or failing the ones named. */
function serve({
  empty = [],
  failing = [],
}: { empty?: string[]; failing?: string[] } = {}): void {
  fetchMock.mockImplementation((url: string) => {
    if (!url.includes('/catalog/products')) return Promise.resolve(jsonResponse({}));

    const parsed = new URL(url, 'http://localhost');
    const category = parsed.searchParams.get('category') ?? '';

    if (failing.some((slug) => category.includes(slug))) {
      return Promise.resolve(
        errorResponse(503, 'SERVICE_UNAVAILABLE', 'The catalogue is unavailable.'),
      );
    }

    const products = empty.some((slug) => category.includes(slug))
      ? []
      : [makeProduct(`p-${category || 'new'}`, `Product for ${category || 'new arrivals'}`)];

    return Promise.resolve(
      jsonResponse({
        products,
        pagination: { page: 1, limit: 6, total: products.length, totalPages: 1 },
        currency: 'INR',
        country: 'IN',
      }),
    );
  });
}

/** Every catalogue URL the band asked for. */
function reads(): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes('/catalog/products'));
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('curated shelves', () => {
  it('draws one shelf per collection, plus new arrivals', async () => {
    renderWithProviders(<CollectionShelves />);

    await screen.findByRole('region', { name: 'New arrivals' });
    expect(await screen.findByRole('region', { name: 'Business essentials' })).toBeInTheDocument();
    expect(
      await screen.findByRole('region', { name: 'Technology and electronics' }),
    ).toBeInTheDocument();

    expect(reads()).toHaveLength(COLLECTIONS.length + 1);
  });

  it('asks for a collection every department at once', async () => {
    renderWithProviders(<CollectionShelves />);
    await screen.findByRole('region', { name: 'Business essentials' });

    const technology = COLLECTIONS.find((entry) => entry.id === 'technology-electronics');
    expect(technology).toBeDefined();

    // One request carrying every slug, rather than one request per department.
    const request = reads().find((url) => url.includes('computers-it'));
    expect(request).toBeDefined();
    for (const slug of technology?.categories ?? []) {
      expect(request).toContain(encodeURIComponent(slug).replace(/%2C/g, ','));
    }
  });

  it('renders nothing at all for a shelf with no products', async () => {
    serve({ empty: ['computers-it'] });
    renderWithProviders(<CollectionShelves />);

    // The others arrive first, and then the empty one goes. It is present
    // while its read is in flight - a skeleton in the grid it will land in -
    // so the assertion is that it LEAVES rather than that it never appeared.
    await screen.findByRole('region', { name: 'Business essentials' });
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Technology and electronics' })).toBeNull();
    });
  });

  it('renders nothing at all for a shelf whose read failed', async () => {
    serve({ failing: ['home-kitchen'] });
    renderWithProviders(<CollectionShelves />);

    await screen.findByRole('region', { name: 'Business essentials' });
    await waitFor(() => {
      expect(
        screen.queryByRole('region', { name: 'Home, lifestyle and personal care' }),
      ).toBeNull();
    });

    // And no error box: this band is optional and the page around it is fine.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('links each shelf to the catalogue narrowed to its own departments', async () => {
    renderWithProviders(<CollectionShelves />);

    const shelf = await screen.findByRole('region', { name: 'Business essentials' });
    const link = within(shelf).getByRole('link', { name: 'See all' });

    const collection = COLLECTIONS.find((entry) => entry.id === 'business-essentials');
    expect(link).toHaveAttribute(
      'href',
      `/products?category=${encodeURIComponent(collection?.categories.join(',') ?? '')}`,
    );
  });

  it('shows the products it was given', async () => {
    renderWithProviders(<CollectionShelves />);

    const shelf = await screen.findByRole('region', { name: 'New arrivals' });
    expect(await within(shelf).findByText('Product for new arrivals')).toBeInTheDocument();
  });
});
