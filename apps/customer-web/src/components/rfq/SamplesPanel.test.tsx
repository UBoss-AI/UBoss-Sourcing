/**
 * Samples on a request (checklist Master row 20).
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SamplesPanel, type Sample } from './SamplesPanel';
import { jsonResponse, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();
const bodyOf = (init: unknown): unknown => {
  const body = (init as RequestInit | undefined)?.body;
  return JSON.parse(typeof body === 'string' ? body : '{}');
};

function sample(overrides: Partial<Sample> = {}): Sample {
  return {
    id: 's1', reference: 'SMP-2026-000007', sellerAccountId: 'a', supplierName: 'Alpha Supplies', status: 'SHIPPED', version: 2,
    quantity: '10', unitOfMeasure: 'BOX', deliveryAddress: 'Lab 2, Pune', requestedByDate: null, approvalCriteria: 'No pinholes',
    notes: null, cost: { minor: '150000', formatted: '1500.00', currency: 'INR' }, paymentStatus: 'PAYMENT_PENDING', supplierNote: null,
    courier: 'DHL', trackingNumber: 'JD01', shippedAt: '2026-10-02T00:00:00.000Z', deliveredAt: null, decisionReason: null,
    referenceCode: null, evidence: [], actions: ['DELIVERED'], createdAt: '2026-10-01T00:00:00.000Z',
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

describe('SamplesPanel', () => {
  it('confirms receipt with the version it saw', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(jsonResponse(init?.method === 'POST' ? { sample: sample({ status: 'DELIVERED' }) } : { samples: [sample()] })),
    );
    renderWithProviders(<SamplesPanel party="BUYER" rfqId="r1" filesAvailable={false} />);
    expect(await screen.findByText(/DHL · JD01/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'It has arrived' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/rfqs/r1/samples/s1/receive'));
      expect(bodyOf(call?.[1])).toEqual({ expectedVersion: 2, reason: null });
    });
  });

  it('asks the supplier for the courier and tracking number to mark it shipped', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ samples: [sample({ status: 'ACCEPTED', actions: ['SHIPPED'], courier: null, trackingNumber: null })] })),
    );
    renderWithProviders(<SamplesPanel party="SUPPLIER" rfqId="r1" filesAvailable={false} />);
    await userEvent.type(await screen.findByLabelText(/Courier/), 'FedEx');
    await userEvent.type(screen.getByLabelText(/Tracking number/), 'FX123');
    await userEvent.click(screen.getByRole('button', { name: 'Mark as shipped' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/seller/rfqs/r1/samples/s1/ship'));
      expect(bodyOf(call?.[1])).toEqual({ expectedVersion: 2, courier: 'FedEx', trackingNumber: 'FX123' });
    });
  });

  it('sends the paid checkout for a charged sample and opens its order to pay', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      Promise.resolve(
        jsonResponse(
          init?.method === 'POST' && url.includes('/checkout')
            ? { orderId: 'o1', sample: sample({ status: 'ACCEPTED', orderId: 'o1' }) }
            : { samples: [sample({ status: 'ACCEPTED', actions: ['CANCELLED'], courier: null, trackingNumber: null })] },
        ),
      ),
    );
    renderWithProviders(<SamplesPanel party="BUYER" rfqId="r1" filesAvailable={false} />);
    await userEvent.click(await screen.findByRole('button', { name: /pay/i }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rfqs/r1/samples/s1/checkout'))).toBe(true);
    });
  });

  it('offers no payment for a free sample, and sends the supplier shipping charge with the cost', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(jsonResponse(init?.method === 'POST' ? { sample: sample({ status: 'ACCEPTED' }) } : { samples: [sample({ status: 'REQUESTED', actions: ['ACCEPTED', 'DECLINED'], cost: null, paymentStatus: 'NOT_REQUIRED', courier: null, trackingNumber: null, version: 0 })] })),
    );
    renderWithProviders(<SamplesPanel party="SUPPLIER" rfqId="r1" filesAvailable={false} />);
    const inputs = await screen.findAllByRole('textbox');
    // Reason, cost, shipping - in that order.
    await userEvent.type(inputs[1] as HTMLElement, '15');
    await userEvent.type(inputs[2] as HTMLElement, '2.5');
    expect(screen.queryByRole('button', { name: /^pay/i })).not.toBeInTheDocument();
    const accept = screen.getAllByRole('button').find((button) => /accept/i.test(button.textContent));
    if (accept === undefined) throw new Error('no accept button');
    await userEvent.click(accept);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/seller/rfqs/r1/samples/s1/accept'));
      expect(bodyOf(call?.[1])).toMatchObject({ expectedVersion: 0, costMinor: '1500', shippingMinor: '250' });
    });
  });
});
