/**
 * Home quick start (checklist JOURNEY-001): buyer and supplier calls to action
 * are separate, the quotation link follows the RFQ switch, and the recent
 * activity module appears only with something in it and can be hidden.
 */
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { renderWithProviders } from '@/test/harness';
import { HomeQuickStart } from './HomeQuickStart';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('HomeQuickStart', () => {
  it('shows the buyer and supplier paths as separate cards', () => {
    renderWithProviders(<HomeQuickStart />, { route: '/' });
    expect(screen.getByRole('heading', { name: 'Buying' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Selling' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /^Sell on / }).getAttribute('href')).toBe('/sell');
    expect(screen.getByRole('link', { name: 'Track your orders' }).getAttribute('href')).toBe('/account/orders');
    expect(screen.queryByRole('heading', { name: 'Continue where you left off' })).toBeNull();
  });

  it('offers quotations only when requests for quotation are on', () => {
    renderWithProviders(<HomeQuickStart />, { config: { ...FALLBACK_CONFIG, features: { ...FALLBACK_CONFIG.features, rfq: true } } });
    expect(screen.getByRole('link', { name: 'Request quotes' }).getAttribute('href')).toBe('/account/rfqs/new');
  });

  it('lists recent activity and remembers when it is hidden', () => {
    window.localStorage.setItem(
      'recently-viewed.v1',
      JSON.stringify([{ kind: 'product', slug: 'nitrile-gloves', name: 'Nitrile gloves', viewedAt: new Date().toISOString() }]),
    );
    const first = renderWithProviders(<HomeQuickStart />);
    expect(screen.getByRole('link', { name: 'Nitrile gloves' }).getAttribute('href')).toBe('/product/nitrile-gloves');
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByRole('link', { name: 'Nitrile gloves' })).toBeNull();
    first.unmount();
    renderWithProviders(<HomeQuickStart />);
    expect(screen.queryByRole('link', { name: 'Nitrile gloves' })).toBeNull();
  });
});
