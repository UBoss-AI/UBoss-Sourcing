/**
 * Seller Hub: a listing's market eligibility and change history (JOURNEY-028),
 * copying a listing into a new draft, and change control for verified
 * company details with the buyer-facing preview (JOURNEY-027).
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { ListingHistoryPanel, ListingMarketPanel } from './ListingInsightPanels';
import { PreviewAsBuyerLink, SellerCompanyChangeCard } from './SellerCompanyChangeCard';

const fetchMock = vi.fn();
const OFFER = 'O1'.padEnd(26, '0');

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const calls = (): [string, RequestInit | undefined][] => fetchMock.mock.calls as [string, RequestInit | undefined][];

describe('where a listing can be sold', () => {
  it('lists each country rule with its reason, and the certificate hold', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          status: 'ACTIVE',
          complianceHolds: [{ certificationId: 'C1', standard: 'ISO 13485', heldAt: '2026-10-01T00:00:00.000Z' }],
          rules: [
            {
              countryCode: 'DE', scope: 'PRODUCT', effect: 'BLOCK', reason: 'Not licensed for sale here.',
              requiredDocuments: [], categoryName: '', minOrderValueMinor: null, thresholdCurrency: null,
            },
            {
              countryCode: 'BR', scope: 'CATEGORY', effect: 'DOCUMENTS_REQUIRED', reason: 'Import permit needed.',
              requiredDocuments: ['ANVISA permit'], categoryName: 'Gloves', minOrderValueMinor: null, thresholdCurrency: null,
            },
          ],
          blockedCountries: ['DE'],
          restrictedCountries: ['BR'],
        }),
      ),
    );
    renderWithProviders(<ListingMarketPanel offerId={OFFER} />);
    expect(await screen.findByText('Not licensed for sale here.')).toBeInTheDocument();
    expect(screen.getByText('Import permit needed.')).toBeInTheDocument();
    expect(screen.getByText('The buyer must hold: ANVISA permit')).toBeInTheDocument();
    expect(screen.getByText('Set on the category Gloves')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('ISO 13485');
    expect(calls()[0]?.[0]).toContain(`/seller/listings/${OFFER}/market-eligibility`);
  });

  it('says plainly when nothing restricts it', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ status: 'ACTIVE', complianceHolds: [], rules: [], blockedCountries: [], restrictedCountries: [] })),
    );
    renderWithProviders(<ListingMarketPanel offerId={OFFER} />);
    expect(await screen.findByText('No country rule restricts this product.')).toBeInTheDocument();
  });
});

describe('a listing\'s change history', () => {
  it('asks the activity log for this listing only, and falls back to the action without a summary', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          entries: [
            { id: 'a1', action: 'seller.listing.sourcing_updated', actorLabel: 'Asha', resourceType: 'seller_offer', resourceId: OFFER, summary: null, createdAt: '2026-10-01T10:00:00.000Z' },
            { id: 'a2', action: 'seller.offer.duplicated', actorLabel: 'Asha', resourceType: 'seller_offer', resourceId: OFFER, summary: 'RAY-1 was copied.', createdAt: '2026-10-02T10:00:00.000Z' },
          ],
        }),
      ),
    );
    renderWithProviders(<ListingHistoryPanel offerId={OFFER} />);
    expect(await screen.findByText('RAY-1 was copied.')).toBeInTheDocument();
    expect(screen.getByText('seller.listing.sourcing_updated')).toBeInTheDocument();
    expect(calls()[0]?.[0]).toContain(`resourceId=${OFFER}`);
  });
});

describe('verified company details after approval', () => {
  const details = {
    current: {
      legalName: 'Acme Gloves Private Limited', companyRegistrationNumber: 'U12345', taxRegistrationNumber: null, eoriNumber: null,
      registeredAddressLine1: '1 Test Road', registeredAddressLine2: null, registeredCity: 'Pune', registeredRegion: null,
      registeredPostcode: '411001', registeredCountry: 'IN',
    },
    changeControlled: true,
    pending: null,
    history: [
      {
        id: 'H1', status: 'REJECTED', proposed: { registeredCity: 'Mumbai' }, previous: { registeredCity: 'Pune' }, material: false,
        reverifies: [], note: null, decisionReason: 'The registry shows Pune.', decidedAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-08-30T00:00:00.000Z',
      },
    ],
  };

  it('sends only what changed, says a material change is checked again, and shows past decisions', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'POST'
          ? jsonResponse({ change: { id: 'N1', status: 'PENDING' } }, 201)
          : jsonResponse(details),
      ),
    );
    renderWithProviders(<SellerCompanyChangeCard canManage />);
    expect(await screen.findByText('Reason: The registry shows Pune.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Request a change' }));
    const name = await screen.findByLabelText('Registered name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Acme Medical Private Limited');
    expect(screen.getByText('This changes facts the marketplace verified, so once approved they are checked again.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send for approval' }));

    await waitFor(() => {
      const post = calls().find(([, init]) => init?.method === 'POST');
      expect(post?.[0]).toContain('/seller/company-changes');
      expect(JSON.parse(post?.[1]?.body as string)).toEqual({ legalName: 'Acme Medical Private Limited' });
    });
  });

  it('stays out of the way while the application itself can still be edited', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ ...details, changeControlled: false })));
    const { container } = renderWithProviders(<SellerCompanyChangeCard canManage />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.textContent).not.toContain('Change verified company details');
    });
  });

  it('opens the public supplier page as a buyer sees it, once approved', () => {
    renderWithProviders(<PreviewAsBuyerLink slug="acme-gloves" isTrading />);
    const link = screen.getByRole('link', { name: 'Preview as buyer' });
    expect(link.getAttribute('href')).toBe('/suppliers/acme-gloves');
    expect(link.getAttribute('target')).toBe('_blank');
  });
});
