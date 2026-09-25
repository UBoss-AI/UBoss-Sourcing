/**
 * Editing a listing that already exists.
 *
 * What is worth asserting here is what a seller would notice was wrong:
 *
 *   - **The form arrives filled in.** An edit screen that opens blank is one
 *     that quietly creates a second product.
 *   - **The options it already sells along are ticked, with the values it
 *     actually stocks.** Not the template's suggestions — what is on the shelf.
 *   - **A live listing has the matrix locked** and is offered the pause with
 *     the sentence about orders, which is the thing sellers worry about.
 *   - **The save carries the version it opened on** and every row, so the
 *     server can refuse a stale write and match combinations by signature.
 *   - **Both finishes are offered**, and each says what it does.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { SellerListingEditPage } from './SellerListingEditPage';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import type {
  ListingEditVariantRow,
  ListingEditView,
  VariantTemplateAxis,
} from '@/lib/seller';

const fetchMock = vi.fn<typeof fetch>();

const OFFER_ID = 'O1'.padEnd(26, '0');
const LOCATION_ID = 'L1'.padEnd(26, '0');
const MEDIA_ID = 'M1'.padEnd(26, '0');

function axis(key: string, label: string, suggestions: string[]): VariantTemplateAxis {
  return {
    key,
    label,
    importance: 'RECOMMENDED',
    input: 'TEXT_SELECT',
    display: 'CHIPS',
    suggestions,
    allowsCustomValues: true,
    affectsSku: true,
    isFilterable: true,
    inTitle: true,
    sortOrder: 0,
    sort: 'GIVEN',
  };
}

/** One size this seller already sells, priced and in stock. */
function size(value: string, over: Partial<ListingEditVariantRow> = {}): ListingEditVariantRow {
  return {
    offerId: `OF${value}`.padEnd(26, '0'),
    variantId: `VA${value}`.padEnd(26, '0'),
    optionSignature: `size:${value}`,
    options: { size: value },
    name: value,
    sku: `SHOE-${value}`,
    barcode: null,
    status: 'PAUSED',
    isActive: true,
    isBaseListing: false,
    priceMinor: '249900',
    compareAtPriceMinor: null,
    minOrderQty: 1,
    qtyIncrement: 1,
    maxOrderQty: null,
    leadTimeDays: null,
    shippingWeightGrams: null,
    shippingLengthMm: null,
    shippingWidthMm: null,
    shippingHeightMm: null,
    imageMediaId: null,
    availableQuantity: 10,
    reservedQuantity: 0,
    stock: [{ locationId: LOCATION_ID, availableQuantity: 10 }],
    isOrderLinked: false,
    ...over,
  };
}

function view(over: Partial<ListingEditView> = {}): ListingEditView {
  return {
    offerId: OFFER_ID,
    version: 7,
    status: 'PAUSED',
    statusReason: null,
    sellerSku: 'SHOE-7',
    currency: 'INR',
    contentDraftId: null,
    updatedAt: '2026-09-19T09:00:00.000Z',
    pausedAt: null,
    pausedBy: null,
    isStructuralEditAllowed: true,
    structuralBlockedReason: null,
    terms: {
      priceMinor: '249900',
      compareAtPriceMinor: '299900',
      orderingUnit: 'PIECE',
      minimumOrderQuantity: 2,
      orderIncrement: 1,
      maximumOrderQuantity: null,
      handlingTimeDays: 3,
      guaranteedShelfLifeMonths: null,
      warrantyMonths: 12,
      taxClassId: 'T1'.padEnd(26, '0'),
      sellingRegions: [],
      priceTiers: [],
    },
    brand: { id: 'B1'.padEnd(26, '0'), name: 'Northwind', status: 'APPROVED' },
    product: {
      id: 'P1'.padEnd(26, '0'),
      name: 'Trail Walking Shoe',
      slug: 'trail-walking-shoe',
      categoryId: 'C1'.padEnd(26, '0'),
      categoryName: 'Footwear',
      shortDescription: 'A shoe for long walks.',
      description: null,
      gtin: null,
      modelIdentifier: null,
      weightGrams: 800,
      hasVariants: true,
      axes: ['size'],
      specifications: [{ name: 'Upper', value: 'Leather' }],
      images: [
        { mediaId: MEDIA_ID, storageKey: 'a.jpg', url: '/a.jpg', altText: 'Front', isPrimary: true },
      ],
      packaging: null,
      canEditPhotos: true,
    },
    template: {
      categorySlug: 'clothing-textiles',
      subcategorySlug: 'footwear',
      label: 'Footwear',
      axes: [axis('size', 'Size', ['7', '8', '9', '10']), axis('colour', 'Colour', ['Black'])],
    },
    variants: [size('7'), size('8'), size('9')],
    ...over,
  };
}

/**
 * The page fetches its listing and the seller's warehouses, and its trade-code
 * and quantity-price panels fetch their own.
 */
function serve(current: ListingEditView): void {
  fetchMock.mockImplementation((url) => {
    const href = typeof url === 'string' ? url : '';

    if (href.includes('/quantity-tiers')) {
      return Promise.resolve(
        jsonResponse({
          offerId: 'offer',
          currency: 'INR',
          listUnitPrice: { minor: '1000', currency: 'INR', formatted: '₹10.00' },
          tiers: [],
        }),
      );
    }

    if (href.includes('/trade-codes')) {
      return Promise.resolve(jsonResponse({ id: 'offer', hsnCode: null, countryOfOrigin: null }));
    }

    if (href.includes('/seller/locations')) {
      return Promise.resolve(
        jsonResponse({ locations: [{ id: LOCATION_ID, name: 'Main store' }], map: {} }),
      );
    }

    return Promise.resolve(jsonResponse(current));
  });
}

function render(): void {
  renderWithProviders(
    <Routes>
      <Route path="/seller/listings/:id/edit" element={<SellerListingEditPage />} />
    </Routes>,
    // A data router, because the page uses `useBlocker` to interrupt a
    // navigation away from unsaved work. `MemoryRouter` is not one.
    { route: `/seller/listings/${OFFER_ID}/edit`, dataRouter: true },
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe('the edit form', () => {
  it('opens filled in rather than blank', async () => {
    serve(view());
    render();

    // The product it is actually editing, not a "new listing" shell.
    expect(await screen.findByRole('heading', { name: 'Trail Walking Shoe' })).toBeInTheDocument();
    expect(screen.getByText('Footwear')).toBeInTheDocument();

    // The terms, in major units, in their boxes.
    expect(screen.getByLabelText(/^Price for this listing \(INR\)/)).toHaveValue('2499.00');
    expect(screen.getByLabelText(/^Recommended price for this listing/i)).toHaveValue('2999.00');
    expect(screen.getByLabelText(/^Smallest order for this listing/)).toHaveValue('2');
    expect(screen.getByLabelText(/days to dispatch/i)).toHaveValue('3');
    expect(screen.getByLabelText(/warranty/i)).toHaveValue('12');
  });

  it('ticks the options it already sells along, with the values it stocks', async () => {
    serve(view());
    render();

    // Size is on because the product declares it; Colour is not, because
    // nothing this seller stocks varies by colour.
    expect(await screen.findByRole('button', { name: /^Size/, pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Colour/, pressed: false })).toBeInTheDocument();

    // The values come from the shelf, not from the template's suggestions —
    // so 7, 8 and 9 are chosen and 10, which this seller does not stock, is not.
    const chosen = screen.getByText(/you sell 3 values/i).closest('div');
    expect(chosen).not.toBeNull();
    for (const value of ['7', '8', '9']) {
      expect(within(chosen as HTMLElement).getByText(value)).toBeInTheDocument();
    }
  });

  it('shows every version it already sells, editable', async () => {
    serve(view());
    render();

    const table = await screen.findByRole('table', { name: /every version of this listing/i });

    for (const value of ['7', '8', '9']) {
      expect(within(table).getByLabelText(`Product code for ${value}`)).toHaveValue(
        `SHOE-${value}`,
      );
      expect(within(table).getByLabelText(`Price for ${value}`)).toHaveValue('2499.00');
      expect(within(table).getByLabelText(`Stock for ${value}`)).toHaveValue('10');
      expect(within(table).getByLabelText(`Offer ${value}`)).toBeChecked();
    }
  });

  it('offers both ways to finish', async () => {
    serve(view());
    render();

    expect(await screen.findByRole('button', { name: /save as paused/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save & resume sale/i })).toBeInTheDocument();
  });
});

describe('saving', () => {
  it('sends every row and the version it opened on', async () => {
    const user = userEvent.setup();
    serve(view());
    render();

    const table = await screen.findByRole('table', { name: /every version of this listing/i });

    // Re-price one size, the ordinary reason a seller opens this screen.
    const price = within(table).getByLabelText('Price for 8');
    await user.clear(price);
    await user.type(price, '2199.00');
    await user.tab();

    await user.click(screen.getByRole('button', { name: /save as paused/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          typeof url === 'string' &&
          url.endsWith(`/seller/listings/${OFFER_ID}/edit`) &&
          (init?.method ?? '').toUpperCase() === 'PATCH',
      );
      expect(call).toBeDefined();

      const body = JSON.parse((call?.[1]?.body as string | undefined) ?? '{}') as {
        expectedVersion: number;
        finish: string;
        rows: { sku: string; priceMinor: string | null; offerId?: string | null }[];
      };

      // The version the page was built from, so a change from another tab is
      // refused rather than silently overwritten.
      expect(body.expectedVersion).toBe(7);
      expect(body.finish).toBe('PAUSED');

      // All three rows go, not just the changed one: the server matches by
      // signature and a missing row means "withdrawn".
      expect(body.rows.map((row) => row.sku).sort()).toEqual(['SHOE-7', 'SHOE-8', 'SHOE-9']);
      expect(body.rows.find((row) => row.sku === 'SHOE-8')?.priceMinor).toBe('219900');

      // The ids of the rows it already had, so nothing is recreated.
      expect(body.rows.every((row) => typeof row.offerId === 'string')).toBe(true);
    });
  });

  it('asks to resume when the seller chooses that finish', async () => {
    const user = userEvent.setup();
    serve(view());
    render();

    await user.click(await screen.findByRole('button', { name: /save & resume sale/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          typeof url === 'string' &&
          url.endsWith(`/seller/listings/${OFFER_ID}/edit`) &&
          (init?.method ?? '').toUpperCase() === 'PATCH',
      );

      const body = JSON.parse((call?.[1]?.body as string | undefined) ?? '{}') as {
        finish: string;
      };
      expect(body.finish).toBe('ACTIVE');
    });
  });
});

describe('a listing that is still on sale', () => {
  it('locks the options and offers the pause, with the sentence about orders', async () => {
    const user = userEvent.setup();
    serve(
      view({
        status: 'ACTIVE',
        isStructuralEditAllowed: false,
        structuralBlockedReason: 'Pause it before changing its options.',
        variants: [size('7', { status: 'ACTIVE' }), size('8', { status: 'ACTIVE' })],
      }),
    );
    render();

    expect(
      await screen.findByRole('heading', { name: /this listing is on sale/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/options are locked while this listing is on sale/i)).toBeInTheDocument();

    // No axis picker while it is live.
    expect(screen.queryByRole('button', { name: /^Size/ })).not.toBeInTheDocument();

    // Prices and stock still are, because those are routine changes.
    const table = screen.getByRole('table', { name: /every version of this listing/i });
    expect(within(table).getByLabelText('Price for 7')).toBeEnabled();
    expect(within(table).getByLabelText('Stock for 7')).toBeEnabled();

    await user.click(screen.getByRole('button', { name: /pause & edit/i }));

    // The wording is the feature: a seller told only "this will be paused"
    // reads it as "my orders will stop".
    expect(
      await screen.findByRole('heading', { name: /pause this product to edit\?/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/structural changes require the listing to be paused temporarily/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/existing orders will not be affected/i)).toBeInTheDocument();
  });
});

describe('a version somebody has already bought', () => {
  it('says so, so the seller knows removing it keeps the order', async () => {
    serve(view({ variants: [size('7', { isOrderLinked: true }), size('8')] }));
    render();

    const table = await screen.findByRole('table', { name: /every version of this listing/i });
    expect(within(table).getByText(/ordered before/i)).toBeInTheDocument();
  });
});

describe('photographs', () => {
  it('lets the seller who described the product change them', async () => {
    serve(view());
    render();

    expect(await screen.findByRole('button', { name: /add a photograph/i })).toBeInTheDocument();
    // The only picture cannot be removed — a product with none shows a grey
    // box in every search result.
    const gallery = screen.getByRole('list', { name: /photographs on this product/i });
    expect(within(gallery).getByRole('button', { name: /^remove$/i })).toBeDisabled();
  });

  it('explains itself to a seller who only matched an existing catalogue entry', async () => {
    const shared = view();
    serve({ ...shared, product: { ...shared.product, canEditPhotos: false } });
    render();

    expect(
      await screen.findByText(/belong to a catalogue entry somebody else described/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add a photograph/i })).not.toBeInTheDocument();
  });
});
