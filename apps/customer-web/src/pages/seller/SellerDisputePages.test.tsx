/**
 * Seller Hub -> Claims (JOURNEY-058): the list, answering with an offer, the
 * evidence download link and the inspection result beside the claim.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SellerDisputeDetailPage, SellerDisputesPage } from './SellerDisputePages';
import { jsonResponse, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();
const GROUP = 'G'.repeat(26);

const dispute = {
  reference: 'DSP-7',
  status: 'AWAITING_SELLER',
  reasonCode: 'DAMAGED',
  description: 'The box arrived crushed.',
  desiredOutcome: 'REFUND_FULL',
  requestedAmount: { minor: '5000', formatted: '50.00', currency: 'EUR' },
  currency: 'EUR',
  order: { id: null, orderNumber: 'ORD-7', sellerOrderGroupId: GROUP, sellerOrderNumber: 'S-0007' },
  line: { name: 'Nitrile gloves', quantity: 10 },
  seller: null,
  sellerProposal: null,
  decision: null,
  deadlines: { sellerResponseDueAt: '2099-10-05T10:00:00.000Z', sellerResponseBreached: false, decisionDueAt: null, appealDueAt: null },
  attachments: [{ id: 'F1', fileName: 'photo.jpg', party: 'BUYER', createdAt: '2026-10-01T10:00:00.000Z' }],
  inspection: [
    {
      sellerOrderGroupId: GROUP,
      status: 'RELEASED',
      reports: [{ id: 'IR1', revision: 2, status: 'SIGNED', result: 'PASS', signedAt: '2026-09-20T10:00:00.000Z' }],
      linkPath: `/seller/orders/${GROUP}`,
    },
  ],
  thread: [{ id: 'E1', kind: 'CREATED', author: 'BUYER', body: null, createdAt: '2026-10-01T10:00:00.000Z' }],
  can: { message: true, addEvidence: true, escalate: false, withdraw: false, respond: true, appeal: false },
  createdAt: '2026-10-01T10:00:00.000Z',
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SellerDisputesPage', () => {
  it('lists the open claims on this seller’s goods by default', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          disputes: [
            { reference: 'DSP-7', status: 'AWAITING_SELLER', reasonCode: 'DAMAGED', orderNumber: 'ORD-7', lineName: 'Nitrile gloves', lastActivityAt: '2026-10-01T10:00:00.000Z', createdAt: '2026-10-01T10:00:00.000Z' },
          ],
          pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
        }),
      ),
    );
    renderWithProviders(
      <Routes>
        <Route path="/seller/disputes" element={<SellerDisputesPage />} />
      </Routes>,
      { route: '/seller/disputes' },
    );
    expect(await screen.findByRole('link', { name: 'DSP-7' })).toHaveAttribute('href', '/seller/disputes/DSP-7');
    expect(screen.getByText('Waiting for the seller')).toBeInTheDocument();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/seller/disputes');
    expect(url).toContain('status=OPEN');
  });
});

describe('SellerDisputeDetailPage', () => {
  function show(): void {
    renderWithProviders(
      <Routes>
        <Route path="/seller/disputes/:reference" element={<SellerDisputeDetailPage />} />
      </Routes>,
      { route: '/seller/disputes/DSP-7' },
    );
  }

  it('shows the deadline, the evidence and the inspection result, which a claim does not change', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ dispute })));
    show();
    expect(await screen.findByRole('heading', { name: 'DSP-7' })).toBeInTheDocument();
    expect(screen.getByText(/Answer by/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download photo.jpg' })).toBeInTheDocument();
    expect(screen.getByText('Report, revision 2')).toBeInTheDocument();
    expect(screen.getByText('Passed')).toBeInTheDocument();
    expect(screen.getByText(/A claim does not change it/)).toBeInTheDocument();
  });

  it('sends the answer with a partial-refund offer in minor units', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        jsonResponse({
          dispute:
            init?.method === 'POST'
              ? { ...dispute, status: 'UNDER_REVIEW', can: { ...dispute.can, respond: true }, sellerProposal: { resolution: 'REFUND_PARTIAL', amount: { minor: '1250', formatted: '12.50', currency: 'EUR' } } }
              : dispute,
        }),
      ),
    );
    show();
    const send = await screen.findByRole('button', { name: 'Send your answer' });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/your account of what happened/i), 'Packed with double wall carton and photographed.');
    await userEvent.click(screen.getByLabelText('A partial refund'));
    await userEvent.type(screen.getByLabelText(/amount you offer to refund/i), '12.50');
    await userEvent.click(send);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
      expect(String(post?.[0])).toContain('/seller/disputes/DSP-7/response');
      expect(JSON.parse((post?.[1] as RequestInit).body as string)).toMatchObject({
        proposal: 'REFUND_PARTIAL',
        proposalAmountMinor: '1250',
      });
    });
    expect(await screen.findByText('Under review')).toBeInTheDocument();
  });

  it('asks for a single-use link before opening a file', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, origin: window.location.origin, href: window.location.href });
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'POST' && url.includes('/link')
          ? jsonResponse({ url: '/api/v1/seller/disputes/DSP-7/attachments/F1/download?token=t' })
          : jsonResponse({ dispute }),
      ),
    );
    show();
    await userEvent.click(await screen.findByRole('button', { name: 'Download photo.jpg' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/seller/disputes/DSP-7/attachments/F1/link'))).toBe(true);
    });
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(expect.stringContaining('/seller/disputes/DSP-7/attachments/F1/download?token=t'));
    });
  });
});
