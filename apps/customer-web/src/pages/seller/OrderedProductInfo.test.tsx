/**
 * "Ordered product information" on a seller's order line.
 *
 *   - It shows what was ordered, read only: no field on it can change anything.
 *   - The live listing is a separate, named link.
 *   - An older order says it is showing today's listing.
 *   - The four tabs are a keyboard tablist.
 */
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/harness';
import type { OrderedProductInfo as Info } from '@/lib/seller';
import { OrderedProductInfo } from './OrderedProductInfo';

const INFO: Info = {
  schemaVersion: 1,
  capturedAt: '2026-10-03T09:00:00.000Z',
  productId: '01PRODUCT00000000000000000',
  productName: 'Stainless Steel Bottle',
  sku: 'OIS-BTL',
  variantId: '01VARIANT00000000000000000',
  variantName: '1 litre',
  selectedOptions: [{ name: 'Capacity', value: '1 litre' }],
  description: { text: null, html: null, sections: [{ heading: 'Overview', body: 'Double-walled.' }] },
  specificationGroups: [{ group: 'TECHNICAL', rows: [{ label: 'Capacity', value: '1000', unit: 'ml', highlight: true }] }],
  packaging: {
    orderingUnit: 'CARTON',
    unitQuantity: 2,
    piecesPerUnit: 24,
    equivalentPieces: 48,
    packageType: null,
    unitsPerCarton: 24,
    cartonsPerPallet: null,
    cartonsPerContainer: null,
    dimensionsMm: null,
    grossWeightGrams: null,
  },
  moqPieces: 24,
  piecesPerCarton: 24,
  containerCapacity: { CONTAINER_20_FT: null, CONTAINER_40_FT: null },
  specialInstructions: 'Laser-engrave our logo on the lid',
};

function renderInfo(source: 'SNAPSHOT' | 'CURRENT_LISTING' | 'UNAVAILABLE' = 'SNAPSHOT', info: Info | null = INFO) {
  renderWithProviders(<OrderedProductInfo source={source} info={info} listingPath="/seller/listings/OFFER" sellerSku="ACME-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Ordered product information' }));
}

describe('ordered product information', () => {
  it('is collapsed until opened, and says so', () => {
    renderWithProviders(<OrderedProductInfo source="SNAPSHOT" info={INFO} listingPath="/x" sellerSku="A" />);
    expect(screen.getByRole('button', { name: 'Ordered product information' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows what was ordered, read only, and links to the live listing separately', () => {
    renderInfo();
    expect(screen.getByText('Stainless Steel Bottle')).toBeInTheDocument();
    expect(screen.getByText(/SKU OIS-BTL · Your code ACME-1/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View current listing' })).toHaveAttribute('href', '/seller/listings/OFFER');
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.queryByText(/Historical product snapshot/)).toBeNull();
  });

  it('moves between the four tabs with the arrow keys', () => {
    renderInfo();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Description', 'Specifications', 'Packaging', 'Order selections']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Specifications' })).toHaveAttribute('aria-selected', 'true');
    expect(within(screen.getByRole('tabpanel')).getByText('1000 ml')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Specifications' }), { key: 'End' });
    const selections = within(screen.getByRole('tabpanel'));
    expect(selections.getByText('Laser-engrave our logo on the lid')).toBeInTheDocument();
    // The option, and the choice that made it.
    expect(selections.getAllByText('1 litre', { selector: 'dd' })).toHaveLength(2);
  });

  it('shows the packaging the order was placed in', () => {
    renderInfo();
    fireEvent.click(screen.getByRole('tab', { name: 'Packaging' }));
    const panel = within(screen.getByRole('tabpanel'));
    expect(panel.getByText('Equivalent pieces').nextSibling?.textContent).toBe('48');
    expect(panel.getByText('Minimum order (pieces)').nextSibling?.textContent).toBe('24');
    // A figure the order does not hold is left out, not shown as zero.
    expect(panel.queryByText('Pieces per 40-ft container')).toBeNull();
  });

  it('says plainly when it is showing today’s listing for an older order', () => {
    renderInfo('CURRENT_LISTING');
    expect(
      screen.getByText('Historical product snapshot was not available. Showing the current listing information.'),
    ).toBeInTheDocument();
  });

  it('says when there is nothing to show, rather than inventing it', () => {
    renderInfo('UNAVAILABLE', null);
    expect(screen.getByText('The product information for this line is not available.')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('shows the customer their purchase without the seller’s code or listing', () => {
    renderWithProviders(<OrderedProductInfo source="SNAPSHOT" info={INFO} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ordered product information' }));
    expect(screen.getByText('SKU OIS-BTL', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(/Your code/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'View current listing' })).toBeNull();
  });
});
