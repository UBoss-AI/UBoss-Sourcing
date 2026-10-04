import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HomeB2bTools } from './HomeB2bTools';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { renderWithProviders } from '@/test/harness';

function config(features: Record<string, boolean>) {
  return { ...FALLBACK_CONFIG, features: { ...FALLBACK_CONFIG.features, ...features } };
}

describe('home B2B tools (DYNAMIC-007)', () => {
  it('links all five tools to their existing screens when each is switched on', () => {
    renderWithProviders(<HomeB2bTools />, { config: config({ rfq: true, recurringOrders: true, customerErp: true }) });
    const section = screen.getByRole('region', { name: 'Tools for business buying' });
    const href = (name: RegExp) => within(section).getByRole('link', { name }).getAttribute('href');
    expect(href(/Request private label \/ OEM/)).toBe('/account/rfqs/new?template=oem');
    expect(href(/Upload bulk requirement/)).toBe('/cart');
    expect(href(/Landed cost/)).toBe('/tools/landed-cost');
    expect(href(/Schedule cart/)).toBe('/account/schedules');
    expect(href(/ERP integration/)).toBe('/account/integrations/erp');
  });

  it('says a switched-off tool is not offered instead of linking to it', () => {
    renderWithProviders(<HomeB2bTools />, { config: config({ rfq: false, recurringOrders: false, customerErp: false }) });
    for (const id of ['oem', 'schedule', 'erp']) {
      const tile = screen.getByTestId(`b2b-tool-${id}`);
      expect(within(tile).queryByRole('link')).not.toBeInTheDocument();
      expect(within(tile).getByText('Not offered on this marketplace at the moment.')).toBeInTheDocument();
    }
    expect(within(screen.getByTestId('b2b-tool-landed')).getByRole('link')).toBeInTheDocument();
  });
});
