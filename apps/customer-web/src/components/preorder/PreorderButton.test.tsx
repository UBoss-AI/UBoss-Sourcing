/**
 * The Preorder button: always present, and truthful about what it will do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { jsonResponse, makeSession, renderWithProviders } from '@/test/harness';
import { PreorderButton } from './PreorderButton';

const AVAILABLE = {
  available: true,
  offerId: '01OFFER0000000000000000000',
  sellerName: 'Gamma Manufacturing',
  currency: 'INR',
  listUnitPriceMinor: '10000',
  instantStockBaseUnits: 500,
  units: [
    { unit: 'PIECE', baseUnits: 1 },
    { unit: 'CARTON', baseUnits: 48 },
  ],
  moq: {
    unit: 'PIECE',
    quantity: 1000,
    incrementQuantity: 100,
    maxQuantity: null,
    minimumBaseUnits: 1000,
    incrementBaseUnits: 100,
    maximumBaseUnits: null,
  },
  pricingMode: 'FIXED',
  tiers: [{ minBaseUnits: 1000, unitPriceMinor: '9000' }],
  window: {
    today: '2026-09-24',
    earliest: '2026-10-04',
    latest: null,
    decidedBy: 'PRODUCTION',
    timezone: 'Asia/Kolkata',
    hasPublishedTransit: false,
  },
  deliveryCountries: [],
  allowPartialFulfilment: false,
  allowSplitDelivery: false,
  cancellationTerms: null,
  specialInstructions: null,
};

function stubApi(eligibility: unknown, viewer: Record<string, unknown>) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes('/preorders/eligibility')) return Promise.resolve(jsonResponse({ eligibility, viewer }));
    if (url.includes('/account/addresses')) return Promise.resolve(jsonResponse({ addresses: [] }));
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function Where(): React.JSX.Element {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

function renderButton(options: { isCustomer?: boolean; route?: string; isReady?: boolean } = {}) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/product/:slug"
        element={
          <>
            <PreorderButton
              productId="01PRODUCT00000000000000000"
              productName="Examination gloves"
              imageUrl={null}
              variantId={null}
              variantName={null}
              isReady={options.isReady ?? true}
            />
            <Where />
          </>
        }
      />
      <Route path="/login" element={<Where />} />
    </Routes>,
    {
      route: options.route ?? '/product/gloves?size=m',
      session: options.isCustomer === false ? makeSession({ isCustomer: false, user: null }) : makeSession(),
    },
  );
}

describe('PreorderButton', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stays visible and disabled, saying why, when the seller has configured nothing', async () => {
    stubApi(
      {
        available: false,
        reason: 'NOT_CONFIGURED',
        message: 'x',
        offerId: null,
        sellerName: null,
      },
      { signedIn: true, isBusinessBuyer: true, addressId: null },
    );
    renderButton();

    const button = await screen.findByRole('button', { name: /preorder/i });
    await waitFor(() => {
      expect(button).toBeDisabled();
    });
    expect(
      screen.getByText('Bulk preorder configuration is not currently available for this product.'),
    ).toBeInTheDocument();
  });

  it('asks for an option first, without asking the server, when none is chosen', () => {
    const fetchMock = stubApi(AVAILABLE, { signedIn: true, isBusinessBuyer: true, addressId: null });
    renderButton({ isReady: false });

    expect(screen.getByRole('button', { name: /preorder/i })).toBeDisabled();
    expect(screen.getByText(/choose one option/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a guest to sign in and back to this product, variant and intent kept', async () => {
    stubApi(AVAILABLE, { signedIn: false, isBusinessBuyer: false, addressId: null });
    renderButton({ isCustomer: false });

    const button = await screen.findByRole('button', { name: /preorder/i });
    await waitFor(() => {
      expect(button).toBeEnabled();
    });
    fireEvent.click(button);

    const where = screen.getByTestId('where').textContent;
    expect(where.startsWith('/login?next=')).toBe(true);
    const next = decodeURIComponent(where.slice('/login?next='.length));
    expect(next).toBe('/product/gloves?size=m&preorder=1');
  });

  it('is disabled for an account with no company, with a way to add one', async () => {
    stubApi(AVAILABLE, { signedIn: true, isBusinessBuyer: false, addressId: null });
    renderButton();

    expect(await screen.findByText('Preorders are for business accounts.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /preorder/i })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Add your company' })).toHaveAttribute('href', '/account/profile');
  });

  it('opens the request form for a business buyer', async () => {
    stubApi(AVAILABLE, { signedIn: true, isBusinessBuyer: true, addressId: null });
    renderButton();

    const button = await screen.findByRole('button', { name: /preorder/i });
    await waitFor(() => {
      expect(button).toBeEnabled();
    });
    fireEvent.click(button);

    expect(await screen.findByText('Request a bulk preorder')).toBeInTheDocument();
    expect(screen.getByText('In pieces: at least 1,000, then in steps of 100.')).toBeInTheDocument();
    expect(screen.getAllByText('Nothing is charged when you send a request.').length).toBeGreaterThan(0);
  });

  it('reopens the form after sign-in and takes the intent off the address', async () => {
    stubApi(AVAILABLE, { signedIn: true, isBusinessBuyer: true, addressId: null });
    renderButton({ route: '/product/gloves?size=m&preorder=1' });

    expect(await screen.findByText('Request a bulk preorder')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('where').textContent).toBe('/product/gloves?size=m');
    });
  });
});
