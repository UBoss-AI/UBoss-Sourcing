/**
 * One buyer company: approve, suspend, ask for re-verification (checklist
 * SCREEN-066).
 *
 *   - only the moves the server says are allowed are offered;
 *   - suspending and re-verifying need a reason, and go to their own routes
 *     with the version the reviewer was looking at;
 *   - a company that is suspended offers Restore, not Approve;
 *   - staff without buyer_company.review get no review actions of their own
 *     (taking the case, re-running checks);
 *   - a colleague deciding first is reported and the case reloaded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import type { BuyerCompanyStatus, ReviewCase } from '@/lib/buyer-companies';
import { BuyerCompanyDetailPage } from './BuyerCompanyDetailPage';

vi.mock('@/lib/buyer-companies', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/buyer-companies')>();
  return {
    ...actual,
    fetchCase: vi.fn(),
    fetchReviewers: vi.fn(),
    reviewApi: {
      startReview: vi.fn(),
      assign: vi.fn(),
      note: vi.fn(),
      requestInformation: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
      suspend: vi.fn(),
      reverify: vi.fn(),
      rerunChecks: vi.fn(),
      documentLink: vi.fn(),
      decideDocument: vi.fn(),
    },
  };
});

const lib = await import('@/lib/buyer-companies');
const fetchCase = vi.mocked(lib.fetchCase);
const fetchReviewers = vi.mocked(lib.fetchReviewers);
const reviewApi = vi.mocked(lib.reviewApi);
const { ApiError } = await import('@/lib/api');

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

const ID = '01COMPANY0000000000000001';

function record(status: BuyerCompanyStatus, to: { to: BuyerCompanyStatus; requiresReason: boolean }[]): ReviewCase {
  return {
    id: ID,
    reference: 'BC-7K2M',
    status,
    version: 4,
    statusReason: null,
    statusReasonCode: null,
    resubmissionAllowed: true,
    riskLevel: 'LOW',
    registrationClaimed: false,
    linkedSeller: null,
    business: {
      legalName: 'Northwind Clinic GmbH',
      tradingName: null,
      entityType: null,
      registrationCountry: 'DE',
      registrationNumber: 'HRB 12345',
      incorporationDate: null,
      industry: null,
      website: null,
      businessEmail: null,
      businessEmailVerified: false,
      businessDomainStatus: 'UNKNOWN',
      businessPhone: null,
    },
    applicant: { fullName: 'Anke Vogel', phone: null, jobTitle: null, relationship: null, authorityConfirmed: true },
    addresses: [],
    identifiers: [],
    procurement: null,
    problems: [],
    documents: [],
    infoRequests: [],
    members: [],
    currentCase: null,
    checks: [],
    timeline: [],
    statusHistory: [],
    consents: [],
    allowedTransitions: to,
    createdAt: '2026-09-01T00:00:00.000Z',
    submittedAt: '2026-09-02T00:00:00.000Z',
    firstSubmittedAt: '2026-09-02T00:00:00.000Z',
    approvedAt: null,
    rejectedAt: null,
    suspendedAt: null,
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
            <MemoryRouter initialEntries={[`/buyer-companies/${ID}`]}>
              <Routes>
                <Route path="/buyer-companies/:id" element={<BuyerCompanyDetailPage />} />
              </Routes>
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

const REVIEW = ['buyer_company.review'];

beforeEach(async () => {
  await i18n.changeLanguage('en');
  fetchCase.mockReset();
  fetchReviewers.mockReset();
  fetchReviewers.mockResolvedValue({ reviewers: [] });
  for (const method of Object.values(reviewApi)) method.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('BuyerCompanyDetailPage decisions', () => {
  it('offers only the moves the server allows', async () => {
    fetchCase.mockResolvedValue(
      record('APPROVED', [
        { to: 'SUSPENDED', requiresReason: true },
        { to: 'REVERIFICATION_REQUIRED', requiresReason: true },
      ]),
    );
    renderPage(REVIEW);

    expect(await screen.findByRole('button', { name: 'Suspend' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request re-verification' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('will not suspend without a reason, then posts it with the version reviewed', async () => {
    fetchCase.mockResolvedValue(record('APPROVED', [{ to: 'SUSPENDED', requiresReason: true }]));
    reviewApi.suspend.mockResolvedValue(record('SUSPENDED', []));
    renderPage(REVIEW);

    fireEvent.click(await screen.findByRole('button', { name: 'Suspend' }));
    const confirm = (await screen.findAllByRole('button', { name: 'Suspend' })).at(-1) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(reviewApi.suspend).not.toHaveBeenCalled();

    fireEvent.change(await screen.findByLabelText(/What to tell the applicant/), { target: { value: 'Licence lapsed on 1 September.' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(reviewApi.suspend).toHaveBeenCalledWith(ID, {
        expectedVersion: 4,
        reason: 'Licence lapsed on 1 September.',
      });
    });
  });

  it('asks for re-verification with a message', async () => {
    fetchCase.mockResolvedValue(record('APPROVED', [{ to: 'REVERIFICATION_REQUIRED', requiresReason: true }]));
    reviewApi.reverify.mockResolvedValue(record('REVERIFICATION_REQUIRED', []));
    renderPage(REVIEW);

    fireEvent.click(await screen.findByRole('button', { name: 'Request re-verification' }));
    fireEvent.change(await screen.findByLabelText(/Message for the applicant/), { target: { value: 'Please send the current licence.' } });
    const confirm = (await screen.findAllByRole('button', { name: 'Request re-verification' })).at(-1) as HTMLButtonElement;
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(reviewApi.reverify).toHaveBeenCalledWith(ID, {
        expectedVersion: 4,
        reason: 'Please send the current licence.',
        documentKinds: [],
      });
    });
  });

  it('offers Restore, not Approve, for a suspended company, and needs a reason', async () => {
    fetchCase.mockResolvedValue(record('SUSPENDED', [{ to: 'APPROVED', requiresReason: true }]));
    reviewApi.approve.mockResolvedValue(record('APPROVED', []));
    renderPage(REVIEW);

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    const confirm = (await screen.findAllByRole('button', { name: 'Restore' })).at(-1) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(await screen.findByLabelText(/Note for the applicant/), { target: { value: 'Licence renewed.' } });
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(reviewApi.approve).toHaveBeenCalledWith(ID, { expectedVersion: 4, reason: 'Licence renewed.' });
    });
  });

  it('gives staff without the review grant no case-taking or re-checking', async () => {
    fetchCase.mockResolvedValue(record('SUBMITTED', []));
    renderPage(['buyer_company.read']);

    await screen.findAllByText('Northwind Clinic GmbH');
    expect(screen.queryByRole('button', { name: 'Start review' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Re-run registry checks' })).toBeNull();
  });

  it('starts a review for a reviewer, naming the version', async () => {
    fetchCase.mockResolvedValue(record('SUBMITTED', []));
    reviewApi.startReview.mockResolvedValue(record('UNDER_REVIEW', []));
    renderPage(REVIEW);

    fireEvent.click(await screen.findByRole('button', { name: 'Start review' }));
    await waitFor(() => {
      expect(reviewApi.startReview).toHaveBeenCalledWith(ID, 4);
    });
  });

  it('says so, and reloads the case, when a colleague decided first', async () => {
    fetchCase.mockResolvedValue(record('APPROVED', [{ to: 'SUSPENDED', requiresReason: true }]));
    reviewApi.suspend.mockRejectedValue(
      new ApiError(409, { code: 'BUYER_COMPANY_VERSION_CONFLICT', message: 'stale', details: [] }),
    );
    renderPage(REVIEW);

    fireEvent.click(await screen.findByRole('button', { name: 'Suspend' }));
    fireEvent.change(await screen.findByLabelText(/What to tell the applicant/), { target: { value: 'Licence lapsed.' } });
    const buttons = await screen.findAllByRole('button', { name: 'Suspend' });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);

    await waitFor(() => {
      expect(fetchCase.mock.calls.length).toBeGreaterThan(1);
    });
  });
});
