/**
 * Schedule Cart.
 *
 * The cases here are the ones that would cost a customer money or trust if
 * they broke:
 *
 *   - the list says what a buyer needs to compare plans — status, next
 *     processing time, its zone, how often, how many products, and what it
 *     would cost;
 *   - the amount on screen is the server's estimate and nothing computed here;
 *   - editing sends the WHOLE basket, so a retried save cannot apply a change
 *     twice;
 *   - a plan past its edit cutoff is read-only, and says why before anybody
 *     tries;
 *   - cancelling asks first, and says that orders already placed are not
 *     affected.
 *
 * `fetch` is stubbed at the boundary, as everywhere in this suite, so the API
 * client's own behaviour is exercised rather than bypassed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScheduleCartPage } from './ScheduleCartPage';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { addDays } from '@/lib/calendar-date';
import { earliestDeliveryDate } from '@/lib/schedule-cadence';
import type { DeliveryWindow } from '@/lib/delivery-window';
import type { Schedule, ScheduleEstimate, StorefrontConfig } from '@/lib/types';

const CONFIG: StorefrontConfig = {
  ...FALLBACK_CONFIG,
  features: { ...FALLBACK_CONFIG.features, recurringOrders: true },
};

const money = (minor: string, formatted: string) => ({ minor, formatted, currency: 'INR' });

/** A live monthly plan, priced. */
function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: '01JSCHEDULE000000000000001',
    name: 'Gloves, monthly',
    status: 'ACTIVE',
    summary: 'Every month on the 9th at 06:00 (Asia/Kolkata)',
    frequency: 'MONTHLY',
    intervalDays: null,
    weekday: null,
    monthDay: 9,
    intervalMonths: null,
    timezone: 'Asia/Kolkata',
    runAtMinute: 360,
    startDate: '2026-10-09',
    endDate: null,
    maxOccurrences: null,
    occurrenceCount: 3,
    // Comfortably in the future, so nothing is inside its cutoff.
    nextRunAt: '2099-10-09T00:30:00.000Z',
    lastRunAt: null,
    paymentMode: 'PAYMENT_LINK',
    payerEmail: 'buyer@example.test',
    hasMandate: false,
    consentAcceptedAt: '2026-09-01T00:00:00.000Z',
    failureCount: 0,
    maxFailures: 3,
    pausedReason: null,
    cancelReason: null,
    itemCount: 2,
    editableUntil: '2099-10-08T00:30:00.000Z',
    estimatedTotal: money('120000', '1,200.00'),
    estimateOk: true,
    ...overrides,
  };
}

/** The same plan as the detail route returns it: with its basket. */
function detail(overrides: Partial<Schedule> = {}): Schedule {
  return {
    ...schedule(),
    items: [
      {
        productId: '01JPRODUCT0000000000000001',
        variantId: null,
        quantity: 20,
        name: 'Nitrile Examination Gloves',
        sku: 'NG-M',
        slug: 'nitrile-examination-gloves',
        purchaseRules: { minOrderQty: 10, maxOrderQty: null, qtyIncrement: 10 },
      },
    ],
    shippingAddress: {
      id: '01JADDRESS00000000000000001',
      kind: 'SHIPPING',
      label: 'Store room',
      contactName: 'Priya',
      contactPhone: '+911234567890',
      line1: '12 Hospital Road',
      line2: null,
      city: 'Pune',
      state: 'MH',
      postalCode: '411001',
      country: 'IN',
      isDefaultBilling: false,
      isDefaultShipping: true,
      archivedAt: null,
    },
    ...overrides,
  };
}

function estimate(overrides: Partial<ScheduleEstimate> = {}): ScheduleEstimate {
  return {
    scheduleId: schedule().id,
    currency: 'INR',
    lines: [
      {
        productId: '01JPRODUCT0000000000000001',
        variantId: null,
        name: 'Nitrile Examination Gloves',
        sku: 'NG-M',
        variantName: null,
        imageUrl: null,
        quantity: 20,
        unitPrice: money('6000', '60.00'),
        lineTotal: money('120000', '1,200.00'),
        availableQty: 400,
        substitutedFor: null,
      },
    ],
    totals: {
      subtotal: money('120000', '1,200.00'),
      discount: money('0', '0.00'),
      tax: money('14400', '144.00'),
      shipping: money('0', '0.00'),
      grandTotal: money('134400', '1,344.00'),
    },
    ok: true,
    problems: [],
    estimatedTotal: money('134400', '1,344.00'),
    ...overrides,
  };
}

interface Routes {
  schedules?: Schedule[];
  detail?: Schedule;
  estimate?: ScheduleEstimate;
  /** Every request, so a test can assert what was sent. */
  onRequest?: (url: string, init: RequestInit | undefined) => void;
  patch?: () => Response;
  /**
   * What `GET /recurring-schedules/delivery-window` answers.
   *
   * Omitted means the ask fails, which is the state the picker has to survive
   * on its own notice-period arithmetic.
   */
  deliveryWindow?: DeliveryWindow;
}

function stubFetch(routes: Routes = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      routes.onRequest?.(url, init);

      if (url.includes('/estimate')) {
        return Promise.resolve(jsonResponse({ estimate: routes.estimate ?? estimate() }));
      }

      if (url.includes('/account/addresses')) {
        return Promise.resolve(
          jsonResponse({ addresses: [detail().shippingAddress] }),
        );
      }

      if (url.includes('/account/profile')) {
        return Promise.resolve(
          jsonResponse({ profile: { email: 'buyer@example.test', fullName: 'Priya' } }),
        );
      }

      if (url.includes('/catalog/products')) {
        return Promise.resolve(jsonResponse({ products: [] }));
      }

      // Before the `/recurring-schedules/:id` branch: the floor endpoint
      // lives under the same prefix, and `includes` would swallow it.
      if (url.includes('/delivery-window')) {
        return Promise.resolve(
          routes.deliveryWindow === undefined
            ? // No answer at all, which is what an older server or a failed
              // ask looks like. The screen falls back to the notice period.
              jsonResponse({}, 404)
            : jsonResponse(routes.deliveryWindow),
        );
      }

      if (url.includes('/recurring-schedules/')) {
        if (method === 'PATCH') {
          return Promise.resolve(
            routes.patch?.() ?? jsonResponse({ updated: true, nextRunAt: null }),
          );
        }
        if (method === 'DELETE') {
          return Promise.resolve(jsonResponse({ status: 'CANCELLED', futureRunsOnly: true }));
        }
        return Promise.resolve(jsonResponse({ schedule: routes.detail ?? detail() }));
      }

      if (url.includes('/recurring-schedules')) {
        return Promise.resolve(
          jsonResponse({
            schedules: routes.schedules ?? [schedule()],
            estimatedCount: 1,
            estimateLimit: 12,
          }),
        );
      }

      return Promise.resolve(jsonResponse({}, 404));
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the list of schedules', () => {
  it('shows what a buyer needs to tell their schedules apart', async () => {
    stubFetch();
    renderWithProviders(<ScheduleCartPage />, { config: CONFIG, route: '/accounts/schedule' });

    /*
     * The card, reached through its own button.
     *
     * The plan's NAME is the button and the card is a plain element around it,
     * so a screen reader hears "Gloves, monthly" rather than the card's entire
     * text read as one name. The assertions below are about the card, so they
     * scope to it rather than to the button inside it.
     */
    const name = await screen.findByRole('button', { name: 'Gloves, monthly' });
    const row = name.closest('li') as HTMLElement;

    // Status, how often, how many products, and the zone the next processing
    // time is read on — somebody reading this from another country needs to
    // know which clock is meant.
    expect(within(row).getByText(/active/i)).toBeInTheDocument();
    expect(within(row).getAllByText(/Every month on the 9th/).length).toBeGreaterThan(0);
    expect(within(row).getByText('2 products')).toBeInTheDocument();
    expect(within(row).getByText('Asia/Kolkata')).toBeInTheDocument();

    // The amount is the server's estimate. Nothing on this page multiplies a
    // unit price by a quantity.
    expect(within(row).getByText('₹1,200.00')).toBeInTheDocument();
  });

  it('asks the API to price the list', async () => {
    const seen: string[] = [];
    stubFetch({
      onRequest: (url) => {
        seen.push(url);
      },
    });

    renderWithProviders(<ScheduleCartPage />, { config: CONFIG, route: '/accounts/schedule' });
    await screen.findByRole('button', { name: /Gloves, monthly/ });

    expect(seen.some((url) => url.includes('estimate=true'))).toBe(true);
  });

  it('shows a dash rather than a confident zero for a plan it could not price', async () => {
    stubFetch({
      schedules: [schedule({ estimatedTotal: null, estimateOk: false })],
    });

    renderWithProviders(<ScheduleCartPage />, { config: CONFIG, route: '/accounts/schedule' });

    const name = await screen.findByRole('button', { name: 'Gloves, monthly' });
    const row = name.closest('li') as HTMLElement;

    expect(within(row).getByText(/not priced/i)).toBeInTheDocument();
    expect(within(row).queryByText('₹0.00')).toBeNull();
  });

  it('says so plainly where the deployment has no schedules at all', () => {
    stubFetch();
    // `FALLBACK_CONFIG` has the feature off.
    renderWithProviders(<ScheduleCartPage />, { route: '/accounts/schedule' });

    expect(screen.getByText(/Schedules are not available here/i)).toBeInTheDocument();
  });
});

describe('editing a schedule', () => {
  it('opens the plan that the URL names', async () => {
    stubFetch();
    renderWithProviders(<ScheduleCartPage />, {
      config: CONFIG,
      route: `/accounts/schedule?id=${schedule().id}`,
    });

    // The basket, with the product on it and its own quantity.
    expect(await screen.findByText('Nitrile Examination Gloves')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: /^Quantity$/i })).toHaveValue(20);

    // The steppers name the line, even though the visible label does not.
    // Two lines of one product are otherwise two controls a screen reader
    // hears as "Increase quantity by 10" twice over.
    expect(
      screen.getByRole('button', {
        name: /Increase the quantity of Nitrile Examination Gloves by 10/i,
      }),
    ).toBeInTheDocument();

    // And the promise this screen has to keep, before anything is changed.
    expect(screen.getByText(/apply to future deliveries only/i)).toBeInTheDocument();
  });

  it('asks for a delivery date and not for a time of day', async () => {
    const user = userEvent.setup();

    /*
     * A plan whose delivery date sits exactly on the floor.
     *
     * Both of these are computed from the same helper the screen uses rather
     * than written as literals: the calendar opens on the month of the value
     * it is given, so a hard-coded month would put the floor off screen — and
     * a hard-coded date would make this test start failing on a day nobody
     * chose.
     */
    const earliest = earliestDeliveryDate('Asia/Kolkata');
    stubFetch({ detail: detail({ startDate: earliest }) });

    renderWithProviders(<ScheduleCartPage />, {
      config: CONFIG,
      route: `/accounts/schedule?id=${schedule().id}`,
    });

    // The time control is gone. It offered five fixed times, none of which a
    // buyer has any basis for choosing between — the hour a warehouse picks an
    // order is the operator's decision.
    const dateField = await screen.findByRole('button', { name: /Delivery date/i });
    expect(screen.queryByLabelText(/time of day/i)).toBeNull();

    await user.click(dateField);
    const calendar = screen.getByRole('dialog');

    // The rule: a week's notice. The day before the floor is out, the floor
    // itself is in, and the reason is written under the grid rather than left
    // to be inferred from a fortnight of grey.
    expect(calendar.querySelector(`[data-iso="${earliest}"]`)).toBeEnabled();
    expect(calendar.querySelector(`[data-iso="${addDays(earliest, -1)}"]`)).toBeDisabled();
    expect(within(calendar).getByText(/earliest date we can take/i)).toBeInTheDocument();
  });

  /**
   * The floor the server names beats the one the browser can work out.
   *
   * Two things can push it past `today + the notice period`, and neither is
   * knowable in a bundle: the delivery address's own IANA zone, and the lane
   * of a warehouse the plan is pinned to. So the picker asks, and the answer
   * wins — including when it moves a date the form already held.
   */
  it('greys out up to the floor the server names, not just the notice period', async () => {
    const user = userEvent.setup();

    const local = earliestDeliveryDate('Asia/Kolkata');
    // Three days past the notice period, as a warehouse lane would put it.
    const serverFloor = addDays(local, 3);

    stubFetch({
      detail: detail({ startDate: local }),
      deliveryWindow: {
        noticeFloor: local,
        warehouseEarliest: serverFloor,
        earliest: serverFloor,
        timezone: 'Asia/Kolkata',
        noticeDays: 7,
      },
    });

    renderWithProviders(<ScheduleCartPage />, {
      config: CONFIG,
      route: `/accounts/schedule?id=${schedule().id}`,
    });

    const dateField = await screen.findByRole('button', { name: /Delivery date/i });
    await user.click(dateField);
    const calendar = screen.getByRole('dialog');

    // The floor moved out, and the calendar moved with it: the day the
    // browser's own arithmetic would have allowed is now greyed out.
    await waitFor(() => {
      expect(calendar.querySelector(`[data-iso="${local}"]`)).toBeDisabled();
    });
    expect(calendar.querySelector(`[data-iso="${serverFloor}"]`)).toBeEnabled();

    // And the date the plan was holding was lifted onto the floor rather than
    // left sitting on a value the API would refuse.
    expect(calendar.querySelector(`[data-iso="${serverFloor}"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('sends the day that was chosen in the calendar', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];

    // Far enough out that the month on screen, and every day in it, is the
    // same in every year this test is ever run in.
    stubFetch({
      detail: detail({ startDate: '2099-06-15' }),
      onRequest: (_url, init) => {
        if ((init?.method ?? 'GET') !== 'PATCH') return;
        if (typeof init?.body !== 'string') return;
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      },
    });

    renderWithProviders(<ScheduleCartPage />, {
      config: CONFIG,
      route: `/accounts/schedule?id=${schedule().id}`,
    });

    await user.click(await screen.findByRole('button', { name: /Delivery date/i }));

    const calendar = screen.getByRole('dialog');
    expect(within(calendar).getByText('June 2099')).toBeInTheDocument();

    await user.click(calendar.querySelector('[data-iso="2099-06-18"]') as HTMLElement);
    await user.click(screen.getByRole('button', { name: /apply changes/i }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });

    // The day that was clicked, unshifted — not the 17th, which is what a
    // local `Date` round trip would have sent. And `runAtMinute` still
    // travels even though nothing on screen asks for it: the plan keeps the
    // hour it already had.
    expect(bodies[0]).toHaveProperty('startDate', '2099-06-18');
    expect(bodies[0]).toHaveProperty('runAtMinute', 360);
  });

  it('will not save until something has changed', async () => {
    stubFetch();
    renderWithProviders(<ScheduleCartPage />, {
      config: CONFIG,
      route: `/accounts/schedule?id=${schedule().id}`,
    });

    // A no-op save is a real write against a live standing order: the PATCH
    // re-materialises every upcoming delivery.
    expect(await screen.findByRole('button', { name: /apply changes/i })).toBeDisabled();
    expect(screen.getByText(/nothing has changed yet/i)).toBeInTheDocument();
  });

  it('sends the whole basket, so a retried save cannot apply a change twice', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];

    stubFetch({
      onRequest: (_url, init) => {
        if ((init?.method ?? 'GET') !== 'PATCH') return;
        if (typeof init?.body !== 'string') return;
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      },
    });

    renderWithProviders(<ScheduleCartPage />, {
      config: CONFIG,
      route: `/accounts/schedule?id=${schedule().id}`,
    });

    const quantity = await screen.findByRole('spinbutton', { name: /^Quantity$/i });

    // The increment is 10, so the stepper goes to 30 rather than 21.
    await user.click(screen.getByRole('button', { name: /increase/i }));
    expect(quantity).toHaveValue(30);

    await user.click(screen.getByRole('button', { name: /apply changes/i }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });

    // Absolute, not incremental: every line with its quantity, plus the whole
    // recurrence. Applying this body twice lands on the same state.
    expect(bodies[0]?.['items']).toEqual([
      { productId: '01JPRODUCT0000000000000001', variantId: null, quantity: 30 },
    ]);
    expect(bodies[0]).toHaveProperty('frequency', 'MONTHLY');
    expect(bodies[0]).toHaveProperty('timezone', 'Asia/Kolkata');
    expect(bodies[0]).toHaveProperty('startDate', '2026-10-09');
  });

  it('sends the basket without a line that was removed', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];

    stubFetch({
      onRequest: (_url, init) => {
        if ((init?.method ?? 'GET') !== 'PATCH') return;
        if (typeof init?.body !== 'string') return;
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      },
    });

    renderWithProviders(<ScheduleCartPage />, {
      config: CONFIG,
      route: `/accounts/schedule?id=${schedule().id}`,
    });

    await user.click(
      await screen.findByRole('button', {
        name: /Remove Nitrile Examination Gloves from this schedule/i,
      }),
    );

    // An empty schedule cannot be saved — the server refuses one — so the
    // screen refuses it too rather than offering a save that errors.
    expect(screen.getByRole('button', { name: /apply changes/i })).toBeDisabled();
    expect(screen.getByText(/add at least one product/i)).toBeInTheDocument();
    expect(bodies).toHaveLength(0);
  });

  it('shows the server sentence when a save is refused', async () => {
    const user = userEvent.setup();

    stubFetch({
      patch: () =>
        jsonResponse(
          {
            error: {
              code: 'SCHEDULE_EDIT_CUTOFF_PASSED',
              message:
                'A delivery from this schedule is being processed right now, so it cannot be changed.',
              details: [],
              correlationId: 'test',
            },
          },
          409,
        ),
    });

    renderWithProviders(<ScheduleCartPage />, {
      config: CONFIG,
      route: `/accounts/schedule?id=${schedule().id}`,
    });

    await screen.findByRole('spinbutton', { name: /^Quantity$/i });
    await user.click(screen.getByRole('button', { name: /increase/i }));
    await user.click(screen.getByRole('button', { name: /apply changes/i }));

    // The server names the rule that was broken. Replacing that with "could
    // not save" throws away the only part the customer can act on.
    expect(await screen.findByText(/being processed right now/i)).toBeInTheDocument();
  });

  it('locks a plan whose edit cutoff has passed, and says why first', async () => {
    stubFetch({
      detail: detail({
        nextRunAt: '2026-09-11T00:30:00.000Z',
        // Already gone: the engine may be pricing the next delivery.
        editableUntil: '2020-01-01T00:00:00.000Z',
      }),
    });

    renderWithProviders(<ScheduleCartPage />, {
      config: CONFIG,
      route: `/accounts/schedule?id=${schedule().id}`,
    });

    expect(await screen.findByText(/cannot be changed right now/i)).toBeInTheDocument();
    expect(screen.getByText(/already being prepared/i)).toBeInTheDocument();

    // Nothing editable, so nothing that looks editable.
    expect(screen.getByRole('button', { name: /apply changes/i })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: /^Quantity$/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /add a product/i })).toBeNull();
  });

  it('locks a cancelled plan rather than pretending it can be edited', async () => {
    stubFetch({ detail: detail({ status: 'CANCELLED', nextRunAt: null, editableUntil: null }) });

    renderWithProviders(<ScheduleCartPage />, {
      config: CONFIG,
      route: `/accounts/schedule?id=${schedule().id}`,
    });

    // `findAllBy`, because the cancel dialog's own explanation says the same
    // thing and a closed dialog is still in the document — as every dialog in
    // this app is. What is asserted is that the notice is there at all.
    expect(
      await screen.findAllByText(/no further deliveries will be placed/i),
    ).not.toHaveLength(0);
    expect(screen.getByText(/cannot be changed right now/i)).toBeInTheDocument();
    // And no second cancel button on something already cancelled.
    expect(screen.queryByRole('button', { name: /cancel this schedule/i })).toBeNull();
  });

  it('shows the estimate the server produced, problems included', async () => {
    stubFetch({
      estimate: estimate({
        ok: false,
        problems: [
          {
            severity: 'HOLD',
            code: 'INSUFFICIENT_STOCK',
            message: 'Only 4 of Nitrile Examination Gloves are available.',
          },
        ],
      }),
    });

    renderWithProviders(<ScheduleCartPage />, {
      config: CONFIG,
      route: `/accounts/schedule?id=${schedule().id}`,
    });

    expect(await screen.findByText('₹1,344.00')).toBeInTheDocument();
    // In the server's own words, because it knows the rule.
    expect(screen.getByText(/Only 4 of Nitrile Examination Gloves/)).toBeInTheDocument();
    // And labelled as an estimate, because every delivery is priced again.
    expect(screen.getByText(/priced again when it runs/i)).toBeInTheDocument();
  });
});

describe('removing a schedule from the list', () => {
  it('offers Remove only on a plan that has stopped', async () => {
    stubFetch({
      schedules: [
        schedule({ id: 'live-plan', name: 'Still running', status: 'ACTIVE' }),
        schedule({ id: 'paused-plan', name: 'On hold', status: 'PAUSED' }),
        schedule({ id: 'dead-plan', name: 'Stopped last month', status: 'CANCELLED' }),
        schedule({ id: 'done-plan', name: 'Ran its course', status: 'COMPLETED' }),
      ],
    });

    renderWithProviders(<ScheduleCartPage />, { config: CONFIG, route: '/accounts/schedule' });

    await screen.findByRole('button', { name: 'Still running' });

    // A live plan is a live authority to charge. Hiding one would mean money
    // leaving an account for an arrangement the customer cannot see, so the
    // control is not offered — and a paused plan resumes, so nor is it there.
    expect(screen.queryByRole('button', { name: /Remove Still running/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove On hold/i })).toBeNull();

    expect(
      screen.getByRole('button', { name: /Remove Stopped last month/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Remove Ran its course/i })).toBeInTheDocument();
  });

  it('asks first, and says what is kept', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];

    stubFetch({
      schedules: [schedule({ status: 'CANCELLED' })],
      onRequest: (url, init) => {
        if ((init?.method ?? 'GET') === 'POST') calls.push(url);
      },
    });

    renderWithProviders(<ScheduleCartPage />, { config: CONFIG, route: '/accounts/schedule' });

    await user.click(await screen.findByRole('button', { name: /Remove Gloves, monthly/i }));

    const dialog = screen.getByRole('dialog');
    // Both halves of what it does: the card goes, the record does not.
    expect(within(dialog).getByText(/The card goes from this list/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/our team can still see them/i)).toBeInTheDocument();

    // Nothing is sent until it is confirmed.
    expect(calls.filter((url) => url.includes('/hide'))).toEqual([]);

    await user.click(within(dialog).getByRole('button', { name: /^Remove it$/i }));

    await waitFor(() => {
      expect(calls.some((url) => url.includes('/hide'))).toBe(true);
    });
  });

  it('sends nothing when the confirmation is dismissed', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];

    stubFetch({
      schedules: [schedule({ status: 'CANCELLED' })],
      onRequest: (url, init) => {
        if ((init?.method ?? 'GET') === 'POST') calls.push(url);
      },
    });

    renderWithProviders(<ScheduleCartPage />, { config: CONFIG, route: '/accounts/schedule' });

    await user.click(await screen.findByRole('button', { name: /Remove Gloves, monthly/i }));
    await user.click(screen.getByRole('button', { name: /keep it on the list/i }));

    expect(calls.filter((url) => url.includes('/hide'))).toEqual([]);
  });

  it('shows the server sentence when a removal is refused', async () => {
    const user = userEvent.setup();

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

        if (url.includes('/hide')) {
          return Promise.resolve(
            jsonResponse(
              {
                error: {
                  code: 'SCHEDULE_NOT_ACTIVE',
                  message:
                    'Only a cancelled or finished schedule can be removed from your list. Cancel this one first, and then remove it.',
                  details: [],
                  correlationId: 'test',
                },
              },
              409,
            ),
          );
        }

        if (url.includes('/recurring-schedules')) {
          return Promise.resolve(
            jsonResponse({
              schedules: [schedule({ status: 'CANCELLED' })],
              estimatedCount: 1,
              estimateLimit: 12,
            }),
          );
        }

        return Promise.resolve(jsonResponse({}, 404));
      }),
    );

    renderWithProviders(<ScheduleCartPage />, { config: CONFIG, route: '/accounts/schedule' });

    await user.click(await screen.findByRole('button', { name: /Remove Gloves, monthly/i }));
    await user.click(screen.getByRole('button', { name: /^Remove it$/i }));

    // The server names the way out. "Could not remove" would throw that away.
    expect(await screen.findByText(/Cancel this one first/i)).toBeInTheDocument();
  });
});

describe('cancelling a schedule', () => {
  it('asks first, needs a reason, and says what is not affected', async () => {
    const user = userEvent.setup();
    const calls: { url: string; method: string }[] = [];

    stubFetch({
      onRequest: (url, init) => {
        calls.push({ url, method: init?.method ?? 'GET' });
      },
    });

    renderWithProviders(<ScheduleCartPage />, {
      config: CONFIG,
      route: `/accounts/schedule?id=${schedule().id}`,
    });

    await user.click(
      await screen.findByRole('button', { name: /cancel this schedule/i }),
    );

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Orders already placed are not affected/i)).toBeInTheDocument();

    // Nothing is sent until a reason is given: the same bar the plan's own
    // page sets for the same action.
    const confirm = within(dialog).getByRole('button', { name: /cancel this schedule/i });
    expect(confirm).toBeDisabled();
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);

    await user.type(within(dialog).getByRole('textbox'), 'Switching supplier');
    await user.click(confirm);

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
    });

    // The reason travels in the query string: a DELETE body is not reliably
    // forwarded by every proxy.
    const deleted = calls.find((call) => call.method === 'DELETE');
    expect(deleted?.url).toContain('reason=Switching+supplier');
  });

  it('sends nothing when the confirmation is dismissed', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];

    stubFetch({
      onRequest: (_url, init) => {
        calls.push(init?.method ?? 'GET');
      },
    });

    renderWithProviders(<ScheduleCartPage />, {
      config: CONFIG,
      route: `/accounts/schedule?id=${schedule().id}`,
    });

    await user.click(await screen.findByRole('button', { name: /cancel this schedule/i }));
    await user.click(screen.getByRole('button', { name: /leave it running/i }));

    expect(calls).not.toContain('DELETE');
  });
});
