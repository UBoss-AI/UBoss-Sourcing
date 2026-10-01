/**
 * Storefront banners and category blocks (Master row 72): asked for with the
 * shopper's country and language, shown as the server sends them (coupon
 * code included only when sent), and absent when there are none or the read
 * fails.
 */
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CategoryContentBlocks, HomeBanners } from './ContentBlocks';
import { errorResponse, jsonResponse, makeLocale, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HomeBanners', () => {
  it('asks for the shopper country and language and shows each banner with its coupon code', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        blocks: [
          { id: 'b1', title: 'Monsoon sale', body: 'Gloves for less.', imageUrl: null, linkUrl: '/catalog?category=gloves', couponCode: 'RAIN10' },
          { id: 'b2', title: 'Partner offer', body: null, imageUrl: null, linkUrl: 'https://partner.example/offer', couponCode: null },
        ],
      }),
    );
    renderWithProviders(<HomeBanners />, { locale: makeLocale({ country: 'de' }) });

    expect(await screen.findByRole('heading', { name: 'Monsoon sale' })).toBeInTheDocument();
    expect(screen.getByText('RAIN10')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Partner offer' })).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveAttribute('href', '/catalog?category=gloves');
    expect(links[1]).toHaveAttribute('rel', 'noopener noreferrer');

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/catalog/content-blocks');
    expect(url).toContain('placement=HOME_BANNER');
    expect(url).toContain('country=DE');
    expect(url).toMatch(/language=[a-z]{2}/);
  });

  it('renders nothing when the read fails', async () => {
    fetchMock.mockResolvedValue(errorResponse(503, 'SERVICE_UNAVAILABLE', 'Down.'));
    const { container } = renderWithProviders(<HomeBanners />, { locale: makeLocale({ country: 'IN' }) });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(container.querySelector('section')).toBeNull();
  });
});

describe('CategoryContentBlocks', () => {
  it('asks for that category only', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ blocks: [{ id: 'c1', title: 'Glove sizing guide', body: 'Measure your palm.', imageUrl: null, linkUrl: null, couponCode: null }] }),
    );
    renderWithProviders(<CategoryContentBlocks slug="gloves" />, { locale: makeLocale({ country: 'IN' }) });
    expect(await screen.findByRole('heading', { name: 'Glove sizing guide' })).toBeInTheDocument();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('placement=CATEGORY_BLOCK');
    expect(url).toContain('category=gloves');
  });
});
