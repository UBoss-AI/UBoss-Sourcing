/**
 * The tracking block on the buyer's order page: what it says about trouble,
 * the ETA in each of its states, the carrier's journey, and the proof of
 * delivery - including that the images are only ever fetched through a
 * freshly minted link, and that the seller's copy never offers them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import type { ConsignmentTracking } from '@/lib/order-tracking';
import type { OrderShipment } from '@/lib/types';
import { SellerConsignmentTracking } from '@/pages/seller/SellerConsignmentTracking';
import { ConsignmentTrackingDetail, OrderTracking } from './OrderTracking';

const ORDER = '01ORDER0000000000000000000';
const SHIP = '01SHIP00000000000000000000';

function consignment(overrides: Partial<ConsignmentTracking> = {}): ConsignmentTracking {
  return {
    id: SHIP,
    reference: 'LS-2026-000123',
    status: 'IN_TRANSIT',
    events: [],
    openTrouble: [],
    eta: { source: 'NONE', at: null, isLate: false },
    proofOfDelivery: null,
    deliveredWithoutProof: false,
    ...overrides,
  };
}

function shipment(overrides: Partial<OrderShipment> = {}): OrderShipment {
  return {
    carrier: 'North Courier',
    trackingNumber: 'TRK-1',
    trackingUrl: null,
    status: 'IN_TRANSIT',
    dispatchedAt: null,
    deliveredAt: null,
    sentBy: 'Acme Supplies',
    ...overrides,
  };
}

function stub(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input.toString();
    for (const [fragment, respond] of Object.entries(routes)) {
      if (url.includes(fragment)) return Promise.resolve(respond());
    }
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const urlsOf = (mock: ReturnType<typeof stub>): string[] =>
  mock.mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input)));

const POD = {
  deliveredAt: '2026-09-12T09:00:00.000Z',
  receivedBy: 'Maria Kowalska',
  receivedByRole: 'Store manager',
  confirmedWithCode: true,
  businessStamped: false,
  signature: { captured: true, available: true },
  photo: { captured: true, available: false },
};

describe('the ETA', () => {
  it('says plainly when there is no date', () => {
    renderWithProviders(<ConsignmentTrackingDetail orderId={ORDER} consignment={consignment()} showReference={false} />);
    expect(
      screen.getByText('No expected delivery date yet. It will appear here as soon as the carrier gives one.'),
    ).toBeInTheDocument();
  });

  it('names an estimate, a revised estimate and a promise differently, and says when it is late', () => {
    const { rerender } = renderWithProviders(
      <ConsignmentTrackingDetail
        orderId={ORDER}
        consignment={consignment({ eta: { source: 'ESTIMATE', at: '2026-10-02T10:00:00.000Z', isLate: false } })}
        showReference={false}
      />,
    );
    expect(screen.getByText(/^Expected delivery:/)).toBeInTheDocument();

    rerender(
      <ConsignmentTrackingDetail
        orderId={ORDER}
        consignment={consignment({ eta: { source: 'REVISED', at: '2026-10-02T10:00:00.000Z', isLate: false } })}
        showReference={false}
      />,
    );
    expect(screen.getByText(/^New expected delivery:/)).toBeInTheDocument();

    rerender(
      <ConsignmentTrackingDetail
        orderId={ORDER}
        consignment={consignment({ eta: { source: 'PROMISE', at: '2026-09-20T10:00:00.000Z', isLate: true } })}
        showReference={false}
      />,
    );
    expect(screen.getByText(/the carrier’s service promise/)).toBeInTheDocument();
    expect(screen.getByText('Running late: it has not arrived by this date.')).toBeInTheDocument();
  });

  it('shows no ETA at all once the parcel is finished', () => {
    renderWithProviders(
      <ConsignmentTrackingDetail
        orderId={ORDER}
        consignment={consignment({ status: 'DELIVERED', eta: { source: 'FINISHED', at: null, isLate: false } })}
        showReference={false}
      />,
    );
    expect(screen.queryByText(/expected delivery/i)).not.toBeInTheDocument();
  });
});

describe('trouble and the journey', () => {
  it('explains a customs or port hold in plain words and marks the event as a problem', () => {
    renderWithProviders(
      <ConsignmentTrackingDetail
        orderId={ORDER}
        consignment={consignment({
          status: 'CUSTOMS_HOLD',
          openTrouble: [{ category: 'CUSTOMS', since: '2026-09-11T09:00:00.000Z' }],
          events: [
            {
              status: 'PICKED_UP',
              kind: 'MILESTONE',
              trouble: null,
              description: 'Your order has been collected by the carrier.',
              occurredAt: '2026-09-10T09:00:00.000Z',
              location: null,
            },
            {
              status: 'CUSTOMS_HOLD',
              kind: 'TROUBLE',
              trouble: 'CUSTOMS',
              description: null,
              occurredAt: '2026-09-11T09:00:00.000Z',
              location: 'Rotterdam port',
            },
          ],
        })}
        showReference
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('held at customs or at the port while it is cleared');
    // The buyer's own sentence where one was written, and the plain label where not.
    expect(screen.getByText('Your order has been collected by the carrier.')).toBeInTheDocument();
    expect(screen.getByText('Held at customs or at the port')).toBeInTheDocument();
    expect(screen.getByText(/Rotterdam port/)).toBeInTheDocument();
    expect(screen.getByText('LS-2026-000123')).toBeInTheDocument();
  });
});

describe('proof of delivery', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says who took it, that the code was used, and offers only the images it may hand over', () => {
    renderWithProviders(
      <ConsignmentTrackingDetail
        orderId={ORDER}
        consignment={consignment({ status: 'DELIVERED', eta: { source: 'FINISHED', at: null, isLate: false }, proofOfDelivery: POD })}
        showReference={false}
      />,
    );

    expect(screen.getByText('Proof of delivery')).toBeInTheDocument();
    expect(screen.getByText('Maria Kowalska (Store manager)')).toBeInTheDocument();
    expect(screen.getByText('Confirmed with the delivery code sent to you.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download the signature' })).toBeInTheDocument();
    // Captured but not servable: said, not offered.
    expect(screen.queryByRole('button', { name: 'Download the delivery photo' })).not.toBeInTheDocument();
    expect(screen.getByText(/cannot be downloaded here yet/)).toBeInTheDocument();
    // Never an inline image.
    expect(document.querySelector('img')).toBeNull();
  });

  it('mints a single-use link when asked, and only then fetches the file', async () => {
    const link = `/api/v1/orders/${ORDER}/shipments/${SHIP}/proof-of-delivery/signature/download?token=abc`;
    const fetchMock = stub({
      '/proof-of-delivery/signature/link': () =>
        jsonResponse({ url: link, expiresAt: '2026-09-29T10:05:00.000Z' }),
      '/proof-of-delivery/signature/download': () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="signature.png"' },
        }),
    });
    const createObjectURL = vi.fn(() => 'blob:signature');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));

    renderWithProviders(
      <ConsignmentTrackingDetail
        orderId={ORDER}
        consignment={consignment({ status: 'DELIVERED', eta: { source: 'FINISHED', at: null, isLate: false }, proofOfDelivery: POD })}
        showReference={false}
      />,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Download the signature' }));

    await waitFor(() => {
      expect(createObjectURL).toHaveBeenCalled();
    });
    const urls = urlsOf(fetchMock);
    expect(urls[0]).toContain(`/orders/${ORDER}/shipments/${SHIP}/proof-of-delivery/signature/link`);
    expect(urls[1]).toContain('/proof-of-delivery/signature/download?token=abc');
  });

  it('says so when a parcel was marked delivered with no proof', () => {
    renderWithProviders(
      <ConsignmentTrackingDetail
        orderId={ORDER}
        consignment={consignment({ status: 'DELIVERED', eta: { source: 'FINISHED', at: null, isLate: false }, deliveredWithoutProof: true })}
        showReference={false}
      />,
    );
    expect(screen.getByText('Marked as delivered. No proof of delivery was recorded here.')).toBeInTheDocument();
  });
});

describe('the block on the order page', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hangs each consignment’s tracking off its line', async () => {
    const fetchMock = stub({
      [`/orders/${ORDER}/tracking`]: () =>
        jsonResponse({
          consignments: [
            consignment({ eta: { source: 'ESTIMATE', at: '2026-10-02T10:00:00.000Z', isLate: false } }),
          ],
        }),
    });

    renderWithProviders(<OrderTracking orderId={ORDER} shipments={[shipment({ consignmentIds: [SHIP] })]} />);

    expect(screen.getByText('North Courier')).toBeInTheDocument();
    expect(await screen.findByText(/^Expected delivery:/)).toBeInTheDocument();
    expect(urlsOf(fetchMock).some((url) => url.includes(`/orders/${ORDER}/tracking`))).toBe(true);
  });

  it('does not ask for tracking when no line has a consignment, and keeps the inline journey', () => {
    const fetchMock = stub({});
    renderWithProviders(
      <OrderTracking
        orderId={ORDER}
        shipments={[
          shipment({
            consignmentIds: [],
            events: [{ status: 'IN_TRANSIT', description: 'On its way to you.', occurredAt: '2026-09-11T09:00:00.000Z' }],
          }),
        ]}
      />,
    );
    expect(screen.getByText('On its way to you.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders nothing for an order with no parcels', () => {
    renderWithProviders(<OrderTracking orderId={ORDER} shipments={[]} />);
    expect(screen.queryByText('Tracking')).not.toBeInTheDocument();
  });
});

describe('the seller’s copy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the milestones, ETA and a masked recipient, and never offers the images', async () => {
    stub({
      [`/seller/consignments/${SHIP}/tracking`]: () =>
        jsonResponse({
          state: {},
          events: [
            { id: 'e1', status: 'DELIVERED', description: 'Your order has been delivered.', occurredAt: '2026-09-12T09:00:00.000Z', source: 'DRIVER_APP' },
          ],
          documents: [],
          delivery: {
            eta: { source: 'FINISHED', at: null, isLate: false },
            proofOfDelivery: {
              ...POD,
              receivedBy: 'Maria K.',
              signature: { captured: true, available: false },
              photo: { captured: true, available: false },
            },
            deliveredWithoutProof: false,
          },
        }),
    });

    renderWithProviders(<SellerConsignmentTracking shipmentId={SHIP} reference="LS-2026-000123" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show tracking' }));

    expect(await screen.findByText('Your order has been delivered.')).toBeInTheDocument();
    expect(screen.getByText('Maria K. (Store manager)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
    expect(screen.getByText(/It belongs to the buyer’s side/)).toBeInTheDocument();
  });
});
