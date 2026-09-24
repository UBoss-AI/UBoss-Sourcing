/**
 * The bulk-savings popover: says what the server priced, offers the next band,
 * routes an over-stock quantity to a preorder, and stays dismissed.
 */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { BulkSavingsPopover } from './BulkSavingsPopover';

const money = (minor: string, formatted: string) => ({ minor, currency: 'INR', formatted });

function pricing(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    offerId: 'offer',
    sellerName: 'Tube Co',
    currency: 'INR',
    quantity: 480,
    listUnitPrice: money('1000', '₹10.00'),
    current: {
      unitPrice: money('950', '₹9.50'),
      lineTotal: money('456000', '₹4,560.00'),
      savingBasisPoints: 500,
      saving: money('24000', '₹240.00'),
      tierMinQuantity: 100,
    },
    next: {
      minQuantity: 500,
      addQuantity: 20,
      unitPrice: money('920', '₹9.20'),
      savingPerPiece: money('30', '₹0.30'),
      savingBasisPoints: 800,
    },
    ladder: [],
    preorderBands: [],
    units: [
      {
        unit: 'PIECE',
        piecesPerUnit: 1,
        unitPrice: money('950', '₹9.50'),
        perPiece: money('950', '₹9.50'),
        savingBasisPoints: 500,
        bestPerPiece: money('920', '₹9.20'),
        wholeUnitsInStock: 20000,
        requiresFreightQuote: false,
      },
      {
        unit: 'CARTON',
        piecesPerUnit: 50,
        unitPrice: money('47000', '₹470.00'),
        perPiece: money('940', '₹9.40'),
        savingBasisPoints: 600,
        bestPerPiece: money('940', '₹9.40'),
        wholeUnitsInStock: 400,
        requiresFreightQuote: false,
      },
    ],
    stockBaseUnits: 20000,
    exceedsStock: false,
    preorderAvailable: true,
    approximate: null,
    ...overrides,
  };
}

function stub(body: unknown) {
  const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(body)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function Where(): React.JSX.Element {
  const location = useLocation();
  return <p data-testid="where">{location.search}</p>;
}

function renderPopover(onSetPieces?: (pieces: number) => void) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/product/:slug"
        element={
          <>
            <BulkSavingsPopover
              productId="01PRODUCT00000000000000000"
              variantId={null}
              pieces={480}
              displayCurrency="INR"
              onSetPieces={onSetPieces}
            />
            <Where />
          </>
        }
      />
    </Routes>,
    { route: '/product/tubing' },
  );
}

/** The product page's quantity box, reduced to what the popover watches. */
function Stepper({ start }: { start: number }): React.JSX.Element {
  const [pieces, setPieces] = useState(start);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setPieces((n) => n + 20);
        }}
      >
        more
      </button>
      <button
        type="button"
        onClick={() => {
          setPieces((n) => n - 20);
        }}
      >
        fewer
      </button>
      <BulkSavingsPopover
        productId="01PRODUCT00000000000000000"
        variantId={null}
        pieces={pieces}
        displayCurrency="INR"
      />
    </>
  );
}

describe('BulkSavingsPopover', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names the next band and sets the quantity to reach it', async () => {
    stub(pricing());
    const onSetPieces = vi.fn();
    renderPopover(onSetPieces);

    expect(
      await screen.findByText(
        'At this quantity you pay ₹9.50 each (5% off). Add 20 more pieces and save another ₹0.30 per piece.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Carton of 50 pieces')).toBeInTheDocument();
    expect(screen.getByText('₹9.40')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change quantity to 500' }));
    expect(onSetPieces).toHaveBeenCalledWith(500);
  });

  it('shows the suggestion without a button where the page counts in something else', async () => {
    stub(pricing());
    renderPopover(undefined);
    await screen.findByText(/Add 20 more pieces/);
    expect(screen.queryByRole('button', { name: /Change quantity/ })).not.toBeInTheDocument();
  });

  it('routes a quantity above the stock to a preorder', async () => {
    stub(pricing({ exceedsStock: true, stockBaseUnits: 300 }));
    renderPopover();

    expect(await screen.findByText(/The seller has 300 pieces in stock/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Preorder a larger quantity' }));
    await waitFor(() => {
      expect(screen.getByTestId('where')).toHaveTextContent('preorder=1');
    });
  });

  it('renders nothing for a product that cannot be bought', async () => {
    const fetchMock = stub({ available: false });
    renderPopover();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(screen.queryByText('Bulk savings')).not.toBeInTheDocument();
  });

  it('plays the galaxy when the quantity goes up, then hands over to the savings', async () => {
    stub(pricing());
    renderWithProviders(<Stepper start={480} />, { route: '/product/tubing' });
    await screen.findByText(/Add 20 more pieces/);

    fireEvent.click(screen.getByRole('button', { name: 'more' }));
    expect(await screen.findByText('Checking bulk prices for 500 pieces…')).toBeInTheDocument();
    // The savings card comes back once the new figures are in.
    expect(
      await screen.findByText(/Add 20 more pieces/, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Checking bulk prices/)).not.toBeInTheDocument();
  });

  it('pops up on every increment, even on a product with no bulk discount', async () => {
    const plain = pricing({
      next: null,
      ladder: [],
      preorderBands: [],
      current: {
        unitPrice: money('1000', '₹10.00'),
        lineTotal: money('500000', '₹5,000.00'),
        savingBasisPoints: 0,
        saving: money('0', '₹0.00'),
        tierMinQuantity: null,
      },
      quantity: 500,
      units: [
        {
          unit: 'PIECE',
          piecesPerUnit: 1,
          unitPrice: money('1000', '₹10.00'),
          perPiece: money('1000', '₹10.00'),
          savingBasisPoints: 0,
          bestPerPiece: money('1000', '₹10.00'),
          wholeUnitsInStock: 20000,
          requiresFreightQuote: false,
        },
      ],
    });
    const fetchMock = stub(plain);
    renderWithProviders(<Stepper start={480} />, { route: '/product/tubing' });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    // Nothing to say on its own: no card until the buyer acts.
    expect(screen.queryByText('Bulk savings')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'more' }));
    expect(await screen.findByText('Checking bulk prices for 500 pieces…')).toBeInTheDocument();
    expect(
      await screen.findByText(
        'No bulk discount on this product yet: 500 pieces at ₹10.00 each come to ₹5,000.00.',
        {},
        { timeout: 4000 },
      ),
    ).toBeInTheDocument();
  });

  it('does not play the galaxy when the quantity goes down', async () => {
    stub(pricing());
    renderWithProviders(<Stepper start={480} />, { route: '/product/tubing' });
    await screen.findByText(/Add 20 more pieces/);

    fireEvent.click(screen.getByRole('button', { name: 'fewer' }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.queryByText(/Checking bulk prices/)).not.toBeInTheDocument();
  });

  it('stays dismissed for this product for the session', async () => {
    stub(pricing());
    const first = renderPopover();
    fireEvent.click(await screen.findByRole('button', { name: 'Hide bulk savings' }));
    await waitFor(() => {
      expect(screen.queryByText('Bulk savings')).not.toBeInTheDocument();
    });
    first.unmount();

    const fetchMock = stub(pricing());
    renderPopover();
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(screen.queryByText('Bulk savings')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
