/**
 * The page Stripe Checkout returns a customer to.
 *
 * The property above all others: **arriving here proves nothing.** The page
 * says "Payment successful" only after the backend has, and the backend says
 * it only from Stripe's signed webhook or Stripe's own API. A return with no
 * webhook yet is "Confirming payment…", and a long wait is "delayed", never
 * "failed" - the money may well have moved.
 */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { PaymentConfirmationPage } from './PaymentConfirmationPage';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';
import { money } from '@/test/fixtures';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SESSION_ID = 'cs_test_a1B2c3D4e5F6g7H8';

type View = Record<string, unknown>;

function view(overrides: View = {}): View {
  return {
    state: 'CONFIRMING',
    orderId: 'order-1',
    orderNumber: 'UB-2026-000042',
    orderStatus: 'PENDING_PAYMENT',
    amount: money('54600'),
    paidAt: null,
    card: null,
    failureReason: null,
    canRetry: false,
    ...overrides,
  };
}

const succeeded = view({
  state: 'SUCCEEDED',
  orderStatus: 'CONFIRMED',
  paidAt: '2026-09-03T10:05:00.000Z',
  card: { brand: 'visa', last4: '4242' },
});

function serve(options: { views?: View[]; refresh?: View; onRefresh?: () => void; status?: number } = {}): {
  statusCalls: () => number;
} {
  const views = [...(options.views ?? [view()])];
  let statusCalls = 0;

  fetchMock.mockImplementation((url: string) => {
    if (url.endsWith('/refresh')) {
      options.onRefresh?.();
      return Promise.resolve(jsonResponse(options.refresh ?? succeeded));
    }

    if (url.includes('/checkout/')) {
      statusCalls += 1;
      if (options.status === 404) {
        return Promise.resolve(errorResponse(404, 'NOT_FOUND', 'Payment was not found.'));
      }
      const next = views.length > 1 ? views.shift() : views[0];
      return Promise.resolve(jsonResponse(next));
    }

    return Promise.resolve(jsonResponse({}));
  });

  return { statusCalls: () => statusCalls };
}

function renderConfirmation(sessionId = SESSION_ID): void {
  renderWithProviders(
    <Routes>
      <Route path="/checkout/payment/:orderId/confirmation" element={<PaymentConfirmationPage />} />
    </Routes>,
    { route: `/checkout/payment/order-1/confirmation?session_id=${sessionId}` },
  );
}

describe('PaymentConfirmationPage', () => {
  it('says "confirming" - not "paid" - when the webhook has not arrived', async () => {
    serve({ views: [view()] });
    renderConfirmation();

    expect(await screen.findByText('Confirming payment…')).toBeInTheDocument();
    expect(screen.queryByText('Payment successful')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /retry payment/i })).not.toBeInTheDocument();
  });

  it('turns to success only once the backend says so, and shows what was paid', async () => {
    serve({ views: [view(), succeeded] });
    renderConfirmation();

    await screen.findByText('Confirming payment…');

    expect(await screen.findByText('Payment successful', {}, { timeout: 6000 })).toBeInTheDocument();
    expect(screen.getByText(/UB-2026-000042 is paid/)).toBeInTheDocument();
    expect(screen.getAllByText('UB-2026-000042').length).toBeGreaterThan(0);
    expect(screen.getByText('₹546.00')).toBeInTheDocument();
    expect(screen.getByText('Visa ending in 4242')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view order/i })).toHaveAttribute(
      'href',
      '/account/orders/order-1',
    );
    expect(screen.getByRole('link', { name: /continue shopping/i })).toBeInTheDocument();
  });

  it('never shows more of the card than its brand and last four', async () => {
    serve({ views: [succeeded] });
    renderConfirmation();

    await screen.findByText('Payment successful');
    const html = document.body.innerHTML.toLowerCase();

    expect(html).not.toContain('cvc');
    expect(html).not.toContain('client_secret');
    expect(html).not.toMatch(/\d{12,}/);
  });

  it('explains a failure in its own words and offers a retry', async () => {
    serve({
      views: [view({ state: 'FAILED', failureReason: 'INSUFFICIENT_FUNDS', canRetry: true })],
    });
    renderConfirmation();

    expect(await screen.findByText('Payment failed')).toBeInTheDocument();
    expect(screen.getByText('The card did not have enough funds.')).toBeInTheDocument();
    expect(screen.getByText(/saved card has expired or no longer works/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /retry payment/i })).toHaveAttribute(
      'href',
      '/checkout/payment/order-1',
    );
  });

  it('offers a fresh payment when the Stripe page expired unpaid', async () => {
    serve({ views: [view({ state: 'EXPIRED', canRetry: true })] });
    renderConfirmation();

    expect(await screen.findByText('Session expired')).toBeInTheDocument();
    expect(screen.getByText(/nothing was charged/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /retry payment/i })).toBeInTheDocument();
  });

  it('says the bank is still processing, and does not offer to pay again', async () => {
    serve({ views: [view({ state: 'PROCESSING' })] });
    renderConfirmation();

    expect(await screen.findByText('Payment processing')).toBeInTheDocument();
    expect(screen.getByText(/do not pay again/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /retry payment/i })).not.toBeInTheDocument();
  });

  it('stops asking after a while, says the confirmation is delayed, and can check again', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    serve({ views: [view()], onRefresh });

    const realNow = Date.now.bind(Date);
    renderConfirmation();
    await screen.findByText('Confirming payment…');

    // A minute and more later, as far as the page can tell.
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000);

    expect(
      await screen.findByText('Confirmation temporarily delayed', {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/has not been lost/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /check again/i }));

    expect(await screen.findByText('Payment successful')).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('asks nothing for an address that is not a Stripe session', async () => {
    const { statusCalls } = serve();
    renderConfirmation('not-a-session');

    expect(await screen.findByText('We could not find this payment')).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(statusCalls()).toBe(0);
  });

  it('shows another customer’s session as simply not found', async () => {
    serve({ status: 404 });
    renderConfirmation();

    expect(await screen.findByText('We could not find this payment')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('Payment successful')).not.toBeInTheDocument();
    });
  });
});
