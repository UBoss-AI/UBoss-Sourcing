/**
 * The quote comparison (checklist Master row 18).
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { RfqComparePage } from './RfqComparePage';
import { jsonResponse, makeLocale, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();
const inr = (minor: string) => ({ minor, formatted: `${minor.slice(0, -2)}.${minor.slice(-2)}`, currency: 'INR' });
const eur = (minor: string) => ({ minor, formatted: `${minor.slice(0, -2)}.${minor.slice(-2)}`, currency: 'EUR' });

function row(overrides: Record<string, unknown>) {
  return {
    quoteId: 'q1',
    supplier: { sellerAccountId: 's1', displayName: 'Alpha Supplies', registrationCountry: 'IN', verifiedAt: '2026-01-01T00:00:00.000Z', verified: true },
    status: 'OPEN',
    shortlisted: false,
    versionNumber: 1,
    author: 'SUPPLIER',
    basedOnRequirementVersion: 1,
    onCurrentRequirement: true,
    expiresAt: '2026-11-01T00:00:00.000Z',
    isExpired: false,
    quantity: '12000',
    quoted: { currency: 'INR', unitPrice: inr('90000'), applicableUnitPrice: inr('85000'), total: inr('1020000000'), tooling: null, sampleCost: null, shippingEstimate: null },
    converted: null,
    conversionUnavailable: false,
    moq: null,
    leadTimeDays: 30,
    capacityPerMonth: null,
    incoterm: 'CIF',
    incotermPlace: null,
    paymentTerms: null,
    inspectionTerms: null,
    warranty: null,
    taxesDisclosure: null,
    tiers: [],
    ...overrides,
  };
}

const COMPARISON = {
  rfqId: 'r1',
  reference: 'RFQ-2026-000042',
  currency: 'INR',
  unitOfMeasure: 'BOX',
  currentRequirementVersion: 1,
  rows: [
    row({}),
    row({
      quoteId: 'q2',
      supplier: { sellerAccountId: 's2', displayName: 'Beta Supplies', registrationCountry: 'DE', verifiedAt: null, verified: true },
      quoted: { currency: 'EUR', unitPrice: eur('950'), applicableUnitPrice: eur('950'), total: eur('11400000'), tooling: eur('50000'), sampleCost: null, shippingEstimate: null },
      converted: {
        unitPrice: inr('85500'),
        applicableUnitPrice: inr('85500'),
        total: inr('1026000000'),
        tooling: inr('4500000'),
        sampleCost: null,
        shippingEstimate: null,
        conversion: { currency: 'INR', rate: '90.00000000', rateAsOf: '2026-09-28T14:00:00.000Z', provider: 'ecb', snapshotId: 'x' },
      },
    }),
  ],
};

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RfqComparePage', () => {
  it('shows every figure as quoted, the converted one beside it with the rate and its source, and missing as not provided', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ comparison: COMPARISON })));
    renderWithProviders(
      <Routes>
        <Route path="/account/rfqs/:id/compare" element={<RfqComparePage />} />
      </Routes>,
      {
        route: '/account/rfqs/r1/compare',
        locale: makeLocale({ currency: 'INR', currencies: [{ code: 'INR', name: 'Rupee', symbol: '₹', exponent: 2, isBase: true }, { code: 'EUR', name: 'Euro', symbol: '€', exponent: 2, isBase: false }] }),
      },
    );
    const table = await screen.findByRole('table', { name: /Quotes side by side/ });
    expect(table).toHaveTextContent('Alpha Supplies');
    expect(table).toHaveTextContent('Beta Supplies');
    expect(screen.getAllByText(/\(converted\)/).length).toBeGreaterThan(0);
    expect(screen.getByRole('note')).toHaveTextContent(/1 EUR = 90\.00000000 INR, published by ecb/);
    expect(screen.getAllByText('Not provided').length).toBeGreaterThan(5);
    expect(screen.getByRole('link', { name: 'Download as CSV' })).toHaveAttribute('href', expect.stringContaining('/rfqs/r1/comparison.csv?sort=total&currency=INR'));
    // JOURNEY-017: the same rows as a PDF, and the terms each supplier left out.
    expect(screen.getByRole('link', { name: 'Download PDF' })).toHaveAttribute('href', expect.stringContaining('/rfqs/r1/comparison.pdf?sort=total&currency=INR'));
    expect(table).toHaveTextContent('Landed estimate (total + tooling + shipping)');

    await userEvent.click(screen.getAllByRole('button', { name: 'Shortlist' })[1] as HTMLElement);
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/quotes/q2/shortlist') && (init as RequestInit).method === 'PUT')).toBe(true);
    });
  });

  it('shows the landed estimate, the export documents and what each supplier did not give (JOURNEY-016/017)', async () => {
    const one = row({
      quoted: { currency: 'INR', unitPrice: inr('90000'), applicableUnitPrice: inr('85000'), total: inr('1020000000'), tooling: inr('1000000'), sampleCost: null, shippingEstimate: inr('500000'), landedEstimate: inr('1021500000') },
      exportDocuments: ['COMMERCIAL_INVOICE', 'PACKING_LIST'],
      missing: ['warranty', 'paymentTerms'],
    });
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ comparison: { ...COMPARISON, rows: [one] } })));
    renderWithProviders(
      <Routes>
        <Route path="/account/rfqs/:id/compare" element={<RfqComparePage />} />
      </Routes>,
      { route: '/account/rfqs/r1/compare' },
    );
    const table = await screen.findByRole('table', { name: /Quotes side by side/ });
    expect(table).toHaveTextContent('Commercial invoice, Packing list');
    expect(table).toHaveTextContent('warranty, payment terms');
  });
});
