/**
 * The two ways to spend a basket.
 *
 * What is asserted is what a customer would notice if it broke: both tabs are
 * there, the one you are on says so to a screen reader as well as visually,
 * the other one leads where it claims to, and neither appears on a deployment
 * that has only one way to buy.
 *
 * The last of those is the case worth a test rather than a comment. A tab
 * pointing at a screen that explains the feature is switched off teaches the
 * customer that the navigation lies, and it is exactly the kind of regression
 * a later "just render it always" change would introduce.
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { CartModeTabs, SCHEDULE_CART_PATH } from './CartModeTabs';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { renderWithProviders } from '@/test/harness';
import type { StorefrontConfig } from '@/lib/types';

/** A deployment with standing orders switched on. */
const WITH_SCHEDULES: StorefrontConfig = {
  ...FALLBACK_CONFIG,
  features: { ...FALLBACK_CONFIG.features, recurringOrders: true },
};

describe('the cart tabs', () => {
  it('offers exactly two, with Instant Buy the one you are on', () => {
    renderWithProviders(<CartModeTabs current="instant" />, { config: WITH_SCHEDULES });

    const tabs = screen.getAllByRole('link');
    expect(tabs).toHaveLength(2);

    const instant = screen.getByRole('link', { name: /instant buy/i });
    const schedule = screen.getByRole('link', { name: /schedule cart/i });

    // `aria-current` and not only a colour: "which of these am I in" has to be
    // answerable without seeing the fill.
    expect(instant).toHaveAttribute('aria-current', 'page');
    expect(schedule).not.toHaveAttribute('aria-current');
  });

  it('sends Schedule Cart to the schedule route', () => {
    renderWithProviders(<CartModeTabs current="instant" />, { config: WITH_SCHEDULES });

    expect(screen.getByRole('link', { name: /schedule cart/i })).toHaveAttribute(
      'href',
      SCHEDULE_CART_PATH,
    );
    expect(SCHEDULE_CART_PATH).toBe('/accounts/schedule');
  });

  it('marks Schedule Cart as current on the schedule screen', () => {
    renderWithProviders(<CartModeTabs current="schedule" />, { config: WITH_SCHEDULES });

    expect(screen.getByRole('link', { name: /schedule cart/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: /instant buy/i })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('renders nothing where the deployment has no schedules', () => {
    // `FALLBACK_CONFIG` has `recurringOrders: false`, which is the honest
    // default: a capability is off until the real config says otherwise.
    renderWithProviders(<CartModeTabs current="instant" />);

    expect(screen.queryByRole('link', { name: /schedule cart/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /instant buy/i })).toBeNull();
  });
});
