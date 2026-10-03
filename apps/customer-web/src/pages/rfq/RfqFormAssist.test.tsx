import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RfqFormAssist } from './RfqFormAssist';
import { EMPTY_REQUIREMENT } from '@/lib/rfq';
import { jsonResponse, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); });

describe('RFQ form assist (ENH-032)', () => {
  it('explains hard fields and offers values from the last submitted request only on confirmation', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(url.includes('/rfqs/r-old')
      ? jsonResponse({ rfq: { id: 'r-old', reference: 'RFQ-7', requirement: { ...EMPTY_REQUIREMENT, destinationCountry: 'DE', incoterm: 'FOB', unitOfMeasure: 'box' } } })
      : jsonResponse({ items: [{ id: 'r-draft', submittedAt: null }, { id: 'r-old', submittedAt: '2026-09-01T00:00:00Z' }], counts: {} })));
    const onApply = vi.fn();
    renderWithProviders(<RfqFormAssist draft={{ ...EMPTY_REQUIREMENT, incoterm: 'CIF' }} onApply={onApply} />);
    expect(screen.getByText('Incoterm', { selector: 'dt' })).toBeInTheDocument();
    expect(await screen.findByText('From RFQ-7. Nothing is filled in until you press Use this.')).toBeInTheDocument();
    expect(screen.getByText('DE')).toBeInTheDocument();
    expect(screen.queryByText('FOB')).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Use this' })[0]!);
    expect(onApply).toHaveBeenCalledWith('destinationCountry', 'DE');
  });
  it('says so when there is nothing to suggest', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], counts: {} }));
    renderWithProviders(<RfqFormAssist draft={EMPTY_REQUIREMENT} onApply={vi.fn()} />);
    expect(await screen.findByText(/No suggestions/)).toBeInTheDocument();
  });
});
