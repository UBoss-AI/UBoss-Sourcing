/**
 * Seller Hub -> Requests for quotation (checklist Master row 17).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Outlet, Route, Routes } from 'react-router-dom';
import { SellerRfqDetailPage } from './SellerRfqDetailPage';
import { SellerRfqsPage } from './SellerRfqsPage';
import type { SellerOutletContext } from './SellerLayout';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { EMPTY_REQUIREMENT } from '@/lib/rfq';

const fetchMock = vi.fn();
const seller = { isTrading: true } as unknown as SellerOutletContext;
const ID = '01RFQ00000000000000000000A';

function sellerRfq(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    reference: 'RFQ-2026-000042',
    status: 'OPEN',
    isPastDeadline: false,
    requirement: { ...EMPTY_REQUIREMENT, title: 'Nitrile gloves', responseDeadline: '2026-11-01T12:00:00.000Z' },
    category: { id: 'c', name: 'Gloves' },
    currentRequirementVersion: 2,
    buyer: { kind: 'COMPANY', companyName: 'Acme Clinics' },
    invitation: { id: 'i', status: 'VIEWED', source: 'MATCHED', invitedAt: '2026-10-01T00:00:00.000Z', viewedAt: null, respondedAt: null, declineReason: null, notifiedVersion: 2 },
    versions: [
      { versionNumber: 1, changedFields: [], changeSummary: null, createdAt: '2026-10-01T00:00:00.000Z' },
      { versionNumber: 2, changedFields: ['quantity'], changeSummary: 'More boxes', createdAt: '2026-10-02T00:00:00.000Z' },
    ],
    attachments: [],
    attachmentPolicy: { available: false, reason: 'NO_SCANNER', maxBytes: 1, maxFiles: 1, types: [] },
    timeline: [],
    actions: { canAsk: true, canDecline: true, canQuote: true },
    ...overrides,
  };
}

function render(path: string, element: React.ReactElement, route: string) {
  return renderWithProviders(
    <Routes>
      <Route element={<Outlet context={seller} />}>
        <Route path={path} element={element} />
      </Route>
    </Routes>,
    { route },
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SellerRfqsPage', () => {
  it('lists the requests this seller was asked to answer, with each invitation status', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          items: [
            {
              id: ID, reference: 'RFQ-2026-000042', status: 'OPEN', title: 'Nitrile gloves', categoryName: 'Gloves', quantity: '12000',
              unitOfMeasure: 'BOX', destinationCountry: 'IN', responseDeadline: '2026-11-01T12:00:00.000Z', isPastDeadline: false,
              invitationStatus: 'INVITED', currentRequirementVersion: 1, invitedAt: '2026-10-01T00:00:00.000Z',
            },
          ],
          counts: { action: 1, quoted: 0, closed: 0, all: 1 },
        }),
      ),
    );
    render('/seller/rfqs', <SellerRfqsPage />, '/seller/rfqs');
    expect(await screen.findByText('Nitrile gloves')).toBeInTheDocument();
    expect(screen.getByText('Invited')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('filter=action'))).toBe(true);
  });
});

describe('SellerRfqDetailPage', () => {
  it('shows the versions, reads its own thread and declines only after the reason is given', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/messages')) return Promise.resolve(jsonResponse({ messages: [] }));
      if (url.includes('/decline') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ rfq: sellerRfq({ invitation: { ...sellerRfq().invitation, status: 'DECLINED' } }) }));
      }
      return Promise.resolve(jsonResponse({ rfq: sellerRfq() }));
    });
    render('/seller/rfqs/:id', <SellerRfqDetailPage />, `/seller/rfqs/${ID}`);
    expect(await screen.findByText(/You are reading version 2/)).toBeInTheDocument();
    expect(screen.getByText(/Changed: Quantity/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Questions' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`/seller/rfqs/${ID}/messages`))).toBe(true);
    });

    await userEvent.click(screen.getByRole('button', { name: 'Decline to quote' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Decline to quote' }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/decline'))).toBe(false);
    await userEvent.type(within(dialog).getByLabelText(/Tell the buyer why/), 'No capacity');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Decline to quote' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/decline'))).toBe(true);
    });
  });
});
