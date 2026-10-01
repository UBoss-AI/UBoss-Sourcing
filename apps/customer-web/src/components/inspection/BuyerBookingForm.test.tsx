import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuyerBookingForm } from './BuyerBookingForm';
import { renderWithProviders } from '@/test/harness';
import { bookBuyerInspection, fetchBuyerAgencyChoices, type InspectionView } from '@/lib/inspection';

vi.mock('@/lib/inspection', async (original) => ({
  ...await original<typeof import('@/lib/inspection')>(),
  fetchBuyerAgencyChoices: vi.fn(),
  bookBuyerInspection: vi.fn(),
}));

const view: InspectionView = {
  requirement: { id: 'R', orderNumber: 'ORD-1', sellerOrderGroupId: 'G', sellerName: 'Acme', level: 'NOT_REQUIRED', status: 'NOT_REQUIRED', reason: null, gate: { allowed: true, sentence: 'May ship.' } },
  jobs: [],
  releases: [],
  timeline: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchBuyerAgencyChoices).mockResolvedValue([
    { id: 'A1', name: 'Independent QA', eligible: true, problems: [] },
    { id: 'A2', name: 'Busy QA', eligible: false, problems: ['CAPACITY_FULL'] },
  ]);
  vi.mocked(bookBuyerInspection).mockResolvedValue({ jobId: 'J', jobNumber: 'INS-9' });
});

describe('the buyer booking form', () => {
  it('loads agencies for the day and country, then books with the buyer paying', async () => {
    renderWithProviders(<BuyerBookingForm orderId="O" view={view} queryKey={['x']} />);
    fireEvent.click(screen.getByRole('button'));

    const form = screen.getByRole('form');
    const inputs = form.querySelectorAll('input');
    const [date, label, address, city, country] = Array.from(inputs);
    fireEvent.change(date as HTMLInputElement, { target: { value: '2099-01-02' } });
    fireEvent.change(label as HTMLInputElement, { target: { value: 'Factory' } });
    fireEvent.change(address as HTMLInputElement, { target: { value: '1 Mill Road' } });
    fireEvent.change(city as HTMLInputElement, { target: { value: 'Pune' } });
    fireEvent.change(country as HTMLInputElement, { target: { value: 'in' } });

    await waitFor(() => { expect(fetchBuyerAgencyChoices).toHaveBeenCalledWith('O', { sellerOrderGroupId: 'G', country: 'IN', scheduledFor: '2099-01-02' }); });
    expect(await screen.findByRole('option', { name: 'Independent QA' })).toBeEnabled();
    expect(screen.getByRole('option', { name: /Busy QA/ })).toBeDisabled();
    // A buyer-requested inspection is paid by the buyer: the seller is not offered.
    const selects = form.querySelectorAll('select');
    const payer = selects[1] as HTMLSelectElement;
    expect(Array.from(payer.options).map((option) => option.value)).toEqual(['BUYER']);
    expect(payer).toBeDisabled();

    fireEvent.change(selects[selects.length - 1] as HTMLSelectElement, { target: { value: 'A1' } });
    fireEvent.submit(form);

    await waitFor(() => { expect(bookBuyerInspection).toHaveBeenCalled(); });
    expect(vi.mocked(bookBuyerInspection).mock.calls[0]?.[1]).toMatchObject({
      sellerOrderGroupId: 'G', agencyId: 'A1', scheduledFor: '2099-01-02', payer: 'BUYER', inspectionPointType: 'SELLER_PREMISES',
      inspectionPoint: { label: 'Factory', addressLine: '1 Mill Road', city: 'Pune', country: 'IN' },
    });
  });
});
