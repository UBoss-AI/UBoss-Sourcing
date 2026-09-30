import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaimRequestPage, DisputeDetailPage } from './DisputePages';
import { jsonResponse, renderWithProviders } from '@/test/harness';

const ORDER = 'O'.repeat(26);
const fetchMock = vi.fn();

const context = {
  reasons: ['DAMAGED', 'OTHER'],
  remedies: ['REFUND_FULL', 'REFUND_PARTIAL', 'REPLACEMENT'],
  claimWindowDays: 30,
  sellerResponseHours: 48,
  limits: { descriptionMin: 10, descriptionMax: 5000, messageMax: 5000 },
};

const dispute = {
  reference: 'DSP-1',
  status: 'AWAITING_SELLER',
  reasonCode: 'DAMAGED',
  description: 'The box arrived crushed.',
  desiredOutcome: 'REFUND_FULL',
  requestedAmount: null,
  order: { id: ORDER, orderNumber: 'ORD-1' },
  line: null,
  seller: null,
  sellerProposal: null,
  decision: null,
  attachments: [],
  thread: [],
  can: { message: true, addEvidence: true, escalate: false, withdraw: true, appeal: false },
  createdAt: '2026-09-30T10:00:00.000Z',
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('raising a claim', () => {
  it('sends the reason, description and remedy, then shows the claim with what the buyer may do', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/disputes/context')) return Promise.resolve(jsonResponse(context));
      if (url.includes(`/orders/${ORDER}`)) {
        return Promise.resolve(jsonResponse({ order: { id: ORDER, orderNumber: 'ORD-1', currency: 'EUR', items: [] } }));
      }
      if (init?.method === 'POST') return Promise.resolve(jsonResponse({ dispute }, 201));
      return Promise.resolve(jsonResponse({ dispute }));
    });
    renderWithProviders(
      <Routes>
        <Route path="/account/orders/:id/claim" element={<ClaimRequestPage />} />
        <Route path="/account/disputes/:reference" element={<DisputeDetailPage />} />
      </Routes>,
      { route: `/account/orders/${ORDER}/claim` },
    );

    const send = await screen.findByRole('button', { name: /send claim/i });
    expect(send).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText(/what went wrong/i), 'DAMAGED');
    await userEvent.type(screen.getByLabelText(/describe the problem/i), 'The box arrived crushed.');
    await userEvent.click(send);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
      expect(JSON.parse((post?.[1] as RequestInit).body as string)).toMatchObject({
        orderId: ORDER,
        reasonCode: 'DAMAGED',
        desiredOutcome: 'REFUND_FULL',
      });
    });
    expect(await screen.findByRole('heading', { name: 'DSP-1' })).toBeInTheDocument();
    expect(screen.getByText('Waiting for the seller')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /withdraw the claim/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /appeal/i })).not.toBeInTheDocument();
  });
});
