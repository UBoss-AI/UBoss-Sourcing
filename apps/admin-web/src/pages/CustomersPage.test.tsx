/**
 * Customers list (checklist SCREEN-066).
 *
 *   - the accounts are listed with their stage;
 *   - searching and the status filter go to the server and into the URL;
 *   - a row opens the account;
 *   - New customer is offered only to staff with customer.write;
 *   - creating one posts the details to the customers route and opens it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import type { CustomerListItem } from '@/lib/customers';
import { CustomersPage } from './CustomersPage';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() } };
});

const { api } = await import('@/lib/api');
const get = vi.mocked(api.get);
const post = vi.mocked(api.post);

// jsdom has no <dialog> methods. The smallest stand-in: toggle `open`.
const dialogProto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal?: () => void; close?: () => void };
if (typeof dialogProto.showModal !== 'function') {
  dialogProto.showModal = function showModal(this: HTMLDialogElement): void {
    this.open = true;
  };
}
if (typeof dialogProto.close !== 'function') {
  dialogProto.close = function close(this: HTMLDialogElement): void {
    this.open = false;
  };
}

function customer(overrides: Partial<CustomerListItem> = {}): CustomerListItem {
  return {
    id: '01CUSTOMER00000000000000001',
    userId: '01USER0000000000000000001',
    email: 'asha@northwind.example',
    status: 'ACTIVE',
    fullName: 'Asha Rao',
    organization: 'Northwind Clinic',
    department: null,
    phone: null,
    customerCode: 'C-0001',
    activatedAt: '2026-09-01T00:00:00.000Z',
    invitedAt: '2026-08-30T00:00:00.000Z',
    lastLoginAt: null,
    orderCount: 3,
    scheduleCount: 0,
    addressCount: 1,
    limits: { requiresOrderApproval: false, perCurrency: [] },
    createdAt: '2026-08-30T00:00:00.000Z',
    ...overrides,
  };
}

const PAGE = { page: 1, limit: 25, total: 1, totalPages: 1 };

function Where(): React.JSX.Element {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

function renderPage(permissions: string[], initial = '/customers'): void {
  const session = {
    user: { id: 'u1', email: 'owner@example.test' },
    isLoading: false,
    can: (permission: string) => permissions.includes(permission),
    canAny: (...wanted: string[]) => wanted.some((permission) => permissions.includes(permission)),
  } as unknown as SessionState;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SessionContext.Provider value={session}>
            <MemoryRouter initialEntries={[initial]}>
              <Where />
              <Routes>
                <Route path="/customers" element={<CustomersPage />} />
                <Route path="/customers/:id" element={<p>Customer page</p>} />
              </Routes>
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  get.mockReset();
  post.mockReset();
  get.mockResolvedValue({ customers: [customer()], pagination: PAGE });
});

afterEach(() => {
  cleanup();
});

describe('CustomersPage', () => {
  it('lists the accounts with their stage', async () => {
    get.mockResolvedValue({
      customers: [customer(), customer({ id: '02', email: 'stopped@example.test', fullName: 'Stopped One', status: 'DEACTIVATED' })],
      pagination: { ...PAGE, total: 2 },
    });
    renderPage(['customer.read']);

    expect(await screen.findByText('asha@northwind.example')).toBeTruthy();
    expect(screen.getByText('stopped@example.test')).toBeTruthy();
    expect(get).toHaveBeenCalledWith('/admin/customers', {
      query: { page: 1, limit: 25, status: undefined, q: undefined },
    });
  });

  it('searches on the server and keeps the search in the address', async () => {
    renderPage(['customer.read']);
    await screen.findByText('asha@northwind.example');

    fireEvent.change(screen.getByPlaceholderText('Name, email or organisation'), { target: { value: 'north' } });

    await waitFor(
      () => {
        expect(get).toHaveBeenLastCalledWith('/admin/customers', {
          query: { page: 1, limit: 25, status: undefined, q: 'north' },
        });
      },
      { timeout: 3000 },
    );
    expect(screen.getByTestId('where').textContent).toBe('/customers?q=north');
  });

  it('filters by status on the server', async () => {
    renderPage(['customer.read']);
    await screen.findByText('asha@northwind.example');

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'DEACTIVATED' } });

    await waitFor(() => {
      expect(get).toHaveBeenLastCalledWith('/admin/customers', {
        query: { page: 1, limit: 25, status: 'DEACTIVATED', q: undefined },
      });
    });
    expect(screen.getByTestId('where').textContent).toBe('/customers?status=DEACTIVATED');
  });

  it('opens the account when its row is chosen', async () => {
    renderPage(['customer.read']);
    fireEvent.click(await screen.findByText('asha@northwind.example'));
    expect(await screen.findByText('Customer page')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/customers/01CUSTOMER00000000000000001');
  });

  it('offers New customer only to staff who may create one', async () => {
    renderPage(['customer.read']);
    await screen.findByText('asha@northwind.example');
    expect(screen.queryByRole('button', { name: 'New customer' })).toBeNull();
    cleanup();

    renderPage(['customer.read', 'customer.write']);
    expect(await screen.findByRole('button', { name: 'New customer' })).toBeTruthy();
  });

  it('posts a new customer to the customers route and opens it', async () => {
    post.mockResolvedValue({ id: '01NEW00000000000000000001' });
    renderPage(['customer.read', 'customer.write']);

    fireEvent.click(await screen.findByRole('button', { name: 'New customer' }));
    fireEvent.change(await screen.findByLabelText(/Email address/), { target: { value: 'new@buyer.example' } });
    fireEvent.change(screen.getByLabelText(/Contact name/), { target: { value: 'Nina Berg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create customer' }));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        '/admin/customers',
        expect.objectContaining({ email: 'new@buyer.example', fullName: 'Nina Berg' }),
      );
    });
    expect(await screen.findByText('Customer page')).toBeTruthy();
  });

  it('will not post a customer without an email address', async () => {
    renderPage(['customer.read', 'customer.write']);

    fireEvent.click(await screen.findByRole('button', { name: 'New customer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create customer' }));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Create customer' }).length).toBeGreaterThan(0);
    });
    expect(post).not.toHaveBeenCalled();
  });
});
