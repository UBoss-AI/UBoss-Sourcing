/**
 * Automatic payment: the customer's time, size and scope controls.
 *
 * What is under test is what goes over the wire. A date field holds a calendar
 * day; the API takes an instant, and "ends on the 31st" has to mean the END of
 * the 31st. A cap is typed in major units and must arrive as whole minor units.
 * A scope with nothing ticked has to arrive as `null` ("every supplier"), not
 * as an empty list that would mean "none". And a cap with no period, or an end
 * before a start, must be caught before anything is sent.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoPayPage } from './AutoPayPage';
import { jsonResponse, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const CARD = {
  id: '01JCARD00000000000000001',
  brand: 'visa',
  last4: '4242',
  expMonth: 12,
  expYear: 2032,
  status: 'ACTIVE',
  isDefault: true,
  consentScope: 'OFF_SESSION',
};

const SELLER_KEY = '01JSELLER0000000000000001';
const CATEGORY_ID = '01JCATEGORY00000000000001';

function settings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'ACTIVE',
    enabled: true,
    paymentMethodId: CARD.id,
    paymentMethodLabel: 'visa ending 4242',
    paymentMethodUsable: true,
    maxTransactionMinor: null,
    approvalThresholdMinor: null,
    limitCurrency: 'EUR',
    retryPreference: 'STANDARD',
    notifyOnCharge: true,
    notifyOnFailure: true,
    authorityExpiresAt: null,
    authorityExpired: false,
    authorityStartsAt: null,
    authorityNotStarted: false,
    periodCapMinor: null,
    capPeriod: null,
    periodUsedMinor: null,
    scopeSellerKeys: null,
    scopeCategoryIds: null,
    consentAcceptedAt: '2026-09-01T10:00:00.000Z',
    consentVersion: 'v1',
    consentWithdrawnAt: null,
    enabledAt: '2026-09-01T10:00:00.000Z',
    pausedAt: null,
    currentConsentVersion: 'v1',
    ...overrides,
  };
}

/** Serve the page's reads and capture the body of every write. */
function serve(current: Record<string, unknown>): { writes: { method: string; body: Record<string, unknown> }[] } {
  const writes: { method: string; body: Record<string, unknown> }[] = [];
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      writes.push({ method, body: JSON.parse(raw) as Record<string, unknown> });
      return Promise.resolve(jsonResponse({ autoPay: current }));
    }
    if (url.includes('/account/autopay/scope-options')) {
      return Promise.resolve(
        jsonResponse({
          suppliers: [
            { key: 'MARKETPLACE', name: null },
            { key: SELLER_KEY, name: 'Northwind Supplies' },
          ],
          categories: [{ id: CATEGORY_ID, name: 'Gloves' }],
        }),
      );
    }
    if (url.includes('/account/payment-methods')) {
      return Promise.resolve(jsonResponse({ paymentMethods: [CARD] }));
    }
    return Promise.resolve(jsonResponse({ autoPay: current, available: true, consentVersion: 'v1' }));
  });
  return { writes };
}

const endOfDay = (year: number, month: number, day: number): string =>
  new Date(year, month - 1, day, 23, 59, 59, 0).toISOString();
const startOfDay = (year: number, month: number, day: number): string =>
  new Date(year, month - 1, day, 0, 0, 0, 0).toISOString();

async function pressSave(): Promise<void> {
  await userEvent.setup().click(await screen.findByRole('button', { name: /^save$/i }));
}

describe('the automatic payment controls', () => {
  it('shows what is already set', async () => {
    serve(
      settings({
        authorityStartsAt: startOfDay(2026, 10, 1),
        authorityExpiresAt: endOfDay(2027, 3, 31),
        periodCapMinor: '250000',
        capPeriod: 'MONTH',
        periodUsedMinor: '60000',
        scopeSellerKeys: [SELLER_KEY],
        scopeCategoryIds: [CATEGORY_ID],
      }),
    );
    renderWithProviders(<AutoPayPage />);

    expect(await screen.findByLabelText(/^start on/i)).toHaveValue('2026-10-01');
    expect(screen.getByLabelText(/^end on/i)).toHaveValue('2027-03-31');
    expect(screen.getByLabelText(/^cap amount/i)).toHaveValue('2500.00');
    expect(screen.getByLabelText(/^period$/i)).toHaveValue('MONTH');
    expect(screen.getByText(/used so far this period/i)).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: 'Northwind Supplies' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Gloves' })).toBeChecked();
  });

  it('says so when the end date has passed', async () => {
    serve(settings({ authorityExpiresAt: startOfDay(2026, 1, 1), authorityExpired: true }));
    renderWithProviders(<AutoPayPage />);

    expect(await screen.findByText(/the end date you set has passed/i)).toBeInTheDocument();
  });

  it('sends the end of the chosen day, the cap in whole minor units, and the ticked scope', async () => {
    const { writes } = serve(settings());
    renderWithProviders(<AutoPayPage />);

    fireEvent.change(await screen.findByLabelText(/^start on/i), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText(/^end on/i), { target: { value: '2027-06-30' } });
    fireEvent.change(screen.getByLabelText(/^cap amount/i), { target: { value: '1200.50' } });
    fireEvent.change(screen.getByLabelText(/^period$/i), { target: { value: 'QUARTER' } });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Northwind Supplies' }));
    await user.click(screen.getByRole('checkbox', { name: 'Gloves' }));
    await pressSave();

    await waitFor(() => {
      expect(writes).toHaveLength(1);
    });
    expect(writes[0]?.method).toBe('PATCH');
    expect(writes[0]?.body).toMatchObject({
      authorityStartsAt: startOfDay(2026, 11, 1),
      authorityExpiresAt: endOfDay(2027, 6, 30),
      periodCapMinor: '120050',
      capPeriod: 'QUARTER',
      scopeSellerKeys: [SELLER_KEY],
      scopeCategoryIds: [CATEGORY_ID],
    });
  });

  it('sends null, not an empty list, when nothing is set or ticked', async () => {
    const { writes } = serve(settings());
    renderWithProviders(<AutoPayPage />);

    await screen.findByLabelText(/^start on/i);
    await pressSave();

    await waitFor(() => {
      expect(writes).toHaveLength(1);
    });
    expect(writes[0]?.body).toMatchObject({
      authorityStartsAt: null,
      authorityExpiresAt: null,
      periodCapMinor: null,
      capPeriod: null,
      scopeSellerKeys: null,
      scopeCategoryIds: null,
    });
  });

  it('clears an end date the customer removes', async () => {
    const { writes } = serve(settings({ authorityExpiresAt: endOfDay(2027, 3, 31) }));
    renderWithProviders(<AutoPayPage />);

    fireEvent.change(await screen.findByLabelText(/^end on/i), { target: { value: '' } });
    await pressSave();

    await waitFor(() => {
      expect(writes).toHaveLength(1);
    });
    expect(writes[0]?.body).toMatchObject({ authorityExpiresAt: null });
  });

  it('will not send a cap that has no period', async () => {
    const { writes } = serve(settings());
    renderWithProviders(<AutoPayPage />);

    fireEvent.change(await screen.findByLabelText(/^cap amount/i), { target: { value: '500' } });
    await pressSave();

    expect(await screen.findByText(/choose how often the cap starts again/i)).toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });

  it('will not send a cap in a currency that has not been chosen', async () => {
    const { writes } = serve(settings({ limitCurrency: null }));
    renderWithProviders(<AutoPayPage />);

    fireEvent.change(await screen.findByLabelText(/^cap amount/i), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText(/^period$/i), { target: { value: 'MONTH' } });
    await pressSave();

    expect(await screen.findByText(/choose a currency|currency/i, { selector: 'p, span, div' })).toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });

  it('will not send an end date before the start date', async () => {
    const { writes } = serve(settings());
    renderWithProviders(<AutoPayPage />);

    fireEvent.change(await screen.findByLabelText(/^start on/i), { target: { value: '2026-12-10' } });
    fireEvent.change(screen.getByLabelText(/^end on/i), { target: { value: '2026-12-01' } });
    await pressSave();

    expect(await screen.findByText(/must not be before the start date/i)).toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });
});
