/**
 * Payment states.
 *
 * The property these tests exist to protect: **the browser never decides that
 * an order is paid.** Razorpay's success callback fires in the customer's own
 * tab and anyone can fire it, so a "submitted" outcome must produce a
 * Processing state and a question to the backend — never a confirmation.
 *
 * The provider module is stubbed, because the real one opens a hosted iframe.
 * What is *not* stubbed is the decision logic, which is the part that matters.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { PaymentPage } from './PaymentPage';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';
import { money } from '@/test/fixtures';
import type { CheckoutOutcome } from '@/lib/razorpay';

const openCheckout = vi.fn<() => Promise<CheckoutOutcome>>();

vi.mock('@/lib/razorpay', () => ({
  openRazorpayCheckout: () => openCheckout(),
  loadRazorpay: () => Promise.resolve(),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  openCheckout.mockReset();
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
    paymentMode: 'ONLINE',
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

interface ServeOptions {
  orderBody?: Record<string, unknown>;
  /** Successive answers from the status endpoint, in order. */
  statuses?: { status: string; paid: boolean; orderStatus: string }[];
  sessionResponse?: Response;
  onSession?: (init?: RequestInit) => void;
}

function serve(options: ServeOptions = {}): void {
  const statuses = [...(options.statuses ?? [])];

  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/payments/orders/') && url.endsWith('/session')) {
      options.onSession?.(init);
      return Promise.resolve(
        options.sessionResponse ??
          jsonResponse(
            {
              paymentTransactionId: 'txn-1',
              provider: 'RAZORPAY',
              mode: 'TEST',
              providerOrderId: 'order_TEST123',
              amount: money('53690'),
              checkoutPayload: { key: 'rzp_test_abc', order_id: 'order_TEST123', amount: 53690 },
            },
            201,
          ),
      );
    }

    if (url.includes('/status')) {
      const next = statuses.shift() ?? {
        status: 'CREATED',
        paid: false,
        orderStatus: 'PENDING_PAYMENT',
      };
      return Promise.resolve(jsonResponse(next));
    }

    return Promise.resolve(jsonResponse({ order: options.orderBody ?? order() }));
  });
}

function renderPayment(): void {
  renderWithProviders(
    <Routes>
      <Route path="/checkout/payment/:orderId" element={<PaymentPage />} />
    </Routes>,
    { route: '/checkout/payment/order-1' },
  );
}

describe('PaymentPage', () => {
  it('shows the amount due and does not start until asked', async () => {
    serve();
    renderPayment();

    expect(await screen.findByText('₹536.90')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pay securely now/i })).toBeInTheDocument();
    expect(openCheckout).not.toHaveBeenCalled();
  });

  it('says a retry cannot create a second order, because it cannot', async () => {
    serve();
    renderPayment();

    expect(
      await screen.findByText(/retrying uses this same order/i),
    ).toBeInTheDocument();
  });

  it('waits for the backend after the provider reports success', async () => {
    const user = userEvent.setup();

    openCheckout.mockResolvedValue({ kind: 'submitted' });
    serve({
      // The webhook has not landed yet, which is the normal case.
      statuses: [{ status: 'AUTHORIZED', paid: false, orderStatus: 'PENDING_PAYMENT' }],
    });

    renderPayment();
    await user.click(await screen.findByRole('button', { name: /pay securely now/i }));

    // "Submitted" is a claim from the customer's own tab. It buys a Processing
    // state and a question to the backend — never a confirmation.
    expect(await screen.findByText('Confirming your payment')).toBeInTheDocument();
    expect(screen.queryByText('Payment confirmed')).not.toBeInTheDocument();
  });

  it('confirms only once the backend says the payment is verified', async () => {
    const user = userEvent.setup();

    openCheckout.mockResolvedValue({ kind: 'submitted' });
    serve({
      statuses: [
        { status: 'AUTHORIZED', paid: false, orderStatus: 'PENDING_PAYMENT' },
        { status: 'CAPTURED', paid: true, orderStatus: 'CONFIRMED' },
      ],
    });

    renderPayment();
    await user.click(await screen.findByRole('button', { name: /pay securely now/i }));

    await screen.findByText('Confirming your payment');

    await waitFor(
      () => {
        expect(screen.getByText('Payment confirmed')).toBeInTheDocument();
      },
      { timeout: 6000 },
    );
  });

  it('keeps the order intact when the customer closes the provider window', async () => {
    const user = userEvent.setup();

    openCheckout.mockResolvedValue({ kind: 'dismissed' });
    serve();

    renderPayment();
    await user.click(await screen.findByRole('button', { name: /pay securely now/i }));

    expect(await screen.findByText('Payment not completed')).toBeInTheDocument();
    expect(
      screen.getByText(/your order is saved and still awaiting payment/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try the payment again/i })).toBeInTheDocument();
  });

  it('shows the provider’s own wording when a payment fails', async () => {
    const user = userEvent.setup();

    openCheckout.mockResolvedValue({
      kind: 'failed',
      message: 'Your card was declined by the issuing bank.',
    });
    serve();

    renderPayment();
    await user.click(await screen.findByRole('button', { name: /pay securely now/i }));

    expect(
      await screen.findByText('Your card was declined by the issuing bank.'),
    ).toBeInTheDocument();
  });

  it('reuses one idempotency key across retries, so one payment can never become two', async () => {
    const user = userEvent.setup();
    const keys: string[] = [];

    openCheckout.mockResolvedValue({ kind: 'dismissed' });
    serve({
      onSession: (init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers?.['Idempotency-Key'] !== undefined) keys.push(headers['Idempotency-Key']);
      },
    });

    renderPayment();

    await user.click(await screen.findByRole('button', { name: /pay securely now/i }));
    await screen.findByRole('button', { name: /try the payment again/i });

    await user.click(screen.getByRole('button', { name: /try the payment again/i }));

    await waitFor(() => {
      expect(keys).toHaveLength(2);
    });

    // The same key means the backend replays the original session rather than
    // creating a second payment against the order.
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('surfaces the server’s refusal when a session cannot be created', async () => {
    const user = userEvent.setup();

    serve({
      sessionResponse: errorResponse(
        409,
        'ORDER_ALREADY_PAID',
        'This order is already paid in full.',
      ),
    });

    renderPayment();
    await user.click(await screen.findByRole('button', { name: /pay securely now/i }));

    expect(await screen.findByText('This order is already paid in full.')).toBeInTheDocument();
    expect(openCheckout).not.toHaveBeenCalled();
  });

  it('recognises an order a webhook settled before the page opened', async () => {
    serve({
      orderBody: order({
        status: 'CONFIRMED',
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
    });

    renderPayment();

    // A webhook can land while the customer is still on the provider's screen.
    expect(await screen.findByText('Payment confirmed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pay securely now/i })).not.toBeInTheDocument();
  });

  it('never puts card wording or a secret on the page', async () => {
    serve();
    renderPayment();

    await screen.findByRole('button', { name: /pay securely now/i });

    const html = document.body.innerHTML.toLowerCase();
    expect(html).not.toContain('cvv');
    expect(html).not.toContain('card number');
    expect(html).not.toContain('secret');
  });
});
