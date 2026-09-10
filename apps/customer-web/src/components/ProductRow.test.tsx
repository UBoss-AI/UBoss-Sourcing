/**
 * The catalogue's row layout.
 *
 * Two things here are worth a test and the rest is markup.
 *
 * **The discount arithmetic.** It runs on `BigInt` minor units, and the moment
 * a price in this app touches a float it has a rounding bug it finds out about
 * from a customer. The percentage is also a *claim* on a listing page, so the
 * direction it rounds matters: 33.6% off must read as 33, never 34.
 *
 * **That nothing is invented.** The reference layout this row was built from
 * carries a star rating, a review count, a trust badge, a "Sponsored" flag and
 * a bank offer. This catalogue holds none of those, and a fabricated rating is
 * the most persuasive lie a listing row can tell — so their absence is
 * asserted rather than left to a comment nobody reads.
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProductRow } from './ProductRow';
import { makeProduct } from '@/test/fixtures';
import { renderWithProviders } from '@/test/harness';
import type { Money, Product } from '@/lib/types';

/** A price, in the shape the API sends: minor units as a string. */
function money(minor: string, formatted: string): Money {
  return { minor, formatted, currency: 'INR' };
}

function row(): HTMLElement {
  const element = screen.getByRole('article');
  return element;
}

function render(overrides: Partial<Product> = {}): void {
  renderWithProviders(<ProductRow product={makeProduct(overrides)} />);
}

describe('the catalogue row', () => {
  it('lists the product name as the one link, and the code beside it', () => {
    render({ name: 'Closed IV Cannula', sku: 'EV-CONTROL-WAY', slug: 'closed-iv-cannula' });

    // One anchor, whose accessible name is the product and nothing else. A row
    // wrapped in a link announces the photograph, the specification and the
    // price as one run of link text.
    const link = within(row()).getByRole('link', { name: 'Closed IV Cannula' });
    expect(link).toHaveAttribute('href', '/product/closed-iv-cannula');
    expect(within(row()).getByText('EV-CONTROL-WAY')).toBeInTheDocument();
  });

  it('shows the product own attributes as the specification, at most four', () => {
    render({
      attributes: [
        { name: 'Sterilisation', value: 'Sterile (EO)' },
        { name: 'Latex', value: 'Latex-free' },
        { name: 'System', value: 'Closed' },
        { name: 'Gauge range', value: '18G - 26G' },
        { name: 'Shelf life', value: '3 years' },
      ],
    });

    // The list is the reason this layout exists: a buyer choosing between
    // eleven infusion sets needs the differences, and these are them.
    expect(within(row()).getByText(/Sterile \(EO\)/)).toBeInTheDocument();
    expect(within(row()).getByText(/18G - 26G/)).toBeInTheDocument();

    // The fifth is dropped rather than pushing the row taller than the
    // photograph beside it.
    expect(within(row()).queryByText(/3 years/)).not.toBeInTheDocument();
  });

  it('works out the saving from the minor units, and truncates it', () => {
    // 4500.00 down to 3000.00 is exactly a third off.
    render({
      price: money('300000', '3,000.00'),
      compareAtPrice: money('450000', '4,500.00'),
    });

    // 33, not 34: the arithmetic is (450000 - 300000) * 100 / 450000 = 33.33,
    // and a claim rounds towards the smaller number.
    expect(within(row()).getByText('33% off')).toBeInTheDocument();
    expect(within(row()).getByText('4,500.00', { exact: false })).toBeInTheDocument();
  });

  it('says nothing about a saving when there is not one', () => {
    // A compare-at price at or below the price is data, not an offer — it
    // happens when a reduction is withdrawn without clearing the old figure.
    render({
      price: money('300000', '3,000.00'),
      compareAtPrice: money('300000', '3,000.00'),
    });

    expect(within(row()).queryByText(/% off/)).not.toBeInTheDocument();
  });

  it('names the purchase rules that vary between products', () => {
    render({
      purchaseRules: {
        minOrderQty: 10,
        maxOrderQty: null,
        qtyIncrement: 5,
        isRecurringEligible: true,
      },
    });

    // A minimum of 10 discovered in the cart wastes the customer twice.
    expect(within(row()).getByText('Minimum 10')).toBeInTheDocument();
    expect(within(row()).getByText('In multiples of 5')).toBeInTheDocument();
  });

  it('invents no rating, no review count and no sponsorship', () => {
    render();

    const text = row().textContent;

    // There is no reviews system, no paid placement and no trust programme in
    // this product. Anything here claiming otherwise would be a claim the
    // operator never made.
    expect(text).not.toMatch(/rating|review|sponsored|assured/i);
    expect(within(row()).queryByText(/★|⭐/)).not.toBeInTheDocument();
  });
});
