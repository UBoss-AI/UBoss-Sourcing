import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RfqEditPage } from './RfqEditPage';
import { DescribedSourcing } from '@/pages/ai/DescribedSourcing';
import { parseSourcing, rfqHref } from '@/lib/sourcing-parse';
import { jsonResponse, renderWithProviders } from '@/test/harness';

const OPTIONS = {
  unitsOfMeasure: ['PIECE', 'BOX'],
  incoterms: ['EXW', 'CIF'],
  sampleRequirements: ['NONE', 'WITH_QUOTE'],
  inspectionRequirements: ['NONE'],
  maxResponseDays: 90,
  maxInvitedSuppliers: 50,
  attachments: { available: true, reason: null, maxBytes: 10_485_760, maxFiles: 40, types: ['application/pdf'] },
};
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation((url: string) => Promise.resolve(jsonResponse(url.includes('/form-options') ? OPTIONS : { items: [], counts: {} })));
});
afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); });

const TEXT = '5,000 boxes of nitrile gloves, CE, FOB, to Germany within 30 days, under 2.50 EUR each';

describe('plain language to an editable RFQ draft (ENH-001)', () => {
  it('shows what was understood and links to filtered search and an RFQ draft', () => {
    renderWithProviders(<DescribedSourcing text={TEXT} />);
    for (const chip of ['5000 boxes', 'to DE', 'FOB', 'CE', 'within 30 days', 'target 2.50 EUR']) expect(screen.getByText(chip)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Search with these filters' })).toHaveAttribute('href', '/search?q=nitrile+gloves&certified=true&incoterm=FOB&maxLeadTimeDays=30');
  });
  it('opens the draft prefilled, says nothing was sent, and sends nothing by itself', async () => {
    renderWithProviders(<Routes><Route path="/account/rfqs/new" element={<RfqEditPage />} /></Routes>, { route: rfqHref(parseSourcing(TEXT)) });
    expect(await screen.findByText(/Filled in from your description/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Title/)).toHaveValue('nitrile gloves');
    expect(screen.getByLabelText(/^Quantity/)).toHaveValue('5000');
    expect(fetchMock.mock.calls.some((call) => (call[1] as { method?: string } | undefined)?.method === 'POST')).toBe(false);
  });
});
