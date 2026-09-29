/**
 * The negotiation panel (checklist Master row 19).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
