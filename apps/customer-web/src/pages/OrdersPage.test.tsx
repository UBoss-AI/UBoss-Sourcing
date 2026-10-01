/**
 * Your orders: the history, each order's status, and filtering by status.
 *
 * The filter is asserted at the request, because that is where it has to
 * happen: a list filtered in the browser would silently drop matching orders
 * beyond the first page. And a filter that matches nothing must not look like
 * a customer who has never ordered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { money } from '@/test/fixtures';
import type { OrderListItem } from '@/lib/types';
import { OrdersPage } from './OrdersPage';

const fetchMock = vi.fn();

function order(overrides: Partial<OrderListItem> = {}): OrderListItem {
  return {
    id: 'order-1',
    orderNumber: 'ORD-1001',
    status: 'SHIPPED',
    source: 'ONE_TIME',
    currency: 'INR',
    totals: {
      subtotal: money('100000'),
      discount: money('0'),
      tax: money('18000'),
      shipping: money('0'),
      grandTotal: money('118000'),
      paid: money('118000'),
      refunded: money('0'),
    },
    paymentMode: 'CARD',
    placedAt: '2026-09-20T10:00:00.000Z',
    confirmedAt: '2026-09-20T10:01:00.000Z',
    itemCount: 1,
    createdAt: '2026-09-20T10:00:00.000Z',
    ...overrides,
  };
}

function answerWith(orders: OrderListItem[]): void {
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      jsonResponse({
        orders,
        pagination: { page: 1, limit: 50, total: orders.length, totalPages: 1 },
      }),
    ),
  );
}

/** The `status` the page last asked the API for, or null for none. */
function requestedStatus(): string | null {
  const url = new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
  return url.searchParams.get('status');
}

let lastSearch = '';
function LocationProbe(): null {
  lastSearch = useLocation().search;
  return null;
}

function renderPage(route = '/account/orders'): void {
  renderWithProviders(
    <Routes>
      <Route
        path="/account/orders"
        element={
          <>
            <OrdersPage />
            <LocationProbe />
          </>
        }
      />
    </Routes>,
    { route },
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the order history', () => {
  it('lists each order with its status in the customer’s words', async () => {
    answerWith([order(), order({ id: 'order-2', orderNumber: 'ORD-1002', status: 'DELIVERED' })]);
    renderPage();

    expect(await screen.findByText('ORD-1001')).toBeInTheDocument();
    // In the list, not the filter's options, which carry the same words.
    const list = screen.getByRole('list');
    expect(within(list).getByText('On its way')).toBeInTheDocument();
    expect(within(list).getByText('Delivered')).toBeInTheDocument();
    expect(requestedStatus()).toBeNull();
  });

  it('shows each order’s inspection status, and nothing when none was decided (ENH-010)', async () => {
    answerWith([
      order({ inspectionStatus: 'NCR' }),
      order({ id: 'order-2', orderNumber: 'ORD-1002', inspectionStatus: 'RELEASED' }),
      order({ id: 'order-3', orderNumber: 'ORD-1003', inspectionStatus: null }),
    ]);
    renderPage();

    expect(await screen.findByText('ORD-1003')).toBeInTheDocument();
    const list = screen.getByRole('list');
    expect(within(list).getByText(/Inspection NCR open|inspection.card.NCR/)).toBeInTheDocument();
    expect(within(list).getByText(/Inspection released|inspection.card.RELEASED/)).toBeInTheDocument();
    expect(within(list).queryAllByText(/inspection.card.|^Inspection /)).toHaveLength(2);
  });

  it('counts products in words that are translated, singular and plural', async () => {
    answerWith([order({ itemCount: 1 }), order({ id: 'order-2', orderNumber: 'ORD-1002', itemCount: 3 })]);
    renderPage();

    expect(await screen.findByText(/1 product$/)).toBeInTheDocument();
    expect(screen.getByText(/3 products$/)).toBeInTheDocument();
  });

  it('keeps the first-visit page for somebody who has never ordered', async () => {
    answerWith([]);
    renderPage();

    expect(await screen.findByText('No orders yet')).toBeInTheDocument();
    expect(screen.queryByLabelText('Status')).toBeNull();
  });
});

describe('filtering by status', () => {
  it('asks the API for the chosen status and puts it in the address', async () => {
    const user = userEvent.setup();
    answerWith([order()]);
    renderPage();

    await user.selectOptions(await screen.findByLabelText('Status'), 'SHIPPED');

    await waitFor(() => {
      expect(requestedStatus()).toBe('SHIPPED');
    });
    expect(lastSearch).toBe('?status=SHIPPED');
  });

  it('opens already filtered from a link, and can go back to every order', async () => {
    const user = userEvent.setup();
    answerWith([order({ status: 'DELIVERED' })]);
    renderPage('/account/orders?status=DELIVERED');

    expect(await screen.findByLabelText('Status')).toHaveValue('DELIVERED');
    expect(requestedStatus()).toBe('DELIVERED');

    await user.selectOptions(screen.getByLabelText('Status'), '');

    await waitFor(() => {
      expect(requestedStatus()).toBeNull();
    });
    expect(lastSearch).toBe('');
  });

  it('never sends a status it does not know, from a hand-edited address', async () => {
    answerWith([order()]);
    renderPage('/account/orders?status=DROP_TABLE');

    expect(await screen.findByText('ORD-1001')).toBeInTheDocument();
    expect(requestedStatus()).toBeNull();
    expect(screen.getByLabelText('Status')).toHaveValue('');
  });

  it('says a filter matched nothing, rather than that there are no orders', async () => {
    answerWith([]);
    renderPage('/account/orders?status=RETURNED');

    expect(await screen.findByText('No orders with this status')).toBeInTheDocument();
    expect(screen.queryByText('No orders yet')).toBeNull();
    expect(screen.getByRole('link', { name: 'Show all orders' })).toHaveAttribute(
      'href',
      '/account/orders',
    );
  });
});
