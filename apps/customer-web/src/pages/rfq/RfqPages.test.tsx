/**
 * The buyer's request-for-quotation screens (checklist Master row 16).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { RfqDetailPage } from './RfqDetailPage';
import { RfqEditPage } from './RfqEditPage';
import { RfqListPage } from './RfqListPage';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { EMPTY_REQUIREMENT, type BuyerRfq } from '@/lib/rfq';

const fetchMock = vi.fn();

const OPTIONS = {
  unitsOfMeasure: ['PIECE', 'BOX'],
  incoterms: ['EXW', 'CIF'],
  sampleRequirements: ['NONE', 'WITH_QUOTE'],
  inspectionRequirements: ['NONE'],
  maxResponseDays: 90,
  maxInvitedSuppliers: 50,
  attachments: { available: true, reason: null, maxBytes: 10_485_760, maxFiles: 40, types: ['application/pdf'] },
};

function rfq(overrides: Partial<BuyerRfq> = {}): BuyerRfq {
  return {
    id: '01RFQ00000000000000000000A',
    reference: 'RFQ-2026-000042',
    status: 'OPEN',
    version: 1,
    isPastDeadline: false,
    requirement: { ...EMPTY_REQUIREMENT, title: 'Nitrile gloves', quantity: '12000', unitOfMeasure: 'BOX', responseDeadline: '2026-11-01T12:00:00.000Z' },
    targetPrice: null,
    category: { id: 'cat', name: 'Gloves' },
    owner: { kind: 'INDIVIDUAL' },
    currentRequirementVersion: 1,
    matchOutcome: 'NO_MATCH',
    matchedSupplierCount: 0,
    selection: { include: [], exclude: [] },
    invitations: [
      {
        id: 'inv1',
        source: 'BUYER_SELECTED',
        status: 'VIEWED',
        invitedAt: '2026-10-01T00:00:00.000Z',
        viewedAt: '2026-10-02T00:00:00.000Z',
        respondedAt: null,
        declineReason: null,
        supplier: {
          sellerAccountId: 's1',
          displayName: 'Gamma Supplies',
          slug: 'gamma',
          registrationCountry: 'IN',
          verifiedAt: '2026-01-01T00:00:00.000Z',
          matchesCategory: false,
        },
      },
    ],
    attachments: [],
    attachmentPolicy: OPTIONS.attachments,
    versions: [{ versionNumber: 1, changedFields: [], changeSummary: null, createdAt: '2026-10-01T00:00:00.000Z' }],
    timeline: [],
    submittedAt: '2026-10-01T00:00:00.000Z',
    closedAt: null,
    cancelledAt: null,
    statusReason: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    actions: { canEdit: false, canSubmit: false, canCancel: true, canClose: true, canInvite: true, canAmend: true },
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RfqListPage', () => {
  it('lists requests with their status and filters by status through the address', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          items: [
            {
              id: 'r1', reference: 'RFQ-2026-000001', status: 'OPEN', title: 'Nitrile gloves', categoryName: 'Gloves',
              quantity: '12000', unitOfMeasure: 'BOX', destinationCountry: 'IN', responseDeadline: '2026-11-01T12:00:00.000Z',
              isPastDeadline: false, invitedCount: 3, respondedCount: 1, updatedAt: '2026-10-01T00:00:00.000Z', submittedAt: null,
            },
          ],
          counts: { DRAFT: 0, OPEN: 1, CLOSED: 0, AWARDED: 0, CANCELLED: 0 },
        }),
      ),
    );
    renderWithProviders(<RfqListPage />);
    expect(await screen.findByText('Nitrile gloves')).toBeInTheDocument();
    expect(screen.getByText('1 of 3 suppliers')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Open for quotes/ }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('status=OPEN'))).toBe(true);
    });
  });

  it('offers a retry when the list cannot be loaded', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Down.' } }, 500)));
    renderWithProviders(<RfqListPage />);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('RfqEditPage', () => {
  it('explains each matched supplier, flags capacity, and invites or excludes all (JOURNEY-014)', async () => {
    const draftRfq = rfq({ status: 'DRAFT', requirement: { ...EMPTY_REQUIREMENT, title: 'Nitrile gloves', categoryId: 'cat', destinationCountry: 'IN', quantity: '12000', unitOfMeasure: 'BOX', responseDeadline: '2026-11-01T12:00:00.000Z' } });
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/form-options')) return Promise.resolve(jsonResponse(OPTIONS));
      if (url.includes('/catalog/categories')) return Promise.resolve(jsonResponse({ categories: [] }));
      if (url.includes('/matches')) {
        return Promise.resolve(
          jsonResponse({
            outcome: 'MATCHED',
            blockedReason: null,
            suppliers: [
              { sellerAccountId: 'sa', displayName: 'Alpha Gloves', slug: 'alpha', registrationCountry: 'IN', verifiedAt: null, matchesCategory: true,
                reasons: ['LIVE_IN_CATEGORY', 'EXPORTS_TO_DESTINATION'], flags: ['CAPACITY_BELOW_QUANTITY'] },
            ],
          }),
        );
      }
      return Promise.resolve(jsonResponse({ rfq: draftRfq }));
    });
    renderWithProviders(
      <Routes>
        <Route path="/account/rfqs/:id/edit" element={<RfqEditPage />} />
      </Routes>,
      { route: `/account/rfqs/${draftRfq.id}/edit` },
    );
    expect(await screen.findByText('Exports to your destination')).toBeInTheDocument();
    expect(screen.getByText('Stated capacity may not cover this quantity in time')).toBeInTheDocument();
    const box = screen.getByRole('checkbox', { name: /Alpha Gloves/ });
    expect(box).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Exclude all, then pick' }));
    expect(box).not.toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Invite all matched' }));
    expect(box).toBeChecked();
  });

  it('marks each field the server refused, beside the field and in the summary', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/form-options')) return Promise.resolve(jsonResponse(OPTIONS));
      if (url.includes('/catalog/categories')) return Promise.resolve(jsonResponse({ categories: [] }));
      if (url.includes('/submit')) {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: 'RFQ_INCOMPLETE',
                message: 'Missing.',
                details: [
                  { field: 'quantity', code: 'REQUIRED' },
                  { field: 'responseDeadline', code: 'IN_PAST' },
                ],
              },
            },
            400,
          ),
        );
      }
      if ((init?.method ?? 'GET') === 'POST' && url.endsWith('/rfqs')) {
        return Promise.resolve(jsonResponse({ rfq: rfq({ status: 'DRAFT', version: 0 }) }, 201));
      }
      return Promise.resolve(jsonResponse({ rfq: rfq({ status: 'DRAFT' }) }));
    });
    renderWithProviders(
      <Routes>
        <Route path="/account/rfqs/new" element={<RfqEditPage />} />
      </Routes>,
      { route: '/account/rfqs/new' },
    );

    await userEvent.type(await screen.findByLabelText(/^Title/), 'Nitrile gloves');
    await userEvent.click(screen.getByRole('button', { name: 'Send to suppliers' }));

    const quantity = await screen.findByLabelText(/^Quantity/);
    await waitFor(() => {
      expect(quantity).toHaveAttribute('aria-invalid', 'true');
    });
    const describedBy = quantity.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy.split(' ').at(-1) ?? '')?.textContent).toBe(
      'This is needed before the request can be sent.',
    );
    const summary = screen.getByText('Some details need attention').closest('[role="alert"]');
    expect(summary).not.toBeNull();
    expect(within(summary as HTMLElement).getByText(/Quotes due by: Choose a time in the future/)).toBeInTheDocument();
  });

  it('checks the quantity in the browser before anything is sent', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/form-options')) return Promise.resolve(jsonResponse(OPTIONS));
      return Promise.resolve(jsonResponse({ categories: [] }));
    });
    renderWithProviders(
      <Routes>
        <Route path="/account/rfqs/new" element={<RfqEditPage />} />
      </Routes>,
      { route: '/account/rfqs/new' },
    );
    await userEvent.type(await screen.findByLabelText(/^Quantity/), '1.2345');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findAllByText(/at most three decimal places/)).not.toHaveLength(0);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });
});

describe('RfqDetailPage', () => {
  it('says honestly that nothing matched, and lists who was asked with their status', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ rfq: rfq() })));
    renderWithProviders(
      <Routes>
        <Route path="/account/rfqs/:id" element={<RfqDetailPage />} />
      </Routes>,
      { route: '/account/rfqs/01RFQ00000000000000000000A' },
    );
    await userEvent.click(await screen.findByRole('tab', { name: /Suppliers/ }));
    expect(screen.getByText(/No approved supplier matched/)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: /Suppliers asked to quote/ });
    expect(within(table).getByRole('rowheader', { name: /Gamma Supplies/ })).toBeInTheDocument();
    expect(within(table).getByText('Viewed')).toBeInTheDocument();
    expect(within(table).getByText('Picked by you')).toBeInTheDocument();
  });
});
