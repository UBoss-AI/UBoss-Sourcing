/**
 * How the customer is asked to pay.
 *
 * This page used to ask which *gateway* should take the money — "Razorpay or
 * Stripe" — which is the operator's plumbing on a customer's screen and a
 * decision nobody buying consumables has any basis for making. It now asks
 * which instrument they are paying with, and the gateway is resolved from that
 * answer on the server.
 *
 * Three properties are worth holding to, and each is a way the change could go
 * quietly wrong:
 *
 *   1. **No gateway is ever named.** Not in a label, not in a hint. If one
 *      leaks back onto this page nothing else fails — the payment still works
 *      — so a test is the only thing that would notice.
 *   2. **A saved card is only offered under the instrument it belongs to.** A
 *      debit card shown under "Pay with Credit Card" is a refusal waiting to
 *      happen on the next screen, at the moment the customer expected to be
 *      done.
 *   3. **What the customer picked reaches the order.** The instrument and the
 *      card are recorded at checkout so the payment page can read them back;
 *      losing either silently drops the customer onto the default.
 *
 * `fetch` is stubbed at the boundary, as everywhere else in this suite, so the
 * API client's own behaviour is exercised rather than bypassed.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckoutPage } from './CheckoutPage';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';
import { makeCart, makeWarehouseOption, makeWarehouseOptions, money } from '@/test/fixtures';
import type { QuoteCheck, WarehouseOptionsResponse } from '@/lib/fulfilment';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const address = {
  id: 'addr-1',
  label: 'Works',
  contactName: 'Pay Buyer',
  contactPhone: '+91 90000 00000',
  line1: 'Gate 3',
  line2: null,
  city: 'Pune',
  state: 'MH',
  postalCode: '411019',
  country: 'IN',
  isDefaultBilling: true,
  isDefaultShipping: true,
  archivedAt: null,
};

const cart = makeCart();

/** A saved card, as `GET /account/payment-methods` returns one. */
function card(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'card-credit-1',
    provider: 'STRIPE',
    brand: 'Visa',
    last4: '4242',
    expMonth: 11,
    expYear: 2030,
    funding: 'credit',
    status: 'ACTIVE',
    isDefault: true,
    instrument: 'CREDIT_CARD',
    consentScope: 'CHECKOUT',
    ...overrides,
  };
}

interface ServeOptions {
  instruments?: { instrument: string; canSaveCard: boolean; savedCardsChargeableHere: boolean }[];
  cards?: Record<string, unknown>[];
  onCheckout?: (body: Record<string, unknown>) => void;
  /**
   * The warehouse answer. Defaults to the empty one, which is what a store
   * quoting no delivery zones returns and what leaves checkout behaving the
   * way it did before the section existed.
   */
  fulfilment?: WarehouseOptionsResponse;
  /** What the revalidation says when Place Order is pressed. */
  revalidate?: QuoteCheck;
  /** The checkout POST fails with this envelope instead of creating an order. */
  checkoutError?: { status: number; code: string; message: string };
}

const CARD_INSTRUMENTS = [
  { instrument: 'CREDIT_CARD', canSaveCard: true, savedCardsChargeableHere: true },
  { instrument: 'DEBIT_CARD', canSaveCard: true, savedCardsChargeableHere: true },
];

function serve(options: ServeOptions = {}): void {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/account/addresses')) {
      return Promise.resolve(jsonResponse({ addresses: [address] }));
    }

    if (url.includes('/payments/instruments')) {
      return Promise.resolve(
        jsonResponse({ instruments: options.instruments ?? CARD_INSTRUMENTS }),
      );
    }

    if (url.includes('/account/payment-methods')) {
      return Promise.resolve(jsonResponse({ paymentMethods: options.cards ?? [] }));
    }

    // Checked before the plain options path, because the revalidation URL
    // contains it: `/warehouse-options/:quoteId/revalidate`.
    if (url.includes('/revalidate')) {
      return Promise.resolve(
        jsonResponse(
          options.revalidate ?? {
            ok: true,
            quoteId: 'quote-pune-000000000000000',
            code: null,
            message: null,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          },
        ),
      );
    }

    if (url.includes('/fulfilment/warehouse-options')) {
      return Promise.resolve(jsonResponse(options.fulfilment ?? makeWarehouseOptions()));
    }

    if (url.includes('/cart/checkout')) {
      if (options.checkoutError !== undefined) {
        const failure = options.checkoutError;
        const body = typeof init?.body === 'string' ? init.body : '{}';
        options.onCheckout?.(JSON.parse(body) as Record<string, unknown>);

        return Promise.resolve(errorResponse(failure.status, failure.code, failure.message));
      }

      // `body` is typed as a BodyInit union, but the API client always sends a
      // JSON string. Narrowed rather than stringified, so a change that starts
      // sending FormData shows up here as an empty body instead of as the
      // characters "[object FormData]" silently failing to parse.
      const body = typeof init?.body === 'string' ? init.body : '{}';
      options.onCheckout?.(JSON.parse(body) as Record<string, unknown>);

      return Promise.resolve(
        jsonResponse(
          {
            orderId: 'order-1',
            orderNumber: 'UB-2026-000042',
            status: 'PENDING_PAYMENT',
            currency: 'INR',
            totals: cart.totals,
            requiresApproval: false,
            paymentMode: 'ONLINE',
          },
          201,
        ),
      );
    }

    if (url.includes('/cart')) {
      return Promise.resolve(jsonResponse({ cart }));
    }

    return Promise.resolve(jsonResponse({}));
  });
}

async function renderCheckout(): Promise<void> {
  renderWithProviders(<CheckoutPage />);
  await screen.findByText('Pay with Credit Card');
}

describe('choosing how to pay', () => {
  it('offers instruments and never names the gateway behind them', async () => {
    serve();
    await renderCheckout();

    expect(screen.getByText('Pay with Credit Card')).toBeInTheDocument();
    expect(screen.getByText('Pay with Debit Card')).toBeInTheDocument();

    // The whole point of the change. A customer is never shown which acquirer
    // settles their money, because it is not theirs to choose and knowing it
    // helps them not at all.
    expect(screen.queryByText(/razorpay/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/stripe/i)).not.toBeInTheDocument();
  });

  it('offers UPI only when the server says it is available', async () => {
    serve();
    await renderCheckout();
    expect(screen.queryByText('Pay with UPI')).not.toBeInTheDocument();

    fetchMock.mockReset();
    serve({
      instruments: [
        ...CARD_INSTRUMENTS,
        { instrument: 'UPI', canSaveCard: false, savedCardsChargeableHere: false },
      ],
    });
    renderWithProviders(<CheckoutPage />);

    expect(await screen.findByText('Pay with UPI')).toBeInTheDocument();
  });

  it('says so plainly when nothing can take an online payment', async () => {
    serve({ instruments: [] });
    renderWithProviders(<CheckoutPage />);

    // Not an empty radio group. The customer can still place the order and pay
    // by link, and that is the useful thing to tell them.
    expect(
      await screen.findByText(/cannot take an online payment in this currency/i),
    ).toBeInTheDocument();
  });
});

describe('paying with a card the customer already saved', () => {
  it('offers a saved card under the instrument it belongs to, and not the other', async () => {
    serve({ cards: [card()] });
    await renderCheckout();

    expect(await screen.findByText('Visa ···· 4242')).toBeInTheDocument();

    // Moving to Debit must take the credit card off the screen. Offering it
    // there is a refusal waiting to happen on the next page, at the moment the
    // customer thought they were finished.
    await userEvent.click(screen.getByRole('radio', { name: /Pay with Debit Card/i }));

    await waitFor(() => {
      expect(screen.queryByText('Visa ···· 4242')).not.toBeInTheDocument();
    });
  });

  it('shows a card of unknown funding under both headings', async () => {
    // A prepaid card, or one the gateway would not describe. It is perfectly
    // usable, so filing it wrongly under one heading would be worse than
    // showing it under both.
    serve({ cards: [card({ id: 'card-prepaid', funding: 'prepaid', instrument: null })] });
    await renderCheckout();

    expect(await screen.findByText('Visa ···· 4242')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: /Pay with Debit Card/i }));
    expect(await screen.findByText('Visa ···· 4242')).toBeInTheDocument();
  });

  it('offers no card list at all to somebody who has saved none', async () => {
    serve({ cards: [] });
    await renderCheckout();

    // Everybody's first order. A "use a different card" option with nothing to
    // differ from would be a choice of one.
    expect(screen.queryByText(/use a different card/i)).not.toBeInTheDocument();
  });

  it('sends the instrument and the chosen card to the order', async () => {
    const bodies: Record<string, unknown>[] = [];
    serve({
      cards: [card()],
      onCheckout: (body) => bodies.push(body),
    });
    await renderCheckout();

    await screen.findByText('Visa ···· 4242');
    await userEvent.click(screen.getByRole('radio', { name: /Visa ···· 4242/i }));
    await userEvent.click(screen.getByRole('button', { name: /place order and pay/i }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });

    // Both recorded on the order, which is what lets the payment page read
    // them back after a reload rather than starting the decision again.
    expect(bodies[0]?.preferredPaymentInstrument).toBe('CREDIT_CARD');
    expect(bodies[0]?.preferredPaymentMethodId).toBe('card-credit-1');
    // And no gateway, because this page no longer knows about any.
    expect(bodies[0]).not.toHaveProperty('preferredPaymentProvider');
  });

  it('sends no card when the customer chooses to enter a different one', async () => {
    const bodies: Record<string, unknown>[] = [];
    serve({ cards: [card({ isDefault: false })], onCheckout: (body) => bodies.push(body) });
    await renderCheckout();

    const list = await screen.findByText(/use a different card/i);
    await userEvent.click(within(list.closest('label') as HTMLElement).getByRole('radio'));
    await userEvent.click(screen.getByRole('button', { name: /place order and pay/i }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });

    expect(bodies[0]?.preferredPaymentInstrument).toBe('CREDIT_CARD');
    expect(bodies[0]).not.toHaveProperty('preferredPaymentMethodId');
  });
});

/**
 * Which warehouse the order leaves from.
 *
 * The properties worth holding to are the ones that decide whether a customer
 * is charged what they were shown:
 *
 *   1. **Every eligible warehouse is offered, with its own dates and total.**
 *      A list of one is a decision nobody was given.
 *   2. **The chosen quote reaches the order.** Losing it drops the customer
 *      onto whatever the server would have picked, at a different price.
 *   3. **The offer is re-checked before the order is created**, and a refusal
 *      creates no order.
 *   4. **Nothing is ever substituted.** A warehouse that disappears clears the
 *      selection and asks again rather than quietly moving to the next one.
 *   5. **A store with no delivery zones is unaffected**, which is the
 *      regression that would take every such deployment's checkout offline.
 */
describe('choosing a fulfilment warehouse', () => {
  const pune = makeWarehouseOption();

  const antwerp = makeWarehouseOption({
    quoteId: 'quote-antw-000000000000000',
    warehouse: {
      id: 'wh-antwerp',
      code: 'ANR',
      name: 'Antwerp Depot',
      countryCode: 'BE',
      countryName: 'Belgium',
      city: 'Antwerp',
      operationalStatus: 'OPERATIONAL',
    },
    carrier: { name: 'PostNL', serviceLevel: 'Standard' },
    transitDays: { min: 5, max: 7 },
    dispatchDate: '2026-09-14',
    deliveryFromDate: '2026-09-21',
    deliveryToDate: '2026-09-23',
    totals: {
      subtotal: money('45500'),
      discount: money('0'),
      tax: money('8190'),
      shipping: money('0'),
      grandTotal: money('53690'),
    },
    isFastest: false,
    isCheapest: true,
    isRecommended: false,
  });

  const bothOptions = makeWarehouseOptions({ options: [pune, antwerp] });

  it('shows every eligible warehouse with its own arrival and total', async () => {
    serve({ fulfilment: bothOptions });
    await renderCheckout();

    expect(await screen.findByText('Pune Fulfilment Centre')).toBeInTheDocument();
    expect(screen.getByText('Antwerp Depot')).toBeInTheDocument();

    // The badges are the server's verdicts, rendered rather than recomputed.
    expect(screen.getByText('Fastest delivery')).toBeInTheDocument();
    expect(screen.getByText('Lowest price')).toBeInTheDocument();
    expect(screen.getByText('Recommended')).toBeInTheDocument();

    // Each card carries its own price, or there is nothing to compare. Pune's
    // total appears twice — on its card and in the summary, because it is the
    // recommended option and therefore the one being reviewed.
    expect(screen.getAllByText('₹661.90').length).toBeGreaterThan(0);
    expect(screen.getAllByText('₹536.90').length).toBeGreaterThan(0);
  });

  it('opens on the recommended option and sends its quote with the order', async () => {
    let sent: Record<string, unknown> | null = null;
    serve({
      fulfilment: bothOptions,
      onCheckout: (body) => {
        sent = body;
      },
    });
    await renderCheckout();

    await screen.findByText('Pune Fulfilment Centre');

    await userEvent.click(screen.getByRole('button', { name: /place order/i }));

    await waitFor(() => {
      expect(sent).not.toBeNull();
    });
    expect(sent).toMatchObject({ fulfilmentQuoteId: pune.quoteId });
  });

  it('sends the quote of the warehouse the customer picked instead', async () => {
    let sent: Record<string, unknown> | null = null;
    serve({
      fulfilment: bothOptions,
      onCheckout: (body) => {
        sent = body;
      },
    });
    await renderCheckout();

    await screen.findByText('Antwerp Depot');
    await userEvent.click(screen.getAllByRole('radio', { name: /antwerp/i })[0]!);

    // The summary follows the choice, or the page quotes one number and
    // charges another.
    expect(await screen.findByText(/sent from antwerp depot/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /place order/i }));

    await waitFor(() => {
      expect(sent).not.toBeNull();
    });
    expect(sent).toMatchObject({ fulfilmentQuoteId: antwerp.quoteId });
  });

  it('creates no order when the offer no longer stands', async () => {
    let sent: Record<string, unknown> | null = null;
    serve({
      fulfilment: bothOptions,
      revalidate: {
        ok: false,
        quoteId: pune.quoteId,
        code: 'FULFILMENT_STOCK_CHANGED',
        message: 'Pune has run out of that while you were checking out.',
        expiresAt: new Date(0).toISOString(),
      },
      onCheckout: (body) => {
        sent = body;
      },
    });
    await renderCheckout();

    await screen.findByText('Pune Fulfilment Centre');
    await userEvent.click(screen.getByRole('button', { name: /place order/i }));

    // Said twice on purpose: in the section they now have to act in, and
    // beside the button they just pressed.
    expect(
      (await screen.findAllByText(/run out of that while you were checking out/i)).length,
    ).toBeGreaterThan(0);

    // The whole point: the checkout POST was never made.
    expect(sent).toBeNull();
  });

  it('will not place an order when no warehouse can send it', async () => {
    serve({
      fulfilment: makeWarehouseOptions({
        options: [],
        ineligible: [
          {
            warehouse: pune.warehouse,
            reason: 'INSUFFICIENT_STOCK',
            message: 'This warehouse does not hold enough of one item.',
            shortLines: [{ ...pune.lines[0]!, availableQty: 2 }],
          },
        ],
      }),
    });
    await renderCheckout();

    expect(await screen.findByText(/no warehouse can send this order/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /place order/i })).toBeDisabled();

    // The near miss is named, with the numbers, rather than hidden — and the
    // reason it cannot simply be split is said once.
    await userEvent.click(screen.getByText(/why one other warehouse cannot/i));
    expect(screen.getByText(/you want 10, this warehouse has 2/i)).toBeInTheDocument();
    expect(screen.getByText(/do not split one order across warehouses/i)).toBeInTheDocument();
  });

  it('leaves a store with no delivery zones exactly as it was', async () => {
    let sent: Record<string, unknown> | null = null;
    serve({
      onCheckout: (body) => {
        sent = body;
      },
    });
    await renderCheckout();

    const place = screen.getByRole('button', { name: /place order/i });
    await waitFor(() => {
      expect(place).toBeEnabled();
    });

    await userEvent.click(place);

    await waitFor(() => {
      expect(sent).not.toBeNull();
    });
    // No quote, and no section standing in the way of the button.
    expect(sent).not.toHaveProperty('fulfilmentQuoteId');
  });

  it('does not block a store whose warehouses have no lane to this address', async () => {
    let sent: Record<string, unknown> | null = null;
    serve({
      // What a deployment that has never drawn a delivery zone returns: every
      // warehouse listed, none of them serving here. It fulfils the old way,
      // and this section must not stand in front of its checkout.
      fulfilment: makeWarehouseOptions({
        options: [],
        ineligible: [
          {
            warehouse: pune.warehouse,
            reason: 'NO_DELIVERY_ZONE',
            message: 'This warehouse has no delivery service covering your address.',
            shortLines: [],
          },
        ],
      }),
      onCheckout: (body) => {
        sent = body;
      },
    });
    await renderCheckout();

    const place = screen.getByRole('button', { name: /place order/i });
    await waitFor(() => {
      expect(place).toBeEnabled();
    });

    await userEvent.click(place);

    await waitFor(() => {
      expect(sent).not.toBeNull();
    });
    expect(sent).not.toHaveProperty('fulfilmentQuoteId');
  });

  it('asks again rather than moving the order to another warehouse', async () => {
    serve({
      fulfilment: bothOptions,
      checkoutError: {
        status: 409,
        code: 'FULFILMENT_WAREHOUSE_UNAVAILABLE',
        message: 'That warehouse stopped shipping while you were checking out.',
      },
    });
    await renderCheckout();

    await screen.findByText('Antwerp Depot');
    await userEvent.click(screen.getAllByRole('radio', { name: /antwerp/i })[0]!);
    await userEvent.click(screen.getByRole('button', { name: /place order/i }));

    expect(
      (await screen.findAllByText(/stopped shipping while you were checking out/i)).length,
    ).toBeGreaterThan(0);

    // Nothing is selected now, and the button says so instead of quietly
    // falling back to Pune.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /place order/i })).toBeDisabled();
    });
    expect(screen.getByText(/choose a warehouse to place this order/i)).toBeInTheDocument();
  });
});
