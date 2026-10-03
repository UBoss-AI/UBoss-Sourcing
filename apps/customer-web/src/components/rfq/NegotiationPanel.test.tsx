/**
 * The negotiation panel (checklist Master row 19).
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { NegotiationPanel } from './NegotiationPanel';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import type { OfferVersion, Quote } from '@/lib/rfq-quote';

const fetchMock = vi.fn();
const bodyOf = (init: unknown): unknown => {
  const body = (init as RequestInit | undefined)?.body;
  return JSON.parse(typeof body === 'string' ? body : '{}');
};
const HASH = 'a'.repeat(64);

function version(overrides: Partial<OfferVersion> = {}): OfferVersion {
  return {
    id: 'v1',
    versionNumber: 1,
    author: 'SUPPLIER',
    state: 'PROPOSED',
    isExpired: false,
    termsHash: HASH,
    terms: {
      quoteId: 'q1', versionNumber: 1, author: 'SUPPLIER', currency: 'INR', unitPriceMinor: '90000', quantity: '12000',
      moq: null, leadTimeDays: 30, capacityPerMonth: null, incoterm: 'CIF', incotermPlace: null, paymentTerms: null,
      inspectionTerms: null, warranty: null, toolingMinor: null, sampleCostMinor: null, shippingEstimateMinor: null,
      taxesDisclosure: null, tiers: [], expiresAt: '2030-11-01T00:00:00.000Z',
    },
    unitPrice: { minor: '90000', formatted: '900.00', currency: 'INR' },
    tooling: null,
    sampleCost: null,
    shippingEstimate: null,
    comment: null,
    responseNote: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    respondedAt: null,
    ...overrides,
  };
}

function quote(current: OfferVersion, overrides: Partial<Quote> = {}): Quote {
  return {
    id: 'q1', rfqId: 'r1', sellerAccountId: 's1', status: 'OPEN', currency: 'INR', shortlisted: false,
    basedOnRequirementVersion: 1, currentVersionNumber: current.versionNumber, current, versions: [current],
    acceptedVersionId: null, acceptedTermsHash: null, acceptedAt: null, closedReason: null, createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ quote: {} })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NegotiationPanel', () => {
  it('lets the buyer accept the supplier’s offer only after confirming, naming its hash', async () => {
    renderWithProviders(<NegotiationPanel quote={quote(version())} party="BUYER" basePath="/rfqs/r1/quotes/q1" queryKey={['x']} />);
    await userEvent.click(screen.getByRole('button', { name: 'Accept these terms' }));
    const dialog = await screen.findByRole('dialog');
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Accept these terms' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/rfqs/r1/quotes/q1/accept'));
      expect(bodyOf(call?.[1])).toEqual({ versionId: 'v1', termsHash: HASH });
    });
  });

  it('offers no accept on your own offer or an expired one, but always a counter-offer while open', () => {
    const { unmount } = renderWithProviders(
      <NegotiationPanel quote={quote(version())} party="SUPPLIER" basePath="/seller/rfqs/r1/quote" queryKey={['x']} />,
    );
    expect(screen.queryByRole('button', { name: 'Accept these terms' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw the quote' })).toBeInTheDocument();
    unmount();
    renderWithProviders(<NegotiationPanel quote={quote(version({ isExpired: true }))} party="BUYER" basePath="/rfqs/r1/quotes/q1" queryKey={['x']} />);
    expect(screen.queryByRole('button', { name: 'Accept these terms' })).not.toBeInTheDocument();
    expect(screen.getByText(/This offer has expired/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send the counter-offer' })).toBeInTheDocument();
  });

  it('sends a counter-offer naming the version it answers, and shows locked terms once accepted', async () => {
    const { unmount } = renderWithProviders(<NegotiationPanel quote={quote(version())} party="BUYER" basePath="/rfqs/r1/quotes/q1" queryKey={['x']} />);
    const price = screen.getByLabelText('Unit price (INR)');
    await userEvent.clear(price);
    await userEvent.type(price, '860');
    await userEvent.type(screen.getByLabelText('Valid until (UTC)'), '2030-12-01T10:00');
    await userEvent.click(screen.getByRole('button', { name: 'Send the counter-offer' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/rfqs/r1/quotes/q1/offers'));
      expect(bodyOf(call?.[1])).toMatchObject({ expectedVersionNumber: 1, unitPriceMinor: '86000' });
    });
    unmount();
    renderWithProviders(
      <NegotiationPanel
        quote={quote(version({ state: 'ACCEPTED' }), { status: 'ACCEPTED', acceptedTermsHash: HASH, acceptedAt: '2026-10-05T00:00:00.000Z' })}
        party="BUYER"
        basePath="/rfqs/r1/quotes/q1"
        queryKey={['x']}
      />,
    );
    expect(screen.getByText('Agreed terms')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(HASH))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send the counter-offer' })).not.toBeInTheDocument();
  });
});

describe('final term sheet before acceptance', () => {
  it('shows every clause, exact large money and previous values before any acceptance request', async () => {
    const earlier = version({ state: 'SUPERSEDED' });
    const latest = version({ id: 'v3', versionNumber: 3, termsHash: 'b'.repeat(64), terms: {
      ...earlier.terms, versionNumber: 3, unitPriceMinor: '900719925474099399', moq: '200', leadTimeDays: 45,
      capacityPerMonth: '50000', incotermPlace: 'Mumbai port', paymentTerms: '30 days', inspectionTerms: 'Independent report',
      warranty: '12 months', toolingMinor: '12345', sampleCostMinor: '0', shippingEstimateMinor: '67890',
      taxesDisclosure: 'Import duties excluded', tiers: [{ minQuantity: '25000', unitPriceMinor: '80000' }],
      exportDocuments: ['CERTIFICATE_OF_ORIGIN', 'COMMERCIAL_INVOICE'],
    } });
    renderWithProviders(<NegotiationPanel quote={quote(latest, { versions: [latest, earlier] })} party="BUYER" basePath="/rfqs/r1/quotes/q1" queryKey={['sheet']} />);
    await userEvent.click(screen.getByRole('button', { name: 'Accept these terms' }));
    const dialog = await screen.findByRole('dialog');
    const sheet = within(dialog).getByRole('region', { name: 'Final term sheet' });
    expect(sheet.querySelectorAll('[data-term]')).toHaveLength(18);
    expect(sheet).toHaveTextContent('9,007,199,254,740,993.99');
    for (const value of ['Mumbai port', '30 days', 'Independent report', '12 months', 'Import duties excluded', 'Certificate of origin', 'Commercial invoice']) expect(sheet).toHaveTextContent(value);
    expect(within(sheet).getAllByText('Changed')).toHaveLength(14);
    expect(sheet.querySelector('[data-term="quantity"]')).not.toHaveTextContent('Changed');
    expect(sheet.querySelector('[data-term="unitPriceMinor"]')).toHaveTextContent('Previous:');
    expect(sheet).toHaveTextContent('b'.repeat(64));
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Accept these terms' }));
    await waitFor(() => { expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ versionId: 'v3', termsHash: 'b'.repeat(64) }); });
  });

  it('does not invent changed clauses for a first offer or accept on opening its sheet', async () => {
    renderWithProviders(<NegotiationPanel quote={quote(version())} party="BUYER" basePath="/rfqs/r1/quotes/q1" queryKey={['first']} />);
    await userEvent.click(screen.getByRole('button', { name: 'Accept these terms' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('First offer; there are no earlier clauses to compare.')).toBeInTheDocument();
    expect(within(dialog).queryByText('Changed')).not.toBeInTheDocument();
    expect(within(dialog).getAllByText('Not provided').length).toBeGreaterThan(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the shown snapshot and refuses a refreshed version instead of accepting unseen terms', async () => {
    let refresh: (value: Quote) => void = () => { throw new Error('Harness not mounted'); };
    function RefreshHarness(): React.JSX.Element {
      const [currentQuote, setCurrentQuote] = useState(quote(version()));
      refresh = setCurrentQuote;
      return <NegotiationPanel quote={currentQuote} party="BUYER" basePath="/rfqs/r1/quotes/q1" queryKey={['refresh']} />;
    }
    renderWithProviders(<RefreshHarness />);
    await userEvent.click(screen.getByRole('button', { name: 'Accept these terms' }));
    const next = version({ id: 'v2', versionNumber: 2, termsHash: 'c'.repeat(64), terms: { ...version().terms, unitPriceMinor: '75000' } });
    act(() => { refresh(quote(next)); });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('region', { name: 'Final term sheet' })).toHaveTextContent(HASH);
    expect(within(dialog).getByRole('region', { name: 'Final term sheet' })).not.toHaveTextContent('c'.repeat(64));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Accept these terms' }));
    expect(await screen.findByText('The offer changed while you were reading. Review the latest terms before accepting.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a buyer counter-offer to its supplier and treats absent export-document lists as empty', async () => {
    const earlier = version({ state: 'SUPERSEDED', terms: { ...version().terms, exportDocuments: [] } });
    const latest = version({ id: 'v2', versionNumber: 2, author: 'BUYER', terms: { ...version().terms, versionNumber: 2, author: 'BUYER' } });
    renderWithProviders(<NegotiationPanel quote={quote(latest, { versions: [earlier, latest] })} party="SUPPLIER" basePath="/seller/rfqs/r1/quote" queryKey={['supplier']} />);
    await userEvent.click(screen.getByRole('button', { name: 'Accept these terms' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText('Changed')).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Accept these terms' }));
    await waitFor(() => { expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/seller/rfqs/r1/quote/accept'); });
  });
});
