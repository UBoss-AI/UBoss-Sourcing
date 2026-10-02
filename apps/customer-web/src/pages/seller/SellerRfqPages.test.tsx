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
    ...INBOX,
    ...overrides,
  };
}

/** What the inbox adds to every request (JOURNEY-030). */
const INBOX = {
  qualification: { score: 60, reasons: ['LIVE_IN_CATEGORY', 'EXPORTS_TO_DESTINATION'], flags: ['CAPACITY_UNKNOWN'] },
  buyerVerification: 'VERIFIED_BUSINESS',
  hidden: false,
  assignedMember: null as { id: string; name: string } | null,
};

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
              ...INBOX,
            },
          ],
          counts: { action: 1, quoted: 0, closed: 0, all: 1, hidden: 0 },
        }),
      ),
    );
    render('/seller/rfqs', <SellerRfqsPage />, '/seller/rfqs');
    expect(await screen.findByText('Nitrile gloves')).toBeInTheDocument();
    expect(screen.getByText('Invited')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('filter=action'))).toBe(true);
  });

  it('shows the fit, the buyer\'s verification and the owner, filters by owner and hides a request (JOURNEY-030)', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/assignees')) {
        return Promise.resolve(jsonResponse({ members: [{ id: 'M1'.padEnd(26, '0'), name: 'Priya Shah' }] }));
      }
      if (url.includes('/hide')) return Promise.resolve(jsonResponse({ rfq: sellerRfq({ hidden: true }) }));
      return Promise.resolve(
        jsonResponse({
          items: [
            {
              id: ID, reference: 'RFQ-2026-000042', status: 'OPEN', title: 'Nitrile gloves', categoryName: 'Gloves', quantity: '12000',
              unitOfMeasure: 'BOX', destinationCountry: 'IN', responseDeadline: '2026-11-01T12:00:00.000Z', isPastDeadline: false,
              invitationStatus: 'INVITED', currentRequirementVersion: 1, invitedAt: '2026-10-01T00:00:00.000Z',
              ...INBOX,
              assignedMember: { id: 'M1'.padEnd(26, '0'), name: 'Priya Shah' },
            },
          ],
          counts: { action: 1, quoted: 0, closed: 0, all: 1, hidden: 0 },
        }),
      );
    });
    render('/seller/rfqs', <SellerRfqsPage />, '/seller/rfqs');
    expect(await screen.findByText('60 / 100')).toBeInTheDocument();
    expect(screen.getByText('Verified business')).toBeInTheDocument();
    expect(screen.getByText('No weekly capacity stated in this category')).toBeInTheDocument();
    expect(screen.getAllByText('Priya Shah').length).toBeGreaterThan(0);

    await userEvent.selectOptions(screen.getByLabelText('Owner'), 'me');
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('assignee=me'))).toBe(true);
    });

    await userEvent.click(screen.getByRole('button', { name: 'Hide, not for us' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => String(url).includes(`/seller/rfqs/${ID}/hide`) && (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true);
    });
  });
});

describe('SellerRfqDetailPage', () => {
  it('gives the request to a team member from the detail page (JOURNEY-030)', async () => {
    const member = 'M1'.padEnd(26, '0');
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/assignees')) return Promise.resolve(jsonResponse({ members: [{ id: member, name: 'Priya Shah' }] }));
      if (url.includes('/assign') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ rfq: sellerRfq({ assignedMember: { id: member, name: 'Priya Shah' } }) }));
      }
      if (url.includes('/messages')) return Promise.resolve(jsonResponse({ messages: [] }));
      return Promise.resolve(jsonResponse({ rfq: sellerRfq() }));
    });
    render('/seller/rfqs/:id', <SellerRfqDetailPage />, `/seller/rfqs/${ID}`);
    expect(await screen.findByText('You export to the destination')).toBeInTheDocument();
    expect(screen.getByText('Verified business')).toBeInTheDocument();
    await screen.findByRole('option', { name: 'Priya Shah' });
    await userEvent.selectOptions(screen.getByLabelText('Owner'), member);
    await waitFor(() => {
      const call = (fetchMock.mock.calls as [string, RequestInit | undefined][]).find(
        ([url, init]) => url.includes('/assign') && init?.method === 'POST',
      );
      expect(JSON.parse(call?.[1]?.body as string)).toEqual({ memberId: member });
    });
  });

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
