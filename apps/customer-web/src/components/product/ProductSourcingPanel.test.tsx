/**
 * The product page's "who sells it and how it reaches you" block (checklist
 * Master row 4): every fact comes from the read, and a fact the read does not
 * hold is not shown.
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProductSourcingPanel } from './ProductSourcingPanel';
import { renderWithProviders } from '@/test/harness';
import type { ProductSourcing } from '@/lib/types';

function sourcing(overrides: Partial<ProductSourcing> = {}): ProductSourcing {
  return {
    seller: {
      slug: 'acme-castings',
      displayName: 'Acme Castings',
      kind: 'MANUFACTURER',
      registrationCountry: 'IN',
      verifiedAt: '2026-03-01T00:00:00.000Z',
    },
    destination: 'DE',
    delivery: { status: 'AVAILABLE', notes: [] },
    handlingTimeDays: 12,
    countryOfOrigin: 'IN',
    inspection: { outlook: 'NOT_REQUIRED', fromValueMinor: null, currency: null },
    ...overrides,
  };
}

describe('ProductSourcingPanel', () => {
  it('names the seller, links to their products, and says since when they are verified', () => {
    renderWithProviders(<ProductSourcingPanel sourcing={sourcing()} />);

    expect(screen.getByRole('region', { name: 'Who sells it and how it reaches you' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Acme Castings' })).toHaveAttribute('href', '/suppliers/acme-castings');
    expect(screen.getByText('Manufacturer · India')).toBeInTheDocument();
    expect(screen.getByText('Verified since March 2026')).toBeInTheDocument();
  });

  it('says the marketplace sells its own stock', () => {
    renderWithProviders(<ProductSourcingPanel sourcing={sourcing({ seller: null, inspection: { outlook: 'NOT_APPLICABLE', fromValueMinor: null, currency: null } })} />);
    expect(screen.getByText(/, from its own stock/)).toBeInTheDocument();
    // No seller to link to; the only link is the explanation of assurance.
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/assurance']);
    // The marketplace's own stock is not gated, so no inspection line at all.
    expect(screen.queryByText('Inspection before dispatch')).not.toBeInTheDocument();
  });

  it.each([
    ['AVAILABLE', 'Can be sold and delivered to Germany.'],
    ['BLOCKED', 'Cannot be sold to Germany.'],
    ['SELLER_DOES_NOT_DELIVER', 'This seller does not sell to Germany.'],
    ['DOCUMENTS_REQUIRED', 'Can be sold to Germany to a buyer holding the documents below.'],
  ] as const)('states delivery %s in words', (status, text) => {
    renderWithProviders(<ProductSourcingPanel sourcing={sourcing({ delivery: { status, notes: [] } })} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('asks for a country rather than guessing one', () => {
    renderWithProviders(
      <ProductSourcingPanel sourcing={sourcing({ destination: null, delivery: { status: 'CHOOSE_DESTINATION', notes: [] } })} />,
    );
    expect(screen.getByText(/Choose your country at the top of the page/)).toBeInTheDocument();
  });

  it('shows the operator’s reason and the documents needed', () => {
    renderWithProviders(
      <ProductSourcingPanel
        sourcing={sourcing({
          delivery: {
            status: 'DOCUMENTS_REQUIRED',
            notes: [{ effect: 'DOCUMENTS_REQUIRED', reason: 'Licensed goods.', requiredDocuments: ['Import permit', 'End-user statement'] }],
          },
        })}
      />,
    );
    expect(screen.getByText('Licensed goods.')).toBeInTheDocument();
    expect(screen.getByText('Documents needed: Import permit, End-user statement')).toBeInTheDocument();
  });

  it('states lead time and origin only when the seller gave them', () => {
    const { unmount } = renderWithProviders(<ProductSourcingPanel sourcing={sourcing()} />);
    expect(screen.getByText('The seller prepares it for dispatch within 12 days.')).toBeInTheDocument();
    expect(screen.getByText('Country of origin: India')).toBeInTheDocument();
    unmount();

    renderWithProviders(<ProductSourcingPanel sourcing={sourcing({ handlingTimeDays: null, countryOfOrigin: null })} />);
    expect(screen.queryByText('Lead time and origin')).not.toBeInTheDocument();
  });

  it('reports inspection as the rules decide it, with the threshold in money', () => {
    const { unmount } = renderWithProviders(
      <ProductSourcingPanel sourcing={sourcing({ inspection: { outlook: 'REQUIRED', fromValueMinor: null, currency: null } })} />,
    );
    expect(screen.getByText(/independent inspection is required before an order/)).toBeInTheDocument();
    unmount();

    renderWithProviders(
      <ProductSourcingPanel
        sourcing={sourcing({ inspection: { outlook: 'REQUIRED_FROM_VALUE', fromValueMinor: '5000000', currency: 'INR' } })}
      />,
    );
    expect(screen.getByText(/on orders of .*50,000\.00 or more/)).toBeInTheDocument();
  });

  it('renders nothing for an older API that sends no sourcing', () => {
    renderWithProviders(<ProductSourcingPanel sourcing={undefined} />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});
