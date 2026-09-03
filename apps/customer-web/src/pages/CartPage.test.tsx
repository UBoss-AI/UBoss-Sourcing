/**
 * Cart behaviour under the conditions that actually go wrong.
 *
 * Every case here corresponds to something a customer hits in production: a
 * product unpublished while it sat in their cart, a price that moved, stock
 * that ran out, a quantity that breaks a rule, and a double-click.
 *
 * The property under test throughout is that **the server's answer wins**.
 * Nothing is computed locally, and `checkoutReady` decides whether checkout is
 * offered — not a count of issues this page could get wrong.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CartPage } from './CartPage';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { makeCart, makeCartLine, money } from '@/test/fixtures';
import type { Cart } from '@/lib/types';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Answer GET /cart with this cart, and echo it back from any mutation. */
function serveCart(cart: Cart, onMutate?: (url: string, init?: RequestInit) => Response): void {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';

    if (method === 'GET') return Promise.resolve(jsonResponse({ cart }));
    if (onMutate !== undefined) return Promise.resolve(onMutate(url, init));

    return Promise.resolve(jsonResponse({ cart }));
  });
}

describe('CartPage', () => {
  it('shows the empty state rather than an empty table', async () => {
    serveCart(makeCart({ lines: [], itemCount: 0 }));

    renderWithProviders(<CartPage />);

    expect(await screen.findByText('Your cart is empty')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /browse products/i })).toBeInTheDocument();
  });

  it('renders the server totals and never recomputes them', async () => {
    serveCart(makeCart());

    renderWithProviders(<CartPage />);

    // The line total and the grand total are the same figure on a one-line
    // cart, so both appear — which is itself worth asserting.
    expect(await screen.findAllByText('₹536.90')).toHaveLength(2);

    // Subtotal and tax come straight from the server. A page that multiplied
    // 45.50 by 10 and applied 18% itself would land on the same numbers by
    // luck, so what matters is that these are read, not derived: the fixture
    // is the only place they exist.
    expect(screen.getByText('₹81.90')).toBeInTheDocument();
    expect(screen.getByText('₹455.00')).toBeInTheDocument();
  });

  it('blocks checkout when the server says the cart is not ready', async () => {
    serveCart(
      makeCart({
        checkoutReady: false,
        blockingIssues: [
          {
            code: 'ORDER_BELOW_MINIMUM_VALUE',
            message: 'Orders must be at least 500.00 INR.',
          },
        ],
      }),
    );

    renderWithProviders(<CartPage />);

    expect(await screen.findByText('Orders must be at least 500.00 INR.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /proceed to checkout/i })).toBeDisabled();
  });

  it('offers checkout when the server says the cart is ready', async () => {
    serveCart(makeCart());

    renderWithProviders(<CartPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /proceed to checkout/i })).toBeEnabled();
    });
  });

  it('explains a product that was unpublished while it sat in the cart', async () => {
    serveCart(
      makeCart({
        checkoutReady: false,
        lines: [
          makeCartLine({
            issues: [
              {
                code: 'CART_ITEM_UNAVAILABLE',
                message: 'Hex Bolt M12 x 60mm is no longer available.',
              },
            ],
          }),
        ],
      }),
    );

    renderWithProviders(<CartPage />);

    // The server's own words, not a paraphrase.
    expect(
      await screen.findByText('Hex Bolt M12 x 60mm is no longer available.'),
    ).toBeInTheDocument();

    // Nothing to correct by changing a number, so no correction is offered.
    expect(screen.queryByRole('button', { name: /reduce to/i })).not.toBeInTheDocument();
  });

  it('offers a one-click fix when stock has run short', async () => {
    const user = userEvent.setup();
    const patched = vi.fn();

    serveCart(
      makeCart({
        checkoutReady: false,
        lines: [
          makeCartLine({
            quantity: 100,
            availableQty: 40,
            issues: [
              {
                code: 'INSUFFICIENT_STOCK',
                message: 'Only 40 left in stock.',
              },
            ],
          }),
        ],
      }),
      (url, init) => {
        patched(url, init?.body);
        return jsonResponse({ cart: makeCart() });
      },
    );

    renderWithProviders(<CartPage />);

    // 40 is available and the minimum is 10 with a step of 5, so 40 is legal.
    const fix = await screen.findByRole('button', { name: 'Reduce to 40' });
    await user.click(fix);

    await waitFor(() => {
      expect(patched).toHaveBeenCalled();
    });

    expect(String(patched.mock.calls[0]?.[1])).toContain('"quantity":40');
  });

  it('does not offer a stock fix when the available amount breaks the minimum', async () => {
    serveCart(
      makeCart({
        checkoutReady: false,
        lines: [
          makeCartLine({
            quantity: 50,
            // Below the minimum of 10, so "reduce to 3" would just produce a
            // different violation.
            availableQty: 3,
            issues: [{ code: 'INSUFFICIENT_STOCK', message: 'Only 3 left in stock.' }],
          }),
        ],
      }),
    );

    renderWithProviders(<CartPage />);

    expect(await screen.findByText('Only 3 left in stock.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reduce to/i })).not.toBeInTheDocument();
  });

  it('offers to snap a quantity back onto the increment', async () => {
    const user = userEvent.setup();
    const patched = vi.fn();

    serveCart(
      makeCart({
        checkoutReady: false,
        lines: [
          makeCartLine({
            // 11 breaks a minimum of 10 in steps of 5; 15 is the next legal one.
            quantity: 11,
            issues: [
              {
                code: 'QUANTITY_INCREMENT_INVALID',
                message: 'This product is ordered in multiples of 5.',
              },
            ],
          }),
        ],
      }),
      (url, init) => {
        patched(url, init?.body);
        return jsonResponse({ cart: makeCart() });
      },
    );

    renderWithProviders(<CartPage />);

    await user.click(await screen.findByRole('button', { name: 'Change to 15' }));

    await waitFor(() => {
      expect(patched).toHaveBeenCalled();
    });

    expect(String(patched.mock.calls[0]?.[1])).toContain('"quantity":15');
  });

  it('shows a price change as a notice, not as a failure', async () => {
    serveCart(
      makeCart({
        lines: [
          makeCartLine({
            unitPrice: money('4900'),
            issues: [
              {
                code: 'CART_PRICE_CHANGED',
                message: 'The price of this item has changed since you added it.',
              },
            ],
          }),
        ],
      }),
    );

    renderWithProviders(<CartPage />);

    expect(
      await screen.findByText('The price of this item has changed since you added it.'),
    ).toBeInTheDocument();

    // The new price is shown. Nothing here remembers the old one.
    expect(screen.getByText(/₹49\.00 each/)).toBeInTheDocument();
  });

  it('disables a line while its change is in flight, so a double click sends one', async () => {
    const user = userEvent.setup();
    let resolvePatch: ((value: Response) => void) | undefined;
    const patched = vi.fn();

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return Promise.resolve(jsonResponse({ cart: makeCart() }));
      }

      patched(url);
      return new Promise<Response>((resolve) => {
        resolvePatch = resolve;
      });
    });

    renderWithProviders(<CartPage />);

    const increase = await screen.findByRole('button', { name: /increase quantity/i });
    await user.click(increase);

    // The control is disabled while the first change is unresolved, so a
    // second click cannot queue a second change.
    await waitFor(() => {
      expect(increase).toBeDisabled();
    });

    await user.click(increase);
    expect(patched).toHaveBeenCalledTimes(1);

    resolvePatch?.(jsonResponse({ cart: makeCart() }));
  });

  it('names the purchasing rules on the line, not only at the product', async () => {
    serveCart(makeCart());

    renderWithProviders(<CartPage />);

    expect(
      await screen.findByText('Ordered minimum 10, in multiples of 5.'),
    ).toBeInTheDocument();
  });

  it('announces the item count to assistive technology', async () => {
    serveCart(makeCart());

    renderWithProviders(<CartPage />);

    const status = await screen.findByText(/10 items across 1 product/);
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('surfaces the server message when a change is rejected', async () => {
    const user = userEvent.setup();

    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return Promise.resolve(jsonResponse({ cart: makeCart() }));
      }

      return Promise.resolve(
        jsonResponse(
          {
            error: {
              code: 'INSUFFICIENT_STOCK',
              message: 'Only 12 left in stock.',
              details: [],
              correlationId: 'abc',
            },
          },
          409,
        ),
      );
    });

    renderWithProviders(<CartPage />);

    await user.click(await screen.findByRole('button', { name: /increase quantity/i }));

    const alerts = await screen.findAllByRole('alert');
    expect(within(alerts[0] as HTMLElement).getByText('Only 12 left in stock.')).toBeInTheDocument();
  });
});
