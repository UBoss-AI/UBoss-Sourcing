/**
 * Deciding a seller application: suspend, approve, send back (checklist
 * SCREEN-066).
 *
 *   - only the moves the status allows are offered;
 *   - staff without customer.status.write are offered none;
 *   - Suspend asks what the seller should be told and will not go without it;
 *   - a decision posts to the decision route, with the version it was made
 *     against, so a stale decision is refused rather than overwriting a colleague.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import type { SellerApplicationDetail } from '@/lib/sellers';
import { SellerDetailPage } from './SellerDetailPage';

vi.mock('@/lib/sellers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sellers')>();
  return { ...actual, fetchSellerApplication: vi.fn(), decideSellerApplication: vi.fn() };
});
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn().mockResolvedValue({ business: { sellerCommissionBasisPoints: 0 } }), post: vi.fn(), patch: vi.fn() } };
});
// Each has its own tests and its own requests; here they would only add noise.
vi.mock('@/components/AccessReviewCard', () => ({ AccessReviewCard: () => null }));
vi.mock('@/components/governance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/governance')>();
  return { ...actual, PendingActionsCard: () => null, RecordHistoryCard: () => null };
});
vi.mock('@/pages/seller/SellerFactoriesPanel', () => ({ SellerFactoriesPanel: () => null }));
vi.mock('@/pages/seller/SellerOffersPanel', () => ({ SellerOffersPanel: () => null }));
vi.mock('./seller/SellerKybReviewPanel', () => ({ SellerKybReviewPanel: () => null }));

const lib = await import('@/lib/sellers');
const fetchApplication = vi.mocked(lib.fetchSellerApplication);
const decide = vi.mocked(lib.decideSellerApplication);

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

const ID = '01SELLER000000000000000001';

function seller(status: SellerApplicationDetail['status']): SellerApplicationDetail {
  return {
    id: ID,
    legalName: 'Sikka Traders Pvt Ltd',
    displayName: 'Sikka Traders',
    slug: 'sikka-traders',
    kind: 'WHOLESALER',
    status,
    registrationCountry: 'IN',
    description: null,
    statusReason: null,
    internalNotes: null,
    resubmissionAllowed: true,
    commissionBasisPoints: null,
    qualityScore: null,
    submittedAt: '2026-09-20T00:00:00.000Z',
    reviewedAt: null,
    approvedAt: null,
    suspendedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    version: 7,
    businessProfile: null,
    onboarding: null,
    payoutAccount: null,
    kyb: {} as SellerApplicationDetail['kyb'],
    locations: [],
    documents: [],
    agreements: [],
    verificationCases: [],
    members: [],
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
            <MemoryRouter initialEntries={[`/sellers/${ID}`]}>
              <Routes>
                <Route path="/sellers/:id" element={<SellerDetailPage />} />
              </Routes>
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

const DECIDE = ['customer.read', 'customer.status.write'];

beforeEach(async () => {
  await i18n.changeLanguage('en');
  fetchApplication.mockReset();
  decide.mockReset();
  decide.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe('SellerDetailPage decisions', () => {
  it('offers only the moves the status allows', async () => {
    fetchApplication.mockResolvedValue(seller('APPROVED'));
    renderPage(DECIDE);

    expect(await screen.findByRole('button', { name: 'Suspend' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send back' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('offers a decision to nobody without customer.status.write', async () => {
    fetchApplication.mockResolvedValue(seller('APPROVED'));
    renderPage(['customer.read']);

    await screen.findAllByText('Sikka Traders');
    expect(screen.queryByRole('button', { name: 'Suspend' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send back' })).toBeNull();
  });

  it('will not suspend without saying what the seller should be told', async () => {
    fetchApplication.mockResolvedValue(seller('APPROVED'));
    renderPage(DECIDE);

    fireEvent.click(await screen.findByRole('button', { name: 'Suspend' }));
    const confirm = (await screen.findAllByRole('button', { name: 'Suspend' })).at(-1) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(decide).not.toHaveBeenCalled();
  });

  it('posts the suspension with its reason, the note and the version it was made against', async () => {
    fetchApplication.mockResolvedValue(seller('APPROVED'));
    renderPage(DECIDE);

    fireEvent.click(await screen.findByRole('button', { name: 'Suspend' }));
    fireEvent.change(await screen.findByLabelText(/What should the seller be told/), {
      target: { value: 'Your insurance certificate has expired.' },
    });
    fireEvent.change(screen.getByLabelText('Internal note'), { target: { value: 'Chased twice.' } });
    const confirm = (await screen.findAllByRole('button', { name: 'Suspend' })).at(-1) as HTMLButtonElement;
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith(ID, {
        status: 'SUSPENDED',
        reason: 'Your insurance certificate has expired.',
        internalNote: 'Chased twice.',
        expectedVersion: 7,
      });
    });
  });

  it('lets a suspended seller be approved again, with no reason needed', async () => {
    fetchApplication.mockResolvedValue(seller('SUSPENDED'));
    renderPage(DECIDE);

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const confirm = (await screen.findAllByRole('button', { name: 'Approve' })).at(-1) as HTMLButtonElement;
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith(ID, {
        status: 'APPROVED',
        reason: null,
        internalNote: null,
        expectedVersion: 7,
      });
    });
  });

  it('offers nothing to decide on an application that was never sent in', async () => {
    fetchApplication.mockResolvedValue(seller('DRAFT'));
    renderPage(DECIDE);

    expect(await screen.findByText('This seller has not sent their application in yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});
