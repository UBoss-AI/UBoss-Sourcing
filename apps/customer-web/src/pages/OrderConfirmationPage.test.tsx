/**
 * The confirmation page.
 *
 * The property under test is the one this page could most easily break: **an
 * order that has been placed has not necessarily been paid.** A payment-link
 * order sits at Pending payment for as long as it takes somebody to open the
 * email, and every part of this page — the heading, the badge, the progress
 * indicator, the money column — has to keep saying so.
 */
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderConfirmationPage } from './OrderConfirmationPage';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { money } from '@/test/fixtures';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function order(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'order-1',
    orderNumber: 'UB-2026-000042',
    status: 'PENDING_PAYMENT',
    source: 'WEB',
    currency: 'INR',
    paymentMode: 'PAYMENT_LINK',
    placedAt: '2026-09-03T10:00:00.000Z',
    confirmedAt: null,
    itemCount: 1,
    createdAt: '2026-09-03T10:00:00.000Z',
    totals: {
      subtotal: money('45500'),
      discount: money('0'),
      tax: money('8190'),
      shipping: money('0'),
      grandTotal: money('53690'),
      paid: money('0'),
      refunded: money('0'),
    },
    items: [],
    timeline: [],
    shippingAddress: null,
    billingAddress: null,
    shippingMethodName: null,
    customerNote: null,
    cancelReason: null,
    shipments: [],
    approval: null,
    ...overrides,
  };
}

function serve(body: Record<string, unknown>): void {
  fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ order: body })));
}

function renderConfirmation(): void {
  renderWithProviders(
    <Routes>
      <Route path="/order-confirmation/:orderId" element={<OrderConfirmationPage />} />
    </Routes>,
    { route: '/order-confirmation/order-1' },
  );
}

describe('OrderConfirmationPage', () => {
  it('says the order was placed, never that it was paid', async () => {
    serve(order());
    renderConfirmation();

    expect(await screen.findByText('Your order has been placed')).toBeInTheDocument();
    expect(screen.queryByText(/payment confirmed/i)).not.toBeInTheDocument();
    expect(screen.getByText('Awaiting payment')).toBeInTheDocument();
  });

  it('leaves the payment step waiting while the order is unpaid', async () => {
    serve(order());
    renderConfirmation();

    const progress = await screen.findByRole('navigation', { name: /checkout progress/i });

    // The words the marker contributes to a screen reader. "waiting", not
    // "completed" — a placed order is not a paid one.
    expect(progress).toHaveTextContent('Payment: waiting');
    expect(progress).not.toHaveTextContent('Payment: completed');
    expect(progress).toHaveTextContent('Not paid yet');
  });

  it('ticks the payment step once the order is settled', async () => {
    serve(
      order({
        status: 'CONFIRMED',
        paymentMode: 'ONLINE',
        totals: {
          subtotal: money('45500'),
          discount: money('0'),
          tax: money('8190'),
          shipping: money('0'),
          grandTotal: money('53690'),
          paid: money('53690'),
          refunded: money('0'),
        },
      }),
    );
    renderConfirmation();

    const progress = await screen.findByRole('navigation', { name: /checkout progress/i });
    expect(progress).toHaveTextContent('Payment: completed');
    expect(progress).not.toHaveTextContent('Not paid yet');
  });

  it('shows the order reference and a route back to the order history', async () => {
    serve(order());
    renderConfirmation();

    expect(await screen.findByText('UB-2026-000042')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /all your orders|your order history/i }).length)
      .toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /track this order/i })).toHaveAttribute(
      'href',
      '/account/orders/order-1',
    );
  });

  it('never renders the emailed payment link or its token', async () => {
    serve(order());
    renderConfirmation();

    await screen.findByText('Payment link sent');

    // The token exists only inside that email, and the customer order API does
    // not carry it. This asserts the page has not grown a way to show one.
    expect(document.body.innerHTML).not.toContain('/pay/');
    expect(screen.getByText(/appears only in that email/i)).toBeInTheDocument();
  });

  it('offers to pay now only when the customer is the one who can pay', async () => {
    serve(order({ paymentMode: 'ONLINE' }));
    renderConfirmation();

    expect(await screen.findByRole('link', { name: /pay for this order/i })).toHaveAttribute(
      'href',
      '/checkout/payment/order-1',
    );
  });

  it('does not offer to pay a payment-link order from this page', async () => {
    serve(order());
    renderConfirmation();

    await screen.findByText('Payment link sent');
    expect(screen.queryByRole('link', { name: /pay for this order/i })).not.toBeInTheDocument();
  });
});
