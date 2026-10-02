/**
 * The product page's ratings (JOURNEY-059): the seller's answer under a
 * review, and the seller's inspection record in a box of its own that never
 * changes the rating.
 */
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { ProductReviews } from './ProductReviews';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import type { StorefrontConfig } from '@/lib/types';

const REVIEWS_ON: StorefrontConfig = {
  ...FALLBACK_CONFIG,
  features: { ...FALLBACK_CONFIG.features, productReviews: true },
};

const fetchMock = vi.fn();

const listResponse = {
  productId: 'P'.repeat(26),
  summary: {
    average: 4.25,
    count: 2,
    categories: { quality: 4.5, delivery: 4, experience: 4.5, support: 4 },
    distribution: [0, 0, 0, 2, 0],
  },
  reviews: [
    {
      id: 'R'.repeat(26),
      reviewerName: 'Priya N.',
      scores: { quality: 5, delivery: 4, experience: 4, support: 4 },
      average: 4.25,
      createdAt: '2026-09-20T10:00:00.000Z',
      editedAt: null,
      response: { sellerName: 'Acme Gloves', body: 'Thank you for the order.', at: '2026-09-21T10:00:00.000Z' },
    },
  ],
  pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(listResponse)));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProductReviews', () => {
  it("shows the seller's answer under the review it belongs to", async () => {
    renderWithProviders(<ProductReviews productId={'P'.repeat(26)} productSlug="gloves" productName="Gloves" />, {
      config: REVIEWS_ON,
    });
    expect(await screen.findByText('Thank you for the order.')).toBeInTheDocument();
    expect(screen.getByText(/Response from Acme Gloves/)).toBeInTheDocument();
  });

  it('shows inspection results in their own box and never moves the rating', async () => {
    renderWithProviders(
      <ProductReviews
        productId={'P'.repeat(26)}
        productSlug="gloves"
        productName="Gloves"
        inspection={{ months: 12, reports: 10, passed: 2, failed: 8 }}
      />,
      { config: REVIEWS_ON },
    );

    const box = await screen.findByTestId('inspection-results');
    expect(within(box).getByText('Inspection results for this seller')).toBeInTheDocument();
    expect(within(box).getByText('2 passed and 8 failed in the last 12 months.')).toBeInTheDocument();
    expect(within(box).getByText(/never averaged into the buyers' ratings/)).toBeInTheDocument();
    // No stars inside the inspection box: it is not a rating.
    expect(within(box).queryByRole('img')).toBeNull();

    // The headline figure is the API's own average (4.25 shows as 4.3),
    // whatever the inspections say.
    expect(await screen.findByText('4.3', { selector: 'p' })).toBeInTheDocument();
  });

  it('draws no inspection box when the seller has no signed inspections', async () => {
    renderWithProviders(
      <ProductReviews productId={'P'.repeat(26)} productSlug="gloves" productName="Gloves" inspection={null} />,
      { config: REVIEWS_ON },
    );
    await screen.findByText('Thank you for the order.');
    expect(screen.queryByTestId('inspection-results')).toBeNull();
  });
});
