/**
 * One customer: suspend, reactivate, approve, invite (checklist SCREEN-066).
 *
 *   - Suspend asks first, and then PATCHes the status with active: false;
 *   - a suspended account offers Reactivate, which PATCHes active: true;
 *   - a self-registered account awaiting approval offers Approve, not
 *     Reactivate, and Approve posts to the approve route;
 *   - an account never activated offers to send the invitation;
 *   - staff without the permission for each get no button for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { CustomerDetailPage } from './CustomerDetailPage';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn(), patch: vi.fn() } };
});
// Its own tests cover it; here it would only add requests.
vi.mock('./customer/CustomerKycPanel', () => ({ CustomerKycPanel: () => null }));

const { api } = await import('@/lib/api');
const get = vi.mocked(api.get);
const post = vi.mocked(api.post);
const patch = vi.mocked(api.patch);

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

const ID = '01CUSTOMER00000000000000001';

function customer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    userId: '01USER0000000000000000001',
    email: 'asha@northwind.example',
    status: 'ACTIVE',
    fullName: 'Asha Rao',
    organization: 'Northwind Clinic',
    department: null,
    phone: null,
    gstin: null,
    vatNumber: null,
    vatNumberValid: null,
    vatNumberCheckedAt: null,
    vatNumberReference: null,
    customerCode: 'C-0001',
    internalNotes: null,
    consentAcceptedAt: null,
    emailVerifiedAt: '2026-08-30T00:00:00.000Z',
    invitedAt: '2026-08-30T00:00:00.000Z',
    selfRegistered: false,
    preferredCountry: null,
    activatedAt: '2026-09-01T00:00:00.000Z',
    lastLoginAt: null,
    limits: { requiresOrderApproval: false, perCurrency: [] },
    addresses: [],
    ...overrides,
  };
}

function renderPage(permissions: string[]): void {
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
            <MemoryRouter initialEntries={[`/customers/${ID}`]}>
              <Routes>
                <Route path="/customers/:id" element={<CustomerDetailPage />} />
              </Routes>
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

function serve(record: Record<string, unknown>): void {
  get.mockImplementation((path: string) => {
    if (path === '/config') return Promise.resolve({ localisation: { currencies: [] } });
    if (path.startsWith('/admin/pending-actions')) return Promise.resolve({ actions: [] });
    if (path.startsWith('/admin/audit-logs')) return Promise.resolve({ entries: [] });
    return Promise.resolve({ customer: record });
  });
}

const READ = ['customer.read'];
const STATUS = ['customer.read', 'customer.status.write'];

beforeEach(async () => {
  await i18n.changeLanguage('en');
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  patch.mockResolvedValue({});
  post.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
});

describe('CustomerDetailPage', () => {
  it('asks before suspending, then sets the account to inactive', async () => {
    serve(customer());
    renderPage(STATUS);

    fireEvent.click(await screen.findByRole('button', { name: 'Suspend customer' }));
    // Nothing is sent by opening the question.
    expect(patch).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    // A suspension always says why (JOURNEY-061): the button waits for a reason.
    const confirm = within(dialog).getByRole('button', { name: 'Suspend customer' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Repeated chargebacks.' } });
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith(`/admin/customers/${ID}/status`, { active: false, reason: 'Repeated chargebacks.' });
    });
  });

  it('says the suspension is waiting for a second approver when the server holds it', async () => {
    serve(customer());
    patch.mockResolvedValue({
      pending: { id: 'P1', kind: 'CUSTOMER_DEACTIVATE', status: 'PENDING', resourceLabel: 'Asha Rao' },
    });
    renderPage(STATUS);

    fireEvent.click(await screen.findByRole('button', { name: 'Suspend customer' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Repeated chargebacks.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Suspend customer' }));

    expect(await screen.findByText(/waiting for a second member of staff/i)).toBeTruthy();
  });

  it('reactivates a suspended account without asking', async () => {
    serve(customer({ status: 'DEACTIVATED' }));
    renderPage(STATUS);

    fireEvent.click(await screen.findByRole('button', { name: 'Reactivate customer' }));

    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith(`/admin/customers/${ID}/status`, { active: true });
    });
  });

  it('gives staff who may only read no suspend or reactivate button', async () => {
    serve(customer());
    renderPage(READ);

    await screen.findAllByText('Northwind Clinic');
    expect(screen.queryByRole('button', { name: 'Suspend customer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reactivate customer' })).toBeNull();
  });

  it('offers Approve, not Reactivate, to a self-registered account awaiting approval', async () => {
    serve(customer({ status: 'PENDING_APPROVAL', selfRegistered: true, activatedAt: null }));
    renderPage(STATUS);

    expect(screen.queryByRole('button', { name: 'Reactivate customer' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve customer' }));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(`/admin/customers/${ID}/approve`, {});
    });
    expect(screen.queryByRole('button', { name: 'Reactivate customer' })).toBeNull();
  });

  it('does not offer Approve for an account that has not confirmed its email', async () => {
    serve(customer({ status: 'PENDING_APPROVAL', selfRegistered: true, activatedAt: null, emailVerifiedAt: null }));
    renderPage(STATUS);

    await screen.findAllByText('Northwind Clinic');
    expect(screen.queryByRole('button', { name: 'Approve customer' })).toBeNull();
  });

  it('sends the invitation to an account that was never activated, if staff may invite', async () => {
    serve(customer({ status: 'PENDING_INVITATION', activatedAt: null, invitedAt: null }));
    renderPage([...READ, 'customer.invite']);

    fireEvent.click(await screen.findByRole('button', { name: 'Send invitation' }));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(`/admin/customers/${ID}/invite`);
    });
  });

  it('offers no invitation without customer.invite', async () => {
    serve(customer({ status: 'PENDING_INVITATION', activatedAt: null, invitedAt: null }));
    renderPage(READ);

    await screen.findAllByText('Northwind Clinic');
    expect(screen.queryByRole('button', { name: 'Send invitation' })).toBeNull();
  });
});
