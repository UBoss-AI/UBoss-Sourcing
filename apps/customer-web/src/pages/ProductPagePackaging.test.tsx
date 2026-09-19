/**
 * The product page, for a catalogue sold by the carton.
 *
 * Three things are pinned here, and each one is a way a wholesale order goes
 * wrong quietly.
 *
 *   **The conversion.** Two cartons is a thousand pieces, and the page has to
 *   say so before the customer commits — a "2" that means two to them and a
 *   thousand to the warehouse is the whole failure mode.
 *
 *   **The unit that is not offered.** There is no unit picker, because there
 *   is no choice: pieces and inner boxes cannot be bought. A control offering
 *   one option reads as broken, and a page that let somebody pick pieces would
 *   be offering something the basket has to refuse.
 *
 *   **The price that is not a price.** A product quoted per account shows an
 *   invitation, never a number and never a zero, and its buy button is
 *   replaced rather than greyed out.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { ProductPage } from './ProductPage';
import { jsonResponse, makeSession, renderWithProviders } from '@/test/harness';
import { makeProduct, money } from '@/test/fixtures';
import type { Product, ProductPackaging } from '@/lib/types';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The carton this shop sells, and the one every figure below counts in. */
const PER_CARTON = 500;

/**
 * What the server still sends about packing: no quantities.
 *
 * The piece counts were removed from the public shape on purpose — the
 * supplier's "2,000 to a carton" and this shop's carton of 500 cannot both be
 * true on one page. See `packaging.service.ts`.
 */
function packing(overrides: Partial<ProductPackaging> = {}): ProductPackaging {
  return {
    packingType: 'Blister Pack',
    dimensions: [
      {
        kind: 'OUTER_CARTON',
        label: 'Outer carton',
        value: '460 × 350 × 210 mm',
        hasUnit: true,
      },
      { kind: 'INNER_BOX', label: 'Inner box', value: '168 × 124 × 155', hasUnit: false },
    ],
    ...overrides,
  };
}

const bodies: string[] = [];

function renderProduct(product: Product): void {
  bodies.length = 0;

  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST' && url.includes('/cart/items')) {
      bodies.push(typeof init?.body === 'string' ? init.body : '');
      return Promise.resolve(jsonResponse({ cart: { itemCount: 1 } }, 201));
    }
    return Promise.resolve(jsonResponse({ product }));
  });

  renderWithProviders(
    <Routes>
      <Route path="/product/:slug" element={<ProductPage />} />
    </Routes>,
    { route: '/product/hex-bolt-m12-x-60mm', session: makeSession() },
  );
}

/** The rules are irrelevant to packing, so they are out of the way. */
const simpleRules = {
  minOrderQty: 1,
  maxOrderQty: null,
  qtyIncrement: 1,
  isRecurringEligible: false,
};

describe('packaging on the product page', () => {
  it('states the carton as one sentence', async () => {
    renderProduct(makeProduct({ purchaseRules: simpleRules, packaging: packing() }));

    const formula = await screen.findByTestId('packing-formula');
    expect(formula).toHaveTextContent('One carton has 500 pieces');
  });

  it('says how it is sold and what a carton holds', async () => {
    renderProduct(makeProduct({ purchaseRules: simpleRules, packaging: packing() }));

    const section = await screen.findByRole('region', { name: /packaging and ordering/i });
    expect(within(section).getByText('Sold in')).toBeInTheDocument();
    expect(within(section).getByText('Pieces per carton')).toBeInTheDocument();
    // The supplier's own inner-box counts are gone. Two carton sizes on one
    // page is a buyer working out which their order was priced at.
    expect(within(section).queryByText('Pieces per box')).not.toBeInTheDocument();
  });

  it('offers no unit to choose, because there is only one', async () => {
    renderProduct(makeProduct({ purchaseRules: simpleRules, packaging: packing() }));

    await screen.findByRole('region', { name: /packaging and ordering/i });
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.getByText(/ordered by the carton/i)).toBeInTheDocument();
  });

  it('says a carton is not a minimum, because a B2B buyer will assume it is', async () => {
    renderProduct(makeProduct({ purchaseRules: simpleRules, packaging: packing() }));

    expect(await screen.findByText(/not a minimum order/i)).toBeInTheDocument();
  });

  it('converts what the customer typed into pieces before they commit', async () => {
    const user = userEvent.setup();
    renderProduct(makeProduct({ purchaseRules: simpleRules, packaging: packing() }));

    const quantity = await screen.findByRole('spinbutton');
    await user.clear(quantity);
    await user.type(quantity, '2');

    // The number the warehouse will pick, said out loud on the page the
    // decision is made on. The whole sentence, because "1,000 pieces" also
    // appears in the ready-reckoner two sections down — and that one is a
    // table of what-ifs rather than a statement about this order.
    expect(await screen.findByText('That comes to 1,000 pieces.')).toBeInTheDocument();
  });

  it('sends the unit and the count, and lets the server do the conversion', async () => {
    const user = userEvent.setup();
    renderProduct(makeProduct({ purchaseRules: simpleRules, packaging: packing() }));

    const quantity = await screen.findByRole('spinbutton');
    await user.clear(quantity);
    await user.type(quantity, '2');
    await user.click(screen.getByRole('button', { name: /add to cart/i }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });

    const sent = JSON.parse(bodies[0] ?? '{}') as {
      items: { orderingUnit: string; unitQuantity: number; quantity: number }[];
    };

    expect(sent.items[0]).toMatchObject({ orderingUnit: 'OUTER_CARTON', unitQuantity: 2 });
    // The pieces go too, but the server recomputes them from its own setting —
    // a browser that got this wrong cannot buy anything at the wrong price.
    // See cart.service.ts.
    expect(sent.items[0]?.quantity).toBe(2 * PER_CARTON);
  });

  it('shows a size as written where the source stated no unit', async () => {
    renderProduct(makeProduct({ purchaseRules: simpleRules, packaging: packing() }));

    const section = await screen.findByRole('region', { name: /dimensions/i });
    expect(within(section).getByText('168 × 124 × 155')).toBeInTheDocument();
    // And says so, rather than quietly appending "mm".
    expect(within(section).getByText(/no unit is given, none was stated/i)).toBeInTheDocument();
  });
});

describe('the price is the price of a carton', () => {
  /** ₹12.50 a piece, 500 to the carton. */
  function pricedProduct(): Product {
    return makeProduct({
      purchaseRules: simpleRules,
      packaging: packing(),
      price: money('1250'),
      variants: [],
      hasVariants: false,
    });
  }

  it('prices the carton, not the piece', async () => {
    renderProduct(pricedProduct());

    // 12.50 × 500. Done on BigInt minor units, never on a float.
    expect(await screen.findByText('₹6250.00')).toBeInTheDocument();
    // The piece price is never the headline, but it stays on screen so a
    // buyer can check the arithmetic that produced the figure above it.
    expect(screen.getByText(/per carton of 500 pieces · ₹12\.50 per piece/i)).toBeInTheDocument();
  });

  it('never shows the piece price as the headline figure', async () => {
    renderProduct(pricedProduct());

    await screen.findByText('₹6250.00');
    expect(screen.queryByText('₹12.50')).not.toBeInTheDocument();
  });

  it('drops the carton line entirely on something sold by the piece', async () => {
    /*
     * A third-party seller's listing. The headline figure is already the
     * price of one, so the carton line would say the same thing twice - and
     * would say it wrongly, because a carton of one is not a carton and
     * "per carton of 1 pieces" reads as a bug. "Sold by the piece", which
     * the quantity block carries, is the whole of the unit here.
     */
    renderProduct(
      makeProduct({
        purchaseRules: simpleRules,
        price: money('799900'),
        variants: [],
        hasVariants: false,
        sellUnit: {
          unit: 'PIECE',
          piecesPerUnit: 1,
          minimumOrderQuantity: 1,
          orderIncrement: 1,
          maximumOrderQuantity: null,
          isPricedPerSellUnit: true,
        },
      }),
    );

    expect(await screen.findByText('₹7999.00')).toBeInTheDocument();
    expect(screen.queryByText(/per carton of/i)).not.toBeInTheDocument();
  });

  it('scales the strike-through by the same factor as the price', async () => {
    renderProduct(
      makeProduct({
        purchaseRules: simpleRules,
        packaging: packing(),
        price: money('1250'),
        compareAtPrice: money('1500'),
        variants: [],
        hasVariants: false,
      }),
    );

    // Both sides multiplied by 500: a sixth off a piece is a sixth off a
    // carton. Scaling only one would invent a saving nobody offered.
    expect(await screen.findByText('₹6250.00')).toBeInTheDocument();
    expect(screen.getByText('₹7500.00')).toBeInTheDocument();
  });
});

describe('a product priced per account', () => {
  const onRequest = {
    isPriceOnRequest: true,
    isOrderable: true,
    unavailabilityReason: null,
    canAddToCart: false,
  };

  it('invites a quotation instead of printing a figure', async () => {
    renderProduct(makeProduct({ purchasability: onRequest }));

    expect(await screen.findByText('Price on request')).toBeInTheDocument();
    // The zero it is stored as must never reach the page.
    expect(screen.queryByText(/0\.00/)).not.toBeInTheDocument();
  });

  it('replaces the buy button rather than greying it out', async () => {
    renderProduct(makeProduct({ purchasability: onRequest }));

    expect(await screen.findByRole('link', { name: /request a quote/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add to cart/i })).not.toBeInTheDocument();
  });
});

describe('a product on hold', () => {
  it('stays readable and says why it cannot be ordered', async () => {
    renderProduct(
      makeProduct({
        purchasability: {
          isPriceOnRequest: false,
          isOrderable: false,
          unavailabilityReason: 'On hold until the new mould lands.',
          canAddToCart: false,
        },
      }),
    );

    // The operator's own sentence, not a generic one.
    expect(await screen.findByText('On hold until the new mould lands.')).toBeInTheDocument();
    // Still a product page: the specification is the reason somebody kept the
    // link. Only the buying is refused.
    expect(screen.getByRole('button', { name: /add to cart/i })).toBeDisabled();
  });
});
