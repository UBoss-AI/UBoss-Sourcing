/**
 * Stripe Checkout, from the payment page's side.
 *
 * What these protect:
 *
 *   · The page sends this tab to the address the server returned - and only
 *     if it is an https Stripe page for that very session. Anything else would
 *     be an open redirect with a payment page's credibility.
 *   · One press is one request. A double click, or a click while the tab is
 *     already leaving, must not ask the server twice.
 *   · The browser supplies no money. The request body carries a tick-box and
 *     nothing about amount, currency, tax, discount or delivery.
 *   · Coming back through Cancel closes the page at Stripe and says nothing
 *     was charged - unless the server says it WAS paid, in another tab.
 *   · Stripe's own error text never reaches the customer.
 *
 * The navigation itself is stubbed: jsdom cannot leave the page.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { PaymentPage } from './PaymentPage';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';
import { money } from '@/test/fixtures';

const goToCheckout = vi.fn<(url: string) => void>();

vi.mock('@/lib/stripe-checkout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/stripe-checkout')>();
  return { ...actual, goToCheckout: (url: string) => { goToCheckout(url); } };
});

vi.mock('@/lib/razorpay', () => ({
  openRazorpayCheckout: () => Promise.resolve({ kind: 'dismissed' }),
  loadRazorpay: () => Promise.resolve(),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  goToCheckout.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const SESSION_ID = 'cs_test_a1B2c3D4e5F6g7H8';
const CHECKOUT_URL = `https://checkout.stripe.com/c/pay/${SESSION_ID}#fragment`;

function order(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'order-1',
    orderNumber: 'UB-2026-000042',
    status: 'PENDING_PAYMENT',
    source: 'WEB',
    currency: 'INR',
    paymentMode: 'ONLINE',
    preferredPaymentInstrument: 'CREDIT_CARD',
    preferredPaymentMethodId: null,
    placedAt: '2026-09-03T10:00:00.000Z',
    confirmedAt: null,
    itemCount: 2,
    createdAt: '2026-09-03T10:00:00.000Z',
    totals: {
      subtotal: money('50000'),
      discount: money('5000'),
      tax: money('8100'),
      shipping: money('1500'),
      grandTotal: money('54600'),
      paid: money('0'),
      refunded: money('0'),
    },
    items: [{ id: 'line-1', productId: 'p1', variantId: null, name: 'Gloves', sku: 'G-1', variantName: null, quantity: 2 }],
    timeline: [],
    shippingAddress: null,
    billingAddress: {
      contactName: 'Asha Rao',
      contactPhone: null,
      line1: '12 MG Road',
      line2: null,
      city: 'Bengaluru',
      state: 'KA',
      postalCode: '560001',
      country: 'IN',
    },
    shippingMethodName: null,
    customerNote: null,
    cancelReason: null,
    shipments: [],
    approval: null,
    ...overrides,
  };
}

interface ServeOptions {
  /** Successive answers from the session endpoint. The last one repeats. */
  sessions?: Response[];
  onSession?: (init?: RequestInit) => void;
  cancelResponse?: Record<string, unknown>;
  onCancel?: () => void;
}

function redirectSession(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse(
    {
      paymentTransactionId: 'txn-1',
      provider: 'STRIPE',
      mode: 'TEST',
      providerOrderId: '',
      amount: money('54600'),
      checkoutPayload: {},
      instrument: 'CREDIT_CARD',
      next: 'REDIRECT',
      redirectUrl: CHECKOUT_URL,
      checkoutSessionId: SESSION_ID,
      expiresAt: '2026-09-03T10:32:00.000Z',
      ...overrides,
    },
    201,
  );
}

function serve(options: ServeOptions = {}): void {
  const sessions = [...(options.sessions ?? [redirectSession()])];

  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/payments/instruments')) {
      return Promise.resolve(
        jsonResponse({
          instruments: [
            {
              instrument: 'CREDIT_CARD',
              canSaveCard: true,
              savedCardsChargeableHere: false,
              hostedCheckout: true,
            },
          ],
          mockPayments: false,
        }),
      );
    }

    if (url.endsWith('/checkout/cancel')) {
      options.onCancel?.();
      return Promise.resolve(
        jsonResponse(options.cancelResponse ?? { state: 'CANCELLED', checkoutSessionId: SESSION_ID }),
      );
    }

    if (url.endsWith('/session')) {
      options.onSession?.(init);
      const next = sessions.length > 1 ? sessions.shift() : sessions[0];
      return Promise.resolve((next ?? redirectSession()).clone());
    }

    if (url.includes('/checkout/')) {
      return Promise.resolve(
        jsonResponse({
          state: 'SUCCEEDED',
          orderId: 'order-1',
          orderNumber: 'UB-2026-000042',
          orderStatus: 'CONFIRMED',
          amount: money('54600'),
          paidAt: '2026-09-03T10:05:00.000Z',
          card: { brand: 'visa', last4: '4242' },
          failureReason: null,
          canRetry: false,
        }),
      );
    }

    return Promise.resolve(jsonResponse({ order: order() }));
  });
}

function renderPayment(route = '/checkout/payment/order-1'): void {
  renderWithProviders(
    <Routes>
      <Route path="/checkout/payment/:orderId" element={<PaymentPage />} />
      <Route
        path="/checkout/payment/:orderId/confirmation"
        element={<p>confirmation page</p>}
      />
    </Routes>,
    { route },
  );
}

describe('PaymentPage with Stripe Checkout', () => {
  it('shows the order as the server priced it, before anything is started', async () => {
    serve();
    renderPayment();

    expect(await screen.findByText('₹546.00')).toBeInTheDocument();
    expect(screen.getByText('−₹50.00')).toBeInTheDocument();
    expect(screen.getByText('₹15.00')).toBeInTheDocument();
    expect(screen.getByText('₹81.00')).toBeInTheDocument();
    expect(screen.getByText('2 items')).toBeInTheDocument();
    expect(screen.getByText(/charged in inr/i)).toBeInTheDocument();
    expect(screen.getByText('Asha Rao')).toBeInTheDocument();
    expect(screen.getByText(/processed securely by stripe/i)).toBeInTheDocument();
    expect(goToCheckout).not.toHaveBeenCalled();
  });

  it('sends this tab to the Stripe page the server returned', async () => {
    const user = userEvent.setup();
    serve();
    renderPayment();

    await user.click(await screen.findByRole('button', { name: /pay securely now/i }));

    await waitFor(() => {
      expect(goToCheckout).toHaveBeenCalledWith(CHECKOUT_URL);
    });

    // Still leaving: the button stays disabled and says so.
    const button = screen.getByRole('button', { name: /opening secure payment/i });
    expect(button).toBeDisabled();
  });

  it('asks the server once, however quickly the button is pressed', async () => {
    const user = userEvent.setup();
    let requests = 0;

    serve({ onSession: () => { requests += 1; } });
    renderPayment();

    const button = await screen.findByRole('button', { name: /pay securely now/i });
    await user.dblClick(button);
    await user.click(button);

    await waitFor(() => {
      expect(goToCheckout).toHaveBeenCalledTimes(1);
    });
    expect(requests).toBe(1);
  });

  it('sends no amount, currency or price of any kind', async () => {
    const user = userEvent.setup();
    let body: unknown = null;

    serve({
      onSession: (init) => {
        body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      },
    });
    renderPayment();

    await user.click(await screen.findByRole('button', { name: /pay securely now/i }));
    await waitFor(() => {
      expect(body).not.toBeNull();
    });

    expect(body).toEqual({ saveCard: false });
  });

  it('shows no save tick of its own - Stripe asks on its own page', async () => {
    serve();
    renderPayment();

    await screen.findByRole('button', { name: /pay securely now/i });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText(/never ticked for you/i)).toBeInTheDocument();
  });

  it('refuses to navigate anywhere but an https page for that session', async () => {
    const user = userEvent.setup();

    serve({
      sessions: [
        redirectSession({ redirectUrl: 'http://checkout.stripe.com/c/pay/cs_test_a1B2c3D4e5F6g7H8' }),
        redirectSession({ redirectUrl: 'https://evil.example/c/pay/cs_test_somebodyElse123' }),
      ],
    });
    renderPayment();

    await user.click(await screen.findByRole('button', { name: /pay securely now/i }));
    expect(await screen.findByText(/could not open the secure payment page/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /try the payment again/i }));
    expect(await screen.findByText(/could not open the secure payment page/i)).toBeInTheDocument();

    expect(goToCheckout).not.toHaveBeenCalled();
  });

  it('waits and asks again while another tab is opening the same payment', async () => {
    const user = userEvent.setup();
    let requests = 0;

    serve({
      sessions: [
        errorResponse(409, 'PAYMENT_ATTEMPT_IN_PROGRESS', 'being opened'),
        redirectSession(),
      ],
      onSession: () => { requests += 1; },
    });
    renderPayment();

    await user.click(await screen.findByRole('button', { name: /pay securely now/i }));

    await waitFor(
      () => {
        expect(goToCheckout).toHaveBeenCalledWith(CHECKOUT_URL);
      },
      { timeout: 5000 },
    );
    expect(requests).toBe(2);
  });

  it('says it in its own words when Stripe cannot be reached', async () => {
    const user = userEvent.setup();

    serve({
      sessions: [
        errorResponse(400, 'PAYMENT_PROVIDER_ERROR', 'Invalid API Key provided: sk_test_***'),
      ],
    });
    renderPayment();

    await user.click(await screen.findByRole('button', { name: /pay securely now/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not open the secure payment page/i);
    expect(document.body.innerHTML).not.toContain('Invalid API Key');
    // The error summary takes focus, so a keyboard user is told.
    await waitFor(() => {
      expect(alert).toHaveFocus();
    });
  });

  it('says honestly when card payment is not set up', async () => {
    const user = userEvent.setup();

    serve({
      sessions: [errorResponse(400, 'PAYMENT_PROVIDER_NOT_CONFIGURED', 'No payment provider')],
    });
    renderPayment();

    await user.click(await screen.findByRole('button', { name: /pay securely now/i }));
    expect(await screen.findByText(/card payment is not set up on this store/i)).toBeInTheDocument();
  });

  it('goes straight to the confirmation when the order is already being paid', async () => {
    const user = userEvent.setup();

    serve({
      sessions: [redirectSession({ next: 'AWAIT_CONFIRMATION', redirectUrl: null })],
    });
    renderPayment();

    await user.click(await screen.findByRole('button', { name: /pay securely now/i }));

    expect(await screen.findByText('confirmation page')).toBeInTheDocument();
    expect(goToCheckout).not.toHaveBeenCalled();
  });
});

describe('Back from Stripe through Cancel', () => {
  it('closes the Stripe page and says nothing was charged', async () => {
    const onCancel = vi.fn();
    serve({ onCancel });

    renderPayment('/checkout/payment/order-1?payment=cancelled');

    expect(await screen.findByText('Payment cancelled')).toBeInTheDocument();
    expect(screen.getByText(/nothing was charged/i)).toBeInTheDocument();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: /try the payment again/i })).toBeEnabled();
  });

  it('goes to the confirmation instead when it had in fact been paid', async () => {
    serve({ cancelResponse: { state: 'SUCCEEDED', checkoutSessionId: SESSION_ID } });

    renderPayment('/checkout/payment/order-1?payment=cancelled');

    expect(await screen.findByText('confirmation page')).toBeInTheDocument();
  });
});
