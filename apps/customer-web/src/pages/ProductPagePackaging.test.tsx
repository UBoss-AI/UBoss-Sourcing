/**
 * The product page, for a catalogue sold by the box.
 *
 * Three things are pinned here, and each one is a way a wholesale order goes
 * wrong quietly.
 *
 *   **The conversion.** Two cartons of something boxed 100 × 20 is four
 *   thousand pieces, and the page has to say so before the customer commits —
 *   a "2" that means two to them and four thousand to the warehouse is the
 *   whole failure mode.
 *
 *   **The unit that is not offered.** A product whose carton quantity nobody
 *   recorded must not offer a carton, and one whose figures contradicted each
 *   other must not offer anything but pieces. Offering a conversion that has
 *   to be refused at the basket wastes the customer's time at the worst moment.
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

/** 100 to a box, 20 boxes to a carton — the commonest shape in the source. */
function packing(overrides: Partial<ProductPackaging> = {}): ProductPackaging {
  return {
    packingType: 'Blister Pack',
    sourceText: '100Pcs x 20Box=2000Pcs',
    piecesPerInnerPack: 100,
    innerPacksPerOuterCarton: 20,
    piecesPerOuterCarton: 2000,
    innerPackType: 'Box',
    outerPackType: 'Carton',
    formula: '100 pieces × 20 boxes = 2,000 pieces',
    isReliable: true,
    parseStatus: 'PARSED',
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
  it('states the conversion as one sentence', async () => {
    renderProduct(makeProduct({ purchaseRules: simpleRules, packaging: packing() }));

    const formula = await screen.findByTestId('packing-formula');
    // Built on the server, so this sentence and the basket's arithmetic come
    // from one place. Asserting the text is asserting that nothing in the
    // browser recomputed it.
    expect(formula).toHaveTextContent('100 pieces × 20 boxes = 2,000 pieces');
  });

  it('breaks the carton down without confusing it with the box', async () => {
    renderProduct(makeProduct({ purchaseRules: simpleRules, packaging: packing() }));

    const section = await screen.findByRole('region', { name: /packaging and ordering/i });
    expect(within(section).getByText('Pieces per box')).toBeInTheDocument();
    expect(within(section).getByText('Box per carton')).toBeInTheDocument();
    expect(within(section).getByText('Pieces per carton')).toBeInTheDocument();
  });

  it('says packing is not a minimum, because a B2B buyer will assume it is', async () => {
    renderProduct(makeProduct({ purchaseRules: simpleRules, packaging: packing() }));

    expect(await screen.findByText(/not a minimum order/i)).toBeInTheDocument();
  });

  it('converts what the customer typed into pieces before they commit', async () => {
    const user = userEvent.setup();
    renderProduct(makeProduct({ purchaseRules: simpleRules, packaging: packing() }));

    await user.click(await screen.findByRole('radio', { name: /carton/i }));

    const quantity = screen.getByRole('spinbutton');
    await user.clear(quantity);
    await user.type(quantity, '2');

    // The number the warehouse will pick, said out loud on the page the
    // decision is made on. The whole sentence, because "4,000 pieces" also
    // appears in the ready-reckoner two sections down — and that one is a
    // table of what-ifs rather than a statement about this order.
    expect(await screen.findByText('That comes to 4,000 pieces.')).toBeInTheDocument();
  });

  it('sends the unit and the count, and lets the server do the conversion', async () => {
    const user = userEvent.setup();
    renderProduct(makeProduct({ purchaseRules: simpleRules, packaging: packing() }));

    await user.click(await screen.findByRole('radio', { name: /carton/i }));

    const quantity = screen.getByRole('spinbutton');
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
    // The pieces go too, but the server recomputes them from its own packing
    // row — a browser that got this wrong cannot buy anything at the wrong
    // price. See cart.service.ts.
    expect(sent.items[0]?.quantity).toBe(4000);
  });

  it('does not offer a carton it cannot convert', async () => {
    renderProduct(
      makeProduct({
        purchaseRules: simpleRules,
        packaging: packing({
          piecesPerInnerPack: 100,
          innerPacksPerOuterCarton: null,
          piecesPerOuterCarton: null,
          formula: null,
        }),
      }),
    );

    await screen.findByRole('region', { name: /packaging and ordering/i });
    expect(screen.queryByRole('radio', { name: /carton/i })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /box/i })).toBeInTheDocument();
  });

  it('offers pieces only where the supplier’s own figures disagreed', async () => {
    renderProduct(
      makeProduct({
        purchaseRules: simpleRules,
        packaging: packing({ isReliable: false, parseStatus: 'NEEDS_REVIEW' }),
      }),
    );

    // No unit control at all: pieces is the only thing left, and a radio group
    // with one option reads as broken rather than as simple.
    await screen.findByRole('region', { name: /packaging and ordering/i });
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.getByText(/do not multiply out/i)).toBeInTheDocument();
  });

  it('shows a size as written where the source stated no unit', async () => {
    renderProduct(makeProduct({ purchaseRules: simpleRules, packaging: packing() }));

    const section = await screen.findByRole('region', { name: /dimensions/i });
    expect(within(section).getByText('168 × 124 × 155')).toBeInTheDocument();
    // And says so, rather than quietly appending "mm".
    expect(within(section).getByText(/no unit is given, none was stated/i)).toBeInTheDocument();
  });
});

describe('the price follows the unit being counted', () => {
  /** ₹12.50 a piece, 100 to a box, 20 boxes to a carton. */
  function pricedProduct(): Product {
    return makeProduct({
      purchaseRules: simpleRules,
      packaging: packing(),
      price: money('1250'),
      variants: [],
      hasVariants: false,
    });
  }

  it('prices a piece when pieces are what is being counted', async () => {
    renderProduct(pricedProduct());
    expect(await screen.findByText('₹12.50')).toBeInTheDocument();
  });

  it('prices a box when the buyer switches to boxes', async () => {
    const user = userEvent.setup();
    renderProduct(pricedProduct());

    await user.click(await screen.findByRole('radio', { name: /box/i }));

    // 12.50 x 100. The buyer is thinking in boxes, so the headline figure is
    // what a box costs - and the per-piece price stays on screen beside it so
    // neither number can be mistaken for the other.
    expect(await screen.findByText('₹1250.00')).toBeInTheDocument();
    expect(screen.getByText(/per box of 100 · ₹12\.50 per piece/i)).toBeInTheDocument();
  });

  it('prices a carton when the buyer switches to cartons', async () => {
    const user = userEvent.setup();
    renderProduct(pricedProduct());

    await user.click(await screen.findByRole('radio', { name: /carton/i }));

    // 12.50 x 2,000. Done on BigInt minor units, never on a float.
    expect(await screen.findByText('₹25000.00')).toBeInTheDocument();
    expect(screen.getByText(/per carton of 2,000/i)).toBeInTheDocument();
  });

  it('says nothing extra while counting in pieces', async () => {
    renderProduct(pricedProduct());

    await screen.findByText('₹12.50');
    // "per piece of 1 · ₹12.50 per piece" would be noise on the one line of
    // the page nobody may misread.
    expect(screen.queryByText(/per piece$/i)).not.toBeInTheDocument();
  });

  it('scales the strike-through by the same factor as the price', async () => {
    const user = userEvent.setup();
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

    await user.click(await screen.findByRole('radio', { name: /box/i }));

    // Both sides multiplied by 100: a fifth off a piece is a fifth off a box.
    // Scaling only one of them would invent a saving that was never offered.
    expect(await screen.findByText('₹1250.00')).toBeInTheDocument();
    expect(screen.getByText('₹1500.00')).toBeInTheDocument();
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
