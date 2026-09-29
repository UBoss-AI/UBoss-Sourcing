/**
 * Ordering an order's lines again reports each line's own outcome.
 *
 * The property worth pinning: **one refused line does not stop the lines after
 * it, and the customer is told which line was refused and why.** Before, the
 * loop stopped at the first refusal with a generic message and nothing said
 * which items had already gone into the cart.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderDetailPage } from './OrderDetailPage';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';
import { money } from '@/test/fixtures';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function item(id: string, productId: string, name: string): Record<string, unknown> {
  return {
    id,
    productId,
    variantId: null,
    name,
    sku: `SKU-${id}`,
    variantName: null,
    imageUrl: null,
    quantity: 3,
    unitPrice: money('1000'),
    lineSubtotal: money('3000'),
    discount: money('0'),
    taxAmount: money('0'),
    lineTotal: money('3000'),
    taxRatePercent: '0',
    taxInclusive: false,
  };
}

function order(): Record<string, unknown> {
  return {
    id: 'order-1',
    orderNumber: 'UB-2026-000042',
    status: 'DELIVERED',
    source: 'WEB',
    currency: 'INR',
    paymentMode: 'ONLINE',
    placedAt: '2026-09-01T10:00:00.000Z',
    confirmedAt: '2026-09-01T10:05:00.000Z',
    itemCount: 3,
    createdAt: '2026-09-01T10:00:00.000Z',
    totals: {
      subtotal: money('9000'),
      discount: money('0'),
      tax: money('0'),
      shipping: money('0'),
      grandTotal: money('9000'),
      paid: money('9000'),
      refunded: money('0'),
    },
    items: [item('i1', 'p1', 'Alpha Gloves'), item('i2', 'p2', 'Beta Masks'), item('i3', 'p3', 'Gamma Gowns')],
    timeline: [{ at: '2026-09-01T10:00:00.000Z', to: 'DELIVERED', reason: null }],
    shippingAddress: null,
    billingAddress: null,
    shippingMethodName: null,
    customerNote: null,
    cancelReason: null,
    shipments: [],
    approval: null,
  };
}

function renderDetail(): void {
  renderWithProviders(
    <Routes>
      <Route path="/account/orders/:id" element={<OrderDetailPage />} />
      <Route path="/cart" element={<p>Cart page</p>} />
    </Routes>,
    { route: '/account/orders/order-1' },
  );
}

describe('OrderDetailPage order again', () => {
  it('keeps going past a refused line and reports every line', async () => {
    const posted: string[] = [];

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/cart/items')) {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { productId: string };
        posted.push(body.productId);
        if (body.productId === 'p2') {
          return Promise.resolve(errorResponse(409, 'PRODUCT_UNAVAILABLE', 'Beta Masks is no longer sold.'));
        }
        return Promise.resolve(jsonResponse({ cart: {} }, 201));
      }
      if (!url.includes('/documents/') && /\/orders\/order-1(\?|$)/.test(url)) return Promise.resolve(jsonResponse({ order: order() }));
      return Promise.resolve(errorResponse(404, 'NOT_FOUND', 'Nothing here.'));
    });

    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: 'Order these again' }));

    // Every line was tried, including the one after the refusal.
    await waitFor(() => {
      expect(posted).toEqual(['p1', 'p2', 'p3']);
    });

    expect(await screen.findByText(/^2 of 3 items were added to your cart at today's prices\.$/)).toBeInTheDocument();
    expect(screen.getByText(/Not added: Beta Masks is no longer sold\./)).toBeInTheDocument();
    expect(screen.getAllByText(/— Added to your cart$/)).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Go to your cart' })).toHaveAttribute('href', '/cart');
    // Stays on the order page rather than jumping away from the report.
    expect(screen.queryByText('Cart page')).not.toBeInTheDocument();
  });

  it('goes straight to the cart when every line was added', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/cart/items')) {
        return Promise.resolve(jsonResponse({ cart: {} }, 201));
      }
      if (!url.includes('/documents/') && /\/orders\/order-1(\?|$)/.test(url)) return Promise.resolve(jsonResponse({ order: order() }));
      return Promise.resolve(errorResponse(404, 'NOT_FOUND', 'Nothing here.'));
    });

    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: 'Order these again' }));

    expect(await screen.findByText('Cart page')).toBeInTheDocument();
  });
});
