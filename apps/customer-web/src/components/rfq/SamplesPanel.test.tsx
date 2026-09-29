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
  it('says payment is not collected here, and confirms receipt with the version it saw', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(jsonResponse(init?.method === 'POST' ? { sample: sample({ status: 'DELIVERED' }) } : { samples: [sample()] })),
    );
    renderWithProviders(<SamplesPanel party="BUYER" rfqId="r1" filesAvailable={false} />);
    expect(await screen.findByText(/Payment is not collected through the marketplace yet/)).toBeInTheDocument();
    expect(screen.getByText(/DHL · JD01/)).toBeInTheDocument();
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
});
