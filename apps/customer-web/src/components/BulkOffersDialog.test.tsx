/**
 * The bulk-offers dialog: every offer at once, the server's figures verbatim,
 * and only true labels.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import type { BulkOfferCard, BulkPricing } from '@/lib/bulk-pricing';
import { BulkOffersDialog } from './BulkOffersDialog';

const money = (minor: string) => ({ minor, formatted: `₹${(Number(minor) / 100).toFixed(2)}`, currency: 'INR' });

function card(minQuantity: number, unit: string, overrides: Partial<BulkOfferCard> = {}): BulkOfferCard {
  const list = 18_000n;
  const saving = list - BigInt(unit);
  return {
    minQuantity,
    maxQuantity: null,
    unitPrice: money(unit),
    listUnitPrice: money(list.toString()),
    savingPerPiece: money(saving.toString()),
    lineTotal: money((BigInt(unit) * BigInt(minQuantity)).toString()),
    totalSaving: money((saving * BigInt(minQuantity)).toString()),
    savingBasisPoints: Number((saving * 10_000n) / list),
    businessBuyersOnly: false,
    endsAt: null,
    isCurrent: false,
    isNext: false,
    isBestValue: false,
    withinStock: true,
    approximateUnitPrice: null,
    ...overrides,
  };
}

function pricing(overrides: Partial<Extract<BulkPricing, { available: true }>> = {}): Extract<BulkPricing, { available: true }> {
  return {
    available: true,
    offerId: 'o1',
    sellerName: 'Acme Medical',
    currency: 'INR',
    quantity: 4,
    listUnitPrice: money('18000'),
    current: {
      unitPrice: money('18000'),
      lineTotal: money('72000'),
      savingBasisPoints: 0,
      saving: money('0'),
      tierMinQuantity: null,
    },
    next: { minQuantity: 10, addQuantity: 6, unitPrice: money('17500'), savingPerPiece: money('500'), savingBasisPoints: 277 },
    ladder: [],
    preorderBands: [],
    offers: [
      card(10, '17500', { isNext: true }),
      card(100, '16500'),
      card(1_000, '15000', { isBestValue: true, withinStock: false }),
    ],
    preorderOffers: [],
    units: [],
    stockBaseUnits: 500,
    exceedsStock: false,
    preorderAvailable: true,
    approximate: null,
    ...overrides,
  };
}

describe('BulkOffersDialog', () => {
  it('shows every offer together, with the server’s figures', () => {
    renderWithProviders(<BulkOffersDialog isOpen pricing={pricing()} onSelect={vi.fn()} onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog', { name: 'Bulk offers' });
    const cards = within(dialog).getAllByRole('article');
    expect(cards).toHaveLength(3);

    const hundred = within(dialog).getByRole('article', { name: 'Offer from 100 pieces' });
    expect(within(hundred).getByText('₹165.00')).toBeInTheDocument();
    expect(within(hundred).getByText('₹15.00')).toBeInTheDocument(); // saving a piece
    expect(within(hundred).getByText('₹1,500.00')).toBeInTheDocument(); // total saving
    expect(within(hundred).getByText('₹16,500.00')).toBeInTheDocument(); // total for 100

    expect(within(dialog).getByText('Add 6 more to pay ₹175.00 a piece.')).toBeInTheDocument();
  });

  it('labels only what the server marked', () => {
    renderWithProviders(<BulkOffersDialog isOpen pricing={pricing()} onSelect={vi.fn()} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByText('Best value')).toHaveLength(1);
    expect(within(dialog).getAllByText('Next saving')).toHaveLength(1);
    expect(within(dialog).queryByText('Your quantity')).toBeNull();

    const thousand = within(dialog).getByRole('article', { name: 'Offer from 1,000 pieces' });
    expect(within(thousand).getByText('Only 500 in stock. The rest would be a preorder.')).toBeInTheDocument();
  });

  it('selects a band with its own button', () => {
    const onSelect = vi.fn();
    renderWithProviders(<BulkOffersDialog isOpen pricing={pricing()} onSelect={onSelect} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select 1,000' }));
    expect(onSelect).toHaveBeenCalledWith(1_000);
  });

  it('offers no Select where the page does not count in pieces', () => {
    renderWithProviders(<BulkOffersDialog isOpen pricing={pricing()} onSelect={undefined} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^Select/ })).toBeNull();
  });

  it('closes on its Close button', () => {
    const onClose = vi.fn();
    renderWithProviders(<BulkOffersDialog isOpen pricing={pricing()} onSelect={vi.fn()} onClose={onClose} />);
    fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' }).at(-1) as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });
});
