/**
 * Product page: variant selection, quantity rules, and the two things this
 * page must never do — claim stock it cannot see, and let a guest reach the
 * cart.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { ProductPage } from './ProductPage';
import { errorResponse, jsonResponse, makeSession, renderWithProviders } from '@/test/harness';
import { makeProduct, money } from '@/test/fixtures';
import type { Product } from '@/lib/types';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Render at the product route, so `useParams` resolves a slug. */
function renderProduct(
  product: Product | null,
  options: { signedIn?: boolean; onAdd?: (body: string) => Response } = {},
): void {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST' && url.includes('/cart/items')) {
      const handler = options.onAdd;
      return Promise.resolve(
        handler === undefined
          ? jsonResponse({ cart: { itemCount: 1 } }, 201)
          // The client always sends a JSON string body, but BodyInit is
          // wider than that, so it is narrowed rather than coerced.
          : handler(typeof init?.body === 'string' ? init.body : ''),
      );
    }

    if (product === null) {
      return Promise.resolve(errorResponse(404, 'NOT_FOUND', 'Product was not found.'));
    }

    return Promise.resolve(jsonResponse({ product }));
  });

  renderWithProviders(
    <Routes>
      <Route path="/product/:slug" element={<ProductPage />} />
    </Routes>,
    {
      route: '/product/hex-bolt-m12-x-60mm',
      session:
        options.signedIn === false
          ? makeSession({ user: null, isCustomer: false })
          : makeSession(),
    },
  );
}

describe('ProductPage', () => {
  it('shows the purchasing rules before Add to Cart, not after', async () => {
    renderProduct(makeProduct());

    // A customer who discovers a minimum of 10 only when the cart rejects them
    // has been wasted twice.
    expect(await screen.findByText('Ordered minimum 10, in multiples of 5.')).toBeInTheDocument();
  });

  it('opens at the lowest quantity the rules allow', async () => {
    renderProduct(makeProduct());

    const quantity = await screen.findByRole('spinbutton', { name: /quantity/i });
    expect(quantity).toHaveValue(10);
  });

  it('steps by the increment, not by one', async () => {
    const user = userEvent.setup();
    renderProduct(makeProduct());

    const quantity = await screen.findByRole('spinbutton', { name: /quantity/i });
    await user.click(screen.getByRole('button', { name: /increase quantity by 5/i }));

    expect(quantity).toHaveValue(15);
  });

  it('never steps below the minimum', async () => {
    const user = userEvent.setup();
    renderProduct(makeProduct());

    await screen.findByRole('spinbutton', { name: /quantity/i });

    // At the minimum already, so decreasing is not offered.
    expect(screen.getByRole('button', { name: /decrease quantity by 5/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /increase quantity by 5/i }));
    expect(screen.getByRole('button', { name: /decrease quantity by 5/i })).toBeEnabled();
  });

  it('makes a guest sign in rather than showing a cart button that fails', async () => {
    renderProduct(makeProduct(), { signedIn: false });

    expect(await screen.findByRole('button', { name: /sign in to order/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add to cart/i })).not.toBeInTheDocument();
  });

  it('requires a variant choice before it will add anything', async () => {
    const withVariants = makeProduct({
      hasVariants: true,
      variants: [
        { id: 'v1', sku: 'BOLT-1L', name: '1 Litre', options: { Size: '1L' }, price: money('4550') },
        { id: 'v2', sku: 'BOLT-5L', name: '5 Litre', options: { Size: '5L' }, price: money('19900') },
      ],
    });

    renderProduct(withVariants);

    expect(await screen.findByText('Choose an option to continue.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add to cart/i })).toBeDisabled();
  });

  it('shows the chosen variant’s own price', async () => {
    const user = userEvent.setup();
    const withVariants = makeProduct({
      hasVariants: true,
      variants: [
        { id: 'v1', sku: 'BOLT-1L', name: '1 Litre', options: { Size: '1L' }, price: money('4550') },
        { id: 'v2', sku: 'BOLT-5L', name: '5 Litre', options: { Size: '5L' }, price: money('19900') },
      ],
    });

    renderProduct(withVariants);

    await user.click(await screen.findByRole('button', { name: /5 Litre/ }));

    expect(screen.getByText('₹199.00')).toBeInTheDocument();
    expect(screen.getByText('Price shown for 5 Litre.')).toBeInTheDocument();
  });

  it('sends the chosen variant with the add', async () => {
    const user = userEvent.setup();
    const bodies: string[] = [];

    const withVariants = makeProduct({
      hasVariants: true,
      variants: [
        { id: 'v1', sku: 'BOLT-1L', name: '1 Litre', options: { Size: '1L' }, price: money('4550') },
        { id: 'v2', sku: 'BOLT-5L', name: '5 Litre', options: { Size: '5L' }, price: money('19900') },
      ],
    });

    renderProduct(withVariants, {
      onAdd: (body) => {
        bodies.push(body);
        return jsonResponse({ cart: { itemCount: 1 } }, 201);
      },
    });

    await user.click(await screen.findByRole('button', { name: /5 Litre/ }));
    await user.click(screen.getByRole('button', { name: /add to cart/i }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });

    expect(bodies[0]).toContain('"variantId":"v2"');
    expect(bodies[0]).toContain('"quantity":10');
  });

  it('shows the server’s refusal verbatim when an add is rejected', async () => {
    const user = userEvent.setup();

    renderProduct(makeProduct(), {
      onAdd: () =>
        errorResponse(
          409,
          'INSUFFICIENT_STOCK',
          'Hex Bolt M12 x 60mm is out of stock.',
        ),
    });

    await user.click(await screen.findByRole('button', { name: /add to cart/i }));

    // The server names the rule that was broken. Replacing it with "could not
    // add" throws away the only thing that tells the customer what to change.
    expect(await screen.findByText('Hex Bolt M12 x 60mm is out of stock.')).toBeInTheDocument();
  });

  it('does not claim a stock level the public API never publishes', async () => {
    renderProduct(makeProduct());

    await screen.findByRole('button', { name: /add to cart/i });

    expect(
      screen.getByText('Availability is confirmed when the item is added to your cart.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/in stock/i)).not.toBeInTheDocument();
  });

  it('treats an unpublished product as a clean 404, not a crash', async () => {
    renderProduct(null);

    expect(await screen.findByText('We could not find that page')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /browse products/i })).toBeInTheDocument();
  });

  it('offers a repeat purchase only when the product allows one', async () => {
    renderProduct(
      makeProduct({
        purchaseRules: {
          minOrderQty: 1,
          maxOrderQty: null,
          qtyIncrement: 1,
          isRecurringEligible: false,
        },
      }),
    );

    await screen.findByRole('button', { name: /add to cart/i });
    expect(screen.queryByRole('link', { name: /repeat purchase/i })).not.toBeInTheDocument();
  });
});
