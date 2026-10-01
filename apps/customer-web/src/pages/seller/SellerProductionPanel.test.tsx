/**
 * Master rows 40 and 22: the seller's production panel and the buyer's
 * milestone timeline.
 *
 *   - only the next stage has a "record" button, and it sends that stage;
 *   - a closed order offers no buttons at all;
 *   - the buyer timeline shows the seller's buyer note, documents, shipments
 *     and an open exception, and renders nothing for an empty order.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import type { ProductionView } from '@/lib/seller-workbench';
import type { OrderMilestones } from '@/lib/order-milestones';
import { SellerProductionPanel } from './SellerProductionPanel';
import { OrderMilestoneTimeline } from '@/components/OrderMilestoneTimeline';

vi.mock('@/lib/seller-workbench', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/seller-workbench')>();
  return {
    ...actual,
    fetchProduction: vi.fn(),
    completeProductionStage: vi.fn(() => Promise.resolve()),
    planProductionStage: vi.fn(() => Promise.resolve()),
    raiseProductionDelay: vi.fn(() => Promise.resolve({ delayId: 'x' })),
    resolveProductionDelay: vi.fn(() => Promise.resolve()),
  };
});
vi.mock('@/lib/order-milestones', () => ({ fetchOrderMilestones: vi.fn() }));

const workbench = await import('@/lib/seller-workbench');
const milestones = await import('@/lib/order-milestones');
const fetchProduction = vi.mocked(workbench.fetchProduction);
const completeProductionStage = vi.mocked(workbench.completeProductionStage);
const fetchOrderMilestones = vi.mocked(milestones.fetchOrderMilestones);

function production(overrides: Partial<ProductionView> = {}): ProductionView {
  return {
    open: true,
    nextStage: 'IN_PRODUCTION',
    stages: [
      {
        stage: 'RAW_MATERIAL',
        plannedFor: null,
        completedAt: '2026-10-01T09:00:00.000Z',
        completedByLabel: 'Asha',
        internalNote: null,
        buyerNote: 'Steel arrived',
      },
      { stage: 'IN_PRODUCTION', plannedFor: '2026-10-10', completedAt: null, completedByLabel: null, internalNote: null, buyerNote: null },
      { stage: 'QUALITY_CHECKED', plannedFor: null, completedAt: null, completedByLabel: null, internalNote: null, buyerNote: null },
      { stage: 'READY', plannedFor: null, completedAt: null, completedByLabel: null, internalNote: null, buyerNote: null },
    ],
    delays: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SellerProductionPanel', () => {
  it('offers a record button on the next stage only, and sends that stage', async () => {
    fetchProduction.mockResolvedValue(production());
    renderWithProviders(<SellerProductionPanel sellerOrderId="01GROUP0000000000000000001" />);

    const next = await screen.findByTestId('stage-IN_PRODUCTION');
    for (const other of ['stage-RAW_MATERIAL', 'stage-QUALITY_CHECKED', 'stage-READY']) {
      expect(within(screen.getByTestId(other)).queryByRole('button')).toBeNull();
    }

    fireEvent.click(within(next).getByRole('button'));
    await waitFor(() => {
      expect(completeProductionStage).toHaveBeenCalledWith('01GROUP0000000000000000001', {
        stage: 'IN_PRODUCTION',
        buyerNote: null,
        internalNote: null,
      });
    });
  });

  it('offers nothing to press on a closed order', async () => {
    fetchProduction.mockResolvedValue(production({ open: false, nextStage: null }));
    renderWithProviders(<SellerProductionPanel sellerOrderId="01GROUP0000000000000000001" />);
    await screen.findByTestId('stage-READY');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

function timeline(overrides: Partial<OrderMilestones> = {}): OrderMilestones {
  const money = (minor: string) => ({ minor, formatted: `₹${minor}`, currency: 'INR' });
  return {
    payment: { state: 'PAID', total: money('100'), paid: money('100'), refunded: money('0'), confirmedAt: null },
    sellers: [
      {
        sellerGroupId: 'g1',
        sellerName: 'Sikka Steel',
        status: 'ACCEPTED',
        production: {
          stages: [
            { stage: 'RAW_MATERIAL', completedAt: '2026-10-01T09:00:00.000Z', note: 'Steel arrived', plannedFor: null },
            { stage: 'IN_PRODUCTION', completedAt: null, note: null, plannedFor: null },
            { stage: 'QUALITY_CHECKED', completedAt: null, note: null, plannedFor: null },
            { stage: 'READY', completedAt: null, note: null, plannedFor: '2026-11-20' },
          ],
          openDelays: [
            {
              stage: 'IN_PRODUCTION',
              reason: 'MACHINE_BREAKDOWN',
              expectedDate: '2026-11-10',
              message: 'A press is being repaired.',
              raisedAt: '2026-10-02T09:00:00.000Z',
            },
          ],
        },
        inspection: { level: 'MANDATORY', status: 'AWAITING_BOOKING' },
        shipments: [],
        documents: [
          { id: 'd1', kind: 'CERTIFICATE_OF_ORIGIN', title: 'Certificate of origin', version: 1, validation: 'VALID', issuedOn: null, expiresOn: null },
        ],
      },
    ],
    events: [{ at: '2026-10-01T09:00:00.000Z', kind: 'MILESTONE_REACHED', sellerGroupId: 'g1', stage: 'RAW_MATERIAL', message: 'Steel arrived' }],
    ...overrides,
  };
}

describe('OrderMilestoneTimeline', () => {
  it('shows production, the open exception, documents and the seller', async () => {
    fetchOrderMilestones.mockResolvedValue(timeline());
    renderWithProviders(<OrderMilestoneTimeline orderId="01ORDER0000000000000000001" />);

    const part = await screen.findByTestId('milestones-g1');
    expect(within(part).getByText('Sikka Steel')).toBeInTheDocument();
    expect(within(part).getByText('Steel arrived')).toBeInTheDocument();
    expect(within(part).getByRole('status')).toHaveTextContent('A press is being repaired.');
    expect(within(part).getByText('Certificate of origin', { exact: false })).toBeInTheDocument();
  });

  it('renders nothing for an order with no sellers and no events', async () => {
    fetchOrderMilestones.mockResolvedValue(timeline({ sellers: [], events: [] }));
    const { container } = renderWithProviders(<OrderMilestoneTimeline orderId="01ORDER0000000000000000001" />);
    await waitFor(() => {
      expect(fetchOrderMilestones).toHaveBeenCalled();
    });
    expect(container.querySelector('[data-testid^="milestones-"]')).toBeNull();
  });
});
