/**
 * The greeting page's product list, and the rule it enforces: **the list is
 * on the page, and nothing takes it away.**
 *
 * Two earlier rules were tried and are recorded in the tests below, because
 * both are the kind of thing somebody re-invents. Revealing the list only once
 * the Products *tab* had been pressed saved one catalogue read and left that
 * tab sitting visibly selected, blue underline and all, with nothing beneath
 * it. Tying it to which tab was current then meant choosing AI Mode unmounted
 * it. Every item in that row is a link to a page now, and none of them is a
 * state this page can be in, so the list is simply part of the page.
 *
 * Two things here are worth more than the rest.
 *
 * **The read count.** Exactly one request per market, asserted — the section
 * mounting twice, or a stale second query key, both show up here and nowhere
 * else.
 *
 * **That nothing scrolls.** The spy on `scrollIntoView` is what stops the old
 * reveal-and-scroll behaviour coming back by accident: on arrival, moving the
 * page past the headline somebody came to read is its own bug.
 */
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from './HomePage';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { jsonResponse, errorResponse, makeSession, renderWithProviders } from '@/test/harness';
import type { StorefrontConfig } from '@/lib/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The assistant on, which is what puts all three items in the hero row. */
function makeConfig(features: Partial<StorefrontConfig['features']> = {}): StorefrontConfig {
  return {
    ...FALLBACK_CONFIG,
    features: { ...FALLBACK_CONFIG.features, assistant: true, ...features },
  };
}

const GUEST = makeSession({ user: null, isCustomer: false });

function makeProduct(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'prod-1',
    name: 'IV Administration Set',
    slug: 'iv-administration-set',
    sku: 'IV-001',
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
    purchaseRules: { minOrderQty: 1, maxOrderQty: null, qtyIncrement: 1, isRecurringEligible: false },
    category: null,
    isStockTracked: false,
    hasVariants: false,
    publishedAt: '2026-09-01T00:00:00.000Z',
    primaryImage: null,
    images: [],
    attributes: [],
    variants: [],
    ...overrides,
  };
}

const fetchMock = vi.fn();

/** Every URL the greeting page might touch, and nothing it should not. */
function serve({
  products = [makeProduct()],
  productsFail = false,
}: { products?: Record<string, unknown>[]; productsFail?: boolean } = {}): void {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/catalog/categories')) {
      return Promise.resolve(jsonResponse({ categories: [] }));
    }

    if (url.includes('/catalog/products')) {
      if (productsFail) {
        return Promise.resolve(
          errorResponse(503, 'SERVICE_UNAVAILABLE', 'The catalogue is unavailable.'),
        );
      }

      return Promise.resolve(
        jsonResponse({
          products,
          pagination: { page: 1, limit: 12, total: products.length, totalPages: 1 },
          currency: 'INR',
          country: 'IN',
        }),
      );
    }

    return Promise.resolve(jsonResponse({}));
  });
}

/**
 * The row of destinations above the search bar.
 *
 * Named, because the whole page is full of navigation and the assertions below
 * are about this row in particular — the sourcing graphic above it carries its
 * own link to the same AI page, under the same name.
 */
const HERO_ROW_LABEL = 'Home, the AI Assistant, or the catalogue';

function heroRow(): HTMLElement {
  return screen.getByRole('navigation', { name: HERO_ROW_LABEL });
}

/** Which catalogue reads have been made. The point of most of these tests. */
function productReads(): string[] {
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

// ---------------------------------------------------------------------------

describe('the greeting page product list', () => {
  it('is on the page, unconditionally', async () => {
    renderWithProviders(<HomePage />, { config: makeConfig(), session: GUEST });

    // The bar above it searches the catalogue and this is the catalogue. It
    // used to come and go with a tab; AI Mode is a link to its own page now,
    // so there is no state this section can be on the wrong side of.
    const section = await screen.findByRole('region', { name: 'Products' });
    expect(await within(section).findByText('IV Administration Set')).toBeInTheDocument();

    // One read, for the market the page is quoting in. Not two: a second
    // request here would mean the section had mounted twice.
    expect(productReads()).toHaveLength(1);
    expect(productReads()[0]).toContain('currency=INR');
  });

  it('does not scroll the page down on arrival', async () => {
    // jsdom has no `scrollIntoView`, so this needs a spy to assert the
    // negative at all. The rule it protects outlived the mechanism that made
    // it necessary: the section once scrolled itself into view when a tab
    // press revealed it, and dragging somebody past the headline they came to
    // read — before they have touched anything — was always the wrong half of
    // that behaviour. Nothing reveals it any more, so nothing should scroll.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    renderWithProviders(<HomePage />, { config: makeConfig(), session: GUEST });
    await screen.findByRole('region', { name: 'Products' });

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('stays put when the AI Assistant is offered beside it, because that is a link away', async () => {
    renderWithProviders(<HomePage />, { config: makeConfig(), session: GUEST });

    await screen.findByRole('region', { name: 'Products' });

    // Scoped to the search row, because the sourcing graphic above carries a
    // node with the same name pointing at the same page — which is the point
    // of them sharing it, and also why an unscoped query here would match two.
    expect(within(heroRow()).getByRole('link', { name: /AI Assistant/ })).toHaveAttribute(
      'href',
      '/ai',
    );
    expect(screen.getByRole('region', { name: 'Products' })).toBeInTheDocument();
    expect(productReads()).toHaveLength(1);
  });

  it('offers a way back when the catalogue read fails', async () => {
    serve({ productsFail: true });

    renderWithProviders(<HomePage />, { config: makeConfig(), session: GUEST });

    // A landing page whose product strip could not load is still a landing
    // page — the hero above it works perfectly well — so this reports rather
    // than replacing the page with an error wall.
    expect(await screen.findByRole('button', { name: /Try again/i })).toBeInTheDocument();
    expect(within(heroRow()).getByRole('link', { name: /AI Assistant/ })).toBeInTheDocument();
  });

  it('says so plainly when the catalogue is empty', async () => {
    serve({ products: [] });

    renderWithProviders(<HomePage />, { config: makeConfig(), session: GUEST });

    // A fresh deployment has nothing published, which is an ordinary answer
    // rather than a fault.
    expect(await screen.findByText('Nothing is published yet')).toBeInTheDocument();
  });

  it('still lists products on a deployment with no assistant, and keeps the row', async () => {
    // With no AI provider the row loses its middle item and keeps Home and
    // Products, which are pages every deployment has. The catalogue below is
    // unaffected — it never depended on the row.
    renderWithProviders(<HomePage />, {
      config: makeConfig({ assistant: false }),
      session: GUEST,
    });

    const row = screen.getByRole('navigation', { name: 'Home, or the catalogue' });
    expect(within(row).getByRole('link', { name: 'Products' })).toHaveAttribute(
      'href',
      '/products',
    );
    expect(within(row).queryByRole('link', { name: /AI Assistant/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Products' })).toBeInTheDocument();
  });
});
