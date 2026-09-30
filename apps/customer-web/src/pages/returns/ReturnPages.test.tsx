import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReturnDetailPage, ReturnRequestPage } from './ReturnPages';
import { jsonResponse, renderWithProviders } from '@/test/harness';

const ORDER = 'O'.repeat(26);
const ITEM = 'I'.repeat(26);
const RETURN = 'R'.repeat(26);
const fetchMock = vi.fn();
const money = { minor: '1000', currency: 'EUR' };

const eligibility = {
  orderId: ORDER,
  orderNumber: 'ORD-1',
  eligible: true,
  reason: null,
  windowDays: 30,
  reasonCodes: ['DEFECTIVE', 'NO_LONGER_NEEDED'],
  evidenceRequired: ['DEFECTIVE'],
  replacementEnabled: false,
  files: { available: true, maxBytes: 1_000_000, maxFiles: 6, types: ['image/jpeg'] },
  groups: [
    {
      sellerOrderGroupId: null,
      sellerName: null,
      windowClosesAt: null,
      open: true,
      lines: [{ orderItemId: ITEM, name: 'Gloves', sku: 'G-1', variantName: null, returnable: 2, unitValue: money }],
    },
  ],
};

const created = {
  id: RETURN,
  reference: 'RET-1',
  orderId: ORDER,
  orderNumber: 'ORD-1',
  status: 'REQUESTED',
  reasonCode: 'NO_LONGER_NEEDED',
  description: '',
  preferredResolution: 'REFUND',
  decisionNote: null,
  returnInstructions: null,
  resolutionNote: null,
  createdAt: '2026-09-30T10:00:00.000Z',
  lines: [{ orderItemId: ITEM, name: 'Gloves', quantity: 1, value: money }],
  value: money,
  refund: null,
  files: [],
  timeline: [{ kind: 'STATUS', toStatus: 'REQUESTED', note: null, actorType: 'CUSTOMER', createdAt: '2026-09-30T10:00:00.000Z' }],
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('asking for a return', () => {
  it('sends the chosen lines and reason, and asks for photos only where the reason needs them', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/returns/eligibility')) return Promise.resolve(jsonResponse(eligibility));
      if (url.includes(`/orders/${ORDER}/returns`) && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ return: created }, 201));
      }
      return Promise.resolve(jsonResponse({ return: created }));
    });
    renderWithProviders(
      <Routes>
        <Route path="/account/orders/:id/return" element={<ReturnRequestPage />} />
        <Route path="/account/returns/:id" element={<ReturnDetailPage />} />
      </Routes>,
      { route: `/account/orders/${ORDER}/return` },
    );

    const send = await screen.findByRole('button', { name: /send return request/i });
    expect(send).toBeDisabled();

    await userEvent.clear(screen.getByLabelText(/quantity to return of gloves/i));
    await userEvent.type(screen.getByLabelText(/quantity to return of gloves/i), '1');
    await userEvent.selectOptions(screen.getByRole('combobox'), 'DEFECTIVE');
    expect(screen.getByText(/needed for this reason/i)).toBeInTheDocument();
    expect(send).toBeDisabled();

    await userEvent.selectOptions(screen.getByRole('combobox'), 'NO_LONGER_NEEDED');
    expect(send).toBeEnabled();
    await userEvent.click(send);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
      expect(post).toBeDefined();
      const init = post?.[1] as RequestInit;
      expect(JSON.parse(init.body as string)).toMatchObject({
        reasonCode: 'NO_LONGER_NEEDED',
        items: [{ orderItemId: ITEM, quantity: 1 }],
      });
      expect(new Headers(init.headers).get('Idempotency-Key')).not.toBeNull();
    });
    expect(await screen.findByRole('heading', { name: 'RET-1' })).toBeInTheDocument();
    expect(screen.getByText(/no refund has been issued yet/i)).toBeInTheDocument();
  });

  it('says why when the order cannot be returned', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...eligibility, eligible: false, reason: 'WINDOW_CLOSED' }));
    renderWithProviders(
      <Routes>
        <Route path="/account/orders/:id/return" element={<ReturnRequestPage />} />
      </Routes>,
      { route: `/account/orders/${ORDER}/return` },
    );
    expect(await screen.findByText(/time allowed for returns on this order has passed/i)).toBeInTheDocument();
  });
});
