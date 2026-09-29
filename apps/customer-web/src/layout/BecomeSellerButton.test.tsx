/**
 * The way into the Seller Hub from the header.
 *
 * What is held down here is the destination for each kind of visitor, because
 * getting it wrong sends somebody to a page that is no use to them: a guest to
 * a Seller Hub that bounces them, a half-finished applicant to a marketing
 * page, an approved seller to the application they already finished. And the
 * guest's path has to come back to the seller programme after signing in,
 * rather than dropping them on the home page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders, makeSession, jsonResponse, errorResponse } from '@/test/harness';
import { SellPage } from '@/pages/seller/SellPage';
import type { SellerIdentity, SellerApplicationStatus } from '@/lib/seller';
import { BecomeSellerButton } from './BecomeSellerButton';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function identity(status: SellerApplicationStatus, isTrading = false): SellerIdentity {
  return {
    sellerAccountId: 'seller-1',
    displayName: 'Northwind',
    legalName: 'Northwind Pvt Ltd',
    slug: 'northwind',
    status,
    role: 'OWNER',
    isTrading,
    isApplicationEditable: status === 'DRAFT' || status === 'ACTION_REQUIRED',
    logoUrl: null,
    permissions: [],
    lock: { isSet: true, isOpen: true },
  };
}

/** Answer the two seller reads the button makes, by path. */
function answer(seller: SellerIdentity | null, percentComplete = 40): void {
  fetchMock.mockImplementation((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes('/sellers/me')) return Promise.resolve(jsonResponse({ seller }));
    if (url.includes('/seller/onboarding')) {
      return Promise.resolve(jsonResponse({ percentComplete }));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

const guest = makeSession({ user: null, isCustomer: false });

describe('where the header sends each visitor', () => {
  it('sends a guest to the seller programme, without asking the API anything', () => {
    renderWithProviders(<BecomeSellerButton />, { session: guest });

    expect(screen.getByRole('link', { name: 'Become a seller' })).toHaveAttribute('href', '/sell');
    // A guest cannot have a seller account; a 401 per anonymous page view to
    // learn that would be noise.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a signed-in buyer with no seller account to the seller programme', async () => {
    answer(null);
    renderWithProviders(<BecomeSellerButton />);

    expect(await screen.findByRole('link', { name: 'Become a seller' })).toHaveAttribute(
      'href',
      '/sell',
    );
  });

  it('sends an unfinished applicant back into onboarding, with how far along', async () => {
    answer(identity('DRAFT'), 40);
    renderWithProviders(<BecomeSellerButton />);

    const link = await screen.findByRole('link', { name: 'Continue setup · 40%' });
    expect(link).toHaveAttribute('href', '/seller/onboarding');
  });

  it('sends an application that was sent back to onboarding, flagged', async () => {
    answer(identity('ACTION_REQUIRED'));
    renderWithProviders(<BecomeSellerButton />);

    expect(
      await screen.findByRole('link', { name: 'Application needs changes' }),
    ).toHaveAttribute('href', '/seller/onboarding');
  });

  it('sends an approved, trading seller to the Seller Hub', async () => {
    answer(identity('APPROVED', true));
    renderWithProviders(<BecomeSellerButton />);

    expect(await screen.findByRole('link', { name: 'Seller Hub' })).toHaveAttribute(
      'href',
      '/seller/dashboard',
    );
  });

  it('says nothing while the session is still resolving', () => {
    renderWithProviders(<BecomeSellerButton />, {
      session: makeSession({ isLoading: true }),
    });

    // A "Become a seller" that turns into "Seller Hub" half a second later is
    // a flicker on every page load.
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('the seller programme page, for somebody signed out', () => {
  it('offers sign-in that comes back to the seller programme, not the home page', async () => {
    fetchMock.mockResolvedValue(errorResponse(401, 'UNAUTHENTICATED', 'Sign in'));
    renderWithProviders(<SellPage />, { session: guest, route: '/sell' });

    // The return is what keeps a supplier who signs in part-way from having to
    // find the seller programme a second time.
    expect(await screen.findByRole('link', { name: 'Sign in to apply' })).toHaveAttribute(
      'href',
      '/login?next=/sell',
    );
  });

  it('sends somebody who already sells here straight to their Hub', async () => {
    answer(identity('APPROVED', true));
    renderWithProviders(<SellPage />, { route: '/sell' });

    expect(await screen.findByRole('link', { name: 'Open your Seller Hub' })).toHaveAttribute(
      'href',
      '/seller/dashboard',
    );
  });
});
