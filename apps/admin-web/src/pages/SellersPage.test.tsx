/**
 * Seller applications list (checklist SCREEN-066).
 *
 *   - applications are listed with their stage and how far they got;
 *   - the count of applications waiting for a decision is in the heading;
 *   - the status filter and the search go to the server and into the address;
 *   - a row opens the application;
 *   - a failed load offers a retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { i18n } from '@/i18n/config';
import type { SellerApplicationRow } from '@/lib/sellers';
import { SellersPage } from './SellersPage';

vi.mock('@/lib/sellers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sellers')>();
  return { ...actual, fetchSellerApplications: vi.fn(), fetchVerifiedSuppliers: vi.fn() };
});

const lib = await import('@/lib/sellers');
const fetchApplications = vi.mocked(lib.fetchSellerApplications);
const fetchVerified = vi.mocked(lib.fetchVerifiedSuppliers);

function row(overrides: Partial<SellerApplicationRow> = {}): SellerApplicationRow {
  return {
    id: '01SELLER000000000000000001',
    legalName: 'Sikka Traders Pvt Ltd',
    displayName: 'Sikka Traders',
    status: 'SUBMITTED',
    registrationCountry: 'IN',
    kind: 'WHOLESALER',
    submittedAt: '2026-09-20T00:00:00.000Z',
    completedSteps: 6,
    requiredSteps: 8,
    documentCount: 4,
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
        <MemoryRouter initialEntries={['/sellers']}>
          <Where />
          <Routes>
            <Route path="/sellers" element={<SellersPage />} />
            <Route path="/sellers/:id" element={<p>Seller page</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  fetchApplications.mockReset();
  fetchVerified.mockReset();
  fetchVerified.mockResolvedValue({ suppliers: [], total: 0 });
  fetchApplications.mockResolvedValue({
    rows: [row()],
    total: 1,
    counts: { SUBMITTED: 2, UNDER_REVIEW: 1, APPROVED: 5 },
  });
});

afterEach(() => {
  cleanup();
});

describe('SellersPage', () => {
  it('lists each application with its stage and progress', async () => {
    renderPage();

    expect(await screen.findByText('Sikka Traders')).toBeTruthy();
    expect(screen.getByText('Sikka Traders Pvt Ltd')).toBeTruthy();
    expect(screen.getByText('6/8 steps')).toBeTruthy();
    expect(screen.getByText('Waiting for review', { selector: 'span' })).toBeTruthy();
  });

  it('says how many applications are waiting for a decision', async () => {
    renderPage();
    expect(await screen.findByText('3 applications are waiting for a decision.')).toBeTruthy();
  });

  it('asks the server for one status at a time, and keeps it in the address', async () => {
    renderPage();
    await screen.findByText('Sikka Traders');

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'SUSPENDED' } });

    await waitFor(() => {
      const last = fetchApplications.mock.calls.at(-1)?.[0];
      expect(last?.get('status')).toBe('SUSPENDED');
      expect(last?.get('page')).toBe('1');
    });
    expect(screen.getByTestId('where').textContent).toBe('/sellers?status=SUSPENDED');
  });

  it('searches by name on the server', async () => {
    renderPage();
    await screen.findByText('Sikka Traders');

    fireEvent.change(screen.getByPlaceholderText('Trading or registered name'), { target: { value: ' Sikka ' } });

    await waitFor(
      () => {
        const last = fetchApplications.mock.calls.at(-1)?.[0];
        expect(last?.get('search')).toBe('Sikka');
      },
      { timeout: 3000 },
    );
    expect(screen.getByTestId('where').textContent).toBe('/sellers?search=Sikka');
  });

  it('opens the application when its row is chosen', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('Sikka Traders'));
    expect(await screen.findByText('Seller page')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/sellers/01SELLER000000000000000001');
  });

  it('offers a retry when the list cannot be loaded', async () => {
    fetchApplications.mockRejectedValueOnce(new Error('boom'));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Sikka Traders')).toBeTruthy();
  });
});

describe('SellersPage verified suppliers', () => {
  it('shows both verified-supplier sections under the application queue', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Verified suppliers' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Newly verified suppliers' })).toBeTruthy();
    expect(fetchVerified).toHaveBeenCalledWith();
    expect(fetchVerified).toHaveBeenCalledWith('newest');
  });
});
