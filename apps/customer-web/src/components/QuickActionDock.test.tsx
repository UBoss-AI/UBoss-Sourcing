import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QuickActionDock } from './QuickActionDock';
import { makeSession, renderWithProviders } from '@/test/harness';
import { FALLBACK_CONFIG } from '@/app/storefront-context';

const config = (on: boolean) => ({ ...FALLBACK_CONFIG, features: { ...FALLBACK_CONFIG.features, rfq: on, assistant: on, imageSearch: on } });

describe('quick-action dock (ENH-005)', () => {
  it('offers all six actions to a signed-in buyer when the features are on', () => {
    renderWithProviders(<QuickActionDock />, { config: config(true), session: makeSession({ isCustomer: true }) });
    fireEvent.click(screen.getByRole('button', { name: 'Quick actions' }));
    expect(screen.getByRole('link', { name: 'Create RFQ' })).toHaveAttribute('href', '/account/rfqs/new');
    expect(screen.getByRole('button', { name: 'Search by image' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ask AI' })).toHaveAttribute('href', '/ai');
    expect(screen.getByRole('link', { name: 'Reorder' })).toHaveAttribute('href', '/account#buy-again-heading');
    expect(screen.getByRole('link', { name: 'Track an order' })).toHaveAttribute('href', '/account/orders');
    expect(screen.getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', '/support');
  });
  it('hides what does not apply: switched-off features and signed-out buyer actions', () => {
    renderWithProviders(<QuickActionDock />, { config: config(false), session: makeSession({ isCustomer: false }) });
    fireEvent.click(screen.getByRole('button', { name: 'Quick actions' }));
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(['Contact support']);
    expect(screen.queryByRole('button', { name: 'Search by image' })).toBeNull();
  });
});
