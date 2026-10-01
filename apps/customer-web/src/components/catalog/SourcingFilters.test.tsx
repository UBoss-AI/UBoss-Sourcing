/**
 * B2B sourcing filters (JOURNEY-002): each control writes the API's own URL
 * parameter, the URL is read back for the request, and every applied filter
 * has a chip that removes exactly its own parameter.
 */
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n/config';
import { renderWithProviders } from '@/test/harness';
import { readSourcingFilters, sourcingChips } from '@/lib/sourcing-filters';
import { SourcingFilterPanel } from './SourcingFilters';

describe('SourcingFilters', () => {
  it('writes each filter as its own URL parameter', () => {
    const setParam = vi.fn();
    renderWithProviders(<SourcingFilterPanel searchParams={new URLSearchParams()} setParam={setParam} />);
    fireEvent.click(screen.getByLabelText(/Samples available/));
    expect(setParam).toHaveBeenLastCalledWith({ sample: 'true' });
    fireEvent.change(screen.getByLabelText('Incoterm'), { target: { value: 'FOB' } });
    expect(setParam).toHaveBeenLastCalledWith({ incoterm: 'FOB' });
    fireEvent.change(screen.getByLabelText('Minimum order'), { target: { value: '100' } });
    expect(setParam).toHaveBeenLastCalledWith({ maxMoq: '100' });
    fireEvent.change(screen.getByLabelText('Bulk lead time'), { target: { value: '30' } });
    expect(setParam).toHaveBeenLastCalledWith({ maxLeadTimeDays: '30' });
  });

  it('reads the URL back for the request and names each applied filter', () => {
    const params = new URLSearchParams('sample=true&incoterm=CIF&maxMoq=50&origin=IN&verifiedSupplier=true&unrelated=x');
    const filters = readSourcingFilters(params);
    expect(filters).toEqual({ sample: 'true', incoterm: 'CIF', maxMoq: '50', origin: 'IN', verifiedSupplier: 'true' });
    const setParam = vi.fn();
    const chips = sourcingChips(i18n.t.bind(i18n) as never, 'en', filters, setParam);
    expect(chips.map((chip) => chip.label)).toEqual(['Verified supplier', 'Samples available', 'Minimum order up to 50', 'CIF', 'Made in India']);
    chips[3]?.remove();
    expect(setParam).toHaveBeenCalledWith({ incoterm: null });
  });
});
