/**
 * One listing under review - the JOURNEY-062 additions.
 *
 *   - a prohibited-term hit shows under "Already flagged" marked automated;
 *   - "Send back" carries a structured evidence request;
 *   - "Approve" can block the product in named countries;
 *   - an appeal is decided from the listing, and the moderator who refused it
 *     is told a colleague must decide.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import type { ListingReviewDetail } from '@/lib/sellers';
import { ListingReviewPage } from './ListingReviewPage';

vi.mock('@/lib/sellers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sellers')>();
  return {
    ...actual,
    fetchListingForReview: vi.fn(),
    decideListing: vi.fn().mockResolvedValue({ offerId: 'O1' }),
    decideListingAppeal: vi.fn().mockResolvedValue({ id: 'L1', status: 'PENDING_REVIEW' }),
  };
});

const lib = await import('@/lib/sellers');
const fetchListing = vi.mocked(lib.fetchListingForReview);
const decide = vi.mocked(lib.decideListing);
const decideAppeal = vi.mocked(lib.decideListingAppeal);

// jsdom has no <dialog> methods; the Modal only needs `open` toggled.
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

function listing(overrides: Partial<ListingReviewDetail> = {}): ListingReviewDetail {
  return {
    id: 'L1',
    status: 'PENDING_REVIEW',
    sellerAccountId: 'S1',
    sellerName: 'Acme',
    sellerSku: 'ACM-1',
    title: 'Hand gel 500 ml',
    generatedTitle: 'Hand gel 500 ml',
    sellerEditedTitle: null,
    brandName: null,
    brandStatus: null,
    categoryId: 'C1',
    categoryPath: [],
    attributes: {},
    content: null,
    offer: {},
    stock: [],
    packaging: {},
    media: [],
    issues: [
      {
        id: 'I1',
        severity: 'WARNING',
        code: 'PROHIBITED_TERM',
        section: null,
        attributeKey: null,
        message: 'Contains "cures": Medical claims are not allowed.',
        isFromModerator: false,
      },
    ],
    schema: null,
    submittedAt: '2026-10-01T09:00:00.000Z',
    submittedVersion: 2,
    reviewComment: null,
    reviewedByUserId: null,
    evidenceRequest: [],
    appeal: null,
    updatedAt: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

function renderPage(userId = 'u1'): void {
  const session = {
    user: { id: userId, email: 'mod@example.test' },
    isLoading: false,
    can: () => true,
    canAny: () => true,
  } as unknown as SessionState;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SessionContext.Provider value={session}>
            <MemoryRouter initialEntries={['/listing-review/L1']}>
              <Routes>
                <Route path="/listing-review/:id" element={<ListingReviewPage />} />
                <Route path="/listing-review" element={<p>queue</p>} />
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
  fetchListing.mockReset();
  decide.mockClear();
  decideAppeal.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('ListingReviewPage moderation tools', () => {
  it('marks a prohibited-term hit as automated', async () => {
    fetchListing.mockResolvedValue(listing());
    renderPage();
    expect(await screen.findByText(/Contains "cures"/)).toBeTruthy();
    expect(screen.getByText('Automated')).toBeTruthy();
  });

  it('sends an evidence request with "send back"', async () => {
    fetchListing.mockResolvedValue(listing());
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Send back for changes' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ask for a document' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'What to send' }), { target: { value: 'CE certificate' } });
    fireEvent.change(within(dialog).getAllByRole('textbox')[0] as HTMLElement, { target: { value: 'Please send the CE certificate.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send it back' }));
    await waitFor(() => {
      expect(decide).toHaveBeenCalledTimes(1);
    });
    expect(decide.mock.calls[0]?.[1]).toMatchObject({
      status: 'ACTION_REQUIRED',
      evidenceRequest: [{ kind: 'CERTIFICATE', label: 'CE certificate', note: null }],
    });
  });

  it('blocks the product in the countries typed on approval', async () => {
    fetchListing.mockResolvedValue(listing());
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Do not sell in/ }), { target: { value: 'us, gb' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(decide).toHaveBeenCalledTimes(1);
    });
    expect(decide.mock.calls[0]?.[1]).toMatchObject({ status: 'APPROVED', blockedCountries: ['US', 'GB'] });
  });

  it('decides an appeal, and tells the moderator who refused it to hand it over', async () => {
    fetchListing.mockResolvedValue(
      listing({ status: 'APPEALED', reviewedByUserId: 'u1', appeal: { reason: 'We removed the claim.', appealedAt: null, outcome: null } }),
    );
    renderPage('u1');
    expect(await screen.findByText('We removed the claim.')).toBeTruthy();
    expect(screen.getByText(/different moderator/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Uphold the appeal' })).toHaveProperty('disabled', true);
  });

  it('lets a second moderator uphold it', async () => {
    fetchListing.mockResolvedValue(
      listing({ status: 'APPEALED', reviewedByUserId: 'u9', appeal: { reason: 'We removed the claim.', appealedAt: null, outcome: null } }),
    );
    renderPage('u1');
    await screen.findByText('We removed the claim.');
    fireEvent.change(screen.getByRole('textbox', { name: /Your answer to the seller/ }), { target: { value: 'Looks right now.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Uphold the appeal' }));
    await waitFor(() => {
      expect(decideAppeal).toHaveBeenCalledWith('L1', { outcome: 'UPHELD', comment: 'Looks right now.' });
    });
  });
});
