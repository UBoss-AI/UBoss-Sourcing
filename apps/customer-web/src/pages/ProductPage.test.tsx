/**
 * Product page: variant selection, quantity rules, and the two things this
 * page must never do — claim stock it cannot see, and let a guest reach the
 * cart.
 *
 * Selection is a MULTIPLE choice, and most of what is asserted below follows
 * from that: a customer buying syringes wants the 3 ml and the 5 ml, each in
 * its own number, added in one request. The price panel is watched closely
 * here for what it must NOT print — a total across the chosen options, which
 * would be a second pricing engine on the one page whose rule is that it has
 * none.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { ProductPage } from './ProductPage';
import { errorResponse, jsonResponse, makeSession, renderWithProviders } from '@/test/harness';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
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
  options: {
    signedIn?: boolean;
    onAdd?: (body: string, url: string) => Response;
    /** Whether the deployment has scheduled orders switched on. Off by default. */
    recurring?: boolean;
  } = {},
): void {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST' && url.includes('/cart/items')) {
      const handler = options.onAdd;
      return Promise.resolve(
        handler === undefined
          ? jsonResponse({ cart: { itemCount: 1 } }, 201)
          // The client always sends a JSON string body, but BodyInit is
          // wider than that, so it is narrowed rather than coerced.
          : handler(typeof init?.body === 'string' ? init.body : '', url),
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
      ...(options.recurring === true
        ? {
            config: {
              ...FALLBACK_CONFIG,
              features: { ...FALLBACK_CONFIG.features, recurringOrders: true },
            },
          }
        : {}),
    },
  );
}

/** Two options at prices far enough apart to make a band obvious. */
function twoOptions(): Product {
  return makeProduct({
    hasVariants: true,
    variants: [
      { id: 'v1', sku: 'BOLT-1L', name: '1 Litre', options: { Size: '1L' }, price: money('4550') },
      { id: 'v2', sku: 'BOLT-5L', name: '5 Litre', options: { Size: '5L' }, price: money('19900') },
    ],
  });
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

    renderProduct(twoOptions());

    await user.click(await screen.findByRole('button', { name: /5 Litre/ }));

    // Twice over, and deliberately: once in the option's own row, because the
    // panel above can print only one figure and cannot be that row's price
    // once a second option is chosen; and once in the panel, because one
    // option chosen is still one price.
    expect(screen.getAllByText('₹199.00')).toHaveLength(2);
    expect(screen.getByText('Price shown for 5 Litre.')).toBeInTheDocument();
  });

  it('preselects the only option there is, and asks about it when there are two', async () => {
    renderProduct(
      makeProduct({
        hasVariants: true,
        variants: [
          {
            id: 'v1',
            sku: 'BOLT-1L',
            name: '1 Litre',
            options: { Size: '1L' },
            price: money('4550'),
          },
        ],
      }),
    );

    // A choice with one candidate is not a choice, so it is made.
    expect(await screen.findByRole('button', { name: /1 Litre/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /add to cart/i })).toBeEnabled();
  });

  it('takes two options of one product in a single add', async () => {
    const user = userEvent.setup();
    const bodies: string[] = [];
    const urls: string[] = [];

    renderProduct(twoOptions(), {
      onAdd: (body, url) => {
        bodies.push(body);
        urls.push(url);
        return jsonResponse({ cart: { itemCount: 2 } }, 201);
      },
    });

    // The whole point of the feature: a syringe order is 3 ml *and* 5 ml.
    await user.click(await screen.findByRole('button', { name: /1 Litre/ }));
    await user.click(screen.getByRole('button', { name: /5 Litre/ }));
    await user.click(screen.getByRole('button', { name: /add 2 options to cart/i }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });

    // ONE request, not two. Two would mean a customer could be told "added to
    // your cart" with only half of what they chose in it, and a customer whose
    // first cart is being created could have the two adds race into two carts.
    expect(urls[0]).toContain('/cart/items/bulk');
    expect(bodies[0]).toContain('"variantId":"v1"');
    expect(bodies[0]).toContain('"variantId":"v2"');
  });

  it('gives each chosen option a quantity of its own', async () => {
    const user = userEvent.setup();
    const bodies: string[] = [];

    renderProduct(twoOptions(), {
      onAdd: (body) => {
        bodies.push(body);
        return jsonResponse({ cart: { itemCount: 2 } }, 201);
      },
    });

    await user.click(await screen.findByRole('button', { name: /1 Litre/ }));
    await user.click(screen.getByRole('button', { name: /5 Litre/ }));

    // Two of the small and three steps up on the large. A shared quantity box
    // could not express that, which is why there is one per option.
    await user.click(screen.getByRole('button', { name: /increase the quantity of 5 Litre by 5/i }));

    expect(screen.getByRole('spinbutton', { name: /quantity of 1 Litre/i })).toHaveValue(10);
    expect(screen.getByRole('spinbutton', { name: /quantity of 5 Litre/i })).toHaveValue(15);

    await user.click(screen.getByRole('button', { name: /add 2 options to cart/i }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });

    const sent = JSON.parse(bodies[0] ?? '{}') as {
      items: { variantId: string; quantity: number }[];
    };
    expect(sent.items).toEqual([
      { productId: 'product-1', variantId: 'v1', quantity: 10 },
      { productId: 'product-1', variantId: 'v2', quantity: 15 },
    ]);
  });

  it('turns a chosen option back off', async () => {
    const user = userEvent.setup();

    renderProduct(twoOptions());

    const litre = await screen.findByRole('button', { name: /1 Litre/ });

    await user.click(litre);
    expect(screen.getByRole('button', { name: /add to cart/i })).toBeEnabled();

    await user.click(litre);
    expect(screen.getByText('Choose an option to continue.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add to cart/i })).toBeDisabled();
  });

  it('prices two chosen options as a band, and never as a total', async () => {
    const user = userEvent.setup();

    renderProduct(twoOptions());

    await user.click(await screen.findByRole('button', { name: /1 Litre/ }));
    await user.click(screen.getByRole('button', { name: /5 Litre/ }));

    expect(screen.getByText('₹45.50 to ₹199.00')).toBeInTheDocument();
    expect(
      screen.getByText('The lowest and the highest of the 2 options you chose.'),
    ).toBeInTheDocument();

    // ₹45.50 + ₹199.00, or either of them times its quantity. This page has no
    // pricing engine and must never grow one: the cart is where a total is
    // worked out, and a second answer here is a second answer that can differ.
    expect(screen.queryByText('₹244.50')).not.toBeInTheDocument();
    expect(screen.queryByText('₹3,440.00')).not.toBeInTheDocument();
  });

  it('offers a repeat purchase for one chosen option, and says why not for two', async () => {
    const user = userEvent.setup();

    renderProduct(twoOptions(), { recurring: true });

    await user.click(await screen.findByRole('button', { name: /1 Litre/ }));
    expect(screen.getByRole('link', { name: /schedule your cart/i })).toHaveAttribute(
      'href',
      '/schedules/new?productId=product-1&quantity=10&variantId=v1',
    );

    await user.click(screen.getByRole('button', { name: /5 Litre/ }));

    // The builder takes one product and one option, so there is no honest link
    // to offer for two. It says which way round to do it rather than vanishing.
    expect(screen.queryByRole('link', { name: /schedule your cart/i })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'A repeat purchase covers one option at a time. Add these to your cart, then schedule the whole cart.',
      ),
    ).toBeInTheDocument();
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
    expect(screen.queryByRole('link', { name: /schedule your cart/i })).not.toBeInTheDocument();
  });
});
