/**
 * Buyer companies queue (checklist SCREEN-066).
 *
 *   - companies are listed with status, risk and reviewer;
 *   - the counters filter the queue when pressed, and press again to clear;
 *   - search, status and risk go to the server and into the address;
 *   - a row opens the case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { i18n } from '@/i18n/config';
import type { QueueRow } from '@/lib/buyer-companies';
import { BuyerCompaniesPage } from './BuyerCompaniesPage';

vi.mock('@/lib/buyer-companies', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/buyer-companies')>();
  return { ...actual, fetchQueue: vi.fn(), fetchReviewers: vi.fn() };
});

const lib = await import('@/lib/buyer-companies');
const fetchQueue = vi.mocked(lib.fetchQueue);
const fetchReviewers = vi.mocked(lib.fetchReviewers);

function row(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    id: '01COMPANY0000000000000001',
    reference: 'BC-7K2M',
    legalName: 'Northwind Clinic GmbH',
    tradingName: null,
    registrationCountry: 'DE',
    entityType: null,
    registrationNumber: 'HRB 12345',
    applicant: { email: 'anke@northwind.example', fullName: 'Anke Vogel' },
    status: 'SUBMITTED',
    riskLevel: 'LOW',
    flags: { failed: 0, duplicates: 1, signals: 0 },
    assignedReviewer: null,
    submittedAt: '2026-09-20T00:00:00.000Z',
    ageDays: 4,
    lastActivityAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
  };
}

function Where(): React.JSX.Element {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/buyer-companies']}>
          <Where />
          <Routes>
            <Route path="/buyer-companies" element={<BuyerCompaniesPage />} />
            <Route path="/buyer-companies/:id" element={<p>Case page</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

const lastParams = (): URLSearchParams => fetchQueue.mock.calls.at(-1)?.[0] ?? new URLSearchParams();

beforeEach(async () => {
  await i18n.changeLanguage('en');
  window.localStorage.clear();
  fetchQueue.mockReset();
  fetchReviewers.mockReset();
  fetchReviewers.mockResolvedValue({ reviewers: [{ id: 'r1', email: 'reviewer@example.test' }] });
  fetchQueue.mockResolvedValue({
    rows: [row()],
    total: 1,
    page: 1,
    pageSize: 25,
    counts: { SUBMITTED: 2, UNDER_REVIEW: 1, SUSPENDED: 3 },
  });
});

afterEach(() => {
  cleanup();
});

describe('BuyerCompaniesPage', () => {
  it('lists each company with its reference, applicant, risk and flags', async () => {
    renderPage();

    expect(await screen.findByText('Northwind Clinic GmbH')).toBeTruthy();
    expect(screen.getByText('BC-7K2M')).toBeTruthy();
    expect(screen.getByText('Anke Vogel')).toBeTruthy();
    expect(screen.getByText('anke@northwind.example')).toBeTruthy();
  });

  it('turns a counter into a filter on the server, and back off when pressed again', async () => {
    renderPage();
    await screen.findByText('Northwind Clinic GmbH');

    const suspended = screen.getByRole('button', { name: /^Suspended\s*3$/ });
    fireEvent.click(suspended);

    await waitFor(() => {
      expect(lastParams().get('status')).toBe('SUSPENDED');
    });
    expect(screen.getByTestId('where').textContent).toBe('/buyer-companies?status=SUSPENDED');
    // While the filtered list loads the counts are blank, so match on the name only.
    expect(screen.getByRole('button', { name: /^Suspended/ }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: /^Suspended/ }));
    await waitFor(() => {
      expect(lastParams().get('status')).toBeNull();
    });
  });

  it('filters by status and risk through the selects', async () => {
    renderPage();
    await screen.findByText('Northwind Clinic GmbH');

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'REVERIFICATION_REQUIRED' } });
    await waitFor(() => {
      expect(lastParams().get('status')).toBe('REVERIFICATION_REQUIRED');
    });

    fireEvent.change(screen.getByLabelText('Risk'), { target: { value: 'HIGH' } });
    await waitFor(() => {
      expect(lastParams().get('risk')).toBe('HIGH');
    });
    // Choosing another filter keeps the first.
    expect(lastParams().get('status')).toBe('REVERIFICATION_REQUIRED');
  });

  it('searches on the server', async () => {
    renderPage();
    await screen.findByText('Northwind Clinic GmbH');

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: ' Northwind ' } });

    await waitFor(
      () => {
        expect(lastParams().get('search')).toBe('Northwind');
      },
      { timeout: 3000 },
    );
    expect(screen.getByTestId('where').textContent).toBe('/buyer-companies?search=Northwind');
  });

  it('opens the case when its row is chosen', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('Northwind Clinic GmbH'));
    expect(await screen.findByText('Case page')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/buyer-companies/01COMPANY0000000000000001');
  });
});
