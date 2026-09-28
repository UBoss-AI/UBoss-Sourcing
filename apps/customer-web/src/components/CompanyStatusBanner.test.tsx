/**
 * The banner that says, on every page, which company the basket belongs to
 * and - until it is verified - why it cannot order yet.
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CompanyStatusBanner } from './CompanyStatusBanner';
import { makeSession, renderWithProviders } from '@/test/harness';
import type { BuyerCompanyStatus } from '@/auth/session-context';

function inCompany(companyStatus: BuyerCompanyStatus): ReturnType<typeof makeSession> {
  return makeSession({
    buyerContext: {
      kind: 'COMPANY',
      companyId: 'C1',
      companyName: 'Acme Polska',
      companyStatus,
      role: 'OWNER',
      applicationReference: 'BC-ABCDEFGH',
    },
  });
}

describe('CompanyStatusBanner', () => {
  it('says nothing while buying for oneself', () => {
    renderWithProviders(<CompanyStatusBanner />, { session: makeSession() });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('explains that ordering waits for verification, and links to the application', () => {
    renderWithProviders(<CompanyStatusBanner />, { session: inCompany('UNDER_REVIEW') });

    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Acme Polska');
    expect(banner).toHaveTextContent('Ordering opens once the company is verified.');
    expect(screen.getByRole('link', { name: 'View application' })).toHaveAttribute('href', '/account/companies/C1');
  });

  it('asks to continue the application when the reviewer is waiting on the buyer', () => {
    renderWithProviders(<CompanyStatusBanner />, { session: inCompany('MORE_INFORMATION_REQUIRED') });
    expect(screen.getByRole('link', { name: /continue/i })).toHaveAttribute('href', '/account/companies/C1');
  });

  it('shrinks to one line naming the company once it is approved', () => {
    renderWithProviders(<CompanyStatusBanner />, { session: inCompany('APPROVED') });

    expect(screen.getByRole('status')).toHaveTextContent('Buying for Acme Polska');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
