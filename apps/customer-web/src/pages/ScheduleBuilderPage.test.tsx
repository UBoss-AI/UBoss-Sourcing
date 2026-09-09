/**
 * The repeat-purchase builder, and specifically what its dropdown submits.
 *
 * The interesting property is the translation between two vocabularies. A
 * customer picks "Every 3 months"; the API stores a frequency, sometimes an
 * interval, and sometimes a day taken from the start date — and the database
 * has a CHECK constraint that REFUSES a frequency whose dependent column is
 * absent. So a preset that posts the wrong pair does not degrade gracefully:
 * it fails the insert.
 *
 * Which is why these tests assert on the request body rather than on the
 * screen. What the customer sees is a label; what decides whether the plan
 * exists is what went over the wire.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduleBuilderPage } from './ScheduleBuilderPage';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { makeCart, makeCartLine } from '@/test/fixtures';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import type { StorefrontConfig } from '@/lib/types';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The builder renders its "not available" state unless the store offers it. */
const CONFIG: StorefrontConfig = {
  ...FALLBACK_CONFIG,
  features: { ...FALLBACK_CONFIG.features, recurringOrders: true },
};

const ADDRESS = {
  id: '01JADDRESS0000000000000001',
  label: 'Warehouse',
  line1: '1 Test Road',
  city: 'Pune',
  state: 'MH',
  postalCode: '411001',
  country: 'IN',
  isDefaultShipping: true,
  isDefaultBilling: true,
  archivedAt: null,
};

/**
 * Serve the four reads the builder makes, and capture what it posts.
 *
 * The POST is answered rather than rejected so the page's success path runs;
 * the assertions are on the captured body.
 */
function serve(): { posted: () => Record<string, unknown> | null } {
  let body: Record<string, unknown> | null = null;

  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST' && url.includes('/recurring-schedules')) {
      // The client always sends a JSON string. Narrowed rather than coerced:
      // `String()` on a BodyInit that happened to be a Blob would produce
      // "[object Blob]" and the parse below would fail with a message about
      // JSON rather than about the assumption that broke.
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      body = JSON.parse(raw) as Record<string, unknown>;
      return Promise.resolve(jsonResponse({ scheduleId: 'sched-1' }, 201));
    }

    if (url.includes('/account/addresses')) {
      return Promise.resolve(jsonResponse({ addresses: [ADDRESS] }));
    }

    if (url.includes('/account/profile')) {
      return Promise.resolve(
        jsonResponse({ profile: { email: 'buyer@example.test', fullName: 'A Buyer' } }),
      );
    }

    return Promise.resolve(
      jsonResponse({
        cart: makeCart({ lines: [makeCartLine({ isRecurringEligible: true })] }),
      }),
    );
  });

  return { posted: () => body };
}

/** Pick a cadence, tick the consent, and submit. */
async function submitWith(cadence: string): Promise<void> {
  const user = userEvent.setup();

  const repeat = await screen.findByLabelText(/^repeat$/i);
  await user.selectOptions(repeat, cadence);

  // The server refuses without consent and this form never pre-ticks it.
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: /start this repeat purchase/i }));
}

describe('ScheduleBuilderPage cadence', () => {
  it('offers the six intervals a customer is likely to want', async () => {
    serve();

    renderWithProviders(<ScheduleBuilderPage />, { config: CONFIG, route: '/schedules/new' });

    const repeat = await screen.findByLabelText(/^repeat$/i);

    for (const label of [
      'Every 15 days',
      'Every month',
      'Every 2 months',
      'Every 3 months',
      'Every 6 months',
      'Once a year',
    ]) {
      expect(
        screen.getByRole('option', { name: label }),
        `${label} is missing from the dropdown`,
      ).toBeInTheDocument();
    }

    // A month, not a week. The old default put "every so many days" with 7 in
    // a box in front of everybody, which made a weekly delivery the path of
    // least resistance for consumables ordered monthly.
    expect(repeat).toHaveValue('MONTHS_1');
  });

  /**
   * A fortnight is EVERY_N_DAYS with 15 — not BIWEEKLY, which is anchored to a
   * weekday nobody chose here.
   */
  it('sends a fortnight as fifteen days', async () => {
    const captured = serve();

    renderWithProviders(<ScheduleBuilderPage />, { config: CONFIG, route: '/schedules/new' });
    await submitWith('DAYS_15');

    await waitFor(() => {
      expect(captured.posted()).toMatchObject({ frequency: 'EVERY_N_DAYS', intervalDays: 15 });
    });
    expect(captured.posted()).not.toHaveProperty('intervalMonths');
  });

  /**
   * One month is MONTHLY, and its day comes from the start date rather than
   * from a separate field. Storing it as EVERY_N_MONTHS with 1 would be a
   * second spelling of a cadence that already has one.
   */
  it('sends a single month as MONTHLY, dated from the first delivery', async () => {
    const captured = serve();

    renderWithProviders(<ScheduleBuilderPage />, { config: CONFIG, route: '/schedules/new' });
    await submitWith('MONTHS_1');

    await waitFor(() => {
      expect(captured.posted()).toMatchObject({ frequency: 'MONTHLY' });
    });

    const body = captured.posted();
    const startDay = Number(String(body?.['startDate']).slice(8, 10));
    expect(body?.['monthDay']).toBe(startDay);
  });

  it.each([
    ['MONTHS_2', 2],
    ['MONTHS_3', 3],
    ['MONTHS_6', 6],
    ['MONTHS_12', 12],
  ])('sends %s as a month interval of %i', async (cadence, months) => {
    const captured = serve();

    renderWithProviders(<ScheduleBuilderPage />, { config: CONFIG, route: '/schedules/new' });
    await submitWith(cadence);

    await waitFor(() => {
      expect(captured.posted()).toMatchObject({
        frequency: 'EVERY_N_MONTHS',
        intervalMonths: months,
      });
    });

    // Not day-counted. Ninety days is not a quarter and 365 is not a year, and
    // a plan stored that way walks into the wrong month.
    expect(captured.posted()).not.toHaveProperty('intervalDays');
  });

  it('keeps the custom weekday cadence that shipped before the presets', async () => {
    const captured = serve();

    renderWithProviders(<ScheduleBuilderPage />, { config: CONFIG, route: '/schedules/new' });

    const user = userEvent.setup();
    const repeat = await screen.findByLabelText(/^repeat$/i);
    await user.selectOptions(repeat, 'CUSTOM_WEEKLY');

    // The follow-up question the preset list does not need.
    expect(screen.getByLabelText(/day of the week/i)).toBeVisible();

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /start this repeat purchase/i }));

    await waitFor(() => {
      expect(captured.posted()).toMatchObject({ frequency: 'WEEKLY', weekday: 1 });
    });
  });
});
