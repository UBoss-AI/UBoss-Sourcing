/**
 * The buyer's answer to a revised-date or split-delivery offer: the schedule
 * with container equivalents, the full price, and three explicit actions -
 * never an order before Accept.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { jsonResponse, makeSession, renderWithProviders } from '@/test/harness';
import { PreorderDetailPage } from './PreorderDetailPage';

const ID = '01PREORDER0000000000000000';
const money = (minor: number) => ({ minor: String(minor), currency: 'INR', formatted: `₹${(minor / 100).toLocaleString('en-IN')}` });

function preorder(overrides: { stockStillAvailable?: boolean; isExpired?: boolean } = {}) {
  const offer = {
    id: '01OFFER0000000000000000000',
    revision: 2,
    author: 'SELLER',
    kind: 'SPLIT_DELIVERY',
    state: 'PROPOSED',
    quantityBaseUnits: 24_000,
    quantityInOrderedUnit: { unit: 'CONTAINER_20_FT', fullUnits: 2, remainderPieces: 0, isWholeUnits: true },
    availableNowBaseUnits: 15_000,
    stockAllocationBaseUnits: 15_000,
    installments: [
      {
        sequence: 1,
        quantityBaseUnits: 15_000,
        committedDeliveryDate: '2026-11-15',
        source: 'AVAILABLE_STOCK',
        status: 'PROPOSED',
        quantityInOrderedUnit: { unit: 'CONTAINER_20_FT', fullUnits: 1, remainderPieces: 3_000, isWholeUnits: false },
      },
      {
        sequence: 2,
        quantityBaseUnits: 9_000,
        committedDeliveryDate: '2026-11-30',
        source: 'FUTURE_SUPPLY',
        status: 'PROPOSED',
        quantityInOrderedUnit: { unit: 'CONTAINER_20_FT', fullUnits: 0, remainderPieces: 9_000, isWholeUnits: false },
      },
    ],
    unitPrice: money(9000),
    goodsTotal: money(216_000_000),
    freight: money(0),
    total: money(216_000_000),
    currency: 'INR',
    committedDeliveryDate: '2026-11-30',
    deliverySplits: null,
    note: 'First 15,000 from stock.',
    expiresAt: '2026-09-27T10:00:00.000Z',
    termsHash: 'a'.repeat(64),
    createdByLabel: 'Epsilon Gloves (seller)',
    createdAt: '2026-09-24T10:00:00.000Z',
    respondedAt: null,
    respondedByLabel: null,
    responseNote: null,
    quote: {
      subtotal: money(216_000_000),
      discount: money(0),
      tax: money(38_880_000),
      shipping: money(0),
      grandTotal: money(254_880_000),
      taxRatePercent: '18.000000',
      taxInclusive: false,
      logisticsIncluded: true,
    },
    stockStillAvailable: overrides.stockStillAvailable ?? true,
    isExpired: overrides.isExpired ?? false,
  };
  return {
    id: ID,
    requestNumber: 'PRQ-2026-000042',
    status: 'SELLER_COUNTERED',
    allowedActions: ['BUYER_CONFIRMED', 'SELLER_REVIEW_REQUIRED', 'CANCELLED', 'EXPIRED'],
    awaiting: 'BUYER',
    product: { id: 'P', variantId: 'V', name: 'Nitrile gloves — Box', slug: 'gloves', sku: 'EPS-BOX', imageUrl: null },
    seller: { id: 'S', name: 'Epsilon Gloves' },
    buyer: null,
    quantity: { orderingUnit: 'CONTAINER_20_FT', unitQuantity: 2, unitsPerPackage: 12_000, baseUnits: 24_000 },
    container: {
      unit: 'CONTAINER_20_FT',
      containers: 2,
      piecesPerContainer: 12_000,
      totalPieces: 24_000,
      cartonsPerContainer: 120,
      piecesPerCarton: 100,
      verifiedAt: null,
      version: 1,
    },
    availability: {
      atSubmission: { requested: 24_000, availableNow: 15_000, remaining: 9_000, sufficient: false },
      live: null,
    },
    stockHolds: null,
    policy: { version: 1 },
    requestedDeliveryDate: '2026-11-15',
    earliestDeliveryDate: '2026-10-04',
    timezone: 'Asia/Kolkata',
    shippingAddress: { line1: '4 Industrial Estate', city: 'Pune', postalCode: '411001', country: 'IN' },
    destinationCountry: 'IN',
    destinationWarehouseLabel: null,
    packagingPreference: null,
    transportPreference: 'ANY',
    allowPartialDelivery: false,
    purchaseOrderReference: null,
    customerNotes: null,
    handlingInstructions: null,
    pricingMode: 'FIXED',
    currency: 'INR',
    indicative: { unitPrice: money(9000), goodsTotal: money(216_000_000), tierMinBaseUnits: 10_000, displayCurrency: null, fxRate: null, fxRateAsOf: null },
    currentOffer: offer,
    offers: [offer],
    confirmed: null,
    order: null,
    sellerOrderGroupId: null,
    capacity: null,
    capacityReservedBaseUnits: null,
    expiresAt: '2026-09-27T10:00:00.000Z',
    closedReason: null,
    history: [],
    submittedAt: '2026-09-24T09:00:00.000Z',
    updatedAt: '2026-09-24T10:00:00.000Z',
    version: 3,
  };
}

function stub(body: ReturnType<typeof preorder>) {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST') {
        calls.push({ url, body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') });
        return Promise.resolve(jsonResponse({ preorder: { ...body, status: 'SELLER_REVIEW_REQUIRED', currentOffer: null } }));
      }
      if (url.includes(`/preorders/${ID}`)) return Promise.resolve(jsonResponse({ preorder: body }));
      return Promise.resolve(jsonResponse({}));
    }),
  );
  return calls;
}

function render() {
  return renderWithProviders(
    <Routes>
      <Route path="/account/preorders/:id" element={<PreorderDetailPage />} />
    </Routes>,
    { session: makeSession(), route: `/account/preorders/${ID}` },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a split-delivery offer', () => {
  it('shows the schedule, the part-filled container and the full price with tax', async () => {
    stub(preorder());
    render();
    expect(await screen.findByText(/Split delivery \(revision 2\)/)).toBeInTheDocument();
    expect(screen.getByText('Shipment 1')).toBeInTheDocument();
    expect(screen.getByText('Shipment 2')).toBeInTheDocument();
    expect(screen.getByText('= 1 × 20-ft Container and a part-filled container of 3,000 pieces')).toBeInTheDocument();
    expect(screen.getByText('= a part-filled container of 9,000 pieces')).toBeInTheDocument();
    expect(screen.getByText('Tax')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept offer' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reject offer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request a change' })).toBeInTheDocument();
  });

  it('sends a change request with the buyer’s message, and places no order', async () => {
    const user = userEvent.setup();
    const calls = stub(preorder());
    render();
    await user.click(await screen.findByRole('button', { name: 'Request a change' }));
    await user.type(screen.getByLabelText('Your message to the seller'), 'Can shipment 2 come earlier?');
    await user.click(screen.getByRole('button', { name: 'Send to the seller' }));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.url).toContain(`/preorders/${ID}/request-change`);
    expect(calls[0]?.body).toEqual({ message: 'Can shipment 2 come earlier?' });
    expect(calls.some((call) => call.url.includes('/confirm'))).toBe(false);
  });

  it('cannot be accepted once its stock has gone, and says so first', async () => {
    stub(preorder({ stockStillAvailable: false }));
    render();
    expect(await screen.findByText('Stock changed; seller revision required')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept offer' })).toBeNull();
  });

  it('cannot be accepted once it has expired', async () => {
    stub(preorder({ isExpired: true }));
    render();
    expect(await screen.findByText('Offer expired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept offer' })).toBeNull();
  });
});
