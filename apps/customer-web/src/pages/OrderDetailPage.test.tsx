/**
 * The order page's progress timeline.
 *
 * Every order in the development database sits at a single status, so the
 * multi-entry timeline — the rail, the ticked history, the one open marker at
 * the bottom — is not reachable by clicking through the running app. It is
 * reachable here.
 *
 * The property worth pinning: **the timeline shows where the order has got
 * to, and claims nothing beyond that.** Entries behind the latest are done;
 * the latest is the current state and is marked as such in words; nothing
 * after it is drawn at all, because the backend has not said what comes next.
 */
import { screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderDetailPage } from './OrderDetailPage';
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
    status: 'SHIPPED',
    source: 'WEB',
    currency: 'INR',
    paymentMode: 'ONLINE',
    placedAt: '2026-09-01T10:00:00.000Z',
    confirmedAt: '2026-09-01T10:05:00.000Z',
    itemCount: 1,
    createdAt: '2026-09-01T10:00:00.000Z',
    totals: {
      subtotal: money('45500'),
      discount: money('0'),
      tax: money('8190'),
      shipping: money('0'),
      grandTotal: money('53690'),
      paid: money('53690'),
      refunded: money('0'),
    },
    items: [],
    timeline: [
      { at: '2026-09-01T10:00:00.000Z', to: 'PENDING_PAYMENT', reason: 'Checkout submitted' },
      { at: '2026-09-01T10:05:00.000Z', to: 'CONFIRMED', reason: null },
      { at: '2026-09-02T09:00:00.000Z', to: 'SHIPPED', reason: null },
    ],
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

function renderDetail(): void {
  renderWithProviders(
    <Routes>
      <Route path="/account/orders/:id" element={<OrderDetailPage />} />
    </Routes>,
    { route: '/account/orders/order-1' },
  );
}

/** The Progress panel, by its own heading. */
async function progressPanel(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: 'Progress' });
  const section = heading.closest('section');
  if (section === null) throw new Error('No Progress section');
  return section;
}

describe('OrderDetailPage progress timeline', () => {
  it('lists every status the order has actually been through, oldest first', async () => {
    serve(order());
    renderDetail();

    const entries = within(await progressPanel()).getAllByRole('listitem');

    expect(entries).toHaveLength(3);
    expect(entries[0]).toHaveTextContent('Awaiting payment');
    expect(entries[1]).toHaveTextContent('Confirmed');
    expect(entries[2]).toHaveTextContent('On its way');
  });

  it('names the latest entry as the current status, in words rather than colour', async () => {
    serve(order());
    renderDetail();

    const entries = within(await progressPanel()).getAllByRole('listitem');

    expect(entries[2]).toHaveTextContent('— current status');
    expect(entries[0]).not.toHaveTextContent('— current status');
    expect(entries[1]).not.toHaveTextContent('— current status');
  });

  it('draws nothing beyond the latest entry', async () => {
    serve(order({ status: 'CONFIRMED', timeline: [
      { at: '2026-09-01T10:00:00.000Z', to: 'PENDING_PAYMENT', reason: null },
      { at: '2026-09-01T10:05:00.000Z', to: 'CONFIRMED', reason: null },
    ] }));
    renderDetail();

    const panel = await progressPanel();

    expect(within(panel).getAllByRole('listitem')).toHaveLength(2);
    // No speculative "Shipped" or "Delivered" step the backend never reported.
    expect(within(panel).queryByText('On its way')).not.toBeInTheDocument();
    expect(within(panel).queryByText('Delivered')).not.toBeInTheDocument();
  });

  it('keeps the reason the backend gave for a step', async () => {
    serve(order());
    renderDetail();

    expect(within(await progressPanel()).getByText('Checkout submitted')).toBeInTheDocument();
  });

  it('labels an order from a schedule without dressing it as a problem', async () => {
    serve(order({ source: 'RECURRING' }));
    renderDetail();

    // Teal, and phrased as provenance. `orderStatusTone` owns the alarm
    // colours; this chip is not one of them.
    expect(await screen.findByText('From a repeat purchase')).toBeInTheDocument();
  });

  it('offers payment only on an order the customer can pay themselves', async () => {
    serve(order({ status: 'PENDING_PAYMENT', paymentMode: 'PAYMENT_LINK' }));
    renderDetail();

    await screen.findByRole('heading', { name: 'Progress' });
    expect(screen.queryByRole('link', { name: /pay for this order/i })).not.toBeInTheDocument();
  });
});
