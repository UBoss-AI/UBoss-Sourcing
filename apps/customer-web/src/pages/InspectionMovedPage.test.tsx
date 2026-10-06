/** The old agency portal routes now explain that inspection work moved to the Audit Console. */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { renderWithProviders } from '@/test/harness';
import { InspectionMovedPage } from './InspectionMovedPage';

describe('InspectionMovedPage', () => {
  it('links to the Audit Console when the config names it, and says the storefront login does not work there', () => {
    renderWithProviders(<InspectionMovedPage />, { config: { ...FALLBACK_CONFIG, auditConsoleUrl: 'https://audit.example.test/' } });
    expect(screen.getByRole('heading', { name: 'Inspection work has moved' })).toBeInTheDocument();
    expect(screen.getByText(/does not work in the Audit Console/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the Audit Console' })).toHaveAttribute('href', 'https://audit.example.test/');
  });

  it('explains without a link when the console is off', () => {
    renderWithProviders(<InspectionMovedPage />, { config: { ...FALLBACK_CONFIG, auditConsoleUrl: '' } });
    expect(screen.queryByRole('link', { name: 'Open the Audit Console' })).toBeNull();
    expect(screen.getByText(/ask .* for the Audit Console address/)).toBeInTheDocument();
  });

  it('never links to a non-http address', () => {
    renderWithProviders(<InspectionMovedPage />, { config: { ...FALLBACK_CONFIG, auditConsoleUrl: 'javascript:alert(1)' } });
    expect(screen.queryByRole('link', { name: 'Open the Audit Console' })).toBeNull();
  });
});
