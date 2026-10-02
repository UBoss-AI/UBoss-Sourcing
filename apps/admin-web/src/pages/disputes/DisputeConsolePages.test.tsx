/**
 * The dispute case screen (JOURNEY-058): the evidence timeline with download
 * links and staff upload, the assignee selector, the payment / chargeback /
 * seller-funds panel and the inspection report behind the claim.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { api, downloadFile } from '@/lib/api';
import { DisputeCasePage } from './DisputeConsolePages';

vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useParams: () => ({ id: 'D1' }),
}));
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, downloadFile: vi.fn(), api: { ...actual.api, get: vi.fn(), post: vi.fn(), upload: vi.fn() } };
});

const eur = (minor: string, formatted: string) => ({ minor, formatted, currency: 'EUR' });

const dispute = {
  id: 'D1',
  reference: 'DSP-1',
  kind: 'CLAIM',
  status: 'UNDER_REVIEW',
  reasonCode: 'DAMAGED',
  description: 'The box arrived crushed.',
  desiredOutcome: 'REFUND_FULL',
  requestedAmount: eur('5000', '50.00'),
  currency: 'EUR',
  order: { id: 'O1', orderNumber: 'ORD-1', status: 'DELIVERED', paid: eur('5000', '50.00'), refunded: eur('0', '0.00'), maxRefundable: eur('5000', '50.00') },
  payment: { provider: 'stripe', status: 'CAPTURED', disputedAt: null, amount: eur('5000', '50.00') },
  openChargeback: { id: 'D2', reference: 'CB-9', status: 'NEEDS_RESPONSE', providerStatus: 'needs_response', evidenceDueAt: '2026-10-09T10:00:00.000Z' },
  chargeback: null,
  fundHolds: [
    {
      sellerOrderGroupId: 'G1',
      sellerName: 'Acme',
      status: 'ON_HOLD',
      allocated: eur('4500', '45.00'),
      released: eur('0', '0.00'),
      holdCode: 'DISPUTE',
      holdReason: 'Claim DSP-1 is open',
      holdPlacedAt: '2026-10-01T10:00:00.000Z',
      releasedAt: null,
    },
  ],
  inspection: [
    {
      requirementId: 'R1',
      sellerOrderGroupId: 'G1',
      status: 'RELEASED',
      reports: [{ id: 'IR1', revision: 1, status: 'SIGNED', result: 'PASS', signedAt: '2026-09-20T10:00:00.000Z' }],
      linkPath: '/inspection/R1',
    },
  ],
  buyer: { name: 'Bea Buyer', email: 'bea@example.test' },
  seller: { id: 'S1', displayName: 'Acme' },
  sellerProposal: null,
  proposal: null,
  decision: null,
  assignee: null,
  sla: {
    sellerResponseDueAt: '2026-09-25T10:00:00.000Z',
    sellerResponseBreached: true,
    decisionDueAt: '2026-10-10T10:00:00.000Z',
    decisionBreached: false,
    evidenceDueAt: null,
    evidenceBreached: false,
    appealDueAt: null,
  },
  appealCount: 0,
  approval: { thresholdMinor: '10000', currency: 'EUR' },
  attachments: [{ id: 'F1', party: 'BUYER', fileName: 'photo.jpg', contentType: 'image/jpeg', kind: 'IMAGE', byteSize: 2048, createdAt: '2026-09-24T10:00:00.000Z' }],
  events: [{ id: 'E1', kind: 'CREATED', party: 'BUYER', body: null, actor: null, toValue: null, amount: null, visibleToBuyer: true, visibleToSeller: true, createdAt: '2026-09-24T10:00:00.000Z' }],
  can: { manage: true, note: true, decide: false, approve: false, assign: true },
};

function show(): void {
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
        <ToastProvider>
          <MemoryRouter>
            <DisputeCasePage />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.clearAllMocks();
  vi.mocked(api.get).mockImplementation((path: string) =>
    Promise.resolve(
      path.endsWith('/assignees')
        ? { assignees: [{ id: 'U1', email: 'ana@ops.test' }] }
        : { dispute },
    ),
  );
  vi.mocked(api.post).mockImplementation((path: string) =>
    Promise.resolve(path.endsWith('/link') ? { url: '/api/v1/admin/disputes/D1/attachments/F1/download?token=t' } : { dispute }),
  );
  vi.mocked(api.upload).mockResolvedValue({ dispute });
});

describe('dispute case page', () => {
  it('shows payment, the open chargeback, the held seller funds and the inspection result', async () => {
    show();
    expect(await screen.findByText('DSP-1')).toBeInTheDocument();
    expect(screen.getByText(/Payment by stripe: Captured/)).toBeInTheDocument();
    expect(screen.getByText(/also opened chargeback CB-9/)).toBeInTheDocument();
    expect(screen.getByText('On Hold')).toBeInTheDocument();
    expect(screen.getByText(/Claim DSP-1 is open/)).toBeInTheDocument();
    expect(screen.getByText('Report, revision 1')).toBeInTheDocument();
    expect(screen.getByText('Pass')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the inspection' })).toHaveAttribute('href', '/inspection/R1');
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText(/needs a second member of staff/)).toBeInTheDocument();
  });

  it('downloads a file through a single-use link', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Download photo.jpg' }));
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/admin/disputes/D1/attachments/F1/link');
    });
    await waitFor(() => {
      expect(downloadFile).toHaveBeenCalledWith('/admin/disputes/D1/attachments/F1/download?token=t', 'photo.jpg');
    });
  });

  it('uploads staff evidence', async () => {
    show();
    const input = await screen.findByLabelText(/Add a file as the marketplace/);
    fireEvent.change(input, { target: { files: [new File(['x'], 'statement.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => {
      expect(api.upload).toHaveBeenCalledWith('/admin/disputes/D1/attachments', expect.any(FormData));
    });
  });

  it('assigns the dispute to a colleague', async () => {
    show();
    const select = await screen.findByLabelText('Assigned to');
    await screen.findByRole('option', { name: 'ana@ops.test' });
    fireEvent.change(select, { target: { value: 'U1' } });
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/admin/disputes/D1/assignment', { assigneeUserId: 'U1' });
    });
  });

  it('says so when the goods had no inspection', async () => {
    vi.mocked(api.get).mockImplementation((path: string) =>
      Promise.resolve(path.endsWith('/assignees') ? { assignees: [] } : { dispute: { ...dispute, inspection: [], openChargeback: null, fundHolds: [] } }),
    );
    show();
    expect(await screen.findByText('These goods had no inspection.')).toBeInTheDocument();
    expect(screen.getByText('No seller funds are recorded for this order.')).toBeInTheDocument();
  });
});
