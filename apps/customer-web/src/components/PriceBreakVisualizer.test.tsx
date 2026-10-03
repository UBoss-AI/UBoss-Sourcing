import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PriceBreakVisualizer } from './PriceBreakVisualizer';
import { renderWithProviders } from '@/test/harness';
import { bandFor, breakAt } from '@/lib/price-breaks';
import type { BulkOfferCard } from '@/lib/bulk-pricing';

const money = (minor: string) => ({ minor, formatted: `€${(Number(minor) / 100).toFixed(2)}`, currency: 'EUR' });
const offer = (minQuantity: number, maxQuantity: number | null, minor: string): BulkOfferCard => ({
  minQuantity, maxQuantity, unitPrice: money(minor), listUnitPrice: money('1000'), savingPerPiece: money('0'), lineTotal: money('0'), totalSaving: money('0'),
  savingBasisPoints: 0, businessBuyersOnly: false, endsAt: null, isCurrent: false, isNext: false, isBestValue: false, withinStock: true, approximateUnitPrice: null,
});
const offers = [offer(100, 499, '900'), offer(500, null, '800')];

describe('price-break visualizer (ENH-027)', () => {
  it('picks the band at each boundary and keeps totals exact', () => {
    expect(bandFor(offers, 99)).toBeNull();
    expect(bandFor(offers, 499)?.unitPrice.minor).toBe('900');
    expect(bandFor(offers, 500)?.unitPrice.minor).toBe('800');
    const big = breakAt([offer(1, null, '9007199254740993')], 3, { unitsPerWeek: 2, leadTimeDaysMin: null, leadTimeDaysMax: null });
    expect(big.totalMinor).toBe(27021597764222979n);
    expect(big.productionWeeks).toBe(2);
  });
  it('moves price, total, production weeks and the landed-cost link with the slider', () => {
    renderWithProviders(<PriceBreakVisualizer offers={offers} capacity={{ unitsPerWeek: 100, leadTimeDaysMin: 10, leadTimeDaysMax: 20 }} initialQuantity={100} />);
    expect(screen.getByText('€9.00')).toBeInTheDocument();
    expect(screen.getByText('About 1 weeks at 100 a week')).toBeInTheDocument();
    expect(screen.getByText('10–20 days')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('slider'), { target: { value: '600' } });
    expect(screen.getByText('€8.00')).toBeInTheDocument();
    expect(screen.getByText('About 6 weeks at 100 a week')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Estimate landed cost for this quantity' })).toHaveAttribute('href', '/tools/landed-cost?unitPriceMinor=800&currency=EUR&quantity=600');
  });
  it('says when capacity and lead time are not stated', () => {
    renderWithProviders(<PriceBreakVisualizer offers={offers} capacity={null} initialQuantity={1} />);
    expect(screen.getByText('Capacity not stated')).toBeInTheDocument();
    expect(screen.getByText('Lead time not stated')).toBeInTheDocument();
  });
});
