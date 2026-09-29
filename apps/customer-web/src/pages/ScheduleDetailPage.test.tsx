/**
 * The question a held delivery asks.
 *
 * When a scheduled delivery's price moves beyond what the customer approved,
 * nothing is charged and the delivery waits. This page is where they answer,
 * so the property worth holding down is what goes over the wire: confirming
 * sends back the TOTAL THAT WAS ON SCREEN (never a bare "yes"), so a price
 * that moved again is refused by the server rather than silently accepted.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduleDetailPage } from './ScheduleDetailPage';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const money = (minor: string, formatted: string) => ({ minor, currency: 'INR', formatted });

function schedule(occurrences: unknown[]): Record<string, unknown> {
  return {
    id: '01JSCHEDULE00000000000001',
    name: 'Weekly gloves',
    status: 'ACTIVE',
    summary: 'Every week',
    frequency: 'WEEKLY',
    intervalDays: null,
    weekday: 3,
    monthDay: null,
    intervalMonths: null,
    timezone: 'Asia/Kolkata',
    runAtMinute: 360,
    startDate: '2026-10-07',
    endDate: null,
    maxOccurrences: null,
    occurrenceCount: 1,
    nextRunAt: null,
    lastRunAt: null,
    paymentMode: 'AUTO_PAY',
    payerEmail: null,
    hasMandate: true,
    consentAcceptedAt: null,
    failureCount: 0,
    maxFailures: 3,
    pausedReason: null,
    cancelReason: null,
    itemCount: 1,
    kind: 'RECURRING',
    items: [],
    occurrences,
  };
}

const HELD = {
  id: '01JOCCURRENCE0000000000001',
  plannedRunAt: '2026-10-07T00:30:00.000Z',
  status: 'AWAITING_CONFIRMATION',
  orderId: null,
  orderNumber: null,
  total: money('472000', '4,720.00'),
  quotedTotal: money('236000', '2,360.00'),
  confirmationDueAt: '2026-10-09T10:00:00.000Z',
  awaitingConfirmation: true,
  failureMessage: null,
  skipReason: 'The price moved',
  canModify: false,
};

function render(): void {
  renderWithProviders(
    <Routes>
      <Route path="/account/schedules/:id" element={<ScheduleDetailPage />} />
    </Routes>,
    { route: '/account/schedules/01JSCHEDULE00000000000001' },
  );
}

/** Serve the detail, and capture every POST. */
function serve(options: { postResponse?: () => Response } = {}): { posts: { url: string; body: unknown }[] } {
  const posts: { url: string; body: unknown }[] = [];
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST') {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      posts.push({ url, body: JSON.parse(raw) as unknown });
      return Promise.resolve(options.postResponse?.() ?? jsonResponse({ result: 'COMPLETED' }));
    }
    return Promise.resolve(jsonResponse({ schedule: schedule([HELD]) }));
  });
  return { posts };
}

describe('a delivery held for a new price', () => {
  it('shows the new total, what they were told before, and the deadline', async () => {
    serve();
    render();

    expect(await screen.findByText(/the price of this delivery changed/i)).toBeInTheDocument();
    expect(screen.getByText(/has not been charged/i)).toHaveTextContent(/4,720\.00/);
    expect(screen.getByText(/you were last told/i)).toHaveTextContent(/2,360\.00/);
    expect(screen.getByText(/please answer by/i)).toBeInTheDocument();
  });

  it('sends back the total that was on screen when the customer confirms', async () => {
    const { posts } = serve();
    const user = userEvent.setup();
    render();

    await user.click(await screen.findByRole('button', { name: /confirm the new price/i }));

    await waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    expect(posts[0]?.url).toContain(
      '/recurring-schedules/01JSCHEDULE00000000000001/occurrences/01JOCCURRENCE0000000000001/confirm-price',
    );
    expect(posts[0]?.body).toEqual({ acceptedTotalMinor: '472000' });
  });

  it('skips the delivery when the customer says no, without sending a total', async () => {
    const { posts } = serve();
    const user = userEvent.setup();
    render();

    await user.click(await screen.findByRole('button', { name: /skip this delivery/i }));

    await waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    expect(posts[0]?.url).toContain('/decline-price');
    expect(posts[0]?.body).toEqual({});
  });

  it('says so when the price moved again, and asks them to check', async () => {
    serve({
      postResponse: () =>
        errorResponse(409, 'SCHEDULE_CONFIRMED_TOTAL_STALE', 'The total has changed since you looked.'),
    });
    const user = userEvent.setup();
    render();

    await user.click(await screen.findByRole('button', { name: /confirm the new price/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/the total changed while you were looking/i);
  });

  it('shows no question on a delivery that is not held', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          schedule: schedule([{ ...HELD, status: 'COMPLETED', awaitingConfirmation: false }]),
        }),
      ),
    );
    render();

    expect(await screen.findByText(/delivery history/i)).toBeInTheDocument();
    expect(screen.queryByText(/the price of this delivery changed/i)).not.toBeInTheDocument();
  });
});
