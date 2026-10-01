/**
 * The seller's quote form (JOURNEY-016): the export documents ticked are sent
 * with the quote, in the server's order and without duplicates.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_REQUIREMENT, type RfqRequirement } from '@/lib/rfq';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { QuoteForm } from './QuoteForm';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ quote: { id: 'q1' } }, 201)));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const REQUIREMENT = { ...EMPTY_REQUIREMENT, title: 'Gloves', quantity: '12000', targetCurrency: 'INR', incoterm: 'CIF' } as unknown as RfqRequirement;

describe('QuoteForm export documents', () => {
  it('sends the export documents ticked, in the server order', async () => {
    renderWithProviders(<QuoteForm rfqId="r1" requirement={REQUIREMENT} filesAvailable={false} />);
    fireEvent.change(screen.getByLabelText(/^Unit price/), { target: { value: '850' } });
    fireEvent.change(screen.getByLabelText(/Valid until \(UTC\)/), { target: { value: '2099-01-01T12:00' } });
    fireEvent.click(screen.getByLabelText('Packing list'));
    fireEvent.click(screen.getByLabelText('Commercial invoice'));
    fireEvent.click(screen.getByRole('button', { name: 'Send the quote' }));
    await waitFor(() => {
      const post = (fetchMock.mock.calls as [string, RequestInit | undefined][]).find(([, init]) => init?.method === 'POST');
      expect(post).toBeDefined();
      expect(JSON.parse(post?.[1]?.body as string)).toMatchObject({ exportDocuments: ['COMMERCIAL_INVOICE', 'PACKING_LIST'] });
    });
  });
});
