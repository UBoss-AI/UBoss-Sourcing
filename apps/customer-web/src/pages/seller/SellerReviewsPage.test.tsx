/**
 * Seller Hub -> Reviews (JOURNEY-059): the service score, answering a review,
 * and an answer staff hid shown as hidden with its reason.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { SellerReviewsPage } from './SellerReviewsPage';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import type { StorefrontConfig } from '@/lib/types';

const REVIEWS_ON: StorefrontConfig = {
  ...FALLBACK_CONFIG,
  features: { ...FALLBACK_CONFIG.features, productReviews: true },
};

const REVIEW_ID = 'R'.repeat(26);
const fetchMock = vi.fn();

function review(response: unknown): unknown {
  return {
    id: REVIEW_ID,
    product: { name: 'Nitrile gloves', slug: 'nitrile-gloves' },
    reviewerName: 'Priya N.',
    scores: { quality: 5, delivery: 4, experience: 4, support: 3 },
    average: 4,
    status: 'PUBLISHED',
    createdAt: '2026-09-20T10:00:00.000Z',
    response,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SellerReviewsPage', () => {
  it('shows the service score and publishes an answer', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return Promise.resolve(
          jsonResponse({ response: { body: 'Thanks!', status: 'PUBLISHED', at: '2026-10-01T10:00:00.000Z', hiddenReason: null } }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          reviews: [review(null)],
          score: { average: 3.5, delivery: 4, support: 3, count: 1 },
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
        }),
      );
    });

    renderWithProviders(<SellerReviewsPage />, { config: REVIEWS_ON, route: '/seller/reviews' });

    expect(await screen.findByText('From 1 published reviews')).toBeInTheDocument();
    expect(screen.getByText('3.5')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Answer this review' }));
    await user.type(screen.getByRole('textbox'), 'Thanks!');
    expect(screen.getByText('7 of 1,000 characters')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Publish answer' }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'PUT');
      expect(put).toBeDefined();
      expect(String(put?.[0])).toContain(`/seller/product-reviews/${REVIEW_ID}/response`);
      expect(JSON.parse((put?.[1] as RequestInit).body as string)).toEqual({ body: 'Thanks!' });
    });
  });

  it('marks an answer staff hid, with the reason', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          reviews: [review({ body: 'Call me on 0123', status: 'HIDDEN', at: '2026-10-01T10:00:00.000Z', hiddenReason: 'Contact details' })],
          score: null,
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
        }),
      ),
    );
    renderWithProviders(<SellerReviewsPage />, { config: REVIEWS_ON, route: '/seller/reviews' });
    expect(await screen.findByText('Hidden by the marketplace')).toBeInTheDocument();
    expect(screen.getByText('Reason: Contact details')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit your answer' })).toBeInTheDocument();
  });
});
