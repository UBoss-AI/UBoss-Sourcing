/**
 * The Audit Team's seller application screen.
 *
 *   - a reviewer with audit.seller.verify is offered the decisions the status
 *     allows, and nobody without it is offered any;
 *   - asking for corrections and rejecting both demand a reason the seller
 *     reads, and nothing is sent without one;
 *   - a decision carries the version on screen, so a colleague's decision
 *     made meanwhile is refused rather than overwritten;
 *   - the history shows who decided, and an earlier Admin Panel decision
 *     still says so.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { api } from '@/lib/api';
import { Permission, holdsAll, holdsAny } from '@/lib/permissions';
import type { SellerVerificationDetail } from '@/lib/seller-verification';
import { sessionFor } from '@/test/session-fixture';
import { SellerVerificationDetailPage } from './SellerVerificationDetailPage';

// Each panel has its own test; here they would only add requests.
vi.mock('./KybReviewPanel', () => ({ KybReviewPanel: () => null }));
vi.mock('./TurnoverPanel', () => ({ TurnoverPanel: () => null }));

const ID = '01SELLER000000000000000001';

function detail(status: SellerVerificationDetail['application']['status']): SellerVerificationDetail {
  return {
    application: {
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
      kyb: {} as SellerVerificationDetail['application']['kyb'],
      locations: [],
      documents: [],
      agreements: [],
      verificationCases: [],
      members: [],
      verification: {
        ownedBy: 'AUDIT',
        consoleEnabled: true,
        reviewersAvailable: true,
        currentDecision: null,
        history: [
          {
            id: 'h1',
            action: 'seller.application.action_required',
            at: '2026-09-10T10:00:00.000Z',
            summary: 'Application moved to action required: upload the licence.',
            actorType: 'ADMIN',
            actorLabel: 'admin@operator.example',
          },
        ],
      },
    },
    readiness: { ready: false, missing: [] },
    turnover: {} as SellerVerificationDetail['turnover'],
  };
}

function renderPage(permissions: string[]): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = sessionFor({ role: 'COMPLIANCE_REVIEWER', permissions });
  const value: SessionState = {
    stage: 'READY',
    session,
    notice: null,
    signIn: vi.fn(),
    signOut: vi.fn(),
    refresh: vi.fn(),
    can: (...keys) => holdsAll(session.member.permissions, keys),
    canAny: (...keys) => holdsAny(session.member.permissions, keys),
  };
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SessionContext.Provider value={value}>
            <MemoryRouter initialEntries={[`/seller-verification/${ID}`]}>
              <Routes>
                <Route path="/seller-verification/:id" element={<SellerVerificationDetailPage />} />
              </Routes>
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

const VERIFY = [Permission.SELLER_READ, Permission.SELLER_VERIFY];

beforeAll(() => {
  window.scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('seller verification decisions', () => {
  it('offers a reviewer the decisions the status allows', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(detail('SUBMITTED'));
    renderPage(VERIFY);
    for (const name of ['Start review', 'Approve seller', 'Request corrections', 'Reject application']) {
      expect(await screen.findByRole('button', { name })).toBeTruthy();
    }
  });

  it('offers nothing to a reader without audit.seller.verify', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(detail('SUBMITTED'));
    renderPage([Permission.SELLER_READ]);
    await screen.findAllByText('Sikka Traders');
    for (const name of ['Start review', 'Approve seller', 'Request corrections', 'Reject application']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('will not reject without a reason, then sends the reason and the version on screen', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(detail('UNDER_REVIEW'));
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined);
    renderPage(VERIFY);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Reject application' }));
    const confirm = (await screen.findAllByRole('button', { name: 'Reject application' })).at(-1) as HTMLButtonElement;
    await user.click(confirm);
    expect(await screen.findByText('Write the reason the seller will read.')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/Message to the seller/i), 'The licence is for another company.');
    await user.click(confirm);
    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        `/audit/seller-verification/${ID}/decision`,
        expect.objectContaining({
          status: 'REJECTED',
          reason: 'The licence is for another company.',
          resubmissionAllowed: true,
          expectedVersion: 7,
        }),
        expect.objectContaining({ idempotencyKey: expect.any(String) as unknown }),
      );
    });
  });

  it('shows an earlier Admin Panel decision as the administrator’s', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(detail('SUBMITTED'));
    renderPage(VERIFY);
    expect(await screen.findByText('Application moved to action required: upload the licence.')).toBeTruthy();
    expect(screen.getByText(/Admin Panel · admin@operator\.example/)).toBeTruthy();
  });
});
