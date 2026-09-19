/**
 * Adding versions to a listing that is already selling.
 *
 * The case this page exists for is the one every catalogue is already in: a
 * suit listed as one thing, one code, one price, with a rack of four sizes
 * behind it and no way to say so. What is worth asserting is that the page
 * does not quietly invent those sizes, does not let a structural change land
 * on a live listing, and never destroys the original.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { SellerListingDetailPage } from './SellerListingDetailPage';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import type { OfferVariantsView, VariantTemplateAxis } from '@/lib/seller';

const fetchMock = vi.fn<typeof fetch>();

const OFFER_ID = 'O1'.padEnd(26, '0');
const LOCATION_ID = 'L1'.padEnd(26, '0');

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

function view(over: Partial<OfferVariantsView> = {}): OfferVariantsView {
  return {
    offerId: OFFER_ID,
    status: 'PAUSED',
    sellerSku: 'RAY-001',
    currency: 'INR',
    version: 3,
    productId: 'P1'.padEnd(26, '0'),
    productName: 'Raymond, Suits & Clothing, Ray-001',
    hasVariants: false,
    isEditable: true,
    blockedReason: null,
    template: {
      categorySlug: 'clothing-textiles',
      subcategorySlug: 'everyday-clothing',
      label: 'Everyday Clothing',
      axes: [axis('size', 'Size', ['38', '40', '42', '44'])],
    },
    existing: [
      {
        offerId: OFFER_ID,
        sellerSku: 'RAY-001',
        status: 'PAUSED',
        priceMinor: '799900',
        compareAtPriceMinor: null,
        availableQuantity: 5,
        isBaseListing: true,
        variantId: null,
        name: null,
        options: {},
        optionSignature: '',
        inventory: [],
      },
    ],
    ...over,
  };
}

/** The page fetches its listing and the seller's warehouses. */
function serve(current: OfferVariantsView): void {
  fetchMock.mockImplementation((url) => {
    const href = typeof url === 'string' ? url : '';

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
      <Route path="/seller/listings/:id" element={<SellerListingDetailPage />} />
    </Routes>,
    { route: `/seller/listings/${OFFER_ID}` },
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

describe('a listing published without versions', () => {
  it('says so, and shows the single line it does sell', async () => {
    serve(view());
    render();

    expect(await screen.findByText(/this listing has no versions yet/i)).toBeInTheDocument();

    // The original is listed as what it is, not as a blank row. Scoped to the
    // table because the code is also in the breadcrumb.
    const table = screen.getByRole('table', { name: /versions of this product/i });
    expect(within(table).getByText(/no particular version/i)).toBeInTheDocument();
    expect(within(table).getByText('RAY-001')).toBeInTheDocument();
  });

  it('offers the category\'s sizes without ticking any of them', async () => {
    const user = userEvent.setup();
    serve(view());
    render();

    await user.click(await screen.findByRole('button', { name: /^Size/ }));

    // A suit is not assumed to come in 38 to 44 because suits usually do.
    for (const size of ['38', '40', '42', '44']) {
      expect(screen.getByRole('button', { name: size, pressed: false })).toBeInTheDocument();
    }
  });

  it('builds a row per chosen size, priced from the original listing', async () => {
    const user = userEvent.setup();
    serve(view());
    render();

    await user.click(await screen.findByRole('button', { name: /^Size/ }));
    await user.click(screen.getByRole('button', { name: '38', pressed: false }));
    await user.click(screen.getByRole('button', { name: '40', pressed: false }));
    await user.click(screen.getByRole('button', { name: /create 2 combinations/i }));

    const table = await screen.findByRole('table', { name: /versions to add/i });
    expect(within(table).getByLabelText('Code for 38')).toHaveValue('RAY-001-38');
    // Seeded from the listing's own price rather than left blank or zeroed.
    expect(within(table).getByLabelText('Price for 38')).toHaveValue('7999.00');
  });

  it('sends only the rows the seller kept ticked', async () => {
    const user = userEvent.setup();
    serve(view());
    render();

    await user.click(await screen.findByRole('button', { name: /^Size/ }));
    await user.click(screen.getByRole('button', { name: '38', pressed: false }));
    await user.click(screen.getByRole('button', { name: '40', pressed: false }));
    await user.click(screen.getByRole('button', { name: /create 2 combinations/i }));

    const table = await screen.findByRole('table', { name: /versions to add/i });
    await user.click(within(table).getByLabelText('Add 40'));
    await user.click(screen.getByRole('button', { name: /add 1 version$/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          typeof url === 'string' &&
          url.endsWith(`/seller/listings/${OFFER_ID}/variants`) &&
          (init?.method ?? '').toUpperCase() === 'POST',
      );
      expect(call).toBeDefined();

      const body = JSON.parse((call?.[1]?.body as string | undefined) ?? '{}') as {
        rows: { sku: string }[];
        expectedVersion: number;
      };

      expect(body.rows.map((row) => row.sku)).toEqual(['RAY-001-38']);
      // The version the page was opened on, so a change from another tab is
      // refused rather than silently overwritten.
      expect(body.expectedVersion).toBe(3);
    });
  });
});

describe('a listing that is still on sale', () => {
  it('refuses the structural change and offers the pause instead', async () => {
    serve(
      view({
        status: 'ACTIVE',
        isEditable: false,
        blockedReason: 'Pause this listing before adding versions.',
      }),
    );
    render();

    expect(await screen.findByText(/pause before adding versions/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pause this listing/i })).toBeInTheDocument();

    // And says the thing a seller actually worries about before pressing it.
    expect(screen.getByText(/orders already placed are not affected/i)).toBeInTheDocument();

    // No axis picker while it is live.
    expect(screen.queryByRole('button', { name: /^Size/ })).not.toBeInTheDocument();
  });
});
