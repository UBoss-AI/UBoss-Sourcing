/**
 * The narrowing variant selector, on the five shapes it has to serve.
 *
 * Footwear, clothing, packaged food, a laptop and a cable reel — deliberately
 * the five worked examples, because between them they cover every behaviour
 * that is easy to get wrong: a dependent size system, a semantic size run, a
 * pack count that is not a cart quantity, a three-axis configuration, and a
 * measurement that has to sort numerically rather than as text.
 *
 * The product page's other test file covers the option LIST — the multiple
 * choice a hospital buyer uses. Both live side by side because both are real
 * ways this catalogue is bought from, and a regression in either is a
 * regression.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes, useLocation } from 'react-router-dom';
import { ProductPage } from './ProductPage';
import { jsonResponse, makeSession, renderWithProviders } from '@/test/harness';
import { makeProduct, money } from '@/test/fixtures';
import type { Product, ProductVariant, VariantAxisDefinition } from '@/lib/types';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function axis(key: string, overrides: Partial<VariantAxisDefinition> = {}): VariantAxisDefinition {
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

/**
 * The axis definitions the storefront fetches once per session, keyed by
 * shelf.
 *
 * Per shelf rather than one global map, and the two size axes below are why:
 * a shoe's size is a numeric run and a shirt's is a semantic one, and a single
 * definition of "size" hangs a shirt rail in the order L, M, S, XL.
 */
const TEMPLATES: Record<string, VariantAxisDefinition[]> = {
  footwear: [
    axis('size_system', { label: 'Size system' }),
    axis('size', { label: 'Size', input: 'NUMERIC', display: 'SIZE_BUTTONS', sort: 'NUMERIC' }),
    axis('colour', { label: 'Colour', input: 'COLOUR', display: 'SWATCHES' }),
  ],
  'workwear-uniforms': [
    axis('size', { label: 'Size', display: 'SIZE_BUTTONS', sort: 'APPAREL' }),
    axis('colour', { label: 'Colour', input: 'COLOUR', display: 'SWATCHES' }),
    axis('sleeve_length', { label: 'Sleeve' }),
  ],
  'seeds-feed-fertiliser': [
    axis('preparation', { label: 'Preparation' }),
    axis('net_weight', { label: 'Net weight', input: 'MEASUREMENT', sort: 'NUMERIC' }),
    axis('pack_count', { label: 'Pack size', input: 'PACK_COUNT', sort: 'NUMERIC' }),
  ],
  'laptops-desktops': [
    axis('ram', { label: 'RAM' }),
    axis('storage', { label: 'Storage' }),
    axis('colour', { label: 'Colour', input: 'COLOUR', display: 'SWATCHES' }),
  ],
  'cables-wiring': [
    axis('cores', { label: 'Number of cores', input: 'NUMERIC', sort: 'NUMERIC' }),
    axis('cross_section', {
      label: 'Cross-sectional area',
      input: 'MEASUREMENT',
      sort: 'NUMERIC',
    }),
    axis('length', { label: 'Length', input: 'MEASUREMENT', sort: 'NUMERIC' }),
  ],
};

function renderProduct(
  product: Product,
  options: { route?: string; onAdd?: (body: string) => Response } = {},
): void {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST' && url.includes('/cart/items')) {
      const handler = options.onAdd;
      return Promise.resolve(
        handler === undefined
          ? jsonResponse({ cart: { itemCount: 1 } }, 201)
          : handler(typeof init?.body === 'string' ? init.body : ''),
      );
    }

    if (url.includes('/catalog/variant-axes')) {
      return Promise.resolve(
        jsonResponse({
          templates: Object.fromEntries(
            Object.entries(TEMPLATES).map((entry) => [
              entry[0],
              { label: entry[0], axes: entry[1] },
            ]),
          ),
        }),
      );
    }

    return Promise.resolve(jsonResponse({ product }));
  });

  renderWithProviders(
    <Routes>
      <Route
        path="/product/:slug"
        element={
          <>
            <ProductPage />
            <SearchProbe />
          </>
        }
      />
    </Routes>,
    { route: options.route ?? `/product/${product.slug}`, session: makeSession() },
  );
}

/**
 * The query string, as the router holds it.
 *
 * The harness renders under a MemoryRouter, which deliberately never writes to
 * `window.location` — so the only way to assert that a choice reached the URL
 * is to read it from the router the page is actually using.
 */
function SearchProbe(): React.JSX.Element {
  return <span data-testid="router-search">{useLocation().search}</span>;
}

function variant(
  id: string,
  options: Record<string, string>,
  overrides: Partial<ProductVariant> = {},
): ProductVariant {
  return {
    id,
    sku: id.toUpperCase(),
    name: Object.values(options).join(' / '),
    options,
    price: money('499900'),
    availableQty: null,
    ...overrides,
  };
}

/** The group of buttons for one axis, so assertions cannot cross axes. */
function group(label: string): HTMLElement {
  return screen.getByRole('radiogroup', { name: new RegExp(label, 'i') });
}

// ---------------------------------------------------------------------------
// 1. FOOTWEAR
// ---------------------------------------------------------------------------

/** Black runs 6–7, brown runs 7–8. Black 7 is out of stock; black 8 is not sold. */
function safetyShoe(): Product {
  return makeProduct({
    name: "Men's Industrial Safety Shoe",
    slug: 'mens-industrial-safety-shoe',
    hasVariants: true,
    variantTemplateSlug: 'footwear',
    variantAxisKeys: ['size_system', 'size', 'colour'],
    purchaseRules: { minOrderQty: 1, maxOrderQty: null, qtyIncrement: 1, isRecurringEligible: false },
    variants: [
      variant('v1', { size_system: 'UK/India', size: '6', colour: 'Black' }, { availableQty: 4 }),
      variant('v2', { size_system: 'UK/India', size: '7', colour: 'Black' }, { availableQty: 0 }),
      variant('v3', { size_system: 'UK/India', size: '7', colour: 'Brown' }, { availableQty: 2 }),
      variant(
        'v4',
        { size_system: 'UK/India', size: '8', colour: 'Brown' },
        { availableQty: 9, price: money('549900') },
      ),
    ],
  });
}

describe('footwear', () => {
  it('sorts the size run numerically, not as text', async () => {
    renderProduct(
      makeProduct({
        ...safetyShoe(),
        variants: [
          variant('a', { size_system: 'UK/India', size: '10', colour: 'Black' }),
          variant('b', { size_system: 'UK/India', size: '8', colour: 'Black' }),
          variant('c', { size_system: 'UK/India', size: '9', colour: 'Black' }),
        ],
      }),
    );

    const sizes = await screen.findByRole('radiogroup', { name: /^size$/i });
    // Alphabetical would give 10, 8, 9 — which is not a size run.
    expect(within(sizes).getAllByRole('radio').map((button) => button.textContent)).toEqual([
      '8',
      '9',
      '10',
    ]);
  });

  it('answers the size system by itself when there is only one', async () => {
    renderProduct(safetyShoe());

    // One value is not a choice, it is a click. The axis is answered and the
    // control is not drawn at all.
    await screen.findByRole('radiogroup', { name: /^size$/i });
    expect(screen.queryByRole('radiogroup', { name: /size system/i })).not.toBeInTheDocument();
  });

  it('distinguishes out of stock from not offered once a colour is chosen', async () => {
    const user = userEvent.setup();
    renderProduct(safetyShoe());

    await user.click(await screen.findByRole('radio', { name: /colour: black/i }));

    // Black 7 exists and there are none left; black 8 has never been sold.
    // Two different sentences, and a buyer has to be able to tell them apart.
    expect(screen.getByRole('radio', { name: /size: 7, out of stock/i })).toBeDisabled();
    expect(
      screen.getByRole('radio', { name: /size: 8, not available in this combination/i }),
    ).toBeDisabled();
    expect(screen.getByRole('radio', { name: /^size: 6$/i })).toBeEnabled();
  });

  it('refuses Add to Basket until the choice is complete, and says what is missing', async () => {
    const user = userEvent.setup();
    const posts: string[] = [];
    renderProduct(safetyShoe(), {
      onAdd: (body) => {
        posts.push(body);
        return jsonResponse({ cart: { itemCount: 1 } }, 201);
      },
    });

    const add = await screen.findByRole('button', { name: /add to (cart|basket)/i });
    await user.click(add);

    // Nothing was sent, and the page said which control to go to rather than
    // sitting there greyed out with no explanation.
    expect(posts).toHaveLength(0);
    expect(await screen.findByRole('alert')).toHaveTextContent(/choose a size/i);

    // And the caret is on the first unanswered control.
    await waitFor(() => {
      expect(within(group('^size$')).getAllByRole('radio')[0]).toHaveFocus();
    });
  });

  it('sends exactly one line, naming the variant the choice resolved to', async () => {
    const user = userEvent.setup();
    const posts: string[] = [];
    renderProduct(safetyShoe(), {
      onAdd: (body) => {
        posts.push(body);
        return jsonResponse({ cart: { itemCount: 1 } }, 201);
      },
    });

    await user.click(await screen.findByRole('radio', { name: /colour: brown/i }));
    await user.click(screen.getByRole('radio', { name: /^size: 8$/i }));
    await user.click(screen.getByRole('button', { name: /add to (cart|basket)/i }));

    await waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    const sent = JSON.parse(posts[0] ?? '{}') as { items: { variantId: string }[] };
    expect(sent.items).toHaveLength(1);
    expect(sent.items[0]?.variantId).toBe('v4');
  });

  it('puts the choice in the URL so the page can be shared', async () => {
    const user = userEvent.setup();
    renderProduct(safetyShoe());

    await user.click(await screen.findByRole('radio', { name: /colour: brown/i }));

    await waitFor(() => {
      expect(screen.getByTestId('router-search')).toHaveTextContent('colour=brown');
    });
  });

  it('opens on the variant a shared link names', async () => {
    renderProduct(safetyShoe(), {
      route: '/product/mens-industrial-safety-shoe?colour=brown&size=8',
    });

    // Restored, not merely remembered: the page opens with the choice made,
    // which is what makes a link somebody sent worth following.
    const colours = await screen.findByRole('radiogroup', { name: /colour/i });
    expect(within(colours).getByRole('radio', { name: /brown/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /^size: 8$/i })).toBeChecked();
  });

  it('ignores a link naming a colour this product does not sell', async () => {
    renderProduct(safetyShoe(), {
      route: '/product/mens-industrial-safety-shoe?colour=purple&size=8',
    });

    const colours = await screen.findByRole('radiogroup', { name: /colour/i });
    for (const button of within(colours).getAllByRole('radio')) {
      expect(button).not.toBeChecked();
    }
  });

  it('can be worked entirely from the keyboard', async () => {
    const user = userEvent.setup();
    renderProduct(safetyShoe());

    const sizes = await screen.findByRole('radiogroup', { name: /^size$/i });
    const six = within(sizes).getByRole('radio', { name: /^size: 6$/i });

    six.focus();
    await user.keyboard('{Enter}');

    expect(six).toBeChecked();
  });
});

// ---------------------------------------------------------------------------
// 2. CLOTHING
// ---------------------------------------------------------------------------

describe('clothing', () => {
  it('hangs the size run the way a rail does, not alphabetically', async () => {
    renderProduct(
      makeProduct({
        name: 'Unisex Cotton Workwear Shirt',
        slug: 'unisex-cotton-workwear-shirt',
        hasVariants: true,
        variantTemplateSlug: 'workwear-uniforms',
        variantAxisKeys: ['size', 'colour', 'sleeve_length'],
        variants: ['XL', 'S', '2XL', 'M', 'L'].map((size) =>
          variant(`s-${size}`, { size, colour: 'Navy', sleeve_length: 'Half sleeve' }),
        ),
      }),
    );

    const sizes = await screen.findByRole('radiogroup', { name: /^size$/i });
    // The storefront is told APPAREL by the server's axis definition. Without
    // it, localeCompare gives L, M, S, XL, 2XL — a word list, not a size run.
    expect(within(sizes).getAllByRole('radio').map((button) => button.textContent)).toEqual([
      'S',
      'M',
      'L',
      'XL',
      '2XL',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. PUMPKIN SEEDS — pack count is not cart quantity
// ---------------------------------------------------------------------------

describe('packaged goods', () => {
  function seeds(): Product {
    return makeProduct({
      name: 'Premium Pumpkin Seeds',
      slug: 'premium-pumpkin-seeds',
      hasVariants: true,
      variantTemplateSlug: 'seeds-feed-fertiliser',
      variantAxisKeys: ['preparation', 'net_weight', 'pack_count'],
      purchaseRules: {
        minOrderQty: 1,
        maxOrderQty: null,
        qtyIncrement: 1,
        isRecurringEligible: false,
      },
      variants: [
        variant(
          'seed-1',
          { preparation: 'Raw', net_weight: '500 g', pack_count: '10' },
          {
            price: money('62000'),
            multipackCount: 10,
            netContentValue: '500',
            netContentUnit: 'g',
          },
        ),
        variant(
          'seed-2',
          { preparation: 'Raw', net_weight: '500 g', pack_count: '1' },
          {
            price: money('7500'),
            multipackCount: 1,
            netContentValue: '500',
            netContentUnit: 'g',
          },
        ),
      ],
    });
  }

  it('states what one pack contains, so the total is not a surprise', async () => {
    const user = userEvent.setup();
    renderProduct(seeds());

    await user.click(await screen.findByRole('radio', { name: /pack size: 10/i }));

    expect(screen.getByText(/Pack of 10/)).toBeInTheDocument();
    expect(screen.getByText(/Each pack contains 5000 g in total/)).toBeInTheDocument();
  });

  it('keeps the pack count out of the quantity, and says what two packs come to', async () => {
    const user = userEvent.setup();
    renderProduct(seeds());

    await user.click(await screen.findByRole('radio', { name: /pack size: 10/i }));

    const quantity = screen.getByRole('spinbutton', { name: /quantity/i });
    await user.clear(quantity);
    await user.type(quantity, '2');

    // Two PACKS — twenty packets, ten kilograms. Not a "Pack of 20", which is
    // a variant nobody stocks.
    expect(
      await screen.findByText(/2 packs is 20 units, 10000 g in total/),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 4. LAPTOP
// ---------------------------------------------------------------------------

describe('configurable electronics', () => {
  it('offers only the configurations the seller actually builds', async () => {
    const user = userEvent.setup();
    renderProduct(
      makeProduct({
        name: 'Business Laptop',
        slug: 'business-laptop',
        hasVariants: true,
        variantTemplateSlug: 'laptops-desktops',
        variantAxisKeys: ['ram', 'storage', 'colour'],
        variants: [
          variant('l1', { ram: '8 GB', storage: '256 GB SSD', colour: 'Silver' }),
          variant('l2', { ram: '16 GB', storage: '512 GB SSD', colour: 'Silver' }),
          variant('l3', { ram: '16 GB', storage: '1 TB SSD', colour: 'Black' }),
        ],
      }),
    );

    await user.click(await screen.findByRole('radio', { name: /ram: 8 gb/i }));

    // 8 GB is only built with 256 GB. Offering the other two and failing at
    // the basket is the behaviour this whole feature exists to prevent.
    expect(screen.getByRole('radio', { name: /storage: 256 GB SSD/i })).toBeEnabled();
    expect(
      screen.getByRole('radio', { name: /storage: 512 GB SSD, not available/i }),
    ).toBeDisabled();
    expect(screen.getByRole('radio', { name: /storage: 1 TB SSD, not available/i })).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// 5. INDUSTRIAL CABLE
// ---------------------------------------------------------------------------

describe('measured industrial goods', () => {
  it('sorts a measurement by its number, and keeps its unit', async () => {
    renderProduct(
      makeProduct({
        name: 'Industrial Copper Cable',
        slug: 'industrial-copper-cable',
        hasVariants: true,
        variantTemplateSlug: 'cables-wiring',
        variantAxisKeys: ['cores', 'cross_section', 'length'],
        variants: [
          variant('c1', { cores: '4', cross_section: '10 mm2', length: '100 m' }),
          variant('c2', { cores: '4', cross_section: '1.5 mm2', length: '100 m' }),
          variant('c3', { cores: '4', cross_section: '2.5 mm2', length: '100 m' }),
        ],
      }),
    );

    const areas = await screen.findByRole('radiogroup', { name: /cross-sectional area/i });
    // As text, "10 mm2" sorts before "1.5 mm2". As a measurement it does not.
    expect(within(areas).getAllByRole('radio').map((button) => button.textContent)).toEqual([
      '1.5 mm2',
      '2.5 mm2',
      '10 mm2',
    ]);
  });
});

// ---------------------------------------------------------------------------
// BACKWARD COMPATIBILITY
// ---------------------------------------------------------------------------

describe('products that declare no axes', () => {
  it('keeps the multiple-choice option list, so Medical Devices is untouched', async () => {
    renderProduct(
      makeProduct({
        hasVariants: true,
        // No `variantAxisKeys` at all — every product that existed before this
        // feature, and every medical listing after it.
        variants: [
          variant('m1', { Size: '3 ml' }, { name: '3 ml' }),
          variant('m2', { Size: '5 ml' }, { name: '5 ml' }),
        ],
      }),
    );

    // The option list, where several can be chosen at once.
    expect(await screen.findByText(/pick as many/i)).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('shows no selector at all for a product with one variant per axis', async () => {
    renderProduct(
      makeProduct({
        hasVariants: true,
        variantTemplateSlug: 'footwear',
        variantAxisKeys: ['colour'],
        variants: [variant('only', { colour: 'Black' })],
      }),
    );

    await screen.findByRole('spinbutton', { name: /quantity/i });
    // One colour is not a choice. Drawing a selector with a single
    // pre-selected button asks a question with one answer.
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// THE CATALOGUE THAT WAS ALREADY ON SALE
// ---------------------------------------------------------------------------

describe('availability on products that declare no axes', () => {
  it('marks a sold-out option in the list, and will not let it be ticked', async () => {
    renderProduct(
      makeProduct({
        hasVariants: true,
        variants: [
          variant('m1', { Size: '3 ml' }, { name: '3 ml', isInStock: true }),
          variant('m2', { Size: '5 ml' }, { name: '5 ml', isInStock: false }),
        ],
      }),
    );

    // The option list — every product listed before variant axes existed uses
    // it, and until now it said nothing at all about availability.
    const soldOut = await screen.findByRole('button', { name: /5 ml, out of stock/i });
    expect(soldOut).toBeDisabled();

    expect(screen.getByRole('button', { name: /3 ml/i })).toBeEnabled();
  });

  it('blocks Add to Cart for a single-item product with nothing behind it', async () => {
    renderProduct(makeProduct({ hasVariants: false, variants: [], isInStock: false }));

    const add = await screen.findByRole('button', { name: /add to (cart|basket)/i });
    expect(add).toBeDisabled();
  });

  it('treats an untracked product as purchasable, not as empty', async () => {
    // Null means "we do not count these", which is not "there are none".
    renderProduct(makeProduct({ hasVariants: false, variants: [], isInStock: null }));

    const add = await screen.findByRole('button', { name: /add to (cart|basket)/i });
    expect(add).toBeEnabled();
  });
});
