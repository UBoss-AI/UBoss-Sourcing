import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SellerActionQueue } from './SellerActionQueue';
import { jsonResponse, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); });

describe('seller action queue (ENH-018)', () => {
  it('keeps the server ranking and links each task with its countdown', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tasks: [
      { kind: 'DISPUTE_RESPONSE', id: 'd1', reference: 'DSP-1', dueAt: new Date(Date.now() - 3_600_000).toISOString(), overdue: true, amountMinor: '12345', currency: 'EUR', href: '/seller/disputes/DSP-1' },
      { kind: 'QUOTE', id: 'r1', reference: 'RFQ-9', dueAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), overdue: false, amountMinor: null, currency: null, href: '/seller/rfqs/r1' },
    ] }));
    renderWithProviders(<SellerActionQueue />);
    const links = await screen.findAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Answer dispute DSP-1', 'Quote on request RFQ-9']);
    expect(links[0]).toHaveAttribute('href', '/seller/disputes/DSP-1');
    expect(document.querySelectorAll('[data-countdown="overdue"]')).toHaveLength(1);
  });
  it('says plainly when nothing is waiting', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tasks: [] }));
    renderWithProviders(<SellerActionQueue />);
    expect(await screen.findByText('Nothing is waiting on you.')).toBeInTheDocument();
  });
});
