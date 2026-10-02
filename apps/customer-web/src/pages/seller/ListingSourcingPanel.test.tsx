/**
 * Sourcing terms on a Seller Hub listing (JOURNEY-029): a lead-time range the
 * wrong way round cannot be saved, and a save sends exactly the terms shown,
 * with only certificates the marketplace verified on offer.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { ListingSourcingPanel } from './ListingSourcingPanel';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
    Promise.resolve(
      init?.method === 'PUT'
        ? jsonResponse({ terms: null })
        : jsonResponse({
            terms: null,
            incoterms: ['EXW', 'FOB', 'CIF'],
            linkableCertifications: [{ id: '01JCERT000000000000000001', standard: 'ISO 13485', issuer: 'TUV', expiresOn: '2027-06-30' }],
          }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ListingSourcingPanel', () => {
  it('refuses a reversed lead time and saves the terms shown', async () => {
    renderWithProviders(<ListingSourcingPanel offerId="01JOFFER00000000000000001" />);
    fireEvent.click(await screen.findByLabelText('We send samples'));
    fireEvent.change(screen.getByLabelText('Sample terms (quantity, cost, courier)'), { target: { value: 'Two boxes' } });
    fireEvent.change(screen.getByLabelText('Shortest'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Longest'), { target: { value: '20' } });
    const save = screen.getByRole('button', { name: 'Save sourcing terms' });
    expect(screen.getByText('The shortest lead time cannot be longer than the longest.')).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Longest'), { target: { value: '45' } });
    fireEvent.click(screen.getByLabelText('FOB'));
    fireEvent.click(screen.getByLabelText('ISO 13485 · TUV'));
    fireEvent.click(save);
    await waitFor(() => {
      const put = (fetchMock.mock.calls as [string, RequestInit | undefined][]).find(([, init]) => init?.method === 'PUT');
      expect(put?.[0]).toContain('/seller/listings/01JOFFER00000000000000001/sourcing');
      expect(JSON.parse(put?.[1]?.body as string)).toEqual({
        sampleAvailable: true,
        sampleNote: 'Two boxes',
        privateLabelAvailable: false,
        oemAvailable: false,
        leadTimeDaysMin: 30,
        leadTimeDaysMax: 45,
        incoterms: ['FOB'],
        certificationIds: ['01JCERT000000000000000001'],
        capacityUnitsPerWeek: null,
        capacityLeadTimeDays: null,
      });
    });
  });

  it('saves the weekly capacity and refuses a lead time without it (JOURNEY-028)', async () => {
    renderWithProviders(<ListingSourcingPanel offerId="01JOFFER00000000000000001" />);
    fireEvent.change(await screen.findByLabelText('Production lead time (days)'), { target: { value: '14' } });
    const save = screen.getByRole('button', { name: 'Save sourcing terms' });
    expect(screen.getByText('Give the weekly capacity the lead time applies to.')).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Units per week'), { target: { value: '5000' } });
    fireEvent.click(save);
    await waitFor(() => {
      const put = (fetchMock.mock.calls as [string, RequestInit | undefined][]).find(([, init]) => init?.method === 'PUT');
      expect(JSON.parse(put?.[1]?.body as string)).toMatchObject({ capacityUnitsPerWeek: 5000, capacityLeadTimeDays: 14 });
    });
  });
});
